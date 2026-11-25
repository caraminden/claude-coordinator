import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, SECRET, type Booted, tempRoot } from './helpers.ts';
import { agentEnv, mcpOnce } from './mcp-agent.ts';

// People's note on a minion (#146): people read and write it; minions and the Taskmaster never see it,
// not in any ticket JSON they can fetch nor in list_tickets or read_ticket.
const tmp = tempRoot('person-notes-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });

const store = new Store(join(data, 'coordinator.db'));
const P = store.createProject('A', null);
const TM = store.createTicket({ project_id: P.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Cara' });
const M = store.createTicket({ project_id: P.id, kind: 'ticket', title: 'Noted one', permission_mode: 'default', created_by: 'Cara' });
store.updateTicket(M.id, { note: 'the minion note' });
store.db.close();

const SECRET_NOTE = 'ask Josh about #1 first';
const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});
after(async () => {
  await srv?.stop(); // ends the server and its turns before the folder goes (#218)
  await tmp.teardown();
});

async function asAgent(id: number, path: string, body?: object, method = body ? 'POST' : 'GET') {
  const res = await fetch(srv.base + path, {
    method,
    headers: { Authorization: `Bearer ${tokens.agentToken(id)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

async function tool(name: string, args: object): Promise<string> {
  const result = await mcpOnce(agentEnv(srv.base, tokens.agentToken(TM.id), { id: TM.id, project_id: P.id }, 'coordinator'), 'tools/call', { name, arguments: args }, tmp.track);
  assert.equal(result.isError, undefined, result.content[0].text);
  return result.content[0].text;
}

test('a person sets a note: folded to one line, capped, shown to people with who wrote it', async () => {
  const set = await srv.call(`/api/tickets/${M.id}/person-note`, { text: `  ask Josh\n about #1   first ` }, 'PUT');
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(set.data.note.text, SECRET_NOTE);
  assert.equal(set.data.note.by, 'Cara');
  const { data: page } = await srv.call(`/api/projects/${P.id}`);
  assert.equal(page.person_notes[M.id].text, SECRET_NOTE);
  // The minion's own note is untouched.
  assert.equal(page.tickets.find((t: any) => t.id === M.id).note, 'the minion note');

  assert.equal((await srv.call(`/api/tickets/${M.id}/person-note`, { text: 'x'.repeat(201) }, 'PUT')).status, 400);
  assert.equal((await srv.call(`/api/tickets/${M.id}/person-note`, {}, 'PUT')).status, 400);
  assert.equal((await srv.call(`/api/tickets/${TM.id}/person-note`, { text: 'no' }, 'PUT')).status, 400, 'the Taskmaster has no note');
  assert.equal((await srv.call(`/api/projects/${P.id}`)).data.person_notes[M.id].text, SECRET_NOTE, 'a refused write changes nothing');
});

test('minions and the Taskmaster can neither write nor read it', async () => {
  const reads = { [M.id]: [`/api/tickets/${M.id}`], [TM.id]: [`/api/tickets/${M.id}`, `/api/projects/${P.id}`, `/api/tickets/${M.id}/events?after=0`] };
  for (const who of [M.id, TM.id]) {
    assert.equal((await asAgent(who, `/api/tickets/${M.id}/person-note`, { text: 'mine now' }, 'PUT')).status, 403);
    for (const path of reads[who]) {
      const r = await asAgent(who, path);
      assert.equal(r.status, 200, `${path}: ${r.text}`);
      if (!path.includes('/events')) assert.match(r.text, /Noted one|the minion note/, path); // and setting it left no chat line
      assert.ok(!r.text.includes('ask Josh'), `${path} as ${who === M.id ? 'the minion' : 'the Taskmaster'}`);
    }
  }
  const list = await tool('list_tickets', {});
  assert.match(list, /Noted one/);
  assert.ok(!list.includes('ask Josh'), list);
  const read = await tool('read_ticket', { ticket_id: M.number });
  assert.match(read, /the minion note/);
  assert.ok(!read.includes('ask Josh'), read);
});

test('an empty text clears it, and deleting the minion deletes its note', async () => {
  assert.equal((await srv.call(`/api/tickets/${M.id}/person-note`, { text: '   ' }, 'PUT')).data.note, null);
  assert.deepEqual((await srv.call(`/api/projects/${P.id}`)).data.person_notes, {});
  const s = new Store(join(data, 'coordinator.db'));
  try {
    s.setPersonNote(M.id, 'again', 'Cara');
    s.deleteTicket(M.id);
    assert.deepEqual(s.personNotes(P.id), {});
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM person_notes').get()!.n, 0);
  } finally {
    s.db.close();
  }
});
