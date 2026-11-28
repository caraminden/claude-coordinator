import assert from 'node:assert/strict';
import { test } from 'node:test';
import { line, needsOf, place, POOL, type PoolJob, type PoolMachine, settle, stepOf } from '../src/runner-pool.ts';

// The pool's line and placing rule (Build 11 P1, specs/one-runner-pool.md sections 3 and 4). Cara, 2026-11-27, #2264's
// card Q2: "Citadel's ships first", "But dont make other schemes or even non-ships wait too long, let them take turns,
// just prio ships and citadel"; and "if a machine doesnt have room, we can wait and load balance, not run the job starved".
const NOW = Date.UTC(2026, 10, 28, 6, 0);
const MIN = 60_000;
const CITADEL = 2;
const PEEK = 5;
const MANDATE = 7;

let nextId = 100;
function job(o: Partial<PoolJob> & { scheme: number }): PoolJob {
  const id = o.id ?? nextId++;
  return { repo: `r/${o.scheme}`, id, run: id, name: `job ${id}`, ship: false, first: false, since: NOW, needs: { os: 'linux', session: false, size: 4 }, ...o };
}
function pc(o: Partial<PoolMachine> & { id: number }): PoolMachine {
  return { name: `pc${o.id}`, priority: null, os: ['windows', 'linux'], session: true, schemes: [CITADEL, PEEK, MANDATE], limit: 16, free: 16, off: null, ...o };
}
const ids = (xs: { job: PoolJob }[]) => xs.map((x) => x.job.id);

test("the line: Citadel's ships, other ships oldest first, then the rest", () => {
  const check = job({ id: 1, scheme: CITADEL, since: NOW - 3 * MIN });
  const peekShipNew = job({ id: 2, scheme: PEEK, ship: true, since: NOW - 1 * MIN });
  const peekShipOld = job({ id: 3, scheme: MANDATE, ship: true, since: NOW - 4 * MIN });
  const citadelShip = job({ id: 4, scheme: CITADEL, ship: true, first: true, since: NOW });
  assert.deepEqual(ids(line([check, peekShipNew, peekShipOld, citadelShip], NOW, new Map())), [4, 3, 2, 1]);
});

test('waiting 10 minutes moves a job up one step, each 10 minutes again', () => {
  assert.equal(stepOf({ ship: false, first: false, since: NOW - (POOL.moveUpMs - 1) }, NOW), 2);
  assert.equal(stepOf({ ship: false, first: false, since: NOW - POOL.moveUpMs }, NOW), 1);
  assert.equal(stepOf({ ship: false, first: false, since: NOW - 2 * POOL.moveUpMs }, NOW), 0);
  assert.equal(stepOf({ ship: true, first: true, since: NOW - 5 * POOL.moveUpMs }, NOW), 0);
  // A check held 10 minutes by a stream of ships goes before the newer ones.
  const check = job({ id: 1, scheme: PEEK, since: NOW - 10 * MIN });
  const ships = [2, 3].map((id) => job({ id, scheme: MANDATE, ship: true, since: NOW - MIN }));
  assert.deepEqual(ids(line([...ships, check], NOW, new Map())), [1, 2, 3]);
  // Another scheme's ship stuck 10 minutes behind Citadel's moves level with it: oldest first.
  const citadel = job({ id: 4, scheme: CITADEL, ship: true, first: true, since: NOW - MIN });
  const peek = job({ id: 5, scheme: PEEK, ship: true, since: NOW - 11 * MIN });
  assert.deepEqual(ids(line([citadel, peek], NOW, new Map())), [5, 4]);
});

test('the rest take turns: the scheme that has waited longest since its last start goes next', () => {
  const peek = [1, 2, 3].map((id) => job({ id, scheme: PEEK, since: NOW - (5 - id) * MIN }));
  const mandate = [4, 5].map((id) => job({ id, scheme: MANDATE, since: NOW - MIN }));
  // Mandate never started, Peek did a minute ago: Mandate first, then they alternate, Peek's last ones at the end.
  assert.deepEqual(ids(line([...peek, ...mandate], NOW, new Map([[PEEK, NOW - MIN]]))), [4, 1, 5, 2, 3]);
  // Neither started: Peek's oldest job is older, so Peek goes first.
  assert.deepEqual(ids(line([...peek, ...mandate], NOW, new Map())), [1, 4, 2, 5, 3]);
});

test('a job starts only where its size is free, and room is taken as jobs are placed', () => {
  const jobs = [1, 2, 3].map((id) => job({ id, scheme: PEEK, since: NOW - id }));
  const out = place({ jobs, machines: [pc({ id: 1, free: 9 })], now: NOW, lastStart: new Map(), warm: new Map() });
  assert.deepEqual(
    out.map((p) => p.machine),
    [1, 1, null],
  );
  assert.equal(out[2].why, 'room on pc1: needs 4 threads, 1 free');
  const short = place({ jobs: [job({ scheme: PEEK, needs: { os: 'linux', session: false, size: 8 } })], machines: [pc({ id: 1, free: 7 })], now: NOW, lastStart: new Map(), warm: new Map() });
  assert.equal(short[0].machine, null);
});

test('a big job gets its room: after 2 minutes, nothing smaller starts on the machine it waits for', () => {
  const big = (since: number) => job({ id: 1, scheme: MANDATE, since, needs: { os: 'linux', session: false, size: 8 } });
  const small = job({ id: 2, scheme: PEEK, since: NOW });
  const machines = [pc({ id: 1, free: 6 })];
  const early = place({ jobs: [big(NOW - POOL.bigHoldMs + 1), small], machines, now: NOW, lastStart: new Map(), warm: new Map() });
  assert.deepEqual(
    early.map((p) => p.machine),
    [null, 1],
    'before 2 minutes the smaller job behind it still starts',
  );
  const late = place({ jobs: [big(NOW - POOL.bigHoldMs), small], machines, now: NOW, lastStart: new Map(), warm: new Map() });
  assert.deepEqual(
    late.map((p) => p.machine),
    [null, null],
  );
  assert.match(late[0].why!, /nothing smaller starts there meanwhile/);
  assert.equal(late[1].why, 'held for a bigger job ahead of it on pc1', "the held job isn't named: it may be another scheme's");
  // Another machine with room still takes the small one.
  const two = place({ jobs: [big(NOW - POOL.bigHoldMs), small], machines: [pc({ id: 1, free: 6, priority: 1 }), pc({ id: 2, free: 4, priority: 2 })], now: NOW, lastStart: new Map(), warm: new Map() });
  assert.deepEqual(
    two.map((p) => p.machine),
    [null, 2],
  );
});

