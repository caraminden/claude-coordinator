// Main went back (#2077): a reset of main that drops commits tells each open minion cut from them, once, with the
// rebase that takes them out; a minion cut before, the shipper whose ship it was, and a closed one hear nothing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { MainRollbacks, rollbackMarkKey } from '../src/main-rollback.ts';

const root = mkdtempSync(join(tmpdir(), 'main-rollback-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

// Every git write at a set second (reflog entries take the committer date), so the order of moves is exact.
function repoAt(dir: string) {
  const run = (t: number, ...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: `@${t} +0000`, GIT_COMMITTER_DATE: `@${t} +0000` },
    }).trim();
  run(1, 'init', '-q', '-b', 'main');
  const tree = run(1, 'mktree', '--missing');
  const commit = (t: number, msg: string, parent?: string) => run(t, 'commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', msg);
  const move = (t: number, ref: string, sha: string, why: string) => run(t, 'update-ref', '-m', why, `refs/heads/${ref}`, sha);
  return { run, commit, move };
}

function scheme(name: string) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const store = new Store(join(root, `${name}.sqlite`));
  const project = store.createProject(name, null);
  store.setProjectRepoDir(project.id, dir);
  const minion = (branch: string) => {
    const t = store.createTicket({ project_id: project.id, title: branch, permission_mode: 'bypassPermissions', created_by: 'Josh' });
    store.setTicketDir(t.id, dir, branch);
    return t.id;
  };
  const told: { id: number; text: string }[] = [];
  const sweeper = new MainRollbacks({ store, tell: (id, text) => void told.push({ id, text }) });
  return { dir, store, project, minion, told, sweeper, ...repoAt(dir) };
}

test('a reset of main tells the minions cut from the dropped commits, and only them, once', async () => {
  const s = scheme('peek');
  const a = s.commit(100, 'base');
  s.move(100, 'main', a, 'commit (initial): base');
  // Cut before the window: its own work on main's old tip.
  const before = s.minion('ticket/1-before');
  s.move(110, 'ticket/1-before', a, 'branch: Created from main');
  s.move(111, 'ticket/1-before', s.commit(111, '#1 own', a), 'commit: #1 own');
  // The shipper: its branch is rebased onto main, then main fast-forwards onto it.
  const shipper = s.minion('ticket/2-ship');
  s.move(120, 'ticket/2-ship', a, 'branch: Created from main');
  const s1 = s.commit(121, '#2 first', a);
  const s2 = s.commit(122, '#2 second', s1);
  s.move(130, 'ticket/2-ship', s2, 'rebase (finish): refs/heads/ticket/2-ship onto ' + a);
  await s.sweeper.sweep(); // the first sweep only sets the mark
  assert.ok(s.store.getSetting(rollbackMarkKey(s.project.id)));
  s.move(200, 'main', s2, `merge ${s2}: Fast-forward`);
  // In the window: a fresh one, one that built on top, one moved up to main, one rebased onto it, a closed one.
  const fresh = s.minion('ticket/3-fresh');
  s.move(210, 'ticket/3-fresh', s2, 'branch: Created from main');
  const built = s.minion('ticket/4-built');
  s.move(211, 'ticket/4-built', s2, 'branch: Created from main');
  s.move(212, 'ticket/4-built', s.commit(212, '#4 own', s2), 'commit: #4 own');
  const moved = s.minion('ticket/5-moved');
  s.move(150, 'ticket/5-moved', a, 'branch: Created from main');
  s.move(213, 'ticket/5-moved', s2, 'reset: moving to main');
  const rebased = s.minion('ticket/6-rebased');
  s.move(151, 'ticket/6-rebased', a, 'branch: Created from main');
  s.move(152, 'ticket/6-rebased', s.commit(152, '#6 own', a), 'commit: #6 own');
  s.move(214, 'ticket/6-rebased', s.commit(214, '#6 own', s2), 'rebase (finish): refs/heads/ticket/6-rebased onto ' + s2);
  const closed = s.minion('ticket/7-closed');
  s.move(215, 'ticket/7-closed', s2, 'branch: Created from main');
  s.store.updateTicket(closed, { status: 'closed' });
  s.move(300, 'main', a, `reset: moving to ${a}`);

  await s.sweeper.sweep();
  assert.deepEqual(
    s.told.map((t) => t.id).sort((x, y) => x - y),
    [fresh, built, moved, rebased],
    'not the one cut before, the shipper or the closed one',
  );
  for (const t of s.told) {
    assert.match(t.text, new RegExp(`reset from ${s2.slice(0, 12)} to ${a.slice(0, 12)}, which took 2 commits off it`));
    assert.match(t.text, /#2 second/);
    assert.match(t.text, /#2 first/);
    assert.ok(t.text.includes(`git rebase --onto main ${s2.slice(0, 12)}`), t.text);
  }
  assert.match(s.told.find((t) => t.id === built)!.text, /ticket\/4-built was cut from them and still holds 2 of them/);
  assert.equal(
    s.told.some((t) => [before, shipper].includes(t.id)),
    false,
  );

  // The command it names leaves only the minion's own commit, on main.
  s.run(400, 'checkout', '-q', 'ticket/4-built');
  s.run(400, 'rebase', '-q', '--onto', 'main', s2.slice(0, 12));
  assert.equal(s.run(400, 'log', '--format=%s', 'main..ticket/4-built'), '#4 own');
  assert.equal(s.run(400, 'merge-base', 'main', 'ticket/4-built'), a);
  s.run(400, 'checkout', '-q', 'main');

  await s.sweeper.sweep();
  assert.equal(s.told.length, 4, 'a second sweep tells nobody again');
});

test("main moving forward tells nobody, and a scheme's first sweep doesn't read old resets", async () => {
  const s = scheme('mandate');
  const a = s.commit(100, 'base');
  const b = s.commit(101, 'next', a);
  s.move(100, 'main', a, 'commit (initial): base');
  s.move(101, 'main', b, 'merge: Fast-forward');
  s.move(102, 'main', a, `reset: moving to ${a}`); // before the first sweep
  s.minion('ticket/1-old');
  s.move(101, 'ticket/1-old', b, 'branch: Created from main');
  await s.sweeper.sweep();
  const c = s.commit(200, 'later', a);
  s.move(200, 'main', c, 'merge: Fast-forward');
  await s.sweeper.sweep();
  assert.deepEqual(s.told, []);
});
