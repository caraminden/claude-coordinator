// ui/chat.js's reply chips in a real browser (headless Chromium, test/browser.ts): chips given while a
// turn runs wait disabled, and come alive once it ends; a tapped chip and older turns' chips stay off.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const pub = join(import.meta.dirname, '..', 'public');

const PAGE = `<!doctype html><meta charset="utf-8"><div id="chat" style="height:400px"></div>
<script type="module">
  import { mountChat } from '/ui/chat.js';
  window.said = [];
  window.chat = mountChat(document.getElementById('chat'), { onReply: (m) => window.said.push(m) });
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
    const m = /^\/ui\/([a-z-]+\.js)$/.exec(path);
    if (!m) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(join(pub, 'ui', m[1])));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r(null)));
});

/** Each chip as "label:on" or "label:off", in order, after the next frame has drawn. */
const chips = (page: Page) => page.eval<string[]>(`new Promise((r) => requestAnimationFrame(() => setTimeout(() =>
  r([...document.querySelectorAll('.cui-choice')].map((c) => c.textContent + (c.disabled ? ':off' : ':on'))), 0)))`);

test('chips given while a turn runs come alive once it ends; a tapped one and older turns\' stay off', { skip }, async () => {
  const page = await browser.page(base, { width: 600, height: 500 });
  await page.eval(`chat.ask('go'); chat.push({ type: 'text', data: { text: 'Pick one' } }); chat.replies([{ label: 'A' }, { label: 'B' }])`);
  assert.deepEqual(await chips(page), ['A:off', 'B:off'], 'disabled while the turn runs');
  await page.eval(`chat.push({ type: 'end', data: {} })`);
  assert.deepEqual(await chips(page), ['A:on', 'B:on'], 'alive once it ends');
  await page.eval(`document.querySelector('.cui-choice').click()`);
  assert.deepEqual(await page.eval('said'), ['A']);
  assert.deepEqual(await chips(page), ['A:off', 'B:off'], 'a tapped chip leaves them all off');
  // A later turn: its own chips come alive at its end, the first turn's stay off.
  await page.eval(`chat.ask('A'); chat.push({ type: 'text', data: { text: 'Next?' } }); chat.replies([{ label: 'C' }])`);
  await page.eval(`chat.push({ type: 'end', data: {} })`);
  assert.deepEqual(await chips(page), ['A:off', 'B:off', 'C:on']);
});
