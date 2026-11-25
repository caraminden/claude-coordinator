// Reading a chat isn't interrupted (#1853): Find keeps the match you are on when older history loads (T1), and the
// opened "Show the N individual actions" list and its opened actions stay open across live events (T2).
// Citadel's real front end in headless Chromium (test/browser.ts), with fetch and the stream answered in the page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = `<script>
  window.ready = true;
  const started = Date.now() - 600_000;
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const minion = { id: 101, project_id: 1, kind: 'ticket', number: 7, title: 'A minion', status: 'running', turnStartedAt: started, updated_at: 0, created_at: started };
  let id = 100;
  const ev = (kind, data) => ({ id: ++id, ticket_id: 101, kind, data: JSON.stringify(data), created_at: started + id * 1000 });
  const msg = (text) => ev('user_message', { author: 'Cara', text });
  // Older page first (ids lower), then the newest page: one needle in the older part, two in the newer.
  let nid = 0;
  const older = [msg('OLD needle zero'), ...Array.from({ length: 5 }, () => msg('old filler')), ];
  for (const e of older) e.id = ++nid;
  const events = [msg('NEW needle one'), msg('filler'), msg('NEW needle two'), ev('claude', { type: 'system', subtype: 'init', model: 'opus' })];
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: [minion], seen: {}, person_notes: {}, pins: [] });
    if (path === 'api/projects/1/recap') return reply(200, { since: null, turns: {} });
    let m;
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: m[1] === '100' ? coordinator : minion });
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/events$/))) {
      if (url.search.includes('after=')) return reply(200, []);
      if (url.search.includes('before=')) { window.olderLoaded = true; return reply(200, { events: older, tasks: [], more: false }); }
      return reply(200, { events: m[1] === '101' ? events : [], tasks: [], more: true });
    }
    if (/search$/.test(path)) return reply(200, []);
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    return reply(200, []);
  };
  let stream;
  window.EventSource = class { constructor() { stream = this; setTimeout(() => this.onopen?.()); } close() {} };
  const tool = (n) => ev('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu' + n, name: 'Bash', input: { command: 'echo ' + n } }] } });
  window.pushTool = (n) => stream.onmessage({ data: JSON.stringify({ type: 'event', event: tool(n) }) });
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

const frame = (page: any) => page.eval(`new Promise((r) => requestAnimationFrame(() => setTimeout(r, 80)))`);

test('Find keeps the match you are on when older history loads, and goes to the newest on typing', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/t/7`, { width: 1280, height: 800 });
  await waitFor(page, 'the chat to draw', `document.getElementById('log').textContent.includes('NEW needle two')`);
  await page.eval(`(() => { const i = document.querySelector('input.chat-find'); i.value = 'needle'; i.dispatchEvent(new Event('input')); })()`);
  await waitFor(page, 'two matches', `document.querySelector('.find-count')?.textContent.startsWith('2/2')`);
  await page.eval(`document.querySelector('input.chat-find').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))`);
  assert.equal(await page.eval(`document.querySelector('.find-count').textContent`), '1/2');
  // Load earlier (a click): the older match joins, the one you were on stays current.
  await page.eval(`document.querySelector('#log .load-earlier button').click()`);
  await waitFor(page, 'older history', `window.olderLoaded && document.getElementById('log').textContent.includes('OLD needle zero')`);
  await waitFor(page, 'find again', `document.querySelector('.find-count')?.textContent.endsWith('/3')`);
  assert.equal(await page.eval(`document.querySelector('.find-count').textContent`), '2/3');
  assert.match(await page.eval(`document.querySelector('#log mark.current')?.closest('.msg')?.textContent`), /NEW needle one/);
  // Typing again goes to the newest.
  await page.eval(`(() => { const i = document.querySelector('input.chat-find'); i.value = 'needl'; i.dispatchEvent(new Event('input')); })()`);
  await waitFor(page, 'newest', `document.querySelector('.find-count')?.textContent === '3/3'`);
});

test('the opened list of individual actions and an opened action stay open when events arrive', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/t/7`, { width: 1280, height: 800 });
  await waitFor(page, 'the chat to draw', `document.getElementById('log').textContent.includes('NEW needle two')`);
  await page.eval(`pushTool(1); pushTool(2)`);
  await frame(page);
  await page.eval(`document.querySelector('button.typing').click()`);
  await waitFor(page, 'the readout', `document.querySelector('.progress-detail details.cmds')`);
  await page.eval(`document.querySelector('.progress-detail details.cmds').open = true`);
  await waitFor(page, 'the actions', `document.querySelector('.progress-detail .actions details.act')`);
  await page.eval(`document.querySelector('.progress-detail .actions details.act').open = true`);
  await waitFor(page, 'its body', `document.querySelector('.progress-detail .actions details.act .body')`);
  await page.eval(`pushTool(3)`);
  await frame(page);
  await frame(page);
  assert.equal(await page.eval(`document.querySelector('.progress-detail details.cmds')?.open`), true, 'the actions list stays open');
  assert.equal(await page.eval(`document.querySelectorAll('.progress-detail .actions details.act').length`), 3);
  assert.equal(await page.eval(`document.querySelector('.progress-detail .actions details.act')?.open`), true, 'the opened action stays open');
});
