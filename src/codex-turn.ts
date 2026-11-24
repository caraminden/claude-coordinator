// A Codex turn that looks like a `claude -p` turn (#337). The runner and contraption turns start this
// in place of claude, with the same arguments plus a few --codex-* ones, and read the same stream-json
// back: it drives `codex app-server` in the person's container on their own ChatGPT login and maps
// Codex's events onto Claude Code's. The turn wrapper, steering, stopping, the readers and the UI stay as they are.
//
// Claude flags it reads: --model, --effort, --append-system-prompt-file, --mcp-config,
// --include-partial-messages, --replay-user-messages, --tools (WebSearch turns web search on). The rest
// (permissions, settings, plugins…) are Claude's own and ignored.
// Its own: --codex-mode turn|contraption, --codex-thread <id> (resume it), --codex-handover <file> (a
// Claude log to start a new thread with), --codex-log <file> (where this turn's parts go, for the way back).
//
// Out, besides Claude's events: the init line carries `codex_thread` (no session_id: the Claude session
// stays the minion's), and `{ type: 'codex_rate_limits', rate_limits }` lines carry Codex's usage.
// Stopping it (SIGTERM) interrupts the turn. 30 minutes with no word from Codex ends it with an error.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callLine, CODEX_NOTE, isTurnNote, codexModelFor, saveGenerated, toCodexPreamble } from './codex.ts';
import { codexLock, LOCK_ENV, startTime } from './codex-lock.ts';
import type { ClaudeEvent, ClaudeMessage } from './claude-events.ts';

/** Claude's --mcp-config file: each server is a stdio command or an HTTP url. */
interface McpServer {
  type?: string;
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Milliseconds. */
  timeout?: number;
}
interface McpConfig {
  mcpServers?: Record<string, McpServer>;
}

/** One entry of a turn's `input` for Codex. */
interface CodexInput {
  type: string;
  text?: string;
  text_elements?: unknown[];
  url?: string;
}

/** One usage window of Codex's account/rateLimits. */
interface CodexWindow {
  usedPercent?: number;
  resetsAt?: number;
}
interface CodexLimits {
  primary?: CodexWindow | null;
  secondary?: CodexWindow | null;
  rateLimitReachedType?: unknown;
}

/** A part of an MCP tool call's result content. */
interface CodexContent {
  type?: string;
  text?: string;
}

/** An item of Codex's app-server protocol (item/started, item/completed): the fields each type carries, all optional. */
interface CodexItem {
  type?: string;
  id: string;
  /** agentMessage */
  text?: string;
  /** commandExecution */
  command?: string;
  aggregatedOutput?: string;
  status?: string;
  exitCode?: number;
  /** fileChange */
  changes?: { kind?: { type?: string } | string; path?: string; diff?: string }[];
  /** mcpToolCall */
  server?: string;
  tool?: string;
  arguments?: object;
  error?: { message?: string };
  /** An mcpToolCall's { content } or an imageGeneration's base64. */
  result?: unknown;
  /** webSearch, imageView, imageGeneration */
  query?: string;
  path?: string;
  revisedPrompt?: string;
  prompt?: string;
  savedPath?: string;
}

interface CodexTurn {
  id?: string;
  status?: string;
  error?: { message?: string; codexErrorInfo?: unknown };
}

/** A notification's params, by method: only what main() reads. */
interface CodexParams {
  item?: CodexItem;
  delta?: unknown;
  run?: { status?: string; entries?: { text?: string }[]; statusMessage?: string };
  plan?: { step?: string; status?: string }[];
  tokenUsage?: { last?: { inputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number; outputTokens: number } };
  rateLimits?: CodexLimits;
  name?: string;
  status?: unknown;
  willRetry?: boolean;
  error?: { message?: string };
  turn?: CodexTurn;
}

/** What `call` resolves to: the result of thread/start, thread/resume, turn/start, account/rateLimits/read. */
interface CodexResult {
  thread?: { id: string };
  turn?: CodexTurn;
  rateLimits?: CodexLimits;
}

/** One JSON-RPC line from `codex app-server`: a response (id, result or error), a request or a notification (method, params). */
interface CodexMessage {
  id?: number;
  method?: string;
  params?: CodexParams;
  result?: CodexResult;
  error?: { message?: string };
}

