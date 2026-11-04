// rail.js in a real browser (headless Chromium, test/browser.ts): an app greyed out at load, or whose icon
// failed, comes back by itself without a reload, and a recheck Citadel doesn't answer keeps the rail (#311).
// The page shortens the rail's 15 s waits to 50 ms; the server picks a free port (0).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const rail = readFileSync(join(import.meta.dirname, '..', 'public', 'rail.js'));

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body>
<script>
  const later = window.setTimeout;
  window.setTimeout = (fn, ms, ...a) => later(fn, ms >= 15000 ? 50 : ms, ...a);
</script>
<script type="module">
  await import('/apps/_citadel/rail.js');
  window.ready = true;
</script>`;

// What the fake Citadel answers: toc up or down, its icon broken, or no answer at all.
const state = { tocUp: true, iconBroken: false, citadelDown: false };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#f93"/></svg>';
let server: Server;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/apps/peek/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (path === '/apps/_citadel/rail.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(rail);
    if (path === '/c/api/contraptions/mine') {
      if (state.citadelDown) return req.socket.destroy();
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify([
        { name: 'peek', title: 'Peek', icon: '/icon.svg', up: true },
        { name: 'toc', title: 'ToC', icon: '/icon.svg', up: state.tocUp },
      ]));
    }
    if (path.endsWith('icon.svg') && !(path.startsWith('/apps/toc/') && state.iconBroken)) return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(svg);
    res.writeHead(path.startsWith('/apps/toc/') ? 502 : 404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/apps/peek/`;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r(null)));
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** ToC's entry: 'img', 'tile' or 'none' (no rail), and whether the rail is still the element first drawn. */
const toc = (page: Page) => page.eval<string>(`(() => {
  const a = document.querySelector('.citadel-rail a[data-app="toc"]');
  return a ? (a.querySelector('img') ? 'img' : 'tile') : 'none';
})()`);
/** ToC's entry once it reads `want`, or what it reads after 2 s. */
async function until(page: Page, want: string) {
  let got = '';
  for (const end = Date.now() + 2000; (got = await toc(page)) !== want && Date.now() < end; await wait(25));
  return got;
}
const mark = (page: Page) => page.eval('document.querySelector(".citadel-rail").dataset.first = "1"');
const sameRail = (page: Page) => page.eval<boolean>('document.querySelector(".citadel-rail")?.dataset.first === "1"');

test('an app down when the page loaded comes back without a reload, and a recheck Citadel misses keeps the rail', { skip }, async () => {
  Object.assign(state, { tocUp: false, iconBroken: false, citadelDown: false });
  const page = await browser.page(base, { width: 1000 });
  assert.equal(await until(page, 'tile'), 'tile', 'greyed out at load');
  state.citadelDown = true;
  await wait(300);
  assert.equal(await toc(page), 'tile', 'Citadel restarting: the rail stays as it was');
  state.citadelDown = false;
  state.tocUp = true;
  assert.equal(await until(page, 'img'), 'img', 'back once it is up');
  await mark(page);
  await wait(300);
  assert.ok(await sameRail(page), 'nothing down: no more redraws');
});

test('an icon that fails to load comes back in place, without redrawing the rail', { skip }, async () => {
  Object.assign(state, { tocUp: true, iconBroken: true, citadelDown: false });
  const page = await browser.page(base, { width: 1000 });
  assert.equal(await until(page, 'tile'), 'tile');
  await mark(page);
  state.iconBroken = false;
  assert.equal(await until(page, 'img'), 'img');
  assert.ok(await sameRail(page), 'the same rail, so focus on it stays put');
});
