import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { Store } from '../src/db.ts';
import { PAGE_EVENTS } from '../src/history.ts';
import { bootServer, PASSWORD, REPO, SECRET, type Booted } from './helpers.ts';

// read_ticket through the real MCP server: the events route pages a minion's history (#120), and the
// tool still needs every entry to show the last few and count the rest (#142).
const root = mkdtempSync(join(tmpdir(), 'read-ticket-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

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
after(() => srv?.proc.kill());

async function readTicket(args: object): Promise<{ text: string; error: boolean }> {
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, COORDINATOR_API: srv.base, COORDINATOR_TOKEN: tokens.agentToken(TM.id),
      COORDINATOR_PROJECT: String(P.id), COORDINATOR_TICKET: String(TM.id), COORDINATOR_ROLE: 'coordinator',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_ticket', arguments: args } }) + '\n');
    const { result } = await reply;
    return { text: result.content[0].text, error: !!result.isError };
  } finally {
    child.kill();
  }
}

test('read_ticket shows the last entries of a paged history and counts every earlier one', async () => {
  const { text, error } = await readTicket({ ticket_id: store.getTicket(M.id)!.number, last: 5 });
  assert.equal(error, false, text);
  assert.match(text, /Long one/);
  assert.match(text, new RegExp(`\\(${MESSAGES - 5} earlier entries omitted\\)`));
  const shown = text.split('\n\n').filter((l) => l.startsWith('[Cara]'));
  assert.deepEqual(shown, [4, 3, 2, 1, 0].map((k) => MESSAGES - k).map((i) => `[Cara]: message ${i}`));
});

test("read_ticket collapses a Grunt's report to its first line and keeps the minion's reply whole", async () => {
  const { text } = await readTicket({ ticket_id: store.getTicket(G.id)!.number });
  assert.match(text, /\(Grunt reported\) Emberknight has five takes\./);
  assert.doesNotMatch(text, /reads well/);
  assert.match(text, /\[Claude\]: All takes are drawn\./);
});
