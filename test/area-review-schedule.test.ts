// The weekly area review (#1784, kit/schedules/area-review.md): the seeded-once rule is in standard-audit-schedules.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTemplates } from '../src/schedules.ts';

test('the template runs weekly, gated on activity', () => {
  const t = loadTemplates().get('area-review')!;
  assert.equal(t.cron, '0 6 * * 1', 'weekly');
  assert.equal(t.min_minions, 10);
});
