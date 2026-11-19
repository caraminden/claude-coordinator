// The scheme-setup template land.sh: the land itself, numbered things and the line for the land lock.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { root, env, git, n, setup, landLockFree, until, queueSetup, sleep } from './scheme-setup-land-fixture.ts';

test('rebases onto main, checks, fast-forwards main and pushes it past the pre-push hook', () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  r.commit(r.main, 'c.txt', 'someone else\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  const tip = git(r.wt, 'rev-parse', 'HEAD');
  assert.equal(git(r.main, 'rev-parse', 'main'), tip);
  assert.equal(git(r.origin, 'rev-parse', 'main'), tip);
  assert.equal(git(r.main, 'log', '--format=%s', '-3'), 'b.txt: mine\nc.txt: someone else\nbase');
});

test('a red check leaves main and origin untouched', () => {
  const r = setup();
  const before = git(r.main, 'rev-parse', 'main');
  r.commit(r.wt, 'red', 'x\n');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /check failed/);
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
  assert.equal(git(r.origin, 'rev-parse', 'main'), before);
});

// The check runs under the land lock, so it must end and must not take the lock with it (#468 S10-2).

test('a check that hangs is stopped at the time limit, says so, and lets go of the lock', () => {
  const r = setup('sleep 30');
  const before = git(r.main, 'rev-parse', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const t = Date.now();
  const res = r.run({ LAND_CHECK_TIMEOUT: '2' });
  assert.ok(Date.now() - t < 20_000, `stopped at the limit, not run out: ${Date.now() - t} ms`);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /the check ran past 2s and was stopped/);
  assert.match(res.stderr, /check failed/);
  assert.equal(git(r.main, 'rev-parse', 'main'), before);
  assert.ok(landLockFree(r), 'the land lock is free');
});

test('a process the check leaves running does not hold the land lock', () => {
  const pidFile = join(root, `left-${n + 1}.pid`);
  const r = setup('sleep 30 >/dev/null 2>&1 & echo $! >"$LEFT_PID"');
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = r.run({ LEFT_PID: pidFile });
  const pid = Number(readFileSync(pidFile, 'utf8'));
  try {
    assert.equal(res.status, 0, res.stderr);
    assert.ok(landLockFree(r), 'the land lock is free while the leftover process runs');
  } finally {
    process.kill(pid);
  }
});

// Theory of Crafting, 2026-11-11: a landing run inside a person's container can't see the host's pids (its own pid
// namespace), so it swept every live ticket ahead of it as dead. The land tool runs it on the host instead.
test("refuses in a person's container, before it takes a place in line", () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'two\n');
  const res = r.run({ COORDINATOR_CONTAINER: '1' });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /runs in a container: call the land tool/);
  assert.equal(existsSync(join(r.main, '.git', 'land-queue')), false, 'it never joined the line');
  assert.equal(git(r.main, 'log', '-1', '--format=%s'), 'base');
});

test('a rebase conflict aborts and leaves main untouched', () => {
  const r = setup();
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.main, 'a.txt', 'theirs\n');
  const mine = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.main, 'rev-parse', 'main');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /rebase onto main failed/);
  assert.equal(git(r.main, 'rev-parse', 'main'), main);
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), mine);
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
});

test('--check (#770) says whether the rebase onto main would conflict, naming the files, and changes nothing', () => {
  const r = setup();
  const check = (...args: string[]) => spawnSync('bash', [join(r.wt, 'tools', 'land.sh'), '--check', ...args], { cwd: r.wt, encoding: 'utf8', env });
  r.commit(r.wt, 'a.txt', 'mine\n');
  r.commit(r.main, 'b.txt', 'clean\n');
  let res = check();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  r.commit(r.main, 'a.txt', 'theirs\n');
  const mine = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.main, 'rev-parse', 'main');
  res = check();
  assert.equal(res.status, 3);
  assert.equal(res.stderr, `land: ticket/1-x won't rebase onto main (${main.slice(0, 7)} "a.txt: theirs") cleanly, by git merge-tree at hand-off, so nothing landed; conflicted files: a.txt. On conflicts: run git rebase main, resolve them keeping the other minions' changes, re-test, commit, then run this again\n`);
  assert.equal(git(r.main, 'rev-parse', 'main'), main);
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), mine);
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
  assert.ok(!existsSync(join(git(r.main, 'rev-parse', '--absolute-git-dir'), 'land-queue')), 'no place in line');
  assert.equal(check('x').status, 1, 'nothing else after it');
  assert.match(check('x').stderr, /takes no arguments/);
});

