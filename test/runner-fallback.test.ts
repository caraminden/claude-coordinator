import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolSight, SeenJob } from '../src/ci-ships.ts';
import { actionsMinutes, FALLBACK, type FallbackDeps, type FallbackLook, Fallbacks, type Gh, machineReasons, noMachine, PERIGEE_HEAVY, perigeeNext, perigeeRunner, restartOnGithub, routeOf } from '../src/runner-fallback.ts';
import type { PoolJob, PoolMachine, PoolPc } from '../src/runner-pool.ts';
import { RunnerPool } from '../src/runner-pool.ts';

// Where a pool job goes when no machine can take it (Build 11 P5, specs/one-runner-pool.md section 5). Cara, 2026-11-27,
// #2264's card Q3: "Public repos go to GitHub", "perigee can be a fallback for private repos, just need to load balance
// and make sure we dont overload it"; on Peek's Windows jobs: "yeah ok...maybe we fall back to github minutes?".
const NOW = Date.UTC(2026, 10, 28, 8, 0);
const MIN = 60_000;
const PEEK = 5;

function job(o: Partial<PoolJob> = {}): PoolJob {
  return { repo: 'caraminden/peek-auras', id: 1, run: 1, name: 'build', scheme: PEEK, ship: true, first: false, since: NOW, needs: { os: 'windows', session: false, size: 4 }, ...o };
}
function pc(o: Partial<PoolMachine> = {}): PoolMachine {
  return { id: 1, name: 'cara-desktop', priority: null, os: ['windows', 'linux'], session: true, schemes: [PEEK], limit: 16, free: 16, off: null, ...o };
}
test('"no room" is not "no machine": only no machine can lead to a fallback', () => {
  const none = (j: PoolJob, ms: PoolMachine[]) => noMachine(j, ms);
  assert.equal(none(job(), [pc({ free: 0 })]), false, 'machines on but full, or held for a big job: no room');
  assert.equal(none(job(), [pc({ limit: 2, cap: 16, free: 2 })]), false, "busy with minion turns: the turns' share leaves too little room now, but its CI limit fits, so it waits there");
  assert.equal(none(job(), [pc()]), false, 'a machine that can take it');
  assert.equal(none(job(), [pc({ off: 'is offline' })]), true, 'every machine off');
  assert.equal(none(job(), [pc({ off: 'is paused' }), pc({ id: 2, name: 'tiny', limit: 2 })]), true, 'one off and the only open one too small: no machine');
  assert.equal(none(job(), [pc({ os: ['linux'] })]), true, 'no machine runs its OS');
  assert.equal(none(job(), [pc({ schemes: [] })]), true, 'no machine lends its scheme CI');
  assert.equal(none(job({ needs: { os: 'windows', session: false, size: 24 } }), [pc()]), true, "too big for any machine's limit");
  assert.equal(none(job({ needs: { os: 'windows', session: false, size: 12 } }), [pc({ limit: 16, cap: 8 })]), true, "too big for the owner's CI cap");
  assert.equal(none(job({ needs: { os: 'windows', session: true, size: 4 } }), [pc({ session: false })]), true, 'nobody signed in for a desktop job');
});

test("why each machine couldn't take it, one line each", () => {
  const machines = [pc({ name: 'cara-desktop', off: 'is offline' }), pc({ id: 2, name: 'josh-wsl', os: ['linux'] }), pc({ id: 3, name: 'tiny', limit: 2 }), pc({ id: 4, name: 'dragonbox', schemes: [99] })];
  assert.deepEqual(machineReasons(job(), machines), ['cara-desktop is offline', "josh-wsl doesn't run Windows", 'tiny lets CI use 2 threads at most, and it needs 4']);
  assert.deepEqual(machineReasons(job(), []), ['no machine lends CI to its scheme']);
});

