import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { landArgs } from '../src/land.ts';
import { agentToken, bootServer, REPO, until } from './helpers.ts';

// The land tool (src/land.ts) for a container turn: the server runs the minion's tools/land.sh on the
// host. A stand-in land.sh prints the token it was given.
const srv = await bootServer();
after(() => srv.stop());

test("landing keeps the calling turn's token: land.sh gets it, and the turn's tools stay logged in (#225)", async () => {
  const store = new Store(join(srv.data, 'coordinator.db'));
  const project = store.createProject('P', null);
  // The scheme this server runs, so the route lets it land.
  store.setProjectRepoDir(project.id, REPO);
  const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(srv.root, 'worktree');
  mkdirSync(join(cwd, 'tools'), { recursive: true });
  writeFileSync(join(cwd, 'tools', 'land.sh'), 'echo "token:$COORDINATOR_TOKEN"\n');
  store.setTicketDir(minion.id, cwd, null);
  const token = agentToken(srv.data, minion.id);
  const call = (method: string) => fetch(`${srv.base}/api/tickets/${minion.id}/land`, { method, headers: { Authorization: `Bearer ${token}` } });

  assert.equal((await call('POST')).status, 202);
  const run = await until('land.sh ends', async () => {
    const res = await call('GET');
    assert.equal(res.status, 200, 'the turn is still logged in');
    const body = await res.json();
    return body.code === null ? null : body;
  });
  assert.equal(run.code, 0, run.output);
  assert.equal(run.output.trim(), `token:${token}`);
});

// Theory of Crafting, 2026-11-11: only this server's own scheme had the tool, so another scheme's container turn ran
// land.sh in the container, where it can't see the host landings in line.
test("any scheme's minion lands through the tool when its worktree has tools/land.sh, and is told when it has none", async () => {
  const store = new Store(join(srv.data, 'coordinator.db'));
  const project = store.createProject('Other', null);
  store.setProjectRepoDir(project.id, join(srv.root, 'other-repo'));
  const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(srv.root, 'other-worktree');
  mkdirSync(join(cwd, 'tools'), { recursive: true });
  store.setTicketDir(minion.id, cwd, null);
  const token = agentToken(srv.data, minion.id);
  const call = (method: string) => fetch(`${srv.base}/api/tickets/${minion.id}/land`, { method, headers: { Authorization: `Bearer ${token}` } });

  const none = await call('POST');
  assert.equal(none.status, 404);
  assert.match((await none.json()).error, /no tools\/land\.sh/);
  writeFileSync(join(cwd, 'tools', 'land.sh'), 'echo landed-other\n');
  assert.equal((await call('POST')).status, 202);
  const run = await until('land.sh ends', async () => { const body = await (await call('GET')).json(); return body.code === null ? null : body; });
  assert.equal(run.output.trim(), 'landed-other');
});

// A container turn couldn't land the fix for a commit whose deploy was rolled back: land.sh wants LAND_FIX=1 for one
// that changes none of its files, and the tool had no way to pass it (#553's handoff).
test('the land tool passes LAND_FIX=1 only when asked to with fix: true, and LAND_URGENT=1 with outage: true', async () => {
  const store = new Store(join(srv.data, 'coordinator.db'));
  const project = store.createProject('Fix', null);
  store.setProjectRepoDir(project.id, join(srv.root, 'fix-repo'));
  const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(srv.root, 'fix-worktree');
  mkdirSync(join(cwd, 'tools'), { recursive: true });
  writeFileSync(join(cwd, 'tools', 'land.sh'), 'echo "fix:${LAND_FIX:-none}${LAND_URGENT:+ urgent}"\n');
  store.setTicketDir(minion.id, cwd, null);
  const token = agentToken(srv.data, minion.id);
  const auth = { Authorization: `Bearer ${token}` };
  const land = async (body?: object) => {
    const post = await fetch(`${srv.base}/api/tickets/${minion.id}/land`, { method: 'POST', headers: body ? { ...auth, 'Content-Type': 'application/json' } : auth, body: body ? JSON.stringify(body) : undefined });
    assert.equal(post.status, 202);
    return (await until('land.sh ends', async () => { const b = await (await fetch(`${srv.base}/api/tickets/${minion.id}/land`, { headers: auth })).json(); return b.code === null ? null : b; })).output.trim();
  };
  assert.equal(await land(), 'fix:none');
  assert.equal(await land({}), 'fix:none');
  assert.equal(await land({ fix: 'yes' }), 'fix:none', 'only true');
  assert.equal(await land({ fix: true }), 'fix:1');
  assert.equal(await land({ outage: true }), 'fix:none urgent', 'outage is its own mark: no LAND_FIX, so no critic skip');
});

