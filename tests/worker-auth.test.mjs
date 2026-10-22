import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthStore, sha } from '../worker/auth.js';
class MemoryStorage {
  map = new Map();
  queue = Promise.resolve();
  async get(k) {
    return structuredClone(this.map.get(k));
  }
  async put(k, v) {
    this.map.set(k, structuredClone(v));
  }
  async delete(k) {
    this.map.delete(k);
  }
  async list({ prefix = '' } = {}) {
    return new Map([...this.map].filter(([k]) => k.startsWith(prefix)));
  }
  async transaction(fn) {
    const op = this.queue.then(() => fn(this));
    this.queue = op.catch(() => {});
    return op;
  }
}
export function authFixture() {
  let now = 1000000;
  return {
    auth: new AuthStore(new MemoryStorage(), { now: () => now }),
    advance: (ms) => (now += ms)
  };
}
const verifier = 'v'.repeat(64),
  state = 's'.repeat(64);
async function session(auth) {
  const state = crypto.randomUUID().replaceAll('-', '') + 'x'.repeat(32);
  await auth.start({ state, challenge: await sha(verifier) });
  const { ticket } = await auth.callback({ state, code: 'synthetic-code' });
  await auth.exchangeClaim({ ticket, verifier });
  return auth.exchangeFinish({ ticket, user: { id: 289706800, login: 'test' } });
}
test('OAuth PKCE mismatch cannot consume ticket, concurrent correct exchanges claim exactly once', async () => {
  const { auth } = authFixture();
  await auth.start({ state, challenge: await sha(verifier) });
  const { ticket } = await auth.callback({ state, code: 'synthetic-code' });
  await assert.rejects(auth.exchangeClaim({ ticket, verifier: 'x'.repeat(64) }));
  const attempts = await Promise.allSettled([
    auth.exchangeClaim({ ticket, verifier }),
    auth.exchangeClaim({ ticket, verifier })
  ]);
  assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1);
  assert.equal(attempts.find((x) => x.status === 'fulfilled').value.code, 'synthetic-code');
});
test('OAuth state replay and expired requests fail closed', async () => {
  const { auth, advance } = authFixture();
  await auth.start({ state, challenge: await sha(verifier) });
  await auth.callback({ state, code: 'code' });
  await assert.rejects(auth.callback({ state, code: 'code' }));
  await auth.start({ state: state + 'x', challenge: await sha(verifier) });
  advance(600001);
  await assert.rejects(auth.callback({ state: state + 'x', code: 'code' }));
});
test('sessions expire at idle and absolute boundaries and logout is immediate', async () => {
  const { auth, advance } = authFixture();
  const s = await session(auth);
  assert.equal((await auth.session({ token: s.token })).user.id, 289706800);
  advance(3600001);
  await assert.rejects(auth.session({ token: s.token }));
  const other = await session(auth);
  await auth.logout({ token: other.token });
  await assert.rejects(auth.session({ token: other.token }));
});
test('rate limit rejects excess calls without resetting its window', async () => {
  const { auth, advance } = authFixture();
  await auth.limit({ key: 'ip-test', max: 2, window: 60000 });
  await auth.limit({ key: 'ip-test', max: 2, window: 60000 });
  await assert.rejects(
    auth.limit({ key: 'ip-test', max: 2, window: 60000 }),
    (e) => e.status === 429
  );
  advance(60001);
  await auth.limit({ key: 'ip-test', max: 2, window: 60000 });
});
test('pending OAuth capacity returns a retry interval and accepts requests after expiry', async () => {
  const { auth, advance } = authFixture();
  const challenge = await sha(verifier);
  for (let i = 0; i < 100; i++)
    await auth.start({ state: String(i).padStart(43, '0'), challenge });
  const next = { state: 'n'.repeat(43), challenge };
  await assert.rejects(auth.start(next), (e) =>
    e.status === 429 && e.code === 'RATE_LIMIT' && e.retryAfter === 60);
  advance(600001);
  assert.deepEqual(await auth.start(next), { ok: true });
});
