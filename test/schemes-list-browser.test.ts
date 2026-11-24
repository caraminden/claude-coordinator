// The schemes list on a scheme page (#491): a failed fetch of api/projects (the restart gap, a dropped
// connection) keeps the schemes already shown and tries again, rather than blanking the list until a reload.
// And going back to a scheme draws it from its payload as you left it, refreshing it in place behind (#538).
// Citadel's real front end (public/index.html) in headless Chromium (test/browser.ts), with fetch answered
// in the page so nothing reaches a server.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, type Page, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

// Runs before app.js: a fake server for the API. `failProjects` fails that many fetches of api/projects with
// the 502 Caddy gives while the server restarts.
const STUB = `<script>
  window.ready = true;
  window.errors = [];
  addEventListener('error', (e) => errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.stack ?? e.reason)));
  window.failProjects = Number(new URLSearchParams(location.search).get('fail') ?? 0);
  const schemes = [{ id: 1, name: 'Alpha', inbox: 0, icon: null }, { id: 2, name: 'Beta', inbox: 0, icon: null }];
  // Each scheme's one minion; window.hold, when set, keeps a scheme's payload waiting until it resolves.
  window.titles = { 1: 'Alpha one', 2: 'Beta one' };
  window.hold = null;
  window.failScheme = 0;
  const minion = (id) => ({ id: id * 100 + 1, project_id: id, kind: 'ticket', number: 1, title: titles[id], status: 'idle', updated_at: 0 });
  const coordinator = (id) => ({ id: id * 100, project_id: id, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 });
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return window.failProjects-- > 0 ? new Response('Bad Gateway', { status: 502 }) : reply(200, schemes);
    let m;
    if ((m = path.match(/^api\\/projects\\/(\\d+)$/))) {
      const p = schemes.find((s) => s.id === Number(m[1]));
      await window.hold;
      if (window.failScheme-- > 0) return new Response('Bad Gateway', { status: 502 });
      return reply(200, { project: { ...p, instructions: '' }, coordinator: coordinator(p.id), tickets: [minion(p.id)], dismissed: 0, seen: {}, person_notes: {}, pins: [] });
    }
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: coordinator(Number(m[1]) / 100) });
    if (/^api\\/tickets\\/\\d+\\/events$/.test(path)) return reply(200, url.search.includes('after=') ? [] : { events: [], tasks: [], more: false });
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    return reply(200, []);
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

const names = (page: Page) => page.eval<string[]>(`[...document.querySelectorAll('#schemes-shelf .scheme-row')].map((r) => r.textContent)`);

test('a failed schemes fetch while moving between scheme pages keeps the list, and a retry brings it back fresh', { skip }, async () => {
  const page = await browser.page(`${base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the schemes list', `document.querySelectorAll('#schemes-shelf .scheme-row').length === 2`);
  // The next page load's fetch of the list hits the restart gap, as does the first retry; Beta is renamed meanwhile.
  await page.eval(`window.failProjects = 2; schemes[1].name = 'Bravo'; location.hash = '#/p/2'`);
  await waitFor(page, 'Beta to open', `document.querySelector('.scheme-crumb [data-project-name="2"]')`);
  const kept = await names(page);
  assert.equal(kept.length, 2, `the list kept both schemes: ${JSON.stringify(kept)}`);
  assert.ok(!kept.join().includes('Bravo'), 'still the list from before the gap');
  await waitFor(page, 'the retry to bring the fresh list', `document.querySelector('#schemes-shelf').textContent.includes('Bravo')`);
});

test('a page whose first schemes fetch fails fills the list in once a retry gets through', { skip }, async () => {
  // Straight to a scheme's URL (the front door needs the list to pick one), its first fetch of the list failing.
  const page = await browser.page(`${base}?fail=1#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'Alpha to open', `document.querySelector('.scheme-crumb [data-project-name="1"]')`);
  await waitFor(page, 'the retry to fill the list', `document.querySelectorAll('#schemes-shelf .scheme-row').length === 2`);
});

test('going back to a scheme draws it as you left it at once, with a ring by Minions, then refreshes it in place', { skip }, async () => {
  const page = await browser.page(`${base}#/p/1`, { width: 1280, height: 800 });
  const row = (title: string) => `[...document.querySelectorAll('#threads .thread-row')].some((r) => r.textContent.includes('${title}'))`;
  await waitFor(page, 'Alpha with its minion', row('Alpha one'));
  await page.eval(`location.hash = '#/p/2'`);
  await waitFor(page, 'Beta with its minion', row('Beta one'));
  // Alpha's minion is renamed while you're away, and the server is slow to say so, then fails once (a restart's gap).
  await page.eval(`titles[1] = 'Alpha renamed'; window.failScheme = 1; window.hold = new Promise((r) => { window.release = r; }); location.hash = '#/p/1'`);
  await waitFor(page, 'Alpha drawn without waiting for the server', `document.querySelector('.scheme-crumb [data-project-name="1"]') && ${row('Alpha one')}`);
  assert.equal(await page.eval(`document.querySelector('#app .sidebar').getAttribute('aria-busy')`), 'true', 'the Minions panel says it is refreshing');
  await page.eval(`window.release()`);
  await waitFor(page, 'the refresh to fail once and then bring the new title', row('Alpha renamed'));
  await waitFor(page, 'the ring to go', `!document.querySelector('#app .sidebar').hasAttribute('aria-busy')`);
});

// #674 (Cara, 2026-11-14: "it shows him as if he is in every scheme"): admin reach still opens a scheme you aren't in,
// but it sits under Other schemes, quiet and collapsed, not among yours; it opens out while you're in it.
test("a scheme you can open but aren't a member of is listed apart under Other schemes, not among yours", { skip }, async () => {
  const page = await browser.page(`${base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the schemes list', `document.querySelectorAll('#schemes-shelf .scheme-row').length === 2`);
  await page.eval(`titles[3] = 'Gamma one'; schemes.push({ id: 3, name: 'Gamma', inbox: 2, icon: null, member: false });
    for (const s of schemes.slice(0, 2)) s.member = true; location.hash = '#/p/2'`);
  const other = `document.querySelector('#schemes-shelf .other-schemes')`;
  await waitFor(page, 'the Other schemes section', `${other}?.querySelector('summary').textContent === 'Other schemes (1)'`);
  const top = await page.eval<string[]>(`[...document.querySelectorAll('#schemes-shelf > .scheme-row')].map((r) => r.textContent)`);
  assert.deepEqual(top, ['Alpha', 'Beta'], 'only your own schemes are in your list');
  assert.equal(await page.eval(`${other}.open`), false, 'collapsed while you are in one of yours');
  assert.equal(await page.eval(`${other}.querySelector('.scheme-row').textContent`), 'Gamma');
  assert.equal(await page.eval(`${other}.querySelector('.scheme-count')`), null, 'no Needs-you count for a scheme you are not in');
  await page.eval(`location.hash = '#/p/3'`);
  await waitFor(page, 'Gamma to open, its row showing', `document.querySelector('.scheme-crumb [data-project-name="3"]') && ${other}.open && ${other}.querySelector('.nav-item.active')`);
});
