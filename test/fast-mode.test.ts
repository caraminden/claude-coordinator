import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ESCALATE_MS, FastMode, verifyResult, type FastState } from '../src/fast-mode.ts';

// src/fast-mode.ts (#1017): the suite behind fast-mode ships. One run per scheme on main's newest head, a red pinned
// on the commit that first fails on a new id, that commit's minion told, the known-red ledger kept and cleared, and
// the Taskmaster told after 30 minutes. Runs are faked (the HostJobs a test answers); git is a real repo. The scheme
// is Peek's id, not Citadel's (the every-scheme skill).
const root = mkdtempSync(join(tmpdir(), 'fast-mode-'));
after(() => rmSync(root, { recursive: true, force: true }));
const PEEK = 3;
let repos = 0;

function world() {
  const repo = join(root, `r${++repos}`);
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
  let clock = 1_000_000;
  const fm = new FastMode({
    schemes: () => [{ id: PEEK, repo }],
    get: (k) => kv.get(k), set: (k, v) => kv.set(k, structuredClone(v)),
    jobs: {
      start: (j) => {
        runs.push({ sha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: j.cwd, encoding: 'utf8' }).trim(), env: j.env });
        answer = { output: '', code: null };
      },
      state: () => answer,
    },
    dir: (p) => join(repo + '-run', String(p)),
    env: (_p, t) => ({ WHO: String(t) }),
    ticketOf: (_p, n) => n + 1000, numberOf: (t) => t * 10,
    tell: (ticket, text) => told.push({ ticket, text }), taskmaster: (_p, text) => tm.push(text),
    green: (_p, sha) => greens.push(sha), now: () => clock,
  });
  /** The running job ends with `output`, and the next tick reads it. */
  const finish = async (output: string, code = output.includes('verify: green') ? 0 : 1) => {
    answer = { output, code };
    await fm.tick();
  };
  return { repo, commit, fm, runs, finish, told, tm, greens, kv, tick: () => fm.tick(), wait: (ms: number) => (clock += ms) };
}
const red = (...ids: string[]) => `${ids.map((id) => `verify: failing ${id}`).join('\n')}\nverify: red\n`;
const GREEN = 'verify: green\n';

test('verifyResult reads green, red with its ids, and anything else as no verdict', () => {
  assert.deepEqual(verifyResult('x\nverify: green\n'), { verdict: 'green' });
  assert.deepEqual(verifyResult(red('a', 'b')), { verdict: 'red', ids: ['a', 'b'] });
  assert.deepEqual(verifyResult('verify: no verdict\n'), { verdict: 'none' });
  assert.deepEqual(verifyResult('bash: tools/land.sh: no such file'), { verdict: 'none' });
});

test('one run on the newest head; green feeds last green; a land kicks the next run, which runs with no known reds or LAND_FAST', async () => {
  const w = world();
  const c1 = w.commit('one');
  await w.tick();
  assert.equal(w.runs.length, 1);
  assert.equal(w.runs[0].sha, c1);
  w.commit('two');
  await w.tick();
  assert.equal(w.runs.length, 1, 'nothing new starts while one runs');
  const c3 = w.commit('three #5');
  await w.finish(GREEN);
  assert.deepEqual(w.greens, [c1]);
  assert.equal(w.runs[1].sha, c3, 'the next run is on the newest head, skipping two');
  assert.equal(w.runs[1].env.LAND_KNOWN_RED, '');
  assert.equal(w.runs[1].env.LAND_FAST, '');
  await w.finish(GREEN);
  assert.equal(w.runs.length, 2, 'nothing more to verify');
  w.fm.landed(PEEK, 7, w.commit('four'));
  await w.tick();
  assert.equal(w.runs.length, 3);
  assert.equal(w.runs[2].env.WHO, '7', "the run's env is its lander's");
});

test("a red on one land tells that land's minion; later reds only on that id blame nobody; it clears once it passes", async () => {
  const w = world();
  w.commit('one');
  await w.tick();
  await w.finish(GREEN);
  const c2 = w.commit('two');
  w.fm.landed(PEEK, 7, c2);
  await w.tick();
  await w.finish(red('test/x.test.ts'));
  assert.equal(w.told.length, 1);
  assert.equal(w.told[0].ticket, 7);
  assert.match(w.told[0].text, /test\/x\.test\.ts/);
  assert.equal(w.fm.knownRed(PEEK), 'test/x.test.ts\t#70 is fixing it');
  w.fm.landed(PEEK, 8, w.commit('three'));
  await w.tick();
  await w.finish(red('test/x.test.ts'));
  assert.equal(w.told.length, 1, 'known red only: nobody blamed');
  const c4 = w.commit('four');
  w.fm.landed(PEEK, 9, c4);
  await w.tick();
  await w.finish(red('test/x.test.ts', 'test/y.test.ts'));
  assert.equal(w.told.length, 2);
  assert.equal(w.told[1].ticket, 9, 'a new id has its own culprit');
  assert.doesNotMatch(w.told[1].text, /x\.test/);
  assert.equal(w.fm.knownRed(PEEK), 'test/x.test.ts\t#70 is fixing it\ntest/y.test.ts\t#90 is fixing it');
  w.commit('five');
  await w.tick();
  await w.finish(red('test/y.test.ts'));
  assert.equal(w.fm.knownRed(PEEK), 'test/y.test.ts\t#90 is fixing it', 'x passed, so it left the ledger');
  w.commit('six');
  await w.tick();
  await w.finish(GREEN);
  assert.equal(w.fm.knownRed(PEEK), '');
  assert.equal(w.tm.length, 0);
});

