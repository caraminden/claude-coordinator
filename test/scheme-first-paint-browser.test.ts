// A scheme's first paint draws its minions list on the list's own answer (#1533): the files, machines and scheme list
// come after it and fill in place, the Needs-you strip and Filters still hold their place from that paint (#989), and a
// link by number asks for its chat's history beside the list, not after it.
// Citadel's real front end in headless Chromium (test/browser.ts), fetch answered in the page with a slow server's timings.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = `<script>
  window.ready = true;
  localStorage.clear();
  localStorage.setItem('cc-inbox-open', location.search.includes('open') ? '1' : '0');
  const t0 = performance.now();
  window.net = []; // [path with query, 'ask' | 'answer', ms]
  const send = (key, body, ms) => { net.push([key, 'ask', performance.now() - t0]);
    return new Promise((r) => setTimeout(() => { net.push([key, 'answer', performance.now() - t0]); r(new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })); }, ms)); };
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const minion = { id: 101, project_id: 1, kind: 'ticket', number: 7, title: 'A minion', status: 'ready', updated_at: 0, created_at: 1 };
  const scheme = (tickets) => ({ project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets, seen: {}, person_notes: {}, pins: [] });
  window.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, ''), key = path + url.search;
    if (path === 'api/me') return send(key, { name: 'Cara', login: 'cara', admin: true, uid: 1 }, 0);
    // The scheme list, files and machines come late; the list in between; the strip's and filter's answers are quick.
    if (path === 'api/projects') return send(key, [{ id: 1, name: 'Alpha', inbox: 1, icon: null, coordinator_id: 100 }, { id: 2, name: 'Beta', inbox: 0, icon: null, coordinator_id: 200 }], 1200);
    if (path === 'api/projects/1' && url.searchParams.has('number')) return send(key, scheme([minion]), 0);
    if (path === 'api/projects/1') return send(key, scheme([minion]), 400);
    if (path === 'api/projects/1/inbox') return send(key, { items: [{ ticketId: 101, kind: 'state', key: 'a', state: 'ready' }] }, 150);
    if (path === 'api/projects/1/properties') return send(key, { keys: [{ key: 'type', status: 'active', value_kind: 'enum', values: [{ value: 'bug', status: 'active' }] }], proposals: [] }, 150);
    if (path === 'api/projects/1/views') return send(key, [], 150);
    if (/^api\\/projects\\/1\\/(artifacts|shared)$/.test(path) || path === 'api/machines') return send(key, [], 1200);
    if (/^api\\/tickets\\/\\d+\\/events$/.test(path)) return send(key, { events: [], tasks: [], more: false }, 0);
    return send(key, [], 0);
  };
  window.EventSource = class { close() {} };
  // Where the list's pieces sit below the panel's top, every frame from its first row until 1.6 s later.
  window.positions = []; window.drawnAt = null;
  (function f() {
    const top = document.querySelector('.sidebar > summary')?.getBoundingClientRect().top;
    const at = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().top - top) : null; };
    if (top != null && document.querySelector('#threads a.thread-row')) {
      drawnAt ??= performance.now() - t0;
      positions.push(JSON.stringify([at('.inbox-strip'), at('#coordinator-row'), at('#threads')]));
    }
    if (drawnAt == null || performance.now() - t0 < drawnAt + 1600) requestAnimationFrame(f); else window.watched = true;
  })();
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

type Net = [string, 'ask' | 'answer', number][];
const when = (net: Net, key: string, kind: 'ask' | 'answer') => net.find(([k, w]) => k === key && w === kind)?.[2] ?? Infinity;

for (const strip of ['shut', 'open']) {
  test(`a fresh open on a minion's link draws the list before the files answer, and nothing moves after (strip ${strip})`, { skip }, async () => {
    const page = await browser.page(`${base}${strip === 'open' ? '?open' : ''}#/p/1/t/7`, { width: 1280, height: 800 });
    await waitFor(page, 'the list to draw and be watched', 'window.watched === true');
    const net = (await page.eval('net')) as Net;
    const drawnAt = (await page.eval('drawnAt')) as number;
    assert.ok(drawnAt < when(net, 'api/projects/1/artifacts', 'answer'), `the list drew at ${Math.round(drawnAt)} ms, after the files answered`);
    assert.ok(drawnAt < when(net, 'api/projects', 'answer'), 'the list drew before the scheme list answered');
    // The chat's history was asked for before the list answered: its id came from the number, not from the list.
    assert.ok(when(net, 'api/tickets/101/events', 'ask') < when(net, 'api/projects/1?tickets=open', 'answer'), 'the events waited for the list');
    const positions = [...new Set((await page.eval('positions')) as string[])];
    assert.equal(positions.length, 1, `the list moved after it drew: ${positions.join(' then ')}`);
    await waitFor(page, 'the strip to fill in', `/Needs you/.test(document.querySelector('.inbox-strip').textContent) && !document.querySelector('.inbox-strip [aria-busy]')`);
  });
}
