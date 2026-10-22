import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { sha } from '../worker/auth.js';
import { build } from 'esbuild';
import { fixture } from './fixtures.mjs';
test('real workerd SQLite Durable Object atomically rejects concurrent OAuth callbacks', async () => {
  const compiled = await build({
    entryPoints: ['worker/index.js'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser'
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'quit365-test',
          modules: true,
          script: compiled.outputFiles[0].text,
          compatibilityDate: '2026-10-22',
          durableObjects: { AUTH: { className: 'AuthState', useSQLite: true } },
          bindings: {
            APP_ORIGIN: 'https://sunnyflame888.github.io',
            APP_URL: 'https://sunnyflame888.github.io/quit365/',
            WORKER_URL: 'https://worker.example',
            GITHUB_CLIENT_ID: 'synthetic',
            GITHUB_CLIENT_SECRET: 'synthetic-only',
            GITHUB_DATA_TOKEN: 'synthetic-only',
            ALLOWED_USER_ID: '289706800',
            DATA_OWNER: 'sunnyflame888',
            DATA_REPO: 'quit365-data',
            DATA_BRANCH: 'main'
          }
        }
      ]
    })
  );
  try {
    const state = 's'.repeat(64),
      r = await mf.dispatchFetch('https://worker.example/auth/start', {
        method: 'POST',
        headers: {
          Origin: 'https://sunnyflame888.github.io',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ state, challenge: await sha('v'.repeat(64)) })
      });
    assert.equal(r.status, 200);
    const replies = await Promise.all([
      mf.dispatchFetch('https://worker.example/auth/callback?state=' + state + '&code=synthetic', {
        redirect: 'manual'
      }),
      mf.dispatchFetch('https://worker.example/auth/callback?state=' + state + '&code=synthetic', {
        redirect: 'manual'
      })
    ]);
    assert.deepEqual(replies.map((r) => r.status).sort(), [303, 401]);
    const denied = await mf.dispatchFetch('https://worker.example/v1/state');
    assert.equal(denied.status, 401);
  } finally {
    await mf.dispose();
  }
});

test('workerd completes OAuth and private data IO while refusing upstream redirects', async () => {
  const compiled = await build({
    entryPoints: ['worker/index.js'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser'
  });
  let redirectOAuth = false,
    redirectData = false,
    escaped = 0,
    written = null;
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'quit365-upstream-test',
          modules: true,
          script: compiled.outputFiles[0].text,
          compatibilityDate: '2026-10-22',
          durableObjects: { AUTH: { className: 'AuthState', useSQLite: true } },
          bindings: {
            APP_ORIGIN: 'https://sunnyflame888.github.io',
            APP_URL: 'https://sunnyflame888.github.io/quit365/',
            WORKER_URL: 'https://worker.example',
            GITHUB_CLIENT_ID: 'synthetic',
            GITHUB_CLIENT_SECRET: 'synthetic-only',
            GITHUB_DATA_TOKEN: 'synthetic-only',
            ALLOWED_USER_ID: '289706800',
            DATA_OWNER: 'sunnyflame888',
            DATA_REPO: 'quit365-data',
            DATA_BRANCH: 'main'
          },
          outboundService: async (request) => {
            const u = new URL(request.url);
            if (!['github.com', 'api.github.com'].includes(u.hostname)) {
              escaped++;
              return new Response('must not follow', { status: 500 });
            }
            if (u.pathname === '/login/oauth/access_token')
              return redirectOAuth
                ? Response.redirect('https://redirect.example/token', 302)
                : Response.json({
                    access_token: 'synthetic-provider-token',
                    scope: '',
                    token_type: 'bearer'
                  });
            if (u.pathname === '/user')
              return Response.json({ id: 289706800, login: 'sunnyflame888' });
            if (u.pathname.startsWith('/applications/')) return new Response(null, { status: 204 });
            if (redirectData) return Response.redirect('https://redirect.example/data', 302);
            if (u.pathname === '/repos/sunnyflame888/quit365-data')
              return Response.json({ private: true });
            if (u.pathname.endsWith('/branches/main')) return Response.json({ name: 'main' });
            if (u.pathname.endsWith('/contents/data/state.json')) {
              if (request.method === 'PUT') {
                written = JSON.parse(await request.text());
                return Response.json({ content: { sha: 'a'.repeat(40) } }, { status: 201 });
              }
              return Response.json({ message: 'Not Found' }, { status: 404 });
            }
            return new Response('unexpected request', { status: 500 });
          }
        }
      ]
    })
  );
  const headers = {
    Origin: 'https://sunnyflame888.github.io',
    'Content-Type': 'application/json'
  };
  async function login(seed) {
    const verifier = seed.repeat(64),
      state = seed.toUpperCase().repeat(64);
    const started = await mf.dispatchFetch('https://worker.example/auth/start', {
      method: 'POST',
      headers,
      body: JSON.stringify({ state, challenge: await sha(verifier) })
    });
    assert.equal(started.status, 200);
    const callback = await mf.dispatchFetch(
      'https://worker.example/auth/callback?state=' + state + '&code=synthetic',
      { redirect: 'manual' }
    );
    assert.equal(callback.status, 303);
    const ticket = new URLSearchParams(new URL(callback.headers.get('Location')).hash.slice(1)).get(
      'oauth'
    );
    return mf.dispatchFetch('https://worker.example/auth/exchange', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ticket, verifier })
    });
  }
  try {
    const exchanged = await login('v');
    assert.equal(exchanged.status, 200, await exchanged.clone().text());
    const session = await exchanged.json();
    assert.equal(session.user.id, 289706800);
    const authenticated = {
      ...headers,
      Authorization: 'Bearer ' + session.token
    };
    const empty = await mf.dispatchFetch('https://worker.example/v1/state', {
      headers: authenticated
    });
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { revision: null, document: null });
    const created = await mf.dispatchFetch('https://worker.example/v1/state', {
      method: 'PUT',
      headers: authenticated,
      body: JSON.stringify({
        revision: null,
        document: { formatVersion: 1, appState: fixture() }
      })
    });
    assert.equal(created.status, 200);
    assert.equal((await created.json()).revision, 'a'.repeat(40));
    assert.equal(written.branch, 'main');
    redirectData = true;
    const denied = await mf.dispatchFetch('https://worker.example/v1/state', {
      headers: authenticated
    });
    assert.equal(denied.status, 503);
    redirectOAuth = true;
    const deniedOAuth = await login('w');
    assert.equal(deniedOAuth.status, 502);
    assert.equal(escaped, 0);
  } finally {
    await mf.dispose();
  }
});
