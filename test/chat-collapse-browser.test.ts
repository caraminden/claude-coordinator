// A running minion's older milestone lines collapse into a boxed "N updates" row as each newer line
// arrives; only the newest stays out (#578, Cara's pick 2026-11-11: "Only the newest line", "Boxed,
// like Taskmaster rows"). A jump link to a collapsed line opens its row. Citadel's real front end
// (public/index.html) in headless Chromium (test/browser.ts), with fetch and the stream answered in the page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';
import { pageStub } from './page-stub.ts';

const bin = chromium();
const skip = !bin && skipMessage;

// Runs before app.js: a fake server with one running minion. Its turn so far: a line, work, a line, work,
// a Taskmaster message steered in, a line, work, and the newest line. push(n) sends line n live.
const STUB = pageStub(
  `
  window.ready = true;
  const started = now - 600_000;
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const minion = { id: 101, project_id: 1, kind: 'ticket', number: 7, title: 'A minion', status: 'running', turnStartedAt: started, updated_at: 0, created_at: started };
  let id = 0;
  const ev = (kind, data) => ({ id: ++id, ticket_id: 101, kind, data: JSON.stringify(data), created_at: started + id * 1000 });
  const line = (text) => ev('claude', { type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', id: 'tu' + id, name: 'Bash', input: { command: 'true' } }] } });
  const events = [
    ev('user_message', { author: 'Cara', text: 'Build the thing.' }),
    ev('claude', { type: 'system', subtype: 'init', model: 'opus' }),
    line('Line one: reading the code.'),
    line('Line two: writing the fix.'),
    ev('user_message', { author: 'coordinator', text: 'One more piece for your branch.' }),
    line('Line three: tests pass.'),
    line('Line four: landing after #576.'),
  ];
  function route(path, url) {
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: [minion], seen: {}, person_notes: {}, pins: [] });
    if (path === 'api/projects/1/recap') return reply(200, { since: null, turns: {} });
    let m;
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: m[1] === '100' ? coordinator : minion });
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/events$/))) {
      if (url.search.includes('after=')) return reply(200, []);
      return reply(200, { events: m[1] === '101' ? events : [], tasks: [], more: false });
    }
  }
  window.push = (text) => window.es.onmessage({ data: JSON.stringify({ type: 'event', event: line(text) }) });
`,
  { open: true },
);

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

// The log as one string per item: a collapsed row as "[N updates: preview]", a line as its text.
const LOG = `[...document.querySelectorAll('#log > *')].map((el) => el.matches('.narration')
  ? '[' + el.querySelector('summary .name').textContent + ': ' + el.querySelector('summary .preview').textContent + ']'
  : el.matches('.msg:not(.user)') ? el.textContent.replace(/^.*?(Line)/, '$1') : el.matches('.msg.user') ? 'message' : null).filter(Boolean)`;

test('only the newest line of a running turn stays out; the ones above collapse as newer lines arrive', { skip }, async () => {
  const page = await browser.page(`${base}#/p/1/t/7`, { width: 1280, height: 800 });
  await waitFor(page, 'the chat to draw', `document.getElementById('log').textContent.includes('Line four')`);
  assert.deepEqual(await page.eval(LOG), ['message', '[2 updates: Line two: writing the fix.]', 'message', '[1 update: Line three: tests pass.]', 'Line four: landing after #576.']);
  // A newer line: the one above it joins its stretch's row, not a new one.
  await page.eval(`push('Line five: live.')`);
  await waitFor(page, 'the new line', `document.getElementById('log').textContent.includes('Line five')`);
  assert.deepEqual(await page.eval(LOG), ['message', '[2 updates: Line two: writing the fix.]', 'message', '[2 updates: Line four: landing after #576.]', 'Line five: live.']);
});

test('a jump link to a collapsed line opens its row and flashes the line', { skip }, async () => {
  // Event 3 is "Line one", collapsed into the first row.
  const page = await browser.page(`${base}#/p/1/t/7?e=3`, { width: 1280, height: 800 });
  await waitFor(page, 'the jump', `document.querySelector('#log .jumped')`);
  assert.equal(await page.eval(`document.querySelector('#log .jumped').textContent.trim()`), 'Line one: reading the code.');
  assert.equal(await page.eval(`document.querySelector('#log .jumped').closest('details').open`), true);
});