test("a big job never holds a machine it can't ever fit: it waits for one that can, or says it's too big", () => {
  const big = job({ id: 1, scheme: MANDATE, since: NOW - POOL.bigHoldMs, needs: { os: 'linux', session: false, size: 8 } });
  const small = job({ id: 2, scheme: PEEK, since: NOW });
  // pc1 comes first by its owner's order but can only ever lend 4; pc2 can lend 8 and is full: pc2 is the one held.
  const out = place({ jobs: [big, small], machines: [pc({ id: 1, priority: 1, limit: 4, free: 4 }), pc({ id: 2, priority: 2, limit: 8, free: 0 })], now: NOW, lastStart: new Map(), warm: new Map() });
  assert.deepEqual(
    out.map((p) => p.machine),
    [null, 1],
  );
  assert.equal(out[0].why, 'room on pc2: needs 8 threads, 0 free; nothing smaller starts there meanwhile');
  const none = place({ jobs: [big, small], machines: [pc({ id: 1, limit: 4, free: 4 })], now: NOW, lastStart: new Map(), warm: new Map() });
  assert.deepEqual(
    none.map((p) => p.machine),
    [null, 1],
  );
  assert.equal(none[0].why, 'too big for now: needs 8 threads, and the most CI may use on any machine for it is 4');
});

test("the owner's order first, then the warm machine, then the most room", () => {
  const j = () => job({ scheme: PEEK });
  const at = (machines: PoolMachine[], warm?: number) => place({ jobs: [j()], machines, now: NOW, lastStart: new Map(), warm: new Map(warm ? [[PEEK, warm]] : []) })[0].machine;
  assert.equal(at([pc({ id: 1, priority: 2, free: 20 }), pc({ id: 2, priority: 1, free: 4 })]), 2);
  assert.equal(at([pc({ id: 1, free: 20 }), pc({ id: 2, free: 4 })], 2), 2);
  assert.equal(at([pc({ id: 1, free: 8 }), pc({ id: 2, free: 12 })]), 2);
});

test('why a job waits when no machine can take it', () => {
  const why = (j: PoolJob, machines: PoolMachine[]) => place({ jobs: [j], machines, now: NOW, lastStart: new Map(), warm: new Map() })[0].why;
  assert.equal(why(job({ scheme: 99 }), [pc({ id: 1 })]), 'no machine lends CI to its scheme');
  assert.equal(why(job({ scheme: PEEK, needs: { os: 'windows', session: false, size: 4 } }), [pc({ id: 1, os: ['linux'] })]), 'no machine lending its scheme CI runs Windows');
  assert.equal(why(job({ scheme: PEEK, needs: { os: 'windows', session: true, size: 4 } }), [pc({ id: 1, session: false })]), 'no machine lending its scheme CI has a person signed in on Windows');
  assert.equal(why(job({ scheme: PEEK }), [pc({ id: 1, name: 'cara-desktop', off: 'is offline' })]), 'cara-desktop is offline');
  assert.match(why(job({ scheme: PEEK, needs: { os: null, session: false, size: 4 } }), [pc({ id: 1 })])!, /name no Windows or Linux runner/);
  // A machine that is off never takes it, even with room.
  assert.equal(place({ jobs: [job({ scheme: PEEK })], machines: [pc({ id: 1, off: 'is paused' })], now: NOW, lastStart: new Map(), warm: new Map() })[0].machine, null);
});

test("a job's needs come from its labels", () => {
  assert.deepEqual(needsOf(['self-hosted', 'peek-auras-ci'], 'Peek Auras'), { os: 'windows', session: false, size: POOL.sizes.ci });
  assert.deepEqual(needsOf(['self-hosted', 'citadel-ci-linux', 'citadel-ci-linux-side'], 'Citadel'), { os: 'linux', session: false, size: 4 });
  assert.deepEqual(needsOf(['self-hosted', 'citadel-ci-linux-check'], 'Citadel'), { os: 'linux', session: false, size: 4 });
  assert.deepEqual(needsOf(['self-hosted', 'Peek-Auras-Desktop'], 'Peek Auras'), { os: 'windows', session: true, size: 4 });
  assert.deepEqual(needsOf(['self-hosted', 'citadel-ci-linux', 'citadel-ci-linux-long', 'citadel-heavy-suite'], 'Citadel'), { os: 'linux', session: false, size: 6 });
  assert.deepEqual(needsOf(['self-hosted', 'citadel-ci-linux', 'citadel-heavy-desktop'], 'Citadel'), { os: 'linux', session: false, size: 8 });
  assert.deepEqual(needsOf(['self-hosted', 'mandate-ci-linux', 'citadel-heavy-what'], 'Mandate'), { os: 'linux', session: false, size: POOL.sizes.heavyUnknown });
  assert.deepEqual(needsOf(['self-hosted', 'linux', 'x64'], 'Mandate'), { os: 'linux', session: false, size: 4 });
  assert.deepEqual(needsOf(['self-hosted'], 'Mandate'), { os: null, session: false, size: 4 });
});

