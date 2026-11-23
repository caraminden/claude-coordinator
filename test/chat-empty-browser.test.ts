// A contraption chat's own empty line is a `.cui-empty` div that chat.js hides with `hidden` once turns load. base.css's
// emptyState card (`:where(.cui-empty) { display: flex }`) must not beat [hidden], so the line really goes away.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, type Browser, serveUi, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/ui/base.css">
<style>body{margin:0;padding:16px;font:15px var(--citadel-font);background:var(--citadel-bg);color:var(--citadel-text)} #chat{height:300px;overflow:auto}</style>
<div id="chat"></div><div id="card"></div>
<script type="module">
  import { mountChat } from '/ui/chat.js';
  import { emptyState } from '/ui/state.js';
  window.chat = mountChat(document.getElementById('chat'), { empty: 'Nothing here yet.' });
  document.getElementById('card').append(emptyState('No items'));
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
  test(`the chat's empty line goes away once turns load, and the emptyState card still shows (${name})`, { skip }, async () => {
    const page = await browser.page(app.base, { width, height: 700 });
    const display = `getComputedStyle(document.querySelector('#chat > .cui-empty')).display`;
    assert.notEqual(await page.eval(display), 'none', 'empty chat shows its line');
    await page.eval(`chat.load([{ ask: 'hi', events: [{ type: 'end' }] }])`);
    assert.equal(await page.eval(display), 'none');
    assert.equal(await page.eval(`getComputedStyle(document.querySelector('#card .cui-empty')).display`), 'flex');
  });
}
