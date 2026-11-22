// Citadel's own front end (public/) in a real browser (headless Chromium, test/browser.ts), loaded as Citadel serves it
// with fetch held so nothing reaches a server (#445).
// - The composer's Card button (thread.js renderCardJump) shows only for a card still waiting on a person. An ultra
//   review's card waits on its review, not on you, running or finished; a loop card waits until someone clicks
//   Continue, and stops at the click, not when the server's event lands.
// - A list row's card badge (sidebar.js threadRow, #575) opens its minion's oldest open card; the rest of the row opens the chat.
// - The Taskmaster's waiting strip (waiting.js, #608) links each of its own open cards and is gone with none.
// - Everyone (#920) draws other Taskmaster sessions with their own state: the Overlord's on its band, each named,
//   and your card held below your Taskmaster's words isn't jumped by another session's.
// - The Codex line under the Claude bar reads a window past its reset as 0%, as Codex's own bar and Settings do.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, normalize } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, launch, type Browser, type Page } from './browser.ts';
import { until } from './wait.ts';

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
  const base = await import('/base.js');
  const { setView } = base;
  window.tmv = () => base.view;
  Object.assign(window, { renderUsage, setCodex });
  const { appendEvent, chatView, renderCardJump } = await import('/thread.js');
  setView({ ...chatView(1, { id: 1, title: 'T' }), kind: 'ticket' });
  let id = 0;
  window.add = (kind, data, ticketId = 1) => appendEvent({ id: ++id, ticket_id: ticketId, kind, data: JSON.stringify(data), created_at: new Date().toISOString() });
  // Your Taskmaster (1) as Everyone, with Alex's (2) and the Overlord (3) drawn into it (#920).
  const { mergedView } = await import('/mine.js');
  window.everyone = () => {
    const taskmasters = [{ id: 1, person_id: 7, person_name: 'Cara' }, { id: 2, person_id: 8, person_name: 'Alex' }, { id: 3, person_id: null, person_name: null }];
    setView({ ...chatView(1, { id: 1, kind: 'coordinator', project_id: 9, status: 'idle' }, mergedView(9, 1, taskmasters, 'everyone')), kind: 'project', projectId: 9, taskmasters });
  };
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
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      return res.writeHead(404).end(); // read first: a 200 already sent can't become a 404, and the import would hang
    }
    res.writeHead(200, { 'content-type': 'text/javascript' }).end(body);
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
  await until('the page to be ready', async () => await page.eval('window.ready'), 2000);
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

test('Everyone draws each Taskmaster session with its own state: the Overlord on its band, named, and your held card stays put', { skip }, async () => {
  const page = await open();
  await page.eval('everyone()');
  await page.eval(`add('question', { id: 'q1', questions: [{ question: 'Tabs or list?', header: 'Pick', options: [{ label: 'Tabs' }, { label: 'List' }] }] })`);
  await page.eval(`add('claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'CI is red on main.' }] } }, 3)`);
  await page.eval(`add('user_message', { author: 'Alex', text: 'start the export minion' }, 2)`);
  const got = await page.eval(`(() => {
    const log = [...document.querySelectorAll('#log > *')];
    const ovl = document.querySelector('#log .ovl');
    const alex = [...document.querySelectorAll('#log .msg.user')].find((m) => m.textContent.includes('export'));
    return {
      order: log.map((n) => n.classList.contains('ovl') ? 'ovl' : n.dataset.session ? 'alex' : 'mine'),
      ovlWho: ovl?.querySelector('.who')?.firstChild?.textContent, ovlSession: ovl?.dataset.session, alexSession: alex?.dataset.session,
      own: [tmv().ticket.id, tmv().part === undefined, tmv().heldCards.length],
    };
  })()`);
  assert.deepEqual(got.order, ['mine', 'ovl', 'alex'], 'in time order: the Overlord\'s words go below your card, not above it');
  assert.equal(got.ovlWho, 'Overlord');
  assert.equal(got.ovlSession, 'Overlord');
  assert.equal(got.alexSession, 'Alex\'s Taskmaster');
  assert.deepEqual(got.own, [1, true, 0], 'your own session\'s state is back in view; the held card let go once another session spoke');
});

