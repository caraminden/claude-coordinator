// Schema and ADR numbers handed out at ship time (#1221): when main (or the build) took the SCHEMA_HISTORY number or
// the ADR number a branch picked while it waited, tools/land.sh gives the branch the next free one itself, in a plain
// land, a feeder's --into and a build's --build alike; a clash it can't sort out is refused before the line with the
// number to take.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { ci, env, git, setup, write } from './land-fixture.ts';

type R = ReturnType<typeof setup>;
const OK = 'test/ok.test.mjs';
const check = (n: number, who: string) => `  if ((this.getSetting<number>('schema_version') ?? 0) >= ${n}) return; // ${who}`;
const filler = Array.from({ length: 6 }, (_, i) => `  const x${i} = ${i};`).join('\n');
// A db.ts shaped like Citadel's: the history, then two one-off steps far enough apart that edits to them merge.
const db = (history: [number, string][], first = '  // first', second = '  // second') =>
  `export const SCHEMA_HISTORY = [\n${history.map(([n, d]) => `  [${n}, '${d}'],`).join('\n')}\n] as const;\nexport const SCHEMA_VERSION = SCHEMA_HISTORY.at(-1)![0];\n\nfunction first() {\n${first}\n${filler}\n}\n\nfunction second() {\n${second}\n${filler}\n}`; // no last newline: git() trims what show() reads
const BASE: [number, string][] = [
  [94, 'host_samples (#1123)'],
  [95, 'tickets.goal (#1130)'],
];

// main with db.ts and ADR 0001, and the minion's worktree on it.
function start() {
  const r = setup();
  write(r.source, { 'src/db.ts': db(BASE), 'docs/adr/0001-first.md': '# ADR 0001: first\n' }, 'db.ts and ADR 0001');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  return r;
}
const show = (r: R, ref: string, f: string) => git(r.source, 'show', `${ref}:${f}`);
function worktree(r: R, name: string, from: string) {
  const wt = join(r.dir, name.replace(/\W/g, '-'));
  git(r.source, 'worktree', 'add', '-q', '-b', name, wt, from);
  return wt;
}

test("a plain land whose schema number main took ships with the next one, its version check moved with it, main's left alone", () => {
  const r = start();
  write(r.wt, { 'src/db.ts': db([...BASE, [96, 'mine (#1)']], check(96, 'mine')) }, '#1: mine');
  write(r.source, { 'src/db.ts': db([...BASE, [96, 'theirs (#2)']], undefined, check(96, 'theirs')) }, '#2: theirs');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'), 'it landed');
  assert.equal(show(r, 'main', 'src/db.ts'), db([...BASE, [96, 'theirs (#2)'], [97, 'mine (#1)']], check(97, 'mine'), check(96, 'theirs')));
});

test("a branch whose ADR number main took ships it under the next one, with its links and its own mentions, and main's mentions left alone", () => {
  const r = start();
  write(r.wt, { 'docs/adr/0002-mine.md': '# ADR 0002: mine\n\nAfter ADR 0001.\n', 'notes.md': 'Per ADR 0002 ([mine](docs/adr/0002-mine.md)).\n' }, '#1: ADR 0002 mine');
  write(r.source, { 'docs/adr/0002-theirs.md': '# ADR 0002: theirs\n', 'docs/theirs.md': 'Per ADR 0002.\n' }, '#2: ADR 0002 theirs');
  writeFileSync(join(r.wt, 'scratch.txt'), 'not for main\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'), 'it landed');
  assert.equal(show(r, 'main', 'docs/adr/0003-mine.md'), '# ADR 0003: mine\n\nAfter ADR 0001.');
  assert.equal(show(r, 'main', 'notes.md'), 'Per ADR 0003 ([mine](docs/adr/0003-mine.md)).');
  assert.equal(show(r, 'main', 'docs/theirs.md'), 'Per ADR 0002.', "main's own mention stays");
  assert.equal(show(r, 'main', 'docs/adr/0002-theirs.md'), '# ADR 0002: theirs');
  assert.ok(!existsSync(join(r.source, 'docs/adr/0002-mine.md')));
  assert.match(git(r.source, 'log', '-1', '--format=%s', 'main'), /ADR 0002 → 0003/);
  assert.match(res.stderr, /ADR 0002 → 0003/);
  assert.equal(git(r.source, 'ls-tree', '--name-only', 'main', 'scratch.txt'), '', 'an untracked file stays out of the commit');
});

