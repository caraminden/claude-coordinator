// public/reviews.js (#1309): the Reviewers and critics page shows the shared loading line until its set arrives, then its head and tabs, and empty set draws without error. Citadel's real front end in headless Chromium (test/browser.ts), with fetch answered in the page.
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
    if (path === 'api/projects/1/reviews') { await window.gate; return reply({ entries: [], starters: [], audits: [], glance: null }); }
    return reply([]);
  };
  window.EventSource = class { close() {} };
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

test('the page shows the shared loading line, then its head and both tabs in the same place', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/reviews`, { width: 1280, height: 800 });
  await waitFor(page, 'the loading line', `!!document.querySelector('.reviews-main .cui-loading[role=status]')`);
  assert.equal(await page.eval(`document.querySelector('.reviews-main .cui-loading').textContent.trim()`), 'Loading…');
  const top = await page.eval<number>(`document.querySelector('.reviews-main .rv-head').getBoundingClientRect().top`);
  await page.eval('window.open()');
  await waitFor(page, 'the set to draw', `!document.querySelector('.reviews-main .cui-loading')`);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('.reviews-main .rv-tabs button')].map((b) => b.textContent)`), ['This scheme', 'Every scheme']);
  assert.equal(await page.eval<number>(`document.querySelector('.reviews-main .rv-head').getBoundingClientRect().top`), top, 'the head did not move');
});
