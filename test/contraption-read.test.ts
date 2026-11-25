// Sessions read the asking person's contraption data (#295, src/contraption-read.ts). A stand-in Mandate
// serves /app-api/read; a stand-in `claude -p` calls contraption_read's route mid-turn with its thread token,
// as the MCP tool does.
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { verifyIdentity } from '../src/contraptions.ts';
import { bootServer, jsonLines, tempRoot, until, type Booted } from './helpers.ts';
import { mcpOnce } from './mcp-agent.ts';

const tmp = tempRoot('contraption-read-');
const root = tmp.dir;

// Each turn runs the calls in plan.json, then logs what came back.
const fakeClaude = join(root, 'claude-fake');
writeFileSync(
  fakeClaude,
  `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).once('line', async (prompt) => {
  const planFile = ${JSON.stringify(join(root, 'plan.json'))};
  const plan = existsSync(planFile) ? JSON.parse(readFileSync(planFile, 'utf8')) : [];
  const api = readFileSync(${JSON.stringify(join(root, 'api'))}, 'utf8');
  const out = [];
  for (const c of plan) {
    const r = await fetch(api + '/api/contraption-read/' + c.app, {
      method: 'POST', body: JSON.stringify(c.body ?? {}),
      headers: { Authorization: 'Bearer ' + process.env.COORDINATOR_TOKEN, 'Content-Type': 'application/json' },
    });
    out.push({ status: r.status, data: await r.json() });
  }
  appendFileSync(${JSON.stringify(join(root, 'turns.jsonl'))}, JSON.stringify({ prompt: JSON.parse(prompt), out }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`,
);
chmodSync(fakeClaude, 0o755);

const LIST = [{ name: 'today', description: "Today's items", input_schema: { type: 'object', properties: { day: { type: 'string' } } } }];
// The stand-in Mandate's read commands: today answers, big floods, tick isn't read-only, the rest don't exist.
// Only app-api calls are recorded: Citadel also GETs an app's page to read its manifest and icons (server.ts's static-paths
// backfill, 20 s after boot), which would break the counts on a loaded box (#1666, as #1660).
const seen: { method: string; path: string; headers: IncomingHttpHeaders; body: string }[] = [];
const mandate = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url!.startsWith('/apps/mandate/app-api/')) seen.push({ method: req.method!, path: req.url!, headers: req.headers, body });
    const send = (status: number, data: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    if (req.method === 'GET' && req.url === '/apps/mandate/app-api/read') return send(200, LIST);
    if (req.method === 'POST' && req.url === '/apps/mandate/app-api/read/today') return send(200, { items: [{ title: 'Review PR #13' }], asked: JSON.parse(body) });
    if (req.method === 'POST' && req.url === '/apps/mandate/app-api/read/big') return send(200, { blob: 'x'.repeat(200_000) });
    if (req.method === 'POST' && req.url === '/apps/mandate/app-api/read/tick') return send(403, { error: 'not_read_only' });
    send(404, { error: 'unknown_command' });
  });
});
// A contraption with no read commands at all.
const peek: Server = createServer((req, res) => res.writeHead(404).end('Not found'));

let srv: Booted;
let project: { id: number };
let minion: { id: number; number: number };
let mandatePub = '';
let mandateKey = '';
let cara = 0;

const turns = () => jsonLines(join(root, 'turns.jsonl'));
const idle = () =>
  until('the turn to end', async () => {
    const { ticket } = (await srv.call(`/api/tickets/${minion.id}`)).data;
    return ticket.status !== 'running' && ticket.queued === 0;
  });
/** One read command's answer as the fake Claude logged it. */
type ReadOut = { status: number; data: { error: string; truncated: number; answer: string } };
/** Runs `plan` in the turn `start` begins; returns what the calls answered. */
async function turn(plan: object[], start: () => Promise<unknown> = () => srv.call(`/api/tickets/${minion.id}/messages`, { text: 'what is on my list?' })): Promise<ReadOut[]> {
  writeFileSync(join(root, 'plan.json'), JSON.stringify(plan));
  const n = turns().length;
  await start();
  const t = await until('the turn', () => turns().length > n && turns().at(-1));
  writeFileSync(join(root, 'plan.json'), '[]');
  await idle();
  return t.out;
}

before(async () => {
  const port = await tmp.serve(mandate);
  const peekPort = await tmp.serve(peek);
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude } });
  tmp.track(srv.proc);
  writeFileSync(join(root, 'api'), srv.base);
  const m = await srv.call('/api/contraptions', { name: 'mandate', title: 'Mandate', port });
  assert.equal(m.status, 201);
  mandatePub = readFileSync(join(m.data.keys_dir, 'identity.pub'), 'utf8');
  mandateKey = readFileSync(join(m.data.keys_dir, 'contraption.key'), 'utf8');
  assert.equal((await srv.call('/api/contraptions', { name: 'peek', title: 'Peek', port: peekPort })).status, 201);
  assert.equal((await srv.call('/api/contraptions', { name: 'shut', title: 'Shut', port: await tmp.down() })).status, 201);
  cara = (await srv.call('/api/me')).data.id;
  for (const name of ['mandate', 'peek']) assert.equal((await srv.call(`/api/contraptions/${name}/people/${cara}`, { enabled: true }, 'PUT')).status, 200);
  project = (await srv.call('/api/projects', { name: 'P' })).data;
  minion = (await srv.call(`/api/projects/${project.id}/tickets`, { message: 'start' })).data;
  await idle();
});
after(async () => {
  await tmp.teardown();
});

