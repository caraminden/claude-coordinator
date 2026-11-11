#!/usr/bin/env node
// perigee-godot's editor only while someone uses it (#505). The Godot editor held a full core for weeks
// whether anyone called it or not, so it now starts on the first tool call and stops after IDLE unused.
//
//   node godot-on-demand.mjs -- <mcp server command> [args...]   the bridge, as the machine agent's command
//   node godot-on-demand.mjs idle-check                          perigee-godot-idle.timer: stop it if unused
//
// The bridge sits between the machine agent and `godot-ai attach`, passing MCP lines through untouched.
// Every line either way stamps the activity file, and so does a tool call still waiting on its answer
// (once a minute), so a session in progress never looks idle. A request that needs the editor (anything
// but the handshake and the listings) first starts the unit if it is down and holds until the editor
// has dialled in to godot-ai's WebSocket port (READY seconds at most), so the minion's call waits
// rather than fails. The godot-ai backend runs here on the host, owned by the attach bridges, not in
// the editor's container: stopping the editor leaves every session open, and the editor reconnects to
// the same backend when it starts again.
//
// idle-check stops the unit once neither a call nor its own start is IDLE old. It never touches a unit
// a person froze (systemctl freeze), and never starts anything.
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export function settings(env = process.env) {
  const num = (name, def) => (env[name] && Number.isFinite(Number(env[name])) ? Number(env[name]) : def);
  return {
    unit: env.GODOT_UNIT || 'perigee-godot.service',
    idleS: num('GODOT_IDLE_S', 2 * 3600),
    readyS: num('GODOT_READY_S', 180),
    wsPort: num('GODOT_WS_PORT', 9500),
    activity: env.GODOT_ACTIVITY || join(homedir(), '.local', 'state', 'perigee-godot', 'last-call'),
    systemctl: env.GODOT_SYSTEMCTL || 'systemctl',
  };
}

