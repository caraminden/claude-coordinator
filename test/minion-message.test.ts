import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { bootServer, PASSWORD, REPO, SECRET, type Booted, tempRoot } from './helpers.ts';

// Minions message each other directly (#783): message_minion and read_minion through the real MCP server
// and the routes behind them. Every message here is wake: false, so no turn starts (the server's claude is
// /bin/false); the wake rules themselves are runner.guard's, tested in cold-mail and parked-hold.
const tmp = tempRoot('minion-message-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(async () => {
  if (srv) await srv.stop();
  await tmp.teardown();
});

const store = new Store(join(data, 'coordinator.db'));
const A = store.createProject('A', null);
const B = store.createProject('B', null);
const TM = store.createTicket({ project_id: A.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
const minion = (p: number, title: string) => store.createTicket({ project_id: p, kind: 'ticket', title, permission_mode: 'default', created_by: 'Cara' });
const M1 = minion(A.id, 'Sender');
const M2 = minion(A.id, 'Receiver');
const GONE = minion(A.id, 'Dismissed one');
store.updateTicket(GONE.id, { status: 'closed' });
const M4 = minion(A.id, 'Chatty');
minion(B.id, 'B one');
minion(B.id, 'B two');
const OTHER = minion(B.id, 'Only in B');
store.setTicketDir(M2.id, join(root, 'wt-receiver'), 'ticket/2-receiver');
// The receiver's chat: a person's message, a card, a tool call and a reply.
store.addEvent(M2.id, 'user_message', { author: 'Cara', text: 'Please own src/foo.ts' });
store.addEvent(M2.id, 'question', { id: 'q1', questions: [{ header: 'Secret pick', question: 'Private option?' }] });
store.addEvent(M2.id, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'cat ~/.secret' } }] } });
store.addEvent(M2.id, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'I own src/foo.ts now.' }] } });

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});