/** A user line waiting for its turn. */
interface QueuedLine {
  content: ClaudeMessage['content'];
  uuid?: string;
  line: ClaudeEvent;
}

export const QUIET_MS = 30 * 60 * 1000;
/** Codex's session files (rollouts) older than this are deleted when a turn starts. */
const ROLLOUT_DAYS = 14;

/** Claude-style argv as flag → values (every arg after a flag up to the next --flag). */
export function parseArgs(argv: string[]): Map<string, string[]> {
  const flags = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const a of argv) {
    if (a.startsWith('--')) flags.set(a, (cur = []));
    else if (a.startsWith('-') && a.length === 2) cur = null;
    else cur?.push(a);
  }
  return flags;
}

/**
 * Claude's --mcp-config servers as Codex thread config, with every secret (a stdio server's env, an HTTP
 * server's headers) moved into `env` and named by reference: Codex forwards env_vars and env_http_headers
 * from its own environment, so no token sits in its config or session files.
 */
export function mcpServers(mcp: McpConfig | null | undefined, turnEnv: Record<string, string | undefined>, toolTimeoutSec: number): { config: Record<string, object>; env: Record<string, string>; names: string[] } {
  const config: Record<string, object> = {};
  const env: Record<string, string> = {};
  const names: string[] = [];
  // A stdio server gets the turn's own Citadel variables, as Claude's do (the thread server's token and ticket).
  const citadel = Object.keys(turnEnv).filter((k) => /^(COORDINATOR_|CITADEL_(?!CODEX_)|MCP_TOOL_TIMEOUT$)/.test(k));
  let n = 0;
  for (const [name, s] of Object.entries(mcp?.mcpServers ?? {})) {
    if (!/^[\w-]+$/.test(name)) continue;
    const timeout = typeof s.timeout === 'number' ? Math.ceil(s.timeout / 1000) : toolTimeoutSec;
    if (s.type === 'http' || s.url) {
      const headers: Record<string, string> = {};
      for (const [h, v] of Object.entries<string>(s.headers ?? {})) {
        const key = `CITADEL_MCP_HEADER_${n++}`;
        env[key] = String(v);
        headers[h] = key;
      }
      config[`mcp_servers.${name}`] = { url: s.url, env_http_headers: headers, tool_timeout_sec: timeout };
    } else {
      for (const [k, v] of Object.entries<string>(s.env ?? {})) env[k] = String(v);
      config[`mcp_servers.${name}`] = { command: s.command, args: s.args ?? [], env_vars: [...new Set([...citadel, ...Object.keys(s.env ?? {})])], tool_timeout_sec: timeout };
    }
    names.push(name);
  }
  return { config, env, names };
}

/** A Claude stream-json user line's content as Codex input; images become data URLs. */
export function codexInput(content: ClaudeMessage['content']): CodexInput[] {
  if (typeof content === 'string') return [{ type: 'text', text: content, text_elements: [] }];
  const out: CodexInput[] = [];
  for (const b of Array.isArray(content) ? content : []) {
    if (b?.type === 'text' && typeof b.text === 'string') out.push({ type: 'text', text: b.text, text_elements: [] });
    else if (b?.type === 'image' && b.source?.type === 'base64') out.push({ type: 'image', url: `data:${b.source.media_type};base64,${b.source.data}` });
  }
  return out;
}

const errorKind = (info: unknown): string => (typeof info === 'string' ? info : info && typeof info === 'object' ? (Object.keys(info)[0] ?? '') : '');

/** Claude Code's words for a usage limit, which the runner's USAGE_LIMIT wait already handles. */
export function limitWords(limits: CodexLimits | null | undefined, now = Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const windows = [limits?.primary, limits?.secondary].filter((w) => w && typeof w.resetsAt === 'number');
  const full = windows.filter((w) => w!.usedPercent! >= 100);
  const at = Math.max(0, ...(full.length ? full : windows).map((w) => w!.resetsAt! * 1000));
  if (!at || at <= now) return "You've hit your Codex usage limit";
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true }).format(at).replace(/\s/g, '').toLowerCase();
  const day = at - now > 20 * 3600_000 ? `${new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(at)}, ` : '';
  return `You've hit your Codex usage limit · resets ${day}${time} (${timeZone})`;
}

