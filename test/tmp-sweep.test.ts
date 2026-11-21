import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { sweepOrphanTmp } from '../src/tmp-sweep.ts';

// #1339: scratch a killed ship or lint left in the RAM-backed /tmp goes once its maker is gone and it is over an hour old.
const root = mkdtempSync(join(tmpdir(), 'tmp-sweep-'));
after(() => rmSync(root, { recursive: true, force: true }));
const now = Date.now();
const make = (name: string, ageMs: number) => {
  const d = join(root, name);
  mkdirSync(d);
  writeFileSync(join(d, 'x'), 'x');
  utimesSync(d, new Date(now - ageMs), new Date(now - ageMs));
  return d;
};
const HOUR = 3600_000;

test('an orphaned lint, boot-check or ship-train folder goes; a live, young or foreign-named one stays', () => {
  const dead = make('lint-ps1-999999999', 2 * HOUR);
  const boot = make('citadel-boot-check-aB3dEf', 2 * HOUR);
  const train = make('land-train.Xy12Zq', 2 * HOUR);
  const guard = make('land-guard.Ab34Cd', 2 * HOUR);
  const heavy = make('heavy-999999998', 2 * HOUR);
  const live = make(`lint-ps1-${process.pid}`, 2 * HOUR);
  const young = make('citadel-boot-check-young1', 10 * 60_000);
  const other = make('someone-elses-scratch', 5 * HOUR);
  const lookalike = make('lint-ps1-notapid', 5 * HOUR);
  const removed = sweepOrphanTmp([root], now, { proc: '/proc' });
  assert.deepEqual(removed.sort(), [boot, dead, guard, heavy, train].sort());
  for (const d of [live, young, other, lookalike]) assert.equal(existsSync(d), true, d);
  for (const d of [dead, boot, train, guard, heavy]) assert.equal(existsSync(d), false, d);
});

test('a folder a running process works inside stays, and another uid\'s is never touched', () => {
  const busy = make('land-train.Busy01', 2 * HOUR);
  const mine = make('citadel-boot-check-other1', 2 * HOUR);
  const proc = join(root, 'fakeproc');
  mkdirSync(join(proc, '123'), { recursive: true });
  symlinkSync(join(busy, 'sub'), join(proc, '123', 'cwd')); // the fake process's cwd is inside busy
  assert.deepEqual(sweepOrphanTmp([root], now, { proc }), [mine]);
  assert.equal(existsSync(busy), true);
  const foreign = make('citadel-boot-check-foreign', 2 * HOUR);
  assert.deepEqual(sweepOrphanTmp([root], now, { proc, uid: 0 }), []);
  assert.equal(existsSync(foreign), true);
});
