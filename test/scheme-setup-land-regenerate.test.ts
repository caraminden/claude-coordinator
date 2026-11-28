// Regenerated files (#1827) on the scheme-setup template land.sh: the cases both ship scripts share are in
// regenerate-cases.ts; these are the ones only the template says or has. Such a ship holds the line and ships alone.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { env, git, setup } from './scheme-setup-land-fixture.ts';
import { FMT, declare, reformat as reformatOn, regenerateCases, write as writeWith } from './regenerate-cases.ts';

const sideOf = (local?: string) => ({
  name: 'the kit template',
  git,
  setup: () => {
    const r = setup('true', {}, local);
    return { ...r, check: () => spawnSync('bash', [join(r.wt, 'tools', 'land.sh'), '--check'], { cwd: r.wt, encoding: 'utf8', timeout: 90_000, env }) };
  },
  failed: /the Regenerate command `.*exit 4` failed \(exit 4\) on the rebased branch, and what it wrote was put back\. Its output ended: formatter broke/,
  outside: /changed files outside Regenerate-files \(\*\.txt\): (made\.log notes\.md|notes\.md made\.log), and they were put back/,
  refused: /the Regenerate command failed on the rebased branch \(above\), so main is untouched/,
});
regenerateCases(sideOf());

const write = (where: string, files: Record<string, string>, msg: string, body?: string) => writeWith(git, where, files, msg, body);
const reformat = (body: string, local: string) => reformatOn(sideOf(local), body);
const show = (r: { main: string }, f: string) => git(r.main, 'show', `main:${f}`);

test("a declared reformat ships through main's change, alone and holding the line, with the command run again after the rebase", () => {
  // MERGES and a land_rebased of the scheme's own: the Regenerate files join MERGES's attributes, and the hook runs after.
  const local = `MERGES='notes.md main'\nland_rebased() { cat a.txt >"$(git rev-parse --absolute-git-dir)/seen"; }\n`;
  const r = reformat(declare(FMT, '*.txt'), local);
  assert.equal(r.check().status, 0, 'the hand-off check counts the declared conflict as clean');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /declares Regenerate files \(\*\.txt\), so it holds the line/);
  assert.match(res.stderr, /making \*\.txt again on [0-9a-f]+: for f in/);
  assert.equal(show(r, 'a.txt'), 'ONE\nTWO', "main's new line, formatted");
  assert.equal(show(r, 'b.txt'), 'BEE');
  assert.equal(git(r.main, 'log', '-1', '--format=%s', 'main'), `#1: regenerated at ship time: ${FMT}`);
  assert.equal(readFileSync(join(git(r.wt, 'rev-parse', '--absolute-git-dir'), 'seen'), 'utf8'), 'ONE\nTWO\n', 'land_rebased ran on the regenerated files');
});

// The template's only, from its fix for refusing ships as lost their titles (#1866); Citadel's lost-title check is
// tools/land/prepare.sh's and is not this case.
test("a refused ship's regenerated commit leaves with it, so titles ending in (#N) aren't refused as lost on the next try", () => {
  // The check fails once, after the command ran.
  const r = setup('[ -e "$(git rev-parse --absolute-git-dir)/tried" ] || { touch "$(git rev-parse --absolute-git-dir)/tried"; exit 1; }', {});
  write(r.wt, { 'a.txt': 'ONE\n' }, 'format the txt files (#1)', declare(FMT, '*.txt'));
  write(r.main, { 'b.txt': 'bee\n' }, 'b.txt');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /making \*\.txt again/);
  assert.equal(git(r.wt, 'log', '-1', '--format=%s'), 'format the txt files (#1)', 'the branch is left without the commit the script made');
  assert.equal(git(r.wt, 'branch', '--show-current'), 'ticket/1-x');
  const again = r.run();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(show(r, 'b.txt'), 'BEE');
});
