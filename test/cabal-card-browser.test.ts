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
// building with no row here), so the open card lists the Overseer alone, as the shut one does.
const STUB = pageStub(
  `
  window.ready = true;
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const lead = { id: 101, project_id: 1, kind: 'ticket', number: 7, title: 'Build 10: one kind of machine', status: 'idle', build: 10, updated_at: 0, created_at: 0 };
  const other = { id: 102, project_id: 1, kind: 'ticket', number: 8, title: 'Another minion', status: 'idle', type: 'feature', updated_at: 0, created_at: 0 };
  const member = (label, state, word) => ({ id: null, number: null, label, title: label + ' work', state, word });
  const cabals = [{ lead: 101, number: 7, title: lead.title, overseer: "Build 10's Overseer", name: 'Build 10', build: 10, members: [member('H1', 'merged', 'merged'), member('H2', 'running', 'building')], finished: 1, done: 'merged', next: 0, spend: 12 }];
  cabals[0].members.forEach((m, i) => { m.id = 200 + i; m.number = 20 + i; });
  function route(path, url) {
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: [lead, other], seen: {}, person_notes: {}, pins: [], cabals: location.search === '?late' && !window.formed ? [] : cabals, builds: [{ build: 10, merged: 1, open: 1, behind: 42 }], build_previews: true });
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

test("a redraw of the list leaves a building member's segment mid-pulse, not back at its start", { skip }, async () => {
  const page = await browser.page(`${base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the card to draw', `document.querySelector('.cabal-meter i[data-s=running]')`);
  // Redraw away from the turn's start (the shared clock: 1.6 s a turn). How far into its turn the new segment's pulse began
  // is its place now less its own running time, so a late frame moves neither: in step, it began where the clock was at
  // the redraw; started over, it began at 0.
  const [began, from, to] = await page.eval<number[]>(`(async () => {
    const { renderSidebar } = await import('./sidebar.js');
    while (Math.abs((Date.now() % 1600) - 800) > 300) await new Promise(requestAnimationFrame);
    const from = Date.now() % 1600;
    renderSidebar();
    const to = Date.now() % 1600;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const [pulse] = document.querySelector('.cabal-meter i[data-s=running]').getAnimations();
    const began = (((pulse.effect.getComputedTiming().progress * 1600 - pulse.currentTime) % 1600) + 1600) % 1600;
    return [began, from, to];
  })()`);
  assert.ok(began >= from - 2 && began <= to + 2, `the segment's pulse began where the clock was at the redraw (${Math.round(began)} ms into its turn; the clock was at ${from} to ${to})`);
});

test('opening a card that has only its Overseer to show moves nothing', { skip }, async () => {
  const page = await browser.page(`${base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the card to draw', `document.querySelector('.cabal-card .thread-row')`);
  const measure = `(() => { const c = document.querySelector('.cabal-card'); return { open: c.hasAttribute('data-open'), rows: c.querySelectorAll('.thread-row').length, preview: !!c.querySelector('.cabal-build a'), height: c.getBoundingClientRect().height }; })()`;
  const shut = await page.eval<Card>(measure);
  await page.eval(`document.querySelector('.cabal-toggle').click()`);
  const open = await page.eval<Card>(measure);
  assert.deepEqual([shut.open, open.open, shut.rows, open.rows, shut.preview], [false, true, 1, 1, true]);
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
  assert.equal(await page.eval(`!!document.querySelector('.cabal-card .thread-row') && !document.querySelector('.g-build')`), true, "the build's section is its cabal's card");
});