test('the route: public to GitHub, private Linux to perigee, private Windows to GitHub under 80% of the minutes, sessions wait', () => {
  const linux = { os: 'linux', session: false, size: 4 } as const;
  const win = { os: 'windows', session: false, size: 4 } as const;
  const minutes = { used: 1000, included: 3000 };
  assert.equal(routeOf(linux, true, null).route, 'github');
  assert.equal(routeOf(win, true, null).route, 'github', "a public repo's Windows job is free too");
  assert.equal(routeOf(linux, false, null).route, 'perigee', "a private repo's Linux job never spends minutes");
  assert.deepEqual(routeOf(win, false, minutes), { route: 'github', why: "its repo is private, so it spends Actions minutes on GitHub's Windows runners (2000 of 3000 included minutes left this month, Windows minutes counting double)" });
  assert.equal(routeOf(win, false, { used: 2399, included: 3000 }).route, 'github');
  const at80 = routeOf(win, false, { used: 2400, included: 3000 });
  assert.equal(at80.route, 'wait', 'at 80% the job waits instead');
  assert.match(at80.why, /2400 of the account's 3000 included Actions minutes are used/);
  assert.equal(routeOf(win, false, { error: 'the link needs the user scope' }).route, 'wait', "minutes that can't be read fail closed");
  assert.equal(routeOf(win, false, null).route, 'wait');
  assert.equal(routeOf({ os: 'windows', session: true, size: 4 }, true, null).route, 'wait', 'a session or GPU job waits, even on a public repo');
  assert.equal(routeOf(linux, null, null).route, 'wait', 'unknown visibility waits');
});

function world(o: { pub?: boolean; minutes?: { used: number; included: number }; perigee?: boolean; quiet?: boolean } = {}) {
  let now = NOW;
  const told: { repo: string; text: string }[] = [];
  const restarts: { repo: string; run: number }[] = [];
  const perigeeStarts: number[] = [];
  const ends: (() => void)[] = [];
  let quiet = o.quiet ?? true;
  const d: FallbackDeps = {
    now: () => now,
    isPublic: async () => o.pub ?? true,
    minutes: async () => o.minutes ?? { error: 'no' },
    github: async (repo, run) => (restarts.push({ repo, run }), { ok: true, why: 'started again on GitHub as run 77' }),
    tell: (repo, text) => told.push({ repo, text }),
    log: () => {},
    ...(o.perigee
      ? {
          perigee: {
            quiet: () => quiet,
            start: async (j: PoolJob) => {
              perigeeStarts.push(j.id);
              return { ok: true, why: '', done: new Promise<void>((r) => ends.push(r)) };
            },
          },
        }
      : {}),
  };
  const fb = new Fallbacks(d);
  const settle = () => new Promise((r) => setImmediate(r));
  return { fb, told, restarts, perigeeStarts, ends, tick: (ms: number) => (now += ms), settle, setQuiet: (q: boolean) => (quiet = q) };
}
const look = (j: PoolJob, none: boolean): FallbackLook => ({ job: j, labels: ['self-hosted', 'peek-auras-ci-linux'], none, reasons: none ? ['cara-desktop is offline'] : [] });

test('no room never falls back, however long it waits', async () => {
  const w = world();
  for (let i = 0; i <= 30; i++) {
    w.fb.look([look(job(), false)]);
    w.tick(MIN);
  }
  await w.settle();
  assert.deepEqual([w.told.length, w.restarts.length], [0, 0]);
});

test("at 10 minutes with no machine, a public repo's job restarts on GitHub, and the Taskmaster hears once, naming each machine's reason", async () => {
  const w = world({ pub: true });
  const j = job({ repo: 'caraminden/claude-coordinator', ship: false });
  w.fb.look([look(j, true)]);
  w.tick(FALLBACK.afterMs - 1);
  w.fb.look([look(j, true)]);
  await w.settle();
  assert.equal(w.told.length, 0, 'not before 10 minutes');
  assert.equal(w.fb.waiting('caraminden/claude-coordinator', 1), false, 'its line reads waiting for a machine only once the fallback has it in hand');
  w.tick(1);
  w.fb.look([look(j, true)]);
  await w.settle();
  assert.deepEqual(w.restarts, [{ repo: 'caraminden/claude-coordinator', run: 1 }]);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /no machine could take caraminden\/claude-coordinator's job "build" \(run 1\) for 10 minutes\. cara-desktop is offline\. So its repo is public, so GitHub's runners run it for free: started again on GitHub as run 77\./);
  w.tick(MIN);
  w.fb.look([look(j, true)]);
  await w.settle();
  assert.deepEqual([w.told.length, w.restarts.length], [1, 1], 'once');
});

