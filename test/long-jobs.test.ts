// Long heavy jobs (#1363): the pump's gate (from 2am, in job hours) and the wake when a run ends.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BEGIN, END } from '../tools/heavy-ci.ts';
import { LongJobs, longView, readLongJobs, type LongDeps } from '../src/long-jobs.ts';
import { DEFAULT_SETTINGS } from '../src/machine-jobs.ts';

const root = mkdtempSync(join(tmpdir(), 'long-jobs-'));
after(() => rmSync(root, { recursive: true, force: true }));

const NOON = Date.parse('2026-11-19T12:00:00-0800'); // outside the default 23:00 to 08:00 hours
const NIGHT = Date.parse('2026-11-20T03:00:00-0800');
const SHA = 'a'.repeat(40);

/** A heavy folder with one queued job per ticket given, and deps whose gh answers like GitHub for a run in `run.status`. */
function setup(tickets: number[], o: { now: number; project?: (t: number) => number; slug?: string; workflow?: string }) {
  const dir = mkdtempSync(join(root, 'heavy-'));
  mkdirSync(join(dir, 'long'));
  for (const t of tickets) {
    const id = `j${t}-1700000000-abc`;
    writeFileSync(join(dir, 'long', `${id}.json`), JSON.stringify({ id, ticket: t, slug: o.slug ?? `own/repo${o.project?.(t) ?? 1}`, sha: SHA, command: 'npm test', what: 'npm test', who: `Scheme #${t} (cara)`, queued_at: 1700000000000 + t, state: 'queued' }));
  }
  const calls: string[][] = [],
    wakes: [number, string, boolean][] = [],
    notes: string[] = [];
  const run = { status: 'queued', conclusion: null as string | null, log: '', down: false, dispatchFails: false };
  const deps: LongDeps = {
    dir,
    now: () => o.now,
    scheme: (t) => ({ projectId: o.project?.(t) ?? 1, slug: `own/repo${o.project?.(t) ?? 1}` }),
    hours: () => DEFAULT_SETTINGS,
    gh: async (_p, args) => {
      calls.push(args);
      const path = args.find((a) => a.startsWith('repos/')) ?? '';
      if (run.down && !path.endsWith('/cancel')) throw new Error('HTTP 502');
      if (run.dispatchFails && path.endsWith('/dispatches')) throw new Error('timed out');
      if (args.includes('POST') || args.includes('DELETE')) return '';
      if (path.includes('/contents/.github/workflows/citadel-heavy.yml?ref=')) return JSON.stringify({ content: Buffer.from(o.workflow ?? 'on:\n  workflow_dispatch:\n    inputs:\n      sha:\n').toString('base64') });
      if (/^repos\/[^/]+\/[^/]+$/.test(path)) return JSON.stringify({ default_branch: 'main' });
      if (path.includes('/workflows/citadel-heavy.yml/runs')) {
        const ids = (run.dispatchFails ? [] : calls.filter((c) => c.some((a) => a.endsWith('/dispatches')))).map((c) => c.find((a) => a.startsWith('inputs[id]='))!.slice('inputs[id]='.length));
        return JSON.stringify({ workflow_runs: ids.map((id, i) => ({ id: 100 + i, display_title: `heavy ${id}`, html_url: `https://github.com/run/${100 + i}` })) });
      }
      if (path.endsWith('/jobs')) return JSON.stringify({ jobs: [{ id: 7, runner_name: 'desk-1' }] });
      if (path.endsWith('/logs')) return run.log;
      if (/\/actions\/runs\/\d+$/.test(path)) return JSON.stringify({ status: run.status, conclusion: run.conclusion });
      throw new Error(`unexpected gh ${args.join(' ')}`);
    },
    wake: (t, text, light) => wakes.push([t, text, light]),
    note: (_t, text) => notes.push(text),
  };
  const dispatches = () => calls.filter((c) => c.some((a) => a.endsWith('/dispatches')));
  return { dir, deps, calls, wakes, notes, run, dispatches, pump: new LongJobs(deps) };
}

