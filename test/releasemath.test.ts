import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeEta, columnOf, shortSpan } from '../public/releasemath.js';

const citadel = [{ name: 'line', usual: null }, { name: 'rebase', usual: 5 }, { name: 'test', usual: 90 }, { name: 'deploy', usual: 70 }, { name: 'restart', usual: 40 }, { name: 'live', usual: 0 }];

test('shortSpan rounds to the unit people read, carrying minutes into hours', () => {
  assert.equal(shortSpan(-5000), '0s');
  assert.equal(shortSpan(45_000), '45s');
  assert.equal(shortSpan(3 * 60_000 + 10_000), '3m');
  assert.equal(shortSpan(3599_000), '1h 0m');
  assert.equal(shortSpan(7170_000), '2h 0m');
  assert.equal(shortSpan(3900_000), '1h 5m');
});

test('columnOf: a wait is Waiting, the first stage too, then Checks for the first half of the rest, Shipping after', () => {
  assert.equal(columnOf(citadel, { stage: 'deploy', waitingOn: 'a runner' }), 0);
  assert.equal(columnOf(citadel, { stage: 'line', waitingOn: null }), 0);
  assert.equal(columnOf(citadel, { stage: 'rebase', waitingOn: null }), 1);
  assert.equal(columnOf(citadel, { stage: 'test', waitingOn: null }), 1);
  assert.equal(columnOf(citadel, { stage: 'deploy', waitingOn: null }), 2);
  assert.equal(columnOf(citadel, { stage: 'restart', waitingOn: null }), 2);
  assert.equal(columnOf(citadel, { stage: 'unknown', waitingOn: null }), 0);
});

test('changeEta: the later of the release estimate and this change\'s own stages; none while anything is unknown', () => {
  const next = { eta: 100_000, stages: citadel };
  // At deploy since t=0: deploy 70s + restart 40s + live 0 = 110 s, later than the release's 100 s.
  assert.equal(changeEta(next, { stage: 'deploy', since: 0, usual: 70, waitingOn: null }), 110_000);
  assert.equal(changeEta({ ...next, eta: 200_000 }, { stage: 'deploy', since: 0, usual: 70, waitingOn: null }), 200_000);
  assert.equal(changeEta({ ...next, eta: null }, { stage: 'deploy', since: 0, usual: 70, waitingOn: null }), null);
  assert.equal(changeEta(next, { stage: 'deploy', since: 0, usual: 70, waitingOn: 'a runner' }), null);
  assert.equal(changeEta(next, { stage: 'line', since: 0, usual: null, waitingOn: null }), null);
  const unknownAfter = { eta: 1, stages: [{ name: 'main', usual: 0 }, { name: 'deploy call', usual: null }, { name: 'live', usual: 0 }] };
  assert.equal(changeEta(unknownAfter, { stage: 'main', since: 0, usual: 0, waitingOn: null }), null);
});
