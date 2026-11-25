import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, test } from 'node:test';
import { procsUnder, tempRoot, until } from './helpers.ts';
import { scriptEnv } from './script-env.ts';

// tools/citadel-test (#641): a minion's own test files, run with the leak guard and a time limit, showing only the
// counts and what failed, with the full output in $TMPDIR/citadel-test.log.
const repo = join(import.meta.dirname, '..');
const bin = join(repo, 'tools', 'citadel-test');
// No NODE_TEST_CONTEXT, which makes a node --test inside a test skip its files. Its own TMPDIR: the log lands there, and the leak guard counts a process as leaked when it names a deleted folder in it.
const scratch = tempRoot('citadel-test-');
const tmp = scratch.dir;
after(() => scratch.teardown());

function file(name: string, body: string): string {
  const path = join(tmp, name);
  writeFileSync(path, `import { test, describe } from 'node:test';\nimport assert from 'node:assert/strict';\n${body}\n`);
  return path;
}

const noList = join(tmp, 'none.txt');
writeFileSync(noList, '# no repo-wide files\n');

function run(args: string[], always = noList, extraEnv: Record<string, string | undefined> = {}): Promise<{ code: number | null; out: string; ms: number }> {
  const start = Date.now();
  const child = scratch.spawn(bin, args, { cwd: repo, env: scriptEnv({ TMPDIR: tmp, NODE_TEST_CONTEXT: undefined, CITADEL_TEST_ALWAYS: always, CITADEL_TEST_EXTRA: undefined, CITADEL_TEST_FILES: '0', CITADEL_MEM_ROOM_MB: undefined, ...extraEnv }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (out += b));
  return new Promise((r) => child.on('close', (code) => r({ code, out, ms: Date.now() - start })));
}

test('a passing file gives a line of counts and where the log is', async () => {
  const r = await run([file('pass.test.ts', `test('one', () => {});\ntest('two', () => {});\ntest.skip('later', () => {});`)]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^✔ 2 passed, 0 failed, 1 skipped in [\d.]+ s\nfull output: .*citadel-test\.log\n$/);
  assert.match(readFileSync(join(tmp, 'citadel-test.log'), 'utf8'), /✔ one/, 'the spec output is in the log');
});

test('a failing test shows its file, line, suite path and the expected/actual diff', async () => {
  const f = file('fail.test.ts', `test('fine', () => {});\ndescribe('totals', () => {\n  test('adds up', () => { assert.deepEqual({ sum: 3 }, { sum: 4 }); });\n});`);
  const r = await run([f]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /^✖ 1 passed, 1 failed in/);
  assert.match(r.out, /✖ .*fail\.test\.ts:5 › totals › adds up\n/);
  assert.match(r.out, /\+ {3}sum: 3\n {2}- {3}sum: 4/);
  assert.match(r.out, /at .*fail\.test\.ts:5:\d+/, 'names the line that threw');
  assert.doesNotMatch(r.out, /✖ .*› totals\n/, 'the suite failing because of it is not listed again');
});

test('a file that throws before its tests run shows what it printed', async () => {
  const r = await run([file('crash.test.ts', `throw new Error('no such fixture');`)]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /✖ .*crash\.test\.ts › \(the file itself\)\n[^]*Error: no such fixture/);
});

test('--name keeps only the tests it matches', async () => {
  const r = await run([file('named.test.ts', `test('keep me', () => {});\ntest('not me', () => { throw new Error('ran'); });`), '--name', 'keep']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^✔ 1 passed, 0 failed/);
});

test('a hung test ends at the limit, named, with a line saying so, and what it started stops too', async () => {
  // Outside the run's TMPDIR, whose processes the leak guard kills: this one only the limit's group TERM stops.
  const awayRoot = tempRoot('citadel-test-away-');
  const away = awayRoot.dir;
  after(() => awayRoot.teardown());
  const worker = join(away, 'worker');
  const f = file(
    'hang.test.ts',
    `import { spawn } from 'node:child_process';\ntest('quick', () => {});\n` +
      `test('waits forever', () => {\n` +
      `  spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', ${JSON.stringify(worker)}], { stdio: 'ignore' });\n` +
      // Printed a turn after the test started, so its line reaches the log after the runner has the start.
      `  setTimeout(() => console.log('hung test running'), 0);\n` +
      `  return new Promise(() => setInterval(() => {}, 1000));\n});`,
  );
  const log = join(tmp, 'citadel-test.log');
  rmSync(log, { force: true });
  const r = run([f, '--timeout', '120']);
  // The limit fires once the hung test runs, not on a clock that races the file's start under load (#1198): SIGALRM
  // is what timeout's own timer sends it.
  await until('the hung test to start', () => existsSync(log) && readFileSync(log, 'utf8').includes('hung test running'));
  const [limit] = await until('the time limit', () => [...procsUnder([tmp])].find(([, cmd]) => cmd.startsWith('timeout --foreground')));
  process.kill(limit, 'SIGALRM');
  // The file had not finished, so it runs once more under one more limit, and stops there too.
  const [limit2] = await until('the second limit', () => [...procsUnder([tmp])].find(([pid, cmd]) => pid !== limit && cmd.startsWith('timeout --foreground')));
  process.kill(limit2, 'SIGALRM');
  const { code, out } = await r;
  assert.equal(code, 124, `the runner stopped on the limit's SIGTERM, not the KILL 10 s later: ${out}`);
  assert.match(out, /stopped before the end \(1 passed, 0 failed by then\)\. Still running:\n {2}.*hang\.test\.ts:5 › waits forever\n/);
  assert.match(out, /✖ stopped at the time limit, 120 s/);
  await until('the process the hung test started to stop', () => procsUnder([away]).size === 0, 10_000);
});

test('a process a test leaves running is reported and the run fails', async () => {
  const gone = join(tmp, 'leak');
  mkdirSync(gone);
  const f = file(
    'leak.test.ts',
    `import { spawn } from 'node:child_process';\nimport { rmSync } from 'node:fs';\n` +
      `test('starts and forgets', () => { spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', ${JSON.stringify(join(gone, 'x'))}], { detached: true, stdio: 'ignore' }).unref(); rmSync(${JSON.stringify(gone)}, { recursive: true }); });`,
  );
  const r = await run([f]);
  assert.equal(r.code, 1, r.out);
  // The file's own count (test/leak-file.ts, #1763) fails it and kills the process, before the run's guard would.
  assert.match(r.out, /✖ 1 passed, 1 failed/);
  assert.match(r.out, /leak\.test\.ts left these behind[^]*1 process\(es\) still running:[^]*setTimeout.*leak\/x/);
  await until('the leaked process to be killed', () => procsUnder([gone]).size === 0);
});

test("a folder is refused: the full suite is the land gate's", async () => {
  const r = await run(['test/']);
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /land gate's job/);
});

// #1621: no files is --affected, with the repo-wide guards on top. Against HEAD so the answer doesn't depend on main.
test('no files runs --affected, the same as asking for it', async (t) => {
  const dirty = await new Promise<string>((res) => {
    let o = '';
    const c = spawn('git', ['status', '--porcelain'], { cwd: repo });
    c.stdout.on('data', (b) => (o += b));
    c.on('close', () => res(o));
  });
  if (dirty.trim()) return t.skip('the tree has changes, so --affected would run their tests');
  const bare = await run(['--base', 'HEAD']);
  assert.equal(bare.code, 0, bare.out);
  assert.match(bare.out, /affected: nothing has changed from HEAD/);
  assert.doesNotMatch(bare.out, /name the test files/);
});

// #1621: the guards that read every file are picked by no map, so they ride on every run.
test('the repo-wide list holds the guards that read every file', () => {
  const always = readFileSync(join(repo, 'tools', 'always-tests.txt'), 'utf8').split('\n');
  for (const t of ['sync-calls', 'judges', 'one-until', 'script-env', 'host-signals-guards', 'format-own']) assert.ok(always.includes(`test/${t}.test.ts`), `${t} runs on every citadel-test run`);
});

// #768: the repo-wide tests ride along, so their failures show before the land.
test('the repo-wide list is added, counted, deduplicated, and a failure in it fails the run', async () => {
  const wide = file('wide.test.ts', `test('wide', () => {});\ntest('wide2', () => {});`);
  const mine = file('mine.test.ts', `test('mine', () => {});`);
  const list = join(tmp, 'list.txt');
  writeFileSync(list, `# comment\n\n${relative(repo, wide)}\n`);
  let r = await run([mine], list);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^✔ 3 passed, 0 failed \(\+1 repo-wide files\) in/);
  r = await run([mine, wide], list);
  assert.match(r.out, /^✔ 3 passed, 0 failed \(\+0 repo-wide|^✔ 3 passed, 0 failed in/, 'a file named twice runs once');
  const bad = file('bad.test.ts', `test('broken', () => { throw new Error('repo-wide break'); });`);
  writeFileSync(list, `${relative(repo, bad)}\n`);
  r = await run([mine], list);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /bad\.test\.ts.*broken/);
});

test('--name filters only the file given; the repo-wide files run apart, unfiltered', async () => {
  const wide = file('wide2.test.ts', `test('alpha', () => {});\ntest('beta', () => {});`);
  const mine = file('mine2.test.ts', `test('keep me', () => {});\ntest('not me', () => { throw new Error('ran'); });`);
  const list = join(tmp, 'list2.txt');
  writeFileSync(list, `${relative(repo, wide)}\n`);
  const r = await run([mine, '--name', 'keep'], list);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^✔ 1 passed, 0 failed in[^]*repo-wide tests[^]*✔ 2 passed, 0 failed in/);
});

