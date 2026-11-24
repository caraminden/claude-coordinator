// citadel-replay (#836): reruns kept app chats (src/replay-keep.ts) with an old and a new system prompt, both against
// the same fake tools, so a blind critic can say which outcome is worse (the citadel:replay skill). It runs `claude -p`
// with a contraption turn's own flags (src/contraption-args.ts), on the minion's own Claude, and deletes the
// transcripts it makes. Pinned beside contraption-args.ts on every turn's PATH by src/turn-launch.ts; it imports
// nothing else of Citadel's.
//
//   citadel-replay run --chats <dir> --old <file> --new <file> [--count 5] [--out <dir>] [--model <m>]
//                      [--tools <json>] [--tools-new <json>] [--mcp <server>=<url>]... [--parallel 3] [--over-cap]
//   citadel-replay stub <chat.jsonl> --server <name> --turn <n> [--tools <json>]   (the fake MCP server; run starts it)
//
// Replays cost usage, so they are manual: a person asks, or once per big change to an app agent's prompt or tools
// (Cara, 2026-11-16: "be judicious about when to leverage this replay"). Over TURN_CAP claude turns needs --over-cap.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { args, mcpConfig, settings, toolNamesPrompt, userLine } from './contraption-args.ts';

export const TURN_CAP = 60;
const TURN_TIMEOUT_MS = 300_000;
/** How much of a tool result an outcome file shows the critic. */
const SHOW_RESULT = 1_500;

/** A kept turn as src/replay-keep.ts writes it (only what replays read). */
export interface Kept {
  n: number;
  prompt: string;
  images: number;
  system: string;
  model: string | null;
  servers: string[];
  agents: boolean;
  webSearch: boolean;
  compactWindow: number;
  effort?: string | null;
  toolSearch?: boolean;
  calls: { name: string; input: unknown; ok: boolean | null; result: string | null }[];
  text: string;
}

export const readChat = (file: string): Kept[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// ---- The stub: answers a replay's tool calls from the kept chat's. ----

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** How alike two inputs are: top-level keys with equal values. */
function likeness(a: unknown, b: unknown): number {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return same(a, b) ? 1 : 0;
  return Object.keys(a).filter((k) => same((a as any)[k], (b as any)[k])).length;
}

/**
 * The answer to a call: a recorded call with the same name and input (in order, the replayed turn's first), else
 * the same tool's most alike recorded call, else an error saying replay has nothing for it. `used` counts the
 * recorded calls already given out, so repeats walk through the recording.
 */
export function answer(chat: Kept[], turn: number, name: string, input: unknown, used: Set<object>): { ok: boolean; text: string } {
  const all = chat.flatMap((t) => t.calls.map((c) => ({ ...c, turn: t.n, ref: c })));
  const byTurn = (a: { turn: number }, b: { turn: number }) => Number(b.turn === turn) - Number(a.turn === turn);
  const named = all.filter((c) => c.name === name && c.result !== null).sort(byTurn);
  const exact = named.filter((c) => same(c.input, input));
  const pick = exact.find((c) => !used.has(c.ref)) ?? exact.at(-1) ?? named.sort((a, b) => likeness(b.input, input) - likeness(a.input, input) || byTurn(a, b))[0];
  if (!pick) return { ok: false, text: `Not available in replay: the kept chat never got a result from ${name}, so there is nothing to answer with.` };
  used.add(pick.ref);
  return { ok: pick.ok !== false, text: pick.result ?? '' };
}

/** Run as a stdio MCP server for one server of one replayed turn. */
async function stub(file: string, server: string, turn: number, toolsFile: string | null) {
  const chat = readChat(file);
  const prefix = `mcp__${server}__`;
  const listed: { name: string; description?: string; inputSchema: object }[] | undefined = toolsFile ? JSON.parse(readFileSync(toolsFile, 'utf8'))[server] : undefined;
  const tools = listed ?? [...new Set(chat.flatMap((t) => t.calls.map((c) => c.name)).filter((n) => n.startsWith(prefix)))].map((n) => ({ name: n.slice(prefix.length), description: 'A tool of the app (replay stub).', inputSchema: { type: 'object', additionalProperties: true } }));
  const used = new Set<object>();
  const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  for await (const line of createInterface({ input: process.stdin })) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id === undefined) continue; // notifications
    if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: `${server}-replay`, version: '1' } } });
    else if (m.method === 'tools/list') send({ id: m.id, result: { tools } });
    else if (m.method === 'tools/call') {
      const a = answer(chat, turn, prefix + String(m.params?.name), m.params?.arguments ?? {}, used);
      send({ id: m.id, result: { content: [{ type: 'text', text: a.text }], isError: !a.ok } });
    } else if (m.method === 'ping') send({ id: m.id, result: {} });
    else send({ id: m.id, error: { code: -32601, message: `No ${m.method} in a replay stub` } });
  }
}