// Methods a session sends before it uses the editor: answered by the backend alone.
const HANDSHAKE = new Set(['initialize', 'ping', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list', 'logging/setLevel']);
export const needsEditor = (msg) => !!msg && typeof msg.method === 'string' && msg.id !== undefined && !HANDSHAKE.has(msg.method) && !msg.method.startsWith('notifications/');

/** The unit's state from `systemctl --user show`: active, activating, frozen, and when it last started (ms). */
export function unitState(cfg) {
  const r = spawnSync(cfg.systemctl, ['--user', 'show', cfg.unit, '-p', 'ActiveState', '-p', 'FreezerState', '-p', 'InactiveExitTimestamp', '--timestamp=unix'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`systemctl show ${cfg.unit} failed: ${(r.stderr || r.error?.message || '').trim()}`);
  const p = Object.fromEntries(r.stdout.split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const since = /^@(\d+)$/.exec(p.InactiveExitTimestamp ?? '');
  return { state: p.ActiveState ?? 'unknown', frozen: !!p.FreezerState && p.FreezerState !== 'running', since: since ? Number(since[1]) * 1000 : 0 };
}

/** When the editor was last used (ms), from the activity file's mtime; 0 if never. */
export function lastActivity(cfg) {
  try {
    return statSync(cfg.activity).mtimeMs;
  } catch {
    return 0;
  }
}

export function touch(cfg, now = Date.now()) {
  const t = new Date(now);
  try {
    utimesSync(cfg.activity, t, t);
  } catch {
    mkdirSync(dirname(cfg.activity), { recursive: true });
    writeFileSync(cfg.activity, '');
    utimesSync(cfg.activity, t, t);
  }
}

/** Whether idle-check should stop the unit, and why, as one line for the journal. */
export function idleVerdict({ now, unit, last, idleS }) {
  if (unit.frozen) return { stop: false, why: `${unit.state} but frozen by a person: left alone` };
  if (unit.state !== 'active') return { stop: false, why: `${unit.state}: nothing to stop` };
  const used = Math.max(last, unit.since);
  const idle = Math.floor((now - used) / 1000);
  if (idle < idleS) return { stop: false, why: `used ${Math.floor(idle / 60)} min ago (stops after ${idleS / 60} min unused)` };
  return { stop: true, why: `unused for ${Math.floor(idle / 60)} min: stopping` };
}

export function idleCheck(cfg = settings(), now = Date.now()) {
  const unit = unitState(cfg);
  // Read the activity last, just before deciding, so a call that lands meanwhile still counts.
  const v = idleVerdict({ now, unit, last: lastActivity(cfg), idleS: cfg.idleS });
  console.log(`${cfg.unit} ${v.why}`);
  if (!v.stop) return v;
  const r = spawnSync(cfg.systemctl, ['--user', 'stop', cfg.unit], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`systemctl stop ${cfg.unit} failed: ${(r.stderr || '').trim()}`);
  return v;
}

/** Whether something holds an open TCP connection to the local port: the editor dialled in to godot-ai. */
export function editorConnected(port, files = ['/proc/net/tcp', '/proc/net/tcp6']) {
  const hex = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    // sl local_address rem_address st ...; st 01 is ESTABLISHED. The server's end has the port as its local one.
    for (const line of text.split('\n').slice(1)) {
      const [, local, , st] = line.trim().split(/\s+/);
      if (st === '01' && local?.endsWith(hex)) return true;
    }
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the unit if it is down and waits until the editor has dialled in, for a call that needs it.
 * Waits only while the unit is in its first READY seconds: an editor up for longer that never connected
 * won't, and holding every call for it would only make each one slow.
 */
export async function ensureEditor(cfg, log, { now = Date.now, connected = () => editorConnected(cfg.wsPort), poll = 500 } = {}) {
  if (connected()) return 'ready';
  let unit;
  try {
    unit = unitState(cfg);
  } catch (err) {
    log(`could not read ${cfg.unit}: ${err.message}`);
    return 'unknown';
  }
  if (unit.frozen) {
    log(`${cfg.unit} is frozen by a person; not starting it`);
    return 'frozen';
  }
  let since = unit.since;
  if (unit.state !== 'active' && unit.state !== 'activating') {
    log(`${cfg.unit} is ${unit.state}; starting it for this call (up to ${cfg.readyS} s)`);
    const r = spawnSync(cfg.systemctl, ['--user', 'start', '--no-block', cfg.unit], { encoding: 'utf8' });
    if (r.status !== 0) {
      log(`could not start ${cfg.unit}: ${(r.stderr || r.error?.message || '').trim()}`);
      return 'failed';
    }
    since = now();
  }
  const deadline = since + cfg.readyS * 1000;
  if (now() >= deadline) return 'not-connected';
  while (now() < deadline) {
    await sleep(poll);
    if (connected()) {
      log(`the editor connected ${Math.round((now() - since) / 1000)} s after ${cfg.unit} started`);
      return 'ready';
    }
  }
  log(`the editor had not connected ${cfg.readyS} s after ${cfg.unit} started; passing the call on anyway`);
  return 'timeout';
}

/** The bridge: the machine agent's stdio on one side, the MCP server's on the other. */
export function bridge(command, cfg = settings(), { input = process.stdin, output = process.stdout, log = (l) => console.error(`godot-on-demand: ${l}`), ensure = () => ensureEditor(cfg, log), keepEveryMs = 60_000 } = {}) {
  const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
  child.stdin.on('error', () => {});
  const pending = new Set();
  let stamped = 0;
  const stamp = () => {
    const t = Date.now();
    if (t - stamped < 5_000) return;
    stamped = t;
    try {
      touch(cfg, t);
    } catch (err) {
      log(`could not stamp ${cfg.activity}: ${err.message}`);
    }
  };
  // A long call (a game run, a big import) sends nothing until it answers: it is still use.
  const keep = setInterval(() => pending.size && ((stamped = 0), stamp()), keepEveryMs);
  keep.unref();
  // Lines go to the server in order: one held for the editor holds the ones behind it.
  let chain = Promise.resolve();
  createInterface({ input }).on('line', (line) => {
    stamp();
    let msg = null;
    try {
      msg = JSON.parse(line);
    } catch {}
    const needs = needsEditor(msg);
    if (needs) pending.add(msg.id);
    chain = chain.then(async () => {
      if (needs) await ensure().catch((err) => log(`could not get the editor up: ${err.message}`));
      child.stdin.write(`${line}\n`);
    });
  }).on('close', () => chain.then(() => child.stdin.end()));
  createInterface({ input: child.stdout }).on('line', (line) => {
    stamp();
    try {
      const msg = JSON.parse(line);
      if (msg && msg.id !== undefined && msg.method === undefined) pending.delete(msg.id);
    } catch {}
    output.write(`${line}\n`);
  });
  return child;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === 'idle-check') {
    try {
      idleCheck();
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    return;
  }
  const dash = argv.indexOf('--');
  const command = dash < 0 ? [] : argv.slice(dash + 1);
  if (!command.length) {
    console.error('Usage: node godot-on-demand.mjs -- <mcp server command> [args...]\n   or: node godot-on-demand.mjs idle-check');
    process.exit(2);
  }
  const child = bridge(command);
  // The machine agent ends a session with SIGTERM when stdin's close wasn't enough: pass it on to attach.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  child.on('error', (err) => {
    console.error(`godot-on-demand: could not start ${command[0]}: ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
