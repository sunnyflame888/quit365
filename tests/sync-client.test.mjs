import test from "node:test";
import assert from "node:assert/strict";
import { IDBFactory } from "fake-indexeddb";
import { createRepository } from "../src/store.js";
import { createSyncClient } from "../src/sync-client.js";
import { fixture, withDay } from "./fixtures.mjs";
function server() {
  let document = null,
    n = 0;
  const calls = [];
  const api = {
    calls,
    loseReply: false,
    hook: null,
    get document() {
      return structuredClone(document);
    },
    get revision() {
      return n ? n.toString(16).padStart(40, "0") : null;
    },
  };
  api.transport = async (path, { method = "GET", body } = {}) => {
    calls.push({ path, method });
    if (path === "/v1/session")
      return { user: { id: 289706800 }, expiresAt: Date.now() + 100000 };
    if (path === "/v1/state" && method === "GET") {
      if (api.hook) {
        const h = api.hook;
        api.hook = null;
        await h("GET");
      }
      return { revision: api.revision, document: structuredClone(document) };
    }
    if (path === "/v1/state" && method === "PUT") {
      if (body.revision !== api.revision)
        throw Object.assign(Error("CONFLICT"), { status: 409 });
      if (api.hook) {
        const h = api.hook;
        api.hook = null;
        await h("PUT");
      }
      document = structuredClone(body.document);
      n++;
      if (api.loseReply) {
        api.loseReply = false;
        throw Error("connection lost after write");
      }
      return { revision: api.revision };
    }
    throw Error("Unexpected path");
  };
  return api;
}
async function device(server, state = fixture()) {
  const ls = new Map(),
    sessionStorage = {
      getItem: (k) => ls.get(k) || null,
      setItem: (k, v) => ls.set(k, v),
      removeItem: (k) => ls.delete(k),
    };
  sessionStorage.setItem(
    "quit365-session-v1",
    JSON.stringify({ token: "t".repeat(43) }),
  );
  const repository = createRepository({
    indexedDB: new IDBFactory(),
    localStorage: { getItem: () => null, setItem() {} },
  });
  await repository.load();
  await repository.save(state, { intent: "initialize" });
  let online = true,
    status,
    now = Date.now();
  const opts = {
    repository,
    transport: server.transport,
    sessionStorage,
    online: () => online,
    clock: { now: () => now, setTimeout: () => 0, clearTimeout() {} },
    onStatus: (s) => (status = s),
  };
  const client = createSyncClient(opts);
  return {
    repository,
    client,
    opts,
    setOnline: (v) => (online = v),
    advance: (ms) => (now += ms),
    get status() {
      return status;
    },
  };
}
async function migrate(d) {
  await d.client.previewMigration();
  await d.client.confirmMigration(
    { settings: "remote" },
    d.client.getStatus().reviewVersion,
  );
}
test("authenticated device does not upload until explicit migration confirmation", async () => {
  const s = server(),
    d = await device(s, withDay(fixture()));
  await d.client.syncNow();
  assert.equal(s.document, null);
  assert.equal(d.status.kind, "migration");
  await migrate(d);
  assert.equal(s.document.appState.logs["2026-10-22"].complete, true);
  assert.equal(d.status.kind, "synced");
  assert.equal((await d.repository.listSnapshots()).length, 1);
});
test("two devices merge different days but concurrent same-day changes stop with conflict", async () => {
  const s = server(),
    a = await device(s),
    b = await device(s);
  await migrate(a);
  await migrate(b);
  await a.repository.save(withDay(fixture()));
  await b.repository.save(withDay(fixture(), "2026-10-23"));
  await a.client.syncNow();
  await b.client.syncNow();
  assert.deepEqual(Object.keys(s.document.appState.logs).sort(), [
    "2026-10-22",
    "2026-10-23",
  ]);
  await a.client.syncNow();
  const ab = (await a.repository.readSync()).state,
    bb = (await b.repository.readSync()).state;
  await a.repository.save(withDay(ab, undefined, "A"));
  await b.repository.save(withDay(bb, undefined, "B"));
  await a.client.syncNow();
  const before = s.document;
  await b.client.syncNow();
  assert.equal(b.status.kind, "conflict");
  assert.deepEqual(s.document, before);
  assert.equal(
    (await b.repository.readSync()).state.logs["2026-10-22"].notes,
    "B",
  );
});
test("offline restart retains pending generation and uploads after reconnection", async () => {
  const s = server(),
    d = await device(s);
  await migrate(d);
  d.setOnline(false);
  await d.repository.save(withDay(fixture()));
  await d.client.syncNow();
  assert.equal(d.status.kind, "offline");
  assert.deepEqual(s.document.appState.logs, {});
  const restarted = createSyncClient(d.opts);
  d.setOnline(true);
  await restarted.syncNow();
  assert.ok(s.document.appState.logs["2026-10-22"]);
});
test("new edit during PUT remains pending rather than falsely acknowledged", async () => {
  const s = server(),
    d = await device(s);
  await migrate(d);
  await d.repository.save(withDay(fixture(), undefined, "first"));
  const original = s.transport;
  s.transport = original;
  const transport = async (path, opts) => {
    if (path === "/v1/state" && opts?.method === "PUT")
      await d.repository.save(withDay(fixture(), undefined, "second"));
    return original(path, opts);
  };
  const c = createSyncClient({ ...d.opts, transport });
  await c.syncNow();
  const { state, meta } = await d.repository.readSync();
  assert.equal(state.logs["2026-10-22"].notes, "second");
  assert.ok(meta.generation > meta.ackedGeneration);
});
test("lost successful PUT response followed by more editing safely retries without same-device conflict", async () => {
  const s = server(),
    d = await device(s);
  await migrate(d);
  await d.repository.save(withDay(fixture(), undefined, "first"));
  s.loseReply = true;
  await d.client.syncNow();
  await d.repository.save(withDay(fixture(), undefined, "second"));
  d.advance(61000);
  await d.client.syncNow();
  assert.equal(d.status.kind, "synced");
  assert.equal(s.document.appState.logs["2026-10-22"].notes, "second");
});
test("slow GET cannot replace a local edit made while download is in flight", async () => {
  const s = server(),
    d = await device(s);
  await migrate(d);
  s.hook = async (method) => {
    assert.equal(method, "GET");
    await d.repository.save(withDay(fixture(), undefined, "during GET"));
  };
  await d.client.syncNow();
  assert.equal(
    (await d.repository.readSync()).state.logs["2026-10-22"].notes,
    "during GET",
  );
  assert.equal(s.document.appState.logs["2026-10-22"].notes, "during GET");
});
test("disconnect and clearing local data do not delete cloud data", async () => {
  const s = server(),
    d = await device(s, withDay(fixture()));
  await migrate(d);
  await d.client.disconnect();
  await d.repository.save(fixture());
  await d.client.syncNow();
  assert.ok(s.document.appState.logs["2026-10-22"]);
});
test("disconnect during first migration cannot re-enable sync when the upload ACK arrives", async () => {
  const s = server(),
    d = await device(s, withDay(fixture()));
  await d.client.previewMigration();
  const hook = async (method) => {
    if (method === "GET") {
      s.hook = hook;
      return;
    }
    await d.client.disconnect();
    await d.repository.save(fixture());
  };
  s.hook = hook;
  await d.client.confirmMigration({}, d.client.getStatus().reviewVersion);
  assert.equal((await d.repository.readSync()).meta.enabled, false);
  await d.client.syncNow();
  assert.ok(s.document.appState.logs["2026-10-22"]);
  assert.deepEqual((await d.repository.readSync()).state.logs, {});
});
test("unrecognized cloud schema is a terminal error without scheduled retries or writes", async () => {
  const s = server(),
    d = await device(s);
  await migrate(d);
  let timers = 0;
  const transport = async (path, opts) =>
    path === "/v1/state" && opts?.method !== "PUT"
      ? {
          revision: "a".repeat(40),
          document: { formatVersion: 99, appState: fixture() },
        }
      : s.transport(path, opts);
  const client = createSyncClient({
    ...d.opts,
    transport,
    clock: {
      now: Date.now,
      setTimeout: () => {
        timers++;
        return 0;
      },
      clearTimeout() {},
    },
  });
  const writes = s.calls.filter((c) => c.method === "PUT").length;
  await client.syncNow();
  assert.equal(timers, 0);
  assert.equal(s.calls.filter((c) => c.method === "PUT").length, writes);
});
test("onState can preserve a still-being-edited form as pending instead of reporting synced", async () => {
  const s = server(),
    d = await device(s);
  await migrate(d);
  let entered = false;
  const c = createSyncClient({
    ...d.opts,
    onState: async () => {
      if (!entered) {
        entered = true;
        await d.repository.save(
          withDay(fixture(), undefined, "not yet blurred"),
        );
      }
    },
  });
  await c.syncNow();
  assert.equal(d.status.kind, "pending");
  assert.equal(
    (await d.repository.readSync()).state.logs["2026-10-22"].notes,
    "not yet blurred",
  );
});
test("API-reported malformed cloud data stops retries without losing local data", async () => {
  const { createTransport } = await import("../src/sync-client.js");
  const s = server(),
    d = await device(s);
  await migrate(d);
  let timers = 0;
  const remote = createTransport("https://unit.workers.dev", {
    fetch: async () =>
      Response.json({ error: "INVALID_CLOUD_DATA" }, { status: 503 }),
  });
  const transport = (path, opts) =>
    path === "/v1/session" ? s.transport(path, opts) : remote(path, opts);
  const c = createSyncClient({
    ...d.opts,
    transport,
    clock: {
      now: Date.now,
      setTimeout: () => {
        timers++;
        return 0;
      },
      clearTimeout() {},
    },
  });
  await c.syncNow();
  assert.equal(timers, 0);
  assert.equal((await d.repository.readSync()).meta.enabled, true);
});

