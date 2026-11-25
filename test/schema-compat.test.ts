import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_HISTORY, SCHEMA_VERSION, Store } from '../src/db.ts';

// A deploy that fails rolls back to the last release, which then opens a database the new code has
// already migrated. That release's Store must still read and write it. The last release is the live
// checkout's last-good tag (deploy.sh tags it), or GitHub's main (deploy.sh pushes each live commit).
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'schema-compat-'));
after(() => rmSync(root, { recursive: true, force: true }));

// The live checkout's own tag first (deploy.sh moves it there): a worktree's clone can hold a last-good
// left from long ago, which would test a rollback to a release no deploy goes back to (#1169).
const live = process.env.DEPLOY_LIVE || join(homedir(), 'claude-coordinator');
const resolves = (dir: string, ref: string) => spawnSync('git', ['-C', dir, 'rev-parse', '-q', '--verify', `${ref}^{commit}`]).status === 0;
const [prevRepo, prev] = (
  [
    [live, 'last-good'],
    [repo, 'last-good'],
    [repo, 'origin/main'],
  ] as const
).find(([dir, ref]) => resolves(dir, ref)) ?? [repo, undefined];
const prevDir = join(root, 'prev');
mkdirSync(prevDir);
if (prev) execFileSync('sh', ['-c', 'git -C "$1" archive "$2" src public | tar -x -C "$3"', 'sh', prevRepo, prev, prevDir]);
// A branch whose base is older than the last release has a lower SCHEMA_VERSION; shipping that would be
// wrong, and the failures that follow look like the change broke compatibility. Say the real cause.
const staleBase = (ref: string | undefined, releaseVersion: number, branchVersion: number) => (releaseVersion > branchVersion ? `this branch's schema is ${branchVersion}, older than the last release's ${releaseVersion} (${ref}): its base is behind. Rebase onto main.` : undefined);
const loadPrev = async () => {
  assert.ok(prev, 'no last-good tag or origin/main to find the last release by: fetch origin');
  const mod = await import(join(prevDir, 'src', 'db.ts'));
  const stale = staleBase(prev, mod.SCHEMA_VERSION ?? 0, SCHEMA_VERSION);
  assert.ok(!stale, stale!);
  return mod;
};

test('a base older than the last release says to rebase, with both schema numbers', () => {
  assert.equal(staleBase('last-good', 111, 110), "this branch's schema is 110, older than the last release's 111 (last-good): its base is behind. Rebase onto main.");
  assert.equal(staleBase('last-good', 110, 110), undefined);
  assert.equal(staleBase('last-good', 109, 110), undefined);
});

// The shape a Store gives a new database: every table and index, as SQLite stores them.
const shape = (S: typeof Store, file: string) => {
  new S(file).db.close();
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  db.close();
  return rows;
};

test(`the last release's Store (${prev}) reads and writes a database this code has migrated`, async () => {
  const { Store: PrevStore, SCHEMA_VERSION: prevVersion = 0 } = await loadPrev();
  const file = join(root, 'coordinator.db'); // the live name: events.db beside it is the name every release looks for
  const now = new Store(file);
  const project = now.createProject('Compat', null);
  const ticket = now.createTicket({ project_id: project.id, title: 'Before', permission_mode: 'default', created_by: 'Cara' });
  now.addEvent(ticket.id, 'note', { text: 'written by this code' });
  now.putClaudeState({ path: 'projects/x/1.jsonl', project_id: project.id, ticket_id: ticket.id, size: 1, mtime: 1, data: new Uint8Array(1) });
  // A person note (#146) has no foreign key, so the last release can still delete its minion.
  const noted = now.createTicket({ project_id: project.id, title: 'Noted', permission_mode: 'default', created_by: 'Cara' });
  now.setPersonNote(noted.id, 'a note', 'Cara');
  now.db.prepare('UPDATE person_notes SET updated_at = 1 WHERE ticket_id = ?').run(noted.id); // well before the minion that reuses its id
  // So has a pin (#179).
  now.setTicketPinned('Cara', noted.id, true);
  now.db.prepare('UPDATE ticket_pins SET pinned_at = 1 WHERE ticket_id = ?').run(noted.id);
  now.db.close();

  const old = new PrevStore(file);
  assert.deepEqual(
    old.listProjects().map((p: { name: string }) => p.name),
    ['Compat'],
  );
  assert.equal(old.getTicket(ticket.id).title, 'Before');
  assert.equal(old.listEvents(ticket.id).at(-1).data, JSON.stringify({ text: 'written by this code' }));
  // Releases before state.db (version 2) look for session state in the main file: they find an empty
  // table there and refill it from Claude's config dir at start; the next release folds it back.
  assert.equal(old.listClaudeState(project.id, ticket.id).length, prevVersion < 2 ? 0 : 1);
  old.putClaudeState({ path: 'projects/x/2.jsonl', project_id: project.id, ticket_id: ticket.id, size: 1, mtime: 1, data: new Uint8Array(1) });
  old.listTickets(project.id);
  old.listArtifacts(project.id);
  old.listTurns(ticket.id);
  old.listMachines();
  old.listPushSubscriptions();
  old.props.forTarget('minion', ticket.id);
  old.schedules.list(project.id);
  old.deleteTicket(noted.id);
  const added = old.createTicket({ project_id: project.id, title: 'After rollback', permission_mode: 'default', created_by: 'Cara' });
  old.addEvent(added.id, 'note', { text: 'written by the last release' });
  old.db.close();

  const again = new Store(file); // and forward again, as the fixed deploy that follows would
  assert.equal(again.getTicket(added.id)!.title, 'After rollback');
  assert.equal(added.id, noted.id, 'the newest id is reused');
  assert.equal(again.personNotes(project.id)[added.id], undefined, "the deleted minion's note left behind doesn't show on the new one");
  assert.deepEqual(again.pinnedTickets('Cara', project.id), [], 'nor does its pin');
  assert.equal(again.getSetting('schema_version'), SCHEMA_VERSION);
  assert.deepEqual(
    again
      .listClaudeState(project.id, ticket.id)
      .map((r) => r.path)
      .sort(),
    ['projects/x/1.jsonl', 'projects/x/2.jsonl'],
    'sessions from both releases',
  );
  again.db.close();
});

test('a change to the database shape comes with a higher SCHEMA_VERSION than the last release', async () => {
  const mod = await loadPrev();
  if (JSON.stringify(shape(Store, join(root, 'now.db'))) === JSON.stringify(shape(mod.Store, join(root, 'prev.db')))) return;
  assert.ok(SCHEMA_VERSION > (mod.SCHEMA_VERSION ?? 0), `the tables differ from ${prev}'s: bump SCHEMA_VERSION in src/db.ts`);
});

test('a Store never lowers schema_version, so an older release left behind by a rollback leaves the newer number', () => {
  const file = join(root, 'newer.db');
  const s = new Store(file);
  s.setSetting('schema_version', SCHEMA_VERSION + 1);
  s.db.close();
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => warned.push(m);
  try {
    const reopened = new Store(file);
    assert.equal(reopened.getSetting('schema_version'), SCHEMA_VERSION + 1);
    reopened.db.close();
  } finally {
    console.warn = warn;
  }
  assert.match(warned.join('\n'), /newer than this code's .*pre-deploy/);
});

test('SCHEMA_HISTORY numbers rise by one with no gaps or repeats', () => {
  SCHEMA_HISTORY.forEach(([n], i) => assert.equal(n, SCHEMA_HISTORY[0][0] + i));
});