test("a stale squash, which reverts what landed since the branch started, is refused until it names each undo (#677)", () => {
  const r = setup();
  r.commit(r.wt, 'b.txt', 'mine\n');
  r.commit(r.main, 'c.txt', [1, 2, 3, 4, 5].map((k) => `someone else landed this, line ${k}\n`).join(''));
  const main = git(r.main, 'rev-parse', 'main');
  git(r.wt, 'reset', '--soft', 'main');
  git(r.wt, 'commit', '-qm', 'squashed');
  const mine = git(r.wt, 'rev-parse', 'HEAD');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, new RegExp(`removes what these landed, without naming them:\\nland:   ${main.slice(0, 12)} c\\.txt: .*\\(5 of the 5 lines[^]*"Undoes: <sha>"`));
  assert.equal(git(r.main, 'rev-parse', 'main'), main);
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), mine, 'the branch is back where it was');
  git(r.wt, 'commit', '-q', '--amend', '-m', `squashed\n\nUndoes: ${main}`);
  const again = r.run();
  assert.equal(again.status, 0, again.stderr);
  assert.equal(git(r.main, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
});

// The Trans Agenda #66, 2026-11-15: a nightly export repeats lines like "linked: null" in every record, so its
// revert put back the old records' copies and those counted as moves of the new ones: 89% removed, under the bar.
const records = (dir: string, names: string[]) => {
  for (const name of names) {
    writeFileSync(join(dir, `${name}.yaml`), [`id: record-${name}`, `title: the ${name} record`, `source: https://example.org/${name}`, `notes: none for ${name}`, 'linked: null', "answer: 'no' given"].join('\n') + '\n');
  }
  git(dir, 'add', '-A');
};

test('a stale squash that reverts an export of records repeating lines is still refused (Trans Agenda #66)', () => {
  const r = setup();
  records(r.main, ['old']);
  git(r.main, 'commit', '-qm', 'nightly export 1');
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.wt, 'b.txt', 'mine\n');
  git(r.main, 'rm', '-q', 'old.yaml');
  records(r.main, ['new1', 'new2', 'new3', 'new4']);
  git(r.main, 'commit', '-qm', 'nightly export 2');
  const main = git(r.main, 'rev-parse', 'main');
  git(r.wt, 'reset', '--soft', 'main');
  git(r.wt, 'commit', '-qm', 'squashed');
  const res = r.run();
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, new RegExp(`removes what these landed, without naming them:\\nland:   ${main.slice(0, 12)} nightly export 2 \\(22 of the 24 lines`));
  assert.equal(git(r.main, 'rev-parse', 'main'), main);
});

test('moving records with repeated lines into one file is a move, not an undo', () => {
  const r = setup();
  records(r.main, ['one', 'two']);
  git(r.main, 'commit', '-qm', 'two records');
  git(r.wt, 'rebase', '-q', 'main');
  const both = readFileSync(join(r.wt, 'one.yaml'), 'utf8') + readFileSync(join(r.wt, 'two.yaml'), 'utf8');
  git(r.wt, 'rm', '-q', 'one.yaml', 'two.yaml');
  writeFileSync(join(r.wt, 'all.yaml'), both);
  git(r.wt, 'add', '-A');
  git(r.wt, 'commit', '-qm', 'one file for the records');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.main, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
});

test("a WIP commit of the branch's own ticket is the branch's, not an undo", () => {
  const r = setup();
  writeFileSync(join(r.main, 'c.txt'), [1, 2, 3, 4, 5].map((k) => `an earlier part of #1, line ${k}\n`).join(''));
  git(r.main, 'add', '-A');
  git(r.main, 'commit', '-qm', 'WIP #1: the first part');
  git(r.wt, 'rebase', '-q', 'main');
  git(r.wt, 'rm', '-q', 'c.txt');
  git(r.wt, 'commit', '-qm', 'the first part goes');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
});

test('a failed push keeps main moved and says so', () => {
  const r = setup();
  git(r.main, 'remote', 'set-url', 'origin', join(r.dir, 'missing.git'));
  r.commit(r.wt, 'b.txt', 'mine\n');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /main moved, but the push to origin failed/);
  assert.equal(git(r.main, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
});

test('the pre-push template refuses a push to main from the same clone', () => {
  const r = setup();
  r.commit(r.main, 'b.txt', 'unlanded\n');
  const res = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: r.main, encoding: 'utf8', env });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /push to main refused/);
});

