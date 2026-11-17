import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { costDays, dayBudget, localDay, modelName, spendSplit, whereItWent } from '../src/costs.ts';
import { Store } from '../src/db.ts';
import { usageSplitText } from '../src/mcp.ts';

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

test('the spend split counts every payer by person and by scheme, for 7 and 30 days, biggest month first (#689)', () => {
  const { store, p, t } = setup('split');
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const q = store.createProject('Delve', null);
  const u = store.createTicket({ project_id: q.id, title: 'y', permission_mode: 'default', created_by: 'Josh' });
  const now = Date.now();
  const day = 86400_000;
  const turn = (ticket: number, cost: number, ago: number, payer: number | null) =>
    store.recordTurn(ticket, { session_id: `s${Math.random()}`, ended_at: now - ago, session_cost_usd: cost, payer });
  turn(t.id, 5, 0, null);
  turn(t.id, 3, 20 * day, null);
  turn(u.id, 2, 0, josh.id);
  turn(u.id, 40, 40 * day, josh.id); // past the month
  const { people, schemes } = spendSplit(store, now);
  assert.equal(cara.server_login, 1);
  assert.deepEqual(people.map((r) => [r.name, r.week, r.month]), [['Cara (server login)', 5, 8], ['Josh', 2, 2]]);
  assert.deepEqual(schemes.map((r) => [r.name, r.week, r.month]), [[p.name, 5, 8], ['Delve', 2, 2]]);
});

const usage = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { costUSD: v, outputTokens: 1 }]));

test("a turn's split by model is each model's rise in the session's running total, Grunts' models included (#905)", () => {
  const { store, p, t } = setup('models');
  const now = Date.now();
  // Before the split was kept: no per-model numbers, so it counts under the minion's own model, marked estimated.
  store.updateTicket(t.id, { last_model: 'claude-fable-5-2' });
  store.recordTurn(t.id, { session_id: 's1', ended_at: now - 3000, session_cost_usd: 1 });
  // The session's next turn: its earlier per-model totals are unknown, so its own $2 splits pro rata (1:3).
  store.recordTurn(t.id, { session_id: 's1', ended_at: now - 2000, session_cost_usd: 3, modelUsage: usage({ 'claude-fable-5-2': 0.75, 'claude-sonnet-5-5': 2.25 }) });
  // Then each model's own rise: Fable +0.25, Sonnet +1.75, and a Haiku Grunt new this turn.
  store.recordTurn(t.id, { session_id: 's1', ended_at: now - 1000, session_cost_usd: 5.5, account: 2, modelUsage: usage({ 'claude-fable-5-2': 1, 'claude-sonnet-5-5': 4, 'claude-haiku-5-5': 0.5 }) });
  // A fresh session counts from zero.
  store.recordTurn(t.id, { session_id: 's2', ended_at: now, session_cost_usd: 0.4, modelUsage: usage({ 'claude-opus-5-5': 0.4 }) });
  const w = whereItWent(store, null, null, now + 1);
  close(w.total, 1 + 2 + 2.5 + 0.4);
  const by = Object.fromEntries(w.models.map((s) => [s.name, s]));
  close(by['Fable 5.2'].usd, 1 + 0.5 + 0.25);
  close(by['Fable 5.2'].estimated, 1);
  close(by['Sonnet 5.5'].usd, 1.5 + 1.75);
  close(by['Haiku 5.5'].usd, 0.5);
  close(by['Opus 5.5'].usd, 0.4);
  assert.equal(by['Sonnet 5.5'].estimated, 0);
  assert.equal(w.models[0].name, 'Sonnet 5.5', 'biggest first');
  assert.equal(store.listTurns(t.id)[2].account, 2);
  assert.deepEqual(w.schemes.map((s) => [s.id, s.name]), [[p.id, p.name]]);
  assert.deepEqual(w.top.map((m) => m.id), [t.id]);
  // A ticket deleted takes its split with it.
  store.deleteTicket(t.id);
  assert.equal(whereItWent(store, null, null, now + 1).total, 0);
});

test('where it went: one payer only, this week against last, by kind of work (#905)', () => {
  const { store, p, t } = setup('kinds');
  const now = Date.now(), day = 86400_000;
  const tm = store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
  const sched = store.createTicket({ project_id: p.id, title: 'audit', permission_mode: 'default', created_by: 'Citadel' });
  store.props.set('minion', t.id, p.id, { type: 'bug' }, 'Cara');
  const turn = (id: number, at: number, usd: number, extra = {}) => store.recordTurn(id, { session_id: `s${Math.random()}`, ended_at: at, session_cost_usd: usd, modelUsage: usage({ 'claude-opus-5-5': usd }), ...extra });
  turn(t.id, now - day, 4);
  turn(t.id, now - 2 * day, 1, { keepalive: true });
  turn(tm.id, now - day, 2);
  turn(sched.id, now - day, 3);
  turn(t.id, now - 8 * day, 6); // last week
  turn(t.id, now - day, 50, { payer: 7 }); // someone else's plan
  const w = whereItWent(store, null, 100, now);
  close(w.total, 10);
  close(w.lastWeek, 6);
  assert.equal(w.weekUsd, 100);
  assert.deepEqual(w.kinds.map((k) => [k.name, k.usd, k.lastWeek]), [['Bug', 4, 6], ['Scheduled runs', 3, 0], ['Taskmasters', 2, 0], ['Keepalive pings', 1, 0]]);
  assert.deepEqual(w.top.map((m) => m.id), [t.id, sched.id, tm.id]);
  close(whereItWent(store, 7, null, now).total, 50);
});

test('model names read like the model picker', () => {
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(modelName('claude-sonnet-5-5+opus-advisor'), 'Sonnet 5.5');
  assert.equal(modelName('opus'), 'Opus');
  assert.equal(modelName('gpt-5.1-codex'), 'gpt-5.1-codex');
});

test("usage_split's text gives shares of one account's week with dollars, and Fable's share each week (#905)", () => {
  const s = (name: string, usd: number, lastWeek: number, estimated = 0) => ({ name, usd, lastWeek, estimated });
  const text = usageSplitText({
    total: 50, lastWeek: 80, weekUsd: 500,
    models: [s('Opus 5.5', 30, 40, 10), s('Fable 5.2', 10, 40), s('Sonnet 5.5', 10, 0)],
    schemes: [s('Citadel', 50, 80)], kinds: [s('Feature', 50, 80)],
    top: [{ id: 3, number: 12, title: 'Big one', scheme: 'Citadel', usd: 20 }],
  });
  assert.match(text, /^Last 7 days: 10% \(\$50\); the 7 before: 16% \(\$80\)\. 100% is one Claude account's weekly limit, about \$500/);
  assert.match(text, /Fable's share of spend: 20% this week, 50% last week\./);
  assert.match(text, /- Opus 5\.5: 6\.0% \(\$30\), last week 8\.0% \(\$40\), \$10 estimated/);
  assert.match(text, /- #12 Big one \(Citadel\): 4\.0% \(\$20\)/);
  assert.match(usageSplitText({ total: 1, lastWeek: 0, weekUsd: null, models: [], schemes: [], kinds: [], top: [] }), /^Last 7 days: \$1\.00; .* dollars at API prices only/);
});