async function tool(from: number, name: string, args: object): Promise<{ text: string; error: boolean }> {
  const child = tmp.spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(from),
      COORDINATOR_PROJECT: String(A.id), COORDINATOR_TICKET: String(from), COORDINATOR_ROLE: 'thread',
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

const events = (id: number, kind: string) => store.listEvents(id).filter((e) => e.kind === kind).map((e) => JSON.parse(e.data));

test('a message shows in both chats, labelled with the sender, and the Taskmaster gets a copy as held mail that wakes nothing', async () => {
  const r = await tool(M1.id, 'message_minion', { ticket_id: M2.number, text: 'I changed src/foo.ts: rebase before you touch it', wake: false });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /Left as held mail: #2 Receiver/);
  const got = events(M2.id, 'user_message').at(-1);
  assert.equal(got.author, '#1 Sender');
  assert.equal(got.text, 'I changed src/foo.ts: rebase before you touch it');
  assert.match(events(M1.id, 'note').at(-1).text, /^Left held mail for #2 Receiver: I changed src\/foo\.ts/);
  // The chat's bubble reads "Not sent yet" while the ticket lists the message as held (#910).
  const heldRow = store.listEvents(M2.id).filter((e) => e.kind === 'user_message').at(-1)!;
  assert.ok((await srv.call(`/api/tickets/${M2.id}`)).data.ticket.held_ids.includes(heldRow.id));
  const copy = events(TM.id, 'minion_copy').at(-1);
  assert.equal(copy.author, '#1 Sender');
  assert.deepEqual([copy.from, copy.to], [1, 2]);
  assert.match(copy.text, /^I changed/);
  // A chat-only row (#924): nothing queued for its next turn, and no message of its own.
  assert.equal(((store.getSetting<any>(`minion-queue:${TM.id}`)?.held ?? null) ?? []).length, 0, "the Taskmaster's next turn gets no copy");
  assert.equal(events(TM.id, 'user_message').length, 0);
  const { data: tm } = await srv.call(`/api/tickets/${TM.id}`);
  assert.notEqual(tm.ticket.status, 'running');
});

test('only minions of its own scheme: a number that exists only in another scheme is refused', async () => {
  assert.equal(OTHER.number, 3);
  const before = events(OTHER.id, 'user_message').length;
  // #3 in A is the dismissed one; #5 exists only in B.
  const r = await tool(M1.id, 'message_minion', { ticket_id: 5, text: 'hello?', wake: false });
  assert.equal(r.error, true);
  assert.match(r.text, /no minion #5 in this scheme.*Taskmaster/);
  const peek = await tool(M1.id, 'read_minion', { ticket_id: 5 });
  assert.equal(peek.error, true);
  // The route takes the sender from the path, so a minion can't post as another one either.
  const forged = await fetch(`${srv.base}/api/tickets/${M2.id}/minion-message`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokens.agentToken(M1.id)}`, 'content-type': 'application/json' }, body: JSON.stringify({ to: 1, text: 'x' }),
  });
  assert.equal(forged.status, 403);
  assert.equal(events(OTHER.id, 'user_message').length, before);
});

test('unpark: true wakes a minion parked on the sender, and the Taskmaster gets a held-mail line', async () => {
  const P = minion(A.id, 'Waiting on #1');
  store.updateTicket(P.id, { state: 'parked' });
  const plain = await tool(M1.id, 'message_minion', { ticket_id: P.number, text: 'held only' });
  assert.match(plain.text, /resend with unpark: true/);
  assert.equal(store.getTicket(P.id)!.state, 'parked', 'without unpark it stays parked');
  const r = await tool(M1.id, 'message_minion', { ticket_id: P.number, text: 'my work is on main, go ahead', unpark: true });
  assert.equal(r.error, false, r.text);
  assert.equal(store.getTicket(P.id)!.state, null);
  assert.ok(events(P.id, 'note').some((n) => n.text === '#1 unparked this minion.'));
  assert.ok(events(P.id, 'user_message').some((m) => m.author === '#1 Sender' && m.text === 'my work is on main, go ahead'));
  const copy = events(TM.id, 'minion_copy').at(-1);
  assert.equal(copy.unparked, true);
  assert.match(copy.text, /^my work is on main/);
  assert.equal(((store.getSetting<any>(`minion-queue:${TM.id}`)?.held ?? null) ?? []).length, 0);
});

test('unpark: a chain a person put on hold is refused and stays parked', async () => {
  const H = minion(A.id, 'Held chain');
  store.updateTicket(H.id, { state: 'parked' });
  store.setSetting('chained-minions', [{ ticket: H.id, after: M2.id, when: 'live', message: 'brief', from: 'Cara', base: null, held: true }]);
  const r = await tool(M1.id, 'message_minion', { ticket_id: H.number, text: 'go', unpark: true });
  assert.equal(r.error, true);
  assert.match(r.text, /on hold.*Taskmaster/);
  assert.equal(store.getTicket(H.id)!.state, 'parked');
  store.setSetting('chained-minions', []);
});

test('a dismissed minion is refused and stays dismissed', async () => {
  const r = await tool(M1.id, 'message_minion', { ticket_id: GONE.number, text: 'wake up', urgent: true });
  assert.equal(r.error, true);
  assert.match(r.text, /dismissed.*never reopens.*Taskmaster/);
  assert.equal(store.getTicket(GONE.id)!.status, 'closed');
  assert.equal(events(GONE.id, 'user_message').length, 0);
});

test('a pair of minions is held after 6 either way in 10 minutes; their Taskmaster loops are apart', async () => {
  for (let i = 0; i < 6; i++) {
    const [from, to] = i % 2 ? [M4, M1] : [M1, M4];
    const r = await tool(from.id, 'message_minion', { ticket_id: to.number, text: `ping ${i}`, wake: false });
    assert.equal(r.error, false, r.text);
    assert.doesNotMatch(r.text, /Held, not delivered/);
  }
  const held = await tool(M4.id, 'message_minion', { ticket_id: M1.number, text: 'ping 6', wake: false });
  assert.match(held.text, /Held, not delivered: you and #1/);
  assert.equal(events(M1.id, 'user_message').filter((m) => m.text === 'ping 6').length, 0);
  const copies = () => events(TM.id, 'minion_copy').filter((m) => m.text === 'ping 6').length;
  assert.equal(copies(), 0, 'no Taskmaster copy while it is held');
  for (const id of [M1.id, M4.id]) assert.match(events(id, 'loop_paused').at(-1).text, /#4 and #1 have exchanged 6 messages/);
  // Another pair isn't held, and the Taskmaster's own loop with #1 counted none of these.
  assert.doesNotMatch((await tool(M1.id, 'message_minion', { ticket_id: M2.number, text: 'other pair', wake: false })).text, /Held/);
  assert.equal(store.getSetting(`loop:${M1.id}`), null);
  // A person's Continue in either chat lets it through.
  const res = await srv.call(`/api/tickets/${M1.id}/continue`, {});
  assert.equal(res.data.released, 1);
  assert.equal(events(M1.id, 'user_message').filter((m) => m.text === 'ping 6').length, 1);
  assert.equal(copies(), 1, 'the Taskmaster gets its copy once the message goes through');
});

test("read_minion shows a minion's line with its worktree and its chat's words, without cards or tool calls", async () => {
  const r = await tool(M1.id, 'read_minion', { ticket_id: M2.number });
  assert.equal(r.error, false, r.text);
  assert.match(r.text, /#2 Receiver .*branch: ticket\/2-receiver .*worktree: .*wt-receiver/);
  assert.match(r.text, /\[Cara\]: Please own src\/foo\.ts/);
  assert.match(r.text, /\[Claude\]: I own src\/foo\.ts now\./);
  assert.doesNotMatch(r.text, /Private option|cat ~\/\.secret/);
  const list = await tool(M1.id, 'list_tickets', {});
  assert.match(list.text, /#2 Receiver .*worktree: .*wt-receiver/);
});

test('the Taskmaster has neither tool, and its list leaves worktrees to read_ticket', async () => {
  const res = await fetch(`${srv.base}/api/tickets/${M1.id}/minion-message`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokens.agentToken(TM.id)}`, 'content-type': 'application/json' }, body: JSON.stringify({ to: 2, text: 'x' }),
  });
  assert.equal(res.status, 403);
  const list = await fetch(`${srv.base}/api/projects/${A.id}/tickets`, { headers: { Authorization: `Bearer ${tokens.agentToken(TM.id)}` } });
  assert.equal((await list.json()).tickets.some((t: any) => 'worktree' in t), false);
});
