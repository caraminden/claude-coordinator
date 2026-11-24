// A post-mortem when a minion goes past four times its budget or a Taskmaster steps its model up (a fix that didn't hold), in every scheme.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetKey } from '../src/minion-budget.ts';
import { Store } from '../src/db.ts';
import { TroubleRetros, troubleKey, SINCE_KEY, postMortemOfKey, PER_TICK } from '../src/effort-retros.ts';

const H = 3_600_000;
const T0 = Date.now(); // updateTicket stamps closed_at with the real clock

function setup(mode: 'act' | 'log-only' = 'act') {
  const store = new Store(':memory:');
  const peek = store.createProject('Peek', null); // a scheme other than Citadel
  store.setSetting(SINCE_KEY, T0 - H);
  const made: { title: string; model: string; effort: string; props: Record<string, string> }[] = [];
  const sent: string[] = [];
  const notes: string[] = [];
  const retros = new TroubleRetros({
    store, by: 'Citadel', now: () => T0 + H, mode,
    newMinion: async (project, m) => {
      made.push(m);
      const x = store.createTicket({ project_id: project.id, title: m.title, permission_mode: 'default', created_by: 'Citadel' });
      return { id: x.id, number: x.number };
    },
    runner: { emit: () => {}, send: (_id: number, _by: string, text: string) => { sent.push(text); } } as any,
    note: (line: string) => { notes.push(line); },
  });
  const minion = (status = 'closed') => {
    const x = store.createTicket({ project_id: peek.id, title: 'feature', permission_mode: 'default', created_by: 'Cara', model: 'claude-sonnet-5-5' } as any);
    store.addPick(x.id, 'claude-sonnet-5-5', 'medium', 'table', 'feature → Sonnet 5.5 medium', T0 - 5 * H);
    store.updateTicket(x.id, { status } as any);
    return x;
  };
  const over = (id: number, at = T0) => store.setSetting(budgetKey(id), { asked: at, woke: at });
  const stepUp = (id: number, at = T0) => store.addPick(id, 'claude-opus-5-5', 'medium', 'Taskmaster', 'changed by the Taskmaster', at);
  return { store, peek, retros, made, sent, notes, minion, over, stepUp };
}

test('a minion past four times its budget gets exactly one post-mortem once it has closed (#1796)', async () => {
  const s = setup();
  const x = s.minion();
  s.over(x.id);
  assert.equal((await s.retros.tick()).length, 1);
  assert.equal(s.made.length, 1);
  assert.equal(s.made[0].model, 'claude-sonnet-5-5');
  assert.equal(s.made[0].effort, 'medium');
  assert.match(s.made[0].title, new RegExp(`Post-mortem: #${x.number}`));
  assert.match(s.sent[0], /Expected cost: ~\$3/);
  const pm = s.store.listTickets(s.peek.id).find((t) => t.title.startsWith('Post-mortem'))!;
  assert.equal(s.store.getSetting<{ estimate: number }>(budgetKey(pm.id))?.estimate, 3, 'its budget alarms count from $3, the cap');
  assert.match(s.sent[0], /past four times its budget/);
  assert.deepEqual(await s.retros.tick(), [], 'a second tick starts nothing');
  assert.equal(s.made.length, 1);
});

test('a minion a Taskmaster stepped up (its fix did not hold) gets exactly one post-mortem (#1796)', async () => {
  const s = setup();
  const x = s.minion();
  s.stepUp(x.id);
  await s.retros.tick();
  await s.retros.tick();
  assert.equal(s.made.length, 1);
  assert.match(s.sent[0], /fix didn't hold|step-up/i);
});

test('a step down, or a change by nobody above the first pick, is not trouble (#1796)', async () => {
  const s = setup();
  const x = s.minion();
  s.store.addPick(x.id, 'claude-sonnet-5-5', 'low', 'Taskmaster', 'cheaper', T0);
  assert.deepEqual(await s.retros.tick(), []);
  const y = s.minion();
  s.store.addPick(y.id, 'claude-sonnet-5-5', 'high', 'Taskmaster', 'more effort', T0);
  assert.equal((await s.retros.tick()).length, 1);
});

test('the default model reads as Opus: default to Sonnet is a step down (#1796)', async () => {
  const s = setup();
  const x = s.minion();
  s.store.addPick(x.id, null, 'medium', 'Taskmaster', 'start', T0 - 4 * H); // the first pick was the table's; a null model follows
  s.store.addPick(x.id, 'claude-sonnet-5-5', 'medium', 'Taskmaster', 'cheaper', T0);
  assert.deepEqual(await s.retros.tick(), []);
});

test('past 2x alone is not trouble: only the 4x mark is (#1796)', async () => {
  const s = setup();
  const x = s.minion();
  s.store.setSetting(budgetKey(x.id), { asked: T0 });
  assert.deepEqual(await s.retros.tick(), []);
});

test('a tick starts at most PER_TICK post-mortems (#1796)', async () => {
  const s = setup();
  for (let i = 0; i < PER_TICK + 2; i++) s.over(s.minion().id);
  assert.equal((await s.retros.tick()).length, PER_TICK);
  assert.equal((await s.retros.tick()).length, 2);
});

test('both triggers on one minion share one post-mortem; each trigger is marked (#1796)', async () => {
  const s = setup();
  const x = s.minion();
  s.over(x.id);
  s.stepUp(x.id);
  await s.retros.tick();
  assert.equal(s.made.length, 1);
  assert.ok(s.store.getSetting(troubleKey(x.id, 'budget')) && s.store.getSetting(troubleKey(x.id, 'stepup')));
});

test('it waits while the minion is still open, and the table pick alone is no trouble (#1796)', async () => {
  const s = setup();
  const open = s.minion('idle');
  s.over(open.id);
  s.minion(); // only its first, table pick
  assert.deepEqual(await s.retros.tick(), []);
  s.store.updateTicket(open.id, { status: 'closed' } as any);
  assert.equal((await s.retros.tick()).length, 1);
});

test('a post-mortem minion never gets one, even past twice its own budget (#1796)', async () => {
  const s = setup();
  const x = s.minion();
  s.over(x.id);
  await s.retros.tick();
  const pm = s.store.listTickets(s.peek.id).find((t) => t.title.startsWith('Post-mortem'))!;
  assert.ok(s.store.getSetting(postMortemOfKey(pm.id)));
  s.store.updateTicket(pm.id, { status: 'closed' } as any);
  s.over(pm.id);
  await s.retros.tick();
  assert.equal(s.made.length, 1);
});

test('trouble from before the first tick is not chased, and the first tick only starts the clock (#1796)', async () => {
  const s = setup();
  s.store.deleteSetting(SINCE_KEY);
  const x = s.minion();
  s.over(x.id, T0 - 10 * H);
  assert.deepEqual(await s.retros.tick(), []);
  assert.ok(s.store.getSetting<number>(SINCE_KEY));
  assert.deepEqual(await s.retros.tick(), []);
  assert.equal(s.made.length, 0);
});

test('log-only notes the post-mortem it would start; acting later starts it (#1796)', async () => {
  const s = setup('log-only');
  const x = s.minion();
  s.over(x.id);
  await s.retros.tick();
  await s.retros.tick();
  assert.equal(s.made.length, 0);
  assert.equal(s.notes.length, 1);
  assert.match(s.notes[0], /would · trouble-retros · start a post-mortem · Peek/);
  const act = new TroubleRetros({ ...(s.retros as any).d, mode: 'act' });
  await act.tick();
  assert.equal(s.made.length, 1);
});
