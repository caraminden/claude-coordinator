// The schemes list on a scheme page (#491): a failed fetch of api/projects (the restart gap, a dropped
// connection) keeps the schemes already shown and tries again, rather than blanking the list until a reload.
// And going back to a scheme draws it from its payload as you left it, refreshing it in place behind (#538).
// Citadel's real front end (public/index.html) in headless Chromium (test/browser.ts), with fetch answered
// in the page so nothing reaches a server.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const pub = join(import.meta.dirname, '..', 'public');

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
      return reply(200, { project: { ...p, instructions: '' }, coordinator: coordinator(p.id), tickets: [minion(p.id)], dismissed: 0, seen: {}, person_notes: {}, pins: [] });
    }
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: coordinator(Number(m[1]) / 100) });
    if (/^api\\/tickets\\/\\d+\\/events$/.test(path)) return reply(200, url.search.includes('after=') ? [] : { events: [], tasks: [], more: false });
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    return reply(200, []);
  };
  window.EventSource = class { close() {} };
</script>`;

let server: Server;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  const types: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/') {
      const html = readFileSync(join(pub, 'index.html'), 'utf8').replace('<head>', `<head>${STUB}`);
      return res.writeHead(200, { 'content-type': 'text/html' }).end(html);
    }
    const file = normalize(join(pub, path));
    if (!file.startsWith(pub)) return res.writeHead(404).end();
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      return res.writeHead(404).end();
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r(null)));
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
  // Alpha's minion is renamed while you're away, and the server is slow to say so.
  await page.eval(`titles[1] = 'Alpha renamed'; window.hold = new Promise((r) => { window.release = r; }); location.hash = '#/p/1'`);
  await waitFor(page, 'Alpha drawn without waiting for the server', `document.querySelector('.scheme-crumb [data-project-name="1"]') && ${row('Alpha one')}`);
  assert.equal(await page.eval(`document.querySelector('#app .sidebar').getAttribute('aria-busy')`), 'true', 'the Minions panel says it is refreshing');
  await page.eval(`window.release()`);
  await waitFor(page, 'the refresh to bring the new title', row('Alpha renamed'));
  await waitFor(page, 'the ring to go', `!document.querySelector('#app .sidebar').hasAttribute('aria-busy')`);
});