test("a culprit commit with no landing of its own is its branch's: the nearest landing after it", async () => {
  const w = world();
  w.commit('one');
  await w.tick();
  await w.finish(GREEN);
  const c2 = w.commit('#77: two');
  const c3 = w.commit('three');
  await w.fm.landed(PEEK, 3, c3);
  await w.finish(red('a'));
  assert.equal(w.runs.at(-1)!.sha, c2);
  await w.finish(red('a'));
  assert.equal(w.told[0].ticket, 3, "two landed in three's landing, which beats its subject's #77");
});

test('a red over several lands is pinned on the first commit failing a new id, oldest first; a #N subject finds its minion', async () => {
  const w = world();
  w.commit('one');
  await w.tick();
  await w.finish(GREEN);
  const c2 = w.commit('two');
  const c3 = w.commit('#33: three');
  const c4 = w.commit('four');
  await w.fm.landed(PEEK, 2, c2);
  await w.tick();
  assert.equal(w.runs.at(-1)!.sha, c4);
  await w.finish(red('a'));
  assert.equal(w.runs.at(-1)!.sha, c2, 'pinning starts at the oldest');
  assert.equal(w.told.length, 0);
  await w.finish(GREEN);
  assert.equal(w.runs.at(-1)!.sha, c3);
  await w.finish(red('a'));
  assert.equal(w.told.length, 1);
  assert.equal(w.told[0].ticket, 1033, "no landing holds three (four's wasn't seen either), so its subject's #33 names it");
  assert.match(w.told[0].text, new RegExp(c3.slice(0, 12)));
  assert.equal(w.greens.length, 1, 'a pinning run going green is not main going green');
  const runs = w.runs.length;
  await w.tick();
  assert.equal(w.runs.length, runs, 'the head was verified by the pinning');
});

