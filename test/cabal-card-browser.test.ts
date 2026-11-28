// A cabal's card in the minions list holds still (#2197): the list redraws on every bit of news, so a building
// member's segment rejoins the shared pulse instead of starting it over, and a card whose open state shows nothing
// more than its shut one is the same height either way. Citadel's real front end in headless Chromium
// (test/browser.ts), with fetch and the stream answered in the page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { type App, type Browser, chromium, launch, serveApp, skipMessage, waitFor } from './browser.ts';
import { pageStub } from './page-stub.ts';

const bin = chromium();
const skip = !bin && skipMessage;
type Card = { open: boolean; rows: number; preview: boolean; height: number };

// Build 10's cabal with a Preview link: its Overseer is its only open minion in the list (one member merged, one
// building with no row here), and it is the header, not a row (#2277), so the card lists no rows open or shut.
const STUB = pageStub(
  `
  window.ready = true;
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const lead = { id: 101, project_id: 1, kind: 'ticket', number: 7, title: 'Build 10: one kind of machine', status: location.search === '?works' ? 'running' : 'idle', build: 10, updated_at: 0, created_at: 0 };
  const other = { id: 102, project_id: 1, kind: 'ticket', number: 8, title: 'Another minion', status: 'idle', type: 'feature', updated_at: 0, created_at: 0 };
  const member = (label, state, word) => ({ id: null, number: null, label, title: label + ' work', state, word });
  const cabals = [{ lead: 101, number: 7, title: lead.title, overseer: "Build 10's Overseer", name: 'Plot 10', build: 10, members: [member('H1', 'merged', 'merged'), member('H2', 'running', 'building')], finished: 1, done: 'merged', next: 0, spend: 12 }];
  cabals[0].members.forEach((m, i) => { m.id = 200 + i; m.number = 20 + i; });
  if (location.search === '?bare') cabals[0].members.shift(); // no dismissed member: open shows nothing more than shut
  if (location.search === '?waits') cabals[0].members.push({ id: null, number: null, label: 'H3', title: 'Not yet', state: 'roster', word: 'next up' });
  // ?goal: a Plot with no branch; ?clean: a numbered Plot whose Overseer carries no prefix (#2282).
  if (location.search === '?goal') { delete cabals[0].build; lead.build = null; lead.title = 'Build 3 · Goal work'; cabals[0].title = lead.title; }
  if (location.search === '?clean') { lead.title = 'One runner pool'; cabals[0].title = lead.title; }
  // ?note: the Overseer's own status note follows the state word (#2282).
  if (location.search === '?note') lead.note = 'P3 #2275 building; ships switched off after P5';
  // ?mix: members in every state, roster order scrambled; B1 and B2 both have an open blocking ask, B1's turn is running (#2288).
  if (location.search === '?mix') {
    const mix = [member('R', 'roster', 'next up'), member('B1', 'blocked', 'blocked'), member('M', 'merged', 'merged'), member('RN', 'running', 'building'), member('B2', 'blocked', 'blocked'), member('S', 'sealed', 'sealed')];
    mix.forEach((m, i) => { m.id = 300 + i; m.number = 30 + i; });
    cabals[0].members = mix;
  }
  // ?leadcard: the Overseer has a question of its own.
  if (location.search === '?leadcard') lead.open_cards = [{ minion: 101, kind: 'question', what: 'question', label: 'Q', href: '#/p/1/t/7?e=9' }];
  window.stubCabals = cabals;
  const row = (id, status) => ({ id, project_id: 1, kind: 'ticket', number: id - 270, title: 'm' + id, status, build: 10, updated_at: 0, created_at: 0 });
  const mixRows = [row(301, 'running'), row(303, 'running'), row(304, 'idle')];
  // ?waits: a member with a question card waiting on people (#2277).
  const waiter = { id: 201, project_id: 1, kind: 'ticket', number: 21, title: 'H2 work', status: 'idle', build: 10, updated_at: 0, created_at: 0, open_cards: [{ minion: 201, kind: 'question', what: 'question', label: 'Q', href: '#/p/1/t/21?e=5' }] };
  function route(path, url) {
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: location.search === '?waits' ? [lead, other, waiter] : location.search === '?mix' ? [lead, other, ...mixRows] : [lead, other], seen: {}, person_notes: {}, pins: [], cabals: location.search === '?late' && !window.formed ? [] : cabals, builds: [{ build: 10, merged: 1, open: 1, behind: 42 }], build_previews: true });
    // The Overseer's chat strip (#2303): the board in roster order, not started first and finished last.
    if (path === 'api/tickets/101/cabal') {
      const bm = (label, state) => ({ row: 1, label, title: label, number: null, project_id: 1, scheme: null, open: true, lane: '', role: '', state, word: state, after: null, note: '', note_at: null, spend: 0, risk: null, claims: [], files: [], doubled: [] });
      return reply(200, { lead: 101, board: { lead: { id: 101, number: 7, title: lead.title, spend: 0, project_id: 1, open: true }, name: 'Plot 10', kind: 'build', build: 10, members: [bm('R', 'roster'), bm('B', 'blocked'), bm('M1', 'merged'), bm('S', 'sealed'), bm('RN', 'running'), bm('M2', 'merged')], asks: [], log: [], red: null, counts: { members: 6, started: 5, merged: 2, open: 2, running: 1, spend: 0 } } });
    }
    if (path === 'api/projects/1/recap') return reply(200, { since: null, turns: {} });
    let m;
    if ((m = path.match(/^api\\/tickets\\/(\\d+)$/))) return reply(200, { ticket: m[1] === '100' ? coordinator : lead });
    if ((m = path.match(/^api\\/tickets\\/(\\d+)\\/events$/))) return reply(200, url.search.includes('after=') ? [] : { events: [], tasks: [], more: false });
  }
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

// The working Overseer's dot in the card's header pulses too (#2277's layout), and is held to the same (#2280).
for (const [what, dot] of [
  ["a building member's segment", '.cabal-meter i[data-s=running]'],
  ["the working Overseer's dot", '.cabal-state[data-s=running] i'],
]) {
  test(`a redraw of the list leaves ${what} mid-pulse, not back at its start`, { skip }, async () => {
    const page = await browser.page(`${base}?works#/p/1`, { width: 1280, height: 800 });
    await waitFor(page, 'the card to draw', `document.querySelector('${dot}')`);
    // Redraw away from the turn's start (the shared clock: 1.6 s a turn). How far into its turn the new pulse began
    // is its place now less its own running time, so a late frame moves neither: in step, it began where the clock was at
    // the redraw; started over, it began at 0.
    const [began, from, to] = await page.eval<number[]>(`(async () => {
      const { renderSidebar } = await import('./sidebar.js');
      while (Math.abs((Date.now() % 1600) - 800) > 300) await new Promise(requestAnimationFrame);
      const from = Date.now() % 1600;
      renderSidebar();
      const to = Date.now() % 1600;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const [pulse] = document.querySelector('${dot}').getAnimations();
      const began = (((pulse.effect.getComputedTiming().progress * 1600 - pulse.currentTime) % 1600) + 1600) % 1600;
      return [began, from, to];
    })()`);
    assert.ok(began >= from - 2 && began <= to + 2, `the pulse began where the clock was at the redraw (${Math.round(began)} ms into its turn; the clock was at ${from} to ${to})`);
  });
}

