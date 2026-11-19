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

// An inline poll: a `for`/`while` whose whole body is one sleep, so a timeout falls through and the failure shows up later
// as a vaguer assert. Use `until('<what>', () => cond)`. A loop that polls on purpose for "nothing happened" says so with
// `// poll-ok: <why>` on its row or the row above. A loop with an assert in it (or a block body) fails on its own timeout.
const SLEEP = /^\s*(?:for|while)\s*\(.*\bsetTimeout\b/;
const POLL_OK = /\/\/\s*poll-ok:\s*\S/;

/** "file:line" for each inline sleep-poll loop this text has. */
export function inlinePolls(file: string, text: string): string[] {
  const rows = text.split('\n');
  return rows.flatMap((row, i) => {
    if (!SLEEP.test(row) || /\{\s*$/.test(row) || /\b(?:assert|throw)\b/.test(row)) return [];
    if (POLL_OK.test(row) || POLL_OK.test(rows[i - 1] ?? '')) return [];
    return [`${file}:${i + 1}`];
  });
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

test("no test file polls with an inline sleep loop: use `until('<what>', () => cond)` from './wait.ts'", () => {
  const hits = readdirSync(dir)
    .filter((f) => /\.(ts|js)$/.test(f) && !EXEMPT.has(f))
    .flatMap((f) => inlinePolls(f, readFileSync(join(dir, f), 'utf8')));
  assert.deepEqual(hits, [], `${hits.join(', ')}: an inline poll loop falls through silently on a timeout. Use until('<what>', () => cond) from ./wait.ts, or mark a deliberate "nothing happened" poll with // poll-ok: <why>.`);
});

test('the inline-poll guard flags sleep loops and leaves look-alikes alone', () => {
  const poll = 'for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));';
  assert.deepEqual(inlinePolls('a.ts', `${poll}\n  while (!ok()) await new Promise((r) => setTimeout(r, 5));\nfor (const end = 1; !ok() && Date.now() < end;) await new Promise((r) => setTimeout(r, 5));`), ['a.ts:1', 'a.ts:2', 'a.ts:3']);
  // a single fixed sleep, a loop that asserts on timeout, a block body, and a marked deliberate poll
  assert.deepEqual(inlinePolls('a.ts', "await new Promise((r) => setTimeout(r, 200));\nfor (const end = 1; !ok(); await new Promise((r) => setTimeout(r, 50))) assert.ok(Date.now() < end);\nfor (let i = 0; i < 9; i++) {\n  await new Promise((r) => setTimeout(r, 5));\n}\nfor (const f of fs) await run(f);"), []);
  assert.deepEqual(inlinePolls('a.ts', `// poll-ok: nothing should happen\n${poll}\n${poll} // poll-ok: still nothing`), []);
});
