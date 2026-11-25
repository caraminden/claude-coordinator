import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { pickRoot, SHM_NEEDED } from './shm-root.ts';

test('a /dev/shm without room sends the run to normal disk', () => {
  const made: string[] = [];
  try {
    made.push(pickRoot('shm-pick-', SHM_NEEDED, () => 292 * 1024));
    assert.ok(made[0].startsWith(tmpdir()), made[0]);
    made.push(pickRoot('shm-pick-', SHM_NEEDED, () => SHM_NEEDED, '/dev/shm'));
    assert.ok(made[1].startsWith('/dev/shm/') || !existsSync('/dev/shm'), made[1]);
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  }
});
