import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { BUSY, CiRuns, KEEP_MS, ciNow, pendingRuns } from '../src/ci-wait.ts';
import type { Job } from '../src/ci-health.ts';
import type { PrSnapshot } from '../src/github.ts';
import { Store } from '../src/db.ts';
import { Waits, type TestCounts } from '../src/waits.ts';
import { thrown } from '../src/thrown.ts';

// src/ci-wait.ts (#546): a CI run's jobs and steps as a minion's wait.
const T0 = Date.parse('2026-11-11T20:00:00Z');
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const steps = (done: number, of: number, running = true) =>
  Array.from({ length: of }, (_, i) => ({
    name: `step ${i + 1}`,
    status: i < done ? 'completed' : i === done && running ? 'in_progress' : 'queued',
    conclusion: i < done ? 'success' : null,
  }));
const job = (name: string, over: Partial<Job> = {}): Job => ({
  id: 1,
  run_id: 7,
  name,
  status: 'queued',
  conclusion: null,
  created_at: iso(0),
  runner_name: null,
  labels: ['self-hosted', 'citadel-ci-linux'],
  steps: [],
  ...over,
});

test('ciNow: queued, then a job by its steps or several by how many are done, then pass or fail', async () => {
  assert.equal(ciNow([]), null);
  assert.deepEqual(ciNow([job('test')]), { stage: 'queued', short: 'queued', text: 'queued for a runner (citadel-ci-linux)', since: T0 });
  const one = ciNow([job('test', { status: 'in_progress', runner_name: 'cara-desktop', steps: steps(4, 8) })])!;
  assert.deepEqual([one.short, one.text, one.done, one.total], ['step 5/8', 'test step 5 of 8: step 5 (cara-desktop)', 4, 8]);
  const three = ciNow([job('lint', { status: 'completed', conclusion: 'success', created_at: iso(5) }), job('test-linux', { status: 'in_progress', steps: steps(1, 3) }), job('test-windows')])!;
  assert.deepEqual([three.stage, three.short, three.text, three.since], ['jobs', '1/3 jobs', 'test-linux step 2 of 3: step 2', T0]);
  const red = ciNow([job('lint', { status: 'completed', conclusion: 'failure', steps: [{ name: 'eslint', status: 'completed', conclusion: 'failure' }] }), job('test', { status: 'in_progress', steps: steps(0, 2) })])!;
  assert.equal(red.text, 'lint failed, test step 1 of 2: step 1', 'a red job shows before the run ends');
  const ok = (over: Partial<Job>) => job('test', { status: 'completed', conclusion: 'success', completed_at: iso(300), ...over });
  assert.deepEqual(ciNow([ok({})]), { stage: 'passed', short: 'passed', text: 'passed, its job green', since: T0, ended: T0 + 300_000 });
  assert.equal(ciNow([ok({}), ok({ name: 'b', conclusion: 'failure', steps: [{ name: 'the full suite', status: 'completed', conclusion: 'failure' }] })])!.text, 'failed in b (the full suite)');
  assert.equal(ciNow([ok({ conclusion: 'cancelled' })])!.stage, 'cancelled');
  // Every job skipped (a draft's PR CI, #558) tested nothing: not green. A skip beside a real pass still is.
  assert.deepEqual(ciNow([ok({ conclusion: 'skipped' }), ok({ name: 'b', conclusion: 'neutral' })]), { stage: 'skipped', short: 'skipped', text: 'ran nothing, all 2 jobs skipped', since: T0, ended: T0 + 300_000 });
  assert.equal(ciNow([ok({}), ok({ name: 'b', conclusion: 'skipped' })])!.stage, 'passed');
});

test("pendingRuns: the Actions runs of a PR's pending checks", async () => {
  const pr = {
    checks: [
      { name: 'a', status: 'pending', url: 'https://github.com/o/r/actions/runs/11/job/1' },
      { name: 'b', status: 'pending', url: 'https://github.com/o/r/actions/runs/11/job/2' },
      { name: 'c', status: 'passed', url: 'https://github.com/o/r/actions/runs/12/job/3' },
      { name: 'd', status: 'pending', url: 'https://ci.example.com/x' },
    ],
  } as PrSnapshot;
  assert.deepEqual(pendingRuns(pr), [11]);
});

