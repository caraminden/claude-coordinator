import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ESCALATE_MS, FastMode, QUICK_WAIT_MS, type FastState } from '../src/fast-mode.ts';

// src/fast-mode.ts's quick scheme (#2244, quick train piece 4): the full run behind each quick train, from land.sh's
// quick-behind lines (tools/land/behind.sh). A red's files run alone on the quick train's base and each ship's top, oldest
// first: the first ship failing one is its culprit, a red on the base is main's own (the Taskmaster's), and a file that passes
// alone everywhere blames nobody. Runs are faked (the HostJobs a test answers); git is a real repo.
const root = mkdtempSync(join(tmpdir(), 'fast-quick-'));
after(() => rmSync(root, { recursive: true, force: true }));
const CITADEL = 2;
let repos = 0;

function world() {
  const repo = join(root, `r${++repos}`);
  const state = join(root, `s${repos}`);
  mkdirSync(state);
  const g = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  g('config', 'user.email', 't@t'), g('config', 'user.name', 't');
  const commit = (subject: string) => {
    writeFileSync(join(repo, 'f.txt'), subject);
    g('add', '.'), g('commit', '-q', '-m', subject);
    return g('rev-parse', 'HEAD');
  };
  const kv = new Map<string, FastState>();
  const runs: { sha: string; env: Record<string, string> }[] = [];
  let answer: { output: string; code: number | null } | null = null;
  const told: { ticket: number; text: string }[] = [];
  const tm: string[] = [];
  const greens: string[] = [];
  let clock = 1_000_000_000;
  const fm = new FastMode({
    schemes: () => [{ id: CITADEL, repo, quick: state }],
    get: (k) => kv.get(k),
    set: (k, v) => kv.set(k, structuredClone(v)),
    jobs: {
      start: (j) => {
        runs.push({ sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: j.cwd, encoding: 'utf8' }).trim(), env: j.env });
        answer = { output: '', code: null };
      },
      look: async () => answer,
    },
    dir: (p) => join(repo + '-run', String(p)),
    env: (_p, t) => ({ WHO: String(t) }),
    ticketOf: (_p, n) => n + 1000,
    numberOf: (t) => t - 1000,
    tell: (ticket, text) => told.push({ ticket, text }),
    taskmaster: (_p, text) => tm.push(text),
    green: (_p, sha) => greens.push(sha),
    now: () => clock,
  });
  const finish = async (output: string, code = output.includes('verify: green') ? 0 : 1) => {
    answer = { output, code };
    await fm.tick();
  };
  /** A quick train of ships #11, #12, #13 on a full train's top, shipped now: its quick-behind line. */
  const quickTrain = (extra = '') => {
    const base = commit('full train top');
    const tops = [11, 12, 13].map((n) => commit(`#${n} a quick ship`));
    writeFileSync(join(state, 'quick-behind'), `${Math.floor(clock / 1000)} ${base} ${tops[2]} ${tops.map((t, i) => `${t}:${11 + i}`).join(' ')}${extra}\n`);
    return { base, tops };
  };
  return { repo, state, commit, fm, runs, finish, told, tm, greens, kv, quickTrain, tick: () => fm.tick(), wait: (ms: number) => (clock += ms) };
}
const red = (...ids: string[]) => `${ids.map((id) => `verify: failing ${id}`).join('\n')}\nverify: red\n`;
const GREEN = 'verify: green\n';

test('off: with no quick-behind line, nothing runs and nothing is written, ships or not', async () => {
  const w = world();
  w.commit('one');
  await w.tick();
  await w.fm.landed(CITADEL, 1005, w.commit('two'));
  await w.tick();
  assert.equal(w.runs.length, 0);
  assert.equal(w.kv.size, 0, 'no state written');
  assert.equal(w.fm.quick(CITADEL), true);
});

test('one run on the quick top, on its base for the burn-in; green is last green and is never run again', async () => {
  const w = world();
  const { base, tops } = w.quickTrain();
  await w.tick();
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0].sha, tops[2]);
  assert.equal(w.runs[0].env.LAND_VERIFY_BASE, base);
  assert.equal(w.runs[0].env.LAND_VERIFY_IDS, '');
  assert.equal(w.runs[0].env.WHO, '1013', "the run's env is the top ship's minion's");
  await w.finish(GREEN);
  assert.deepEqual(w.greens, [tops[2]]);
  w.commit('a full ship after');
  await w.tick();
  assert.equal(w.runs.length, 1, 'that quick top has its verdict');
});

