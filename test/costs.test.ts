import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { costDays, dayBudget, localDay } from '../src/costs.ts';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'costs-'));
after(() => rmSync(root, { recursive: true, force: true }));

function setup(name: string) {
  const store = new Store(join(root, `${name}.db`));
  const p = store.createProject(`P-${name}`, null);
  const t = store.createTicket({ project_id: p.id, title: 'x', permission_mode: 'default', created_by: 'Cara' });
  return { store, p, t };
}

const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);

test("a turn's cost is the rise in the session's running total", () => {
  const { store, t } = setup('delta');
  const now = Date.now();
  const a = store.recordTurn(t.id, { session_id: 's1', ended_at: now, session_cost_usd: 0.5, usage: { input_tokens: 3, output_tokens: 40, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 } });
  close(a.cost_usd, 0.5);
  assert.deepEqual([a.input_tokens, a.output_tokens, a.cache_read_tokens, a.cache_write_tokens], [3, 40, 1000, 200]);
  close(store.recordTurn(t.id, { session_id: 's1', ended_at: now, session_cost_usd: 1.25 }).cost_usd, 0.75);
  // A total that went down started afresh; so does a new session.
  close(store.recordTurn(t.id, { session_id: 's1', ended_at: now, session_cost_usd: 0.2 }).cost_usd, 0.2);
  close(store.recordTurn(t.id, { session_id: 's2', ended_at: now, session_cost_usd: 0.9 }).cost_usd, 0.9);
  close(store.ticketCost(t.id), 0.5 + 0.75 + 0.2 + 0.9);
  assert.equal(store.listTurns(t.id).length, 4);
});

test('backfill works turn costs out of stored result events, once', () => {
  const { store, t } = setup('backfill');
  const add = (data: object) => store.addEvent(t.id, 'claude', data);
  add({ type: 'system', subtype: 'init', session_id: 's1' });
  add({ type: 'result', subtype: 'success', duration_ms: 1000, total_cost_usd: 1 });
  add({ type: 'system', subtype: 'init', session_id: 's1' });
  add({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });
  add({ type: 'result', subtype: 'success', duration_ms: 2000, total_cost_usd: 3 });
  add({ type: 'system', subtype: 'init', session_id: 's2' });
  add({ type: 'result', subtype: 'success', duration_ms: 500, total_cost_usd: 0.5 });
  assert.equal(store.backfillTurns(), 3);
  assert.deepEqual(store.listTurns(t.id).map((u) => [u.session_id, u.cost_usd, u.duration_ms, u.input_tokens]), [['s1', 1, 1000, null], ['s1', 2, 2000, null], ['s2', 0.5, 500, null]]);
  assert.equal(store.backfillTurns(), 0);
});

test('daily totals: seven local days, today first, per scheme and overall', () => {
  const { store, p, t } = setup('days');
  const other = store.createProject('Other', null);
  const o = store.createTicket({ project_id: other.id, title: 'y', permission_mode: 'default', created_by: 'Cara' });
  const now = new Date(2026, 9, 28, 15, 0).getTime();
  const yesterday = new Date(2026, 9, 27, 23, 30).getTime();
  store.recordTurn(t.id, { session_id: 'a', ended_at: now, session_cost_usd: 2 });
  store.recordTurn(o.id, { session_id: 'b', ended_at: now, session_cost_usd: 1 });
  store.recordTurn(t.id, { session_id: 'c', ended_at: yesterday, session_cost_usd: 4 });
  // Eight days back: outside the window.
  store.recordTurn(t.id, { session_id: 'd', ended_at: new Date(2026, 9, 20, 12).getTime(), session_cost_usd: 9 });
  const days = costDays(store, now);
  assert.equal(days.length, 7);
  assert.equal(days[0].day, '2026-10-28');
  assert.equal(days[6].day, '2026-10-22');
  assert.equal(days[0].total, 3);
  assert.deepEqual(days[0].byProject, { [p.id]: 2, [other.id]: 1 });
  assert.equal(days[1].total, 4);
  assert.equal(days.reduce((s, d) => s + d.total, 0), 7);
  assert.equal(localDay(yesterday), '2026-10-27');
});

