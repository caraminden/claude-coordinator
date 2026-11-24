// The scheme-setup template land.sh's ship-time merges (#1221, #1322): MERGES lets two branches that each raise a
// budget, append a migration or regenerate a baseline ship without a hand rebase, alone and inside a batch, and
// refuses what its rules aren't sure of. On files shaped like Citadel's.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ciSetup, git, GREEN, setup } from './scheme-setup-land-fixture.ts';

const BUDGET_FILE = 'test/prompt-budget.test.ts';
const DB_FILE = 'src/db.ts';
const BASELINE = 'test/prompt-baseline.json';
const LOCAL = `MERGES='
${BUDGET_FILE} sum ^const\\ BUDGET\\ =
${BUDGET_FILE} sum ^const\\ KIT_BUDGET\\ =
${DB_FILE} append ^const\\ MIGRATIONS
${BASELINE} main
'
# The baseline is made again from the merged tree, never merged.
land_rebased() { sha256sum ${BUDGET_FILE} ${DB_FILE} >${BASELINE}; git add ${BASELINE}; git diff --cached --quiet || git commit -qm 'baseline again'; }
`;

const budget = (minion: string, minionNotes: string, kit: string, kitNotes: string) => `import { test } from 'node:test';\n\nconst BUDGET = { minion: ${minion} /* ${minionNotes} */, taskmaster: 41_500 /* +100 (#1119) */ };\n\nconst KIT_BUDGET = ${kit}; // ${kitNotes}\n\ntest('budget', () => {});\n`;
const db = (...cols: string[]) => `export const x = 1;\n\nconst MIGRATIONS: [table: string, column: string, ddl: string][] = [\n  ['tickets', 'a', 'TEXT'],\n${cols.map((c) => `  ['tickets', '${c}', 'TEXT'],\n`).join('')}];\n\nexport function migrate() {}\n`;
const baseline = (where: string) => {
  const sum = (f: string) =>
    createHash('sha256')
      .update(readFileSync(join(where, f)))
      .digest('hex');
  return `${sum(BUDGET_FILE)}  ${BUDGET_FILE}\n${sum(DB_FILE)}  ${DB_FILE}\n`;
};
const show = (where: string, f: string) => git(where, 'show', `main:${f}`) + '\n';

/** Writes the files and commits them in one commit. */
function change(where: string, files: Record<string, string>, msg: string) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(where, f)), { recursive: true });
    writeFileSync(join(where, f), text);
  }
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', msg);
}
/** The shared base: Citadel-shaped files on main. */
const BASE = { [BUDGET_FILE]: budget('37_500', '+450 (#1115)', '10_550', '+200 (#1148)'), [DB_FILE]: db(), [BASELINE]: 'old\n' };

test('two branches that each raise a budget, append a migration and regenerate the baseline both ship, with no hand rebase', () => {
  const r = setup('grep -o "minion: [0-9_]*" test/prompt-budget.test.ts >>"$CHECK_LOG"', {}, LOCAL);
  const checkLog = join(r.dir, 'check.log');
  change(r.main, BASE, 'shared base');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  // Main moves on: its own raises, its own migration, its own baseline.
  change(r.main, { [BUDGET_FILE]: budget('37_900', '+450 (#1115), +400 (#9)', '10_750', '+200 (#1148); +200 (#9)'), [DB_FILE]: db('b'), [BASELINE]: 'main\n' }, 'main: #9');
  // The branch, from the old base.
  change(r.wt, { [BUDGET_FILE]: budget('37_800', '+450 (#1115), +300 (#2)', '10_650', '+200 (#1148); +100 (#2)'), [DB_FILE]: db('c'), [BASELINE]: 'branch\n' }, 'branch: #2');
  const out = r.run({ CHECK_LOG: checkLog });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(show(r.main, BUDGET_FILE), budget('38_200', '+450 (#1115), +400 (#9), +300 (#2)', '10_850', '+200 (#1148); +200 (#9); +100 (#2)'), "main's number plus the branch's raise, and both notes");
  assert.equal(show(r.main, DB_FILE), db('b', 'c'), 'both migrations, main first');
  assert.equal(show(r.main, BASELINE), baseline(r.main), 'the baseline made again from the merged files');
  assert.deepEqual(readFileSync(checkLog, 'utf8').trim().split('\n').at(-1), 'minion: 38_200', 'the check ran on the merged result');
});

test('a raise both sides made alike still counts twice: git would take the same change once', () => {
  const r = setup('true', {}, LOCAL);
  change(r.main, BASE, 'shared base');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  change(r.main, { [BUDGET_FILE]: budget('37_800', '+450 (#1115), +300 (#9)', '10_750', '+200 (#1148); +200 (#9)') }, 'main: #9');
  change(r.wt, { [BUDGET_FILE]: budget('37_800', '+450 (#1115), +300 (#2)', '10_750', '+200 (#1148); +200 (#2)') }, 'branch: #2');
  const out = r.run();
  assert.equal(out.status, 0, out.stderr);
  assert.equal(show(r.main, BUDGET_FILE), budget('38_100', '+450 (#1115), +300 (#9), +300 (#2)', '10_950', '+200 (#1148); +200 (#9); +200 (#2)'));
});

