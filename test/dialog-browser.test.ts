// ui/dialog.js and base.css's cui-dialog in a real browser (headless Chromium, test/browser.ts). Cara, 2026-11-08 (in
// Peek Auras): "the X to close should stay at the top and clicking off the modal should close it". A long body,
// scrolled to its end, still has the head and its ✕ at the top; a click on the backdrop closes it, a drag that
// starts inside and ends on the backdrop doesn't; Escape closes it; the page behind doesn't scroll.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { themeCss } from '../src/theme.ts';
import { chromium, launch, type Browser, type Page, serveUi, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;
const pub = join(import.meta.dirname, '..', 'public');

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/ui/base.css">
<style>body{margin:0;font:15px var(--citadel-font);background:var(--citadel-bg);color:var(--citadel-text)} .tall{height:3000px}</style>
<div class="tall">The page behind</div>
<dialog class="cui-dialog" id="d" aria-labelledby="t">
  <form method="dialog" class="cui-dialog-head"><h2 id="t">Link to PC</h2><button class="cui-btn cui-ghost cui-icon" id="x" aria-label="Close">✕</button></form>
  ${Array.from({ length: 40 }, (_, i) => `<p id="p${i}">Line ${i + 1} of a long body that scrolls under the pinned head.</p>`).join('')}
</dialog>
<script type="module">
  import { mountDialogs } from '/ui/dialog.js';
  mountDialogs();
  mountDialogs(); // twice is once
  window.d = document.getElementById('d');
  window.closes = 0;
  d.addEventListener('close', () => closes++);
  window.open = () => { if (!d.open) d.showModal(); };
  window.ready = true;
</script>`;

let app: App;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  app = await serveUi(PAGE);
  base = app.base;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await app?.close();
});

/** Press the left button at one point and let go at another. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...from, button: 'left', clickCount: 1 });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...to, button: 'left' });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...to, button: 'left', clickCount: 1 });
}
const frame = 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))';

for (const [label, opts] of [['desktop', { width: 1000, height: 600 }], ['phone, dark', { width: 390, height: 700, touch: true, dark: true }]] as const) {
  test(`${label}: a long body scrolled to its end keeps the head and ✕ at the top, inside the window`, { skip }, async () => {
    const page = await browser.page(base, opts);
    await page.eval(`(open(), d.scrollTop = d.scrollHeight, ${frame})`);
    const r = await page.eval<Record<string, number>>(`(() => {
      const dr = d.getBoundingClientRect(), h = d.querySelector('.cui-dialog-head'), hr = h.getBoundingClientRect(), x = document.getElementById('x').getBoundingClientRect();
      const hs = getComputedStyle(h);
      return { scrolled: d.scrollTop, dTop: dr.top, dBottom: dr.bottom, dLeft: dr.left, dRight: dr.right, hTop: hr.top, hLeft: hr.left, hRight: hr.right,
        xTop: x.top - hr.top, xBottom: hr.bottom - parseFloat(hs.borderBottomWidth) - x.bottom, padTop: parseFloat(hs.paddingTop), padBottom: parseFloat(hs.paddingBottom),
        under: document.elementFromPoint(x.left + x.width / 2, x.top + x.height / 2).id };
    })()`);
    assert.ok(r.scrolled > 200, 'the body scrolled');
    assert.equal(r.hTop, r.dTop + 1, 'the head sits at the top of the box, inside its border');
    assert.equal(r.under, 'x', 'the ✕ is on top, not the scrolled text');
    assert.ok(r.dTop >= 0 && r.dLeft >= 0 && r.dBottom <= opts.height && r.dRight <= opts.width, `the box fits the window: ${JSON.stringify(r)}`);
    assert.ok(r.hLeft === r.dLeft + 1 && r.hRight >= r.dRight - 1 - 20, 'the head spans the box');
    assert.ok(r.padTop > 0 && r.padTop === r.padBottom, 'the head has equal room above and below');
    assert.ok(Math.abs(r.xTop - r.xBottom) <= 0.5, `the ✕ is centred in the head: ${r.xTop} / ${r.xBottom}`);
    assert.equal(await page.eval(`getComputedStyle(document.documentElement).overflow`), 'hidden', 'the page behind does not scroll');
    await page.eval(`(d.close(), ${frame})`);
    assert.notEqual(await page.eval(`getComputedStyle(document.documentElement).overflow`), 'hidden', 'and scrolls again once it closes');
  });
}

test('a click on the backdrop closes it; a drag from inside to the backdrop, or from the backdrop inside, does not', { skip }, async () => {
  const page = await browser.page(base, { width: 1000, height: 600 });
  await page.eval(`(open(), ${frame})`);
  const inside = await page.centre('#p3');
  const out = { x: 20, y: 20 };
  await drag(page, inside, out);
  assert.equal(await page.eval('d.open'), true, 'selecting text and letting go on the backdrop keeps it open');
  await drag(page, out, inside);
  assert.equal(await page.eval('d.open'), true, 'pressing on the backdrop and letting go inside keeps it open');
  await drag(page, out, out);
  assert.equal(await page.eval('d.open'), false, 'a click on the backdrop closes it');
  assert.equal(await page.eval(`${frame}.then(() => closes)`), 1, 'once');
});

test('a tap on the backdrop closes it on a phone', { skip }, async () => {
  const page = await browser.page(base, { width: 390, height: 700, touch: true });
  await page.eval(`(open(), ${frame})`);
  await page.tap(195, 3);
  await page.eval(frame);
  assert.equal(await page.eval('d.open'), false);
});

test('a cancel listener that says no keeps it open on a backdrop click, as with Escape', { skip }, async () => {
  const page = await browser.page(base, { width: 1000, height: 600 });
  if (!(await page.eval('typeof HTMLDialogElement.prototype.requestClose === "function"'))) return;
  await page.eval(`(d.addEventListener('cancel', (e) => e.preventDefault(), { once: true }), open(), ${frame})`);
  await drag(page, { x: 20, y: 20 }, { x: 20, y: 20 });
  assert.equal(await page.eval('d.open'), true);
});

test('Escape and the ✕ close it', { skip }, async () => {
  const page = await browser.page(base, { width: 1000, height: 600 });
  await page.eval(`(open(), ${frame})`);
  await page.key('Escape');
  assert.equal(await page.eval('d.open'), false, 'Escape');
  await page.eval(`(open(), ${frame})`);
  const x = await page.centre('#x');
  await drag(page, x, x);
  assert.equal(await page.eval('d.open'), false, 'the ✕');
});
