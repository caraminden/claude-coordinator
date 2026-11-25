import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Contraptions } from '../src/contraptions.ts';
import { buildOwnerKey, Store } from '../src/db.ts';
import { bootServer, PASSWORD, SECRET, type Booted, stopProcs, tempRoot, zoneDay } from './helpers.ts';
import { agentEnv, mcpOnce } from './mcp-agent.ts';
import { json } from './typed.ts';

/** A line of a scheme's minion list, as these tests read it. */
type Line = { id: number; title: string; open_cards: { kind: string; what: string }[] };

// A minion lists its own scheme's minions, read-only (#143): list_tickets through the real MCP server,
// and the route behind it, which gives a minion only the line's fields and never another scheme.
const tmp = tempRoot('list-tickets-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  if (srv) await stopProcs([srv.proc]);
  await tmp.teardown();
});

const store = new Store(join(data, 'coordinator.db'));
const A = store.createProject('A', null);
const B = store.createProject('B', null);
// A scheme with a repo whose build/5 branch exists: its feeder's go card merges, its build minion's and a plain minion's ship.
const gitRepo = join(root, 'repo');
mkdirSync(gitRepo);
for (const a of [
  ['init', '-q', '-b', 'main'],
  ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'],
  ['branch', 'build/5'],
])
  execFileSync('git', a, { cwd: gitRepo });
const C = store.createProject('C', null);
store.setProjectRepoDir(C.id, gitRepo);
const minion = (p: number, title: string) => store.createTicket({ project_id: p, kind: 'ticket', title, permission_mode: 'default', created_by: 'Cara' });
const M1 = minion(A.id, 'Asker');
const M2 = minion(A.id, 'Sibling');
const GONE = minion(A.id, 'Dismissed one');
store.updateTicket(GONE.id, { status: 'closed' });
const OTHER = minion(B.id, 'Other scheme');
// A question card waiting on people in the sibling's chat (#468 S06-3).
const CARD = store.addEvent(M2.id, 'question', { id: 'q1', questions: [{ header: 'Layout', question: 'Tabs?' }] });

// A task list in the sibling's history and in the dismissed one's (#527).
for (const t of [M2, GONE]) {
  store.addEvent(t.id, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'TaskCreate', input: { subject: 'Map' } }] } });
  store.addEvent(t.id, 'claude', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'Task #1 created successfully: Map' }] } });
}