// The numbered-things check: a scheme whose Project facts name its migrations, a version and a ledger.
// The line wraps onto a second line, as Project facts bullets do.
const facts = [
  '## Project facts',
  '',
  '- **Check commands:** none.',
  '- **Numbered things:** `files db/migrations/NNNN-*.sql`; `ids docs/ledger.md "^- \\*\\*U(\\d+)\\."`;',
  '  `version addons/*/*.toc "^## Version: (.+)"`',
  '- **Glossary:** none.',
  '',
].join('\n');
const ledger = (open: string, proven: string) => `# Ledger\n\n## Open\n\n${open}\n## Proven\n\n${proven}\n## End\n`;
function numbered() {
  const r = setup();
  r.commit(r.main, 'CLAUDE.md', facts);
  r.commit(r.main, 'db/migrations/0001-base.sql', 'create\n');
  r.commit(r.main, 'docs/ledger.md', ledger('- **U1.** one\n', '- **U2.** two\n'));
  r.commit(r.main, 'addons/beacon/beacon.toc', '## Title: Beacon\n## Version: 0.2.0\n');
  git(r.wt, 'rebase', '-q', 'main');
  return r;
}
function refused(r: ReturnType<typeof setup>, res: ReturnType<typeof r.run>, mine: string, main: string, says: RegExp) {
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, says);
  assert.match(res.stderr, /takes a number main already has .*back where it was\. Renumber yours past main's highest/);
  assert.equal(git(r.main, 'rev-parse', 'main'), main, 'main untouched');
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), mine, 'the branch is put back unrebased');
  assert.equal(git(r.wt, 'status', '--porcelain'), '');
}

test('numbered things: a migration number main already has is refused, naming both files', () => {
  const r = numbered();
  r.commit(r.wt, 'db/migrations/0002-mine.sql', 'mine\n');
  r.commit(r.main, 'db/migrations/0002-theirs.sql', 'theirs\n');
  const mine = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.main, 'rev-parse', 'main');
  refused(r, r.run(), mine, main, /db\/migrations\/0002-mine\.sql takes number 2, which db\/migrations\/0002-theirs\.sql already has \(the highest so far is 2\)/);
});

test('numbered things: two identical version bumps, which git merges silently, are refused and stay refused', () => {
  const r = numbered();
  r.commit(r.wt, 'addons/beacon/beacon.toc', '## Title: Beacon\n## Version: 0.2.1\n');
  r.commit(r.wt, 'mine.lua', 'x\n');
  // Main's bump comes second, or it would be the very same commit as the branch's (same parent, message and second).
  r.commit(r.main, 'theirs.lua', 'y\n');
  r.commit(r.main, 'addons/beacon/beacon.toc', '## Title: Beacon\n## Version: 0.2.1\n');
  const mine = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.main, 'rev-parse', 'main');
  const says = /addons\/beacon\/beacon\.toc: this branch moves its version from 0\.2\.0 to 0\.2\.1, but main moved it to 0\.2\.1/;
  refused(r, r.run(), mine, main, says);
  // Running it again without renumbering is refused again, since the branch went back unrebased.
  refused(r, r.run(), mine, main, says);
  // Bumped past main's, it lands.
  git(r.wt, 'rebase', '-q', '-X', 'theirs', 'main');
  r.commit(r.wt, 'addons/beacon/beacon.toc', '## Title: Beacon\n## Version: 0.2.2\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.main, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
});

test('numbered things: a ledger id main already has is refused, even in another section', () => {
  const r = numbered();
  r.commit(r.wt, 'docs/ledger.md', ledger('- **U1.** one\n- **U3.** mine\n', '- **U2.** two\n'));
  r.commit(r.main, 'docs/ledger.md', ledger('- **U1.** one\n', '- **U2.** two\n- **U3.** theirs\n'));
  const mine = git(r.wt, 'rev-parse', 'HEAD');
  const main = git(r.main, 'rev-parse', 'main');
  refused(r, r.run(), mine, main, /docs\/ledger\.md has id 3 twice: this branch adds one and main already has it \(the highest so far is 3\)/);
});

test('numbered things: new numbers past main\'s, a version only the branch bumps and edits to old entries land', () => {
  const r = numbered();
  // A duplicate main already had is not this branch's to fix, even when the branch edits that entry.
  r.commit(r.main, 'docs/ledger.md', ledger('- **U1.** one\n- **U1.** old duplicate\n', '- **U2.** two\n'));
  git(r.wt, 'rebase', '-q', 'main');
  r.commit(r.main, 'db/migrations/0002-theirs.sql', 'theirs\n');
  r.commit(r.main, 'docs/ledger.md', ledger('- **U1.** one\n- **U1.** old duplicate\n', '- **U2.** two\n- **U3.** theirs\n'));
  r.commit(r.wt, 'db/migrations/0003-mine.sql', 'mine\n');
  r.commit(r.wt, 'docs/ledger.md', ledger('- **U1.** one, reworded\n- **U1.** old duplicate\n- **U4.** mine\n', '- **U2.** two\n'));
  r.commit(r.wt, 'addons/beacon/beacon.toc', '## Title: Beacon\n## Version: 0.2.1\n');
  const res = r.run();
  assert.equal(res.status, 0, res.stderr);
  assert.equal(git(r.main, 'rev-parse', 'main'), git(r.wt, 'rev-parse', 'HEAD'));
});