test('the Codex line under the Claude bar reads a 5-hour window past its reset as 0%, not its last 99%', { skip }, async () => {
  const page = await open();
  const hourAgo = Math.floor(Date.now() / 1000) - 3600;
  const inADay = Math.floor(Date.now() / 1000) + 86400;
  await page.eval(`renderUsage({ weekly: { utilization: 0.95, resetsAt: Date.now() + 86400000 }, updatedAt: new Date().toISOString() })`);
  await page.eval(`setCodex({ on: true, usage: { primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: ${hourAgo} }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: ${inADay} }, updatedAt: new Date().toISOString() } })`);
  assert.equal(await page.eval(`document.querySelector('.usage.codex')`), null, "no Codex bar in the top-left (Cara, 2026-11-18); Settings → Usage has its windows");
  const line = await page.eval<{ text: string; level: string; title: string; hidden: boolean }>(`(({ textContent: text, dataset, title, hidden }) => ({ text, level: dataset.level, title, hidden }))(document.querySelector('.codex-usage'))`);
  assert.equal(line.hidden, false);
  assert.equal(line.text, 'Codex 40%');
  assert.equal(line.level, '');
  assert.match(line.title, /^5-hour window: 0%\nWeekly: 40%, resets /);
});

test('with several Claude accounts the bar combines them: average weekly, a reset or missing report counts 0%, error only when all are out', { skip }, async () => {
  const page = await open();
  const soon = Date.now() + 3600000, later = Date.now() + 86400000;
  const acc = (n: number, usage: string) => `{ n: ${n}, label: 'Account ${n}', usage: ${usage} }`;
  const wk = (u: number, resetsAt: number, status = 'allowed') => `{ weekly: { utilization: ${u}, resetsAt: ${resetsAt}, status: '${status}' } }`;
  const show = (accounts: string[]) => page.eval(`renderUsage({ weekly: { utilization: 0.2, resetsAt: ${later} }, account: 1, accounts: [${accounts.join(',')}], updatedAt: new Date().toISOString() })`);
  const bar = () => page.eval<{ text: string; level: string; title: string }>(`(({ textContent: text, dataset, title }) => ({ text, level: dataset.level, title }))(document.querySelector('#usage'))`);
  await show([acc(1, wk(0.8, later)), acc(2, wk(0.2, soon))]);
  let b = await bar();
  assert.equal(b.text.replace(/\s+/g, ''), 'Week50%');
  assert.equal(b.level, '');
  assert.match(b.title, /^Weekly usage combined across 2 Claude accounts: 50%, next reset /);
  assert.match(b.title, /▸ Account 1: week 80%/);
  await show([acc(1, wk(0.8, later)), acc(2, 'null')]);
  assert.equal((await bar()).text, 'Week 40%', 'no report counts 0%');
  await show([acc(1, wk(0.8, later)), acc(2, wk(0.9, Date.now() - 1000))]);
  assert.equal((await bar()).text, 'Week 40%', 'a window past its reset counts 0%');
  await show([acc(1, wk(0.95, later)), acc(2, wk(1, later, 'rejected'))]);
  b = await bar();
  assert.equal(b.text, 'Week 98%');
  assert.equal(b.level, 'error');
  await show([acc(1, wk(0.8, later)), acc(2, wk(0.8, later))]);
  assert.equal((await bar()).level, 'warn');
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

test('the Taskmaster\'s waiting strip links each of its open cards, oldest first, and is gone with none', { skip }, async () => {
  const page = await open();
  const got = await page.eval<{ none: boolean; head: string; links: string[][] }>(`(async () => {
    const { waitingStrip } = await import('/waiting.js');
    const strip = waitingStrip({ id: 1, kind: 'coordinator', project_id: 2, open_cards: [
      { minion: null, kind: 'question', what: 'question', label: 'Layout', href: '#/p/2?e=11' },
      { minion: null, kind: 'plan', what: 'plan', label: 'Build 9', href: '#/p/2?e=12' }] });
    document.body.prepend(strip);
    return { none: waitingStrip({ id: 1, kind: 'coordinator', open_cards: [] }) === null, head: strip.querySelector('.waiting-head').textContent,
      links: [...strip.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.textContent]) };
  })()`);
  assert.equal(got.none, true, 'nothing waits, no strip');
  assert.equal(got.head, '2 cards wait on you');
  assert.deepEqual(got.links, [['#/p/2?e=11', 'questionLayout'], ['#/p/2?e=12', 'planBuild 9']]);
  await page.eval(`document.querySelectorAll('.waiting-strip a')[1].click()`);
  assert.equal(await page.eval('location.hash'), '#/p/2?e=12', 'a click opens the chat at that card');
});

// Needs you (inbox.js) around a dismissal (#589; Josh, 2026-11-12: "It shouldnt require a refresh to drop out, dismissed
// minions should never be in your inbox"). One complete minion, #12, waits in the strip; `server` is what the server's
// inbox holds now and `status` how the dismiss or reopen request ends ('hold' keeps it on its way).
async function inboxPage(status: 'ok' | 'fail' | 'hold', closed = false): Promise<Page> {
  const page = await open();
  await page.eval(`(async () => {
    document.body.insertAdjacentHTML('afterbegin', '<span data-scheme-inbox="2"></span><div id="ticket-head"></div><div id="threads"></div>');
    localStorage.setItem('cc-inbox-open', '1');
    const base = await import('/base.js');
  const { setView } = base;
  window.tmv = () => base.view;
    const { inboxStrip, refreshInbox } = await import('/inbox.js');
    const { onTicketUpdate } = await import('/core.js');
    const { renderTicketHead } = await import('/thread-head.js');
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
    window.needsYou = () => ({ rows: document.querySelectorAll('.inbox-row').length, strip: !!document.querySelector('.inbox-strip .inbox-toggle:not(.inbox-empty)'), empty: !!document.querySelector('.inbox-strip .inbox-empty'),
      badge: !document.querySelector('[data-scheme-inbox="2"]').hidden });
  })()`);
  return page;
}
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('dismissing a minion takes it out of Needs you and the badge at once, before the server answers', { skip }, async () => {
  const page = await inboxPage('hold');
  assert.deepEqual(await page.eval('needsYou()'), { rows: 1, strip: true, empty: false, badge: true }, 'waiting on you');
  await page.eval(`document.querySelector('.act-dismiss').click()`);
  assert.deepEqual(await page.eval('needsYou()'), { rows: 0, strip: false, empty: true, badge: false });
});

test('a failed dismissal puts it back in Needs you', { skip }, async () => {
  const page = await inboxPage('fail');
  await page.eval(`document.querySelector('.act-dismiss').click()`);
  await settle(50);
  assert.deepEqual(await page.eval('needsYou()'), { rows: 1, strip: true, empty: false, badge: true });
});

test('another tab drops a minion dismissed elsewhere from Needs you when the stream says so', { skip }, async () => {
  const page = await inboxPage('ok');
  await page.eval(`(server = [], echo('closed'))`);
  await settle(400); // the inbox's refetch waits out a burst
  assert.deepEqual(await page.eval('needsYou()'), { rows: 0, strip: false, empty: true, badge: false });
});

test('reopening a dismissed minion that still waits on you puts it back in Needs you', { skip }, async () => {
  const page = await inboxPage('ok', true);
  assert.deepEqual(await page.eval('needsYou()'), { rows: 0, strip: false, empty: true, badge: false });
  await page.eval(`(server = [{ kind: 'state', ticketId: 900, at: Date.now(), key: 'state:900' }], document.querySelector('.act-reopen').click())`);
  await settle(50);
  await page.eval(`echo('idle')`);
  await settle(400);
  assert.deepEqual(await page.eval('needsYou()'), { rows: 1, strip: true, empty: false, badge: true });
});

// #890: installing moves the open tab into the app window without a reload, so a colour app.js added only when the page
// loaded installed never came, and the controls sat on a white box. The page has them from the start, for the app only.
test('the window controls take the page colour from the first load, and a browser tab gets no theme colour', () => {
  const metas = [...readFileSync(join(pub, 'index.html'), 'utf8').matchAll(/<meta name="theme-color" content="([^"]+)" media="([^"]+)">/g)].map((m) => ({ colour: m[1], media: m[2] }));
  for (const [scheme, colour] of [['light', '#f6f5f2'], ['dark', '#161514']]) {
    const first = metas.find((m) => m.media.includes('window-controls-overlay') && m.media.includes(scheme));
    assert.equal(first?.colour, colour, `the ${scheme} page colour, for the title bar overlay`);
  }
  assert.ok(metas.length && metas.every((m) => /\(display-mode: (standalone|window-controls-overlay)\)/.test(m.media)), 'each names an installed display mode, so tabs stay as they were');
});

test('the installed app shows the title bar hint once: gone for good on close or when the title bar is hidden, never in a tab', { skip }, async () => {
  const page = await open();
  // Headless Chromium has no app window, so the overlay and the display-mode query are stand-ins that fire like the real ones.
  const run = (expr: string) => page.eval(`(async () => {
    const { wcoHint } = await import('/wco-hint.js');
    const fake = (k, v) => Object.assign(new EventTarget(), { [k]: v });
    window.wco ??= fake('visible', false);
    window.installed ??= fake('matches', true);
    window.desktop ??= { value: true };
    window.start = () => wcoHint(wco, installed, () => desktop.value);
    window.hint = () => !!document.querySelector('.wco-hint');
    return ${expr};
  })()`);
  await run('(localStorage.clear(), installed.matches = false, start(), hint())').then((v) => assert.equal(v, false, 'a browser tab gets no hint'));
  assert.equal(await run('(installed.matches = true, installed.dispatchEvent(new Event("change")), hint())'), true, 'installing from the tab shows it without a reload');
  assert.equal(await run('(document.querySelector(".wco-hint button").click(), hint())'), false, 'its ✕ closes it');
  assert.equal(await run('(start(), hint())'), false, 'and it stays closed on the next launch');
  assert.equal(await run('(localStorage.clear(), start(), hint())'), true, 'a fresh profile shows it again');
  assert.equal(await run('(wco.visible = true, wco.dispatchEvent(new Event("geometrychange")), hint())'), false, 'hiding the title bar takes it away');
  assert.equal(await run('(wco.visible = false, start(), hint())'), false, 'and for good, even with the title bar back');
  assert.equal(await run('(localStorage.clear(), wco.visible = true, start(), hint())'), false, 'an app that opens with it hidden needs no hint');
  assert.equal(await run('(wco.visible = false, installed.dispatchEvent(new Event("change")), hint())'), false, 'nor when they show the title bar after');
  // Installed on a phone or tablet (standalone matches there too, and Chrome may expose the overlay): no title bar to hide.
  assert.equal(await run('(localStorage.clear(), desktop.value = false, installed.matches = true, start(), hint())'), false, 'an installed phone app gets no hint');
  assert.equal(await run('(installed.dispatchEvent(new Event("change")), hint())'), false, 'not on a later display-mode change either');
  assert.equal(await run('(desktop.value = true, installed.dispatchEvent(new Event("change")), hint())'), true, 'an installed desktop app with the title bar showing still gets it');
  assert.equal(await run('(document.querySelectorAll(".wco-hint").forEach((n) => n.remove()), localStorage.clear(), installed.matches = false, start(), hint())'), false, 'a desktop browser tab gets none');
});

// #694: in the installed app the window controls sit on the window-controls-overlay theme colour; a see-through
// background (the Taskmaster chat's after #693) once came back from the canvas as #000000, a black strip.
test('the window controls keep the base colour for a see-through background and take an opaque one', { skip }, async () => {
  for (const [dark, baseColour] of [[false, '#f6f5f2'], [true, '#161514']] as const) {
    const page = await browser.page(base, { dark });
    const meta = `document.querySelector('meta[name=theme-color][media*="${dark ? 'dark' : 'light'}"]').content`;
    const tint = (bg: string | null) => page.eval(`(async () => {
      const { tintTitleBar } = await import('/base.js');
      // Headless Chromium can't emulate display-mode, so each meta also matches on its colour scheme alone.
      if (!document.querySelector('meta[name=theme-color]')) {
        for (const [s, c] of [['light', '#f6f5f2'], ['dark', '#161514']]) document.head.insertAdjacentHTML('beforeend', '<meta name="theme-color" content="' + c + '" media="(prefers-color-scheme: ' + s + '), (display-mode: window-controls-overlay) and (prefers-color-scheme: ' + s + ')">');
      }
      // frames.js passes the colour a frame's page reports, its bar's computed background.
      const el = ${bg === null ? 'null' : `document.body.appendChild(Object.assign(document.createElement('div'), { style: 'background: ${bg}' }))`};
      tintTitleBar(el && getComputedStyle(el).backgroundColor);
      return ${meta};
    })()`);
    assert.equal(await tint('transparent'), baseColour, 'a transparent background leaves the base colour, not black');
    assert.equal(await tint('rgba(255, 0, 0, 0.5)'), baseColour, 'a half see-through one does too');
    assert.equal(await tint('rgb(18, 52, 86)'), '#123456', 'an opaque bar colours the controls');
    assert.equal(await tint(null), baseColour, 'no bar puts the base back');
  }
});