/** Delete Codex session files older than ROLLOUT_DAYS: CODEX_HOME grows fast otherwise. */
function pruneRollouts(dir: string, now = Date.now()) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    try {
      const st = statSync(p);
      if (st.isDirectory()) {
        pruneRollouts(p, now);
        if (!readdirSync(p).length) rmSync(p, { recursive: true });
      } else if (now - st.mtimeMs > ROLLOUT_DAYS * 86_400_000) rmSync(p);
    } catch {}
  }
}

/**
 * The kit's skills as Codex skills (CODEX_HOME/skills/citadel-<name>), replacing an older copy. The
 * person's other Codex turns may be starting or reading them (#636), so a kit already installed is left
 * alone (`.citadel-kit` holds its hash), and a new one goes in a skill at a time: copied aside, then renamed into place.
 */
export function installSkills(kit: string, home: string) {
  const skills = join(home, 'skills');
  mkdirSync(skills, { recursive: true });
  const src = join(kit, 'skills');
  const names = existsSync(src) ? readdirSync(src).filter((name) => existsSync(join(src, name, 'SKILL.md'))) : [];
  const hash = createHash('sha256');
  for (const name of names) {
    for (const f of (readdirSync(join(src, name), { recursive: true }) as string[]).sort()) {
      const p = join(src, name, f);
      hash.update(`${name}/${f}\0`);
      if (statSync(p).isFile()) hash.update(readFileSync(p));
    }
  }
  const stamp = join(skills, '.citadel-kit');
  const digest = hash.digest('hex');
  try {
    if (readFileSync(stamp, 'utf8') === digest) return;
  } catch {}
  for (const name of readdirSync(skills)) if (name.startsWith('citadel-') && !names.includes(name.slice('citadel-'.length))) rmSync(join(skills, name), { recursive: true, force: true });
  for (const name of names) {
    const dest = join(skills, `citadel-${name}`);
    const [fresh, old] = [join(skills, `.new-${process.pid}-${name}`), join(skills, `.old-${process.pid}-${name}`)];
    cpSync(join(src, name), fresh, { recursive: true });
    try {
      renameSync(dest, old);
    } catch {}
    try {
      renameSync(fresh, dest);
    } catch {
      rmSync(fresh, { recursive: true, force: true }); // another turn's copy of it got there first
    }
    rmSync(old, { recursive: true, force: true });
  }
  writeFileSync(stamp, digest);
}

