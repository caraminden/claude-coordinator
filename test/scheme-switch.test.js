import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schemeSwitchHash } from '../public/scheme-switch.js';

test('a Settings tab stays open for the clicked scheme', () => {
  assert.equal(schemeSwitchHash('#/p/3/approvals', 5), '#/p/5/approvals');
  assert.equal(schemeSwitchHash('#/p/3/instructions', 5), '#/p/5/instructions');
  assert.equal(schemeSwitchHash('#/p/3/settings', 5), '#/p/5/settings');
  assert.equal(schemeSwitchHash('#/p/3/usage', 5), '#/p/5/usage');
});
test('admin tabs fall back to the first tab for a non-admin', () => {
  assert.equal(schemeSwitchHash('#/p/3/people', 5, false), '#/p/5/instructions');
  assert.equal(schemeSwitchHash('#/p/3/people', 5, true), '#/p/5/people');
});
test('files, CI and releases keep their place', () => {
  assert.equal(schemeSwitchHash('#/p/3/shared', 5), '#/p/5/shared');
  assert.equal(schemeSwitchHash('#/p/3/ci/history', 5), '#/p/5/ci/history');
  // The Releases page (#1423) opens on the scheme you switch to, Citadel too, and keeps a tab but not a highlighted change.
  assert.equal(schemeSwitchHash('#/p/3/releases/7/12', 2), '#/p/2/releases/2');
  assert.equal(schemeSwitchHash('#/p/3/releases/3/history', 5), '#/p/5/releases/5/history');
  assert.equal(schemeSwitchHash('#/p/3/releases/all/status', 5), '#/p/5/releases/5/status');
  assert.equal(schemeSwitchHash('#/p/3/ci/health', 5), '#/p/5/ci/health');
  assert.equal(schemeSwitchHash('#/p/3/ci', 5), '#/p/5/ci');
  assert.equal(schemeSwitchHash('#/p/3/status', 5), '#/p/5/status');
  assert.equal(schemeSwitchHash('#/p/3/releases/7/12', 5), '#/p/5/releases/5');
});
test('a chat or the Taskmaster goes to the new Taskmaster', () => {
  assert.equal(schemeSwitchHash('#/p/3/t/42', 5), '#/p/5');
  assert.equal(schemeSwitchHash('#/p/3', 5), '#/p/5');
  assert.equal(schemeSwitchHash('#/t/42', 5), '#/p/5');
  assert.equal(schemeSwitchHash('', 5), '#/p/5');
});
test('an Orders page stays open for the clicked scheme', () => {
  assert.equal(schemeSwitchHash('#/p/3/reviews', 5), '#/p/5/reviews');
  assert.equal(schemeSwitchHash('#/p/3/orders', 5), '#/p/5/orders');
  assert.equal(schemeSwitchHash('#/p/3/schedules/9', 5), '#/p/5/schedules');
  assert.equal(schemeSwitchHash('#/p/3/memory/notes.md', 5), '#/p/5/memory');
});

test('CI and Status open on the scheme from a scheme, on all schemes from Home', async () => {
  const { scopedPageHash } = await import('../public/page-scope.js');
  assert.equal(scopedPageHash('ci', 5, 2), '#/p/5/ci');
  assert.equal(scopedPageHash('status', 5, 2), '#/p/5/status');
  assert.equal(scopedPageHash('ci', undefined, 7), '#/p/7/ci/all');
  assert.equal(scopedPageHash('status', null, 7), '#/p/7/status/all');
  assert.equal(schemeSwitchHash('#/p/3/ci/all', 5), '#/p/5/ci/all');
  assert.equal(schemeSwitchHash('#/p/3/status/all', 5), '#/p/5/status/all');
});
