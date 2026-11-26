import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { CiRuns } from '../src/ci-wait.ts';
import type { Job } from '../src/ci-health.ts';
import { Store } from '../src/db.ts';
import { earlyDroppedWhy } from '../src/land-news.ts';
import { parseEarly, Waits } from '../src/waits.ts';

// The next ship's early test on the page (#1905): land.sh's <cc-deploy>/early names the stacked run (#1366); the ship's wait says
// it is running, passed, or thrown away, and says nothing when early tests are off.
const T0 = Date.parse('2026-11-24T20:00:00Z');
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const job = (over: Partial<Job> = {}): Job => ({ id: 1, run_id: 5, name: 'test', status: 'in_progress', conclusion: null, created_at: iso(0), runner_name: null, labels: [], steps: [{ name: 'the full suite', status: 'in_progress', conclusion: null }], ...over });

const root = mkdtempSync(join(tmpdir(), 'early-wait-'));
after(() => rmSync(root, { recursive: true, force: true }));
const store = new Store(join(root, 'test.db'));
const project = store.createProject('Citadel', null);
function minion() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' } as never);
  store.setTicketDir(t.id, root, `ticket/${t.number}-x`);
  return { id: t.id, number: t.number, branch: `ticket/${t.number}-x` };
}

function setup(why: string | null | (() => Promise<string | null>) = 'the train ahead went red') {
  const now = T0 + 60_000;
  const answers = new Map<string, unknown>();
  const get = async (path: string) => {
    const body = answers.get(path) ?? answers.get(path.replace(/\?.*/, ''));
    return body === undefined ? { status: 404, etag: null, body: { message: 'Not Found' } } : { status: 200, etag: null, body };
  };
  const state = mkdtempSync(join(root, 'state-'));
  mkdirSync(join(state, 'queue'));
  let ci!: CiRuns;
  const waits: Waits = new Waits({
    store,
    deployState: state,
    heavyDir: join(root, 'none'),
    ship: () => null,
    interruptible: () => 0,
    changed: (id) => waits.check(id),
    now: () => now,
    alive: () => true,
    held: () => false,
    ci: (ci = new CiRuns({ changed: (id) => waits.check(id), get: get as never, now: () => now })),
    ciSlug: () => 'o/r',
    earlyWhy: () => (typeof why === 'function' ? why() : why),
  });
  const head = minion(),
    next = minion();
  const queue = (n: string, who: { branch: string }, got: number, phase: string) => {
    const f = join(state, 'queue', n);
    writeFileSync(f, `100 77\n${got}\n${who.branch}\n${phase}\n`);
    utimesSync(f, now / 1000, now / 1000);
  };
  queue('0000000001', head, now / 1000 - 30, 'waiting for CI since 12:01');
  queue('0000000002', next, 0, 'waiting');
  const early = () => writeFileSync(join(state, 'early'), `abc123 ${next.branch} ${now / 1000 - 20} ${head.branch} def456 -\n`);
  const run = (jobs: Job[], status = 'in_progress', conclusion: string | null = null) => {
    answers.set('repos/o/r/actions/workflows/tests.yml/runs', { workflow_runs: [{ id: 5, status, conclusion, created_at: iso(50) }] });
    answers.set('repos/o/r/actions/runs/5/jobs', { jobs });
    answers.set('repos/o/r/actions/runs/5', { id: 5, workflow_id: 3, status });
  };
  return { ci, waits, state, head, next, early, run };
}

test("parseEarly reads land.sh's early file, and earlyDroppedWhy the head ship's log", () => {
  assert.deepEqual(parseEarly('abc ticket/9-x 1700000000 ticket/8-y def 5,6\n'), { top: 'abc', next: 'ticket/9-x', at: 1700000000, head: 'ticket/8-y' });
  assert.equal(parseEarly('junk'), null);
  assert.equal(parseEarly(null), null);
  const log = "land: early next train: dropped the early CI run on ticket/9-x's train (the train ahead went red)\nland: other\n";
  assert.equal(earlyDroppedWhy(log, 'ticket/9-x'), 'the train ahead went red');
  assert.equal(earlyDroppedWhy(log, 'ticket/7-z'), null);
});

test('the next ship reads "Testing early" with its test files while the early run goes', async () => {
  const { ci, waits, next, early, run } = setup();
  early();
  run([job()]);
  await waits.poll();
  assert.equal(waits.wait(next.id)!.early?.state, 'running', 'no run found yet still says it started');
  await ci.tick();
  ci.testCounts('o/r', 5, { done: 12, total: 40, failed: ['test/a.test.ts'] } as never);
  const w = waits.wait(next.id)!;
  assert.equal(w.early?.state, 'running');
  assert.equal(w.early?.brief, 'Testing early · 12/40 files · 1 failed');
  assert.match(w.chip, /early 12\/40/);
  assert.match(w.text, /ahead of it ships/);
});

test('a green early run reads "passed early" and waits for the ship ahead', async () => {
  const { ci, waits, head, next, early, run } = setup();
  early();
  run([job({ status: 'completed', conclusion: 'success', completed_at: iso(80) })], 'completed', 'success');
  await waits.poll();
  await ci.tick();
  const w = waits.wait(next.id)!;
  assert.equal(w.early?.state, 'passed');
  assert.equal(w.early?.brief, `Passed early · waits for #${head.number}`);
  assert.match(w.chip, /passed early/);
});

test('an early run thrown away when the ship ahead failed says so, until the ship leaves the line', async () => {
  const { waits, state, head, next, early } = setup();
  early();
  await waits.poll();
  rmSync(join(state, 'early'));
  await waits.poll();
  assert.equal(waits.wait(next.id)!.early?.state, 'dropped');
  assert.equal(waits.wait(next.id)!.early?.text, `Early test dropped: #${head.number} ahead of it failed`);
  rmSync(join(state, 'queue', '0000000002'));
  await waits.poll();
  assert.equal(waits.wait(next.id), null);
});

test("a reason read off the thread fills the dropped note in, and an older run's late reason never replaces a newer one (#2111)", async () => {
  const reads: ((why: string) => void)[] = [];
  const { waits, state, head, next, early } = setup(() => new Promise<string | null>((done) => reads.push(done)));
  const drop = async () => {
    early();
    await waits.poll();
    rmSync(join(state, 'early'));
    await waits.poll();
  };
  await drop();
  assert.equal(waits.wait(next.id)!.early?.text, `Early test dropped: #${head.number} ahead of it changed`, 'the plain words until the log is read');
  // A second early run for the same ship is dropped too, while the first read is still out; the reads end in reverse.
  await drop();
  assert.equal(reads.length, 2);
  reads[1]('the train ahead went red');
  await new Promise((r) => setImmediate(r));
  assert.equal(waits.wait(next.id)!.early?.text, `Early test dropped: #${head.number} ahead of it failed`);
  reads[0]('its train was built again');
  await new Promise((r) => setImmediate(r));
  assert.equal(waits.wait(next.id)!.early?.text, `Early test dropped: #${head.number} ahead of it failed`);
});

test('with early tests switched off the row shows none of it', async () => {
  const { waits, state, next, early } = setup();
  early();
  writeFileSync(join(state, 'early-off'), '');
  await waits.poll();
  assert.equal(waits.wait(next.id)!.early, undefined);
  rmSync(join(state, 'early-off'));
  await waits.poll();
  assert.equal(waits.wait(next.id)!.early?.state, 'running');
  writeFileSync(join(state, 'early-off'), '');
  rmSync(join(state, 'early'));
  await waits.poll();
  assert.equal(waits.wait(next.id)!.early, undefined, 'off, so a lost run is not "dropped"');
});
