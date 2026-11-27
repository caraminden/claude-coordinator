// Shared setup of land.test.ts and its parts (#2208): the file is split so no one test file sets the suite's length.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { land, env, git, setup, ci, quietProc, stopShip } from './land-fixture.ts';
import { until } from './wait.ts';
import { copyLand } from './land-files.ts';

export const repo = join(import.meta.dirname, '..');

// #565: one line per landing with how long each phase took, landed or refused.
export const timings = (shared: string) =>
  landLog(shared)
    .split('\n')
    .filter((l) => l.includes(' · timing · '));

// #1894: stopping a ship ends the run it pushed, whose id it may not have read yet. `when` says when to stop it; then
// with `listed`, GitHub
// lists the run from after its clean-up's first look for it on (else never).
export async function stopped(extra: Record<string, string> | ((r: ReturnType<typeof setup>) => Record<string, string>), when: (c: ReturnType<typeof ci>, r: ReturnType<typeof setup>) => boolean, listed = false) {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const seen = join(r.dir, 'listed');
  const child = spawn('bash', [land], {
    cwd: r.wt,
    env: {
      ...env,
      DEPLOY_LIVE: r.live,
      DEPLOY_SOURCE: r.source,
      DEPLOY_NOTE: join(r.dir, 'note'),
      PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`,
      LAND_CI: '1',
      LAND_CI_POLL: '2', // long beside a stop, so the gate's own polls don't read the run's id
      FAKE_CI: 'running',
      FAKE_UNLISTED: `b.txt ${seen}`,
      ...(typeof extra === 'function' ? extra(r) : extra),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr!.on('data', (d) => (stderr += d));
  let ended = false;
  child.once('close', () => (ended = true));
  await until(
    'the moment to stop it',
    () => when(c, r),
    30_000,
    () => stderr,
  );
  const lines = () => c.calls().split('\n').filter(Boolean);
  const before = lines().length;
  stopShip(child.pid!);
  if (listed) {
    await until('its first look for the run', () => ended || lines().length > before);
    writeFileSync(seen, '');
  }
  await until(
    'land.sh to end',
    () => ended,
    undefined,
    () => stderr,
  );
  return { r, calls: lines(), after: lines().slice(before) };
}

export const cancels = (calls: string[]) => calls.filter((x) => x.includes('-X POST') && x.endsWith('/cancel')).map((x) => /runs\/(\d+)\/cancel/.exec(x)?.[1]);

export const hubHas = (r: ReturnType<typeof setup>, ref: string) => git(join(r.dir, 'hub.git'), 'for-each-ref', `refs/heads/${ref}`) !== '';

export const waits = (c: ReturnType<typeof ci>, r: ReturnType<typeof setup>) => hubHas(r, 'land/ticket/1-x') && c.calls().split('head_sha=').length > 2;

// #1254 (Josh, 2026-11-20: "only if and when perigee has plenty of resources, just make sure we play nice"): the suite runs
// here only while perigee is quiet; until then the ship keeps waiting for CI, and a long busy spell refuses it.
export const procAt = (r: ReturnType<typeof setup>, o?: Parameters<typeof quietProc>[1]) => {
  const proc = quietProc(join(r.dir, 'proc'), o);
  return { LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(r.dir, 'heavy') };
};

// Each flips its world (CI answers, a runner comes back, perigee goes quiet) only once land.sh has said perigee is busy.
export const once = (act: () => void) => {
  let done = false;
  return (s: string) => {
    if (!done && /perigee is busy/.test(s)) {
      done = true;
      act();
    }
  };
};

// The reruns alone get a window of their own (#1374): on Nov 20 a busy desktop's full run ended at the old limit, so its
// flakes were never rerun and counted as a real red. At its CI limit land.sh looks at the run's steps once.
export const RERUNNING = 'the full suite\tcompleted\tfailure\nrerun failed files alone\tin_progress\t-\n';

export async function windowed(steps: string) {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const gate = join(r.dir, 'ci-gate');
  const told = (s: string) => /rerunning the failed files alone/.test(s) && !existsSync(gate) && writeFileSync(gate, '');
  // Quiet perigee: without the window it would fall back at the limit and run the suite here.
  const res = await c.runAsync({ FAKE_CI: 'red', FAKE_LOG: 'flakes', FAKE_CI_RERUN: 'green', FAKE_CI_GATE: gate, FAKE_STEPS: steps, LAND_CI_TIMEOUT: '1', LAND_CI_RERUN: '60', ...procAt(r) }, told);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI's full run ended red and it is rerunning the failed files alone to tell flakes from real failures, so this waits up to 1 min 0 s more for them instead of falling back at 1s/);
  assert.match(res.stderr, /running CI once more/);
  assert.match(res.stderr, /CI passed/);
  assert.doesNotMatch(res.stderr, /CI FALLBACK/);
  assert.equal(c.localRuns(), 0);
}

// #1360 (Cara, 2026-11-20, "Refused ships keep their place"): a refusal by the pipeline, not the ship's change, keeps its
// ticket and goes again once; alone in line it goes again at once (no ship to let by: land-train-riders.test.ts has the line).
export const retries = (shared: string) =>
  landLog(shared)
    .split('\n')
    .filter((l) => l.includes(' · retry in place · '));

// A test file that fails on the runs FLAKY_FAIL names (1,3: the 1st and 3rd), counted in FLAKY_COUNT.
export const flaky =
  "import { readFileSync, writeFileSync } from 'node:fs';\nconst f = process.env.FLAKY_COUNT;\nif (f) {\n  let n = 0;\n  try { n = Number(readFileSync(f, 'utf8')); } catch {}\n  writeFileSync(f, String(++n));\n  if ((process.env.FLAKY_FAIL ?? '').split(',').includes(String(n))) throw new Error('flaky');\n}\n";

// #1393: the suite here killed from outside before any test failed is the pipeline's, not the change's: it keeps its
// place and goes again once, as a red of flakes only does.
export const killer =
  "import { readFileSync, writeFileSync } from 'node:fs';\nconst f = process.env.KILL_COUNT;\nif (f) {\n  let n = 0;\n  try { n = Number(readFileSync(f, 'utf8')); } catch {}\n  writeFileSync(f, String(++n));\n  if ((process.env.KILL_ON ?? '').split(',').includes(String(n))) { process.kill(process.ppid, 'SIGKILL'); await new Promise(() => {}); }\n}\n";

// Ultra review of the ship scripts, 2026-11-23 (#1693): the copy of land.sh a rebase hands over to (#500), or that
// starts over after main moved under the restart ahead, is the same hand-off. It counts its gh calls as the first copy
// does, and keeps the hand-off's one retry in place and its flake keeps rather than starting them over.
// newerLandOnMain: the worktree runs its own tools/land.sh, as a minion does, and main has a newer one its rebase brings in.
export function newerLandOnMain(r: ReturnType<typeof setup>) {
  for (const f of readdirSync(join(repo, 'tools'), { withFileTypes: true })) if (f.isFile() && f.name !== 'deploy.sh') copyFileSync(join(repo, 'tools', f.name), join(r.source, 'tools', f.name));
  copyLand(join(r.source, 'tools'));
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'real tools');
  git(r.wt, 'rebase', '-q', 'main');
  const script = join(r.source, 'tools', 'land.sh');
  writeFileSync(script, readFileSync(script, 'utf8') + '# newer\n');
  git(r.source, 'commit', '-qam', 'newer land.sh');
  return (extra: Record<string, string>) =>
    spawnSync('bash', [join(r.wt, 'tools', 'land.sh')], {
      cwd: r.wt,
      encoding: 'utf8',
      timeout: 90_000,
      env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note'), PATH: `${join(r.dir, 'bin')}:${process.env.PATH}`, LAND_CI: '1', LAND_CI_POLL: '0.1', TEST_RUNS: join(r.dir, 'test-runs'), ...extra },
    });
}

// The one day's folder, whichever UTC day the run fell on.
export const landLog = (shared: string) => readFileSync(join(shared, 'retro-log', readdirSync(join(shared, 'retro-log'))[0], 'land.md'), 'utf8');

// The smoke check (#1012): before the line, so its refusals never wait in it. Its tests run through the branch's own
// tools/citadel-test, a stand-in here that notes each run's arguments on a line ("alone" for a failed file's rerun
// without the always-tests) and answers as told.
// #1240: the guard tests run on the rebased commit, before a CI run is spent. A stand-in citadel-test fails when
// GUARD_EXIT is set, and logs what it was asked to run.
export function guardSetup() {
  const r = setup();
  const c = ci(r);
  writeFileSync(
    join(r.source, 'tools', 'citadel-test'),
    `#!/usr/bin/env bash
echo "\${CITADEL_TEST_ALWAYS:-} $*" >>"$GUARD_ARGS"
[ -z "\${GUARD_EXIT:-}" ] || { echo "✖ test/schema-compat.test.ts:40 › each schema number is used once"; echo "  SCHEMA_HISTORY 212 is taken twice"; echo "full output: /somewhere/citadel-test.log"; exit "$GUARD_EXIT"; }
`,
  );
  chmodSync(join(r.source, 'tools', 'citadel-test'), 0o755);
  // Built, not quoted: a quoted test file's name reads as a dependency to test/pipeline-files.test.ts.
  for (const g of ['schema-compat', 'ui-contract']) writeFileSync(join(r.source, 'test', `${g}.test.ts`), '');
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'guard tools');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const args = join(r.dir, 'guard-args');
  const shared = join(r.dir, 'shared');
  const run = (extra: Record<string, string> = {}) => c.run({ GUARD_ARGS: args, COORDINATOR_SHARED_DIR: shared, LAND_SMOKE: '0', FAKE_CI: 'green', ...extra });
  const ran = () => (existsSync(args) ? readFileSync(args, 'utf8').trim() : '');
  return { ...r, c, run, ran, shared };
}

export function smokeSetup() {
  const r = setup();
  writeFileSync(join(r.source, 'tools', 'always-tests.txt'), '# repo-wide\n\ntest/always.test.ts\n');
  writeFileSync(
    join(r.source, 'tools', 'citadel-test'),
    `#!/usr/bin/env bash
echo "\${CITADEL_TEST_ALWAYS:+alone }$*" >>"$SMOKE_ARGS"
sleep "\${SMOKE_SLEEP:-0}"
code=\${SMOKE_EXIT:-}; [ -z "\${CITADEL_TEST_ALWAYS:-}" ] || code=\${SMOKE_ALONE_EXIT-$code}
[ -z "$code" ] || [ "$code" = 0 ] || { echo "✖ test/always.test.ts:3 › a snapshot"; echo "full output: /somewhere/citadel-test.log"; exit "$code"; }
`,
  );
  chmodSync(join(r.source, 'tools', 'citadel-test'), 0o755);
  writeFileSync(join(r.source, 'test', 'always.test.ts'), '');
  writeFileSync(join(r.source, 'test', 'gone.test.ts'), '');
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'smoke tools');
  git(r.wt, 'rebase', '-q', 'main');
  writeFileSync(join(r.wt, 'test', 'mine.test.ts'), '');
  git(r.wt, 'rm', '-q', 'test/gone.test.ts');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const args = join(r.dir, 'smoke-args');
  const shared = join(r.dir, 'shared');
  const smoke = (extra: Record<string, string> = {}) => r.run({ SMOKE_ARGS: args, COORDINATOR_SHARED_DIR: shared, ...extra });
  const ran = () => (existsSync(args) ? readFileSync(args, 'utf8').trim().split('\n') : []);
  return { ...r, smoke, ran, shared };
}

// #1361 (Cara 2026-11-20, "Wait for a busy desktop"): while a runner is online, a ship waits LAND_CI_START_ONLINE for
// it to start the job, not LAND_CI_START; only no runner online (or GitHub erring) writes ci-down. Here 1 s stands for
// the 90 s, and a job that starts a few seconds in stands for one that starts 5 min in, after another ship's run.
export const startsLater = (file: string, ms = 2500) => {
  let done = false;
  return (s: string) => {
    if (done || !/runner is online but hasn't started the job/.test(s)) return;
    done = true;
    setTimeout(() => {
      writeFileSync(file, 'running');
      setTimeout(() => writeFileSync(file, 'green'), 500);
    }, ms);
  };
};

export const ciDown = (r: ReturnType<typeof setup>) => join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'ci-down');
