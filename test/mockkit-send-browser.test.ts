// The mock kit's Send dock in a real browser (headless Chromium, test/browser.ts), against a stubbed Citadel
// bridge: pressing Send again for picks that were already sent must not post them again (#420), also after a
// reload; a changed pick sends again; a failed send rolls back with a toast and Retry.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, type Page, serve, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;
const starter = join(import.meta.dirname, '..', 'kit', 'skills', 'docs-and-mocks', 'starter');

// `fail` makes the next send reject; the stubbed bridge counts and records every post in window.posts.
const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Take page</title><link rel="stylesheet" href="/mockkit.css">
<script>
  window.posts = []; window.fail = false;
  const docs = new Map();
  window.claude = { use: async () => ({ collection: () => ({
    onSnapshot: (cb) => { window.snap = () => cb({ docs: [...docs].map(([id, d]) => ({ id, data: () => d })) }); window.snap(); },
    doc: (id) => ({ set: async (d) => { docs.set(id, d); window.snap(); }, delete: async () => { docs.delete(id); window.snap(); } }),
  }) }) };
  window.citadel = {
    info: async () => ({ person: 'cara' }),
    watchSaves: (cb) => { window.setSave = cb; },
    // labelAtSend: the button's label as the post leaves, read in the page so a loaded box can't let the 120 ms run out first.
    send: async (text) => { window.labelAtSend = document.querySelector('.mk-dock > button').textContent; await new Promise((r) => setTimeout(r, 120)); if (window.fail) { window.fail = false; throw new Error('boom'); } window.posts.push(text); return { sent: true, to: '#419' }; },
  };
</script>
<script src="/mockkit.js"></script>
<body class="mk"><main class="mk-page">
  <section data-pick="a" data-title="Take A"><h2>Take A</h2></section>
  <section data-pick="b" data-title="Take B"><h2>Take B</h2></section>
</main>
<script>mock.picks({ options: [{ v: 'pick', label: 'Pick this', done: 'Picked' }] }); mock.ready.then(() => setTimeout(() => (window.ready = true), 50));</script>`;

let app: App;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  app = await serve((path, res) => {
    if (path === '/') return void res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (path === '/mockkit.js' || path === '/mockkit.css') {
      return void res.writeHead(200, { 'content-type': path.endsWith('js') ? 'text/javascript' : 'text/css' }).end(readFileSync(join(starter, path)));
    }
    res.writeHead(404).end();
  });
  base = app.base;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await app?.close();
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A person scrolls a button into view before pressing it; the sticky dock covers the bottom of the 400 px viewport.
const click = async (page: Page, sel: string) => { await page.eval(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({ block: 'center' })`); const c = await page.centre(sel); await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 }); await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 }); };
const posts = (page: Page) => page.eval<string[]>('window.posts');
const send = (page: Page) => click(page, '.mk-dock > button');
const label = (page: Page) => page.eval<string>('document.querySelector(".mk-dock > button").textContent');
const disabled = (page: Page) => page.eval<boolean>('document.querySelector(".mk-dock > button").disabled');

test('pressing Send again for the same picks posts nothing more, and the button stays Sent and disabled', { skip }, async () => {
  const page = await browser.page(base);
  await click(page, '[data-pick="a"] [data-v="pick"]');
  await send(page);
  await waitFor(page, 'the post', 'window.posts.length > 0');
  assert.equal((await posts(page)).length, 1);
  assert.equal(await disabled(page), true, 'no second press is possible');
  assert.match(await label(page), /Sent/);
  await page.eval('document.querySelector(".mk-dock > button").click()'); // even a scripted click
  await wait(250);
  assert.equal((await posts(page)).length, 1);
});

test('a changed pick or note makes Send ready again, and the new text posts once', { skip }, async () => {
  const page = await browser.page(base);
  await click(page, '[data-pick="a"] [data-v="pick"]');
  await send(page);
  await waitFor(page, 'the first post', 'window.posts.length > 0');
  await click(page, '[data-pick="b"] [data-v="pick"]');
  assert.equal(await disabled(page), false);
  assert.doesNotMatch(await label(page), /Sent/);
  await send(page);
  await waitFor(page, 'the second post', 'window.posts.length > 1');
  const p = await posts(page);
  assert.equal(p.length, 2);
  assert.notEqual(p[0], p[1]);
  // Going back to the exact text already sent is not a change worth a second post either.
  await send(page).catch(() => {});
  await wait(100);
  assert.equal((await posts(page)).length, 2);
});

