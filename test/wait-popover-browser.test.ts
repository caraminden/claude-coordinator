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
  window.a = { id: 101, project_id: 1, kind: 'ticket', number: 1, title: 'Minion A', status: 'parked', updated_at: now, created_at: now - 600_000, outbox_waits: [w(1, '⇢ #2', 'the deploy of #2')] };
  window.b = { id: 102, project_id: 1, kind: 'ticket', number: 2, title: 'Minion B', status: 'parked', updated_at: now - 1, created_at: now - 600_000, outbox_waits: [w(2, '⏱ 01:32', 'check the run'), w(3, '⇢ event', 'a second wait')] };
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
before(async () => { if (skip) return; app = await serveApp({ stub: STUB }); browser = await launch(bin!); });
after(async () => { await browser?.close(); await app?.close(); });

const tip = `(document.querySelector('.why-tip:popover-open')?.textContent ?? '')`;

test('a minion with two waits shows one line each in one popover, and it stays on its minion through another minion\'s change', { skip }, async () => {
  const page = await browser.page(`${app.base}#/p/1`, { width: 1280, height: 800 });
  await waitFor(page, 'the chips', `document.querySelectorAll('.wait-chip[data-wait-id="102"]').length === 1`);
  const c = await page.centre('.wait-chip[data-wait-id="102"]');
  await page.mouse(c.x, c.y);
  await waitFor(page, 'the popover', `${tip}.includes('check the run')`);
  assert.equal(await page.eval(`document.querySelectorAll('.why-tip:popover-open .wait-line').length`), 2);
  // Another minion's wait changes (a cancelled one appears) while the popover is open: the list redraws, the popover stays on B.
  // (Cause of the jump Cara saw, 2026-11-21: a redraw re-finds the open chip by its data-tip* attributes, and the wait chip had none, so it matched the first chip in the list.)
  await page.eval(`es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...a, outbox_waits: [{ id: 9, state: 'dropped', chip: '⏱ 01:32', what: 'cancelled wake', reason: 'cancelled' }] } }) })`);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(await page.eval<boolean>(`${tip}.includes('check the run') && ${tip}.includes('a second wait') && !${tip}.includes('cancelled wake')`));
  // B's own change shows in the open popover.
  await page.eval(`es.onmessage({ data: JSON.stringify({ type: 'ticket', ticket: { ...b, outbox_waits: [b.outbox_waits[1]], updated_at: Date.now() } }) })`);
  await waitFor(page, 'B\'s update', `!${tip}.includes('check the run') && ${tip}.includes('a second wait')`);
});
