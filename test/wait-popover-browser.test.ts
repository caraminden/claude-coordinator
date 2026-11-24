// The waits popover (#1387): one line per wait, and an open popover keeps showing the minion it was opened on while
// another minion's waits change and the list redraws (Cara, 2026-11-21: it "randomly changes to" another minion's wait).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = `<script>
  window.ready = true;
  const now = Date.now();
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  const w = (id, chip, what, extra) => ({ id, state: 'waiting', chip, what, cancellable: true, ...extra });
  window.a = { id: 101, project_id: 1, kind: 'ticket', number: 1, title: 'Minion A', status: 'parked', updated_at: now, created_at: now - 600_000, outbox_waits: [w(1, '⇢ #2', 'the deploy of #2', { link: { project: 1, number: 2 } })] };
  const relay = { headline: 'Note from #1 once its change is live', line: 'Main is green again.', text: 'Main is green again. One. Two. Three and four.', facts: ['Set by #1 at 12:54 PST', 'waits for fa4fb3f to go live'], link: { project: 1, number: 1 } };
  window.b = { id: 102, project_id: 1, kind: 'ticket', number: 2, title: 'Minion B', status: 'parked', updated_at: now - 1, created_at: now - 600_000, outbox_waits: [w(2, '⏱ 01:32', 'check the run'), w(3, '⇢ #1', 'a second wait', relay), w(4, '⇢ live', 'x', { headline: 'Wakes when abc1234 is live', line: '', text: '', facts: [] })] };
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    const path = url.pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply(200, { name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 0, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: [a, b], dismissed: 0, seen: {}, person_notes: {}, pins: [] });
    if (/\\/events$/.test(path)) return reply(200, url.search.includes('after=') ? [] : { events: [], tasks: [], more: false });
    if (/seen$/.test(path)) return reply(200, { seen_at: now });
    if (/inbox$/.test(path)) return reply(200, { items: [] });
    return reply(200, []);
  };
  window.EventSource = class { constructor() { window.es = this; } close() {} };
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

/** A real click: move there, press, release. */
async function click(page: Awaited<ReturnType<Browser['page']>>, at: { x: number; y: number }) {
  await page.mouse(at.x, at.y);
  for (const type of ['mousePressed', 'mouseReleased']) await page.send('Input.dispatchMouseEvent', { type, ...at, button: 'left', buttons: 1, clickCount: 1 });
}

const tip = `(document.querySelector('.why-tip:popover-open')?.textContent ?? '')`;

test("a minion with two waits shows one line each in one popover, and it stays on its minion through another minion's change", { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the chips', `document.querySelectorAll('.wait-chip[data-wait-id="102"]').length === 1`);
  const c = await page.centre('.wait-chip[data-wait-id="102"]');
  await page.mouse(c.x, c.y);
  await waitFor(page, 'the popover', `${tip}.includes('check the run')`);
  assert.equal(await page.eval(`document.querySelectorAll('.why-tip:popover-open .wait-line').length`), 3);
  // Another minion's wait changes (a cancelled one appears) while the popover is open: the list redraws, the popover stays on B.
  // (Cause of the jump Cara saw, 2026-11-21: a redraw re-finds the open chip by its data-tip* attributes, and the wait chip had none, so it matched the first chip in the list.)
  await page.eval(`es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...a, outbox_waits: [{ id: 9, state: 'dropped', chip: '⏱ 01:32', what: 'cancelled wake', reason: 'cancelled' }] } }) })`);
  await waitFor(page, 'the redraw', `document.querySelector('.thread-row[data-id="101"]')?.textContent.includes('01:32')`);
  assert.ok(await page.eval<boolean>(`${tip}.includes('check the run') && ${tip}.includes('Note from #1') && !${tip}.includes('cancelled wake')`));
  // B's own change shows in the open popover.
  await page.eval(`es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...b, outbox_waits: [b.outbox_waits[1]], updated_at: Date.now() } }) })`);
  await waitFor(page, "B's update", `!${tip}.includes('check the run') && ${tip}.includes('Note from #1')`);
});

