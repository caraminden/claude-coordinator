import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { affected, parseMap } from '../tools/affected.ts';

// #2037: a test that reads a source file's text (a snapshot, a budget, a line count, a list it must match) goes red for an
// edit to that file that never touched the test, so a change to the file must pick it: it is on tools/always-tests.txt or
// tools/affected-map.txt picks it for that path. Before this, 13 ship lessons in 2.4 days were such a test failing only on
// the train's CI. On tools/always-tests.txt, so a new test file meets it in its own run.
const repo = join(import.meta.dirname, '..');
const tracked = spawnSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
const isTracked = new Set(tracked);
const map = parseMap(readFileSync(join(repo, 'tools', 'affected-map.txt'), 'utf8'));
const always = new Set(
  readFileSync(join(repo, 'tools', 'always-tests.txt'), 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#')),
);

// The source paths a test reads: on a line that reads a file (readFileSync, a one-line helper around it, readdirSync, git
// ls-files), a tracked path under src/, public/, tools/, kit/ or deploy/, or server.ts, written whole (after any ../) or
// as join()'s parts.
// shortcut: a read split over lines or through a helper of another shape is missed; widen the patterns when one bites.
export function pinnedPaths(text: string, isFile: (p: string) => boolean): string[] {
  const helpers = [...text.matchAll(/const (\w+) = \([^)]*\)(?:: \w+)? => readFileSync\(/g)].map((m) => m[1]);
  const reads = new RegExp(`readFileSync\\(|readdirSync\\(|ls-files${helpers.map((h) => `|\\b${h}\\(`).join('')}`);
  const paths = new Set<string>();
  for (const line of text.split('\n').filter((l) => reads.test(l))) {
    for (const m of line.matchAll(/(?<![\w./-])(?:\.\.\/)*((?:src|public|tools|kit|deploy)\/[\w./-]+\w|server\.ts)\b/g)) if (isFile(m[1])) paths.add(m[1]);
    for (const m of line.matchAll(/'(src|public|tools|kit|deploy)'((?:,\s*'[\w.-]+')+)/g)) {
      const p = [m[1], ...[...m[2].matchAll(/'([\w.-]+)'/g)].map((x) => x[1])].join('/');
      if (isFile(p)) paths.add(p);
    }
  }
  return [...paths];
}

test('the scan finds a source path a test reads, whole, in parts or through a helper, and only on a reading line', () => {
  const files = new Set(['src/a.ts', 'src/db/b.ts', 'tools/land.sh', 'server.ts', 'public/c.js']);
  const text = [
    "const sh = readFileSync(join(repo, 'tools/land.sh'), 'utf8');",
    "const db = readFileSync(join(repo, 'src', 'db', 'b.ts'), 'utf8');",
    "const read = (p: string) => readFileSync(join(repo, p), 'utf8');",
    "assert.ok(read('server.ts').includes('x'));",
    "const w = readFileSync(new URL('../public/c.js', import.meta.url), 'utf8');",
    "spawnSync('node', ['src/a.ts']); // runs it, doesn't read it",
    "readFileSync(join(repo, 'src/gone.ts'));",
  ].join('\n');
  assert.deepEqual(pinnedPaths(text, (p) => files.has(p)).sort(), ['public/c.js', 'server.ts', 'src/db/b.ts', 'tools/land.sh']);
});

test('every test that reads a source file is picked when that file changes, or runs on every run', () => {
  const missed: string[] = [];
  for (const t of tracked.filter((f) => /^test\/[^/]+\.test\.ts$/.test(f) && !always.has(f))) {
    const paths = pinnedPaths(readFileSync(join(repo, t), 'utf8'), (p) => isTracked.has(p));
    const gone = paths.filter((p) => !affected(map, [p], tracked, repo).run.some((r) => r.test === t));
    if (gone.length) missed.push(`${t} reads ${gone.join(', ')}`);
  }
  assert.deepEqual(missed, [], 'add a rule to tools/affected-map.txt (`<path>: <test>`), or put the test on tools/always-tests.txt if it is fast and reads the whole repo');
});
