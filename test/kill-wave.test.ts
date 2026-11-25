import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { KillWaves, WAVE_GAP_MS, waveText } from '../src/kill-wave.ts';

test('each death in a wave rewrites every note with the count and the container; another place or a later one is its own', () => {
  const store = new Store(':memory:');
  const p = store.createProject('P', null);
  const waves = new KillWaves(store);
  const die = (container: string | null, at: number) => {
    const t = store.createTicket({ project_id: p.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
    const e = store.addEvent(t.id, 'note', { text: 'killed' });
    waves.add(container, at, e);
    return () => JSON.parse(store.getEvent(e.id)!.data).text;
  };
  const a = die('c-2', 1000);
  assert.equal(a(), 'killed', 'one alone says nothing more');
  const b = die('c-2', 4000);
  const host = die(null, 4000);
  const c = die('c-2', 10_000);
  for (const note of [a, b, c]) assert.equal(note(), 'killed\n3 turns were killed together, within 9 s: all ran in the container c-2.');
  assert.equal(host(), 'killed');
  const later = die('c-2', 10_001 + WAVE_GAP_MS);
  assert.equal(later(), 'killed');
  assert.match(waveText(2, 0, null), /within 1 s: each in a unit/);
});
