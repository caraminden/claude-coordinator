// CI health (src/ci-health.ts, #368): the four rules on GitHub answers shaped like Peek Auras' real ones, and the
// poller putting and clearing admins' Mandate alerts.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  CiHealth, OFFLINE_MS, addRunnerWaiter, onlineRunners, runnerWaiters, QUEUED_MS, VERDICT_MS, bundleTitle, deadGroups, deadProblem, ghGet, itemKey, neverStarted, queuedProblems,
  runnerProblems, sharedHost, skippedProblem, verdictPair, verdictProblem, type GhAnswer, type Job, type Run,
  clock, ORPHAN_MS, orphanRuns, landProblems, landStep, newLandState, type LandState,
} from '../src/ci-health.ts';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';

const root = mkdtempSync(join(tmpdir(), 'ci-health-'));
after(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse('2026-11-05T12:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
// GitHub's annotation on Peek's 11-05 hosted jobs (run 42005206342).
const BILLING = "The job was not started because recent account payments have failed or your spending limit needs to be increased. Please check the 'Billing & plans' section in your settings";

let ids = 1000;
function job(fields: Partial<Job> = {}): Job {
  return { id: ids++, run_id: 1, name: 'build', status: 'completed', conclusion: 'success', created_at: iso(HOUR), runner_name: 'DESKTOP-G248IJ8', labels: ['peek-auras-ci'], steps: [{}, {}], ...fields };
}
// The billing job exactly as GitHub lists it: failed, 0 steps, no runner.
const dead = (msAgo: number, fields: Partial<Job> = {}) => job({ conclusion: 'failure', runner_name: '', steps: [], labels: ['windows-latest'], created_at: iso(msAgo), ...fields });
function runOf(fields: Partial<Run> = {}): Run {
  return { id: ids++, name: 'desktop', workflow_id: 7, head_branch: 'main', head_sha: `${ids}abcdef0123`, status: 'completed', conclusion: 'success', created_at: iso(HOUR), ...fields };
}

test('a runner alerts once it has been offline for 15 minutes, and clears when back or gone', () => {
  const offline: Record<string, number> = {};
  const runners = [{ name: 'DESKTOP-G248IJ8-desktop', status: 'offline' }, { name: 'DESKTOP-G248IJ8', status: 'online' }];
  assert.deepEqual(runnerProblems(runners, offline, NOW), []);
  assert.deepEqual(runnerProblems(runners, offline, NOW + OFFLINE_MS - 1), []);
  const [p] = runnerProblems(runners, offline, NOW + OFFLINE_MS);
  assert.equal(p.key, 'runner:DESKTOP-G248IJ8-desktop');
  assert.match(p.title, /^CI: runner DESKTOP-G248IJ8-desktop has been offline since Nov \d\d? \d\d:\d\d$/);
  assert.deepEqual(runnerProblems([{ name: 'DESKTOP-G248IJ8-desktop', status: 'online' }], offline, NOW + HOUR), []);
  assert.deepEqual(offline, {}, 'back online forgets when it went');
  runnerProblems(runners, offline, NOW);
  assert.deepEqual(runnerProblems([], offline, NOW + HOUR), []);
  assert.deepEqual(offline, {}, 'a runner removed from GitHub is forgotten');
});

test('jobs that never started group by labels, apart from red tests, until a job with those labels starts', () => {
  assert.equal(neverStarted(dead(HOUR)), true);
  assert.equal(neverStarted(job({ conclusion: 'failure' })), false, 'a red test ran steps on a runner');
  assert.equal(neverStarted(dead(HOUR, { conclusion: 'cancelled' })), false, 'cancelled before starting is not dead');
  assert.equal(neverStarted(dead(HOUR, { conclusion: 'startup_failure' })), false, 'a broken workflow file is the branch\'s own problem');

  const jobs = [
    dead(5 * HOUR), job({ labels: ['windows-latest'], created_at: iso(4 * HOUR) }), // started: what died before it is over
    dead(3 * HOUR), dead(2 * HOUR), dead(HOUR),
    job({ conclusion: 'failure', created_at: iso(HOUR) }), // a red test on the desktop runner
  ];
  const groups = deadGroups(jobs);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].labels, 'windows-latest');
  assert.equal(groups[0].dead.length, 3);
  const p = deadProblem(groups[0], BILLING);
  assert.equal(p.key, 'nostart:windows-latest');
  assert.match(p.title, /^CI: 3 jobs on windows-latest didn't start since Nov \d\d? \d\d:\d\d, so they aren't test failures\. GitHub says: "The job was not started because recent account payments have failed/);
  assert.match(deadProblem({ labels: 'x', dead: [dead(HOUR)] }, null).title, /1 job on x didn't start since .*, so it isn't a test failure\.$/);

  assert.deepEqual(deadGroups([...jobs, job({ labels: ['windows-latest'], created_at: iso(MIN) })]), [], 'a job that started since clears it');
});

test('jobs queued 30 minutes with no runner alert per label set', () => {
  const jobs = [
    job({ status: 'queued', conclusion: null, runner_name: null, steps: [], labels: ['self-hosted', 'peek-auras-desktop'], created_at: iso(QUEUED_MS) }),
    job({ status: 'queued', conclusion: null, runner_name: null, steps: [], labels: ['self-hosted', 'peek-auras-desktop'], created_at: iso(HOUR) }),
    job({ status: 'queued', conclusion: null, runner_name: null, steps: [], created_at: iso(QUEUED_MS - 1) }),
  ];
  const ps = queuedProblems(jobs, NOW);
  assert.equal(ps.length, 1);
  assert.equal(ps[0].key, 'queued:self-hosted, peek-auras-desktop');
  assert.match(ps[0].title, /^CI: 2 jobs on self-hosted, peek-auras-desktop have waited for a runner since/);
});

test('no verdict counts from the first run after the last verdict, so a stream of cancelled runs still alerts', () => {
  const wf = { id: 7, name: 'desktop' };
  // Peek's 20 h: the last green 20 h ago, then a run every half hour, each cancelled by the next.
  const cancelled = Array.from({ length: 39 }, (_, i) => runOf({ conclusion: 'cancelled', created_at: iso(i * 30 * MIN) }));
  const green = runOf({ head_sha: '4f1e9aa0000', created_at: iso(20 * HOUR) });
  const p = verdictProblem(wf, 'main', [...cancelled, green], NOW);
  assert.equal(p?.key, 'verdict:7');
  assert.match(p!.title, /^CI: no desktop verdict on main since .* \(the last was success on 4f1e9aa; 39 runs since\)$/);

  assert.equal(verdictProblem(wf, 'main', [runOf({ conclusion: 'failure' }), ...cancelled], NOW), null, 'a red verdict is a verdict');
  assert.equal(verdictProblem(wf, 'main', [runOf({ status: 'in_progress', conclusion: null, created_at: iso(VERDICT_MS - MIN) }), green], NOW), null, 'still within the 4 h');
  assert.ok(verdictProblem(wf, 'main', [runOf({ status: 'queued', conclusion: null, created_at: iso(VERDICT_MS) }), green], NOW), 'stuck in the queue 4 h');
  assert.equal(verdictProblem(wf, 'main', [runOf({ created_at: iso(3 * 24 * HOUR) })], NOW), null, 'a quiet repo is fine');
  assert.equal(verdictProblem(wf, 'main', [runOf({ conclusion: 'cancelled', created_at: iso(8 * 24 * HOUR) })], NOW), null, 'a workflow unused for a week is not missing anything');
  assert.match(verdictProblem(wf, 'main', cancelled.slice(10), NOW)!.title, /none in its last 29 runs/);
  assert.equal(verdictProblem(wf, 'main', [], NOW), null);
});

test('runs skipped by a job-level if: (or neutral) wait for no verdict (#468 S08-4)', () => {
  const wf = { id: 8, name: 'claude' };
  const skipped = (h: number) => runOf({ conclusion: 'skipped', created_at: iso(h * HOUR) });
  assert.equal(verdictProblem(wf, 'main', [skipped(1), skipped(5), runOf({ created_at: iso(30 * HOUR) })], NOW), null);
  assert.equal(verdictProblem(wf, 'main', [runOf({ conclusion: 'neutral', created_at: iso(2 * HOUR) }), skipped(6)], NOW), null);
  assert.ok(verdictProblem(wf, 'main', [skipped(1), runOf({ conclusion: 'cancelled', created_at: iso(5 * HOUR) }), runOf({ created_at: iso(30 * HOUR) })], NOW), 'a cancelled run still waits for one');
});

test('a green run that skipped jobs which ran the time before is a quiet item, never an alert; jobs skipped both times are nothing', () => {
  const wf = { id: 7, name: 'desktop' };
  const before = [job({ name: 'screen' }), job({ name: 'capture', conclusion: 'failure' }), job({ name: 'nightly', conclusion: 'skipped' })];
  const latest = runOf({ head_sha: 'a1b2c3d9999' });
  const p = skippedProblem(wf, 'main', latest, [job({ name: 'screen', conclusion: 'skipped' }), job({ name: 'capture', conclusion: 'skipped' }), job({ name: 'nightly', conclusion: 'skipped' }), job({ name: 'gate' })], before);
  assert.equal(p?.key, 'green-skipped:7');
  assert.equal(p!.quiet, true, 'a green run never alarms (Cara, 2026-11-11)');
  assert.equal(p!.title, 'CI: desktop on main (a1b2c3d) went green with 2 jobs skipped that ran the time before: screen, capture');
  assert.equal(skippedProblem(wf, 'main', latest, [job({ name: 'screen' }), job({ name: 'nightly', conclusion: 'skipped' })], before), null);

  const red = runOf({ conclusion: 'failure' });
  assert.equal(verdictPair([runOf({ conclusion: 'cancelled' }), red, latest]), null, 'only a green newest verdict is checked');
  assert.deepEqual(verdictPair([runOf({ status: 'in_progress', conclusion: null }), latest, runOf({ conclusion: 'cancelled' }), red])?.map((r) => r.id), [latest.id, red.id]);
});

test('Mandate item keys keep to its characters and length', () => {
  assert.equal(itemKey('queued:self-hosted, peek-auras-desktop'), 'ci.queued:self-hosted_peek-auras-desktop');
  assert.equal(itemKey(`runner:${'x'.repeat(200)}`).length, 128);
});

test('gh api answers parse, a 304 included (gh exits 1 on it)', async () => {
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *If-None-Match*) printf 'HTTP/2.0 304 Not Modified\\r\\nEtag: W/"e1"\\r\\n\\r\\n'; echo 'gh: HTTP 304' >&2; exit 1 ;;
  *) printf 'HTTP/2.0 200 OK\\r\\nEtag: W/"e1"\\r\\nX-Ratelimit-Remaining: 4989\\r\\n\\r\\n{"total_count":1,"runners":[{"name":"r","status":"online"}]}' ;;
esac
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const as = { PATH: `${bin}:${process.env.PATH}` };
  assert.deepEqual(await ghGet('repos/o/r/actions/runners', null, as), { status: 200, etag: 'W/"e1"', body: { total_count: 1, runners: [{ name: 'r', status: 'online' }] } });
  assert.deepEqual(await ghGet('repos/o/r/actions/runners', 'W/"e1"', as), { status: 304, etag: 'W/"e1"', body: null });
});

