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
  window.upward = [];
  addEventListener('message', (e) => { if (e.data?.test) window.echo[e.data.test] = e.data.value; if (['ext', 'app', 'go-url'].includes(e.data?.type)) window.upward.push(e.data.type + ' ' + e.data.url); });
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
<script>
  // ?late: the bar comes with a narrower window, as ToC's phone header does.
  if (location.search === '?late') document.querySelector('header').classList.remove('cui-topbar');
</script>
<script type="module">
  await import('/apps/_citadel/rail.js');
  const tell = (test, value) => parent !== window && parent.postMessage({ test, value }, '*');
  new MutationObserver(() => tell('strip', document.documentElement.style.getPropertyValue('--citadel-strip-h')))
    .observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  // ?modal: a modal dialog over the bar half a second after its load, closed a second later.
  if (location.search === '?modal') {
    const d = document.body.appendChild(document.createElement('dialog'));
    setTimeout(() => d.showModal(), 500);
    setTimeout(() => d.close(), 1500);
  }
  // ?late: a second after its load, the bar arrives with a resize.
  if (location.search === '?late') setTimeout(() => { document.querySelector('header').classList.add('cui-topbar'); dispatchEvent(new Event('resize')); }, 1000);
  setInterval(() => {
    const h = document.querySelector('.citadel-rail-handle');
    const r = h && !h.hidden && h.getBoundingClientRect();
    tell('handle', r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null);
  }, 50);
  // Links to click from the test (a clickLink message): what the page's handler did with each, reported back.
  document.body.insertAdjacentHTML('beforeend', '<a id="same" href="/apps/peek/ingest">a</a><a id="other" href="http://voice.test/apps/voice/rate/">b</a><a id="out" href="https://example.com/x">c</a><a id="zip" target="_blank" href="https://docs.citadel.zip/">d</a>');
  // A handled click is stopped before it reaches the document: that, or a prevented default, is what the test reads.
  addEventListener('message', (e) => {
    if (e.data?.getCookie) tell('cookie', document.cookie);
    const id = e.data?.clickLink;
    if (!id) return;
    let seen = null;
    const onClick = (ev) => { seen = ev.defaultPrevented; ev.preventDefault(); };
    document.addEventListener('click', onClick, { once: true });
    document.getElementById(id).click();
    document.removeEventListener('click', onClick);
    tell('click:' + id, seen === null ? true : seen);
  });
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

const framer = (opts: { width: number; height?: number; touch?: boolean }, query = '') =>
  browser.page(`${citadel()}/c/framer?src=${encodeURIComponent(`${contraption()}/apps/peek/${query}`)}`, opts);

test("the frame is another origin: Citadel can't read the contraption's page", { skip }, async () => {
  const page = await framer({ width: 1000, height: 600 });
  // The contraption's own report, so its page is in the frame: until then the frame holds about:blank, which Citadel can read (#758).
  await waitFor(page, "the contraption's page in the frame", `'handle' in window.echo`);
  assert.equal(await page.eval(`document.querySelector('#frames iframe').contentDocument`), null);
});

test("the frame carries the allow list, so the mic works on the contraption's own host (#892)", { skip }, async () => {
  const page = await framer({ width: 1000, height: 600 });
  await waitFor(page, "the contraption's page in the frame", `'handle' in window.echo`);
  const allow = await page.eval(`document.querySelector('#frames iframe').allow`) as string;
  for (const f of ['microphone', 'camera', 'clipboard-read', 'clipboard-write', 'fullscreen']) assert.match(allow, new RegExp(`(^|; )${f} \\*(;|$)`));
  assert.equal(await page.eval(`document.querySelector('#frames iframe').contentWindow.document`).catch(() => 'cross'), 'cross');
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

test("while a modal dialog is open over a contraption's top bar, its drag box drops its holes for the strip above, and gets them back as it closes", { skip }, async () => {
  const page = await framer({ width: 1000, height: 600 }, '?modal');
  await waitFor(page, 'the hole over the bar\'s button', `document.querySelectorAll('.frame-drag > div').length === 1`);
  await waitFor(page, 'the strip-only drag box under the modal', `!document.querySelector('.frame-drag').hidden && document.querySelectorAll('.frame-drag > div').length === 0`);
  await waitFor(page, 'the hole back once it closes', `document.querySelectorAll('.frame-drag > div').length === 1`);
});

test("a top bar a contraption adds on a resize after its load is fitted too", { skip }, async () => {
  const page = await framer({ width: 1200, height: 800 }, '?late');
  await waitFor(page, "the contraption's handle report (the frame is up)", `'handle' in window.echo`);
  assert.equal(await page.eval<boolean>(`document.documentElement.classList.contains('frame-topbar')`), false, 'no bar yet');
  await waitFor(page, 'the frame-topbar class', `document.documentElement.classList.contains('frame-topbar')`);
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
  // Waited for, not read once: the layer shows before Citadel's page is in its frame, and until then that is about:blank (#758).
  await waitFor(page, "Citadel's page in the layer, on another origin (unreadable from here)", `document.querySelector('.citadel-layer iframe').contentDocument === null`);
  // Citadel's rail in the layer sits where this page's rail is, under it: click Peek there.
  const peek = await page.centre('.citadel-rail a[data-app="peek"]');
  for (const end = Date.now() + 10_000; Date.now() < end && (await layer(page)) !== 'hidden'; await new Promise((r) => setTimeout(r, 100))) {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: peek.x, y: peek.y, button: 'left', buttons: 1, clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: peek.x, y: peek.y, button: 'left', buttons: 0, clickCount: 1 });
  }
  assert.equal(await layer(page), 'hidden', 'this app picked in the layer: back to its own page');
});

