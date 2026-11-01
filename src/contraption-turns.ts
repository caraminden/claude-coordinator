// The turn API's engine (shared/project/specs/contraptions/citadel-apps-brief.md, section 4): runs one
// Claude turn for a contraption, for one of its people, on that person's own Claude (their container, or
// the host for the server login's owner, as their minion turns do), and hands back its events.
//
// A turn can reach only the contraption's own MCP servers (on its 127.0.0.1 port; containers share the
// host's network) and, if the contraption allows, Agent with a cap on how many run at once. It runs in an
// empty scratch folder per (contraption, person), with no user or project settings, CLAUDE.md, memory,
// skills, plugins or other MCP servers: see args() and settings().
//
// Citadel keeps no turn content: the prompt, the contraption's system prompt and its MCP headers sit in a
// private turn folder that is deleted when the turn ends, and only the meter (src/db.ts contraption_turns)
// and the session names are stored. The transcript is the person's own Claude session, in their folder.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AUTH_VARS, isAuthFailure, resolveClaude, type TurnPlace } from './claude-link.ts';
import type { Contraptions } from './contraptions.ts';
import type { ContraptionRow, Store } from './db.ts';
import { USAGE_LIMIT, turnEnv } from './runner.ts';
import { claudeConfigDir, projectSlug } from './sessions.ts';

/** Read once at load, like the runner's pinned files: a deploy doesn't change the hook under a running server. */
const AGENT_CAP = readFileSync(join(import.meta.dirname, 'contraption-agent-cap.ts'), 'utf8');

export type TurnErrorCode = 'not_enabled' | 'no_plan' | 'limit' | 'busy' | 'timeout' | 'canceled' | 'bad_request' | 'failed';

export class TurnError extends Error {
  code: TurnErrorCode;
  constructor(code: TurnErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface McpServer {
  name: string;
  path: string;
  headers: Record<string, string>;
}

/** A checked start-turn request. */
export interface TurnRequest {
  person: number;
  session: string;
  fresh: boolean;
  prompt: string;
  system: string;
  model: string | null;
  compactWindow: number;
  mcp: McpServer[];
  agents: { max: number; model: string | null } | false;
  timeoutSec: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One reply event: start, text, tool, tool_result, compacted, end or error. */
export type Emit = (event: string, data: object) => void;

export const DEFAULT_COMPACT_WINDOW = 40_000;
export const DEFAULT_TIMEOUT_SEC = 180;
const SESSION_NAME = /^[\w.:@-]{1,100}$/;
const MODEL = /^[\w.\[\]-]{1,60}$/;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,40}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;

function bad(message: string): never {
  throw new TurnError('bad_request', message);
}

function int(v: unknown, what: string, min: number, max: number, fallback: number): number {
  if (v === undefined || v === null) return fallback;
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) bad(`${what} must be a whole number from ${min} to ${max}`);
  return v as number;
}

/** Check a start-turn body, filling in the registry's defaults. */
export function parseTurn(body: any, c: Pick<ContraptionRow, 'default_model'>): TurnRequest {
  if (!body || typeof body !== 'object') bad('Send a JSON object');
  if (!Number.isInteger(body.person) || body.person < 1) bad('person must be a person\'s id');
  if (typeof body.session !== 'string' || !SESSION_NAME.test(body.session)) bad('session must be a name of letters, digits and . _ : @ -, at most 100');
  if (body.fresh !== undefined && typeof body.fresh !== 'boolean') bad('fresh must be true or false');
  if (typeof body.prompt !== 'string' || !body.prompt.trim()) bad('prompt is required');
  if (body.system !== undefined && typeof body.system !== 'string') bad('system must be text');
  const model = body.model ?? c.default_model ?? null;
  if (model !== null && (typeof model !== 'string' || !MODEL.test(model))) bad('model must be a model name like haiku');
  if (body.mcp !== undefined && (!Array.isArray(body.mcp) || body.mcp.length > 10)) bad('mcp must be a list of at most 10 servers');
  const mcp: McpServer[] = [];
  for (const s of body.mcp ?? []) {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !SERVER_NAME.test(s.name)) bad('Each mcp server needs a name of letters, digits, _ and -');
    if (mcp.some((m) => m.name === s.name)) bad(`Two mcp servers are called ${s.name}`);
    if (typeof s.path !== 'string' || !/^\/[\x21-\x7e]{0,199}$/.test(s.path)) bad('Each mcp server needs a path on the contraption\'s port, starting with /');
    if (s.headers !== undefined && (!s.headers || typeof s.headers !== 'object' || Array.isArray(s.headers))) bad('mcp headers must be an object');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(s.headers ?? {})) {
      if (!HEADER_NAME.test(k) || typeof v !== 'string' || v.length > 8192 || /[\r\n\0]/.test(v)) bad(`mcp header ${k.slice(0, 100)} isn't a plain header`);
      headers[k] = v;
    }
    mcp.push({ name: s.name, path: s.path, headers });
  }
  let agents: TurnRequest['agents'] = false;
  if (body.agents !== undefined && body.agents !== false) {
    const a = body.agents;
    if (!a || typeof a !== 'object') bad('agents must be { max, model } or false');
    if (a.model !== undefined && (typeof a.model !== 'string' || !MODEL.test(a.model))) bad('agents.model must be a model name like haiku');
    agents = { max: int(a.max, 'agents.max', 1, 10, 1), model: a.model ?? null };
  }
  return {
    person: body.person, session: body.session, fresh: body.fresh === true, prompt: body.prompt, system: body.system ?? '', model,
    compactWindow: int(body.compactWindow, 'compactWindow', 10_000, 1_000_000, DEFAULT_COMPACT_WINDOW), mcp, agents,
    timeoutSec: int(body.timeoutSec, 'timeoutSec', 1, 900, DEFAULT_TIMEOUT_SEC),
  };
}