// #1512 (Cara, 2026-11-21: "a headline single sentence description, and then clicking it opens a few sentence summary"; take A, opens in place).
test('a wait line is a headline with its first sentence under it; a click opens its summary in place, and it stays open through a redraw', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the chips', `document.querySelectorAll('.wait-chip[data-wait-id="102"]').length === 1`);
  const c = await page.centre('.wait-chip[data-wait-id="102"]');
  await click(page, c);
  await waitFor(page, 'the popover', `${tip}.includes('Note from #1 once its change is live')`);
  const line = `document.querySelectorAll('.why-tip:popover-open .wait-line')[1]`;
  assert.equal(await page.eval(`${line}.querySelector('.wait-line-meta')?.textContent`), 'Main is green again.');
  assert.equal(await page.eval(`document.querySelectorAll('.why-tip:popover-open .wait-sum').length`), 0, 'nothing opens by itself');
  // An old-shape row (no headline) still reads: its words are the headline.
  assert.match(await page.eval<string>(`document.querySelectorAll('.why-tip:popover-open .wait-line')[0].textContent`), /check the run/);
  const hd = await page.centre('.why-tip:popover-open .wait-line:nth-child(2) .wait-line-hd');
  await click(page, hd);
  await waitFor(page, 'the summary', `!!${line}.querySelector('.wait-sum')`);
  const sum = await page.eval<string>(`${line}.querySelector('.wait-sum').textContent`);
  assert.ok(sum.includes('Main is green again. One. Two.') && !sum.includes('Three') && sum.includes('Show all'), sum);
  assert.ok(sum.includes('Set by #1 at 12:54 PST · waits for fa4fb3f to go live'), sum);
  assert.equal(await page.eval(`${line}.querySelector('.wait-sum a')?.getAttribute('href')`), '#/p/1/t/1');
  assert.equal(await page.eval(`${line}.querySelector('.wait-line-hd').getAttribute('aria-expanded')`), 'true');
  await waitFor(page, 'the opening to settle', `document.querySelector('.why-tip:popover-open').getAnimations({ subtree: true }).every((a) => a.playState !== 'running')`);
  const more = await page.centre('.why-tip:popover-open .wait-more');
  await click(page, more);
  await waitFor(page, 'the full words', `${line}.querySelector('.wait-sum').textContent.includes('Three and four.')`);
  // B redraws with the same waits (the list's 30 s tick does this): the open popover keeps its very elements, so a
  // click pressed before the redraw and released after it still lands (the burn-in race, #1512).
  await page.eval(`document.querySelector('.thread-row[data-id="102"]').dataset.old = '1'; document.querySelector('.why-tip:popover-open .wait-line-hd').dataset.old = '1'`);
  await page.eval(`es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...b, updated_at: Date.now() } }) })`);
  await waitFor(page, "B's row to redraw", `!document.querySelector('.thread-row[data-id="102"]')?.dataset.old`);
  await page.eval(`new Promise((r) => queueMicrotask(r))`);
  assert.equal(await page.eval(`document.querySelector('.why-tip:popover-open .wait-line-hd')?.dataset.old`), '1', 'a redraw with nothing new leaves the popover alone');
  // B's waits change (another wait goes): the popover redraws and the open line stays open, without animating again.
  await page.eval(`es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...b, outbox_waits: b.outbox_waits.slice(1), updated_at: Date.now() } }) })`);
  await waitFor(page, "B's update", `!${tip}.includes('check the run')`);
  const open = `document.querySelector('.why-tip:popover-open .wait-line.open')`;
  assert.ok(await page.eval<boolean>(`!!${open}?.textContent.includes('Three and four.') && !${open}.classList.contains('opening')`));
  // A wait with no words of its own opens to its facts alone; a second click closes it.
  const bare = await page.centre('.why-tip:popover-open .wait-line:nth-child(2) .wait-line-hd');
  await click(page, bare);
  await waitFor(page, 'one open at a time', `document.querySelectorAll('.why-tip:popover-open .wait-line.open').length === 1 && ${open}.textContent.includes('Wakes when abc1234 is live')`);
  assert.equal(await page.eval(`${open}.querySelector('.wait-sum-words')`), null);
  // Opening it moved its header (the other line closed, its summary grows), so find it again once that settles.
  await waitFor(page, 'the second opening to settle', `document.querySelector('.why-tip:popover-open').getAnimations({ subtree: true }).every((a) => a.playState !== 'running')`);
  await click(page, await page.centre('.why-tip:popover-open .wait-line.open .wait-line-hd'));
  await waitFor(page, 'closed', `!document.querySelector('.why-tip:popover-open .wait-line.open')`);
});

// #1676 (Cara, 2026-11-22: "this should link to the minion it is waiting on"): the chip's "⇢ #N" opens that minion, not the row or the popover.
test("a wait chip naming a minion links to it, and the click opens neither the row's chat nor the popover", { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the link', `!!document.querySelector('.wait-chip[data-wait-id="101"] a.wait-chip-link')`);
  assert.equal(await page.eval(`document.querySelector('.wait-chip[data-wait-id="101"] a').getAttribute('aria-label')`), 'Waits on #2');
  assert.equal(await page.eval(`document.querySelector('.wait-chip[data-wait-id="102"] a')`), null, 'a clock wait names no minion');
  await click(page, await page.centre('.wait-chip[data-wait-id="101"] a'));
  await waitFor(page, 'minion #2', `location.hash === '#/p/1/t/2'`);
  assert.equal(await page.eval(`!!document.querySelector('.why-tip:popover-open')`), false);
});
