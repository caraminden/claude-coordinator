// self-review's facts at load (kit/skills/self-review/scripts/arrive.sh): the base is an argument, else the
// unshipped build branch this one grew from, else main.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const SCRIPT = join(import.meta.dirname, '..', 'kit', 'skills', 'self-review', 'scripts', 'arrive.sh');
const root = mkdtempSync(join(tmpdir(), 'arrive-'));
after(() => rmSync(root, { recursive: true, force: true }));
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => spawnSync('git', a, { cwd, env, encoding: 'utf8' });
const commit = (dir: string, file: string) => {
  writeFileSync(join(dir, file), file + '\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', file);
};
const arrive = (dir: string, ...args: string[]) => spawnSync('sh', [SCRIPT, ...args], { cwd: dir, env, encoding: 'utf8' }).stdout;

test('a feeder branch from build/7 is sized against build/7, not main', () => {
  const dir = join(root, 'repo');
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  commit(dir, 'a.txt');
  git(dir, 'switch', '-q', '-c', 'build/7');
  commit(dir, 'build.txt');
  git(dir, 'switch', '-q', '-c', 'ticket/1-feeder');
  commit(dir, 'feeder.txt');
  let out = arrive(dir);
  assert.match(out, /base: build\/7 /);
  assert.match(out, /feeder\.txt/);
  assert.doesNotMatch(out, /build\.txt/, 'the build\'s own work is not this branch\'s diff');
  assert.match(arrive(dir, 'main'), /base: main /, 'an argument wins');
  // Once build/7 is in main it is not a base any more.
  git(dir, 'switch', '-q', 'main');
  git(dir, 'merge', '-q', '--ff-only', 'ticket/1-feeder');
  git(dir, 'switch', '-q', '-c', 'ticket/2-plain');
  commit(dir, 'plain.txt');
  out = arrive(dir);
  assert.match(out, /base: main /);
});

test('a feeder behind its build still gets build/7 as its base, and is told what merged since', () => {
  const dir = join(root, 'behind');
  spawnSync('git', ['init', '-q', '-b', 'main', dir]);
  commit(dir, 'a.txt');
  git(dir, 'switch', '-q', '-c', 'build/7');
  commit(dir, 'build-claims.md');
  git(dir, 'switch', '-q', '-c', 'ticket/3-mine');
  commit(dir, 'mine.txt');
  let out = arrive(dir);
  assert.doesNotMatch(out, /BEHIND/, 'level with the build: nothing to say');
  // Another feeder merges into build/7 after this one started.
  git(dir, 'switch', '-q', 'build/7');
  commit(dir, 'other-feeder.txt');
  git(dir, 'switch', '-q', 'ticket/3-mine');
  out = arrive(dir);
  assert.match(out, /base: build\/7 /);
  assert.match(out, /BEHIND: build\/7 has 1 commits/);
  assert.match(out, /other-feeder\.txt/, 'the merge it lacks is listed');
  assert.match(out, /mine\.txt/);
  // A plain branch from main shares no build commit, so it stays on main.
  git(dir, 'switch', '-q', '-c', 'ticket/4-plain', 'main');
  commit(dir, 'plain.txt');
  out = arrive(dir);
  assert.match(out, /base: main /);
  assert.doesNotMatch(out, /BEHIND/);
});
