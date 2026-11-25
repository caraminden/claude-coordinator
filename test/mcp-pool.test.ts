// The shared tool server (#1259, src/mcp-pool.ts): one process serves every turn of a place (a person's container, or
// the host) on one pinned version, reached over Claude Code's HTTP MCP transport. Each turn is known only by its own
// token, which its wrapper registers (src/pool-client.mjs); a turn's machines are reached lazily from a remembered tool list.
import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ensurePool, keepTurn, readPool, registerTurn, type PoolInfo, type PoolSpec } from '../src/pool-client.mjs';
import { REPO, tempRoot, until } from './helpers.ts';

const tmp = tempRoot('mcp-pool-');
let nRoots = 0;
const pools: number[] = [];
after(async () => {
  for (const pid of pools)
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  await tmp.teardown();
});

function root(): string {
  const d = tmp.path(`r${nRoots++}`);
  mkdirSync(d);
  return d;
}

/** A fake app: records each API call's method, path and token; the machine routes behave like test/machine-mcp.test.ts's. */
async function fakeApp() {
  const calls: { method: string; path: string; token: string }[] = [];
  const machine = { gets: 0, posts: [] as any[], stream: null as ServerResponse | null, session: '', lent: undefined as string | undefined };
  const srv = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      calls.push({ method: req.method!, path: req.url!, token });
      if (req.method === 'GET' && req.url!.startsWith('/api/machines/5/session?')) {
        machine.gets++;
        machine.session = String(machine.gets).padStart(24, '0');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ session: machine.session, lent: machine.lent })}\n\n`);
        machine.stream = res;
        return;
      }
      const m = req.url!.match(/^\/api\/machines\/5\/session\/([0-9]{24})$/);
      if (req.method === 'POST' && m) {
        const message = JSON.parse(body).message;
        machine.posts.push(message);
        res.writeHead(202).end('{}');
        // The machine's server answers each request at once.
        if (message.id !== undefined && message.method) {
          const result =
            message.method === 'initialize'
              ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: machine.lent ?? 'box', version: '1' } }
              : message.method === 'tools/list'
                ? { tools: [{ name: machine.lent ? `${machine.lent}_tool` : 'run_task', description: 'Run a task', inputSchema: { type: 'object' } }] }
                : { content: [{ type: 'text', text: `ran ${message.params?.name}` }] };
          setTimeout(() => machine.stream?.write(`data: ${JSON.stringify({ message: { jsonrpc: '2.0', id: message.id, result } })}\n\n`), 5);
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ number: 1, title: 't', status: 'idle' }));
    });
  });
  const port = await tmp.serve(srv);
  return { base: `http://127.0.0.1:${port}`, calls, machine };
}

/** Short TTL and idle times so the version test sees a pool exit; `long` keeps turns registered through slow steps. */
function spec(dir: string, version = 'v1', script = join(REPO, 'src', 'mcp-pool.ts'), long = false): PoolSpec {
  const times = long ? { CITADEL_POOL_IDLE_MS: '60000', CITADEL_POOL_TTL_MS: '60000' } : { CITADEL_POOL_IDLE_MS: '1500', CITADEL_POOL_TTL_MS: '1000' };
  return { dir: join(dir, version), script, node: process.execPath, version, env: { PATH: process.env.PATH ?? '', ...times, CITADEL_POOL_WAIT_MS: '2000' } };
}

async function started(s: PoolSpec): Promise<PoolInfo> {
  const p = await ensurePool(s);
  pools.push(p.pid);
  return p;
}

function turn(api: string, ticket: number, project: number, extra: Record<string, string> = {}) {
  return { env: { COORDINATOR_API: api, COORDINATOR_PROJECT: String(project), COORDINATOR_ROLE: 'thread', COORDINATOR_TICKET: String(ticket), ...extra }, cwd: tmpdir() };
}