test('a schema clash it cannot sort out is refused before the line, with the number to take', () => {
  const r = start();
  // The branch rewrote a line main has too: not an append, so no renumbering.
  write(r.wt, { 'src/db.ts': db([BASE[0], [95, 'tickets.goal, renamed (#1130)'], [96, 'mine (#1)']]) }, '#1: mine');
  write(r.source, { 'src/db.ts': db([...BASE, [96, 'theirs (#2)']]) }, '#2: theirs');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /smoke: it conflicts with main/);
  assert.match(res.stderr, /SCHEMA_HISTORY ends at 96 on main: number this branch's new lines from 97/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(r.note(), null, 'nothing deployed');
});

test('a feeder whose numbers the build took gets the next ones as it merges into the build', () => {
  const r = start();
  git(r.source, 'branch', 'build/3', 'main');
  const other = worktree(r, 'ticket/2-y', 'build/3');
  write(other, { 'src/db.ts': db([...BASE, [96, 'theirs (#2)']]), 'docs/adr/0002-theirs.md': '# ADR 0002: theirs\n' }, '#2: theirs');
  assert.equal(r.run({}, ['--into', 'build/3', OK], other).status, 0);
  git(r.wt, 'reset', '-q', '--hard', 'build/3~1');
  write(r.wt, { 'src/db.ts': db([...BASE, [96, 'mine (#1)']], check(96, 'mine')), 'docs/adr/0002-mine.md': '# ADR 0002: mine\n' }, '#1: mine');
  const res = r.run({}, ['--into', 'build/3', OK]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(show(r, 'build/3', 'src/db.ts'), db([...BASE, [96, 'theirs (#2)'], [97, 'mine (#1)']], check(97, 'mine')));
  assert.equal(show(r, 'build/3', 'docs/adr/0003-mine.md'), '# ADR 0003: mine');
  assert.match(res.stderr, /ADR 0002 → 0003: build\/3 took 0002/, 'it names the build, not a commit');
});

test("a build whose numbers main took keeps main's and takes the next ones when it lands", () => {
  const r = start();
  git(r.source, 'branch', 'build/3', 'main');
  git(r.wt, 'reset', '-q', '--hard', 'build/3');
  write(r.wt, { 'src/db.ts': db([...BASE, [96, 'build (#1)']], check(96, 'build')), 'docs/adr/0002-build.md': '# ADR 0002: build\n' }, '#1: build');
  assert.equal(r.run({}, ['--into', 'build/3', OK]).status, 0);
  const bwt = worktree(r, 'ticket/9-build', 'build/3');
  write(r.source, { 'src/db.ts': db([...BASE, [96, 'main (#2)']], undefined, check(96, 'main')), 'docs/adr/0002-main.md': '# ADR 0002: main\n' }, '#2: main');
  const res = r.run({}, ['--build'], bwt);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(bwt, 'rev-parse', 'HEAD'), 'it landed');
  assert.equal(show(r, 'main', 'src/db.ts'), db([...BASE, [96, 'main (#2)'], [97, 'build (#1)']], check(97, 'build'), check(96, 'main')));
  assert.equal(show(r, 'main', 'docs/adr/0002-main.md'), '# ADR 0002: main');
  assert.equal(show(r, 'main', 'docs/adr/0003-build.md'), '# ADR 0003: build');
});

test("a branch with two commits each adding a schema line keeps both, in order, after main's", () => {
  const r = start();
  write(r.wt, { 'src/db.ts': db([...BASE, [96, 'mine 1 (#1)']]) }, '#1: one');
  write(r.wt, { 'src/db.ts': db([...BASE, [96, 'mine 1 (#1)'], [97, 'mine 2 (#1)']], check(97, 'mine')) }, '#1: two');
  write(r.source, { 'src/db.ts': db([...BASE, [96, 'theirs (#2)']]) }, '#2: theirs');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(show(r, 'main', 'src/db.ts'), db([...BASE, [96, 'theirs (#2)'], [97, 'mine 1 (#1)'], [98, 'mine 2 (#1)']], check(98, 'mine')));
});

test('the hand-off check (--check) passes a branch whose schema number main took', () => {
  const r = start();
  write(r.wt, { 'src/db.ts': db([...BASE, [96, 'mine (#1)']]) }, '#1: mine');
  write(r.source, { 'src/db.ts': db([...BASE, [96, 'theirs (#2)']]) }, '#2: theirs');
  const res = r.run({}, ['--check']);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(!readFileSync(join(r.wt, 'src/db.ts'), 'utf8').includes('theirs'), 'the check moves nothing');
});

