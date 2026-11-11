import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { DatabaseSync } from 'node:sqlite';
import { describeCron, nextRun, parseCron, pinForOwner, runBrief, runMinion, Schedules, SCHEDULES_SCHEMA } from '../src/schedules.ts';

// Local wall-clock times, since schedules run in the server's time zone.
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('nextRun finds the next matching minute, strictly after the given time', () => {
  assert.equal(nextRun('0 3 * * *', at(2026, 10, 28, 2, 59)), at(2026, 10, 28, 3, 0));
  assert.equal(nextRun('0 3 * * *', at(2026, 10, 28, 3, 0)), at(2026, 10, 29, 3, 0));
  assert.equal(nextRun('@hourly', at(2026, 10, 28, 13, 5)), at(2026, 10, 28, 14, 0));
  // 2026-10-28 is a Wednesday: the next Monday 09:00 is Nov 2.
  assert.equal(nextRun('0 9 * * 1', at(2026, 10, 28, 12)), at(2026, 11, 2, 9, 0));
  assert.equal(nextRun('*/15 * * * *', at(2026, 10, 28, 12, 7)), at(2026, 10, 28, 12, 15));
  assert.equal(nextRun('30 6 1 * *', at(2026, 12, 15)), at(2027, 1, 1, 6, 30));
  // 7 is Sunday too; with both day fields set, either one matches (cron's rule).
  assert.equal(nextRun('0 0 * * 7', at(2026, 10, 28)), at(2026, 11, 1));
  assert.equal(nextRun('0 0 13 * 5', at(2026, 10, 28)), at(2026, 10, 30));
  assert.equal(nextRun('0 0 30 2 *', at(2026, 1, 1)), null);
});

/** Run `fn` with the process in another time zone (Node reads TZ again when it is set). */
function inZone(tz: string, fn: () => void) {
  const was = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
}

test('in the hour repeated when clocks go back, nextRun never returns a time at or before the one asked about (#468 S04-3)', () => {
  inZone('America/Los_Angeles', () => {
    // 2026-11-01: 01:00-02:00 comes twice, PDT (08:00 UTC) then PST (09:00 UTC).
    const pst = (h: number, m: number, s = 0) => Date.UTC(2026, 10, 1, h + 8, m, s);
    assert.equal(nextRun('*/10 * * * *', pst(1, 0, 5)), pst(1, 10));
    // A schedule at a set hour runs in the first pass only, as cron's do: not again an hour later (#468 S04-3 review).
    const nextDay = Date.UTC(2026, 10, 2, 9, 30);
    assert.equal(nextRun('30 1 * * *', pst(1, 10)), nextDay);
    assert.equal(nextRun('30 1 * * *', pst(0, 30)), nextDay, 'from its run at 01:30 PDT');
    assert.equal(nextRun('0 1 * * *', pst(0, 0)), Date.UTC(2026, 10, 2, 9, 0), 'from its run at 01:00 PDT');
    assert.equal(nextRun('*/15 1 * * *', pst(0, 45)), Date.UTC(2026, 10, 2, 9, 0), 'from its last run at 01:45 PDT');
    assert.equal(nextRun('30 1 * * *', pst(0, 10)), pst(0, 30), 'its first pass still runs');
    // Every-hour schedules run in both passes.
    assert.equal(nextRun('@hourly', pst(0, 30)), pst(1, 0));
    for (const after of [pst(1, 0, 5), pst(1, 10), pst(1, 59)]) {
      for (const cron of ['*/10 * * * *', '30 1 * * *', '@hourly', '0 3 * * *']) assert.ok(nextRun(cron, after)! > after, `${cron} after ${new Date(after).toISOString()}`);
    }
  });
});

test('a schedule inside the hour skipped when clocks go forward runs at the first minute after the gap (#468 S04-4)', () => {
  inZone('America/Los_Angeles', () => {
    // 2027-03-14: 02:00 PST is 03:00 PDT (10:00 UTC); there is no 02:30.
    const gapEnd = Date.UTC(2027, 2, 14, 10, 0);
    const local = (d: number, h: number, m = 0) => new Date(2027, 2, d, h, m).getTime();
    assert.equal(nextRun('30 2 * * *', local(13, 12)), gapEnd);
    assert.equal(nextRun('0 2 * * 0', local(10, 12)), gapEnd);
    assert.equal(nextRun('0,30 1,2 * * *', local(14, 1, 30)), gapEnd, 'stepping by minutes out of a wanted hour');
    // Not run twice: the next is the day after, at 02:30 again.
    assert.equal(nextRun('30 2 * * *', gapEnd), local(15, 2, 30));
    assert.equal(nextRun('0 4 * * *', local(14, 1)), local(14, 4), 'a schedule not in the gap is untouched');
  });
});

