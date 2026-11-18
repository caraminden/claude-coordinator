// A guard: test/wait.ts is the one `until` for tests. A file that defines its own copy gets a loop with a different
// timeout and no `what` in its failure; import the shared one instead.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const dir = import.meta.dirname;
const COPY = /^\s*(?:export\s+)?(?:async\s+)?function\s+until\b|^\s*(?:export\s+)?const\s+until\s*=\s*async\b/;
// rail-browser's `until` polls a page, not a condition: it is a different thing with the same name.
const EXEMPT = new Set(['wait.ts', 'one-until.test.ts', 'rail-browser.test.ts']);

/** "file:line" for each own `until` this text defines. */
export function untilCopies(file: string, text: string): string[] {
  return text.split('\n').flatMap((row, i) => (COPY.test(row) ? [`${file}:${i + 1}`] : []));
}

test("no test file defines its own `until`: import it from './wait.ts'", () => {
  const hits = readdirSync(dir)
    .filter((f) => /\.(ts|js)$/.test(f) && !EXEMPT.has(f))
    .flatMap((f) => untilCopies(f, readFileSync(join(dir, f), 'utf8')));
  assert.deepEqual(hits, [], `${hits.join(', ')}: test/wait.ts is the one \`until\`. Import it (import { until } from './wait.ts') and give each wait a \`what\`.`);
});

test('the guard sees both shapes of a copy and leaves the shared one and look-alikes alone', () => {
  assert.deepEqual(untilCopies('a.ts', 'async function until(check: () => boolean) {\n}\nconst until = async (ok) => {};\nfunction until() {}'), ['a.ts:1', 'a.ts:3', 'a.ts:4']);
  assert.deepEqual(untilCopies('a.ts', "import { until } from './wait.ts';\nconst until = performance.now() + 5;\nawait until('x', () => 1);\nconst untilLayer = async () => {};"), []);
});
