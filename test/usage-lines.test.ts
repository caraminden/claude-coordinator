import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accountLine, combineWindows } from '../public/claudeusage.js';

// The tooltip's per-account lines use the bar's rule: a window past its reset counts as 0% (#1433).
const now = 1_800_000_000_000;
const w = (utilization: number, resetsAt: number | null) => ({ utilization, resetsAt });
const stale = { n: 1, label: 'server login', usage: { weekly: w(1, now - 1000), session: w(0.5, now - 1000) } };
const fresh = { n: 2, label: 'cara', usage: { weekly: w(0.84, now + 86400000), session: w(0.2, now + 3600000) } };

test('an account whose week already reset shows 0% with a note, so the lines add up to the combined one', () => {
  assert.equal(accountLine(stale, false, now), 'server login: week 0% (week reset, no turns since), 5 hours 0%');
  assert.equal(accountLine(fresh, true, now), '▸ cara: week 84%, 5 hours 20%');
  assert.equal(combineWindows([stale, fresh], 'weekly', now)?.utilization, 0.42);
  assert.equal(accountLine({ n: 3, label: 'new', usage: null }, false, now), 'new: no turns yet');
});
