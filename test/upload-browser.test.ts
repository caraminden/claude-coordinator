// mountUpload()'s zone in a real browser (headless Chromium, test/browser.ts): the total row it hides with `hidden`
// stays hidden (a later :where() display must not beat [hidden]), and its pickers are as tall as every other control.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, type Browser, serveUi, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/ui/base.css">
<style>body{margin:0;padding:16px;font:15px var(--citadel-font);background:var(--citadel-bg);color:var(--citadel-text)}</style>
<div id="root"></div>
<script type="module">
  import { mountUpload } from '/ui/upload.js';
  mountUpload(document.getElementById('root'), { endpoint: '/none' });
  window.ready = true;
</script>`;

let app: App;
let browser: Browser;
before(async () => {
  if (skip) return;
  app = await serveUi(PAGE);
  browser = await launch(bin!);
});
after(async () => {
  await browser?.close();
  await app?.close();
});

for (const [name, width] of [
  ['desktop', 1000],
  ['phone', 390],
] as const) {
  test(`the upload zone hides its empty total row and its pickers are control-h tall (${name})`, { skip }, async () => {
    const page = await browser.page(app.base, { width, height: 700 });
    assert.equal(await page.eval(`getComputedStyle(document.querySelector('.cui-upload-total')).display`), 'none');
    const heights = (await page.eval(`(() => {
      const control = parseFloat(getComputedStyle(document.querySelector('.cui-upload-drop')).getPropertyValue('--citadel-control-h') || getComputedStyle(document.documentElement).getPropertyValue('--citadel-control-h'));
      return { control, buttons: [...document.querySelectorAll('.cui-upload-pick .cui-btn')].map((b) => b.getBoundingClientRect().height) };
    })()`)) as { control: number; buttons: number[] };
    assert.ok(heights.control > 30, 'the control height resolved');
    for (const h of heights.buttons) assert.ok(h >= heights.control, `button ${h}px is at least control-h ${heights.control}px`);
  });
}

// #902: a page whose uploads never finish (fetch never answers), so a row stays "sending" until the test moves it.
const HANG = PAGE.replace("mountUpload(document.getElementById('root'), { endpoint: '/none' });", "window.fetch = () => new Promise(() => {}); window.up = mountUpload(document.getElementById('root'), { endpoint: '/none' });");
const states = `[...document.querySelectorAll('.cui-upload-file')].map((li) => li.dataset.state)`;
const files = (...names: string[]) => `up.add([${names.map((n) => `{ file: new File(['x'], '${n}'), path: '${n}' }`).join(',')}])`;

test('a file cancelled before its turn is cleared with the finished rows when the next batch comes', { skip }, async () => {
  const hang = await serveUi(HANG);
  try {
    const page = await browser.page(hang.base, { width: 1000, height: 700 });
    await page.eval(files('a.bin', 'b.bin'));
    assert.deepEqual(await page.eval(states), ['sending', 'waiting']);
    await page.eval(`document.querySelectorAll('.cui-upload-file')[1].querySelector('[aria-label^="Cancel"]').click()`);
    assert.deepEqual(await page.eval(states), ['sending', 'cancelled']);
    await page.eval(files('c.bin'));
    assert.deepEqual(await page.eval(states), ['sending', 'waiting']);
  } finally {
    await hang.close();
  }
});

test('Resume on a paused file while another is sending waits its turn: one file at a time', { skip }, async () => {
  const hang = await serveUi(HANG);
  try {
    const page = await browser.page(hang.base, { width: 1000, height: 700 });
    await page.eval(files('a.bin', 'b.bin'));
    await page.eval(`document.querySelectorAll('.cui-upload-file')[0].querySelector('.cui-btn').click()`); // pause a: b starts
    assert.deepEqual(await page.eval(states), ['paused', 'sending']);
    await page.eval(`document.querySelectorAll('.cui-upload-file')[0].querySelector('.cui-btn').click()`); // resume a
    assert.deepEqual(await page.eval(states), ['waiting', 'sending']);
    await page.eval(`up.pause(); up.resume()`); // Resume all keeps it too
    assert.deepEqual((await page.eval<string[]>(states)).filter((s) => s === 'sending').length, 1);
    await page.eval(`document.querySelectorAll('.cui-upload-file')[1].querySelector('.cui-btn').click()`); // pause b: a gets its turn
    assert.deepEqual(await page.eval(states), ['sending', 'paused']);
  } finally {
    await hang.close();
  }
});

// #1945: pausing the first row gave the next one its turn, so every waiting file was started, then cancelled.
test('Pause all with files waiting starts and cancels nothing', { skip }, async () => {
  const hang = await serveUi(HANG.replace('window.fetch = () => new Promise(() => {});', 'window.calls = []; window.fetch = (url, o) => (calls.push(o.method), new Promise(() => {}));'));
  try {
    const page = await browser.page(hang.base, { width: 1000, height: 700 });
    await page.eval(files('a.bin', 'b.bin', 'c.bin'));
    await page.eval(`up.pause()`);
    assert.deepEqual(await page.eval(states), ['paused', 'paused', 'paused']);
    assert.deepEqual(await page.eval('calls'), ['POST'], 'only a, which was sending already');
    // A paused file told to resume is waiting too: Pause all takes its turn away as well.
    await page.eval(`up.resume()`); // a sends again, b and c wait
    await page.eval(`document.querySelectorAll('.cui-upload-file')[0].querySelector('.cui-btn').click()`); // pause a: b starts
    await page.eval(`document.querySelectorAll('.cui-upload-file')[0].querySelector('.cui-btn').click()`); // resume a: it waits
    assert.deepEqual(await page.eval(states), ['waiting', 'sending', 'waiting']);
    const before = await page.eval<number>('calls.length');
    await page.eval(`up.pause()`);
    assert.deepEqual(await page.eval(states), ['paused', 'paused', 'paused']);
    assert.equal(await page.eval('calls.length'), before);
  } finally {
    await hang.close();
  }
});