/** One MCP request over HTTP, as Claude Code sends it; the answer may come as JSON or as an event stream. */
async function rpc(port: number, token: string, path: string, message: object): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', ...message }),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, text };
  if (!(res.headers.get('content-type') ?? '').includes('event-stream')) return text ? JSON.parse(text) : {};
  const data = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim());
  return JSON.parse(data[data.length - 1]);
}

const toolCall = (id: number, name: string, args: object = {}) => ({ id, method: 'tools/call', params: { name, arguments: args } });

test('each turn acts only as itself: its token picks its own identity, and an unregistered token or a key-less registration is refused', async () => {
  const app = await fakeApp();
  const pool = await started(spec(root(), 'v1', undefined, true));
  await registerTurn(pool, 'token-a', turn(app.base, 11, 1, { COORDINATOR_DEPLOYS: '1' }));
  await registerTurn(pool, 'token-b', turn(app.base, 22, 2));

  await rpc(pool.port, 'token-a', '/mcp', toolCall(1, 'set_thread_status', { note: 'a' }));
  await rpc(pool.port, 'token-b', '/mcp', toolCall(2, 'set_thread_status', { note: 'b' }));
  const patches = app.calls.filter((c) => c.method === 'PATCH');
  assert.deepEqual(
    patches.map((c) => [c.path, c.token]),
    [
      ['/api/tickets/11', 'token-a'],
      ['/api/tickets/22', 'token-b'],
    ],
  );

  // The tool list is each turn's own: only A deploys, so only A is offered start_preview.
  const names = async (t: string) => (await rpc(pool.port, t, '/mcp', { id: 3, method: 'tools/list' })).result.tools.map((x: any) => x.name);
  assert.ok((await names('token-a')).includes('start_preview'));
  assert.ok(!(await names('token-b')).includes('start_preview'));

  // A token nobody registered gets nothing, and reaches no API.
  const before = app.calls.length;
  const stranger = await rpc(pool.port, 'token-c', '/mcp', toolCall(4, 'set_thread_status', { note: 'c' }));
  assert.equal(stranger.status, 401);
  assert.equal(app.calls.length, before);

  // Registering needs the pool's key, which only its own place can read: a turn elsewhere can't plant an identity here.
  const planted = await fetch(`http://127.0.0.1:${pool.port}/register`, { method: 'POST', headers: { Authorization: 'Bearer token-c', 'Content-Type': 'application/json' }, body: JSON.stringify(turn(app.base, 11, 1)) });
  assert.equal(planted.status, 403);
  await registerTurn({ ...pool, key: 'wrong' }, 'token-c', turn(app.base, 11, 1)).then(
    () => assert.fail('registered with a wrong key'),
    () => {},
  );
});