test("with Open links in Firefox on, a framed app's own links stay in it; another app, Citadel's domain and outside links go up (#988)", { skip }, async () => {
  const page = await framer({ width: 1000, height: 600 });
  await waitFor(page, "the contraption's page in the frame", `'handle' in window.echo`);
  // What Citadel's state message says with the switch on (the test box isn't Windows, so it says it itself).
  // Citadel's own state messages (after its app list loads) say firefox false: wait for them, and say it again before each click.
  await waitFor(page, "Citadel's rail with its app list", `!!document.querySelector('.citadel-rail a[data-app="toc"]')`);
  const frame = `document.querySelector('#frames iframe').contentWindow`;
  const state = `${frame}.postMessage({ protocol: 'citadel-frame-1', type: 'state', hasRail: true, narrow: false, firefox: true, own: ['127.0.0.1'], apps: { 'voice.test': 'voice' }, domain: 'citadel.zip' }, '*')`;
  const click = async (id: string) => {
    await page.eval(state);
    await page.eval(`${frame}.postMessage({ clickLink: '${id}' }, '*')`);
    await waitFor(page, `click ${id}`, `'click:${id}' in window.echo`);
    return page.eval(`window.echo['click:${id}']`);
  };
  assert.equal(await click('same'), false, "its own link is left to the page");
  assert.equal(await click('other'), true);
  assert.equal(await click('out'), true);
  assert.equal(await click('zip'), true);
  assert.deepEqual(await page.eval(`window.upward`), ['app http://voice.test/apps/voice/rate/', 'ext https://example.com/x', 'go-url https://docs.citadel.zip/']);
});

const WINDOWS = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', userAgentMetadata: { platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', model: '', mobile: false } };

test("in an app's own window (no Citadel around it), the switch comes from its cookie: outside links go to Firefox, its own stay (#988)", { skip }, async () => {
  const page = await browser.page(`${contraption()}/apps/peek/`, { width: 1000, height: 600 });
  await page.send('Emulation.setUserAgentOverride', WINDOWS);
  await page.send('Page.reload'); // the page reads the platform as it loads
  await waitFor(page, "the reloaded contraption page", `navigator.userAgent.includes('Windows') && !!document.getElementById('out')`);
  // A handled click never reaches the document's bubble phase; a hidden frame holds the launch.
  await page.eval(`window.violations = []; document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective))`);
  const handled = (id: string) => page.eval(`(() => { let reached = false; const f = (e) => { reached = true; e.preventDefault(); }; document.addEventListener('click', f, { once: true }); document.getElementById('${id}').click(); document.removeEventListener('click', f); return !reached; })()`);
  const launched = () => page.eval(`[...document.querySelectorAll('iframe[hidden]')].map((f) => f.src).join()`);
  assert.equal(await handled('out'), false, 'cookie missing: the browser keeps it');
  await page.eval(`document.cookie = 'citadel-open-in-firefox=1; path=/'`);
  assert.equal(await handled('same'), false, 'its own link stays');
  assert.equal(await handled('out'), true, 'cookie set: an outside link is handled');
  assert.equal(await launched(), 'citadel-firefox:https://example.com/x');
  assert.deepEqual(await page.eval(`violations`), [], 'the page\'s policy lets the launch frame through');
});

test("a framed app copies Citadel's switch into a cookie on its own host, and clears it when the switch goes off (#988)", { skip }, async () => {
  const page = await framer({ width: 1000, height: 600 });
  await waitFor(page, "Citadel's rail with its app list", `!!document.querySelector('.citadel-rail a[data-app="toc"]')`);
  // The cookie is read by the frame's own page (it posts document.cookie back), so third-party cookie blocking would show.
  const say = (on: boolean) => page.eval(`document.querySelector('#frames iframe').contentWindow.postMessage({ protocol: 'citadel-frame-1', type: 'state', hasRail: true, narrow: false, firefox: ${on}, own: [], apps: {}, domain: null }, '*')`);
  const cookie = async () => {
    await page.eval(`window.echo.cookie = null; document.querySelector('#frames iframe').contentWindow.postMessage({ getCookie: 1 }, '*')`);
    await waitFor(page, 'the frame\'s cookie', `window.echo.cookie !== null`);
    return String(await page.eval(`window.echo.cookie`));
  };
  await say(true);
  for (const end = Date.now() + 5000; Date.now() < end && !(await cookie()).includes('citadel-open-in-firefox=1'); await new Promise((r) => setTimeout(r, 100)));
  assert.match(await cookie(), /citadel-open-in-firefox=1/);
  await say(false);
  for (const end = Date.now() + 5000; Date.now() < end && (await cookie()).includes('citadel-open-in-firefox'); await new Promise((r) => setTimeout(r, 100)));
  assert.doesNotMatch(await cookie(), /citadel-open-in-firefox/);
});