// ---- The run: each chat, old and new, one claude -p per kept turn. ----

interface Opts {
  chats: string;
  old: string;
  new: string;
  count: number;
  out: string;
  model: string | null;
  tools: string | null;
  toolsNew: string | null;
  mcp: Map<string, string>;
  parallel: number;
  overCap: boolean;
  claude: string;
}

interface Step {
  prompt: string;
  calls: { name: string; input: unknown; ok: boolean | null; result: string | null }[];
  text: string;
  error: string | null;
}

/** The chats to replay: the newest `count` session files in the folder. */
export function pickChats(dir: string, count: number): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, count);
}

const configDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

/** One side of one chat: its kept turns rerun in a fresh session in a folder of its own, deleted after. */
async function side(o: Opts, file: string, chat: Kept[], system: string, toolsFile: string | null, work: string): Promise<{ steps: Step[]; cost: number }> {
  mkdirSync(work, { recursive: true });
  const session = randomUUID();
  const steps: Step[] = [];
  let cost = 0;
  try {
    for (const t of chat) {
      const servers = t.servers.map((name) => ({ name, path: '' }));
      const req = {
        system: [system, toolNamesPrompt(t.servers)].filter(Boolean).join('\n\n'),
        blind: false,
        model: o.model ?? t.model,
        compactWindow: t.compactWindow,
        effort: t.effort ?? null,
        toolSearch: t.toolSearch === true,
        mcp: servers,
        agents: t.agents ? { max: 1 } : (false as const),
        webSearch: t.webSearch,
        media: false,
      };
      // The stub runs in the work folder, so its paths must be absolute.
      // shortcut: the machines note real turns add isn't rebuilt, and Agent runs without its cap's hook; add them if replays of those apps matter.
      const config = mcpConfig(0, []);
      for (const s of t.servers) {
        const url = o.mcp.get(s);
        config.mcpServers[s] = url ? { type: 'http', url } : { type: 'stdio', command: process.execPath, args: [import.meta.filename, 'stub', resolve(file), '--server', s, '--turn', String(t.n), ...(toolsFile ? ['--tools', resolve(toolsFile)] : [])] };
      }
      writeFileSync(join(work, 'mcp.json'), JSON.stringify(config));
      writeFileSync(join(work, 'settings.json'), JSON.stringify(settings(req, null)));
      writeFileSync(join(work, 'system.md'), req.system);
      const r = await claude(o.claude, args(req, work, session, steps.length > 0), work, t.prompt);
      cost += r.cost;
      steps.push({ prompt: t.prompt, ...r });
      if (r.error) break;
    }
  } finally {
    rmSync(join(configDir(), 'projects', work.replace(/[^a-zA-Z0-9]/g, '-')), { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
  return { steps, cost };
}

/** One claude -p turn: the prompt in, what it said and called out. */
function claude(bin: string, argv: string[], cwd: string, prompt: string): Promise<Omit<Step, 'prompt'> & { cost: number }> {
  return new Promise((done) => {
    const child = spawn(bin, argv, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const calls = new Map<string, Step['calls'][number]>();
    let text = '';
    let error: string | null = null;
    let cost = 0;
    let stderr = '';
    const timer = setTimeout(() => {
      error = `timed out after ${TURN_TIMEOUT_MS / 1000} s`;
      child.kill('SIGTERM');
    }, TURN_TIMEOUT_MS);
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
    child.stdin.on('error', () => {});
    child.stdin.write(userLine(prompt));
    createInterface({ input: child.stdout }).on('line', (line) => {
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.parent_tool_use_id) return; // a Grunt's own words and calls
      if (ev.type === 'system' && ev.subtype === 'init') {
        const down = (ev.mcp_servers ?? []).filter((m: any) => m?.status !== 'connected').map((m: any) => `${m?.name} ${m?.status}`);
        if (down.length) error = `MCP server not connected: ${down.join(', ')}`;
      } else if (ev.type === 'assistant') {
        for (const b of ev.message?.content ?? []) {
          if (b?.type === 'text' && b.text) text += (text ? '\n\n' : '') + b.text;
          if (b?.type === 'tool_use') calls.set(String(b.id), { name: String(b.name), input: b.input, ok: null, result: null });
        }
      } else if (ev.type === 'user') {
        for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) {
          const call = b?.type === 'tool_result' ? calls.get(String(b.tool_use_id)) : undefined;
          if (call) Object.assign(call, { ok: !b.is_error, result: typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x?.text ?? '').join('\n') });
        }
      } else if (ev.type === 'result') {
        cost = Number(ev.total_cost_usd) || 0;
        if (ev.is_error) error = String(ev.result ?? ev.subtype ?? 'error').slice(0, 500);
        child.stdin.end();
      }
    });
    child.on('error', (err) => (error = err.message));
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code && !error) error = `claude exited ${code}: ${stderr.trim().slice(-300)}`;
      done({ calls: [...calls.values()], text, error, cost });
    });
  });
}

