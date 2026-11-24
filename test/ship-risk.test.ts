import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pacificWeek, parseShipNote, shipRiskText, summarize } from '../src/ship-risk.ts';

// The shapes src/land.ts:525 and :548 post.
const SHIPPED = 'Shipped a1b2c3d "#1196: ship risk": One call counts ships. Risk low: only a read tool. Live now.';
const MERGED = 'Merged into build/7: feeder part. Risk medium: touches the parser. Merged into build/7, not live until the build ships.';
const GO = 'Shipped a1b2c3d "x": Changes auth. Risk high: auth. Go: Josh, 2026-11-20 10:00. Waiting for the restart. Deployed app one.';
const PUSH_FAILED = 'Shipped a1b2c3d "x": Did a thing. Risk high. Shipped locally, not pushed to origin: the push failed.';

test('parseShipNote reads each real note shape', () => {
  assert.deepEqual(parseShipNote(SHIPPED), { kind: 'shipped', risk: 'low', go: false, pushFailed: false });
  assert.deepEqual(parseShipNote(MERGED), { kind: 'merged', risk: 'medium', go: false, pushFailed: false });
  assert.deepEqual(parseShipNote(GO), { kind: 'shipped', risk: 'high', go: true, pushFailed: false });
  assert.deepEqual(parseShipNote(PUSH_FAILED), { kind: 'shipped', risk: 'high', go: false, pushFailed: true });
});

test('parseShipNote ignores notes that only mention risk', () => {
  assert.equal(parseShipNote('Shipping parked: CI gave no verdict. Risk high: waiting.'), null);
  assert.equal(parseShipNote('Ready. Risk high: needs a go.'), null);
  assert.equal(parseShipNote('Shipped abc "x": y. Risk high.'), null);
});

test('weeks run Monday to Sunday in Pacific time', () => {
  assert.equal(pacificWeek(Date.parse('2026-11-16T07:59:00Z')), '2026-11-09');
  assert.equal(pacificWeek(Date.parse('2026-11-16T09:00:00Z')), '2026-11-16');
  assert.equal(pacificWeek(Date.parse('2026-11-23T07:59:00Z')), '2026-11-16');
});

test('summarize counts per scheme, week and kind, and names a scheme with no notes', () => {
  const at = Date.parse('2026-11-18T20:00:00Z');
  const notes = [SHIPPED, MERGED, GO, PUSH_FAILED, 'Ready. Risk high: x.'].map((text) => ({ scheme: 2, at, text }));
  const r = summarize(
    notes,
    [
      { id: 2, name: 'Citadel' },
      { id: 5, name: 'Delve' },
    ],
    4,
    Date.parse('2026-11-20T20:00:00Z'),
  );
  assert.deepEqual(r.weeks, ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16']);
  const s = r.rows.find((x) => x.kind === 'shipped')!;
  assert.deepEqual(s.counts, { low: 1, medium: 0, high: 2 });
  assert.equal(s.withGo, 1);
  assert.equal(s.pushFailed, 1);
  assert.deepEqual(r.rows.find((x) => x.kind === 'merged')!.counts, { low: 0, medium: 1, high: 0 });
  const text = shipRiskText(r);
  assert.match(text, /week of 2026-11-16: low 1, medium 0, high 2; high share 67% \(1 with a go, 1 push failed\)/);
  assert.match(text, /No ship notes .*: Delve\./);
});
