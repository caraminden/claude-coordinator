// A big scheme's dismissed minions must not make every minion update expensive (#1077). Each `ticket` message
// on the stream redraws the whole minions list; with a thousand dismissed minions each redraw built a thousand
// hidden rows, each stamping its "Dismissed at" with a fresh date formatter: a quarter second of main thread
// per update on a desktop, a second or more on a phone, so typing and scrolling froze while minions ran.
// Citadel's real front end in headless Chromium (test/browser.ts), with fetch answered in the page.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = `<script>
  window.ready = true;
  const now = Date.now();
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  window.running = { id: 101, project_id: 1, kind: 'ticket', number: 1, title: 'A running minion', status: 'running', updated_at: now, created_at: now - 600_000 };
  const closed = Array.from({ length: 1000 }, (_, i) => ({ id: 200 + i, project_id: 1, kind: 'ticket', number: 2 + i, title: 'Dismissed minion ' + i, status: 'closed', updated_at: now - i * 60_000, created_at: now - 86_400_000 * 30, closed_at: now - i * 3_600_000 }));
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, url.search.includes('tickets=closed') ? { tickets: closed } : { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: [running], dismissed: closed.length, seen: {}, person_notes: {}, pins: [] });
    let m;
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: m[1] === '100' ? coordinator : m[1] === '101' ? running : closed[m[1] - 200] });
    if (/\\/events$/.test(path)) return reply(200, url.search.includes('after=') ? [] : { events: [], tasks: [], more: false });
    if (/seen$/.test(path)) return reply(200, { seen_at: now });
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    return reply(200, []);
  };
  window.EventSource = class { constructor() { window.es = this; } close() {} };
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

const closedRows = `document.querySelectorAll('#threads details.g-closed .thread-row').length`;

test('a shut Dismissed list builds no rows, at first or when minion updates redraw the list', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the Dismissed list', `document.querySelector('#threads details.g-closed')`);
  assert.equal(await page.eval(closedRows), 0);
  // No timing here (a slow runner would flake it): tools/typing-lag.ts measures the redraws. Before the fix each update took about 250 ms.
  await page.eval(`(() => { for (let n = 1; n <= 20; n++) es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...running, last_activity: 'Running commands ' + n, updated_at: Date.now() } }) }); })()`);
  assert.match(await page.eval<string>(`document.querySelector('#threads .thread-row.s-running').textContent`), /Running commands 20/);
  assert.equal(await page.eval(closedRows), 0);
});

test('opening the Dismissed list builds its rows, each with when it was dismissed, and they stay through a redraw', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the Dismissed list', `document.querySelector('#threads details.g-closed')`);
  await page.eval(`document.querySelector('#threads details.g-closed summary').click()`);
  await waitFor(page, 'the dismissed rows', `${closedRows} === 1000`);
  const stamps = await page.eval<string[]>(`[0, 999].map((i) => document.querySelectorAll('#threads details.g-closed .closed-at')[i].textContent)`);
  assert.match(stamps[0], /^Dismissed \d{1,2}:\d\d [AP]M P[SD]T$/);
  assert.match(stamps[1], /^Dismissed [A-Z][a-z]{2} \d{1,2}(, \d{4})?$/);
  await page.eval(`es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...running, last_activity: 'More' } }) })`);
  assert.equal(await page.eval(closedRows), 1000);
  assert.equal(await page.eval(`document.querySelector('#threads details.g-closed').open`), true);
});

test('a link to a dismissed minion opens the Dismissed list at its row', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/t/500`, { width: 1280, height: 800 });
  await waitFor(page, 'the dismissed minion\'s row', `document.querySelector('#threads details.g-closed[open] .thread-row.active')`);
  assert.match(await page.eval<string>(`document.querySelector('#threads .thread-row.active').textContent`), /Dismissed minion 498/);
});

test('a redraw reuses the Dismissed rows whose minion did not change, and rebuilds the one that did', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the Dismissed list', `document.querySelector('#threads details.g-closed')`);
  await page.eval(`document.querySelector('#threads details.g-closed summary').click()`);
  await waitFor(page, 'the dismissed rows', `${closedRows} === 1000`);
  await page.eval(`(() => { window.before = [...document.querySelectorAll('#threads details.g-closed .thread-row')]; window.group = document.querySelector('#threads details.g-closed'); })()`);
  // An update to the running minion redraws the list: every dismissed row and the list itself stay the same nodes.
  await page.eval(`es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...running, last_activity: 'More' } }) })`);
  assert.equal(await page.eval(`[...document.querySelectorAll('#threads details.g-closed .thread-row')].every((r, i) => r === before[i]) && document.querySelector('#threads details.g-closed') === group`), true);
  // A dismissed minion that changes gets a new row in its place; its neighbours keep theirs.
  await page.eval(`es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...closed[5], title: 'Renamed', updated_at: closed[5].updated_at + 1 } }) })`);
  const same = await page.eval<boolean[]>(`[...document.querySelectorAll('#threads details.g-closed .thread-row')].map((r, i) => r === before[i])`);
  assert.equal(same.length, 1000);
  assert.equal(same.filter((x) => !x).length, 1);
  assert.match(await page.eval<string>(`document.querySelectorAll('#threads details.g-closed .thread-row')[0].textContent + document.querySelector('#threads details.g-closed').textContent`), /Renamed/);
});