// ---------- the poller ----------

function world({ delve = false } = {}) {
  const dir = mkdtempSync(join(root, 'w-'));
  const store = new Store(join(dir, 'coordinator.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const rachel = store.createUser({ name: 'Rachel', login: 'rachel', admin: true });
  const peek = store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras', cara.id);
  store.createProject('Notes', 'https://github.com/caraminden/notes', cara.id);
  store.createProject('Local', null, cara.id);
  // A second scheme with CI, sharing the desktop, when a test asks for it.
  if (delve) store.createProject('Delve', 'https://github.com/caraminden/delve', cara.id);
  const c = new Contraptions(store, 's'.repeat(40), join(dir, 'keys'));
  const mandate = c.register({ name: 'mandate', title: 'Mandate', port: 9101, icon: '/icon.svg', home_scheme: null, open_paths: '[]', default_model: 'haiku', turn_cap: 200 });
  // Cara and Josh have Mandate; Rachel, an admin, doesn't.
  store.setContraptionUser(mandate.id, cara.id, true, cara.id);
  store.setContraptionUser(mandate.id, josh.id, true, cara.id);

  const gh = {
    runners: [{ name: 'DESKTOP-G248IJ8-desktop', status: 'online' }] as { name: string; status: string }[],
    delveRunners: [] as { name: string; status: string }[],
    runnersDenied: false,
    runs: [] as Run[],
    jobs: new Map<number, Job[]>(),
    mainRuns: [] as Run[],
    scheduled: [] as Run[],
    dispatched: [] as Run[],
    // A check run's annotations by job id; Peek's billing one for the rest.
    notes: new Map<number, { message: string; annotation_level: string }[]>(),
    calls: [] as string[],
    rateLimited: false,
    down: null as RegExp | null,
    // Paths GitHub answers 404 for: a private repo the reading login can't see (#607).
    hidden: null as RegExp | null,
  };
  const etagOf = (body: any) => `W/"${JSON.stringify(body).length}-${JSON.stringify(body).split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)}"`;
  const get = async (path: string, etag: string | null): Promise<GhAnswer> => {
    gh.calls.push(path);
    if (gh.down?.test(path)) return { status: 502, etag: null, body: { message: 'Server Error' } };
    if (gh.hidden?.test(path)) return { status: 404, etag: null, body: { message: 'Not Found' } };
    if (gh.rateLimited) return { status: 403, etag: null, body: { message: 'API rate limit exceeded for user ID 1.' } };
    let body: any;
    if (path.startsWith('repos/caraminden/notes/')) body = { total_count: 0, workflows: [] };
    else if (path.endsWith('/actions/workflows?per_page=100')) body = { workflows: [{ id: 7, name: 'desktop', state: 'active' }, { id: 8, name: 'old', state: 'disabled_manually' }] };
    else if (path.endsWith('/actions/runners?per_page=100') && gh.runnersDenied) return { status: 403, etag: null, body: { message: 'Resource not accessible by integration' } };
    else if (path === 'repos/caraminden/delve/actions/runners?per_page=100') body = { runners: gh.delveRunners };
    else if (path.endsWith('/actions/runners?per_page=100')) body = { runners: gh.runners };
    else if (path.includes('/actions/workflows/7/runs?branch=main')) body = { workflow_runs: gh.mainRuns };
    // Peek's own; any other repo has none.
    else if (path.endsWith('/actions/runs?event=schedule&branch=main&per_page=20')) body = { workflow_runs: path.startsWith('repos/caraminden/peek-auras/') ? gh.scheduled : [] };
    else if (path.endsWith('/actions/runs?event=workflow_dispatch&per_page=50')) body = { workflow_runs: path.startsWith('repos/caraminden/peek-auras/') ? gh.dispatched : [] };
    else if (path.endsWith('/actions/runs?per_page=50')) body = { workflow_runs: gh.runs };
    else if (/^repos\/caraminden\/[^/]+$/.test(path)) body = { default_branch: 'main' };
    else if (/\/runs\/\d+\/jobs/.test(path)) body = { jobs: gh.jobs.get(Number(/runs\/(\d+)\//.exec(path)![1])) ?? [] };
    else if (/check-runs\/\d+\/annotations/.test(path)) body = gh.notes.get(Number(/check-runs\/(\d+)\//.exec(path)![1])) ?? [{ message: BILLING, annotation_level: 'failure' }];
    else return { status: 404, etag: null, body: { message: 'Not Found' } };
    const tag = etagOf(body);
    return etag === tag ? { status: 304, etag: tag, body: null } : { status: 200, etag: tag, body };
  };
  const puts: [string, string, string | null][] = [];
  const from: string[] = [];
  const quiet: string[] = [];
  const mandateUp = { ok: true };
  const deps = {
    as: () => undefined,
    get,
    mandate: async (p: { name: string }, u: { name: string }, key: string, title: string | null, q?: boolean) => {
      puts.push([u.name, key, title]);
      from.push(p.name);
      if (q) quiet.push(key);
      return mandateUp.ok;
    },
  };
  return { store, peek, gh, puts, from, quiet, mandateUp, deps, health: new CiHealth(store, deps) };
}

test('a problem is one Mandate alert per admin with Mandate, cleared when fixed, and kept across a restart', async () => {
  const w = world();
  const t0 = NOW;
  await w.health.tick(t0);
  assert.deepEqual(w.puts, [], 'all clear: nothing sent');
  assert.ok(!w.gh.calls.some((c) => c.startsWith('repos/caraminden/notes/') && !c.includes('/workflows?')), 'a repo with no workflows costs one call');

  // The desktop runner goes offline; 15 minutes later Cara hears, once. Josh isn't an admin; Rachel has no Mandate.
  w.gh.runners = [{ name: 'DESKTOP-G248IJ8-desktop', status: 'offline' }];
  await w.health.tick(t0 + 5 * MIN);
  assert.deepEqual(w.puts, []);
  await w.health.tick(t0 + 5 * MIN + OFFLINE_MS);
  assert.equal(w.puts.length, 1);
  assert.deepEqual(w.puts[0].slice(0, 2), ['Cara', 'ci.open']);
  assert.match(w.puts[0][2]!, /^CI, Peek Auras: runner DESKTOP-G248IJ8-desktop has been offline since/);
  assert.equal(w.from[0], 'CI health', 'from CI health, not the scheme');
  await w.health.tick(t0 + 10 * MIN + OFFLINE_MS);
  assert.equal(w.puts.length, 1, 'unchanged: not put again');

  // A restart remembers both when it went offline and what Cara already has.
  const again = new CiHealth(w.store, w.deps);
  await again.tick(t0 + 15 * MIN + OFFLINE_MS);
  assert.equal(w.puts.length, 1, 'a restart does not re-send');

  // Back online: her item is cleared.
  w.gh.runners = [{ name: 'DESKTOP-G248IJ8-desktop', status: 'online' }];
  await again.tick(t0 + 20 * MIN + OFFLINE_MS);
  assert.deepEqual(w.puts.at(-1), ['Cara', 'ci.open', null]);
  await again.tick(t0 + 25 * MIN + OFFLINE_MS);
  assert.equal(w.puts.length, 2, 'cleared once');
});

test('an alert raised before local midnight is not sent again after it (#509)', async () => {
  const w = world();
  const t0 = new Date(2026, 10, 10, 23, 40).getTime(); // local time, in whatever zone the tests run
  w.gh.runners = [{ name: 'DESKTOP-G248IJ8-desktop', status: 'offline' }];
  await w.health.tick(t0);
  await w.health.tick(t0 + OFFLINE_MS);
  assert.equal(w.puts.length, 1);
  await w.health.tick(new Date(2026, 10, 11, 0, 5).getTime());
  await w.health.tick(new Date(2026, 10, 11, 9, 0).getTime());
  assert.equal(w.puts.length, 1, 'the next day: not put again');
  assert.match(w.puts[0][2]!, /since Nov 10 23:40$/);
});

test('billing-blocked jobs make one alert that counts up, quoting GitHub, and Mandate being down is retried', async () => {
  const w = world();
  const t = NOW;
  const at = (ago: number) => new Date(t - ago).toISOString();
  const runs = [1, 2].map((i) => runOf({ id: 500 + i, name: 'windows', created_at: at(i * 10 * MIN) }));
  w.gh.runs = runs;
  for (const r of runs) w.gh.jobs.set(r.id, [dead(0, { run_id: r.id, created_at: r.created_at })]);
  w.mandateUp.ok = false;
  await w.health.tick(t);
  assert.equal(w.puts.length, 1);
  assert.match(w.puts[0][2]!, /^CI, Peek Auras: 2 jobs on windows-latest didn't start since .*GitHub says: "The job was not started because recent account payments/);
  // The jobs read are kept for the CI desktop's view (#534), across a restart too.
  assert.equal(w.health.recent.get(w.peek.id)!.length, 2);
  assert.deepEqual(new CiHealth(w.store, w.deps).recent.get(w.peek.id)!.map((j) => j.run_id), [501, 502]);
  await w.health.tick(t + MIN);
  assert.equal(w.puts.length, 2, 'Mandate was down: tried again');
  w.mandateUp.ok = true;
  await w.health.tick(t + 2 * MIN);
  await w.health.tick(t + 3 * MIN);
  assert.equal(w.puts.length, 3, 'settled once Mandate answers');

  // A third dies: the same item, new words.
  const third = runOf({ id: 600, name: 'windows', created_at: at(MIN) });
  w.gh.runs = [third, ...runs];
  w.gh.jobs.set(600, [dead(0, { run_id: 600, created_at: third.created_at })]);
  await w.health.tick(t + 4 * MIN);
  assert.equal(w.puts.at(-1)![1], 'ci.open');
  assert.match(w.puts.at(-1)![2]!, /^CI, Peek Auras: 3 jobs/);
  assert.equal(w.gh.calls.filter((c) => c.includes('/runs/501/jobs')).length, 1, "a finished run's jobs are read once");
  assert.equal(w.gh.calls.filter((c) => c.includes('/annotations')).length, 2, 'one annotation read per newest dead job');

  // Paid: a windows job runs, and the item clears.
  const ok = runOf({ id: 700, name: 'windows', created_at: at(0) });
  w.gh.runs = [ok, third, ...runs];
  w.gh.jobs.set(700, [job({ run_id: 700, labels: ['windows-latest'], created_at: ok.created_at })]);
  await w.health.tick(t + 5 * MIN);
  assert.deepEqual(w.puts.at(-1), ['Cara', 'ci.open', null]);
});

test('a rate limit pauses the checks', async () => {
  const w = world();
  w.gh.rateLimited = true;
  const t = NOW;
  await w.health.tick(t);
  const n = w.gh.calls.length;
  assert.equal(n, 1, 'stops at the first refusal');
  w.gh.rateLimited = false;
  await w.health.tick(t + 5 * MIN);
  assert.equal(w.gh.calls.length, n, 'paused');
  await w.health.tick(t + 16 * MIN);
  assert.ok(w.gh.calls.length > n, 'resumes after 15 minutes');
});

test('a GitHub error skips the round: open alerts stay, and a failed jobs read is not kept', async () => {
  const w = world();
  const t = NOW;
  const r = runOf({ id: 801, name: 'windows', created_at: new Date(t - 10 * MIN).toISOString() });
  w.gh.runs = [r];
  w.gh.jobs.set(801, [dead(0, { run_id: 801, created_at: r.created_at })]);
  w.gh.down = /\/runs\/801\/jobs/;
  await w.health.tick(t);
  assert.deepEqual(w.puts, [], 'nothing known, nothing said');
  w.gh.down = null;
  await w.health.tick(t + MIN);
  assert.equal(w.puts.length, 1, 'the jobs are read again once GitHub answers');
  assert.equal(w.puts[0][1], 'ci.open');
  for (const down of [/\/actions\/workflows\?/, /\/actions\/runs\?per_page/, /\/workflows\/7\/runs/]) {
    w.gh.down = down;
    await w.health.tick(t + 2 * MIN);
    assert.equal(w.puts.length, 1, `a 502 on ${down} clears nothing`);
  }
});

test("a repo the scheme's GitHub login can't see says so, naming whose login it is, not a bare 404 (#607)", async () => {
  const w = world();
  // FuckSpamTexts after its move: a private repo whose owner's login has an invite it hasn't accepted.
  const josh = w.store.listUsers().find((u) => u.name === 'Josh')!;
  w.store.createProject('FuckSpamTexts', 'https://github.com/caraminden/fuckspamtexts.git', josh.id);
  w.gh.hidden = /^repos\/caraminden\/fuckspamtexts\//;
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (...a: unknown[]) => void said.push(a.join(' '));
  try {
    await new CiHealth(w.store, { ...w.deps, as: (p) => (p.name === 'FuckSpamTexts' ? { GH_TOKEN: 'josh' } : undefined) }).tick(NOW);
    await new CiHealth(w.store, w.deps).tick(NOW);
  } finally {
    console.warn = warn;
  }
  const lines = said.filter((l) => l.includes('FuckSpamTexts'));
  assert.equal(lines.length, 2, said.join('\n'));
  assert.match(lines[0], /^CI health check of FuckSpamTexts failed \(said once until a restart\): Josh's linked GitHub can't see caraminden\/fuckspamtexts \(GitHub answers 404\): it has no access to the repo or its invite is still waiting to be accepted, or the repo isn't at that address \(deleted, or repo_url is wrong\)\.$/);
  assert.match(lines[1], /: the box's GitHub login can't see caraminden\/fuckspamtexts \(GitHub answers 404\)/, 'a scheme read as the box says so');
  assert.equal(w.puts.length, 0, 'an unreadable repo clears and raises nothing');
});

test('green with skipped jobs goes out quiet, and the alarm item an older build sent for it is cleared (#532)', async () => {
  const w = world();
  const t = NOW;
  const at = (ago: number) => new Date(t - ago).toISOString();
  // What the old build left behind: the same trouble, sent as an alarm under the old key.
  w.store.setSetting(`ci-health:${w.peek.id}`, { offline: {}, sent: { 'skipped:7': { 1: 'CI: desktop on main went green with 1 job skipped' } } });
  const [green, before] = [runOf({ id: 901, created_at: at(10 * MIN), head_sha: 'a1b2c3d4' }), runOf({ id: 900, created_at: at(HOUR), conclusion: 'failure' })];
  w.gh.mainRuns = [green, before];
  w.gh.jobs.set(901, [job({ run_id: 901, name: 'screen', conclusion: 'skipped' })]);
  w.gh.jobs.set(900, [job({ run_id: 900, name: 'screen', conclusion: 'failure' })]);
  await w.health.tick(t);
  assert.deepEqual(w.puts.find(([, k]) => k === 'ci.skipped:7'), ['Cara', 'ci.skipped:7', null], 'the alarm already out is cleared');
  const put = w.puts.find(([, k]) => k === 'ci.green-skipped:7');
  assert.match(put?.[2] ?? '', /went green with 1 job skipped that ran the time before: screen$/);
  assert.deepEqual(w.quiet, ['ci.green-skipped:7'], 'and comes back as a quiet item, not an alert');
});

test('the one alert names the PC a set of offline runners share, and lists the other problems in full', () => {
  assert.equal(sharedHost(['DESKTOP-G248IJ8', 'DESKTOP-G248IJ8-2', 'DESKTOP-G248IJ8-perf', 'DESKTOP-G248IJ8-linux-2']), 'DESKTOP-G248IJ8');
  assert.equal(sharedHost(['DESKTOP-G248IJ8-3', 'DESKTOP-G248IJ8-4']), 'DESKTOP-G248IJ8', 'no runner named for the PC alone');
  assert.equal(sharedHost(['DESKTOP-G248IJ8', 'DESKTOP-AB12CD3']), null, "two PCs' default names aren't one PC");
  assert.equal(sharedHost(['DESKTOP-G248IJ8', 'CITADEL-BOX-desktop']), null);
  assert.equal(sharedHost(['DESKTOP-G248IJ8']), null);

  const runner = (scheme: string, name: string) => ({ scheme, problem: { key: `runner:${name}`, title: `CI: runner ${name} has been offline since Nov 11 13:32` } });
  const schemes = ['Delve', 'Peek Auras', 'Theory of Crafting', 'Mandate', 'Citadel'];
  const outage = schemes.flatMap((s, i) => [runner(s, i ? `DESKTOP-G248IJ8-${i + 1}` : 'DESKTOP-G248IJ8'), runner(s, `DESKTOP-G248IJ8-linux${i ? `-${i}` : ''}`)]);
  assert.equal(bundleTitle(outage), 'CI: 10 runners offline on DESKTOP-G248IJ8 in 5 schemes');
  assert.equal(bundleTitle(outage.slice(0, 4)), 'CI: 4 runners offline on DESKTOP-G248IJ8 in Delve and Peek Auras');
  const queued = { scheme: 'Delve', problem: { key: 'queued:delve-ci', title: 'CI: 2 jobs on delve-ci have waited for a runner since Nov 11 13:40' } };
  assert.equal(bundleTitle([...outage.slice(0, 2), queued]), 'CI: 2 runners offline on DESKTOP-G248IJ8 and 1 other problem in Delve. Delve: 2 jobs on delve-ci have waited for a runner since Nov 11 13:40');
  assert.equal(bundleTitle([queued]), 'CI, Delve: 2 jobs on delve-ci have waited for a runner since Nov 11 13:40');
  assert.equal(bundleTitle([runner('Delve', 'DESKTOP-G248IJ8'), runner('Peek Auras', 'CITADEL-BOX-desktop')]), 'CI: 2 runners offline in Delve and Peek Auras');
  assert.equal(bundleTitle(Array.from({ length: 30 }, (_, i) => ({ ...queued, problem: { ...queued.problem, key: `q${i}` } }))).length, 500, 'kept to Mandate\'s 500');
});

test('an outage across schemes is one alert that rings once, takes new words quietly, clears when all is well, and rings again on the next (#540)', async () => {
  const w = world({ delve: true });
  const t0 = NOW;
  const off = (name: string) => ({ name, status: 'offline' });
  w.gh.runners = [off('DESKTOP-G248IJ8'), off('DESKTOP-G248IJ8-2')];
  w.gh.delveRunners = [off('DESKTOP-G248IJ8-linux')];
  await w.health.tick(t0);
  await w.health.tick(t0 + OFFLINE_MS);
  assert.deepEqual(w.puts, [['Cara', 'ci.open', 'CI: 3 runners offline on DESKTOP-G248IJ8 in Delve and Peek Auras']], 'one item, not three');
  assert.deepEqual(w.quiet, [], 'an alert');

  // One more drops: the same item takes the new words (Mandate pushes only a new item, so this one doesn't ring).
  w.gh.delveRunners = [off('DESKTOP-G248IJ8-linux'), off('DESKTOP-G248IJ8-linux-2')];
  await w.health.tick(t0 + 2 * OFFLINE_MS);
  await w.health.tick(t0 + 3 * OFFLINE_MS);
  assert.deepEqual(w.puts.slice(1), [['Cara', 'ci.open', 'CI: 4 runners offline on DESKTOP-G248IJ8 in Delve and Peek Auras']]);

  // Peek's come back first: still open, fewer words; then Delve's, and it clears once.
  w.gh.runners = [];
  await w.health.tick(t0 + 4 * OFFLINE_MS);
  assert.deepEqual(w.puts.at(-1), ['Cara', 'ci.open', 'CI: 2 runners offline on DESKTOP-G248IJ8 in Delve']);
  w.gh.delveRunners = [];
  await w.health.tick(t0 + 5 * OFFLINE_MS);
  await w.health.tick(t0 + 6 * OFFLINE_MS);
  assert.deepEqual(w.puts.slice(3), [['Cara', 'ci.open', null]]);

  // The next outage is a new item, so it rings.
  w.gh.runners = [off('DESKTOP-G248IJ8')];
  await w.health.tick(t0 + 7 * OFFLINE_MS);
  await w.health.tick(t0 + 8 * OFFLINE_MS);
  assert.equal(w.puts.length, 5);
  assert.deepEqual(w.puts.at(-1)!.slice(0, 2), ['Cara', 'ci.open']);
});

test("an older build's per-scheme alarm items are cleared from their scheme once the one alert takes over (#540)", async () => {
  const w = world();
  w.store.setSetting(`ci-health:${w.peek.id}`, { offline: { 'DESKTOP-G248IJ8': NOW - OFFLINE_MS }, sent: { 'runner:DESKTOP-G248IJ8': { 1: 'CI: runner DESKTOP-G248IJ8 has been offline since Nov 5 03:45' } } });
  w.gh.runners = [{ name: 'DESKTOP-G248IJ8', status: 'offline' }];
  await w.health.tick(NOW);
  assert.deepEqual(w.puts[0], ['Cara', 'ci.runner:DESKTOP-G248IJ8', null]);
  assert.deepEqual(w.puts.slice(1).map(([u, k]) => [u, k]), [['Cara', 'ci.open']]);
  assert.deepEqual(w.from, ['Peek Auras', 'CI health']);
});

test("a runner list CI health can't read keeps the runner alerts as they were (#540)", async () => {
  const w = world();
  w.gh.runners = [{ name: 'DESKTOP-G248IJ8', status: 'offline' }];
  await w.health.tick(NOW);
  await w.health.tick(NOW + OFFLINE_MS);
  assert.equal(w.puts.length, 1);
  w.gh.runnersDenied = true;
  await w.health.tick(NOW + 2 * OFFLINE_MS);
  await w.health.tick(NOW + 3 * OFFLINE_MS);
  assert.equal(w.puts.length, 1, 'not cleared, not re-sent');
  w.gh.runnersDenied = false;
  w.gh.runners = [{ name: 'DESKTOP-G248IJ8', status: 'online' }];
  await w.health.tick(NOW + 4 * OFFLINE_MS);
  assert.deepEqual(w.puts.at(-1), ['Cara', 'ci.open', null], 'cleared once the list says so');
});

test("an older build's runner alarm moves into the one alert even when the first round after can't read the runner list (#540)", async () => {
  const w = world();
  const title = 'CI: runner DESKTOP-G248IJ8 has been offline since Nov 5 03:45';
  w.store.setSetting(`ci-health:${w.peek.id}`, { offline: { 'DESKTOP-G248IJ8': NOW - OFFLINE_MS }, sent: { 'runner:DESKTOP-G248IJ8': { 1: title } } });
  w.gh.runnersDenied = true;
  await w.health.tick(NOW);
  assert.deepEqual(w.puts, [['Cara', 'ci.runner:DESKTOP-G248IJ8', null], ['Cara', 'ci.open', `CI, Peek Auras: ${title.slice(4)}`]]);
});

test('wake_when_runners_back (#541): a minion parked on CI hears once, when a runner with its scheme\'s label is online', async () => {
  const w = world({ delve: true });
  const sent: [number, string][] = [];
  const health = new CiHealth(w.store, { ...w.deps, wake: (id, text) => sent.push([id, text]) });
  const mk = (project_id: number, title: string) => w.store.createTicket({ project_id, title, permission_mode: 'default', created_by: 1 } as any).id;
  const delve = w.store.listProjects().find((p) => p.name === 'Delve')!;
  const parked = mk(w.peek.id, 'parked');
  const other = mk(delve.id, 'delve');
  const gone = mk(w.peek.id, 'dismissed');
  for (const t of [parked, other, gone]) addRunnerWaiter(w.store, t, 'run tools/land.sh again.');
  w.store.updateTicket(gone, { status: 'closed' });

  // Online, but not with Peek's label: no wake. The dismissed minion's waiter is dropped.
  w.gh.runners = [{ name: 'DESKTOP-G248IJ8', status: 'offline', labels: [{ name: 'peek-auras-ci' }] }, { name: 'X', status: 'online', labels: [{ name: 'other-ci' }] }] as any;
  await health.tick(NOW);
  assert.deepEqual(sent, []);
  assert.deepEqual(runnerWaiters(w.store).map((x) => x.ticket), [parked, other]);

  // The Linux runner comes back: Peek's minion is woken once, Delve's (no runner of its own online) keeps waiting.
  w.gh.runners = [{ name: 'DESKTOP-G248IJ8-linux', status: 'online', labels: [{ name: 'self-hosted' }, { name: 'peek-auras-ci-linux' }] }] as any;
  await health.tick(NOW + 5 * MIN);
  await health.tick(NOW + 10 * MIN);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], parked);
  assert.match(sent[0][1], /^Peek Auras's CI runners are back \(DESKTOP-G248IJ8-linux online\): run tools\/land\.sh again\. If land parks/);
  assert.deepEqual(runnerWaiters(w.store).map((x) => x.ticket), [other]);

  // Without a way to send, nobody is dropped.
  w.gh.delveRunners = [{ name: 'D', status: 'online', labels: [{ name: 'delve-ci' }] }] as any;
  await w.health.tick(NOW + 15 * MIN);
  assert.deepEqual(runnerWaiters(w.store).map((x) => x.ticket), [other]);
  await health.tick(NOW + 20 * MIN);
  assert.deepEqual(sent.map(([id]) => id), [parked, other]);
  assert.deepEqual(runnerWaiters(w.store), []);
});

test("wake_when_runners_back: a runner list the scheme's GitHub login can't read tells the parked minion once and drops it", async () => {
  const w = world();
  const sent: [number, string][] = [];
  const health = new CiHealth(w.store, { ...w.deps, wake: (id, text) => sent.push([id, text]) });
  const parked = w.store.createTicket({ project_id: w.peek.id, title: 'parked', permission_mode: 'default', created_by: 1 } as any).id;
  addRunnerWaiter(w.store, parked, 'run tools/land.sh again.');
  w.gh.runnersDenied = true;
  // Without a way to send, nobody is dropped.
  await w.health.tick(NOW);
  assert.deepEqual(runnerWaiters(w.store).map((x) => x.ticket), [parked]);
  await health.tick(NOW + 5 * MIN);
  await health.tick(NOW + 10 * MIN);
  assert.equal(sent.length, 1, 'once, not every poll');
  assert.equal(sent[0][0], parked);
  assert.match(sent[0][1], /can't read Peek Auras's CI runners with the scheme's GitHub login, so it can't tell when they are back: ask a person whether they are, then run tools\/land\.sh again\.$/);
  assert.deepEqual(runnerWaiters(w.store), []);
});

test('onlineRunners matches the scheme label, its -linux twin and the -desktop session runner, online only', () => {
  const r = (name: string, status: string, ...labels: string[]) => ({ name, status, labels: labels.map((name) => ({ name })) });
  const got = onlineRunners([r('a', 'online', 'peek-auras-ci'), r('b', 'online', 'peek-auras-ci-linux'), r('c', 'offline', 'peek-auras-ci'), r('d', 'online', 'peek-auras-ci-mac'), { name: 'e', status: 'online' }, r('f', 'online', 'peek-auras-desktop'), r('g', 'offline', 'peek-auras-desktop'), r('h', 'online', 'delve-desktop')], 'Peek Auras');
  assert.deepEqual(got.map((x) => x.name), ['a', 'b', 'f']);
});

// ---------- the land gate's alarm (#561) ----------
// Waits.poll feeds every landing in the line each 2 s: its phase (landPhase's key, or 'line' while it waits) and
// its CI gate run's stage as ci-wait last read it.
const land = (seq: number, name: string, phase: string, ci: string | null = null, run: number | null = null) => ({ seq, name, phase, ci, run });

/** One landing's whole way through the line, a poll per phase, from `t`; returns the time it left. */
function through(state: LandState, seq: number, name: string, phases: [string, string | null, number][], t: number, run: number | null = null): number {
  for (const [phase, ci, ms] of phases) {
    landStep(state, [land(seq, name, phase, ci, ci ? run : null)], t);
    t += ms;
  }
  landStep(state, [], t);
  return t;
}
const capHit: [string, string | null, number][] = [['rebase', null, 5_000], ['ci', null, 20_000], ['ci', 'jobs', 6 * MIN], ['tests', null, 4 * MIN], ['deploy', null, MIN]];
const noJob: [string, string | null, number][] = [['rebase', null, 5_000], ['ci', null, 95_000], ['tests', null, 4 * MIN], ['deploy', null, MIN]];
const green: [string, string | null, number][] = [['rebase', null, 5_000], ['ci', 'jobs', 2 * MIN], ['deploy', null, MIN]];
const desktopOff: [string, string | null, number][] = [['rebase', null, 5_000], ['tests', null, 4 * MIN], ['deploy', null, MIN]];

test('the land gate alarms once CI falls back to perigee on 2 lands in a row, naming each and why, and the next green land clears it (#561)', () => {
  const s = newLandState();
  let t = NOW;
  t = through(s, 1, '#544', capHit, t, 43082450082);
  assert.deepEqual(landProblems(s, t), [], 'one fallback is no alarm');
  t = through(s, 2, '#555', noJob, t);
  assert.deepEqual(landProblems(s, t), [{
    key: 'land:fallback',
    title: "CI: the land gate fell back to perigee on 2 lands in a row: #544 (the desktop suite hit the 6-min cap, run 43082450082), #555 (GitHub never started its run)",
  }]);
  t = through(s, 3, '#556', capHit, t, 7);
  assert.match(landProblems(s, t)[0].title, /^CI: the land gate fell back to perigee on 3 lands in a row: #544 .*, #555 .*, #556 \(the desktop suite hit the 6-min cap, run 7\)$/);
  t = through(s, 4, '#557', green, t);
  assert.deepEqual(landProblems(s, t), [], 'a green gate clears it');
  t = through(s, 5, '#558', capHit, t);
  assert.deepEqual(landProblems(s, t), [], 'and starts the count again');
});

test("the land gate's alarm: a job no runner took is named as that, not as a cap hit; a land that never reached CI (desktop off, LAND_CI=0) neither counts nor clears (#561)", () => {
  const s = newLandState();
  let t = NOW;
  t = through(s, 1, '#1', [['rebase', null, 5_000], ['ci', 'queued', 95_000], ['tests', null, 4 * MIN], ['deploy', null, MIN]], t, 9);
  t = through(s, 2, '#2', desktopOff, t);
  assert.deepEqual(landProblems(s, t), [], "the desktop off isn't the gate failing: the runner-offline alert covers it");
  // Only what CI said while the land waited on it counts: ci-wait drops the run once the land moves on.
  t = through(s, 3, '#3', [['rebase', null, 5_000], ['ci', 'jobs', 30_000], ['ci', 'failed', 2_000], ['tests', null, 4 * MIN], ['deploy', null, MIN]], t, 10);
  assert.equal(landProblems(s, t)[0]?.title, 'CI: the land gate fell back to perigee on 2 lands in a row: #1 (no runner started its job, run 9), #3 (its run failed before the tests ran, run 10)');
  t = through(s, 4, '#4', desktopOff, t);
  assert.equal(landProblems(s, t).length, 1, 'still open: only a green gate clears it');
  // A land refused in CI (red tests) leaves from the CI phase: no fallback, no green.
  t = through(s, 5, '#5', [['rebase', null, 5_000], ['ci', 'failed', 3 * MIN]], t);
  assert.equal(landProblems(s, t).length, 1);
  // tools/deploy.sh on its own goes straight to deploying: not a land, so not green either.
  assert.equal(landProblems(s, through(s, 6, 'tools/deploy.sh', [['deploy', null, MIN]], t)).length, 1);
});

test('a land in the line over 30 min alarms, waiting in line included, until that land ends (#561)', () => {
  const s = newLandState();
  const t = NOW;
  landStep(s, [land(1, '#549', 'tests'), land(2, '#551', 'line')], t);
  landStep(s, [land(1, '#549', 'tests'), land(2, '#551', 'line')], t + 29 * MIN);
  assert.deepEqual(landProblems(s, t + 29 * MIN), []);
  landStep(s, [land(2, '#551', 'rebase'), land(3, '#552', 'line')], t + 31 * MIN);
  const slow = landProblems(s, t + 31 * MIN);
  assert.deepEqual(slow, [{ key: 'land:slow', title: `CI: #551 has been landing since ${clock(t)} (over 30 min)` }]);
  assert.deepEqual(landProblems(s, t + 40 * MIN), slow, 'the words stay put as the minutes pass, so it is not re-sent');
  landStep(s, [land(3, '#552', 'rebase')], t + 41 * MIN);
  assert.deepEqual(landProblems(s, t + 41 * MIN), [], 'cleared when #551 left the line');
  landStep(s, [land(3, '#552', 'rebase'), land(4, '#553', 'line')], t + 70 * MIN);
  assert.match(landProblems(s, t + 70 * MIN)[0].title, /^CI: #552 has been landing since /);
});

test("the land alarm joins CI health's one alert under the live scheme, rings within the poll, and clears itself (#561)", async () => {
  const w = world();
  let t = NOW;
  const seen = (seq: number, name: string, phase: string, ci: string | null = null) => w.health.land(w.peek.id, [land(seq, name, phase, ci)], t);
  for (const [seq, name] of [[1, '#544'], [2, '#555']] as const) {
    for (const [phase, ci, ms] of capHit) { await seen(seq, name, phase, ci); t += ms; }
    await w.health.land(w.peek.id, [], t);
  }
  assert.deepEqual(w.puts, [['Cara', 'ci.open', 'CI, Peek Auras: the land gate fell back to perigee on 2 lands in a row: #544 (the desktop suite hit the 6-min cap), #555 (the desktop suite hit the 6-min cap)']]);
  assert.deepEqual(w.quiet, [], 'an alarm');
  // The 5-min poll keeps it, with GitHub's own problems beside it.
  await w.health.tick(t);
  assert.equal(w.puts.length, 1, 'not re-sent');
  for (const [phase, ci, ms] of green) { await seen(3, '#556', phase, ci); t += ms; }
  await w.health.land(w.peek.id, [], t);
  assert.deepEqual(w.puts.at(-1), ['Cara', 'ci.open', null]);
  // A restart remembers the line and the count.
  for (const [phase, ci, ms] of capHit) { await seen(4, '#557', phase, ci); t += ms; }
  await w.health.land(w.peek.id, [], t);
  const again = new CiHealth(w.store, w.deps);
  for (const [phase, ci, ms] of capHit) { await again.land(w.peek.id, [land(5, '#558', phase, ci)], t); t += ms; }
  await again.land(w.peek.id, [], t);
  assert.match(w.puts.at(-1)![2]!, /2 lands in a row: #557 .*#558/);
});

test('a failed scheduled run on main tells its scheme\'s Taskmaster once, failed step and link included; green, push and old runs say nothing (#588)', async () => {
  const w = world();
  const told: [string, string][] = [];
  const deps = { ...w.deps, tell: (p: { name: string }, text: string) => (told.push([p.name, text]), true) };
  const health = new CiHealth(w.store, deps);
  const nightly = (fields: Partial<Run>) => runOf({ name: 'Tests', workflow_id: 9, created_at: iso(2 * HOUR), ...fields });
  const red = nightly({ id: 4242, head_sha: 'abc1234def', conclusion: 'failure' });
  w.gh.jobs.set(4242, [job({ run_id: 4242, name: 'tests', conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run the suite', conclusion: 'failure' }] })]);
  // GitHub's event=schedule filter keeps push runs out; a green nightly (before the red one: no back to green), one still running and a red one from two days ago say nothing.
  w.gh.scheduled = [nightly({ conclusion: 'success', created_at: iso(3 * HOUR) }), nightly({ status: 'in_progress', conclusion: null }), red, nightly({ conclusion: 'failure', created_at: iso(48 * HOUR) })];
  await health.tick(NOW);
  assert.equal(told.length, 1);
  assert.equal(told[0][0], 'Peek Auras');
  assert.match(told[0][1], /^Peek Auras's scheduled Tests run on main failed on abc1234, at tests › Run the suite \(finished Nov 5, 02:00 PST\): https:\/\/github\.com\/caraminden\/peek-auras\/actions\/runs\/4242\n/);
  assert.deepEqual(w.puts, [], 'not a Mandate alert');

  await health.tick(NOW + 5 * MIN);
  assert.equal(told.length, 1, 'a second poll does not repeat it');
  await new CiHealth(w.store, deps).tick(NOW + 10 * MIN);
  assert.equal(told.length, 1, 'nor does a restart');

  // The next night's red run is a new run, so it tells again; one whose jobs can't say where just leaves that out.
  w.gh.scheduled = [nightly({ id: 4343, head_sha: 'def5678abc', conclusion: 'failure', created_at: iso(MIN) }), ...w.gh.scheduled];
  await health.tick(NOW + 15 * MIN);
  assert.equal(told.length, 2);
  assert.match(told[1][1], /^Peek Auras's scheduled Tests run on main failed on def5678 \(finished Nov 5, 03:59 PST\): https:\/\/github\.com\/caraminden\/peek-auras\/actions\/runs\/4343\n/);
});

test('a failed scheduled run waits, untold, while nothing can tell the Taskmaster: no hook, no Taskmaster, or a send that throws (#588)', async () => {
  const w = world();
  // Queued for most of a day before it ran: aged by when it ended.
  w.gh.scheduled = [runOf({ id: 4444, name: 'Tests', conclusion: 'failure', created_at: iso(30 * HOUR), updated_at: iso(HOUR) })];
  await w.health.tick(NOW);
  const told: string[] = [];
  let answer: 'none' | 'throw' | 'ok' = 'none';
  const health = new CiHealth(w.store, { ...w.deps, tell: (_p, text) => {
    if (answer === 'throw') throw new Error('send failed');
    if (answer === 'ok') told.push(text);
    return answer === 'ok';
  } });
  await health.tick(NOW + 5 * MIN);
  answer = 'throw';
  await health.tick(NOW + 10 * MIN);
  assert.deepEqual(told, []);
  answer = 'ok';
  await health.tick(NOW + 15 * MIN);
  await health.tick(NOW + 20 * MIN);
  assert.equal(told.length, 1);
});

test("a failed scheduled run whose jobs can't be read still tells, without the step (#588)", async () => {
  const w = world();
  const told: string[] = [];
  const health = new CiHealth(w.store, { ...w.deps, tell: (_p, text) => (told.push(text), true) });
  w.gh.scheduled = [runOf({ id: 4545, name: 'Tests', head_sha: 'feed123abc', conclusion: 'failure' })];
  w.gh.down = /runs\/4545\/jobs/;
  await health.tick(NOW);
  assert.equal(told.length, 1);
  assert.match(told[0], /^Peek Auras's scheduled Tests run on main failed on feed123 \(finished [^)]+ PST\): https:/);
});

/** A world whose minions and Taskmaster hear of runs no PR started (#678), with what each was sent. */
function outsideWorld() {
  const w = world({ delve: true });
  const woken: [number, string, boolean][] = [];
  const told: [string, string][] = [];
  const deps = { ...w.deps, wake: (id: number, text: string, fyi?: boolean) => void woken.push([id, text, !!fyi]), tell: (p: { name: string }, text: string) => (told.push([p.name, text]), true) };
  const minion = (project: number, branch: string) => {
    const t = w.store.createTicket({ project_id: project, title: branch, permission_mode: 'default', created_by: 1 } as any);
    w.store.setTicketDir(t.id, '/tmp/x', branch);
    return t;
  };
  return { ...w, woken, told, outside: deps, minion };
}
const dispatched = (fields: Partial<Run>) => runOf({ event: 'workflow_dispatch', name: 'stress', workflow_id: 11, path: '.github/workflows/stress.yml', created_at: iso(10 * MIN), updated_at: iso(5 * MIN), ...fields });

test('a run a minion dispatched on its branch wakes it once with its result, red or green, across a restart; others say nothing (#678)', async () => {
  const w = outsideWorld();
  const mine = w.minion(w.peek.id, 'ticket/12-stress');
  const closed = w.minion(w.peek.id, 'ticket/13-done');
  w.store.updateTicket(closed.id, { status: 'closed' });
  // Delve's own minion on the same branch name never hears Peek's run.
  w.minion(w.store.listProjects().find((p) => p.name === 'Delve')!.id, 'ticket/12-stress');
  // Ended before the first poll that read dispatched runs: history from before the deploy, not news.
  w.gh.dispatched = [dispatched({ id: 5000, head_branch: 'ticket/12-stress', conclusion: 'failure', updated_at: iso(2 * HOUR) })];
  const health = new CiHealth(w.store, w.outside);
  await health.tick(NOW - HOUR);
  assert.deepEqual(w.woken, []);

  const failed = job({ run_id: 5001, name: 'stress', conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run it', conclusion: 'failure' }] });
  w.gh.jobs.set(5001, [failed]);
  w.gh.notes.set(failed.id, [{ message: 'Process completed with exit code 1.', annotation_level: 'failure' }, { message: 'bar_fill:\n 3 of 100 runs failed', annotation_level: 'failure' }, { message: 'Node 20 is deprecated', annotation_level: 'warning' }]);
  w.store.putCiFile({ project_id: w.peek.id, workflow: 'stress.yml', run_id: 5001, run_attempt: 1, sha: 'a'.repeat(40), ref: 'refs/heads/ticket/12-stress', name: 'stress-5001.txt', kind: 'report', target: '', size: 10, sha256: 'b'.repeat(64), created_at: NOW });
  w.gh.dispatched = [
    dispatched({ id: 5004, head_branch: 'ticket/99-gone', conclusion: 'failure' }), // nobody's branch
    dispatched({ id: 5003, head_branch: 'ticket/13-done', conclusion: 'failure' }), // a dismissed minion's
    dispatched({ id: 5002, head_branch: 'ticket/12-stress', conclusion: 'success', created_at: iso(8 * MIN), head_sha: 'feedface00' }),
    dispatched({ id: 5001, head_branch: 'ticket/12-stress', conclusion: 'failure', head_sha: 'abc1234fff' }),
    ...w.gh.dispatched,
  ];
  await health.tick(NOW);
  assert.equal(w.woken.length, 2);
  const [red, green] = w.woken;
  assert.equal(red[0], mine.id);
  assert.equal(red[2], false, 'a red run is work to do');
  assert.equal(red[1], [
    'Your dispatched stress run on ticket/12-stress failed, at stress › Run it (abc1234, finished Nov 5, 03:55 PST): https://github.com/caraminden/peek-auras/actions/runs/5001',
    "GitHub's error lines:",
    '- bar_fill: 3 of 100 runs failed',
    "Its files in Citadel's CI store (ci_files with run: 5001): stress-5001.txt (report).",
    '`ci-failures 5001 -R caraminden/peek-auras` prints its failing tests.',
  ].join('\n'));
  assert.deepEqual(green, [mine.id, 'Your dispatched stress run on ticket/12-stress passed (feedfac, finished Nov 5, 03:55 PST): https://github.com/caraminden/peek-auras/actions/runs/5002', true]);
  assert.deepEqual(w.told, [], 'none of these is the Taskmaster\'s');

  await health.tick(NOW + 5 * MIN);
  await new CiHealth(w.store, w.outside).tick(NOW + 10 * MIN);
  assert.equal(w.woken.length, 2, 'not again, nor after a restart');
});

test('a red scheduled run, or a red dispatched one on main, is one message to the Taskmaster; the next green says back to green once; a quiet workflow says nothing (#678)', async () => {
  const w = outsideWorld();
  const health = new CiHealth(w.store, w.outside);
  await health.tick(NOW - HOUR); // dispatched runs count from here
  const drift = (fields: Partial<Run>) => runOf({ event: 'schedule', name: 'drift', workflow_id: 12, path: '.github/workflows/drift.yml', created_at: iso(30 * MIN), updated_at: iso(20 * MIN), ...fields });
  w.gh.scheduled = [drift({ id: 6002, head_sha: 'd1d1d1d1d1', conclusion: 'failure' })];
  w.gh.dispatched = [dispatched({ id: 6001, name: 'windows', workflow_id: 13, path: '.github/workflows/windows.yml', head_sha: 'e2e2e2e2e2', conclusion: 'failure', triggering_actor: { login: 'josh' } })];
  await health.tick(NOW);
  assert.equal(w.told.length, 2);
  assert.match(w.told[0][1], /^Peek Auras's scheduled drift run on main failed on d1d1d1d \(finished Nov 5, 03:40 PST\): https:\/\/github\.com\/caraminden\/peek-auras\/actions\/runs\/6002\n/);
  assert.match(w.told[0][1], /To stop these for drift\.yml, add it to the scheme's quiet CI workflows/);
  assert.match(w.told[1][1], /^Peek Auras's dispatched \(by josh\) windows run on main failed on e2e2e2e \(finished Nov 5, 03:55 PST\): https:\/\/github\.com\/caraminden\/peek-auras\/actions\/runs\/6001\n/);
  assert.deepEqual(w.woken, []);

  await health.tick(NOW + 5 * MIN);
  await new CiHealth(w.store, w.outside).tick(NOW + 10 * MIN);
  assert.equal(w.told.length, 2, 'not again, nor after a restart');

  // The next green of each says so once; a green after that says nothing.
  w.gh.scheduled = [drift({ id: 6003, head_sha: 'f3f3f3f3f3', created_at: iso(-MIN), updated_at: iso(-10 * MIN) }), ...w.gh.scheduled];
  w.gh.dispatched = [dispatched({ id: 6004, name: 'windows', workflow_id: 13, path: '.github/workflows/windows.yml', head_sha: 'a4a4a4a4a4', created_at: iso(-MIN), updated_at: iso(-10 * MIN) }), ...w.gh.dispatched];
  await health.tick(NOW + 15 * MIN);
  await new CiHealth(w.store, w.outside).tick(NOW + 20 * MIN);
  assert.deepEqual(w.told.slice(2).map(([, t]) => t), [
    "Peek Auras's drift is back to green on main: https://github.com/caraminden/peek-auras/actions/runs/6003 (f3f3f3f, Nov 5, 04:10 PST), after run 6002 failed.",
    "Peek Auras's windows is back to green on main: https://github.com/caraminden/peek-auras/actions/runs/6004 (a4a4a4a, Nov 5, 04:10 PST), after run 6001 failed.",
  ]);
  w.gh.scheduled = [drift({ id: 6005, created_at: iso(-20 * MIN), updated_at: iso(-25 * MIN) }), ...w.gh.scheduled];
  await health.tick(NOW + 30 * MIN);
  assert.equal(w.told.length, 4);

  // Quieted in the scheme's settings: its red runs no longer tell.
  w.store.setProjectSettings(w.peek.id, { ci_quiet: 'drift.yml' });
  w.gh.scheduled = [drift({ id: 6006, conclusion: 'failure', created_at: iso(-30 * MIN), updated_at: iso(-35 * MIN) }), ...w.gh.scheduled];
  await health.tick(NOW + 40 * MIN);
  assert.equal(w.told.length, 4);
});

test('a red nightly fixed by a push to main says back to green from that push run; a red waiting for a Taskmaster reads GitHub once (#678)', async () => {
  const w = outsideWorld();
  let taskmaster = false;
  const health = new CiHealth(w.store, { ...w.outside, tell: (p: { name: string }, text: string) => (taskmaster && w.told.push([p.name, text]), taskmaster) });
  // Workflow 7 (desktop) runs nightly and on every push to main.
  const nightly = runOf({ id: 7001, event: 'schedule', workflow_id: 7, conclusion: 'failure', created_at: iso(3 * HOUR), updated_at: iso(2 * HOUR) });
  w.gh.jobs.set(7001, [job({ run_id: 7001, conclusion: 'failure' })]);
  w.gh.scheduled = [nightly];
  w.gh.mainRuns = [nightly];
  await health.tick(NOW);
  const reads = () => w.gh.calls.filter((c) => /runs\/7001\/jobs|check-runs/.test(c)).length;
  const first = reads();
  assert.ok(first > 0);
  await health.tick(NOW + 5 * MIN);
  assert.equal(reads(), first, 'no Taskmaster yet: the next poll retries from what it read');
  taskmaster = true;
  await health.tick(NOW + 10 * MIN);
  assert.equal(w.told.length, 1);

  w.gh.mainRuns = [runOf({ id: 7002, event: 'push', workflow_id: 7, head_sha: 'c0ffee0000', created_at: iso(HOUR), updated_at: iso(50 * MIN) }), nightly];
  await health.tick(NOW + 15 * MIN);
  await health.tick(NOW + 20 * MIN);
  assert.deepEqual(w.told.slice(1).map(([, t]) => t), ["Peek Auras's desktop is back to green on main: https://github.com/caraminden/peek-auras/actions/runs/7002 (c0ffee0, Nov 5, 03:10 PST), after run 7001 failed."]);
});

test('a watched workflow gone red on main wakes the Taskmaster once per red streak, from any trigger, and says back to green as held mail (#774)', async () => {
  const w = outsideWorld();
  const told: [string, boolean][] = [];
  let taskmaster = true;
  const deps = { ...w.outside, tell: (_p: { name: string }, text: string, wake?: boolean) => (taskmaster && told.push([text, !!wake]), taskmaster) };
  const health = new CiHealth(w.store, deps);
  const push = (fields: Partial<Run>) => runOf({ event: 'push', name: 'Desktop', workflow_id: 7, path: '.github/workflows/desktop.yml', triggering_actor: { login: 'caraminden' }, ...fields });
  w.gh.jobs.set(8001, [
    job({ run_id: 8001, name: 'build', conclusion: 'failure', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'failure' }] }),
    job({ run_id: 8001, name: 'package', conclusion: 'failure', steps: [] }),
    job({ run_id: 8001, name: 'lint', conclusion: 'success' }),
  ]);
  w.gh.mainRuns = [push({ id: 8001, head_sha: 'bad0001fff', conclusion: 'failure', created_at: iso(40 * MIN), updated_at: iso(30 * MIN) })];
  await health.tick(NOW);
  assert.deepEqual(told, [], 'not watched yet: a red push run says nothing');

  // Watched while main is already red: told at once, waking the Taskmaster.
  w.store.setProjectSettings(w.peek.id, { ci_watch: 'desktop.yml' });
  await health.tick(NOW + 5 * MIN);
  assert.equal(told.length, 1);
  assert.equal(told[0][1], true, 'it wakes the Taskmaster');
  assert.match(told[0][0], /^Peek Auras's main went red: desktop\.yml \(Desktop\) run 8001 failed on bad0001 \(push by caraminden, finished Nov 5, 03:30 PST\): https:\/\/github\.com\/caraminden\/peek-auras\/actions\/runs\/8001\nFailing jobs: build › Run tests; package\n/);
  assert.match(told[0][0], /`ci-failures 8001 -R caraminden\/peek-auras` prints its failing tests\. Later red runs of desktop\.yml won't message you again/);

  // Later red runs in the streak, and one still running, say nothing, across a restart too.
  w.gh.mainRuns = [push({ id: 8003, status: 'in_progress', conclusion: null, created_at: iso(MIN) }), push({ id: 8002, conclusion: 'failure', created_at: iso(20 * MIN) }), ...w.gh.mainRuns];
  await health.tick(NOW + 10 * MIN);
  await new CiHealth(w.store, deps).tick(NOW + 15 * MIN);
  assert.equal(told.length, 1, 'once per streak');

  // The streak ends green: held mail, once.
  w.gh.mainRuns = [push({ id: 8004, head_sha: 'a00d000fff', created_at: iso(-MIN), updated_at: iso(-10 * MIN) }), ...w.gh.mainRuns.slice(1)];
  await health.tick(NOW + 20 * MIN);
  await health.tick(NOW + 25 * MIN);
  assert.deepEqual(told.slice(1), [["Peek Auras's Desktop is back to green on main: https://github.com/caraminden/peek-auras/actions/runs/8004 (a00d000, Nov 5, 04:10 PST), after run 8001 failed.", false]]);

  // The next red starts a new streak, waiting untold while there's no Taskmaster; then a re-run of it going green ends it.
  taskmaster = false;
  w.gh.mainRuns = [push({ id: 8005, head_sha: 'bad0005fff', conclusion: 'failure', created_at: iso(-20 * MIN), updated_at: iso(-25 * MIN) }), ...w.gh.mainRuns];
  await health.tick(NOW + 30 * MIN);
  assert.equal(told.length, 2);
  taskmaster = true;
  await health.tick(NOW + 35 * MIN);
  assert.equal(told.length, 3);
  assert.match(told[2][0], /^Peek Auras's main went red: desktop\.yml \(Desktop\) run 8005 failed on bad0005 /);
  w.gh.mainRuns = [{ ...w.gh.mainRuns[0], conclusion: 'success', run_attempt: 2, updated_at: iso(-40 * MIN) }, ...w.gh.mainRuns.slice(1)];
  await health.tick(NOW + 40 * MIN);
  assert.equal(told.length, 4);
  assert.match(told[3][0], /back to green on main: .*runs\/8005 .*after run 8005 failed\.$/);
  assert.equal(told[3][1], false);
});

test('orphanRuns: queued land/** runs over an hour old that no landing holds', () => {
  const old = (f: Partial<Run>) => runOf({ status: 'queued', conclusion: null, head_branch: 'land/ticket/550-x', created_at: iso(ORPHAN_MS + MIN), ...f });
  const orphan = old({ id: 1 });
  const line = { 7: { name: '#551', run: 99 }, 8: { name: 'deploy', run: null } };
  const runs = [
    orphan,
    old({ id: 2, created_at: iso(ORPHAN_MS - MIN) }), // young
    old({ id: 3, head_branch: 'main' }), // not a land branch
    old({ id: 4, status: 'in_progress' }),
    old({ id: 99 }), // a landing's run
    old({ id: 5, head_branch: 'land/ticket/551-y' }), // a landing's ticket, run not read yet
    old({ id: 6, head_branch: 'land/ticket/5510-z' }), // #5510 is not #551
  ];
  assert.deepEqual(orphanRuns(runs, line, NOW).map((r) => r.id), [1, 6]);
  const waiting = { ...line, 9: { name: '#552', run: null, ciSince: NOW - MIN } };
  assert.deepEqual(orphanRuns(runs, waiting, NOW), [], 'a landing in its CI wait with no run read yet may take any run of its commit');
});

test('the poll cancels an orphan land run once and logs it, and leaves a landing\'s run alone', async () => {
  const w = world();
  const posts: string[] = [];
  const line2 = { project: w.peek.id, problems: [], state: { fellBack: [], lands: { 1: { name: '#551', joined: NOW - HOUR }, 2: { name: '#552', joined: NOW, ciSince: NOW, run: 4003 } } } };
  // A landing takes the second orphan while the first is being cancelled.
  const health = new CiHealth(w.store, { ...w.deps, post: async (path) => (posts.push(path), w.store.setSetting('ci-health:land', line2), { status: 202 }) });
  const old = (id: number, fields: Partial<Run> = {}) => runOf({ id, status: 'queued', conclusion: null, head_branch: 'land/ticket/550-x', created_at: iso(2 * HOUR), ...fields });
  w.gh.runs = [old(4001), old(4002, { head_branch: 'land/ticket/551-y' }), old(4003)];
  const line = { project: w.peek.id, problems: [], state: { fellBack: [], lands: { 1: { name: '#551', joined: NOW - HOUR } } } };
  await health.tick(NOW);
  assert.deepEqual(posts, [], 'no land line kept for this scheme: nothing is cancelled');
  w.store.setSetting('ci-health:land', line);
  await health.tick(NOW + 10 * MIN);
  await health.tick(NOW + 20 * MIN);
  assert.deepEqual(posts, ['repos/caraminden/peek-auras/actions/runs/4001/cancel']);
});
