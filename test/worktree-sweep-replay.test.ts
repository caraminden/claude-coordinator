import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { ticketWorktree } from '../src/build-output.ts';
import { stopTurns, testPins } from './helpers.ts';
import { git } from './git.ts';

// #1055 review fix (b14a0dff): the day's cleanup note, when edited by a later sweep, keeps its everyone flag, so the
// live edit reaches every member's open chat like the note itself did.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-sweep-replay-')));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const { Runner } = await import('../src/runner.ts');
testPins();

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

test("the edit of the day's cleanup note carries everyone: true, as the note did", async () => {
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const p = store.createProject('Daily', null, cara.id);
  const repo = join(data, 'projects', String(p.id), 'repo');
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  store.setProjectRepoDir(p.id, repo);
  const tm = store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'TM', permission_mode: 'default', created_by: 'T' });
  store.setTicketDir(tm.id, repo, null);
  // A split scheme: a person's own Taskmaster exists beside the Overlord, so the note is the Overlord's (for everyone, #920).
  store.splitScheme(p.id, josh.id);
  const lord = store.getOverlord(p.id)!;
  const day1 = Date.parse('2026-11-19T20:00:00Z');
  const old = () => {
    const t = store.createTicket({ project_id: p.id, title: 'T', permission_mode: 'default', created_by: 'T' });
    const dir = ticketWorktree(data, p.id, t.id);
    const branch = `ticket/${t.number}-t`;
    git(repo, 'worktree', 'add', '-q', '-b', branch, dir);
    store.setTicketDir(t.id, dir, branch);
    store.updateTicket(t.id, { status: 'closed' });
    store.db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(day1 - 4 * DAY, t.id);
  };
  old();
  await runner.sweepWorktrees(day1);
  old();
  await runner.sweepWorktrees(day1 + 3_600_000);
  const events = store.listEvents(lord.id);
  const note = events.find((e) => e.kind === 'note' && /today/.test(JSON.parse(e.data).text));
  assert.equal(JSON.parse(note!.data).everyone, true, 'the note itself is for everyone');
  const edits = events.filter((e) => e.kind === 'note_edit');
  assert.equal(edits.length, 1);
  assert.equal(JSON.parse(edits[0].data).everyone, true, 'the edit keeps the flag');
});
