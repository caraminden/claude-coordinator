// The turn's stand-in for a machine's MCP server (src/machine-mcp.ts), against a fake app: what it does when the
// app restarts under it, and when the machine's server goes away with a call in flight.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { REPO, stopProcs, until } from './helpers.ts';

const procs: ChildProcess[] = [];
const servers: ReturnType<typeof createServer>[] = [];
after(async () => {
  await stopProcs(procs);
  for (const s of servers) s.closeAllConnections(), s.close();
});

/**
 * A fake app. Each GET of the session route takes the next answer from `answers` (a status, or 'open' for a
 * stream with a new session id); posts are recorded per session. `stream` is the open session's response.
 */
async function fakeApp(answers: (number | 'open')[]) {
  const posts: { session: string; message: any }[] = [];
  const state = { stream: null as ServerResponse | null, session: '', gets: 0 };
  const srv = createServer((req, res) => {
    if (req.method === 'GET' && req.url!.startsWith('/api/machines/5/session?')) {
      state.gets++;
      const answer = answers.shift() ?? 503;
      if (answer !== 'open') return res.writeHead(answer).end('That machine is offline');
      state.session = String(state.gets).padStart(24, '0');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ session: state.session })}\n\n`);
      state.stream = res;
      return;
    }
    const m = req.url!.match(/^\/api\/machines\/5\/session\/([0-9]{24})$/);
    if (req.method === 'POST' && m) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        posts.push({ session: m[1], message: JSON.parse(body).message });
        res.writeHead(m[1] === state.session ? 202 : 503).end('{}');
      });
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(srv);
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const reply = (message: unknown) => state.stream!.write(`data: ${JSON.stringify({ message })}\n\n`);
  return { base, posts, state, reply };
}

function startProxy(base: string) {
  const proc = spawn(process.execPath, [`${REPO}/src/machine-mcp.ts`, '5', 'box', 'mcp'], {
    env: { ...process.env, COORDINATOR_API: base, COORDINATOR_TOKEN: 'tok' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  procs.push(proc);
  const out: any[] = [];
  let err = '';
  createInterface({ input: proc.stdout! }).on('line', (l) => out.push(JSON.parse(l)));
  proc.stderr!.on('data', (c) => (err += c));
  const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
  let code: number | null | undefined;
  exited.then((c) => (code = c));
  const send = (m: unknown) => proc.stdin!.write(`${JSON.stringify(m)}\n`);
  return { proc, out, send, exited, code: () => code, err: () => err };
}

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } } };

test('after the app restarts, the proxy waits out "machine offline" answers until the agent is back, and replays the handshake', async () => {
  const app = await fakeApp(['open', 503, 503, 'open']);
  const p = startProxy(app.base);
  p.send(init);
  await until('initialize posted', () => app.posts.length === 1);
  app.reply({ jsonrpc: '2.0', id: 1, result: {} });
  await until('initialize answered', () => p.out.length === 1);
  // The app restarts: the stream ends, and until the machine's agent is back the session route answers 503.
  app.state.stream!.end();
  await until('a new session', () => app.state.gets === 4 && app.posts.length === 2, 15_000);
  assert.equal(p.code(), undefined, `the proxy is still running: ${p.err()}`);
  assert.equal(app.posts[1].session, app.state.session);
  assert.equal(app.posts[1].message.method, 'initialize', 'the handshake is replayed to the new session');
  p.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  await until('tools/list posted to the new session', () => app.posts.some((x) => x.message.id === 2 && x.session === app.state.session));
});

test('a first connect that the app answers 503 still fails at once', async () => {
  const app = await fakeApp([503]);
  const p = startProxy(app.base);
  assert.equal(await p.exited, 1);
  assert.match(p.err(), /box is not available \(503\)/);
});

test('a call in flight when the app restarts is answered with an error, and one answered before is not answered twice', async () => {
  const app = await fakeApp(['open', 'open']);
  const p = startProxy(app.base);
  p.send(init);
  await until('initialize posted', () => app.posts.length === 1);
  app.reply({ jsonrpc: '2.0', id: 1, result: {} });
  p.send({ jsonrpc: '2.0', id: 'call-7', method: 'tools/call', params: { name: 'whoami', arguments: {} } });
  p.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} });
  await until('the call posted', () => app.posts.length === 3);
  // The agent stops its servers when the app goes, so this call's reply never comes.
  app.state.stream!.end();
  const answered = await until('the call answered', () => p.out.find((m) => m.id === 'call-7'));
  assert.match(answered.error.message, /^box: /);
  await until('a new session', () => app.state.gets === 2 && app.posts.length === 4);
  assert.deepEqual(p.out.map((m) => m.id), [1, 'call-7'], 'one reply each, none for the notification');
  assert.equal(p.code(), undefined);
});

test('when the machine\'s server exits, the proxy answers the call in flight and exits instead of starting it again', async () => {
  const app = await fakeApp(['open', 'open', 'open']);
  const p = startProxy(app.base);
  p.send(init);
  await until('initialize posted', () => app.posts.length === 1);
  app.reply({ jsonrpc: '2.0', id: 1, result: {} });
  p.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'whoami', arguments: {} } });
  await until('the call posted', () => app.posts.length === 2);
  app.state.stream!.write(`data: ${JSON.stringify({ closed: true })}\n\n`);
  app.state.stream!.end();
  await until('the proxy exits', () => p.code() !== undefined, 10_000);
  assert.equal(p.code(), 1);
  const answered = p.out.find((m) => m.id === 2);
  assert.match(answered?.error?.message ?? '', /^box: .*exited/);
  assert.equal(app.state.gets, 1, 'no new session, so no new copy of the server');
  assert.match(p.err(), /exited/);
});