test('a merge rule refuses what it is not sure of: a budget one side lowered stops the rebase as a clash does', () => {
  const r = setup('true', {}, LOCAL);
  change(r.main, BASE, 'shared base');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  change(r.main, { [BUDGET_FILE]: budget('37_900', '+450 (#1115), +400 (#9)', '10_550', '+200 (#1148)') }, 'main: #9');
  change(r.wt, { [BUDGET_FILE]: budget('37_000', '+450 (#1115), -500 (#2)', '10_550', '+200 (#1148)') }, 'branch: lowers it');
  const before = git(r.main, 'rev-parse', 'main');
  const out = r.run();
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /won't rebase onto main .* cleanly, by git merge-tree .*conflicted files: test\/prompt-budget\.test\.ts/);
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
  // And with the smoke off, the rebase itself stops on it too.
  const late = r.run({ LAND_SMOKE: '0' });
  assert.equal(late.status, 1, late.stderr);
  assert.match(late.stderr, /the rebase onto main failed|won't rebase onto main/);
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
});

test("the hook rule: land.local.sh's land_merge merges the file, given main's side and the path; its failure stops the rebase", () => {
  // A list kept sorted: the hook takes both sides' lines, sorted, where git sees two edits of one line.
  const local = `MERGES='list.txt hook'\nland_merge() { echo "$1 $5" >>"$HOOK_LOG"; [ ! -e "$HOOK_RED" ] || return 1; sort -u "$3" "$4" >"$3.m" && mv "$3.m" "$3"; }\n`;
  const r = setup('true', {}, local);
  const log = join(r.dir, 'hook.log');
  const red = join(r.dir, 'red');
  change(r.main, { 'list.txt': 'a\nz\n' }, 'base');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  change(r.main, { 'list.txt': 'a\nm\nz\n' }, 'main: m');
  change(r.wt, { 'list.txt': 'a\nb\nz\n' }, 'branch: b');
  writeFileSync(red, '');
  const before = git(r.main, 'rev-parse', 'main');
  const no = r.run({ HOOK_LOG: log, HOOK_RED: red });
  assert.equal(no.status, 1, no.stderr);
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
  rmSync(red);
  const out = r.run({ HOOK_LOG: log, HOOK_RED: red });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(show(r.main, 'list.txt'), 'a\nb\nm\nz\n');
  assert.ok(readFileSync(log, 'utf8').split('\n').includes('ours list.txt'), 'in the rebase, ours is main');
});

test('inside a batch: each member merges onto the one below it, and all three ship in one push', async () => {
  const c = ciSetup(3, { stack: '1', batch: '3', check: 'until [ -e "$GATE" ]; do sleep 0.05; done', local: LOCAL });
  try {
    change(c.main, BASE, 'shared base');
    for (const wt of c.wts) git(wt, 'rebase', '-q', 'main');
    change(c.main, { [BUDGET_FILE]: budget('37_900', '+450 (#1115), +400 (#9)', '10_550', '+200 (#1148)'), [DB_FILE]: db('b') }, 'main: #9');
    change(c.wts[0], { [BUDGET_FILE]: budget('37_800', '+450 (#1115), +300 (#1)', '10_550', '+200 (#1148)'), [DB_FILE]: db('c1') }, 'one');
    change(c.wts[1], { [BUDGET_FILE]: budget('37_500', '+450 (#1115)', '10_650', '+200 (#1148); +100 (#2)'), [DB_FILE]: db('c2') }, 'two');
    change(c.wts[2], { [BUDGET_FILE]: budget('37_600', '+450 (#1115), +100 (#3)', '10_550', '+200 (#1148)'), [DB_FILE]: db('c3') }, 'three');
    const [a, b, d] = await c.lands(1, 2, 3);
    c.open();
    const td = await c.tip(d);
    c.verdict(td, GREEN);
    for (const l of [a, b, d]) assert.equal(await l.exit, 0, l.stderr());
    assert.equal(c.mainAt(), td, 'one batch, one push');
    assert.deepEqual([c.sent(a), c.sent(b)], [[], []]);
    assert.equal(show(c.main, BUDGET_FILE), budget('38_300', '+450 (#1115), +400 (#9), +300 (#1), +100 (#3)', '10_650', '+200 (#1148); +100 (#2)'));
    assert.equal(show(c.main, DB_FILE), db('b', 'c1', 'c2', 'c3'));
    assert.equal(show(c.main, BASELINE), baseline(c.main));
  } finally {
    c.stop();
  }
});