test("a version check main added too, word for word, still moves with the branch's line", () => {
  const r = start();
  write(r.wt, { 'src/db.ts': db([...BASE, [96, 'mine (#1)']], check(96, 'same')) }, '#1: mine');
  write(r.source, { 'src/db.ts': db([...BASE, [96, 'theirs (#2)']], undefined, check(96, 'same')) }, '#2: theirs');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(show(r, 'main', 'src/db.ts'), db([...BASE, [96, 'theirs (#2)'], [97, 'mine (#1)']], check(97, 'same'), check(96, 'same')));
});

test("an ADR renumber reaches a file with a space in its name, and leaves a mention beside a link to main's ADR of that number", () => {
  const r = start();
  write(r.wt, { 'docs/adr/0002-mine.md': '# ADR 0002: mine\n', 'my notes.md': 'Per ADR 0002.\nUnlike ADR 0002 ([theirs](docs/adr/0002-theirs.md)).\n' }, '#1: ADR 0002 mine');
  write(r.source, { 'docs/adr/0002-theirs.md': '# ADR 0002: theirs\n' }, '#2: ADR 0002 theirs');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(show(r, 'main', 'my notes.md'), 'Per ADR 0003.\nUnlike ADR 0002 ([theirs](docs/adr/0002-theirs.md)).');
});

test("the build minion's own merge of main (ship-numbers take) moves the build's schema lines after main's", () => {
  const r = start();
  git(r.source, 'branch', 'build/3', 'main');
  git(r.wt, 'reset', '-q', '--hard', 'build/3');
  write(r.wt, { 'src/db.ts': db([...BASE, [96, 'build (#1)']], check(96, 'build')) }, '#1: build');
  write(r.source, { 'src/db.ts': db([...BASE, [96, 'main (#2)']], undefined, check(96, 'main')) }, '#2: main');
  const res = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'tools', 'ship-numbers.ts'), 'take', 'main'], { cwd: r.wt, env, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(readFileSync(join(r.wt, 'src/db.ts'), 'utf8'), db([...BASE, [96, 'main (#2)'], [97, 'build (#1)']], check(97, 'build'), check(96, 'main')));
});

test('a --build stopped by a red gate after renumbering an ADR says how to go on', () => {
  const r = start();
  const c = ci(r);
  git(r.source, 'branch', 'build/3', 'main');
  git(r.wt, 'reset', '-q', '--hard', 'build/3');
  write(r.wt, { 'docs/adr/0002-build.md': '# ADR 0002: build\n' }, '#1: build');
  assert.equal(c.run({}, ['--into', 'build/3', OK]).status, 0);
  const bwt = worktree(r, 'ticket/9-build', 'build/3');
  write(r.source, { 'docs/adr/0002-main.md': '# ADR 0002: main\n' }, '#2: main');
  assert.equal(c.run({ FAKE_CI: 'red' }, ['--build'], bwt).status, 1);
  const res = c.run({}, ['--build'], bwt);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /one merge ahead of build\/3 .*run tools\/land\.sh --into build\/3 --full first/s);
  assert.equal(c.run({}, ['--into', 'build/3', '--full'], bwt).status, 0);
  assert.equal(c.run({}, ['--build'], bwt).status, 0);
  assert.equal(show(r, 'main', 'docs/adr/0003-build.md'), '# ADR 0003: build');
});

test("a feeder whose ADR renumber would rewrite a file another feeder claimed is refused, and the build doesn't move", () => {
  const r = start();
  git(r.source, 'branch', 'build/3', 'main');
  const boss = worktree(r, 'ticket/9-build', 'build/3');
  write(boss, { 'build-claims.md': '# Build 3\nbuild: #9\n#1: docs/adr/\n#2: docs/x.md\n', 'docs/adr/0002-boss.md': '# ADR 0002: boss\n' }, 'claims');
  git(r.source, 'branch', '-f', 'build/3', 'ticket/9-build');
  const two = worktree(r, 'ticket/2-y', 'build/3');
  write(two, { 'docs/x.md': 'Waits on docs/adr/0002-mine.md.\n' }, '#2: x');
  assert.equal(r.run({}, ['--into', 'build/3', OK], two).status, 0);
  git(r.wt, 'reset', '-q', '--hard', 'build/3');
  write(r.wt, { 'docs/adr/0002-mine.md': '# ADR 0002: mine\n' }, '#1: mine');
  const before = git(r.source, 'rev-parse', 'build/3');
  const res = r.run({}, ['--into', 'build/3', OK]);
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /docs\/x\.md is #2's in the claims/);
  assert.equal(git(r.source, 'rev-parse', 'build/3'), before);
});

