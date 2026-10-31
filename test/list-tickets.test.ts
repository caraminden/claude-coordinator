import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, REPO, SECRET, type Booted, stopProcs } from './helpers.ts';

// A minion lists its own scheme's minions, read-only (#143): list_tickets through the real MCP server,
// and the route behind it, which gives a minion only the line's fields and never another scheme.
const root = mkdtempSync(join(tmpdir(), 'list-tickets-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  if (srv) await stopProcs([srv.proc]);
  rmSync(root, { recursive: true, force: true });
});

const store = new Store(join(data, 'coordinator.db'));
const A = store.createProject('A', null);
const B = store.createProject('B', null);
const minion = (p: number, title: string) => store.createTicket({ project_id: p, kind: 'ticket', title, permission_mode: 'default', created_by: 'Cara' });
const M1 = minion(A.id, 'Asker');
const M2 = minion(A.id, 'Sibling');
const GONE = minion(A.id, 'Dismissed one');
store.updateTicket(GONE.id, { status: 'closed' });
const OTHER = minion(B.id, 'Other scheme');

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});

async function tool(name: string, args: object): Promise<{ text: string; error: boolean }> {
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(M1.id),
      COORDINATOR_PROJECT: String(A.id), COORDINATOR_TICKET: String(M1.id), COORDINATOR_ROLE: 'thread',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const { result } = await reply;
    return { text: result.content[0].text, error: !!result.isError };
  } finally {
    child.kill();
  }
}

const get = (path: string, id: number) => fetch(srv.base + path, { headers: { Authorization: `Bearer ${tokens.agentToken(id)}` } });

test('a minion lists its own scheme, leaving out dismissed ones unless asked', async () => {
  const open = await tool('list_tickets', {});
  assert.equal(open.error, false, open.text);
  assert.match(open.text, /#1 Asker/);
  assert.match(open.text, /#2 Sibling/);
  assert.doesNotMatch(open.text, /Dismissed one|Other scheme/);
  const all = await tool('list_tickets', { include_closed: true });
  assert.match(all.text, /#3 Dismissed one .*status: closed/);
  assert.doesNotMatch(all.text, /Other scheme/);
});

test('a minion still cannot read another minion', async () => {
  const r = await tool('read_ticket', { ticket_id: 2 });
  assert.equal(r.error, true);
  assert.match(r.text, /Unknown tool read_ticket/);
});

test("the route gives a minion only the line's fields, and refuses another scheme", async () => {
  const res = await get(`/api/projects/${A.id}/tickets`, M2.id);
  assert.equal(res.status, 200);
  const { tickets } = await res.json();
  assert.deepEqual(tickets.map((t: any) => t.title).sort(), ['Asker', 'Sibling']);
  assert.deepEqual(Object.keys(tickets[0]).sort(), [
    'branch', 'build', 'closing', 'created_by', 'effort', 'last_activity', 'model', 'note', 'number', 'properties', 'queued', 'state', 'status', 'tag', 'title',
  ]);
  const cross = await get(`/api/projects/${B.id}/tickets`, M1.id);
  assert.equal(cross.status, 403);
  assert.equal((await get(`/api/projects/${B.id}/tickets`, OTHER.id)).status, 200);
});