test('the books follow the job each runner really took: a same-repo swap books neither job twice', () => {
  const r = (name: string, job: number, at = NOW, labels = ['self-hosted', 'peek-auras-ci']) => ({ name, repo: 'o/peek', machine: 1, job, labels, at });
  // s2 was made for job 20 but took job 10 (s1's); s1 hasn't taken one yet: s1 now stands for job 20.
  const a = settle([r('s1', 10), r('s2', 20)], [{ repo: 'O/Peek', id: 10, runner: 's2' }], NOW);
  assert.deepEqual(Object.fromEntries(a.holds), { s1: { machine: 1, job: 20 }, s2: { machine: 1, job: 10 } });
  assert.deepEqual(a.free, []);
  assert.deepEqual(a.reap, []);
  // Both swapped: each holds the other's.
  const b = settle(
    [r('s1', 10), r('s2', 20)],
    [
      { repo: 'o/peek', id: 20, runner: 's1' },
      { repo: 'o/peek', id: 10, runner: 's2' },
    ],
    NOW,
  );
  assert.deepEqual(Object.fromEntries(b.holds), { s1: { machine: 1, job: 20 }, s2: { machine: 1, job: 10 } });
  // s2 took s1's job and s1 is past the 2 minutes: s1 is reaped, and job 20 waits again.
  const c = settle([r('s1', 10, NOW - POOL.reapMs), r('s2', 20)], [{ repo: 'o/peek', id: 10, runner: 's2' }], NOW);
  assert.deepEqual(c.reap, ['s1']);
  assert.deepEqual(c.free, [20]);
  assert.deepEqual(Object.fromEntries(c.holds), { s2: { machine: 1, job: 10 } });
  // Another repo's runner of the same name takes nothing of this one's.
  const d = settle([r('s1', 10)], [{ repo: 'o/mandate', id: 10, runner: 's1' }], NOW);
  assert.deepEqual(Object.fromEntries(d.holds), { s1: { machine: 1, job: 10 } });
  // s2 (a -side runner) took s1's job; s1 (-long) can't take s2's -side job, so it holds none and job 20 waits again.
  const e = settle([r('s1', 10, NOW, ['self-hosted', 'peek-auras-ci-long']), r('s2', 20, NOW, ['self-hosted', 'peek-auras-ci-side'])], [{ repo: 'o/peek', id: 10, runner: 's2' }], NOW);
  assert.deepEqual(Object.fromEntries(e.holds), { s1: { machine: 1, job: null }, s2: { machine: 1, job: 10 } });
  assert.deepEqual(e.free, [20]);
});

// ---------- the watcher (P1: watching only) and the poll that feeds it ----------

import { ShipWatch, type PoolSight, type SeenJob } from '../src/ci-ships.ts';
import type { PoolLook, PoolRow } from '../src/db/runner-pool.ts';
import { RunnerPool, machineOfRunner, type PoolPc } from '../src/runner-pool.ts';
import { Store } from '../src/db.ts';

/** A fake GitHub that answers 304 to a path asked again with the ETag it gave, and counts the calls GitHub would count. */
function github(pages: Record<string, unknown>) {
  const counted: string[] = [];
  const asked: string[] = [];
  const get = async (path: string, etag: string | null) => {
    asked.push(path);
    const body = pages[path];
    if (body === undefined) return { status: 404, etag: null, body: { message: 'Not Found' } };
    const tag = `"${JSON.stringify(body)}"`;
    if (etag === tag) return { status: 304, etag: tag, body: null };
    counted.push(path);
    return { status: 200, etag: tag, body };
  };
  return { get, counted, asked, pages };
}

test('the job poll asks with ETags: an unchanged answer makes no counted call, and a running run is read again only once it changed', async () => {
  const repo = 'caraminden/peek-auras';
  const queuedRuns = `repos/${repo}/actions/runs?status=queued&per_page=20`;
  const runningRuns = `repos/${repo}/actions/runs?status=in_progress&per_page=50`;
  const jobsOf = (id: number) => `repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100`;
  const gh = github({
    [queuedRuns]: { workflow_runs: [{ id: 1, head_branch: 'land/9-x' }] },
    [jobsOf(1)]: { jobs: [{ id: 11, name: 'build', status: 'queued', labels: ['self-hosted', 'peek-auras-ci'], created_at: '2026-11-28T05:00:00Z' }] },
    [runningRuns]: { workflow_runs: [{ id: 2, head_branch: 'main', updated_at: 'a' }] },
    [jobsOf(2)]: {
      jobs: [
        { id: 21, name: 'test', status: 'in_progress', labels: ['self-hosted', 'peek-auras-ci'], runner_name: 'DESK-2', steps: [{ name: 'a', status: 'in_progress' }] },
        { id: 22, name: 'after', status: 'queued', labels: ['self-hosted', 'peek-auras-ci'] },
        { id: 23, name: 'hosted', status: 'queued', labels: ['ubuntu-latest'] },
      ],
    },
  });
  const sights: PoolSight[] = [];
  const w = new ShipWatch({ repos: () => [repo], as: () => ({}), send: () => {}, get: gh.get, log: () => {}, queued: () => {}, pool: (s) => void sights.push(s) });
  await w.tick(0);
  assert.equal(gh.counted.length, 4, 'the first look reads each path once: the in-progress list serves the ships and the pool');
  assert.deepEqual(
    sights[0].jobs.map((j: SeenJob) => [j.id, j.status, j.runner, j.ship]),
    [
      [11, 'queued', null, true],
      [21, 'in_progress', 'DESK-2', false],
      [22, 'queued', null, false],
    ],
  );
  assert.deepEqual([...sights[0].known].sort(), [`${repo}#1`, `${repo}#2`]);
  // Unchanged: every path answers 304, and the running run's jobs aren't asked at all.
  gh.counted.length = 0;
  gh.asked.length = 0;
  await w.tick(POOL.pollMs);
  assert.deepEqual(gh.counted, []);
  assert.ok(!gh.asked.includes(jobsOf(2)), "a running run GitHub says didn't change isn't read again");
  assert.equal(sights[1].jobs.length, 3, 'its jobs still come from the last read');
  // Its steps moved (a new ETag) but the run didn't: read again once POOL.runningMs has gone by.
  (gh.pages[jobsOf(2)] as { jobs: { steps?: unknown }[] }).jobs[0].steps = [{ name: 'a', status: 'completed' }];
  await w.tick(2 * POOL.pollMs);
  assert.deepEqual(gh.counted, []);
  await w.tick(POOL.runningMs + POOL.pollMs);
  assert.deepEqual(gh.counted, [jobsOf(2)]);
  // The run changed (a job ended): read at once.
  gh.counted.length = 0;
  gh.pages[runningRuns] = { workflow_runs: [{ id: 2, head_branch: 'main', updated_at: 'b' }] };
  (gh.pages[jobsOf(2)] as { jobs: { status?: string }[] }).jobs[0].status = 'completed';
  await w.tick(POOL.runningMs + 2 * POOL.pollMs);
  assert.deepEqual(gh.counted.sort(), [jobsOf(2), runningRuns].sort());
  // Run 1 started between the two lists, so both name it: its job is in sight once.
  gh.pages[runningRuns] = {
    workflow_runs: [
      { id: 1, head_branch: 'land/9-x', updated_at: 'c' },
      { id: 2, head_branch: 'main', updated_at: 'b' },
    ],
  };
  await w.tick(POOL.runningMs + 3 * POOL.pollMs);
  assert.deepEqual(sights.at(-1)!.jobs.filter((j) => j.id === 11).length, 1);
});