test("a container turn of any scheme is offered the land tool; a host turn is not", async () => {
  const tools = (extra: Record<string, string>) => new Promise<string[]>((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
      env: { ...process.env, MACHINES_URL: undefined, COORDINATOR_API: 'http://127.0.0.1:9', COORDINATOR_TOKEN: '7.sig', COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '7', COORDINATOR_ROLE: 'thread', COORDINATOR_DEPLOYS: undefined, COORDINATOR_CONTAINER: undefined, ...extra },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    child.once('exit', (code) => reject(new Error(`mcp.ts ended (${code}) before it listed its tools`)));
    createInterface({ input: child.stdout! }).once('line', (l) => { child.kill(); resolve(JSON.parse(l).result.tools.map((t: any) => t.name)); });
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  });
  assert.ok((await tools({ COORDINATOR_CONTAINER: '1' })).includes('land'));
  assert.ok(!(await tools({})).includes('land'));
});

test('the land tool says the server restarted when the landing it started is no longer known, rather than failing (#468 S06-6)', async () => {
  // A server that started the landing, then restarted (a deploy) and forgot it before the next poll.
  const api = createServer((req, res) => {
    const send = (status: number, data: object) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    if (req.method === 'POST') return send(202, { output: '', code: null });
    send(404, { error: 'No landing has started for this minion' });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, COORDINATOR_API: `http://127.0.0.1:${(api.address() as any).port}`, COORDINATOR_TOKEN: '7.sig',
      COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '7', COORDINATOR_ROLE: 'thread', COORDINATOR_DEPLOYS: '1', COORDINATOR_CONTAINER: '1',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const reply = new Promise<any>((resolve) => createInterface({ input: child.stdout! }).once('line', (l) => resolve(JSON.parse(l))));
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'land', arguments: {} } }) + '\n');
    const { result } = await reply;
    assert.equal(result.isError, undefined, result.content[0].text);
    assert.match(result.content[0].text, /restarted/);
    assert.match(result.content[0].text, /git log main/);
  } finally {
    child.kill();
    api.close();
  }
});

