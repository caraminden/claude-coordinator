import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { router, type Route } from '../src/http.ts';
import { appRoutes } from '../src/routes/app.ts';
import { fileRoutes } from '../src/routes/files.ts';
import { machineRoutes } from '../src/routes/machines.ts';
import { projectRoutes } from '../src/routes/projects.ts';
import { pushRoutes } from '../src/routes/push.ts';
import { ticketRoutes } from '../src/routes/tickets.ts';

// Like #25 in the live project: shown as #25, stored as ticket 29 (the id its token is issued for).
const ID = 29;
const NUMBER = 25;

// The real route table, with every handler swapped for a no-op, over a stand-in store holding the
// minion and another one numbered like its own #.
const minion = { id: ID, number: NUMBER, project_id: 2, kind: 'ticket' };
const other = { id: NUMBER, number: 21, project_id: 2, kind: 'ticket' };
const stub: any = {
  store: { getTicket: (id: number) => [minion, other].find((t) => t.id === id), getProject: (id: number) => ({ id }) },
  runner: { view: (t: unknown) => t },
};
const all: Route[] = [...appRoutes, ...projectRoutes, ...ticketRoutes, ...fileRoutes, ...machineRoutes, ...pushRoutes];
const table = router(all.map((r) => ({ ...r, handler: () => 'ok' })));
/** Would the route table let this minion's token make the call (anything but a 403)? */
async function mayCall(method: string, path: string): Promise<boolean> {
  try {
    await table(stub, { method, headers: {} } as any, {} as any, new URL(path, 'http://x'), { name: '#25', exp: 0, agent: ID });
    return true;
  } catch (err: any) {
    if (err.status === 403) return false;
    throw err;
  }
}

test('a thread token may read, relabel, ask and close only its own internal id', async () => {
  assert.ok(await mayCall('GET', `/api/tickets/${ID}`));
  assert.ok(await mayCall('PATCH', `/api/tickets/${ID}`));
  assert.ok(await mayCall('POST', `/api/tickets/${ID}/questions`));
  assert.ok(await mayCall('POST', `/api/tickets/${ID}/close`));
  assert.ok(await mayCall('POST', `/api/tickets/${ID}/coordinator`));
  assert.ok(await mayCall('POST', `/api/tickets/${ID}/strike`));
  assert.ok(!await mayCall('POST', `/api/tickets/${NUMBER}/strike`));
  assert.ok(!await mayCall('POST', `/api/tickets/${NUMBER}/coordinator`));
  assert.ok(!await mayCall('POST', `/api/tickets/${NUMBER}/close`));
  assert.ok(!await mayCall('PATCH', `/api/tickets/${NUMBER}`));
  assert.ok(!await mayCall('POST', `/api/tickets/${ID}/status`));
  assert.ok(!await mayCall('POST', `/api/tickets/${ID}/messages`));
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
  for (const c of calls) assert.ok(await mayCall(c.method, c.path), `${c.method} ${c.path} passes the guard`);
});

test('message_coordinator posts to its own internal id', async () => {
  calls.length = 0;
  const r = await tool('message_coordinator', { text: 'Send #28 the handoff', ticket_id: 7 });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /api/tickets/${ID}/coordinator`]);
});

test('wake_when_live posts to its own internal id, which its token may do', async () => {
  calls.length = 0;
  respond = () => [201, { waiting: true, commit: 'a'.repeat(40), head: 'b'.repeat(40) }];
  const r = await tool('wake_when_live', { commit: 'aaaaaaa', reason: 'retry', ticket_id: 7 });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /Waiting for `aaaaaaa`/);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /api/tickets/${ID}/wake`]);
  assert.ok(await mayCall('POST', `/api/tickets/${ID}/wake`));
  assert.ok(!await mayCall('POST', `/api/tickets/${NUMBER}/wake`));
});