test("a turn answering Cara's typed message lists and runs Mandate's read commands as her, signed for the scheme", async () => {
  const n = seen.length;
  const out = await turn([{ app: 'mandate' }, { app: 'mandate', body: { command: 'today', args: { day: '2026-11-04' } } }]);
  assert.deepEqual(out, [
    { status: 200, data: { status: 200, answer: LIST } },
    { status: 200, data: { status: 200, answer: { items: [{ title: 'Review PR #13' }], asked: { day: '2026-11-04' } } } },
  ]);
  const [list, today] = seen.slice(n);
  assert.deepEqual([list.method, list.path, list.body], ['GET', '/apps/mandate/app-api/read', '']);
  assert.deepEqual([today.method, today.path], ['POST', '/apps/mandate/app-api/read/today']);
  for (const s of [list, today]) {
    const claims = verifyIdentity(s.headers['x-citadel-identity'] as string, mandatePub, 'mandate');
    assert.ok(claims, "signed with Mandate's own key");
    assert.deepEqual([claims.sub, claims.login, claims.from, claims.fromTitle], [cara, 'cara', `scheme-${project.id}`, 'P']);
    assert.equal(s.headers.authorization, undefined);
  }
});

test("the app's refusals pass back; a big answer is cut at 64 KB; an app without reads answers 404", async () => {
  const out = await turn([{ app: 'mandate', body: { command: 'tick', args: { key: 'k' } } }, { app: 'mandate', body: { command: 'nope' } }, { app: 'mandate', body: { command: 'big' } }, { app: 'peek' }]);
  assert.deepEqual(out[0].data, { status: 403, answer: { error: 'not_read_only' } });
  assert.deepEqual(out[1].data, { status: 404, answer: { error: 'unknown_command' } });
  assert.equal(out[2].data.truncated, 64 * 1024);
  assert.equal(out[2].data.answer.length, 64 * 1024);
  assert.deepEqual(out[3].data, { status: 404, answer: 'Not found' });
});

test("Citadel refuses before calling: a bad command or args, an app she hasn't enabled, one that isn't there", async () => {
  const n = seen.length;
  const out = await turn([{ app: 'mandate', body: { command: '../items' } }, { app: 'mandate', body: { command: 'today', args: ['x'] } }, { app: 'mandate', body: { args: { day: 'x' } } }, { app: 'shut' }, { app: 'nothing-here' }, { app: 'Bad%20Name' }]);
  assert.deepEqual(
    out.map((o) => o.status),
    [400, 400, 400, 403, 404, 400],
  );
  assert.equal(out[3].data.error, "Cara doesn't have Shut enabled");
  assert.equal(seen.length, n, 'nothing reached Mandate');
});

test("a turn no one typed for (a [Mandate] post) can't read anyone's data", async () => {
  const n = seen.length;
  const out = await turn([{ app: 'mandate' }], () =>
    fetch(`${srv.base}/api/contraptions/relay/scheme-${project.id}/mandate-hook`, {
      method: 'POST',
      body: JSON.stringify({ key: `${minion.number}.k`, event: 'ticked', at: '2026-11-04T08:00:00Z' }),
      headers: { Authorization: `Bearer ${mandateKey}`, 'X-Citadel-Person': String(cara), 'Content-Type': 'application/json' },
    }),
  );
  assert.equal(out[0].status, 403);
  assert.match(out[0].data.error, /Only a turn answering a person's own typed message may read their data in mandate/);
  assert.equal(seen.length, n);
});

test('the contraption_read tool lists commands, quotes answers, says when an app has no reads or an answer was cut', async () => {
  // A stand-in API: the tool's text is all that's checked here; the route is checked above.
  const answers: Record<string, unknown> = {
    '{}': { status: 200, answer: LIST },
    '{"command":"today"}': { status: 200, answer: { items: [] } },
    '{"command":"big"}': { status: 200, answer: 'xxx', truncated: 65536 },
  };
  const api = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const app = req.url!.split('/').at(-1);
      const r = app === 'peek' ? { status: 404, answer: 'Not found' } : app === 'shut' ? null : answers[body];
      if (!r) return void res.writeHead(403, { 'Content-Type': 'application/json' }).end('{"error":"Cara doesn\'t have Shut enabled"}');
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(r));
    });
  });
  const tool = tempRoot('contraption-read-tool-');
  const port = await tool.serve(api);
  const env = { COORDINATOR_API: `http://127.0.0.1:${port}`, COORDINATOR_TOKEN: 't', COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '1', COORDINATOR_ROLE: 'thread' };
  const call = async (args: object) => (await mcpOnce(env, 'tools/call', { name: 'contraption_read', arguments: args }, tool.track)).content[0].text as string;
  try {
    assert.equal(await call({ app: 'mandate' }), `- today: Today's items\n  input: ${JSON.stringify(LIST[0].input_schema)}`);
    assert.equal(await call({ app: 'mandate', command: 'today' }), 'mandate answered 200: {"items":[]}');
    assert.match(await call({ app: 'mandate', command: 'big' }), /^mandate answered 200: xxx\n\(Cut at 64 KB/);
    assert.equal(await call({ app: 'peek' }), 'peek offers no read commands: it has no /app-api/read.');
    assert.match(await call({ app: 'shut' }), /Cara doesn't have Shut enabled/);
  } finally {
    await tool.teardown();
  }
});
