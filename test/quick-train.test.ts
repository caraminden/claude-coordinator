import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { CAP, pipelinePaths, sensitive, why, type Ship } from '../tools/quick-train.ts';
import { git } from './git.ts';

// tools/quick-train.ts (#1912): who would ride the quick train. Judged and logged, never acted on yet.
const root = mkdtempSync(join(tmpdir(), 'quick-train-'));
after(() => rmSync(root, { recursive: true, force: true }));
const tool = join(import.meta.dirname, '..', 'tools', 'quick-train.ts');
const PIPE = ['tools/land.sh', 'kit/skills/scheme-setup/templates/', 'test/land.test.ts'];
const ship = (over: Partial<Ship> = {}): Ship => ({ risk: 'low', lane: 'full', changed: ['public/app.js'], pipeline: PIPE, unmapped: [], tests: 10, ...over });

test('a low ship with plain files, a known map and few tests qualifies', () => {
  assert.deepEqual(why(ship()), []);
  assert.deepEqual(why(ship({ tests: CAP })), [], 'the cap itself still qualifies');
});

test('each failed condition is named', () => {
  assert.deepEqual(why(ship({ risk: 'medium' })), ['risk medium']);
  assert.deepEqual(why(ship({ risk: undefined })), ['no risk label'], 'a ship with no label is never low');
  assert.deepEqual(why(ship({ unmapped: ['docs/a.html'] })), ['not in the test map (docs/a.html)']);
  assert.deepEqual(why(ship({ tests: CAP + 1 })), [`${CAP + 1} test files picked, over ${CAP}`]);
  assert.deepEqual(why(ship({ changed: ['public/app.js', 'tools/land.sh'] })), ['sensitive: pipeline (tools/land.sh)']);
  assert.deepEqual(why(ship({ risk: 'high', unmapped: ['x'], changed: ['x', 'src/db/a.ts', 'src/db/b.ts', 'src/db/c.ts'] })), ['risk high', 'sensitive: saved data (src/db/a.ts, src/db/b.ts +1)', 'not in the test map (x)']);
});

test('a light-lane ship says so and nothing else: it runs no tests as today', () => {
  assert.match(why(ship({ lane: 'light', risk: undefined, changed: ['docs/a.md'], unmapped: ['docs/a.md'] }))[0], /^light lane/);
});

test('the sensitive list covers each kind, and a low label never overrides it', () => {
  const kind = (p: string) => sensitive(p, PIPE);
  for (const [p, want] of [
    ['tools/land.sh', 'pipeline'],
    ['tools/pipeline-files.txt', 'pipeline'],
    ['deploy/x.service', 'pipeline'],
    ['.github/workflows/tests.yml', 'pipeline'],
    ['src/db.ts', 'saved data'],
    ['src/db/tickets.ts', 'saved data'],
    ['src/db-schema.ts', 'saved data'],
    ['src/backup-flag.ts', 'saved data'],
    ['src/auth.ts', 'sign-in and access'],
    ['src/tripwire-git.ts', 'tripwire'],
    ['tools/guard.sh', 'tripwire'],
    ['src/hook-run.ts', 'tripwire'],
    ['src/claude-link.ts', 'turn start'],
    ['kit/skills/scheme-setup/templates/land.sh', 'pipeline'],
    ['src/runner.ts', 'turn start'],
    ['server.ts', 'turn start'],
    ['public/ui/chat.js', 'Citadel UI contract'],
    ['test/ui-contract.json', 'Citadel UI contract'],
  ] as const)
    assert.equal(kind(p), want, p);
  for (const p of ['public/app.js', 'src/secrets.ts', 'src/db-view-helpers.ts', 'docs/x.md', 'src/land-news.ts']) assert.equal(kind(p), null, p);
});

test("the pipeline list's comments and blank lines are not paths", () => {
  assert.deepEqual(pipelinePaths('# a note\ntools/a.sh # why\n\nkit/b/\n'), ['tools/a.sh', 'kit/b/']);
});

// The CLI, on a small repo: main's lists decide, the branch's own don't.
const repo = join(root, 'repo');
mkdirSync(repo);
const put = (f: string, text: string) => {
  mkdirSync(dirname(join(repo, f)), { recursive: true });
  writeFileSync(join(repo, f), text);
};
const commit = (msg: string) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', msg);
};
const answer = (args: string[] = ['--risk', 'low']) => {
  const r = spawnSync(process.execPath, [tool, '--main', 'main', '--base', git(repo, 'merge-base', 'main', 'HEAD'), ...args], { cwd: repo, encoding: 'utf8' });
  return { out: r.stdout.trim(), status: r.status, err: r.stderr };
};

git(root, 'init', '-q', '-b', 'main', repo);
put('tools/pipeline-files.txt', 'tools/land.sh\n');
put('tools/affected-map.txt', '@tests test/*.test.ts\nsrc/*.ts: test/a.test.ts\n');
put('tools/lanes', 'light docs/*\n');
put('src/a.ts', 'export {};\n');
put('test/a.test.ts', '');
commit('start');
git(repo, 'checkout', '-qb', 'ship');

test('the CLI answers for a branch', () => {
  put('src/a.ts', 'export const a = 1;\n');
  commit('a');
  assert.deepEqual(answer().out, 'would qualify');
  assert.equal(answer(['--risk', '']).out, 'not: no risk label');
  put('README.md', 'x');
  commit('b');
  assert.equal(answer().out, 'not: not in the test map (README.md)');
});

test('the CLI asks the light lane first', () => {
  git(repo, 'checkout', '-qb', 'docs', 'main');
  put('docs/a.md', 'x');
  commit('docs');
  assert.match(answer().out, /^not: light lane/);
  assert.equal(answer(['--risk', 'low', '--mode', 'build']).out, 'not: not in the test map (docs/a.md)', "a build's own ship is always the full lane");
  git(repo, 'checkout', '-q', 'ship');
});

test("a branch can't loosen main's lists, and an unreadable base exits 2", () => {
  put('tools/land.sh', 'echo\n');
  put('tools/pipeline-files.txt', '\n');
  commit('c');
  assert.match(answer().out, /^not: .*sensitive: pipeline \(tools\/land\.sh, tools\/pipeline-files\.txt\)/);
  const bad = spawnSync(process.execPath, [tool, '--main', 'main', '--base', 'no-such-ref'], { cwd: repo, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.equal(bad.stdout, '');
});
