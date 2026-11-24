// The scheme-setup template land.sh's Regenerated files (#1827), the same as Citadel's (test/land-regenerate.test.ts):
// a ship whose diff is a command's output declares it with the trailers Regenerate: and Regenerate-files:, and land.sh
// takes main's side of those files where they conflict, runs the command again after the rebase and commits what it
// wrote, instead of refusing the ship on the conflict. Such a ship holds the line and ships alone.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { env, git, setup } from './scheme-setup-land-fixture.ts';

type R = ReturnType<typeof setup>;
// The "formatter": every .txt file upper-cased in place.
const FMT = 'for f in *.txt; do tr a-z A-Z <"$f" >"$f.tmp" && mv "$f.tmp" "$f"; done';
const declare = (cmd: string, files: string) => `Regenerate: ${cmd}\nRegenerate-files: ${files}`;

function write(where: string, files: Record<string, string>, msg: string, body?: string) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(where, f, '..'), { recursive: true });
    writeFileSync(join(where, f), text);
  }
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', msg, ...(body ? ['-m', body] : []));
}
// main with a.txt (the fixture's "one"), b.txt and a note; the branch formats the .txt files (declared or not), and
// main then changes a.txt, which conflicts with the formatted copy.
function reformat(body?: string, extra: Record<string, string> = {}, local?: string) {
  const r = setup('true', {}, local);
  write(r.main, { 'b.txt': 'bee\n', 'notes.md': 'note\n' }, 'base files');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  write(r.wt, { 'a.txt': 'ONE\n', 'b.txt': 'BEE\n', ...extra }, '#1: format the txt files', body);
  write(r.main, { 'a.txt': 'one\ntwo\n' }, 'a.txt: two');
  return r;
}
const check = (r: R) => spawnSync('bash', [join(r.wt, 'tools', 'land.sh'), '--check'], { cwd: r.wt, encoding: 'utf8', timeout: 90_000, env });
const show = (r: R, f: string) => git(r.main, 'show', `main:${f}`);

test("without a declaration, a reformat main's newer change conflicts with is refused, with the hint", () => {
  const r = reformat();
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /declare it instead: a commit with the trailers Regenerate: <command> and Regenerate-files:/);
  assert.equal(show(r, 'a.txt'), 'one\ntwo');
});

test("a declared reformat ships through main's change, alone and holding the line, with the command run again after the rebase", () => {
  // MERGES and a land_rebased of the scheme's own: the Regenerate files join MERGES's attributes, and the hook runs after.
  const local = `MERGES='notes.md main'\nland_rebased() { cat a.txt >"$(git rev-parse --absolute-git-dir)/seen"; }\n`;
  const r = reformat(declare(FMT, '*.txt'), {}, local);
  assert.equal(check(r).status, 0, 'the hand-off check counts the declared conflict as clean');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /declares Regenerate files \(\*\.txt\), so it holds the line/);
  assert.match(res.stderr, /making \*\.txt again on [0-9a-f]+: for f in/);
  assert.equal(show(r, 'a.txt'), 'ONE\nTWO', "main's new line, formatted");
  assert.equal(show(r, 'b.txt'), 'BEE');
  assert.equal(git(r.main, 'log', '-1', '--format=%s', 'main'), `#1: regenerated at ship time: ${FMT}`);
  assert.equal(readFileSync(join(git(r.wt, 'rev-parse', '--absolute-git-dir'), 'seen'), 'utf8'), 'ONE\nTWO\n', 'land_rebased ran on the regenerated files');
});

test('a conflict outside the declared files still refuses, naming that file', () => {
  const r = reformat(declare(FMT, '*.txt'), { 'notes.md': 'branch note\n' });
  write(r.main, { 'notes.md': 'main note\n' }, 'notes: main');
  const c = check(r);
  assert.equal(c.status, 3, c.stderr);
  assert.match(c.stderr, /conflicted files: notes\.md\./);
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.equal(show(r, 'notes.md'), 'main note');
});

test('a declared command that fails, or writes outside its files, refuses and the worktree is put back', () => {
  for (const [cmd, want] of [
    [`${FMT}; echo touched >new.txt; echo formatter broke >&2; exit 4`, /the Regenerate command `.*exit 4` failed \(exit 4\) on the rebased branch, and what it wrote was put back\. Its output ended: formatter broke/],
    [`${FMT}; echo stray >>notes.md; echo made >made.log`, /changed files outside Regenerate-files \(\*\.txt\): (made\.log notes\.md|notes\.md made\.log), and they were put back/],
  ] as const) {
    const r = reformat(declare(cmd, '*.txt'));
    const main = git(r.main, 'rev-parse', 'main');
    const res = r.run();
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, want);
    assert.match(res.stderr, /the Regenerate command failed on the rebased branch \(above\), so main is untouched/);
    assert.equal(git(r.main, 'rev-parse', 'main'), main);
    assert.equal(git(r.wt, 'status', '--porcelain'), '');
    assert.ok(!existsSync(join(r.wt, 'new.txt')) && !existsSync(join(r.wt, 'made.log')));
  }
});

test('a command with no files declared, or files with no command, is refused before anything moves', () => {
  for (const [body, want] of [['Regenerate: true', /a Regenerate: trailer but no Regenerate-files:/], ['Regenerate-files: *.txt', /a Regenerate-files: trailer but no Regenerate: <command>/], [declare('true', '!a.txt'), /plain \.gitattributes patterns, not "!a\.txt"/]] as const) {
    const r = reformat(body);
    const main = git(r.main, 'rev-parse', 'main');
    const res = r.run();
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, want);
    assert.equal(git(r.main, 'rev-parse', 'main'), main);
  }
});
