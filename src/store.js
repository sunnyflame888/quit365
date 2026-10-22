import { validateSyncState } from "./sync-schema.js";
const NAME = "quit365-local-v1",
  KEY = "state",
  META = "sync-meta";
const defaults = () => ({
  localRevision: 0,
  generation: 0,
  ackedGeneration: 0,
  baseRevision: null,
  baseState: null,
  enabled: false,
  migration: false,
  conflict: null,
});
export class LocalConflictError extends Error {
  constructor() {
    super("其他页面已更新记录；当前编辑已保留为本机草稿，请导出后重新载入");
    this.name = "LocalConflictError";
  }
}
export class RecoveryError extends Error {
  constructor(raw) {
    super("本机数据需要恢复，请先导出原始数据；不会用空记录覆盖");
    this.raw = raw;
    this.name = "RecoveryError";
  }
}
function browserStorage() {
  try {
    return globalThis.window?.localStorage;
  } catch {
    return undefined;
  }
}
export function createRepository({
  indexedDB = globalThis.indexedDB,
  localStorage = browserStorage(),
} = {}) {
  let mode = "indexeddb",
    expected = 0,
    recovery = false;
  const open = () =>
    new Promise((resolve, reject) => {
      let r;
      try {
        r = indexedDB.open(NAME, 1);
      } catch (e) {
        reject(e);
        return;
      }
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains("kv"))
          r.result.createObjectStore("kv");
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(Error("IndexedDB被其他页面阻塞"));
    });
  async function transact(write, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", write ? "readwrite" : "readonly"),
        store = tx.objectStore("kv");
      let state,
        meta,
        count = 0,
        result;
      const finish = () => {
        if (++count !== 2) return;
        try {
          result = fn(state, { ...defaults(), ...meta }, store);
        } catch (e) {
          tx.abort();
          reject(e);
        }
      };
      const a = store.get(KEY),
        b = store.get(META);
      a.onsuccess = () => {
        state = a.result;
        finish();
      };
      b.onsuccess = () => {
        meta = b.result;
        finish();
      };
      tx.oncomplete = () => {
        db.close();
        resolve(result);
      };
      tx.onerror = () => {
        db.close();
        reject(tx.error || Error("本机保存失败"));
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error || Error("本机事务已取消"));
      };
    });
  }
  function check(state, meta) {
    if (state === undefined && meta?.localRevision > 0) {
      recovery = true;
      throw new RecoveryError({
        missingState: true,
        lastKnownState: meta.baseState,
      });
    }
    if (state !== undefined) {
      try {
        validateSyncState(state);
      } catch {
        recovery = true;
        throw new RecoveryError(state);
      }
    }
  }
  async function load() {
    if (localStorage?.getItem(NAME + "-fallback-pending"))
      mode = "localstorage";
    if (mode === "indexeddb") {
      let result;
      try {
        result = await transact(false, (state, meta) => ({ state, meta }));
      } catch {
        mode = "localstorage";
      }
      if (result) {
        check(result.state, result.meta);
        expected = result.meta.localRevision;
        return result.state;
      }
    }
    let raw;
    try {
      raw = localStorage?.getItem(NAME);
      if (!raw) return undefined;
      const state = JSON.parse(raw);
      check(state);
      return state;
    } catch (e) {
      if (e instanceof RecoveryError) throw e;
      recovery = true;
      throw new RecoveryError(raw);
    }
  }
  async function snapshot(label, state) {
    const value = {
      key: "snapshot:" + crypto.randomUUID(),
      label,
      at: new Date().toISOString(),
      state: structuredClone(state),
    };
    await transact(true, (_s, _m, store) => store.put(value, value.key));
    return value;
  }
  async function save(state, { intent = "edit" } = {}) {
    if (recovery) throw new RecoveryError(state);
    validateSyncState(state);
    if (mode === "indexeddb") {
      let stale = false;
      try {
        await transact(true, (_old, meta, store) => {
          if (meta.localRevision !== expected) {
            stale = true;
            return;
          }
          meta.localRevision++;
          if (intent === "edit") meta.generation++;
          store.put(structuredClone(state), KEY);
          store.put(meta, META);
          expected = meta.localRevision;
        });
        if (stale) {
          await snapshot("stale-tab-draft", state);
          throw new LocalConflictError();
        }
        return;
      } catch (e) {
        if (e instanceof LocalConflictError) throw e;
        mode = "localstorage";
        try {
          localStorage.setItem(NAME, JSON.stringify(state));
          localStorage.setItem(NAME + "-fallback-pending", "1");
        } catch {}
        throw Error("IndexedDB保存失败，云同步已停止；请立即导出本机备份");
      }
    }
    try {
      localStorage.setItem(NAME, JSON.stringify(state));
      localStorage.setItem(NAME + "-fallback-pending", "1");
    } catch {
      mode = "unavailable";
      throw Error("设备无法保存数据，请立即导出备份");
    }
  }
  async function readSync() {
    if (mode !== "indexeddb" || recovery)
      throw Error("云同步需要正常的IndexedDB；本机数据仍可导出");
    return transact(false, (state, meta) => {
      check(state, meta);
      return { state, meta };
    });
  }
  async function updateSync(revision, patch) {
    if (mode !== "indexeddb" || recovery)
      throw Error("云同步需要正常的IndexedDB");
    const result = await transact(true, (state, meta, store) => {
      if (meta.localRevision !== revision) throw new LocalConflictError();
      if (patch.state !== undefined) {
        validateSyncState(patch.state);
        state = structuredClone(patch.state);
        store.put(state, KEY);
      }
      if (patch.snapshot) {
        const s = {
          key: "snapshot:" + crypto.randomUUID(),
          at: new Date().toISOString(),
          ...structuredClone(patch.snapshot),
        };
        store.put(s, s.key);
      }
      meta = {
        ...meta,
        ...structuredClone(patch.meta || {}),
        localRevision: meta.localRevision + 1,
      };
      store.put(meta, META);
      return { state, meta };
    });
    expected = result.meta.localRevision;
    return result;
  }
  async function restore(state) {
    validateSyncState(state);
    if (mode !== "indexeddb") {
      try {
        const raw = localStorage.getItem(NAME);
        let old = raw;
        try {
          old = raw === null ? undefined : JSON.parse(raw);
        } catch {}
        const snapshots = JSON.parse(
          localStorage.getItem(NAME + "-snapshots") || "[]",
        );
        if (!Array.isArray(snapshots)) throw Error("恢复快照格式无效");
        snapshots.push({
          key: "snapshot:" + crypto.randomUUID(),
          at: new Date().toISOString(),
          label: "before-explicit-restore",
          state: old,
        });
        // Persist the original first. Quota/permission failures must not replace it.
        localStorage.setItem(NAME + "-snapshots", JSON.stringify(snapshots));
        localStorage.setItem(NAME + "-fallback-pending", "1");
        localStorage.setItem(NAME, JSON.stringify(state));
        recovery = false;
        mode = "localstorage";
        return;
      } catch {
        throw Error("无法完成本机恢复；原始数据保留，请检查存储权限或空间");
      }
    }
    try {
      const result = await transact(true, (old, meta, store) => {
        const snap = {
          key: "snapshot:" + crypto.randomUUID(),
          at: new Date().toISOString(),
          label: "before-explicit-restore",
          state: old,
        };
        store.put(snap, snap.key);
        const next = {
          ...meta,
          localRevision: meta.localRevision + 1,
          generation: meta.generation + 1,
          enabled: false,
          conflict: null,
          syncEpoch: (meta.syncEpoch || 0) + 1,
        };
        store.put(structuredClone(state), KEY);
        store.put(next, META);
        return next;
      });
      expected = result.localRevision;
      mode = "indexeddb";
      recovery = false;
      localStorage?.removeItem?.(NAME + "-fallback-pending");
    } catch (e) {
      throw Error("无法完成安全恢复；原始数据保留，请检查IndexedDB权限后重试");
    }
  }
  async function listSnapshots() {
    if (mode !== "indexeddb")
      return JSON.parse(localStorage.getItem(NAME + "-snapshots") || "[]").map(
        ({ key, label, at }) => ({ key, label, at }),
      );
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("kv", "readonly"),
        r = tx.objectStore("kv").getAll();
      r.onsuccess = () => {
        db.close();
        resolve(
          r.result
            .filter(
              (x) =>
                typeof x?.key === "string" && x.key.startsWith("snapshot:"),
            )
            .map(({ key, label, at }) => ({ key, label, at })),
        );
      };
      r.onerror = () => {
        db.close();
        reject(r.error);
      };
    });
  }
  async function readSnapshot(key) {
    if (!key.startsWith("snapshot:")) throw Error("快照标识无效");
    if (mode !== "indexeddb")
      return JSON.parse(localStorage.getItem(NAME + "-snapshots") || "[]").find(
        (s) => s.key === key,
      );
    const db = await open();
    return new Promise((resolve, reject) => {
      const r = db.transaction("kv").objectStore("kv").get(key);
      r.onsuccess = () => {
        db.close();
        resolve(r.result);
      };
      r.onerror = () => {
        db.close();
        reject(r.error);
      };
    });
  }
  return {
    load,
    save,
    restore,
    readSync,
    updateSync,
    listSnapshots,
    readSnapshot,
    storageMode: () => mode,
  };
}
export const repository = createRepository();
export const load = (...args) => repository.load(...args);
export const save = (...args) => repository.save(...args);
export const storageMode = () => repository.storageMode();
