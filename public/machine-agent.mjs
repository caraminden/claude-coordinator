#!/usr/bin/env node
// Claude Coordinator machine agent: lends this computer's MCP server (a Godot editor, say) to the
// coordinator's threads. It dials out to the app and keeps that connection open, so the app never
// needs to reach this computer; each thread session gets its own copy of the MCP server.
//
//   node machine-agent.mjs <app url> <token> -- <mcp server command> [args...]
//
// The token can come from CC_MACHINE_TOKEN instead. Needs Node 18 or newer; no other installs.
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const [appUrl, argToken] = dash < 0 ? argv : argv.slice(0, dash);
const command = dash < 0 ? [] : argv.slice(dash + 1);
const token = argToken ?? process.env.CC_MACHINE_TOKEN;
if (!appUrl || !token || !command.length) {
  console.error('Usage: node machine-agent.mjs <app url> <token> -- <mcp server command> [args...]');
  console.error('Example: node machine-agent.mjs https://example.net ccm_1_… -- npx -y @coding-solo/godot-mcp');
  process.exit(2);
}
const auth = { Authorization: `Bearer ${token}` };

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

/** session id -> its running MCP server, and the chain that sends its output in order */
const sessions = new Map();

function startServer(id) {
  const proc = spawn(command[0], command.slice(1), {
    stdio: ['pipe', 'pipe', 'pipe'],
    // npx and friends are .cmd files on Windows, which only start through a shell.
    shell: process.platform === 'win32',
  });
  const s = { proc, chain: Promise.resolve() };
  sessions.set(id, s);
  log(`Session ${id.slice(0, 6)} started ${command[0]}`);
  createInterface({ input: proc.stdout }).on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return log(`[${id.slice(0, 6)}] ${line}`); // stray non-protocol output
    }
    send(s, id, { message });
  });
  createInterface({ input: proc.stderr }).on('line', (line) => log(`[${id.slice(0, 6)}] ${line}`));
  const ended = (why) => {
    if (sessions.get(id) !== s) return;
    sessions.delete(id);
    log(`Session ${id.slice(0, 6)} ended (${why})`);
    send(s, id, { closed: true });
  };
  proc.on('exit', (code, signal) => ended(signal ?? `exit ${code}`));
  proc.on('error', (err) => ended(err.message));
  proc.stdin.on('error', () => {});
  return s;
}

function stopServer(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  s.proc.stdin.end();
  // Give it a moment to exit by itself, as MCP servers do when stdin closes.
  setTimeout(() => s.proc.exitCode === null && s.proc.kill(), 3000).unref();
  log(`Session ${id.slice(0, 6)} closed by the app`);
}

function send(s, id, body) {
  s.chain = s.chain.then(async () => {
    const res = await fetch(new URL('/api/machines/send', appUrl), {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: id, ...body }),
    });
    // The thread's turn ended: nobody is listening to this server any more.
    if (res.status === 410) stopServer(id);
  }).catch((err) => log(`Could not send to the app: ${err.message}`));
}

/** Server-sent events from a fetch body, one parsed JSON message per event. */
async function* events(body) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}

async function connect() {
  const url = new URL('/api/machines/connect', appUrl);
  url.searchParams.set('host', hostname());
  url.searchParams.set('command', command.join(' '));
  const res = await fetch(url, { headers: { ...auth, Accept: 'text/event-stream' } });
  if (res.status === 401) {
    console.error('The app rejected this token. Make a new one in the Machines panel.');
    process.exit(1);
  }
  if (!res.ok) throw new Error(`the app answered ${res.status}`);
  for await (const msg of events(res.body)) {
    if (msg.hello) {
      log(`Connected to ${new URL(appUrl).host} as "${msg.hello}". Threads can use ${command.join(' ')} while this runs.`);
      retry = 0;
    } else if (msg.close) {
      stopServer(msg.session);
    } else if (msg.session) {
      const s = sessions.get(msg.session) ?? startServer(msg.session);
      s.proc.stdin.write(`${JSON.stringify(msg.message)}\n`);
    }
  }
  throw new Error('the connection closed');
}

let retry = 0;
for (;;) {
  try {
    await connect();
  } catch (err) {
    // The app ends every session when this connection drops; stop their servers too.
    for (const id of [...sessions.keys()]) stopServer(id);
    const wait = Math.min(30, 2 ** retry++);
    log(`Disconnected: ${err.message}. Retrying in ${wait}s.`);
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}