/** The `claude` arguments for a turn: only the contraption's MCP servers and (maybe) Agent, nothing of the user's or Citadel's. */
export function args(req: TurnRequest, dir: string, claudeSession: string, resume: boolean): string[] {
  const a = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    // No user, project or local settings: no CLAUDE.md, hooks, plugins, permissions or MCP servers of theirs.
    '--setting-sources', '',
    // The built-in tools: Agent or none. Subagents get no more than this.
    '--tools', req.agents ? 'Agent' : '',
    '--strict-mcp-config', '--mcp-config', join(dir, 'mcp.json'),
    '--settings', join(dir, 'settings.json'),
    '--permission-mode', 'dontAsk',
    '--disable-slash-commands',
  ];
  if (req.system) a.push('--append-system-prompt-file', join(dir, 'system.md'));
  if (req.model) a.push('--model', req.model);
  a.push(resume ? '--resume' : '--session-id', claudeSession);
  return a;
}

/** The contraption's MCP servers as `--mcp-config` takes them: HTTP on its own port, headers as sent. */
export function mcpConfig(port: number, servers: McpServer[]) {
  return { mcpServers: Object.fromEntries(servers.map((s) => [s.name, { type: 'http', url: `http://127.0.0.1:${port}${s.path}`, headers: s.headers }])) };
}

/** The turn's --settings: what it may use, where it compacts, and the Agent cap's hook. */
export function settings(req: TurnRequest, hook: { node: string; script: string; slots: string } | null) {
  const allow = req.mcp.map((s) => `mcp__${s.name}`);
  if (req.agents) allow.push('Agent');
  const out: Record<string, unknown> = {
    permissions: { allow, defaultMode: 'dontAsk' },
    autoCompactWindow: req.compactWindow,
    autoMemoryEnabled: false,
    syncClaudeAiSkills: false,
    disableClaudeAiConnectors: true,
    enableAllProjectMcpServers: false,
  };
  if (req.agents && hook) {
    const command = [hook.node, hook.script, hook.slots, String(req.agents.max)].map((s) => `'${s}'`).join(' ');
    const on = [{ matcher: '^(Agent|Task)$', hooks: [{ type: 'command', command, timeout: 10 }] }];
    out.hooks = { PreToolUse: on, PostToolUse: on, PostToolUseFailure: on };
  }
  return out;
}