test('after a reload the same picks are still Sent and cannot post again', { skip }, async () => {
  const page = await browser.page(base);
  await click(page, '[data-pick="a"] [data-v="pick"]');
  await send(page);
  await waitFor(page, 'the post', 'window.posts.length > 0');
  // The stub's picks live in memory, so put the same pick back after reloading, as the saved ones would be.
  await page.eval(`(() => { location.reload(); })()`).catch(() => {});
  await waitFor(page, 'the reloaded page', 'window.ready && window.posts.length === 0');
  await click(page, '[data-pick="a"] [data-v="pick"]');
  await waitFor(page, 'the pick to be drawn', '/Sent/.test(document.querySelector(".mk-dock > button").textContent)');
  // Same text as before the reload, apart from who/when, which the summary leaves out.
  assert.equal(await disabled(page), true);
  assert.match(await label(page), /Sent/);
});

test('a failed send rolls back to ready, with a toast whose Retry posts it', { skip }, async () => {
  const page = await browser.page(base);
  await click(page, '[data-pick="a"] [data-v="pick"]');
  await page.eval('window.fail = true');
  await send(page);
  await waitFor(page, 'the post to leave', 'window.labelAtSend !== undefined');
  assert.match(await page.eval<string>('window.labelAtSend'), /Sent/, 'shows Sent at once, before the post resolves');
  await waitFor(page, 'the toast', '!!document.querySelector(".mk-toast")');
  assert.equal(await page.eval('!!document.querySelector(".mk-toast")'), true);
  assert.equal(await disabled(page), false);
  assert.doesNotMatch(await label(page), /Sent/);
  await click(page, '.mk-toast .primary');
  await waitFor(page, 'the retried post', 'window.posts.length > 0');
  assert.equal((await posts(page)).length, 1);
  assert.equal(await disabled(page), true);
});

// #914: the button must not move while the status text, the Sent line and the label change.
for (const width of [1200, 700, 390]) {
  test(`the dock's button keeps its box through picks, notes, save states and Sent at ${width}px`, { skip }, async () => {
    const page = await browser.page(base, { width, height: 700 });
    await waitFor(page, 'the page', 'window.ready');
    // The button's box inside the dock (x, y from the dock's top, size) plus the dock's own height.
    const box = () => page.eval<string>(`(() => { const d = document.querySelector('.mk-dock'), b = d.querySelector('button'), r = b.getBoundingClientRect(), q = d.getBoundingClientRect(); return [r.left, r.top - q.top, r.width, r.height, q.height].map((n) => Math.round(n)).join(','); })()`);
    const seen: Record<string, string> = {};
    const snap = async (name: string) => { seen[name] = await box(); };
    await snap('empty');
    await click(page, '[data-pick="a"] [data-v="pick"]');
    await snap('one picked');
    await click(page, '[data-pick="b"] [data-v="pick"]');
    await page.eval(`window.setSave('saving')`); await snap('saving');
    await page.eval(`window.setSave('retrying')`); await snap('retrying');
    await page.eval(`window.setSave('saved')`); await snap('saved');
    await page.eval(`document.querySelector('.mk-dock .mk-sent').textContent = 'Sent to #419 ✓ and a long line that goes on and on to prove it cannot push anything around'`); await snap('sent line');
    await page.eval(`document.querySelector('.mk-dock .mk-sent').textContent = ''`);
    await send(page);
    await waitFor(page, 'the post', 'window.posts.length > 0');
    await snap('sent');
    const first = seen.empty.split(',').map(Number);
    for (const [name, v] of Object.entries(seen)) {
      const n = v.split(',').map(Number);
      // Same x, width, height and place in the dock, and the dock's own height, in every state (the page y of a sticky dock may change).
      assert.deepEqual(n, first, `${name} at ${width}px moved the button or resized the dock: ${v} vs ${seen.empty}`);
    }
  });
}