/** A fake GitHub: answers by path from `answers`, counting calls; an unchanged body is a 304. */
function github() {
  const answers = new Map<string, unknown>();
  const calls: string[] = [];
  const get = async (path: string, etag: string | null) => {
    calls.push(path);
    const body = answers.get(path) ?? answers.get(path.replace(/\?.*/, ''));
    if (body === undefined) return { status: 404, etag: null, body: { message: 'Not Found' } };
    const tag = JSON.stringify(body);
    return etag === tag ? { status: 304, etag, body: null } : { status: 200, etag: tag, body };
  };
  return { answers, calls, get };
}

const root = mkdtempSync(join(tmpdir(), 'ci-wait-'));
after(() => rmSync(root, { recursive: true, force: true }));
const store = new Store(join(root, 'test.db'));
const project = store.createProject('Citadel', null);
function minion(status: 'running' | 'idle' = 'idle') {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, `ticket/${t.number}-x`);
  store.updateTicket(t.id, { status });
  return { id: t.id, branch: `ticket/${t.number}-x` };
}

function setup() {
  let now = T0 + 60_000;
  const gh = github();
  const changed: number[] = [];
  const state = mkdtempSync(join(root, 'state-'));
  mkdirSync(join(state, 'queue'));
  let ci!: CiRuns;
  const heads: { sha: string | null } = { sha: null };
  const waits = new Waits({
    store,
    deployState: state,
    heavyDir: join(root, 'none'),
    ship: () => null,
    interruptible: () => 0,
    changed: (id) => changed.push(id),
    now: () => now,
    alive: () => true,
    held: () => false,
    ci: (ci = new CiRuns({ changed: (id) => waits.check(id), get: gh.get, now: () => now, head: async () => heads.sha })),
    ciSlug: () => 'o/r',
  });
  const pr = (number: number, runs: number[], state: PrSnapshot['state'] = 'OPEN') =>
    ({
      number,
      state,
      checks: runs.map((r) => ({ name: `c${r}`, status: 'pending', url: `https://github.com/o/r/actions/runs/${r}/job/1` })),
    }) as PrSnapshot;
  return { gh, ci, waits, changed, state, pr, heads, at: (s: number) => (now = T0 + s * 1000), now: () => now };
}

