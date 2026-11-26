// The scheme-setup template land.sh's ship-time merges (#1221, #1322): MERGES lets two branches that each raise a
// budget, append a migration or regenerate a baseline ship without a hand rebase, alone and inside a batch, and
// refuses what its rules aren't sure of. On files shaped like Citadel's.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ciSetup, env, git, GREEN, setup } from './scheme-setup-land-fixture.ts';

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

/** A list of caps, one to a line, by the count rule (#1917). */
const caps = (a: string, b: string) => `export const CAPS = {\n  'a.ts': [${a}],\n  'b.ts': [${b}],\n};\n`;
const CAPS = 'test/caps.test.ts';
/** Main's and the branch's edits of the caps, both from <base>; the landing's result. */
function capsLanding(rule: string, main: string, branch: string, base = caps("10, 'x'", "20, 'y'")) {
  const r = setup('true', {}, `MERGES='${CAPS} ${rule} ^\\ \\ .[a-z.]+.:\\ \\[[0-9]+,'\n`);
  change(r.main, { [CAPS]: base }, 'shared base');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  change(r.main, { [CAPS]: main }, 'main: #9');
  change(r.wt, { [CAPS]: branch }, 'branch: #2');
  const out = r.run();
  return { out, list: show(r.main, CAPS), main };
}
for (const [what, main, branch, want] of [
  ['both raise one', caps("13, 'x (+3 #9)'", "20, 'y'"), caps("15, 'x (+5 #2)'", "20, 'y'"), caps("18, 'x (+3 #9) (+5 #2)'", "20, 'y'")],
  ['main lowers it, the branch raises it', caps("4, 'x (-6 #9)'", "20, 'y'"), caps("15, 'x (+5 #2)'", "20, 'y'"), caps("9, 'x (-6 #9) (+5 #2)'", "20, 'y'")],
  ['each raises a neighbour', caps("13, 'x (+3 #9)'", "20, 'y'"), caps("10, 'x'", "25, 'y (+5 #2)'"), caps("13, 'x (+3 #9)'", "25, 'y (+5 #2)'")],
])
  test(`the count rule: ${what}, and main's change plus the branch's lands`, () => {
    const { out, list } = capsLanding('count', main, branch);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(list, want);
  });

