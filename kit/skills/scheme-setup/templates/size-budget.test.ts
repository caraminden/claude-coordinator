// Size budget (from the Citadel kit's scheme-setup templates). A source file past LIMIT lines is hard for a minion to
// navigate: it can't read it whole and can't find the seam. This fails when a file under ROOTS is over LIMIT, or when an
// allowed giant grows past its listed size. Set ROOTS and CODE to this repo's source folders and extensions.
// Big files already here are in ALLOWED at their size, each with its reason; they can shrink but not grow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, lstatSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const ROOTS = ['src'];
const CODE = /\.(ts|js|mjs|sh|html|css|ps1|py)$/;
export const LIMIT = 1500;

// Files the Citadel kit syncs into a scheme (src/kit-sync.ts KIT_FILES). A scheme can't usefully edit them and the kit's own
// size budget (Citadel's test/size-budget.test.ts, which counts the kit's copies) owns their size, so a kit sync that grows
// land.sh must not turn this test red. Never list them in ALLOWED. Only the scheme's own files are counted.
export const KIT_SYNCED = new Set(['tools/land.sh', 'tools/guard.sh', '.githooks/pre-push', '.claude/rules/ponytail.md']);

// path -> [lines it may have, why it is allowed]. A split that shrinks a file lowers its number in the same commit.
export const ALLOWED: Record<string, [number, string]> = {
  // Files already over LIMIT when this test was added go here at their current line count, each with a one-line reason:
  // 'src/big.ts': [2100, 'why it is one file'],
};

// Symlinks are skipped on purpose: their target is counted where it really lives.
export function lineCounts(dir = root): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (rel: string) => {
    if (!existsSync(join(dir, rel))) return; // a root this repo lacks
    for (const e of readdirSync(join(dir, rel))) {
      if (e === 'node_modules') continue;
      const path = `${rel}/${e}`;
      if (KIT_SYNCED.has(path)) continue;
      const st = lstatSync(join(dir, path));
      if (st.isDirectory()) walk(path);
      else if (st.isFile() && CODE.test(e)) out[path] = readFileSync(join(dir, path), 'utf8').split('\n').length - 1;
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
}

export function overBudget(counts: Record<string, number>, allowed = ALLOWED, limit = LIMIT): string[] {
  const bad: string[] = [];
  for (const [path, n] of Object.entries(counts)) {
    const cap = allowed[path]?.[0] ?? limit;
    if (n > cap) bad.push(`${path}: ${n} lines, limit ${cap}${allowed[path] ? ' (its ALLOWED size)' : ''}`);
  }
  return bad;
}

const HELP = `Split the file along a seam (one concern per module, then add its row to the README Layout table), or, if a split truly doesn't fit,
add or raise its entry in ALLOWED in this file with a one-line reason.`;

test(`no source file under ROOTS is over ${LIMIT} lines unless ALLOWED lists it`, () => {
  assert.deepEqual(overBudget(lineCounts()), [], HELP);
});

test('an ALLOWED entry names a file that exists and is still over the limit', () => {
  const counts = lineCounts();
  const stale = Object.entries(ALLOWED)
    .filter(([p, [n]]) => !(p in counts) || counts[p]! <= LIMIT || n <= LIMIT)
    .map(([p]) => p);
  assert.deepEqual(stale, [], 'remove the entry: the file is gone or now within the limit');
});

test('the check fails on growth past the limit or past an allowed size, and passes at or under them', () => {
  assert.deepEqual(overBudget({ 'a.ts': 1500 }, {}, 1500), []);
  assert.equal(overBudget({ 'a.ts': 1501 }, {}, 1500).length, 1);
  assert.equal(overBudget({ 'big.ts': 3001 }, { 'big.ts': [3000, 'x'] }, 1500).length, 1);
  assert.deepEqual(overBudget({ 'big.ts': 2000 }, { 'big.ts': [3000, 'x'] }, 1500), []);
});

test('a kit-synced file over the limit is not counted, and the scheme\'s own big file still is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'size-budget-'));
  try {
    const big = 'x\n'.repeat(LIMIT + 10);
    for (const f of ['tools/land.sh', 'src/own.ts']) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), big);
    }
    const counts = lineCounts(dir);
    assert.ok(!('tools/land.sh' in counts), 'tools/land.sh is kit-synced, so it is skipped');
    assert.equal(counts['src/own.ts'], LIMIT + 10);
    assert.equal(overBudget(counts, {}, LIMIT).length, 1, 'the scheme\'s own file is still over budget');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
