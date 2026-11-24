import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { clearTmpDir, makeTmpDir, sweepTmpDirs, tmpDirFor } from '../src/turn-tmp.ts';
import { stopTurns, testPins } from './helpers.ts';

const root = mkdtempSync(join(tmpdir(), 'turn-tmp-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const { Runner } = await import('../src/runner.ts');
testPins();

test('a temp folder is only ever a ticket id directly under an absolute root', () => {
  assert.equal(tmpDirFor('/data/tmp', 7), '/data/tmp/7');
  for (const bad of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => tmpDirFor('/data/tmp', bad), /Not a ticket id/);
  assert.throws(() => tmpDirFor('tmp', 7), /absolute/);
  assert.throws(() => tmpDirFor('', 7), /absolute/);
  assert.throws(() => clearTmpDir('/data/tmp', '..' as any), /Not a ticket id/);
});

test('clearing a folder removes what is in it but never what its symlinks point at', () => {
  const tmpRoot = join(root, 'links');
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'keep');
  const dir = makeTmpDir(tmpRoot, 3);
  mkdirSync(join(dir, 'build'));
  writeFileSync(join(dir, 'build', 'out.dll'), 'x');
  symlinkSync(outside, join(dir, 'link'));
  clearTmpDir(tmpRoot, 3);
  assert.ok(!existsSync(dir));
  assert.ok(existsSync(join(outside, 'keep.txt')));
  assert.ok(existsSync(tmpRoot), 'the root stays');
});

test('the sweep removes only ticket folders it is told to, and leaves anything else in the root alone', () => {
  const tmpRoot = join(root, 'sweep');
  for (const id of [1, 2, 3]) makeTmpDir(tmpRoot, id);
  for (const other of ['notes', '01', '2-old', '.hidden']) mkdirSync(join(tmpRoot, other));
  writeFileSync(join(tmpRoot, '4'), 'a file named like a ticket');
  const gone = sweepTmpDirs(tmpRoot, (id) => id === 2);
  assert.deepEqual(gone.sort(), [1, 3, 4]);
  for (const kept of ['2', 'notes', '01', '2-old', '.hidden']) assert.ok(existsSync(join(tmpRoot, kept)), kept);
  assert.deepEqual(
    sweepTmpDirs(join(root, 'missing'), () => false),
    [],
  );
});

test("dismissing a minion clears its temp folder, and a restart sweeps those of dismissed minions (#218), not of minions it can't find (#259)", async () => {
  const data = join(root, 'data');
  mkdirSync(data);
  const store = new Store(join(data, 'test.db'));
  const runner = new Runner(
    store,
    () => {},
    () => ({}),
    '/bin/false',
  );
  const project = store.createProject('Test', null);
  const tmpRoot = runner.tmpRoot(project.id);
  assert.equal(tmpRoot, join(data, 'projects', String(project.id), 'tmp'));
  const ticket = () => store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' }).id;

  const dismissed = ticket();
  writeFileSync(join(makeTmpDir(tmpRoot, dismissed), 'leftover'), 'x');
  await runner.close(dismissed, 'Dismissed.'); // resolves once the folder is gone: the delete doesn't hold up the server (#526)
  assert.ok(!existsSync(join(tmpRoot, String(dismissed))));
  assert.equal(store.getTicket(dismissed)!.status, 'closed');

  // Left behind by a server that died before clearing them; and one of a minion deleted since, which stays.
  const taskmaster = store.createTicket({ project_id: project.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' }).id;
  const open = ticket();
  const closedEarlier = ticket();
  store.updateTicket(closedEarlier, { status: 'closed' });
  const deleted = ticket();
  for (const id of [taskmaster, open, closedEarlier, deleted]) makeTmpDir(tmpRoot, id);
  store.deleteTicket(deleted);
  // A folder in the wrong scheme's root belongs to no open minion there.
  const other = store.createProject('Other', null);
  makeTmpDir(runner.tmpRoot(other.id), open);
  const stray = join(tmpRoot, 'not-a-ticket');
  mkdirSync(stray);
  runner.recover();
  assert.ok(existsSync(join(tmpRoot, String(open))), 'an open minion keeps its folder');
  assert.ok(existsSync(join(tmpRoot, String(taskmaster))), 'so does the Taskmaster');
  assert.ok(!existsSync(join(tmpRoot, String(closedEarlier))));
  // A minion the database doesn't know is no proof its folder is stale (#259): a restored backup lacks the newest minions.
  assert.ok(existsSync(join(tmpRoot, String(deleted))));
  assert.ok(!existsSync(join(runner.tmpRoot(other.id), String(open))));
  assert.ok(existsSync(stray));
});