// #508: the server runs the landing in a unit of its own. A restart (the deploy of another land, say)
// neither waits for it nor kills it, and when its deploy reports, the new server takes the report from
// the turn's token and the land tool still gets land.sh's result.
test("a landing outlives the server that started it: its deploy report reaches the next server, which reports land.sh's result", async () => {
  const root = mkdtempSync(join(tmpdir(), 'land-restart-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  // A fake systemd-run: starts the command after its options in a session of its own, as a unit outlives the server.
  writeFileSync(join(bin, 'systemd-run'), '#!/usr/bin/env bash\nwhile [ "${1#-}" != "$1" ]; do [ "$1" = -p ] && shift; shift; done\nsetsid "$@" </dev/null >/dev/null 2>&1 &\n', { mode: 0o755 });
  const env = { TURN_UNITS: '1', PATH: `${bin}:${process.env.PATH}` };
  let first: Awaited<ReturnType<typeof bootServer>> | null = await bootServer({ root, env });
  let next: Awaited<ReturnType<typeof bootServer>> | null = null;
  const go = join(root, 'go');
  try {
    const store = new Store(join(first.data, 'coordinator.db'));
    const project = store.createProject('P', null);
    store.setProjectRepoDir(project.id, REPO);
    const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
    const cwd = join(root, 'worktree');
    mkdirSync(join(cwd, 'tools'), { recursive: true });
    // As deploy.sh's report_me does, once the server has restarted under it.
    writeFileSync(join(cwd, 'tools', 'land.sh'), `echo started
for i in $(seq 600); do [ -e ${JSON.stringify(go)} ] && break; sleep 0.05; done
curl -sS -o /dev/null -w 'report: %{http_code}\\n' -X POST "$COORDINATOR_API/api/tickets/$COORDINATOR_TICKET/deploy" -H "Authorization: Bearer $COORDINATOR_TOKEN" -H 'Content-Type: application/json' -d '{"ok":true,"text":"Deployed abc1234: live now"}'
`);
    store.setTicketDir(minion.id, cwd, null);
    const token = agentToken(first.data, minion.id);
    const call = (base: string, method: string) => fetch(`${base}/api/tickets/${minion.id}/land`, { method, headers: { Authorization: `Bearer ${token}` } });

    assert.equal((await call(first.base, 'POST')).status, 202);
    await until('land.sh starts', async () => ((await (await call(first.base, 'GET')).json()).output as string).includes('started'));
    assert.equal((await (await fetch(`${first.base}/api/health`)).json()).interruptible, 0, "a restart doesn't wait for the landing");
    // The restart: a new server on the same port and data.
    const port = first.port;
    await first.stop({ keepTurns: true });
    first = null;
    next = await bootServer({ root, env: { ...env, PORT: String(port) } });
    const running = await (await call(next.base, 'GET')).json();
    assert.equal(running.code, null, 'the new server finds it still running');
    writeFileSync(go, '');
    const done = await until('land.sh ends', async () => { const r = await (await call(next!.base, 'GET')).json(); return r.code === null ? null : r; });
    assert.equal(done.code, 0, done.output);
    assert.match(done.output, /report: 201/, 'the new server took the report from the turn\'s token');
    assert.ok(store.listEvents(minion.id).some((e) => String(e.data).includes('Deployed abc1234: live now')), "the report is in the minion's chat");
  } finally {
    writeFileSync(go, '');
    await first?.stop();
    await next?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

// #597: a container turn's build minion or feeder couldn't pass land.sh's build forms through the tool. The server
// turns { into, files, full, build } into land.sh's arguments, and only into the shapes land.sh accepts.
test('landArgs gives land.sh only the shapes it accepts, files as paths inside the worktree', () => {
  const root = mkdtempSync(join(tmpdir(), 'land-args-'));
  const cwd = join(root, 'wt');
  mkdirSync(join(cwd, 'test', 'sub'), { recursive: true });
  writeFileSync(join(cwd, 'test', 'a.test.ts'), '');
  writeFileSync(join(cwd, 'test', 'sub', 'b.test.ts'), '');
  writeFileSync(join(cwd, '-x.test.ts'), '');
  writeFileSync(join(root, 'outside.test.ts'), '');
  symlinkSync(join(root, 'outside.test.ts'), join(cwd, 'test', 'link.test.ts'));
  try {
    assert.deepEqual(landArgs({}, cwd), [], 'no arguments: a plain land, as before');
    assert.deepEqual(landArgs({ fix: true } as any, cwd), []);
    assert.deepEqual(landArgs({ build: false, full: false, files: [], into: null }, cwd), []);
    assert.deepEqual(landArgs({ build: true }, cwd), ['--build']);
    assert.deepEqual(landArgs({ into: 'build/7', full: true }, cwd), ['--into', 'build/7', '--full']);
    assert.deepEqual(landArgs({ into: 'build/12', files: ['test/a.test.ts', './test/sub/b.test.ts', join(cwd, 'test', 'a.test.ts')] }, cwd),
      ['--into', 'build/12', 'test/a.test.ts', 'test/sub/b.test.ts', 'test/a.test.ts'], 'in order, relative to the worktree');
    assert.deepEqual(landArgs({ into: 'build/7' }, cwd), ['--into', 'build/7'], 'no files: land.sh lets only a docs-only change through');
    assert.deepEqual(landArgs({ into: 'build/7', files: ['-x.test.ts'] }, cwd), ['--into', 'build/7', './-x.test.ts'], 'never read as an option');

    const refused = (body: object, re: RegExp) => assert.throws(() => landArgs(body as any, cwd), re, JSON.stringify(body));
    for (const into of ['build/0', 'build/07', 'build/1234567', 'build/7; rm -rf ~', 'main', '--full', 'build/x', ' build/7', 'build/7\n']) refused({ into }, /into must be a build branch/);
    refused({ into: 7 }, /into must be/);
    refused({ into: '' }, /into must be a build branch/);
    refused({ into: '', files: ['test/a.test.ts'] }, /into must be a build branch/);
    refused({ build: true, into: '' }, /build takes nothing more/);
    refused({ into: 'build/7', files: ['../outside.test.ts'] }, /not a file in your worktree/);
    refused({ into: 'build/7', files: [join(root, 'outside.test.ts')] }, /not a file in your worktree/);
    refused({ into: 'build/7', files: ['test/link.test.ts'] }, /not a file in your worktree/);
    refused({ into: 'build/7', files: ['test/missing.test.ts'] }, /not a file in your worktree/);
    refused({ into: 'build/7', files: ['test'] }, /not a file in your worktree/);
    refused({ into: 'build/7', files: [''] }, /not a file in your worktree/);
    refused({ into: 'build/7', files: 'test/a.test.ts' }, /files must be a list/);
    refused({ into: 'build/7', files: [1] }, /files must be a list/);
    refused({ into: 'build/7', full: true, files: ['test/a.test.ts'] }, /name no files/);
    refused({ into: 'build/7', full: 'yes' }, /full must be/);
    refused({ files: ['test/a.test.ts'] }, /go with into/);
    refused({ full: true }, /go with into.*drop full and files/);
    refused({ build: true, into: 'build/7' }, /build takes nothing more/);
    refused({ build: true, files: ['test/a.test.ts'] }, /build takes nothing more/);
    refused({ build: 'true' }, /build must be/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the land route hands land.sh those arguments, and refuses a bad call without starting it', async () => {
  const store = new Store(join(srv.data, 'coordinator.db'));
  const project = store.createProject('Args', null);
  store.setProjectRepoDir(project.id, join(srv.root, 'args-repo'));
  const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(srv.root, 'args-worktree');
  mkdirSync(join(cwd, 'tools'), { recursive: true });
  mkdirSync(join(cwd, 'test'));
  writeFileSync(join(cwd, 'test', 'a.test.ts'), '');
  writeFileSync(join(cwd, 'test', 'b.test.ts'), '');
  writeFileSync(join(cwd, 'tools', 'land.sh'), 'echo "n=$#"; for a in "$@"; do echo "[$a]"; done\n');
  store.setTicketDir(minion.id, cwd, null);
  const auth = { Authorization: `Bearer ${agentToken(srv.data, minion.id)}` };
  const post = (body?: object) => fetch(`${srv.base}/api/tickets/${minion.id}/land`, { method: 'POST', headers: body ? { ...auth, 'Content-Type': 'application/json' } : auth, body: body ? JSON.stringify(body) : undefined });
  const land = async (body?: object) => {
    const res = await post(body);
    assert.equal(res.status, 202);
    return (await until('land.sh ends', async () => { const b = await (await fetch(`${srv.base}/api/tickets/${minion.id}/land`, { headers: auth })).json(); return b.code === null ? null : b; })).output.trim();
  };
  assert.equal(await land(), 'n=0', 'no body: land.sh as before');
  assert.equal(await land({}), 'n=0');
  assert.equal(await land({ into: 'build/3', files: ['test/b.test.ts', 'test/a.test.ts'] }), 'n=4\n[--into]\n[build/3]\n[test/b.test.ts]\n[test/a.test.ts]');
  assert.equal(await land({ into: 'build/3', full: true }), 'n=3\n[--into]\n[build/3]\n[--full]');
  assert.equal(await land({ build: true }), 'n=1\n[--build]');

  for (const body of [{ into: '' }, { into: 'build/3; touch pwned' }, { into: 'build/3', files: ['../args-repo/x.test.ts'] }, { full: true }]) {
    const res = await post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const last = await (await fetch(`${srv.base}/api/tickets/${minion.id}/land`, { headers: auth })).json();
  assert.equal(last.output.trim(), 'n=1\n[--build]', 'a refused call started nothing');
});

test('the land tool sends into, files, full and build on to the server, and nothing for a plain call', async () => {
  const bodies: any[] = [];
  const api = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.method === 'POST') bodies.push(JSON.parse(raw || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ output: 'ok', code: 0 }));
    });
  });
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [join(REPO, 'src', 'mcp.ts')], {
    env: {
      ...process.env, MACHINES_URL: undefined, COORDINATOR_API: `http://127.0.0.1:${(api.address() as any).port}`, COORDINATOR_TOKEN: '7.sig',
      COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '7', COORDINATOR_ROLE: 'thread', COORDINATOR_DEPLOYS: '1', COORDINATOR_CONTAINER: '1',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  try {
    const replies = createInterface({ input: child.stdout! })[Symbol.asyncIterator]();
    let id = 0;
    const land = async (args: object) => {
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'land', arguments: args } }) + '\n');
      const { result } = JSON.parse((await replies.next()).value);
      assert.match(result.content[0].text, /exited 0/);
    };
    await land({});
    await land({ fix: false });
    await land({ into: 'build/3', files: ['test/a.test.ts', 'test/b.test.ts'] });
    await land({ into: 'build/3', full: true });
    await land({ build: true, fix: true });
    assert.deepEqual(bodies, [{}, {}, { into: 'build/3', files: ['test/a.test.ts', 'test/b.test.ts'] }, { into: 'build/3', full: true }, { build: true, fix: true }]);
  } finally {
    child.kill();
    api.close();
  }
});