test('a real culprit: the file runs alone on the base and each ship oldest first, and the first red ship is told; its fix clears it; else the Taskmaster after 30 minutes', async () => {
  const w = world();
  const { base, tops } = w.quickTrain();
  await w.tick();
  await w.finish(red('test/a.test.ts'));
  assert.equal(w.told.length, 0, 'not blamed before it is pinned');
  assert.equal(w.runs[1].sha, base);
  assert.equal(w.runs[1].env.LAND_VERIFY_IDS, 'test/a.test.ts');
  await w.finish(GREEN);
  assert.equal(w.runs[2].sha, tops[0]);
  await w.finish(GREEN);
  assert.equal(w.runs[3].sha, tops[1]);
  assert.equal(w.runs[3].env.WHO, '1012');
  await w.finish(red('test/a.test.ts'));
  assert.equal(w.told.length, 1);
  assert.equal(w.told[0].ticket, 1012, "#12's minion, the first ship it fails on");
  assert.match(w.told[0].text, /behind a quick train/);
  assert.match(w.told[0].text, /test\/a\.test\.ts/);
  assert.match(w.told[0].text, /Your fix goes first/);
  assert.equal(w.runs.length, 4, 'pinned: no run on the ships after it');
  assert.deepEqual(
    w.fm.view(CITADEL).reds.map((r) => [r.ids, r.n]),
    [[['test/a.test.ts'], 12]],
  );
  // Its fix goes first: urgent-fixes reads these for the quick scheme too (test/urgent.test.ts).
  w.wait(ESCALATE_MS - 1);
  await w.tick();
  assert.equal(w.tm.length, 0);
  w.wait(2);
  await w.tick();
  assert.equal(w.tm.length, 1);
  assert.match(w.tm[0], /red behind a quick train.*30 minutes unfixed.*#12/s);
  // Its next ship is rechecked: the file runs alone on it, and only a pass there clears it.
  const unrelated = w.commit('#12 something else');
  await w.fm.landed(CITADEL, 1012, unrelated);
  assert.equal(w.runs.at(-1)!.sha, unrelated);
  assert.equal(w.runs.at(-1)!.env.LAND_VERIFY_IDS, 'test/a.test.ts');
  assert.equal(w.runs.at(-1)!.env.WHO, '1012');
  await w.finish(red('test/a.test.ts'));
  assert.equal(w.fm.view(CITADEL).reds.length, 1, 'still red after a ship that did not fix it');
  await w.fm.landed(CITADEL, 1011, w.commit('#11 not the culprit'));
  assert.equal(w.runs.length, 5, "another minion's ship is no recheck");
  const fix = w.commit('#12 the fix');
  await w.fm.landed(CITADEL, 1012, fix);
  assert.equal(w.runs.at(-1)!.sha, fix);
  await w.finish(GREEN);
  assert.deepEqual(w.fm.view(CITADEL).reds, [], 'passed alone on its fix');
  await w.tick();
  assert.equal(w.runs.length, 6, 'nothing more to run');
});

test('a flake: passing alone on the base and every ship, the top too, blames nobody', async () => {
  const w = world();
  const { tops } = w.quickTrain();
  await w.tick();
  await w.finish(red('test/flaky.test.ts'));
  for (let i = 0; i < 4; i++) await w.finish(GREEN);
  assert.equal(w.runs.at(-1)!.sha, tops[2], 'the top is run alone too');
  assert.equal(w.runs.length, 5);
  assert.deepEqual(w.told, []);
  assert.deepEqual(w.tm, []);
  assert.deepEqual(w.fm.view(CITADEL).reds, []);
  await w.tick();
  assert.equal(w.runs.length, 5, 'done with that quick train');
});

test('two failing files, each blamed on the first ship it fails on', async () => {
  const w = world();
  w.quickTrain();
  await w.tick();
  await w.finish(red('test/a.test.ts', 'test/b.test.ts'));
  await w.finish(GREEN); // base
  await w.finish(red('test/a.test.ts')); // #11
  assert.equal(w.runs.at(-1)!.env.LAND_VERIFY_IDS, 'test/b.test.ts', 'only the file not yet pinned goes on');
  await w.finish(red('test/b.test.ts')); // #12
  assert.deepEqual(
    w.told.map((t) => [t.ticket, /a\.test/.test(t.text) ? 'a' : 'b']),
    [
      [1011, 'a'],
      [1012, 'b'],
    ],
  );
  assert.equal(w.runs.length, 4);
});

test('more than 6 failing files: the first 6 are pinned, the rest go to the Taskmaster at once', async () => {
  const w = world();
  w.quickTrain();
  await w.tick();
  const ids = Array.from({ length: 8 }, (_, i) => `test/f${i}.test.ts`);
  await w.finish(red(...ids));
  assert.equal(w.runs[1].env.LAND_VERIFY_IDS, ids.slice(0, 6).join('\n'));
  assert.equal(w.tm.length, 1);
  assert.match(w.tm[0], /more than 6 files failing/);
  assert.match(w.tm[0], /test\/f7\.test\.ts/);
});

test("no pin: a red on the base was main's before the quick train, and a red naming no file, both go to the Taskmaster at once", async () => {
  const w = world();
  w.quickTrain();
  await w.tick();
  await w.finish(red('test/old.test.ts'));
  await w.finish(red('test/old.test.ts')); // base
  assert.deepEqual(w.told, []);
  assert.equal(w.tm.length, 1);
  assert.match(w.tm[0], /main's red before the quick train/);
  const v = world();
  v.quickTrain();
  await v.tick();
  await v.finish(red('CI'));
  assert.equal(v.runs.length, 1, 'nothing to pin');
  assert.deepEqual(v.told, []);
  assert.match(v.tm[0], /no test file to name/);
});

test("the next full train's run counts: no run while ships wait in line (30 minutes at most), and its red is pinned with no run of its own", async () => {
  const w = world();
  w.quickTrain();
  mkdirSync(join(w.state, 'queue'));
  writeFileSync(join(w.state, 'queue', '4400'), '');
  await w.tick();
  assert.equal(w.runs.length, 0, 'a ship waits: its full train runs CI over the quick top');
  w.wait(QUICK_WAIT_MS);
  await w.tick();
  assert.equal(w.runs.length, 1, 'waited 30 minutes: it runs anyway');

  const v = world();
  const { base, tops } = v.quickTrain(' red=test/a.test.ts');
  await v.tick();
  assert.equal(v.runs.length, 1);
  assert.equal(v.runs[0].sha, base, 'straight to the pin');
  assert.equal(v.runs[0].env.LAND_VERIFY_IDS, 'test/a.test.ts');
  await v.finish(GREEN);
  await v.finish(red('test/a.test.ts'));
  assert.equal(v.runs[1].sha, tops[0]);
  assert.deepEqual(
    v.told.map((t) => t.ticket),
    [1011],
  );
});

test('no verdict (CI down): that quick top runs again 30 minutes later, and a red found by the next full train meanwhile is still pinned', async () => {
  const w = world();
  const { tops } = w.quickTrain();
  await w.tick();
  await w.finish('verify: no verdict\n', 75);
  await w.tick();
  assert.equal(w.runs.length, 1, 'not straight away');
  w.wait(QUICK_WAIT_MS);
  await w.tick();
  assert.equal(w.runs.length, 2);
  assert.equal(w.runs[1].sha, tops[2]);
  await w.finish('verify: no verdict\n', 75);
  writeFileSync(join(w.state, 'quick-behind'), `${readFileSync(join(w.state, 'quick-behind'), 'utf8').trim()} red=test/a.test.ts\n`);
  await w.tick();
  assert.equal(w.runs.length, 3);
  assert.equal(w.runs[2].env.LAND_VERIFY_IDS, 'test/a.test.ts', 'pinned at once');
});

test('a quick top no longer on main (rolled back) gets no run', async () => {
  const w = world();
  const { base } = w.quickTrain();
  execFileSync('git', ['reset', '-q', '--hard', base], { cwd: w.repo });
  await w.tick();
  assert.equal(w.runs.length, 0);
});