test("a PR's run: queued, its jobs, then green for a while; shown only once the turn has ended", async () => {
  const { gh, ci, waits, changed, pr, at } = setup();
  const m = minion();
  gh.answers.set('repos/o/r/actions/runs/7', { id: 7, workflow_id: 3, status: 'queued' });
  gh.answers.set('repos/o/r/actions/workflows/3/runs', { workflow_runs: [100, 200, 300, 400, 500].map((s) => ({ created_at: iso(0), updated_at: iso(s) })) });
  gh.answers.set('repos/o/r/actions/runs/7/jobs', { jobs: [job('lint'), job('test')] });
  ci.pr(m.id, 'o/r', undefined, pr(88, [7]));
  await ci.tick();
  assert.deepEqual(waits.wait(m.id), { kind: 'ci', stage: 'queued', chip: 'CI · queued', text: 'PR #88 · queued for a runner (citadel-ci-linux)', since: T0, usual: 300 });
  assert.deepEqual(changed, [m.id]);

  store.updateTicket(m.id, { status: 'running' });
  assert.equal(waits.wait(m.id), null, 'its own turn says more while it runs');
  store.updateTicket(m.id, { status: 'idle' });

  gh.answers.set('repos/o/r/actions/runs/7/jobs', { jobs: [job('lint', { status: 'completed', conclusion: 'success', completed_at: iso(30) }), job('test', { status: 'in_progress', steps: steps(2, 5) })] });
  at(80);
  await ci.tick();
  assert.equal(waits.wait(m.id)!.chip, 'CI · 1/2 jobs');
  assert.equal(waits.wait(m.id)!.text, 'PR #88 · test step 3 of 5: step 3');

  gh.calls.length = 0;
  at(90);
  await ci.tick();
  assert.deepEqual(gh.calls, ['repos/o/r/actions/runs/7/jobs?per_page=100'], 'one call a poll while it runs');

  // All jobs done, but the run itself still going (a job that waits on others isn't listed yet): not over.
  const done = { jobs: [job('lint', { status: 'completed', conclusion: 'success', completed_at: iso(30) }), job('test', { status: 'completed', conclusion: 'success', completed_at: iso(250) })] };
  gh.answers.set('repos/o/r/actions/runs/7/jobs', done);
  at(260);
  await ci.tick();
  assert.deepEqual([waits.wait(m.id)!.stage, waits.wait(m.id)!.chip, waits.wait(m.id)!.text], ['jobs', 'CI · 2/2 jobs', 'PR #88 · 2 of 2 jobs done, the next not started yet'], 'no verdict before the run says so');
  gh.answers.set('repos/o/r/actions/runs/7', { id: 7, workflow_id: 3, status: 'completed' });
  await ci.tick();
  gh.calls.length = 0;
  at(270);
  await ci.tick();
  assert.deepEqual(gh.calls, [], 'an ended run is not asked about again');
  assert.deepEqual(waits.wait(m.id), { kind: 'ci', stage: 'passed', chip: 'CI · passed', text: 'PR #88 · passed, all 2 jobs green', since: T0, usual: 300, ended: T0 + 250_000 });
  // The watcher, two minutes behind, still sees it pending, then green: the pass stays until KEEP_MS.
  ci.pr(m.id, 'o/r', undefined, pr(88, [7]));
  ci.pr(m.id, 'o/r', undefined, pr(88, []));
  assert.equal(waits.wait(m.id)!.stage, 'passed');
  at(260 + KEEP_MS / 1000);
  await ci.tick();
  assert.equal(waits.wait(m.id), null);
});

test('a PR closed or pushed again lets the old run go', async () => {
  const { gh, ci, waits, pr } = setup();
  const m = minion();
  gh.answers.set('repos/o/r/actions/runs/7/jobs', { jobs: [job('test')] });
  gh.answers.set('repos/o/r/actions/runs/8/jobs', { jobs: [job('test', { status: 'in_progress', steps: steps(0, 2) })] });
  ci.pr(m.id, 'o/r', undefined, pr(88, [7]));
  await ci.tick();
  assert.equal(waits.wait(m.id)!.chip, 'CI · queued', 'no usual known is fine');
  ci.pr(m.id, 'o/r', undefined, pr(88, [8]));
  await ci.tick();
  assert.equal(waits.wait(m.id)!.chip, 'CI · step 1/2');
  ci.pr(m.id, 'o/r', undefined, pr(88, [8], 'CLOSED'));
  assert.equal(waits.wait(m.id), null);
});

test('more than BUSY runs in flight: each is asked about once a minute', async () => {
  const { gh, ci, pr, at } = setup();
  for (let i = 0; i <= BUSY; i++) {
    gh.answers.set(`repos/o/r/actions/runs/${100 + i}/jobs`, { jobs: [job('test')] });
    ci.pr(minion().id, 'o/r', undefined, pr(i, [100 + i]));
  }
  await ci.tick();
  const jobs = () => gh.calls.filter((c) => c.endsWith('/jobs?per_page=100')).length;
  assert.equal(jobs(), BUSY + 1);
  at(80);
  await ci.tick();
  assert.equal(jobs(), BUSY + 1, '20 s later: not yet');
  at(121);
  await ci.tick();
  assert.equal(jobs(), 2 * (BUSY + 1));
});

