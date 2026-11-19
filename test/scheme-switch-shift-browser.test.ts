// Switching schemes moves nothing but the content (#989, "No reflow without input"). The Needs-you strip and the
// Filters button used to arrive after the new scheme drew, pushing the Taskmaster row, search and list down or up.
// Citadel's real front end in headless Chromium (test/browser.ts), fetch answered in the page: Alpha has a waiting
// minion and a filter key, Beta has neither, and the inbox, properties and views answers come late, as a slow server's do.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = `<script>
  window.ready = true;
  const late = (body) => new Promise((r) => setTimeout(() => r(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })), 250));
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const scheme = (id, name) => ({ project: { id, name, instructions: '' }, coordinator: { id: id * 100, project_id: id, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 },
    tickets: id === 1 ? [{ id: 101, project_id: 1, kind: 'ticket', number: 7, title: 'A minion', status: 'ready', updated_at: 0, created_at: 1 }] : [], seen: {}, person_notes: {}, pins: [] });
  window.fetch = async (input) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply({ name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply([{ id: 1, name: 'Alpha', inbox: 1, icon: null, coordinator_id: 100 }, { id: 2, name: 'Beta', inbox: 0, icon: null, coordinator_id: 200 }]);
    let m;
    if ((m = path.match(/^api\\/projects\\/(\\d)$/))) return reply(scheme(Number(m[1]), m[1] === '1' ? 'Alpha' : 'Beta'));
    if ((m = path.match(/^api\\/projects\\/(\\d)\\/inbox$/))) return late({ items: m[1] === '1' ? [{ ticketId: 101, kind: 'state', key: 'a', state: 'ready' }] : [] });
    if ((m = path.match(/^api\\/projects\\/(\\d)\\/properties$/))) return late({ keys: m[1] === '1' ? [{ key: 'type', status: 'active', value_kind: 'enum', values: [{ value: 'bug', status: 'active' }] }] : [], proposals: [] });
    if ((m = path.match(/^api\\/projects\\/(\\d)\\/views$/))) return late([]);
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/events$/))) return reply({ events: [], tasks: [], more: false });
    return reply([]);
  };
  window.EventSource = class { close() {} };
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

// Where the minions list's pieces sit below the panel's own top, every frame for a while after the switch.
const WATCH = `new Promise((resolve) => {
  const top = () => document.querySelector('.sidebar > summary').getBoundingClientRect().top;
  const at = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().top - top()) : null; };
  const seen = []; const t0 = performance.now();
  (function f() {
    if (document.getElementById('coordinator-row')?.textContent.includes('Beta')) seen.push(JSON.stringify([at('#coordinator-row'), at('#threads')]));
    if (performance.now() - t0 < 800) requestAnimationFrame(f); else resolve([...new Set(seen)]);
  })();
  location.hash = '#/p/2';
})`;

test('switching to a scheme with no waiting minions and no filters keeps the minions list where it first drew', { skip }, async () => {
  const page = await browser.page(`${base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'Alpha to draw its strip and filters', `!!document.querySelector('.inbox-strip:not([hidden]) .inbox-toggle') && !!document.querySelector('#prop-filter .pf-toggle')`);
  const positions = (await page.eval(WATCH)) as string[];
  assert.ok(positions.length > 0, 'Beta drew');
  assert.equal(positions.length, 1, `the list moved after Beta drew: ${positions.join(' then ')}`);
});