test("a pool killed mid-turn is started again on the same port, and the turn's next tool call works", async () => {
  const app = await fakeApp();
  const s = spec(root(), 'v1', undefined, true);
  const t = turn(app.base, 11, 1);
  const first = await keepTurn(s, 'token-a', t);
  pools.push(first.pid);
  assert.ok((await rpc(first.port, 'token-a', '/mcp', toolCall(1, 'set_thread_status', { note: 'x' }))).result);

  process.kill(first.pid, 'SIGKILL');
  await until('the pool is gone', () => {
    try {
      process.kill(first.pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  // The wrapper's next beat brings it back and registers its turn again.
  // keepTurn starts a fresh pool at once (it doesn't wait on the dead one or a stale lock); it throws at its own 20 s
  // deadline if it hangs, so getting here is the "comes back" proof and no elapsed time is read.
  const second = await keepTurn(s, 'token-a', t);
  pools.push(second.pid);
  assert.notEqual(second.pid, first.pid);
  assert.equal(second.port, first.port);
  const r = await rpc(second.port, 'token-a', '/mcp', toolCall(2, 'set_thread_status', { note: 'y' }));
  assert.ok(r.result && !r.result.isError, JSON.stringify(r));
});

test("a call that arrives before the restarted pool has its turn back waits for the wrapper's registration", async () => {
  const app = await fakeApp();
  const s = spec(root(), 'v1', undefined, true);
  const pool = await started(s);
  const pending = rpc(pool.port, 'token-late', '/mcp', toolCall(1, 'set_thread_status', { note: 'late' }));
  // timing-ok: pacing so the call is in the pool before the registration; too short only weakens this, it can't fail it
  await new Promise((r) => setTimeout(r, 300));
  await registerTurn(pool, 'token-late', turn(app.base, 33, 1));
  const r = await pending;
  assert.ok(r.result, JSON.stringify(r));
  assert.ok(app.calls.some((c) => c.path === '/api/tickets/33' && c.token === 'token-late'));
});

test('two pools started at once for one place and version end as one: the later steps aside for the one on record', async () => {
  const r = root();
  const s = spec(r, 'v1', undefined, true);
  mkdirSync(s.dir, { recursive: true });
  const kids = [0, 1].map(() => tmp.spawn(s.node, [s.script, s.dir, s.version], { env: s.env, stdio: 'ignore' }));
  for (const k of kids) pools.push(k.pid!);
  await until('a pool is on record', () => readPool(s.dir) !== null, 20_000);
  await until('one of them has stepped aside', () => kids.some((k) => k.exitCode !== null), 20_000);
  const live = kids.filter((k) => k.exitCode === null);
  assert.equal(live.length, 1);
  assert.equal(readPool(s.dir)!.pid, live[0].pid);
});

test('two pinned versions run side by side, each serving only its own turns, and one exits once its last turn is gone', async () => {
  const app = await fakeApp();
  const r = root();
  // Two copies of the pool's code, as two deploys pin them: the newer offers a tool the older doesn't know.
  const copies = ['old', 'new'].map((v) => {
    const d = join(r, `pin-${v}`);
    mkdirSync(d);
    cpSync(join(REPO, 'src'), d, { recursive: true, filter: (f) => !f.includes('node_modules') });
    return d;
  });
  const newer = join(copies[1], 'mcp.ts');
  writeFileSync(newer, readFileSync(newer, 'utf8').replace("name: 'close_self',", "name: 'close_self_v2',"));
  const sOld = spec(r, 'old', join(copies[0], 'mcp-pool.ts'));
  const sNew = spec(r, 'new', join(copies[1], 'mcp-pool.ts'));
  // Each turn is kept registered the way its wrapper does, so a slow start of the other pool doesn't idle one out.
  const oldPool = await started(sOld);
  await registerTurn(oldPool, 'token-old', turn(app.base, 1, 1));
  const keepOld = setInterval(() => registerTurn(oldPool, 'token-old', turn(app.base, 1, 1)).catch(() => {}), 300).unref();
  const newPool = await started(sNew);
  await registerTurn(newPool, 'token-new', turn(app.base, 2, 1));
  const keep = setInterval(() => registerTurn(newPool, 'token-new', turn(app.base, 2, 1)).catch(() => {}), 300).unref();
  assert.notEqual(oldPool.port, newPool.port);
  const names = async (p: PoolInfo, t: string) => (await rpc(p.port, t, '/mcp', { id: 1, method: 'tools/list' })).result.tools.map((x: any) => x.name);
  assert.ok((await names(oldPool, 'token-old')).includes('close_self'));
  assert.ok((await names(newPool, 'token-new')).includes('close_self_v2'));
  assert.equal((await rpc(newPool.port, 'token-old', '/mcp', { id: 2, method: 'tools/list' })).status, 401);
  assert.equal((await (await fetch(`http://127.0.0.1:${oldPool.port}/health`)).json()).version, 'old');

  // The old version's last turn ends (its wrapper stops refreshing): that pool exits; the new one keeps its turn.
  clearInterval(keepOld);
  try {
    await until(
      'the old pool exits',
      () => {
        try {
          process.kill(oldPool.pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      10_000,
    );
    assert.equal(readPool(sOld.dir), null);
    process.kill(newPool.pid, 0);
  } finally {
    clearInterval(keep);
  }
});

test("machine tools are lazy: a remembered tool list answers the turn's start, and the machine is only opened on its first call", async () => {
  const app = await fakeApp();
  const r = root();
  const pool = await started(spec(r, 'v1', undefined, true));
  await registerTurn(pool, 'token-a', turn(app.base, 11, 1));
  const path = '/machine/5/mcp?name=box';
  const cache = join(r, 'machine-tools', '5-mcp.json');

  // No remembered list yet: the first turn learns the tools from the machine, and the list is kept.
  assert.equal((await rpc(pool.port, 'token-a', path, { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } })).result.serverInfo.name, 'box');
  const listed = await rpc(pool.port, 'token-a', path, { id: 2, method: 'tools/list' });
  assert.deepEqual(
    listed.result.tools.map((t: any) => t.name),
    ['run_task'],
  );
  assert.equal(app.machine.gets, 1);
  await until('the tool list is remembered', () => existsSync(cache));

  // A later turn starts without opening the machine at all.
  await registerTurn(pool, 'token-b', turn(app.base, 22, 1));
  const gets = app.machine.gets;
  const init = await rpc(pool.port, 'token-b', path, { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
  assert.equal(init.result.serverInfo.name, 'box');
  assert.deepEqual(
    (await rpc(pool.port, 'token-b', path, { id: 2, method: 'tools/list' })).result.tools.map((t: any) => t.name),
    ['run_task'],
  );
  assert.equal(app.machine.gets, gets, 'the machine was opened for a turn that has not used it');

  // Its first call opens the machine, replays the handshake, and gets the machine's answer, as the turn's own token.
  const ran = await rpc(pool.port, 'token-b', path, toolCall(3, 'run_task', { task: 'build' }));
  assert.equal(ran.result.content[0].text, 'ran run_task');
  assert.equal(app.machine.gets, gets + 1);
  assert.equal(app.calls.filter((c) => c.path.startsWith('/api/machines/5/session?')).at(-1)!.token, 'token-b');
  assert.ok(app.machine.posts.some((m) => m.method === 'initialize'));

  // A notification on the open link (Claude Code cancelling a call) reaches the machine, and the pool lives on.
  await rpc(pool.port, 'token-b', path, { method: 'notifications/cancelled', params: { requestId: 3 } });
  await until('the machine got the notification', () => app.machine.posts.some((m) => m.method === 'notifications/cancelled'));
  process.kill(pool.pid, 0);
  assert.equal((await rpc(pool.port, 'token-b', path, toolCall(4, 'run_task', { task: 'again' }))).result.content[0].text, 'ran run_task');
});

test("a turn that starts after another MCP server is ticked gets the new one's tools, not the remembered ones (2MA6)", async () => {
  const app = await fakeApp();
  const r = root();
  const pool = await started(spec(r, 'v1', undefined, true));
  // A turn's start, as Claude Code does it, on the server ticked when its config was written.
  const start = async (token: string, ticked: string) => {
    await registerTurn(pool, token, turn(app.base, 11, 1));
    const path = `/machine/5/mcp?name=box&lent=${ticked}`;
    const init = await rpc(pool.port, token, path, { id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } });
    const list = await rpc(pool.port, token, path, { id: 2, method: 'tools/list' });
    return { server: init.result.serverInfo.name, tools: list.result.tools.map((t: { name: string }) => t.name), call: () => rpc(pool.port, token, path, toolCall(3, 'x')) };
  };
  app.machine.lent = 'blender';
  assert.deepEqual((await start('token-a', 'blender')).tools, ['blender_tool']);
  const opened = app.machine.gets;
  const b = await start('token-b', 'blender');
  assert.equal(app.machine.gets, opened, 'the remembered list answers a turn on the same server');

  app.machine.lent = 'godot-ai';
  const c = await start('token-c', 'godot-ai');
  assert.equal(c.server, 'godot-ai');
  assert.deepEqual(c.tools, ['godot-ai_tool']);

  // A turn from before the swap opens its session only now, so godot answers it: that list isn't kept as blender's.
  await b.call();
  app.machine.lent = 'blender';
  assert.deepEqual((await start('token-d', 'blender')).tools, ['blender_tool']);
});

test("a turn whose pool won't start runs with its own helpers instead (the stdio config)", async () => {
  const r = root();
  const dir = join(r, 'turn');
  mkdirSync(dir);
  // A stand-in claude that writes down the arguments and port it was started with.
  const fake = join(r, 'fake-claude.mjs');
  writeFileSync(fake, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(r, 'argv.json'))}, JSON.stringify({ argv: process.argv.slice(2), port: process.env.CITADEL_POOL_PORT ?? null })); console.log(JSON.stringify({ type: 'result' }));`);
  writeFileSync(join(dir, 'prompt.jsonl'), '{}\n');
  const broken = { dir: join(r, 'pool', 'v1'), script: join(r, 'no-such-pool.ts'), node: process.execPath, version: 'v1', env: { PATH: process.env.PATH ?? '' } };
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ command: process.execPath, args: [fake, '--mcp-config', join(dir, 'mcp.json'), '-p'], cwd: r, env: { PATH: process.env.PATH, COORDINATOR_TOKEN: 'tok' }, pool: broken }));
  const w = tmp.spawn(process.execPath, [join(REPO, 'src', 'turn-wrapper.mjs'), dir], { stdio: 'ignore' });
  await until('the turn ended', () => existsSync(join(dir, 'exit.json')), 45_000); // the wrapper gives the pool 20 s to start
  w.kill();
  const seen = JSON.parse(readFileSync(join(r, 'argv.json'), 'utf8'));
  assert.deepEqual(seen.argv, ['--mcp-config', join(dir, 'mcp-stdio.json'), '-p']);
  assert.equal(seen.port, null);
});

test('a turn whose pool starts gets its port, and its wrapper registers it', async () => {
  const app = await fakeApp();
  const r = root();
  const dir = join(r, 'turn');
  mkdirSync(dir);
  const fake = join(r, 'fake-claude.mjs');
  // The stand-in calls a tool through the pool the way Claude would, then ends the turn.
  writeFileSync(
    fake,
    `
    const port = process.env.CITADEL_POOL_PORT;
    const res = await fetch('http://127.0.0.1:' + port + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.COORDINATOR_TOKEN, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'set_thread_status', arguments: { note: 'w' } } }) });
    (await import('node:fs')).writeFileSync(${JSON.stringify(join(r, 'out.json'))}, JSON.stringify({ port, status: res.status, argv: process.argv.slice(2) }));
    console.log(JSON.stringify({ type: 'result' }));`,
  );
  writeFileSync(join(dir, 'prompt.jsonl'), '{}\n');
  const s = spec(r);
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ command: process.execPath, args: [fake, '--mcp-config', join(dir, 'mcp.json')], cwd: r, env: { ...turn(app.base, 44, 1).env, PATH: process.env.PATH, COORDINATOR_TOKEN: 'tok-w' }, pool: s }));
  const w = tmp.spawn(process.execPath, [join(REPO, 'src', 'turn-wrapper.mjs'), dir], { stdio: 'ignore' });
  await until('the turn ended', () => existsSync(join(dir, 'exit.json')), 20_000);
  w.kill();
  const pool = readPool(s.dir);
  if (pool) pools.push(pool.pid);
  const out = JSON.parse(readFileSync(join(r, 'out.json'), 'utf8'));
  assert.equal(out.status, 200);
  assert.equal(Number(out.port), pool?.port);
  assert.deepEqual(out.argv, ['--mcp-config', join(dir, 'mcp.json')]);
  assert.ok(app.calls.some((c) => c.path === '/api/tickets/44' && c.token === 'tok-w'));
});

// #1272: the runner once left the pool out of spec.json, and Claude Code ran the turn with no Citadel tools at all.
// A pooled config naming a variable the turn's env lacks gives way to the stdio config beside it, when there is one.
/** Run the wrapper on a turn whose `mcp.json` is `mcp` (none if null), with `mcp-stdio.json` beside it if `stdio`; returns the stand-in claude's argv and the turn's stderr. */
async function wrapperWith(mcp: object | null, stdio: boolean, env: Record<string, string> = {}) {
  const r = root();
  const dir = join(r, 'turn');
  mkdirSync(dir);
  const fake = join(r, 'fake-claude.mjs');
  writeFileSync(fake, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(r, 'argv.json'))}, JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({ type: 'result' }));`);
  writeFileSync(join(dir, 'prompt.jsonl'), '{}\n');
  if (mcp) writeFileSync(join(dir, 'mcp.json'), JSON.stringify(mcp));
  if (stdio) writeFileSync(join(dir, 'mcp-stdio.json'), JSON.stringify({ mcpServers: { thread: { type: 'stdio', command: 'node', args: ['mcp.ts'] } } }));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ command: process.execPath, args: [fake, '--mcp-config', join(dir, 'mcp.json'), '-p'], cwd: r, env: { PATH: process.env.PATH, ...env } }));
  const w = tmp.spawn(process.execPath, [join(REPO, 'src', 'turn-wrapper.mjs'), dir], { stdio: 'ignore' });
  await until('the turn ended', () => existsSync(join(dir, 'exit.json')), 20_000);
  w.kill();
  assert.equal(JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')).code, 0);
  return { argv: JSON.parse(readFileSync(join(r, 'argv.json'), 'utf8')), stderr: readFileSync(join(dir, 'stderr.log'), 'utf8'), dir };
}
const pooledConfig = { mcpServers: { thread: { type: 'http', url: 'http://127.0.0.1:${CITADEL_POOL_PORT}/mcp', headers: { Authorization: 'Bearer ${COORDINATOR_TOKEN}' } } } };