test('a landing waiting for CI finds its run by its commit, as land.sh does', async () => {
  const { gh, ci, waits, state, heads } = setup();
  const m = minion('running');
  heads.sha = 'abc123';
  writeFileSync(join(state, 'queue', '0000000001'), `100 77\n1\n${m.branch}\nwaiting for CI since 12:01\n`);
  await waits.poll();
  // An earlier try's green run of the same commit counts, however old.
  gh.answers.set('repos/o/r/actions/workflows/tests.yml/runs', { workflow_runs: [{ id: 5, status: 'completed', created_at: iso(-3600) }] });
  gh.answers.set('repos/o/r/actions/runs/5/jobs', { jobs: [job('test', { status: 'in_progress', steps: steps(1, 3) })] });
  await ci.tick();
  assert.ok(gh.calls.includes('repos/o/r/actions/workflows/tests.yml/runs?per_page=5&head_sha=abc123'));
  assert.equal(waits.wait(m.id)!.chip, 'ship · CI 2/3');
});

test("a landing waiting for CI passes over an earlier try's red run of the same commit, which land.sh replaces", async () => {
  const { gh, ci, waits, state, heads, at, now } = setup();
  const m = minion('running');
  heads.sha = 'abc123';
  const f = join(state, 'queue', '0000000001');
  writeFileSync(f, `100 77\n${now() / 1000 - 30}\n${m.branch}\nwaiting for CI since 12:01\n`);
  utimesSync(f, now() / 1000, now() / 1000);
  await waits.poll();
  const runs = 'repos/o/r/actions/workflows/tests.yml/runs';
  const old = { id: 5, status: 'completed', conclusion: 'failure', created_at: iso(-3600) };
  gh.answers.set(runs, { workflow_runs: [old] });
  gh.answers.set('repos/o/r/actions/runs/5/jobs', { jobs: [job('test', { status: 'completed', conclusion: 'failure' })] });
  await ci.tick();
  assert.equal(waits.wait(m.id)!.chip, 'ship · CI', "not the old run's result");
  // The run land.sh starts in its place is the one shown; a red run of this wait's own still counts.
  gh.answers.set(runs, { workflow_runs: [{ id: 9, status: 'completed', conclusion: 'failure', created_at: iso(40) }, old] });
  gh.answers.set('repos/o/r/actions/runs/9/jobs', { jobs: [job('test', { status: 'in_progress', steps: steps(1, 3) })] });
  at(125);
  await ci.tick();
  assert.equal(waits.wait(m.id)!.chip, 'ship · CI 2/3');
});

test('a landing waiting for CI shows its run on land/<branch>; a fallback says so', async () => {
  const { gh, ci, waits, state, at, now } = setup();
  const m = minion('running');
  const f = join(state, 'queue', '0000000001');
  const phase = (text: string) => {
    writeFileSync(f, `100 77\n${now() / 1000 - 30}\n${m.branch}\n${text}\n`);
    utimesSync(f, now() / 1000, now() / 1000);
  };
  phase('waiting for CI since 12:01');
  await waits.poll();
  assert.equal(waits.wait(m.id)!.chip, 'ship · CI', 'no run yet');
  // An old run of the branch from an earlier landing doesn't count; the new one does.
  const runs = `repos/o/r/actions/workflows/tests.yml/runs`;
  gh.answers.set(runs, { workflow_runs: [{ id: 5, workflow_id: 3, status: 'completed', created_at: iso(-3600) }] });
  await ci.tick();
  assert.equal(waits.wait(m.id)!.chip, 'ship · CI');
  gh.answers.set(runs, { workflow_runs: [{ id: 9, workflow_id: 3, status: 'queued', created_at: iso(61) }] });
  gh.answers.set('repos/o/r/actions/runs/9/jobs', { jobs: [job('test')] });
  at(65);
  await ci.tick();
  assert.ok(gh.calls.includes(`${runs}?per_page=5&branch=land%2F${encodeURIComponent(m.branch)}`));
  const w = waits.wait(m.id)!;
  assert.deepEqual([w.kind, w.stage, w.chip, w.text], ['land', 'test', 'ship · CI queued', 'waiting for CI: queued for a runner (citadel-ci-linux); if none starts it soon, the suite runs on perigee']);
  assert.equal(w.brief, 'CI: queued');
  gh.answers.set('repos/o/r/actions/runs/9/jobs', { jobs: [job('test', { status: 'in_progress', runner_name: 'cara-desktop', steps: steps(4, 8) })] });
  at(85);
  await ci.tick();
  assert.deepEqual([waits.wait(m.id)!.chip, waits.wait(m.id)!.text], ['ship · CI 5/8', 'waiting for CI: test step 5 of 8: step 5 (cara-desktop)']);
  assert.equal(waits.wait(m.id)!.brief, 'CI: step 5', "the line's short form: one counter (the landing's stage), the step by name, no runner (#630)");
  // No runner took it in time: land.sh cancels the run and tests on perigee.
  phase('running the tests since 12:03');
  await waits.poll();
  assert.deepEqual([waits.wait(m.id)!.chip, waits.wait(m.id)!.text], ['ship · tests', 'CI fell back: running the full suite on perigee']);
  assert.equal(ci.view(m.id), null, 'the cancelled run is let go');
});

