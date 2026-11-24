// public/releases.js (#1309): the Releases page shows the shared loading line until the releases arrive, then its head, the list's All row and the line saying nothing ships yet; since #1423 the CI page's list and tabs sit around it, Releases the first tab. Citadel's real front end in headless Chromium (test/browser.ts), with fetch answered in the page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = `<script>
  window.ready = true;
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  window.gate = new Promise((r) => { window.open = r; });
  window.fetch = async (input) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply({ name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply([{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (/^api\\/projects\\/1$/.test(path)) return reply({ project: { id: 1, name: 'Alpha', instructions: '' }, coordinator: { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: Date.now(), created_at: Date.now() }, tickets: [] });
    if (path === 'api/ci') return reply({ schemes: [], pcs: [] });
    if (path === 'api/releases') { await window.gate; return reply({ schemes: [] }); }
    return reply([]);
  };
  window.EventSource = class { constructor() { setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: 'hello', usage: {}, version: 'v1' }) }), 100); } close() {} };
</script>`;

let app: App;
let browser: Browser;

before(async () => {
  if (skip) return;
  app = await serveApp({ stub: STUB });
  browser = await launch(bin!);
});
after(async () => {
  await browser?.close();
  await app?.close();
});

test('the page shows the shared loading line, then its head, the All row, the tabs and the empty line', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/releases/all`, { width: 1280, height: 800 });
  await waitFor(page, 'the loading line', `!!document.querySelector('.releases-main .cui-loading[role=status]')`);
  assert.equal(await page.eval(`document.querySelector('.releases-main .cui-loading').textContent.trim()`), 'Loading releases…');
  await page.eval('window.open()');
  await waitFor(page, 'the releases to draw', `!document.querySelector('.releases-main .cui-loading')`);
  assert.equal(await page.eval(`document.querySelector('.releases-main .rel-head h2').textContent.startsWith('Releases')`), true);
  assert.match(await page.eval<string>(`document.querySelector('.releases-main .ci-list .ci-li.ci-all.on')?.textContent ?? ''`), /^All schemes/);
  // All has no one CI: its tabs are Releases and Status only.
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('.releases-main .ci-detail [role=tab]')].map((t) => t.textContent)`), ['Releases', 'Status']);
  assert.match(await page.eval<string>(`document.querySelector('.releases-main .rel-body').textContent`), /Nothing ships yet/);
});

test('opened from a scheme, the page shows that scheme with every tab, Releases picked', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/releases`, { width: 1280, height: 800 });
  await page.eval('window.open()');
  await waitFor(page, 'the releases to draw', `!!document.querySelector('.releases-main .ci-li.on[data-scheme="1"]')`);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('.releases-main .ci-detail [role=tab]')].map((t) => t.textContent)`), ['Releases', 'Overview', 'History', 'Test health', 'Numbers', 'Status']);
  assert.equal(await page.eval(`document.querySelector('.releases-main .ci-detail [role=tab][aria-selected=true]')?.textContent`), 'Releases');
});

test('an old CI link opens the same page on its CI tab', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/ci/history`, { width: 1280, height: 800 });
  await waitFor(page, 'the page', `!!document.querySelector('.releases-main .ci-detail [role=tab][aria-selected=true]')`);
  assert.equal(await page.eval(`document.querySelector('.releases-main .ci-detail [role=tab][aria-selected=true]').textContent`), 'History');
});
