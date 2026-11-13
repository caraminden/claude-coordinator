import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { ticketWorktree } from '../src/build-output.ts';
import { GRACE_MS, SAVE_LIMIT, savedRef } from '../src/worktree-sweep.ts';
import { stopTurns, testPins } from './helpers.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-sweep-')));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const { Runner } = await import('../src/runner.ts');
testPins();

const DAY = 86_400_000;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
const has = (repo: string, ref: string) => { try { git(repo, 'rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; } };

const data = join(root, 'data');
mkdirSync(data);
const store = new Store(join(data, 'test.db'));
const runner = new Runner(store, () => {}, () => ({}), '/bin/false');

function scheme(name: string, repo?: string) {
  const p = store.createProject(name, null);
  repo ??= join(data, 'projects', String(p.id), 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'target/\nnode_modules/\n.claude/\n');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  writeFileSync(join(repo, 'gone.txt'), 'tracked\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  store.setProjectRepoDir(p.id, repo);
  const coordinator = store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'TM', permission_mode: 'default', created_by: 'T' });
  store.setTicketDir(coordinator.id, repo, null);
  return { id: p.id, repo, coordinator: coordinator.id };
}

function minion(s: { id: number; repo: string }, dismissedDaysAgo: number | null) {
  const t = store.createTicket({ project_id: s.id, title: 'T', permission_mode: 'default', created_by: 'T' });
  const dir = ticketWorktree(data, s.id, t.id);
  const branch = `ticket/${t.number}-t`;
  git(s.repo, 'worktree', 'add', '-q', '-b', branch, dir);
  store.setTicketDir(t.id, dir, branch);
  if (dismissedDaysAgo !== null) {
    store.updateTicket(t.id, { status: 'closed' });
    store.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(Date.now() - dismissedDaysAgo * DAY, t.id);
  }
  return { id: t.id, number: t.number, dir, branch };
}

const notes = (id: number) => store.listEvents(id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text as string);

test('the grace is 3 days', () => assert.equal(GRACE_MS, 3 * DAY));

test('dismissed past the grace: removed with its branch kept, saving uncommitted work first; inside the grace, open or locked: kept', async () => {
  const s = scheme('Sweep');
  const old = minion(s, 4);
  writeFileSync(join(old.dir, 'a.txt'), 'two\n');
  const fresh = minion(s, 2);
  const open = minion(s, null);
  const dirty = minion(s, 4);
  writeFileSync(join(dirty.dir, 'a.txt'), 'edited\n');
  git(dirty.dir, 'add', 'a.txt');
  writeFileSync(join(dirty.dir, 'a.txt'), 'edited again\n');
  rmSync(join(dirty.dir, 'gone.txt'));
  mkdirSync(join(dirty.dir, 'notes'));
  writeFileSync(join(dirty.dir, 'notes', 'new.md'), 'new file\n');
  mkdirSync(join(dirty.dir, 'target'));
  writeFileSync(join(dirty.dir, 'target', 'big.o'), 'ignored');
  const clean = minion(s, 5);
  const locked = minion(s, 5);
  git(s.repo, 'worktree', 'lock', locked.dir);
  const nested = minion(s, 5);
  mkdirSync(join(nested.dir, 'clone'));
  git(join(nested.dir, 'clone'), 'init', '-q');
  const big = minion(s, 5);
  writeFileSync(join(big.dir, 'huge.bin'), '');
  truncateSync(join(big.dir, 'huge.bin'), SAVE_LIMIT + 1); // sparse: the size counts, not the disk

  const done = (await runner.sweepWorktrees()).get(s.id)!;
  for (const t of [old, dirty, clean]) {
    assert.ok(!existsSync(t.dir), `#${t.number} removed`);
    assert.ok(has(s.repo, `refs/heads/${t.branch}`), `#${t.number}'s branch stays`);
  }
  for (const t of [fresh, open, locked, big, nested]) assert.ok(existsSync(t.dir), `#${t.number} kept`);
  assert.ok(has(s.repo, savedRef(String(dirty.id))) && has(s.repo, savedRef(String(old.id))));
  assert.ok(!has(s.repo, savedRef(String(clean.id))), 'nothing to save, no ref');
  assert.equal(git(s.repo, 'rev-parse', `${savedRef(String(dirty.id))}^`), git(s.repo, 'rev-parse', dirty.branch), 'the save sits on the branch tip, which did not move');

  assert.equal(done.removed.length, 3);
  assert.match(done.kept.join('\n'), new RegExp(`#${locked.number} .*could not remove`));
  assert.match(done.kept.join('\n'), new RegExp(`#${big.number} .*too big to save`));
  assert.match(done.kept.join('\n'), new RegExp(`#${nested.number} .*holds another git checkout, clone`));
  assert.match(notes(dirty.id).at(-1)!, /Removed this dismissed minion's worktree .*a reopen brings the folder back with its uncommitted work/);
  const tm = notes(s.coordinator).at(-1)!;
  assert.match(tm, /Removed 3 worktrees/);
  assert.match(tm, new RegExp(`#${clean.number} \\(${clean.dir}\\), \\d+ MiB`));

  // A second sweep says nothing new about the ones it keeps.
  assert.equal((await runner.sweepWorktrees()).get(s.id), undefined);
  git(s.repo, 'worktree', 'unlock', locked.dir);

  // Reopen: the folder comes back on its branch, its saved work as uncommitted changes, and the ref goes.
  store.updateTicket(dirty.id, { status: 'idle' });
  await runner.reopened(dirty.id);
  assert.equal(git(dirty.dir, 'branch', '--show-current'), dirty.branch);
  assert.equal(readFileSync(join(dirty.dir, 'a.txt'), 'utf8'), 'edited again\n');
  assert.equal(readFileSync(join(dirty.dir, 'notes', 'new.md'), 'utf8'), 'new file\n');
  assert.ok(!existsSync(join(dirty.dir, 'gone.txt')), 'a deletion comes back too');
  assert.ok(!existsSync(join(dirty.dir, 'target')), 'ignored files were never saved');
  assert.equal(git(dirty.dir, 'show', ':a.txt'), 'edited', 'the staged version comes back staged');
  assert.ok(!has(s.repo, savedRef(String(dirty.id))));
  assert.match(notes(dirty.id).at(-1)!, /Recreated this minion's worktree .*uncommitted work is back/);

  // Reopened, dismissed again: the clock restarts, so the next sweep keeps it.
  store.updateTicket(dirty.id, { status: 'closed' });
  await runner.sweepWorktrees();
  assert.ok(existsSync(dirty.dir));

  // A branch that moved after the save: the folder comes back on it, the ref stays for a person.
  git(s.repo, 'branch', '-f', old.branch, git(s.repo, 'commit-tree', '-p', old.branch, '-m', 'moved', `${old.branch}^{tree}`));
  store.updateTicket(old.id, { status: 'idle' });
  await runner.reopened(old.id);
  assert.ok(existsSync(old.dir));
  assert.equal(readFileSync(join(old.dir, 'a.txt'), 'utf8'), 'one\n');
  assert.ok(has(s.repo, savedRef(String(old.id))));
  assert.match(notes(old.id).at(-1)!, /branch has moved since/);

  // Dismissed again with new edits before anyone took that work back: the earlier save is never written over.
  const before = git(s.repo, 'rev-parse', savedRef(String(old.id)));
  writeFileSync(join(old.dir, 'a.txt'), 'newer\n');
  store.updateTicket(old.id, { status: 'closed' });
  const again = (await runner.sweepWorktrees(Date.now() + 4 * DAY)).get(s.id)!;
  assert.ok(existsSync(old.dir));
  assert.equal(git(s.repo, 'rev-parse', savedRef(String(old.id))), before);
  assert.match(again.kept.join('\n'), new RegExp(`#${old.number} .*earlier saved work .* isn't restored yet`));
});

test('a detached HEAD\'s commit is saved in the ref', async () => {
  const s = scheme('Detached');
  const t = minion(s, 4);
  git(t.dir, 'checkout', '-q', '--detach');
  writeFileSync(join(t.dir, 'x.txt'), 'x\n');
  git(t.dir, 'add', 'x.txt');
  git(t.dir, 'commit', '-qm', 'off the branch');
  const lone = git(t.dir, 'rev-parse', 'HEAD');
  await runner.sweepWorktrees();
  assert.ok(!existsSync(t.dir));
  assert.equal(git(s.repo, 'rev-parse', `${savedRef(String(t.id))}^`), lone);
});

test('Grunt worktrees: kept while a turn of the scheme that began before them runs, removed once none does; never outside the data folder', async () => {
  const s = scheme('Grunts');
  const grunt = (repo: string, name: string) => {
    const path = join(repo, '.claude', 'worktrees', name);
    git(repo, 'worktree', 'add', '-q', '-b', `worktree-${name}`, path);
    return path;
  };
  const inUse = grunt(s.repo, 'agent-a1');
  const dirtyGrunt = grunt(s.repo, 'agent-a2');
  writeFileSync(join(dirtyGrunt, 'half.rs'), 'fn main() {}\n');
  const host = minion(s, null);
  const nested = grunt(host.dir, 'agent-a3');

  const later = Date.now() + 2 * DAY;
  const turns = runner['turns'] as Map<number, { startedAt: number }>;
  turns.set(host.id, { startedAt: Date.now() - DAY } as never);
  await runner.sweepWorktrees(later);
  assert.ok(existsSync(inUse) && existsSync(dirtyGrunt) && existsSync(nested), 'a turn that began before them may be using them');

  turns.set(host.id, { startedAt: Date.now() + 1000 } as never);
  await runner.sweepWorktrees(later);
  turns.delete(host.id);
  for (const p of [inUse, dirtyGrunt, nested]) assert.ok(!existsSync(p));
  assert.ok(has(s.repo, 'refs/heads/worktree-agent-a2'), "a Grunt's branch stays");
  assert.ok(has(s.repo, savedRef('grunt/agent-a2')), 'its uncommitted file is saved');
  assert.ok(existsSync(host.dir), "the open minion's own worktree stays");

  // Too young: kept whatever the turns say, and so is the dismissed minion it sits in.
  const young = grunt(s.repo, 'agent-a4');
  const parent = minion(s, 5);
  const inside = grunt(parent.dir, 'agent-a5');
  const locked = grunt(s.repo, 'agent-a6');
  git(s.repo, 'worktree', 'lock', locked);
  const done = (await runner.sweepWorktrees(Date.now() + DAY / 2)).get(s.id)!;
  assert.ok(existsSync(young) && existsSync(inside) && existsSync(parent.dir));
  assert.match(done.kept.join('\n'), new RegExp(`#${parent.number} .*holds another git checkout, \\.claude/worktrees/agent-a5`));
  // Old enough and idle, but locked: kept, and the Taskmaster's note says so.
  const later2 = (await runner.sweepWorktrees(later)).get(s.id)!;
  assert.ok(existsSync(locked) && !existsSync(young));
  assert.match(later2.kept.join('\n'), /Grunt agent-a6 .*locked/);
  git(s.repo, 'worktree', 'unlock', locked);

  // A scheme whose repo isn't in this data folder (a dev copy's rows point at the live repos): untouched.
  const away = scheme('Away', join(root, 'live-repo'));
  const theirs = grunt(away.repo, 'agent-b1');
  await runner.sweepWorktrees(later);
  assert.ok(existsSync(theirs));
});

test("the one-off clears only target/ of Peek's three open minions, once", async () => {
  const fresh = join(root, 'peek');
  mkdirSync(fresh);
  const db = new Store(join(fresh, 'test.db'));
  const r = new Runner(db, () => {}, () => ({}), '/bin/false');
  db.createProject('One', null);
  db.createProject('Two', null);
  const peek = db.createProject('Peek Auras', null);
  assert.equal(peek.id, 3);
  const repo = join(fresh, 'projects', '3', 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'target/\nnode_modules/\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  db.setProjectRepoDir(3, repo);
  const t = db.createTicket({ project_id: 3, title: 'T', permission_mode: 'default', created_by: 'T' });
  db.db.prepare('UPDATE tickets SET id = 833 WHERE id = ?').run(t.id);
  const dir = ticketWorktree(fresh, 3, 833);
  git(repo, 'worktree', 'add', '-q', '-b', 'ticket/1-t', dir);
  db.setTicketDir(833, dir, 'ticket/1-t');
  for (const f of ['target/debug/x', 'node_modules/m/i.js']) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), 'x');
  }
  await r.sweepWorktrees();
  assert.ok(!existsSync(join(dir, 'target')));
  assert.ok(existsSync(join(dir, 'node_modules', 'm', 'i.js')) && existsSync(join(dir, 'a')) === false && existsSync(join(dir, '.gitignore')));
  mkdirSync(join(dir, 'target'));
  await r.sweepWorktrees();
  assert.ok(existsSync(join(dir, 'target')), 'once only');
});
