// Reopening a chat kept in the page's cache draws it once and only appends what arrived since (#1531). It used
// to draw the cached copy, ask for what's new, and then draw the whole chat a second time, and the catch-up
// asked the server twice. Citadel's real front end in headless Chromium (test/browser.ts), fetch answered in the page.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

// Minion 7 has three messages. Once the test sets window.newer, its catch-ups (events?after=) are counted and held
// until release(), then bring a fourth.
const STUB = `<script>
  window.ready = true;
  window.afters = 0;
  let open;
  const held = new Promise((r) => (open = r));
  window.release = () => open();
  const now = Date.now();
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const minion = (id, number) => ({ id, project_id: 1, kind: 'ticket', number, title: 'Minion ' + number, status: 'idle', updated_at: now, created_at: now - 600_000 });
  const tickets = [minion(101, 7), minion(102, 8)];
  const said = (id, text) => ({ id, ticket_id: 101, kind: 'user_message', data: JSON.stringify({ text, author: 'Josh' }), created_at: now - 60_000 + id });
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets, seen: { 101: now, 102: now }, person_notes: {}, pins: [] });
    let m;
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: [coordinator, ...tickets].find((t) => String(t.id) === m[1]) });
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/events$/))) {
      const after = url.searchParams.get('after');
      if (m[1] !== '101') return reply(200, after ? [] : { events: [], tasks: [], more: false });
      if (!after) return reply(200, { events: [said(1, 'First'), said(2, 'Second'), said(3, 'Third')], tasks: [], more: false });
      if (!window.newer) return reply(200, []);
      window.afters++;
      return held.then(() => reply(200, Number(after) < 4 ? [said(4, 'Caught up')] : []));
    }
    if (/seen$/.test(path)) return reply(200, { seen_at: now });
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    return reply(200, []);
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

test('reopening a cached chat keeps what it drew and appends what is new, with one catch-up request', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/t/7`, { width: 1280, height: 800 });
  await waitFor(page, 'the chat', `document.querySelector('#log [data-eid="3"]')`);
  await page.eval(`location.hash = '#/p/1/t/8'`);
  await waitFor(page, 'the other chat', `!document.querySelector('#log [data-eid="3"]') && document.getElementById('ticket-head')?.textContent.includes('Minion 8')`);
  await page.eval(`window.newer = true; location.hash = '#/p/1/t/7'`);
  await waitFor(page, 'the chat again', `(window.first = document.querySelector('#log [data-eid="1"]'))`);
  await page.eval('release()');
  await waitFor(page, 'the caught-up message', `document.querySelector('#log [data-eid="4"]')`);
  await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
  assert.equal(await page.eval<boolean>('window.first.isConnected'), true, 'the chat was drawn a second time after the catch-up');
  assert.equal(await page.eval<number>('document.querySelectorAll(\'#log [data-eid]\').length'), 4);
  assert.equal(await page.eval<number>('window.afters'), 1, 'the catch-up asked the server more than once');
});
