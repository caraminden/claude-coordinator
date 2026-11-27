// What the CI page reads of a ship's run on GitHub's 20 shards (#2231, ADR 0043): where it ran, its shards, its push to
// verdict, and the ship script's fallbacks off GitHub, a streak of which rings.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fallbackStreak, fallbacksOf, type Job, movedOff, type Run, runShape, shipTimes } from '../src/ci-view.ts';
import { ownFallbackProblems } from '../src/ci-land-gate.ts';
import { parseRetro } from '../src/land-reds.ts';

const T = (hm: string, s = 0) => `2026-11-27T${hm}:${String(s).padStart(2, '0')}Z`;
const run = (id: number, branch: string, at: string, end: string, conclusion: string | null = 'success', extra: Partial<Run> = {}): Run => ({
  id,
  name: 'tests',
  workflow_id: 1,
  head_branch: branch,
  head_sha: `sha${id}`,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  created_at: at,
  updated_at: end,
  event: 'push',
  ...extra,
});
let jid = 0;
const job = (run_id: number, name: string, labels: string[], status: string, conclusion: string | null, end: string | null = null): Job => ({ id: ++jid, run_id, name, status, conclusion, created_at: T('10:00'), started_at: status === 'queued' ? null : T('10:00'), completed_at: end, runner_name: null, labels });
const GH = ['ubuntu-latest'];
const DESK = ['self-hosted', 'citadel-ci-linux'];
/** A ship's run on GitHub as tests.yml makes it: times, the desktop job skipped, and `n` shards. */
const ghRun = (id: number, at: string, end: string, shards: [string, string | null][] = Array(20).fill(['completed', 'success'])) => [
  job(id, 'times', GH, 'completed', 'success', at),
  job(id, 'test', DESK, 'completed', 'skipped', at),
  ...shards.map(([st, c], i) => job(id, `shard (${i})`, GH, st, c, st === 'completed' ? end : null)),
];
const deskRun = (id: number, end: string) => [job(id, 'times', GH, 'completed', 'skipped', null), job(id, 'test', DESK, 'completed', 'success', end)];
const lines = (md: string) => parseRetro(md, '2026-11-27');

test("a ship's run on GitHub reads as GitHub's, with its shards counted and its push to last job; a desktop run as the scheme's own", () => {
  const going = run(1, 'land/ticket/1-a', T('10:00'), T('10:02'), null);
  const shards: [string, string | null][] = [...Array(9).fill(['completed', 'success']), ['completed', 'failure'], ...Array(7).fill(['in_progress', null]), ...Array(3).fill(['queued', null])];
  assert.deepEqual(runShape(going, ghRun(1, T('10:00'), T('10:02'), shards)), { where: 'github', secs: null, shards: { n: 20, started: 17, done: 9, red: 1, queued: 3 } });
  const done = run(2, 'land/ticket/2-b', T('10:00'), T('10:03'));
  assert.deepEqual(runShape(done, ghRun(2, T('10:00'), T('10:03', 23))), { where: 'github', secs: 203, shards: { n: 20, started: 20, done: 20, red: 0, queued: 0 } });
  // The skipped times job ran nowhere: a desktop run is the scheme's own and has no shards.
  assert.deepEqual(runShape(run(3, 'land/ticket/3-c', T('10:00'), T('10:08')), deskRun(3, T('10:08', 2))), { where: 'own', secs: 482, shards: null });
  // A run with no jobs yet ran nowhere; another run's jobs don't count.
  assert.deepEqual(runShape(run(4, 'main', T('10:00'), T('10:00'), null), ghRun(2, T('10:00'), T('10:03'))), { where: null, secs: null, shards: null });
});

test('the fallback lines read as where the ship went and why; a moved run is the one GitHub had when the line came', () => {
  const fb = fallbacksOf(lines(['- 09:48:13Z · ci fallback · ticket/9-z · no citadel-ci-linux runner is online · GitHub calls left: 2882/5000', '- 10:01:05Z · ci to desktop · ticket/1-a · not every shard started within 60 s of the push', '- 10:01:06Z · ship train · ticket/1-a · 2 riders: x y'].join('\n')));
  assert.deepEqual(
    fb.map((f) => [f.to, f.branch, f.why]),
    [
      ['perigee', 'ticket/9-z', 'no citadel-ci-linux runner is online'],
      ['own', 'ticket/1-a', 'not every shard started within 60 s of the push'],
    ],
  );
  assert.equal(movedOff(run(1, 'land/ticket/1-a', T('10:00'), T('10:01', 4), 'cancelled'), fb)?.why, 'not every shard started within 60 s of the push');
  // Another branch, a run that ended long before the line, and the desktop run that took over are not moved.
  assert.equal(movedOff(run(2, 'land/ticket/2-b', T('10:00'), T('10:01'), 'cancelled'), fb), undefined);
  assert.equal(movedOff(run(3, 'land/ticket/1-a', T('09:40'), T('09:45')), fb), undefined);
  assert.equal(movedOff(run(4, 'land/ticket/1-a', T('10:01', 2), T('10:08'), 'success', { event: 'workflow_dispatch' }), fb), undefined, 'dispatched before the line is written');
});

