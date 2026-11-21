// Home's list (#1253): a row that leaves the list (its card answered) is gone in the same draw, with no struck-through
// "✓ Done" row left behind, and a scheme with no rows left loses its heading. Josh, 2026-11-20: "these should just be gone
// once done". Citadel's real front end in headless Chromium (test/browser.ts), with fetch answered in the page.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, launch, waitFor, type Browser, serveApp, skipMessage, type App } from './browser.ts';

const bin = chromium();
const skip = !bin && skipMessage;

const STUB = `<script>
  window.ready = true;
  const now = Date.now();
  const mk = (id, project_id, number, title) => ({ id, project_id, kind: 'ticket', number, title, status: 'idle', updated_at: now, created_at: now - 1000 });
  const tickets = [mk(101, 1, 7, 'First minion'), mk(102, 1, 8, 'Second minion'), mk(103, 2, 9, 'Third minion')];
  window.waiting = [101, 102, 103];
  const reply = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  window.fetch = async (input) => {
    const path = new URL(typeof input === 'string' ? input : input.url, location.href).pathname.replace(/^\\//, '');
    if (path === 'api/me') return reply({ name: 'Cara', login: 'cara', admin: true, uid: 1 });
    if (path === 'api/projects') return reply([{ id: 1, name: 'Alpha', inbox: 0, icon: null }, { id: 2, name: 'Beta', inbox: 0, icon: null }]);
    let m;
    if ((m = path.match(/^api\\/projects\\/(\\d+)$/))) {
      const id = Number(m[1]);
      return reply({ project: { id, name: id === 1 ? 'Alpha' : 'Beta', instructions: '' }, coordinator: { id: id * 100, project_id: id, kind: 'coordinator', number: 0, title: 'Taskmaster', status: 'idle', updated_at: 0 }, tickets: tickets.filter((t) => t.project_id === id), seen: {}, person_notes: {}, pins: [] });
    }
    if (/^api\\/projects\\/\\d+\\/properties$/.test(path)) return reply({ keys: [], values: {} });
    if (/^api\\/tickets\\/\\d+\\/events$/.test(path)) return reply({ events: [], more: false, tasks: [] });
    if (path === 'api/home') return reply({
      items: window.waiting.map((ticketId, i) => ({ id: i + 1, ticketId, kind: 'question', at: now })),
      tickets: tickets.filter((t) => window.waiting.includes(t.id)),
      schemes: [{ id: 1, name: 'Alpha', waiting: 0, working: 0, shipped: 0, daily: [] }, { id: 2, name: 'Beta', waiting: 0, working: 0, shipped: 0, daily: [] }],
      seen: {}, days: [], me: 'Cara',
    });
    return reply([]);
  };
  window.EventSource = class { close() {} };
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

const rows = `[...document.querySelectorAll('.home-panel .thread-row .name')].map((n) => n.textContent.trim()).join('|')`;
const heads = `[...document.querySelectorAll('.home-panel .home-group > h3')].map((n) => n.firstChild.textContent.trim()).join('|')`;

test('a row that leaves Home goes at once, its scheme heading with the last one, and nothing is ticked off', { skip }, async () => {
  const page = await browser.page(`${app.base}#/home`, { width: 1280, height: 800 });
  await waitFor(page, 'three rows', `document.querySelectorAll('.home-panel .thread-row').length === 3`);
  assert.equal(await page.eval(heads), 'Alpha|Beta');
  const redraw = `import('/home.js').then((m) => m.refreshHome())`;
  await page.eval(`window.waiting = [101, 103]; ${redraw}`);
  await waitFor(page, 'the answered row to go', `document.querySelectorAll('.home-panel .thread-row').length === 2`);
  assert.equal(await page.eval(`document.querySelectorAll('.home-panel .done, .home-panel .done-chip').length`), 0);
  assert.equal(await page.eval(`${rows}.includes('Second')`), false);
  await page.eval(`window.waiting = [101]; ${redraw}`);
  await waitFor(page, "Beta's heading to go", `(${heads}) === 'Alpha'`);
  await page.eval(`window.waiting = []; ${redraw}`);
  await waitFor(page, 'the empty card', `document.querySelector('.home-panel').textContent.includes('Nothing needs you')`);
});

// Folded shut means skipped (#1405): answering the last card in an open scheme doesn't open a row of a folded one.
for (const [folded, expect] of [[true, '#/home/p/1/t/7'], [false, '#/home/p/2/t/9']] as const) {
  test(`after an answer, Home ${folded ? 'skips' : 'moves on to'} a scheme folded ${folded ? 'shut' : 'open'}`, { skip }, async () => {
    const page = await browser.page(`${app.base}#/home`, { width: 1280, height: 800 });
    await page.eval(`localStorage.setItem('cc-home-folded', ${JSON.stringify(folded ? '[2]' : '[]')}); location.reload()`);
    await waitFor(page, 'the rows', `document.querySelectorAll('.home-panel .thread-row').length >= 1`);
    await page.eval(`location.hash = '#/home/p/1/t/7'`);
    await waitFor(page, 'the chat open', `location.hash === '#/home/p/1/t/7'`);
    // Answer 101's card: the list loses that row, the way /api/home does once it's settled.
    await page.eval(`window.waiting = [103]; import('/home.js').then((m) => m.homeEvent({ ticket_id: 101, kind: 'user_message', data: JSON.stringify({ answer: true, author: 'Cara' }) }))`);
    await new Promise((r) => setTimeout(r, folded ? 2500 : 0));
    if (!folded) await waitFor(page, 'the move', `location.hash.startsWith('${expect}')`);
    assert.equal((await page.eval<string>('location.hash')).startsWith(expect), true);
  });
}