test('numbered things: a line that does not parse refuses and names it; "none" checks nothing', () => {
  const r = numbered();
  r.commit(r.wt, 'CLAUDE.md', facts.replace('`files db/migrations/NNNN-*.sql`', '`files db/migrations/*.sql`'));
  const mine = git(r.wt, 'rev-parse', 'HEAD');
  const res = r.run();
  assert.equal(res.status, 1);
  assert.match(res.stderr, /does not parse: "files db\/migrations\/\*\.sql": files takes one glob with NNNN/);
  assert.equal(git(r.wt, 'rev-parse', 'HEAD'), mine);
  // Only the line changes: the whole file swapped for it would undo the facts main just landed (the undo guard, #677).
  r.commit(r.wt, 'CLAUDE.md', facts.replace(/- \*\*Numbered things:\*\*.*\n.*\n/, '- **Numbered things:** none.\n'));
  r.commit(r.wt, 'db/migrations/0001-again.sql', 'dup\n');
  const ok = r.run();
  assert.equal(ok.status, 0, ok.stderr);
});

test('ten landings started together land in the order they arrived, each told its place in line', async () => {
  const q = queueSetup(10);
  const lands: ReturnType<typeof q.land>[] = [];
  try {
    for (let i = 1; i <= 10; i++) {
      lands.push(q.land(i));
      await until(`landing ${i}'s ticket`, () => q.issued() === i); // arrival order is the order of the tickets
    }
    // The first holds the lock, in its check, until all ten are in line and the last has been told its place.
    await until('the last to say its place', () => /queue: 10th in line for the land lock, about 45 min \(ahead: ticket\/1-x, running the check since \d\d:\d\d\)/.test(lands[9].stderr()));
  } finally {
    q.open();
  }
  const codes = await Promise.all(lands.map((l) => l.exit));
  codes.forEach((code, i) => assert.equal(code, 0, `landing ${i + 1}: ${lands[i].stderr()}`));
  assert.deepEqual(q.landed(), lands.map((_, i) => `f${i + 1}.txt: ${i + 1}`));
  assert.equal(git(q.origin, 'rev-parse', 'main'), git(q.main, 'rev-parse', 'main'), 'the last push carried them all');
  assert.doesNotMatch(lands[0].stderr(), /in line/, 'the first had nobody to wait for');
  assert.match(lands[9].stderr(), /queue: 2nd in line for the land lock, about \d+ min \(ahead: ticket\/9-x, /);
  assert.match(lands[9].stderr(), /queue: got the land lock/);
  assert.deepEqual(q.tickets(), [], 'every ticket is gone');
  assert.equal(readFileSync(join(q.state, 'land-queue', '.took'), 'utf8').trim().split('\n').length, 5, 'the newest five landings were timed, for the estimate');
  assert.ok(landLockFree(q), 'the land lock is free');
});

test('a landing waiting in line rechecks each time main moves, and leaves the line at once when it would conflict (#770)', async () => {
  // 1 and 3 change files of their own; 2 and 4 both change a.txt. Each check waits for a gate of its own.
  const q = queueSetup(4, undefined, {}, (i) => (i % 2 ? `f${i}.txt` : 'a.txt'));
  const gate = (i: number) => join(q.dir, `gate${i}`);
  const lands: ReturnType<typeof q.land>[] = [];
  try {
    for (let i = 1; i <= 4; i++) {
      lands.push(q.land(i, { GATE: gate(i) }));
      await until(`landing ${i}'s ticket`, () => q.issued() === i);
    }
    await until('landing 4 to wait in line', () => /4th in line/.test(lands[3].stderr()));
    writeFileSync(gate(1), '');
    assert.equal(await lands[0].exit, 0, lands[0].stderr());
    await until('landing 2 to take the lock', () => /got the land lock/.test(lands[1].stderr()));
    await sleep(300);
    assert.equal(q.tickets().length, 3, 'a clean move of main keeps landing 4 in line');
    writeFileSync(gate(2), '');
    assert.equal(await lands[1].exit, 0, lands[1].stderr());
    const main = git(q.main, 'rev-parse', 'main');
    assert.equal(await lands[3].exit, 1, 'landing 4 leaves while landing 3 still holds the lock');
    assert.match(lands[3].stderr(), new RegExp(`land: ticket/4-x won't rebase onto main \\(${main.slice(0, 7)} "a\\.txt: 2"\\) cleanly, by git merge-tree waiting in line, so nothing landed; conflicted files: a\\.txt\\. On conflicts: run git rebase main`));
    assert.equal(q.tickets().length, 1, 'only landing 3 is left in line');
    assert.equal(git(q.wts[3], 'branch', '--show-current'), 'ticket/4-x');
    assert.equal(git(q.wts[3], 'status', '--porcelain'), '');
    writeFileSync(gate(3), '');
    assert.equal(await lands[2].exit, 0, lands[2].stderr());
    assert.deepEqual(q.landed(), ['f1.txt: 1', 'a.txt: 2', 'f3.txt: 3']);
  } finally {
    for (let i = 1; i <= 4; i++) writeFileSync(gate(i), '');
    for (const l of lands) l.child.kill('SIGKILL'); // a failed check must not leave landings running past the test
  }
});

test('the waiters follow land-queue/.order (#1007): the ones it names first, the rest in arrival order; the holder stays', async () => {
  const q = queueSetup(4);
  const lands: ReturnType<typeof q.land>[] = [];
  try {
    for (let i = 1; i <= 4; i++) {
      lands.push(q.land(i));
      await until(`landing ${i}'s ticket`, () => q.issued() === i);
    }
    await until('the 4th to see its place', () => /4th in line/.test(lands[3].stderr()));
    const [t1, , , t4] = q.tickets();
    assert.equal(readFileSync(join(q.state, 'land-queue', t4), 'utf8').split('\n')[7], 'order', 'its ticket says it follows .order');
    // The Releases page's write: the 4th to land next, and the holder named too (it stays first whatever .order says).
    writeFileSync(join(q.state, 'land-queue', '.order'), `# Cara moved ticket/4-x to land next\n${t4}\n${t1}\n`);
    await until('the 4th to move up', () => /queue: Cara moved ticket\/4-x to land next\nqueue: 2nd in line for the land lock/.test(lands[3].stderr()));
    await until('the 2nd to move back', () => /queue: 3rd in line for the land lock[^\n]*\(ahead: ticket\/1-x/.test(lands[1].stderr()));
  } finally {
    q.open();
  }
  const codes = await Promise.all(lands.map((l) => l.exit));
  codes.forEach((code, i) => assert.equal(code, 0, `landing ${i + 1}: ${lands[i].stderr()}`));
  assert.deepEqual(q.landed(), ['f1.txt: 1', 'f4.txt: 4', 'f2.txt: 2', 'f3.txt: 3']);
  assert.doesNotMatch(lands[0].stderr(), /Cara moved/, 'the holder is not told: it stays where it is');
});

test('a waiter that is killed leaves the line, and the one behind it goes next', async () => {
  const q = queueSetup(3);
  const a = q.land(1);
  try {
    await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
    const b = q.land(2);
    await until("b's ticket", () => q.issued() === 2);
    const c = q.land(3);
    await until('c to see its place', () => /3rd in line/.test(c.stderr()));
    b.child.kill('SIGKILL');
    await b.exit;
    await until('c to move up past the dead ticket', () => /2nd in line/.test(c.stderr()));
    assert.equal(q.tickets().length, 2, 'the waiter behind it removed it');
    q.open();
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await c.exit, 0, c.stderr());
    assert.deepEqual(q.landed(), ['f1.txt: 1', 'f3.txt: 3']);
  } finally {
    q.open();
  }
});

// A zombie: b's parent starts it, then becomes a sleep that never waits on it, so once b is killed its
// /proc entry stays, start time and all, until the parent goes.
const isZombie = (pid: number) => { try { return /\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; } };

test('a killed waiter whose parent never reaps it leaves the line too', async () => {
  const q = queueSetup(3);
  const a = q.land(1);
  const pidFile = join(q.dir, 'b.pid');
  let c: ReturnType<typeof q.land> | undefined;
  let parent: ReturnType<typeof spawn> | undefined;
  try {
    await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
    parent = spawn('bash', ['-c', 'bash "$0" & echo $! >"$1"; exec sleep 600', join(q.wts[1], 'tools', 'land.sh'), pidFile], { cwd: q.wts[1], stdio: 'ignore', env: { ...env, GATE: join(q.dir, 'gate'), LAND_QUEUE_POLL: '0.05' } });
    await until("b's ticket", () => q.issued() === 2);
    c = q.land(3);
    const cs = c.stderr;
    await until('c to see its place', () => /3rd in line/.test(cs()));
    const [ta, , tc] = q.tickets();
    assert.ok(tc, 'three tickets in line');
    const b = Number(readFileSync(pidFile, 'utf8'));
    process.kill(b, 'SIGKILL');
    await until('b to be a zombie', () => isZombie(b));
    await until('c to move up past the zombie', () => /2nd in line/.test(cs()));
    assert.deepEqual(q.tickets(), [ta, tc], "the zombie's ticket was removed");
    assert.ok(isZombie(b), 'b was still a zombie when c moved up');
    q.open();
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await c.exit, 0, c.stderr());
    assert.deepEqual(q.landed(), ['f1.txt: 1', 'f3.txt: 3']);
  } finally {
    q.open();
    c?.child.kill('SIGKILL'); // with nothing ahead it would wait out the stall limit
    parent?.kill('SIGKILL');
  }
});