test('parseCron refuses what it cannot read', () => {
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', '*/0 * * * *', 'a * * * *', '* * * * 8']) {
    assert.throws(() => parseCron(bad), Error, bad);
  }
});

test('schedules are stored per scheme with their next run', () => {
  const store = new Store(':memory:');
  const p = store.createProject('One', null).id;
  const s = store.schedules.create({ project_id: p, name: 'Nightly', cron: '0 3 * * *', brief: 'Is main healthy?', type: 'chore', created_by: 'Cara' }, at(2026, 10, 28, 12));
  assert.equal(s.next_run_at, at(2026, 10, 29, 3, 0));
  assert.deepEqual(store.schedules.list(p).map((x) => x.name), ['Nightly']);
  assert.throws(() => store.schedules.create({ project_id: p, name: 'x', cron: 'nope', brief: 'x', type: 'chore', created_by: 'Cara' }), /five cron fields/);
});

test('the panel words common cron shapes and leaves the rest as cron', () => {
  assert.equal(describeCron('0 3 * * *'), 'Every day at 03:00');
  assert.equal(describeCron('0 9 * * 1'), 'Mondays at 09:00');
  assert.equal(describeCron('30 6 1 * *'), 'Monthly on day 1 at 06:30');
  assert.equal(describeCron('5 * * * *'), 'Every hour at :05');
  assert.equal(describeCron('0 9 * * 1-5'), 'Weekdays at 09:00');
  assert.equal(describeCron('*/15 9-17 * * *'), '*/15 9-17 * * *');
});

test('a schedule pauses, resumes from now, comes due once, and records its runs', () => {
  const store = new Store(':memory:');
  const p = store.createProject('One', null).id;
  const t0 = at(2026, 10, 28, 12);
  const s = store.schedules.create({ project_id: p, name: 'Nightly', cron: '0 3 * * *', brief: 'b', type: 'chore', created_by: 'Cara' }, t0);
  assert.equal(store.schedules.update(s.id, { paused: true }, t0).next_run_at, null);
  // Resumed two days later: the next run counts from then, not from when it was paused.
  const t1 = at(2026, 10, 30, 12);
  assert.equal(store.schedules.update(s.id, { paused: false }, t1).next_run_at, at(2026, 10, 31, 3, 0));
  assert.equal(store.schedules.update(s.id, { name: 'Renamed' }, t1).next_run_at, at(2026, 10, 31, 3, 0));
  assert.equal(store.schedules.update(s.id, { cron: '0 9 * * *' }, t1).next_run_at, at(2026, 10, 31, 9, 0));
  assert.throws(() => store.schedules.update(s.id, { cron: '0 25 * * *' }, t1), /out of range/);
  // Down for three days: due once, and the next run counts from the run.
  const late = at(2026, 11, 3, 10);
  assert.deepEqual(store.schedules.due(late).map((x) => x.id), [s.id]);
  assert.deepEqual(store.schedules.due(at(2026, 10, 31, 8, 59)), []);
  const minion = store.createTicket({ project_id: p, title: 'Renamed', permission_mode: 'bypassPermissions', created_by: 'Citadel' }).id;
  store.schedules.ran(s.id, { ticketId: minion }, late);
  let after = store.schedules.get(s.id)!;
  assert.deepEqual([after.last_run_at, after.last_ticket_id, after.next_run_at], [late, minion, at(2026, 11, 4, 9, 0)]);
  assert.deepEqual(store.schedules.due(late), []);
  // A slot that didn't start keeps the last run and says why.
  store.schedules.ran(s.id, { error: 'repo locked' }, at(2026, 11, 4, 9));
  after = store.schedules.get(s.id)!;
  assert.deepEqual([after.last_ticket_id, after.last_error, after.next_run_at], [minion, 'repo locked', at(2026, 11, 5, 9, 0)]);
  store.schedules.ran(s.id, { ticketId: minion }, at(2026, 11, 5, 9));
  assert.equal(store.schedules.get(s.id)!.last_error, null);
  assert.equal(store.schedules.remove(s.id), true);
  assert.deepEqual(store.schedules.list(p), []);
});