test('a look where a machine could take it starts the 10 minutes over', async () => {
  const w = world();
  w.fb.look([look(job(), true)]);
  w.tick(9 * MIN);
  w.fb.look([look(job(), false)]);
  w.tick(2 * MIN);
  w.fb.look([look(job(), true)]);
  await w.settle();
  assert.equal(w.told.length, 0);
});

test("a private repo's Windows job at 80% of the included minutes waits, and the Taskmaster is told why; under it, the message says minutes were spent and how many are left", async () => {
  const at = world({ pub: false, minutes: { used: 2400, included: 3000 } });
  at.fb.look([look(job(), true)]);
  at.tick(FALLBACK.afterMs);
  at.fb.look([look(job(), true)]);
  await at.settle();
  assert.equal(at.restarts.length, 0, 'no minutes spent');
  assert.match(at.told[0].text, /2400 of the account's 3000 included Actions minutes are used this month \(80% or more\), so it waits for a machine/);
  assert.equal(at.fb.waiting('caraminden/peek-auras', 1), true, "its ship's line reads waiting for a machine");
  const under = world({ pub: false, minutes: { used: 600, included: 3000 } });
  under.fb.look([look(job(), true)]);
  under.tick(FALLBACK.afterMs);
  under.fb.look([look(job(), true)]);
  await under.settle();
  assert.equal(under.restarts.length, 1);
  assert.match(under.told[0].text, /spends Actions minutes on GitHub's Windows runners \(2400 of 3000 included minutes left this month/);
  assert.equal(under.fb.waiting('caraminden/peek-auras', 1), false, 'gone to GitHub');
});

test("perigee takes private repos' Linux jobs one at a time, only while quiet: a second queues", async () => {
  assert.equal(perigeeNext(['a', 'b'], 0, true), 'a');
  assert.equal(perigeeNext(['a', 'b'], 1, true), null, 'one at a time');
  assert.equal(perigeeNext(['a'], 0, false), null, 'not while busy');
  const w = world({ pub: false, perigee: true, quiet: false });
  const a = job({ id: 1, run: 1, needs: { os: 'linux', session: false, size: 4 } });
  const b = job({ id: 2, run: 2, needs: { os: 'linux', session: false, size: 4 } });
  w.fb.look([look(a, true), look(b, true)]);
  w.tick(FALLBACK.afterMs);
  w.fb.look([look(a, true), look(b, true)]);
  await w.settle();
  assert.deepEqual(w.perigeeStarts, [], 'perigee is busy: both wait in its line');
  assert.match(w.told[1].text, /runs on perigee, one such job at a time and only while perigee is quiet; 1 ahead of it there\./);
  w.setQuiet(true);
  w.fb.look([look(a, true), look(b, true)]);
  await w.settle();
  assert.deepEqual(w.perigeeStarts, [1]);
  w.fb.look([look(a, true), look(b, true)]);
  await w.settle();
  assert.deepEqual(w.perigeeStarts, [1], 'the second queues while the first runs');
  assert.deepEqual([w.fb.waiting('caraminden/peek-auras', 1), w.fb.waiting('caraminden/peek-auras', 2)], [false, true], 'the one running on perigee is not waiting for a machine; the one queued there is');
  assert.equal(w.fb.shipWaiting('caraminden/peek-auras'), true, "a ship job of the repo waits: its ship's line says so");
  assert.equal(w.fb.shipWaiting('caraminden/other'), false);
  w.ends[0]();
  await w.settle();
  w.fb.look([look(b, true)]);
  await w.settle();
  assert.deepEqual(w.perigeeStarts, [1, 2]);
});

test("a private repo's Linux job waits, and says so, while perigee's own runner isn't set up", async () => {
  const w = world({ pub: false });
  const a = job({ needs: { os: 'linux', session: false, size: 4 } });
  w.fb.look([look(a, true)]);
  w.tick(FALLBACK.afterMs);
  w.fb.look([look(a, true)]);
  await w.settle();
  assert.match(w.told[0].text, /perigee's own runner isn't set up, so it waits for a machine/);
});

function fakeGh(o: { event?: string; tip?: string; dispatch?: number; newRunAfter?: number; running?: boolean; ended?: string } = {}) {
  const calls: string[] = [];
  let lists = 0;
  const gh: Gh = async (method, path, body) => {
    calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`);
    if (method === 'GET' && path === 'repos/o/r/actions/runs/50') return { status: 200, body: { id: 50, path: '.github/workflows/windows.yml', head_branch: 'land/fix', head_sha: 'abc', status: 'queued', event: o.event ?? 'push' } };
    if (method === 'GET' && path.startsWith('repos/o/r/git/ref/heads/')) return { status: 200, body: { object: { sha: o.tip ?? 'abc' } } };
    if (method === 'GET' && path === 'repos/o/r/actions/runs/50/jobs?filter=latest&per_page=100') return { status: 200, body: { jobs: [{ status: 'queued' }, { status: o.running ? 'in_progress' : 'completed' }] } };
    if (method === 'POST' && path.endsWith('/dispatches')) return { status: o.dispatch ?? 204, body: null };
    if (method === 'GET' && path.startsWith('repos/o/r/actions/runs?'))
      return {
        status: 200,
        body: {
          workflow_runs:
            ++lists > (o.newRunAfter ?? 0)
              ? [
                  { id: 49, path: '.github/workflows/windows.yml' },
                  { id: 51, path: '.github/workflows/windows.yml', ...(o.ended ? { status: 'completed', conclusion: o.ended } : { status: 'queued' }) },
                  { id: 52, path: '.github/workflows/other.yml' },
                ]
              : [],
        },
      };
    if (method === 'POST' && path.endsWith('/cancel')) return { status: 202, body: null };
    return { status: 404, body: null };
  };
  return { gh, calls };
}

test('a restart starts the new run on the same commit and sees it before it cancels the old one, so the ship script follows the newest', async () => {
  const f = fakeGh({ newRunAfter: 1 });
  const r = await restartOnGithub(f.gh, 'o/r', 50, async () => {});
  assert.deepEqual(r, { ok: true, why: "started again on GitHub's runners as run 51" });
  assert.deepEqual(f.calls, [
    'GET repos/o/r/actions/runs/50',
    'GET repos/o/r/actions/runs/50/jobs?filter=latest&per_page=100',
    'GET repos/o/r/git/ref/heads/land/fix',
    'POST repos/o/r/actions/workflows/windows.yml/dispatches {"ref":"land/fix","inputs":{"route":"github"}}',
    'GET repos/o/r/actions/runs?head_sha=abc&event=workflow_dispatch&per_page=20',
    'GET repos/o/r/actions/runs?head_sha=abc&event=workflow_dispatch&per_page=20',
    'POST repos/o/r/actions/runs/50/cancel',
  ]);
});

test("a restart that can't be made cancels nothing: the job waits, never fails", async () => {
  const cancels = (f: ReturnType<typeof fakeGh>) => f.calls.filter((c) => c.endsWith('/cancel')).length;
  const refused = fakeGh({ dispatch: 422 });
  assert.match((await restartOnGithub(refused.gh, 'o/r', 50, async () => {})).why, /takes no `route` input/);
  assert.equal(cancels(refused), 0);
  const moved = fakeGh({ tip: 'def' });
  assert.match((await restartOnGithub(moved.gh, 'o/r', 50, async () => {})).why, /has moved past the run's commit/);
  assert.equal(moved.calls.filter((c) => c.includes('dispatches')).length, 0, 'no run of another commit');
  const dispatched = fakeGh({ event: 'workflow_dispatch' });
  assert.equal((await restartOnGithub(dispatched.gh, 'o/r', 50, async () => {})).ok, false, "a dispatched run's inputs can't be given again");
  assert.equal(dispatched.calls.filter((c) => c.includes('dispatches')).length, 0);
  const never = fakeGh({ newRunAfter: 1e9 });
  assert.equal((await restartOnGithub(never.gh, 'o/r', 50, async () => {})).ok, false);
  assert.equal(cancels(never), 0, 'no new run seen: the old one is left');
  const running = fakeGh({ running: true });
  assert.match((await restartOnGithub(running.gh, 'o/r', 50, async () => {})).why, /a job of its run is running now/);
  assert.equal(running.calls.filter((c) => c.includes('dispatches') || c.endsWith('/cancel')).length, 0, 'a machine picked a job of it up meanwhile: cancelling would kill it');
  const failed = fakeGh({ ended: 'startup_failure' });
  assert.match((await restartOnGithub(failed.gh, 'o/r', 50, async () => {})).why, /ended at once \(startup_failure\), so the old run is left waiting/);
  assert.equal(cancels(failed), 0, "a new run that never started doesn't cost the old one its chance at a machine");
});

test("the pool hands the fallback its own waiting jobs, marked no machine or no room; not Citadel's ships, heavy jobs or a standing scheme's", () => {
  const looks: FallbackLook[][] = [];
  const reads: ReadonlySet<string>[] = [];
  const peek = 'caraminden/peek-auras';
  const citadel = 'caraminden/claude-coordinator';
  const off: PoolPc = { id: 1, name: 'cara-desktop', priority: null, os: ['windows', 'linux'], session: true, schemes: [PEEK, 2], limit: 8, off: 'is offline', hosts: ['DESK'] };
  const pool = new RunnerPool({
    scheme: (r) => (r === peek ? { id: PEEK, name: 'Peek Auras' } : r === citadel ? { id: 2, name: 'Citadel' } : null),
    first: () => citadel,
    machines: () => [off],
    store: { poolLook: () => {}, poolOpen: () => [], poolLastStarts: () => [] },
    log: () => {},
    now: () => NOW,
    pooled: () => true,
    start: async () => ({ name: '', ok: true, output: '' }),
    fallback: { look: (j, read) => (looks.push(j), reads.push(read)) },
  });
  const j = (repo: string, id: number, labels: string[], ship = false): SeenJob => ({ repo, id, run: id, name: `job ${id}`, labels, ship, created: NOW, status: 'queued', runner: null });
  const jobs = [j(peek, 1, ['self-hosted', 'peek-auras-ci']), j(citadel, 2, ['self-hosted', 'citadel-ci'], true), j(peek, 3, ['self-hosted', 'peek-auras-ci-linux', 'citadel-heavy-apk'])];
  const runs = new Set(jobs.map((x) => `${x.repo}#${x.run}`));
  const sight: PoolSight = { jobs, runs, known: new Set(runs), repos: new Set([peek, citadel]) };
  pool.pass(sight);
  assert.deepEqual(
    looks[0].map((l) => [l.job.id, l.none, l.reasons]),
    [[1, true, ['cara-desktop is offline']]],
  );
  assert.deepEqual(looks[0][0].labels, ['self-hosted', 'peek-auras-ci']);
  assert.deepEqual([...reads[0]], [peek, citadel], 'the repos it read, so a failed read keeps its jobs');
});

// A fake GitHub for the minutes count: each repo's visibility and this month's dispatched runs, with their jobs.
function minutesGh(repos: Record<string, { private: boolean; runs?: { group: string; labels: string[]; mins: number }[][]; down?: string }>) {
  const asked: string[] = [];
  const of =
    (repo: string): Gh =>
    async (_m, path) => {
      asked.push(path);
      const r = repos[repo];
      if (r.down && path.includes(r.down)) return { status: 502, body: null };
      if (path === `repos/${repo}`) return { status: 200, body: { private: r.private } };
      const page = path.match(/actions\/runs\?event=workflow_dispatch&status=completed&created=>=2026-11-01&per_page=100&page=(\d+)$/);
      if (page) {
        const ids = (r.runs ?? []).map((_, i) => i + 1);
        return { status: 200, body: { workflow_runs: ids.slice((Number(page[1]) - 1) * 100, Number(page[1]) * 100).map((id) => ({ id })) } };
      }
      const jobs = path.match(/\/runs\/(\d+)\/jobs\?filter=all&per_page=100$/);
      if (jobs) return { status: 200, body: { jobs: (r.runs?.[Number(jobs[1]) - 1] ?? []).map((j) => ({ runner_group_name: j.group, labels: j.labels, started_at: new Date(NOW).toISOString(), completed_at: new Date(NOW + j.mins * MIN).toISOString() })) } };
      return { status: 404, body: null };
    };
  return { of, asked };
}

test("the minutes count is Citadel's own: private repos' dispatched jobs on GitHub's runners, each rounded up, Windows double, macOS ten times; each ended run read once", async () => {
  const gh = minutesGh({
    'caraminden/peek-auras': {
      private: true,
      runs: [
        [
          { group: 'GitHub Actions', labels: ['windows-latest'], mins: 9.5 },
          { group: 'Default', labels: ['self-hosted', 'peek-auras-ci'], mins: 60 },
        ],
        [{ group: 'GitHub Actions', labels: ['ubuntu-latest'], mins: 3 }],
        [{ group: 'GitHub Actions', labels: ['macos-latest'], mins: 1 }],
      ],
    },
    'caraminden/claude-coordinator': { private: false, runs: [[{ group: 'GitHub Actions', labels: ['ubuntu-latest'], mins: 5000 }]] },
  });
  const counted = new Map<string, number>();
  const m = await actionsMinutes(gh.of, ['caraminden/peek-auras', 'caraminden/claude-coordinator'], '2026-11-01', counted);
  assert.deepEqual(m, { used: 20 + 3 + 10, included: FALLBACK.included }, 'a self-hosted job is free');
  assert.ok(!gh.asked.some((p) => p.startsWith('repos/caraminden/claude-coordinator/')), "a public repo's minutes are free: never read");
  const jobReads = () => gh.asked.filter((p) => p.includes('/jobs?')).length;
  const before = jobReads();
  assert.deepEqual(await actionsMinutes(gh.of, ['caraminden/peek-auras'], '2026-11-01', counted), m);
  assert.equal(jobReads(), before, "an ended run's minutes are kept, not read again");
  counted.set('2026-10-01 caraminden/peek-auras#1.1', 99);
  await actionsMinutes(gh.of, ['caraminden/peek-auras'], '2026-11-01', counted);
  assert.ok(![...counted.keys()].some((k) => k.startsWith('2026-10-01')), "last month's are dropped");
});

test('the minutes count reads every page of runs, and fails closed past the pages it counts', async () => {
  const many = (n: number) => minutesGh({ 'caraminden/peek-auras': { private: true, runs: Array.from({ length: n }, () => [{ group: 'GitHub Actions', labels: ['ubuntu-latest'], mins: 1 }]) } });
  assert.deepEqual(await actionsMinutes(many(150).of, ['caraminden/peek-auras'], '2026-11-01', new Map()), { used: 150, included: FALLBACK.included });
  const over = await actionsMinutes(many(FALLBACK.countPages * 100).of, ['caraminden/peek-auras'], '2026-11-01', new Map());
  assert.ok('error' in over && /more than 1000 runs/.test(over.error), JSON.stringify(over));
});

test('the minutes count fails closed: a read GitHub refuses, or a repo no login reads, is an error, so private Windows jobs wait', async () => {
  const down = minutesGh({ 'caraminden/peek-auras': { private: true, runs: [[{ group: 'GitHub Actions', labels: ['windows-latest'], mins: 1 }]], down: '/jobs?' } });
  const m = await actionsMinutes(down.of, ['caraminden/peek-auras'], '2026-11-01', new Map());
  assert.ok('error' in m && /502/.test(m.error), JSON.stringify(m));
  assert.equal(routeOf({ os: 'windows', session: false, size: 4 }, false, m).route, 'wait');
  const none = await actionsMinutes(() => null, ['caraminden/peek-auras'], '2026-11-01', new Map());
  assert.ok('error' in none);
});

test('the jobs of one run that reach 10 minutes together go as one: one restart, one message naming them all', async () => {
  const w = world({ pub: true });
  const a = job({ id: 1, run: 9, name: 'build' });
  const b = job({ id: 2, run: 9, name: 'test' });
  w.fb.look([look(a, true), look(b, true)]);
  w.tick(FALLBACK.afterMs);
  w.fb.look([look(a, true), look(b, true)]);
  await w.settle();
  assert.deepEqual(w.restarts, [{ repo: 'caraminden/peek-auras', run: 9 }]);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /jobs "build", "test" \(run 9, a ship\)/);
});

test("a repo whose read failed keeps its jobs' 10 minutes; a repo read without them has ended them", async () => {
  const w = world({ pub: true });
  w.fb.look([look(job(), true)], new Set(['caraminden/peek-auras']));
  w.tick(5 * MIN);
  w.fb.look([], new Set());
  w.tick(5 * MIN);
  w.fb.look([look(job(), true)], new Set(['caraminden/peek-auras']));
  await w.settle();
  assert.equal(w.restarts.length, 1, 'a failed read kept its clock');
  const e = world({ pub: true });
  e.fb.look([look(job(), true)], new Set(['caraminden/peek-auras']));
  e.tick(5 * MIN);
  e.fb.look([], new Set(['caraminden/peek-auras']));
  e.tick(5 * MIN);
  e.fb.look([look(job(), true)], new Set(['caraminden/peek-auras']));
  await e.settle();
  assert.equal(e.restarts.length, 0, 'it ended, so one seen again starts over');
});

test('a fallback whose reads throw is told and waits, not lost', async () => {
  const told: string[] = [];
  let now = NOW;
  const f = new Fallbacks({ now: () => now, isPublic: async () => Promise.reject(new Error('gh not found')), minutes: async () => ({ error: 'no' }), github: async () => ({ ok: true, why: '' }), tell: (_r, text) => told.push(text), log: () => {} });
  f.look([look(job(), true)]);
  now += FALLBACK.afterMs;
  f.look([look(job(), true)]);
  await new Promise((r) => setImmediate(r));
  assert.match(told[0] ?? '', /Citadel couldn't send it on \(gh not found\), so it waits for a machine/);
  assert.equal(f.waiting('caraminden/peek-auras', 1), true);
});

test("a job in perigee's line that a machine could take leaves the line and starts its 10 minutes over", async () => {
  const w = world({ pub: false, perigee: true, quiet: false });
  const a = job({ needs: { os: 'linux', session: false, size: 4 } });
  w.fb.look([look(a, true)]);
  w.tick(FALLBACK.afterMs);
  w.fb.look([look(a, true)]);
  await w.settle();
  assert.equal(w.told.length, 1);
  w.fb.look([look(a, false)]);
  w.setQuiet(true);
  w.fb.look([look(a, true)]);
  await w.settle();
  assert.deepEqual(w.perigeeStarts, [], 'not started: it left the line');
  w.tick(FALLBACK.afterMs);
  w.fb.look([look(a, true)]);
  await w.settle();
  assert.deepEqual(w.perigeeStarts, [1], 'ten more minutes with no machine: back in the line, and told again');
  assert.equal(w.told.length, 2);
});

test("perigee's start that fails tells the Taskmaster, and the job waits for a machine", async () => {
  const told: string[] = [];
  let now = NOW;
  const f = new Fallbacks({
    now: () => now,
    isPublic: async () => false,
    minutes: async () => ({ error: 'no' }),
    github: async () => ({ ok: true, why: '' }),
    tell: (_r, text) => told.push(text),
    log: () => {},
    perigee: { quiet: () => true, start: async () => Promise.reject(new Error('GitHub answered 403 for a runner config')) },
  });
  const a = job({ needs: { os: 'linux', session: false, size: 4 } });
  f.look([look(a, true)]);
  now += FALLBACK.afterMs;
  f.look([look(a, true)]);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.match(told[1] ?? '', /perigee couldn't start caraminden\/peek-auras's job "build" \(run 1\): GitHub answered 403 for a runner config\. It waits for a machine\./);
  assert.equal(f.waiting('caraminden/peek-auras', 1), true);
});

test("perigee's runner: the config goes only to run(), never a log line; one that took no job in 2 minutes after it connected is stopped and taken off GitHub", async () => {
  const lines: string[] = [];
  const ran: { name: string; config: string }[] = [];
  const removed: number[] = [];
  let stopped = 0;
  let polls = 0;
  let state: (poll: number) => { busy: boolean; online: boolean } | null = () => null;
  const p = perigeeRunner({
    pressure: () => 12,
    jit: async (_repo, name, labels) => (assert.deepEqual(labels, ['self-hosted', 'peek-auras-ci-linux']), assert.equal(name, 'perigee-1'), { id: 900, config: 'SECRET-JIT' }),
    run: (name, config) => (ran.push({ name, config }), { done: new Promise(() => {}), stop: () => stopped++ }),
    runner: async () => state(++polls),
    remove: async (_repo, id) => void removed.push(id),
    wait: async () => {},
    log: (l) => lines.push(l),
  });
  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  };
  assert.equal(p.quiet(), true);
  // Waits in citadel-heavy's slot for 10 polls (offline), then connects and takes nothing.
  state = (n) => ({ busy: false, online: n > 10 });
  assert.equal((await p.start(job(), ['self-hosted', 'peek-auras-ci-linux'])).ok, true);
  assert.deepEqual(ran, [{ name: 'perigee-1', config: 'SECRET-JIT' }]);
  await settle();
  assert.deepEqual([stopped, removed, polls], [1, [900], 10 + FALLBACK.perigee.idleMs / FALLBACK.perigee.pollMs], 'its time in the slot is not idle time');
  assert.ok(!lines.some((l) => l.includes('SECRET-JIT')), 'the config is a credential');
  stopped = 0;
  polls = 0;
  state = (n) => ({ busy: n > 1, online: true });
  await p.start(job(), ['self-hosted', 'peek-auras-ci-linux']);
  await settle();
  assert.deepEqual([stopped, polls], [0, 2], 'a runner on its job is left to finish');
  assert.equal(perigeeRunner({ pressure: () => FALLBACK.perigee.quietPct, jit: async () => ({ id: 0, config: '' }), run: () => ({ done: Promise.resolve(), stop() {} }), runner: async () => null, remove: async () => {}, log() {} }).quiet(), false, 'at 30% CPU pressure it is not quiet');
});

test("perigee's runner waits for citadel-heavy's one slot on perigee: never judged light, never sent to CI", () => {
  assert.deepEqual(PERIGEE_HEAVY, { CITADEL_HEAVY_HERE: '1', CITADEL_HEAVY_JUDGE: '0', CITADEL_HEAVY_WHAT: 'CI fallback: perigee runner' });
});

test("a job whose perigee runner ended while it still waits goes back to the front of perigee's line once, then waits for a machine and says so", async () => {
  const w = world({ pub: false, perigee: true });
  const a = job({ needs: { os: 'linux', session: false, size: 4 } });
  w.fb.look([look(a, true)]);
  w.tick(FALLBACK.afterMs);
  w.fb.look([look(a, true)]);
  await w.settle();
  assert.deepEqual(w.perigeeStarts, [1]);
  w.ends[0]();
  await w.settle();
  w.fb.look([look(a, true)]);
  await w.settle();
  assert.deepEqual(w.perigeeStarts, [1, 1], 'started again');
  w.ends[1]();
  await w.settle();
  w.fb.look([look(a, true)]);
  await w.settle();
  assert.deepEqual(w.perigeeStarts, [1, 1], 'not a third time');
  assert.match(w.told.at(-1)?.text ?? '', /perigee couldn't start caraminden\/peek-auras's job "build" \(run 1\): its runner ended 2 times with the job still waiting\. It waits for a machine\./);
  assert.equal(w.fb.waiting('caraminden/peek-auras', 1), true);
  const done = world({ pub: false, perigee: true });
  done.fb.look([look(a, true)]);
  done.tick(FALLBACK.afterMs);
  done.fb.look([look(a, true)]);
  await done.settle();
  done.ends[0]();
  await done.settle();
  done.fb.look([]);
  await done.settle();
  assert.deepEqual([done.perigeeStarts, done.told.length], [[1], 1], 'its job ended with it: nothing more');
});

test('a job told to wait starts over once a machine could take it: no stale "waiting for a machine", and told again after 10 more minutes', async () => {
  const w = world({ pub: false, minutes: { used: 2400, included: 3000 } });
  w.fb.look([look(job(), true)]);
  w.tick(FALLBACK.afterMs);
  w.fb.look([look(job(), true)]);
  await w.settle();
  assert.equal(w.fb.waiting('caraminden/peek-auras', 1), true);
  w.fb.look([look(job(), false)]);
  assert.equal(w.fb.waiting('caraminden/peek-auras', 1), false, 'a machine could take it: it waits for room');
  w.fb.look([look(job(), true)]);
  w.tick(FALLBACK.afterMs);
  w.fb.look([look(job(), true)]);
  await w.settle();
  assert.equal(w.told.length, 2);
});