test('a holder that is killed leaves the line too, and its lock goes with it', async () => {
  const q = queueSetup(2);
  const a = q.land(1);
  try {
    await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
    const b = q.land(2);
    await until('b to wait', () => /2nd in line/.test(b.stderr()));
    a.child.kill('SIGKILL'); // its check runs on without the lock, until the gate opens below
    await until('b to get the lock', () => /got the land lock/.test(b.stderr()));
    q.open();
    assert.equal(await b.exit, 0, b.stderr());
    assert.deepEqual(q.landed(), ['f2.txt: 2']);
  } finally {
    q.open();
  }
});

test('a waiter gives up once nothing has moved for the stall limit, with nothing landed', async () => {
  const q = queueSetup(2);
  const a = q.land(1);
  try {
    await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
    const b = q.land(2, { LAND_CHECK_TIMEOUT: '1', LAND_QUEUE_SLACK: '1' });
    assert.equal(await b.exit, 1, 'it gives up in the end');
    assert.match(b.stderr(), /2nd in line for the land lock, about 5 min \(ahead: ticket\/1-x, running the check since/);
    assert.match(b.stderr(), /nothing has moved for 1 min \(ahead: ticket\/1-x, running the check since .*\), so this gave up and nothing landed/);
    assert.equal(q.tickets().length, 1, 'its ticket went with it');
    q.open();
    assert.equal(await a.exit, 0, a.stderr());
    assert.deepEqual(q.landed(), ['f1.txt: 1']);
  } finally {
    q.open();
  }
});

test('the stall limit is longer than the check limit, so a waiter outlasts a check that runs to its limit', async () => {
  // The holder's branch has a file that makes the check hang; the waiter's does not.
  const q = queueSetup(2, '[ ! -e f1.txt ] || sleep 30');
  const limits = { LAND_CHECK_TIMEOUT: '3', LAND_QUEUE_SLACK: '4' }; // slack to spare: bash counts whole seconds, and the box may be busy
  const a = q.land(1, limits);
  await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
  const b = q.land(2, limits);
  assert.equal(await a.exit, 1);
  assert.match(a.stderr(), /the check ran past 3s and was stopped/);
  assert.equal(await b.exit, 0, b.stderr());
  assert.match(b.stderr(), /2nd in line/);
  assert.deepEqual(q.landed(), ['f2.txt: 2']);
  assert.equal(spawnSync('bash', [join(q.wt, 'tools', 'land.sh')], { cwd: q.wt, encoding: 'utf8', env: { ...env, LAND_CHECK_TIMEOUT: '30m' } }).stderr.trim(), 'land: LAND_CHECK_TIMEOUT is in whole seconds, not "30m"');
});

test('the head of the line waits for a lock held outside it (an older land.sh), and the estimate comes from past landings', async () => {
  const q = queueSetup(2, 'true');
  mkdirSync(join(q.state, 'land-queue'));
  writeFileSync(join(q.state, 'land-queue', '.took'), '100\n140\n');
  const older = spawn('bash', ['-c', 'exec 9>"$0"; flock 9; exec sleep 600', join(q.state, 'land.lock')], { stdio: 'ignore' }); // one process, so killing it frees the lock
  try {
    await until('the lock to be held', () => !landLockFree(q));
    const a = q.land(1);
    await until('a to say it waits', () => /next in line for the land lock \(ahead: a landing started from a branch whose land.sh is older/.test(a.stderr()));
    const b = q.land(2);
    await until('b to say its place', () => /2nd in line for the land lock, about 2 min \(ahead: ticket\/1-x, waiting\)/.test(b.stderr()));
    assert.deepEqual(q.landed(), []);
    older.kill('SIGKILL');
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 0, b.stderr());
    assert.deepEqual(q.landed(), ['f1.txt: 1', 'f2.txt: 2']);
    assert.equal(readFileSync(join(q.state, 'land-queue', '.took'), 'utf8').trim().split('\n').length, 4, 'each noted how long it held the lock');
  } finally {
    older.kill('SIGKILL');
  }
});

// Citadel's pipeline failure drill, F3 (#553), in the template's own line: a waiter stopped by a SIGSTOP (state T) holds
// no land lock, yet everyone behind it waited on it with the lock free. A frozen cgroup is below.
test('a waiter that is stopped (SIGSTOP) is passed over: the one behind it takes the lock and lands, and it goes when it wakes', async () => {
  const q = queueSetup(3);
  const gate = { a: join(q.dir, 'gate-a'), c: join(q.dir, 'gate-c') };
  q.open(); // b's check
  const a = q.land(1, { GATE: gate.a });
  let b: ReturnType<typeof q.land> | undefined;
  let c: ReturnType<typeof q.land> | undefined;
  try {
    await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
    b = q.land(2);
    const bs = b.stderr;
    await until('b to say its place', () => /2nd in line/.test(bs()));
    process.kill(b.child.pid!, 'SIGSTOP');
    c = q.land(3, { GATE: gate.c });
    const cs = c.stderr;
    await until('c to say its place', () => /in line for the land lock/.test(cs()));
    writeFileSync(gate.a, '');
    assert.equal(await a.exit, 0, a.stderr());
    await until('c to take the lock past the stopped b', () => /got the land lock/.test(cs()), 15_000);
    // Awake again while the one that passed it has the lock: that is a landing in line, not one older than the line, and
    // as the holder it is ahead of every waiter (#1007).
    process.kill(b.child.pid!, 'SIGCONT');
    await until('b to say what it waits for now', () => /2nd in line for the land lock, about \d+ min \(ahead: ticket\/3-x, running the check since/.test(bs()));
    assert.doesNotMatch(bs(), /older than the line/);
    writeFileSync(gate.c, '');
    assert.equal(await c.exit, 0, cs());
    assert.equal(await b.exit, 0, bs());
    assert.deepEqual(q.landed(), ['f1.txt: 1', 'f3.txt: 3', 'f2.txt: 2']);
  } finally {
    for (const g of Object.values(gate)) writeFileSync(g, '');
    if (b) { b.child.kill('SIGCONT'); b.child.kill('SIGKILL'); }
    c?.child.kill('SIGKILL');
  }
});

// The same for a waiter frozen with `systemctl freeze` (the cgroup freezer, #585): state S, and "frozen 1" in its cgroup's
// cgroup.events. A fake cgroup root stands in for /sys/fs/cgroup, so nothing real is frozen.
test('a waiter whose cgroup is frozen (state S) is passed over like a stopped one: the one behind it takes the free lock and lands', async () => {
  const q = queueSetup(1);
  const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
  try {
    const pid = sleeper.pid!;
    await until('the frozen one to be in state S, as a frozen cgroup leaves it', () => /\) S /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')));
    const start = readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[19];
    const cg = readFileSync(`/proc/${pid}/cgroup`, 'utf8').match(/^0::(.*)$/m)![1];
    const fake = join(q.dir, 'cgroup');
    mkdirSync(join(fake, cg), { recursive: true });
    writeFileSync(join(fake, cg, 'cgroup.events'), 'populated 1\nfrozen 1\n');
    mkdirSync(join(q.state, 'land-queue'), { recursive: true });
    writeFileSync(join(q.state, 'land-queue', '0000000001'), `${pid} ${start}\n0\nticket/9-frozen\nwaiting\n-\n`);
    writeFileSync(join(q.state, 'land-queue', '.seq'), '1\n');
    q.open();
    const a = q.land(1, { LAND_CHECK_TIMEOUT: '1', LAND_QUEUE_SLACK: '1', LAND_QUEUE_CGROUP: fake });
    assert.equal(await a.exit, 0, a.stderr());
    assert.deepEqual(q.landed(), ['f1.txt: 1']);
    assert.deepEqual(q.tickets(), ['0000000001'], 'the frozen one keeps its place, to go when it thaws');
  } finally {
    sleeper.kill('SIGKILL');
  }
});

test('giving up names the process at the head of the line, its state and whether the lock is held or free', async () => {
  const q = queueSetup(3);
  const a = q.land(1);
  const stall = { LAND_CHECK_TIMEOUT: '1', LAND_QUEUE_SLACK: '1' };
  let stuck: ReturnType<typeof spawn> | undefined;
  try {
    await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
    process.kill(a.child.pid!, 'SIGSTOP'); // the holder itself is stopped: nobody can pass it
    const b = q.land(2, stall);
    assert.equal(await b.exit, 1, b.stderr());
    assert.match(b.stderr(), new RegExp(`nothing has moved for 1 min \\(ahead: ticket/1-x, running the check since \\d\\d:\\d\\d; pid ${a.child.pid}, stopped; the lock is held\\), so this gave up`));
    a.child.kill('SIGKILL');
    q.open(); // its check's subshell outlives it, holding its stderr open until the check ends
    await a.exit;
    // First in line, awake, and not taking the free lock.
    stuck = spawn('sleep', ['60'], { stdio: 'ignore' });
    const pid = stuck.pid!;
    await until('the stuck process to run', () => existsSync(`/proc/${pid}/stat`));
    const started = readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /s, '').split(' ')[19];
    const seq = Number(readFileSync(join(q.state, 'land-queue', '.seq'), 'utf8')) + 1;
    writeFileSync(join(q.state, 'land-queue', String(seq).padStart(10, '0')), `${pid} ${started}\n0\nstuck\nwaiting\n-\n`);
    writeFileSync(join(q.state, 'land-queue', '.seq'), `${seq}\n`);
    const c = q.land(3, stall);
    assert.equal(await c.exit, 1, c.stderr());
    assert.match(c.stderr(), new RegExp(`nothing has moved for 1 min \\(ahead: stuck, waiting; pid ${pid}, state S; the lock is free\\), so this gave up and nothing landed\\. A person needs to look at pid ${pid}, which is first in line and is not taking the lock, before anyone tries again`));
  } finally {
    q.open();
    a.child.kill('SIGKILL');
    stuck?.kill('SIGKILL');
  }
});

// Citadel's drill, F12b (#577): a lock file that can't be opened is named, not left to a shell or flock error.
test("a land lock that can't be opened gives up at once and says so", async () => {
  const q = queueSetup(1, 'true');
  writeFileSync(join(q.state, 'land.lock'), '', { mode: 0o444 });
  const a = q.land(1);
  assert.equal(await a.exit, 1, a.stderr());
  assert.match(a.stderr(), /queue: can't open the land lock \S+\/land\.lock for writing, so nothing landed: a person needs to look at it/);
  assert.doesNotMatch(a.stderr(), /Bad file descriptor|Permission denied|nothing has moved/);
  assert.deepEqual(q.tickets(), []);
  assert.deepEqual(q.landed(), []);
});

// F12c: junk in land-queue/.seq gave the next landing ticket 1 again, in place of the holder's, and nothing named it.
test('a land-queue/.seq that holds no number is named, and the next ticket still goes behind the ones in line', async () => {
  const q = queueSetup(2);
  const a = q.land(1);
  let b: ReturnType<typeof q.land> | undefined;
  try {
    await until('a to run its check', () => /running the check/.test(q.phase(q.tickets()[0] ?? '')));
    writeFileSync(join(q.state, 'land-queue', '.seq'), 'junk\n');
    b = q.land(2);
    const bs = b.stderr;
    await until('b to wait', () => /2nd in line/.test(bs()));
    assert.match(bs(), /queue: \S+\/land-queue\/\.seq held no ticket number \("junk"\); numbering goes on from the newest ticket, 1/);
    assert.deepEqual(q.tickets(), ['0000000001', '0000000002']);
    q.open();
    assert.equal(await a.exit, 0, a.stderr());
    assert.equal(await b.exit, 0, bs());
    assert.deepEqual(q.landed(), ['f1.txt: 1', 'f2.txt: 2']);
    assert.equal(q.issued(), 2);
  } finally {
    q.open();
    b?.child.kill('SIGKILL');
  }
});

// merge-tree reads .gitattributes from the worktree it runs in, but the rebase sees main's: a union file main gained
// after the branch forked must not make --check refuse a branch that appends to it too.
test("--check reads main's .gitattributes, so both appending to a union file is no conflict", () => {
  const r = setup();
  r.commit(r.wt, 'log.md', 'base\nmine\n');
  r.commit(r.main, '.gitattributes', 'log.md merge=union\n');
  r.commit(r.main, 'log.md', 'base\ntheirs\n');
  const res = spawnSync('bash', [join(r.wt, 'tools', 'land.sh'), '--check'], { cwd: r.wt, encoding: 'utf8', env });
  assert.equal(res.status, 0, res.stderr);
});
