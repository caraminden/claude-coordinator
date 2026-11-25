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

for (const [name, width] of [
  ['desktop', 1000],
  ['phone', 390],
] as const) {
  test(`the chat's empty line goes away once turns load, and the emptyState card still shows (${name})`, { skip }, async () => {
    const page = await browser.page(app.base, { width, height: 700 });
    const display = `getComputedStyle(document.querySelector('#chat > .cui-empty')).display`;
    assert.notEqual(await page.eval(display), 'none', 'empty chat shows its line');
    await page.eval(`chat.load([{ ask: 'hi', events: [{ type: 'end' }] }])`);
    assert.equal(await page.eval(display), 'none');
    assert.equal(await page.eval(`getComputedStyle(document.querySelector('#card .cui-empty')).display`), 'flex');
  });
}

test("an empty chat is plain centred text, not emptyState's card, and emptyState is not centred by the chat", { skip }, async () => {
  const page = await browser.page(app.base, { width: 1000, height: 700 });
  const look = (sel: string) => page.eval<string[]>(`(() => { const s = getComputedStyle(document.querySelector('${sel}')); return [s.display, s.borderTopWidth, s.backgroundColor, s.textAlign]; })()`);
  assert.deepEqual(await look('#chat > .cui-empty'), ['block', '0px', 'rgba(0, 0, 0, 0)', 'center']);
  const card = await look('#card .cui-empty');
  assert.equal(card[0], 'flex');
  assert.equal(card[1], '1px');
  assert.notEqual(card[2], 'rgba(0, 0, 0, 0)');
  assert.equal(card[3], 'start');
  assert.equal(await page.eval(`getComputedStyle(document.querySelector('#card .cui-empty')).marginTop`), '0px');
});

test('a card whose result draws nothing leaves no duplicate row, live and on a load', { skip }, async () => {
  const page = await browser.page(app.base, { width: 1000, height: 700 });
  const rows = `new Promise((r) => requestAnimationFrame(() => setTimeout(() => r([...document.querySelectorAll('#c2 .cui-run-label, #c2 .cui-md')].map((e) => e.textContent.trim())))))`;
  const events = [
    ['tool', { id: 'a', name: 'Read', input: {} }],
    ['tool', { id: 'b', name: 'Card', input: {} }],
    ['tool', { id: 'c', name: 'Read', input: {} }],
    ['tool_result', { id: 'b', ok: false }],
    ['tool_result', { id: 'a', ok: true }],
    ['tool_result', { id: 'c', ok: true }],
    ['text', { delta: 'All done' }],
    ['end', {}],
  ].map(([type, data]) => ({ type, data }));
  const mount = `(async () => {
    const { mountChat } = await import('/ui/chat.js');
    document.getElementById('c2')?.remove();
    const el = Object.assign(document.createElement('div'), { id: 'c2' });
    document.body.append(el);
    window.c2 = mountChat(el, { block: (name, input, result) => (name !== 'Card' || (result && !result.ok) ? null : document.createElement('b')) });
  })()`;
  const want = ['1 step', '1 step', 'All done'];
  await page.eval(mount);
  await page.eval(`c2.ask('go')`);
  for (const e of events) {
    await page.eval(`c2.push(${JSON.stringify(e)})`);
    await page.eval(rows); // a frame between events, so each one redraws
  }
  assert.deepEqual(await page.eval(rows), want);
  await page.eval(mount);
  await page.eval(`c2.load([{ ask: 'go', events: ${JSON.stringify(events)} }])`);
  await page.eval(rows);
  await page.eval(`c2.replies([{ label: 'A' }])`); // redraws the last turn, as an app does on open
  assert.deepEqual(await page.eval(rows), want);
});
