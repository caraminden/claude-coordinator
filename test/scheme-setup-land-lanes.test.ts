// The scheme-setup template land.sh: land lanes (#753, specs/land-lanes.md). A landing checks, and runs CI for, only
// the lane of what it changes, by the map in tools/lanes as main has it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { env, git, sleep, until, queueSetup } from './scheme-setup-land-fixture.ts';

// tools/* is light here so the rule that the map, land.sh and land.local.sh are full whatever it says is what decides.
const MAP = '# where paths go\nfull  src/core/Cargo.toml\nfast  src/*\nlight docs/* *.md tools/*  # notes\nandroid app/*\n';
// Each check says its lane in $CHECKS; android runs a check but no CI.
const LANES = `LANES=tools/lanes\nCHECK='echo full >>"$CHECKS"'\nCHECK_FAST='echo fast >>"$CHECKS"'\nCHECK_ANDROID='echo android >>"$CHECKS"'\nCI_WORKFLOWS_ANDROID=''\n`;
const gated = 'until [ -e "$GATE" ]; do sleep 0.05; done';

// CI faked as in scheme-setup-land-ci.test.ts: CI_STATUS answers from a file named after the commit, and logs
// "<argument count> <commit> <lane>" to status.log; or, builtin, a gh that prints runs.tsv and skipped-jobs.
function laneSetup(files: string[], { lanes = LANES, extra = '', builtin = false, stack = '', batch = '' } = {}) {
  const config: Record<string, string> = { ...(builtin ? { CI_WORKFLOWS: 'ci.yml slow.yml' } : { CI_STATUS: '"$CI_FAKE"' }), ...(stack ? { CI_STACK: stack } : {}) };
  const q = queueSetup(files.length, 'true', config, (i) => files[i - 1], lanes + extra);
  q.commit(q.main, 'tools/lanes', MAP);
  const ci = join(q.dir, 'ci');
  const bin = join(q.dir, 'bin');
  mkdirSync(ci);
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/bash\necho "$*" >>"$CI_DIR/gh.log"\ncase "$*" in *head_sha=*) cat "$CI_DIR/runs.tsv" 2>/dev/null ;; *skipped*) cat "$CI_DIR/skipped-jobs" 2>/dev/null || echo 0 ;; esac\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(ci, 'status.sh'), '#!/bin/bash\necho "$# ${1:0:12} ${2:-}" >>"$CI_DIR/status.log"\nread -r code <"$CI_DIR/${1:0:12}" 2>/dev/null || code=3\nexit "$code"\n', { mode: 0o755 });
  const checks = join(q.dir, 'checks');
  const ciEnv = { CI_DIR: ci, CI_FAKE: join(ci, 'status.sh'), CHECKS: checks, PATH: `${bin}:${env.PATH}`, LAND_CI_POLL: '0', LAND_CI_GRACE: '0', LAND_BATCH: batch || '1' }; // no batch: off, so a test of one landing's run isn't batched by the template's default (4)
  const started: ReturnType<typeof q.land>[] = [];
  const land = (i: number) => started[started.push(q.land(i, ciEnv)) - 1];
  type L = ReturnType<typeof land>;
  const lands = async (...is: number[]) => {
    const out: L[] = [];
    for (const i of is) {
      const had = q.issued();
      out.push(land(i));
      await until(`landing ${i}'s ticket`, () => q.issued() === had + 1);
    }
    return out;
  };
  // What a landing sent to CI, oldest first: "<commit> <scratch branch>".
  const sent = (l: L) => [...l.stderr().matchAll(/waiting for CI on ([0-9a-f]{12}) \(origin's (\S+)\)/g)].map((m) => `${m[1]} ${m[2]}`);
  const tip = async (l: L) => { await until(`a CI run: ${l.stderr()}`, () => sent(l).length > 0); return sent(l)[0].split(' ')[0]; };
  const verdict = (sha: string, code: number) => writeFileSync(join(ci, sha), `${code}\n`);
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const asked = () => read(join(ci, 'status.log'));
  const checked = () => read(checks);
  const mainAt = () => git(q.main, 'rev-parse', 'main').slice(0, 12);
  const parent = (sha: string) => git(q.main, 'rev-parse', `${sha}^`).slice(0, 12);
  const stop = () => { for (const l of started) if (l.child.exitCode === null && l.child.signalCode === null) l.child.kill('SIGKILL'); };
  return { ...q, ci, land, lands, sent, tip, verdict, asked, checked, mainAt, parent, stop };
}
const GREEN = 0, RED = 1;

test('lanes: --lane prints the lane and the path that decided it, by main\'s map, never the commit\'s', () => {
  const c = laneSetup(['docs/a.md']);
  const lane = (...args: string[]) => {
    // main's land.sh, run in the worktree: the commits below edit the worktree's own
    const r = spawnSync('bash', [join(c.main, 'tools', 'land.sh'), '--lane', ...args], { cwd: c.wt, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const next = (file: string, text = 'x\n') => { c.commit(c.wt, file, text); return lane('HEAD', 'HEAD~1'); };
  assert.equal(lane(), 'light docs/a.md', 'every path light: light');
  assert.equal(next('src/x.txt'), 'fast src/x.txt');
  assert.equal(lane(), 'fast src/x.txt', 'light and one partial lane: that lane');
  assert.equal(next('app/y.txt'), 'android app/y.txt');
  assert.equal(lane(), 'full src/x.txt', 'two partial lanes: full');
  assert.equal(next('src/core/Cargo.toml'), 'full src/core/Cargo.toml', 'the first line that matches wins');
  assert.equal(next('other.txt'), 'full other.txt', 'a path no line lists is full');
  assert.equal(next('docs/deep/er/b.md'), 'light docs/deep/er/b.md', '* matches / too');
  assert.equal(lane('HEAD', 'HEAD'), 'full (no changes)');
  for (const f of ['tools/land.local.sh', 'tools/land.sh', '.github/notes.md']) assert.equal(next(f, '# edited\n'), `full ${f}`, `${f} is full whatever the map says`);
  // A commit that loosens the map is full itself, and the one stacked on it is judged by main's map.
  assert.equal(next('tools/lanes', 'light *\n'), 'full tools/lanes');
  assert.equal(next('new/z.txt'), 'full new/z.txt');
  assert.equal(lane('HEAD', 'no-such-base'), "full (couldn't diff HEAD against no-such-base)");
  const off = laneSetup(['docs/a.md'], { lanes: '' });
  assert.equal(spawnSync('bash', [join(off.wt, 'tools', 'land.sh'), '--lane'], { cwd: off.wt, encoding: 'utf8', env }).stdout.trim(), 'full (LANES is not set, so every landing is full)');
});

test('lanes: a path PIPELINE_FILES lists takes the full lane whatever the map says, as the list file itself does', () => {
  const c = laneSetup(['docs/a.md'], { extra: 'PIPELINE_FILES=tools/pipe.txt\n' });
  c.commit(c.main, 'tools/pipe.txt', '# the deploy script\ndocs/deploy/\n'); // main's list decides, as with the map
  const next = (file: string) => {
    c.commit(c.wt, file, 'x\n');
    const r = spawnSync('bash', [join(c.main, 'tools', 'land.sh'), '--lane', 'HEAD', 'HEAD~1'], { cwd: c.wt, encoding: 'utf8', env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(next('docs/b.md'), 'light docs/b.md');
  assert.equal(next('docs/deploy/run.sh'), 'full docs/deploy/run.sh', 'light by the map, but part of the pipeline');
  assert.equal(next('tools/pipe.txt'), 'full tools/pipe.txt');
});

test('lanes: a light landing runs no check and no CI and pushes nothing; a partial lane with no workflows runs only its own check', async () => {
  const c = laneSetup(['docs/a.md', 'app/y.txt']);
  try {
    const a = c.land(1);
    assert.equal(await a.exit, 0, a.stderr());
    assert.match(a.stderr(), /lane light: docs\/a\.md/);
    assert.match(a.stderr(), /lane light runs no check/);
    assert.match(a.stderr(), /lane light runs no CI, so nothing is pushed/);
    assert.equal(c.checked(), '', 'neither CHECK nor any other check ran');
    const b = c.land(2);
    assert.equal(await b.exit, 0, b.stderr());
    assert.equal(c.checked(), 'android\n', "CHECK_ANDROID, not CHECK");
    assert.deepEqual([c.sent(a), c.sent(b)], [[], []]);
    assert.equal(c.asked(), '', 'CI was never asked');
    assert.deepEqual(c.landed().slice(1), ['docs/a.md: 1', 'app/y.txt: 2']);
    assert.equal(git(c.origin, 'for-each-ref', 'refs/heads/land'), '', 'no scratch branch was ever pushed');
  } finally {
    c.stop();
  }
});

test('lanes: a light landing stacked on one whose CI is running lands right after it, with no run of its own', async () => {
  const c = laneSetup(['src/core/Cargo.toml', 'docs/b.md'], { extra: `CHECK_LIGHT='echo light >>"$CHECKS"'\n` });
  try {
    const [a, b] = await c.lands(1, 2);
    const ta = await c.tip(a);
    assert.deepEqual(c.sent(a), [`${ta} land/full/ticket/1-x`]);
    await until('the light one to be green on the one ahead', () => /lane light runs no CI/.test(b.stderr()));
    assert.match(b.stderr(), /rebasing ticket\/2-x onto ticket\/1-x's commit/);
    await sleep(300);
    assert.equal(b.child.exitCode, null, 'it waits for the one ahead to land');
    assert.deepEqual(c.landed().slice(1), []);
    c.verdict(ta, GREEN);
    for (const l of [a, b]) assert.equal(await l.exit, 0, l.stderr());
    assert.deepEqual(c.landed().slice(1), ['src/core/Cargo.toml: 1', 'docs/b.md: 2']);
    assert.equal(c.parent(c.mainAt()), ta, 'on the commit CI passed');
    assert.deepEqual(c.sent(b), []);
    assert.equal(c.checked(), 'full\nlight\n', 'CHECK_LIGHT ran for the light one');
    assert.doesNotMatch(c.asked(), new RegExp(c.mainAt()), 'CI was never asked about the light commit');
  } finally {
    c.stop();
  }
});

test('lanes: when the run ahead of a stacked light landing goes red, it builds again on main and lands, still with no run', async () => {
  const c = laneSetup(['src/x.txt', 'docs/b.md']);
  try {
    const [a, b] = await c.lands(1, 2);
    const ta = await c.tip(a);
    assert.deepEqual(c.sent(a), [`${ta} land/fast/ticket/1-x`]);
    await until('the light one to be green on the one ahead', () => /lane light runs no CI/.test(b.stderr()));
    c.verdict(ta, RED);
    assert.equal(await a.exit, 1, a.stderr());
    assert.equal(await b.exit, 0, b.stderr());
    assert.match(b.stderr(), /rebasing ticket\/2-x onto main/);
    assert.deepEqual(c.landed().slice(1), ['docs/b.md: 2']);
    assert.deepEqual(c.sent(b), []);
    assert.equal(c.asked().trim().split('\n').every((l) => l === `2 ${ta} fast`), true, `CI_STATUS gets the lane, and only the fast run was asked about: ${c.asked()}`);
  } finally {
    c.stop();
  }
});

test("lanes: a partial lane runs its own check, pushes to land/<lane>/, waits only for its workflows and may skip its jobs; full waits for all", async () => {
  const c = laneSetup(['src/x.txt', 'other.txt'], { builtin: true, extra: "CI_WORKFLOWS_FAST='ci.yml'\nCI_SKIPS_FAST='bench'\n" });
  const run = (workflow: string, id: number, state: string) => `.github/workflows/${workflow}\t${id}\t${state}\thttps://ci.test/${id}\n`;
  try {
    const a = c.land(1);
    await c.tip(a);
    assert.match(c.sent(a)[0], / land\/fast\/ticket\/1-x$/);
    writeFileSync(join(c.ci, 'runs.tsv'), run('ci.yml', 2, 'completed\tsuccess') + run('slow.yml', 3, 'in_progress\t-'));
    writeFileSync(join(c.ci, 'skipped-jobs'), 'bench\n'); // the job names the fast run skipped
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(c.checked(), 'fast\n');
    assert.deepEqual(c.landed().slice(1), ['src/x.txt: 1']);
    // other.txt is listed nowhere: full, which counts every skipped job and waits for slow.yml too.
    rmSync(join(c.ci, 'runs.tsv'));
    const b = c.land(2);
    await c.tip(b);
    assert.match(c.sent(b)[0], / land\/full\/ticket\/2-x$/);
    writeFileSync(join(c.ci, 'runs.tsv'), run('ci.yml', 2, 'completed\tsuccess') + run('slow.yml', 3, 'in_progress\t-'));
    writeFileSync(join(c.ci, 'skipped-jobs'), '0\n');
    await sleep(600);
    assert.equal(b.child.exitCode, null, 'full waits for slow.yml');
    writeFileSync(join(c.ci, 'runs.tsv'), run('ci.yml', 2, 'completed\tsuccess') + run('slow.yml', 3, 'completed\tsuccess'));
    assert.equal(await b.exit, 0, b.stderr());
    assert.equal(c.checked(), 'fast\nfull\n');
    assert.deepEqual(c.landed().slice(1), ['src/x.txt: 1', 'other.txt: 2']);
  } finally {
    c.stop();
  }
});

test("lanes: a commit that edits the map is full, and the one stacked on it is judged by main's map, not the edited one", async () => {
  const c = laneSetup(['tools/notes.txt', 'new/x.txt']);
  git(c.wts[0], 'rebase', '-q', 'main'); // onto the map, so the edit below doesn't conflict
  c.commit(c.wts[0], 'tools/lanes', `${MAP}light new/*\n`);
  try {
    const [a, b] = await c.lands(1, 2);
    const ta = await c.tip(a);
    assert.match(a.stderr(), /lane full: tools\/lanes/);
    const tb = await c.tip(b);
    assert.equal(c.parent(tb), ta, 'stacked on the map edit');
    assert.match(b.stderr(), /lane full: new\/x\.txt/);
    assert.deepEqual(c.sent(b), [`${tb} land/full/ticket/2-x`]);
    c.verdict(ta, GREEN);
    c.verdict(tb, GREEN);
    for (const l of [a, b]) assert.equal(await l.exit, 0, l.stderr());
    assert.equal(c.checked(), 'full\nfull\n');
  } finally {
    c.stop();
  }
});

test("lanes: with batches the top's run takes the lane of the batch's whole range, and an all-light batch runs nothing", async () => {
  const extra = `CHECK_LIGHT='${gated}'\nCHECK_FAST='${gated}'\n`;
  const c = laneSetup(['src/x.txt', 'docs/a.md', 'docs/b.md'], { extra, stack: '1', batch: '3' });
  try {
    const [a, b, d] = await c.lands(1, 2, 3);
    c.open();
    const td = await c.tip(d);
    assert.deepEqual(c.sent(d), [`${td} land/fast/ticket/3-x`], 'the light top pushes, in the lane of the fast member under it');
    assert.match(d.stderr(), /its batch's run, from [0-9a-f]{12} up, takes lane fast: src\/x\.txt/);
    c.verdict(td, GREEN);
    for (const l of [a, b, d]) assert.equal(await l.exit, 0, l.stderr());
    assert.deepEqual(c.landed().slice(1), ['src/x.txt: 1', 'docs/a.md: 2', 'docs/b.md: 3']);
    assert.equal(c.mainAt(), td);
    assert.deepEqual([c.sent(a), c.sent(b)], [[], []]);
    assert.match(c.asked(), new RegExp(`^2 ${td} fast$`, 'm'));
  } finally {
    c.stop();
  }
  const l = laneSetup(['docs/a.md', 'b.md', 'docs/c.md'], { extra, stack: '1', batch: '3' });
  try {
    const all = await l.lands(1, 2, 3);
    l.open();
    for (const x of all) assert.equal(await x.exit, 0, x.stderr());
    assert.deepEqual(l.landed().slice(1), ['docs/a.md: 1', 'b.md: 2', 'docs/c.md: 3']);
    assert.deepEqual(all.map(l.sent), [[], [], []]);
    assert.equal(l.asked(), '', 'CI was never asked');
    assert.match(all[0].stderr(), /landed [0-9a-f]+ "[^"]*" in a batch with ticket\/2-x, ticket\/3-x/);
  } finally {
    l.stop();
  }
});

test('lanes: with LANES unset the map is ignored, a light path is full, and CI_STATUS gets the commit alone', async () => {
  const c = laneSetup(['docs/a.md'], { lanes: '' });
  try {
    const a = c.land(1);
    const ta = await c.tip(a);
    assert.deepEqual(c.sent(a), [`${ta} land/ticket/1-x`]);
    c.verdict(ta, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.doesNotMatch(a.stderr(), /\blane\b/);
    assert.equal(c.asked().split('\n')[0], `1 ${ta} `);
  } finally {
    c.stop();
  }
});