test("push to verdict: each ship run with a verdict; a fallback's from the first push, the run GitHub gave up on not on its own", () => {
  const fb = fallbacksOf(lines("- 10:21:05Z · ci to desktop · ticket/3-c · GitHub's run ended with no verdict"));
  const runs = [
    run(5, 'main', T('10:40'), T('10:41')), // not a ship
    run(4, 'land/ticket/4-d', T('10:30'), T('10:31'), 'cancelled'), // cancelled by hand: no verdict
    run(31, 'land/ticket/3-c', T('10:21', 10), T('10:27'), 'success', { event: 'workflow_dispatch' }),
    run(3, 'land/ticket/3-c', T('10:20'), T('10:21'), 'failure'),
    run(2, 'land/ticket/2-b', T('10:10'), T('10:13'), 'failure'),
    run(1, 'land/ticket/1-a', T('10:00'), T('10:02')),
  ];
  const jobs = [...ghRun(1, T('10:00'), T('10:02', 24)), ...ghRun(2, T('10:10'), T('10:13', 18)), ...ghRun(3, T('10:20'), T('10:21')), ...deskRun(31, T('10:27', 10)), ...ghRun(4, T('10:30'), T('10:31')), ...ghRun(5, T('10:40'), T('10:41'))];
  assert.deepEqual(
    shipTimes(runs, jobs, fb).map((t) => [t.runId, t.value, t.workflow]),
    [
      [1, 144, 'tests on GitHub'],
      [2, 198, 'tests on GitHub'],
      [31, 430, 'tests on own runners'],
    ],
  );
});

test('two ships in a row moved off GitHub ring; a ship with its own verdict on GitHub clears it, one still running does not', () => {
  const fb = fallbacksOf(lines(['- 10:01:05Z · ci to desktop · ticket/1-a · slots taken', '- 10:11:05Z · ci to desktop · ticket/2-b · slots taken'].join('\n')));
  const runs = [run(2, 'land/ticket/2-b', T('10:10'), T('10:11'), 'cancelled'), run(1, 'land/ticket/1-a', T('10:00'), T('10:01'), 'cancelled'), run(0, 'land/ticket/0-z', T('09:50'), T('09:53'))];
  const jobs = [...ghRun(0, T('09:50'), T('09:53')), ...ghRun(1, T('10:00'), T('10:01')), ...ghRun(2, T('10:10'), T('10:11'))];
  const streak = fallbackStreak(runs, jobs, fb);
  assert.deepEqual(
    streak.map((f) => f.branch),
    ['ticket/1-a', 'ticket/2-b'],
  );
  const now = Date.parse(T('10:12'));
  const [p] = ownFallbackProblems(streak, now);
  assert.equal(p.key, 'land:off-github');
  assert.match(p.title, /fell back from GitHub to the desktop on 2 ships in a row: ticket\/1-a \(slots taken\), ticket\/2-b/);
  assert.equal(p.since, Date.parse(T('10:11', 5)));
  assert.equal(p.quiet, true, 'it waits like the perigee fallback: its Taskmaster first, people after');
  assert.deepEqual(ownFallbackProblems(streak.slice(1), now), []);
  // A ship still running on GitHub clears nothing; one with a verdict does.
  const going = [run(3, 'land/ticket/3-c', T('10:20'), T('10:21'), null), ...runs];
  assert.equal(fallbackStreak(going, [...jobs, ...ghRun(3, T('10:20'), T('10:21'), [['in_progress', null]])], fb).length, 2);
  const red = [run(3, 'land/ticket/3-c', T('10:20'), T('10:23'), 'failure'), ...runs];
  assert.deepEqual(fallbackStreak(red, [...jobs, ...ghRun(3, T('10:20'), T('10:23'))], fb), []);
});
