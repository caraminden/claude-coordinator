// The type baseline at ship time (#2141, from the effort retro #2113): a branch whose test/typecheck-baseline.json only
// lowers counts takes main's copy in the merge (tools/ship-numbers.ts baseline, through land.local.sh's hook), and
// tools/land.sh runs typecheck.ts --update on the rebased tree, so two ships lowering neighbouring rows both ship. A count
// above main's refuses in typecheck's own words; a --moved branch (it raised a row) merges as git would, as before.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, setup, write } from './land-fixture.ts';
import { type Ship, line } from './land-train-fixture.ts';

type R = ReturnType<typeof setup>;
const BASELINE = 'test/typecheck-baseline.json';
const any = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i}: any = ${i};\n`).join('');
// The real typecheck.ts, counting escapes only (no tsconfig, so no tsc), over src/a.ts and src/b.ts with two `any` each:
// their baseline rows sit next to each other, so two branches lowering one each conflict in a plain git merge.
function start(): R {
  const r = setup();
  const real = readFileSync(join(import.meta.dirname, '..', 'tools', 'typecheck.ts'), 'utf8');
  const tc = real.replace(/^export const PROJECTS = .*$/m, 'export const PROJECTS: string[] = [];').replace(/^export const SCRIPTS: .*$/m, 'export const SCRIPTS: string[] = [];');
  assert.notEqual(tc, real);
  write(r.source, { 'tools/typecheck.ts': tc, 'src/a.ts': any(2), 'src/b.ts': any(2) }, 'two files with escapes');
  const init = spawnSync(process.execPath, ['--no-warnings', 'tools/typecheck.ts', '--init'], { cwd: r.source, encoding: 'utf8' });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'baseline');
  assert.match(show(r, 'main', BASELINE), /"src\/a\.ts": \[0, 2\],\n {2}"src\/b\.ts": \[0, 2\]/);
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  return r;
}
const show = (r: R, ref: string, f: string) => git(r.source, 'show', `${ref}:${f}`);
const lower = (from: string, file: string, n: number) => readFileSync(from, 'utf8').replace(new RegExp(`("${file.replace(/[/.]/g, '\\$&')}": \\[0, )\\d+`), `$1${n}`);

test('two branches that each lower a neighbouring row both ship: main keeps both lowerings, measured again on the rebased tree', () => {
  const r = start();
  write(r.source, { 'src/a.ts': any(1), [BASELINE]: lower(join(r.source, BASELINE), 'src/a.ts', 1) }, '#2: one any fewer in a.ts');
  write(r.wt, { 'src/b.ts': any(0), [BASELINE]: lower(join(r.wt, BASELINE), 'src/b.ts', 0) }, '#1: no any in b.ts');
  assert.equal(r.run({}, ['--check']).status, 0, 'the hand-off check counts the baseline as clean');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.doesNotMatch(res.stderr, /holds the line/, 'a plain ship: it keeps its place and its train');
  const merged = show(r, 'main', BASELINE);
  assert.match(merged, /"src\/a\.ts": \[0, 1\]/, "main's lowering stays");
  assert.doesNotMatch(merged, /src\/b\.ts/, "this branch's lowering, measured again: a row at zero goes");
  assert.equal(git(r.source, 'log', '-1', '--format=%s', 'main'), '#1: test/typecheck-baseline.json measured again at ship time');
});

test("a branch whose rebased tree counts more than main's baseline is refused in typecheck's own words", () => {
  const r = start();
  // main lowers a.ts; this branch lowers b.ts but adds an any in a new file its baseline doesn't list.
  write(r.source, { 'src/a.ts': any(1), [BASELINE]: lower(join(r.source, BASELINE), 'src/a.ts', 1) }, '#2: one any fewer in a.ts');
  write(r.wt, { 'src/b.ts': any(1), 'src/c.ts': any(1), [BASELINE]: lower(join(r.wt, BASELINE), 'src/b.ts', 1) }, '#1: one any fewer in b.ts, one in c.ts');
  const before = git(r.source, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /node tools\/typecheck\.ts --update refused on ticket\/1-x, so nothing landed and main is untouched\. .* It said:\n/);
  assert.match(res.stderr, /A file has more type errors or escapes .* than test\/typecheck-baseline\.json allows:\n {2}src\/c\.ts: escapes 0 → 1/);
  assert.equal(git(r.source, 'rev-parse', 'main'), before);
  assert.equal(git(r.wt, 'status', '--porcelain'), '', 'the worktree is put back');
});

test('a --moved branch (it raised a row) merges as git would: a clash with main still stops it, as before', () => {
  const r = start();
  write(r.source, { 'src/b.ts': any(1), [BASELINE]: lower(join(r.source, BASELINE), 'src/b.ts', 1) }, '#2: one any fewer in b.ts');
  // Moves both of a.ts's escapes into b.ts: --update --moved files them under b.ts, raising its row.
  write(r.wt, { 'src/a.ts': '', 'src/b.ts': any(4) }, '#1: move a into b');
  const moved = spawnSync(process.execPath, ['--no-warnings', 'tools/typecheck.ts', '--update', '--moved'], { cwd: r.wt, encoding: 'utf8' });
  assert.equal(moved.status, 0, moved.stdout + moved.stderr);
  git(r.wt, 'commit', '-qam', '#1: re-file the counts');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /conflicted files: [^\n]*test\/typecheck-baseline\.json/);
  assert.doesNotMatch(res.stderr, /measured again at ship time/);
});

test('the merge by itself: a side that only lowered takes main, a raise merges as git would', () => {
  const r = start();
  const tool = join(import.meta.dirname, '..', 'tools', 'ship-numbers.ts');
  const f = (name: string, text: string) => (writeFileSync(join(r.dir, name), text), join(r.dir, name));
  const base = f('o', '{\n  "a": [0, 2],\n  "b": [0, 2]\n}\n');
  const ours = f('m', '{\n  "a": [0, 1],\n  "b": [0, 2]\n}\n');
  const theirs = f('t', '{\n  "a": [0, 2]\n}\n');
  const merge = (side: string, o: string, a: string, b: string) => spawnSync(process.execPath, ['--no-warnings', tool, 'baseline', side, o, a, b], { encoding: 'utf8' }).status;
  assert.equal(merge('ours', base, ours, theirs), 0);
  assert.equal(readFileSync(ours, 'utf8'), '{\n  "a": [0, 1],\n  "b": [0, 2]\n}\n', "main's copy (ours), to be measured again");
  // With main as theirs (a merge into the branch), the branch's raise merges as git would.
  const raised = f('r', '{\n  "a": [0, 3],\n  "b": [0, 2]\n}\n');
  const main2 = f('m2', '{\n  "a": [0, 2],\n  "b": [0, 1]\n}\n');
  assert.equal(merge('theirs', base, raised, main2), 1, "neighbouring rows: git's own clash, as before");
  const far = f('r2', '{\n  "a": [0, 3],\n  "b": [0, 2]\n}\n');
  const same = f('m3', '{\n  "a": [0, 2],\n  "b": [0, 2]\n}\n');
  assert.equal(merge('theirs', base, far, same), 0);
  assert.equal(readFileSync(far, 'utf8'), '{\n  "a": [0, 3],\n  "b": [0, 2]\n}\n', "merged as git would: the raise kept, not main's copy");
});

// #2141: two ships lowering neighbouring rows of the type baseline ride one train: the rider takes the front's copy in its
// merge and its counts are measured again on the train (train_steps), as the front's are after its rebase.
test('two ships lowering neighbouring type baseline rows ride one train, and main keeps both lowerings', async () => {
  const base = 'test/typecheck-baseline.json';
  const any = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i}: any = ${i};\n`).join('');
  const ships: Ship[] = [{}, { change: ['src/a.ts', any(1)], also: [base, ''] }, { change: ['src/b.ts', any(0)], also: [base, ''] }];
  const l = await line(ships, {}, (r) => {
    const tc = readFileSync(join(import.meta.dirname, '..', 'tools', 'typecheck.ts'), 'utf8').replace(/^export const PROJECTS = .*$/m, 'export const PROJECTS: string[] = [];');
    mkdirSync(join(r.source, 'src'), { recursive: true });
    for (const [f, t] of [
      ['tools/typecheck.ts', tc],
      ['src/a.ts', any(2)],
      ['src/b.ts', any(2)],
    ])
      writeFileSync(join(r.source, f), t);
    git(r.source, 'add', '-A');
    const init = spawnSync(process.execPath, ['--no-warnings', 'tools/typecheck.ts', '--init'], { cwd: r.source, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stdout + init.stderr);
    git(r.source, 'add', '-A');
    git(r.source, 'commit', '-qm', 'escapes and their baseline');
    const was = readFileSync(join(r.source, base), 'utf8');
    assert.match(was, /"src\/a\.ts": \[0, 2\],\n {2}"src\/b\.ts": \[0, 2\]/);
    ships[1].also![1] = was.replace('"src/a.ts": [0, 2]', '"src/a.ts": [0, 1]');
    ships[2].also![1] = was.replace(/ {2}"src\/b\.ts": \[0, 2\],?\n/, '').replace(/,\n\}/, '\n}');
    git(r.wt, 'merge', '-q', '--ff-only', 'main');
  });
  for (const n of [2, 3]) {
    git(l.wts[n - 1], 'reset', '-q', '--soft', git(l.wts[n - 1], 'merge-base', 'main', 'HEAD'));
    git(l.wts[n - 1], 'commit', '-q', '-m', `#${n}: lower a row`);
  }
  const done = await l.go();
  done.forEach((d, i) => assert.equal(d.status, 0, `ship ${i + 1}: ${d.stderr}`));
  assert.match(done[1].stderr, /ship train: ticket\/2-x takes the 1 ships waiting behind it \(ticket\/3-x\)/);
  const merged = git(l.r.source, 'show', `main:${base}`);
  assert.match(merged, /"src\/a\.ts": \[0, 1\]/);
  assert.doesNotMatch(merged, /src\/b\.ts/);
  l.done();
});
