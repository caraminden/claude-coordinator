// Two ships that change the size list merge by themselves (#1917): land.sh's merge (the kit core's count rule, MERGES in
// tools/land.local.sh) on the real list as it stands, so a layout the rule can't read fails here. The size check then
// runs on what shipped, over files of the sizes the list names. NOT_JUDGES, the same one-line shape, rides the same rule.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { env, git, setup, write } from './land-fixture.ts';
import { line, shipped } from './land-train-fixture.ts';

type R = ReturnType<typeof setup>;
const LIST = 'test/size-budget.test.ts';
const JUDGES = 'test/judges.test.ts';
const real = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8');
// The real list, less the entries under tools/ and kit/: the fixture's own files live there.
const list = real(LIST).replace(/^ {2}'(tools|kit)\/[^']+': \[\d+, .*\],\n/gm, '');
const sizes = new Map([...list.matchAll(/^ {2}'([^']+)': \[\s*(\d+),/gm)].map((m) => [m[1]!, Number(m[2])]));
const lines = [...list.matchAll(/^ {2}'([^']+)': \[\d+,.*\],$/gm)].map((m) => m[1]!);
// The largest of the one-line entries, so lowering it stays over the limit, and one beside it.
const at = lines.indexOf(lines.toSorted((a, b) => sizes.get(b)! - sizes.get(a)!)[0]!);
const [ONE, NEXT] = [lines[at]!, lines[at + 1] ?? lines[at - 1]!];
const BROKEN = /^ {2}'([^']+)': \[\n/m.exec(list)?.[1]; // an entry on four lines, if one is left
const body = (n: number) => Array.from({ length: n }, (_, i) => `// line ${i}\n`).join('');

/** The entry's line for <path> with its number moved by <by> and <note> at the end of its reason. */
function entry(text: string, path: string, by: number, note: string) {
  let hit = false;
  const out = text.replace(new RegExp(`('${path.replaceAll('.', '\\.')}': \\[\\s*)(\\d+)(,\\s*(['"]).*)\\4(,?\\s*\\],)`), (_, a, n, b, q, c) => ((hit = true), `${a}${Number(n) + by}${b}${note}${q}${c}`));
  assert.ok(hit, `an entry for ${path}`);
  return out;
}
const read = (text: string, path: string) => new RegExp(`'${path.replaceAll('.', '\\.')}': \\[\\s*(\\d+),\\s*(['"])(.*)\\2`).exec(text)!;
const size = (text: string, path: string) => Number(read(text, path)[1]);
/** <path>'s file changed at its top or its bottom by <by> lines, so two branches' changes to it don't clash. */
function resized(path: string, by: number, end: 'top' | 'bottom') {
  const lines = body(sizes.get(path)!).split(/(?<=\n)/);
  const more = Array.from({ length: Math.max(by, 0) }, (_, i) => `// ${end} ${i}\n`);
  return (end === 'top' ? [...more, ...lines.slice(Math.max(-by, 0))] : [...lines.slice(0, lines.length - Math.max(-by, 0)), ...more]).join('');
}
const base = () => ({ ...Object.fromEntries([...sizes].map(([p, n]) => [p, body(n)])), [LIST]: list });
function start() {
  const r = setup();
  write(r.source, base(), 'the list and its files');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  return r;
}
const shownList = (r: R) => git(r.source, 'show', `main:${LIST}`);
const SLACK = Number(/^export const SLACK = (\d+);$/m.exec(list)![1]); // how far a listed file may grow past its number (#2139)
/** The size check on main as it shipped, and (strict) that SLACK more lines in <path> pass it and one more fails it. */
function check(r: R, path: string) {
  const dir = join(r.dir, 'check');
  git(r.source, 'worktree', 'add', '-q', '--detach', dir, 'main');
  const run = () => spawnSync(process.execPath, ['--no-warnings', '--test', join(dir, LIST)], { cwd: dir, encoding: 'utf8', env, timeout: 60_000 });
  const ok = run();
  assert.equal(ok.status, 0, ok.stdout);
  const n = size(shownList(r), path);
  writeFileSync(join(dir, path), `${readFileSync(join(dir, path), 'utf8')}${body(SLACK)}`);
  const slack = run();
  assert.equal(slack.status, 0, slack.stdout);
  writeFileSync(join(dir, path), `${readFileSync(join(dir, path), 'utf8')}// one more\n`);
  const no = run();
  assert.equal(no.status, 1, no.stdout);
  assert.match(no.stdout, new RegExp(`${path.replaceAll('.', '\\.')}: ${n + SLACK + 1} lines, limit ${n + SLACK}, 1 over`));
}
/** Ships <mine> from the base, after <theirs> went onto main: each [by, note] for its path. */
function both(path: string, theirs: [number, string], mine: [number, string], minePath = path) {
  const r = start();
  write(r.source, { [LIST]: entry(list, path, ...theirs), [path]: resized(path, theirs[0], 'top') }, '#2: theirs');
  write(r.wt, { [LIST]: entry(list, minePath, ...mine), [minePath]: resized(minePath, mine[0], 'bottom') }, '#1: mine');
  return { r, res: r.run() };
}