test('a long job waits for 2am: not in the day, not early in job hours, not while the PC is paused', async () => {
  const s = setup([1], { now: NOON });
  let now = NOON,
    paused = false;
  s.deps.now = () => now;
  s.deps.hours = () => ({ ...DEFAULT_SETTINGS, paused });
  for (const t of ['2026-11-19T12:00:00-0800', '2026-11-19T23:30:00-0800', '2026-11-20T01:59:00-0800', '2026-11-20T08:00:00-0800']) {
    now = Date.parse(t);
    await s.pump.pump();
  }
  now = NIGHT;
  paused = true;
  await s.pump.pump();
  assert.equal(s.dispatches().length, 0);
  assert.equal(readLongJobs(s.dir)[0].state, 'queued');
  paused = false;
  await s.pump.pump();
  assert.equal(s.dispatches().length, 1, 'it starts at 3am');
  assert.equal(readLongJobs(s.dir)[0].state, 'dispatched');
});

test('at night it starts one long job per repo at a time', async () => {
  const s = setup([1, 2, 3], { now: NIGHT, project: (t) => (t === 3 ? 2 : 1) });
  await s.pump.pump();
  const byTicket = new Map(readLongJobs(s.dir).map((j) => [j.ticket, j]));
  assert.equal(byTicket.get(1)!.state, 'dispatched');
  assert.equal(byTicket.get(2)!.state, 'queued', 'the second job on the same repo waits for the first');
  assert.equal(byTicket.get(3)!.state, 'dispatched', 'another repo has its own lane');
  const post = s.dispatches()[0];
  assert.ok(post.includes(`inputs[sha]=${SHA}`) && post.includes('inputs[command]=npm test') && post.includes('ref=main'));
  assert.ok(!post.some((a) => a.startsWith('inputs[minutes]')), 'a workflow without a minutes input gets none');
});

test('when the run ends, the minion that queued it is woken with the exit status and the output path', async () => {
  const s = setup([5], { now: NIGHT });
  await s.pump.pump(); // dispatched
  s.run.status = 'in_progress';
  await s.pump.pump(); // finds the run, then reads it running
  assert.equal(readLongJobs(s.dir)[0].state, 'running');
  assert.equal(s.wakes.length, 0);
  Object.assign(s.run, { status: 'completed', conclusion: 'failure', log: ['2026-11-20T09:00:00.0Z setup', `2026-11-20T09:00:01.0Z ${BEGIN}`, '2026-11-20T09:00:02.0Z 3 tests failed', `2026-11-20T09:00:03.0Z ${END}with 1 ===`].join('\n') });
  await s.pump.pump();
  const j = readLongJobs(s.dir)[0];
  assert.equal(j.state, 'failed');
  assert.equal(j.code, 1);
  assert.equal(s.wakes.length, 1);
  const [ticket, text, light] = s.wakes[0];
  const log = join(s.dir, 'long', `${j.id}.log`);
  assert.equal(ticket, 5);
  assert.match(text, /failed with exit 1/);
  assert.ok(text.includes(log), text);
  assert.ok(text.includes('https://github.com/run/100'));
  assert.equal(light, false);
  assert.equal(readFileSync(log, 'utf8'), '3 tests failed\n');
  assert.ok(
    s.calls.some((c) => c.includes('DELETE')),
    'its snapshot ref is dropped',
  );
  await s.pump.pump();
  assert.equal(s.wakes.length, 1, 'an ended job wakes once');
  assert.deepEqual(
    longView(readLongJobs(s.dir), NIGHT).map((v) => v.state),
    ['failed'],
  );
});