test('the real list names files that exist', () => {
  for (const l of readFileSync(join(repo, 'tools', 'always-tests.txt'), 'utf8').split('\n')) {
    if (l && !l.startsWith('#')) assert.ok(existsSync(join(repo, l)), l);
  }
});

test('--affected with nothing changed is not a failure: it says so and runs only the repo-wide list', async (t) => {
  const dirty = await new Promise<string>((res) => {
    let o = '';
    const c = spawn('git', ['status', '--porcelain'], { cwd: repo });
    c.stdout.on('data', (b) => (o += b));
    c.on('close', () => res(o));
  });
  if (dirty.trim()) return t.skip('the tree has changes, so --affected would run their tests');
  const r = await run(['--affected', '--base', 'HEAD']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /affected: nothing has changed from HEAD/);
  assert.match(r.out, /affected: nothing to run/);
});

test('workers follow the memory room: a short room says so and runs fewer files at once (#1340)', async () => {
  // Room for one: on 4 CPUs (a pinned heavy job, #1928, or a small runner) two workers is the normal half, not short.
  const f = file('room.test.ts', `test('one', () => {});`);
  const short = await run([f], noList, { CITADEL_MEM_ROOM_MB: '350' });
  assert.equal(short.code, 0, short.out);
  assert.match(short.out, /memory room is short \(350 MB free for heavy work\): running 1 worker\(s\) at a time/);
  const plenty = await run([f], noList, { CITADEL_MEM_ROOM_MB: '100000' });
  assert.doesNotMatch(plenty.out, /memory room is short/);
  const pinned = await run([f], noList, { CITADEL_MEM_ROOM_MB: '350', CITADEL_TEST_CONCURRENCY: '3' });
  assert.doesNotMatch(pinned.out, /memory room is short/, 'an explicit CITADEL_TEST_CONCURRENCY wins');
});

