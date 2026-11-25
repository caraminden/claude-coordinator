// A source file past LIMIT lines is hard for a minion to navigate: it can't read it whole and can't find the seam (#1786).
// This fails when a file in src/, public/ or tools/ is over LIMIT, or when an allowed giant grows past its listed size.
// Big files already here are in ALLOWED at their size, each with its reason; they can shrink but not grow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const ROOTS = ['src', 'public', 'tools', 'kit'];
const CODE = /\.(ts|js|mjs|sh|html|css|ps1|py)$/;
export const LIMIT = 1500;

// path -> [lines it may have, why it is allowed]. A split that shrinks a file lowers its number in the same commit.
export const ALLOWED: Record<string, [number, string]> = {
  'public/core.js': [1514, 'over the line once the Biome reformat (#1792) broke its long lines; a split is queued'],
  'src/ci-health.ts': [1560, 'over the line once the Biome reformat (#1792) broke its long lines; a split is queued'],
  'src/runner.ts': [
    5614,
    'turn runner: spawn, stream, resume and cost in one module; a split into its seams is queued (+21: types replacing any, #1799) (raised once for the Biome reformat, #1792) (+135: the launch off the main thread and its stop and close deferrals, #1808) (+135: worker-line host, stop, pause, boot and view calls; the line itself is turn-line.ts, #1868) (+43: facts for the order of the line and a keepalive in line, #1888) (+15: the compaction callout wiring; the count is compactions.ts, #1920)',
  ],
  'src/mcp.ts': [2922, 'every MCP tool definition and handler; split by tool family is queued (+1: the worker wait in a minion line, #1868) (+5: apply_memory, #1803) (raised once for the Biome reformat, #1792) (+17: mark_urgent, #1888) (+3: same-scheme person text, #1855) (+1: before and first, #1909)'],
  'src/db.ts': [1703, 'schema, migrations and settings; its queries are moving to src/db/<area>.ts, a piece at a time (#1842; 1683 plus room for the ships waiting in line beside it, tightened next piece)'],
  'tools/land.sh': [2841, 'the ship script is one shell program; its steps share state and are pinned by tests (+141: a red train pulls every likely ship and hands what is left to the next one, #1918)'],
  'kit/skills/scheme-setup/templates/land.sh': [2879, 'the kit template every scheme copies byte for byte; the schemes skip their copies, so this is the one place its size is counted'],
  'public/machine-agent.mjs': [2474, 'standalone agent a person runs on their own computer: one file so it can be copied alone (raised once for the Biome reformat, #1792)'],
  'src/routes/projects.ts': [2105, 'every /projects route; split by page is queued (+2: a waiting minion counts as working, #1868) (raised once for the Biome reformat, #1792) (+30: same-scheme Taskmaster message, #1855) (+4: the stale check and its wait for queued saves, #1859)'],
  'src/tripwire.ts': [1830, 'the tripwire rules; high risk to edit, so a split waits for its own change (raised once for the Biome reformat, #1792)'],
  'src/routes/tickets.ts': [1936, 'every /tickets route; split by page is queued (+19: #1823 unchain, +13: card types replacing any, #1799) (raised once for the Biome reformat, #1792) (+3: a hand-off and a deploy report move its place in line, #1888)'],
  'tools/dev-seeds.ts': [2104, 'seed data for dev copies; grows with every table (raised once for the Biome reformat, #1792)'],
};

// Symlinks are skipped on purpose: their target is counted where it really lives.
export function lineCounts(dir = root): Record<string, number> {
  const out: Record<string, number> = {};
  const walk = (rel: string) => {
    if (!existsSync(join(dir, rel))) return; // a root this repo lacks
    for (const e of readdirSync(join(dir, rel))) {
      if (e === 'node_modules') continue;
      const path = `${rel}/${e}`;
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
add or raise its entry in ALLOWED in test/size-budget.test.ts with a one-line reason.`;

test(`no source file in src, public, tools or kit is over ${LIMIT} lines unless ALLOWED lists it`, () => {
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