test("a queued run counts the repo's older queued runs ahead of it, read once a poll for the repo", async () => {
  const { gh, ci, waits, pr } = setup();
  const a = minion(),
    b = minion();
  gh.answers.set('repos/o/r/actions/runs', {
    workflow_runs: [
      { id: 6, created_at: iso(-10) },
      { id: 7, created_at: iso(0) },
      { id: 9, created_at: iso(5) },
    ],
  });
  gh.answers.set('repos/o/r/actions/runs/6/jobs', { jobs: [job('test', { created_at: iso(-10) })] });
  gh.answers.set('repos/o/r/actions/runs/9/jobs', { jobs: [job('test', { created_at: iso(5) })] });
  ci.pr(a.id, 'o/r', undefined, pr(1, [6]));
  ci.pr(b.id, 'o/r', undefined, pr(2, [9]));
  await ci.tick();
  assert.deepEqual([waits.wait(a.id)!.chip, waits.wait(a.id)!.text], ['CI · queued', 'PR #1 · queued for a runner (citadel-ci-linux), none ahead']);
  assert.deepEqual([waits.wait(b.id)!.chip, waits.wait(b.id)!.text], ['CI · 2 ahead', 'PR #2 · queued for a runner (citadel-ci-linux), 2 runs ahead']);
  assert.equal(gh.calls.filter((c) => c.startsWith('repos/o/r/actions/runs?status=queued')).length, 1);
  // Over a page of queued runs: the oldest may be missing, so no count.
  gh.answers.set('repos/o/r/actions/runs', {
    total_count: 101,
    workflow_runs: [
      { id: 6, created_at: iso(-10) },
      { id: 9, created_at: iso(5) },
    ],
  });
  await ci.tick();
  assert.equal(waits.wait(a.id)!.chip, 'CI · queued');
  assert.equal(waits.wait(a.id)!.text, 'PR #1 · queued for a runner (citadel-ci-linux)');
  // Started: no more queue reads, and no count.
  gh.answers.set('repos/o/r/actions/runs/9/jobs', { jobs: [job('test', { created_at: iso(5), status: 'in_progress', steps: steps(0, 2) })] });
  gh.answers.set('repos/o/r/actions/runs/6/jobs', { jobs: [job('test', { created_at: iso(-10), status: 'in_progress', steps: steps(0, 2) })] });
  gh.calls.length = 0;
  await ci.tick();
  assert.equal(waits.wait(b.id)!.chip, 'CI · step 1/2');
  assert.deepEqual(
    gh.calls.filter((c) => c.includes('status=queued')),
    [],
  );
});