const fence = (s: string) => '````\n' + s.replace(/\n?$/, '\n') + '````';
const short = (s: string | null) => (s && s.length > SHOW_RESULT ? `${s.slice(0, SHOW_RESULT)} [… ${s.length - SHOW_RESULT} more characters]` : (s ?? ''));

function stepsMd(steps: Step[], n: number): string {
  const s = steps[n];
  if (!s) return '_(not reached: an earlier turn failed)_';
  const calls = s.calls.map((c) => `- \`${c.name}\` ${JSON.stringify(c.input)}${c.ok === false ? ' → error' : ''}\n${fence(short(c.result))}`).join('\n');
  return [calls && `Tool calls:\n${calls}`, `Reply:\n${fence(s.text || '(no text)')}`, s.error && `**The turn failed:** ${s.error}`].filter(Boolean).join('\n\n');
}

/** The file the critic reads for one chat: the player's words, then X and Y per turn, and the recorded run for context. */
export function chatMd(i: number, chat: Kept[], x: Step[], y: Step[]): string {
  const parts = [`# Chat ${i}`, 'Two outcomes, X and Y, of the same player messages. Both ran against the same fake tools. "Originally" is what happened with the real tools, for context only.'];
  chat.forEach((t, n) => {
    parts.push(`## Turn ${n + 1}`, `Player:\n${fence(t.prompt)}${t.images ? `\n_(The player attached ${t.images} image(s), not kept: neither outcome saw them.)_` : ''}`);
    parts.push(`### X\n${stepsMd(x, n)}`, `### Y\n${stepsMd(y, n)}`);
    parts.push(`### Originally\n${t.calls.map((c) => `- \`${c.name}\` ${JSON.stringify(c.input)}`).join('\n')}\n\nReply:\n${fence(short(t.text) || '(no text)')}`);
  });
  return parts.join('\n\n') + '\n';
}

async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]();
      }
    }),
  );
  return out;
}

export async function run(o: Opts) {
  const files = pickChats(o.chats, o.count);
  if (!files.length) throw new Error(`No kept chats in ${o.chats}`);
  const chats = files.map(readChat);
  const turns = chats.reduce((n, c) => n + c.length, 0) * 2;
  console.log(`citadel-replay: ${files.length} chats, ${turns / 2} kept turns each side, ${turns} claude turns in all, on your own plan.`);
  if (turns > TURN_CAP && !o.overCap) throw new Error(`${turns} turns is over the ${TURN_CAP}-turn cap: replay fewer chats (--count), or pass --over-cap if a person asked for this many`);
  const oldText = readFileSync(o.old, 'utf8');
  const newText = readFileSync(o.new, 'utf8');
  const oldHash = createHash('sha256').update(oldText).digest('hex');
  const off = files.filter((_, i) => chats[i].some((t) => t.system !== oldHash)).length;
  if (off) console.log(`citadel-replay: warning: ${off} of ${files.length} chats ran on a system prompt other than --old (an earlier version?). The comparison still holds: both sides rerun.`);
  mkdirSync(o.out, { recursive: true });
  const work = join(tmpdir(), `citadel-replay-${randomUUID().slice(0, 8)}`);
  const jobs = files.flatMap((file, i) => [() => side(o, file, chats[i], oldText, o.tools, join(work, `${i}-old`)), () => side(o, file, chats[i], newText, o.toolsNew ?? o.tools, join(work, `${i}-new`))]);
  const results = await pool(jobs, o.parallel);
  rmSync(work, { recursive: true, force: true });
  const key: Record<string, { X: string; Y: string; file: string }> = {};
  let cost = 0;
  files.forEach((file, i) => {
    const [old, neu] = [results[2 * i], results[2 * i + 1]];
    cost += old.cost + neu.cost;
    const flip = Math.random() < 0.5;
    key[`chat-${i + 1}`] = { X: flip ? 'new' : 'old', Y: flip ? 'old' : 'new', file: basename(file) };
    writeFileSync(join(o.out, `chat-${i + 1}.md`), chatMd(i + 1, chats[i], (flip ? neu : old).steps, (flip ? old : neu).steps), { mode: 0o600 });
  });
  // The key sits beside the out folder, not in it: the critic is briefed with the folder only.
  const keyFile = `${resolve(o.out)}.key.json`;
  writeFileSync(keyFile, JSON.stringify(key, null, 2), { mode: 0o600 });
  console.log(`citadel-replay: outcomes in ${o.out} (chat-1.md … chat-${files.length}.md). Key (read only after the verdicts): ${keyFile}. Cost about $${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)} at API prices.`);
}

function parse(argv: string[]): { cmd: string; pos: string[]; flags: Map<string, string[]> } {
  const [cmd = '', ...rest] = argv;
  const pos: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) pos.push(a);
    else if (a === '--over-cap') flags.set(a, ['1']);
    else flags.set(a, [...(flags.get(a) ?? []), rest[++i] ?? '']);
  }
  return { cmd, pos, flags };
}

const USAGE = 'usage: citadel-replay run --chats <dir> --old <file> --new <file> [--count 5] [--out <dir>] [--model <m>] [--tools <json>] [--tools-new <json>] [--mcp <server>=<url>] [--parallel 3] [--over-cap]';

async function main() {
  const { cmd, pos, flags } = parse(process.argv.slice(2));
  const one = (k: string) => flags.get(k)?.at(-1) ?? null;
  if (cmd === 'stub') return stub(pos[0], one('--server') ?? '', Number(one('--turn')) || 1, one('--tools'));
  if (cmd !== 'run' || !one('--chats') || !one('--old') || !one('--new')) {
    console.error(USAGE);
    process.exit(2);
  }
  const count = Number(one('--count') ?? 5);
  const parallel = Number(one('--parallel') ?? 3);
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(parallel) || parallel < 1) {
    console.error('citadel-replay: --count and --parallel are whole numbers from 1');
    process.exit(2);
  }
  const mcp = new Map((flags.get('--mcp') ?? []).map((m) => [m.slice(0, m.indexOf('=')), m.slice(m.indexOf('=') + 1)] as [string, string]));
  try {
    await run({
      chats: one('--chats')!,
      old: one('--old')!,
      new: one('--new')!,
      count,
      parallel,
      mcp,
      out: one('--out') ?? join(process.env.TMPDIR || tmpdir(), `replay-${new Date().toISOString().replace(/[:.]/g, '-')}`),
      model: one('--model'),
      tools: one('--tools'),
      toolsNew: one('--tools-new'),
      overCap: flags.has('--over-cap'),
      claude: process.env.CLAUDE_BIN || 'claude',
    });
  } catch (err: any) {
    console.error(`citadel-replay: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) await main();