for (const [what, rule, main, branch, base] of [
  ['count refuses a number the two would take below 0', 'count', caps("3, 'x (-7 #9)'", "20, 'y'"), caps("4, 'x (-6 #2)'", "20, 'y'")],
  ['count refuses a #number both changed', 'count', caps("10, 'x #9'", "20, 'y'"), caps("10, 'x #2'", "20, 'y'"), caps("10, 'x #1'", "20, 'y'")],
  ['sum still refuses a lowered one', 'sum', caps("4, 'x'", "20, 'y'"), caps("15, 'x'", "20, 'y'")],
])
  test(`merge rules: ${what}`, () => {
    const { out, list } = capsLanding(rule, main, branch, base);
    assert.equal(out.status, 1, out.stderr);
    assert.match(out.stderr, /conflicted files: test\/caps\.test\.ts/);
    assert.equal(list, main, 'main stays');
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

/** A README with a Layout table (#2104): <rows> between its header and the last row, then prose under another heading. */
const README = 'README.md';
const ROWS = `MERGES='${README} rows ^##\\ Layout$'\n`;
const readme = (rows: string[], prose = 'Run it.', other = '| `x` | X |') => `# R\n\n## Layout\n\n| Path | What |\n| --- | --- |\n| \`a\` | A |\n${rows.map((r) => `${r}\n`).join('')}| \`z\` | Z |\n\n## Running\n\n${prose}\n\n| Other | table |\n| --- | --- |\n${other}\n`;
const row = (f: string, what = f.toUpperCase()) => `| \`${f}\` | ${what} |`;
/** Main's and the branch's README, both from <base>: the landing's result and main's README after it. */
function readmeLanding(main: string, branch: string, base = readme([])) {
  const r = setup('true', {}, ROWS);
  change(r.main, { [README]: base }, 'shared base');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  change(r.main, { [README]: main }, 'main: #9');
  change(r.wt, { [README]: branch }, 'branch: #2');
  return { out: r.run(), shown: show(r.main, README), r };
}

test("the rows rule: two branches that each add a row to the Layout table both ship, main's row first", () => {
  const { out, shown } = readmeLanding(readme([row('b'), row('b2')]), readme([row('c')]));
  assert.equal(out.status, 0, out.stderr);
  assert.equal(shown, readme([row('b'), row('b2'), row('c')]));
});

for (const [what, main, branch, base] of [
  ['a row both changed differently', readme([], 'Run it.').replace('| A |', '| A2 |'), readme([]).replace('| A |', '| A3 |')],
  ['a clash in the prose outside the table', readme([], 'Run it twice.'), readme([], 'Run it once.')],
  ['rows both add to a table under another heading', readme([], 'Run it.', '| `x` | X |\n| `y` | Y |'), readme([], 'Run it.', '| `x` | X |\n| `w` | W |')],
  ['one file both list', readme([row('b', 'from main')]), readme([row('b', 'from the branch')])],
  ['a row and a line that is not one', readme([row('b')]), readme([row('c'), 'not a row'])],
])
  test(`the rows rule stops on ${what}: refused, main stays`, () => {
    const { out, shown } = readmeLanding(main, branch, base);
    assert.equal(out.status, 1, out.stderr);
    assert.match(out.stderr, /conflicted files: README\.md/);
    assert.equal(shown, main, 'main stays');
  });

/** The merge driver itself, as git runs it: <main's>, <base>, <the branch's>; its exit and what it left in main's file. */
function driver(main: string, base: string, branch: string) {
  const r = setup('true', {}, ROWS);
  for (const [f, text] of Object.entries({ m: main, o: base, b: branch })) writeFileSync(join(r.dir, f), text);
  const res = spawnSync('bash', [join(r.main, 'tools', 'land.sh'), '--merge', 'ours', join(r.dir, 'o'), join(r.dir, 'm'), join(r.dir, 'b'), README], { cwd: r.main, encoding: 'utf8', env });
  return { status: res.status, text: readFileSync(join(r.dir, 'm'), 'utf8') };
}
const changed = (text: string) => text.replace('| A |', '| A, changed |');
for (const [what, main, branch, want] of [
  ['main changed a row, the branch added one after it', changed(readme([])), readme([row('b')]), changed(readme([row('b')]))],
  ['the branch changed a row, main added one after it', readme([row('b')]), changed(readme([])), changed(readme([row('b')]))],
  ['main removed a row, the branch added one after it', readme([]).replace('| `a` | A |\n', ''), readme([row('b')]), readme([row('b')]).replace('| `a` | A |\n', '')],
  ['main changed a row, the branch added one before it', changed(readme([])), readme([]).replace('| `a` |', `${row('0')}\n| \`a\` |`), changed(readme([]).replace('| `a` |', `${row('0')}\n| \`a\` |`))],
])
  test(`the rows rule: ${what}, and both stay`, () => {
    assert.deepEqual(driver(main, readme([]), branch), { status: 0, text: want });
  });

test("a clash no rule takes leaves git's own conflict markers, so a fix recorded ahead of time with git rerere still replays", () => {
  const base = readme([]);
  const [main, branch] = [base.replace('| A |', '| A2 |'), base.replace('| A |', '| A3 |')];
  const merged = driver(main, base, branch);
  assert.equal(merged.status, 1);
  const d = mkdtempSync(join(tmpdir(), 'rows-'));
  try {
    for (const [f, text] of Object.entries({ m: main, o: base, b: branch })) writeFileSync(join(d, f), text);
    const unlabelled = (text: string) => text.replace(/^([<>]{7}) .*$/gm, '$1');
    assert.equal(unlabelled(merged.text), unlabelled(spawnSync('git', ['merge-file', '-p', join(d, 'm'), join(d, 'o'), join(d, 'b')], { encoding: 'utf8' }).stdout));
  } finally {
    rmSync(d, { recursive: true, force: true }); // timing-ok: own temp dir
  }
  // The fix, recorded by a plain cherry-pick as a minion would, replays in the rebase with the driver on.
  const r = setup('true', {}, ROWS);
  change(r.main, { [README]: base }, 'shared base');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  change(r.main, { [README]: main }, 'main: #9');
  change(r.wt, { [README]: branch }, 'branch: #2');
  const rr = ['-c', 'rerere.enabled=true', '-c', 'rerere.autoupdate=true'];
  const fix = base.replace('| A |', '| A2 and A3 |');
  const scratch = join(r.dir, 'fix');
  git(r.main, 'worktree', 'add', '-q', '--detach', scratch, 'main');
  assert.throws(() => git(scratch, ...rr, 'cherry-pick', 'ticket/1-x'));
  writeFileSync(join(scratch, README), fix);
  git(scratch, ...rr, 'add', README);
  git(scratch, ...rr, 'rerere');
  git(scratch, 'cherry-pick', '--abort');
  writeFileSync(join(r.dir, 'attributes'), `${README} merge=land-ship\n`);
  const withDriver = ['-c', `core.attributesFile=${join(r.dir, 'attributes')}`, '-c', `merge.land-ship.driver=bash '${join(r.wt, 'tools', 'land.sh')}' --merge ours %O %A %B %P`];
  assert.throws(() => git(r.wt, ...withDriver, ...rr, 'rebase', '-q', 'main'), 'git stops even on a conflict rerere resolved');
  assert.equal(git(r.wt, 'diff', '--name-only', '--diff-filter=U'), '', 'rerere resolved it');
  assert.equal(readFileSync(join(r.wt, README), 'utf8'), fix);
  git(r.wt, 'rebase', '--abort');
});