test("the pool reads every queued run's jobs, past the five the queued counts read", async () => {
  const repo = 'caraminden/peek-auras';
  const runs = Array.from({ length: 7 }, (_, k) => ({ id: k + 1, head_branch: 'main' }));
  const pages: Record<string, unknown> = { [`repos/${repo}/actions/runs?status=queued&per_page=20`]: { workflow_runs: runs }, [`repos/${repo}/actions/runs?status=in_progress&per_page=50`]: { workflow_runs: [] } };
  for (const r of runs) pages[`repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`] = { jobs: [{ id: r.id * 10, name: 'build', status: 'queued', labels: ['self-hosted', 'peek-auras-ci'] }] };
  const gh = github(pages);
  const sights: PoolSight[] = [];
  let counts = new Map<string, number>();
  const w = new ShipWatch({ repos: () => [repo], as: () => ({}), send: () => {}, get: gh.get, log: () => {}, queued: (q) => void (counts = q), pool: (s) => void sights.push(s) });
  await w.tick(0);
  assert.deepEqual(
    sights[0].jobs.map((j) => j.id),
    [10, 20, 30, 40, 50, 60, 70],
  );
  assert.equal(counts.get(repo), 5, 'the queued counts read as before');
});

test("a repo whose scheme isn't on the pool costs GitHub what it did without the pool: five queued runs' jobs, no in-progress list, nothing in the pool's sight", async () => {
  const [off, on] = ['caraminden/peek-auras', 'caraminden/delve'];
  const runs = Array.from({ length: 7 }, (_, k) => ({ id: k + 1, head_branch: 'main' }));
  const pages: Record<string, unknown> = {};
  for (const repo of [off, on]) {
    pages[`repos/${repo}/actions/runs?status=queued&per_page=20`] = { workflow_runs: runs };
    pages[`repos/${repo}/actions/runs?status=in_progress&per_page=50`] = { workflow_runs: [] };
    for (const r of runs) pages[`repos/${repo}/actions/runs/${r.id}/jobs?filter=latest&per_page=100`] = { jobs: [{ id: r.id * 10, name: 'build', status: 'queued', labels: ['self-hosted', 'ci'] }] };
  }
  const gh = github(pages);
  const sights: PoolSight[] = [];
  const w = new ShipWatch({ repos: () => [off, on], as: () => ({}), send: () => {}, get: gh.get, log: () => {}, queued: () => {}, pool: (s) => void sights.push(s), pooled: (repo) => repo === on });
  await w.tick(0);
  const asked = (repo: string) => gh.asked.filter((p) => p.includes(repo));
  // What ShipWatch asked before the pool existed, for the same repo.
  const before = github(pages);
  await new ShipWatch({ repos: () => [off], as: () => ({}), send: () => {}, get: before.get, log: () => {}, queued: () => {} }).tick(0);
  assert.deepEqual(asked(off), before.asked);
  assert.ok(asked(on).length > before.asked.length, 'the pooled repo reads all seven runs and the in-progress list too');
  // Read, with nothing listed: a job the pool still had open for it (its scheme just switched off) ends, never stays open for good.
  assert.deepEqual([...sights[0].repos].sort(), [on, off].sort());
  assert.ok(sights[0].jobs.length === 7 && sights[0].jobs.every((j) => j.repo === on));
  assert.ok([...sights[0].runs].every((r) => r.startsWith(`${on}#`)));
});

test("a failed read isn't passed off as new: the repo isn't counted as read, so no job is ended on it", async () => {
  const repo = 'caraminden/peek-auras';
  const runningRuns = `repos/${repo}/actions/runs?status=in_progress&per_page=50`;
  const gh = github({ [`repos/${repo}/actions/runs?status=queued&per_page=20`]: { workflow_runs: [] }, [runningRuns]: { workflow_runs: [] } });
  const sights: PoolSight[] = [];
  const w = new ShipWatch({ repos: () => [repo], as: () => ({}), send: () => {}, get: gh.get, log: () => {}, queued: () => {}, pool: (s) => void sights.push(s) });
  await w.tick(0);
  assert.ok(sights[0].repos.has(repo));
  delete gh.pages[runningRuns];
  await w.tick(POOL.pollMs);
  assert.ok(!sights[1].repos.has(repo), 'the in-progress list failed: none of its jobs can be called ended');
});