/** Midnight today, server time: turn_cap counts from here. */
function dayStart(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

interface Live {
  id: number;
  contraption: number;
  person: number;
  session: string;
  container: string | null;
  child: ChildProcess | null;
  pidFile: string;
  /** Why Citadel stopped it, if it did. */
  stopped: 'timeout' | 'canceled' | null;
}

export interface ClaudePlaces {
  place(uid: number | null): TurnPlace | null;
  expire(uid: number): void;
}

export class ContraptionTurns {
  private store: Store;
  private contraptions: Contraptions;
  private claude: ClaudePlaces;
  private dataDir: string;
  private claudeBin: string;
  private podman: string;
  private env: NodeJS.ProcessEnv;
  /** Running turns by id. */
  private live = new Map<number, Live>();
  /** Busy session names: contraption id / person / name. */
  private names = new Set<string>();
  /** A preview (a copy of the data) never runs turns. */
  noTurns = false;

  constructor(store: Store, contraptions: Contraptions, claude: ClaudePlaces, opts: { dataDir: string; claudeBin: string; podman?: string; env?: NodeJS.ProcessEnv }) {
    this.store = store;
    this.contraptions = contraptions;
    this.claude = claude;
    this.dataDir = opts.dataDir;
    this.claudeBin = opts.claudeBin;
    this.podman = opts.podman ?? 'podman';
    this.env = opts.env ?? process.env;
    // No turn outlives the server: drop what a crash left behind.
    rmSync(join(this.dataDir, 'run', 'contraption-turns'), { recursive: true, force: true });
  }

  /** Turns running now, which a restart would cut off. */
  running(): number {
    return this.live.size;
  }

  /** Turns running in a container now (it isn't restarted under them). */
  inContainer(container: string): number {
    return [...this.live.values()].filter((t) => t.container === container).length;
  }

  private key(contraption: number, person: number, name: string) {
    return `${contraption}/${person}/${name}`;
  }

  /** Where a person's turns for a contraption run, as claude sees it and as this server sees it. */
  private scratch(c: ContraptionRow, person: number, place: TurnPlace) {
    // In a container its home is the person's volume, at the host's home path; the volume holds only their own.
    if (place.host) {
      // Not DATA_DIR/contraptions: a dev copy keeps contraptions' key folders there.
      const dir = join(this.dataDir, 'contraption-scratch', c.name, String(person));
      return { cwd: dir, onHost: dir, configDir: claudeConfigDir(this.env) };
    }
    const rel = join('.citadel', 'contraption-scratch', c.name);
    return { cwd: join(homedir(), rel), onHost: join(dirname(place.configDir), rel), configDir: place.configDir };
  }

  /**
   * A turn's private folder (its prompt, the contraption's system prompt and MCP tokens), as this server
   * sees it and as claude does. Never under run/turns, which every person's container mounts.
   */
  private turnDir(id: number, place: TurnPlace) {
    if (place.host) {
      const dir = join(this.dataDir, 'run', 'contraption-turns', String(id));
      return { onHost: dir, inside: dir };
    }
    const rel = join('.citadel', 'contraption-turns', String(id));
    return { onHost: join(dirname(place.configDir), rel), inside: join(homedir(), rel) };
  }

  /** A Claude session's transcript, as this server sees it. */
  private transcript(configDir: string, cwd: string, claudeSession: string) {
    return join(configDir, 'projects', projectSlug(cwd), `${claudeSession}.jsonl`);
  }

  /** Delete a Claude session's transcript and its subagents' from the person's Claude folder. */
  private dropTranscript(where: { configDir: string; cwd: string }, claudeSession: string) {
    const file = this.transcript(where.configDir, where.cwd, claudeSession);
    rmSync(file, { force: true });
    rmSync(file.replace(/\.jsonl$/, ''), { recursive: true, force: true });
  }

  /**
   * Run a turn, calling `emit` with its events, and resolve once it has ended (its last event is end or
   * error). Refusals are an error event too. Its start event carries the turn's id, for cancel().
   */
  async run(c: ContraptionRow, req: TurnRequest, emit: Emit): Promise<void> {
    const fail = (code: TurnErrorCode, message: string) => emit('error', { code, message });
    if (this.noTurns) return fail('failed', 'This is a preview of Citadel: it never runs turns');
    if (!this.contraptions.enabled(c.name, req.person)) return fail('not_enabled', `${c.title} isn't enabled for this person`);
    const key = this.key(c.id, req.person, req.session);
    if (this.names.has(key)) return fail('busy', `A turn is already running in ${req.session}`);
    if (c.turn_cap && this.store.contraptionTurnsSince(c.id, req.person, dayStart()) >= c.turn_cap) return fail('limit', `${c.title}'s cap of ${c.turn_cap} turns a day is used up for this person`);
    const place = this.claude.place(req.person);
    if (!place) return fail('no_plan', 'This person hasn\'t linked their Claude in Citadel (Settings → Claude), or it needs linking again');

    this.names.add(key);
    const id = this.store.startContraptionTurn(c.id, req.person, req.session);
    const dir = this.turnDir(id, place);
    const live: Live = { id, contraption: c.id, person: req.person, session: req.session, container: place.host ? null : place.container, child: null, pidFile: join(dir.onHost, 'pid'), stopped: null };
    this.live.set(id, live);
    let outcome: string = 'failed';
    let usage: Usage | null = null;
    try {
      ({ outcome, usage } = await this.turn(c, req, place, live, dir, emit));
    } catch (err: any) {
      fail('failed', String(err?.message ?? err).slice(0, 300));
    } finally {
      this.live.delete(id);
      this.names.delete(key);
      rmSync(dir.onHost, { recursive: true, force: true });
      this.store.endContraptionTurn(id, outcome, usage);
    }
  }

  private async turn(c: ContraptionRow, req: TurnRequest, place: TurnPlace, live: Live, dir: { onHost: string; inside: string }, emit: Emit): Promise<{ outcome: string; usage: Usage | null }> {
    const where = this.scratch(c, req.person, place);
    mkdirSync(where.onHost, { recursive: true });
    // Resume the name's session unless asked for a fresh one, or its transcript is gone (a relinked Claude).
    const known = this.store.contraptionSession(c.id, req.person, req.session);
    const resume = !!known && !req.fresh && existsSync(this.transcript(where.configDir, where.cwd, known.claude_session));
    const claudeSession = resume ? known!.claude_session : randomUUID();
    // The name can never get back to the session it leaves, so that session's transcript goes.
    if (known && !resume) this.dropTranscript(where, known.claude_session);
    this.store.putContraptionSession(c.id, req.person, req.session, claudeSession);

    // Private: it holds the prompt, the contraption's system prompt and its MCP tokens until the turn ends.
    mkdirSync(dir.onHost, { recursive: true, mode: 0o700 });
    mkdirSync(join(dir.onHost, 'slots'), { mode: 0o700 });
    mkdirSync(join(dir.onHost, 'tmp'));
    const secret = (name: string, text: string) => writeFileSync(join(dir.onHost, name), text, { mode: 0o600 });
    secret('mcp.json', JSON.stringify(mcpConfig(c.port, req.mcp)));
    if (req.system) secret('system.md', req.system);
    let hook = null;
    if (req.agents) {
      secret('agent-cap.ts', AGENT_CAP);
      hook = { node: process.execPath, script: join(dir.inside, 'agent-cap.ts'), slots: join(dir.inside, 'slots') };
    }
    secret('settings.json', JSON.stringify(settings(req, hook)));

    const tmp = join(dir.inside, 'tmp');
    let env: Record<string, string> = {
      ...turnEnv(this.env), TMPDIR: tmp, TMP: tmp, TEMP: tmp, CLAUDE_CODE_TMPDIR: tmp,
      // Belt and braces with --setting-sources '': no CLAUDE.md or auto-memory, and Agent calls wait for their agent (the cap's hook counts on it).
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', DISABLE_AUTOUPDATER: '1',
    };
    delete env.SSH_AUTH_SOCK;
    if (req.agents && (req.agents.model ?? req.model)) env.CLAUDE_CODE_SUBAGENT_MODEL = (req.agents.model ?? req.model)!;
    const argv = args(req, dir.inside, claudeSession, resume);
    let cmd: string;
    let cmdArgs: string[];
    if (place.host) {
      [cmd, cmdArgs] = [this.claudeBin, argv];
    } else {
      // The person's own sign-in, so nothing of the server's may win over it.
      for (const v of AUTH_VARS) delete env[v];
      env = { ...env, ...place.env, XDG_RUNTIME_DIR: tmp };
      await place.ensure();
      // `exec` keeps the pid, written first, so a cancel can signal claude inside the container.
      cmd = this.podman;
      cmdArgs = ['exec', '-i', '-w', where.cwd, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), place.container,
        'sh', '-c', 'echo $$ > "$0"; exec "$@"', join(dir.inside, 'pid'), resolveClaude(this.claudeBin), ...argv];
    }
    if (live.stopped) return { outcome: live.stopped, usage: null };

    const child = spawn(cmd, cmdArgs, { cwd: place.host ? where.cwd : undefined, env: place.host ? env : turnEnv(this.env), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    live.child = child;
    emit('start', { turn: live.id, session: req.session, claudeSession });
    child.stdin!.on('error', () => {});
    child.stdin!.end(req.prompt);
    const timer = setTimeout(() => this.stop(live, 'timeout'), req.timeoutSec * 1000);

    let result: any = null;
    let stderr = '';
    const streamed = new Map<string, string>();
    const said = new Map<string, string>();
    let message = '';
    const handle = (ev: any) => {
      if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string' && ev.session_id !== claudeSession) {
        this.store.putContraptionSession(c.id, req.person, req.session, ev.session_id);
      } else if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
        emit('compacted', {});
      } else if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
        const e = ev.event;
        if (e?.type === 'message_start') message = String(e.message?.id ?? '');
        else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
          streamed.set(message, (streamed.get(message) ?? '') + e.delta.text);
          emit('text', { delta: e.delta.text });
        }
      } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        const mid = String(ev.message.id ?? '');
        for (const b of ev.message.content) {
          if (b?.type === 'tool_use') emit('tool', { id: b.id, name: b.name, input: b.input });
          else if (b?.type === 'text' && !ev.parent_tool_use_id && typeof b.text === 'string') {
            // Text the partial stream missed (it is off, or cut short): the rest of it, once.
            const all = (said.get(mid) ?? '') + b.text;
            said.set(mid, all);
            const sent = streamed.get(mid) ?? '';
            if (all.length > sent.length && all.startsWith(sent)) {
              emit('text', { delta: all.slice(sent.length) });
              streamed.set(mid, all);
            }
          }
        }
      } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) if (b?.type === 'tool_result') emit('tool_result', { id: b.tool_use_id, ok: !b.is_error });
      } else if (ev.type === 'result') {
        result = ev;
      }
    };
    let buf = '';
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          handle(JSON.parse(line));
        } catch {
          // Not stream-json: claude printed something else.
        }
      }
    });
    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-2000)));
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        stderr += err.message;
        resolve(null);
      });
      child.on('close', (n) => resolve(n));
    });
    clearTimeout(timer);

    const u = result?.usage;
    const usage: Usage | null = u ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 } : null;
    const error = (code: TurnErrorCode, message: string) => {
      emit('error', { code, message });
      return { outcome: code, usage };
    };
    if (live.stopped === 'timeout') return error('timeout', `The turn ran past ${req.timeoutSec} seconds and was stopped`);
    if (live.stopped === 'canceled') return error('canceled', 'The turn was stopped');
    if (result && !result.is_error) {
      emit('end', { stop: result.stop_reason ?? result.subtype ?? 'end_turn', usage: usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      return { outcome: 'end', usage };
    }
    const why = [typeof result?.result === 'string' ? result.result : '', ...(Array.isArray(result?.errors) ? result.errors.map(String) : []), stderr].join('\n').trim();
    if (USAGE_LIMIT.test(why)) return error('limit', why.split('\n')[0].slice(0, 300));
    if (isAuthFailure(why)) {
      if (!place.host) this.claude.expire(req.person);
      return error('no_plan', 'This person\'s Claude sign-in was refused: they need to link it again in Citadel');
    }
    return error('failed', `Claude ended without a reply (exit ${code ?? 'unknown'})${why ? `: ${why.split('\n').filter(Boolean).at(-1)!.slice(0, 300)}` : ''}`);
  }

  /** Stop a running turn: its process group on the host, claude itself in a container. */
  private stop(live: Live, why: 'timeout' | 'canceled') {
    if (live.stopped) return;
    live.stopped = why;
    const child = live.child;
    if (!child?.pid) return; // not started yet: turn() sees `stopped` before it spawns
    if (live.container) {
      let pid = '';
      try {
        pid = readFileSync(live.pidFile, 'utf8').trim();
      } catch {}
      if (/^\d+$/.test(pid)) spawn(this.podman, ['exec', live.container, 'kill', '-TERM', pid], { stdio: 'ignore' }).on('error', () => {});
    }
    const kill = (sig: NodeJS.Signals) => {
      try {
        process.kill(-child.pid!, sig);
      } catch {}
    };
    kill('SIGTERM');
    setTimeout(() => child.exitCode === null && child.signalCode === null && kill('SIGKILL'), 5_000).unref();
  }

  /** Cancel a contraption's own running turn; false when it has no such turn running. */
  cancel(contraption: number, turn: number): boolean {
    const live = this.live.get(turn);
    if (!live || live.contraption !== contraption) return false;
    this.stop(live, 'canceled');
    return true;
  }

  /** A person's sessions in a contraption: names, when last used, and whether a turn runs in one now. */
  sessions(contraption: number, person: number) {
    return this.store.contraptionSessions(contraption, person).map((s) => ({ name: s.name, lastUsed: s.used_at, busy: this.names.has(this.key(contraption, person, s.name)) }));
  }

  /**
   * Forget a session name and delete its transcript from the person's Claude folder. With their sign-in
   * expired there's no folder to reach, so the transcript stays in their own volume.
   */
  deleteSession(c: ContraptionRow, person: number, name: string): 'deleted' | 'busy' | 'missing' {
    if (this.names.has(this.key(c.id, person, name))) return 'busy';
    const s = this.store.contraptionSession(c.id, person, name);
    if (!s) return 'missing';
    const place = this.claude.place(person);
    if (place) this.dropTranscript(this.scratch(c, person, place), s.claude_session);
    this.store.deleteContraptionSession(c.id, person, name);
    return 'deleted';
  }
}
