// Activity triggers (#1798): a schedule can run early, after N ships to main or N new minions since its last real run,
// at most once per its minimum gap, never over a working run, with its calendar slot kept as the fallback.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { loadTemplates, runWindow, ScheduledRuns, templateFields, templateVars } from '../src/schedules.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setup() {
  const store = new Store(':memory:');
  const project = store.createProject('Peek Auras', null);
  const made: string[] = [];
  const sends: { id: number; text: string }[] = [];
  const runs = new ScheduledRuns({
    store,
    newMinion: async (p, m, by) => {
      made.push(m.title);
      const t = store.createTicket({ project_id: p.id, title: m.title, permission_mode: 'bypassPermissions', created_by: by });
      return { id: t.id, number: t.number! };
    },
    runner: { emit: () => {}, send: (id: number, _from: string, text: string) => void sends.push({ id, text }), limitWait: () => null, netWait: () => null, killWait: () => null } as any,
    broadcast: () => {},
    by: 'Citadel',
    dataDir: '/data',
  });
  return { store, project, runs, made, sends };
}

/** A monthly schedule made ten days back, its calendar slot a month away whatever today's date. */
function monthly(store: Store, projectId: number, extra: object = {}) {
  const s = store.schedules.create({ project_id: projectId, name: 'Test audit', cron: '0 7 1 * *', brief: 'b', type: 'chore', created_by: 'Cara', trigger_kind: 'ships', trigger_count: 3, ...extra }, Date.now() - 10 * DAY);
  store.db.prepare('UPDATE schedules SET next_run_at = ? WHERE id = ?').run(Date.now() + 30 * DAY, s.id);
  return store.schedules.get(s.id)!;
}
// Runs in the gap and overlap tests happen days back, so ships made since (at the real clock) fall after them.
const BACK = () => Date.now() - 5 * DAY;

/** `n` minions in `projectId` that each shipped to main. */
function ships(store: Store, projectId: number, n: number, text = 'Shipped abc1234: a fix. Risk low: tests.') {
  for (let i = 0; i < n; i++) {
    const t = store.createTicket({ project_id: projectId, title: 'work', permission_mode: 'bypassPermissions', created_by: 'Cara' });
    store.addEvent(t.id, 'note', { text });
  }
}

test('a schedule with a ship trigger runs early once the count is hit, and its brief says what triggered it', async () => {
  const { store, project, runs, made, sends } = setup();
  const s = monthly(store, project.id);
  const slot = s.next_run_at!;
  ships(store, project.id, 2);
  // A minion's second ship (a follow-up) is still one shipped minion.
  store.addEvent(store.listTickets(project.id).at(-1)!.id, 'note', { text: 'Shipped abc1235: a follow-up. Risk low: tests.' });
  // Neither a merge into a build branch nor a ship whose push failed is a ship to main; another scheme's ship isn't ours.
  ships(store, project.id, 1, 'Merged def5678 into build/3: a feeder. Risk low: tests.');
  ships(store, project.id, 1, 'Shipped abc1237 "x": a push. Risk low. Shipped locally, not pushed to origin: the push failed.');
  ships(store, store.createProject('Elsewhere', null).id, 4);
  const now = Date.now() + 1000;
  await runs.runTriggered(now);
  assert.deepEqual(made, [], '2 ships of 3: no run yet');
  ships(store, project.id, 1);
  await runs.runTriggered(now);
  assert.deepEqual(made, ['Test audit'], 'the third ship brings it forward');
  const after = store.schedules.get(s.id)!;
  assert.equal(after.last_run_at, now);
  assert.equal(after.next_run_at, slot, 'its calendar slot stays where it was');
  assert.match(sends[0].text, /\nTriggered: 3 ships since .+ P[SD]T \(runs after 3\)\. Last real run: never \(scheduled .+\); since then 5 minions and 3 ships in this scheme\.\n/);
});