for (const path of [ONE, ...(BROKEN ? [BROKEN] : [])]) {
  test(`two branches that each raise ${path === ONE ? 'one entry' : 'an entry on four lines'}: the raises add up, both reasons stay, and the size check passes on it, no looser`, () => {
    const { r, res } = both(path, [5, ' (+5: theirs, #2)'], [3, ' (+3: mine, #1)']);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(shownList(r) + '\n', entry(list, path, 8, ' (+5: theirs, #2) (+3: mine, #1)'));
    check(r, path);
  });
}

test('a raise both branches made alike counts twice', () => {
  const { r, res } = both(ONE, [4, ' (+4: theirs, #2)'], [4, ' (+4: mine, #1)']);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(size(shownList(r), ONE), sizes.get(ONE)! + 8);
  check(r, ONE);
});

test('two branches that raise neighbouring entries both ship', () => {
  const { r, res } = both(ONE, [5, ' (+5: theirs, #2)'], [3, ' (+3: mine, #1)'], NEXT);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(shownList(r) + '\n', entry(entry(list, ONE, 5, ' (+5: theirs, #2)'), NEXT, 3, ' (+3: mine, #1)'));
  check(r, NEXT);
});

for (const [what, theirs, mine] of [
  ['main lowered and the branch raised', -20, 3],
  ['main raised and the branch lowered', 5, -20],
  ['both lowered', -20, -10],
] as const) {
  test(`an entry ${what} adds up`, () => {
    const { r, res } = both(ONE, [theirs, ` (${theirs}: theirs, #2)`], [mine, ` (${mine}: mine, #1)`]);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(shownList(r) + '\n', entry(list, ONE, theirs + mine, ` (${theirs}: theirs, #2) (${mine}: mine, #1)`));
    check(r, ONE);
  });
}

test('two branches that each list a new file at the end both stay', () => {
  const r = start();
  const add = (f: string) => list.replace(/^};$/m, `  '${f}': [1600, 'new'],\n};`);
  write(r.source, { [LIST]: add('src/b.ts'), 'src/b.ts': body(1600) }, '#2: theirs');
  write(r.wt, { [LIST]: add('src/a.ts'), 'src/a.ts': body(1600) }, '#1: mine');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.match(shownList(r), /'src\/b\.ts': \[1600, 'new'\],\n {2}'src\/a\.ts': \[1600, 'new'\],\n\};/);
  check(r, 'src/a.ts');
});

test('a file both branches list is refused before the line: the last of two entries would win', () => {
  const r = start();
  const add = (n: number) => list.replace(/^};$/m, `  'src/b.ts': [${n}, 'new'],\n};`);
  write(r.source, { [LIST]: add(1510) }, '#2: theirs');
  write(r.wt, { [LIST]: add(1520) }, '#1: mine');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /smoke: it conflicts with main/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

test('a reason both branches rewrote is refused before the line, naming the file, and main stays', () => {
  const r = start();
  const rewritten = (words: string) => list.replace(read(list, ONE)[3]!, words);
  write(r.source, { [LIST]: rewritten('theirs say this') }, '#2: theirs');
  write(r.wt, { [LIST]: rewritten('mine goes otherwise') }, '#1: mine');
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /smoke: it conflicts with main/);
  assert.match(res.stderr, /size-budget\.test\.ts/);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
});

test('in a ship train: two riders that raise the entry the front raised all ship on one run, the raises added up', async () => {
  const raise = (by: number, n: number) => ({ change: [LIST, entry(list, ONE, by, ` (+${by}: ship ${n}, #${n})`)] as [string, string], also: [`f${n}.txt`, `${n}\n`] as [string, string] });
  const l = await line([{}, raise(5, 2), raise(3, 3), raise(3, 4)], {}, (r: R) => write(r.source, base(), 'the list and its files'));
  const done = await l.go();
  shipped(l, done[2]!, 3, 2, 3);
  shipped(l, done[3]!, 4, 2, 3);
  assert.equal(shownList(l.r) + '\n', entry(list, ONE, 11, ' (+5: ship 2, #2) (+3: ship 3, #3) (+3: ship 4, #4)'));
  l.done();
});