test('a job whose minion is gone is lost without waking anyone', async () => {
  const s = setup([6], { now: NIGHT });
  s.deps.scheme = () => null;
  await new LongJobs(s.deps).pump();
  assert.equal(readLongJobs(s.dir)[0].state, 'lost');
  assert.equal(s.dispatches().length, 0);
  assert.equal(s.wakes.length, 0);
});

test('a workflow on the default branch with a minutes input gets the long limit; a mixed-case repo name still matches', async () => {
  const s = setup([7], { now: NIGHT, slug: 'Own/Repo1', workflow: 'on:\n  workflow_dispatch:\n    inputs:\n      minutes:\n        required: false\n' });
  await s.pump.pump();
  const post = s.dispatches()[0];
  assert.ok(post, "the job matched its scheme's lowercased repo and went out");
  assert.ok(post.includes('inputs[minutes]=360'), post.join(' '));
  assert.ok(
    s.calls.some((c) => c.some((a) => a.endsWith('/contents/.github/workflows/citadel-heavy.yml?ref=main'))),
    'the workflow is read at the branch GitHub runs',
  );
});

// #1592: on 2026-11-22 a long job held the side runner from 02:04 to about 07:30, and five flake proofs queued behind it.
// A workflow with a `long` input sends long jobs to a runner of their own, so proofs and heavy runs keep the side one.
test('a workflow with a long input sends long jobs to their own runner; one without it keeps the side runner', async () => {
  const s = setup([9], { now: NIGHT, workflow: 'on:\n  workflow_dispatch:\n    inputs:\n      minutes:\n        required: false\n      long:\n        required: false\n' });
  await s.pump.pump();
  assert.ok(s.dispatches()[0].includes('inputs[long]=true'), s.dispatches()[0].join(' '));
  const old = setup([10], { now: NIGHT });
  await old.pump.pump();
  assert.ok(!old.dispatches()[0].some((a) => a.startsWith('inputs[long]')), 'GitHub refuses an input the workflow lacks');
});

test('citadel-heavy.yml runs a long job only on the long runner, and every other heavy run off it', () => {
  const wf = readFileSync(new URL('../.github/workflows/citadel-heavy.yml', import.meta.url), 'utf8');
  assert.match(wf, /^ {6}long:\s*$/m, 'it declares the input the pump looks for');
  const runsOn = wf.match(/^ {4}runs-on: (.*)$/m)![1];
  assert.match(runsOn, /inputs\.long == 'true' && fromJSON\('\["self-hosted", "citadel-ci-linux", "citadel-ci-linux-long"\]'\)/);
  assert.match(runsOn, /\|\| fromJSON\('\["self-hosted", "citadel-ci-linux", "citadel-ci-linux-side"\]'\)/);
});

test('a dispatch that errors is never sent twice at once: it waits for a run, goes back in line, and is lost after three tries', async () => {
  const s = setup([8], { now: NIGHT });
  s.run.dispatchFails = true;
  let now = NIGHT;
  s.deps.now = () => now;
  for (let i = 0; i < 3; i++) {
    await s.pump.pump(); // dispatches; the answer errors, but GitHub may have taken it
    assert.equal(readLongJobs(s.dir)[0].state, 'dispatched');
    await s.pump.pump(); // still inside the no-run window: no second dispatch
    assert.equal(s.dispatches().length, i + 1);
    now += 6 * 60_000;
    await s.pump.pump(); // no run showed up
  }
  const j = readLongJobs(s.dir)[0];
  assert.equal(j.state, 'lost');
  assert.match(j.why!, /no run for any of its 3 dispatches/);
  assert.equal(s.wakes.length, 1);
  assert.match(s.wakes[0][1], /was lost/);
});