test('wake_when_runners_back posts to its own internal id, which its token may do (#541)', async () => {
  calls.length = 0;
  respond = () => [201, { label: 'citadel-ci' }];
  const r = await tool('wake_when_runners_back', { reason: 'run land again' });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /citadel-ci or citadel-ci-linux/);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /api/tickets/${ID}/wake-runners`]);
  assert.ok(await mayCall('POST', `/api/tickets/${ID}/wake-runners`));
  assert.ok(!await mayCall('POST', `/api/tickets/${NUMBER}/wake-runners`));
});

test('prep_ultra_reviews posts to its own internal id and lists what waits for the Start (#1399)', async () => {
  calls.length = 0;
  respond = () => [200, { for: 'Josh', rows: [{ name: 'Land', state: 'ready', size: { lines: 120, files: 3 }, pr: { number: 7, url: 'https://github.com/o/r/pull/7' } }], refused: [{ index: 1, name: 'Big', error: '9,000 lines in 40 files: over the limit' }] }];
  const r = await tool('prep_ultra_reviews', { areas: [{ name: 'Land', paths: ['tools/land.sh'] }, { name: 'Big', paths: ['src'] }] });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /^Prepped for Josh: .*You cannot start one\.$/m);
  assert.match(r.content[0].text, /^Refused Big: 9,000 lines/m);
  assert.match(r.content[0].text, /^Land: ready, draft PR #7 https:\/\/github\.com\/o\/r\/pull\/7 \(120 lines, 3 files\)$/m);
  await tool('prep_ultra_reviews', {});
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /api/tickets/${ID}/ultrareview/batch`, `GET /api/tickets/${ID}/ultrareview/batch`]);
  assert.ok(await mayCall('POST', `/api/tickets/${ID}/ultrareview/batch`));
  assert.ok(!await mayCall('POST', `/api/tickets/${NUMBER}/ultrareview/batch`));
  assert.ok(!await mayCall('POST', `/api/tickets/${ID}/ultrareview/batch/x/start`), 'the Start stays a person\'s');
});

test('wake_at posts to its own internal id, which its token may do (#722)', async () => {
  calls.length = 0;
  respond = () => [200, { set: { id: 1, when: 'Wed 18 Nov, 09:00 PST' }, wakes: [{ id: 1, when: 'Wed 18 Nov, 09:00 PST', note: 'start it' }] }];
  const r = await tool('wake_at', { at: '2026-11-18 09:00', note: 'start it' });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /Wake set for Wed 18 Nov, 09:00 PST/);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), [`POST /api/tickets/${ID}/wake-at`]);
  assert.ok(await mayCall('POST', `/api/tickets/${ID}/wake-at`));
  assert.ok(!await mayCall('POST', `/api/tickets/${NUMBER}/wake-at`));
});

test('close_self says when it cleared state ready (#480)', async () => {
  respond = () => [202, { cleared: true }];
  const r = await tool('close_self', {});
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /^Dismissed \(state ready cleared\)/);
  respond = () => [202, { cleared: false }];
  assert.doesNotMatch((await tool('close_self', {})).content[0].text, /cleared/);
});

test('set_thread_status says when its state cancelled close_self (#604)', async () => {
  respond = () => [200, { number: 7, title: 'T', status: 'running', state: 'complete', closing: false, close_cancelled: 'its state is complete, which keeps it open for people to read or close' }];
  const r = await tool('set_thread_status', { state: 'complete', note: 'read: the report' });
  assert.match(r.content[0].text, /^Updated\. close_self is cancelled: its state is complete.*stays open after this turn/);
  assert.doesNotMatch(r.content[0].text, /closes after this turn/);
  respond = () => [200, { number: 7, title: 'T', status: 'running', state: 'parked' }];
  assert.doesNotMatch((await tool('set_thread_status', { state: 'parked' })).content[0].text, /cancelled/);
});

test('close_self on a server older than the tool says to wait for the restart', async () => {
  respond = () => [403, { error: 'A thread may only update itself' }];
  const r = await tool('close_self', {});
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /predates close_self.*next restart/);
});