export async function main(argv: string[], env: Record<string, string | undefined> = process.env) {
  const flags = parseArgs(argv);
  const one = (f: string) => flags.get(f)?.[0];
  const mode = one('--codex-mode') === 'contraption' ? 'contraption' : 'turn';
  const model = codexModelFor(one('--model'));
  // Codex's efforts stop at xhigh: Claude's max asks for the most it has.
  const effort = one('--effort') === 'max' ? 'xhigh' : (one('--effort') ?? null);
  const partial = flags.has('--include-partial-messages');
  const replay = flags.has('--replay-user-messages');
  const web = (flags.get('--tools') ?? []).join(',').includes('WebSearch') || mode === 'turn';
  const logFile = one('--codex-log');
  const home = env.CODEX_HOME || join(env.HOME || homedir(), '.codex');
  const cwd = process.cwd();
  const out = (ev: object) => process.stdout.write(JSON.stringify(ev) + '\n');
  const log = (text: string, output = false) => {
    if (logFile) appendFileSync(logFile, JSON.stringify(output ? { text, output } : { text }) + '\n');
  };

  const system = one('--append-system-prompt-file');
  const developerInstructions = [system && existsSync(system) ? readFileSync(system, 'utf8') : '', mode === 'turn' ? CODEX_NOTE : ''].filter(Boolean).join('\n\n');
  const mcpFile = one('--mcp-config');
  const timeoutSec = Math.ceil(Number(env.MCP_TOOL_TIMEOUT || 600_000) / 1000);
  const mcp = mcpServers(mcpFile && existsSync(mcpFile) ? JSON.parse(readFileSync(mcpFile, 'utf8')) : {}, env, timeoutSec);

  const gate = await codexLock(home, () => out({ type: 'codex_waiting' }), { env, bin: env.CITADEL_CODEX_BIN });
  const unlock = gate.unlock;
  process.on('exit', unlock);
  // For the journal: what the login check cost this turn (#636).
  if (gate.waitedMs >= 1000 || gate.refreshed || gate.serial) out({ type: 'codex_gate', waited_ms: gate.waitedMs, refreshed: gate.refreshed, serial: gate.serial });
  pruneRollouts(join(home, 'sessions'));
  // The kit pins beside this file in a turn's folder, and sits one up in the repo.
  const here = dirname(fileURLToPath(import.meta.url));
  const kit = [join(here, 'kit'), join(here, '..', 'kit')].find((d) => existsSync(join(d, 'skills')));
  if (mode === 'turn' && kit) installSkills(kit, home);

  const c = (k: string, v: unknown) => ['-c', `${k}=${JSON.stringify(v)}`];
  const codexArgs = [
    'app-server',
    // The login stays a file (no keyring in a container); no history file; no goal tools; give up on a dead connection.
    ...c('cli_auth_credentials_store', 'file'),
    ...c('history.persistence', 'none'),
    ...c('features.goals', false),
    ...c('features.unbounded_connection_retries', false),
    ...c('web_search', web ? 'live' : 'disabled'),
    ...(mode === 'turn'
      ? // The repo's CLAUDE.md as its project doc; the shell gets the turn's env as Claude's Bash does (GH_TOKEN included).
        [...c('project_doc_fallback_filenames', ['CLAUDE.md']), ...c('shell_environment_policy.ignore_default_excludes', true)]
      : [...c('features.shell_tool', false), ...c('features.view_image', false), ...c('project_doc_max_bytes', 0)]),
    ...JSON.parse(env.CITADEL_CODEX_EXTRA_ARGS || '[]'),
  ];
  // Its shell's citadel-codex-review runs inside this turn: under this lock, when the turn keeps it (#468 S04-6).
  const lockEnv = { [LOCK_ENV]: `${process.pid} ${startTime(process.pid) ?? ''}`.trim() };
  const child = spawn(env.CITADEL_CODEX_BIN || 'codex', codexArgs, { cwd, env: { ...env, ...mcp.env, ...lockEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr!.on('data', (b) => process.stderr.write(b));
  let nextId = 1;
  const waiting = new Map<number, (m: CodexMessage) => void>();
  const send = (m: object) => child.stdin!.write(JSON.stringify(m) + '\n');
  const call = (method: string, params: object) =>
    new Promise<CodexResult>((resolve, reject) => {
      const id = nextId++;
      waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`)) : resolve(m.result!)));
      send({ id, method, params });
    });

  let threadId = '';
  let turnId: string | null = null;
  /** A turn is starting or running: turnId comes once Codex has started it. */
  let busy = false;
  /** The Claude log a new thread starts with, given to its first turn. */
  let preamble: string | null = null;
  let turnStarted = 0;
  let stopping = false;
  let timedOut = false;
  let inputEnded = false;
  /** Steers sent and not yet answered: one Codex refuses still starts a turn, so the run can't end before it's answered. */
  let steering = 0;
  let lastText = '';
  let rateLimits: CodexLimits | null = null;
  let usage: CodexParams['tokenUsage'] = undefined;
  const errors: string[] = [];
  const queue: QueuedLine[] = [];
  const mcpStatus = new Map<string, string>();
  let quiet: NodeJS.Timeout;
  const finish = (code: number) => {
    child.stdin!.end();
    child.kill('SIGTERM');
    unlock();
    process.exit(code);
  };
  const quietMs = Number(env.CITADEL_CODEX_QUIET_MS) || QUIET_MS; // shorter in tests
  const heard = () => {
    clearTimeout(quiet);
    quiet = setTimeout(() => {
      timedOut = true;
      out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `Codex sent nothing for ${Math.round(quietMs / 60_000)} minutes, so the turn was stopped.`, duration_ms: Date.now() - turnStarted, num_turns: 1 });
      if (turnId) call('turn/interrupt', { threadId, turnId }).catch(() => {});
      setTimeout(() => finish(1), 3000);
    }, quietMs);
  };

  const taken = (q: QueuedLine) => {
    if (replay) out({ ...q.line, isReplay: true });
  };
  const startTurn = async (q: QueuedLine) => {
    busy = true;
    const text =
      typeof q.content === 'string'
        ? q.content
        : (q.content ?? [])
            .filter((b) => b?.type === 'text' && !isTurnNote(String(b.text ?? '')))
            .map((b) => b.text)
            .join('\n');
    log(`[Message] ${text}`);
    const input = [...(preamble ? [{ type: 'text', text: preamble, text_elements: [] }] : []), ...codexInput(q.content)];
    preamble = null;
    turnStarted = Date.now();
    lastText = '';
    const r = await call('turn/start', { threadId, input, model, ...(effort ? { effort } : {}) });
    if (busy && !turnId) turnId = r?.turn?.id ?? null;
    taken(q);
  };
  const userLine = async (line: ClaudeEvent) => {
    const q = { content: line.message?.content, uuid: line.uuid, line };
    if (!threadId || (busy && !turnId)) return void queue.push(q);
    if (!busy) return void startTurn(q).catch(fail);
    steering++;
    try {
      await call('turn/steer', { threadId, input: codexInput(q.content), expectedTurnId: turnId });
      log(
        `[Message] ${
          typeof q.content === 'string'
            ? q.content
            : codexInput(q.content)
                .map((i) => i.text ?? '[image]')
                .join('\n')
        }`,
      );
      taken(q);
    } catch {
      // The turn ended while the steer was on its way: nothing else would start the next turn.
      if (!busy) return void startTurn(q).catch(fail);
      queue.push(q); // not steerable now: it starts the next turn
    } finally {
      steering--;
      if (inputEnded && !busy && !queue.length && !steering) finish(0);
    }
  };
  const fail = (err: Error) => {
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: err.message, duration_ms: turnStarted ? Date.now() - turnStarted : 0, num_turns: 0 });
    finish(1);
  };

  const assistant = (id: string, content: object[]) => out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model, content }, parent_tool_use_id: null });
  const result = (id: string, content: unknown, isError: boolean) => out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, parent_tool_use_id: null });
  const started = new Set<string>();
  const use = (item: CodexItem, name: string, input: object) => {
    if (started.has(item.id)) return;
    started.add(item.id);
    assistant(`msg_${item.id}`, [{ type: 'tool_use', id: item.id, name, input }]);
    log(callLine(name, input));
  };
  const onItem = (item: CodexItem | undefined, done: boolean) => {
    switch (item?.type) {
      case 'agentMessage':
        if (!done && partial) out({ type: 'stream_event', event: { type: 'message_start', message: { id: item.id } }, parent_tool_use_id: null });
        if (done && String(item.text ?? '').trim()) {
          lastText = String(item.text);
          assistant(item.id, [{ type: 'text', text: lastText }]);
          log(`[Codex] ${lastText}`);
        }
        return;
      case 'commandExecution':
        use(item, 'Bash', { command: String(item.command ?? '') });
        if (done) {
          const text = String(item.aggregatedOutput ?? '');
          result(item.id, text, item.status !== 'completed' || (item.exitCode ?? 0) !== 0);
          log(text, true);
        }
        return;
      case 'fileChange': {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        use(item, 'apply_patch', { files: changes.map((ch) => `${(typeof ch.kind === 'string' ? undefined : ch.kind?.type) ?? ch.kind ?? 'update'} ${ch.path}`) });
        if (done) {
          const text = changes.map((ch) => `${ch.path}\n${ch.diff ?? ''}`).join('\n');
          result(item.id, text, item.status !== 'completed');
          log(text, true);
        }
        return;
      }
      case 'mcpToolCall':
        use(item, `mcp__${item.server}__${item.tool}`, item.arguments ?? {});
        if (done) {
          const content = item.error ? String(item.error.message ?? 'failed') : ((item.result as { content?: CodexContent[] } | undefined)?.content ?? []);
          result(item.id, content, !!item.error);
          log(typeof content === 'string' ? content : content.map((b) => (b?.type === 'text' ? b.text : `[${b?.type}]`)).join('\n'), true);
        }
        return;
      case 'webSearch':
        use(item, 'WebSearch', { query: String(item.query ?? '') });
        if (done) result(item.id, 'searched', false);
        return;
      case 'imageView':
        use(item, 'Read', { file_path: String(item.path ?? '') });
        if (done) result(item.id, '[image]', false);
        return;
      case 'imageGeneration': {
        // Codex saves the file in its own folder (savedPath), outside the worktree: copy it in so the reply can link it.
        // shortcut: the field names (revisedPrompt, savedPath, result as base64) match 0.166.0's app-server schema (#733), not a captured turn; check them on the first real one.
        use(item, 'GenerateImage', { prompt: String(item.revisedPrompt ?? item.prompt ?? '') });
        if (!done) return;
        try {
          const dir = join(cwd, 'generated');
          mkdirSync(dir, { recursive: true });
          const to = join(dir, typeof item.savedPath === 'string' && item.savedPath ? basename(item.savedPath) : `${String(item.id).replace(/[^\w.-]/g, '_')}.png`);
          saveGenerated(item, to);
          result(item.id, `Saved ${to}`, false);
          log(`Saved ${to}`, true);
        } catch (e) {
          result(item.id, (e as Error).message, true);
          log((e as Error).message, true);
        }
        return;
      }
    }
  };
  let hookCalls = 0;
  let sentLimits = '';
  /** Codex's usage windows, passed on when they say something new. */
  const limits = (l: CodexLimits | null | undefined) => {
    if (!l || (!l.primary && !l.secondary)) return;
    rateLimits = l;
    const j = JSON.stringify({ primary: l.primary, secondary: l.secondary, reached: l.rateLimitReachedType });
    if (j === sentLimits) return;
    sentLimits = j;
    out({ type: 'codex_rate_limits', rate_limits: l });
  };
  const onMessage = (m: CodexMessage) => {
    const p = m.params ?? {};
    switch (m.method) {
      case 'item/started':
        return onItem(p.item, false);
      case 'item/completed':
        return onItem(p.item, true);
      case 'item/agentMessage/delta':
        if (partial && typeof p.delta === 'string') out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: p.delta } }, parent_tool_use_id: null });
        return;
      case 'hook/completed': {
        // A tripwire block: the call never runs, so it has no item; show it as Claude shows a hook's block.
        if (p.run?.status !== 'blocked') return;
        const id = `hook_${++hookCalls}`;
        const why = (p.run.entries ?? []).map((e) => e.text).join('\n') || p.run.statusMessage || 'Blocked by the tripwire.';
        assistant(`msg_${id}`, [{ type: 'tool_use', id, name: 'Tripwire', input: { blocked: true } }]);
        result(id, why, true);
        log(`[Tripwire] ${why}`, true);
        return;
      }
      case 'turn/plan/updated': {
        const status = (s: string | undefined) => (s === 'inProgress' || s === 'in_progress' ? 'in_progress' : s === 'completed' ? 'completed' : 'pending');
        const todos = (p.plan ?? []).map((s) => ({ content: String(s.step), activeForm: String(s.step), status: status(s.status) }));
        assistant(`msg_plan_${Date.now()}`, [{ type: 'tool_use', id: `plan_${Date.now()}`, name: 'TodoWrite', input: { todos } }]);
        return;
      }
      case 'thread/tokenUsage/updated':
        usage = p.tokenUsage;
        return;
      case 'account/rateLimits/updated':
        return limits(p.rateLimits);
      case 'mcpServer/startupStatus/updated':
        if (typeof p.name === 'string') mcpStatus.set(p.name, String(p.status));
        return;
      case 'error':
        if (!p.willRetry) errors.push(String(p.error?.message ?? 'unknown error'));
        return;
      case 'turn/started':
        if (busy && !turnId) turnId = p.turn?.id ?? null;
        return;
      case 'turn/completed': {
        const turn: CodexTurn = p.turn ?? {};
        turnId = null;
        busy = false;
        if (stopping) return finish(143);
        if (timedOut) return finish(1); // its result is out already
        const u = usage?.last;
        const base = { duration_ms: Date.now() - turnStarted, num_turns: 1, ...(u ? { usage: { input_tokens: u.inputTokens - u.cachedInputTokens, cache_read_input_tokens: u.cachedInputTokens, cache_creation_input_tokens: u.cacheWriteInputTokens ?? 0, output_tokens: u.outputTokens } } : {}) };
        if (turn.status === 'completed') out({ type: 'result', subtype: 'success', is_error: false, result: lastText, ...base });
        else {
          const kind = errorKind(turn.error?.codexErrorInfo);
          const why = kind === 'usageLimitExceeded' ? limitWords(rateLimits) : `Codex: ${turn.error?.message || errors.join('; ') || `the turn ended ${turn.status ?? 'without a status'}`}`;
          out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: why, ...base });
        }
        errors.length = 0;
        const next = queue.shift();
        if (next) return void startTurn(next).catch(fail);
        if (inputEnded && !steering) finish(0);
        return;
      }
    }
  };

  let buf = '';
  child.stdout!.setEncoding('utf8');
  child.stdout!.on('data', (chunk: string) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m: CodexMessage;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      heard();
      if (m.id !== undefined && m.method === undefined) {
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
      } else if (m.id !== undefined) {
        // Requests from Codex: nobody can answer an approval here (the tripwire hook already checked the call).
        if (/requestApproval$|^(applyPatch|execCommand)Approval$/.test(m.method!)) send({ id: m.id, result: { decision: 'decline' } });
        else if (m.method === 'mcpServer/elicitation/request') send({ id: m.id, result: { action: 'decline' } });
        else send({ id: m.id, error: { code: -32601, message: `${m.method} isn't available in a Citadel turn` } });
      } else onMessage(m);
    }
  });
  child.on('error', (err) => fail(new Error(`Couldn't start Codex: ${err.message}`)));
  child.on('exit', (code) => {
    if (stopping) process.exit(143);
    fail(new Error(`codex app-server exited (${code}) before the turn finished.`));
  });
  process.on('SIGTERM', () => {
    stopping = true;
    if (!turnId) return finish(143);
    call('turn/interrupt', { threadId, turnId }).catch(() => finish(143));
    setTimeout(() => finish(143), 5000).unref();
  });

  // Claude's stdin protocol: one user line per message; steers arrive mid-turn; the end of input ends the run once the turn is done.
  let inBuf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    inBuf += chunk;
    let nl;
    while ((nl = inBuf.indexOf('\n')) >= 0) {
      const line = inBuf.slice(0, nl).trim();
      inBuf = inBuf.slice(nl + 1);
      try {
        const ev = line ? JSON.parse(line) : null;
        if (ev?.type === 'user') void userLine(ev);
      } catch {}
    }
  });
  process.stdin.on('end', () => {
    inputEnded = true;
    if (threadId && !busy && !queue.length && !steering) finish(0);
  });

  try {
    heard();
    await call('initialize', { clientInfo: { name: 'citadel-codex-turn', version: '1' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    send({ method: 'initialized' });
    call('account/rateLimits/read', {}).then(
      (r) => limits(r?.rateLimits),
      () => {},
    );
    const thread = { cwd, model, approvalPolicy: 'never', sandbox: 'danger-full-access', config: mcp.config, developerInstructions };
    const resume = one('--codex-thread');
    let fresh = !resume;
    let r: CodexResult | null = null;
    if (resume) r = await call('thread/resume', { threadId: resume, ...thread }).catch(() => null);
    if (!r) {
      fresh = true;
      r = await call('thread/start', thread);
    }
    threadId = r.thread!.id;
    out({ type: 'system', subtype: 'init', model, cwd, codex_thread: threadId, mcp_servers: mcp.names.map((name) => ({ name, status: mcpStatus.get(name) === 'failed' ? 'failed' : 'connected' })), tools: [], ...(resume && fresh ? { codex_resume_failed: resume } : {}) });
    const handover = one('--codex-handover');
    const handoverLog = fresh && handover && existsSync(handover) ? readFileSync(handover, 'utf8').trim() : '';
    if (handoverLog) preamble = toCodexPreamble(handoverLog);
    // Messages that came while the thread started wait here; later ones start their own turns or steer.
    const first = queue.shift();
    if (first) await startTurn(first);
    else if (inputEnded) finish(0);
  } catch (err) {
    fail(err as Error);
  }
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  await main(process.argv.slice(2)).catch((err) => {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: `The Codex turn couldn't start: ${err?.message ?? err}`, duration_ms: 0, num_turns: 0 }) + '\n');
    process.exit(1);
  });
}
