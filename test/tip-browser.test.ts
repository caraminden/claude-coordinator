// ui/tip.js in a real browser (headless Chromium, test/browser.ts): hover, keyboard focus, a tap and a long
// press on a touch screen, placement inside the window and off the thing, a slow body's skeleton, one tip at
// a time, and following a redraw. Ported from Theory of Crafting's app/dev/tip-browser.test.ts (ToC #55).
// The page links the real theme.css and base.css; the server picks a free port (0).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { themeCss } from '../src/theme.ts';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const pub = join(import.meta.dirname, '..', 'public');

export const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/ui/base.css">
<style>body{margin:0;font:15px var(--citadel-font);background:var(--citadel-bg);color:var(--citadel-text)} .t{position:absolute;padding:4px}
#top{left:20px;top:20px} #btn{left:20px;top:120px} #slow{left:300px;top:20px} #low{right:4px;bottom:4px} #other{left:20px;top:200px}</style>
<span class="t" id="top" data-tip="Life: 1,234" tabindex="0" aria-describedby="own-note">Life</span>
<button class="t cui-btn" id="btn" data-tip="What it does">Act</button>
<span class="t" id="slow" data-tip="" data-tip-slow="1">Slow</span>
<span class="t" id="low" data-tip="Low">Bottom right</span>
<span class="t" id="other" data-tip="From another mount" class="t">Other</span>
<p id="own-note" hidden>own</p>
<script type="module">
  import { mountTips } from '/ui/tip.js';
  window.clicks = 0;
  document.getElementById('btn').addEventListener('click', () => window.clicks++);
  const other = document.getElementById('other');
  other.remove();
  // A body for the slow one only: every other tip falls back to its plain data-tip (undefined).
  window.tips = mountTips(document.body, {
    selector: '[data-tip]:not(#other)',
    body: (el) => el.dataset.tipSlow ? new Promise((r) => (window.finish = () => r('<b id="done">loaded</b>'))) : undefined,
  });
  // A second mount on its own root: still one tip open on the page.
  const box = document.createElement('div');
  box.append(other);
  document.body.append(box);
  window.otherTips = mountTips(box);
  window.ready = true;
