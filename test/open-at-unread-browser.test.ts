// Opening a chat with unread puts its New line just under the head bar and keeps it there while what's
// below lays out (#737). When all that was new fitted at the bottom, the chat opened following the bottom,
// so anything that grew just after opening (an image loading, the catch-up's events) pushed the New line up
// out of sight. Citadel's real front end (public/index.html) in headless Chromium (test/browser.ts), with
// fetch answered in the page so nothing reaches a server.
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

// Runs before app.js: a fake server for the API. Twenty messages you've seen, one you haven't (short enough
// to fit at the bottom), and a long one the catch-up (events?after=) brings once the test calls release().
const STUB = `<script>
  window.ready = true;
  let open;
  const held = new Promise((r) => (open = r));
  window.release = () => open();
  const now = Date.now();
  const seenAt = now - 30_000;
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const minion = { id: 101, project_id: 1, kind: 'ticket', number: 7, title: 'A minion', status: 'idle', updated_at: now, created_at: now - 600_000 };
  const said = (id, text, at) => ({ id, ticket_id: 101, kind: 'user_message', data: JSON.stringify({ text, author: 'Josh' }), created_at: at });
  const long = (n) => Array.from({ length: n }, (_, i) => 'Line ' + i + ' of a long message.').join('\\n\\n');
  const seenEvents = Array.from({ length: 20 }, (_, i) => said(i + 1, 'Seen ' + i + '\\n\\n' + long(4), seenAt - 60_000 + i));
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: [minion], seen: { 101: seenAt }, person_notes: {}, pins: [] });
    let m;
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: m[1] === '100' ? coordinator : minion });
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/events$/))) {
      if (m[1] !== '101') return reply(200, url.search.includes('after=') ? [] : { events: [], tasks: [], more: false });
      if (url.search.includes('after=')) return held.then(() => reply(200, Number(url.searchParams.get('after')) < 22 ? [said(22, 'Caught up\\n\\n' + long(40), now - 1000)] : []));
      return reply(200, { events: [...seenEvents, said(21, 'The one you have not seen', now - 2000)], tasks: [], more: false });
    }
    if (/seen$/.test(path)) return reply(200, { seen_at: now });
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

// How far the New line's top sits below the head bar's bottom, in px.
const gap = `(() => {
  const d = document.querySelector('#log > .unread-divider');
  return d ? Math.round(d.getBoundingClientRect().top - document.getElementById('ticket-head').getBoundingClientRect().bottom) : null;
})()`;

for (const [what, size] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 844, touch: true }],
] as const) {
  test(`on ${what}, a chat whose unread fits on screen keeps its New line under the head bar as more lays out below`, { skip }, async () => {
    const page = await browser.page(`${base}#/p/1/t/7`, size);
    await waitFor(page, 'the New line', `document.querySelector('#log > .unread-divider')`);
    await page.eval('release()');
    await waitFor(page, 'the caught-up message', `document.getElementById('log').textContent.includes('Caught up')`);
    await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const px = await page.eval<number>(gap);
    assert.ok(px >= 0 && px <= 16, `the New line is ${px}px below the head bar, not just under it`);
  });
}
