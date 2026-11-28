// The standard audits (src/standard-audits.ts) share one rule: every scheme gets the row once at boot, the next boot adds
// nothing, and a row someone deleted stays deleted. One table over all four; each audit's own cases stay in its file.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { addAreaReview, addAreaReviews, addArchitectureCheck, addArchitectureChecks, addGlossaryDrift, addGlossaryDrifts, addMemoryCurator, addMemoryCurators } from '../src/standard-audits.ts';

const root = mkdtempSync(join(tmpdir(), 'standard-audits-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

const audits = [
  { template: 'area-review', all: addAreaReviews, one: addAreaReview, paused: true },
  { template: 'glossary-drift', all: addGlossaryDrifts, one: addGlossaryDrift, paused: false },
  { template: 'architecture', all: addArchitectureChecks, one: addArchitectureCheck, paused: false },
  { template: 'memory-curator', all: addMemoryCurators, one: addMemoryCurator, paused: false },
];

for (const a of audits)
  test(`${a.template}: every scheme gets one row once; a deleted one stays deleted`, () => {
    const store = new Store(join(root, `${a.template}.sqlite`));
    const [x, y] = [store.createProject('Theory of Crafting', null), store.createProject('Plain', null)];
    const rows = (id: number) => store.schedules.list(id).filter((s) => s.template === a.template);
    assert.equal(a.all(store, '/data').length, store.listProjects().length);
    for (const p of [x, y]) assert.equal(rows(p.id).length, 1);
    if (a.paused) assert.deepEqual([rows(x.id)[0].paused, rows(x.id)[0].next_run_at], [1, null], 'off by default');
    assert.deepEqual(a.all(store, '/data'), [], 'the next boot adds nothing');
    store.schedules.remove(rows(x.id)[0].id);
    assert.equal(a.one(store, '/data', x.id), null);
    assert.equal(rows(x.id).length, 0, 'someone deleted it: it stays deleted');
    assert.equal(rows(y.id).length, 1, "another scheme's row is untouched");
  });