/** An in-memory pool_jobs with the store's three calls. */
function books(rows: PoolRow[] = []) {
  const looks: PoolLook[] = [];
  return {
    looks,
    rows,
    poolLook(l: PoolLook) {
      looks.push(l);
      for (const r of l.seen) {
        const had = rows.find((x) => x.repo === r.repo && x.job_id === r.job_id);
        if (had) had.ended_at = null;
        else rows.push({ ...r, placed_machine: null, placed_at: null, runner: null, ran_on: null, started_at: null, ended_at: null });
      }
      for (const r of l.placed) Object.assign(rows.find((x) => x.repo === r.repo && x.job_id === r.job_id)!, { placed_machine: r.machine, placed_at: l.at });
      for (const r of l.ran) Object.assign(rows.find((x) => x.repo === r.repo && x.job_id === r.job_id)!, { runner: r.runner, ran_on: r.ran_on, started_at: r.started_at });
      for (const r of l.ended) Object.assign(rows.find((x) => x.repo === r.repo && x.job_id === r.job_id)!, { ended_at: l.at });
    },
    poolOpen: () => rows.filter((r) => r.ended_at === null),
    poolLastStarts: () => [],
  };
}

test('the watcher keeps the books, counts running jobs as used room, and logs each would-start once', () => {
  const repo = 'caraminden/peek-auras';
  let now = NOW;
  const logs: string[] = [];
  const store = books();
  const desk: PoolPc = { id: 1, name: 'cara-desktop', priority: null, os: ['windows'], session: true, schemes: [PEEK], limit: 8, off: null, hosts: ['DESK'] };
  const pool = new RunnerPool({ scheme: (r) => (r === repo ? { id: PEEK, name: 'Peek Auras' } : null), first: () => 'caraminden/claude-coordinator', machines: () => [desk], store, log: (l) => logs.push(l), now: () => now });
  const j = (id: number, o: Partial<SeenJob> = {}): SeenJob => ({ repo, id, run: id, name: `job ${id}`, labels: ['self-hosted', 'peek-auras-ci'], ship: false, created: NOW - 60_000, status: 'queued', runner: null, ...o });
  const sight = (jobs: SeenJob[], runs = jobs.map((x) => x.run)): PoolSight => ({ jobs, runs: new Set(runs.map((r) => `${repo}#${r}`)), known: new Set(runs.map((r) => `${repo}#${r}`)), repos: new Set([repo]) });

  let v = pool.pass(sight([j(1), j(2), j(3)]));
  assert.deepEqual(
    v.line.map((x) => [x.id, x.machine, x.why]),
    [
      [1, 'cara-desktop', null],
      [2, 'cara-desktop', null],
      [3, null, 'room on cara-desktop: needs 4 threads, 0 free'],
    ],
  );
  assert.equal(store.rows.length, 3);
  assert.deepEqual(
    store.rows.map((r) => r.placed_machine),
    [1, 1, null],
    'placed where',
  );
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^Runner pool \(watching\): would start caraminden\/peek-auras "job 1" \(job 1\) on cara-desktop, place 1 of 3$/);
  // The same look again: nothing new written or logged.
  now += POOL.pollMs;
  pool.pass(sight([j(1), j(2), j(3)]));
  assert.equal(store.looks.length, 1);
  assert.equal(logs.length, 2);
  // A standing runner on DESK took job 1: booked to the machine, and its 4 threads are in use.
  now += POOL.pollMs;
  v = pool.pass(sight([j(1, { status: 'in_progress', runner: 'DESK-2' }), j(2), j(3)]));
  assert.deepEqual(
    store.rows.find((r) => r.job_id === 1),
    { ...store.rows.find((r) => r.job_id === 1)!, runner: 'DESK-2', ran_on: 1, started_at: now, ended_at: null },
  );
  assert.deepEqual(
    v.line.map((x) => [x.id, x.machine]),
    [
      [2, 'cara-desktop'],
      [3, null],
    ],
  );
  // Job 1's run is gone from the lists: it ended, and its room is free again. Job 3's run is listed but unread: still open.
  now += POOL.pollMs;
  const s = sight([j(2)], [2]);
  s.runs.add(`${repo}#3`);
  v = pool.pass(s);
  assert.equal(store.rows.find((r) => r.job_id === 1)!.ended_at, now);
  assert.equal(store.rows.find((r) => r.job_id === 3)!.ended_at, null);
  assert.equal(v.watching, true);
  // Job 1 listed again (its run had fallen off a list): its row opens again.
  now += POOL.pollMs;
  pool.pass(sight([j(1, { status: 'in_progress', runner: 'DESK-2' }), j(2)], [1, 2, 3]));
  assert.equal(store.rows.find((r) => r.job_id === 1)!.ended_at, null);
});

test('ended pool_jobs rows go after POOL.keepMs; open rows and recent ended ones stay', () => {
  const store = new Store(':memory:');
  const job = (job_id: number) => ({ repo: 'o/peek', job_id, run_id: 9, project_id: PEEK, name: `job ${job_id}`, labels: '[]', size: 4, ship: 0, first_seen: NOW });
  store.poolLook({ seen: [job(1), job(2), job(3)], ran: [], placed: [], ended: [{ repo: 'o/peek', job_id: 1 }], at: NOW });
  store.poolLook({ seen: [], ran: [], placed: [], ended: [{ repo: 'o/peek', job_id: 2 }], at: NOW + POOL.keepMs });
  store.poolPrune(NOW + 1);
  const left = () => (store.db.prepare('SELECT job_id FROM pool_jobs ORDER BY job_id').all() as { job_id: number }[]).map((r) => r.job_id);
  assert.deepEqual(left(), [2, 3], 'job 1 ended a keepMs ago; 2 just now; 3 is open');
});

