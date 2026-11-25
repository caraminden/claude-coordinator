// A click on a minion's row opens it even when the list redraws between the press and the release (#1499; Cara,
// 2026-11-21: clicking a minion over $25, then one waiting on a question, "didnt open the minion", and "the second
// click works though"). Every minion update redraws the whole list, so on a busy scheme a redraw often lands inside a
// click: the pressed row was swapped for a new one, the release fell on the new one, and no click reached either link.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, launch, waitFor, type Browser, type Page, serveApp, skipMessage, type App } from './browser.ts';
import { pageStub } from './page-stub.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = pageStub(`
  window.ready = true;
  localStorage.setItem('cc-inbox-open', '1');
  const coordinator = { id: 100, project_id: 1, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 };
  window.a = { id: 101, project_id: 1, kind: 'ticket', number: 1, title: 'Minion A', status: 'idle', state: 'ready', updated_at: now, created_at: now - 600_000 };
  window.b = { id: 102, project_id: 1, kind: 'ticket', number: 2, title: 'Minion B', status: 'running', updated_at: now - 1, created_at: now - 600_000, last_activity: 'Working' };
  function route(path, url) {
    if (path === 'api/projects') return reply(200, [{ id: 1, name: 'Alpha', inbox: 1, icon: null }]);
    if (path === 'api/projects/1') return reply(200, { project: { id: 1, name: 'Alpha', instructions: '' }, coordinator, tickets: [a, b], dismissed: 0, seen: {}, person_notes: {}, pins: [] });
    if (/\\/events$/.test(path)) return reply(200, url.search.includes('after=') ? [] : { events: [], tasks: [], more: false });
    if (/seen$/.test(path)) return reply(200, { seen_at: now });
    if (/inbox$/.test(path)) return reply(200, { items: [{ kind: 'state', ticketId: 101, at: now, key: 'state:101' }] });
  }
`);

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

/** Press on `selector`, let another minion's update redraw the list, then release where it was pressed. */
async function clickThroughRedraw(page: Page, selector: string) {
  const { x, y } = await page.centre(selector);
  const at = { x, y, button: 'left', clickCount: 1 };
  await page.mouse(x, y);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
  await page.eval(`es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...b, last_activity: 'Still working', updated_at: Date.now() } }) })`);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
}

for (const [where, selector] of [
  ['the minion list', '#threads .thread-row[data-id="101"] .name'],
  ['Needs you', '.inbox-rows .inbox-row .name'],
]) {
  test(`a row in ${where} opens its minion when the list redraws during the click`, { skip }, async () => {
    const page = await browser.page(`${app.base}#/p/1/t/2`, { width: 1280, height: 800 });
    await waitFor(page, 'the rows', `!!document.querySelector('${selector}')`);
    await clickThroughRedraw(page, selector);
    await waitFor(page, 'the held redraw', `document.querySelector('#threads .thread-row[data-id="102"]')?.textContent.includes('Still working')`);
    // The click went through: the router has the minion it opens (the redraw it held ran after it, above).
    assert.equal(await page.eval<string>('location.hash'), '#/p/1/t/1');
  });
}

// #1532: a burst of live messages draws the list once, not once a message.
test('ten ticket messages in one frame redraw the minion list once', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1/t/2`, { width: 1280, height: 800 });
  await waitFor(page, 'the rows', `!!document.querySelector('#threads .thread-row[data-id="102"]')`);
  const draws = await page.eval<number[]>(`(async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r)); // the first load's own redraws settle
    const row = () => document.querySelector('#threads .thread-row[data-id="102"]');
    let swaps = 0, last = row();
    const count = () => { if (row() !== last) { swaps++; last = row(); } };
    for (let i = 0; i < 10; i++) es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...b, last_activity: 'Step ' + i, updated_at: Date.now() + i } }) });
    count();
    const sync = swaps; // nothing drawn inside the handler
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    count();
    return [sync, swaps];
  })()`);
  // Ten uncoalesced messages swap the row ten times. One more swap can come from the page's own load work landing
  // in the same window (a busy runner), so the bound is "a couple", never ten.
  assert.ok(draws[0] <= 1 && draws[1] <= 2, `ten messages swapped the row ${draws[1]} times (${draws[0]} inside the handlers)`);
});
