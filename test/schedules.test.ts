import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { describeCron, nextRun, parseCron } from '../src/schedules.ts';

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

test('parseCron refuses what it cannot read', () => {
  for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', '*/0 * * * *', 'a * * * *', '* * * * 8']) {
    assert.throws(() => parseCron(bad), Error, bad);
  }
});

test('schedules are stored per scheme with their next run', () => {
  const store = new Store(':memory:');
  const p = store.createProject('One', null).id;
  const s = store.schedules.create({ project_id: p, name: 'Nightly', cron: '0 3 * * *', brief: 'Is main healthy?', created_by: 'Cara' }, at(2026, 10, 28, 12));
  assert.equal(s.next_run_at, at(2026, 10, 29, 3, 0));
  assert.deepEqual(store.schedules.list(p).map((x) => x.name), ['Nightly']);
  assert.throws(() => store.schedules.create({ project_id: p, name: 'x', cron: 'nope', brief: 'x', created_by: 'Cara' }), /five cron fields/);
});

test('the panel words common cron shapes and leaves the rest as cron', () => {
  assert.equal(describeCron('0 3 * * *'), 'Every day at 03:00');
  assert.equal(describeCron('0 9 * * 1'), 'Mondays at 09:00');
  assert.equal(describeCron('30 6 1 * *'), 'Monthly on day 1 at 06:30');
  assert.equal(describeCron('5 * * * *'), 'Every hour at :05');
  assert.equal(describeCron('0 9 * * 1-5'), 'Weekdays at 09:00');
  assert.equal(describeCron('*/15 9-17 * * *'), '*/15 9-17 * * *');
});
