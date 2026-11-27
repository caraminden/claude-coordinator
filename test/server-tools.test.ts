// Tools the server runs itself for some schemes' minions (src/server-tools.ts, #2179): perigee-godot left the Machines
// page, so who gets it is SERVER_TOOLS, and each turn session gets its own MCP server, spawned here.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { SERVER_TOOLS, ServerToolSessions, serverToolKey, serverToolsFor, type ServerTool } from '../src/server-tools.ts';
import { until } from './wait.ts';
import { fake } from './typed.ts';

test('perigee-godot goes to the minions of Delve and Peek Auras only, under its old name', () => {
  const names = (project: number, kind = 'thread') => serverToolsFor(project, kind).map((t) => t.name);
  assert.deepEqual(names(1), ['perigee-godot'], 'Delve');
  assert.deepEqual(names(3), ['perigee-godot'], 'Peek Auras');
  assert.deepEqual(names(2), [], 'the Citadel scheme');
  assert.deepEqual(names(4), [], 'any other scheme');
  assert.deepEqual(names(1, 'coordinator'), [], "Delve's Taskmaster");
  assert.equal(serverToolKey('perigee-godot'), 'tool-perigee-godot');
});

test("perigee-godot runs the machine agent's old command, through the on-demand bridge, in a scope of its own", () => {
  const argv = SERVER_TOOLS.find((t) => t.name === 'perigee-godot')!.command('/home/x');
  const bridge = argv.findIndex((a) => a.endsWith('/deploy/perigee-godot/godot-on-demand.mjs'));
  assert.ok(bridge > 0 && existsSync(argv[bridge]!), 'the bridge script, from this checkout');
  assert.deepEqual(argv.slice(0, 3), ['systemd-run', '--user', '--scope']);
  assert.ok(argv.includes('--slice=app-godot.slice'), "the slice src/cpu-ledger.ts reads for perigee-godot's line");
  // The agent unit's ExecStart after its `--`, as it was (deploy/perigee-godot/perigee-godot-agent.service before #2179).
  assert.deepEqual(argv.slice(bridge + 1), ['--', '/home/x/.local/bin/uvx', '--from', 'godot-ai==4.3.0', 'godot-ai', 'attach', '--port', '8000', '--ws-port', '9500']);
});

/** An event stream's writes, as a response the sessions write to. */
function stream() {
  const events = new EventEmitter();
  const got: unknown[] = [];
  let ended = false;
  const res: ServerResponse = fake<ServerResponse>({
    writeHead: () => res,
    write: (chunk: string) => {
      const data = /^data: (.*)\n\n$/s.exec(chunk);
      if (data) got.push(JSON.parse(data[1]!));
      return true;
    },
    end: () => ((ended = true), res),
    on: (event: string, fn: () => void) => (events.on(event, fn), res),
  });
  return { res, got, ended: () => ended, close: () => events.emit('close') };
}

// An echo MCP server: answers each request with its own id, and prints what it was given as environment.
const ECHO = `process.stdin.setEncoding('utf8');let b='';process.stdin.on('data',(c)=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{secret:process.env.SECRET_THING??null,home:process.env.HOME}})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`;
const echo: ServerTool = { name: 'echo', schemes: [1], command: () => [process.execPath, '-e', ECHO], notes: '' };
const delve = { id: 42, project_id: 1, kind: 'thread' };

test("a session opens only for a minion of a scheme on the tool's list, never its Taskmaster", () => {
  let ran = 0;
  const sessions = new ServerToolSessions(
    () => (ran++, spawn(process.execPath, ['-e', ''])),
    () => {},
  );
  for (const minion of [
    { id: 9, project_id: 2, kind: 'thread' },
    { id: 10, project_id: 1, kind: 'coordinator' },
  ]) {
    const s = stream();
    assert.equal(sessions.open(echo, minion, '#9 in Citadel', s.res), false, JSON.stringify(minion));
    assert.deepEqual(s.got, [], 'nothing is written, so the route can still answer 403');
  }
  assert.equal(ran, 0);
});

test('a session starts its server on its first message, relays both ways, keeps the server env out, and ends it with the stream', async () => {
  process.env.SECRET_THING = 'hunter2';
  const started: { argv: string[]; exited: boolean }[] = [];
  const sessions = new ServerToolSessions(
    (argv, env) => {
      const child = spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env });
      const run = { argv, exited: false };
      child.on('exit', () => (run.exited = true));
      started.push(run);
      return child;
    },
    () => {},
    '/home/someone',
  );
  try {
    const s = stream();
    assert.equal(sessions.open(echo, delve, '#7 in Delve', s.res), true);
    const id = (s.got[0] as { session: string }).session;
    assert.match(id, /^[0-9a-f]{24}$/);
    assert.equal(started.length, 0, 'nothing runs until the first message');
    assert.equal(sessions.post(id, 43, { jsonrpc: '2.0', id: 1, method: 'initialize' }), false, "another minion's message is refused");
    assert.equal(started.length, 0);
    assert.equal(sessions.post(id, 42, { jsonrpc: '2.0', id: 1, method: 'initialize' }), true);
    await until('the answer to come back', () => s.got.length === 2);
    assert.deepEqual(s.got[1], { message: { jsonrpc: '2.0', id: 1, result: { secret: null, home: '/home/someone' } } });
    assert.equal(started.length, 1);
    s.close();
    assert.ok(s.ended());
    await until('its server to end once the stream closed', () => started[0]!.exited);
    assert.equal(sessions.post(id, 42, { jsonrpc: '2.0', id: 2, method: 'tools/list' }), false, 'a closed session is gone');
  } finally {
    delete process.env.SECRET_THING;
  }
});

test("a server that exits tells the proxy it closed, so it doesn't start it again", async () => {
  const quits: ServerTool = { name: 'quits', schemes: [1], command: () => [process.execPath, '-e', 'process.exit(3)'], notes: '' };
  const sessions = new ServerToolSessions(undefined, () => {});
  const s = stream();
  sessions.open(quits, delve, '#7 in Delve', s.res);
  const id = (s.got[0] as { session: string }).session;
  sessions.post(id, 42, { jsonrpc: '2.0', id: 1, method: 'initialize' });
  await until('the closed word', () => s.ended());
  assert.deepEqual(s.got.at(-1), { closed: true });
  assert.equal(sessions.post(id, 42, { jsonrpc: '2.0', id: 2, method: 'initialize' }), false);
});