test('a pass wakes lightly; GitHub down for an hour loses a running job, cancels its run and wakes the minion', async () => {
  const ok = setup([9], { now: NIGHT });
  await ok.pump.pump();
  Object.assign(ok.run, { status: 'completed', conclusion: 'success', log: `2026-11-20T09:00:00.0Z ${BEGIN}\n2026-11-20T09:00:00.0Z all good\n2026-11-20T09:00:00.0Z ${END}with 0 ===` });
  await ok.pump.pump();
  assert.equal(readLongJobs(ok.dir)[0].state, 'done');
  assert.match(ok.wakes[0][1], /passed with exit 0/);
  assert.equal(ok.wakes[0][2], true);

  const s = setup([10], { now: NIGHT });
  await s.pump.pump();
  s.run.status = 'in_progress';
  await s.pump.pump();
  s.run.down = true;
  for (let i = 0; i < 59; i++) await s.pump.pump();
  assert.equal(readLongJobs(s.dir)[0].state, 'running', 'an outage under an hour is ridden out');
  await s.pump.pump();
  assert.equal(readLongJobs(s.dir)[0].state, 'lost');
  assert.ok(
    s.calls.some((c) => c.some((a) => a.endsWith('/actions/runs/100/cancel'))),
    'its run is cancelled',
  );
  assert.equal(s.wakes.length, 1);
  assert.match(s.wakes[0][1], /GitHub kept failing for an hour/);
});

test('a job that ended but whose wake never went out (a restart in between) wakes its minion on the next pass', async () => {
  const s = setup([11], { now: NIGHT });
  await s.pump.pump();
  Object.assign(s.run, { status: 'completed', conclusion: 'failure', log: `2026-11-20T09:00:00.0Z ${BEGIN}\n2026-11-20T09:00:00.0Z bad\n2026-11-20T09:00:00.0Z ${END}with 2 ===` });
  const wake = s.deps.wake;
  s.deps.wake = () => {
    throw new Error('server stopped');
  };
  await new LongJobs(s.deps).pump();
  const j = readLongJobs(s.dir)[0];
  assert.equal(j.state, 'failed');
  assert.equal(j.woke, false);
  s.deps.wake = wake;
  await new LongJobs(s.deps).pump();
  assert.equal(s.wakes.length, 1);
  assert.match(s.wakes[0][1], /failed with exit 2/);
  await new LongJobs(s.deps).pump();
  assert.equal(s.wakes.length, 1, 'once woken, never again');
});

