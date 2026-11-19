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
const CITADEL = `<!doctype html><meta charset="utf-8"><body><script type="module">import { showRail } from '/c/rail.js'; showRail(); window.ready = true;</script>`;

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body>
<script>
  const later = window.setTimeout;
  window.setTimeout = (fn, ms, ...a) => later(fn, ms >= 15000 ? 50 : ms, ...a);
  const media = window.matchMedia.bind(window);
  if (location.search === '?native') window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
  if (location.search === '?installed') window.matchMedia = (q) => (q.includes('display-mode') ? { matches: true, addEventListener() {} } : media(q));
</script>
<script type="module">
  await import('/apps/_citadel/rail.js');
  window.ready = true;
</script>`;

// What the fake Citadel answers: toc up or down, its icon broken, or no answer at all.
const state = { tocUp: true, iconBroken: false, citadelDown: false, citadel502: false, citadel401: false, citadelAt: null as string | null };
// The orders the rail saved (#649), and how the next saves go: failing, or answered late.
const orders = { saved: [] as string[][], fail: false, delay: 0 };
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#f93"/></svg>';
let closed401 = 0;
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
    // What the rail imports beside it (#649): drag to reorder and Citadel UI's optimistic save.
    const beside = path.match(/^\/(?:c|apps\/_citadel)\/(reorder\.js|extlinks\.js|ui\/(?:optimistic|status)\.js)$/)?.[1];
    if (beside) return res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(pub, beside)));
    if (path === '/c/api/me/order/apps' && req.method === 'PUT') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => setTimeout(() => {
        if (orders.fail) return res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"disk full"}');
        orders.saved.push(JSON.parse(body).keys);
        res.writeHead(200, { 'content-type': 'application/json' }).end(body);
      }, orders.delay));
      return;
    }
    // Citadel's list (its own page) and the kit's (a contraption's page: who is signed in, and Citadel's address
    // when it's on another host, src/apps.ts kit).
    if (path === '/c/api/contraptions/mine' || path === '/apps/_citadel/api/mine') {
      if (state.citadelDown) return req.socket.destroy();
      if (state.citadel502) return res.writeHead(502).end();
      // A proxy that answers 401 and keeps the body open: the page never goes idle unless the rail lets go of it.
      if (state.citadel401) {
        res.on('close', () => (closed401 += 1));
        return res.writeHead(401, { 'content-type': 'application/json' }).write('{"error":');
      }
      const apps = [
        { name: 'peek', title: 'Peek', icon: '/icon.svg', up: true },
        { name: 'toc', title: 'ToC', icon: '/icon.svg', up: state.tocUp },
      ];
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(path.startsWith('/c/') ? apps : { name: 'josh', citadel: state.citadelAt, apps }));
    }
    const icon = path.match(/^\/apps\/_citadel\/icon\/([a-z]+)$/)?.[1];
    if (path === '/c/icon.svg' || (icon && !(icon === 'toc' && state.iconBroken))) return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(svg);
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
/** Two more of this page's own asks answered: rechecks follow one another, so the first answer has been handled. Other open pages ask too, so the server's count won't do. */
async function twoAsks(page: Page) {
  await page.eval(`(() => {
    const real = window.fetch;
    window.asked = 0;
    window.fetch = (...a) => real(...a).finally(() => { if (String(a[0]?.url ?? a[0]).endsWith('/mine')) window.asked++; });
  })()`);
  await waitFor(page, 'two rechecks', 'window.asked >= 2');
}
const mark = (page: Page) => page.eval('document.querySelector(".citadel-rail").dataset.first = "1"');
const sameRail = (page: Page) => page.eval<boolean>('document.querySelector(".citadel-rail")?.dataset.first === "1"');

test('an app down when the page loaded comes back without a reload, and a recheck Citadel misses keeps the rail', { skip }, async () => {
  Object.assign(state, { tocUp: false, iconBroken: false, citadelDown: false });
  const page = await browser.page(base, { width: 1000 });
  assert.equal(await until(page, 'tile'), 'tile', 'greyed out at load');
  state.citadelDown = true;
  await twoAsks(page);
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
  await twoAsks(page);
  assert.equal(await toc(page), 'tile', 'a 502 on a recheck: the rail stays as it was');
  state.citadel502 = false;
  state.tocUp = true;
  assert.equal(await until(page, 'img'), 'img', 'back once it is up');
  state.citadel502 = true;
  const later = await browser.page(base, { width: 1000 });
  await twoAsks(later);
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

test("in an app's native shell (a Capacitor WebView), the page gets no rail, handle or switcher", { skip }, async () => {
  const page = await browser.page(`${base}?native`, { width: 400 });
  await waitFor(page, 'the page loaded', 'window.ready === true');
  await wait(300);
  assert.equal(await page.eval(`document.querySelectorAll('.citadel-rail, .citadel-rail-handle, [class*="citadel-rail"]').length`), 0, 'nothing of the rail');
  assert.equal(await page.eval(`document.documentElement.classList.contains('has-citadel-rail')`), false);
});

test("in a tab, the rail's entries stay plain links into Citadel", { skip }, async () => {
  const page = await browser.page(base, { width: 1000 });
  assert.equal(await until(page, 'img'), 'img', 'the rail drew, ToC with its icon');
  assert.equal(await page.eval(`document.querySelector('.citadel-rail a[data-app="toc"]').getAttribute('href')`), '/c/#/apps/toc');
  // The click would follow the link, and an evaluate sent while the tab leaves for /c/ dies with "Inspected target
  // navigated or closed" (#725). So the page's last listener notes whether the rail left the click alone, then stops it.
  const prevented = await page.eval<boolean>(`(() => {
    let prevented;
    addEventListener('click', (e) => { prevented = e.defaultPrevented; e.preventDefault(); }, { once: true });
    document.querySelector('.citadel-rail a[data-app="toc"]').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return prevented;
  })()`);
  assert.equal(prevented, false, 'the rail leaves the click to the browser');
  assert.equal(await layer(page), 'none');
  assert.equal(await page.eval('location.pathname'), '/apps/peek/', 'the test itself stopped the click, so the page is still here');
});

test("Citadel loaded at a framed app's address: its own entry still points at a view, so a click doesn't reload Citadel (#468 S12-7)", { skip }, async () => {
  Object.assign(state, { tocUp: true, iconBroken: false, citadelDown: false, citadel502: false });
  const page = await browser.page(base.replace('/apps/peek/', '/c/#/apps/toc'), { width: 1000 });
  await waitFor(page, "Citadel's rail", `!!document.querySelector('.citadel-rail a[data-app="toc"]')`);
  assert.equal(await page.eval(`document.querySelector('.citadel-rail a[data-app=""]').getAttribute('href')`), '/c/#/');
});

test("a reload on a framed app keeps Citadel's entry on the minion you left, not the start scheme's Taskmaster (#675)", { skip }, async () => {
  Object.assign(state, { tocUp: true, iconBroken: false, citadelDown: false, citadel502: false });
  const page = await browser.page(base.replace('/apps/peek/', '/c/#/p/2/t/9'), { width: 1000 });
  const entry = `document.querySelector('.citadel-rail a[data-app=""]')?.getAttribute('href')`;
  await waitFor(page, "Citadel's rail on the minion", `${entry} === '/c/#/p/2/t/9'`);
  await page.eval(`location.hash = '#/apps/toc'`);
  await waitFor(page, 'ToC current', `!!document.querySelector('.citadel-rail a[data-app="toc"].current')`);
  // The framed app's own rail.js loads too (and hides its rail, Citadel's being beside it): it mustn't wipe the memory.
  await page.eval(`document.body.append(Object.assign(document.createElement('iframe'), { src: '/apps/peek/' }))`);
  await waitFor(page, "the framed app's rail.js", `document.querySelector('iframe')?.contentWindow.ready === true`);
  await page.eval(`window.beforeReload = true; setTimeout(() => location.reload(), 0)`);
  await waitFor(page, "Citadel's rail after the reload", `!window.beforeReload && window.ready && !!document.querySelector('.citadel-rail a[data-app="toc"].current')`);
  assert.equal(await page.eval(entry), '/c/#/p/2/t/9');
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

// Drag to reorder the apps (#649): Citadel's own rail, as a wide screen shows it.
const appOrder = (page: Page) => page.eval<string[]>(`[...document.querySelectorAll('.citadel-rail a[data-app]')].map((a) => a.dataset.app)`);
/** Drag ToC's or Peek's tile to `toY` with the mouse, in small steps. */
async function mouseDrag(page: Page, app: string, toY: number) {
  const { x, y } = await page.centre(`.citadel-rail a[data-app="${app}"]`);
  const mouse = (type: string, my: number) => page.send('Input.dispatchMouseEvent', { type, x, y: my, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
  await mouse('mousePressed', y);
  for (let i = 1; i <= 6; i++) await mouse('mouseMoved', y + ((toY - y) * i) / 6);
  await mouse('mouseReleased', toY);
}
const citadel = () => base.replace('/apps/peek/', '/c/');
/** Until the fake Citadel has taken `n` saves (10 s at most). */
async function saves(n: number) {
  for (const end = Date.now() + 10_000; orders.saved.length < n && Date.now() < end; await wait(20));
  return orders.saved;
}

test('a mouse drag moves an app at once, saves the order, and opens nothing; two quick drags both count', { skip }, async () => {
  Object.assign(state, { tocUp: true, iconBroken: false, citadelDown: false, citadel502: false });
  Object.assign(orders, { saved: [], fail: false, delay: 300 });
  const page = await browser.page(citadel(), { width: 1000, height: 500 });
  await waitFor(page, "Citadel's rail", `!!document.querySelector('.citadel-rail a[data-app="toc"]')`);
  assert.deepEqual(await appOrder(page), ['', 'peek', 'toc']);
  const peek = await page.centre('.citadel-rail a[data-app="peek"]');
  await mouseDrag(page, 'toc', peek.y - 15);
  assert.deepEqual(await appOrder(page), ['', 'toc', 'peek'], 'moved the moment it dropped, before the save answers');
  assert.equal(await page.eval('location.hash'), '', 'the drop opened nothing');
  // Straight away, back again, while the first save is still on its way.
  const top = await page.centre('.citadel-rail a[data-app="toc"]');
  await mouseDrag(page, 'peek', top.y - 15);
  assert.deepEqual(await appOrder(page), ['', 'peek', 'toc']);
  assert.deepEqual(await saves(2), [['toc', 'peek'], ['peek', 'toc']], 'both saved, in the order dropped');
  // A slow click (held half a second, not moved) still opens the app: a mouse drags only once it moves.
  const at = await page.centre('.citadel-rail a[data-app="toc"]');
  const mouse = (type: string) => page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  await mouse('mousePressed');
  await wait(500);
  await mouse('mouseReleased');
  assert.equal(await page.eval('location.hash'), '#/apps/toc');
});

test('Alt+Up and Alt+Down move the focused app, and focus stays on it', { skip }, async () => {
  Object.assign(orders, { saved: [], fail: false, delay: 0 });
  const page = await browser.page(citadel(), { width: 1000, height: 500 });
  await waitFor(page, "Citadel's rail", `!!document.querySelector('.citadel-rail a[data-app="toc"]')`);
  await page.eval(`document.querySelector('.citadel-rail a[data-app="toc"]').focus()`);
  const key = (type: string) => page.send('Input.dispatchKeyEvent', { type, key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, modifiers: 1 });
  await key('rawKeyDown');
  await key('keyUp');
  assert.deepEqual(await appOrder(page), ['', 'toc', 'peek']);
  assert.equal(await page.eval('document.activeElement.dataset.app'), 'toc');
  await key('rawKeyDown');
  await key('keyUp');
  assert.deepEqual(await appOrder(page), ['', 'toc', 'peek'], 'already first among the apps: Citadel stays above');
  assert.deepEqual(await saves(1), [['toc', 'peek']]);
});

test('a failed save puts the app back and says so with a Retry', { skip }, async () => {
  Object.assign(orders, { saved: [], fail: true, delay: 0 });
  const page = await browser.page(citadel(), { width: 1000, height: 500 });
  await waitFor(page, "Citadel's rail", `!!document.querySelector('.citadel-rail a[data-app="toc"]')`);
  const peek = await page.centre('.citadel-rail a[data-app="peek"]');
  await mouseDrag(page, 'toc', peek.y - 15);
  await waitFor(page, 'the failure toast', `/Couldn't save the order of your apps: disk full/.test(document.querySelector('.cui-toast')?.textContent ?? '')`);
  assert.deepEqual(await appOrder(page), ['', 'peek', 'toc'], 'back where it was');
  orders.fail = false;
  await page.eval(`[...document.querySelectorAll('.cui-toast button')].find((b) => b.textContent === 'Retry').click()`);
  await waitFor(page, 'the retried save', `[...document.querySelectorAll('.citadel-rail a[data-app]')].map((a) => a.dataset.app).join() === ',toc,peek'`);
  assert.deepEqual(await saves(1), [['toc', 'peek']]);
});

