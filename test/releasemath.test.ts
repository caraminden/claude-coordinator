import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeEta, columnOf, releaseName, shortSpan, STUCK_MS, stuckFor } from '../public/releasemath.js';

const citadel = [{ name: 'line', usual: null }, { name: 'rebase', usual: 5 }, { name: 'test', usual: 90 }, { name: 'deploy', usual: 70 }, { name: 'restart', usual: 40 }, { name: 'live', usual: 0 }];

test('shortSpan rounds to the unit people read, carrying minutes into hours', () => {
  assert.equal(shortSpan(-5000), '0s');
  assert.equal(shortSpan(45_000), '45s');
  assert.equal(shortSpan(3 * 60_000 + 10_000), '3m');
  assert.equal(shortSpan(3599_000), '1h 0m');
  assert.equal(shortSpan(7170_000), '2h 0m');
  assert.equal(shortSpan(3900_000), '1h 5m');
});

test('columnOf: a wait is Waiting, the land line too, then Checks for the first half of the rest, Shipping after', () => {
  assert.equal(columnOf(citadel, { stage: 'deploy', waitingOn: 'a runner' }), 0);
  assert.equal(columnOf(citadel, { stage: 'line', waitingOn: null }), 0);
  assert.equal(columnOf(citadel, { stage: 'rebase', waitingOn: null }), 1);
  assert.equal(columnOf(citadel, { stage: 'test', waitingOn: null }), 1);
  assert.equal(columnOf(citadel, { stage: 'deploy', waitingOn: null }), 2);
  assert.equal(columnOf(citadel, { stage: 'restart', waitingOn: null }), 2);
  assert.equal(columnOf(citadel, { stage: 'unknown', waitingOn: null }), 0);
});

const track = (...names) => [...names, 'live'].map((name) => ({ name, usual: null }));

test('columnOf: a contraption\'s call is Waiting, its build Checks, the drain and restart Shipping, as before #659', () => {
  const contraption = track('call', 'build', 'drain', 'restart');
  assert.equal(columnOf(contraption, { stage: 'call', waitingOn: 'a deploy' }), 0);
  assert.equal(columnOf(contraption, { stage: 'call', waitingOn: null }), 0);
  assert.equal(columnOf(contraption, { stage: 'build', waitingOn: null }), 1);
  assert.equal(columnOf(contraption, { stage: 'drain', waitingOn: 'its running agent turns to end' }), 0);
  assert.equal(columnOf(contraption, { stage: 'drain', waitingOn: null }), 2);
  assert.equal(columnOf(contraption, { stage: 'restart', waitingOn: null }), 2);
});

test('columnOf: a PR whose checks run is in Checks; queued, failed or waiting for a merge go, Waiting (#659)', () => {
  for (const stages of [track('checks', 'merge'), track('checks', 'merge', 'call', 'build', 'drain', 'restart')]) {
    assert.equal(columnOf(stages, { stage: 'checks', waitingOn: null }), 1);
    assert.equal(columnOf(stages, { stage: 'checks', waitingOn: 'its checks wait for a CI runner' }), 0);
    assert.equal(columnOf(stages, { stage: 'checks', waitingOn: 'its checks failed: the minion fixes them' }), 0);
    assert.equal(columnOf(stages, { stage: 'merge', waitingOn: 'PR #12 waits for a go to land' }), 0);
  }
  // Behind PRs, a contraption's call still waits.
  assert.equal(columnOf(track('checks', 'merge', 'call', 'build'), { stage: 'call', waitingOn: null }), 0);
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

test('releaseName: only a try that failed is "a failed try"; a next with no number yet keeps its own name', () => {
  assert.equal(releaseName({ number: 14 }), 'Release 14');
  assert.equal(releaseName({ number: 997, name: 'Build 997' }, false), 'Build 997');
  assert.equal(releaseName({ number: null, outcome: 'failed' }), 'a failed try');
  assert.equal(releaseName({ number: null, name: 'Next build' }), 'Next build');
  assert.equal(releaseName({ number: null }), 'Next release');
  assert.equal(releaseName({ number: null, outcome: 'signed' }), 'a signed build');
});

test('stuckFor: a wait outside the pipeline past half an hour is stuck; work in progress and a place in the land line are not (#1019)', () => {
  const now = 10 * STUCK_MS;
  const runner = { stage: 'desktop', since: now - STUCK_MS - 60_000, waitingOn: 'desktop waiting for a CI runner' };
  assert.equal(stuckFor(runner, now), STUCK_MS + 60_000);
  assert.equal(stuckFor({ ...runner, since: now - 22 * 60_000 }, now), 0, '22 minutes for a runner is still waiting');
  assert.equal(stuckFor({ ...runner, waitingOn: null }, now), 0, 'running, however long, is not a wait');
  assert.equal(stuckFor({ ...runner, stage: 'line', waitingOn: '3rd in line' }, now), 0);
  assert.equal(stuckFor(null, now), 0);
  assert.equal(stuckFor({ ...runner, stage: 'deploy', brief: 'on main, waits for the next land' }, now), 0);
});
