import assert from 'node:assert/strict';
import { test } from 'node:test';
import { holds } from './holds.ts';

test('holds returns once the witness is in and the check never broke', async () => {
  let n = 0;
  await holds('n stays small', () => n < 10, { after: () => ++n >= 3 });
  assert.equal(n, 3);
});

test('holds fails the moment the check breaks, even before the witness', async () => {
  let n = 0;
  await assert.rejects(
    holds('nothing ran', () => ++n < 2, { after: () => false }),
    /nothing ran: it happened/,
  );
});

test('holds with only a window watches it out, and wants one or the other', async () => {
  const t0 = Date.now();
  await holds('quiet', () => true, { ms: 60 });
  assert.ok(Date.now() - t0 >= 50);
  await assert.rejects(
    holds('x', () => true),
    /give a witness/,
  );
  await assert.rejects(
    holds('slow witness', () => true, { after: () => false, ms: 50 }),
    /Timed out waiting for the witness/,
  );
});
