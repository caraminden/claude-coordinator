// Citadel and a contraption on two origins (#709: contraptions on their own hosts), in a real browser (test/browser.ts):
// everything that used to reach across the frame by hand now goes by postMessage (citadel-frame-1, public/rail.js),
// so it has to work when neither page can read the other. Citadel here is 127.0.0.1 and the contraption localhost,
// two origins on one test server: its bar runs up into Citadel's title bar strip, Alt+` reaches Citadel's switcher,
// its handle opens Citadel's rail on a phone, and in its installed window Citadel's layer over it puts itself away.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const pub = join(import.meta.dirname, '..', 'public');

// Citadel's page, as far as a framed contraption goes: its rail, its switcher and the frame (public/frames.js).
// It keeps what the contraption tells it for the test (`test` messages: they aren't the protocol's).
const FRAMER = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/c/style.css"><body><main></main>
<script type="module">
  import { showRail } from '/c/rail.js';
  import { showFrame } from '/c/frames.js';
  import { initAppSwitch } from '/c/appswitch.js';
  window.echo = {};
  addEventListener('message', (e) => { if (e.data?.test) window.echo[e.data.test] = e.data.value; });
  showRail();
  initAppSwitch('josh');
  showFrame('peek', new URLSearchParams(location.search).get('src'));
  window.ready = true;
</script>`;
// Citadel's page in a contraption's layer: just its rail.
const CITADEL = `<!doctype html><meta charset="utf-8"><body><script type="module">import { showRail } from '/c/rail.js'; showRail(); window.ready = true;</script>`;

// The contraption: a Citadel UI top bar with a control, and what it got back from Citadel told to its parent for the test.
const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<style>body { margin: 0; } .cui-topbar { display: flex; align-items: center; height: 44px; padding-top: var(--citadel-strip-h, 0px); background: rgb(20, 90, 160); }</style>
<script>
  const media = window.matchMedia.bind(window);
  if (location.search === '?installed') window.matchMedia = (q) => (q.includes('display-mode') ? { matches: true, addEventListener() {} } : media(q));
</script>
<header class="cui-topbar"><button>Menu</button></header>
<script type="module">
  await import('/apps/_citadel/rail.js');
  const tell = (test, value) => parent !== window && parent.postMessage({ test, value }, '*');
  new MutationObserver(() => tell('strip', document.documentElement.style.getPropertyValue('--citadel-strip-h')))
    .observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  setInterval(() => {
    const h = document.querySelector('.citadel-rail-handle');
    const r = h && !h.hidden && h.getBoundingClientRect();
    tell('handle', r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null);
  }, 50);
  window.ready = true;
</script>`;

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#f93"/></svg>';
const apps = [{ name: 'peek', title: 'Peek', icon: '/icon.svg', up: true }, { name: 'toc', title: 'ToC', icon: '/icon.svg', up: true }];
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
let server: Server;
let browser: Browser;
let port = 0;
const citadel = () => `http://127.0.0.1:${port}`;
const contraption = () => `http://localhost:${port}`;

before(async () => {
  if (skip) return;
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const host = req.headers.host?.split(':')[0];
    const send = (type: string, body: string | Buffer) => res.writeHead(200, { 'content-type': type }).end(body);
    if (host === 'localhost') {
      // The contraption's host serves only the contraption and the kit (src/apps.ts).
      if (path === '/apps/peek/') return send('text/html', PAGE);
      if (path === '/apps/_citadel/api/mine') return send('application/json', JSON.stringify({ name: 'josh', citadel: `${citadel()}/c/`, apps }));
      if (path.startsWith('/apps/_citadel/icon/')) return send('image/svg+xml', svg);
      const kit = path.match(/^\/apps\/_citadel\/([\w/.-]+\.js)$/)?.[1];
      if (kit) return send('text/javascript', readFileSync(join(pub, normalize(kit).replace(/^(\.\.\/)+/, ''))));
      return res.writeHead(404).end();
    }
    if (path === '/c/framer') return send('text/html', FRAMER);
    if (path === '/c/') return send('text/html', CITADEL);
    if (path === '/c/api/contraptions/mine') return send('application/json', JSON.stringify(apps));
    if (path === '/c/api/me') return send('application/json', '{"name":"josh"}');
    if (path.startsWith('/apps/_citadel/icon/')) return send('image/svg+xml', svg);
    const file = path.match(/^\/c\/([\w/.-]+\.(?:js|css|svg))$/)?.[1];
    if (file) {
      try {
        return send(TYPES[extname(file)], readFileSync(join(pub, normalize(file).replace(/^(\.\.\/)+/, ''))));
      } catch {}
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r(null)));
});

const framer = (opts: { width: number; height?: number; touch?: boolean }) =>
  browser.page(`${citadel()}/c/framer?src=${encodeURIComponent(`${contraption()}/apps/peek/`)}`, opts);