test("a run's brief says how to file a quiet run away without a ping, then gives the brief", () => {
  const store = new Store(':memory:');
  const p = store.createProject('One', null).id;
  const s = store.schedules.create({ project_id: p, name: 'Nightly', cron: '0 3 * * *', brief: 'Is main healthy?', type: 'chore', created_by: 'Cara' });
  const text = runBrief(s, 'Oct 29, 2026, 3:00 AM');
  assert.match(text, /^Scheduled run of "Nightly" \(Every day at 03:00/);
  assert.match(text, /close_self/);
  assert.match(text, /leaving state null/);
  assert.ok(text.endsWith('\n\nIs main healthy?'));
});

test("a scheduled run's minion is pinned for the scheme's owner alone, an unpin sticks, and no owner means no pin (#384)", () => {
  const store = new Store(':memory:');
  const cara = store.createUser({ name: 'Cara', login: 'cara' });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const owned = store.createProject('Owned', null, cara.id);
  store.addMember(owned.id, josh.id);
  const run = () => store.createTicket({ project_id: owned.id, kind: 'ticket', title: 'Nightly', permission_mode: 'default', created_by: 'Citadel' });

  const first = run();
  assert.equal(pinForOwner(store, first.id), 'Cara');
  assert.deepEqual(store.pinnedTickets('Cara', owned.id), [first.id]);
  assert.deepEqual(store.pinnedTickets('Josh', owned.id), [], 'only the owner gets the pin');

  // Cara unpins it; the next run pins only its own minion, not the one she unpinned.
  store.setTicketPinned('Cara', first.id, false);
  const second = run();
  pinForOwner(store, second.id);
  assert.deepEqual(store.pinnedTickets('Cara', owned.id), [second.id]);

  // Closing a minion leaves a person's pin as it is, and so this one.
  store.updateTicket(second.id, { status: 'closed' });
  assert.equal(store.isTicketPinned('Cara', second.id), true);

  const ownerless = store.createProject('Ownerless', null);
  const orphan = store.createTicket({ project_id: ownerless.id, kind: 'ticket', title: 'Nightly', permission_mode: 'default', created_by: 'Citadel' });
  assert.equal(pinForOwner(store, orphan.id), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ticket_pins WHERE ticket_id = ?').get(orphan.id)!.n, 0, 'no owner, no pin for anyone');
});

test("a run starts with its schedule's model and effort, null being the scheme's default (#387)", () => {
  const store = new Store(':memory:');
  const p = store.createProject('One', null).id;
  const base = { project_id: p, name: 'Upstream check', cron: '0 9 1 * *', brief: 'b', type: 'chore', created_by: 'Cara' };
  const plain = store.schedules.create(base);
  assert.deepEqual([plain.model, plain.effort], [null, null]);
  const cheap = store.schedules.create({ ...base, model: 'claude-sonnet-5-5', effort: 'medium' });
  assert.deepEqual(runMinion(cheap, { name: 'Cara', disabled_at: null }), { title: 'Upstream check', model: 'claude-sonnet-5-5', effort: 'medium', props: { type: 'chore', assigned: 'Cara' } });
  assert.deepEqual(runMinion(plain, undefined), { title: 'Upstream check', model: null, effort: null, props: { type: 'chore' } });
  // A change to one leaves the other; null goes back to the default.
  assert.deepEqual([store.schedules.update(cheap.id, { effort: 'low' })].map((s) => [s.model, s.effort]), [['claude-sonnet-5-5', 'low']]);
  assert.deepEqual([store.schedules.update(cheap.id, { model: null })].map((s) => [s.model, s.effort]), [[null, 'low']]);
});

test('a schedules table from before model and effort gets both columns, its rows keeping the defaults (#387)', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY); INSERT INTO projects (id) VALUES (1);');
  db.exec(SCHEDULES_SCHEMA.replace('  model TEXT,\n  effort TEXT,\n', ''));
  assert.ok(!(db.prepare('PRAGMA table_info(schedules)').all() as { name: string }[]).some((c) => c.name === 'model'), 'the old shape has no model');
  db.prepare("INSERT INTO schedules (project_id, name, cron, brief, created_by, created_at) VALUES (1, 'Old', '@daily', 'b', 'Cara', 0)").run();
  const old = new Schedules(db).list(1)[0];
  assert.deepEqual([old.name, old.model, old.effort], ['Old', null, null]);
  new Schedules(db); // a second start finds them there
});