// #2139: on 2026-11-25 ships that each grew a big file a little passed alone and went red together, and each was sent
// back from the train in turn. A ship that fits alone but not after the ships in line hears so before the line.
test('a ship that fits alone but not after the ships in line is refused before the line: the file, how far over, and who used the room (#2139)', () => {
  const r = start();
  const ahead = join(r.dir, 'ahead');
  git(r.source, 'worktree', 'add', '-q', '-b', 'ticket/9-ahead', ahead);
  write(ahead, { [ONE]: resized(ONE, SLACK - 10, 'top') }, '#9: ahead');
  write(r.wt, { [ONE]: resized(ONE, 20, 'bottom') }, '#1: mine');
  // Its ticket in the line, this test's process standing in for its land.sh.
  const queue = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'queue');
  mkdirSync(queue, { recursive: true });
  writeFileSync(join(queue, '0000000001'), `${process.pid} 1\n0\nticket/9-ahead\nwaiting\norder\ntrain\n`);
  const main = git(r.source, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  const n = sizes.get(ONE)!;
  assert.match(res.stderr, new RegExp(`^land: smoke: size room: ${ONE.replaceAll('.', '\\.')} would be ${n + SLACK + 10} lines, 10 over its limit ${n + SLACK} .* the ships ahead: ticket/9-ahead \\+${SLACK - 10}, and ticket/1-x adds 20`, 'm'));
  assert.match(res.stderr, /smoke: a file it grows would be over its size limit after the ships in line, before the line/);
  assert.doesNotMatch(res.stderr, /^(queue|land: rebasing)/m, 'it never got in line');
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  rmSync(join(queue, '0000000001'));
  const alone = r.run();
  assert.equal(alone.status, 0, alone.stderr);
});

// The size test as a stand-in citadel-test runs it for the guards (land.sh's guard_run), naming the file it fails.
const sizeGuard = (r: R) => {
  write(
    r.source,
    {
      ...base(),
      'tools/citadel-test': `#!/usr/bin/env bash
case " $* " in *" ${LIST} "*) ;; *) exit 0 ;; esac
out=$("${process.execPath}" --no-warnings --test ${LIST} 2>&1) && exit 0
grep 'lines, limit' <<<"$out"
echo "✖ ${LIST}:1 › over"
exit 1
`,
    },
    'the list, its files and the guard',
  );
  chmodSync(join(r.source, 'tools/citadel-test'), 0o755);
  git(r.source, 'commit', '-qam', 'the guard runs');
};

test('in a ship train, the rider whose growth takes a file over is the one refused, told how far over and which ships ahead used the room (#2139)', async () => {
  const grow = (by: number, end: 'top' | 'bottom') => ({ change: [ONE, resized(ONE, by, end)] as [string, string] });
  const l = await line([{}, grow(30, 'top'), grow(30, 'bottom'), {}], { LAND_SMOKE: '0' }, sizeGuard);
  const done = await l.go();
  const n = sizes.get(ONE)!;
  assert.equal(done[2]!.status, 1, done[2]!.stderr);
  assert.match(done[2]!.stderr, /the guard tests failed on ticket\/2-x's ship train in test\/size-budget\.test\.ts with ticket\/3-x on it and passed on the train before it/);
  assert.match(done[2]!.stderr, new RegExp(`size room: ${ONE.replaceAll('.', '\\.')} would be ${n + 60} lines, 10 over its limit ${n + SLACK} .* the ships ahead: ticket/2-x \\+30, and ticket/3-x adds 30`));
  for (const i of [1, 2, 4]) assert.equal(done[i - 1]!.status, 0, `ship ${i}: ${done[i - 1]!.stderr}`);
  shipped(l, done[3]!, 4, 2, 2);
  l.done();
});

test('NOT_JUDGES call counts in the judges test merge the same way', () => {
  // The list alone: the judges test itself can't run in the fixture, whose CI fallback runs every test file.
  const judges = /^const NOT_JUDGES[^]*?^\};\n/m.exec(real(JUDGES))![0];
  const calls = (text: string, file: string, by: number, note: string) => {
    const out = text.replace(new RegExp(`^( {2}'${file}': \\{ why: (['"]).*)(\\2, calls: )(\\d+)( \\},)$`, 'm'), (_, a, _q, c, n, d) => `${a}${note}${c}${Number(n) + by}${d}`);
    assert.notEqual(out, text, `a line for ${file}`);
    return out;
  };
  const r = setup();
  write(r.source, { [JUDGES]: judges }, 'the judges list');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  const [file, next] = [...judges.matchAll(/^ {2}'([^']+)': \{ why/gm)].slice(0, 2).map((m) => m[1]!) as [string, string]; // neighbours
  write(r.source, { [JUDGES]: calls(judges, file, 2, '; theirs (#2)') }, '#2: theirs');
  write(r.wt, { [JUDGES]: calls(calls(judges, file, 1, '; mine (#1)'), next, 1, '; mine too (#1)') }, '#1: mine');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.source, 'show', `main:${JUDGES}`) + '\n', calls(calls(judges, file, 3, '; theirs (#2); mine (#1)'), next, 1, '; mine too (#1)'));
});
