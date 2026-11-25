// WaitList (src/resumes.ts): one persisted wait per minion; the setting goes when the list empties.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WaitList } from '../src/resumes.ts';

test('WaitList puts, replaces, takes and deletes the setting when empty', () => {
  const m = new Map<string, unknown>();
  const store = { getSetting: <T>(k: string) => m.get(k) as T | undefined, setSetting: (k: string, v: unknown) => void m.set(k, v), deleteSetting: (k: string) => void m.delete(k) };
  const w = new WaitList<{ ticket: number; tries: number }>(store, 'k');
  assert.deepEqual(w.all(), []);
  w.put({ ticket: 1, tries: 1 });
  w.put({ ticket: 2, tries: 1 });
  w.put({ ticket: 1, tries: 2 });
  assert.deepEqual(w.all(), [
    { ticket: 2, tries: 1 },
    { ticket: 1, tries: 2 },
  ]);
  assert.equal(w.get(1)?.tries, 2);
  assert.equal(w.take(9), null);
  assert.deepEqual(w.take(1), { ticket: 1, tries: 2 });
  assert.ok(m.has('k'));
  w.take(2);
  assert.equal(m.has('k'), false);
});