// P3 (#2275): the pool starts one-job runners for a scheme switched to it; the rest it only watches.
const TOC = 9;
function poolWorld(o: { pooled?: Set<number>; standing?: Set<string>; limit?: number } = {}) {
  const toc = 'caraminden/theory-of-crafting';
  const peek = 'caraminden/peek-auras';
  let now = NOW;
  const logs: string[] = [];
  const starts: { repo: string; slot: number; labels: string[]; job: number; machine: number; os: string }[] = [];
  const answers: ((r: { ok: boolean; output: string } | Error) => void)[] = [];
  const store = books();
  const desk: PoolPc = { id: 1, name: 'cara-desktop', priority: null, os: ['windows', 'linux'], session: true, schemes: [TOC, PEEK], limit: o.limit ?? 8, off: null, hosts: ['DESK'] };
  const pool = new RunnerPool({
    scheme: (r) => (r === toc ? { id: TOC, name: 'Theory of Crafting' } : r === peek ? { id: PEEK, name: 'Peek Auras' } : null),
    first: () => 'caraminden/claude-coordinator',
    machines: () => [desk],
    store,
    log: (l) => logs.push(l),
    now: () => now,
    pooled: (id) => (o.pooled ?? new Set([TOC])).has(id),
    standing: (r) => (o.standing?.has(r) ? ['on cara-desktop'] : []),
    start: (ask) => {
      starts.push({ repo: ask.repo, slot: ask.slot, labels: ask.labels, job: ask.job, machine: ask.machine, os: ask.os });
      return new Promise((resolve, reject) => answers.push((r) => (r instanceof Error ? reject(r) : resolve({ name: '', ...r }))));
    },
  });
  const j = (repo: string, id: number, o2: Partial<SeenJob> = {}): SeenJob => ({ repo, id, run: id, name: `job ${id}`, labels: repo === toc ? ['self-hosted', 'theory-of-crafting-ci-linux'] : ['self-hosted', 'peek-auras-ci'], ship: false, created: NOW - 60_000, status: 'queued', runner: null, ...o2 });
  const sight = (jobs: SeenJob[]): PoolSight => {
    const runs = new Set(jobs.map((x) => `${x.repo}#${x.run}`));
    return { jobs, runs, known: new Set(runs), repos: new Set([toc, peek]) };
  };
  return { toc, peek, pool, starts, answers, logs, j, sight, tick: (ms: number) => (now += ms), desk };
}

test("a pool scheme's placed job gets a one-job runner in the lowest free slot, with its exact labels, booked so the next look starts no second (Build 11 P3)", async () => {
  const w = poolWorld();
  let v = w.pool.pass(w.sight([w.j(w.toc, 11), w.j(w.toc, 12), w.j(w.toc, 13)]));
  assert.deepEqual(
    w.starts.map((s) => [s.job, s.slot, s.os, s.machine]),
    [
      [11, 1, 'linux', 1],
      [12, 2, 'linux', 1],
    ],
    'two fit in 8 threads, slots 1 and 2',
  );
  assert.deepEqual(w.starts[0].labels, ['self-hosted', 'theory-of-crafting-ci-linux'], 'the runner gets exactly the labels the job asks for');
  assert.deepEqual(
    v.line.map((x) => [x.id, x.place, x.starting, x.machine, x.pool]),
    [
      [11, 0, true, 'cara-desktop', true],
      [12, 0, true, 'cara-desktop', true],
      [13, 1, false, null, true],
    ],
  );
  assert.match(v.line[2].why!, /^room on cara-desktop: needs 4 threads, 0 free/, 'the starting runners hold their room');
  assert.deepEqual(
    v.machines[0].running.map((r) => [r.name, r.starting, r.pool]),
    [
      ['job 11', true, true],
      ['job 12', true, true],
    ],
  );
  assert.equal(v.machines[0].used, 8);
  // The same look again: nothing new is started.
  w.tick(POOL.pollMs);
  w.pool.pass(w.sight([w.j(w.toc, 11), w.j(w.toc, 12), w.j(w.toc, 13)]));
  assert.equal(w.starts.length, 2);
  // Job 11 runs on its runner: its room is counted once, from the running job. Job 12's runner ends without a job (the agent's report): its slot and room are free again, so job 12 starts again in slot 2, and 13 still has no room.
  w.pool.onSlot({ runner: 'pool-m1-l2-j12', event: 'stopped' });
  w.tick(POOL.pollMs);
  v = w.pool.pass(w.sight([w.j(w.toc, 11, { status: 'in_progress', runner: 'pool-m1-l1-j11' }), w.j(w.toc, 12), w.j(w.toc, 13)]));
  assert.deepEqual(
    w.starts.slice(2).map((s) => [s.job, s.slot]),
    [[12, 2]],
  );
  assert.equal(v.machines[0].used, 8);
  assert.deepEqual(
    v.machines[0].running.map((r) => [r.name, r.starting]),
    [
      ['job 11', false],
      ['job 12', true],
    ],
  );
  // Job 11 ends: its runner is forgotten with it, and job 13 starts in slot 1, the warm one.
  w.tick(POOL.pollMs);
  w.pool.pass(w.sight([w.j(w.toc, 12), w.j(w.toc, 13)]));
  assert.deepEqual(w.starts.at(-1), { ...w.starts.at(-1)!, job: 13, slot: 1 });
});

