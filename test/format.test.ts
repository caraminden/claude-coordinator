// The format gate (#1792): every TypeScript and JavaScript file is as Biome (biome.json) writes it, so whitespace
// never makes two branches conflict. The failure message is the way out for a branch that predates the reformat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const bin = join(root, 'node_modules/.bin/biome');

// The way onto main for a branch cut before the reformat (#2007): the same text in every kit copy. Only what the branch
// changed from the formatted old code is replayed, so the reformat itself never conflicts.
const REBASE = `
git update-ref refs/worktree/reformat "$(for r in $(git show main:.git-blame-ignore-revs | grep '^[0-9a-f]'); do git merge-base --is-ancestor $r main && ! git merge-base --is-ancestor $r HEAD && git cat-file -e $r~1:tools/fmt && { echo $r; break; }; done 2>/dev/null)"
git rebase refs/worktree/reformat~1        # your commits, up to just before the reformat
tools/fmt && git commit -qam format --allow-empty
git switch --detach refs/worktree/reformat~1 && tools/fmt && git commit -qam 'the old code, formatted' --allow-empty && git update-ref refs/worktree/old HEAD && git switch -
git switch -C "$(git branch --show-current)" "$(git commit-tree 'HEAD^{tree}' -p refs/worktree/old -m "$(git log -1 --format=%s HEAD~1)")"   # one commit
git rebase --onto refs/worktree/reformat refs/worktree/old
git rebase main
`;

export const FIX = `Run \`tools/fmt --own\` (on main itself: \`tools/fmt\`) and commit the result. A branch cut before the reformat commit that conflicts when it rebases onto main: commit everything, then run these one at a time (each line stands alone; if the second says it knows no such revision, no listed reformat is on main: stop and fix the list), and where a rebase stops, settle each conflict by hand keeping both main's change and yours (never \`-X theirs\` or \`-X ours\`: one drops landed work without a word, the other yours), then \`git rebase --continue\`:
${REBASE}Then \`tools/fmt --own\` again, and commit.`;

test('every .ts, .js and .mjs file is formatted', { skip: !existsSync(bin) && !process.env.CI ? 'Biome is not installed here (run `npm ci`); CI runs this check' : false }, () => {
  assert.ok(existsSync(bin), 'Biome is missing: run `npm ci`');
  const r = spawnSync(bin, ['format', '--max-diagnostics=10', '.'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `${FIX}\n\n${(r.stdout + r.stderr).slice(0, 3000)}`);
});

test('the check is red on an unformatted file and green once formatted', { skip: !existsSync(bin) ? 'Biome is not installed here' : false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'fmt-'));
  try {
    copyFileSync(join(root, 'biome.json'), join(dir, 'biome.json'));
    writeFileSync(join(dir, 'x.ts'), 'const  a = {b:1}\n');
    const run = (...args: string[]) => spawnSync(bin, ['format', ...args, '.'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(run().status, 0);
    assert.equal(run('--write').status, 0);
    assert.equal(readFileSync(join(dir, 'x.ts'), 'utf8'), 'const a = { b: 1 };\n');
    assert.equal(run().status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const read = (p: string) => readFileSync(join(root, p), 'utf8');

test("the kit's biome.json template carries the same style as Citadel's", () => {
  const mine = JSON.parse(read('biome.json'));
  const kit = JSON.parse(read('kit/skills/scheme-setup/templates/biome.config.json'));
  assert.deepEqual(kit.formatter, mine.formatter, 'a style change goes into kit/skills/scheme-setup/templates/biome.config.json too (other schemes copy it)');
  assert.deepEqual(kit.javascript, mine.javascript);
  const rebase = (p: string) => /^const REBASE = `[^`]*`;$/m.exec(read(p))?.[0];
  assert.ok(rebase('test/format.test.ts'));
  assert.equal(rebase('kit/skills/scheme-setup/templates/format.test.ts'), rebase('test/format.test.ts'), 'the way onto main reads the same in both copies');
});

// A hash from before the reformat was rebased onto main sends the way onto main (and git blame) to a commit main lacks (#2007).
test('every commit .git-blame-ignore-revs lists is in this history', () => {
  for (const r of read('.git-blame-ignore-revs').match(/^[0-9a-f]{40}/gm) ?? []) assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', r, 'HEAD'], { cwd: root }).status, 0, r);
});
