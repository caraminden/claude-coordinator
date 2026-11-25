// An app's frame open in Citadel picks up the app's new deploy (#1690; Cara picked "In Citadel, every app" after TripPresenter's
// ✦ Animate button stayed missing in a frame opened before the deploy). In a real browser (test/browser.ts), Citadel and the app on
// two origins as with APPS_DOMAIN: Citadel (public/frames.js) hears the deploy, and the app's page (its rail.js) says whether it holds
// unsent text. A frame out of sight and clean reloads itself, at its own address; one holding text, or on screen, gets a one-click
// offer instead; a frame on screen reloads once it's left. A frame for an app that didn't deploy is left alone.
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

// Citadel's page, as far as its frames go: what each app's page tells it (`test` messages, not the protocol's) is kept per app.
const FRAMER = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/c/style.css"><body><main></main>
<script type="module">
  import { showRail } from '/c/rail.js';
  import { appDeployed, deploysSince, hideFrames, showFrame } from '/c/frames.js';
  window.echo = { peek: {}, toc: {} };
  addEventListener('message', (e) => { if (e.data?.test) window.echo[e.data.app][e.data.test] = e.data.value; });
  showRail();
  Object.assign(window, { appDeployed, deploysSince, hideFrames, showFrame });
  window.frameOf = (app) => document.querySelector('#frames iframe[data-app="' + app + '"]');
  window.tell = (app, msg) => frameOf(app).contentWindow.postMessage(msg, '*');
  window.ready = true;
</script>`;

// An app's page: a textarea, and how many times it has loaded in this tab, told to Citadel on each load.
const APP = `<!doctype html><meta charset="utf-8"><body><textarea id="t"></textarea><input id="i" value="loaded with">
<script type="module">
  await import('/apps/_citadel/rail.js');
  const app = location.pathname.split('/')[2];
  const loads = Number(sessionStorage.getItem('loads:' + app) ?? 0) + 1;
  sessionStorage.setItem('loads:' + app, String(loads));
  const tell = (test, value) => parent.postMessage({ app, test, value }, '*');
  // Text left in the box, as a draft someone stopped typing: no input event, so only the box's value holds a reload back.
  addEventListener('message', (e) => { if (typeof e.data?.fill === 'string') { document.getElementById(e.data.id ?? 't').value = e.data.fill; tell('filled', e.data.fill); } });
  // With ?box, Citadel UI's message box too (#1939): its sends settle when told, each box has its own tray, and its clock can be moved on.
  if (new URLSearchParams(location.search).has('box')) {
    const { mountComposer } = await import('/apps/_citadel/ui/composer.js');
    let settle = () => {};
    let skew = 0;
    const now = Date.now;
    Date.now = () => now() + skew;
    const place = document.body.appendChild(document.createElement('div'));
    let trays = []; // the first chat's, then the next's
    const mount = (tray = { files: 0 }) => (trays.push(tray), mountComposer(place, {
      autofocus: false,
      canSend: (text) => !!text || tray.files > 0,
      send: () => new Promise((ok, no) => { tray.files = 0; settle = (sent) => (sent ? ok() : no(new Error('refused'))); }),
      onError: () => tell('step', 'settle:' + box.value), // the words are back
    }));
    let box = mount();
    addEventListener('message', (e) => {
      const { box: step, value } = e.data ?? {};
      if (step === 'send') { box.value = value; box.form.requestSubmit(); }
      else if (step === 'settle') { settle(value); if (!value) return; }
      else if (step === 'tray') trays[0].files = value; // the first chat's
      else if (step === 'drawn') return requestAnimationFrame(() => requestAnimationFrame(() => tell('step', 'drawn:')));
      else if (step === 'skew') skew = value;
      else if (step === 'other chat') { place.replaceChildren(); box = mount(); } // as Peek does for another aura
      else return;
      tell('step', [step, box.value].join(':'));
    });
  }
  tell('href', location.href);
  tell('loads', loads);
</script>`;

const apps = [
  { name: 'peek', title: 'Peek', icon: '/icon.svg', up: true },
  { name: 'toc', title: 'ToC', icon: '/icon.svg', up: true },
];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#f93"/></svg>';
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
let server: Server;
let browser: Browser;
let port = 0;
const citadel = () => `http://127.0.0.1:${port}`;
const appUrl = (name: string, query = '') => `http://localhost:${port}/apps/${name}/${query}`;

