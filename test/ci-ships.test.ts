// The ship watcher (#1268): which runners are on a ship run's job now, from GitHub, sent to the runner agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShipWatch, type Ship } from '../src/ci-ships.ts';

/** A fake GitHub: paths to bodies, a 304 for a path asked again with the etag it gave, and every path asked. */
function github(pages: Record<string, any>) {
  const asked: string[] = [];
  const get = async (path: string, etag: string | null) => {
    asked.push(path);
    const body = pages[path];
    if (body === undefined) return { status: 404, etag: null, body: { message: 'Not Found' } };
    if (typeof body === 'number') return { status: body, etag: null, body: { message: body === 403 ? 'API rate limit exceeded' : '' } };
    const tag = `"${JSON.stringify(body).length}"`;
    return etag === tag ? { status: 304, etag: tag, body: null } : { status: 200, etag: tag, body };
  };
  return { get, asked, pages };
}

const runs = (repo: string) => `repos/${repo}/actions/runs?status=in_progress&per_page=50`;
const jobs = (repo: string, id: number) => `repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`;

function watch(gh: ReturnType<typeof github>, repos = ['caraminden/claude-coordinator', 'caraminden/peek-auras'], as = (_: string): {} | null => ({})) {
  const sent: Ship[][] = [];
  const logs: string[] = [];
  const w = new ShipWatch({ repos: () => repos, as: as as any, send: (s) => sent.push(s), get: gh.get as any, log: (l) => logs.push(l) });
  return { w, sent, logs };
}

test('only a ship branch\'s running jobs on self-hosted runners count, each with its repo, so same-named runners in two repos stay apart', async () => {
  const gh = github({
    [runs('caraminden/claude-coordinator')]: { workflow_runs: [{ id: 1, head_branch: 'land/1268-x' }, { id: 2, head_branch: 'main' }] },
    [jobs('caraminden/claude-coordinator', 1)]: { jobs: [{ status: 'in_progress', labels: ['self-hosted'], runner_name: 'DESKTOP-G248IJ8' }, { status: 'queued', runner_name: null }, { status: 'in_progress', labels: ['ubuntu-latest'], runner_name: 'GitHub Actions 3' }, { status: 'completed', runner_name: 'DESKTOP-G248IJ8-2' }] },
    [runs('caraminden/peek-auras')]: { workflow_runs: [{ id: 7, head_branch: 'land/peek-9' }, { id: 8, head_branch: 'feature/land/x' }] },
    [jobs('caraminden/peek-auras', 7)]: { jobs: [{ status: 'in_progress', labels: ['self-hosted'], runner_name: 'DESKTOP-G248IJ8' }] },
  });
  const { w, sent } = watch(gh);
  assert.deepEqual(await w.tick(0), [
    { repo: 'caraminden/claude-coordinator', runner: 'DESKTOP-G248IJ8' },
    { repo: 'caraminden/peek-auras', runner: 'DESKTOP-G248IJ8' },
  ]);
  assert.equal(sent.length, 1);
  // main's and a non-ship branch's runs are never read for jobs.
  assert.ok(!gh.asked.includes(jobs('caraminden/claude-coordinator', 2)) && !gh.asked.includes(jobs('caraminden/peek-auras', 8)));
});

test('every look sends, an empty list too, so the agents lift the squeeze as soon as the ship ends', async () => {
  const gh = github({
    [runs('a/b')]: { workflow_runs: [{ id: 1, head_branch: 'land/1' }] },
    [jobs('a/b', 1)]: { jobs: [{ status: 'in_progress', labels: ['self-hosted'], runner_name: 'r1' }] },
  });
  const { w, sent } = watch(gh, ['a/b']);
  await w.tick(0);
  await w.tick(1);
  gh.pages[runs('a/b')] = { workflow_runs: [] };
  await w.tick(2);
  assert.deepEqual(sent, [[{ repo: 'a/b', runner: 'r1' }], [{ repo: 'a/b', runner: 'r1' }], []]);
});

test('a repo no scheme has is never read, and a repo whose read fails keeps its last ships for 2 minutes', async () => {
  const gh = github({
    [runs('a/b')]: { workflow_runs: [{ id: 1, head_branch: 'land/1' }] },
    [jobs('a/b', 1)]: { jobs: [{ status: 'in_progress', labels: ['self-hosted'], runner_name: 'r1' }] },
  });
  const { w, sent, logs } = watch(gh, ['a/b', 'not/ours'], (r) => (r === 'not/ours' ? null : {}));
  await w.tick(0);
  assert.ok(!gh.asked.some((p) => p.includes('not/ours')));
  gh.pages[runs('a/b')] = 502;
  await w.tick(15_000);
  await w.tick(119_999);
  assert.deepEqual(sent.at(-1), [{ repo: 'a/b', runner: 'r1' }]);
  assert.equal(logs.length, 1, 'a failing repo is said once, not every 15 seconds');
  await w.tick(120_000);
  assert.deepEqual(sent.at(-1), [], 'still failing after 2 minutes: the ship may have ended unseen, so it lifts');
});

test('a rate limit sends an empty list once, then nothing for 5 minutes, then looks again', async () => {
  const gh = github({
    [runs('a/b')]: { workflow_runs: [{ id: 1, head_branch: 'land/1' }] },
    [jobs('a/b', 1)]: { jobs: [{ status: 'in_progress', labels: ['self-hosted'], runner_name: 'r1' }] },
  });
  const { w, sent, logs } = watch(gh, ['a/b']);
  await w.tick(0);
  gh.pages[runs('a/b')] = 403;
  gh.asked.length = 0;
  assert.equal(await w.tick(15_000), null);
  assert.equal(await w.tick(75_000), null);
  assert.equal(gh.asked.length, 1);
  gh.pages[runs('a/b')] = { workflow_runs: [] };
  assert.deepEqual(await w.tick(15_000 + 5 * 60_000), []);
  assert.deepEqual(sent, [[{ repo: 'a/b', runner: 'r1' }], [], []], 'lifted at the limit, not held through the pause');
  assert.match(logs[0], /slow down/);
});
