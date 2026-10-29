import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, Store } from '../src/db.ts';

// A deploy that fails rolls back to the last release, which then opens a database the new code has
// already migrated. That release's Store must still read and write it. The last release is the live
// checkout's last-good tag (deploy.sh tags it), or GitHub's main (deploy.sh pushes each live commit).
const repo = join(import.meta.dirname, '..');
const root = mkdtempSync(join(tmpdir(), 'schema-compat-'));
after(() => rmSync(root, { recursive: true, force: true }));

const resolves = (ref: string) => spawnSync('git', ['-C', repo, 'rev-parse', '-q', '--verify', `${ref}^{commit}`]).status === 0;
const prev = ['last-good', 'origin/main'].find(resolves);
const prevDir = join(root, 'prev');
mkdirSync(prevDir);
if (prev) execFileSync('sh', ['-c', 'git -C "$1" archive "$2" src | tar -x -C "$3"', 'sh', repo, prev, prevDir]);
const loadPrev = async () => {
  assert.ok(prev, 'no last-good tag or origin/main to find the last release by: fetch origin');
  return import(join(prevDir, 'src', 'db.ts'));
};

// The shape a Store gives a new database: every table and index, as SQLite stores them.
const shape = (S: typeof Store, file: string) => {
  new S(file).db.close();
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  db.close();
  return rows;
};

test(`the last release's Store (${prev}) reads and writes a database this code has migrated`, async () => {
  const { Store: PrevStore } = await loadPrev();
  const file = join(root, 'migrated.db');
  const now = new Store(file);
  const project = now.createProject('Compat', null);
  const ticket = now.createTicket({ project_id: project.id, title: 'Before', permission_mode: 'default', created_by: 'Cara' });
  now.addEvent(ticket.id, 'note', { text: 'written by this code' });
  now.putClaudeState({ path: 'projects/x/1.jsonl', project_id: project.id, ticket_id: ticket.id, size: 1, mtime: 1, data: new Uint8Array(1) });
  now.db.close();

  const old = new PrevStore(file);
  assert.deepEqual(old.listProjects().map((p: any) => p.name), ['Compat']);
  assert.equal(old.getTicket(ticket.id).title, 'Before');
  assert.equal(old.listEvents(ticket.id).at(-1).data, JSON.stringify({ text: 'written by this code' }));
  assert.equal(old.listClaudeState(project.id, ticket.id).length, 1);
  old.listTickets(project.id);
  old.listArtifacts(project.id);
  old.listTurns(ticket.id);
  old.listMachines();
  old.listPushSubscriptions();
  old.props.forTarget('minion', ticket.id);
  old.schedules.list(project.id);
  const added = old.createTicket({ project_id: project.id, title: 'After rollback', permission_mode: 'default', created_by: 'Cara' });
  old.addEvent(added.id, 'note', { text: 'written by the last release' });
  old.db.close();

  const again = new Store(file); // and forward again, as the fixed deploy that follows would
  assert.equal(again.getTicket(added.id)!.title, 'After rollback');
  assert.equal(again.getSetting('schema_version'), SCHEMA_VERSION);
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
