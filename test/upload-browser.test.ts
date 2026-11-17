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

for (const [name, width] of [['desktop', 1000], ['phone', 390]] as const) {
  test(`the upload zone hides its empty total row and its pickers are control-h tall (${name})`, { skip }, async () => {
    const page = await browser.page(app.base, { width, height: 700 });
    assert.equal(await page.eval(`getComputedStyle(document.querySelector('.cui-upload-total')).display`), 'none');
    const heights = await page.eval(`(() => {
      const control = parseFloat(getComputedStyle(document.querySelector('.cui-upload-drop')).getPropertyValue('--citadel-control-h') || getComputedStyle(document.documentElement).getPropertyValue('--citadel-control-h'));
      return { control, buttons: [...document.querySelectorAll('.cui-upload-pick .cui-btn')].map((b) => b.getBoundingClientRect().height) };
    })()`) as { control: number; buttons: number[] };
    assert.ok(heights.control > 30, 'the control height resolved');
    for (const h of heights.buttons) assert.ok(h >= heights.control, `button ${h}px is at least control-h ${heights.control}px`);
  });
}
