import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// tools/who-touches (#1159) on a scratch repo with worktrees: committed, uncommitted and untracked changes, a feeder
// measured against its build branch, the build as a row of its own, and worktrees that don't touch the path left out.
const tool = join(import.meta.dirname, '..', 'tools', 'who-touches');
const dir = mkdtempSync(join(tmpdir(), 'who-touches-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const repo = join(dir, 'repo');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} ${i}\n`).join('');

execFileSync('git', ['init', '-q', '-b', 'main', repo]);
writeFileSync(join(repo, 'shared.ts'), lines(10, 'base'));
writeFileSync(join(repo, 'other.ts'), 'x\n');
git(repo, 'add', '.');
git(repo, 'commit', '-qm', 'base');
git(repo, 'branch', 'build/2');

const tree = (name: string, branch: string, from = 'main') => {
  const p = join(dir, name);
  git(repo, 'worktree', 'add', '-q', '-b', branch, p, from);
  return p;
};
// #7 commits 3 lines to shared.ts; #8 has 2 uncommitted; #9 touches only other.ts; #11 adds a new untracked file.
const w7 = tree('t7', 'ticket/7-committed');
writeFileSync(join(w7, 'shared.ts'), lines(10, 'base') + lines(3, 'seven'));
git(w7, 'commit', '-qam', '#7');
const w8 = tree('t8', 'ticket/8-dirty');
writeFileSync(join(w8, 'shared.ts'), lines(10, 'base') + lines(2, 'eight'));
const w9 = tree('t9', 'ticket/9-elsewhere');
writeFileSync(join(w9, 'other.ts'), 'y\n');
git(w9, 'commit', '-qam', '#9');
const w11 = tree('t11', 'ticket/11-new-file');
writeFileSync(join(w11, 'brand-new.ts'), lines(4, 'new'));
// Build 2: a feeder #10 already merged 5 lines into build/2, and a second feeder #12 adds 1 more on top.
const w10 = tree('t10', 'ticket/10-feeder', 'build/2');
writeFileSync(join(w10, 'shared.ts'), lines(10, 'base') + lines(5, 'ten'));
git(w10, 'commit', '-qam', '#10');
git(repo, 'branch', '-f', 'build/2', 'ticket/10-feeder');
const w12 = tree('t12', 'ticket/12-feeder', 'build/2');
writeFileSync(join(w12, 'shared.ts'), lines(10, 'base') + lines(5, 'ten') + lines(1, 'twelve'));
git(w12, 'commit', '-qam', '#12');

const run = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [tool, ...args], { cwd, encoding: 'utf8' });
const row = (out: string, who: string) => out.split('\n').find((l) => l.startsWith(`${who} `) || l.startsWith(`${who}  `));

test('lists each worktree that changes the path, with its own lines, and skips the rest', () => {
  const r = run(w9, 'shared.ts');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^who-touches shared\.ts: 3 of 7 worktrees change it/);
  assert.match(row(r.stdout, '#7') ?? '', /^#7 {2}\+3 -0 {2}last commit \w{3} \d+ .* P[SD]T {2}ticket\/7-committed {2}.*t7$/);
  assert.match(row(r.stdout, '#8') ?? '', /^#8 {2}\+2 -0 \(\+2 -0 uncommitted\)/);
  // The feeder shows only its own line, against build/2; #10's merged work is the build's row.
  assert.match(row(r.stdout, '#12') ?? '', /^#12 {2}\+1 -0 .* vs build\/2/);
  assert.match(row(r.stdout, 'build/2') ?? '', /^build\/2 {2}\+5 -0 .*the build branch, vs main$/);
  for (const absent of ['#9', '#10', '#11']) assert.equal(row(r.stdout, absent), undefined, absent);
});

test('an untracked new file counts, and paths resolve from a subfolder or another worktree', () => {
  const r = run(w7, 'brand-new.ts', 'shared.ts');
  assert.equal(r.status, 0, r.stderr);
  assert.match(row(r.stdout, '#11') ?? '', /^#11 {2}\+4 -0 \(\+4 -0 uncommitted\)/);
  assert.match(r.stdout, /^#7 \(you\) {2}\+3 -0/m);
  assert.match(r.stdout, /^ {4}brand-new\.ts \+4 -0 \(uncommitted\)$/m);
});

test('--base measures every worktree against one ref and drops the build rows', () => {
  const r = run(w9, '--base', 'main', 'shared.ts');
  assert.equal(r.status, 0, r.stderr);
  assert.match(row(r.stdout, '#12') ?? '', /^#12 {2}\+6 -0/);
  assert.equal(row(r.stdout, 'build/2'), undefined);
});

test('it writes nothing: every worktree is as it was', () => {
  const before = [w7, w8, w12].map((w) => git(w, 'status', '--porcelain'));
  run(w9, 'shared.ts');
  assert.deepEqual([w7, w8, w12].map((w) => git(w, 'status', '--porcelain')), before);
});

test('refuses no path, an unknown ref and a path outside the repo', () => {
  assert.equal(run(w9).status, 2);
  assert.match(run(w9, '--base', 'nope', 'shared.ts').stderr, /no such ref: nope/);
  assert.match(run(w9, '/etc/passwd').stderr, /outside this repository/);
});
