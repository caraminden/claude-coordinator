import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempRoot, type TempRoot } from './helpers.ts';
import { busyNow, settled } from '../src/settled.ts';
import { clearTmpDirLater, dropTurnDir, makeTmpDir, sweepDroppedTurnDirs } from '../src/turn-tmp.ts';

const roots: TempRoot[] = [];
after(async () => {
  for (const r of roots) await r.teardown();
});
const make = () => {
  roots.push(tempRoot('drop-'));
  const root = roots.at(-1)!.dir;
  const dir = join(root, '12-1700000000000');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'f'), 'x');
  return { root, dir };
};

// The rename is off the server's thread too since #2137, so "out of sight at once" is no longer true or needed: nothing
// reads a finished turn's folder by name, and a sweep that meets it mid-way only drops it again.
test('a_finished_turns_folder_is_gone_under_both_names_once_its_delete_ends', async () => {
  const { dir } = make();
  const done = dropTurnDir(dir);
  assert.deepEqual(busyNow(), ['1 folder deletes']);
  await done;
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(`${dir}.gone`), false);
});

test('dropping_a_folder_that_is_already_gone_does_not_throw', async () => {
  const { dir } = make();
  await dropTurnDir(dir);
  await dropTurnDir(dir);
});

test('a_crash_mid_delete_leaves_a_folder_the_async_sweep_removes', async () => {
  const { root, dir } = make();
  const person = join(root, 'person-3');
  mkdirSync(join(person, '5-1.gone'), { recursive: true });
  const keep = join(root, '13-1700000000001');
  mkdirSync(keep);
  mkdirSync(`${dir}.gone`);
  await sweepDroppedTurnDirs(root);
  assert.equal(existsSync(`${dir}.gone`), false);
  assert.equal(existsSync(join(person, '5-1.gone')), false);
  assert.equal(existsSync(keep), true);
});

// #1788: a test's teardown waits on settled() and then deletes the data folder. A delete still running in the background
// there made rmSync({ force: true }) stop half way without an error (it reads the ENOENT of an entry that went
// meanwhile as "already gone"), and the folder stayed behind: close-self, github-link and stuck-list, under load.
test('a_background_folder_delete_counts_as_busy_until_it_ends_so_a_teardown_waits_for_it', async () => {
  const { root, dir } = make();
  void dropTurnDir(dir);
  assert.deepEqual(busyNow(), ['1 folder deletes']);
  assert.deepEqual(await settled(), []);
  assert.equal(existsSync(`${dir}.gone`), false);

  const tmp = await makeTmpDir(join(root, 'tmp'), 7);
  writeFileSync(join(tmp, 'f'), 'x');
  void clearTmpDirLater(join(root, 'tmp'), 7);
  mkdirSync(join(root, '13-1700000000000.gone'));
  void sweepDroppedTurnDirs(root);
  assert.deepEqual(busyNow(), ['2 folder deletes']);
  assert.deepEqual(await settled(), []);
  assert.equal(existsSync(tmp), false);
  assert.equal(existsSync(join(root, '13-1700000000000.gone')), false);
});
