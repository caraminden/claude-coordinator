import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropTurnDir, sweepDroppedTurnDirs } from '../src/turn-tmp.ts';

const make = () => {
  const root = mkdtempSync(join(tmpdir(), 'drop-'));
  const dir = join(root, '12-1700000000000');
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, 'sub', 'f'), 'x');
  return { root, dir };
};

test('a_finished_turns_folder_is_out_of_sight_at_once_and_gone_once_its_delete_ends', async () => {
  const { dir } = make();
  const done = dropTurnDir(dir);
  // Returned before the delete finished: the name is free, the renamed folder still exists.
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(`${dir}.gone`), true);
  await done;
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
