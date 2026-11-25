// While the live stream is down (a restart, #493), the page keeps what it shows and, after a moment, a
// "Reconnecting…" chip says why, gone once the stream is back. Citadel's real front end (public/index.html)
// in headless Chromium (test/browser.ts), with fetch and EventSource faked in the page. Then what a reconnect owes (#1854):
// a catch-up that fails is tried again with nothing lost, and an older answer never undoes what came live.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';
import { pageStub } from './page-stub.ts';

const bin = chromium();
const skip = !bin && skipMessage;

// Runs before app.js: a fake API, and an EventSource the test opens and drops (window.streams).
const STUB = pageStub(`
  window.ready = true;
  window.errors = [];
  addEventListener('error', (e) => errors.push(String(e.message)));
  addEventListener('unhandledrejection', (e) => errors.push(String(e.reason?.stack ?? e.reason)));
  const scheme = { id: 1, name: 'Alpha', inbox: 0, icon: null };
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const minion = (id, more) => ({ id, project_id: 1, kind: 'ticket', number: id - 100, title: 'Minion ' + id, status: 'idle', created_at: now, updated_at: 10, ...more });
  window.said = (id, ticket_id, text) => ({ id, ticket_id, kind: 'user_message', data: JSON.stringify({ text, author: 'Josh' }), created_at: now });
  // What the server has: the test changes these, and \`failing\` (a RegExp) answers 500 to the paths it matches.
  window.rows = [minion(101), minion(102)];
  window.log = [said(1, 101, 'first')];
  window.failing = null;
  window.failed = 0;
  window.gate = null; // a promise the scheme's answer waits for, once it is made up
  window.live = (msg) => streams.at(-1).onmessage({ data: JSON.stringify(msg) });
  async function route(path, url) {
    if (failing?.test(path)) return failed++, reply(500, { error: 'down' });
    if (path === 'api/projects') return reply(200, [scheme]);
    if (path === 'api/projects/1') {
      const answer = reply(200, { project: { ...scheme, instructions: '' }, coordinator, tickets: rows, dismissed: 0, seen: {}, person_notes: {}, pins: [] });
      await gate;
      return answer;
    }
    if (path === 'api/tickets/100') return reply(200, { ticket: coordinator });
    const one = path.match(/^api\\/tickets\\/(\\d+)(\\/events)?$/);
    if (one?.[2]) {
      const mine = log.filter((e) => e.ticket_id === Number(one[1]) && e.id > Number(url.searchParams.get('after') ?? 0));
      return reply(200, url.search.includes('after=') ? mine : { events: mine, tasks: [], more: false });
    }
    if (one) return reply(200, { ticket: rows.find((t) => t.id === Number(one[1])) });
    if (path === 'api/projects/1/properties') return reply(200, { keys: [] });
  }
  if (location.search === '?desktop') window.citadelDesktop = { show() {} };
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
`);

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

// ---------- what a reconnect owes (#1854) ----------

const texts = `[...document.querySelectorAll('#log .msg.user')].map((m) => m.textContent.match(/first|missed|live|other/)?.[0]).join()`;
/** A signed-in page on a minion's chat, its history drawn and its stream open. */
async function openChat(hash = '#/p/1/t/1', query = '') {
  const page = await browser.page(`${base}${query}${hash}`, { width: 1280, height: 800 });
  await waitFor(page, 'the chat', `${texts} === 'first' && streams.at(-1)?.readyState === 1`);
  return page;
}
/** The tab goes out of sight and back, as far as the page can tell: going, it keeps the open chat for the next launch. */
const hide = `(() => {
  localStorage.removeItem('cc-last-chat');
  for (const state of ['hidden', 'visible']) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    document.dispatchEvent(new Event('visibilitychange'));
  }
  return !!localStorage.getItem('cc-last-chat');
})()`;

test('a catch-up that fails is tried again: live messages wait behind it, the chip says so, and nothing is missing', { skip }, async () => {
  const page = await openChat();
  await page.eval(`dropStream(), log.push(said(2, 101, 'missed')), failing = /tickets.101.events/, reopenStream()`);
  await waitFor(page, 'the failed catch-up', `failed > 0`);
  await page.eval(`log.push(said(3, 101, 'live')), live({ type: 'event', event: log.at(-1) })`);
  await waitFor(page, 'the chip', `${chip}?.textContent === 'Catching up…'`);
  assert.equal(await page.eval(texts), 'first', 'the live one waits for what came before it');
  assert.equal(await page.eval(hide), false, 'a chat with a hole is not kept for the next launch');
  await page.eval(`failing = null`);
  await waitFor(page, 'the chat whole', `${texts} === 'first,missed,live'`);
  await waitFor(page, 'the chip to go', `!${chip}`);
  assert.equal(await page.eval(hide), true, 'whole again, it is');
});

