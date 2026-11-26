// The daily sweeps make no blocking disk call or process start on the server's one thread (#1768): the build cache
// trim, the build output sweep, the contraption media sweep and the dismissed worktree sweep each hold every request
// meanwhile when btrfs stalls.
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { trimCache } from '../src/build-cache.ts';
import { findBuildOutput, ticketWorktree } from '../src/build-output.ts';
import { MEDIA_KEEP_MS, sweepMedia } from '../src/contraption-media.ts';
import { removeWorktree, trashOf } from '../src/worktree-sweep.ts';
import { stopTurns, testPins } from './helpers.ts';
import { git } from './git.ts';
import { syncCallsUnder } from './sync-trap.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'off-thread-sweeps-')));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true }); // timing-ok: own temp dir
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const { Runner } = await import('../src/runner.ts');
testPins();

const put = (file: string, text = 'x') => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};
const aged = (file: string, ms: number) => utimesSync(file, (Date.now() - ms) / 1000, (Date.now() - ms) / 1000);

test('the build cache trim stats and deletes off the thread, still oldest first down to the cap', async () => {
  const dir = join(root, 'cache');
  for (const [name, hoursAgo] of [
    ['a', 5],
    ['b', 4],
    ['c', 3],
  ] as const) {
    put(join(dir, name), 'x'.repeat(100));
    aged(join(dir, name), hoursAgo * 3_600_000);
  }
  let r: Awaited<ReturnType<typeof trimCache>> | undefined;
  let none: Awaited<ReturnType<typeof trimCache>> | undefined;
  const calls = await syncCallsUnder(root, async () => {
    r = await trimCache(dir, 150);
    none = await trimCache(join(root, 'no-cache'), 1);
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(r, { removed: 2, freed: 200, left: 100 });
  assert.deepEqual(none, { removed: 0, freed: 0, left: 0 });
  assert.deepEqual(fs.readdirSync(dir), ['c']);
});

test("finding a worktree's build output (Gradle's beside a build file) makes no blocking call", async () => {
  const dir = join(root, 'find');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  put(join(dir, '.gitignore'), 'build/\ntarget/\n');
  put(join(dir, 'app', 'build.gradle.kts'));
  put(join(dir, 'app', 'build', 'out.class'));
  put(join(dir, 'docs', 'build', 'kept.html')); // no Gradle file beside it
  put(join(dir, 'target', 'x'));
  let found: string[] = [];
  const calls = await syncCallsUnder(root, async () => {
    found = await findBuildOutput(dir);
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(found, [join(dir, 'app', 'build'), join(dir, 'target')]);
});

test('the contraption media sweep reads, stats and deletes off the thread, keeping new files', async () => {
  const dir = join(root, 'media');
  put(join(dir, 'app', 'old.png'));
  put(join(dir, 'app', 'old.png.json'));
  put(join(dir, 'app', 'deep', 'new.png'));
  aged(join(dir, 'app', 'old.png'), MEDIA_KEEP_MS + 60_000);
  aged(join(dir, 'app', 'old.png.json'), MEDIA_KEEP_MS + 60_000);
  let gone = -1;
  let none = -1;
  const calls = await syncCallsUnder(root, async () => {
    gone = await sweepMedia(dir);
    none = await sweepMedia(join(root, 'no-media'));
  });
  assert.deepEqual(calls, []);
  assert.equal(gone, 2);
  assert.equal(none, 0);
  assert.ok(!existsSync(join(dir, 'app', 'old.png')) && !existsSync(join(dir, 'app', 'old.png.json')));
  assert.ok(existsSync(join(dir, 'app', 'deep', 'new.png')));
});

const DAY = 86_400_000;
const data = join(root, 'data');
mkdirSync(data);
const store = new Store(join(data, 'test.db'));
const runner = new Runner(
  store,
  () => {},
  () => ({}),
  '/bin/false',
);

function scheme(name: string) {
  const p = store.createProject(name, null);
  const repo = join(data, 'projects', String(p.id), 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'target/\n.claude/\n');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  store.setProjectRepoDir(p.id, repo);
  return { id: p.id, repo };
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
  return { id: t.id, dir, branch };
}

test("the build output sweep clears dismissed minions' target/ off the thread, and leaves an open one's", async () => {
  const s = scheme('Build');
  const gone = minion(s, 0);
  const open = minion(s, null);
  for (const t of [gone, open]) put(join(t.dir, 'target', 'big.o'));
  let freed: { worktrees: number; bytes: number } | undefined;
  const calls = await syncCallsUnder(data, async () => {
    freed = await runner.sweepBuildOutput();
  });
  assert.deepEqual(calls, []);
  assert.equal(freed?.worktrees, 1);
  assert.ok(!existsSync(join(gone.dir, 'target')));
  assert.ok(existsSync(join(open.dir, 'target', 'big.o')));
  assert.ok(existsSync(join(gone.dir, 'a.txt')), 'the worktree itself stays');
});

test("the worktree sweep removes dismissed minions' worktrees off the thread, keeping those inside the grace", async () => {
  const s = scheme('Worktrees');
  const old = minion(s, 4);
  writeFileSync(join(old.dir, 'a.txt'), 'edited\n');
  const half = minion(s, 4);
  rmSync(join(half.dir, '.git')); // a removal cut short by the first version of the sweep
  const fresh = minion(s, 1);
  let done: Awaited<ReturnType<typeof runner.sweepWorktrees>> | undefined;
  const calls = await syncCallsUnder(data, async () => {
    done = await runner.sweepWorktrees();
  });
  assert.deepEqual(calls, []);
  assert.equal(done?.get(s.id)?.removed.length, 2);
  assert.ok(!existsSync(old.dir) && !existsSync(half.dir));
  assert.ok(existsSync(fresh.dir));
  assert.equal(git(s.repo, 'show', `refs/citadel/saved/${old.id}:a.txt`), 'edited');
});

test('removeWorktree makes no blocking call, and still refuses a locked worktree or one with trash left beside it', async () => {
  const s = scheme('Remove');
  const t = minion(s, 4);
  const locked = minion(s, 4);
  git(s.repo, 'worktree', 'lock', locked.dir);
  const blocked = minion(s, 4);
  mkdirSync(trashOf(blocked.dir));
  const errors: string[] = [];
  const calls = await syncCallsUnder(data, async () => {
    assert.ok((await removeWorktree(s.repo, t.dir)) > 0);
    for (const dir of [locked.dir, blocked.dir]) await removeWorktree(s.repo, dir).catch((err: Error) => errors.push(err.message));
  });
  assert.deepEqual(calls, []);
  assert.ok(!existsSync(t.dir) && !existsSync(trashOf(t.dir)));
  assert.deepEqual(errors, ['locked', `${trashOf(blocked.dir).split('/').at(-1)} is still there from an earlier removal`]);
  assert.ok(existsSync(locked.dir) && existsSync(blocked.dir));
});
