import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';
import { shipTargets } from '../src/ship-time.ts';

// #1132 review fixes (7c48b1e4): the waterfall keeps each day's 8 slowest ships (not the newest 80 overall), and a
// deleted app's deploys give no row. (The third fix, a stale picked day resetting, is in public/status.js's DOM code.)
const root = mkdtempSync(join(tmpdir(), 'ship-time-replay-'));
after(() => rmSync(root, { recursive: true, force: true }));
const DAYS = ['2026-11-18', '2026-11-19', '2026-11-20'];
const noon = (day: string) => Date.parse(`${day}T20:00:00Z`); // noon Pacific

test('3 days of 12 ships each keep the 8 slowest per day, slowest first', () => {
  const store = new Store(join(root, 'a.db'));
  const p = store.createProject('S', null);
  for (const [d, day] of DAYS.entries()) {
    for (let i = 0; i < 12; i++) {
      const live = noon(day) + i * 1000;
      const took = 100 + ((i * 7) % 12) * 10 + d; // a shuffled spread, distinct per day
      store.addRelease({ project_id: p.id, target: 'app', version: `v${d}${i}`.padEnd(8, '0'), changes: '[]', started_at: live - took * 1000, live_at: live, outcome: 'live', stages: '{}' });
    }
  }
  const [t] = shipTargets(store, DAYS, p.id);
  assert.deepEqual(t.counts, [12, 12, 12]);
  assert.equal(t.ships.length, 24, '8 per day');
  for (const [d, day] of DAYS.entries()) {
    const rows = t.ships.filter((s) => s.at >= noon(day) && s.at < noon(day) + 60_000);
    assert.equal(rows.length, 8, `day ${day} keeps 8`);
    const took = rows.map((s) => s.took);
    assert.deepEqual(
      took,
      [...took].sort((a, b) => b - a),
      'slowest first',
    );
    assert.equal(Math.min(...took), 100 + 4 * 10 + d, 'the 4 fastest were dropped');
  }
});

test('a deploy of an app that is no longer registered gives no app row; a registered one does', () => {
  const store = new Store(join(root, 'b.db'));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const p = store.createProject('S', null, josh.id);
  const c = new Contraptions(store, 's'.repeat(40), join(root, 'keys'));
  c.register({ name: 'alive', title: 'Alive', port: 9301, icon: null, home_scheme: p.id, open_paths: '[]', default_model: null, turn_cap: null });
  for (const name of ['alive', 'gone']) {
    store.addContraptionDeploy({ name, from_sha: 'a'.repeat(40), to_sha: 'b'.repeat(40), by: 'josh', started_at: noon(DAYS[1]) - 60_000, finished_at: noon(DAYS[1]), outcome: 'deployed', stages: '{}', changes: '[]' });
  }
  assert.deepEqual(
    shipTargets(store, DAYS, p.id).map((t) => t.key),
    ['app:alive'],
  );
});