// #1650 (Cara, 2026-11-22: "On a red, says if the file is a known flake or the box is overloaded, and to rerun it alone once"):
// a hint under a red, text only. tools/known-flakes.ts reads a retro log made here; the load and cores are set by env.
const stampOf = (ms: number) => {
  const d = new Date(ms).toISOString();
  return `${d.slice(11, 19)}Z`;
};
function hintRun(failFile: string, retro: string[], load = '0.50', cores = '8') {
  const shared = join(tmp, `shared-${Math.random().toString(36).slice(2)}`);
  const day = new Date().toISOString().slice(0, 10);
  mkdirSync(join(shared, 'retro-log', day), { recursive: true });
  writeFileSync(join(shared, 'retro-log', day, 'land.md'), retro.join('\n') + '\n');
  const loadFile = join(tmp, `loadavg-${Math.random().toString(36).slice(2)}`);
  writeFileSync(loadFile, `${load} 1.00 1.00 1/100 1234\n`);
  return run([failFile], noList, { COORDINATOR_SHARED_DIR: shared, CITADEL_TEST_LOADAVG: loadFile, CITADEL_TEST_CORES: cores, LAND_FLAKE_DB: join(tmp, 'none.db') });
}
const red = () => file(`hint-${Math.random().toString(36).slice(2)}.test.ts`, `test('breaks', () => { assert.equal(1, 2); });`);
const sighting = (f: string, branch: string, ago = 60_000) => `- ${stampOf(Date.now() - ago)} · flake · ${relative(repo, f)} · load 3 · ${branch} · in CI`;

