// Citadel's own front end (public/) in a real browser (headless Chromium, test/browser.ts), loaded as Citadel serves it
// with fetch held so nothing reaches a server (#445).
// - The composer's Card button (thread.js renderCardJump) shows only for a card still waiting on a person. An ultra
//   review's card waits on its review, not on you, running or finished; a loop card waits until someone clicks
//   Continue, and stops at the click, not when the server's event lands.
// - A list row's card badge (sidebar.js threadRow, #575) opens its minion's oldest open card; the rest of the row opens the chat.
// - The Codex line under the Claude bar reads a window past its reset as 0%, as Codex's own bar and Settings do.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, normalize } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, type Browser, type Page } from './browser.ts';

const bin = chromium();
const skip = !bin && 'no headless Chromium in ~/.cache/ms-playwright';
const pub = join(import.meta.dirname, '..', 'public');

// A chat log above a composer with its Card button; the spacer lets the cards scroll out of sight above.
const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body><div class="meters"><div id="usage" class="usage" hidden><span class="label"></span><span class="track"><span class="fill"></span></span></div></div>
<div><div id="log"></div><div id="spacer" style="height:3000px"></div><div class="composer"><button class="to-card" hidden><span>↑</span> Card</button></div></div>
<script type="module">
  window.fetch = () => new Promise(() => {}); // every request stays on its way
  const { renderUsage, setCodex } = await import('/core.js');
  const { setView } = await import('/base.js');
  Object.assign(window, { renderUsage, setCodex });
  const { appendEvent, chatView, renderCardJump } = await import('/thread.js');
  setView({ ...chatView(1, { id: 1, title: 'T' }), kind: 'ticket' });
  let id = 0;
  window.add = (kind, data) => appendEvent({ id: ++id, ticket_id: 1, kind, data: JSON.stringify(data), created_at: new Date().toISOString() });
  // Scroll the cards out of sight and ask the button: does it show?
  window.showsCard = () => { scrollTo(0, document.body.scrollHeight); renderCardJump(); return !document.querySelector('.to-card').hidden; };
  window.ready = true;