for (const lostReply of [false, true]) {
  test(`remote-added day survives editing during merged PUT (lost reply: ${lostReply})`, async () => {
    const s = server(),
      a = await device(s),
      b = await device(s);
    await migrate(a);
    await migrate(b);
    await b.repository.save(withDay(fixture(), "2026-10-23", "remote day"));
    await b.client.syncNow();
    await a.repository.save(withDay(fixture(), "2026-10-22", "before upload"));
    const transport = async (path, opts) => {
      if (path === "/v1/state" && opts?.method === "PUT") {
        await a.repository.save(
          withDay(fixture(), "2026-10-22", "during upload"),
        );
        s.loseReply = lostReply;
      }
      return s.transport(path, opts);
    };
    const c = createSyncClient({ ...a.opts, transport });
    await c.syncNow();
    await a.client.syncNow();
    await a.client.syncNow();
    assert.deepEqual(Object.keys(s.document.appState.logs).sort(), [
      "2026-10-22",
      "2026-10-23",
    ]);
    assert.equal(s.document.appState.logs["2026-10-22"].notes, "during upload");
    assert.equal(
      (await a.repository.readSync()).state.logs["2026-10-23"].notes,
      "remote day",
    );
  });
}
test("migration confirmation rejects a replaced preview that the user has not seen", async () => {
  const s = server(),
    a = await device(s, withDay(fixture(), undefined, "REMOTE V1"));
  await migrate(a);
  const b = await device(s, withDay(fixture(), undefined, "LOCAL"));
  await b.client.previewMigration();
  const shown = b.status.reviewVersion;
  await a.repository.save(withDay(fixture(), undefined, "REMOTE V2"));
  await a.client.syncNow();
  await b.client.previewMigration();
  const writes = s.calls.filter((c) => c.method === "PUT").length;
  await assert.rejects(
    b.client.confirmMigration({ "logs.2026-10-22": "local" }, shown),
    /重新/,
  );
  assert.equal(s.calls.filter((c) => c.method === "PUT").length, writes);
});
test("conflict confirmation rejects choices from an older rendered conflict", async () => {
  const s = server(),
    a = await device(s),
    b = await device(s);
  await migrate(a);
  await migrate(b);
  await a.repository.save(withDay(fixture(), undefined, "REMOTE V1"));
  await a.client.syncNow();
  await b.repository.save(withDay(fixture(), undefined, "LOCAL"));
  await b.client.syncNow();
  const shown = b.status.reviewVersion;
  await a.repository.save(withDay(fixture(), undefined, "REMOTE V2"));
  await a.client.syncNow();
  await b.client.syncNow();
  const writes = s.calls.filter((c) => c.method === "PUT").length;
  await assert.rejects(
    b.client.resolveConflicts({ "logs.2026-10-22": "local" }, shown),
    /重新/,
  );
  assert.equal(s.calls.filter((c) => c.method === "PUT").length, writes);
});
test("Retry-After is enforced for manual, save and foreground triggers", async () => {
  const s = server(),
    d = await device(s);
  await migrate(d);
  let now = 1000,
    requests = 0,
    limited = true,
    sequence = 0;
  const timers = new Map();
  const c = createSyncClient({
    ...d.opts,
    transport: async (path, opts) => {
      requests++;
      if (limited)
        throw Object.assign(Error("RATE_LIMIT"), {
          status: 429,
          retryAfter: 60000,
        });
      return s.transport(path, opts);
    },
    clock: {
      now: () => now,
      setTimeout: (fn, delay) => {
        timers.set(++sequence, { fn, at: now + delay });
        return sequence;
      },
      clearTimeout: (id) => timers.delete(id),
    },
  });
  await c.start();
  await c.syncNow();
  c.notifySaved();
  now = 32000;
  for (const [id, t] of [...timers])
    if (t.at <= now) {
      timers.delete(id);
      await t.fn();
    }
  await c.syncNow();
  assert.equal(requests, 1);
  limited = false;
  now = 61001;
  await c.syncNow();
  assert.ok(requests > 1);
  c.stop();
});