test('a red that is a known flake says so, to rerun it alone once, and keeps the exit code', async () => {
  const f = red();
  const r = await hintRun(f, [sighting(f, 'ticket/7-a', 2 * 86_400_000), sighting(f, 'ticket/8-b', 3 * 86_400_000)]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`${relative(repo, f).replace(/[.]/g, '\\.')}: known flake \\(tools/known-flakes\\.ts: seen on 2 other branches in 14 days\\)\\. Rerun this file alone once; a green rerun is needed before you ignore it`));
  assert.doesNotMatch(r.out, /load was/);
});

test('a red on a loaded box says the load, with or without a known flake', async () => {
  const f = red();
  const r = await hintRun(f, [], '12.40', '8');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /: load was 12.40 on 8 cores when the run started\. Rerun this file alone once; a green rerun is needed/);
  assert.doesNotMatch(r.out, /known flake/);
});

test('a broken test is said broken, never a flake', async () => {
  const f = red();
  const timing = (i: number) => `- ${stampOf(Date.now() - (i + 1) * 60_000)} · timing · ticket/${100 + i}-r · line 0 · rebase 1 · ci-queue 8 · ci-run 107 · fallback - · deploy 7 · live 42 · landed`;
  const r = await hintRun(f, [...Array.from({ length: 10 }, (_, i) => timing(i)), ...[1, 2, 3].map((i) => sighting(f, `ticket/${10 + i}-o`, i * 60_000))]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /: broken, not a flake \(red in 3 of 11 runs in the last 6 h\); don't rerun and ignore it/);
  assert.doesNotMatch(r.out, /known flake/);
});

test('a plain red on a quiet box, and a green run, get no hint', async () => {
  const f = red();
  const r = await hintRun(f, []);
  assert.equal(r.code, 1, r.out);
  assert.doesNotMatch(r.out, /Before chasing|known flake|load was/);
  const g = await run([file('hint-green.test.ts', `test('ok', () => {});`)], noList, { CITADEL_TEST_LOADAVG: join(tmp, 'none.txt'), CITADEL_TEST_CORES: '1' });
  assert.equal(g.code, 0, g.out);
  assert.doesNotMatch(g.out, /Before chasing/);
});

// #1928: citadel-test's own wiring of the shared limit: its files wait for a place held elsewhere, the run says so, and starts anyway.
test('a run waits for a held place, starts anyway after the wait, and says so in one line', async () => {
  const heavyDir = join(tmp, 'gate-heavy');
  mkdirSync(heavyDir, { recursive: true });
  const holder = spawn('flock', [join(heavyDir, 'test-slot-0'), 'sleep', '600'], { stdio: 'ignore', detached: true });
  try {
    await until('the place held', () => existsSync(join(heavyDir, 'test-slot-0')));
    const r = await run([file('gated.test.ts', `test('ran', () => {});`)], noList, {
      CITADEL_TEST_FILES: '1',
      CITADEL_TEST_FILES_MIN: '1',
      CITADEL_TEST_FILES_MAX: '1',
      CITADEL_TEST_ROOM_WAIT: '2',
      CITADEL_HEAVY_DIR: heavyDir,
      CITADEL_HEAVY_PRESSURE: join(tmp, 'no-psi'),
      RUNNER_TEMP: undefined,
      GITHUB_ACTIONS: undefined,
      CITADEL_HEAVY_HELD: undefined,
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^citadel-test: waiting for room: 1 test files may run at once on this box and other files hold them; this run waits at most 2 s in all$/m);
    assert.equal(r.out.match(/waiting for room/g)?.length, 1);
    assert.ok(r.out.indexOf('waiting for room') < r.out.indexOf('1 passed'), 'said while it waits, not after the counts');
  } finally {
    process.kill(-holder.pid!, 'SIGTERM'); // the group: flock's sleep too
  }
});

test('citadel-test killed outright leaves no watcher holding its output open', async () => {
  const heavyDir = join(tmp, 'gate-killed');
  const up = join(tmp, 'killed-up');
  const f = file('killed.test.ts', `import { writeFileSync } from 'node:fs';\ntest('long', async () => { writeFileSync(${JSON.stringify(up)}, ''); await new Promise((r) => setTimeout(r, 600_000)); });`); // timing-ok: the run is killed
  const env = scriptEnv({ TMPDIR: tmp, NODE_TEST_CONTEXT: undefined, CITADEL_TEST_ALWAYS: noList, CITADEL_HEAVY_DIR: heavyDir, CITADEL_TEST_FILES: '4', RUNNER_TEMP: undefined, GITHUB_ACTIONS: undefined, CITADEL_HEAVY_HELD: undefined });
  const child = scratch.spawn(bin, [f], { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await until('the test running', () => existsSync(up));
  // The watcher is citadel-test's own child and runs the same script.
  const kids = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8').trim().split(' ');
  const watcher = kids.find((k) => readFileSync(`/proc/${k}/cmdline`, 'utf8').includes('tools/citadel-test'));
  assert.ok(watcher, 'the watcher is up');
  child.kill('SIGKILL');
  try {
    await until('the watcher gone', () => !existsSync(`/proc/${watcher}`));
  } finally {
    for (const k of kids) {
      try {
        process.kill(-Number(k), 'SIGKILL'); // the runner's own group, which a SIGKILL of citadel-test leaves (as on main)
      } catch {}
    }
  }
});

// #1925: the limit grows with the files it runs, and a run that hits it reruns only the files it hadn't finished.
const knobs = { CITADEL_TEST_LIMIT_BASE: '20', CITADEL_TEST_LIMIT_FREE: '2', CITADEL_TEST_LIMIT_PER_FILE: '5', CITADEL_TEST_LIMIT_CAP: '40' };
const quick = (n: string) => file(`lim-${n}.test.ts`, `test('ok', () => {});`);

test('the time limit is the base up to the free files, then grows a step per file, up to the cap', async () => {
  const two = await run([quick('a'), quick('b')], noList, knobs);
  assert.doesNotMatch(two.out, /time limit:/, 'the base limit is not worth a line');
  const five = await run([quick('a'), quick('b'), quick('c'), quick('d'), quick('e')], noList, knobs);
  assert.match(five.out, /time limit: 35 s for 5 files/);
  const nine = await run(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(quick), noList, knobs);
  assert.match(nine.out, /time limit: 40 s for 9 files/);
  assert.equal(nine.code, 0, nine.out);
});

test('--timeout wins, and the repo-wide files count toward the size', async () => {
  const list = join(tmp, 'one.txt');
  writeFileSync(list, `${relative(repo, quick('w'))}\n`);
  const fixed = await run([quick('a'), quick('b'), quick('c'), '--timeout', '77'], list, knobs);
  assert.doesNotMatch(fixed.out, /time limit:/);
  const counted = await run([quick('a'), quick('b'), quick('c')], list, knobs);
  assert.match(counted.out, /time limit: 30 s for 4 files/);
});

test('the base limit is 300 s without knobs, and a stop names the one it used', async () => {
  const quiet = await run([quick('a')]);
  assert.doesNotMatch(quiet.out, /time limit:/);
  const r = await run([hangs('stop-base', true)], noList, { CITADEL_TEST_LIMIT_BASE: '2' });
  assert.equal(r.code, 124, r.out);
  assert.match(r.out, /stopped at the time limit, 2 s/);
});

/** A file that hangs on the first run (it leaves a marker) and passes on the next, or hangs every time. */
function hangs(name: string, always = false): string {
  const marker = join(tmp, `${name}.marker`);
  rmSync(marker, { force: true });
  return file(`${name}.test.ts`, `import { existsSync, writeFileSync } from 'node:fs';\ntest('maybe hangs', () => {\n  if (${always ? 'false' : `existsSync(${JSON.stringify(marker)})`}) return;\n  writeFileSync(${JSON.stringify(marker)}, '');\n  return new Promise(() => setInterval(() => {}, 1000));\n});`);
}

test('a run stopped at the limit reruns only the files it had not finished, and passes when they do', async () => {
  const done = quick('stop-done');
  const slow = hangs('stop-slow');
  const r = await run([done, slow, '--timeout', '3'], noList);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /stopped at the time limit, 3 s/);
  assert.match(r.out, /1 of 2 files finished; rerunning only: .*stop-slow\.test\.ts/);
  assert.doesNotMatch(r.out, /rerunning only: .*stop-done/);
  assert.match(r.out, /✔ 1 passed, 0 failed/);
});

test('a failure in a file that finished before the stop keeps the run red across both parts', async () => {
  const bad = file('stop-bad.test.ts', `test('fails', () => { assert.equal(1, 2); });`);
  const slow = hangs('stop-slow2');
  const r = await run([bad, slow, '--timeout', '3'], noList, { CITADEL_TEST_LOADAVG: join(tmp, 'none.txt') });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /stop-bad\.test\.ts[^\n]*fails/);
  assert.match(r.out, /rerunning only: .*stop-slow2/);
  assert.match(r.out, /both parts: ✖ 1 passed, 1 failed/);
});

test('a file that hits the limit twice is reported unfinished and the run exits 124', async () => {
  const slow = hangs('stop-never', true);
  const r = await run([quick('stop-ok'), slow, '--timeout', '3'], noList);
  assert.equal(r.code, 124, r.out);
  assert.match(r.out, /not finished after two limits: .*stop-never\.test\.ts/);
  assert.doesNotMatch(r.out, /Before chasing/);
});

test('the --name pass for the repo-wide files follows the same rule', async () => {
  const list = join(tmp, 'wide.txt');
  const slow = hangs('stop-wide');
  writeFileSync(list, `${relative(repo, slow)}\n`);
  const r = await run([quick('stop-named'), '--name', 'ok', '--timeout', '3'], list);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /rerunning only: .*stop-wide/);
});

test('a file that finished before the stop and failed outside its tests is not forgotten', async () => {
  const exit = file('stop-exit.test.ts', `test('ok', () => {});\nprocess.exitCode = 1;`);
  const hook = file('stop-hook.test.ts', `import { after } from 'node:test';\ntest('ok', () => {});\nafter(() => { throw new Error('after hook'); });`);
  for (const bad of [exit, hook]) {
    const r = await run([bad, hangs(`stop-slow-${relative(tmp, bad)}`), '--timeout', '3'], noList, { CITADEL_TEST_LOADAVG: join(tmp, 'none.txt') });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /1 of 2 files finished/);
  }
});
