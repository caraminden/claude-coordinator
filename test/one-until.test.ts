// A guard: test/wait.ts is the one `until` for tests. A file that defines its own copy gets a loop with a different
// timeout and no `what` in its failure; import the shared one instead.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

// ---- Flake-prone patterns (#1442): counted per file, never allowed to rise ----
// Five patterns that make a test pass or fail by timing. test/flake-baseline.json holds today's count per file and
// pattern (`n` bare hits, `ok` hits with a `// timing-ok: <why>` on the row or the row above). A count that rises, or a new
// file with any, fails; so does one that falls without the baseline being lowered, so the numbers only go down.
// After you fix or mark one: `FLAKE_BASELINE=write node test/one-until.test.ts`, and commit the JSON.
export const FLAKE_RULES: Record<string, { re: (row: string) => boolean; why: string }> = {
  sleep: {
    re: (r) => /\bawait\b.*\bsetTimeout\b|\bawait\s+(?:sleep|delay|nap|pause)\w*\(\s*\d/.test(r),
    why: 'a bare sleep guesses how long the thing takes. Wait on its done signal: until(\'<what>\', () => cond) from ./wait.ts; to show nothing happens, do a second action and wait for that.',
  },
  elapsed: {
    re: (r) => /\bassert\b.*(?:(?:Date|performance)\.now\(\)\s*-|\belapsed\w*|\btook\w*|\bwaitedMs\b|\bduration\w*|\.ms\b)[^;]*?<=?\s*\d/.test(r),
    why: 'asserting that something was fast fails on a busy box. A deadline means "it hung": give until(..) the wait, or inject a clock and assert on its ticks.',
  },
  freePort: {
    re: (r) => /\bfreePort\(/.test(r),
    why: 'a picked port can be taken between the pick and the bind. Listen on port 0 and read the port the server reports.',
  },
  shortUntil: {
    re: (r) => {
      const m = /\buntil\(.*,\s*(\d[\d_]*)\s*(?:,\s*\(\)\s*=>[^]*)?\)/.exec(r);
      const ms = m ? Number(m[1].replace(/_/g, '')) : 0;
      return ms >= 100 && ms < 30_000;
    },
    why: 'a deadline under until\'s 30 s default fails when the box is loaded. Drop the number; a deadline means "it hung".',
  },
  rmTemp: {
    re: (r) => /\brmSync\(.*recursive:\s*true/.test(r),
    why: 'a hand-rolled recursive delete skips the leak check and races a child still writing. Let bootServer or stopTurns (./helpers.ts) tear down.',
  },
};
const TIMING_OK = /\/\/\s*timing-ok:\s*\S/;
const BASELINE = join(dir, 'flake-baseline.json');
const FLAKE_EXEMPT = new Set(['wait.ts', 'helpers.ts', 'one-until.test.ts']);

type Counts = Record<string, { n: number; ok: number }>;
type Hits = Record<string, { bare: number[]; ok: number[] }>;

/** Per pattern, the 1-based rows with a bare hit and the rows with a `timing-ok` escape. */
export function flakeHits(text: string): Hits {
  const rows = text.split('\n');
  const out: Hits = {};
  rows.forEach((row, i) => {
    if (/^\s*\/\//.test(row)) return;
    for (const [name, rule] of Object.entries(FLAKE_RULES)) {
      if (!rule.re(row)) continue;
      const escaped = TIMING_OK.test(row) || TIMING_OK.test(rows[i - 1] ?? '');
      ((out[name] ??= { bare: [], ok: [] })[escaped ? 'ok' : 'bare']).push(i + 1);
    }
  });
  return out;
}

function flakeScan(): Record<string, Hits> {
  const all: Record<string, Hits> = {};
  for (const f of readdirSync(dir).sort()) {
    if (!/\.(ts|js)$/.test(f) || FLAKE_EXEMPT.has(f)) continue;
    const h = flakeHits(readFileSync(join(dir, f), 'utf8'));
    if (Object.keys(h).length) all[f] = h;
  }
  return all;
}

const toCounts = (all: Record<string, Hits>): Record<string, Counts> =>
  Object.fromEntries(Object.entries(all).map(([f, h]) => [f, Object.fromEntries(Object.entries(h).map(([p, v]) => [p, { n: v.bare.length, ok: v.ok.length }]))]));

/** Problems when `now` differs from `base`: a rise names its rows, a fall asks for the baseline to be lowered. */
export function flakeProblems(all: Record<string, Hits>, base: Record<string, Counts>): string[] {
  const problems: string[] = [];
  const files = new Set([...Object.keys(all), ...Object.keys(base)]);
  for (const f of [...files].sort()) {
    for (const p of Object.keys(FLAKE_RULES)) {
      const have = all[f]?.[p] ?? { bare: [], ok: [] };
      const was = base[f]?.[p] ?? { n: 0, ok: 0 };
      if (have.bare.length > was.n) {
        const rows = have.bare.map((l) => `${f}:${l}`).join(', ');
        problems.push(`${rows}: ${have.bare.length} \`${p}\` hits, the baseline allows ${was.n}. ${FLAKE_RULES[p].why} If it truly must stay, add \`// timing-ok: <why>\` on its row or the row above.`);
      } else if (have.bare.length < was.n) {
        problems.push(`${f}: \`${p}\` fell from ${was.n} to ${have.bare.length}. Lower the baseline: FLAKE_BASELINE=write node test/one-until.test.ts`);
      }
      if (have.ok.length !== was.ok) {
        problems.push(`${f}: \`${p}\` has ${have.ok.length} \`timing-ok\` escapes, the baseline has ${was.ok}. Record them: FLAKE_BASELINE=write node test/one-until.test.ts`);
      }
    }
  }
  return problems;
}

if (process.env.FLAKE_BASELINE === 'write') {
  writeFileSync(BASELINE, `${JSON.stringify(toCounts(flakeScan()), null, 1)}\n`);
  console.log(`wrote ${BASELINE}`);
}

test('no test file adds a timing-dependent pattern past test/flake-baseline.json (rules: .claude/rules/tests.md)', () => {
  const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, Counts>;
  const problems = flakeProblems(flakeScan(), base);
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});

test('the flake guard finds each pattern, honours timing-ok, and holds the number down', () => {
  const text = [
    'await new Promise((r) => setTimeout(r, 50));',
    'assert.ok(Date.now() - t0 < 3000, "fast");',
    'const port = await freePort();',
    "await until('x', () => ok(), 5_000);",
    'rmSync(root, { recursive: true, force: true });',
    '// timing-ok: the sleep is the thing under test',
    'await new Promise((r) => setTimeout(r, 50));',
    "await until('x', () => a.slice(0, 2));",
    "await until('x', () => ok(), 60_000);",
    "// await new Promise((r) => setTimeout(r, 50));",
  ].join('\n');
  const h = flakeHits(text);
  assert.deepEqual(Object.fromEntries(Object.entries(h).map(([p, v]) => [p, [v.bare, v.ok]])), {
    sleep: [[1], [7]], elapsed: [[2], []], freePort: [[3], []], shortUntil: [[4], []], rmTemp: [[5], []],
  });
  const base = toCounts({ 'a.ts': h });
  assert.deepEqual(flakeProblems({ 'a.ts': h }, base), []);
  assert.match(flakeProblems({ 'a.ts': h, 'b.ts': h }, base).join('\n'), /b\.ts:1.*sleep.*until\(/);
  assert.match(flakeProblems({}, base).join('\n'), /a\.ts: `sleep` fell from 1 to 0\. Lower the baseline/);
  const noEscape = flakeHits('await new Promise((r) => setTimeout(r, 50));');
  assert.match(flakeProblems({ 'a.ts': noEscape }, base).join('\n'), /escapes/);
});
