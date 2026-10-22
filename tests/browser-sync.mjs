// Synthetic browser acceptance checks. No live OAuth or personal health data.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, webkit } from 'playwright';
const root = resolve('.'),
  prefix = '/quit365/';
const mime = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};
const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const name = path.startsWith(prefix)
    ? decodeURIComponent(path.slice(prefix.length)) || 'index.html'
    : null;
  if (!name || name.split('/').some((p) => p.startsWith('.')) || !mime[extname(name)]) {
    res.writeHead(404).end();
    return;
  }
  try {
    res.setHeader('Content-Type', mime[extname(name)]);
    res.end(await readFile(resolve(root, name)));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`,
  url = origin + prefix;
const output = process.env.QUIT365_QA_DIR || resolve(tmpdir(), 'quit365-browser-qa');
await mkdir(output, { recursive: true });
const engine = process.env.QUIT365_BROWSER === 'webkit' ? webkit : chromium;
const browser = await engine.launch({
  headless: true,
  ...(process.env.QUIT365_CHROMIUM_PATH
    ? { executablePath: process.env.QUIT365_CHROMIUM_PATH }
    : {})
});
const errors = [];
let cloud = null,
  revision = null,
  writes = 0;
const nav = (p, v) =>
  p
    .locator(
      `nav[aria-label="${p.viewportSize().width <= 760 ? '底部导航' : '主导航'}"] [data-view="${v}"]`
    )
    .click();
async function device({ configured = true, authenticated = true, workers = 'block' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 420, height: 900 },
    timezoneId: 'Asia/Shanghai',
    serviceWorkers: workers,
    acceptDownloads: true
  });
  if (authenticated)
    await ctx.addInitScript(() => {
      if (!sessionStorage.getItem('synthetic-initialized')) {
        sessionStorage.setItem('quit365-session-v1', JSON.stringify({ token: 't'.repeat(43) }));
        sessionStorage.setItem('synthetic-initialized', '1');
      }
    });
  if (configured)
    await ctx.route('**/src/sync-config.js', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: "export const SYNC_API_URL='https://quit365-qa.workers.dev';"
      })
    );
  await ctx.route('https://quit365-qa.workers.dev/**', async (route) => {
    const r = route.request(),
      path = new URL(r.url()).pathname;
    const headers = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
      'Content-Type': 'application/json'
    };
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers, body: '' });
    let body,
      status = 200;
    if (path === '/v1/session')
      body = { user: { id: 289706800, login: 'synthetic' }, expiresAt: Date.now() + 3600000 };
    else if (path === '/v1/state' && r.method() === 'GET')
      body = { revision, document: structuredClone(cloud) };
    else if (path === '/v1/state' && r.method() === 'PUT') {
      const value = r.postDataJSON();
      if (value.revision !== revision) {
        status = 409;
        body = { error: 'CONFLICT' };
      } else {
        cloud = structuredClone(value.document);
        revision = (++writes).toString(16).padStart(40, '0');
        body = { revision };
      }
    } else if (path === '/v1/logout') body = { ok: true };
    else {
      status = 404;
      body = { error: 'NOT_FOUND' };
    }
    await route.fulfill({ status, headers, body: JSON.stringify(body) });
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(String(e)));
  p.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await p.goto(url);
  await p.locator('#sync-status').waitFor();
  return { ctx, p };
}
async function saved(p, note) {
  await nav(p, 'log');
  await p.locator('#log-notes').fill(note);
  await p.locator('#log-notes').blur();
  await p.locator('#complete-checkbox').check();
  await p.locator('[data-action="save-log"]').click();
  await p.locator('#toast').filter({ hasText: '今天的内容已保存到当前设备' }).waitFor();
}
async function migrate(p) {
  await nav(p, 'settings');
  await p.locator('[data-sync-action="preview"]').click();
  await p.locator('#sync-backup-confirm').check();
  await p.locator('[data-sync-action="migrate"]').click();
  await p.locator('#sync-status').filter({ hasText: '已同步' }).waitFor();
}
async function sync(p) {
  await nav(p, 'settings');
  await p.locator('[data-sync-action="sync"]').click();
}
async function download(p, selector) {
  const event = p.waitForEvent('download');
  await p.locator(selector).click();
  const d = await event;
  assert.equal(await d.failure(), null);
  return readFile(await d.path(), 'utf8');
}
try {
  const local = await device({ configured: false, authenticated: false });
  assert.equal(await local.p.locator('#sync-status').innerText(), '仅本机保存');
  for (const width of [320, 375, 390, 420, 430, 768, 1440]) {
    await local.p.setViewportSize({ width, height: 950 });
    for (const view of ['today', 'log', 'progress', 'plan', 'settings']) {
      await nav(local.p, view);
      const fit = await local.p.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        dates: [...document.querySelectorAll('input[type=date],input[type=time]')].every(
          (e) =>
            e.getBoundingClientRect().right <= e.parentElement.getBoundingClientRect().right + 1
        ),
        charts: [...document.querySelectorAll('.line-chart')].every((e) =>
          [...e.querySelectorAll('small')].every(
            (x) =>
              x.getBoundingClientRect().bottom <= e.getBoundingClientRect().bottom + 1 &&
              x.getBoundingClientRect().bottom + 8 <=
                e.nextElementSibling.getBoundingClientRect().top
          )
        )
      }));
      assert.deepEqual(fit, { overflow: false, dates: true, charts: true }, `${width} ${view}`);
    }
  }
  const a = await device();
  await saved(a.p, 'SYNTHETIC INITIAL');
  assert.equal(writes, 0);
  await migrate(a.p);
  const b = await device();
  await migrate(b.p);
  await nav(b.p, 'log');
  assert.equal(await b.p.locator('#log-notes').inputValue(), 'SYNTHETIC INITIAL');
  await saved(a.p, 'SYNTHETIC DEVICE A');
  await sync(a.p);
  await a.p.locator('#sync-status').filter({ hasText: '已同步' }).waitFor();
  await saved(b.p, 'SYNTHETIC DEVICE B');
  const beforeConflict = writes;
  await sync(b.p);
  await b.p.locator('#sync-status').filter({ hasText: '冲突' }).waitFor();
  assert.equal(writes, beforeConflict);
  await b.p.locator('#sync-panel [data-conflict-path]').selectOption('remote');
  await b.p.locator('[data-sync-action="resolve"]').click();
  await b.p.locator('#sync-status').filter({ hasText: '已同步' }).waitFor();
  await nav(b.p, 'log');
  assert.equal(await b.p.locator('#log-notes').inputValue(), 'SYNTHETIC DEVICE A');
  await b.p.reload();
  await nav(b.p, 'log');
  assert.equal(await b.p.locator('#log-notes').inputValue(), 'SYNTHETIC DEVICE A');
  await nav(b.p, 'settings');
  const plain = JSON.parse(await download(b.p, 'main [data-action="export"] >> nth=-1'));
  assert.equal(Object.values(plain.logs)[0].notes, 'SYNTHETIC DEVICE A');
  assert.equal(plain.sync, undefined);
  const csv = await download(b.p, '[data-action="csv"]');
  assert.ok(csv.includes('SYNTHETIC DEVICE A'));
  const pass = 'synthetic-only passphrase 42';
  const dialog = (d) => d.accept(d.type() === 'prompt' ? pass : undefined);
  b.p.on('dialog', dialog);
  const encrypted = JSON.parse(await download(b.p, '[data-action="export-encrypted"]'));
  assert.equal(encrypted.kind, 'quit365-encrypted-backup');
  assert.equal(encrypted.payload.includes('SYNTHETIC'), false);
  await b.p
    .locator('#import-file')
    .setInputFiles({
      name: 'synthetic-encrypted.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(encrypted))
    });
  await b.p.locator('h1').filter({ hasText: '今天，从这里开始' }).waitFor();
  await nav(b.p, 'log');
  assert.equal(await b.p.locator('#log-notes').inputValue(), 'SYNTHETIC DEVICE A');
  await nav(b.p, 'settings');
  Object.values(plain.logs)[0].notes = '<img src=x onerror="window.syntheticXSS=1">';
  await b.p
    .locator('#import-file')
    .setInputFiles({
      name: 'synthetic-plain.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(plain))
    });
  await b.p.locator('h1').filter({ hasText: '今天，从这里开始' }).waitFor();
  await nav(b.p, 'log');
  assert.equal(await b.p.locator('#log-notes').inputValue(), Object.values(plain.logs)[0].notes);
  assert.equal(await b.p.locator('img[src=x]').count(), 0);
  assert.equal(await b.p.evaluate(() => window.syntheticXSS), undefined);
  b.p.off('dialog', dialog);
  const ticket = await device({ authenticated: false });
  await ticket.p.goto(url + '#oauth=' + 'x'.repeat(43));
  await ticket.p.locator('#sync-ticket').waitFor();
  assert.equal(await ticket.p.locator('#sync-ticket').inputValue(), 'x'.repeat(43));
  assert.equal(await ticket.p.evaluate(() => location.hash), '');
  assert.equal(await ticket.p.evaluate(() => sessionStorage.getItem('quit365-session-v1')), null);
  const offline = await device({ configured: false, authenticated: false, workers: 'allow' });
  await offline.p.evaluate(() => navigator.serviceWorker.ready);
  await offline.p.reload();
  await offline.p.waitForFunction(() => navigator.serviceWorker.controller);
  await offline.ctx.setOffline(true);
  await offline.p.reload();
  await offline.p.locator('#sync-status').waitFor();
  await nav(offline.p, 'progress');
  assert.equal(await offline.p.locator('.chart-col small').count(), 28);
  await offline.ctx.setOffline(false);
  assert.ok(
    (
      await offline.p.evaluate(async () => {
        const keys = await caches.keys();
        return Promise.all(
          keys.map(async (k) => (await (await caches.open(k)).keys()).map((r) => r.url))
        );
      })
    )
      .flat()
      .every((x) => x.startsWith(origin))
  );
  await nav(offline.p, 'progress');
  await offline.p
    .locator('.line-chart')
    .first()
    .evaluate((e) => e.parentElement.scrollIntoView({ behavior: 'instant', block: 'start' }));
  await offline.p.screenshot({ path: resolve(output, 'progress.png') });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browser: engine.name(),
      result: 'PASS',
      layouts: 35,
      checks: [
        'explicit migration',
        'two isolated device contexts',
        'same-day conflict and explicit resolution',
        'refresh persistence',
        'JSON/CSV/AES-GCM roundtrip',
        'safe note rendering',
        'Safari/PWA ticket fallback',
        'static offline cache'
      ],
      writes,
      screenshots: output
    })
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