test("an even day's share of the weekly limit, priced from the meter and what turns cost in its window", () => {
  const { store, t } = setup('budget');
  const resetsAt = Date.now() + 5 * 86400_000; // the window opened two days ago
  store.recordTurn(t.id, { session_id: 'a', ended_at: Date.now() - 86400_000, session_cost_usd: 140 });
  store.recordTurn(t.id, { session_id: 'b', ended_at: Date.now(), session_cost_usd: 70 });
  // Before the window: not counted.
  store.recordTurn(t.id, { session_id: 'c', ended_at: Date.now() - 3 * 86400_000, session_cost_usd: 1000 });
  assert.equal(dayBudget(store, { utilization: 0.02, resetsAt }), null); // too coarse yet, and no earlier estimate
  assert.equal(dayBudget(store, null), null);
  close(dayBudget(store, { utilization: 0.1, resetsAt })!, 210 / 0.1 / 7);
  // A fresh window's meter is too coarse again: the last estimate stands in rather than dropping to dollars.
  close(dayBudget(store, { utilization: 0.01, resetsAt: resetsAt + 7 * 86400_000 })!, 210 / 0.1 / 7);
  close(dayBudget(store, null)!, 210 / 0.1 / 7);
  // A meter that has moved but no turns priced in its window yet: the last estimate too.
  close(dayBudget(store, { utilization: 0.5, resetsAt: resetsAt + 30 * 86400_000 })!, 210 / 0.1 / 7);
});

test("the day budget prices the server login's meter from the server login's turns only, not other payers' (#468 S05-3)", () => {
  const { store, t } = setup('payer');
  const resetsAt = Date.now() + 5 * 86400_000;
  store.recordTurn(t.id, { session_id: 'host', ended_at: Date.now(), session_cost_usd: 140 });
  const theirs = store.recordTurn(t.id, { session_id: 'josh', ended_at: Date.now(), session_cost_usd: 140, payer: 7 });
  assert.equal(theirs.payer, 7);
  close(dayBudget(store, { utilization: 0.1, resetsAt })!, 140 / 0.1 / 7);
});

test("a meter whose reset time has passed keeps the last estimate rather than summing turns from before its week (#468 S05-3)", () => {
  const { store, t } = setup('stale');
  const now = Date.now();
  store.recordTurn(t.id, { session_id: 'a', ended_at: now - 86400_000, session_cost_usd: 70 });
  close(dayBudget(store, { utilization: 0.1, resetsAt: now + 5 * 86400_000 }, now)!, 70 / 0.1 / 7);
  store.recordTurn(t.id, { session_id: 'old', ended_at: now - 8 * 86400_000, session_cost_usd: 700 });
  close(dayBudget(store, { utilization: 0.2, resetsAt: now - 2 * 86400_000 }, now)!, 70 / 0.1 / 7);
});

test("the day totals and a minion's share of the week count only the server login's turns, as its meter does (#468 S05-3)", () => {
  const { store, p, t } = setup('shown');
  const now = new Date(2026, 9, 28, 15, 0).getTime();
  store.recordTurn(t.id, { session_id: 'host', ended_at: now, session_cost_usd: 2 });
  store.recordTurn(t.id, { session_id: 'josh', ended_at: now, session_cost_usd: 5, payer: 7 });
  const today = costDays(store, now)[0];
  assert.equal(today.total, 2);
  assert.deepEqual(today.byProject, { [p.id]: 2 });
  assert.equal(store.ticketCost(t.id), 7, "the minion's own cost is still every turn's");
  assert.equal(store.ticketCost(t.id, true), 2);
});
