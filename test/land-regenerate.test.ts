// Regenerated files (#1827): a ship whose diff is a command's output declares it with the trailers Regenerate: and
// Regenerate-files:, and tools/land.sh takes main's side of those files where they conflict, runs the command again
// on main after the rebase and commits what it wrote, instead of refusing the ship on the conflict.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { env, git, setup } from './land-fixture.ts';

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
// main with two .txt files and a note; the branch formats the .txt files (declared or not), and main then changes
// a.txt, which conflicts with the formatted copy.
function reformat(body?: string, extra: Record<string, string> = {}) {
  const r = setup();
  write(r.source, { 'a.txt': 'one\n', 'b.txt': 'bee\n', 'notes.md': 'note\n' }, 'base files');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  write(r.wt, { 'a.txt': 'ONE\n', 'b.txt': 'BEE\n', ...extra }, '#1: format the txt files', body);
  write(r.source, { 'a.txt': 'one\ntwo\n' }, 'a.txt: two');
  return r;
}
const show = (r: R, ref: string, f: string) => git(r.source, 'show', `${ref}:${f}`);

test("without a declaration, a reformat main's newer change conflicts with is refused (today's behaviour)", () => {
  const r = reformat();
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /conflicted files: a\.txt\..*declare it instead: a commit with the trailers Regenerate: <command> and Regenerate-files:/);
  assert.equal(show(r, 'main', 'a.txt'), 'one\ntwo');
});

test("a declared reformat ships through main's change: the files take main's side and the command runs again on main", () => {
  const r = reformat(declare(FMT, '*.txt'));
  assert.equal(r.run({}, ['--check']).status, 0, 'the hand-off check counts the declared conflict as clean');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /making \*\.txt again on main \([0-9a-f]+\): for f in/);
  assert.equal(show(r, 'main', 'a.txt'), 'ONE\nTWO', "main's new line, formatted");
  assert.equal(show(r, 'main', 'b.txt'), 'BEE');
  assert.equal(git(r.source, 'log', '-1', '--format=%s', 'main'), `#1: regenerated at ship time: ${FMT}`);
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
});

test('a conflict outside the declared files still refuses, naming that file', () => {
  const r = reformat(declare(FMT, '*.txt'), { 'notes.md': 'branch note\n' });
  write(r.source, { 'notes.md': 'main note\n' }, 'notes: main');
  const check = r.run({}, ['--check']);
  assert.equal(check.status, 3, check.stderr);
  assert.match(check.stderr, /conflicted files: notes\.md\./);
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /conflicted files: notes\.md\./);
  assert.equal(show(r, 'main', 'notes.md'), 'main note');
});

test('a declared command that fails refuses with the end of its output, and the worktree is put back', () => {
  const r = reformat(declare(`${FMT}; echo touched >new.txt; echo formatter broke >&2; exit 4`, '*.txt'));
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /the Regenerate command `.*exit 4` failed \(exit 4\) on main \([0-9a-f]+\), so nothing landed and what it wrote was put back\. Its output ended: formatter broke/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(r.wt, 'new.txt')));
});

test('a declared command that writes outside its files refuses, naming them, and they are put back', () => {
  const r = reformat(declare(`${FMT}; echo stray >>notes.md; echo made >made.log`, '*.txt'));
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /changed files outside Regenerate-files \(\*\.txt\): (made\.log notes\.md|notes\.md made\.log), so nothing landed/);
  assert.equal(readFileSync(join(r.wt, 'notes.md'), 'utf8'), 'note\n');
  assert.ok(!existsSync(join(r.wt, 'made.log')));
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
});

test('a command with no files declared, or files with no command, is refused before anything moves', () => {
  for (const [body, want] of [['Regenerate: true', /a Regenerate: trailer but no Regenerate-files:/], ['Regenerate-files: *.txt', /a Regenerate-files: trailer but no Regenerate: <command>/], [declare('true', '!a.txt'), /plain \.gitattributes patterns, not "!a\.txt"/]] as const) {
    const r = reformat(body);
    const main = git(r.source, 'rev-parse', 'main');
    const res = r.run();
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, want);
    assert.equal(git(r.source, 'rev-parse', 'main'), main);
  }
});

test('a declared generated file with no conflict is made again on main all the same, and an unchanged result adds no commit', () => {
  const r = setup();
  write(r.source, { 'list.txt': 'b\na\n', 'gen.out': 'a\nb\n' }, 'list and its sorted copy');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  write(r.wt, { 'other.md': 'x\n' }, '#1: other', declare('sort list.txt >gen.out', 'gen.out'));
  write(r.source, { 'list.txt': 'c\nb\na\n' }, 'list: c, without its copy made again');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(show(r, 'main', 'gen.out'), 'a\nb\nc');
  const r2 = setup();
  write(r2.source, { 'gen.out': '\n' }, 'gen');
  git(r2.wt, 'merge', '-q', '--ff-only', 'main');
  write(r2.wt, { 'other.md': 'x\n' }, '#1: other', declare('true', 'gen.out'));
  assert.equal(r2.run().status, 0);
  assert.equal(git(r2.source, 'log', '-1', '--format=%s', 'main'), '#1: other');
});

test("a declared commit the rebase empties still ships its command when the rebase brought a newer land.sh, which runs over", () => {
  // The branch's only commit formats a.txt, and main changed a.txt: the driver takes main's side, the commit drops out of
  // the rebase, and land.sh starts over as the rebased copy. The trailers come from the branch as it was before the rebase.
  const r = setup();
  const tools = join(import.meta.dirname, '..', 'tools');
  for (const f of readdirSync(tools, { withFileTypes: true })) if (f.isFile() && f.name !== 'deploy.sh') copyFileSync(join(tools, f.name), join(r.source, 'tools', f.name));
  write(r.source, {}, 'the real tools');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  write(r.wt, { 'a.txt': 'ONE\n' }, '#1: format a.txt', declare(FMT, '*.txt'));
  write(r.source, { 'a.txt': 'one\ntwo\n' }, 'a.txt: two');
  write(r.source, { 'tools/land.sh': readFileSync(join(r.source, 'tools', 'land.sh'), 'utf8') + '# newer\n' }, 'a newer land.sh');
  const res = spawnSync('bash', [join(r.wt, 'tools', 'land.sh')], { cwd: r.wt, encoding: 'utf8', timeout: 90_000, env: { ...env, DEPLOY_LIVE: r.live, DEPLOY_SOURCE: r.source, DEPLOY_NOTE: join(r.dir, 'note') } });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(show(r, 'main', 'a.txt'), 'ONE\nTWO');
  assert.equal(git(r.source, 'log', '-1', '--format=%s', 'main'), `#1: regenerated at ship time: ${FMT}`);
});
