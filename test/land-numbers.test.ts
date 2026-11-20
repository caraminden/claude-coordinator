// Schema and ADR numbers handed out at ship time (#1221): when main (or the build) took the SCHEMA_HISTORY number or
// the ADR number a branch picked while it waited, tools/land.sh gives the branch the next free one itself, in a plain
// land, a feeder's --into and a build's --build alike; a clash it can't sort out is refused before the line with the
// number to take.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, setup } from './land-fixture.ts';

type R = ReturnType<typeof setup>;
const OK = 'test/ok.test.mjs';
const check = (n: number, who: string) => `  if ((this.getSetting<number>('schema_version') ?? 0) >= ${n}) return; // ${who}`;
const filler = Array.from({ length: 6 }, (_, i) => `  const x${i} = ${i};`).join('\n');
// A db.ts shaped like Citadel's: the history, then two one-off steps far enough apart that edits to them merge.
const db = (history: [number, string][], first = '  // first', second = '  // second') =>
  `export const SCHEMA_HISTORY = [\n${history.map(([n, d]) => `  [${n}, '${d}'],`).join('\n')}\n] as const;\nexport const SCHEMA_VERSION = SCHEMA_HISTORY.at(-1)![0];\n\nfunction first() {\n${first}\n${filler}\n}\n\nfunction second() {\n${second}\n${filler}\n}`; // no last newline: git() trims what show() reads
const BASE: [number, string][] = [[94, 'host_samples (#1123)'], [95, 'tickets.goal (#1130)']];

function write(where: string, files: Record<string, string>, msg: string) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(where, f, '..'), { recursive: true });
    writeFileSync(join(where, f), text);
  }
  git(where, 'add', '-A');
  git(where, 'commit', '-qm', msg);
}
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

test("a feeder whose numbers the build took gets the next ones as it merges into the build", () => {
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

test('a branch with two commits each adding a schema line keeps both, in order, after main\'s', () => {
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
