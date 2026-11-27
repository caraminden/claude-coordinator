import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readEmulatorLease, releaseEmulatorLease } from '../src/emulator-lease.ts';

test('a lease reads until it runs out, and only its own turn releases it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lease-'));
  try {
    assert.equal(await readEmulatorLease(dir), null);
    writeFileSync(join(dir, 'android.lease'), '2000\tPeek #1 (josh)\tthe login page\n');
    writeFileSync(join(dir, 'android.who'), '1990\tPeek #1 (josh)\n');
    assert.deepEqual(await readEmulatorLease(dir, 1_000_000), { who: 'Peek #1 (josh)', what: 'the login page', until: 2_000_000 });
    assert.equal(await readEmulatorLease(dir, 2_000_000), null, 'past its time: nobody has it');
    assert.equal(await releaseEmulatorLease(dir, 'Delve #3', 1_000_000), false);
    assert.equal(await releaseEmulatorLease(dir, 'Peek #1 (josh)', 1_000_000), true);
    assert.equal(await readEmulatorLease(dir, 1_000_000), null);
    assert.equal(readFileSync(join(dir, 'android.who'), 'utf8'), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