test("a runner that doesn't start frees its room, says why on the job, and is tried again after a minute (Build 11 P3)", async () => {
  const w = poolWorld();
  w.pool.pass(w.sight([w.j(w.toc, 11)]));
  w.answers[0]({ ok: false, output: 'starting slot\nthe runner copy is 30 days old\n' });
  await new Promise((r) => setImmediate(r)); // timing-ok: lets the start's answer settle
  w.tick(POOL.pollMs);
  let v = w.pool.pass(w.sight([w.j(w.toc, 11)]));
  assert.equal(w.starts.length, 1, 'not again within the minute');
  assert.match(v.line[0].why!, /its runner didn't start \(the runner copy is 30 days old\)/);
  assert.equal(v.machines[0].used, 0);
  assert.ok(w.logs.some((l) => l.startsWith("Runner pool: couldn't start pool-m1-l1-j11")));
  w.tick(POOL.startAgainMs);
  v = w.pool.pass(w.sight([w.j(w.toc, 11)]));
  assert.equal(w.starts.length, 2);
  assert.equal(v.line[0].starting, true);
});

test("a standing scheme's jobs are only watched and take none of the pool's room; standing runners' running jobs do (Build 11 P3)", () => {
  const w = poolWorld();
  // Peek's two waiting jobs are older but on standing runners: Theory of Crafting's job still starts. Taking turns, ToC's job
  // comes between Peek's two, so to the watcher Peek's second has no room left.
  const v = w.pool.pass(w.sight([w.j(w.peek, 1, { created: NOW - 5 * 60_000 }), w.j(w.peek, 2, { created: NOW - 4 * 60_000 }), w.j(w.toc, 11)]));
  assert.deepEqual(
    w.starts.map((s) => s.job),
    [11],
  );
  assert.deepEqual(
    v.line.filter((x) => !x.pool).map((x) => [x.id, x.machine]),
    [
      [1, 'cara-desktop'],
      [2, null],
    ],
    'Peek still shows where the pool would start it',
  );
  assert.ok(w.logs.some((l) => /^Runner pool \(watching\): would start caraminden\/peek-auras "job 1"/.test(l)));
  // Peek's standing runner on DESK runs job 1: 4 of the 8 threads, so with ToC's starting one the machine is full.
  w.tick(POOL.pollMs);
  const v2 = w.pool.pass(w.sight([w.j(w.peek, 1, { status: 'in_progress', runner: 'DESK-2' }), w.j(w.toc, 11), w.j(w.toc, 12)]));
  assert.equal(w.starts.length, 1, "no room for ToC's second job");
  assert.match(v2.line.find((x) => x.id === 12)!.why!, /0 free/);
  assert.deepEqual(
    v2.machines[0].running.map((r) => [r.repo, r.pool]),
    [
      [w.peek, false],
      [w.toc, true],
    ],
  );
});

test('a pool scheme whose standing runners are still on a PC starts nothing yet, and says so (Build 11 P3)', () => {
  const w = poolWorld({ standing: new Set(['caraminden/theory-of-crafting']) });
  const v = w.pool.pass(w.sight([w.j(w.toc, 11)]));
  assert.equal(w.starts.length, 0);
  assert.match(v.line[0].why!, /standing runners are still there \(on cara-desktop\); the pool starts its jobs once they're gone/);
  assert.equal(v.line[0].pool, true);
});

test("which machines could take a pool scheme's jobs: lending it CI, not off, and able to run each job it has waiting", () => {
  const w = poolWorld();
  assert.deepEqual(w.pool.able(TOC), ['cara-desktop']);
  assert.deepEqual(w.pool.able(42), []);
  // A Windows-only PC can't take ToC's waiting Linux job, so ToC isn't fine there; nor is a job that needs a session (P6).
  w.desk.os = ['windows'];
  w.pool.pass(w.sight([w.j(w.toc, 11)]));
  assert.deepEqual(w.pool.able(TOC), []);
  w.desk.os = ['windows', 'linux'];
  w.pool.pass(w.sight([w.j(w.toc, 11)]));
  assert.deepEqual(w.pool.able(TOC), ['cara-desktop']);
  w.pool.pass(w.sight([w.j(w.toc, 12, { labels: ['self-hosted', 'theory-of-crafting-desktop'] })]));
  assert.deepEqual(w.pool.able(TOC), []);
  w.pool.pass(w.sight([]));
  w.desk.off = 'is offline';
  assert.deepEqual(w.pool.able(TOC), []);
});

test('a runner that took its job but is never seen running on it (too short to read, or its end report lost) gives its room back after a while (Build 11 P3)', () => {
  const w = poolWorld();
  w.pool.pass(w.sight([w.j(w.toc, 11)]));
  assert.equal(w.starts.length, 1);
  w.pool.onSlot({ runner: 'pool-m1-l1-j11', event: 'took' });
  // The job is gone from the queued list and was never read in progress; the runner's record keeps its room for now.
  w.tick(POOL.pollMs);
  assert.equal(w.pool.pass(w.sight([])).machines[0].used, 4);
  w.tick(POOL.tookMs);
  const v = w.pool.pass(w.sight([]));
  assert.equal(v.machines[0].used, 0);
  assert.deepEqual(v.machines[0].running, []);
});

test("the pool's books in the real table: seen, placed, ran, ended, seen again, and each scheme's last start", () => {
  const store = new Store(':memory:');
  const seen = (job_id: number, project_id: number) => ({ repo: 'o/peek', job_id, run_id: 9, project_id, name: `job ${job_id}`, labels: '["self-hosted"]', size: 4, ship: 0, first_seen: NOW });
  store.poolLook({ seen: [seen(1, PEEK), seen(2, PEEK), seen(3, MANDATE)], ran: [], placed: [{ repo: 'o/peek', job_id: 1, machine: 4 }], ended: [], at: NOW });
  store.poolLook({
    seen: [],
    ran: [
      { repo: 'o/peek', job_id: 1, runner: 'DESK-1', ran_on: 4, started_at: NOW + 1 },
      { repo: 'o/peek', job_id: 2, runner: 'DESK-2', ran_on: 6, started_at: NOW + 2 },
    ],
    placed: [],
    ended: [{ repo: 'o/peek', job_id: 3 }],
    at: NOW + 3,
  });
  const row = (id: number) => store.poolOpen().find((r) => r.job_id === id);
  assert.deepEqual({ ...row(1)!, labels: JSON.parse(row(1)!.labels) }, { ...seen(1, PEEK), labels: ['self-hosted'], placed_machine: 4, placed_at: NOW, runner: 'DESK-1', ran_on: 4, started_at: NOW + 1, ended_at: null });
  assert.equal(row(3), undefined, 'ended');
  // A second start doesn't move started_at; a job seen again after it ended opens again, the rest of its row kept.
  store.poolLook({ seen: [seen(3, MANDATE)], ran: [{ repo: 'o/peek', job_id: 1, runner: 'DESK-9', ran_on: 4, started_at: NOW + 50 }], placed: [], ended: [], at: NOW + 4 });
  assert.equal(row(1)!.started_at, NOW + 1);
  assert.equal(row(3)!.first_seen, NOW);
  assert.deepEqual(
    store.poolLastStarts().map((r) => ({ ...r })),
    [{ project_id: PEEK, at: NOW + 2, machine: 6 }],
  );
});

test("a runner's machine is the one whose hostname its name starts with", () => {
  const pcs = [
    { id: 1, hosts: ['DESK'] },
    { id: 2, hosts: ['DESK-2', 'desk-2-linux'] },
  ];
  assert.equal(machineOfRunner('desk', pcs), 1);
  assert.equal(machineOfRunner('DESK-3', pcs), 1);
  assert.equal(machineOfRunner('desk-2-linux-1', pcs), 2);
  assert.equal(machineOfRunner('laptop', pcs), null);
  // A pool slot (P2) names its machine by id.
  assert.equal(machineOfRunner('pool-m2-w1-j55', pcs), 2);
  assert.equal(machineOfRunner('pool-m7-l1-ab12cd', pcs), null);
});

import { ciPoolRoutes } from '../src/routes/ci-pool.ts';
import { poolKey, poolOn } from '../src/runner-pool.ts';
import { Readable } from 'node:stream';

test("/api/ci/pool shows a person only the jobs of the schemes they can see, with the whole line's count; another scheme's running job by its size only", async () => {
  const lineJob = (id: number, scheme: number) => ({ repo: `r/${scheme}`, scheme, id, run: id, name: `job ${id}`, labels: [], ship: false, since: NOW, size: 4, place: id, step: 2, machine: null, why: 'room', pool: false, starting: false });
  const running = (scheme: number) => ({ repo: `r/${scheme}`, scheme, name: `tests ${scheme}`, size: 4, since: NOW, pool: true, starting: false });
  const view = { at: NOW, watching: false, line: [lineJob(1, PEEK), lineJob(2, MANDATE), lineJob(3, PEEK)], machines: [{ id: 1, name: 'cara-desktop', limit: 16, used: 8, free: 8, off: null, running: [running(PEEK), running(MANDATE)] }] };
  const settings = new Map<string, unknown>([[poolKey(PEEK), true]]);
  const read = async (pool: { view(): typeof view } | undefined, who: 'cara' | 'josh' = 'cara') => {
    const res = {
      body: '',
      headersSent: false,
      setHeader() {},
      writeHead() {
        return this;
      },
      end(b?: string) {
        this.body = b ?? '';
      },
    };
    const app = { pool, store: { canSee: (_: unknown, scheme: number) => scheme === PEEK, listProjects: () => [{ id: PEEK }, { id: MANDATE }, { id: CITADEL }], getSetting: (k: string) => settings.get(k) ?? null, getMachine: (id: number) => ({ id, owner_id: 1 }) } };
    await ciPoolRoutes[0].handler({ res, app, session: { name: who === 'cara' ? 'Cara' : 'Josh', uid: who === 'cara' ? 1 : 2, admin: false } } as never);
    return JSON.parse(res.body);
  };
  const got = await read({ view: () => view });
  assert.deepEqual(
    got.line.map((j: { id: number }) => j.id),
    [1, 3],
  );
  assert.equal(got.total, 3);
  assert.deepEqual(
    got.machines[0].running.map((r: { name: string; scheme: number; size: number }) => [r.name, r.scheme, r.size]),
    [
      [`tests ${PEEK}`, PEEK, 4],
      ["another scheme's job", 0, 4],
    ],
  );
  assert.deepEqual(got.pooled, [PEEK]);
  assert.deepEqual((await read({ view: () => view }, 'josh')).machines, [], 'a machine shows only to whom its Machines page does: its owner, and admins');
  assert.equal(await read(undefined), null);
});

test('the switch: a scheme is on the pool only once a member turns it on, and off again takes the setting away (Build 11 P3)', async () => {
  const store = new Store(':memory:');
  const p = store.getProject(store.createProject('Theory of Crafting', null).id)!;
  assert.equal(poolOn(store, p.id), false, 'every scheme starts on its standing runners');
  const patch = async (body: unknown) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: { 'content-type': 'application/json' } });
    const res = {
      status: 0,
      body: '',
      headersSent: false,
      setHeader() {},
      writeHead(s: number) {
        this.status = s;
        return this;
      },
      end(b?: string) {
        this.body = b ?? '';
      },
    };
    await ciPoolRoutes[1].handler({ req, res, app: { store }, project: p } as never);
    return res;
  };
  await patch({ on: true });
  assert.equal(poolOn(store, p.id), true);
  await patch({ on: false });
  assert.equal(poolOn(store, p.id), false);
  assert.equal(store.getSetting(poolKey(p.id)), null);
  await assert.rejects(patch({ on: 'yes' }), /on must be true/);
});

test('until P6 moves every scheme over, only Theory of Crafting can be switched on; any scheme can switch off (Cara, 2026-11-28, "Lock until move-over")', async () => {
  const store = new Store(':memory:');
  const peek = store.getProject(store.createProject('Peek', null).id)!;
  const patch = (body: unknown) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: { 'content-type': 'application/json' } });
    const res = { setHeader() {}, writeHead: () => res, end() {} };
    return ciPoolRoutes[1].handler({ req, res, app: { store }, project: peek } as never);
  };
  await assert.rejects(patch({ on: true }), (e: { status?: number; message: string }) => e.status === 409 && /Only Theory of Crafting/.test(e.message));
  assert.equal(store.getSetting(poolKey(peek.id)), null, 'refused before anything is written');
  await patch({ on: false });
  assert.equal(poolOn(store, peek.id), false);
});
