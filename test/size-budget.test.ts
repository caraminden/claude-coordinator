// A source file past LIMIT lines is hard for a minion to navigate: it can't read it whole and can't find the seam (#1786).
// This fails when a file in src/, public/ or tools/ is over LIMIT, or when an allowed giant grows past its listed size.
// Big files already here are in ALLOWED at their size, each with its reason; they can shrink but not grow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, lstatSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(import.meta.dirname, '..');
const ROOTS = ['src', 'public', 'tools', 'kit'];
const CODE = /\.(ts|js|mjs|sh|html|css|ps1|py)$/;
export const LIMIT = 1500;

// path -> [lines it may have, why it is allowed]. A split that shrinks a file lowers its number in the same commit.
// Two ships that change an entry merge by rule: the changes to its number add up and both reasons stay (count, MERGES in tools/land.local.sh, #1917).
// Add your reason at the end. One line per entry (the runner's is older), so the formatter must not break a long one.
// biome-ignore format: one line per entry is what the merge rule reads
export const ALLOWED: Record<string, [number, string]> = {
  'public/reviews.js': [1662, 'the Reviewers and critics page (+162: JSDoc types replacing implicit any, #2023)'],
  'public/settings.js': [1609, "a scheme's settings pages (+109: JSDoc types replacing implicit any, #2023)"],
  'public/core.js': [1523, '(+1: cabal cards arrive like build headers, #2092) over the line once the Biome reformat (#1792) broke its long lines; a split is queued (+5: types replacing any, #2022; +3 for the cabal page, #2090)'],
  'src/ci-health.ts': [1560, 'over the line once the Biome reformat (#1792) broke its long lines; a split is queued'],
  'src/runner.ts': [
    4889,
    'turn runner: spawn, stream, resume and cost in one module; a split into its seams is queued (+13: a marked minion reaching its machine host, Build 7 T8, #2070) (+23: a turn placed on a machine, #1962) (+2: a cabal member is offered cabal_board, #2090) (+1: a word on the quick lane with a message, #1986) (+11: busy and a recorded answer its chat reads next turn, #1930) (+5: the state a status line gives, kept on its event, #1923) (+134: cards that outlive their turn, #1916) (+21: types replacing any, #1799) (raised once for the Biome reformat, #1792) (+135: the launch off the main thread and its stop and close deferrals, #1808) (+135: worker-line host, stop, pause, boot and view calls; the line itself is turn-line.ts, #1868) (+43: facts for the order of the line and a keepalive in line, #1888) (+15: the compaction callout wiring; the count is compactions.ts, #1920) (+18: a stop settles the outbox rows it dropped, #1904) (+15: what a killed turn spent and kills together, #1938) (+6: a seal set during a cut-off turn stays, #1958) (+17: where a turn runs, its Stop and its prompt line for the jobs it hands over, #1890) (+6: Start now wiring; the holds are start-now.ts, #1957) (+4: claims pass on at live, two delegations to src/closing.ts, #1985) (+6: the list line for a minion whose CI run is held, #1984) (+3: one call that hands each raw event to the cut-off record; the record is cut-offs.ts, #1992)',
  ],
  'tools/land.sh': [3188, 'the ship script is one shell program; its steps share state and are pinned by tests (+141: a red train pulls every likely ship and hands what is left to the next one, #1918) (+177: no-verdict runs, checks for riders and light ships, #1864) (+10: riders heard of their restart, #1865) (+11: the quick-train line, #1912) (+13: a suite stopped at its limit, missing packages, #1863) (+20: a stop finds the run it just pushed, #1894) (+51: a burn-in red names the ship that added the case, #2019) (+5: titles checked before the line, #1983) (+17: the main .gitattributes on git before 2.40, #2071) (+2: a build\'s --full run checks the schema against its own base, #2067) (+36: a guess refuses nobody, its ship ships alone, #2098) (+5: the parts loader and a re-exec check over every part, #2099, after step 0 took 8 off)'],
  'kit/skills/scheme-setup/templates/land.sh': [3049, 'the kit template every scheme copies byte for byte; the schemes skip their copies, so this is the one place its size is counted (+8: the count merge rule, #1917) (+2: ships a person placed, #1827) (+121: wrong refusals, #1866) (+8: the same for a landing, #1894) (+5: titles checked before the line, #1983) (+24: the main .gitattributes on git before 2.40, #2071) (+2: a build\'s --full run checks the schema against its own base, #2067)'],
  'public/machine-agent.mjs': [2805, 'standalone agent a person runs on their own computer: one file so it can be copied alone (+88: the programs its owner lists for marked minions, and their starts, refused while a writable folder holds them, Build 7 T8, #2070) (+22: loads the worker file, which is its own, #1962) (+146: --join swaps a join code for its token, and the report of what the PC can do, Build 7 M2, #2053) (+31: a role\'s Set up and Test run role-setup-agent.mjs, taken from the app, Build 7 M4, #2055) (raised once for the Biome reformat, #1792) (+43: jobs keep their state across reconnect, Pause and Stop, #1956) (+1: a tick skips a job that ended during its GPU sample, #1964)'],
  'src/routes/projects.ts': [2127, 'every /projects route; split by page is queued (+4: runs_on, #1973) (+3: create_ticket puts a minion on a cabal board, #2090) (+2: a waiting minion counts as working, #1868) (raised once for the Biome reformat, #1792) (+30: same-scheme Taskmaster message, #1855) (+4: the stale check and its wait for queued saves, #1859) (+3: the claim keep checks and who ships beside it, #1985) (+4: a first open answers with the folder of its Taskmaster while that write is queued, #1903) (+8: createMinion, the create path a card pick shares, #2050)'],
  'src/tripwire.ts': [1847, 'the tripwire rules; high risk to edit, so a split waits for its own change (+6: a whole /host/<name> of a machine\'s owner, Build 7 T8, #2070) (raised once for the Biome reformat, #1792) (+10: types replacing any, #1816) (+1: a turn may change its own copies of app data, #1884)'],
  'src/routes/tickets.ts': [1937, 'every /tickets route; split by page is queued (+19: #1823 unchain, +13: card types replacing any, #1799) (raised once for the Biome reformat, #1792) (+3: a hand-off and a deploy report move its place in line, #1888) (+1: the machine wait and Runs on mark of a minion, Build 7)'],
  'tools/dev-seeds.ts': [2111, 'seed data for dev copies; grows with every table (raised once for the Biome reformat, #1792; by 2 for the Flow seed moved out to dev-seeds-flow.ts, #1989; by 2 for the cabal seeds in dev-seeds-cabal.ts, #2090; +3: types replacing any, #2075)'],
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

// The ship script in bytes (#2099; Josh, 2026-11-26, approving #1921's plan): tools/land.sh and its parts
// (tools/land/<part>.sh). Lines don't bound it (a third of its lines ran past 160 characters), so each file has a byte
// limit, the lot a total, and lines past 160 characters a count. Until the split's last step these are a falling
// ceiling, lowered by each step to what it leaves; then the plan's limits (specs/ship-script-split.md, "The shape").
// Raising one needs the decision quoted beside it. A part with no row here fails: give it one.
export const SHIP_LIMITS = {
  files: {
    'tools/land.sh': 235_000,
    'tools/land/common.sh': 10_000,
    'tools/land/prepare.sh': 30_000,
    'tools/land/guards.sh': 20_000,
    'tools/land/build.sh': 10_000,
    'tools/land/ci.sh': 30_000,
    'tools/land/train.sh': 30_000,
    'tools/land/early.sh': 15_000,
    'tools/land/blame.sh': 30_000,
  } as Record<string, number>,
  total: 235_000,
  longLines: 184,
};

export function shipSizes(dir = root): Record<string, { bytes: number; long: number }> {
  const out: Record<string, { bytes: number; long: number }> = {};
  const parts = existsSync(join(dir, 'tools', 'land')) ? readdirSync(join(dir, 'tools', 'land')).filter((f) => f.endsWith('.sh')) : [];
  for (const path of ['tools/land.sh', ...parts.sort().map((f) => `tools/land/${f}`)]) {
    const text = readFileSync(join(dir, path), 'utf8');
    out[path] = { bytes: Buffer.byteLength(text), long: text.split('\n').filter((l) => l.length > 160).length };
  }
  return out;
}

export function overShipLimits(sizes: Record<string, { bytes: number; long: number }>, limits = SHIP_LIMITS): string[] {
  const bad: string[] = [];
  let total = 0;
  let long = 0;
  for (const [path, { bytes, long: l }] of Object.entries(sizes)) {
    total += bytes;
    long += l;
    const cap = limits.files[path];
    if (cap === undefined) bad.push(`${path}: a part with no byte limit in SHIP_LIMITS`);
    else if (bytes > cap) bad.push(`${path}: ${bytes} bytes, limit ${cap}`);
  }
  if (total > limits.total) bad.push(`land.sh and its parts: ${total} bytes in all, limit ${limits.total}`);
  if (long > limits.longLines) bad.push(`land.sh and its parts: ${long} lines past 160 characters, limit ${limits.longLines}`);
  return bad;
}

// A copy of this file run in a scratch repo with no ship script (land.test's size refusal) has nothing to measure.
const shipHere = existsSync(join(root, 'tools/land.sh'));

test('the ship script and its parts are within their byte limits, in total, and in lines past 160 characters', () => {
  if (shipHere) assert.deepEqual(overShipLimits(shipSizes()), [], 'move code into a part, or cut it; raising a limit needs the decision quoted beside it');
});

test('the ship limits fail a file, a new part, the total and long lines past their limits, and pass at them', () => {
  const limits = { files: { a: 10, b: 10 } as Record<string, number>, total: 15, longLines: 2 };
  assert.deepEqual(overShipLimits({ a: { bytes: 10, long: 1 }, b: { bytes: 5, long: 1 } }, limits), []);
  assert.equal(overShipLimits({ a: { bytes: 11, long: 0 } }, limits).length, 1);
  assert.match(overShipLimits({ c: { bytes: 1, long: 0 } }, limits)[0]!, /no byte limit/);
  assert.match(overShipLimits({ a: { bytes: 10, long: 0 }, b: { bytes: 6, long: 0 } }, limits)[0]!, /in all/);
  assert.match(overShipLimits({ a: { bytes: 1, long: 3 } }, limits)[0]!, /past 160/);
});

test('the ship script and every part parse as bash', () => {
  for (const f of shipHere ? Object.keys(shipSizes()) : []) {
    const r = spawnSync('bash', ['-n', join(root, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});
