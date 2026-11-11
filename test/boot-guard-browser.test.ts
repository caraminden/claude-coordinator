// The app's own page (public/index.html) when one of its modules doesn't arrive, in a real browser (headless Chromium,
// test/browser.ts). #479: Mike's Firefox got no core.js (a restart's gap), so app.js never ran: no login, no message,
// and the ↻ button, whose handler app.js adds, did nothing. Only wiping the site's data got him back in.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, normalize } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const pub = join(import.meta.dirname, '..', 'public');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let server: Server;
let browser: Browser;
let base = '';
/** How many times the page itself was asked for, and whether core.js answers 502 (as Caddy does while the server restarts). */
let pageLoads = 0;
let coreFails = true;

before(async () => {
  if (skip) return;
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    // Signed out, as Mike's sign-in check would have said had it run.
    if (path.startsWith('/api/')) return res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Not logged in"}');
    if (path === '/core.js' && coreFails) return res.writeHead(502).end();
    if (path === '/') pageLoads++;
    const file = normalize(join(pub, path === '/' ? 'index.html' : path));
    const type = TYPES[file.slice(file.lastIndexOf('.'))];
    if (!file.startsWith(pub) || !type) return res.writeHead(404).end();
    let body: string;
    try {
      body = readFileSync(file, 'utf8');
    } catch {
      return res.writeHead(404).end();
    }
    // test/browser.ts opens a page once it says it's ready: at once here, before any module has run.
    if (path === '/') body = body.replace('</head>', '<script>window.ready = true</script></head>');
    res.writeHead(200, { 'content-type': type }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r(null)));
});

test('a module that fails to load says so, and its Try again reloads into a working page', { skip }, async () => {
  coreFails = true;
  pageLoads = 0;
  const page = await browser.page(base);
  await waitFor(page, 'the load failure message', `document.querySelector('#app > p.error')?.textContent.includes("Couldn't open")`);
  assert.equal(await page.eval(`document.querySelector('#app > p.error').textContent`), "Couldn't open Citadel: part of the page didn't load. Try again in a moment.");
  coreFails = false;
  await page.eval(`document.querySelector('#app > button').click()`);
  await waitFor(page, 'the sign-in form after the reload', `!!document.querySelector('#login-form')`);
  assert.equal(pageLoads, 2, 'Try again loaded the page again');
});

test('the top bar ↻ reloads the page too when the app never started', { skip }, async () => {
  coreFails = true;
  pageLoads = 0;
  const page = await browser.page(base);
  await waitFor(page, 'the load failure message', `!!document.querySelector('#app > p.error')`);
  coreFails = false;
  await page.eval(`document.querySelector('.topbar .refresh-btn').click()`);
  await waitFor(page, 'the sign-in form after the reload', `!!document.querySelector('#login-form')`);
  assert.equal(pageLoads, 2);
});

test('a page that loads whole shows no failure message', { skip }, async () => {
  coreFails = false;
  const page = await browser.page(base);
  await waitFor(page, 'the sign-in form', `!!document.querySelector('#login-form')`);
  assert.equal(await page.eval(`!!document.querySelector('#app > p.error')`), false);
});