// Cara, 2026-11-28: "these 2 views of the Plot status are backwards, both should have the green on the left".
test("the Overseer's chat strip fills finished, then at work, then not started (#2303)", { skip }, async () => {
  const page = await browser.page(`${base}#/p/1/t/7`, { width: 1280, height: 800 });
  await waitFor(page, 'the strip to draw', `document.querySelectorAll('#chat-cabal .cabal-meter i').length === 6`);
  assert.deepEqual(await page.eval(`[...document.querySelectorAll('#chat-cabal .cabal-meter i')].map((i) => i.dataset.s)`), ['merged', 'merged', 'blocked', 'running', 'roster', 'sealed']);
});

test('opening a card that has no member rows to show moves nothing', { skip }, async () => {
  const page = await browser.page(`${base}?bare#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the card to draw', `document.querySelector('.cabal-card .cabal-lead')`);
  const measure = `(() => { const c = document.querySelector('.cabal-card'); return { open: c.hasAttribute('data-open'), rows: c.querySelectorAll('.thread-row').length, preview: !!c.querySelector('.cabal-build a'), height: c.getBoundingClientRect().height }; })()`;
  const shut = await page.eval<Card>(measure);
  await page.eval(`document.querySelector('.cabal-toggle').click()`);
  const open = await page.eval<Card>(measure);
  assert.deepEqual([shut.open, open.open, shut.rows, open.rows, shut.preview], [false, true, 0, 0, true]);
  assert.equal(open.height, shut.height, 'the same rows at the same height, open or shut');
  // The row under the Preview link starts inside the link's box: the link stays on top, so its whole height takes the tap.
  const hit = `(() => { const a = document.querySelector('.cabal-build a'); const r = a.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.bottom - 2) === a; })()`;
  assert.equal(await page.eval(hit), true, 'open: the bottom of the Preview link is the link');
  await page.eval(`document.querySelector('.cabal-toggle').click()`);
  assert.equal(await page.eval(hit), true, 'shut: the bottom of the Preview link is the link');
});

// #2240: a cabal formed while the page was away (asleep, or its stream down over a restart) had no card until the list
// next changed: the reconnect's resync took the builds from the answer and left the cabals.
test('a resync brings the card of a cabal formed while the stream was down', { skip }, async () => {
  const page = await browser.page(`${base}?late#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the plain build group to draw', `document.querySelector('.g-build .thread-row') && !document.querySelector('.cabal-card')`);
  await page.eval(`(async () => { window.formed = true; await (await import('./resync.js')).resync(); })()`);
  assert.equal(await page.eval(`!!document.querySelector('.cabal-card') && !document.querySelector('.g-build')`), true, "the build's section is its cabal's card");
});