// #1368: a landing's CI job sends its suite's test file counts (POST /api/ci-tests, its run named by its GitHub run
// token); the wait, and so the Releases Test stage and its riders, read "143/412 test files" and fill by them.
test("a landing's CI shows its suite's test files as its job sends them, and its steps again once they stop", async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { Readable } = await import('node:stream');
  const { AUDIENCE, CiStore, ISSUER, RunTokens } = await import('../src/ci-store.ts');
  const { agentRoutes } = await import('../src/routes/machines.ts');
  const { gh, ci, waits, state, at, now } = setup();
  const m = minion('running');
  const f = join(state, 'queue', '0000000001');
  writeFileSync(f, `100 77\n${now() / 1000 - 30}\n${m.branch}\nwaiting for CI since 12:01\n`);
  utimesSync(f, now() / 1000, now() / 1000);
  await waits.poll();
  gh.answers.set('repos/o/r/actions/workflows/tests.yml/runs', { workflow_runs: [{ id: 9, workflow_id: 3, status: 'in_progress', created_at: iso(61) }] });
  gh.answers.set('repos/o/r/actions/runs/9/jobs', { jobs: [job('test', { status: 'in_progress', runner_name: 'cara-desktop', steps: steps(6, 8) })] });
  at(65);
  await ci.tick();
  assert.equal(waits.wait(m.id)!.brief, 'CI: step 7', 'no counts yet: its step, as before');

  // The route: the run comes from the job's run token, never from the body.
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  store.setProjectUpstream(project.id, 'https://github.com/o/r', null);
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const t = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'RS256', kid: 'k1', typ: 'JWT' })}.${b64({ iss: ISSUER, aud: AUDIENCE, exp: t + 300, nbf: t - 300, repository: 'o/r', run_id: '9', run_attempt: '1', sha: 'a'.repeat(40), ref: 'refs/heads/land/x', workflow_ref: 'o/r/.github/workflows/tests.yml@refs/heads/land/x' })}`;
  const token = `${body}.${sign('RSA-SHA256', Buffer.from(body), keys.privateKey).toString('base64url')}`;
  const app = { ciStore: new CiStore(store, join(root, 'store'), new RunTokens(async () => [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'k1' }])), ciTests: (repo: string, run: number, c: TestCounts) => ci.testCounts(repo, run, c) };
  const route = agentRoutes.find((r) => r.path === '/api/ci-tests')!;
  const post = async (sent: unknown, auth = `Bearer ${token}`) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(sent))]), { headers: { 'content-type': 'application/json', authorization: auth } });
    const res = {
      status: 0,
      headersSent: false,
      setHeader() {},
      writeHead(s: number) {
        this.status = s;
        return this;
      },
      end() {},
    };
    try {
      await route.handler({ req, res, app } as any);
      return res.status;
    } catch (err) {
      return thrown(err).status;
    }
  };
  assert.equal(await post({ done: 143, total: 412, file: 'test/releases.test.ts' }, 'Bearer nope'), 401, 'no run token, no count');
  assert.equal(await post({ done: 413, total: 412 }), 400);
  assert.equal(await post({ done: 'x', total: 412 }), 400);
  ci.testCounts('someone/else', 9, { done: 1, total: 2, file: '' });
  assert.equal(waits.wait(m.id)!.brief, 'CI: step 7', "another repo's run 9 is not this one");
  assert.equal(await post({ done: 143, total: 412, file: 'test/releases.test.ts' }), 202);
  const w = waits.wait(m.id)!;
  assert.deepEqual([w.brief, w.done, w.total, w.chip], ['CI: 143/412 test files', 143, 412, 'ship · CI 7/8'], 'the stage reads and fills by test files; the chip keeps its steps (Josh, #551)');
  assert.equal(w.text, 'waiting for CI: test step 7 of 8: step 7 (cara-desktop) · 143 of 412 test files · test/releases.test.ts');

  // Files failed so far ride along, and once the suite ends its reruns count (phase rerun): Releases names them (#1368).
  assert.equal(await post({ done: 1, total: 2, failed: 'test/a.test.ts' }), 400, 'failed is a list');
  assert.equal(await post({ done: 1, total: 2, phase: 'bisect' }), 400);
  assert.equal(await post({ done: 200, total: 412, failed: ['test/memory.test.ts'] }), 202);
  assert.deepEqual(waits.wait(m.id)!.failed, ['test/memory.test.ts']);
  assert.equal(await post({ done: 1, total: 4, file: 'test/memory.test.ts', failed: ['test/memory.test.ts', 'x'.repeat(300), ...Array(30).fill('t')], phase: 'rerun' }), 202);
  const r = waits.wait(m.id)!;
  assert.deepEqual([r.brief, r.done, r.total, r.failed!.length, r.failed![1].length], ['CI: 1/4 failed files rerun alone', 1, 4, 20, 200], 'at most 20 names of 200 characters');
  assert.equal(await post({ done: 143, total: 412, file: 'test/releases.test.ts' }), 202);
  assert.equal(waits.wait(m.id)!.failed, undefined, 'none failed: none shown');

  // They stop (the suite ended, or the sender died): its steps again once they're stale.
  at(65 + 44);
  await ci.tick();
  assert.equal(waits.wait(m.id)!.brief, 'CI: 143/412 test files');
  at(65 + 46);
  await ci.tick();
  assert.deepEqual([waits.wait(m.id)!.brief, waits.wait(m.id)!.done, waits.wait(m.id)!.total], ['CI: step 7', 6, 8]);
});

test("a train front's CI run, on the train's top commit, is found by land/<branch> and followed to a re-formed train's new run", async () => {
  const { gh, ci, waits, state, heads, at, now } = setup();
  const m = minion('running');
  heads.sha = 'front-head'; // the front's own worktree, an ancestor of the train's top the run is on
  const f = join(state, 'queue', '0000000001');
  writeFileSync(f, `100 77\n${now() / 1000 - 30}\n${m.branch}\nwaiting for CI since 12:01\n`);
  utimesSync(f, now() / 1000, now() / 1000);
  await waits.poll();
  const runs = 'repos/o/r/actions/workflows/tests.yml/runs?per_page=5&';
  gh.answers.set(`${runs}head_sha=front-head`, { workflow_runs: [] });
  const byBranch = `${runs}branch=land%2F${encodeURIComponent(m.branch)}`;
  gh.answers.set(byBranch, { workflow_runs: [{ id: 5, status: 'completed', conclusion: 'failure', created_at: iso(-3600) }] });
  await ci.tick();
  assert.equal(waits.wait(m.id)!.brief, 'CI: waiting for a run or runner', "an earlier train's run isn't this one's");
  gh.answers.set(byBranch, {
    workflow_runs: [
      { id: 9, status: 'in_progress', created_at: iso(61) },
      { id: 5, status: 'completed', conclusion: 'failure', created_at: iso(-3600) },
    ],
  });
  gh.answers.set('repos/o/r/actions/runs/9/jobs', { jobs: [job('test', { status: 'in_progress', steps: steps(1, 3) })] });
  at(65);
  await ci.tick();
  assert.equal(waits.wait(m.id)!.chip, 'ship · CI 2/3');
  // The train is re-formed after a red: its new run replaces the red one.
  gh.answers.set('repos/o/r/actions/runs/9/jobs', { jobs: [job('test', { status: 'completed', conclusion: 'failure' })] });
  gh.answers.set('repos/o/r/actions/runs/9', { id: 9, status: 'completed', conclusion: 'failure' });
  at(70);
  await ci.tick();
  gh.answers.set(byBranch, {
    workflow_runs: [
      { id: 12, status: 'in_progress', created_at: iso(80) },
      { id: 9, status: 'completed', conclusion: 'failure', created_at: iso(61) },
    ],
  });
  gh.answers.set('repos/o/r/actions/runs/12/jobs', { jobs: [job('test', { status: 'in_progress', steps: steps(2, 3) })] });
  at(90);
  await ci.tick();
  await ci.tick();
  assert.equal(waits.wait(m.id)!.chip, 'ship · CI 3/3');
});
