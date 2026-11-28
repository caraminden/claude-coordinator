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
  const cabals = [{ lead: 101, number: 7, title: lead.title, overseer: "Build 10's Overseer", name: 'Build 10', build: 10, members: [member('H1', 'merged', 'merged'), member('H2', 'running', 'building')], finished: 1, done: 'merged', next: 0, spend: 12 }];
  cabals[0].members.forEach((m, i) => { m.id = 200 + i; m.number = 20 + i; });
  if (location.search === '?bare') cabals[0].members.shift(); // no dismissed member: open shows nothing more than shut
  if (location.search === '?waits') cabals[0].members.push({ id: null, number: null, label: 'H3', title: 'Not yet', state: 'roster', word: 'next up' });
  window.stubCabals = cabals;
  // ?waits: a member with a question card waiting on people (#2277).
  const waiter = { id: 201, project_id: 1, kind: 'ticket', number: 21, title: 'H2 work', status: 'idle', build: 10, updated_at: 0, created_at: 0, open_cards: [{ minion: 201, kind: 'question', what: 'question', label: 'Q', href: '#/p/1/t/21?e=5' }] };
  function route(path, url) {
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: location.search === '?waits' ? [lead, other, waiter] : [lead, other], seen: {}, person_notes: {}, pins: [], cabals: location.search === '?late' && !window.formed ? [] : cabals, builds: [{ build: 10, merged: 1, open: 1, behind: 42 }], build_previews: true });
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
test("a shut card lists its started members and the header's chip opens a waiting card; open adds the not-started lines", { skip }, async () => {
  const page = await browser.page(`${base}?waits#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the chip to draw', `document.querySelector('.cabal-lead .card-badge')`);
  const count = (sel: string) => page.eval<number>(`document.querySelectorAll('.cabal-card ${sel}').length`);
  assert.deepEqual([await count('.thread-row'), await count('.cabal-planned'), await count('.cabal-lead + * .thread-row')], [1, 0, 0], 'shut: the started member, no Overseer row, no not-started line');
  await page.eval(`document.querySelector('.cabal-toggle').click()`);
  assert.deepEqual([await count('.thread-row'), await count('.cabal-planned')], [1, 1], 'open: adds the not-started line');
  await page.eval(`window.hashes = []; addEventListener('hashchange', (e) => hashes.push(new URL(e.newURL).hash)); document.querySelector('.cabal-lead .card-badge').click()`);
  await waitFor(page, 'the card', `hashes.includes('#/p/1/t/21?e=5')`);
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
