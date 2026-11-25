import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { Store } from '../src/db.ts';
import { deleteNote } from '../src/memory-files.ts';
import { projectSlug, restoreAhead, restoreSession, saveSession, storedPaths } from '../src/sessions.ts';

// #1952 (2ME1): a note a person, a tidy or a session deleted stays deleted, whichever login or container the next turn is on.
const root = mkdtempSync(join(tmpdir(), 'deleted-notes-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir
const server = join(root, 'server-claude');
process.env.CLAUDE_CONFIG_DIR = server;

let n = 0;
function scheme() {
  const at = join(root, `case-${++n}`);
  const store = new Store(join(root, `case-${n}.db`));
  const { id } = store.createProject(`Test ${n}`, null);
  store.setProjectRepoDir(id, join(at, 'repo'));
  const project = store.getProject(id)!;
  const memory = join('projects', projectSlug(project.repo_dir!), 'memory');
  /** A minion's turns on one config dir: start is what the runner does before the process, end what it does after. */
  const turns = (configDir: string) => {
    const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
    store.setTicketDir(t.id, join(at, `wt-${t.id}`), null);
    store.updateTicket(t.id, { session_id: 'sess' });
    const ticket = store.getTicket(t.id)!;
    const transcript = join(configDir, 'projects', projectSlug(ticket.cwd), 'sess.jsonl');
    let had: Set<string> | null = null;
    return {
      ticket,
      async start() {
        await restoreAhead(store, ticket, project, configDir);
        await restoreSession(store, ticket, project, configDir);
        had = storedPaths(store, ticket, project);
        mkdirSync(join(transcript, '..'), { recursive: true });
        writeFileSync(transcript, '{}\n');
      },
      /** `killed`: a restart cut the turn off, so its save prunes nothing. */
      end: (killed = false) => saveSession(store, ticket, project, configDir, killed ? null : had),
    };
  };
  const note = (configDir: string, file: string, text: string, age = 0) => {
    mkdirSync(join(configDir, memory), { recursive: true });
    const path = join(configDir, memory, file);
    writeFileSync(path, text);
    const t = new Date(Date.now() - age);
    utimesSync(path, t, t);
  };
  const has = (configDir: string, file: string) => existsSync(join(configDir, memory, file));
  const row = (file: string, text: string, age = 0) => store.putClaudeState({ path: join(memory, file), project_id: project.id, ticket_id: null, size: text.length, mtime: Date.now() - age, data: gzipSync(text) });
  const stored = (file: string) => !!store.getClaudeState(join(memory, file));
  /** What the Memory page and a tidy do. */
  const pageDelete = (file: string) => {
    deleteNote(join(server, memory), file);
    store.deleteClaudeState(join(memory, file));
  };
  const seed = async () => {
    for (const f of ['a.md', 'b.md', 'MEMORY.md']) note(server, f, f, 3_600_000);
    const host = turns(server);
    await host.start();
    await host.end();
  };
  return { at, store, project, memory, turns, note, has, row, stored, pageDelete, seed };
}

test("a note deleted on the page stays gone after a turn in a container whose own copy of the folder the server's is mounted over", async () => {
  const s = scheme();
  await s.seed();
  // On the host the container's config dir holds a folder of its own where the server's is mounted: a restore filled it.
  const volume = join(s.at, 'volume');
  for (const f of ['a.md', 'b.md', 'MEMORY.md']) s.note(volume, f, f, 3_600_000);
  const josh = s.turns(volume);
  await josh.start();
  s.pageDelete('a.md');
  await josh.end();
  assert.equal(s.stored('a.md'), false, "the volume's copy isn't saved again");
  const host = s.turns(server);
  await host.start();
  await host.end();
  await josh.start();
  assert.equal(s.has(server, 'a.md'), false);
  assert.equal(s.has(server, 'b.md'), true);
});

test('a note a session in that container deletes stays gone', async () => {
  const s = scheme();
  await s.seed();
  const volume = join(s.at, 'volume');
  for (const f of ['a.md', 'b.md', 'MEMORY.md']) s.note(volume, f, f, 3_600_000);
  const josh = s.turns(volume);
  await josh.start();
  rmSync(join(server, s.memory, 'a.md')); // through the mount
  await josh.end();
  assert.equal(s.stored('a.md'), false, 'the saved copy goes too');
  const host = s.turns(server);
  await host.start();
  assert.equal(s.has(server, 'a.md'), false);
});

test("a note an account 2 session deletes through the server's linked folder stays gone on both accounts", async () => {
  const s = scheme();
  await s.seed();
  const two = join(s.at, 'account-2');
  mkdirSync(two, { recursive: true });
  symlinkSync(join(server, 'projects'), join(two, 'projects'));
  const second = s.turns(two);
  await second.start();
  rmSync(join(server, s.memory, 'a.md'));
  await second.end();
  await second.start();
  assert.equal(s.has(server, 'a.md'), false, 'account 2');
  await s.turns(server).start();
  assert.equal(s.has(server, 'a.md'), false, 'account 1');
  assert.equal(s.stored('a.md'), false);
});

test("account 2's own copy of the folder never brings a deleted note back, and what it deletes itself isn't put back in it", async () => {
  const s = scheme();
  await s.seed();
  const two = join(s.at, 'account-2');
  const second = s.turns(two);
  await second.start();
  assert.equal(s.has(two, 'a.md'), true, "a login of its own gets the scheme's notes");
  await second.end();
  s.pageDelete('a.md');
  rmSync(join(two, s.memory, 'b.md'));
  for (let i = 0; i < 2; i++) {
    await second.start();
    await second.end();
    await s.turns(server).start();
  }
  assert.equal(s.has(server, 'a.md'), false);
  assert.equal(s.stored('a.md'), false);
  assert.equal(s.has(two, 'b.md'), false);
});

test('a note deleted while a container that lacks the mount runs stays gone, even one the turn edited; a note it wrote reaches the server', async () => {
  const s = scheme();
  await s.seed();
  const volume = join(s.at, 'volume');
  const josh = s.turns(volume);
  await josh.start();
  s.note(volume, 'a.md', 'edited in the volume');
  s.note(volume, 'new.md', 'written in the volume');
  // Another turn in that container starts meanwhile: what the first wrote isn't taken for old.
  await s.turns(volume).start();
  s.pageDelete('a.md');
  await josh.end(true);
  await josh.start();
  const host = s.turns(server);
  await host.start();
  await host.end();
  assert.equal(readFileSync(join(server, s.memory, 'new.md'), 'utf8'), 'written in the volume');
  assert.equal(s.stored('new.md'), true);
  s.note(server, 'later.md', 'written on the server');
  await josh.start();
  assert.equal(s.has(volume, 'later.md'), true);
  assert.equal(s.has(server, 'a.md'), false);
  assert.equal(s.stored('a.md'), false);
});

test('a note deleted mid-turn is not put back by a turn that starts before that one ends, nor after a restart cut it off', async () => {
  const s = scheme();
  await s.seed();
  const first = s.turns(server);
  await first.start();
  rmSync(join(server, s.memory, 'a.md'));
  await s.turns(server).start();
  assert.equal(s.has(server, 'a.md'), false);
  await first.end(true);
  await s.turns(server).start();
  assert.equal(s.has(server, 'a.md'), false);
});

test('a row stored before the fix for a note deleted on disk restores nothing, and goes at the next save', async () => {
  const s = scheme();
  await s.seed();
  s.row('ghost.md', 'deleted long ago', 60_000);
  // And one a Taskmaster whose cwd is the repo once stored as its own.
  const host = s.turns(server);
  s.store.putClaudeState({ path: join(s.memory, 'own.md'), project_id: s.project.id, ticket_id: host.ticket.id, size: 1, mtime: Date.now(), data: gzipSync('x') });
  await host.start();
  assert.equal(s.has(server, 'ghost.md'), false);
  assert.equal(s.has(server, 'own.md'), false);
  await host.end();
  assert.equal(s.stored('ghost.md'), false);
  assert.equal(s.stored('own.md'), false);
});

test('a fresh machine, whose memory folder is empty, gets every note back, also when the first try was cut off', async () => {
  const s = scheme();
  await s.seed();
  rmSync(join(server, s.memory), { recursive: true }); // timing-ok: own temp dir
  mkdirSync(join(server, s.memory));
  // The first try stops at a folder in the way of one note's file.
  mkdirSync(join(server, s.memory, 'b.md'));
  const host = s.turns(server);
  await assert.rejects(host.start());
  rmSync(join(server, s.memory, 'b.md'), { recursive: true }); // timing-ok: own temp dir
  writeFileSync(join(server, s.memory, 'stray.md'), 'the folder is no longer empty');
  await host.start();
  for (const f of ['a.md', 'b.md', 'MEMORY.md']) assert.equal(s.has(server, f), true, f);
  // Once it is back, a delete holds again.
  rmSync(join(server, s.memory, 'a.md'));
  await s.turns(server).start();
  assert.equal(s.has(server, 'a.md'), false);
});

for (const folder of ['missing', 'empty'])
  test(`the first note of a new scheme reaches the server from a container that lacks the mount, its memory folder ${folder}`, async () => {
    const s = scheme();
    if (folder === 'empty') mkdirSync(join(server, s.memory), { recursive: true });
    const volume = join(s.at, 'volume');
    const josh = s.turns(volume);
    await josh.start();
    s.note(volume, 'first.md', 'first');
    await josh.end();
    assert.equal(s.has(server, 'first.md'), true);
    assert.equal(s.stored('first.md'), true);
  });

test("a note written later under a deleted note's name is kept, in a copy without the mount too", async () => {
  const s = scheme();
  await s.seed();
  const volume = join(s.at, 'volume');
  const josh = s.turns(volume);
  await josh.start();
  s.pageDelete('a.md');
  await josh.end();
  await josh.start();
  s.note(volume, 'a.md', 'a new fact');
  await josh.end();
  assert.equal(readFileSync(join(server, s.memory, 'a.md'), 'utf8'), 'a new fact');
  assert.equal(s.stored('a.md'), true);
});

test("a note that can't be copied across costs neither the turn's start nor its save", async () => {
  const s = scheme();
  await s.seed();
  const volume = join(s.at, 'volume');
  const josh = s.turns(volume);
  await josh.start();
  s.note(volume, 'x.md', 'a file here');
  mkdirSync(join(server, s.memory, 'x.md')); // and a folder there
  const transcript = join('projects', projectSlug(josh.ticket.cwd), 'sess.jsonl');
  await josh.end();
  assert.ok(s.store.getClaudeState(transcript), 'the transcript is stored');
  await josh.start();
  rmSync(join(server, s.memory, 'x.md'), { recursive: true }); // timing-ok: own temp dir
  await josh.end();
  assert.equal(s.has(server, 'x.md'), true, 'copied once it can be');
});

test("a note in a minion's own folder not stored yet, or whose rows the nightly prune dropped, is stored at the next save", async () => {
  const s = scheme();
  const josh = s.turns(join(s.at, 'volume'));
  const own = join('projects', projectSlug(josh.ticket.cwd), 'memory', 'mine.md');
  await josh.start();
  mkdirSync(join(s.at, 'volume', own, '..'), { recursive: true });
  writeFileSync(join(s.at, 'volume', own), 'mine');
  await josh.start(); // a side question on the same login, mid-turn
  await josh.end();
  assert.ok(s.store.getClaudeState(own), 'stored though a start came between');
  await josh.start();
  await josh.end();
  for (const r of s.store.listClaudeState(s.project.id, josh.ticket.id)) s.store.deleteClaudeState(r.path);
  await josh.start();
  await josh.end();
  assert.ok(s.store.getClaudeState(own), 'stored again after the prune');
  s.store.deleteTicket(josh.ticket.id);
  assert.equal(s.store.getSetting(`memory-own:${josh.ticket.id}`), null);
});

test("a note in a minion's own folder that one login deleted isn't saved again from another login's older copy", async () => {
  const s = scheme();
  const volume = join(s.at, 'volume');
  const josh = s.turns(volume);
  const own = join('projects', projectSlug(josh.ticket.cwd), 'memory', 'mine.md');
  await josh.start();
  mkdirSync(join(volume, own, '..'), { recursive: true });
  writeFileSync(join(volume, own), 'mine');
  await josh.end();
  await josh.start();
  await josh.end();
  // On the host's login the same minion deletes it.
  s.store.deleteClaudeState(own);
  await josh.start();
  await josh.end();
  assert.equal(s.store.getClaudeState(own), undefined);
  // And one a killed turn deletes isn't put back.
  writeFileSync(join(volume, own), 'mine again');
  await josh.end();
  await josh.start();
  rmSync(join(volume, own));
  writeFileSync(join(volume, own, '..', 'other.md'), 'the folder is not empty');
  await josh.end(true);
  await josh.start();
  assert.equal(existsSync(join(volume, own)), false);
});
