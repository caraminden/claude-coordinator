// The warm handover (#1170, src/handover.ts): a deploy boots the new server beside the old one, then swaps them.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, get, type IncomingMessage } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { COLD, handOver, handoverState, standby } from '../src/handover.ts';
import { SCHEMA_VERSION } from '../src/db.ts';
import { STOP_MARK } from '../src/sd-watchdog.ts';
import { bootServer, PASSWORD, SECRET, tempRoot, TEST_ZONE, until } from './helpers.ts';
import { json } from './typed.ts';

const REPO = join(import.meta.dirname, '..');
const tmp = tempRoot('handover-');
after(() => tmp.teardown());

/** A `systemd-notify` that writes its arguments to a file, on a PATH for children. */
function fakeNotify(dir: string): { PATH: string; NOTIFY_SOCKET: string; calls: () => string[] } {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const out = join(dir, 'notify.log');
  writeFileSync(join(bin, 'systemd-notify'), `#!/bin/sh\necho "$@" >> '${out}'\n`);
  chmodSync(join(bin, 'systemd-notify'), 0o755);
  return { PATH: `${bin}:${process.env.PATH}`, NOTIFY_SOCKET: join(dir, 'notify.sock'), calls: () => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n') : []) };
}

/** A listening socket's fd, as systemd would hold it. */
async function heldSocket(): Promise<{ server: NetServer; fd: number; port: number }> {
  const server = createNetServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, fd: (server as any)._handle.fd, port: (server.address() as { port: number }).port };
}

// A copy that does what the server's copy does (server.ts): standby, then live once "listening".
const COPY = join(tmp.dir, 'copy.mjs');
writeFileSync(
  COPY,
  `import { standby } from ${JSON.stringify(join(REPO, 'src/handover.ts'))};
if (process.env.COPY_MODE === 'exit') process.exit(1);
if (process.env.COPY_MODE === 'hang') setInterval(() => {}, 1000);
else { const h = await standby(Number(process.env.COPY_SCHEMA)); console.log('copy got go'); if (process.env.COPY_MODE === 'die') process.exit(3); h.live(); }
`,
);

// The old server's side in a process of its own, for the endings where it exits.
const OLD = join(tmp.dir, 'old.mjs');
writeFileSync(
  OLD,
  `import { createServer } from 'node:net';
import { handOver } from ${JSON.stringify(join(REPO, 'src/handover.ts'))};
const held = createServer();
held.listen(0, '127.0.0.1', () => handOver(
  { quiesce: () => console.log('quiesce'), finish: () => console.log('finish') },
  { schema: 7, onSocket: true, env: process.env, argv: [${JSON.stringify(COPY)}], socketFd: held._handle.fd },
));
`,
);

function oldSide(env: Record<string, string>, opts: { readyMs?: number; onSocket?: boolean } = {}) {
  const lines: string[] = [];
  const order: string[] = [];
  return {
    lines,
    order,
    run: (fd: number) => handOver({ quiesce: () => order.push('quiesce'), finish: () => order.push('finish') }, { schema: 7, onSocket: opts.onSocket ?? true, env: { ...process.env, ...env }, argv: [COPY], socketFd: fd, readyMs: opts.readyMs, log: (l) => lines.push(l) }),
  };
}

test('a copy with another schema backs out and the old server keeps serving', async () => {
  const held = await heldSocket();
  const side = oldSide({ COPY_SCHEMA: '8' });
  side.run(held.fd);
  held.server.close();
  await until('it refuses', () => handoverState().startsWith('refused'));
  assert.match(handoverState(), /^refused \d+ the new code changes the database schema$/);
  assert.deepEqual(side.order, [], 'nothing was let go of');
});

test('a copy that exits or hangs before ready is refused, with the reason on health', async () => {
  const held = await heldSocket();
  const exits = oldSide({ COPY_MODE: 'exit' });
  exits.run(held.fd);
  await until('it refuses the exit', () => handoverState().includes('exited'));
  assert.match(handoverState(), /the new server exited \(1\) before it was ready/);

  const hangs = oldSide({ COPY_MODE: 'hang' }, { readyMs: 200 });
  hangs.run(held.fd);
  held.server.close();
  await until('it refuses the hang', () => handoverState().includes("wasn't ready"));
  assert.deepEqual([...exits.order, ...hangs.order], []);
});

test("a server that isn't on systemd's socket refuses at once", () => {
  oldSide({}, { onSocket: false }).run(0);
  assert.match(handoverState(), /isn't on systemd's socket/);
});