test('a turn whose mcp.json names a variable its env lacks runs its own helpers, and says so', async () => {
  const { argv, stderr, dir } = await wrapperWith(pooledConfig, true, { COORDINATOR_TOKEN: 'tok' });
  assert.deepEqual(argv, ['--mcp-config', join(dir, 'mcp-stdio.json'), '-p']);
  assert.match(stderr, /names CITADEL_POOL_PORT, which its env lacks; it runs its own helpers/);
});

test('an unreadable mcp.json with the stdio config beside it runs the stdio config rather than failing the turn', async () => {
  const { argv, stderr, dir } = await wrapperWith(null, true);
  assert.deepEqual(argv, ['--mcp-config', join(dir, 'mcp-stdio.json'), '-p']);
  assert.match(stderr, /can't be read .*; it runs its own helpers/);
});

test('a filled-in mcp.json, or one with nothing better beside it, is passed to Claude as it is', async () => {
  const filled = await wrapperWith(pooledConfig, true, { COORDINATOR_TOKEN: 'tok', CITADEL_POOL_PORT: '1234' });
  assert.deepEqual(filled.argv, ['--mcp-config', join(filled.dir, 'mcp.json'), '-p']);
  assert.equal(filled.stderr, '');
  const defaulted = await wrapperWith({ mcpServers: { x: { type: 'http', url: 'http://${HOST:-127.0.0.1:1}/mcp' } } }, true);
  assert.deepEqual(defaulted.argv, ['--mcp-config', join(defaulted.dir, 'mcp.json'), '-p']);
  const alone = await wrapperWith(pooledConfig, false);
  assert.deepEqual(alone.argv, ['--mcp-config', join(alone.dir, 'mcp.json'), '-p']);
});