test("the first run's red, a range too long to pin, and a red left 30 minutes go to the Taskmaster; no verdict isn't retried on the same head", async () => {
  const w = world();
  w.commit('one');
  await w.tick();
  await w.finish(red('old'));
  assert.equal(w.told.length, 0);
  assert.equal(w.tm.length, 1);
  assert.match(w.tm[0], /first run since fast mode went on/);
  assert.equal(w.fm.knownRed(PEEK), 'old\tthe Taskmaster has it');
  for (let i = 0; i < 10; i++) w.commit(`c${i}`);
  await w.tick();
  await w.finish(red('old', 'new'));
  assert.equal(w.tm.length, 2);
  assert.match(w.tm[1], /more than 8 to pin/);
  const c = w.commit('lone');
  w.fm.landed(PEEK, 5, c);
  await w.tick();
  await w.finish(red('old', 'new', 'z'));
  assert.equal(w.told.length, 1);
  w.wait(ESCALATE_MS - 1);
  await w.tick();
  assert.equal(w.tm.length, 2);
  w.wait(2);
  await w.tick();
  assert.equal(w.tm.length, 3);
  assert.match(w.tm[2], /30 minutes unfixed: z.*given to #50/);
  await w.tick();
  assert.equal(w.tm.length, 3, 'told once');
  w.commit('stuck');
  await w.tick();
  const runs = w.runs.length;
  await w.finish('verify: no verdict\n', 75);
  await w.tick();
  assert.equal(w.runs.length, runs, 'not retried until main moves');
  w.commit('moved');
  await w.tick();
  assert.equal(w.runs.length, runs + 1);
  w.fm.reset(PEEK);
  assert.equal(w.fm.knownRed(PEEK), '');
});

test("each id is pinned on the first commit failing it: the run reruns only the ids left, its 30 minutes start at the red, and they're known red meanwhile", async () => {
  const w = world();
  w.commit('one');
  await w.tick();
  await w.finish(GREEN);
  const c2 = w.commit('two'), c3 = w.commit('three'), c4 = w.commit('four');
  w.fm.landed(PEEK, 2, c2.slice(0, 9)); // land.sh's "landed" line gives a short sha
  w.fm.landed(PEEK, 4, c4);
  await w.tick();
  await w.finish(red('a', 'b'));
  assert.equal(w.runs.at(-1)!.sha, c2);
  assert.equal(w.runs.at(-1)!.env.LAND_VERIFY_IDS, 'a\nb', 'a pinning run checks only the new ids');
  assert.equal(w.fm.knownRed(PEEK), 'a\tCitadel is finding whose change broke it\nb\tCitadel is finding whose change broke it');
  w.wait(ESCALATE_MS / 2);
  await w.finish(red('a'));
  assert.deepEqual(w.told.map((t) => t.ticket), [2], 'a is two\'s, found by its short sha');
  assert.doesNotMatch(w.told[0].text, /- b/);
  assert.equal(w.runs.at(-1)!.sha, c3);
  assert.equal(w.runs.at(-1)!.env.LAND_VERIFY_IDS, 'b', 'b goes on alone');
  await w.finish(GREEN);
  assert.deepEqual(w.told.map((t) => t.ticket), [2, 4], "b passed on three, so it's four's: the head's own");
  assert.equal(w.fm.knownRed(PEEK), 'a\t#20 is fixing it\nb\t#40 is fixing it');
  assert.equal(w.tm.length, 0);
  w.wait(ESCALATE_MS / 2 + 1);
  await w.tick();
  assert.equal(w.tm.length, 2, 'the 30 minutes ran from when the red was seen, not from the blame: one note per entry');
});

test("a land during a pass isn't lost; an old red escalates while a run is going; reset keeps the run", async () => {
  const w = world();
  w.commit('one');
  await w.tick();
  await w.finish(GREEN);
  const c2 = w.commit('two');
  const pass = w.tick();
  w.fm.landed(PEEK, 6, c2); // while the pass awaits git
  await pass;
  assert.equal(w.kv.get(`fast-mode:${PEEK}`)!.landed[c2], 6);
  await w.finish(red('a'));
  assert.equal(w.told.at(-1)!.ticket, 6);
  w.commit('three');
  await w.tick();
  const runs = w.runs.length;
  assert.ok(w.kv.get(`fast-mode:${PEEK}`)!.running);
  w.wait(ESCALATE_MS + 1);
  await w.tick();
  assert.equal(w.tm.length, 1, 'escalated with the run still going');
  w.fm.reset(PEEK);
  await w.tick();
  assert.equal(w.runs.length, runs, 'the run going survives a reset and is not started again');
  const tm = w.tm.length;
  await w.finish(red('a'));
  assert.equal(w.tm.length, tm, "its result is dropped: it may have been a pinning run's few ids");
  assert.equal(w.runs.length, runs + 1, 'and the head is run afresh');
  await w.finish(red('a'));
  assert.match(w.tm.at(-1)!, /first run since fast mode went on/);
});

test("a pinning run with no verdict, or red only on what it can't name, is no pass: it is run again, then the pin stops and the Taskmaster has it (R1)", async () => {
  for (const nothing of ['verify: no verdict\n', red('the check'), red('CI')]) {
    const w = world();
    w.commit('one');
    await w.tick();
    await w.finish(GREEN);
    const c2 = w.commit('two'), c3 = w.commit('three'), c4 = w.commit('four');
    w.fm.landed(PEEK, 2, c2), w.fm.landed(PEEK, 3, c3), w.fm.landed(PEEK, 4, c4);
    await w.tick();
    await w.finish(red('test/a.test.ts'));
    assert.equal(w.runs.at(-1)!.sha, c2, 'pinning starts at the oldest');
    await w.finish(nothing);
    assert.equal(w.runs.at(-1)!.sha, c2, `${nothing.trim()}: two is run again, not passed`);
    await w.finish(nothing);
    assert.equal(w.told.length, 0, `${nothing.trim()}: no minion is blamed for a red nothing pinned on it`);
    assert.equal(w.tm.length, 1, 'the Taskmaster has it');
    assert.match(w.tm[0], /test\/a\.test\.ts/);
    assert.match(w.tm[0], /no verdict/);
    assert.equal(w.fm.knownRed(PEEK), 'test/a.test.ts\tthe Taskmaster has it');
    const runs = w.runs.length;
    await w.tick();
    assert.equal(w.runs.length, runs, 'the head counts as verified: not run again until main moves');
  }
  // An unnamed red that is itself pinned is blamed, but says nothing of the other ids: they are run again, alone.
  const m = world();
  m.commit('one');
  await m.tick();
  await m.finish(GREEN);
  const m2 = m.commit('two'), m3 = m.commit('three'), m4 = m.commit('four');
  m.fm.landed(PEEK, 2, m2), m.fm.landed(PEEK, 3, m3), m.fm.landed(PEEK, 4, m4);
  await m.tick();
  await m.finish(red('the check', 'test/a.test.ts'));
  await m.finish(red('the check'));
  assert.deepEqual(m.told.map((t) => t.ticket), [2], 'the check is two\'s');
  assert.equal(m.runs.at(-1)!.sha, m2, 'test/a is run on two again');
  assert.equal(m.runs.at(-1)!.env.LAND_VERIFY_IDS, 'test/a.test.ts');
  await m.finish(GREEN);
  assert.equal(m.runs.at(-1)!.sha, m3);
  await m.finish(red('test/a.test.ts'));
  assert.deepEqual(m.told.map((t) => t.ticket), [2, 3]);
  // A retry that gives a verdict goes on as usual.
  const w = world();
  w.commit('one');
  await w.tick();
  await w.finish(GREEN);
  const c2 = w.commit('two'), c3 = w.commit('three');
  w.fm.landed(PEEK, 2, c2), w.fm.landed(PEEK, 3, c3);
  await w.tick();
  await w.finish(red('a'));
  await w.finish('verify: no verdict\n');
  await w.finish(red('a'));
  assert.deepEqual(w.told.map((t) => t.ticket), [2]);
});

test("a reset while a pass awaits git sticks: the pass doesn't write its old state back, and the run it started stays known (R3)", async () => {
  const w = world();
  w.commit('one');
  await w.tick();
  await w.finish(red('a'));
  assert.equal(w.fm.knownRed(PEEK), 'a\tthe Taskmaster has it');
  const c2 = w.commit('two');
  const pass = w.tick(); // reads the state, then awaits git to start a run on two
  w.fm.reset(PEEK);
  await pass;
  assert.equal(w.fm.knownRed(PEEK), '', 'the ledger the reset cleared stays cleared');
  const s = w.kv.get(`fast-mode:${PEEK}`)!;
  assert.equal(s.verified, undefined, 'no verdict from before the reset');
  assert.equal(s.running?.sha, c2, 'the run the pass started is still known, so it is not started twice');
  assert.equal(s.running?.stale, true, 'and its result is dropped');
  const runs = w.runs.length;
  await w.finish(red('a'));
  assert.equal(w.runs.length, runs + 1, 'the head is run afresh');
  await w.finish(red('a'));
  assert.match(w.tm.at(-1)!, /first run since fast mode went on/);
  // A reset while a red is being blamed (its git lookups): nobody is told of a ledger the reset cleared.
  const c3 = w.commit('three');
  w.fm.landed(PEEK, 7, c3);
  await w.tick();
  const tm = w.tm.length;
  const blaming = w.finish(red('a', 'b'));
  w.fm.reset(PEEK);
  await blaming;
  assert.equal(w.tm.length, tm);
  assert.equal(w.told.length, 0);
  assert.equal(w.fm.knownRed(PEEK), '');
});

test("a fast-mode worktree whose git link is gone is rebuilt on the next tick, and the run goes on", async () => {
  const w = world();
  w.commit('one');
  await w.tick();
  await w.finish(GREEN);
  // What a `git worktree prune` run where the folder can't be seen (a container turn) leaves: the folder and its .git file, no entry.
  rmSync(join(w.repo, '.git', 'worktrees'), { recursive: true, force: true });
  const c2 = w.commit('two');
  await w.tick();
  assert.equal(w.runs.length, 2, 'the run on the new head started');
  assert.equal(w.runs[1].sha, c2);
  const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: w.repo, encoding: 'utf8' });
  assert.match(list, /locked/, 'locked, so a prune from elsewhere leaves it alone');
});

test("a failure that repeats is said once, and said again when it changes or after it clears", async () => {
  const w = world();
  w.commit('one');
  const said: string[] = [];
  const was = [console.error, console.log];
  console.error = console.log = (m: string) => said.push(m);
  try {
    const broken = join(w.repo, '.git', 'HEAD');
    const good = execFileSync('cat', [broken], { encoding: 'utf8' });
    writeFileSync(broken, 'garbage\n');
    await w.tick(), await w.tick(), await w.tick();
    assert.equal(said.filter((m) => /failed/.test(m)).length, 1, 'three ticks, one line');
    writeFileSync(broken, good);
    await w.tick();
    assert.ok(said.some((m) => /works again|recovered/.test(m)), 'it says when it recovers');
    await w.finish(GREEN);
    writeFileSync(broken, 'garbage\n');
    await w.tick();
    assert.equal(said.filter((m) => /failed/.test(m)).length, 2, 'a new failure after a recovery is said');
  } finally {
    [console.error, console.log] = was;
  }
});