before(async () => {
  if (skip) return;
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const host = req.headers.host?.split(':')[0];
    const send = (type: string, body: string | Buffer) => res.writeHead(200, { 'content-type': type }).end(body);
    const file = (rel: string) => {
      try {
        return send(TYPES[extname(rel)], readFileSync(join(pub, normalize(rel).replace(/^(\.\.\/)+/, ''))));
      } catch {
        return res.writeHead(404).end();
      }
    };
    if (host === 'localhost') {
      if (/^\/apps\/(peek|toc)\/$/.test(path)) return send('text/html', APP);
      if (path === '/apps/_citadel/api/mine') return send('application/json', JSON.stringify({ name: 'josh', citadel: `${citadel()}/c/`, apps }));
      if (path.startsWith('/apps/_citadel/icon/')) return send('image/svg+xml', svg);
      const kit = path.match(/^\/apps\/_citadel\/([\w/.-]+\.js)$/)?.[1];
      return kit ? file(kit) : res.writeHead(404).end();
    }
    if (path === '/c/framer') return send('text/html', FRAMER);
    if (path === '/c/api/contraptions/mine') return send('application/json', JSON.stringify(apps));
    if (path === '/c/api/me') return send('application/json', '{"name":"josh"}');
    if (path.startsWith('/apps/_citadel/icon/')) return send('image/svg+xml', svg);
    const own = path.match(/^\/c\/([\w/.-]+\.(?:js|css|svg))$/)?.[1];
    return own ? file(own) : res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r(null)));
});

/** Citadel with peek's frame opened at `query` and then toc's, so peek's is out of sight. */
async function twoFrames(query = ''): Promise<Page> {
  const page = await browser.page(`${citadel()}/c/framer`, { width: 1000, height: 600 });
  await page.eval(`showFrame('peek', ${JSON.stringify(appUrl('peek', query))})`);
  await waitFor(page, "peek's page in its frame", 'echo.peek.loads === 1');
  await page.eval(`showFrame('toc', ${JSON.stringify(appUrl('toc'))})`);
  await waitFor(page, "toc's page in its frame", 'echo.toc.loads === 1');
  return page;
}

const offer = `document.querySelector('#frames .frame-update:not([hidden])')`;

test("a deployed app's frame out of sight reloads itself onto the new version, at its own address; another app's frame is left alone", { skip }, async () => {
  const page = await twoFrames('?deep=1');
  await page.eval(`appDeployed('peek')`);
  await waitFor(page, "peek's frame to reload", 'echo.peek.loads === 2');
  assert.equal(await page.eval('echo.peek.href'), appUrl('peek', '?deep=1'), "it reloads where its page was, not at the app's start");
  assert.equal(await page.eval('echo.toc.loads'), 1, "toc didn't deploy: its frame is untouched");
  assert.equal(await page.eval(`!!${offer}`), false, 'nothing is offered over toc, which is on screen and current');
});

test('a frame out of sight holding unsent text is never reloaded by itself; showing it offers a one-click reload', { skip }, async () => {
  const page = await twoFrames();
  await page.eval(`tell('peek', { fill: 'half a thought' })`);
  await waitFor(page, 'the draft in peek', `echo.peek.filled === 'half a thought'`);
  await page.eval(`appDeployed('peek')`);
  await waitFor(page, 'peek to say it holds unsent text', `frameOf('peek').dataset.update === 'held'`);
  assert.equal(await page.eval('echo.peek.loads'), 1, 'the draft is still there: no reload');
  await page.eval(`showFrame('peek')`);
  await waitFor(page, 'the offer over peek', `${offer}?.textContent.includes('new version')`);
  await page.eval(`${offer}.querySelector('button').click()`);
  await waitFor(page, 'peek to reload on the click', 'echo.peek.loads === 2');
  await waitFor(page, 'the offer to go', `!${offer}`);
});

test('a frame on screen is never reloaded under the person: it offers, and reloads out of sight once they leave it', { skip }, async () => {
  const page = await twoFrames();
  await page.eval(`appDeployed('toc')`);
  await waitFor(page, 'the offer over toc', `${offer}?.textContent.includes('new version')`);
  // The same offer, asked again, still hasn't reloaded it: a second deploy and a round trip to peek (which didn't deploy) later.
  await page.eval(`appDeployed('toc')`);
  await page.eval(`tell('peek', { fill: '' })`);
  await waitFor(page, 'the round trip to peek', `echo.peek.filled === ''`);
  assert.equal(await page.eval('echo.toc.loads'), 1, 'on screen: offered, not reloaded');
  await page.eval('hideFrames()');
  await waitFor(page, "toc's frame to reload once left", 'echo.toc.loads === 2');
  await page.eval(`showFrame('toc')`);
  assert.equal(await page.eval(`!!${offer}`), false, 'the offer is gone with the old version');
});