test('a scheme list that fails is tried again too, and the open chat stays live meanwhile', { skip }, async () => {
  const page = await openChat();
  await page.eval(`dropStream(), log.push(said(2, 101, 'missed')), rows = [...rows.slice(0, 1), { ...rows[1], title: 'Renamed', updated_at: 20 }], failing = /projects.1$/, reopenStream()`);
  await waitFor(page, 'the chip', `${chip}?.textContent === 'Catching up…'`);
  await page.eval(`log.push(said(3, 101, 'live')), live({ type: 'event', event: log.at(-1) })`);
  await waitFor(page, 'the chat whole', `${texts} === 'first,missed,live'`);
  assert.equal(await page.eval(`!!${chip}`), true, 'still catching up: the list is old');
  await page.eval(`failing = null`);
  await waitFor(page, 'the fresh list', `document.getElementById('threads').textContent.includes('Renamed') && !${chip}`);
});

test('switching chat drops what was held: the next chat is live at once, and the first is whole when reopened', { skip }, async () => {
  const page = await openChat();
  await page.eval(`dropStream(), log.push(said(2, 101, 'missed')), failing = /tickets.101.events/, reopenStream()`);
  await waitFor(page, 'the failed catch-up', `failed > 0`);
  await page.eval(`log.push(said(3, 101, 'live')), live({ type: 'event', event: log.at(-1) }), location.hash = '#/p/1/t/2'`);
  await waitFor(page, 'the second chat', `document.querySelector('.ticket-head')?.textContent.includes('Minion 102')`);
  await page.eval(`log.push(said(4, 102, 'other')), live({ type: 'event', event: log.at(-1) })`);
  await waitFor(page, "the second chat's own message", `${texts} === 'other'`);
  await waitFor(page, 'the chip to go: this chat is fresh', `!${chip}`);
  await page.eval(`failing = null, location.hash = '#/p/1/t/1'`);
  await waitFor(page, 'the first chat, whole', `${texts} === 'first,missed,live'`);
});

test('a dismissal that arrives while a reconnect is fetching is not undone by the older answer', { skip }, async () => {
  const page = await openChat();
  const row = `import(new URL('base.js', location.href)).then((m) => m.view.tickets.get(102).status + ' ' + m.view.ticket.title)`;
  await page.eval(`gate = new Promise((ok) => (window.letGo = ok)), dropStream(), reopenStream()`);
  await page.eval(`live({ type: 'ticket', ticket: { ...rows[1], status: 'closed', updated_at: 20 } }), live({ type: 'ticket', ticket: { ...rows[0], title: 'Newer', updated_at: 20 } })`);
  // The catch-up's chat history comes after its lists, so once it shows, they have been taken in.
  await page.eval(`log.push(said(2, 101, 'missed')), letGo()`);
  await waitFor(page, 'the catch-up', `${texts} === 'first,missed'`);
  assert.equal(await page.eval(row), 'closed Newer');
});

test('↻ reloads with a draft open while a new front end waits', { skip }, async () => {
  const page = await openChat();
  await page.eval(`live({ type: 'hello', version: 'aaa' }), live({ type: 'hello', version: 'bbb' })`);
  await page.eval(`(() => { window.before = true; const b = document.querySelector('.composer textarea'); b.value = 'half typed'; b.dispatchEvent(new Event('input')); document.querySelector('.refresh-btn').click(); })()`);
  await waitFor(page, 'the reload', `window.ready && !window.before`);
});

test('a sign-out that fails says so and leaves you as you were, notifications on; Try again signs out', { skip }, async () => {
  const page = await openChat('#/p/1/t/1', '?desktop');
  const push = `localStorage.getItem('citadel-desktop-push')`;
  await page.eval(`localStorage.setItem('citadel-desktop-push', 'this-pc'), Notification.requestPermission = async () => 'granted', failing = /api.logout/`);
  await page.eval(`import(new URL('core.js', location.href)).then((m) => m.logout())`);
  await waitFor(page, 'the toast', `document.querySelector('.cui-toast:popover-open')?.textContent.includes("sign you out")`);
  assert.equal(await page.eval(texts), 'first', 'the chat is as it was');
  assert.ok(await page.eval(push), 'notifications are back on');
  await page.eval(`failing = null, document.querySelector('.cui-toast-action').click()`);
  await waitFor(page, 'the login', `!!document.getElementById('login-form')`);
  assert.equal(await page.eval(push), null);
});
