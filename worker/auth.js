import { ApiError, requireValue } from './errors.js';
export const base64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
export const sha = async (text) =>
  base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
const opaque = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(v);
export class AuthStore {
  constructor(
    storage,
    { now = Date.now, random = () => base64url(crypto.getRandomValues(new Uint8Array(32))) } = {}
  ) {
    this.storage = storage;
    this.now = now;
    this.random = random;
  }
  async start({ state, challenge }) {
    requireValue(opaque(state) && opaque(challenge));
    const key = 'login:' + (await sha(state)),
      now = this.now();
    await this.storage.transaction(async (tx) => {
      requireValue(!(await tx.get(key)), 409, 'LOGIN_EXISTS');
      const pending = await tx.list({ prefix: 'login:' });
      requireValue(
        [...pending.values()].filter((x) => x.expiresAt > now).length < 100,
        429,
        'RATE_LIMIT',
        60
      );
      await tx.put(key, { challenge, expiresAt: now + 600000, status: 'pending' });
    });
    return { ok: true };
  }
  async callback({ state, code }) {
    requireValue(
      opaque(state) && typeof code === 'string' && code.length > 0 && code.length <= 512
    );
    const key = 'login:' + (await sha(state)),
      ticket = this.random(),
      ticketKey = 'ticket:' + (await sha(ticket));
    await this.storage.transaction(async (tx) => {
      const p = await tx.get(key);
      requireValue(p && p.expiresAt > this.now() && p.status === 'pending', 401, 'INVALID_LOGIN');
      await tx.delete(key);
      await tx.put(ticketKey, { ...p, status: 'callback', code, attempts: 0 });
    });
    return { ticket };
  }
  async exchangeClaim({ ticket, verifier }) {
    requireValue(opaque(ticket) && opaque(verifier));
    const key = 'ticket:' + (await sha(ticket)),
      challenge = await sha(verifier);
    const result = await this.storage.transaction(async (tx) => {
      const p = await tx.get(key);
      requireValue(p && p.expiresAt > this.now() && p.status === 'callback', 401, 'INVALID_LOGIN');
      if (p.challenge !== challenge) {
        p.attempts++;
        if (p.attempts >= 5) await tx.delete(key);
        else await tx.put(key, p);
        return null;
      }
      await tx.put(key, { ...p, status: 'exchanging' });
      return { code: p.code };
    });
    requireValue(result, 401, 'INVALID_LOGIN');
    return result;
  }
  async exchangeFinish({ ticket, user }) {
    requireValue(opaque(ticket) && user && Number.isSafeInteger(user.id), 401, 'INVALID_LOGIN');
    const ticketKey = 'ticket:' + (await sha(ticket)),
      token = this.random(),
      sessionKey = 'session:' + (await sha(token)),
      now = this.now();
    await this.storage.transaction(async (tx) => {
      const p = await tx.get(ticketKey);
      requireValue(p && p.expiresAt > now && p.status === 'exchanging', 401, 'INVALID_LOGIN');
      await tx.delete(ticketKey);
      await tx.put(sessionKey, { user, createdAt: now, lastSeen: now, expiresAt: now + 43200000 });
    });
    return { token, user, expiresAt: now + 43200000 };
  }
  async cancel({ ticket }) {
    if (opaque(ticket)) await this.storage.delete('ticket:' + (await sha(ticket)));
    return { ok: true };
  }
  async session({ token }) {
    requireValue(opaque(token), 401, 'UNAUTHORIZED');
    const key = 'session:' + (await sha(token)),
      now = this.now();
    return this.storage.transaction(async (tx) => {
      const s = await tx.get(key);
      if (!s || s.expiresAt <= now || s.lastSeen + 3600000 <= now) {
        await tx.delete(key);
        throw new ApiError(401, 'SESSION_EXPIRED');
      }
      s.lastSeen = now;
      await tx.put(key, s);
      return { user: s.user, expiresAt: s.expiresAt };
    });
  }
  async logout({ token }) {
    if (opaque(token)) await this.storage.delete('session:' + (await sha(token)));
    return { ok: true };
  }
  async limit({ key, max, window }) {
    const k = 'limit:' + (await sha(key)),
      now = this.now();
    return this.storage.transaction(async (tx) => {
      const old = await tx.get(k),
        r = old && old.expiresAt > now ? old : { count: 0, expiresAt: now + window };
      if (r.count >= max)
        throw new ApiError(429, 'RATE_LIMIT', Math.ceil((r.expiresAt - now) / 1000));
      r.count++;
      await tx.put(k, r);
      return { ok: true };
    });
  }
}
