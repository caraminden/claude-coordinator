// CI health (src/ci-health.ts, #368): the four rules on GitHub answers shaped like Peek Auras' real ones, and the
// poller putting and clearing admins' Mandate alerts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  CiHealth, addRunnerWaiter, onlineRunners, runnerWaiters, WAIT_MS, HUNG_MS, bundleTitle, deadGroups, deadProblem, ghGet, itemKey, itemText, neverStarted,
  trackOffline, servers, stuckProblems, hungProblems, redProblem, sharedHost, skippedJobs, verdictPair, type GhAnswer, type Job, type Run,
  firstTickDelay, START_DELAY_MS, clock, ORPHAN_MS, orphanRuns, landProblems, landStep, newLandState, LAND_RING_STREAK, LAND_RING_MS, RED_FIX_MS, type LandState,
} from '../src/ci-health.ts';
import { Contraptions } from '../src/contraptions.ts';
import type { AlertPart } from '../src/alert-wakes.ts';
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

test('trackOffline remembers when each runner went offline, forgetting it once back or gone', () => {
  const offline: Record<string, number> = {};
  const runners = [{ name: 'DESKTOP-G248IJ8-desktop', status: 'offline' }, { name: 'DESKTOP-G248IJ8', status: 'online' }];
  trackOffline(runners, offline, NOW);
  trackOffline(runners, offline, NOW + HOUR);
  assert.deepEqual(offline, { 'DESKTOP-G248IJ8-desktop': NOW }, 'first seen offline, kept');
  trackOffline([{ name: 'DESKTOP-G248IJ8-desktop', status: 'online' }], offline, NOW + HOUR);
  assert.deepEqual(offline, {}, 'back online forgets when it went');
  trackOffline(runners, offline, NOW);
  trackOffline([], offline, NOW + HOUR);
  assert.deepEqual(offline, {}, 'a runner removed from GitHub is forgotten');
});

// Peek's runners as GitHub lists them: four Windows runners on one PC, labelled peek-auras-ci.
const peekRunner = (name: string, status: string, label = 'peek-auras-ci') => ({ name, status, labels: [{ name: 'self-hosted' }, { name: 'Windows' }, { name: 'X64' }, { name: label }] });
const queued = (msAgo: number, labels = ['self-hosted', 'peek-auras-ci']) => job({ status: 'queued', conclusion: null, runner_name: null, steps: [], labels, created_at: iso(msAgo) });

test('work stuck on offline runners rings after 10 min, naming the runners, since when and the PC to turn on (#968)', () => {
  const down = ['DESKTOP-G248IJ8', 'DESKTOP-G248IJ8-2'].map((n) => peekRunner(n, 'offline'));
  const offline = { 'DESKTOP-G248IJ8': NOW - 3 * HOUR, 'DESKTOP-G248IJ8-2': NOW - 2 * HOUR };
  const [p, ...rest] = stuckProblems(down, [queued(14 * MIN), queued(12 * MIN), queued(WAIT_MS - 1)], offline, NOW);
  assert.equal(rest.length, 0);
  assert.equal(p.key, 'stuck:self-hosted, peek-auras-ci');
  assert.equal(p.quiet, undefined, 'it rings');
  assert.equal(p.title, `CI: 2 jobs on self-hosted, peek-auras-ci have waited for a runner since ${clock(NOW - 14 * MIN)}`);
  assert.equal(p.why, `every runner that serves self-hosted, peek-auras-ci (DESKTOP-G248IJ8, DESKTOP-G248IJ8-2) is offline, since ${clock(NOW - 3 * HOUR)}`);
  assert.match(p.fix!, /^turn on DESKTOP-G248IJ8 or restart its runner service/);
  assert.match(clock(NOW), /^Nov 5, 04:00 PST$/, 'times are Pacific');

  assert.deepEqual(stuckProblems(down, [queued(WAIT_MS - 1)], offline, NOW), [], 'under 10 min it waits');
  assert.deepEqual(stuckProblems(down, [], offline, NOW), [], 'offline with nothing waiting is the page\'s');
  assert.deepEqual(stuckProblems([...down, peekRunner('DESKTOP-G248IJ8-3', 'online')], [queued(HOUR)], offline, NOW), [], 'a queue behind a busy online runner is the page\'s');
  assert.deepEqual(stuckProblems(down, [queued(HOUR, ['windows-latest'])], offline, NOW), [], "GitHub's hosted runners aren't the repo's");
  assert.equal(servers([peekRunner('A', 'online', 'PEEK-AURAS-CI')], { labels: ['peek-auras-ci'] }).length, 1, 'labels match case-blind');
});

