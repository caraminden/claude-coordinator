// The ship watcher (#1268): which runners are on a ship run's job now, from GitHub, sent to the runner agents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queuedOn, ShipWatch, shipsOn, type Ship } from '../src/ci-ships.ts';

/** A fake GitHub: paths to bodies, a 304 for a path asked again with the etag it gave, and every path asked. */
function github(pages: Record<string, unknown>) {
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

function watch(gh: ReturnType<typeof github>, repos = ['caraminden/claude-coordinator', 'caraminden/peek-auras'], as = (_: string): Record<string, string> | null => ({}), first?: () => string | null) {
  const sent: Ship[][] = [];
  const logs: string[] = [];
  const w = new ShipWatch({ repos: () => repos, as, send: (s) => sent.push(s), get: gh.get, log: (l) => logs.push(l), first });
  return { w, sent, logs };
}

test("only a ship branch's running jobs on self-hosted runners count, each with its repo, so same-named runners in two repos stay apart", async () => {
  const gh = github({
    [runs('caraminden/claude-coordinator')]: {
      workflow_runs: [
        { id: 1, head_branch: 'land/1268-x' },
        { id: 2, head_branch: 'main' },
      ],
    },
    [jobs('caraminden/claude-coordinator', 1)]: {
      jobs: [
        { status: 'in_progress', labels: ['self-hosted'], runner_name: 'DESKTOP-G248IJ8' },
        { status: 'queued', runner_name: null },
        { status: 'in_progress', labels: ['ubuntu-latest'], runner_name: 'GitHub Actions 3' },
        { status: 'completed', runner_name: 'DESKTOP-G248IJ8-2' },
      ],
    },
    [runs('caraminden/peek-auras')]: {
      workflow_runs: [
        { id: 7, head_branch: 'land/peek-9' },
        { id: 8, head_branch: 'feature/land/x' },
      ],
    },
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

test("while Citadel's own ship runs, only its runners are ships on that PC, so another scheme's ship is squeezed; alone, that ship counts", async () => {
  const gh = github({
    [runs('caraminden/claude-coordinator')]: { workflow_runs: [{ id: 1, head_branch: 'land/1268-x' }] },
    [jobs('caraminden/claude-coordinator', 1)]: { jobs: [{ status: 'in_progress', labels: ['self-hosted'], runner_name: 'DESKTOP-G248IJ8-linux' }] },
    [runs('caraminden/peek-auras')]: { workflow_runs: [{ id: 7, head_branch: 'land/peek-9' }] },
    [jobs('caraminden/peek-auras', 7)]: { jobs: [{ status: 'in_progress', labels: ['self-hosted'], runner_name: 'DESKTOP-G248IJ8-heavy' }] },
  });
  const { w, sent } = watch(gh, undefined, undefined, () => 'CaraMinden/Claude-Coordinator');
  await w.tick(0);
  gh.pages[runs('caraminden/claude-coordinator')] = { workflow_runs: [] };
  await w.tick(15_000);
  // What the PC's agents are sent, not just what tick returns.
  const pcs = new Map([['desktop-g248ij8', new Set<string>()]]);
  assert.deepEqual(
    sent.map((s) => shipsOn('DESKTOP-G248IJ8', s, pcs)),
    [[{ repo: 'caraminden/claude-coordinator', runner: 'DESKTOP-G248IJ8-linux', first: true }], [{ repo: 'caraminden/peek-auras', runner: 'DESKTOP-G248IJ8-heavy' }]],
  );
});

test("an early next train's run is squeezed while a ship runs; with none, the oldest early run is the ship, being a train's own counted CI (#1568)", async () => {
  const repo = 'caraminden/claude-coordinator';
  const gh = github({
    [runs(repo)]: {
      workflow_runs: [
        { id: 3, head_branch: 'early/ticket/5-x', created_at: '2026-11-22T21:05:00Z' },
        { id: 1, head_branch: 'land/ticket/3-x', created_at: '2026-11-22T21:00:00Z' },
        { id: 2, head_branch: 'early/ticket/4-x', created_at: '2026-11-22T21:02:00Z' },
      ],
    },
    [jobs(repo, 1)]: { jobs: [{ status: 'in_progress', labels: ['self-hosted'], runner_name: 'DESKTOP-linux' }] },
    [jobs(repo, 2)]: { jobs: [{ status: 'in_progress', labels: ['self-hosted'], runner_name: 'DESKTOP-linux-2' }] },
    [jobs(repo, 3)]: { jobs: [{ status: 'in_progress', labels: ['self-hosted'], runner_name: 'DESKTOP-linux-3' }] },
  });
  const { w } = watch(gh, [repo]);
  assert.deepEqual(await w.tick(0), [{ repo, runner: 'DESKTOP-linux' }], 'the ship run alone: both early runs are squeezed');
  gh.pages[runs(repo)] = { workflow_runs: (gh.pages[runs(repo)] as { workflow_runs: { id: number }[] }).workflow_runs.filter((r) => r.id !== 1) };
  assert.deepEqual(await w.tick(15_000), [{ repo, runner: 'DESKTOP-linux-2' }], "ticket/4-x's early run counted once ticket/3-x shipped: it is the ship, and ticket/5-x's stays squeezed");
});

test("each PC gets its own ships only (#1934): by the runners its agents list, else by the runner's name; a ship on no known PC squeezes none", () => {
  const pcs = new Map([
    ['desk', new Set(['a/b/desk-linux', 'a/b/odd name'])],
    ['desk-2', new Set<string>()],
    ['laptop', new Set(['a/b/desk-2-linux'])],
  ]);
  const on = (runner: string, repo = 'a/b') => [...pcs.keys()].filter((h) => shipsOn(h, [{ repo, runner }], pcs).length);
  assert.deepEqual(on('DESK-linux'), ['desk']);
  assert.deepEqual(on('Odd Name'), ['desk'], 'a hand-named runner is known from its agent');
  assert.deepEqual(on('desk-2-linux'), ['laptop'], "the agents' own list beats the name");
  assert.deepEqual(on('desk-2-linux', 'c/d'), [], 'no list yet, and two hostnames fit: nobody is slowed on a guess');
  assert.deepEqual(on('DESK', 'c/d'), ['desk']);
  assert.deepEqual(on('deskside', 'c/d'), []);
  assert.deepEqual(shipsOn('DESK', [{ repo: 'a/b', runner: 'DESK-linux' }], pcs), [{ repo: 'a/b', runner: 'DESK-linux' }], "an agent's hostname in any case");
});

test("a Citadel ship on one PC leaves another scheme's ship on a second PC its share (#1934)", () => {
  const pcs = new Map([
    ['desk', new Set<string>()],
    ['laptop', new Set<string>()],
  ]);
  const ships: Ship[] = [
    { repo: 'c/citadel', runner: 'desk-linux', first: true },
    { repo: 'c/peek', runner: 'desk' },
    { repo: 'c/peek', runner: 'laptop' },
  ];
  assert.deepEqual(shipsOn('desk', ships, pcs), [ships[0]]);
  assert.deepEqual(shipsOn('laptop', ships, pcs), [ships[2]]);
});

// Build 7 M6: waiting CI shrinks the workers (Josh, 2026-11-25), so the watch counts the jobs queued for self-hosted runners.
const queuedRuns = (repo: string) => `repos/${repo}/actions/runs?status=queued&per_page=20`;

test('queued jobs for self-hosted runners are counted per repo, and shared among the PCs that serve it', async () => {
  const repo = 'caraminden/claude-coordinator';
  const gh = github({
    [runs(repo)]: { workflow_runs: [] },
    [queuedRuns(repo)]: { workflow_runs: [{ id: 3 }, { id: 4 }] },
    [jobs(repo, 3)]: {
      jobs: [
        { status: 'queued', labels: ['self-hosted', 'citadel'] },
        { status: 'queued', labels: ['ubuntu-latest'] },
      ],
    },
    [jobs(repo, 4)]: {
      jobs: [
        { status: 'queued', labels: ['self-hosted'] },
        { status: 'completed', labels: ['self-hosted'] },
      ],
    },
  });
  const counts: Map<string, number>[] = [];
  const labels: Map<string, Set<string>>[] = [];
  const w = new ShipWatch({ repos: () => [repo], as: () => ({}), send: () => {}, get: gh.get, log: () => {}, queued: (m, l) => void (counts.push(m), labels.push(l)) });
  await w.tick(0);
  assert.deepEqual([...counts[0]], [[repo, 2]]);
  // #2064: the labels a queued self-hosted job asks for, so a label no runner has gets one; a hosted job's aren't.
  assert.deepEqual(
    [...labels[0]].map(([r, l]) => [r, [...l]]),
    [[repo, ['citadel']]],
  );
  const pcs = new Map([
    ['desk', new Set([`${repo}/desk`])],
    ['laptop', new Set([`${repo}/laptop`, 'caraminden/peek-auras/laptop'])],
    ['other', new Set(['caraminden/peek-auras/other'])],
  ]);
  assert.deepEqual(
    ['desk', 'LAPTOP', 'other'].map((h) => queuedOn(h, counts[0], pcs)),
    [1, 1, 0],
  );
  assert.equal(queuedOn('desk', new Map([[repo, 3]]), pcs), 2, 'rounded up: an odd one shrinks both');
});

test('a queued heavy job (#2120) comes back as one to place, not as waiting CI nor a label to make runners for', async () => {
  const repo = 'caraminden/peek';
  const gh = github({
    [runs(repo)]: { workflow_runs: [] },
    [queuedRuns(repo)]: { workflow_runs: [{ id: 5 }] },
    [jobs(repo, 5)]: {
      jobs: [
        { id: 51, name: 'apk', status: 'queued', labels: ['self-hosted', 'peek-ci-linux', 'citadel-heavy-apk'] },
        { id: 52, name: 'test', status: 'queued', labels: ['self-hosted', 'peek-ci-linux'] },
      ],
    },
  });
  const got: [Map<string, number>, Map<string, Set<string>>][] = [];
  const heavy: unknown[] = [];
  const read: string[][] = [];
  const w = new ShipWatch({ repos: () => [repo], as: () => ({}), send: () => {}, get: gh.get, log: () => {}, queued: (m, l) => void got.push([m, l]), heavy: (h, r) => void (heavy.push(...h), read.push([...r])) });
  await w.tick(0);
  const [counts, labels] = got[0];
  assert.deepEqual(read, [[repo]]);
  assert.deepEqual([...counts], [[repo, 1]]);
  assert.deepEqual([...labels.get(repo)!], ['peek-ci-linux']);
  assert.deepEqual(heavy, [{ repo, id: 51, run: 5, name: 'apk', labels: ['self-hosted', 'peek-ci-linux', 'citadel-heavy-apk'] }]);
});

test("a watch with no queued hook never reads queued runs, and a failed read of them doesn't touch the ships", async () => {
  const repo = 'caraminden/claude-coordinator';
  const gh = github({ [runs(repo)]: { workflow_runs: [{ id: 1, head_branch: 'land/1' }] }, [jobs(repo, 1)]: { jobs: [{ status: 'in_progress', labels: ['self-hosted'], runner_name: 'desk' }] } });
  const plain = watch(gh, [repo]);
  await plain.w.tick(0);
  assert.ok(!gh.asked.some((p) => p.includes('status=queued')));
  const counts: Map<string, number>[] = [];
  const w = new ShipWatch({ repos: () => [repo], as: () => ({}), send: () => {}, get: gh.get, log: () => {}, queued: (m) => void counts.push(m) });
  assert.deepEqual(await w.tick(0), [{ repo, runner: 'desk' }], 'the 404 on queued runs leaves the ship');
  assert.deepEqual([...counts[0]], []);
});