// Ship-time merges (#1418): the prompt budgets add up, the baseline is made again from the merged prompts, and both
// sides' MIGRATIONS lines stay, by the kit core's MERGES rules (tools/land-core.sh --merge, its settings in land.local.sh).
// Names built, not quoted: a quoted test file's name reads as a dependency to test/pipeline-files.test.ts.
const BUDGET_FILE = `test/${'prompt-budget'}.test.ts`;
const BASELINE = 'test/prompt-baseline.json';
// A budget file shaped like Citadel's; PROMPT_BASELINE=write makes the baseline from it, as the real one does.
const budget = (minion: string, minionNotes: string, kit: string, kitNotes: string) => `import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
const BUDGET = { minion: ${minion} /* ${minionNotes} */, taskmaster: 41_500 /* +100 for the ship-lessons line (#1119) */ };
const KIT_BUDGET = ${kit}; // ${kitNotes}
if (process.env.PROMPT_BASELINE === 'write') writeFileSync(new URL('prompt-baseline.json', import.meta.url), JSON.stringify({ made: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex') }) + '\\n');
void BUDGET, KIT_BUDGET;
`;
const made = (text: string) => JSON.stringify({ made: createHash('sha256').update(text).digest('hex') });
const migrations = (...cols: string[]) => `\n\nconst MIGRATIONS: [table: string, column: string, ddl: string][] = [\n  ['tickets', 'a', 'TEXT'],\n${cols.map((c) => `  ['tickets', '${c}', 'TEXT'],\n`).join('')}];`;
// A stand-in citadel-test for the guard tests: logs the minion budget it saw on the commit it ran on.
function guarded(r: R) {
  writeFileSync(join(r.source, 'tools', 'citadel-test'), `#!/usr/bin/env bash\ngrep -o "minion: [0-9_]*" ${BUDGET_FILE} >>"$GUARD_LOG"\n`);
  chmodSync(join(r.source, 'tools', 'citadel-test'), 0o755);
  const old = budget('37_500', '+450 on 2026-11-19 for the done-lines rule (#1115)', '10_550', '+200 on 2026-11-05 (#1148)');
  write(r.source, { [BUDGET_FILE]: old, [BASELINE]: made(old) + '\n', 'src/db.ts': db(BASE) + migrations() }, 'budget, baseline, migrations');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  return join(r.dir, 'guard.log');
}

test('two branches that each raise BUDGET and KIT_BUDGET ship one after the other: the raises add up, both notes stay, the budget test runs on the result (#1418)', () => {
  const r = start();
  const log = guarded(r);
  write(r.source, { [BUDGET_FILE]: budget('37_900', '+400 for A (#2), +450 on 2026-11-19 for the done-lines rule (#1115)', '10_750', '+200 for A (#2); +200 on 2026-11-05 (#1148)') }, '#2: raise');
  write(r.wt, { [BUDGET_FILE]: budget('37_800', '+300 for B (#1), +450 on 2026-11-19 for the done-lines rule (#1115)', '10_650', '+100 for B (#1); +200 on 2026-11-05 (#1148)') }, '#1: raise');
  const res = r.run({ GUARD_LOG: log });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.source, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'), 'it landed');
  const merged = show(r, 'main', BUDGET_FILE);
  assert.match(merged, /minion: 38_200 \/\* /, "main's 37_900 plus this branch's +300, never more");
  assert.match(merged, /KIT_BUDGET = 10_850;/);
  for (const note of ['+400 for A (#2)', '+300 for B (#1)', '+200 for A (#2)', '+100 for B (#1)', '+450 on 2026-11-19 for the done-lines rule (#1115)', '+200 on 2026-11-05 (#1148)']) assert.ok(merged.includes(note), `${note} kept:\n${merged}`);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').at(-1), 'minion: 38_200', 'the guard ran the budget test on the merged file');
});

