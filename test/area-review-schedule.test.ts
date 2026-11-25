// The weekly area review (#1784, kit/schedules/area-review.md): every scheme gets one at boot, once, paused; a deleted one stays deleted.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { loadTemplates } from '../src/schedules.ts';
import { addAreaReview, addAreaReviews } from '../src/standard-audits.ts';

const root = mkdtempSync(join(tmpdir(), 'area-review-'));
after(() => rmSync(root, { recursive: true, force: true }));
const rows = (store: Store, id: number) => store.schedules.list(id).filter((s) => s.template === 'area-review');

test('every scheme gets a paused row once; a deleted one stays deleted', () => {
  const store = new Store(join(root, 'db.sqlite'));
  const a = store.createProject('Theory of Crafting', null);
  assert.equal(addAreaReviews(store, '/data').length, store.listProjects().length);
  assert.equal(rows(store, a.id).length, 1);
  assert.equal(rows(store, a.id)[0].paused, 1, 'off by default');
  assert.equal(rows(store, a.id)[0].next_run_at, null);
  assert.deepEqual(addAreaReviews(store, '/data'), [], 'the next boot adds nothing');
  store.schedules.remove(rows(store, a.id)[0].id);
  assert.equal(addAreaReview(store, '/data', a.id), null);
  assert.equal(rows(store, a.id).length, 0);
});

test('the template picks by lines changed since each area’s last review, records the commit, and ends on a card', () => {
  const t = loadTemplates().get('area-review')!;
  assert.equal(t.cron, '0 6 * * 1', 'weekly');
  assert.equal(t.min_minions, 10);
  assert.match(t.body, /git diff --shortstat <baseline> main/);
  assert.match(t.body, /Reviewed commit:/);
  assert.match(t.body, /newest other deep review/, 'an earlier review counts as the baseline');
  assert.match(t.body, /never by single file/);
  assert.match(t.body, /citadel:reviewer/);
  assert.match(t.body, /citadel:finding-checker/);
  assert.match(t.body, /ask_question/);
  assert.match(t.body, /area-review-brief\.md/);
});