test("an older drop's Retry, after a newer drop saved, leaves the newer order alone", { skip }, async () => {
  Object.assign(orders, { saved: [], fail: true, delay: 0 });
  const page = await browser.page(citadel(), { width: 1000, height: 500 });
  await waitFor(page, "Citadel's rail", `!!document.querySelector('.citadel-rail a[data-app="toc"]')`);
  const peek = await page.centre('.citadel-rail a[data-app="peek"]');
  await mouseDrag(page, 'toc', peek.y - 15);
  await waitFor(page, 'the failure toast', `/Couldn't save the order/.test(document.querySelector('.cui-toast')?.textContent ?? '')`);
  orders.fail = false;
  // A newer drop of its own, which saves: the same move, then ToC back down.
  await mouseDrag(page, 'toc', peek.y - 15);
  const peekNow = await page.centre('.citadel-rail a[data-app="peek"]');
  await mouseDrag(page, 'toc', peekNow.y + 15);
  assert.deepEqual(await saves(2), [['toc', 'peek'], ['peek', 'toc']]);
  await page.eval(`[...document.querySelectorAll('.cui-toast button')].find((b) => b.textContent === 'Retry')?.click()`);
  await wait(200);
  assert.deepEqual(await appOrder(page), ['', 'peek', 'toc'], 'the newest drop stands');
  assert.deepEqual(orders.saved, [['toc', 'peek'], ['peek', 'toc']], 'and nothing older is sent');
});

