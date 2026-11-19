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
  assert.equal(schemeSwitchHash('#/p/3/ci', 5), '#/p/5/ci');
  assert.equal(schemeSwitchHash('#/p/3/releases/7/12', 5), '#/p/5/releases/all');
});
test('a chat or the Taskmaster goes to the new Taskmaster', () => {
  assert.equal(schemeSwitchHash('#/p/3/t/42', 5), '#/p/5');
  assert.equal(schemeSwitchHash('#/p/3', 5), '#/p/5');
  assert.equal(schemeSwitchHash('#/t/42', 5), '#/p/5');
  assert.equal(schemeSwitchHash('', 5), '#/p/5');
});
