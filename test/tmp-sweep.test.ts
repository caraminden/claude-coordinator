import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { sweepOrphanTmp, TEST_MIN_AGE_MS } from '../src/tmp-sweep.ts';

// #1339: scratch a killed ship or lint left in the RAM-backed /tmp goes once its maker is gone and it is over an hour old.
const root = mkdtempSync(join(tmpdir(), 'tmp-sweep-'));
after(() => rmSync(root, { recursive: true, force: true }));
const now = Date.now();
let base = root;
const make = (name: string, ageMs: number) => {
  const d = join(base, name);
  mkdirSync(d);
  writeFileSync(join(d, 'x'), 'x');
  utimesSync(d, new Date(now - ageMs), new Date(now - ageMs));
  return d;
};
const HOUR = 3600_000;

test('an orphaned lint, boot-check or ship-train folder goes; a live, young or foreign-named one stays', async () => {
  const dead = make('lint-ps1-999999999', 2 * HOUR);
  const boot = make('citadel-boot-check-aB3dEf', 2 * HOUR);
  const train = make('land-train.Xy12Zq', 2 * HOUR);
  const guard = make('land-guard.Ab34Cd', 2 * HOUR);
  const heavy = make('heavy-999999998', 2 * HOUR);
  const live = make(`lint-ps1-${process.pid}`, 2 * HOUR);
  const young = make('citadel-boot-check-young1', 10 * 60_000);
  const other = make('someone-elses-scratch', 5 * HOUR);
  const lookalike = make('lint-ps1-notapid', 5 * HOUR);
  const removed = await sweepOrphanTmp([root], now, { proc: '/proc' });
  assert.deepEqual(removed.sort(), [boot, dead, guard, heavy, train].sort());
  for (const d of [live, young, other, lookalike]) assert.equal(existsSync(d), true, d);
  for (const d of [dead, boot, train, guard, heavy]) assert.equal(existsSync(d), false, d);
});

test('a folder a running process works inside stays, and another uid\'s is never touched', async () => {
  const busy = make('land-train.Busy01', 2 * HOUR);
  const mine = make('citadel-boot-check-other1', 2 * HOUR);
  const proc = join(root, 'fakeproc');
  mkdirSync(join(proc, '123'), { recursive: true });
  symlinkSync(join(busy, 'sub'), join(proc, '123', 'cwd')); // the fake process's cwd is inside busy
  assert.deepEqual(await sweepOrphanTmp([root], now, { proc }), [mine]);
  assert.equal(existsSync(busy), true);
  const foreign = make('citadel-boot-check-foreign', 2 * HOUR);
  assert.deepEqual(await sweepOrphanTmp([root], now, { proc, uid: 0 }), []);
  assert.equal(existsSync(foreign), true);
});

// #1759: old test leftovers named by a known stem go; young, busy, foreign-owned or unnamed ones stay.
test('old test leftovers go by name; young, busy, other-owner and unnamed ones stay', async () => {
  const DAY = 24 * HOUR;
  base = join(root, 'case3'); // its own folder: the earlier cases' leftovers aren't swept again
  mkdirSync(base);
  const old = 4 * DAY;
  const gone = [
    make('answer-tmp-aB3dEf', old),
    make('kit-shared-0DE0zd', old),
    make('voice-data-00mr1N', old),
    make('voice-04ju2a', old), // bare stem
    make('twi-drafts-2-05QwZ3', old),
    make('peek-wanted-01vjum', old),
  ];
  const shot = join(base, 'uim-busy-1099267-0.png');
  writeFileSync(shot, 'png');
  utimesSync(shot, new Date(now - old), new Date(now - old));
  const stays = [
    make('answer-tmp-young01', TEST_MIN_AGE_MS - HOUR), // too young: a run may still use it
    make('curator-notastem', old), // wrong suffix length
    make('my-own-project-aB3dEf', old), // not a known stem
    make('voice87-profile', old),
    make('voice-backup', old), // six plain lowercase letters: a word, not mkdtemp's
    make('peek-other-aB3dEf', old), // peek stems are named, not the whole prefix
  ];
  const busy = make('memfiles-Busy01', old);
  const proc = join(root, 'fakeproc2');
  mkdirSync(join(proc, '7', 'fd'), { recursive: true });
  symlinkSync(join(busy, 'x'), join(proc, '7', 'fd', '3')); // a process holds a file inside it open
  const removed = await sweepOrphanTmp([base], now, { proc });
  assert.deepEqual(removed.sort(), [...gone, shot].sort());
  for (const d of [...stays, busy]) assert.equal(existsSync(d), true, d);
  assert.deepEqual(await sweepOrphanTmp([base], now, { proc, uid: 0 }), []); // another owner's: never
});
