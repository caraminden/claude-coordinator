// Regenerated files (#1827), the cases both ship scripts run: tools/land.sh in land-regenerate.test.ts and the kit's
// template in scheme-setup-land-regenerate.test.ts, one table for the twin rule's "a test on each side" (Cara,
// 2026-11-22, "Keep both, port by rule"). A ship whose diff is a command's output declares it with the trailers
// Regenerate: and Regenerate-files:, and land.sh takes main's side of those files where they conflict, runs the command
// again after the rebase and commits what it wrote, instead of refusing the ship on the conflict. Each side hands in how
// it makes a repo and ships, and its words where the two scripts word a refusal differently; a case only one script
// has stays in that side's file.
import assert from 'node:assert/strict';
import type { SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

type Git = (cwd: string, ...args: string[]) => string;
// A side's repo: the worktree the ship runs in, the repo main lives in, a ship and the hand-off's --check.
export type Repo = { wt: string; main: string; run: () => SpawnSyncReturns<string>; check: () => SpawnSyncReturns<string> };
export type Side = {
  name: string;
  git: Git;
  setup: () => Repo;
  // The command failed, or wrote outside its files: each script's own refusal.
  failed: RegExp;
  outside: RegExp;
  // Said besides on either refusal, where the script says more.
  refused?: RegExp;
};

// The "formatter": every .txt file upper-cased in place.
export const FMT = 'for f in *.txt; do tr a-z A-Z <"$f" >"$f.tmp" && mv "$f.tmp" "$f"; done';
export const declare = (cmd: string, files: string) => `Regenerate: ${cmd}\nRegenerate-files: ${files}`;

export function write(git: Git, where: string, files: Record<string, string>, msg: string, body?: string) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(where, f, '..'), { recursive: true });
    writeFileSync(join(where, f), text);
  }
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', msg, ...(body ? ['-m', body] : []));
}

// main with two .txt files and a note; the branch formats the .txt files (declared or not), and main then changes
// a.txt, which conflicts with the formatted copy.
export function reformat<R extends Repo>(side: { git: Git; setup: () => R }, body?: string, extra: Record<string, string> = {}): R {
  const { git } = side;
  const r = side.setup();
  write(git, r.main, { 'a.txt': 'one\n', 'b.txt': 'bee\n', 'notes.md': 'note\n' }, 'base files');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  write(git, r.wt, { 'a.txt': 'ONE\n', 'b.txt': 'BEE\n', ...extra }, '#1: format the txt files', body);
  write(git, r.main, { 'a.txt': 'one\ntwo\n' }, 'a.txt: two');
  return r;
}

export function regenerateCases(side: Side) {
  const { git } = side;
  const show = (r: Repo, f: string) => git(r.main, 'show', `main:${f}`);

  test(`${side.name}: without a declaration, a reformat main's newer change conflicts with is refused, with the hint`, () => {
    const r = reformat(side);
    const res = r.run();
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /conflicted files: a\.txt\..*declare it instead: a commit with the trailers Regenerate: <command> and Regenerate-files:/);
    assert.equal(show(r, 'a.txt'), 'one\ntwo');
  });

  test(`${side.name}: a conflict outside the declared files still refuses, naming that file`, () => {
    const r = reformat(side, declare(FMT, '*.txt'), { 'notes.md': 'branch note\n' });
    write(git, r.main, { 'notes.md': 'main note\n' }, 'notes: main');
    const check = r.check();
    assert.equal(check.status, 3, check.stderr);
    assert.match(check.stderr, /conflicted files: notes\.md\./);
    const res = r.run();
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, /conflicted files: notes\.md\./);
    assert.equal(show(r, 'notes.md'), 'main note');
  });

  test(`${side.name}: a declared command that fails, or writes outside its files, refuses and the worktree is put back`, () => {
    for (const [cmd, want] of [
      [`${FMT}; echo touched >new.txt; echo formatter broke >&2; exit 4`, side.failed],
      [`${FMT}; echo stray >>notes.md; echo made >made.log`, side.outside],
    ] as const) {
      const r = reformat(side, declare(cmd, '*.txt'));
      const main = git(r.main, 'rev-parse', 'main');
      const res = r.run();
      assert.equal(res.status, 1, res.stderr);
      assert.match(res.stderr, want);
      if (side.refused) assert.match(res.stderr, side.refused);
      assert.equal(git(r.main, 'rev-parse', 'main'), main);
      assert.equal(git(r.wt, 'status', '--porcelain'), '');
      assert.equal(readFileSync(join(r.wt, 'notes.md'), 'utf8'), 'note\n');
      assert.ok(!existsSync(join(r.wt, 'new.txt')) && !existsSync(join(r.wt, 'made.log')));
    }
  });

  test(`${side.name}: a command with no files declared, or files with no command, is refused before anything moves`, () => {
    for (const [body, want] of [
      ['Regenerate: true', /a Regenerate: trailer but no Regenerate-files:/],
      ['Regenerate-files: *.txt', /a Regenerate-files: trailer but no Regenerate: <command>/],
      [declare('true', '!a.txt'), /plain \.gitattributes patterns, not "!a\.txt"/],
    ] as const) {
      const r = reformat(side, body);
      const main = git(r.main, 'rev-parse', 'main');
      const res = r.run();
      assert.equal(res.status, 1, res.stderr);
      assert.match(res.stderr, want);
      assert.equal(git(r.main, 'rev-parse', 'main'), main);
    }
  });

  // Made again on main with no conflict at all, and an unchanged result adds no commit.
  test(`${side.name}: a declared generated file with no conflict is made again on main all the same, and an unchanged result adds no commit`, () => {
    const r = side.setup();
    write(git, r.main, { 'list.txt': 'b\na\n', 'gen.out': 'a\nb\n' }, 'list and its sorted copy');
    git(r.wt, 'merge', '-q', '--ff-only', 'main');
    write(git, r.wt, { 'other.md': 'x\n' }, '#1: other', declare('sort list.txt >gen.out', 'gen.out'));
    write(git, r.main, { 'list.txt': 'c\nb\na\n' }, 'list: c, without its copy made again');
    const res = r.run();
    assert.equal(res.status, 0, res.stderr);
    assert.equal(show(r, 'gen.out'), 'a\nb\nc');
    const r2 = side.setup();
    write(git, r2.main, { 'gen.out': '\n' }, 'gen');
    git(r2.wt, 'merge', '-q', '--ff-only', 'main');
    write(git, r2.wt, { 'other.md': 'x\n' }, '#1: other', declare('true', 'gen.out'));
    const again = r2.run();
    assert.equal(again.status, 0, again.stderr);
    assert.equal(git(r2.main, 'log', '-1', '--format=%s', 'main'), '#1: other');
  });
}