// Last of the in-process ones: a handover that went live leaves this module busy, as the old server exits then.
test('the old server lets go once the copy is ready, and finishes once it is live', async () => {
  const notify = fakeNotify(join(tmp.dir, 'taken'));
  const held = await heldSocket();
  const side = oldSide({ PATH: notify.PATH, NOTIFY_SOCKET: notify.NOTIFY_SOCKET, COPY_SCHEMA: '7' });
  side.run(held.fd);
  held.server.close();
  await until('the handover finishes', () => side.order.includes('finish'));
  assert.deepEqual(side.order, ['quiesce', 'finish']);
  // The copy told systemd it is the main process, with its own pid.
  const pid = Number(/pid (\d+) is the server now/.exec(side.lines.join('\n'))?.[1]);
  assert.ok(pid > 0, side.lines.join('\n'));
  await until('the copy told systemd', () => notify.calls().length > 0);
  assert.deepEqual(notify.calls(), [`MAINPID=${pid}`]);
  assert.equal(handoverState(), 'busy'); // the old server exits from here (closeDown)
});

test('a copy that dies after go makes the old server exit, so systemd restarts the service', async () => {
  const old = tmp.spawn(process.execPath, [OLD], { env: { ...process.env, COPY_SCHEMA: '7', COPY_MODE: 'die' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  old.stdout!.setEncoding('utf8').on('data', (d) => (out += d));
  assert.equal(await new Promise((r) => old.once('exit', r)), 1, out);
  assert.match(out, /quiesce\n[^]*Handover: the new server (exited \(3\)|closed the pipe without going live) after go; exiting, so systemd restarts the service\./);
  assert.doesNotMatch(out, /finish/);
});

test('a standby copy of the real server does nothing before go, and goes when the old server does', async () => {
  const data = join(tmp.dir, 'standby-data');
  const copy = tmp.spawn(process.execPath, [join(REPO, 'server.ts')], {
    env: { ...process.env, DATA_DIR: data, PORT: '0', COORDINATOR_PASSWORD: PASSWORD, SESSION_SECRET: SECRET, CITADEL_HANDOVER: String(SCHEMA_VERSION), CITADEL_HOST_SIGNALS: 'fixed', CITADEL_ZONE: TEST_ZONE },
    stdio: ['ignore', 'inherit', 'inherit', 'ignore', 'pipe'],
  });
  const ctl = copy.stdio[4]!;
  const ready = await new Promise<string>((r) => createInterface({ input: ctl as Readable }).once('line', r));
  assert.equal(ready, 'ready');
  assert.ok(!existsSync(data), 'it made its data folder before go');
  const exited = new Promise((r) => copy.once('exit', r));
  ctl.destroy();
  assert.equal(await exited, 0);
});

test('a standby copy backs out of a schema change with the cold exit code', async () => {
  const copy = tmp.spawn(process.execPath, ['-e', `import(${JSON.stringify(join(REPO, 'src/handover.ts'))}).then((m) => m.standby(5, { CITADEL_HANDOVER: '4' }))`], { stdio: 'ignore' });
  assert.equal(await new Promise((r) => copy.once('exit', r)), COLD);
});

/** GET `path` on a fresh connection (Caddy's kept-alive ones go through the same close), with its status or error. */
function ask(port: number, path: string): Promise<string> {
  return new Promise((r) => {
    // A request the handover lost would hang: it says so instead.
    const req = get({ host: '127.0.0.1', port, path, agent: false, timeout: 20_000 }, (res) => (res.resume(), r(String(res.statusCode)))).on('error', (e) => r(e.message));
    req.on('timeout', () => (req.destroy(), r('no answer in 20 s')));
  });
}

// Two real servers boot in it: room for its own waits to say which step stuck before the test's timeout does.
test('the real server hands over under a request loop with no failed request and no dropped page', { timeout: 120_000 }, async () => {
  const root = join(tmp.dir, 'real');
  mkdirSync(root);
  const notify = fakeNotify(root);
  const held = await heldSocket();
  const log = join(root, 'server.log');
  // bootServer spawns before its first await, so the server has its copy of the socket when this process closes its
  // own, before it ever accepts: listening here too, it took some connections (sign-in among them) and never answered.
  const booting = bootServer({
    root,
    log,
    fds: [held.fd],
    // systemd's way: LISTEN_PID is the server's own pid.
    wrap: ['sh', '-c', 'export LISTEN_PID=$$; exec "$0" "$@"'],
    env: { TURN_UNITS: '0', PORT: String(held.port), LISTEN_FDS: '1', PATH: notify.PATH, NOTIFY_SOCKET: notify.NOTIFY_SOCKET, CITADEL_EXIT_WITH_PARENT: '0' },
  });
  held.server.close();
  const booted = await booting;
  let newPid = 0;
  after(() => {
    if (newPid)
      try {
        process.kill(newPid, 'SIGKILL');
      } catch {}
  });
  const { base, cookie, proc } = booted;
  assert.equal((await json<{ handover: string }>(await fetch(`${base}/api/health`))).handover, 'ready');

  // An open page's live stream: it stays open until the new server listens, then ends, and the page reconnects.
  const stream = await new Promise<IncomingMessage>((r) => get({ host: '127.0.0.1', port: held.port, path: '/api/stream', agent: false, headers: { Cookie: cookie } }, r));
  let streamed = '';
  let streamEnded = false;
  stream
    .setEncoding('utf8')
    .on('data', (d) => (streamed += d))
    .on('close', () => (streamEnded = true));

  const answers: string[] = [];
  let looping = true;
  const loop = (async () => {
    while (looping) answers.push(await ask(held.port, '/api/health'));
  })();
  await until('a few answers before', () => answers.length >= 5);
  let exitCode: number | null | undefined;
  proc.once('exit', (code) => (exitCode = code));
  const serverLog = () => readFileSync(log, 'utf8').slice(-3000);
  // A kept-alive connection, as Caddy holds them, opened before the swap.
  const keep = new Agent({ keepAlive: true, maxSockets: 1 });
  const onKept = () =>
    new Promise<{ reused: boolean; handover: string }>((r, j) => {
      const q = get({ host: '127.0.0.1', port: held.port, path: '/api/health', agent: keep, timeout: 20_000 }, (res) => {
        let body = '';
        res
          .setEncoding('utf8')
          .on('data', (d) => (body += d))
          .on('end', () => r({ reused: q.reusedSocket, handover: JSON.parse(body).handover }));
      }).on('error', j);
      q.on('timeout', () => q.destroy(new Error('the kept-alive request had no answer in 20 s')));
    });
  assert.equal((await onKept()).handover, 'ready');
  proc.kill('SIGUSR2');
  await until('the old server lets go', () => /handing it the socket/.test(readFileSync(log, 'utf8')), undefined, serverLog);
  // On it, a request after the old server let go of its work goes on to the new server ("ready"; the old one says "busy").
  assert.deepEqual(await onKept(), { reused: true, handover: 'ready' });
  keep.destroy();
  await until('the new server takes over', () => (newPid = Number(/pid (\d+) is the server now/.exec(readFileSync(log, 'utf8'))?.[1])), undefined, serverLog);
  await until('the old server exits', () => exitCode !== undefined, undefined, serverLog);
  assert.equal(exitCode, 0, 'the old server exits cleanly');
  await until("the old server's stream ends", () => streamEnded, undefined, serverLog);
  // Its last words tell the page the next server is up: come back in 0.2 s, and no "Reconnecting…" chip.
  assert.match(streamed, /retry: 200\ndata: \{"type":"handover"\}\n\n$/);
  const at = answers.length;
  await until(
    'answers from the new server',
    () => answers.length >= at + 5,
    undefined,
    () => `${answers.slice(-5)}\n${serverLog()}`,
  );
  looping = false;
  await loop;
  assert.deepEqual(
    answers.filter((a) => a !== '200'),
    [],
    'every request was answered',
  );
  assert.deepEqual(
    notify.calls().filter((c) => c.startsWith('MAINPID')),
    [`MAINPID=${newPid}`],
  );
  // The old server noted its own stop, so the new one's boot logs a handover, not "no stop was noted" (an unplanned one).
  assert.equal(JSON.parse(readFileSync(join(booted.data, STOP_MARK), 'utf8')).result, 'handover');
  // The page's next stream opens on the new server.
  const again = await new Promise<IncomingMessage>((r) => get({ host: '127.0.0.1', port: held.port, path: '/api/stream', agent: false, headers: { Cookie: cookie } }, r));
  assert.equal(again.statusCode, 200);
  again.destroy();
  const out = readFileSync(log, 'utf8');
  assert.doesNotMatch(out, /still open after/, 'the old server sat out its grace');
  process.kill(newPid, 'SIGTERM');
  await until('the new server exits', () => {
    try {
      process.kill(newPid, 0);
      return false;
    } catch {
      return true;
    }
  });
  newPid = 0;
});