// The answer was read before the stream's news of the cabal, and lands after it: the news is the newer of the two.
test("a resync's answer doesn't take back a card the stream brought meanwhile", { skip }, async () => {
  const page = await browser.page(`${base}?late#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the plain build group to draw', `document.querySelector('.g-build .thread-row') && !document.querySelector('.cabal-card')`);
  await page.eval(`(async () => {
    const asked = (await import('./resync.js')).resync();
    window.es.onmessage({ data: JSON.stringify({ type: 'cabals', projectId: 1, cabals: window.stubCabals }) });
    await asked;
  })()`);
  await waitFor(page, 'the list to redraw', `document.querySelector('.cabal-card') || document.querySelector('.g-build .thread-row')`);
  assert.equal(await page.eval(`!!document.querySelector('.cabal-card') && !document.querySelector('.g-build')`), true, 'the card the stream brought stays');
});

// Cara, 2026-11-27: "the special overseer UI went away". The quick chat switch rebuilt the view without the Plots,
// so the card was gone until the server next sent them.
test("a chat click in the scheme keeps the Plot's card (#2274)", { skip }, async () => {
  const page = await browser.page(`${base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the card to draw', `document.querySelector('.cabal-card')`);
  await page.eval(`location.hash = '#/p/1/t/8'`);
  await waitFor(page, 'the other chat', `import('/base.js').then((m) => { window.shown = m.view.id; }) && window.shown === 102`);
  assert.equal(await page.eval(`import('/base.js').then((m) => m.view.cabals?.length ?? 0)`), 1);
  assert.ok(await page.eval(`!!document.querySelector('.cabal-card')`));
});

// #2277 (Cara, 2026-11-27): the Overseer is the header; a shut card lists every started member, an open one adds the not-started
// lines. A member's waiting card shows as the header's chip too, and one click opens it.
test("a shut card lists its started members and a member's card is its row's chip, not the header's; open adds the not-started lines", { skip }, async () => {
  const page = await browser.page(`${base}?waits#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the chip to draw', `document.querySelector('.thread-row .card-badge')`);
  const count = (sel: string) => page.eval<number>(`document.querySelectorAll('.cabal-card ${sel}').length`);
  assert.deepEqual([await count('.thread-row'), await count('.cabal-planned'), await count('.cabal-lead + * .thread-row')], [1, 0, 0], 'shut: the started member, no Overseer row, no not-started line');
  await page.eval(`document.querySelector('.cabal-toggle').click()`);
  assert.deepEqual([await count('.thread-row'), await count('.cabal-planned')], [1, 1], 'open: adds the not-started line');
  // Cara, 2026-11-28: "a minions chip shouldnt also show up on the Overseer": the member's card is its own row's chip, the header has none.
  assert.equal(await count('.cabal-top .card-badge'), 0, "a member's card isn't rolled up into the header");
  assert.equal(await count('.thread-row .card-badge'), 1, "it stays on the member's own row");
});

test("the header's chip shows the Overseer's own waiting card", { skip }, async () => {
  const page = await browser.page(`${base}?leadcard#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the chip to draw', `document.querySelector('.cabal-top .card-badge')`);
});

// #2288 (Cara, 2026-11-28: "Blue, plus a question dot"; "fill green, then blue, then grey").
test('the bar fills finished, then at work, then not started; a working member with an open question stays blue with a dot, a stopped one is red', { skip }, async () => {
  const page = await browser.page(`${base}?mix#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the bar to draw', `document.querySelectorAll('.cabal-meter i').length === 6`);
  const segs = await page.eval<[string, boolean, string][]>(`[...document.querySelectorAll('.cabal-meter i')].map((i) => [i.dataset.s, i.hasAttribute('data-ask'), i.title])`);
  assert.deepEqual(
    segs.map((s) => s[0]),
    ['merged', 'running', 'running', 'blocked', 'roster', 'sealed'],
  );
  assert.deepEqual(
    segs.map((s) => s[1]),
    [false, true, false, false, false, false],
    'only the building member with a question carries the dot',
  );
  assert.match(segs[1][2], /^B1 #31 B1 work: building, with a question open with the Overseer$/);
  assert.match(segs[3][2], /^B2 #34 B2 work: waiting on the Overseer's answer$/);
});

// #2282 (Cara, 2026-11-28): the section heading is "Plot 10: <title>" (an old "Build 10:" prefix dropped; a Plot with no number is its title), "current"
// after it; the card's first line is the Overseer chip and its #N.
for (const [what, search, heading, name] of [
  ['an old "Build 10:" title loses its prefix', '?waits', 'Plot 10: one kind of machine', 'Overseer #7'],
  ['a title with no prefix reads as it is', '?clean', 'Plot 10: One runner pool', 'Overseer #7'],
  ['a Plot with no branch is headed by its title alone', '?goal', 'Goal work', 'Overseer #7'],
]) {
  test(`the section heading and the card's first line: ${what}`, { skip }, async () => {
    const page = await browser.page(`${base}${search}#/p/1`, { width: 1280, height: 800 });
    await waitFor(page, 'the card to draw', `document.querySelector('.cabal-name')`);
    const text = (sel: string) => page.eval<string>(`document.querySelector('${sel}').textContent.replace(/\\s+/g, ' ').trim()`);
    assert.equal(await text('.g-cabal > h3 .cabal-h'), heading);
    assert.equal(await text('.g-cabal > h3'), `${heading}${search === '?goal' ? '' : ' current'}`);
    assert.equal(await text('.cabal-name'), name);
  });
}

// #2282 (Cara, 2026-11-28, "Show what it waits on"): the state line says the Overseer's note after the word, one line, full text in a tooltip.
test("the state line adds the Overseer's note after the word, and is the word alone with none", { skip }, async () => {
  const state = `document.querySelector('.cabal-state').textContent.replace(/\\s+/g, ' ').trim()`;
  let page = await browser.page(`${base}?note#/p/1`, { width: 390, height: 800 });
  await waitFor(page, 'the card to draw', `document.querySelector('.cabal-state')`);
  assert.equal(await page.eval<string>(state), 'Idle · P3 #2275 building; ships switched off after P5');
  assert.equal(await page.eval<string>(`document.querySelector('.cabal-note').title`), 'P3 #2275 building; ships switched off after P5');
  assert.equal(await page.eval<string>(`getComputedStyle(document.querySelector('.cabal-note')).whiteSpace`), 'nowrap');
  page = await browser.page(`${base}#/p/1`, { width: 390, height: 800 });
  await waitFor(page, 'the card to draw', `document.querySelector('.cabal-state')`);
  assert.equal(await page.eval<string>(state), 'Idle');
  assert.equal(await page.eval<number>(`document.querySelectorAll('.cabal-note').length`), 0);
});

// Cara, 2026-11-27: "I am still getting the flickering" (#2280). The list rebuilds the card on every bit of news, and a
// new card under a resting pointer began its hover fade again: the outline snapped to grey and came back, each redraw.
// Nothing in the list may start a transition because of a redraw alone.
test('a redraw under a resting pointer leaves the card as it was: no outline fading back in (#2280)', { skip }, async () => {
  const page = await browser.page(`${base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the card to draw', `document.querySelector('.cabal-card .cabal-meter')`);
  const at = await page.eval<{ x: number; y: number }>(`(() => { const r = document.querySelector('.cabal-meter').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 2 }; })()`);
  await page.mouse(at.x - 3, at.y);
  await page.mouse(at.x, at.y);
  const fades = `document.getElementById('threads').getAnimations({ subtree: true }).filter((a) => a instanceof CSSTransition).map((a) => a.effect.target.className + ' ' + a.transitionProperty)`;
  await waitFor(page, 'the hover to settle', `document.querySelector('.cabal-card').matches(':hover') && !${fades}.length`);
  for (const step of ['shut', 'open']) {
    if (step === 'open') {
      await page.eval(`document.querySelector('.cabal-toggle').click()`);
      await waitFor(page, 'the open card to settle', `document.querySelector('.cabal-card[data-open]') && !${fades}.length`);
    }
    const seen = await page.eval<{ before: string; frames: { hover: boolean; border: string; fades: string[] }[] }>(`(async () => {
      const { renderSidebar } = await import('./sidebar.js');
      const border = () => getComputedStyle(document.querySelector('.cabal-card')).borderTopColor;
      const before = border();
      renderSidebar();
      const frames = [];
      for (let i = 0; i < 3; i++) {
        await new Promise(requestAnimationFrame);
        frames.push({ hover: document.querySelector('.cabal-card').matches(':hover'), border: border(), fades: ${fades} });
      }
      return { before, frames };
    })()`);
    assert.deepEqual(
      seen.frames,
      [0, 1, 2].map(() => ({ hover: true, border: seen.before, fades: [] })),
      `${step}: every frame after the redraw shows the hovered card as before it`,
    );
  }
});

// Cara, 2026-11-27: "when you expand a Plot, below the not started minions, you also see the dismissed minions from that build".
test('an open card lists its dismissed members under the not-started lines, each a link to its chat; a shut one lists none', { skip }, async () => {
  const page = await browser.page(`${base}?waits#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the card to draw', `document.querySelector('.cabal-card .thread-row')`);
  const lines = `[...document.querySelectorAll('.cabal-members > *')].map((e) => (e.matches('a[href]:not(.thread-row)') ? [e.getAttribute('href'), ...[...e.children].map((x) => x.textContent)].join(' | ') : e.classList[0]))`;
  assert.deepEqual(await page.eval(lines), ['thread-row'], 'shut: the started member only');
  await page.eval(`document.querySelector('.cabal-toggle').click()`);
  // H1 merged and has no open row: dismissed. H2 (#21) is open, so it keeps its row and gets no second line.
  assert.deepEqual(await page.eval(lines), ['thread-row', 'cabal-planned', '#/p/1/t/20 | #20 H1 H1 work | merged']);
});

// Cara, 2026-11-27, picked "Always purple": the outline is the Plot's colour at rest, hovered or not, open or shut.
test("the card's outline is the Plot's colour with no pointer on it", { skip }, async () => {
  const page = await browser.page(`${base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the card to draw', `document.querySelector('.cabal-card')`);
  const [hover, border, heading] = await page.eval<[boolean, string, string]>(`(() => { const c = document.querySelector('.cabal-card'); return [c.matches(':hover'), getComputedStyle(c).borderTopColor, getComputedStyle(document.querySelector('.g-cabal > h3')).color]; })()`);
  assert.deepEqual([hover, border], [false, heading]);
});