</script>`;

let server: Server;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (path === '/theme.css') return res.writeHead(200, { 'content-type': 'text/css' }).end(themeCss(readFileSync(join(pub, 'style.css'), 'utf8')));
    const m = /^\/ui\/([a-z-]+\.(js|css))$/.exec(path);
    if (!m) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': m[2] === 'js' ? 'text/javascript' : 'text/css' }).end(readFileSync(join(pub, 'ui', m[1])));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r(null)));
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Box = { left: number; top: number; right: number; bottom: number; text: string };
const tipBox = (page: Page) => page.eval<Box | null>(`(() => {
  const pop = [...document.querySelectorAll('.cui-tip')].find((p) => p.matches(':popover-open'));
  if (!pop) return null;
  const r = pop.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, text: pop.textContent };
})()`);
const rect = (page: Page, sel: string) => page.eval<Box>(`document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect().toJSON()`);
const open = (opts: { touch?: boolean } = {}) => browser.page(base, opts);
const SHOWN = `[...document.querySelectorAll('.cui-tip')].some((p) => p.matches(':popover-open'))`;
/** Times in the page's own clock, which a loaded test box can't stretch: when the pointer first came over each thing (by id), and each tip's opening. */
const clock = (page: Page) => page.eval(`(() => {
  window.over = {}; window.opened = [];
  document.addEventListener('pointerover', (e) => { if (e.target.id) over[e.target.id] ??= performance.now(); }, true);
  document.addEventListener('beforetoggle', (e) => { if (e.newState === 'open') opened.push(performance.now()); }, true);
})()`);

test('opens on hover after a short pause, below the thing, and closes when the mouse leaves', { skip }, async () => {
  const page = await open();
  const c = await page.centre('#top');
  await clock(page);
  await page.mouse(c.x, c.y);
  await waitFor(page, 'the tip', SHOWN);
  // tip.js's OPEN_MS is 250; a few ms off for the clock's coarsening.
  assert.ok(await page.eval<number>('opened[0] - over.top') >= 240, 'not at once: a mouse passing over doesn\'t flash tips');
  const box = await tipBox(page);
  const t = await rect(page, '#top');
  assert.equal(box?.text, 'Life: 1,234');
  assert.ok(box!.top >= t.bottom, 'below the thing');
  assert.match(await page.eval<string>('document.getElementById("top").getAttribute("aria-describedby")'), /^own-note cui-tip-\w+$/, 'adds its id beside the page\'s own');
  await page.mouse(590, 300);
  await waitFor(page, 'the tip to close', `!${SHOWN}`);
  assert.equal(await tipBox(page), null);
  assert.equal(await page.eval('document.getElementById("top").getAttribute("aria-describedby")'), 'own-note', 'and takes only its own back');
});

test('stays inside the window and off the thing in a corner', { skip }, async () => {
  const page = await open();
  const c = await page.centre('#low');
  await page.mouse(c.x, c.y);
  await waitFor(page, 'the tip', SHOWN);
  const box = (await tipBox(page))!;
  const t = await rect(page, '#low');
  assert.ok(box.bottom <= t.top, 'flipped above');
  assert.ok(box.right <= 600 - 8 && box.left >= 8, 'inside the window');
});

test('opens at once on keyboard focus, Escape closes it, and the next focus opens the next', { skip }, async () => {
  const page = await open();
  await page.key('Tab');
  assert.equal(await page.eval('document.activeElement?.id'), 'top');
  assert.equal((await tipBox(page))?.text, 'Life: 1,234');
  await page.key('Escape');
  assert.equal(await tipBox(page), null);
  await page.key('Tab');
  assert.equal((await tipBox(page))?.text, 'What it does');
});

test('shows a skeleton while a slow body loads, then the body', { skip }, async () => {
  const page = await open();
  const c = await page.centre('#slow');
  await page.mouse(c.x, c.y);
  await waitFor(page, 'the tip', SHOWN);
  assert.equal(await page.eval('document.querySelectorAll(".cui-tip .cui-skeleton").length'), 3);
  await page.eval('window.finish()');
  await waitFor(page, 'the body', '!!document.querySelector(".cui-tip #done")');
  assert.equal(await page.eval('!!document.querySelector(".cui-tip #done")'), true);
  assert.equal(await page.eval('document.querySelectorAll(".cui-tip .cui-skeleton").length'), 0);
});

test('one tip open on the page, across mounts; a redraw\'s copy of the thing keeps it open', { skip }, async () => {
  const page = await open();
  const c = await page.centre('#top');
  await clock(page);
  await page.mouse(c.x, c.y);
  await waitFor(page, "#top's tip", 'opened.length === 1');
  const o = await page.centre('#other');
  await page.mouse(o.x, o.y);
  await waitFor(page, "#other's tip", 'opened.length === 2');
  assert.ok(await page.eval<number>('opened[1] - over.other') < 250, 'warm: quicker from one tip to the next than the first (250 ms)');
  assert.equal((await tipBox(page))?.text, 'From another mount');
  assert.equal(await page.eval('document.querySelectorAll(".cui-tip:popover-open").length'), 1);
  // Back on #top, then the page redraws it.
  await page.mouse(c.x, c.y);
  await waitFor(page, "#top's tip again", 'opened.length === 3');
  await page.eval('(() => { const old = document.getElementById("top"); old.replaceWith(old.cloneNode(true)); })()');
  await waitFor(page, 'the tip to follow the redraw', 'window.tips.open === document.getElementById("top")');
  assert.equal((await tipBox(page))?.text, 'Life: 1,234');
  assert.equal(await page.eval('window.tips.open === document.getElementById("top")'), true, 'follows the new element');
});

test('on a touch screen a tap opens a tip that stays, and a tap elsewhere closes it', { skip }, async () => {
  const page = await open({ touch: true });
  const c = await page.centre('#top');
  await page.tap(c.x, c.y);
  await waitFor(page, 'the tip', SHOWN);
  assert.equal((await tipBox(page))?.text, 'Life: 1,234');
  await wait(400);
  assert.notEqual(await tipBox(page), null, 'pinned: no hover close');
  await page.tap(400, 300);
  await waitFor(page, 'the tip to close', `!${SHOWN}`);
  assert.equal(await tipBox(page), null);
});

test('a tap on a button does the button\'s thing; a long press shows its tip and swallows the click', { skip }, async () => {
  const page = await open({ touch: true });
  const b = await page.centre('#btn');
  await page.tap(b.x, b.y);
  await waitFor(page, 'the click', 'window.clicks > 0');
  assert.equal(await page.eval('window.clicks'), 1);
  assert.equal(await tipBox(page), null);
  await page.touch('touchStart', b.x, b.y);
  // Held until the tip shows (tip.js's 450 ms press), not a set time a loaded box can cut short.
  await waitFor(page, 'the long press', SHOWN);
  await page.touch('touchEnd');
  await wait(50);
  assert.equal((await tipBox(page))?.text, 'What it does');
  assert.equal(await page.eval('window.clicks'), 1);
});

test('a tip for a thing inside a modal dialog sits in it, so its buttons can be clicked', { skip }, async () => {
  const page = await open();
  await page.eval(`import('/ui/tip.js').then(({ mountTips }) => {
    const d = document.createElement('dialog');
    d.innerHTML = '<span id="in-dialog" data-dtip="x">In the dialog</span>';
    document.body.append(d);
    d.showModal();
    window.tipClicks = 0;
    mountTips(d, { selector: '[data-dtip]', body: () => Object.assign(document.createElement('button'), { id: 'in-tip', textContent: 'Go', onclick: () => window.tipClicks++ }) });
  })`);
  const c = await page.centre('#in-dialog');
  await page.mouse(c.x, c.y);
  await waitFor(page, "the tip's button", '!!document.querySelector("#in-tip")');
  const b = await page.centre('#in-tip');
  await page.mouse(b.x, b.y);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, x: b.x, y: b.y, button: 'left', clickCount: 1 });
  await waitFor(page, 'the click', 'window.tipClicks > 0');
  assert.equal(await page.eval('window.tipClicks'), 1, 'the click reached the tip\'s button');
});