test('a triggered schedule does not run again inside its minimum gap, one day unless set', async () => {
  const { store, project, runs, made } = setup();
  const daily = monthly(store, project.id);
  const short = monthly(store, project.id, { name: 'Code health', trigger_gap_hours: 2 });
  ships(store, project.id, 3);
  const now = BACK();
  await runs.runTriggered(now);
  assert.deepEqual(made.sort(), ['Code health', 'Test audit']);
  ships(store, project.id, 5);
  await runs.runTriggered(now + 1 * HOUR);
  assert.equal(made.length, 2, 'both inside their gap');
  await runs.runTriggered(now + 3 * HOUR);
  assert.deepEqual(made.slice(2), ['Code health'], 'a 2-hour gap is over, a day is not');
  ships(store, project.id, 3);
  await runs.runTriggered(now + DAY + 1);
  assert.deepEqual(made.slice(3).sort(), ['Code health', 'Test audit'], 'a day on, the default gap is over too');
  assert.equal(store.schedules.get(daily.id)!.last_run_at, now + DAY + 1);
  assert.equal(store.schedules.get(short.id)!.trigger_gap_hours, 2);
});

test('a trigger never starts a run over a working one, and says nothing about it', async () => {
  const { store, project, runs, made } = setup();
  const s = monthly(store, project.id);
  ships(store, project.id, 3);
  const now = BACK();
  await runs.runTriggered(now);
  const first = store.schedules.get(s.id)!;
  store.updateTicket(first.last_ticket_id!, { status: 'running' });
  ships(store, project.id, 3);
  await runs.runTriggered(now + DAY + 1);
  assert.deepEqual(made, ['Test audit'], 'the run before is still working');
  const after = store.schedules.get(s.id)!;
  assert.deepEqual([after.last_run_at, after.last_error, after.next_run_at], [now, null, first.next_run_at]);
  store.updateTicket(first.last_ticket_id!, { status: 'idle' });
  await runs.runTriggered(now + DAY + 2);
  assert.equal(made.length, 2, 'once it stops, the trigger runs');
});

test('a triggered schedule still runs on its calendar slot, under its own min_minions gate', async () => {
  const { store, project, runs, made } = setup();
  const s = monthly(store, project.id, { trigger_count: 500 });
  assert.deepEqual([s.trigger_kind, s.trigger_count], ['ships', 500]);
  await runs.run(store.schedules.get(s.id)!, s.next_run_at!);
  assert.deepEqual(made, ['Test audit'], 'no ships, but its slot came');
  const gated = monthly(store, project.id, { name: 'Retro', min_minions: 50, trigger_kind: 'minions', trigger_count: 500 });
  await runs.run(store.schedules.get(gated.id)!, gated.next_run_at!);
  assert.equal(made.length, 1);
  assert.match(store.schedules.get(gated.id)!.last_skip ?? '', /\(needs 50\)$/, 'the quiet gate still skips a calendar slot');
});

test('a schedule with no trigger behaves as before: activity never starts it early', async () => {
  const { store, project, runs, made, sends } = setup();
  const s = monthly(store, project.id, { trigger_kind: null, trigger_count: null });
  assert.deepEqual([s.trigger_kind, s.trigger_count, s.trigger_gap_hours], [null, null, null]);
  ships(store, project.id, 50);
  await runs.runTriggered(Date.now() + 2 * DAY);
  assert.deepEqual(made, []);
  await runs.run(store.schedules.get(s.id)!, s.next_run_at!);
  assert.deepEqual(made, ['Test audit']);
  assert.match(sends[0].text, /\nLast real run: never \(scheduled .+\); since then 50 minions and 50 ships in this scheme\.\n/);
  assert.doesNotMatch(sends[0].text, /Triggered/);
});