test('two branches that each change the prompt baseline both ship: the baseline is made again from the merged prompts, not merged (#1418)', () => {
  const r = start();
  const log = guarded(r);
  const theirs = budget('37_900', '+400 for A (#2), +450 on 2026-11-19 for the done-lines rule (#1115)', '10_550', '+200 on 2026-11-05 (#1148)');
  write(r.source, { [BUDGET_FILE]: theirs, [BASELINE]: made(theirs) + '\n' }, '#2: raise, baseline');
  const mine = budget('37_500', '+450 on 2026-11-19 for the done-lines rule (#1115)', '10_650', '+100 for B (#1); +200 on 2026-11-05 (#1148)');
  write(r.wt, { [BUDGET_FILE]: mine, [BASELINE]: made(mine) + '\n' }, '#1: raise, baseline');
  const res = r.run({ GUARD_LOG: log });
  assert.equal(res.status, 0, res.stderr);
  const merged = show(r, 'main', BUDGET_FILE);
  assert.match(merged, /minion: 37_900 .*KIT_BUDGET = 10_650;/s);
  assert.equal(show(r, 'main', BASELINE), made(merged + '\n'), 'measured again on the merged file');
  assert.match(git(r.source, 'log', '-1', '--format=%s', 'main'), /prompt-baseline\.json measured again at ship time/);
});

test("two branches that each append to MIGRATIONS and SCHEMA_HISTORY both ship: main's lines first, then the branch's, renumbered (#1418)", () => {
  const r = start();
  guarded(r);
  write(r.source, { 'src/db.ts': db([...BASE, [96, 'theirs (#2)']]) + migrations('b') }, '#2: theirs');
  write(r.wt, { 'src/db.ts': db([...BASE, [96, 'mine (#1)']], check(96, 'mine')) + migrations('c') }, '#1: mine');
  const res = r.run({ GUARD_LOG: join(r.dir, 'guard.log') });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(show(r, 'main', 'src/db.ts'), db([...BASE, [96, 'theirs (#2)'], [97, 'mine (#1)']], check(97, 'mine')) + migrations('b', 'c'));
});

test('a budget one side lowered is not summed: the ship is refused before the line as any conflict is, main untouched (#1418)', () => {
  const r = start();
  guarded(r);
  write(r.source, { [BUDGET_FILE]: budget('37_900', '+400 for A (#2), +450 on 2026-11-19 for the done-lines rule (#1115)', '10_550', '+200 on 2026-11-05 (#1148)') }, '#2: raise');
  write(r.wt, { [BUDGET_FILE]: budget('37_000', '-500 for B (#1), +450 on 2026-11-19 for the done-lines rule (#1115)', '10_550', '+200 on 2026-11-05 (#1148)') }, '#1: lower');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run({ GUARD_LOG: join(r.dir, 'guard.log') });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /smoke: it conflicts with main/);
  assert.match(res.stderr, /prompt-budget\.test\.ts/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

// README's Layout rows (#2104): two ships that each add a row to the real table both ship, by the kit core's rows rule
// (MERGES in land.local.sh); two that change one row differently are still refused.
const README = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');
const ROW = README.split('\n').find((l) => l.startsWith('| `server.ts` |'))!;
const withRows = (...rows: string[]) => README.replace(`${ROW}\n`, `${ROW}\n${rows.map((r) => `${r}\n`).join('')}`);

test("two branches that each add a row to README's Layout table both ship, main's row first (#2104)", () => {
  const r = start();
  write(r.source, { 'README.md': README }, 'the README');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  write(r.source, { 'README.md': withRows('| `src/b.ts` | B (#2) |'), 'src/b.ts': 'export {};\n' }, '#2: a row');
  write(r.wt, { 'README.md': withRows('| `src/a.ts` | A (#1) |'), 'src/a.ts': 'export {};\n' }, '#1: a row');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(show(r, 'main', 'README.md') + '\n', withRows('| `src/b.ts` | B (#2) |', '| `src/a.ts` | A (#1) |'));
});

test('a README Layout row two branches changed differently is refused before the line, main untouched (#2104)', () => {
  const r = start();
  write(r.source, { 'README.md': README }, 'the README');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  write(r.source, { 'README.md': README.replace(ROW, `${ROW.slice(0, -2)} (theirs, #2) |`) }, '#2: the row');
  write(r.wt, { 'README.md': README.replace(ROW, `${ROW.slice(0, -2)} (mine, #1) |`) }, '#1: the row');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /smoke: it conflicts with main/);
  assert.match(res.stderr, /README\.md/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});
