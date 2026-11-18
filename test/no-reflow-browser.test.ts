// Nothing on screen moves sideways unless the person did something (#861; Cara, 2026-11-16: "UI reflowing
// without a user input should be avoided, especially if it moves big pieces of the UI around"). The scheme
// page and a minion's chat sit while the stream brings news: the chat grows past the window's height (a
// scrollbar comes), another scheme starts working and gets cards waiting (its pill in the overview grows).
// The big panes keep their edges and the layout shifts stay near zero. Citadel's real front end
// (public/index.html) in headless Chromium (test/browser.ts, real 15px scrollbars), with fetch and the
// stream answered in the page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

// Runs before app.js: a fake server with three schemes, one with the longest name in the overview and idle, and
// a short chat each for the Taskmaster and a minion. push(ticketId, n) sends n lines live; busy() makes the
// long-named scheme start working with cards waiting, as its next counts fetch says.
const STUB = `<script>
  window.ready = true;
  const now = Date.now();
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'running', turnStartedAt: now - 60_000, updated_at: now, created_at: now - 600_000 };
  const minion = { id: 101, project_id: 1, kind: 'ticket', number: 7, title: 'A minion', status: 'running', turnStartedAt: now - 60_000, updated_at: now, created_at: now - 600_000 };
  const schemes = [
    { id: 1, name: 'Alpha', inbox: 0, icon: null },
    { id: 2, name: 'Theory of Crafting Lore', inbox: 0, icon: null },
    { id: 3, name: 'Beta', inbox: 1, icon: null },
  ];
  let id = 0;
  const ev = (ticket, kind, data) => ({ id: ++id, ticket_id: ticket, kind, data: JSON.stringify(data), created_at: now - 50_000 + id * 100 });
  const line = (ticket, text) => ev(ticket, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text }] } });
  const start = (ticket) => [ev(ticket, 'user_message', { author: 'Cara', text: 'Build the thing.' }), ev(ticket, 'claude', { type: 'system', subtype: 'init', model: 'opus' }), line(ticket, 'Reading the code.')];
  const events = { 100: start(100), 101: start(101) };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, schemes);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: [minion], seen: {}, person_notes: {}, pins: [] });
    if (path === 'api/projects/1/recap') return reply(200, { since: null, turns: {} });
    let m;
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: m[1] === '100' ? coordinator : minion });
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/events$/))) {
      if (url.search.includes('after=')) return reply(200, []);
      return reply(200, { events: events[m[1]] ?? [], tasks: [], more: false });
    }
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    return reply(200, []);
  };
  let stream;
  window.EventSource = class { constructor() { stream = this; setTimeout(() => this.onopen?.()); } close() {} };
  const send = (msg) => stream.onmessage({ data: JSON.stringify(msg) });
  window.push = (ticket, n) => { for (let i = 0; i < n; i++) send({ type: 'event', event: line(ticket, 'Step ' + i + ': another line of the turn, long enough to take a row of its own in the chat.') }); };
  window.busy = () => {
    Object.assign(schemes[1], { running: true, working: 12, inbox: 23, fresh: true });
    send({ type: 'ticket', ticket: { id: 900, project_id: 2, kind: 'ticket', number: 1, title: 'Elsewhere', status: 'running', updated_at: Date.now() } });
  };
  // Every layout shift the page makes, from here on. hadRecentInput is not asked (#963): the test sends no input, yet
  // a phone-sized page calls every shift of its first half second one, so the check passed only by starting inside
  // that window and failed whenever the page was older. The working line under the chat is left out: it is the
  // chat's last row, and lines arriving above it carry it down the page as they do each other.
  window.shifts = [];
  const working = (e) => e.sources.length > 0 && e.sources.every((s) => s.node?.closest?.('#log ~ .typing'));
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (!working(e)) window.shifts.push(e.value); }).observe({ type: 'layout-shift' });
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

// The left and right edges of the big pieces: the overview, the minions list, the chat column and its log and composer.
const PANES = ['.shelf', '.sidebar', '.split > section', '#log', '.composer'];
const EDGES = `Object.fromEntries(${JSON.stringify(PANES)}.map((s) => {
  const r = document.querySelector(s)?.getBoundingClientRect();
  return [s, r && r.width ? [Math.round(r.left), Math.round(r.right)] : null];
}))`;
const frames = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`;

for (const [what, size] of [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844, touch: true }]] as const) {
  for (const [view, route, ticket] of [['the Taskmaster chat', '#/p/1', 100], ["a minion's chat", '#/p/1/t/7', 101]] as const) {
    test(`on ${what}, ${view} keeps its panes still while live news arrives with nobody touching it`, { skip }, async () => {
      const page = await browser.page(`${base}${route}`, size);
      await waitFor(page, 'the chat to draw', `document.getElementById('log')?.textContent.includes('Reading the code')`);
      await waitFor(page, 'the scheme pills', `document.querySelector('[data-scheme-inbox="3"]:not([hidden])')`);
      await page.eval(frames);
      const before = await page.eval<Record<string, number[] | null>>(EDGES);
      assert.ok(before['.split > section'], 'the chat column is on screen');
      await page.eval('window.shifts.length = 0');

      // The chat grows past the window's height, and another scheme starts working with cards waiting.
      await page.eval(`push(${ticket}, 40)`);
      await waitFor(page, 'the last line', `document.getElementById('log').textContent.includes('Step 39')`);
      await page.eval('busy()');
      await waitFor(page, 'the other scheme to start working', `document.querySelector('[data-scheme-inbox="2"] .busy')`);
      await page.eval(frames);

      assert.ok(await page.eval(`document.documentElement.scrollHeight > innerHeight`), 'the chat grew past the window');
      assert.deepEqual(await page.eval(EDGES), before, 'no pane moved sideways or changed width');
      const cls = await page.eval<number>('window.shifts.reduce((a, b) => a + b, 0)');
      assert.ok(cls < 0.01, `layout shift without input was ${cls.toFixed(4)}, over 0.01`);
    });
  }
}