test('a minion trigger counts minions as the gate does, across all schemes with gate_scope all; a paused one never runs', async () => {
  const { store, project, runs, made } = setup();
  const other = store.createProject('Mandate', null);
  monthly(store, project.id, { name: 'Digest', trigger_kind: 'minions', trigger_count: 3, gate_scope: 'all' });
  const paused = monthly(store, project.id, { name: 'Paused', trigger_kind: 'minions', trigger_count: 1, gate_scope: 'all' });
  store.schedules.update(paused.id, { paused: true });
  store.createTicket({ project_id: other.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  store.createTicket({ project_id: other.id, title: 'a run', permission_mode: 'bypassPermissions', created_by: 'Citadel' });
  store.createTicket({ project_id: other.id, title: 'x', permission_mode: 'bypassPermissions', created_by: 'Josh' });
  store.createTicket({ project_id: project.id, title: 'y', permission_mode: 'bypassPermissions', created_by: 'Cara' });
  const now = Date.now() + 1000;
  await runs.runTriggered(now);
  assert.deepEqual(made, [], 'two minions count: neither the Taskmaster nor a Citadel run');
  store.createTicket({ project_id: other.id, title: 'z', permission_mode: 'bypassPermissions', created_by: 'Josh' });
  await runs.runTriggered(now);
  assert.deepEqual(made, ['Digest']);
});

test('runDue checks triggers at most once an hour', async () => {
  const { store, project, runs, made } = setup();
  monthly(store, project.id);
  const now = Date.now() + 1000;
  await runs.runDue(now);
  ships(store, project.id, 3);
  await runs.runDue(now + 30_000);
  assert.deepEqual(made, [], 'checked at the first pass, not again for an hour');
  await runs.runDue(now + HOUR);
  assert.deepEqual(made, ['Test audit']);
});

test("the run window counts ships and minions, and a trigger's line leads it", () => {
  const store = new Store(':memory:');
  const p = store.createProject('One', null);
  const s = store.schedules.create({ project_id: p.id, name: 'n', cron: '@daily', brief: 'b', type: 'chore', created_by: 'Cara', gate_scope: 'all', trigger_kind: 'ships', trigger_count: 100 }, Date.UTC(2026, 10, 24, 17));
  assert.equal(runWindow(s, null, 1, 0), 'Last real run: never (scheduled Nov 24, 09:00 PST); since then 1 minion and 0 ships across all schemes.');
  assert.equal(runWindow(s, null, 2, 120, true), 'Triggered: 120 ships since Nov 24, 09:00 PST (runs after 100). Last real run: never (scheduled Nov 24, 09:00 PST); since then 2 minions and 120 ships across all schemes.');
});

test('standard audits carry their template trigger, and opening a database from before them fills it on their rows once', () => {
  const templates = loadTemplates();
  const withTrigger = [...templates.values()].filter((t) => t.trigger_count != null).map((t) => t.slug).sort();
  assert.deepEqual(withTrigger, ['code-health', 'monthly-retro', 'test-audit']);
  for (const slug of withTrigger) {
    const t = templates.get(slug)!;
    assert.ok(t.trigger_kind === 'ships' || t.trigger_kind === 'minions', slug);
    assert.ok(t.trigger_gap_hours == null || t.trigger_gap_hours >= 1, slug);
  }
  const store = new Store(':memory:');
  const p = store.createProject('Genesis Tree', null);
  const row = store.schedules.create({ project_id: p.id, ...templateFields(templates.get('test-audit')!, p, '', templateVars(store, '/tmp', p.id)), created_by: 'Cara' });
  assert.deepEqual([row.trigger_kind, row.trigger_count], [templates.get('test-audit')!.trigger_kind, templates.get('test-audit')!.trigger_count], 'a new row takes it from the template');
  const old = store.schedules.create({ project_id: p.id, name: 'Code health', cron: '0 5 * * *', brief: 'b', type: 'chore', template: 'code-health', created_by: 'Cara' });
  const custom = store.schedules.create({ project_id: p.id, name: 'Custom', cron: '0 5 * * *', brief: 'b', type: 'chore', created_by: 'Cara' });
  store.schedules.fillTriggers(templates);
  assert.equal(store.schedules.get(old.id)!.trigger_count, templates.get('code-health')!.trigger_count, "an existing templated row gets its template's trigger");
  assert.equal(store.schedules.get(custom.id)!.trigger_count, null, 'a custom schedule keeps none');
});
