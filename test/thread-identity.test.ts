import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { threadMayCall } from '../src/auth.ts';

// Like #25 in the live project: shown as #25, stored as ticket 29 (the id its token is issued for).
const ID = 29;
const NUMBER = 25;

test('a thread token may read, relabel, ask and close only its own internal id', () => {
  assert.ok(threadMayCall(ID, 'GET', `/api/tickets/${ID}`));
  assert.ok(threadMayCall(ID, 'PATCH', `/api/tickets/${ID}`));
  assert.ok(threadMayCall(ID, 'POST', `/api/tickets/${ID}/questions`));
  assert.ok(threadMayCall(ID, 'POST', `/api/tickets/${ID}/close`));
  assert.ok(threadMayCall(ID, 'POST', `/api/tickets/${ID}/coordinator`));
  assert.ok(!threadMayCall(ID, 'POST', `/api/tickets/${NUMBER}/coordinator`));
  assert.ok(!threadMayCall(ID, 'POST', `/api/tickets/${NUMBER}/close`));
  assert.ok(!threadMayCall(ID, 'PATCH', `/api/tickets/${NUMBER}`));
  assert.ok(!threadMayCall(ID, 'POST', `/api/tickets/${ID}/status`));
  assert.ok(!threadMayCall(ID, 'POST', `/api/tickets/${ID}/messages`));
});

// A stand-in API that records what the thread's MCP server calls, and answers like `respond` says.
const calls: { method: string; path: string; auth: string }[] = [];
let respond = (_path: string): [number, object] => [200, { number: NUMBER, title: 'T', status: 'running', created_by: 'Cara' }];
const api = createServer((req, res) => {
  calls.push({ method: req.method!, path: req.url!, auth: String(req.headers.authorization) });
  req.resume().on('end', () => {
    const [status, body] = respond(req.url!);
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  });
});
await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
after(() => api.close());

const mcp = spawn(process.execPath, [join(import.meta.dirname, '../src/mcp.ts')], {
  env: {
    ...process.env, MACHINES_URL: undefined,
    COORDINATOR_API: `http://127.0.0.1:${(api.address() as any).port}`,
    COORDINATOR_TOKEN: `${ID}.sig`,
    COORDINATOR_PROJECT: '2',
    COORDINATOR_ROLE: 'thread',
    COORDINATOR_TICKET: String(ID),
  },
  stdio: ['pipe', 'pipe', 'inherit'],
});
after(() => mcp.kill());
const replies = new Map<number, (r: any) => void>();
createInterface({ input: mcp.stdout! }).on('line', (l) => {
  const r = JSON.parse(l);
  replies.get(r.id)?.(r);
});
let rid = 0;
function rpc(method: string, params: object): Promise<any> {
  const id = ++rid;
  mcp.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((r) => replies.set(id, r));
}
const tool = (name: string, args: object) => rpc('tools/call', { name, arguments: args }).then((r) => r.result);

test('close_self and set_thread_status address the internal id, whatever the model passes', async () => {
  const tools = (await rpc('tools/list', {})).result.tools.map((t: any) => t.name);
  assert.ok(tools.includes('close_self'));
  calls.length = 0;
  const closed = await tool('close_self', { reason: 'merged', ticket_id: 7 });
  assert.ok(!closed.isError, closed.content[0].text);
  const labelled = await tool('set_thread_status', { note: 'ok' });
  assert.ok(!labelled.isError, labelled.content[0].text);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /api/tickets/${ID}/close`, `PATCH /api/tickets/${ID}`]);
  for (const c of calls) assert.ok(threadMayCall(ID, c.method, c.path), `${c.method} ${c.path} passes the guard`);
});

test('message_coordinator posts to its own internal id', async () => {
  calls.length = 0;
  const r = await tool('message_coordinator', { text: 'Send #28 the handoff', ticket_id: 7 });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /api/tickets/${ID}/coordinator`]);
});

test('close_self on a server older than the tool says to wait for the restart', async () => {
  respond = () => [403, { error: 'A thread may only update itself' }];
  const r = await tool('close_self', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /predates close_self.*next restart/);
});