// A contraption of scheme A with errors yesterday (Pacific), for the morning count (#835).
const yesterday = new Date(Date.parse(`${zoneDay()}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10); // in the server's zone (#1536)
const app = new Contraptions(store, 's'.repeat(40), join(root, 'keys')).register({ name: 'peek', title: 'Peek', port: 9401, icon: null, home_scheme: A.id, open_paths: '[]', default_model: null, turn_cap: null });
for (let i = 0; i < 3; i++) store.addContraptionError(app.id, yesterday, 'tool', 'Bash: exit #', 'Bash: exit 1', Date.now() - 86_400_000);

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});

async function tool(name: string, args: object): Promise<{ text: string; error: boolean }> {
  const result = await mcpOnce(agentEnv(srv.base, tokens.agentToken(M1.id), M1, 'thread'), 'tools/call', { name, arguments: args }, tmp.track);
  return { text: result.content[0].text, error: !!result.isError };
}

const get = (path: string, id: number) => fetch(srv.base + path, { headers: { Authorization: `Bearer ${tokens.agentToken(id)}` } });

test('a minion lists its own scheme, leaving out dismissed ones unless asked', async () => {
  const open = await tool('list_tickets', {});
  assert.equal(open.error, false, open.text);
  assert.match(open.text, /#1 Asker/);
  assert.match(open.text, /#2 Sibling/);
  assert.match(open.text, new RegExp(`#2 Sibling .*waiting: .*Layout.*#/p/${A.id}/t/2\\?e=${CARD.id}`), 'the card waiting on people, with its link');
  assert.doesNotMatch(open.text, /Dismissed one|Other scheme/);
  const all = await tool('list_tickets', { include_closed: true });
  assert.match(all.text, /#3 Dismissed one .*status: closed/);
  assert.doesNotMatch(all.text, /Other scheme/);
});

test("the list's first line counts the scheme's contraption errors yesterday and names the file (#835)", async () => {
  const { text } = await tool('list_tickets', {});
  assert.equal(text.split('\n')[0], `Contraption errors yesterday (${yesterday}): 3, Peek 3. Grouped with a sample each in the shared folder's reports/contraption-errors/${yesterday}.md.`);
});

test('a minion still cannot read another minion', async () => {
  const r = await tool('read_ticket', { ticket_id: 2 });
  assert.equal(r.error, true);
  assert.match(r.text, /Unknown tool read_ticket/);
});

test("the route gives a minion only the line's fields, and refuses another scheme", async () => {
  const res = await get(`/api/projects/${A.id}/tickets`, M2.id);
  assert.equal(res.status, 200);
  const { tickets } = await json<{ tickets: Line[] }>(res);
  assert.deepEqual(tickets.map((t) => t.title).sort(), ['Asker', 'Sibling']);
  assert.deepEqual(Object.keys(tickets[0]).sort(), ['branch', 'build', 'closing', 'created_by', 'effort', 'last_activity', 'model', 'note', 'number', 'open_cards', 'parent', 'plugin_dirs', 'properties', 'queued', 'state', 'status', 'title', 'workflow']);
  const cross = await get(`/api/projects/${B.id}/tickets`, M1.id);
  assert.equal(cross.status, 403);
  assert.equal((await get(`/api/projects/${B.id}/tickets`, OTHER.id)).status, 200);
});

test("the scheme's list counts an open minion's steps and leaves a dismissed one's history unread (#527)", async () => {
  const { status, data: scheme } = await srv.call(`/api/projects/${A.id}`);
  assert.equal(status, 200);
  const by = (title: string) => scheme.tickets.find((t: Line) => t.title === title);
  assert.deepEqual(by('Sibling').steps, { done: 0, total: 1 });
  assert.equal(by('Dismissed one').steps, null, 'its row shows no steps, so its events are not replayed for the list');
  assert.equal(by('Sibling').pending_card_at, CARD.created_at);
  assert.equal(by('Sibling').open_cards.length, 1);
  assert.equal(by('Dismissed one').pending_card_at, null);
});

test('a question card asked with kind merge reads as a ship card on the list; an unknown kind is refused (#575)', async () => {
  const q = [{ question: 'Ship this high-risk change?', header: 'Ship It', options: [{ label: 'Ship It', recommended: true }, { label: 'Hold' }] }];
  const asked = await tool('ask_question', { questions: q, kind: 'merge' });
  assert.equal(asked.error, false, asked.text);
  const { data: scheme } = await srv.call(`/api/projects/${A.id}`);
  const cards = scheme.tickets.find((t: Line) => t.title === 'Asker').open_cards;
  assert.deepEqual(
    cards.map((c: { kind: string; what: string }) => [c.kind, c.what]),
    [['question', 'ship']],
  );
  assert.deepEqual(
    scheme.tickets.find((t: Line) => t.title === 'Sibling').open_cards.map((c: { kind: string; what: string }) => c.what),
    ['question'],
    'a plain question stays a question',
  );
  const bad = await fetch(`${srv.base}/api/tickets/${M1.id}/questions`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.agentToken(M1.id)}`, 'content-type': 'application/json' }, body: JSON.stringify({ questions: q, kind: 'deploy' }) });
  assert.equal(bad.status, 400);
  // "ship" is the word people read (Cara, 2026-11-19, on #1020's card), and an older "land" still counts: asked with
  // either, the card is stored as the older kind merge.
  for (const kind of ['ship', 'land']) {
    const r = await fetch(`${srv.base}/api/tickets/${M1.id}/questions`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.agentToken(M1.id)}`, 'content-type': 'application/json' }, body: JSON.stringify({ questions: q, kind }) });
    assert.equal(r.status, 201, await r.text());
  }
  const { data: after } = await srv.call(`/api/projects/${A.id}`);
  assert.deepEqual(
    after.tickets.find((t: Line) => t.id === M1.id).open_cards.map((c: { kind: string; what: string }) => c.what),
    ['ship', 'ship', 'ship'],
  );
});

test("a feeder's go card says merge, a build owner's and a plain minion's say ship", async () => {
  const feeder = store.createTicket({ project_id: C.id, kind: 'ticket', title: 'Feeder', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(feeder.id, { build: 5 });
  const owner = store.createTicket({ project_id: C.id, kind: 'ticket', title: 'Owner', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(owner.id, { build: 5 });
  store.setSetting(buildOwnerKey(C.id, 5), owner.id);
  const plain = store.createTicket({ project_id: C.id, kind: 'ticket', title: 'Plain', permission_mode: 'default', created_by: 'Cara' });
  const q = [{ question: 'Go?', header: 'Go', options: [{ label: 'Go', recommended: true }, { label: 'Hold' }] }];
  for (const t of [feeder, owner, plain]) {
    const r = await fetch(`${srv.base}/api/tickets/${t.id}/questions`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.agentToken(t.id)}`, 'content-type': 'application/json' }, body: JSON.stringify({ questions: q, kind: 'merge' }) });
    assert.equal(r.status, 201, await r.text());
  }
  const { data: scheme } = await srv.call(`/api/projects/${C.id}`);
  const what = (title: string) => scheme.tickets.find((t: Line) => t.title === title).open_cards.map((c: { kind: string; what: string }) => c.what);
  assert.deepEqual([what('Feeder'), what('Owner'), what('Plain')], [['merge'], ['ship'], ['ship']]);
});
