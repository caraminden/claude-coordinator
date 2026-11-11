// rail.js in a real browser (headless Chromium, test/browser.ts): an app greyed out at load, or whose icon
// failed, comes back by itself without a reload, and a recheck Citadel doesn't answer keeps the rail; in an
// installed app's window, another app opens in Citadel's layer over the page, and Alt+` switches there too (#311).
// The page shortens the rail's 15 s waits to 50 ms, and ?installed stands in for an installed app's window.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const pub = join(import.meta.dirname, '..', 'public');
const rail = readFileSync(join(pub, 'rail.js'));
// Citadel's page, as far as the rail goes: it draws its own (public/rail.js as Citadel imports it).
const CITADEL = `<!doctype html><meta charset="utf-8"><body><script type="module">import { showRail } from '/c/rail.js'; showRail();</script>`;

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body>
<script>
  const later = window.setTimeout;
  window.setTimeout = (fn, ms, ...a) => later(fn, ms >= 15000 ? 50 : ms, ...a);
  const media = window.matchMedia.bind(window);
  if (location.search === '?installed') window.matchMedia = (q) => (q.includes('display-mode') ? { matches: true, addEventListener() {} } : media(q));
</script>
<script type="module">
  await import('/apps/_citadel/rail.js');
  window.ready = true;
</script>`;

// What the fake Citadel answers: toc up or down, its icon broken, or no answer at all.
const state = { tocUp: true, iconBroken: false, citadelDown: false, citadel502: false };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#f93"/></svg>';
let server: Server;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/apps/peek/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (path === '/c/') return res.writeHead(200, { 'content-type': 'text/html' }).end(CITADEL);
    if (path === '/c/rail.js' || path === '/c/appswitch.js' || path === '/apps/_citadel/appswitch.js') {
      return res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(pub, path.endsWith('rail.js') ? 'rail.js' : 'appswitch.js')));
    }
    if (path === '/c/api/me') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"name":"josh"}');
    if (path === '/apps/_citadel/rail.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(rail);
    if (path === '/c/api/contraptions/mine') {
      if (state.citadelDown) return req.socket.destroy();
      if (state.citadel502) return res.writeHead(502).end();
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
/** ToC's entry once it reads `want`, or what it reads after 10 s. */
async function until(page: Page, want: string) {
  let got = '';
  for (const end = Date.now() + 10_000; (got = await toc(page)) !== want && Date.now() < end; await wait(25));
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

test('a 502 from Citadel (its proxy while it restarts) keeps the rail on a recheck, and a page loaded during one draws it once Citadel is back', { skip }, async () => {
  Object.assign(state, { tocUp: false, iconBroken: false, citadelDown: false, citadel502: false });
  const page = await browser.page(base, { width: 1000 });
  assert.equal(await until(page, 'tile'), 'tile', 'greyed out at load');
  state.citadel502 = true;
  await wait(300);
  assert.equal(await toc(page), 'tile', 'a 502 on a recheck: the rail stays as it was');
  state.citadel502 = false;
  state.tocUp = true;
  assert.equal(await until(page, 'img'), 'img', 'back once it is up');
  state.citadel502 = true;
  const later = await browser.page(base, { width: 1000 });
  await wait(300);
  assert.equal(await toc(later), 'none', 'no rail while Citadel answers 502');
  state.citadel502 = false;
  assert.equal(await until(later, 'img'), 'img', 'drawn once Citadel answers');
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

const layer = (page: Page) => page.eval<string>(`(() => {
  const l = document.querySelector('.citadel-layer');
  return l ? (l.hidden ? 'hidden' : 'shown ' + l.querySelector('iframe').contentWindow.location.hash) + (document.body.inert ? ' inert' : '') : 'none';
})()`);
async function untilLayer(page: Page, want: string) {
  let got = '';
  for (const end = Date.now() + 10_000; (got = await layer(page)) !== want && Date.now() < end; await wait(25));
  return got;
}

test("in an installed app's window, another app opens in Citadel's layer over it, and picking this app there puts it away", { skip }, async () => {
  Object.assign(state, { tocUp: true, iconBroken: false, citadelDown: false });
  const page = await browser.page(base + '?installed', { width: 1000 });
  assert.equal(await until(page, 'img'), 'img', 'the rail drew, ToC with its icon');
  assert.equal(await page.eval('document.querySelector(".citadel-rail a[target]")'), null, 'no new-window links any more');
  await page.eval(`document.querySelector('.citadel-rail a[data-app="toc"]').click()`);
  assert.equal(await untilLayer(page, 'shown #/apps/toc inert'), 'shown #/apps/toc inert', "Citadel's page at ToC, over this one");
  const inFrame = (sel: string) => `document.querySelector('.citadel-layer iframe').contentDocument.querySelector(${JSON.stringify(sel)})`;
  await waitFor(page, "Citadel's rail in the layer", `!!${inFrame('.citadel-rail a[data-app="peek"]')}`);
  await page.eval(`${inFrame('.citadel-rail a[data-app="peek"]')}.click()`);
  assert.equal(await untilLayer(page, 'hidden'), 'hidden', 'this app picked in the layer: back to its own page');
  await page.eval(`document.querySelector('.citadel-rail a[data-app=""]').click()`);
  assert.equal(await untilLayer(page, 'shown #/ inert'), 'shown #/ inert', "Citadel's entry: the same layer, at Citadel's own view");
});

test("in a tab, the rail's entries stay plain links into Citadel", { skip }, async () => {
  const page = await browser.page(base, { width: 1000 });
  assert.equal(await until(page, 'img'), 'img', 'the rail drew, ToC with its icon');
  assert.equal(await page.eval(`document.querySelector('.citadel-rail a[data-app="toc"]').getAttribute('href')`), '/c/#/apps/toc');
  await page.eval(`document.querySelector('.citadel-rail a[data-app="toc"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`);
  assert.equal(await layer(page), 'none');
});

test("Alt+\` switches apps on a contraption's own page too", { skip }, async () => {
  const page = await browser.page(base + '?installed', { width: 1000 });
  assert.equal(await until(page, 'img'), 'img', 'the rail drew, ToC with its icon');
  // The switcher records the app you're in once it knows who you are (appswitch.js initAppSwitch); each page has
  // its own storage (browser.ts), so this is this page's switcher ready, not a key an earlier page left behind.
  await waitFor(page, 'the switcher to know the person (citadel-app-switch:josh)', '!!localStorage.getItem("citadel-app-switch:josh")');
  const key = (type: string, key: string, code: string, modifiers: number) => page.send('Input.dispatchKeyEvent', { type, key, code, modifiers });
  await key('rawKeyDown', 'Alt', 'AltLeft', 1);
  await key('rawKeyDown', '`', 'Backquote', 1);
  assert.match(await page.eval<string>(`document.querySelector('.app-switch [aria-selected=true]')?.textContent ?? 'none'`), /Citadel|ToC/);
  await key('keyUp', '`', 'Backquote', 1);
  await key('keyUp', 'Alt', 'AltLeft', 0);
  // Citadel (no hash yet: its first view) or ToC, whichever the switcher had picked.
  await waitFor(page, 'the layer to open', `!!document.querySelector('.citadel-layer:not([hidden])')`);
  assert.match(await layer(page), /^shown (#\/apps\/toc)? ?inert$/, 'letting go of Alt opens the one picked, in the layer');
});
