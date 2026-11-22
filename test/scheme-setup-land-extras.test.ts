// The scheme-setup template land.sh: the last of Citadel's own land.sh extras as core hooks and settings (#1571, one
// ship batching step 3b, ADR 0026): FLAKE_RUNS, PARK_RETRIES, land_ci_more, land_main_red, land_recover, land_under,
// land_suspect, a MERGES hook beside append rules, and CONFLICT_PREP. Each is off by default, which the template's other tests pin
// by passing unchanged.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ciSetup, git, GREEN, RED, setup, until } from './scheme-setup-land-fixture.ts';

test('FLAKE_RUNS: a CI red that land_flaky calls flakes only gets that many fresh runs, keeping its place', async () => {
  const c = ciSetup(1, { stack: '1', local: `FLAKE_RUNS=2\nland_flaky() { echo 'ci:tests'; }\n` });
  try {
    const a = c.land(1);
    const ta = await c.tip(a);
    c.verdict(ta, RED, true);
    assert.equal(await c.tip(a, 2), ta);
    assert.match(a.stderr(), /CI's red on [0-9a-f]{12} was flakes only \(land_flaky: ci:tests\): fresh run 1 of 2, keeping its place in line/);
    c.verdict(ta, RED, true);
    assert.equal(await c.tip(a, 3), ta);
    assert.match(a.stderr(), /fresh run 2 of 2/);
    c.verdict(ta, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(c.mainAt(), ta);
  } finally {
    c.stop();
  }
});

test('FLAKE_RUNS=0 turns the fresh run off, and a value that is not a number refuses', async () => {
  const c = ciSetup(1, { stack: '1', local: `FLAKE_RUNS=0\nland_flaky() { echo 'ci:tests'; }\n` });
  try {
    const a = c.land(1);
    c.verdict(await c.tip(a), RED);
    assert.equal(await a.exit, 1, a.stderr());
    assert.equal(c.sent(a).length, 1);
  } finally {
    c.stop();
  }
  const r = setup('true', {}, 'FLAKE_RUNS=lots\n');
  r.commit(r.wt, 'b.txt', 'b\n');
  const out = r.run();
  assert.equal(out.status, 1, out.stderr);
  assert.match(out.stderr, /FLAKE_RUNS is a number from 0 up, not "lots"/);
});

test('PARK_RETRIES: where CI gives no answer it asks CI again in place that many times, then parks; an answer lands', async () => {
  const c = ciSetup(2, { stack: '1', local: 'PARK_RETRIES=1\n' });
  try {
    const a = c.land(1, { LAND_CI_START: '2' });
    const ta = await c.tip(a);
    await until(`the retry: ${a.stderr()}`, () => /asking CI again in place instead of parking \(1 of 1\)/.test(a.stderr()));
    assert.equal(await c.tip(a, 2), ta, 'the same commit, pushed again');
    c.verdict(ta, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    const b = c.land(2, { LAND_CI_START: '1' });
    assert.equal(await b.exit, 75, b.stderr());
    assert.equal(c.sent(b).length, 2, 'one ask again, then it parks');
    assert.equal(c.mainAt(), ta);
  } finally {
    c.stop();
  }
});

test('land_ci_more: CI past CI_LIMIT gets the time the hook gives, once per key; a used key or no answer ends the wait', async () => {
  const c = ciSetup(1, { stack: '1', local: `land_ci_more() { echo "$1 [$2]" >>"$CI_DIR/more.log"; echo "1 queued a runner was busy"; }\nland_fallback() { return 1; }\n` });
  try {
    const a = c.land(1, { LAND_CI_TIMEOUT: '1' });
    const ta = await c.tip(a);
    assert.equal(await a.exit, 1, a.stderr());
    assert.match(a.stderr(), /CI on [0-9a-f]{12} ran past its 1 s?.*land_ci_more gives it 1s more \(queued: a runner was busy\)/);
    const calls = readFileSync(join(c.ci, 'more.log'), 'utf8').trim().split('\n');
    assert.deepEqual(calls.map((l) => l.replace(/^(\S{12})\S*/, '$1')), [`${ta} []`, `${ta} [queued]`], 'asked again with the key it gave, which it may not take twice');
  } finally {
    c.stop();
  }
});

test('land_main_red: a check red only on failures the hook says are red on main too goes on; any other refuses', () => {
  const local = `land_main_red() { echo "$1 $2" >>"$MR_LOG"; grep -F test/old.test.ts || true; }\n`;
  const check = 'for f in $FAILS; do printf "test at %s:3:1\\n" "$f"; done; exit 1';
  const r = setup(check, {}, local);
  const log = join(r.dir, 'mr.log');
  r.commit(r.main, 'm.txt', 'main\n');
  r.commit(r.wt, 'b.txt', 'b\n');
  const before = git(r.main, 'rev-parse', 'main');
  const bad = r.run({ MR_LOG: log, FAILS: 'test/old.test.ts test/new.test.ts' });
  assert.equal(bad.status, 1, bad.stderr);
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
  const ok = r.run({ MR_LOG: log, FAILS: 'test/old.test.ts' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, /the check failed only on known reds, so it goes on: test\/old\.test\.ts: red on main's tip too/);
  const [m, c] = readFileSync(log, 'utf8').trim().split('\n').at(-1)!.split(' ');
  assert.equal(m, before, "given main's tip");
  assert.equal(c, git(r.main, 'rev-parse', 'main'), 'and the commit the check ran on');
});

test('land_recover runs in the main checkout with its tip before each land, and its failure refuses', () => {
  const r = setup('true', {}, `land_recover() { echo "$PWD $1" >>"$REC_LOG"; return "\${REC_RC:-0}"; }\n`);
  const log = join(r.dir, 'rec.log');
  r.commit(r.wt, 'b.txt', 'b\n');
  const before = git(r.main, 'rev-parse', 'main');
  const no = r.run({ REC_LOG: log, REC_RC: '3' });
  assert.equal(no.status, 1, no.stderr);
  assert.match(no.stderr, /land\.local\.sh's land_recover failed \(exit 3\), so nothing landed/);
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
  const ok = r.run({ REC_LOG: log });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n')[0], `${r.main} ${before}`);
});

test('land_under: the rebase replays only the commits above the one it names; a commit not under the branch refuses', () => {
  const r = setup('true', {}, 'land_under() { [ ! -e "$UNDER" ] || cat "$UNDER"; }\n');
  const under = join(r.dir, 'under');
  // A commit main took and a deploy then rolled back: the branch still has it under its own.
  r.commit(r.wt, 'rolled.txt', 'back\n');
  const x = git(r.wt, 'rev-parse', 'HEAD');
  r.commit(r.wt, 'b.txt', 'b\n');
  r.commit(r.main, 'm.txt', 'main\n');
  writeFileSync(under, git(r.main, 'rev-parse', 'main'));
  const bad = r.run({ UNDER: under });
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stderr, /land_under printed "[0-9a-f]+", which is not a commit under ticket\/1-x's/);
  writeFileSync(under, `${x}\n`);
  const ok = r.run({ UNDER: under });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, new RegExp(`the rebase replays only ticket/1-x's commits above ${x.slice(0, 12)} \\(land_under\\)`));
  assert.deepEqual(git(r.main, 'log', '--format=%s', 'main').split('\n'), ['b.txt: b', 'm.txt: main', 'base']);
});

test('land_under: asked again right before the rebase, so a roll back after the early checks still stays off main', () => {
  // The first ask (the early checks) has nothing yet; the deploy rolls back while the landing waits.
  const r = setup('true', {}, 'land_under() { echo x >>"$ASKED"; [ "$(wc -l <"$ASKED")" -lt 2 ] || cat "$UNDER"; }\n');
  const under = join(r.dir, 'under');
  const asked = join(r.dir, 'asked');
  r.commit(r.wt, 'rolled.txt', 'back\n');
  writeFileSync(under, `${git(r.wt, 'rev-parse', 'HEAD')}\n`);
  r.commit(r.wt, 'b.txt', 'b\n');
  r.commit(r.main, 'm.txt', 'main\n');
  const ok = r.run({ UNDER: under, ASKED: asked });
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(readFileSync(asked, 'utf8').split('\n').length > 2, 'asked more than once');
  assert.deepEqual(git(r.main, 'log', '--format=%s', 'main').split('\n'), ['b.txt: b', 'm.txt: main', 'base']);
});

// land_suspect (Cara, 2026-11-22, "Port it as a hook"): a red batch tries the member the hook guesses first, the one
// below it, then it, before halving. Four members, the top red: halving would push the 2nd; the guess (the top) pushes the 3rd.
const gated = 'until [ -e "$GATE" ]; do sleep 0.05; done';
const suspectHook = `land_suspect() { { echo "$*"; cat; } >>"$CI_DIR/suspect.log"; [ ! -e "$CI_DIR/guess" ] || cat "$CI_DIR/guess"; }\n`;
test('land_suspect: a red batch runs CI on the member below the guess, then refuses the guess with no halving', async () => {
  const c = ciSetup(4, { stack: '1', batch: '4', check: gated, local: suspectHook });
  try {
    const [a, b, d, e] = await c.lands(1, 2, 3, 4);
    const base = c.mainAt();
    c.open();
    const te = await c.tip(e);
    const td = c.parent(te), tb = c.parent(td), ta = c.parent(tb);
    const full = git(c.main, 'rev-parse', te);
    writeFileSync(join(c.ci, 'guess'), `${full}\n`);
    c.verdict(te, RED);
    assert.equal(await c.tip(d), td, 'the member just below the guess pushes, not the halfway one');
    assert.match(e.stderr(), /land_suspect guesses ticket\/4-x \([0-9a-f]{12}\) turned CI red, so the bisect tries it first/);
    const asked = readFileSync(join(c.ci, 'suspect.log'), 'utf8').split('\n')[0].split(' ');
    assert.deepEqual(asked.map((x) => x.slice(0, 12)), [base, ta, tb, td, te], "main's commit, then each member's");
    assert.deepEqual([c.sent(a), c.sent(b)], [[], []]);
    c.verdict(td, GREEN);
    for (const l of [a, b, d]) assert.equal(await l.exit, 0, l.stderr());
    assert.equal(await e.exit, 1, e.stderr());
    assert.match(e.stderr(), /CI is red on [0-9a-f]{12} \(above\), so main is untouched/);
    assert.deepEqual(c.landed(), ['f1.txt: 1', 'f2.txt: 2', 'f3.txt: 3']);
    assert.equal(c.sent(e).length, 1, 'two CI runs in all, where halving takes three');
  } finally {
    c.stop();
  }
});

test('land_suspect: an answer that is no member of the batch is said, and the red batch halves as always', async () => {
  const c = ciSetup(4, { stack: '1', batch: '4', check: gated, local: suspectHook });
  try {
    const [a, b, , e] = await c.lands(1, 2, 3, 4);
    writeFileSync(join(c.ci, 'guess'), `${c.mainAt()}\n`);
    c.open();
    const te = await c.tip(e);
    const tb = c.parent(c.parent(te));
    c.verdict(te, RED);
    assert.equal(await c.tip(b), tb, 'the halfway member pushes');
    assert.match(e.stderr(), /land_suspect printed "[0-9a-f]+", which is not the commit of a member of this batch, so the red batch's bisect halves/);
    assert.deepEqual(c.sent(a), []);
  } finally {
    c.stop();
  }
});

// Citadel's src/db.ts: SCHEMA_HISTORY renumbered by its own driver (tools/ship-numbers.ts, the hook) and MIGRATIONS
// appended by rule, in one file.
const DB_FILE = 'src/db.ts';
const db = (history: string[], cols: string[]) =>
  `export const SCHEMA_HISTORY = [\n${history.map((h, i) => `  [${i + 1}, '${h}'],\n`).join('')}] as const;\n\nexport const x = 1;\n\nconst MIGRATIONS: [table: string, column: string, ddl: string][] = [\n  ['tickets', 'a', 'TEXT'],\n${cols.map((c) => `  ['tickets', '${c}', 'TEXT'],\n`).join('')}];\n\nexport function migrate() {}\n`;
const HOOK_LOCAL = `MERGES='
${DB_FILE} hook
${DB_FILE} append ^const\\ MIGRATIONS
'
land_merge() { node "$(git rev-parse --show-toplevel)/tools/ship-numbers.ts" merge "$1" "$2" "$3" "$4"; }
`;

test('MERGES: a hook beside an append rule renumbers with the hook and appends the clash it leaves, alone and by its own', () => {
  const r = setup('true', {}, HOOK_LOCAL);
  copyFileSync(join(import.meta.dirname, '..', 'tools', 'ship-numbers.ts'), join(r.main, 'tools', 'ship-numbers.ts'));
  mkdirSync(dirname(join(r.main, DB_FILE)), { recursive: true });
  writeFileSync(join(r.main, DB_FILE), db(['first'], []));
  git(r.main, 'add', '-A');
  git(r.main, 'commit', '-qm', 'shared base');
  git(r.wt, 'merge', '-q', '--ff-only', 'main');
  writeFileSync(join(r.main, DB_FILE), db(['first', 'main'], ['b']));
  git(r.main, 'commit', '-qam', 'main: #9');
  writeFileSync(join(r.wt, DB_FILE), db(['first', 'branch'], ['c']));
  git(r.wt, 'commit', '-qam', 'branch: #2');
  const out = r.run();
  assert.equal(out.status, 0, out.stderr);
  assert.equal(git(r.main, 'show', `main:${DB_FILE}`) + '\n', db(['first', 'main', 'branch'], ['b', 'c']), "main's number kept, the branch's renumbered after it, both migrations");
  // The hook alone still decides the whole file: a clash only the append rule could take refuses.
  const s = setup('true', {}, HOOK_LOCAL.replace(/^src\/db\.ts append.*\n/m, ''));
  copyFileSync(join(import.meta.dirname, '..', 'tools', 'ship-numbers.ts'), join(s.main, 'tools', 'ship-numbers.ts'));
  mkdirSync(dirname(join(s.main, DB_FILE)), { recursive: true });
  writeFileSync(join(s.main, DB_FILE), db(['first'], []));
  git(s.main, 'add', '-A');
  git(s.main, 'commit', '-qm', 'shared base');
  git(s.wt, 'merge', '-q', '--ff-only', 'main');
  writeFileSync(join(s.main, DB_FILE), db(['first'], ['b']));
  git(s.main, 'commit', '-qam', 'main: #9');
  writeFileSync(join(s.wt, DB_FILE), db(['first'], ['c']));
  git(s.wt, 'commit', '-qam', 'branch: #2');
  const no = s.run();
  assert.equal(no.status, 1, no.stderr);
});

test('CONFLICT_PREP: a stacked ship that conflicts with the one ahead says what fix to record; once recorded, both ship', async () => {
  const c = ciSetup(2, { stack: '2', files: () => 'a.txt', local: 'CONFLICT_PREP=1\n' });
  const scratch = join(c.dir, 'fix');
  try {
    const [a, b] = await c.lands(1, 2);
    const ta = await c.tip(a);
    const prep = /prep: ticket\/2-x will conflict with ticket\/1-x once ticket\/1-x ships; conflicted files: a\.txt; record the fix against ([0-9a-f]+) from ([0-9a-f]+) to ([0-9a-f]+)/;
    await until(`the prep line: ${b.stderr()}`, () => prep.test(b.stderr()));
    const [, against, from, to] = prep.exec(b.stderr())!;
    assert.equal(against.slice(0, 12), ta, 'against the commit ahead');
    assert.equal(from, git(c.main, 'merge-base', 'main', 'ticket/2-x'));
    assert.equal(to, git(c.main, 'rev-parse', 'ticket/2-x'));
    assert.equal(c.sent(b).length, 0, 'it waits rather than sending CI a build it could not make');
    // The fix, recorded in a scratch worktree as a minion would: rerere keeps it in the repo's shared rr-cache.
    git(c.main, 'worktree', 'add', '-q', '--detach', scratch, against);
    const rr = ['-c', 'rerere.enabled=true'];
    assert.throws(() => git(scratch, ...rr, 'cherry-pick', `${from}..${to}`));
    writeFileSync(join(scratch, 'a.txt'), '1\n2\n');
    git(scratch, ...rr, 'add', 'a.txt');
    git(scratch, ...rr, 'rerere');
    git(scratch, 'cherry-pick', '--abort');
    const tb = await c.tip(b);
    assert.match(b.stderr(), /prep: ticket\/2-x conflicts with [0-9a-f]+ by its rebase, but the fix recorded ahead of time \(git rerere\) resolves it/);
    c.verdict(ta, GREEN);
    c.verdict(tb, GREEN);
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 0, b.stderr());
    assert.equal(git(c.main, 'show', 'main:a.txt'), '1\n2');
    assert.equal(git(c.main, 'config', '--get', 'rerere.enabled'), 'false', 'rerere stays off for the repo itself');
  } finally {
    c.stop();
    rmSync(scratch, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});
