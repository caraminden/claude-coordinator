// CI health (src/ci-health.ts, #368): the four rules on GitHub answers shaped like Peek Auras' real ones, and the
// poller putting and clearing admins' Mandate alerts.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  CiHealth, OFFLINE_MS, QUEUED_MS, VERDICT_MS, deadGroups, deadProblem, ghGet, itemKey, neverStarted, queuedProblems,
  runnerProblems, skippedProblem, verdictPair, verdictProblem, type GhAnswer, type Job, type Run,
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
  assert.match(p.title, /^CI: runner DESKTOP-G248IJ8-desktop has been offline since \d\d:\d\d$/);
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
  const p = deadProblem(groups[0], BILLING, NOW);
  assert.equal(p.key, 'nostart:windows-latest');
  assert.match(p.title, /^CI: 3 jobs on windows-latest didn't start since \d\d:\d\d, so they aren't test failures\. GitHub says: "The job was not started because recent account payments have failed/);
  assert.match(deadProblem({ labels: 'x', dead: [dead(HOUR)] }, null, NOW).title, /1 job on x didn't start since .*, so it isn't a test failure\.$/);

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

test('a green run that skipped jobs which ran the time before alerts; jobs skipped both times do not', () => {
  const wf = { id: 7, name: 'desktop' };
  const before = [job({ name: 'screen' }), job({ name: 'capture', conclusion: 'failure' }), job({ name: 'nightly', conclusion: 'skipped' })];
  const latest = runOf({ head_sha: 'a1b2c3d9999' });
  const p = skippedProblem(wf, 'main', latest, [job({ name: 'screen', conclusion: 'skipped' }), job({ name: 'capture', conclusion: 'skipped' }), job({ name: 'nightly', conclusion: 'skipped' }), job({ name: 'gate' })], before);
  assert.equal(p?.key, 'skipped:7');
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

function world() {
  const dir = mkdtempSync(join(root, 'w-'));
  const store = new Store(join(dir, 'coordinator.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const rachel = store.createUser({ name: 'Rachel', login: 'rachel', admin: true });
  const peek = store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras', cara.id);
  store.createProject('Notes', 'https://github.com/caraminden/notes', cara.id);
  store.createProject('Local', null, cara.id);
  const c = new Contraptions(store, 's'.repeat(40), join(dir, 'keys'));
  const mandate = c.register({ name: 'mandate', title: 'Mandate', port: 9101, icon: '/icon.svg', home_scheme: null, open_paths: '[]', default_model: 'haiku', turn_cap: 200 });
  // Cara and Josh have Mandate; Rachel, an admin, doesn't.
  store.setContraptionUser(mandate.id, cara.id, true, cara.id);
  store.setContraptionUser(mandate.id, josh.id, true, cara.id);

  const gh = {
    runners: [{ name: 'DESKTOP-G248IJ8-desktop', status: 'online' }] as { name: string; status: string }[],
    runs: [] as Run[],
    jobs: new Map<number, Job[]>(),
    mainRuns: [] as Run[],
    calls: [] as string[],
    rateLimited: false,
    down: null as RegExp | null,
  };
  const etagOf = (body: any) => `W/"${JSON.stringify(body).length}-${JSON.stringify(body).split('').reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) | 0, 7)}"`;
  const get = async (path: string, etag: string | null): Promise<GhAnswer> => {
    gh.calls.push(path);
    if (gh.down?.test(path)) return { status: 502, etag: null, body: { message: 'Server Error' } };
    if (gh.rateLimited) return { status: 403, etag: null, body: { message: 'API rate limit exceeded for user ID 1.' } };
    let body: any;
    if (path.startsWith('repos/caraminden/notes/')) body = { total_count: 0, workflows: [] };
    else if (path.endsWith('/actions/workflows?per_page=100')) body = { workflows: [{ id: 7, name: 'desktop', state: 'active' }, { id: 8, name: 'old', state: 'disabled_manually' }] };
    else if (path.endsWith('/actions/runners?per_page=100')) body = { runners: gh.runners };
    else if (path.includes('/actions/workflows/7/runs?branch=main')) body = { workflow_runs: gh.mainRuns };
    else if (path.endsWith('/actions/runs?per_page=50')) body = { workflow_runs: gh.runs };
    else if (path === 'repos/caraminden/peek-auras') body = { default_branch: 'main' };
    else if (/\/runs\/\d+\/jobs/.test(path)) body = { jobs: gh.jobs.get(Number(/runs\/(\d+)\//.exec(path)![1])) ?? [] };
    else if (/check-runs\/\d+\/annotations/.test(path)) body = [{ message: BILLING, annotation_level: 'failure' }];
    else return { status: 404, etag: null, body: { message: 'Not Found' } };
    const tag = etagOf(body);
    return etag === tag ? { status: 304, etag: tag, body: null } : { status: 200, etag: tag, body };
  };
  const puts: [string, string, string | null][] = [];
  const mandateUp = { ok: true };
  const deps = {
    as: () => undefined,
    get,
    mandate: async (p: { name: string }, u: { name: string }, key: string, title: string | null) => {
      puts.push([u.name, key, title]);
      return mandateUp.ok;
    },
  };
  return { store, peek, gh, puts, mandateUp, deps, health: new CiHealth(store, deps) };
}

test('each problem is one Mandate alert per admin with Mandate, updated on change, cleared when fixed, and kept across a restart', async () => {
  const w = world();
  const t0 = Date.now();
  await w.health.tick(t0);
  assert.deepEqual(w.puts, [], 'all clear: nothing sent');
  assert.ok(!w.gh.calls.some((c) => c.startsWith('repos/caraminden/notes/') && !c.includes('/workflows?')), 'a repo with no workflows costs one call');

  // The desktop runner goes offline; 15 minutes later Cara hears, once. Josh isn't an admin; Rachel has no Mandate.
  w.gh.runners = [{ name: 'DESKTOP-G248IJ8-desktop', status: 'offline' }];
  await w.health.tick(t0 + 5 * MIN);
  assert.deepEqual(w.puts, []);
  await w.health.tick(t0 + 5 * MIN + OFFLINE_MS);
  assert.equal(w.puts.length, 1);
  assert.deepEqual(w.puts[0].slice(0, 2), ['Cara', 'ci.runner:DESKTOP-G248IJ8-desktop']);
  assert.match(w.puts[0][2]!, /^CI: runner DESKTOP-G248IJ8-desktop has been offline since/);
  await w.health.tick(t0 + 10 * MIN + OFFLINE_MS);
  assert.equal(w.puts.length, 1, 'unchanged: not put again');

  // A restart remembers both when it went offline and what Cara already has.
  const again = new CiHealth(w.store, w.deps);
  await again.tick(t0 + 15 * MIN + OFFLINE_MS);
  assert.equal(w.puts.length, 1, 'a restart does not re-send');

  // Back online: her item is cleared.
  w.gh.runners = [{ name: 'DESKTOP-G248IJ8-desktop', status: 'online' }];
  await again.tick(t0 + 20 * MIN + OFFLINE_MS);
  assert.deepEqual(w.puts.at(-1), ['Cara', 'ci.runner:DESKTOP-G248IJ8-desktop', null]);
  await again.tick(t0 + 25 * MIN + OFFLINE_MS);
  assert.equal(w.puts.length, 2, 'cleared once');
});

test('billing-blocked jobs make one alert that counts up, quoting GitHub, and Mandate being down is retried', async () => {
  const w = world();
  const t = Date.now();
  const at = (ago: number) => new Date(t - ago).toISOString();
  const runs = [1, 2].map((i) => runOf({ id: 500 + i, name: 'windows', created_at: at(i * 10 * MIN) }));
  w.gh.runs = runs;
  for (const r of runs) w.gh.jobs.set(r.id, [dead(0, { run_id: r.id, created_at: r.created_at })]);
  w.mandateUp.ok = false;
  await w.health.tick(t);
  assert.equal(w.puts.length, 1);
  assert.match(w.puts[0][2]!, /^CI: 2 jobs on windows-latest didn't start since .*GitHub says: "The job was not started because recent account payments/);
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
  assert.equal(w.puts.at(-1)![1], 'ci.nostart:windows-latest');
  assert.match(w.puts.at(-1)![2]!, /^CI: 3 jobs/);
  assert.equal(w.gh.calls.filter((c) => c.includes('/runs/501/jobs')).length, 1, "a finished run's jobs are read once");
  assert.equal(w.gh.calls.filter((c) => c.includes('/annotations')).length, 2, 'one annotation read per newest dead job');

  // Paid: a windows job runs, and the item clears.
  const ok = runOf({ id: 700, name: 'windows', created_at: at(0) });
  w.gh.runs = [ok, third, ...runs];
  w.gh.jobs.set(700, [job({ run_id: 700, labels: ['windows-latest'], created_at: ok.created_at })]);
  await w.health.tick(t + 5 * MIN);
  assert.deepEqual(w.puts.at(-1), ['Cara', 'ci.nostart:windows-latest', null]);
});

test('a rate limit pauses the checks', async () => {
  const w = world();
  w.gh.rateLimited = true;
  const t = Date.now();
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
  const t = Date.now();
  const r = runOf({ id: 801, name: 'windows', created_at: new Date(t - 10 * MIN).toISOString() });
  w.gh.runs = [r];
  w.gh.jobs.set(801, [dead(0, { run_id: 801, created_at: r.created_at })]);
  w.gh.down = /\/runs\/801\/jobs/;
  await w.health.tick(t);
  assert.deepEqual(w.puts, [], 'nothing known, nothing said');
  w.gh.down = null;
  await w.health.tick(t + MIN);
  assert.equal(w.puts.length, 1, 'the jobs are read again once GitHub answers');
  assert.equal(w.puts[0][1], 'ci.nostart:windows-latest');
  for (const down of [/\/actions\/workflows\?/, /\/actions\/runs\?per_page/, /\/workflows\/7\/runs/]) {
    w.gh.down = down;
    await w.health.tick(t + 2 * MIN);
    assert.equal(w.puts.length, 1, `a 502 on ${down} clears nothing`);
  }
});
