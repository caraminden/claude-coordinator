import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { changedPaths, coverage, folderOf, isTestOrDoc, ownGlobs } from '../src/review-glance.ts';
import type { ReviewEntry } from '../src/review-set.ts';

const root = mkdtempSync(join(tmpdir(), 'review-glance-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('tests and docs are left out of the hint', () => {
  for (const p of ['test/a.ts', 'src/tests/b.ts', 'app/__tests__/c.js', 'docs/x.html', 'src/a.test.ts', 'lib/b.spec.js', 'README.md', 'kit/skills/x/SKILL.md'])
    assert.ok(isTestOrDoc(p), p);
  for (const p of ['src/server.ts', 'public/app.js', 'testing/x.ts', 'latest/a.ts', 'src/contest.ts'])
    assert.ok(!isTestOrDoc(p), p);
});

test('a gap is named two folders deep where it can be', () => {
  assert.equal(folderOf('app/server/main.ts'), 'app/server');
  assert.equal(folderOf('app/server/deep/x.ts'), 'app/server');
  assert.equal(folderOf('public/app.js'), 'public');
  assert.equal(folderOf('package.json'), '(top)');
});

test("coverage counts what the scheme's own critics watch and ranks the rest by folder", () => {
  const paths = ['public/a.js', 'public/b.css', 'app/server/x.ts', 'app/server/y.ts', 'app/server/x.ts', 'levels/one.json', 'test/a.test.ts', 'docs/a.md'];
  const c = coverage(paths, ['public/**']);
  assert.equal(c.changes, 6, 'test and doc paths are dropped');
  assert.equal(c.watched, 2);
  assert.deepEqual(c.gaps, [{ folder: 'app/server', changes: 3 }, { folder: 'levels', changes: 1 }]);
  assert.deepEqual(coverage([], ['**']), { changes: 0, watched: 0, gaps: [] });
});

test("only the scheme's own critics that are on and watch a diff count", () => {
  const e = (over: Partial<ReviewEntry>) => ({ enabled: true, source: null, triggers: { diff: ['src/**'] }, ...over }) as unknown as ReviewEntry;
  assert.deepEqual(ownGlobs([
    e({}),
    e({ enabled: false, triggers: { diff: ['off/**'] } }),
    e({ source: 'kit:reviewer', triggers: { diff: ['kit/**'] } }),
    e({ source: 'agent:shader-critic', triggers: { diff: ['agent/**'] } }),
    e({ triggers: { ask: true } as any }),
  ]), ['src/**']);
});

test("the last 30 days' changed paths come from git, and no repo or no history is null", async () => {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'app'), { recursive: true });
  const g = (...a: string[]) => execFileSync('git', ['-C', repo, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(join(repo, 'app', 'a.ts'), '1');
  g('add', '.'); g('commit', '-qm', 'one');
  writeFileSync(join(repo, 'app', 'a.ts'), '2'); writeFileSync(join(repo, 'b.ts'), '1');
  g('add', '.'); g('commit', '-qm', 'two');
  assert.deepEqual((await changedPaths(repo))?.sort(), ['app/a.ts', 'app/a.ts', 'b.ts']);
  assert.equal(await changedPaths(null), null);
  assert.equal(await changedPaths(join(root, 'not-a-repo')), null);
});
