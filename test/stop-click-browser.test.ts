// Stop shows "Stopping…" at once (#1529; Cara, 2026-11-08: "assume things will work instantly, but recover later if there
// was an issue"): the server's stop takes up to 15 s, and the head's button used to look as if nothing had happened.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = `<script>
  window.ready = true;
  const now = Date.now();
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  window.b = { id: 102, project_id: 1, kind: 'ticket', number: 2, title: 'Minion B', status: 'running', updated_at: now - 1, created_at: now - 600_000, last_activity: 'Working' };
  window.stops = [];
  window.stopAnswer = null; // set to a function to answer; unset, the POST hangs like a slow stop
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 1, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: [b], dismissed: 0, seen: {}, person_notes: {}, pins: [] });
    if (/\\/events$/.test(path)) return reply(200, url.search.includes('after=') ? [] : { events: [], tasks: [], more: false });
    if (/\\/stop$/.test(path)) {
      stops.push(path);
      return new Promise((resolve) => { window.answerStop = (body) => resolve(reply(200, body)); });
    }
    if (/seen$/.test(path)) return reply(200, { seen_at: now });
    return reply(200, []);
  };
  window.EventSource = class { constructor() { window.es = this; } close() {} };
</script>`;

let app: App;
let browser: Browser;
before(async () => { if (skip) return; app = await serveApp({ stub: STUB }); browser = await launch(bin!); });
after(async () => { await browser?.close(); await app?.close(); });

const label = `document.querySelector('.act-stop')?.textContent`;

test('Stop says "Stopping…" while the request is still open', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/t/2`, { width: 1280, height: 800 });
  await waitFor(page, 'the Stop button', `${label} === 'Stop'`);
  await page.eval(`document.querySelector('.act-stop').click()`);
  await waitFor(page, 'Stopping…', `${label} === 'Stopping…' && document.querySelector('.act-stop').disabled && stops.length === 1`);
});

test('a refused Stop puts the button back and says why', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/t/2`, { width: 1280, height: 800 });
  await waitFor(page, 'the Stop button', `${label} === 'Stop'`);
  await page.eval(`document.querySelector('.act-stop').click()`);
  await waitFor(page, 'Stopping…', `${label} === 'Stopping…'`);
  await page.eval(`answerStop({ stopped: false })`);
  await waitFor(page, 'the button back', `${label} === 'Stop' && !document.querySelector('.act-stop').disabled`);
  assert.match(await page.eval<string>('document.body.innerText'), /Couldn't stop/);
});