test('on a touch screen a held press drags, and a swipe that moves at once does not', { skip }, async () => {
  Object.assign(orders, { saved: [], fail: false, delay: 0 });
  const page = await browser.page(citadel(), { width: 1000, height: 500, touch: true });
  await waitFor(page, "Citadel's rail", `!!document.querySelector('.citadel-rail a[data-app="toc"]')`);
  const peek = await page.centre('.citadel-rail a[data-app="peek"]');
  const toc = await page.centre('.citadel-rail a[data-app="toc"]');
  const touch = (type: string, y?: number) => page.send('Input.dispatchTouchEvent', { type, touchPoints: y === undefined ? [] : [{ x: toc.x, y }] });
  const drag = async (holdMs: number) => {
    await touch('touchStart', toc.y);
    await wait(holdMs);
    for (let i = 1; i <= 6; i++) await touch('touchMove', toc.y + ((peek.y - 15 - toc.y) * i) / 6);
    await touch('touchEnd');
  };
  await drag(0);
  assert.deepEqual(await appOrder(page), ['', 'peek', 'toc'], 'a swipe is a scroll, not a drag');
  await drag(500);
  assert.deepEqual(await appOrder(page), ['', 'toc', 'peek'], 'held, then dragged: moved');
  assert.deepEqual(await saves(1), [['toc', 'peek']], 'one save: the swipe sent none');
});

test('a 401 from Citadel whose body never ends is let go by the rail, so the page can go network-idle', { skip }, async () => {
  Object.assign(state, { tocUp: true, iconBroken: false, citadelDown: false, citadel502: false, citadel401: true });
  closed401 = 0;
  const page = await browser.page(base, { width: 1000 });
  try {
    for (const end = Date.now() + 5000; !closed401 && Date.now() < end; await wait(25));
    assert.ok(closed401 > 0, 'the rail cancelled the unread 401 body');
  } finally {
    state.citadel401 = false;
  }
  assert.equal(await page.eval<string>('document.querySelector(".citadel-rail") ? "rail" : "none"'), 'none', 'no session: no rail');
});
