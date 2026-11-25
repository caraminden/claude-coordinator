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
// Two ships that change an entry merge by rule: the changes to its number add up and both reasons stay (count, MERGES in tools/land.local.sh, #1917).
// Add your reason at the end. One line per entry (the runner's is older), so the formatter must not break a long one.
// biome-ignore format: one line per entry is what the merge rule reads
export const ALLOWED: Record<string, [number, string]> = {
  'public/core.js': [1514, 'over the line once the Biome reformat (#1792) broke its long lines; a split is queued'],
  'src/ci-health.ts': [1560, 'over the line once the Biome reformat (#1792) broke its long lines; a split is queued'],
  'src/runner.ts': [
    4869,
    'turn runner: spawn, stream, resume and cost in one module; a split into its seams is queued (+1: a message's word on the quick lane, #1986) (+11: busy and a recorded answer its chat reads next turn, #1930) (+5: the state a status line gives, kept on its event, #1923) (+134: cards that outlive their turn, #1916) (+21: types replacing any, #1799) (raised once for the Biome reformat, #1792) (+135: the launch off the main thread and its stop and close deferrals, #1808) (+135: worker-line host, stop, pause, boot and view calls; the line itself is turn-line.ts, #1868) (+43: facts for the order of the line and a keepalive in line, #1888) (+15: the compaction callout wiring; the count is compactions.ts, #1920) (+18: a stop settles the outbox rows it dropped, #1904) (+15: what a killed turn spent and kills together, #1938) (+6: a seal set during a cut-off turn stays, #1958) (+17: where a turn runs, its Stop and its prompt line for the jobs it hands over, #1890) (+6: Start now wiring; the holds are start-now.ts, #1957) (+4: claims pass on at live, two delegations to src/closing.ts, #1985) (+6: the list line for a minion whose CI run is held, #1984)',
  ],
  'tools/land.sh': [3072, 'the ship script is one shell program; its steps share state and are pinned by tests (+141: a red train pulls every likely ship and hands what is left to the next one, #1918) (+177: no-verdict runs, checks for riders and light ships, #1864) (+10: riders heard of their restart, #1865) (+11: the quick-train line, #1912) (+13: a suite stopped at its limit, missing packages, #1863) (+20: a stop finds the run it just pushed, #1894)'],
  'kit/skills/scheme-setup/templates/land.sh': [3018, 'the kit template every scheme copies byte for byte; the schemes skip their copies, so this is the one place its size is counted (+8: the count merge rule, #1917) (+2: ships a person placed, #1827) (+121: wrong refusals, #1866) (+8: the same for a landing, #1894)'],
  'public/machine-agent.mjs': [2518, 'standalone agent a person runs on their own computer: one file so it can be copied alone (raised once for the Biome reformat, #1792) (+43: jobs keep their state across reconnect, Pause and Stop, #1956) (+1: a tick skips a job that ended during its GPU sample, #1964)'],
  'src/routes/projects.ts': [2107, 'every /projects route; split by page is queued (+2: a waiting minion counts as working, #1868) (raised once for the Biome reformat, #1792) (+30: same-scheme Taskmaster message, #1855) (+4: the stale check and its wait for queued saves, #1859) (+2: the claim keep checks, #1985)'],
  'src/tripwire.ts': [1840, 'the tripwire rules; high risk to edit, so a split waits for its own change (raised once for the Biome reformat, #1792) (+10: types replacing any, #1816)'],
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
