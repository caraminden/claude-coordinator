// Trap tests for #2135's ultra review check timer and kit sync round: no blocking disk call or process start on the
// server's one thread.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import childProcess from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { HostJobs } from '../src/host-job.ts';
import { KIT_FILES, KitSync, type KitSyncDeps, type KitSyncState } from '../src/kit-sync.ts';
import { UltraReviews, type ReviewResult } from '../src/ultrareview.ts';
import { until } from './wait.ts';
import { syncCallsUnder } from './sync-trap.ts';
import { fake } from './typed.ts';

const root = mkdtempSync(join(tmpdir(), 'off-thread-review-kit-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

const git = (cwd: string, ...args: string[]) => childProcess.execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
function commit(dir: string, files: Record<string, string>, msg: string) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}
function newRepo(dir: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}
function script(dir: string, name: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}`);
  chmodSync(join(dir, name), 0o755);
  return join(dir, name);
}

function reviews(base: string, bin: string, extra: Partial<ConstructorParameters<typeof UltraReviews>[0]> = {}) {
  const events: { kind: string; data: Partial<ReviewResult> }[] = [];
  const settings = new Map<string, unknown>();
  const scratch = join(base, 'scratch');
  const jobsDir = join(base, 'jobs');
  const shared = join(base, 'shared');
  for (const d of [scratch, jobsDir, shared]) mkdirSync(d, { recursive: true });
  const ur = new UltraReviews({
    claudeBin: bin,
    place: () => ({ host: true }),
    scratch: () => scratch,
    hostEnv: { PATH: process.env.PATH! },
    jobsDir,
    emit: (_t, kind, data) => events.push({ kind, data: data as Partial<ReviewResult> }),
    getSetting: <T>(k: string) => settings.get(k) as T | undefined,
    setSetting: (k, v) => settings.set(k, v),
    github: () => null,
    ...extra,
  });
  const result = () => until('the result', () => events.find((e) => e.kind === 'ultrareview_result')?.data as ReviewResult | undefined);
  return { ur, events, settings, scratch, jobsDir, shared, result };
}

test("an ultra review's 2 s check reads its job's end, posts the findings and tidies up with no synchronous file call or process start (#2135)", async () => {
  const base = mkdtempSync(join(root, 'ur-check-'));
  const { ur, settings, scratch, jobsDir, shared, result } = reviews(base, '/bin/false');
  // A review whose CLI ended with findings while the server restarted: recover follows it, and the check timer finishes it.
  const dir = join(scratch, 'ultrareview-done1');
  mkdirSync(dir);
  mkdirSync(join(jobsDir, 'done1'));
  writeFileSync(join(jobsDir, 'done1', 'code'), '0');
  writeFileSync(join(jobsDir, 'done1', 'output.log'), '1 bug found: src/a.ts:2 off by one\n');
  settings.set('ultrareview_running', [{ ticketId: 7, uid: 1, id: 'done1', dir, job: true, findings: { dir: shared, ev: { mode: 'branch', base: 'main', branch: 'ticket/9-thing' } } }]);
  let r: ReviewResult | undefined;
  const calls = await syncCallsUnder(base, async () => {
    await ur.recover();
    r = await result();
  });
  assert.deepEqual(calls, []);
  assert.equal(r!.ok, true);
  assert.match(readFileSync(r!.file!, 'utf8'), /off by one/, 'the findings are written to the shared folder');
  assert.ok(!existsSync(dir) && !existsSync(join(jobsDir, 'done1')), 'its clone and job folder are gone');
  assert.deepEqual(settings.get('ultrareview_running'), []);
});

test('an ultra review the CLI refuses as too large goes up as a draft PR, is reviewed and cleaned up with no synchronous file call or process start (#2135)', async () => {
  const base = mkdtempSync(join(root, 'ur-pr-'));
  const bins = join(root, 'ur-pr-bins');
  const ghLog = join(bins, 'gh.log');
  const claude = script(bins, 'claude', `case "$2" in\n  [0-9]*) echo "2 bugs found in PR $2";;\n  *) echo 'Repo is too large. Push a PR.' >&2; exit 1;;\nesac\n`);
  const gh = script(bins, 'gh', `echo "$*" >> '${ghLog}'\n[ "$1 $2" = "pr create" ] && echo "https://github.com/o/r/pull/42"\nexit 0\n`);
  const repo = newRepo(join(root, 'ur-pr-repo'));
  commit(repo, { 'src/a.ts': 'a\n', 'lib/x.ts': 'x\n', 'README.md': 'r\n' }, 'main');
  git(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  const bare = join(root, 'ur-pr-bare.git');
  git(root, 'init', '-q', '--bare', bare);
  // The jobs' own folder is HostJobs' (src/host-job.ts), outside this trap: the scratch clones and findings are watched.
  const { ur, result } = reviews(base, claude, { github: () => ({ token: 'tok', login: 'cara' }), gh, remoteUrl: () => bare });
  // base/s* is scratch/ and shared/, not jobs/.
  const watched = join(base, 's');
  let r: ReviewResult | undefined;
  const calls = await syncCallsUnder(watched, async () => {
    await ur.start(7, 1, 'Cara', { mode: 'area', repo, base: 'main', paths: ['src/a.ts'] }, { files: 1, lines: 1 }, join(base, 'shared'));
    r = await result();
    await until('the clean-up', () => existsSync(ghLog) && readFileSync(ghLog, 'utf8').includes('-base') && readFileSync(ghLog, 'utf8').includes('DELETE'));
    await until('no scratch left', async () => !(await readdir(join(base, 'scratch'))).length);
  });
  assert.deepEqual(calls, []);
  assert.equal(r!.ok, true, r!.text);
  assert.equal(r!.text, '2 bugs found in PR 42');
  assert.deepEqual(r!.pr, { number: 42, url: 'https://github.com/o/r/pull/42' });
  assert.match(readFileSync(ghLog, 'utf8'), /pr close 42 --repo o\/r/);
});

const LAND = KIT_FILES[0];
function kitFixture(name: string) {
  const base = mkdtempSync(join(root, name));
  const kit = newRepo(join(base, 'kit'));
  const v1 = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n';
  commit(kit, { [LAND.template]: v1 }, 'v1');
  const projectsDir = join(base, 'projects');
  const scheme = newRepo(join(projectsDir, '3', 'repo'));
  commit(scheme, { [LAND.path]: v1.replace('line 20', 'line 20 scheme edit') }, 'setup');
  const v2 = v1.replace('line 5', 'line 5 kit fix');
  commit(kit, { [LAND.template]: v2 }, 'v2');
  return { base, kit, projectsDir, scheme, v2 };
}
function kitDeps(f: { base: string; kit: string; projectsDir: string }, jobs: KitSyncDeps['jobs'], box: { saved?: KitSyncState; cards: number }): KitSyncDeps {
  return {
    kitDir: f.kit,
    projectsDir: f.projectsDir,
    runDir: join(f.base, 'run'),
    jobs,
    load: () => box.saved && JSON.parse(JSON.stringify(box.saved)),
    save: (s) => (box.saved = JSON.parse(JSON.stringify(s))),
    projects: () => [{ id: 3, name: 'One' }],
    home: () => 2,
    chat: async (p) => 100 + p,
    env: () => ({ PATH: process.env.PATH! }),
    canPush: async () => true,
    postCard: () => `q${++box.cards}`,
    settle: () => {},
    note: () => {},
    mail: () => {},
  };
}

test("a kit sync round merges, branches and commits a scheme's sync with no synchronous file call or process start (#2135)", async () => {
  const f = kitFixture('kit-round-');
  const started: string[] = [];
  const box: { saved?: KitSyncState; cards: number } = { cards: 0 };
  const jobs = fake<KitSyncDeps['jobs']>({ start: (o) => void started.push(o.cwd), look: async () => null });
  const ks = new KitSync(kitDeps(f, jobs, box));
  // Watched: the whole temp folder, so the merge's scratch files count too.
  const calls = await syncCallsUnder(tmpdir(), () => ks.poll());
  assert.deepEqual(calls, []);
  assert.equal(box.saved?.round?.schemes[0].state, 'checking');
  const wt = join(f.projectsDir, '3', 'kit-sync');
  assert.deepEqual(started, [wt], 'its check started in the sync worktree');
  const merged = readFileSync(join(wt, LAND.path), 'utf8');
  assert.ok(merged.includes('line 5 kit fix') && merged.includes('line 20 scheme edit'), 'the kit change came in and the scheme edit stayed');
  assert.equal(git(wt, 'rev-parse', 'HEAD'), box.saved?.round?.schemes[0].commit);
  assert.match(git(wt, 'log', '-1', '--format=%B'), /Kit-Sync: [0-9a-f]{40}/);
});

test("a kit sync round's check end is read and its card posted with no synchronous file call or process start (#2135)", async () => {
  const f = kitFixture('kit-advance-');
  const box: { saved?: KitSyncState; cards: number } = { cards: 0 };
  const real = new HostJobs(() => false);
  // The check is recorded as started; its end is what the 20 s round step reads.
  const jobs = fake<KitSyncDeps['jobs']>({ start: () => {}, look: real.look.bind(real) });
  const ks = new KitSync(kitDeps(f, jobs, box));
  await ks.poll();
  assert.equal(box.saved?.round?.schemes[0].state, 'checking');
  const job = join(f.base, 'run', '3-check');
  mkdirSync(job, { recursive: true });
  writeFileSync(join(job, 'output.log'), 'all good\n');
  writeFileSync(join(job, 'code'), '0');
  const calls = await syncCallsUnder(f.base, () => ks.poll());
  assert.deepEqual(calls, []);
  assert.equal(box.saved?.round?.schemes[0].state, 'green');
  assert.equal(box.cards, 1, 'the card is posted');
});