test('a runner on one job over 2 h rings as probably hung; under that is the page\'s (#968)', () => {
  const running = (msAgo: number) => job({ status: 'in_progress', conclusion: null, run_id: 44370680700, name: 'windows', runner_name: 'DESKTOP-G248IJ8-3', started_at: iso(msAgo) });
  assert.deepEqual(hungProblems([running(HUNG_MS - MIN), queued(3 * HOUR)], NOW), []);
  const [p] = hungProblems([running(HUNG_MS)], NOW);
  assert.equal(p.key, 'hung:DESKTOP-G248IJ8-3');
  assert.equal(p.title, `CI: runner DESKTOP-G248IJ8-3 has run windows (run 44370680700) since ${clock(NOW - HUNG_MS)}`);
  assert.match(p.why!, /probably hung/);
  assert.match(p.fix!, /^cancel run 44370680700 on GitHub/);
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
  assert.match(p.title, /^CI: 3 jobs on windows-latest didn't start since Nov \d\d?, \d\d:\d\d PST, so they aren't test failures$/);
  assert.match(p.why!, /^GitHub says: "The job was not started because recent account payments have failed/);
  assert.match(p.fix!, /spending limit/, 'a billing block says where to fix it');
  const none = deadProblem({ labels: 'x', dead: [dead(HOUR)] }, null);
  assert.match(none.title, /1 job on x didn't start since .*, so it isn't a test failure$/);
  assert.match(none.fix!, /^check that a runner carries x/);

  assert.deepEqual(deadGroups([...jobs, job({ labels: ['windows-latest'], created_at: iso(MIN) })]), [], 'a job that started since clears it');
});

test('skippedJobs: the jobs a green run skipped that ran the time before; verdictPair finds the two runs', () => {
  const before = [job({ name: 'screen' }), job({ name: 'capture', conclusion: 'failure' }), job({ name: 'nightly', conclusion: 'skipped' })];
  const latest = runOf({ head_sha: 'a1b2c3d9999' });
  assert.deepEqual(skippedJobs([job({ name: 'screen', conclusion: 'skipped' }), job({ name: 'capture', conclusion: 'skipped' }), job({ name: 'nightly', conclusion: 'skipped' }), job({ name: 'gate' })], before), ['screen', 'capture']);
  assert.deepEqual(skippedJobs([job({ name: 'screen' }), job({ name: 'nightly', conclusion: 'skipped' })], before), []);

  const red = runOf({ conclusion: 'failure' });
  assert.equal(verdictPair([runOf({ conclusion: 'cancelled' }), red, latest]), null, 'only a green newest verdict is checked');
  assert.deepEqual(verdictPair([runOf({ status: 'in_progress', conclusion: null }), latest, runOf({ conclusion: 'cancelled' }), red])?.map((r) => r.id), [latest.id, red.id]);
});

test('a red on main is a quiet item while its fix is on the way, and rings when none starts in an hour or the fix does not hold (#968)', () => {
  const mark = { run: 44370680700, at: iso(2 * HOUR), told: NOW - 30 * MIN, where: 'windows › Test' };
  const red = runOf({ id: 44370680700, workflow_id: 9, conclusion: 'failure', created_at: iso(2 * HOUR) });
  const waiting = redProblem('desktop.yml', 'main', mark, red, null, NOW)!;
  assert.equal(waiting.key, 'red:9');
  assert.equal(waiting.quiet, true);
  assert.equal(waiting.title, 'CI: desktop.yml failed on main (run 44370680700, at windows › Test)');
  assert.match(waiting.fix!, new RegExp(`rings at ${clock(NOW + 30 * MIN)}`));

  const late = redProblem('desktop.yml', 'main', mark, red, null, NOW + 30 * MIN)!;
  assert.equal(late.quiet, false, 'an hour with no fix minion rings');
  assert.match(late.title, /: no fix minion started$/);

  assert.deepEqual(waiting.noFix, { ringsAt: NOW + 30 * MIN, late: false }, 'no fix minion yet says when it rings (#1078)');
  assert.equal(late.noFix?.late, true);
  const rerunning = redProblem('desktop.yml', 'main', { ...mark, rerun: { ticket: 971, sha: 'a1b2c3d9999', tip: 'x', at: NOW, run: 77, dispatched: true } }, red, { number: 971, closedAt: null }, NOW, 'o/r')!;
  assert.deepEqual(rerunning.rerun, { sha: 'a1b2c3d', url: 'https://github.com/o/r/actions/runs/77', state: 'running' });
  assert.equal(rerunning.noFix, undefined);

  const started = redProblem('desktop.yml', 'main', mark, red, { number: 971, closedAt: null }, NOW + 2 * HOUR)!;
  assert.equal(started.quiet, true);
  assert.equal(started.title, 'CI: desktop.yml failed on main (run 44370680700, at windows › Test): fix minion #971 started');

  const closed = { number: 971, closedAt: NOW + HOUR };
  assert.equal(redProblem('desktop.yml', 'main', mark, red, closed, NOW + HOUR + 30 * MIN)!.quiet, true, 'closed, and no verdict since: waiting on the next run');
  const stale = redProblem('desktop.yml', 'main', mark, red, closed, NOW + 2 * HOUR)!;
  assert.equal(stale.quiet, undefined, 'an hour after it closed with no newer run, it rings');
  assert.match(stale.title, /still red an hour after fix minion #971 closed$/);
  const after = runOf({ id: 44370699999, workflow_id: 9, conclusion: 'failure', head_sha: '323bf97aaaa', created_at: new Date(NOW + 90 * MIN).toISOString() });
  const held = redProblem('desktop.yml', 'main', mark, after, closed, NOW + 2 * HOUR)!;
  assert.equal(held.quiet, undefined, 'still red after the fix closed rings');
  assert.match(held.title, /still red after fix minion #971 closed$/);
  assert.match(held.why!, /run 44370699999 on 323bf97/);

  assert.equal(redProblem('desktop.yml', 'main', mark, runOf({ workflow_id: 9 }), null, NOW + 2 * HOUR), null, 'green says nothing');
});

test('an item reads what, why and fix, within Mandate\'s 500 characters', () => {
  assert.equal(itemText({ key: 'k', title: 'CI: a.', why: 'b', fix: 'c.' }), 'CI: a. Why: b. Fix: c.');
  assert.equal(itemText({ key: 'k', title: 'CI: a' }), 'CI: a.');
  assert.equal(itemText({ key: 'k', title: 'x'.repeat(600) }).length, 500);
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
    // GitHub's main tip, for the re-run after a red's fix ships (#1074).
    mainHead: 'aaaa000fff',
    // The repo's CI_RUNNER variable (the kit's switch onto GitHub's runners); null: unset (404).
    ciRunner: null as string | null,
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
    else if (path.endsWith('/actions/workflows?per_page=100')) body = { workflows: [{ id: 7, name: 'desktop', path: '.github/workflows/desktop.yml', state: 'active' }, { id: 8, name: 'old', state: 'disabled_manually' }] };
    else if (path.endsWith('/actions/runners?per_page=100') && gh.runnersDenied) return { status: 403, etag: null, body: { message: 'Resource not accessible by integration' } };
    else if (path === 'repos/caraminden/delve/actions/runners?per_page=100') body = { runners: gh.delveRunners };
    else if (path.endsWith('/actions/runners?per_page=100')) body = { runners: gh.runners };
    else if (path.includes('/actions/workflows/7/runs?branch=main')) body = { workflow_runs: gh.mainRuns };
    else if (path.endsWith('/branches/main')) body = { name: 'main', commit: { sha: gh.mainHead } };
    else if (path.endsWith('/actions/variables/CI_RUNNER') && gh.ciRunner != null) body = { name: 'CI_RUNNER', value: gh.ciRunner };
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
  const parts: (AlertPart[] | undefined)[] = [];
  const from: string[] = [];
  const quiet: string[] = [];
  const links: (string | undefined)[] = [];
  const mandateUp = { ok: true };
  const deps = {
    as: () => undefined,
    get,
    mandate: async (p: { name: string }, u: { name: string }, key: string, title: string | null, q?: boolean, link?: string, about?: AlertPart[]) => {
      puts.push([u.name, key, title]);
      links.push(link);
      parts.push(about);
      from.push(p.name);
      if (q) quiet.push(key);
      return mandateUp.ok;
    },
  };
  return { store, peek, gh, puts, parts, from, quiet, links, mandateUp, deps, health: new CiHealth(store, deps) as CiHealth };
}

// Peek's desktop runner, offline, and a job on its label waiting: the stuck-runner rule's world.
const desk = (status: string, name = 'DESKTOP-G248IJ8-desktop') => ({ name, status, labels: [{ name: 'self-hosted' }, { name: 'peek-auras-ci' }] });
const waitingRun = (w: ReturnType<typeof world>, t: number, id = 3001) => {
  const r = runOf({ id, status: 'queued', conclusion: null, created_at: new Date(t).toISOString() });
  w.gh.runs = [r, ...w.gh.runs];
  w.gh.jobs.set(id, [job({ run_id: id, status: 'queued', conclusion: null, runner_name: null, steps: [], labels: ['self-hosted', 'peek-auras-ci'], created_at: r.created_at })]);
};

test('the CI page reads each scheme it may see: runners with their job, the queue, verdicts on main with skipped jobs, runs and open problems; items link it (#968)', async () => {
  const w = world();
  w.gh.runners = [{ ...desk('online'), busy: true } as any, desk('offline', 'DESKTOP-G248IJ8-2')];
  const running = runOf({ id: 4001, status: 'in_progress', conclusion: null, created_at: iso(5 * MIN) });
  w.gh.runs = [running];
  w.gh.jobs.set(4001, [job({ run_id: 4001, name: 'tests', status: 'in_progress', conclusion: null, runner_name: 'DESKTOP-G248IJ8-desktop', created_at: iso(5 * MIN) }), job({ run_id: 4001, name: 'lint', status: 'queued', conclusion: null, runner_name: null, steps: [], labels: ['self-hosted', 'peek-auras-ci'], created_at: iso(4 * MIN) })]);
  // Green that skipped the Windows job the red before it ran.
  w.gh.mainRuns = [runOf({ id: 5002, conclusion: 'success', created_at: iso(HOUR) }), runOf({ id: 5001, conclusion: 'failure', created_at: iso(2 * HOUR) })];
  w.gh.jobs.set(5002, [job({ run_id: 5002, name: 'windows', conclusion: 'skipped' })]);
  w.gh.jobs.set(5001, [job({ run_id: 5001, name: 'windows', conclusion: 'failure' })]);
  await w.health.tick(NOW);
  waitingRun(w, NOW);
  w.gh.runners = [desk('offline')];
  await w.health.tick(NOW + WAIT_MS);

  const [peek, ...rest] = w.health.snapshot(() => true);
  assert.deepEqual(rest, [], 'only schemes whose repo has CI are listed: Notes has no workflows');
  assert.equal(peek.name, 'Peek Auras');
  const v = peek.view!;
  assert.equal(v.branch, 'main');
  assert.deepEqual(v.runners!.map((r) => [r.name, r.status, r.offlineSince]), [['DESKTOP-G248IJ8-desktop', 'offline', NOW + WAIT_MS]]);
  assert.ok(v.waiting.some((j) => j.name === 'lint'), 'the queue lists the waiting job');
  assert.deepEqual(v.workflows.map((x) => [x.name, x.verdict?.conclusion, x.skipped]), [['desktop', 'success', ['windows']]]);
  assert.ok(v.runs.some((r) => r.id === 3001 && r.url.endsWith('/runs/3001')));
  assert.ok(peek.problems.some((x) => x.key.startsWith('stuck:')), 'the ringing problem is on the page with its why and fix');
  assert.ok(peek.problems.every((x) => x.why && x.fix));
  assert.equal(w.links.at(-1), `/c/#/p/${w.peek.id}/ci`, 'the alert opens the CI page');
  assert.deepEqual(w.health.snapshot((id) => id !== w.peek.id), [], "a scheme they can't see isn't listed");
});

test('a quieted workflow whose last run on main failed keeps its verdict on the page, marked quiet, and makes no problem (TWIReader #990)', async () => {
  const w = world();
  w.store.setProjectSettings(w.peek.id, { ci_quiet: 'desktop.yml' });
  w.gh.mainRuns = [runOf({ id: 5101, conclusion: 'failure', created_at: iso(HOUR) })];
  await w.health.tick(NOW);
  const peek = w.health.snapshot(() => true).find((s) => s.id === w.peek.id)!;
  assert.deepEqual(peek.view.workflows.map((x) => [x.file, x.verdict?.conclusion, x.quiet]), [['desktop.yml', 'failure', true]], 'the red verdict stays, marked quiet');
  assert.deepEqual(peek.problems, [], 'a quiet workflow never counts toward the scheme\'s red');
  // ci_watch beats ci_quiet, as it does for the wakes, and the mark follows the settings without a new poll.
  w.store.setProjectSettings(w.peek.id, { ci_watch: 'desktop.yml' });
  assert.equal(w.health.snapshot(() => true).find((s) => s.id === w.peek.id)!.view.workflows[0].quiet, false);
});

test('a problem is one Mandate alert per admin with Mandate, cleared when fixed, and kept across a restart', async () => {
  const w = world();
  const t0 = NOW;
  await w.health.tick(t0);
  assert.deepEqual(w.puts, [], 'all clear: nothing sent');
  assert.ok(!w.gh.calls.some((c) => c.startsWith('repos/caraminden/notes/') && !c.includes('/workflows?')), 'a repo with no workflows costs one call');

  // The desktop runner goes offline: with nothing waiting on it, that's the page's, not a ring (#968).
  w.gh.runners = [desk('offline')];
  await w.health.tick(t0 + 5 * MIN);
  await w.health.tick(t0 + HOUR);
  assert.deepEqual(w.puts, []);
  // A job waits on it: 10 minutes later Cara hears, once. Josh isn't an admin; Rachel has no Mandate.
  waitingRun(w, t0 + HOUR);
  await w.health.tick(t0 + HOUR + WAIT_MS - MIN);
  assert.deepEqual(w.puts, []);
  await w.health.tick(t0 + HOUR + WAIT_MS);
  assert.equal(w.puts.length, 1);
  assert.deepEqual(w.puts[0].slice(0, 2), ['Cara', 'ci.open']);
  assert.match(w.puts[0][2]!, /^CI, Peek Auras: 1 job on self-hosted, peek-auras-ci has waited for a runner since .*\. Why: every runner that serves .* \(DESKTOP-G248IJ8-desktop\) is offline, since Nov 5, 04:05 PST\. Fix: /);
  assert.equal(w.from[0], 'CI health', 'from CI health, not the scheme');
  await w.health.tick(t0 + HOUR + WAIT_MS + 5 * MIN);
  assert.equal(w.puts.length, 1, 'unchanged: not put again');

  // A restart remembers both when it went offline and what Cara already has.
  const again = new CiHealth(w.store, w.deps);
  await again.tick(t0 + HOUR + WAIT_MS + 10 * MIN);
  assert.equal(w.puts.length, 1, 'a restart does not re-send');

  // Back online: her item is cleared.
  w.gh.runners = [desk('online')];
  await again.tick(t0 + 2 * HOUR);
  assert.deepEqual(w.puts.at(-1), ['Cara', 'ci.open', null]);
  await again.tick(t0 + 2 * HOUR + 5 * MIN);
  assert.equal(w.puts.length, 2, 'cleared once');
});

test('an alert raised before midnight is not sent again after it (#509)', async () => {
  const w = world();
  const t0 = Date.parse('2026-11-11T07:40:00Z'); // 23:40 PST
  w.gh.runners = [desk('offline')];
  waitingRun(w, t0);
  await w.health.tick(t0);
  await w.health.tick(t0 + WAIT_MS);
  assert.equal(w.puts.length, 1);
  await w.health.tick(t0 + 25 * MIN);
  await w.health.tick(t0 + 9 * HOUR);
  assert.equal(w.puts.length, 1, 'the next day: not put again');
  assert.match(w.puts[0][2]!, /waited for a runner since Nov 10, 23:40 PST\./);
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

test("green with skipped jobs is the page's now: the items an older build sent for it are cleared (#532, #968)", async () => {
  const w = world();
  const t = NOW;
  const at = (ago: number) => new Date(t - ago).toISOString();
  w.store.setSetting(`ci-health:${w.peek.id}`, { offline: {}, sent: { 'skipped:7': { 1: 'CI: desktop on main went green with 1 job skipped' }, 'green-skipped:7': { 1: 'CI: desktop on main went green with 1 job skipped' } } });
  const [green, before] = [runOf({ id: 901, created_at: at(10 * MIN), head_sha: 'a1b2c3d4' }), runOf({ id: 900, created_at: at(HOUR), conclusion: 'failure' })];
  w.gh.mainRuns = [green, before];
  w.gh.jobs.set(901, [job({ run_id: 901, name: 'screen', conclusion: 'skipped' })]);
  w.gh.jobs.set(900, [job({ run_id: 900, name: 'screen', conclusion: 'failure' })]);
  await w.health.tick(t);
  assert.deepEqual(w.puts, [['Cara', 'ci.skipped:7', null], ['Cara', 'ci.green-skipped:7', null]]);
  assert.deepEqual(w.quiet, []);
});

test('the one alert: one problem in full, several counted with each in full, within 500 characters; sharedHost names the PC runners share', () => {
  assert.equal(sharedHost(['DESKTOP-G248IJ8', 'DESKTOP-G248IJ8-2', 'DESKTOP-G248IJ8-perf', 'DESKTOP-G248IJ8-linux-2']), 'DESKTOP-G248IJ8');
  assert.equal(sharedHost(['DESKTOP-G248IJ8-3', 'DESKTOP-G248IJ8-4']), 'DESKTOP-G248IJ8', 'no runner named for the PC alone');
  assert.equal(sharedHost(['DESKTOP-G248IJ8', 'DESKTOP-AB12CD3']), null, "two PCs' default names aren't one PC");
  assert.equal(sharedHost(['DESKTOP-G248IJ8', 'CITADEL-BOX-desktop']), null);
  assert.equal(sharedHost(['DESKTOP-G248IJ8']), null);

  const stuck = { scheme: 'Delve', problem: { key: 'stuck:delve-ci', title: 'CI: 2 jobs on delve-ci have waited for a runner since Nov 11, 13:40 PST', why: 'every runner that serves delve-ci (DESKTOP-G248IJ8-linux) is offline', fix: 'turn on DESKTOP-G248IJ8' } };
  assert.equal(bundleTitle([stuck]), 'CI, Delve: 2 jobs on delve-ci have waited for a runner since Nov 11, 13:40 PST. Why: every runner that serves delve-ci (DESKTOP-G248IJ8-linux) is offline. Fix: turn on DESKTOP-G248IJ8.');
  const hung = { scheme: 'Peek Auras', problem: { key: 'hung:X', title: 'CI: runner X has run windows (run 1) since Nov 11, 10:00 PST', why: 'probably hung', fix: 'cancel run 1' } };
  assert.equal(bundleTitle([stuck, hung]), 'CI: 2 problems in Delve and Peek Auras. Delve: 2 jobs on delve-ci have waited for a runner since Nov 11, 13:40 PST. Why: every runner that serves delve-ci (DESKTOP-G248IJ8-linux) is offline. Fix: turn on DESKTOP-G248IJ8; Peek Auras: runner X has run windows (run 1) since Nov 11, 10:00 PST. Why: probably hung. Fix: cancel run 1.');
  assert.equal(bundleTitle(Array.from({ length: 30 }, (_, i) => ({ ...stuck, problem: { ...stuck.problem, key: `q${i}` } }))).length, 500, 'kept to Mandate\'s 500');
});

test('an outage across schemes is one alert that rings once, takes new words quietly, clears when all is well, and rings again on the next (#540)', async () => {
  const w = world({ delve: true });
  const t0 = NOW;
  // Both repos list the same waiting job (the fake answers every repo's runs alike), each with its own offline runner.
  w.gh.runners = [desk('offline', 'DESKTOP-G248IJ8')];
  w.gh.delveRunners = [desk('offline', 'DESKTOP-G248IJ8-linux')];
  waitingRun(w, t0);
  await w.health.tick(t0);
  await w.health.tick(t0 + WAIT_MS);
  assert.equal(w.puts.length, 1, 'one item, not two');
  assert.match(w.puts[0][2]!, /^CI: 2 problems in Delve and Peek Auras\. Delve: 1 job .*; Peek Auras: 1 job /);
  assert.deepEqual(w.quiet, [], 'an alert');

  // Another job waits: the same item takes the new words (Mandate pushes only a new item, so this one doesn't ring).
  waitingRun(w, t0 + MIN, 3002);
  await w.health.tick(t0 + 2 * WAIT_MS);
  await w.health.tick(t0 + 3 * WAIT_MS);
  assert.equal(w.puts.length, 2);
  assert.deepEqual(w.puts[1].slice(0, 2), ['Cara', 'ci.open']);
  assert.match(w.puts[1][2]!, /Delve: 2 jobs /);

  // Peek's comes back first: still open, fewer words; then Delve's, and it clears once.
  w.gh.runners = [desk('online', 'DESKTOP-G248IJ8')];
  await w.health.tick(t0 + 4 * WAIT_MS);
  assert.match(w.puts.at(-1)![2]!, /^CI, Delve: 2 jobs /);
  w.gh.delveRunners = [desk('online', 'DESKTOP-G248IJ8-linux')];
  await w.health.tick(t0 + 5 * WAIT_MS);
  await w.health.tick(t0 + 6 * WAIT_MS);
  assert.deepEqual(w.puts.slice(3), [['Cara', 'ci.open', null]]);

  // The next outage is a new item, so it rings.
  w.gh.runners = [desk('offline', 'DESKTOP-G248IJ8')];
  await w.health.tick(t0 + 7 * WAIT_MS);
  await w.health.tick(t0 + 8 * WAIT_MS);
  assert.equal(w.puts.length, 5);
  assert.deepEqual(w.puts.at(-1)!.slice(0, 2), ['Cara', 'ci.open']);
});

test("an older build's per-scheme alarm items are cleared from their scheme, and its runner-offline ring isn't kept (#540, #968)", async () => {
  const w = world();
  w.store.setSetting(`ci-health:${w.peek.id}`, { offline: { 'DESKTOP-G248IJ8': NOW - HOUR }, problems: [{ key: 'runner:DESKTOP-G248IJ8', title: 'CI: runner DESKTOP-G248IJ8 has been offline since Nov 5 03:45' }], sent: { 'runner:DESKTOP-G248IJ8': { 1: 'CI: runner DESKTOP-G248IJ8 has been offline since Nov 5 03:45' } } });
  w.store.setSetting('ci-health:alert', { 1: 'CI, Peek Auras: runner DESKTOP-G248IJ8 has been offline since Nov 5 03:45' });
  w.gh.runners = [desk('offline', 'DESKTOP-G248IJ8')];
  await w.health.tick(NOW);
  assert.deepEqual(w.puts, [['Cara', 'ci.runner:DESKTOP-G248IJ8', null], ['Cara', 'ci.open', null]]);
});

test("a runner list CI health can't read keeps the stuck alerts as they were (#540)", async () => {
  const w = world();
  w.gh.runners = [desk('offline')];
  waitingRun(w, NOW);
  await w.health.tick(NOW);
  await w.health.tick(NOW + WAIT_MS);
  assert.equal(w.puts.length, 1);
  w.gh.runnersDenied = true;
  await w.health.tick(NOW + 2 * WAIT_MS);
  await w.health.tick(NOW + 3 * WAIT_MS);
  assert.equal(w.puts.length, 1, 'not cleared, not re-sent');
  w.gh.runnersDenied = false;
  w.gh.runners = [desk('online')];
  await w.health.tick(NOW + 4 * WAIT_MS);
  assert.deepEqual(w.puts.at(-1), ['Cara', 'ci.open', null], 'cleared once the list says so');
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

test('the land gate falling back to perigee is a quiet item from 2 lands in a row and rings at 4, naming each and why; the next green land clears it (#561, #968)', () => {
  const s = newLandState();
  let t = NOW;
  t = through(s, 1, '#544', capHit, t, 43082450082);
  assert.deepEqual(landProblems(s, t), [], 'one fallback is nothing');
  t = through(s, 2, '#555', noJob, t);
  assert.deepEqual(landProblems(s, t), [{
    key: 'land:fallback', quiet: true,
    title: "CI: the ship gate fell back to perigee on 2 ships in a row: #544 (the desktop suite hit the 6-min cap, run 43082450082), #555 (GitHub never started its run)",
    why: 'the desktop suite hit the 6-min cap; GitHub never started its run, so each ship ran the full suite on perigee instead of waiting on CI',
    fix: 'open the fallen-back runs on the CI page and fix what stopped them; the next ship with a green gate clears this',
  }]);
  t = through(s, 3, '#556', capHit, t, 7);
  assert.match(landProblems(s, t)[0].title, /^CI: the ship gate fell back to perigee on 3 ships in a row: #544 .*, #555 .*, #556 \(the desktop suite hit the 6-min cap, run 7\)$/);
  assert.equal(landProblems(s, t)[0].quiet, true);
  t = through(s, LAND_RING_STREAK, '#557', capHit, t);
  assert.equal(landProblems(s, t)[0].quiet, false, `${LAND_RING_STREAK} in a row rings`);
  assert.match(landProblems(s, t)[0].title, /4 ships in a row: 1 more, then #555 /);
  t = through(s, 5, '#558', green, t);
  assert.deepEqual(landProblems(s, t), [], 'a green gate clears it');
  t = through(s, 6, '#559', capHit, t);
  assert.deepEqual(landProblems(s, t), [], 'and starts the count again');
});

test("the land gate's alarm: a job no runner took is named as that, not as a cap hit; a land that never reached CI (desktop off, LAND_CI=0) neither counts nor clears (#561)", () => {
  const s = newLandState();
  let t = NOW;
  t = through(s, 1, '#1', [['rebase', null, 5_000], ['ci', 'queued', 95_000], ['tests', null, 4 * MIN], ['deploy', null, MIN]], t, 9);
  t = through(s, 2, '#2', desktopOff, t);
  assert.deepEqual(landProblems(s, t), [], "the desktop off isn't the gate failing: the stuck-runner rule covers it");
  // Only what CI said while the land waited on it counts: ci-wait drops the run once the land moves on.
  t = through(s, 3, '#3', [['rebase', null, 5_000], ['ci', 'jobs', 30_000], ['ci', 'failed', 2_000], ['tests', null, 4 * MIN], ['deploy', null, MIN]], t, 10);
  assert.equal(landProblems(s, t)[0]?.title, 'CI: the ship gate fell back to perigee on 2 ships in a row: #1 (no runner started its job, run 9), #3 (its run failed before the tests ran, run 10)');
  assert.match(landProblems(s, t)[0].fix!, /^check the desktop's Linux runners are online/, 'a runner cause says where to look');
  t = through(s, 4, '#4', desktopOff, t);
  assert.equal(landProblems(s, t).length, 1, 'still open: only a green gate clears it');
  // A land refused in CI (red tests) leaves from the CI phase: no fallback, no green.
  t = through(s, 5, '#5', [['rebase', null, 5_000], ['ci', 'failed', 3 * MIN]], t);
  assert.equal(landProblems(s, t).length, 1);
  // tools/deploy.sh on its own goes straight to deploying: not a land, so not green either.
  assert.equal(landProblems(s, through(s, 6, 'tools/deploy.sh', [['deploy', null, MIN]], t)).length, 1);
});

test('a land in the line over 30 min is a quiet item, waiting in line included, ringing at 1 h, until that land ends (#561, #968)', () => {
  const s = newLandState();
  const t = NOW;
  landStep(s, [land(1, '#549', 'tests'), land(2, '#551', 'line')], t);
  landStep(s, [land(1, '#549', 'tests'), land(2, '#551', 'line')], t + 29 * MIN);
  assert.deepEqual(landProblems(s, t + 29 * MIN), []);
  landStep(s, [land(2, '#551', 'rebase'), land(3, '#552', 'line')], t + 31 * MIN);
  const slow = landProblems(s, t + 31 * MIN);
  assert.deepEqual(slow.map((x) => [x.key, x.quiet, x.title]), [['land:slow', true, `CI: #551 has been shipping since ${clock(t)} (over 30 min)`]]);
  assert.match(slow[0].why!, /under 15 min/);
  assert.deepEqual(landProblems(s, t + 40 * MIN), slow, 'the words stay put as the minutes pass, so it is not re-sent');
  const ringing = landProblems(s, t + LAND_RING_MS);
  assert.deepEqual(ringing.map((x) => [x.quiet, x.title]), [[false, `CI: #551 has been shipping since ${clock(t)} (over 1 h)`]]);
  landStep(s, [land(3, '#552', 'rebase')], t + 41 * MIN);
  assert.deepEqual(landProblems(s, t + 41 * MIN), [], 'cleared when #551 left the line');
  landStep(s, [land(3, '#552', 'rebase'), land(4, '#553', 'line')], t + 95 * MIN);
  assert.match(landProblems(s, t + 95 * MIN)[0].title, /^CI: #552 has been shipping since /);
});

test("the land gate's items: quiet under the live scheme first, then joining CI health's one alert as it rings, and clearing themselves (#561, #968)", async () => {
  const w = world();
  let t = NOW;
  const seen = (seq: number, name: string, phase: string, ci: string | null = null) => w.health.land(w.peek.id, [land(seq, name, phase, ci)], t);
  const lands = async (from: number, names: string[], phases = capHit) => {
    for (const [i, name] of names.entries()) {
      for (const [phase, ci, ms] of phases) { await seen(from + i, name, phase, ci); t += ms; }
      await w.health.land(w.peek.id, [], t);
    }
  };
  await lands(1, ['#544', '#555']);
  assert.deepEqual(w.puts, [['Cara', 'ci.land:fallback', 'CI: the ship gate fell back to perigee on 2 ships in a row: #544 (the desktop suite hit the 6-min cap), #555 (the desktop suite hit the 6-min cap). Why: the desktop suite hit the 6-min cap, so each ship ran the full suite on perigee instead of waiting on CI. Fix: open the fallen-back runs on the CI page and fix what stopped them; the next ship with a green gate clears this.']]);
  assert.deepEqual(w.quiet, ['ci.land:fallback'], 'a quiet item, from the scheme');
  assert.deepEqual(w.from, ['Peek Auras']);
  await lands(3, ['#556', '#557']);
  assert.deepEqual(w.puts.slice(-2).map(([, k, x]) => [k, x?.slice(0, 84) ?? null]), [['ci.land:fallback', null], ['ci.open', 'CI, Peek Auras: the ship gate fell back to perigee on 4 ships in a row: 1 more, then']], 'ringing: the quiet one goes, the alert comes');
  // The 5-min poll keeps it, with GitHub's own problems beside it.
  const before = w.puts.length;
  await w.health.tick(t);
  assert.equal(w.puts.length, before, 'not re-sent');
  const sent = w.puts.length;
  await lands(5, ['#558'], green);
  assert.deepEqual(w.puts.slice(sent), [['Cara', 'ci.open', null]]);
  // A restart remembers the line and the count.
  await lands(6, ['#559']);
  const again = new CiHealth(w.store, w.deps);
  for (const [phase, ci, ms] of capHit) { await again.land(w.peek.id, [land(7, '#560', phase, ci)], t); t += ms; }
  await again.land(w.peek.id, [], t);
  assert.match(w.puts.at(-1)![2]!, /2 ships in a row: #559 .*#560/);
});

test("the land alarm wakes its Taskmaster once, with each run's link, failed step and runner (#869, #983)", async () => {
  const w = world();
  const told: [string, string, boolean][] = [];
  w.health = new CiHealth(w.store, { ...w.deps, tell: (p, text, wake) => (told.push([p.name, text, !!wake]), true) });
  let t = NOW + 10 * HOUR; // daytime: the overnight hold is below
  const failed: [string, string | null, number][] = [['rebase', null, 5_000], ['ci', 'failed', 20_000], ['tests', null, 4 * MIN], ['deploy', null, MIN]];
  for (const [seq, name, run] of [[1, '#866', 7001], [2, '#867', 7002], [3, '#868', 7003], [4, '#869', 7004]] as const) {
    w.gh.jobs.set(run, [job({ run_id: run, name: 'tests', conclusion: 'failure', runner_name: 'DESKTOP-G248IJ8-desktop', steps: [{ name: 'Set up job', conclusion: 'success' }, { name: "the runner's clock", conclusion: 'failure' }] })]);
    for (const [phase, ci, ms] of failed) { await w.health.land(w.peek.id, [land(seq, name, phase, ci, ci ? run : null)], t); t += ms; }
    await w.health.land(w.peek.id, [], t);
  }
  assert.equal(told.length, 1, 'once');
  assert.deepEqual([told[0][0], told[0][2]], ['Peek Auras', true]);
  assert.match(told[0][1], /^Peek Auras: CI: the ship gate fell back to perigee on 4 ships in a row.*\. Why: .*\. Fix: /);
  assert.match(told[0][1], /https:\/\/github\.com\/caraminden\/peek-auras\/actions\/runs\/7002: tests › the runner's clock failed on DESKTOP-G248IJ8-desktop/);
  assert.match(told[0][1], /runs\/7004: tests › the runner's clock/, 'the run that tipped it over is in the wake');
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
  // The fake answers every repo's main runs alike: a test about Peek's reds quiets Delve's copy.
  const quietDelve = () => w.store.setProjectSettings(w.store.listProjects().find((p) => p.name === 'Delve')!.id, { ci_quiet: 'desktop.yml' });
  return { ...w, woken, told, outside: deps, minion, quietDelve };
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

test('every workflow but a quiet one is watched: a red on main from any trigger wakes the Taskmaster once per streak and says back to green as held mail; ci_quiet silences, ci_watch overrides it (#774, #968)', async () => {
  const w = outsideWorld();
  w.quietDelve();
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
  w.store.setProjectSettings(w.peek.id, { ci_quiet: 'desktop.yml' });
  w.gh.mainRuns = [push({ id: 8001, head_sha: 'bad0001fff', conclusion: 'failure', created_at: iso(40 * MIN), updated_at: iso(30 * MIN) })];
  await health.tick(NOW);
  assert.deepEqual(told, [], 'quiet: a red says nothing');

  // ci_watch beats ci_quiet; with neither it's watched all the same.
  w.store.setProjectSettings(w.peek.id, { ci_watch: 'desktop.yml' });
  await health.tick(NOW + 5 * MIN);
  w.store.setProjectSettings(w.peek.id, { ci_quiet: '', ci_watch: '' });
  await health.tick(NOW + 10 * MIN);
  assert.equal(told.length, 1);
  assert.equal(told[0][1], true, 'it wakes the Taskmaster');
  assert.match(told[0][0], /^Peek Auras's main went red: desktop\.yml \(Desktop\) run 8001 failed on bad0001 \(push by caraminden, finished Nov 5, 03:30 PST\): https:\/\/github\.com\/caraminden\/peek-auras\/actions\/runs\/8001\nFailing jobs: build › Run tests; package\n/);
  assert.match(told[0][0], /Start a fix minion now and put run 8001 in its brief/);

  // Later red runs in the streak, and one still running, say nothing, across a restart too.
  w.gh.mainRuns = [push({ id: 8003, status: 'in_progress', conclusion: null, created_at: iso(MIN) }), push({ id: 8002, conclusion: 'failure', created_at: iso(20 * MIN) }), ...w.gh.mainRuns];
  await health.tick(NOW + 15 * MIN);
  await new CiHealth(w.store, deps).tick(NOW + 20 * MIN);
  assert.equal(told.length, 1, 'once per streak');

  // The streak ends green: held mail, once; a scheduled or dispatched green on main ends it as well as a push.
  w.gh.mainRuns = [push({ id: 8004, event: 'schedule', head_sha: 'a00d000fff', created_at: iso(-MIN), updated_at: iso(-10 * MIN) }), ...w.gh.mainRuns.slice(1)];
  await health.tick(NOW + 25 * MIN);
  await health.tick(NOW + 30 * MIN);
  assert.deepEqual(told.slice(1), [["Peek Auras's Desktop is back to green on main: https://github.com/caraminden/peek-auras/actions/runs/8004 (a00d000, Nov 5, 04:10 PST), after run 8001 failed.", false]]);

  // The next red waits, untold, while there's no Taskmaster; a re-run of it going green ends it.
  taskmaster = false;
  w.gh.mainRuns = [push({ id: 8005, event: 'workflow_dispatch', head_sha: 'bad0005fff', conclusion: 'failure', created_at: iso(-20 * MIN), updated_at: iso(-25 * MIN) }), ...w.gh.mainRuns];
  await health.tick(NOW + 35 * MIN);
  assert.equal(told.length, 2);
  taskmaster = true;
  await health.tick(NOW + 40 * MIN);
  assert.equal(told.length, 3);
  assert.match(told[2][0], /^Peek Auras's main went red: desktop\.yml \(Desktop\) run 8005 failed on bad0005 \(workflow_dispatch by caraminden, /);
  w.gh.mainRuns = [{ ...w.gh.mainRuns[0], conclusion: 'success', run_attempt: 2, updated_at: iso(-40 * MIN) }, ...w.gh.mainRuns.slice(1)];
  await health.tick(NOW + 45 * MIN);
  assert.equal(told.length, 4);
  assert.match(told[3][0], /back to green on main: .*runs\/8005 .*after run 8005 failed\.$/);
});

test("fast mode: a land's push going red on main wakes no one and makes no item; a scheduled red still does (#1017)", async () => {
  const w = outsideWorld();
  w.quietDelve();
  const told: string[] = [];
  const health = new CiHealth(w.store, { ...w.outside, tell: (_p: unknown, text: string) => (told.push(text), true) });
  w.store.setProjectSettings(w.peek.id, { land_mode: 'fast' });
  const run = (fields: Partial<Run>) => runOf({ workflow_id: 7, path: '.github/workflows/desktop.yml', conclusion: 'failure', ...fields });
  w.gh.mainRuns = [run({ id: 9101, event: 'push', head_sha: 'bad0101fff', created_at: iso(20 * MIN), updated_at: iso(19 * MIN) })];
  await health.tick(NOW);
  await health.tick(NOW + RED_FIX_MS);
  assert.deepEqual(told, [], 'fast mode handles it');
  assert.ok(!w.puts.some(([, key]) => /^ci\.(red|open)/.test(key)), 'no Mandate item');
  w.gh.mainRuns = [run({ id: 9102, event: 'schedule', head_sha: 'bad0102fff', created_at: iso(-MIN), updated_at: iso(-2 * MIN) }), ...w.gh.mainRuns];
  await health.tick(NOW + RED_FIX_MS + MIN);
  assert.equal(told.length, 1);
  assert.match(told[0], /run 9102 failed on bad0102 \(schedule/);
  // A workflow the scheme watches alerts on a land's push red too.
  w.store.setProjectSettings(w.peek.id, { ci_watch: 'release.yml' });
  w.gh.mainRuns = [runOf({ id: 9103, workflow_id: 8, path: '.github/workflows/release.yml', conclusion: 'failure', event: 'push', head_sha: 'bad0103fff', created_at: iso(-3 * MIN), updated_at: iso(-4 * MIN) }), ...w.gh.mainRuns];
  await health.tick(NOW + RED_FIX_MS + 2 * MIN);
  assert.equal(told.length, 2, told.join('\n'));
  assert.match(told[1], /run 9103 failed on bad0103/);
});

test("a citadel-heavy job's red is the minion's own command, not main's: it wakes no one and makes no item, even watched (#1254)", async () => {
  const w = outsideWorld();
  w.quietDelve();
  const told: string[] = [];
  const health = new CiHealth(w.store, { ...w.outside, tell: (_p: unknown, text: string) => (told.push(text), true) });
  // Dispatched on the default branch, with the minion's snapshot as an input: GitHub files it under main.
  const heavy = (fields: Partial<Run>) => runOf({ workflow_id: 9, name: 'citadel-heavy', path: '.github/workflows/citadel-heavy.yml', event: 'workflow_dispatch', conclusion: 'failure', ...fields });
  w.gh.mainRuns = [heavy({ id: 9201, head_sha: 'aaa0201fff', created_at: iso(20 * MIN), updated_at: iso(19 * MIN) })];
  await health.tick(NOW);
  w.store.setProjectSettings(w.peek.id, { ci_watch: 'citadel-heavy.yml' });
  await health.tick(NOW + RED_FIX_MS + MIN);
  assert.deepEqual(told, []);
  assert.ok(!w.puts.some(([, key]) => /^ci\.(red|open)/.test(key)), 'no Mandate item');
});

test('a red on main the Taskmaster heard of is a quiet item, ringing an hour on with no fix minion naming the run, or once it is still red after the fix closed (#968)', async () => {
  const w = outsideWorld();
  w.quietDelve();
  const deps = { ...w.outside, tell: () => true };
  const health = new CiHealth(w.store, deps);
  const red = (id: number, msAgo: number) => runOf({ id, event: 'push', workflow_id: 7, path: '.github/workflows/desktop.yml', head_sha: `${id}abcdef`, conclusion: 'failure', created_at: iso(msAgo), updated_at: iso(msAgo - MIN) });
  w.gh.jobs.set(9001, [job({ run_id: 9001, name: 'windows', conclusion: 'failure', steps: [{ name: 'Test', conclusion: 'failure' }] })]);
  w.gh.mainRuns = [red(9001, 20 * MIN)];
  await health.tick(NOW);
  const item = (k = 'ci.red:7') => w.puts.filter(([, key]) => key === k).at(-1)?.[2];
  assert.match(item()!, /^CI: desktop\.yml failed on main \(run 9001, at windows › Test\)\. Why: .*\. Fix: .*rings at Nov 5, 05:00 PST/);
  assert.ok(w.quiet.includes('ci.red:7'), 'quiet while the Taskmaster has an hour');
  assert.equal(item('ci.open'), undefined);

  await health.tick(NOW + RED_FIX_MS);
  assert.match(item('ci.open')!, /^CI, Peek Auras: desktop\.yml failed on main \(run 9001, at windows › Test\): no fix minion started\./, 'an hour with no fix rings');
  assert.equal(item(), null, 'and the quiet one goes');

  // A minion whose brief names the run: quiet again, with its number.
  const fix = w.minion(w.peek.id, 'ticket/1-fix');
  w.store.addEvent(fix.id, 'user_message', { text: 'Fix the red desktop run 9001 on main' });
  await health.tick(NOW + RED_FIX_MS + 5 * MIN);
  assert.equal(item('ci.open'), null, 'a fix on the way stops the ring');
  assert.match(item()!, new RegExp(`: fix minion #${fix.number} started\\.`));

  // It closes; main is still red on a run made after: that rings.
  w.store.updateTicket(fix.id, { status: 'closed' });
  const closedAt = w.store.getTicket(fix.id)!.updated_at;
  await health.tick(NOW + 2 * HOUR);
  assert.match(item()!, /closed, waiting on the next run/);
  w.gh.mainRuns = [{ ...red(9002, 0), created_at: new Date(closedAt + MIN).toISOString() }, ...w.gh.mainRuns];
  await health.tick(NOW + 2 * HOUR + 5 * MIN);
  assert.match(item('ci.open')!, new RegExp(`still red after fix minion #${fix.number} closed`));

  // Green clears both.
  w.gh.mainRuns = [{ ...red(9003, 0), conclusion: 'success', created_at: new Date(closedAt + 2 * MIN).toISOString() }, ...w.gh.mainRuns];
  await health.tick(NOW + 2 * HOUR + 10 * MIN);
  assert.equal(item('ci.open'), null);
});

test("a red whose first fix minion closed names the open one fixing it now (the first open), else the newest (#1074, Josh 2026-11-19)", async () => {
  const w = outsideWorld();
  w.quietDelve();
  const health = new CiHealth(w.store, { ...w.outside, tell: () => true });
  w.gh.mainRuns = [runOf({ id: 9601, event: 'schedule', name: 'tests', workflow_id: 7, path: '.github/workflows/desktop.yml', head_sha: 'bad0601fff', conclusion: 'failure', created_at: iso(30 * MIN), updated_at: iso(20 * MIN) })];
  await health.tick(NOW);
  const item = (k = 'ci.red:7') => w.puts.filter(([, key]) => key === k).at(-1)?.[2];
  const first = w.minion(w.peek.id, 'ticket/7-fix');
  w.store.addEvent(first.id, 'user_message', { text: 'Fix the red tests run 9601 on main' });
  w.store.updateTicket(first.id, { status: 'closed' });
  // Its fix didn't hold: a later run is red too, and a second minion is on it.
  const closedAt = w.store.getTicket(first.id)!.updated_at;
  w.gh.mainRuns = [runOf({ id: 9602, event: 'schedule', name: 'tests', workflow_id: 7, path: '.github/workflows/desktop.yml', head_sha: 'bad0602fff', conclusion: 'failure', created_at: new Date(closedAt + MIN).toISOString() }), ...w.gh.mainRuns];
  const now = w.minion(w.peek.id, 'ticket/8-fix-again');
  w.store.addEvent(now.id, 'user_message', { text: 'Run 9601 is still red after the first fix: fix it' });
  await health.tick(NOW + 2 * HOUR);
  assert.match(item()!, new RegExp(`: fix minion #${now.number} started\\.`), 'the open fix minion, not the closed first one');
  assert.equal(item('ci.open') ?? null, null, 'an open fix minion keeps it from ringing');
  assert.match(health.hold(now.id)!, /run 9601/);
  assert.equal(health.hold(first.id), null);
  // A later minion that only quotes the run doesn't take the hold from the open fix minion.
  const review = w.minion(w.peek.id, 'ticket/9-review');
  w.store.addEvent(review.id, 'user_message', { text: 'Review what went wrong in run 9601' });
  assert.match(health.hold(now.id)!, /run 9601/);
  assert.equal(health.hold(review.id), null);
  w.store.updateTicket(review.id, { status: 'closed' });
  w.store.updateTicket(now.id, { status: 'closed' });
  await health.tick(NOW + 2 * HOUR + 5 * MIN);
  // All closed: the newest (9602 came after they closed, so it rings, naming it).
  assert.match(item('ci.open')!, new RegExp(`still red after fix minion #${review.number} closed`));
});

test("a red's fix minion is held open; once its fix is on main the workflow is dispatched once per fix, and green dismisses it (#1074)", async () => {
  const w = outsideWorld();
  w.quietDelve();
  const posts: [string, Record<string, string> | undefined][] = [];
  const dismissed: [number, string][] = [];
  const held: [number, string | null][] = [];
  // Which of the fix minion's tips each main commit holds: fix0001 has its first fix, oth0001 another land on top, fix0002 its second.
  const has: Record<string, string> = { fix0001fff: 'tip1', oth0001fff: 'tip1', fix0002fff: 'tip2' };
  const deps = {
    ...w.outside, tell: () => true,
    post: async (path: string, _as: unknown, fields?: Record<string, string>) => (posts.push([path, fields]), { status: 204 }),
    shipped: async (_p: unknown, _t: unknown, sha: string) => has[sha] ?? null,
    held: (id: number, note: string | null) => void held.push([id, note]),
    dismiss: (id: number, text: string) => void dismissed.push([id, text]),
  };
  const health = new CiHealth(w.store, deps);
  const run = (id: number, fields: Partial<Run>) => runOf({ id, event: 'schedule', name: 'tests', workflow_id: 7, path: '.github/workflows/desktop.yml', ...fields });
  w.gh.jobs.set(9201, [job({ run_id: 9201, name: 'test', conclusion: 'failure', labels: ['self-hosted', 'citadel-ci-linux'], steps: [{ name: 'Test', conclusion: 'failure' }] })]);
  w.gh.mainHead = 'bad0001fff';
  w.gh.mainRuns = [run(9201, { head_sha: 'bad0001fff', conclusion: 'failure', created_at: iso(30 * MIN), updated_at: iso(20 * MIN) })];
  await health.tick(NOW);
  const fix = w.minion(w.peek.id, 'ticket/2-fix');
  w.store.addEvent(fix.id, 'user_message', { text: 'Fix the red tests run 9201 on main' });
  const other = w.minion(w.peek.id, 'ticket/3-other');
  const item = () => w.puts.filter(([, key]) => key === 'ci.red:7').at(-1)?.[2];
  const dispatches = () => posts.filter(([path]) => path === 'repos/caraminden/peek-auras/actions/workflows/7/dispatches');

  // Held from the start: neither the deploy nor close_self dismisses it while main is red. Others aren't.
  assert.match(health.hold(fix.id)!, /run 9201/);
  assert.equal(health.hold(other.id), null);

  // Its fix isn't on GitHub's main yet: nothing is dispatched.
  await health.tick(NOW + 5 * MIN);
  assert.deepEqual(dispatches(), []);

  // It is: one dispatch of the red workflow on main, and the minion shows it waits on it.
  w.gh.mainHead = 'fix0001fff';
  await health.tick(NOW + 10 * MIN);
  assert.deepEqual(dispatches(), [['repos/caraminden/peek-auras/actions/workflows/7/dispatches', { ref: 'main' }]]);
  assert.deepEqual(held.at(-1), [fix.id, 'waiting on the desktop.yml re-run on main (fix0001)']);
  assert.match(item()!, new RegExp(`: fix minion #${fix.number} shipped; re-running on fix0001\\.`));

  // Not again for that commit: not while it's unseen, queued or running, nor after a restart.
  await health.tick(NOW + 15 * MIN);
  w.gh.mainRuns = [run(9202, { event: 'workflow_dispatch', head_sha: 'fix0001fff', status: 'in_progress', conclusion: null, created_at: iso(-11 * MIN) }), ...w.gh.mainRuns];
  await health.tick(NOW + 20 * MIN);
  await new CiHealth(w.store, deps).tick(NOW + 25 * MIN);
  assert.equal(dispatches().length, 1);
  assert.match(item()!, /actions\/runs\/9202/, 'the item links the re-run');
  assert.deepEqual(dismissed, []);

  // Red again: the fix minion is woken with the new run, the item points at it, and it stays held.
  w.gh.jobs.set(9202, [job({ run_id: 9202, name: 'test', conclusion: 'failure', labels: ['self-hosted', 'citadel-ci-linux'], steps: [{ name: 'Test', conclusion: 'failure' }] })]);
  w.gh.mainRuns = [{ ...w.gh.mainRuns[0], status: 'completed', conclusion: 'failure', updated_at: iso(-20 * MIN) }, ...w.gh.mainRuns.slice(1)];
  await health.tick(NOW + 30 * MIN);
  const wakes = w.woken.filter(([id]) => id === fix.id);
  assert.equal(wakes.length, 1);
  assert.match(wakes[0][1], /re-run .*failed.*actions\/runs\/9202/s);
  assert.equal(wakes[0][2], false, 'work to do, not news');
  assert.deepEqual(held.at(-1), [fix.id, null]);
  assert.match(item()!, /re-run 9202 on fix0001 failed too/);
  assert.match(health.hold(fix.id)!, /run 9201/);
  await health.tick(NOW + 35 * MIN);
  assert.equal(w.woken.filter(([id]) => id === fix.id).length, 1, 'woken once');

  // Someone else's land moves main with no new fix from it: nothing is dispatched.
  w.gh.mainHead = 'oth0001fff';
  await health.tick(NOW + 40 * MIN);
  assert.equal(dispatches().length, 1);

  // Its second fix ships: one more dispatch, then green dismisses it and clears the red.
  w.gh.mainHead = 'fix0002fff';
  await health.tick(NOW + 45 * MIN);
  assert.equal(dispatches().length, 2);
  w.gh.mainRuns = [run(9203, { event: 'workflow_dispatch', head_sha: 'fix0002fff', conclusion: 'success', created_at: iso(-46 * MIN), updated_at: iso(-55 * MIN) }), ...w.gh.mainRuns];
  await health.tick(NOW + 60 * MIN);
  assert.deepEqual(dismissed.map(([id]) => id), [fix.id]);
  assert.match(dismissed[0][1], /green on main/);
  assert.equal(health.hold(fix.id), null);
  assert.equal(item(), null);
});

test("a re-run that's cancelled wakes the fix minion; with CI_RUNNER=github none is dispatched; a green before any re-run still lets a held minion go (#1074)", async () => {
  const w = outsideWorld();
  w.quietDelve();
  const posts: string[] = [];
  const dismissed: number[] = [];
  let shipped: string | null = 'tip1';
  const health = new CiHealth(w.store, {
    ...w.outside, tell: () => true, held: () => {},
    post: async (path: string) => (posts.push(path), { status: 204 }), shipped: async () => shipped, dismiss: (id: number) => void dismissed.push(id),
  });
  const run = (id: number, fields: Partial<Run>) => runOf({ id, event: 'schedule', name: 'tests', workflow_id: 7, path: '.github/workflows/desktop.yml', ...fields });
  w.gh.jobs.set(9401, [job({ run_id: 9401, name: 'test', conclusion: 'failure', labels: ['self-hosted'] })]);
  w.gh.mainRuns = [run(9401, { head_sha: 'bad0401fff', conclusion: 'failure', created_at: iso(30 * MIN), updated_at: iso(20 * MIN) })];
  await health.tick(NOW);
  const fix = w.minion(w.peek.id, 'ticket/4-fix');
  w.store.addEvent(fix.id, 'user_message', { text: 'Fix the red tests run 9401 on main' });
  const item = () => w.puts.filter(([, key]) => key === 'ci.red:7').at(-1)?.[2];

  // Dispatched; GitHub cancels the run, on a newer tip than the one read: the minion still hears.
  w.gh.mainHead = 'fix0401fff';
  await health.tick(NOW + 5 * MIN);
  assert.equal(posts.length, 1);
  w.gh.mainRuns = [run(9402, { event: 'workflow_dispatch', head_sha: 'fix0402fff', conclusion: 'cancelled', created_at: iso(-6 * MIN), updated_at: iso(-7 * MIN) }), ...w.gh.mainRuns];
  await health.tick(NOW + 10 * MIN);
  const wakes = w.woken.filter(([id]) => id === fix.id);
  assert.equal(wakes.length, 1);
  assert.match(wakes[0][1], /ended cancelled/);
  assert.match(item()!, /re-run 9402 on fix0402 failed too/);

  // A second fix, with the scheme switched onto GitHub's runners: left for a person.
  w.gh.ciRunner = 'github';
  shipped = 'tip2';
  w.gh.mainHead = 'fix0403fff';
  await health.tick(NOW + 15 * MIN);
  assert.equal(posts.length, 1);
  assert.match(item()!, /re-run desktop\.yml on main by hand/);

  // A minion its deploy held before any re-run was recorded is let go by the green too.
  const w2 = outsideWorld();
  w2.quietDelve();
  const gone: number[] = [];
  const h2 = new CiHealth(w2.store, { ...w2.outside, tell: () => true, shipped: async () => null, dismiss: (id: number) => void gone.push(id) });
  w2.gh.mainRuns = [run(9501, { head_sha: 'bad0501fff', conclusion: 'failure', created_at: iso(30 * MIN), updated_at: iso(20 * MIN) })];
  await h2.tick(NOW);
  const held = w2.minion(w2.peek.id, 'ticket/5-fix');
  w2.store.addEvent(held.id, 'user_message', { text: 'Fix the red tests run 9501 on main' });
  const busy = w2.minion(w2.peek.id, 'ticket/6-also-9501');
  w2.store.addEvent(busy.id, 'user_message', { text: 'Look into run 9501' });
  w2.store.updateTicket(held.id, { state: 'outside', note: 'live; waiting on the CI re-run on main' });
  w2.gh.mainRuns = [run(9502, { event: 'push', head_sha: 'fix0501fff', conclusion: 'success', created_at: iso(-1 * MIN), updated_at: iso(-5 * MIN) }), ...w2.gh.mainRuns];
  await h2.tick(NOW + 10 * MIN);
  assert.deepEqual(gone, [held.id]);
});

test("a red whose jobs ran on GitHub's own runners isn't re-run by Citadel: the item says to re-run it by hand (#1074)", async () => {
  const w = outsideWorld();
  w.quietDelve();
  const posts: string[] = [];
  const health = new CiHealth(w.store, { ...w.outside, tell: () => true, post: async (path: string) => (posts.push(path), { status: 204 }), shipped: async () => 'tip1' });
  w.gh.jobs.set(9301, [job({ run_id: 9301, name: 'test', conclusion: 'failure', labels: ['ubuntu-latest'] })]);
  w.gh.mainRuns = [runOf({ id: 9301, event: 'schedule', workflow_id: 7, path: '.github/workflows/desktop.yml', head_sha: 'bad0301fff', conclusion: 'failure', created_at: iso(30 * MIN), updated_at: iso(20 * MIN) })];
  await health.tick(NOW);
  const fix = w.minion(w.peek.id, 'ticket/4-fix');
  w.store.addEvent(fix.id, 'user_message', { text: 'Fix run 9301' });
  w.gh.mainHead = 'fix0301fff';
  await health.tick(NOW + 5 * MIN);
  assert.ok(!posts.some((p) => p.endsWith('/dispatches')), 'no Actions minutes spent');
  assert.match(w.puts.filter(([, key]) => key === 'ci.red:7').at(-1)![2]!, /re-run desktop\.yml on main by hand/);
});

test('quieting a workflow after it went red clears its open red on the next poll, with no back-to-green message', async () => {
  const w = outsideWorld();
  w.quietDelve();
  const told: string[] = [];
  const health = new CiHealth(w.store, { ...w.outside, tell: (_p: { name: string }, text: string) => (told.push(text), true) });
  w.store.setProjectSettings(w.peek.id, { ci_quiet: '' });
  w.gh.mainRuns = [runOf({ id: 9101, event: 'workflow_dispatch', workflow_id: 7, name: 'Desktop', path: '.github/workflows/desktop.yml', head_sha: '9101abcdef', conclusion: 'failure', created_at: iso(20 * MIN), updated_at: iso(19 * MIN) })];
  await health.tick(NOW);
  assert.ok(w.puts.filter(([, key]) => key === 'ci.red:7').at(-1)?.[2], 'open red item');
  assert.equal(told.length, 1);

  w.store.setProjectSettings(w.peek.id, { ci_quiet: 'desktop.yml' });
  await health.tick(NOW + 5 * MIN);
  assert.equal(w.puts.filter(([, key]) => key === 'ci.red:7').at(-1)?.[2], null, 'quieted: the item clears');
  assert.equal(told.length, 1, 'and says nothing');
  await health.tick(NOW + 10 * MIN);
  assert.equal(told.length, 1);
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

test('a ringing problem wakes its scheme\'s Taskmaster once, at once, and again only after it clears (#983)', async () => {
  const w = world();
  const told: [string, string, boolean][] = [];
  const deps = { ...w.deps, tell: (p: { name: string }, text: string, wake?: boolean) => (told.push([p.name, text, !!wake]), true) };
  const health = new CiHealth(w.store, deps);
  const t0 = Date.parse('2026-11-11T20:00:00Z');
  w.gh.runners = [desk('offline')];
  waitingRun(w, t0);
  await health.tick(t0);
  assert.deepEqual(told, [], 'under the wait it says nothing');
  await health.tick(t0 + WAIT_MS);
  assert.equal(told.length, 1);
  assert.equal(told[0][0], 'Peek Auras', "the scheme's own Taskmaster");
  assert.equal(told[0][2], true, 'a wake, not held mail, so a cold Taskmaster runs');
  assert.match(told[0][1], /waited for a runner.*Why: .*Fix: /s, 'what, why and the fix');
  assert.match(told[0][1], /start a fix minion/i);
  // The same outage on the next polls, and after a restart, is not news.
  await health.tick(t0 + WAIT_MS + 5 * MIN);
  await new CiHealth(w.store, deps).tick(t0 + WAIT_MS + 10 * MIN);
  assert.equal(told.length, 1, 'once per outage');
  // Back online, then out again: that's a new problem.
  w.gh.runners = [desk('online')];
  await health.tick(t0 + HOUR);
  w.gh.runners = [desk('offline')];
  await health.tick(t0 + HOUR + 5 * MIN);
  assert.equal(told.length, 2, 'it came back');
});

test('with no Taskmaster to tell, a ringing problem is tried again next poll (#983)', async () => {
  const w = world();
  let has = false;
  const told: string[] = [];
  const health = new CiHealth(w.store, { ...w.deps, tell: (_p, text) => (has && told.push(text), has) });
  const t0 = Date.parse('2026-11-11T20:00:00Z');
  w.gh.runners = [desk('offline')];
  waitingRun(w, t0);
  await health.tick(t0 + WAIT_MS);
  has = true;
  await health.tick(t0 + WAIT_MS + 5 * MIN);
  assert.equal(told.length, 1);
});

test('shared problems wake Citadel\'s Taskmaster once for all schemes, not each scheme (#983)', async () => {
  const w = world({ delve: true });
  const told: [string, string][] = [];
  const citadel = w.store.listProjects().find((p) => p.name === 'Notes')!;
  const health = new CiHealth(w.store, { ...w.deps, home: () => citadel, tell: (p, text) => (told.push([p.name, text]), true) });
  const t0 = Date.parse('2026-11-11T20:00:00Z');
  // Billing: every scheme's jobs fail to start with the same account reason.
  w.gh.runners = [desk('online')];
  const reason = 'The job was not started because recent account payments have failed or your spending limit needs to be increased.';
  for (const [i, id] of [5101, 5102].entries()) {
    w.gh.runs = [runOf({ id, created_at: new Date(t0 - (i + 3) * HOUR).toISOString() }), ...w.gh.runs];
    w.gh.jobs.set(id, [dead(3 * HOUR, { run_id: id })]);
    w.gh.notes.set(id * 10, [{ message: reason, annotation_level: 'failure' }]);
  }
  await health.tick(t0);
  assert.ok(told.length >= 1, 'something woke');
  const billing = told.filter(([, t]) => /spending limit/.test(t));
  assert.ok(billing.every(([name]) => name === 'Notes'), "Citadel's, not each scheme's");
  assert.equal(billing.length, 1, 'once');
  await health.tick(t0 + 5 * MIN);
  assert.equal(told.filter(([, t]) => /spending limit/.test(t)).length, billing.length, 'not again next poll');
});

test('a red on main wakes at red and once more when it rings, naming the run; nothing overnight is sent until 9 AM (#983)', async () => {
  const w = outsideWorld();
  w.quietDelve();
  const told: [string, boolean][] = [];
  const health = new CiHealth(w.store, { ...w.outside, tell: (_p, text, wake) => (told.push([text, !!wake]), true) });
  w.gh.jobs.set(9101, [job({ run_id: 9101, name: 'windows', conclusion: 'failure', steps: [{ name: 'Test', conclusion: 'failure' }] })]);
  w.gh.mainRuns = [runOf({ id: 9101, event: 'push', workflow_id: 7, path: '.github/workflows/desktop.yml', conclusion: 'failure', created_at: iso(20 * MIN), updated_at: iso(19 * MIN) })];
  const day = Date.parse('2026-11-05T20:00:00Z'); // noon PST
  await health.tick(day);
  assert.equal(told.length, 1, 'the red wakes');
  await health.tick(day + 5 * MIN);
  assert.equal(told.length, 1, 'not again while a fix has its hour');
  await health.tick(day + RED_FIX_MS);
  assert.equal(told.length, 2, 'it rings: the Taskmaster hears again');
  assert.deepEqual(told[1][1], true);
  assert.match(told[1][0], /desktop\.yml failed on main \(run 9101.*no fix minion started.*put run 9101 in its brief/s);
  await health.tick(day + RED_FIX_MS + 5 * MIN);
  assert.equal(told.length, 2, 'once');

  // A runner problem opening at 3 AM PST is held to the first poll after 9.
  const w2 = world();
  const held: string[] = [];
  const h2 = new CiHealth(w2.store, { ...w2.deps, tell: (_p, text) => (held.push(text), true) });
  const night = Date.parse('2026-11-11T11:00:00Z'); // 3 AM PST
  w2.gh.runners = [desk('offline')];
  waitingRun(w2, night - HOUR);
  await h2.tick(night);
  assert.deepEqual(held, [], 'asleep');
  await h2.tick(night + 6 * HOUR + MIN);
  assert.equal(held.length, 1, 'after 9');
});

test('one PC offline for two schemes wakes Citadel once; for one scheme alone, that scheme (#983)', async () => {
  const told: [string, string][] = [];
  const mk = () => {
    const w = world({ delve: true });
    const home = w.store.listProjects().find((p) => p.name === 'Notes')!;
    return { w, health: new CiHealth(w.store, { ...w.deps, home: () => home, tell: (p, text) => (told.push([p.name, text]), true) }) };
  };
  const t0 = Date.parse('2026-11-11T20:00:00Z');
  const both = mk();
  both.w.gh.runners = [desk('offline', 'DESKTOP-G248IJ8')];
  both.w.gh.delveRunners = [desk('offline', 'DESKTOP-G248IJ8-linux')];
  waitingRun(both.w, t0);
  await both.health.tick(t0 + WAIT_MS);
  await both.health.tick(t0 + WAIT_MS + 5 * MIN);
  assert.deepEqual(told.map(([n]) => n), ['Notes'], "one wake, Citadel's");
  assert.match(told[0][1], /It touches Delve, Peek Auras\./);

  told.length = 0;
  const alone = mk();
  alone.w.gh.runners = [desk('offline', 'DESKTOP-G248IJ8-desktop'), desk('offline', 'DESKTOP-G248IJ8-2')];
  waitingRun(alone.w, t0);
  await alone.health.tick(t0 + WAIT_MS);
  await alone.health.tick(t0 + WAIT_MS + 5 * MIN);
  assert.deepEqual(told.map(([n]) => n), ['Peek Auras'], 'a PC only one scheme uses is that scheme\'s');
});

test('every open problem links to its fix minion, else to the Taskmaster entry that heard of it (#992)', async () => {
  const w = outsideWorld();
  w.quietDelve();
  // tell hands back the chat entry the wake became; false-ish means nobody heard.
  let entry: number | boolean = 777;
  const health = new CiHealth(w.store, { ...w.outside, tell: () => entry });
  const red = (id: number, msAgo: number) => runOf({ id, event: 'push', workflow_id: 7, path: '.github/workflows/desktop.yml', head_sha: `${id}abcdef`, conclusion: 'failure', created_at: iso(msAgo), updated_at: iso(msAgo - MIN) });
  w.gh.jobs.set(9001, [job({ run_id: 9001, name: 'windows', conclusion: 'failure', steps: [{ name: 'Test', conclusion: 'failure' }] })]);
  w.gh.mainRuns = [red(9001, 20 * MIN)];
  const link = () => health.snapshot(() => true).find((s) => s.id === w.peek.id)!.problems.find((x) => x.key === 'red:7')?.link;
  await health.tick(NOW);
  assert.deepEqual(link(), { kind: 'taskmaster', href: `#/p/${w.peek.id}?e=777`, label: "the Taskmaster's wake" }, 'no fix yet: the entry its Taskmaster was woken at');

  const fix = w.minion(w.peek.id, 'ticket/1-fix');
  w.store.updateTicket(fix.id, { title: 'Fix the red desktop run' });
  w.store.addEvent(fix.id, 'user_message', { text: 'Fix the red desktop run 9001 on main' });
  await health.tick(NOW + 5 * MIN);
  const n = w.store.getTicket(fix.id)!.number;
  assert.deepEqual(link(), { kind: 'minion', href: `#/p/${w.peek.id}/t/${n}`, label: `#${n} Fix the red desktop run`, closed: false }, 'a fix minion wins over the Taskmaster');

  w.store.updateTicket(fix.id, { status: 'closed' });
  await health.tick(NOW + 10 * MIN);
  assert.deepEqual(link(), { kind: 'minion', href: `#/p/${w.peek.id}/t/${n}`, label: `#${n} Fix the red desktop run`, closed: true }, 'closed, the red still open: linked, and says so');
});

test('with no wake entry recorded, a problem falls back to the Taskmaster chat without an anchor (#992)', async () => {
  const w = world();
  const health = new CiHealth(w.store, { ...w.deps, tell: () => true });
  const t0 = Date.parse('2026-11-11T20:00:00Z');
  w.gh.runners = [desk('offline')];
  waitingRun(w, t0);
  await health.tick(t0 + WAIT_MS);
  const x = health.snapshot(() => true).find((s) => s.id === w.peek.id)!.problems[0];
  assert.deepEqual(x.link, { kind: 'taskmaster', href: `#/p/${w.peek.id}`, label: 'the Taskmaster' });
});

test('#1005: back-to-back restarts still read at least every poll, and keep a rate-limit pause', async () => {
  const w = world();
  await w.health.tick(NOW);
  const last = w.store.getSetting<number>('ci-health:lastTick');
  assert.equal(last, NOW, 'a finished read is remembered across restarts');
  // Restarts every 3 min: the read still comes by lastRead + one poll, never a full poll after each restart.
  assert.equal(firstTickDelay(last, 0, NOW + 3 * MIN), 2 * MIN);
  assert.equal(firstTickDelay(last, 0, NOW + 4.9 * MIN), START_DELAY_MS, 'a fresh start never reads at once');
  assert.equal(firstTickDelay(last, 0, NOW + 20 * MIN), START_DELAY_MS, 'an overdue read comes after the short delay');
  assert.equal(firstTickDelay(undefined, 0, NOW), START_DELAY_MS, 'a first ever start waits the short delay');
  assert.equal(firstTickDelay(last, NOW + 15 * MIN, NOW + 3 * MIN), 12 * MIN, 'the rate-limit pause holds across a restart');
  w.gh.rateLimited = true;
  await w.health.tick(NOW + 6 * MIN);
  assert.ok((w.store.getSetting<number>('ci-health:pausedUntil') ?? 0) > NOW + 6 * MIN, 'the pause is saved');
});

test('each run and queued job on the CI page names the minion whose change it tests: its branch, its land copy, or its land on main; else what it is (#1019)', async () => {
  const w = world();
  const repo = mkdtempSync(join(root, 'repo-'));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'landed #584');
  git('branch', 'ticket/584-sound-tab');
  const landed = git('rev-parse', 'HEAD');
  w.store.setProjectRepoDir(w.peek.id, repo);
  const sound = w.store.createTicket({ project_id: w.peek.id, title: 'Sound tab', permission_mode: 'default', created_by: 'cara' });
  const drag = w.store.createTicket({ project_id: w.peek.id, title: 'Panel drag', permission_mode: 'default', created_by: 'cara' });
  w.store.updateTicket(sound.id, { branch: 'ticket/584-sound-tab' } as any);
  w.store.updateTicket(drag.id, { branch: 'ticket/587-panel-drag' } as any);
  const n = (id: number) => w.store.getTicket(id)!.number!;
  const onMain = runOf({ id: 6001, status: 'queued', conclusion: null, head_sha: landed, created_at: iso(22 * MIN) });
  const onLand = runOf({ id: 6002, head_branch: 'land/ticket/587-panel-drag', created_at: iso(30 * MIN) });
  const onTicket = runOf({ id: 6003, head_branch: 'ticket/587-panel-drag', event: 'workflow_dispatch', created_at: iso(40 * MIN) });
  const scheduled = runOf({ id: 6004, event: 'schedule', created_at: iso(50 * MIN) });
  const plain = runOf({ id: 6005, event: 'push', created_at: iso(55 * MIN) });
  w.gh.runs = [onMain, onLand, onTicket, scheduled, plain];
  w.gh.mainRuns = [runOf({ id: 6006, head_sha: landed, created_at: iso(HOUR) })];
  w.gh.jobs.set(6001, [job({ run_id: 6001, name: 'screen', status: 'queued', conclusion: null, runner_name: null, steps: [], labels: ['peek-auras-desktop'], created_at: iso(22 * MIN) })]);
  await w.health.tick(NOW);

  const v = w.health.snapshot(() => true)[0].view as any;
  const who = (id: number) => v.runs.find((r: any) => r.id === id).who;
  assert.deepEqual(who(6001), { href: `#/p/${w.peek.id}/t/${n(sound.id)}`, label: `#${n(sound.id)} Sound tab` }, "a land's push to main: the minion whose branch tops the commit");
  assert.deepEqual(who(6002), { href: `#/p/${w.peek.id}/t/${n(drag.id)}`, label: `#${n(drag.id)} Panel drag` }, "a land's CI copy on land/<branch>");
  assert.equal(who(6003).href, `#/p/${w.peek.id}/t/${n(drag.id)}`, 'a run by hand on the minion branch is the minion\'s');
  assert.deepEqual(who(6004), { label: 'scheduled run' });
  assert.deepEqual(who(6005), { label: 'main itself' }, 'a push to main no land tops');
  assert.deepEqual(v.waiting.map((j: any) => [j.name, j.who.label]), [['screen', `#${n(sound.id)} Sound tab`]], 'the queued job links its run\'s minion');
  assert.equal(v.workflows[0].verdict.who.label, `#${n(sound.id)} Sound tab`, 'the verdict on main names the land it tested');
});

test("the CI page's Running now: each running job with its runner, start and minion, and the queue per set of labels with the online runners that serve it (#1019)", async () => {
  const w = world();
  const drag = w.store.createTicket({ project_id: w.peek.id, title: 'Panel drag', permission_mode: 'default', created_by: 'cara' });
  w.store.updateTicket(drag.id, { branch: 'ticket/588-panel-drag' } as any);
  const n = w.store.getTicket(drag.id)!.number!;
  w.gh.runners = [{ ...desk('online'), busy: true } as any, desk('offline', 'DESKTOP-G248IJ8-2')];
  const mine = runOf({ id: 7001, status: 'in_progress', conclusion: null, head_branch: 'land/ticket/588-panel-drag', created_at: iso(20 * MIN) });
  const queued = runOf({ id: 7002, status: 'queued', conclusion: null, event: 'schedule', created_at: iso(15 * MIN) });
  w.gh.runs = [mine, queued];
  const desktopJob = { labels: ['self-hosted', 'peek-auras-ci'], status: 'queued', conclusion: null, runner_name: null, steps: [] };
  w.gh.jobs.set(7001, [
    job({ run_id: 7001, name: 'e2e', status: 'in_progress', conclusion: null, runner_name: 'DESKTOP-G248IJ8-desktop', labels: ['self-hosted', 'peek-auras-ci'], created_at: iso(20 * MIN), started_at: iso(12 * MIN) }),
    job({ run_id: 7001, name: 'lint', status: 'in_progress', conclusion: null, runner_name: 'GitHub Actions 3', labels: ['ubuntu-latest'], created_at: iso(20 * MIN), started_at: iso(19 * MIN) }),
    job({ run_id: 7001, name: 'screens', ...desktopJob, created_at: iso(20 * MIN) }),
  ]);
  w.gh.jobs.set(7002, [job({ run_id: 7002, name: 'drift', ...desktopJob, created_at: iso(15 * MIN) }), job({ run_id: 7002, name: 'build', ...desktopJob, labels: ['peek-auras-ci', 'self-hosted'], created_at: iso(15 * MIN) }),
    job({ run_id: 7002, name: 'docs', ...desktopJob, labels: ['ubuntu-latest'], created_at: iso(15 * MIN) })]);
  await w.health.tick(NOW);

  const v = w.health.snapshot(() => true)[0].view as any;
  assert.deepEqual(v.running.map((j: any) => [j.name, j.runner, j.since, j.who.label]), [
    ['e2e', 'DESKTOP-G248IJ8-desktop', iso(12 * MIN), `#${n} Panel drag`],
    ['lint', 'GitHub Actions 3', iso(19 * MIN), `#${n} Panel drag`],
  ], 'self-hosted and GitHub-hosted jobs alike, each with when it started, not when it queued');
  assert.deepEqual(v.queues, [
    { labels: ['peek-auras-ci', 'self-hosted'], jobs: 3, runners: 1 },
    { labels: ['ubuntu-latest'], jobs: 1, runners: 0 },
  ], 'labels in any order are one queue; the offline runner is not counted; GitHub\'s own runners are none of the repo\'s');
});
