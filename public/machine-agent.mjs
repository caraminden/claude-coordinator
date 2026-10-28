#!/usr/bin/env node
// Claude Coordinator machine agent: lends this computer's MCP server (a Godot editor, say) to the
// coordinator's threads. It dials out to the app and keeps that connection open, so the app never
// needs to reach this computer; each thread session gets its own copy of the MCP server.
//
//   node machine-agent.mjs <app url> <token> --claude-mcp <name>
//   node machine-agent.mjs <app url> <token> -- <mcp server command> [args...]
//
// --claude-mcp runs a server already set up for Claude Code on this computer (in ~/.claude.json),
// such as godot-ai, whose entry holds a path only this computer knows. It is read afresh for each
// session, so an updated entry applies without restarting the agent.
// The token can come from CC_MACHINE_TOKEN instead. Needs Node 18 or newer; no other installs.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const dash = argv.indexOf('--');
const command = dash < 0 ? [] : argv.slice(dash + 1);
const opts = dash < 0 ? argv : argv.slice(0, dash);
const flag = opts.indexOf('--claude-mcp');
const claudeMcp = flag < 0 ? null : opts.splice(flag, 2)[1];
const [appUrl, argToken] = opts;
const token = argToken ?? process.env.CC_MACHINE_TOKEN;
if (!appUrl || !token || (!command.length && !claudeMcp)) {
  console.error('Usage: node machine-agent.mjs <app url> <token> --claude-mcp <name>');
  console.error('   or: node machine-agent.mjs <app url> <token> -- <mcp server command> [args...]');
  console.error('Example: node machine-agent.mjs https://example.net ccm_1_… --claude-mcp godot-ai');
  process.exit(2);
}

/** A stdio server from Claude Code's config: user scope first, then any project's. */
function claudeServer(name) {
  const file = join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`could not read ${file}: ${err.message}`);
  }
  const entry = config.mcpServers?.[name] ?? Object.values(config.projects ?? {}).map((p) => p?.mcpServers?.[name]).find(Boolean);
  if (!entry?.command) throw new Error(`${file} has no stdio MCP server named "${name}"`);
  return { command: entry.command, args: entry.args ?? [], env: entry.env ?? {} };
}

/** What a session runs: the program, its arguments, extra environment, and whether it needs a shell. */
function serverCommand() {
  if (claudeMcp) {
    const s = claudeServer(claudeMcp);
    // An absolute path may hold spaces, which a shell would split; only batch files need one.
    return { ...s, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(s.command) };
  }
  // npx and friends are .cmd files on Windows, which only start through a shell.
  return { command: command[0], args: command.slice(1), env: {}, shell: process.platform === 'win32' };
}
const describe = claudeMcp ? `${claudeMcp} (from Claude Code's config)` : command.join(' ');
try {
  serverCommand();
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
const auth = { Authorization: `Bearer ${token}` };

const log = (...a) => console.log(new Date().toLocaleTimeString(), ...a);

/** session id -> its running MCP server, and the chain that sends its output in order */
const sessions = new Map();

function startServer(id) {
  let run;
  try {
    run = serverCommand();
  } catch (err) {
    log(`Session ${id.slice(0, 6)} could not start: ${err.message}`);
    run = { command: process.execPath, args: ['-e', 'process.exit(1)'], env: {}, shell: false };
  }
  const proc = spawn(run.command, run.args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...run.env }, shell: run.shell });
  const s = { proc, chain: Promise.resolve() };
  sessions.set(id, s);
  log(`Session ${id.slice(0, 6)} started ${describe}`);
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
  url.searchParams.set('command', describe);
  const res = await fetch(url, { headers: { ...auth, Accept: 'text/event-stream' } });
  if (res.status === 401) {
    console.error('The app rejected this token. Make a new one in the Machines panel.');
    process.exit(1);
  }
  if (res.status === 403) {
    // This address takes no machines; the app says where they connect instead.
    console.error((await res.json().catch(() => ({}))).error ?? 'The app refused this connection.');
    process.exit(1);
  }
  if (!res.ok) throw new Error(`the app answered ${res.status}`);
  for await (const msg of events(res.body)) {
    if (msg.hello) {
      log(`Connected to ${new URL(appUrl).host} as "${msg.hello}". Threads can use ${describe} while this runs.`);
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