test('a field emptied of the text it loaded with is unsent too: no reload by itself', { skip }, async () => {
  const page = await twoFrames();
  await page.eval(`tell('peek', { fill: '', id: 'i' })`);
  await waitFor(page, 'the field emptied in peek', `echo.peek.filled === ''`);
  await page.eval(`appDeployed('peek')`);
  await waitFor(page, 'peek to say it holds unsent text', `frameOf('peek').dataset.update === 'held'`);
  assert.equal(await page.eval('echo.peek.loads'), 1);
});

test('a deploy the stream missed (it has no replay) is caught from the rail list: only an app deployed since its frame loaded', { skip }, async () => {
  const page = await twoFrames();
  await page.eval(`deploysSince([{ name: 'peek', deployed: Date.now() + 1000 }, { name: 'toc', deployed: Date.now() - 3600e3 }, { name: 'gone', deployed: Date.now() }])`);
  await waitFor(page, "peek's frame to reload", 'echo.peek.loads === 2');
  assert.equal(await page.eval(`!!${offer}`), false, "toc's last deploy was before its frame loaded: no offer over it");
  assert.equal(await page.eval('echo.toc.loads'), 1);
});

// ---------- a message still being sent (#1939): its words have left the box, and only this page holds them ----------

/** One step in peek's message box, done once its page says so. */
async function inBox(page: Page, step: string, value: unknown, text = ''): Promise<void> {
  await page.eval(`(echo.peek.step = null, tell('peek', { box: ${JSON.stringify(step)}, value: ${JSON.stringify(value)} }))`);
  await waitFor(page, `${step} in peek's box`, `echo.peek.step === ${JSON.stringify(`${step}:${text}`)}`);
}

/** Asks peek's frame, out of sight, to reload for a new deploy. */
async function askedToReload(page: Page, answer: 'held' | 'reload', why: string): Promise<void> {
  await page.eval(`appDeployed('peek')`);
  await waitFor(page, why, answer === 'held' ? `frameOf('peek').dataset.update === 'held'` : 'echo.peek.loads === 2');
  if (answer === 'held') assert.equal(await page.eval('echo.peek.loads'), 1, why);
}

test('a frame out of sight with a message still being sent is held, and reloads when asked again once it is sent', { skip }, async () => {
  const page = await twoFrames('?box');
  await inBox(page, 'send', 'words with screenshots');
  await askedToReload(page, 'held', 'held while the message is on its way');
  await inBox(page, 'settle', true);
  await askedToReload(page, 'reload', 'it was sent');
});

test('a frame already stale when the person sends and leaves is held too', { skip }, async () => {
  const page = await twoFrames('?box');
  await page.eval(`showFrame('peek')`);
  await page.eval(`appDeployed('peek')`);
  await waitFor(page, 'the offer over peek', `${offer}?.textContent.includes('new version')`);
  await inBox(page, 'send', 'sent on the old version');
  await page.eval('hideFrames()');
  await waitFor(page, 'peek to say it holds a message being sent', `frameOf('peek').dataset.update === 'held'`);
  assert.equal(await page.eval('echo.peek.loads'), 1);
});

test('a send that fails leaves its words in the box, which holds the reload as any unsent text does', { skip }, async () => {
  const page = await twoFrames('?box');
  await inBox(page, 'send', 'refused words');
  await inBox(page, 'settle', false, 'refused words');
  await askedToReload(page, 'held', 'held by the words put back');
});

test('a message being sent from a box the page has since replaced (another chat opened) holds the reload', { skip }, async () => {
  const page = await twoFrames('?box');
  await inBox(page, 'send', 'sent from the first chat');
  await inBox(page, 'other chat', null);
  await askedToReload(page, 'held', 'held by the first chat');
  await inBox(page, 'settle', true);
  await askedToReload(page, 'reload', 'it was sent');
});

test('files waiting to go with an empty box hold the reload, in a box the page has replaced too', { skip }, async () => {
  const page = await twoFrames('?box');
  await page.eval(`showFrame('peek')`);
  await inBox(page, 'drawn', null);
  await inBox(page, 'tray', 2);
  await page.eval('hideFrames()');
  await askedToReload(page, 'held', 'held by the files');
  await inBox(page, 'other chat', null);
  await inBox(page, 'other chat', null);
  await askedToReload(page, 'held', 'the first chat still has them');
  await inBox(page, 'tray', 0);
  await askedToReload(page, 'reload', 'nothing waits');
});

test('a send that never settles holds the reload for ten minutes, not for ever', { skip }, async () => {
  const page = await twoFrames('?box');
  await inBox(page, 'send', 'stuck');
  await inBox(page, 'skew', 10 * 60_000 - 30_000);
  await askedToReload(page, 'held', 'still on its way');
  await inBox(page, 'skew', 10 * 60_000 + 1000);
  await askedToReload(page, 'reload', 'given up on');
});
