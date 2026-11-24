// public/slow-moments.js, the slow-load recorder (#1752), in a real browser (headless Chromium, test/browser.ts): a
// frozen tab, a slow request and a slow page opening each become one row with its split, and a report the server
// couldn't take is kept on the device and sent on the next load. The server side is test/slow-moments.test.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, serve, skipMessage, type App, type Browser, type Page } from './browser.ts';
import { until } from './wait.ts';

const bin = chromium();
const skip = !bin && skipMessage;
const RECORDER = readFileSync(join(import.meta.dirname, '..', 'public', 'slow-moments.js'), 'utf8');
const PAGE = '<!doctype html><meta charset="utf-8"><script src="/slow-moments.js"></script><script>addEventListener("load", () => setTimeout(() => { window.ready = true; }))</script><body><p>page</p></body>';

type Row = { kind: string; what: string; page: string; total: number; server: number | null; network: number; tab_ms: number; tab: string };
let app: App;
let browser: Browser;
let reports: { device: string; tab: string; moments: Row[] }[] = [];
let refuse = false;

before(async () => {
  if (skip) return;
  app = await serve((path, res) => {
    if (path === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (path === '/slow-moments.js') return void res.writeHead(200, { 'content-type': 'text/javascript' }).end(RECORDER);
    // A request the server spends 2.1 s on, as its stamp says: the answer itself comes 2.3 s after it was asked.
    if (path === '/api/slow') return void setTimeout(() => res.writeHead(200, { 'server-timing': 'app;dur=2100.0' }).end('{}'), 2300);
    if (path === '/api/slow-moments') {
      if (refuse) return void res.writeHead(503).end();
      const chunks: Buffer[] = [];
      res.req.on('data', (c: Buffer) => chunks.push(c)).on('end', () => {
        reports.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(202).end('{}');
      });
      return;
    }
    res.writeHead(404).end();
  });
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await app?.close();
});

/** A page with the recorder running and its load moment past (window.ready), so what follows is all a test does. */
async function open(): Promise<Page> {
  reports = [];
  return browser.page(app.base);
}
const rows = (kind: string) => reports.flatMap((r) => r.moments).filter((m) => m.kind === kind);
/** Go to `hash` and wait for its hashchange, which is when the recorder notes the page. */
const go = (hash: string) => `new Promise((r) => { addEventListener('hashchange', r, { once: true }); location.hash = '${hash}'; })`;
const SLOW_FETCH = `(async () => { const start = performance.now(); const res = await fetch('/api/slow'); globalThis.citadelSlow.request('GET', '/api/slow?x=1', start, res); })()`;

test('a tab frozen over 2 s is one row, nearly all of it tab time', { skip }, async () => {
  const page = await open();
  await page.eval(go('#/p/7/t/3'));
  await page.eval(`(() => { const t = performance.now(); while (performance.now() - t < 2600) {} })()`);
  const [freeze] = await until('the freeze was reported', () => rows('freeze').length && rows('freeze'));
  assert.equal(freeze.page, '#/p/7/t/3');
  assert.ok(freeze.total > 2000 && freeze.tab_ms > 2000, JSON.stringify(freeze));
  assert.equal(freeze.server, null);
  assert.match(reports[0].tab, /^[a-z0-9]{1,4}$/);
  assert.equal(freeze.tab, reports[0].tab);
});

test('a slow request splits into the server time it was stamped with and the network', { skip }, async () => {
  const page = await open();
  await page.eval(go('#/p/7'));
  const ask = page.eval(SLOW_FETCH);
  // Left while it was waiting: the wait still belongs to the page it was asked on.
  await page.eval(go('#/status'));
  await ask;
  const [req] = await until('the request was reported', () => rows('request').length && rows('request'));
  assert.equal(req.what, 'GET /api/slow');
  assert.equal(req.page, '#/p/7');
  assert.equal(req.server, 2100);
  assert.ok(req.network > 0 && req.network < req.total - 2100 + 1, JSON.stringify(req));
  assert.ok(req.tab_ms < 500, JSON.stringify(req));
});

test('opening a page that waits over 2 s is one row, named by its slowest request', { skip }, async () => {
  const page = await open();
  await page.eval(`(async () => {
    // As core.js does it: the address changes, then route() (a hashchange listener after the recorder's) dims the page.
    location.hash = '#/p/7/status';
    await new Promise((r) => addEventListener('hashchange', r, { once: true }));
    document.body.classList.add('navigating');
    await ${SLOW_FETCH};
    document.body.classList.remove('navigating');
  })()`);
  const [opening] = await until('the opening was reported', () => rows('open').length && rows('open'));
  assert.equal(opening.what, 'GET /api/slow');
  assert.equal(opening.server, 2100);
  assert.equal(opening.page, '#/p/7/status', 'the page it opened, not the one it left');
  assert.deepEqual(rows('request'), [], 'its request is inside the opening, not a row of its own');
});

test('a report the server could not take is kept and sent on the next load', { skip }, async () => {
  refuse = true;
  try {
    const page = await open();
    await page.eval(`(() => { const t = performance.now(); while (performance.now() - t < 2600) {} })()`);
    await until('the freeze was kept on the device', () => page.eval(`JSON.parse(localStorage.getItem('cc-slow-moments') || '[]').length === 1`));
    assert.deepEqual(reports, []);
    refuse = false;
    await page.eval('location.reload()');
    const [freeze] = await until('the kept freeze was sent after the reload', () => rows('freeze').length && rows('freeze'));
    assert.ok(freeze.tab_ms > 2000);
    await until('the device dropped what was taken', () => page.eval(`localStorage.getItem('cc-slow-moments') === null`));
  } finally {
    refuse = false;
  }
});
