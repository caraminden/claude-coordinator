import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { PAGE_EVENTS } from '../src/history.ts';
import { bootServer, PASSWORD, SECRET, tempRoot, type Booted } from './helpers.ts';
import { agentEnv, mcpOnce } from './mcp-agent.ts';

// read_ticket through the real MCP server: the events route pages a minion's history (#120), and the
// tool still needs every entry to show the last few and count the rest (#142).
const tmp = tempRoot('read-ticket-');
const root = tmp.dir;
const data = join(root, 'data');
mkdirSync(data, { recursive: true });

const store = new Store(join(data, 'coordinator.db'));
const P = store.createProject('A', null);
const TM = store.createTicket({ project_id: P.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Cara' });
const M = store.createTicket({ project_id: P.id, kind: 'ticket', title: 'Long one', permission_mode: 'default', created_by: 'Cara' });
// More entries than one history page holds, with tool calls in between that show no line.
const MESSAGES = PAGE_EVENTS + 50;
for (let i = 1; i <= MESSAGES; i++) {
  store.addEvent(M.id, 'user_message', { author: 'Cara', text: `message ${i}` });
  store.addEvent(M.id, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });
}

// A minion whose Grunt reported a long wall, then replied itself (#205).
const G = store.createTicket({ project_id: P.id, kind: 'ticket', title: 'Fan-out', permission_mode: 'default', created_by: 'Cara' });
store.addEvent(G.id, 'claude', { type: 'assistant', parent_tool_use_id: 'toolu_1', message: { content: [{ type: 'text', text: '## Emberknight has five takes.\n\n**A** reads well.\n**B** clips.' }] } });
store.addEvent(G.id, 'claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'All takes are drawn.' }] } });

const tokens = new Auth(PASSWORD, SECRET);
let srv: Booted;
before(async () => {
  srv = await bootServer({ root });
});
after(async () => {
  await srv?.stop(); // ends the server and its turns before the folder goes (#218)
  await tmp.teardown();
});

async function readTicket(args: object): Promise<{ text: string; error: boolean }> {
  const result = await mcpOnce(agentEnv(srv.base, tokens.agentToken(TM.id), { id: TM.id, project_id: P.id }, 'coordinator'), 'tools/call', { name: 'read_ticket', arguments: args }, tmp.track);
  return { text: result.content[0].text, error: !!result.isError };
}

test('read_ticket shows the last entries of a paged history and counts every earlier one', async () => {
  const { text, error } = await readTicket({ ticket_id: store.getTicket(M.id)!.number, last: 5 });
  assert.equal(error, false, text);
  assert.match(text, /Long one/);
  assert.match(text, new RegExp(`\\(${MESSAGES - 5} earlier entries omitted\\)`));
  const shown = text.split('\n\n').filter((l) => l.startsWith('[Cara]'));
  assert.deepEqual(
    shown,
    [4, 3, 2, 1, 0].map((k) => MESSAGES - k).map((i) => `[Cara]: message ${i}`),
  );
});

test("read_ticket collapses a Grunt's report to its first line and keeps the minion's reply whole", async () => {
  const { text } = await readTicket({ ticket_id: store.getTicket(G.id)!.number });
  assert.match(text, /\(Grunt reported\) Emberknight has five takes\./);
  assert.doesNotMatch(text, /reads well/);
  assert.match(text, /\[Claude\]: All takes are drawn\./);
});

test('read_ticket shows the worktree, and live: true shows what the turn is doing instead of the chat', async () => {
  const L = store.createTicket({ project_id: P.id, kind: 'ticket', title: 'Busy one', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(L.id, '/w/busy', null);
  store.addEvent(L.id, 'user_message', { author: 'Josh', text: 'is it hung?' });
  store.addEvent(L.id, 'claude', { type: 'system', subtype: 'init' });
  store.addEvent(L.id, 'claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cargo test', description: 'Run the tests' } }] } });
  const n = store.getTicket(L.id)!.number;
  const plain = await readTicket({ ticket_id: n });
  assert.match(plain.text, /^worktree: \/w\/busy$/m);
  assert.match(plain.text, /\[Josh\]: is it hung\?/);
  const live = await readTicket({ ticket_id: n, live: true });
  assert.equal(live.error, false, live.text);
  assert.match(live.text, /Live state of #\d+: status/);
  assert.match(live.text, /Bash: Run the tests: cargo test/);
  assert.doesNotMatch(live.text, /is it hung/);
});
