// The advisor trial's readout (#817, tools/advisor-trial.ts): each turn counts by the model it ran on and
// the consults between its previous turn's end and its own.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { trialNumbers } from '../tools/advisor-trial.ts';

const root = mkdtempSync(join(tmpdir(), 'advisor-trial-'));
const store = new Store(join(root, 'coordinator.db'));
after(() => {
  store.db.close();
  rmSync(root, { recursive: true, force: true });
});

test('turns count by the model they ran on, consults by turn, and escalations apart', () => {
  const p = store.createProject('P', null);
  const make = (model: string, effort: string) => {
    const t = store.createTicket({ project_id: p.id, title: model, permission_mode: 'bypassPermissions', created_by: 'Cara' });
    store.updateTicket(t.id, { model, effort });
    return t.id;
  };
  const db = store.db;
  const event = (ticket: number, data: object, at: number) => Number(db.prepare(`INSERT INTO events (ticket_id, kind, data, created_at) VALUES (?, 'claude', ?, ?)`).run(ticket, JSON.stringify(data), at).lastInsertRowid);
  const init = (ticket: number, model: string, at: number) => event(ticket, { type: 'system', subtype: 'init', model }, at);
  const consult = (ticket: number, at: number) => event(ticket, { type: 'assistant', message: { content: [{ type: 'server_tool_use', name: 'advisor', input: {} }] } }, at);
  const turn = (ticket: number, eventId: number, cost: number, at: number) => db.prepare(`INSERT INTO turns (ticket_id, event_id, ended_at, cost_usd, session_cost_usd) VALUES (?, ?, ?, ?, ?)`).run(ticket, eventId, at, cost, cost);
  const since = 1000;

  // An advisor minion: a turn before the window (its consult doesn't count), two in it (2 consults, then 0).
  const advised = make('claude-sonnet-5-5+opus-advisor', 'medium');
  init(advised, 'claude-sonnet-5-5', 500);
  turn(advised, consult(advised, 600), 1, 700);
  init(advised, 'claude-sonnet-5-5', 1100);
  consult(advised, 1200);
  turn(advised, consult(advised, 1300), 0.5, 1400);
  turn(advised, init(advised, 'claude-sonnet-5-5', 1500), 0.25, 1600);
  // A minion that consulted, then was moved to Opus: its Opus turn is an escalation, not the trial's or the baseline's.
  const moved = make('claude-opus-5-5', 'medium');
  init(moved, 'claude-sonnet-5-5', 1100);
  turn(moved, consult(moved, 1200), 0.25, 1300);
  turn(moved, init(moved, 'claude-opus-5-5', 1400), 2, 1500);
  // Baseline: a Sonnet-medium minion; and one now on Sonnet medium whose turn ran on Opus, which doesn't count.
  const plain = make('claude-sonnet-5-5', 'medium');
  turn(plain, init(plain, 'claude-sonnet-5-5', 1100), 0.2, 1200);
  const switched = make('claude-sonnet-5-5', 'medium');
  turn(switched, init(switched, 'claude-opus-5-5', 1100), 3, 1200);

  const n = trialNumbers(db, since);
  assert.deepEqual(n.trial, { minions: 2, turns: 3, cost: 1, consults: 3, over3: 0 });
  assert.deepEqual(n.escalated, { minions: 1, turns: 1, cost: 2, consults: 0, over3: 0 });
  assert.deepEqual(n.baseline, { minions: 1, turns: 1, cost: 0.2, consults: 0, over3: 0 });
  assert.deepEqual(
    n.perMinion.map((m) => [m.id, m.consults, m.max, m.escalated]),
    [
      [advised, 2, 2, false],
      [moved, 1, 1, true],
    ],
  );
});