test("the frame is another origin: Citadel can't read the contraption's page", { skip }, async () => {
  const page = await framer({ width: 1000, height: 600 });
  await waitFor(page, 'the frame to load', `document.querySelector('#frames iframe')?.contentWindow?.length === 0`);
  assert.equal(await page.eval(`document.querySelector('#frames iframe').contentDocument`), null);
});

test("a contraption's top bar runs up into Citadel's title bar strip, with a drag box over it and a hole over its button", { skip }, async () => {
  const page = await framer({ width: 1000, height: 600 });
  await waitFor(page, 'the frame-topbar class', `document.documentElement.classList.contains('frame-topbar')`);
  await waitFor(page, 'the drag box over the bar', `!document.querySelector('.frame-drag').hidden && document.querySelectorAll('.frame-drag > div').length === 1`);
  // Citadel told the page the strip's room, and the page set it: an echo through the test's own message.
  await waitFor(page, "the strip's height in the contraption", `/^\\d+(\\.\\d+)?px$/.test(window.echo.strip ?? '')`);
  // The strip names the app, from the rail (or the page's own title, in its message).
  assert.equal(await page.eval(`document.querySelector('.frame-strip b').textContent`), 'Peek');
});

test("Alt+\` inside the contraption's frame opens Citadel's switcher", { skip }, async () => {
  const page = await framer({ width: 1000, height: 600 });
  await waitFor(page, "Citadel's rail", `!!document.querySelector('.citadel-rail a[data-app="toc"]')`);
  await waitFor(page, 'the bar (the frame is up)', `document.documentElement.classList.contains('frame-topbar')`);
  // Click into the frame, so it has the keys.
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 600, y: 400, button: 'left', buttons: 1, clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 600, y: 400, button: 'left', buttons: 0, clickCount: 1 });
  assert.equal(await page.eval(`document.activeElement?.tagName`), 'IFRAME');
  const key = (type: string, key: string, code: string, modifiers: number) => page.send('Input.dispatchKeyEvent', { type, key, code, modifiers });
  await key('rawKeyDown', 'Alt', 'AltLeft', 1);
  await key('rawKeyDown', '`', 'Backquote', 1);
  await waitFor(page, "Citadel's switcher", `!!document.querySelector('.app-switch [aria-selected=true]')`);
  await key('keyUp', '`', 'Backquote', 1);
  await key('keyUp', 'Alt', 'AltLeft', 0);
});

test("on a phone, the contraption's handle opens Citadel's rail", { skip }, async () => {
  const page = await framer({ width: 400, height: 800, touch: true });
  await waitFor(page, "the contraption's handle", `!!window.echo.handle`);
  const at = await page.eval<{ x: number; y: number }>(`window.echo.handle`);
  const left = await page.eval<number>(`document.querySelector('#frames iframe').getBoundingClientRect().left`);
  const top = await page.eval<number>(`document.querySelector('#frames iframe').getBoundingClientRect().top`);
  await page.tap(left + at.x, top + at.y);
  await waitFor(page, "Citadel's rail open", `!!document.querySelector('.citadel-rail.open')`);
});

const layer = (page: Page) => page.eval<string>(`(() => {
  const l = document.querySelector('.citadel-layer');
  return l ? (l.hidden ? 'hidden' : 'shown ' + l.querySelector('iframe').src) + (document.body.inert ? ' inert' : '') : 'none';
})()`);

test("in a contraption's installed window, Citadel's layer on Citadel's host opens over it, and picking it there puts the layer away", { skip }, async () => {
  const page = await browser.page(`${contraption()}/apps/peek/?installed`, { width: 1000, height: 600 });
  await waitFor(page, 'the rail, ToC with its icon', `!!document.querySelector('.citadel-rail a[data-app="toc"] img')`);
  assert.equal(await page.eval(`document.querySelector('.citadel-rail a[data-app=""]').href`), `${citadel()}/c/`, "Citadel's entry points at Citadel's host");
  await page.eval(`document.querySelector('.citadel-rail a[data-app="toc"]').click()`);
  await waitFor(page, 'the layer', `!!document.querySelector('.citadel-layer:not([hidden])')`);
  assert.equal(await layer(page), `shown ${citadel()}/c/#/apps/toc inert`);
  assert.equal(await page.eval(`document.querySelector('.citadel-layer iframe').contentDocument`), null, 'another origin');
  // Citadel's rail in the layer sits where this page's rail is, under it: click Peek there.
  const peek = await page.centre('.citadel-rail a[data-app="peek"]');
  for (const end = Date.now() + 10_000; Date.now() < end && (await layer(page)) !== 'hidden'; await new Promise((r) => setTimeout(r, 100))) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: peek.x, y: peek.y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: peek.x, y: peek.y, button: 'left', buttons: 0, clickCount: 1 });
  }
  assert.equal(await layer(page), 'hidden', 'this app picked in the layer: back to its own page');
});