</script>`;

let server: Server;
let browser: Browser;
let base = '';

before(async () => {
  if (skip) return;
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    const file = normalize(join(pub, path));
    if (!file.startsWith(pub) || !file.endsWith('.js')) return res.writeHead(404).end();
    try {
      res.writeHead(200, { 'content-type': 'text/javascript' }).end(readFileSync(file));
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await launch(bin!);
});

after(async () => {
  await browser?.close();
  await new Promise((r) => (server ? server.close(r) : r(null)));
});

async function open(): Promise<Page> {
  const page = await browser.page(base);
  for (let i = 0; i < 100 && !(await page.eval('window.ready')); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(await page.eval('window.ready'), true, 'the chat code loaded');
  return page;
}

test('a question card out of sight shows the Card button (the check works)', { skip }, async () => {
  const page = await open();
  assert.equal(await page.eval('showsCard()'), false, 'no cards, no button');
  await page.eval(`add('question', { id: 'q1', questions: [{ question: 'Tabs or list?', header: 'Pick', options: [{ label: 'Tabs' }, { label: 'List' }] }] })`);
  assert.equal(await page.eval('showsCard()'), true);
});

test('an ultra review card never shows the Card button, running or finished', { skip }, async () => {
  const page = await open();
  await page.eval(`add('ultrareview', { id: 'u1', by: 'Josh', mode: 'area', paths: ['src'], size: { files: 1, lines: 2 } })`);
  assert.equal(await page.eval('showsCard()'), false, 'running: it waits on the review, not on you');
  await page.eval(`add('ultrareview_result', { id: 'u1', ok: true, text: 'No findings.' })`);
  assert.equal(await page.eval('showsCard()'), false, 'finished');
});

test('a loop card shows the Card button until Continue is clicked', { skip }, async () => {
  const page = await open();
  await page.eval(`add('loop_paused', { minion: 5, text: 'held a message' })`);
  assert.equal(await page.eval('showsCard()'), true, 'it waits on a person');
  await page.eval(`document.querySelector('.lcard button').click()`);
  assert.equal(await page.eval('showsCard()'), false, 'Continue clicked: the request is still on its way');
  await page.eval(`add('loop_continued', { minion: 5, by: 'Josh' })`);
  assert.equal(await page.eval(`document.querySelector('.lcard [role=status]').textContent`), 'Continued by Josh', 'the server\'s event still names who');
  assert.equal(await page.eval('showsCard()'), false);
});

test('the Codex line under the Claude bar reads a 5-hour window past its reset as 0%, not its last 99%', { skip }, async () => {
  const page = await open();
  const hourAgo = Math.floor(Date.now() / 1000) - 3600;
  const inADay = Math.floor(Date.now() / 1000) + 86400;
  await page.eval(`renderUsage({ weekly: { utilization: 0.95, resetsAt: Date.now() + 86400000 }, updatedAt: new Date().toISOString() })`);
  await page.eval(`setCodex({ on: true, usage: { primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: ${hourAgo} }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: ${inADay} }, updatedAt: new Date().toISOString() } })`);
  assert.equal(await page.eval(`document.querySelector('.usage.codex').hidden`), true, "Codex's own bar hides: nothing above 75%");
  const line = await page.eval<{ text: string; level: string; title: string; hidden: boolean }>(`(({ textContent: text, dataset, title, hidden }) => ({ text, level: dataset.level, title, hidden }))(document.querySelector('.codex-usage'))`);
  assert.equal(line.hidden, false);
  assert.equal(line.text, 'Codex 40%');
  assert.equal(line.level, '');
  assert.match(line.title, /^5-hour window: 0%\nWeekly: 40%, resets /);
});

test('a row\'s card badge opens the oldest open card, the rest of the row the chat, and a row without cards has none', { skip }, async () => {
  const page = await open();
  await page.eval(`(async () => {
    const { threadRow } = await import('/sidebar.js');
    const row = (id, open_cards) => threadRow({ id, number: id, project_id: 2, kind: 'ticket', title: 'T' + id, status: 'idle', updated_at: Date.now(), open_cards });
    document.body.prepend(row(7, [{ kind: 'question', what: 'question', label: 'A', href: '#/p/2/t/7?e=11' }, { kind: 'question', what: 'question', label: 'B', href: '#/p/2/t/7?e=12' }]), row(8, []));
  })()`);
  assert.equal(await page.eval(`document.querySelector('[data-id="7"] .card-badge').textContent`), '2 questions');
  assert.equal(await page.eval(`!!document.querySelector('[data-id="8"] .card-badge')`), false);
  await page.eval(`document.querySelector('[data-id="7"] .card-badge').click()`);
  assert.equal(await page.eval('location.hash'), '#/p/2/t/7?e=11', 'the badge opens the oldest card');
  await page.eval(`document.querySelector('[data-id="7"] .name').click()`);
  assert.equal(await page.eval('location.hash'), '#/p/2/t/7', 'the rest of the row opens the chat');
});

// Needs you (inbox.js) around a dismissal (#589; Josh, 2026-11-12: "It shouldnt require a refresh to drop out, dismissed
// minions should never be in your inbox"). One complete minion, #12, waits in the strip; `server` is what the server's
// inbox holds now and `status` how the dismiss or reopen request ends ('hold' keeps it on its way).
async function inboxPage(status: 'ok' | 'fail' | 'hold', closed = false): Promise<Page> {
  const page = await open();
  await page.eval(`(async () => {
    document.body.insertAdjacentHTML('afterbegin', '<span data-scheme-inbox="2"></span><div id="ticket-head"></div><div id="threads"></div>');
    localStorage.setItem('cc-inbox-open', '1');
    const { setView } = await import('/base.js');
    const { inboxStrip, refreshInbox } = await import('/inbox.js');
    const { onTicketUpdate } = await import('/core.js');
    const { renderTicketHead } = await import('/thread.js');
    const minion = { id: 900, number: 12, project_id: 2, kind: 'ticket', title: 'Report', status: ${closed ? "'closed'" : "'idle'"}, state: 'complete', replies: [], updated_at: Date.now() };
    window.server = ${closed ? '[]' : "[{ kind: 'state', ticketId: 900, at: Date.now(), key: 'state:900' }]"};
    window.fetch = async (path, opts) => {
      const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });
      if (path === 'api/projects/2/inbox') return reply({ items: window.server });
      if (path === 'api/tickets/900/status') return ${status === 'ok' ? 'reply({})' : status === 'fail' ? "reply({ error: 'nope' }, false)" : 'new Promise(() => {})'};
      return reply({});
    };
    setView({ kind: 'project', projectId: 2, id: 900, ticket: minion, project: { id: 2 }, projects: [{ id: 2 }],
      coordinator: { id: 1, kind: 'coordinator', project_id: 2, status: 'idle' }, tickets: new Map([[900, minion]]) });
    document.body.prepend(inboxStrip());
    await refreshInbox();
    renderTicketHead();
    // What the stream says once the server has it, as another tab hears it too.
    window.echo = (status) => onTicketUpdate({ ...minion, status });
    window.needsYou = () => ({ rows: document.querySelectorAll('.inbox-row').length, strip: !document.querySelector('.inbox-strip').hidden,
      badge: !document.querySelector('[data-scheme-inbox="2"]').hidden });
  })()`);
  return page;
}
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('dismissing a minion takes it out of Needs you and the badge at once, before the server answers', { skip }, async () => {
  const page = await inboxPage('hold');
  assert.deepEqual(await page.eval('needsYou()'), { rows: 1, strip: true, badge: true }, 'waiting on you');
  await page.eval(`document.querySelector('.act-dismiss').click()`);
  assert.deepEqual(await page.eval('needsYou()'), { rows: 0, strip: false, badge: false });
});

test('a failed dismissal puts it back in Needs you', { skip }, async () => {
  const page = await inboxPage('fail');
  await page.eval(`document.querySelector('.act-dismiss').click()`);
  await settle(50);
  assert.deepEqual(await page.eval('needsYou()'), { rows: 1, strip: true, badge: true });
});

test('another tab drops a minion dismissed elsewhere from Needs you when the stream says so', { skip }, async () => {
  const page = await inboxPage('ok');
  await page.eval(`(server = [], echo('closed'))`);
  await settle(400); // the inbox's refetch waits out a burst
  assert.deepEqual(await page.eval('needsYou()'), { rows: 0, strip: false, badge: false });
});

test('reopening a dismissed minion that still waits on you puts it back in Needs you', { skip }, async () => {
  const page = await inboxPage('ok', true);
  assert.deepEqual(await page.eval('needsYou()'), { rows: 0, strip: false, badge: false });
  await page.eval(`(server = [{ kind: 'state', ticketId: 900, at: Date.now(), key: 'state:900' }], document.querySelector('.act-reopen').click())`);
  await settle(50);
  await page.eval(`echo('idle')`);
  await settle(400);
  assert.deepEqual(await page.eval('needsYou()'), { rows: 1, strip: true, badge: true });
});
