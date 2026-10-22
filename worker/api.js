import { ApiError, requireValue } from './errors.js';
import { GithubData } from './github.js';
const json = (body, status = 200) => Response.json(body, { status });
function validURLs(env) {
  try {
    const app = new URL(env.APP_URL),
      worker = new URL(env.WORKER_URL);
    const secure = app.protocol === 'https:';
    const local =
      env.ALLOW_LOCAL_DEV === 'true' &&
      app.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(app.hostname);
    return (
      (secure || local) &&
      app.origin === env.APP_ORIGIN &&
      !app.username &&
      !app.password &&
      !app.search &&
      !app.hash &&
      app.pathname.endsWith('/') &&
      worker.protocol === 'https:' &&
      env.WORKER_URL === worker.origin
    );
  } catch {
    return false;
  }
}
async function body(request) {
  requireValue(
    request.headers.get('Content-Type')?.split(';')[0] === 'application/json',
    415,
    'JSON_REQUIRED'
  );
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, 'INVALID_REQUEST');
  let size = 0;
  const parts = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 1064960) {
      await reader.cancel();
      throw new ApiError(413, 'DOCUMENT_TOO_LARGE');
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new ApiError(400, 'INVALID_JSON');
  }
}
export function createHandler({ fetch: upstreamFetch = globalThis.fetch } = {}) {
  return async function handle(request, env) {
    const origin = request.headers.get('Origin');
    let response;
    async function auth(op, args) {
      const stub = env.AUTH.get(env.AUTH.idFromName('quit365-auth-v1'));
      const r = await stub.fetch('https://auth.internal/' + op, {
        method: 'POST',
        body: JSON.stringify(args)
      });
      const b = await r.json();
      if (!r.ok) throw new ApiError(r.status, b.error || 'AUTH_FAILED', b.retryAfter);
      return b;
    }
    async function github(url, init) {
      const r = await upstreamFetch(url, { ...init, redirect: 'error' });
      if (!r.ok) throw new ApiError(502, 'GITHUB_AUTH_UNAVAILABLE');
      return r;
    }
    try {
      requireValue(
        validURLs(env) &&
          env.GITHUB_CLIENT_ID &&
          env.GITHUB_CLIENT_SECRET &&
          env.GITHUB_DATA_TOKEN &&
          env.AUTH &&
          env.ALLOWED_USER_ID === '289706800',
        503,
        'CONFIGURATION_REQUIRED'
      );
      requireValue(!origin || origin === env.APP_ORIGIN, 403, 'ORIGIN_DENIED');
      const url = new URL(request.url),
        path = url.pathname;
      if (request.method === 'OPTIONS') {
        requireValue(origin === env.APP_ORIGIN, 403, 'ORIGIN_DENIED');
        response = new Response(null, { status: 204 });
      } else if (path === '/auth/start' && request.method === 'POST') {
        requireValue(origin === env.APP_ORIGIN, 403, 'ORIGIN_DENIED');
        await auth('limit', {
          key: 'login:' + request.headers.get('CF-Connecting-IP'),
          max: 10,
          window: 600000
        });
        const b = await body(request);
        await auth('start', b);
        const authorize = new URL('https://github.com/login/oauth/authorize');
        authorize.search = new URLSearchParams({
          client_id: env.GITHUB_CLIENT_ID,
          redirect_uri: env.WORKER_URL + '/auth/callback',
          state: b.state,
          code_challenge: b.challenge,
          code_challenge_method: 'S256',
          scope: '',
          allow_signup: 'false'
        });
        response = json({ authorizeUrl: authorize.href });
      } else if (path === '/auth/callback' && request.method === 'GET') {
        requireValue(!url.searchParams.has('error'), 401, 'LOGIN_CANCELLED');
        const result = await auth('callback', {
          state: url.searchParams.get('state'),
          code: url.searchParams.get('code')
        });
        const dest = new URL(env.APP_URL);
        dest.hash = 'oauth=' + encodeURIComponent(result.ticket);
        response = new Response(null, { status: 303, headers: { Location: dest.href } });
      } else if (path === '/auth/exchange' && request.method === 'POST') {
        requireValue(origin === env.APP_ORIGIN, 403, 'ORIGIN_DENIED');
        await auth('limit', {
          key: 'exchange:' + request.headers.get('CF-Connecting-IP'),
          max: 30,
          window: 600000
        });
        const b = await body(request),
          claim = await auth('exchangeClaim', b);
        let token;
        try {
          const tr = await github('https://github.com/login/oauth/access_token', {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id: env.GITHUB_CLIENT_ID,
              client_secret: env.GITHUB_CLIENT_SECRET,
              code: claim.code,
              code_verifier: b.verifier,
              redirect_uri: env.WORKER_URL + '/auth/callback'
            })
          });
          const data = await tr.json();
          requireValue(typeof data.access_token === 'string', 401, 'LOGIN_FAILED');
          token = data.access_token;
          requireValue(
            typeof data.scope === 'string' &&
              data.scope
                .split(/[ ,]+/)
                .filter(Boolean)
                .every((x) => x === 'read:user'),
            403,
            'OAUTH_SCOPE_DENIED'
          );
          const user = await (
            await github('https://api.github.com/user', {
              headers: {
                Authorization: 'Bearer ' + token,
                Accept: 'application/vnd.github+json',
                'User-Agent': 'QUIT365-Sync'
              }
            })
          ).json();
          requireValue(String(user.id) === env.ALLOWED_USER_ID, 403, 'USER_NOT_ALLOWED');
          await github(
            'https://api.github.com/applications/' +
              encodeURIComponent(env.GITHUB_CLIENT_ID) +
              '/token',
            {
              method: 'DELETE',
              headers: {
                Authorization:
                  'Basic ' + btoa(env.GITHUB_CLIENT_ID + ':' + env.GITHUB_CLIENT_SECRET),
                'Content-Type': 'application/json',
                'User-Agent': 'QUIT365-Sync'
              },
              body: JSON.stringify({ access_token: token })
            }
          );
          token = null;
          response = json(
            await auth('exchangeFinish', {
              ticket: b.ticket,
              user: { id: user.id, login: String(user.login) }
            })
          );
        } catch (e) {
          await auth('cancel', { ticket: b.ticket });
          throw e;
        } finally {
          if (token) {
            try {
              await upstreamFetch(
                'https://api.github.com/applications/' +
                  encodeURIComponent(env.GITHUB_CLIENT_ID) +
                  '/token',
                {
                  method: 'DELETE',
                  redirect: 'error',
                  headers: {
                    Authorization:
                      'Basic ' + btoa(env.GITHUB_CLIENT_ID + ':' + env.GITHUB_CLIENT_SECRET),
                    'Content-Type': 'application/json',
                    'User-Agent': 'QUIT365-Sync'
                  },
                  body: JSON.stringify({ access_token: token })
                }
              );
            } catch {}
          }
        }
      } else if (['/v1/session', '/v1/logout', '/v1/state'].includes(path)) {
        const token = request.headers
          .get('Authorization')
          ?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/)?.[1];
        requireValue(token, 401, 'UNAUTHORIZED');
        const s = await auth('session', { token });
        requireValue(String(s.user.id) === env.ALLOWED_USER_ID, 403, 'USER_NOT_ALLOWED');
        await auth('limit', { key: 'session:' + token, max: 120, window: 60000 });
        if (path === '/v1/session' && request.method === 'GET') response = json(s);
        else if (path === '/v1/logout' && request.method === 'POST')
          response = json(await auth('logout', { token }));
        else if (path === '/v1/state' && request.method === 'GET')
          response = json(await new GithubData(env, { fetch: upstreamFetch }).read());
        else if (path === '/v1/state' && request.method === 'PUT') {
          requireValue(origin === env.APP_ORIGIN, 403, 'ORIGIN_DENIED');
          await auth('limit', { key: 'write:' + token, max: 30, window: 60000 });
          const b = await body(request);
          response = json(
            await new GithubData(env, { fetch: upstreamFetch }).write(b.document, b.revision)
          );
        } else throw new ApiError(405, 'METHOD_NOT_ALLOWED');
      } else throw new ApiError(404, 'NOT_FOUND');
    } catch (e) {
      response = json(
        { error: e instanceof ApiError ? e.code : 'SERVICE_UNAVAILABLE' },
        e instanceof ApiError ? e.status : 503
      );
      if (e.retryAfter) response.headers.set('Retry-After', String(e.retryAfter));
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (origin === env.APP_ORIGIN) {
      response.headers.set('Access-Control-Allow-Origin', origin);
      response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.headers.set('Access-Control-Expose-Headers', 'Retry-After');
      response.headers.set('Vary', 'Origin');
    }
    return response;
  };
}
