#!/usr/bin/env node
// The verifier's stand-in for Claude Code (#1740), which `boot.mjs start --turns` runs as the dev copy's CLAUDE_BIN, so a
// verifier can make real turns end the way the bug it hunts needs: a usage limit, a logged-out login, a card, a crash.
// Each turn takes the first line of <case>/fake/turns.jsonl that fits it (a line with "ticket" only fits that minion's
// turns) and logs what it got to <case>/fake/calls.jsonl. No line fits: it replies "ok". A line, all keys optional:
//   {"ticket": 3, "outcome": "success" | "usage_limit" | "not_logged_in" | "error" | "crash",
//    "text": "the reply, or the error's words", "tools": [{"name": "ask_question", "arguments": {...}, "server": "thread"}],
//    "delayMs": 2000, "lines": [raw stream-json events, printed as they are], "exit": 0}
// Tools are called on the turn's own MCP server (from --mcp-config) the way Claude Code calls them; a card's call
// waits for its answer, as a real turn does.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DIR = process.env.FAKE_CLAUDE_DIR ?? join(dirname(new URL(import.meta.url).pathname), 'fake');
const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const env = { ticket: process.env.COORDINATOR_TICKET ?? null, number: process.env.COORDINATOR_NUMBER ?? null, role: process.env.COORDINATOR_ROLE ?? null };
// boot.mjs --clock's offset: the server's clock, which reads a reset hour or a timestamp the fake writes.
const OFFSET = (() => {
  try {
    return Number(readFileSync(join(DIR, 'clock-offset'), 'utf8')) || 0;
  } catch {
    return 0;
  }
})();
const now = () => new Date(Date.now() + OFFSET);
const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');

/** The first queued line that fits this turn, taken off the queue; null when none does. */
export function take(lines, who) {
  const i = lines.findIndex((l) => l.ticket == null || String(l.ticket) === String(who.ticket) || String(l.ticket) === String(who.number));
  return i < 0 ? null : lines.splice(i, 1)[0];
}

/** The words Claude Code ends a limited turn with, reset an hour or more ahead whatever the time. */
export function limitText(at = new Date()) {
  const h = new Date(at.getTime() + 2 * 3600_000).getUTCHours();
  return `You've hit your limit · resets ${h % 12 || 12}${h < 12 ? 'am' : 'pm'} (UTC)`;
}

function popQueue() {
  const file = join(DIR, 'turns.jsonl');
  const lock = join(DIR, 'turns.lock');
  mkdirSync(DIR, { recursive: true });
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      if (i > 200) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const spec = take(lines, env);
    if (spec) writeFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));
    return spec;
  } finally {
    try {
      rmdirSync(lock);
    } catch {}
  }
}

/** Calls one tool on a stdio MCP server from the turn's --mcp-config and returns its result. */
async function callTool(tool) {
  const config = JSON.parse(readFileSync(arg('--mcp-config'), 'utf8')).mcpServers;
  const name = tool.server ?? Object.keys(config)[0];
  const s = config[name];
  // shortcut: stdio only; `boot.mjs start --turns` sets TURN_POOL=0 so turns get stdio. Add HTTP if a case needs the pool.
  if (!s || (s.type && s.type !== 'stdio')) throw new Error(`no stdio MCP server ${name} in --mcp-config`);
  const proc = spawn(s.command, s.args ?? [], { env: { ...process.env, ...(s.env ?? {}) }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  createInterface({ input: proc.stdout }).on('line', (l) => {
    try {
      const m = JSON.parse(l);
      waiting.get(m.id)?.(m);
    } catch {}
  });
  let id = 0;
  const rpc = (method, params) =>
    new Promise((r) => {
      waiting.set(++id, r);
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  try {
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '1' } });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const m = await rpc('tools/call', { name: tool.name, arguments: tool.arguments ?? {} });
    return m.error ? { isError: true, content: [{ type: 'text', text: JSON.stringify(m.error) }] } : m.result;
  } finally {
    proc.kill();
  }
}

async function turn(line) {
  const blocks = line ? (JSON.parse(line).message?.content ?? []) : [];
  const prompt = Array.isArray(blocks) ? blocks.map((b) => b.text ?? '').join('\n') : String(blocks);
  const spec = popQueue() ?? {};
  const session = arg('--resume') ?? randomUUID();
  const log = { at: now().toISOString(), ...env, args, prompt, spec, tools: [] };
  const say = (text) => out({ type: 'assistant', message: { role: 'assistant', model: 'claude-fake', content: [{ type: 'text', text }] }, session_id: session });
  out({ type: 'system', subtype: 'init', session_id: session, model: arg('--model') ?? 'claude-fake', cwd: process.cwd() });
  if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
  for (const ev of spec.lines ?? []) out(ev);
  for (const [i, tool] of (spec.tools ?? []).entries()) {
    const use = `toolu_fake_${i}`;
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: use, name: `mcp__${tool.server ?? env.role ?? 'thread'}__${tool.name}`, input: tool.arguments ?? {} }] }, session_id: session });
    let result;
    try {
      result = await callTool(tool);
    } catch (e) {
      result = { isError: true, content: [{ type: 'text', text: String(e.message) }] };
    }
    log.tools.push({ name: tool.name, result });
    out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: use, content: result?.content ?? [], is_error: !!result?.isError }] }, session_id: session });
  }
  const outcome = spec.outcome ?? 'success';
  appendFileSync(join(DIR, 'calls.jsonl'), JSON.stringify({ ...log, outcome }) + '\n');
  // The session file a real turn leaves, which the server reads back for some checks.
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(DIR, 'config'), 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(projects, { recursive: true });
  appendFileSync(join(projects, `${session}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: blocks } }) + '\n');
  if (outcome === 'crash') process.exit(spec.exit ?? 1);
  if (outcome === 'success') {
    const text = spec.text ?? 'ok';
    say(text);
    out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, num_turns: 1, duration_ms: 10, total_cost_usd: 0 });
    process.exit(spec.exit ?? 0);
  }
  const text = spec.text ?? (outcome === 'usage_limit' ? limitText(now()) : outcome === 'not_logged_in' ? 'Invalid API key · Please run /login' : 'API Error: 500 Internal server error');
  out({ type: 'assistant', isApiErrorMessage: true, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text }] }, session_id: session });
  out({ type: 'result', subtype: 'success', is_error: true, result: text, session_id: session, num_turns: 1, duration_ms: 10, total_cost_usd: 0 });
  process.exit(spec.exit ?? 1);
}

if (import.meta.main ?? process.argv[1] === new URL(import.meta.url).pathname) {
  if (args.includes('--version')) {
    console.log('2.1.0 (Claude Code)');
    process.exit(0);
  }
  let started = false;
  const rl = createInterface({ input: process.stdin });
  rl.once('line', (l) => {
    started = true;
    turn(l);
  });
  // A prompt given with -p and no stdin.
  rl.once('close', () => {
    if (!started) turn(JSON.stringify({ message: { content: [{ type: 'text', text: /^-/.test(args[args.indexOf('-p') + 1] ?? '-') ? '' : args[args.indexOf('-p') + 1] }] } }));
  });
}