// Deploys first (#1902): a heavy job handed over while ships were in line (`quiet`), and long jobs, wait for the line.
function quiet(s: ReturnType<typeof setup>, o: Record<string, unknown> = {}) {
  const f = join(s.dir, 'long', 'j1-1700000000-abc.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), quiet: true, ...o }));
}

test('a handed-over job starts in the day once the line is empty, on the side runner with the normal limit', async () => {
  const s = setup([1], { now: NOON, workflow: 'on:\n  workflow_dispatch:\n    inputs:\n      minutes:\n      long:\n' });
  quiet(s);
  let why: string | null = '2 ships are in line';
  s.deps.hold = () => why;
  await s.pump.pump();
  assert.equal(s.dispatches().length, 0);
  why = null;
  await s.pump.pump();
  assert.equal(s.dispatches().length, 1);
  assert.doesNotMatch(s.dispatches()[0].join(' '), /inputs\[(long|minutes)\]/);
  assert.match(s.notes.join('\n'), /Heavy job .* went to own\/repo1's CI/);
  assert.equal(longView(readLongJobs(s.dir), NOON)[0].quiet, true);
});

test('ships hold a long job at night too, and it keeps since when and why for the hold to tell', async () => {
  const s = setup([1], { now: NIGHT });
  let why: string | null = 'a ship is in line';
  s.deps.hold = () => why;
  let now = NIGHT;
  s.deps.now = () => now;
  await s.pump.pump();
  assert.equal(s.dispatches().length, 0);
  const since = readLongJobs(s.dir)[0].held_at;
  now += 3600_000;
  why = '2 ships are in line';
  await s.pump.pump();
  await s.pump.refresh();
  await s.pump.told(readLongJobs(s.dir)[0].id);
  assert.deepEqual([readLongJobs(s.dir)[0].held_at, readLongJobs(s.dir)[0].held_why, readLongJobs(s.dir)[0].reported], [since, '2 ships are in line', true]);
  why = null;
  await s.pump.pump();
  assert.equal(s.dispatches().length, 1);
  assert.equal(readLongJobs(s.dir)[0].held_why, undefined, 'dispatched: no longer waiting');
});

test('a running job the hold stopped is not ended by its cancelled run, and wakes its minion when the run comes back and ends', async () => {
  const s = setup([1], { now: NOON });
  quiet(s, { state: 'running', run_id: 100, url: 'https://github.com/run/100', dispatched_at: NOON });
  Object.assign(s.run, { status: 'completed', conclusion: 'cancelled' });
  let held = true;
  s.deps.heldRun = () => held;
  await s.pump.pump();
  assert.deepEqual([readLongJobs(s.dir)[0].state, s.wakes.length], ['dispatched', 0]);
  held = false;
  Object.assign(s.run, { conclusion: 'success', log: ['2026-11-20T09:00:01.0Z ' + BEGIN, '2026-11-20T09:00:02.0Z hi', `2026-11-20T09:00:03.0Z ${END}0 ===`].join('\n') });
  await s.pump.pump();
  assert.equal(readLongJobs(s.dir)[0].state, 'done');
  assert.match(s.wakes[0][1], /^Heavy job/);
});

// #2059: nobody reads a dismissed minion's job. One not started yet is dropped; a run already on CI is left alone.
test('a queued or held job whose minion closed is dropped, not started, and the minion is not woken', async () => {
  const s = setup([1, 2, 3], { now: NIGHT, project: (t) => t });
  quiet(s, { held_at: NIGHT, held_why: 'a ship is in line' });
  s.deps.scheme = (t) => ({ projectId: t, slug: `own/repo${t}`, closed: t !== 3 });
  await new LongJobs(s.deps).pump();
  const byTicket = new Map(readLongJobs(s.dir).map((j) => [j.ticket, j]));
  for (const t of [1, 2]) {
    assert.equal(byTicket.get(t)!.state, 'lost');
    assert.equal(byTicket.get(t)!.why, 'its minion closed');
  }
  assert.equal(byTicket.get(3)!.state, 'dispatched', 'an open one (pending-deploy included) still starts');
  assert.equal(s.dispatches().length, 1);
  assert.equal(s.wakes.length, 0, 'a wake would reopen it');
  assert.ok(
    s.calls.some((c) => c.includes('DELETE') && c.some((a) => a.endsWith('j1-1700000000-abc'))),
    'its snapshot ref goes',
  );
  await new LongJobs(s.deps).pump();
  assert.equal(s.wakes.length, 0, 'nor on a later pass');
});

test('a run already on CI when its minion closed is left to finish', async () => {
  const s = setup([1], { now: NIGHT });
  quiet(s, { state: 'running', run_id: 100, url: 'https://github.com/run/100', dispatched_at: NIGHT });
  s.deps.scheme = () => ({ projectId: 1, slug: 'own/repo1', closed: true });
  s.run.status = 'in_progress';
  await new LongJobs(s.deps).pump();
  assert.equal(readLongJobs(s.dir)[0].state, 'running');
  assert.ok(!s.calls.some((c) => c.includes('POST')), 'nothing cancels it');
});

test('a minion closed while its job was starting gets no dispatch', async () => {
  const s = setup([1], { now: NIGHT });
  let closed = false;
  s.deps.scheme = () => ({ projectId: 1, slug: 'own/repo1', closed });
  const gh = s.deps.gh;
  s.deps.gh = (p, args) => {
    closed = true;
    return gh(p, args);
  };
  const pump = new LongJobs(s.deps);
  await pump.pump();
  assert.equal(s.dispatches().length, 0);
  await pump.pump();
  assert.equal(readLongJobs(s.dir)[0].state, 'lost');
});
