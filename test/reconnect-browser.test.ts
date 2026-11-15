// While the live stream is down (a restart, #493), the page keeps what it shows and, after a moment, a
// "Reconnecting…" chip says why, gone once the stream is back. Citadel's real front end (public/index.html)
// in headless Chromium (test/browser.ts), with fetch and EventSource faked in the page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

// Runs before app.js: a fake API, and an EventSource the test opens and drops (window.streams).
const STUB = `<script>
  window.ready = true;
  window.errors = [];
  addEventListener('error', (e) => errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.stack ?? e.reason)));
  const scheme = { id: 1, name: 'Alpha', inbox: 0, icon: null };
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, [scheme]);
    if (path === 'api/projects/1') return reply(200, { project: { ...scheme, instructions: '' }, coordinator, tickets: [], seen: {}, person_notes: {}, pins: [] });
    if (path === 'api/tickets/100') return reply(200, { ticket: coordinator });
    if (/^api\\/tickets\\/\\d+\\/events$/.test(path)) return reply(200, url.search.includes('after=') ? [] : { events: [], tasks: [], more: false });
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    if (path === 'api/projects/1/properties') return reply(200, { keys: [] });
    return reply(200, []);
  };
  window.streams = [];
  window.EventSource = class {
    static CONNECTING = 0; static OPEN = 1; static CLOSED = 2;
    readyState = 0;
    constructor() { streams.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); }); }
    close() { this.readyState = 2; }
  };
  // What a browser does when the server ends the stream: an error, then it retries on its own.
  window.dropStream = () => { const es = streams.at(-1); es.readyState = 0; es.onerror?.(); };
  window.reopenStream = () => { const es = streams.at(-1); es.readyState = 1; es.onopen?.(); };
</script>`;

let app: App;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  app = await serveApp({ stub: STUB });
  base = app.base;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await app?.close();
});

const chip = `document.querySelector('.reconnecting')`;

test('a dropped live stream shows "Reconnecting…" after a moment, keeps the page, and clears once it is back', { skip }, async () => {
  const page = await browser.page(`${base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the scheme page', `document.querySelector('.scheme-crumb [data-project-name="1"]') && streams.at(-1)?.readyState === 1`);

  // Timed in the page, whose timers run in order, so a loaded box can't let the 1.5 s pass before the look.
  assert.equal(await page.eval(`dropStream(), new Promise((r) => setTimeout(() => r(!!${chip}), 500))`), false, 'a blip shorter than 1.5 s shows nothing');
  await page.eval(`dropStream()`); // the browser's retries fail too; they must not put the chip off
  await waitFor(page, 'the chip', `${chip}?.textContent === 'Reconnecting…'`);
  assert.equal(await page.eval(`${chip}.getAttribute('role')`), 'status');
  assert.equal(await page.eval(`!!document.querySelector('[data-taskmaster-name="1"]') && !!document.querySelector('.scheme-crumb [data-project-name="1"]')`), true, 'the page stays as it was');

  await page.eval(`reopenStream()`);
  assert.equal(await page.eval(`!!${chip}`), false, 'gone once the stream is back');
});

test('a stream back within the moment never shows the chip', { skip }, async () => {
  const page = await browser.page(`${base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the scheme page', `streams.at(-1)?.readyState === 1`);
  // Timed in the page, as above: back after 300 ms, then a look once the 1.5 s would have run out.
  assert.equal(await page.eval(`dropStream(), new Promise((r) => setTimeout(() => { reopenStream(); setTimeout(() => r(!!${chip}), 1700); }, 300))`), false);
});
