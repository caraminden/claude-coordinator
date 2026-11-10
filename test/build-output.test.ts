import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { clearBuildOutput, findBuildOutput, ticketWorktree } from '../src/build-output.ts';
import { stopTurns, testPins } from './helpers.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'build-output-')));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const { Runner } = await import('../src/runner.ts');
testPins();

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' });
const put = (file: string, text = 'x') => {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, text);
};

/** A git checkout with every kind of folder the clearer must take or leave. */
function checkout(dir: string, outside: string) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  put(join(dir, '.gitignore'), 'target\nnode_modules/\nbuild/\n');
  put(join(dir, 'src', 'main.rs'));
  put(join(dir, 'kept', 'target', 'tracked.txt')); // force-added below: a tracked file in an ignored folder
  git(dir, 'add', '.gitignore', 'src');
  git(dir, 'add', '-f', 'kept/target/tracked.txt');
  git(dir, 'commit', '-qm', 'init');
  put(join(dir, 'kept', 'target', 'junk'));
  put(join(dir, 'target', 'debug', 'big.bin'));
  put(join(dir, 'web', 'node_modules', 'pkg', 'index.js'));
  put(join(dir, 'target', 'nested', 'target', 'x')); // inside one already found
  put(join(dir, 'build', 'node_modules', 'x')); // inside an ignored folder of another name: git reports only build/
  put(join(dir, 'src', 'target', 'untracked-but-not-ignored.txt'), 'y');
  // Symlinks named like build output, out to a folder that must survive, and a symlinked parent.
  put(join(outside, 'precious'));
  symlinkSync(outside, join(dir, 'node_modules'));
  mkdirSync(join(outside, 'deep', 'target'), { recursive: true });
  put(join(outside, 'deep', 'target', 'precious'));
  symlinkSync(join(outside, 'deep'), join(dir, 'linked'));
}

test('finds only wholly ignored target/ and node_modules/ folders, never tracked files or symlinks', async () => {
  const dir = join(root, 'find');
  const outside = join(root, 'find-outside');
  checkout(dir, outside);
  // src/target is ignored by the bare `target` pattern too, and holds nothing tracked: it counts.
  assert.deepEqual(await findBuildOutput(dir), ['src/target', 'target', 'web/node_modules'].map((p) => join(dir, p)));
  const r = await clearBuildOutput(dir);
  assert.equal(r.dirs, 3);
  assert.ok(r.bytes > 0);
  for (const gone of ['target', 'web/node_modules', 'src/target']) assert.ok(!existsSync(join(dir, gone)), gone);
  for (const kept of ['src/main.rs', 'kept/target/tracked.txt', 'kept/target/junk', 'build/node_modules/x', '.git', 'web'])
    assert.ok(existsSync(join(dir, kept)), kept);
  assert.ok(existsSync(join(outside, 'precious')) && existsSync(join(outside, 'deep', 'target', 'precious')), 'nothing behind a symlink');
  assert.equal(git(dir, 'status', '--porcelain', '--untracked-files=no').toString(), '', 'no tracked file touched');
  assert.deepEqual(await clearBuildOutput(dir), { dirs: 0, bytes: 0 });
});

test("a folder inside another repo isn't a checkout of its own", async () => {
  const repo = join(root, 'outer');
  checkout(repo, join(root, 'outer-outside'));
  mkdirSync(join(repo, 'plain'));
  await assert.rejects(findBuildOutput(join(repo, 'plain')), /not a git worktree/);
  assert.ok(existsSync(join(repo, 'target')));
});

test("dismissing a minion clears its worktree's build output; the sweep catches earlier ones and leaves open minions, Taskmasters and stray paths (#336)", async () => {
  const data = join(root, 'data');
  mkdirSync(data);
  const store = new Store(join(data, 'test.db'));
  const runner = new Runner(store, () => {}, () => ({}), '/bin/false');
  const project = store.createProject('Test', null);
  const minion = (kind?: 'coordinator', cwd?: string) => {
    const id = store.createTicket({ project_id: project.id, kind, title: 'T', permission_mode: 'default', created_by: 'Cara' }).id;
    const dir = cwd ?? ticketWorktree(data, project.id, id);
    checkout(dir, join(root, `outside-${id}`));
    store.setTicketDir(id, dir, 'b');
    return { id, target: join(dir, 'target') };
  };

  const dismissed = minion();
  await runner.close(dismissed.id, 'Dismissed.');
  assert.ok(!existsSync(dismissed.target), 'cleared on dismissal');
  assert.ok(existsSync(join(dismissed.target, '..', 'src', 'main.rs')), 'the worktree stays');

  // Reopened while its preview stopped: its build output stays.
  const reopenedMidClose = minion();
  runner.onClose = (id) => store.updateTicket(id, { status: 'idle' });
  await runner.close(reopenedMidClose.id, 'Dismissed.');
  runner.onClose = () => {};
  assert.ok(existsSync(reopenedMidClose.target), 'reopened during dismissal');

  const open = minion();
  const closedEarlier = minion();
  const taskmaster = minion('coordinator', join(data, 'projects', String(project.id), 'repo'));
  const elsewhere = minion(undefined, join(root, 'not-a-ticket-folder'));
  const reopened = minion();
  for (const t of [closedEarlier, taskmaster, elsewhere, reopened]) store.updateTicket(t.id, { status: 'closed' });
  // A step already on its lane (a reopen's turn, say): the sweep passes it by.
  let release!: () => void;
  const busy = runner['lanes'].run(reopened.id, 'held', () => new Promise<void>((r) => (release = r)));
  const freed = await runner.sweepBuildOutput();
  release();
  await busy;
  assert.equal(freed.worktrees, 1);
  assert.ok(!existsSync(closedEarlier.target));
  for (const [name, t] of Object.entries({ open, taskmaster, elsewhere, reopened })) assert.ok(existsSync(t.target), name);
});
