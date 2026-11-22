// The turn API's engine (shared/project/specs/contraptions/citadel-apps-brief.md, section 4): runs one
// Claude turn for a contraption, for one of its people, on that person's own Claude (their container, or
// the host for the server login's owner, as their minion turns do), and hands back its events.
//
// A turn can reach only the contraption's own MCP servers (on its 127.0.0.1 port; containers share the
// host's network), the MCP servers of its person's own machines that are online (#306), and, if the
// contraption allows, Agent with a cap on how many run at once, and WebSearch and WebFetch if it asks
// (#332). It runs in an empty scratch folder per (contraption, person), with no user or project
// settings, CLAUDE.md, memory, skills, plugins or other MCP servers: see args() and settings().
//
// The prompt, the contraption's system prompt and its MCP headers sit in a private turn folder that is deleted
// when the turn ends. The meter (src/db.ts contraption_turns) and the session names hold no turn text. The one
// place that does is the audit (#844, contraption_turn_audit): the system text, prompt and reply as the model got
// and gave them, never tool calls or MCP headers, for the home scheme's members to read, kept AUDIT_DAYS. The
// transcript is the person's own Claude session, in their folder.
// The other is a turn the app sends with `keep: true` (#836): src/replay-keep.ts keeps the session's first few turns
// in the app's home scheme's shared folder for replay tests, unless the person opted out.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AUTH_VARS, isAuthFailure, resolveClaude, type TurnPlace } from './claude-link.ts';
import type { Contraptions } from './contraptions.ts';
import type { ContraptionRow, Store } from './db.ts';
import { blockText, claudeParts, codexModelFor, codexSwitchKey, fitLog, isCodexModel, readParts, toClaudePreamble, CODEX_WAITING } from './codex.ts';
import { USAGE_LIMIT, turnEnv, tripwireConfig } from './turn-launch.ts';
import { clockTime, parseResetTime, ZONE } from './pacific.ts';
import { realClock, type Clock } from './clock.ts';
import type { ImageBlock } from './turn-images.ts';
import { type CodexAt, type MediaTurn } from './contraption-media.ts';
import { suggestTools, unknownToolName } from './tool-suggest.ts';
import { args, mcpConfig, settings, toolNamesPrompt, userLine, MEDIA_SERVER } from './contraption-args.ts';
import { keepTurn, keptDir, keptFile, dropKeptSession, optOutKey, sha256, cap, wantsKeep, type KeptCall } from './replay-keep.ts';
import { claudeConfigDir, projectSlug, transcriptPath, validSessionId } from './sessions.ts';

/** Read once at load, like the runner's pinned files: a deploy doesn't change the hook under a running server. */
const AGENT_CAP = readFileSync(join(import.meta.dirname, 'contraption-agent-cap.ts'), 'utf8');
/** The stdio stand-in for a machine's MCP server, as minion turns use it (src/machine-mcp.ts). */
const MACHINE_MCP = readFileSync(join(import.meta.dirname, 'machine-mcp.ts'), 'utf8');
// A Codex turn (#337) runs the shim from its own folder in the container, and Codex's managed hook imports the tripwire from there.
const CODEX_FILES = ['codex-turn.ts', 'codex-lock.ts', 'codex.ts', 'tripwire.ts', 'tripwire-base.ts', 'tripwire-git.ts'].map((f) => [f, readFileSync(join(import.meta.dirname, f), 'utf8')] as const);

/** A contraption session's Codex thread while its turns run on Codex: dropped on the first Claude turn after, or a fresh session. */
const codexKey = (c: number, person: number, session: string) => `codex:contraption:${c}:${person}:${session}`;
/**
 * Set while a session's newest turn ended `interrupted` (#1382): the next cut in a row offers no retry, so an app that
 * retries on its own can't loop (one resume per kill, as #1364's minion turns). A setting, so it outlives the restart that cut it.
 */
const cutKey = (c: number, person: number, session: string) => `cut:contraption:${c}:${person}:${session}`;
interface CodexSession {
  thread: string | null;
}
/**
 * The session's Codex turns as log parts, for the way back to Claude: in the person's own volume beside the
 * scratch folder, never in Citadel's database, which keeps no contraption turn's content.
 */
const codexLogFile = (scratch: string, session: string) => join(`${scratch}.codex`, `${session}.jsonl`);

/** One of the person's own machines a turn gets (#306). */
export interface PersonMachine {
  id: number;
  name: string;
  notes: string;
}

/** What a contraption turn tells claude about the person's machines it has. */
export function machinesPrompt(machines: PersonMachine[]): string {
  if (!machines.length) return '';
  return [
    `Connected machines: ${machines.map((m) => `${m.name} (mcp__${m.name})`).join(', ')}. Their MCP tools run on this person's own computers, not where you run, and fail if that computer goes offline mid-turn.`,
    ...machines.filter((m) => m.notes).map((m) => `Notes on ${m.name} from its owner:\n${m.notes}`),
  ].join('\n\n');
}

export { args, mcpConfig, settings, toolNamesPrompt, userLine };

export type TurnErrorCode = 'not_enabled' | 'no_plan' | 'limit' | 'busy' | 'timeout' | 'canceled' | 'interrupted' | 'bad_request' | 'failed';

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
  /** `claude --effort`: low, medium or high (#1084); null leaves Claude Code's default. */
  effort: string | null;
  /** Load MCP tools only when the model searches for them (Claude Code's tool search, #1084); off unless asked. */
  toolSearch: boolean;
  mcp: McpServer[];
  agents: { max: number; model: string | null } | false;
  /** WebSearch and WebFetch, off unless the contraption asks (#332). */
  webSearch: boolean;
  /** The person's online machines as MCP tools, with the system prompt's note on them (#306); `machines: false` drops both (#409). */
  machines: boolean;
  /** generate_image, edit_image, generate_audio and generate_speech from Citadel's `citadel` server, on the person's own OpenRouter key (#732). */
  media: boolean;
  /** A turn whose context names no person or app (VoiceAnalyzer #26): a neutral empty folder, `system` as the whole system prompt, no machines, always fresh, never Codex. */
  blind: boolean;
  /** Keep this turn for replay tests if it is among its session's first few (#836, src/replay-keep.ts). */
  keep: boolean;
  /** Paths in the app's data folder (#834); the route loads them into `imageBlocks` before the turn starts. */
  images: string[];
  imageBlocks?: ImageBlock[];
  timeoutSec: number;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** One reply event: start, text, tool, tool_result, compacted, taken (a steer reached claude), end or error. */
export type Emit = (event: string, data: object) => void;

export const DEFAULT_COMPACT_WINDOW = 40_000;
/** How much of a failed tool call's error text its tool_result event carries. */
export const TOOL_ERROR_MAX = 2_000;
export const DEFAULT_TIMEOUT_SEC = 180;
/** How long a restart of a contraption waits for its running turns (#319): about a turn's default timeout. */
export const DRAIN_MS = 3 * 60_000;
/** How long a stopped turn's claude has between SIGTERM and SIGKILL: on the host it exits in under a second (#319). */
export const KILL_AFTER_MS = 2_000;
/** Where a blind turn's random folder goes: a path with no login, home or app in it. */
const BLIND_ROOT = '/tmp';
interface Blind { root: string | null; cwd: string }
const SESSION_NAME = /^[\w.:@-]{1,100}$/;
const MODEL = /^[\w.\[\]-]{1,60}$/;
/** Effort an app may ask for: nothing above high (citadel:subagents, "Minions, Taskmasters and schedules too"). */
const TURN_EFFORTS = ['low', 'medium', 'high'];
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
  if (body.webSearch !== undefined && typeof body.webSearch !== 'boolean') bad('webSearch must be true or false');
  if (body.effort != null && !TURN_EFFORTS.includes(body.effort)) bad(`effort must be ${TURN_EFFORTS.join(', ')} or left out`);
  if (body.toolSearch !== undefined && typeof body.toolSearch !== 'boolean') bad('toolSearch must be true or false');
  if (body.machines !== undefined && typeof body.machines !== 'boolean') bad('machines must be true or false');
  if (body.media !== undefined && typeof body.media !== 'boolean') bad('media must be true or false');
  if (body.images !== undefined && (!Array.isArray(body.images) || body.images.some((p: unknown) => typeof p !== 'string'))) bad('images must be a list of paths');
  if (body.blind !== undefined && typeof body.blind !== 'boolean') bad('blind must be true or false');
  if (body.blind === true && isCodexModel(model)) bad('A blind turn runs on Claude only: pick a Claude model');
  if (body.keep !== undefined && typeof body.keep !== 'boolean') bad('keep must be true or false');
  if (body.keep === true && body.blind === true) bad('A blind turn has no session to keep: send keep or blind, not both');
  if (body.media === true && mcp.some((s) => s.name === MEDIA_SERVER)) bad(`With media: true, ${MEDIA_SERVER} is Citadel's server: call yours something else`);
  return {
    person: body.person, session: body.session, fresh: body.fresh === true || body.blind === true, prompt: body.prompt, system: body.system ?? '', model,
    compactWindow: int(body.compactWindow, 'compactWindow', 10_000, 1_000_000, DEFAULT_COMPACT_WINDOW), effort: body.effort ?? null, toolSearch: body.toolSearch === true, mcp, agents,
    webSearch: body.webSearch === true, machines: body.machines !== false && body.blind !== true, media: body.media === true, blind: body.blind === true, keep: body.keep === true, images: body.images ?? [], timeoutSec: int(body.timeoutSec, 'timeoutSec', 1, 900, DEFAULT_TIMEOUT_SEC),
  };
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
  /** Its machine proxies' key to the session routes (routes/machines.ts), and the machines it got at its start. */
  token: string;
  machines: number[];
  /** Its reply is out: claude's stdin is closed, so it takes no more steers. */
  replied: boolean;
  /** Ids of steers written to claude that it hasn't taken in yet. */
  steers: Set<string>;
  /** Set when it asked for media (#732): who and where its media calls go, and its event stream for the `media` event. */
  media: MediaTurn | null;
  /** What the model got and said, for the audit row (#844): set once claude is about to start. */
  audit: { model: string | null; system: string; prompt: string; output: string } | null;
}

/** How long a turn's audit row is kept (#844), and how much of each text it holds. */
export const AUDIT_DAYS = 14;
const AUDIT_TEXT_MAX = 100_000;
const clip = (text: string) => (text.length > AUDIT_TEXT_MAX ? `${text.slice(0, AUDIT_TEXT_MAX)}\n[… ${text.length - AUDIT_TEXT_MAX} more characters not kept]` : text);
/** Between a turn's prompt and a message its person sent while it ran, in the audit's prompt text. */
export const AUDIT_STEER = '\n\n--- sent during the turn ---\n';

/** An app session as the account pick knows it (ClaudePlaces.place). */
const appWarmKey = (contraption: number, session: string) => `app:${contraption}:${session}`;

export interface ClaudePlaces {
  /** `warm` names the session a turn resumes (`app:<contraption>:<name>`), which stays on its account while its cache is warm (#793). */
  place(uid: number | null, warm?: string): TurnPlace | null;
  /** A Claude turn of session `key` ended on `account` (ClaudeLink.ran). */
  ran?(uid: number, key: string, account: number): void;
  /** The server login's Codex-only container (#341), whose place() is the host. */
  codexPlace(uid: number): TurnPlace | null;
  expire(uid: number, account?: number): void;
  /** Every linked account's config folder: a session left on another account's (after a switch) is carried over before it resumes. */
  configDirs(uid: number): string[];
  /** A turn on `account` hit its limit, which resets at `until` (ClaudeLink.limitedView, the minions' path): the account turns move on to, or null when none is ready, and the first reset. */
  limitedView(uid: number, account: number, until: number): { next: { n: number; label: string } | null; resetAt: number; limits?: { n: number; label: string; until: number }[] } | null;
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
  /** Contraptions about to restart (#319): their new turns wait for `open`, which resolves once nothing holds them. */
  private holds = new Map<number, { count: number; open: Promise<void>; release: () => void }>();
  /** A preview (a copy of the data) never runs turns. */
  noTurns = false;
  /** The server got SIGTERM (a restart): a turn cut off now says Citadel restarted. Set by server.ts. */
  stopping = false;
  /** The person's own machines online now (#306), and the address their proxies reach Citadel at: set by server.ts. */
  machines: (person: number) => PersonMachine[] = () => [];
  apiUrl = () => '';
  /** Why a person's turns can't run on Codex, or null (Runner.codexWhy), and where their Codex usage goes: set by server.ts. */
  codexWhy: (person: number) => string | null = () => "Codex isn't set up on this server";
  onCodexUsage: (person: number, limits: unknown) => void = () => {};
  /** A Claude turn's `rate_limit_info` on `account` of `payer` (null: the server login), for the account pick's meters (Runner.recordUsage, #793). */
  onUsage: (info: unknown, payer: number | null, person: number, account: number) => void = () => {};
  /** A tool call that came back is_error, for the daily error digest (src/contraption-errors.ts, #835): set by server.ts. */
  onToolError: (c: ContraptionRow, tool: string, error: string) => void = () => {};

  /** The clock a stopped turn's SIGKILL wait and a drain's wait run on; tests move it (#1444). */
  clock: Clock = realClock;

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

  /** The running turn a machine proxy's token belongs to, or null. */
  machineTurn(token: string): { id: number; person: number; contraption: number; machines: number[] } | null {
    for (const t of this.live.values()) if (t.token === token) return t;
    return null;
  }

  /** The running turn that asked for media and holds this token, or null (src/contraption-media.ts). */
  mediaTurn(token: string): MediaTurn | null {
    for (const t of this.live.values()) if (t.token === token) return t.media;
    return null;
  }

  /** Where a media turn's generate_image_codex runs (#732), as a Codex turn would: the person's container, or the server login's Codex one. */
  private codexAt(person: number, place: TurnPlace): CodexAt | null {
    const at = this.codexWhy(person) ? null : place.host ? this.claude.codexPlace(person) : place;
    if (!at || at.host) return null;
    return { container: at.container, turnsDir: at.turnsDir, env: at.env, tripwire: tripwireConfig(0, at.configDir, false), ensure: at.ensure, podman: this.podman };
  }

  /** Turns running now, which a restart would cut off. */
  running(): number {
    return this.live.size;
  }

  /** The contraption_turns rows of the turns running now (the standing checks' snapshot, #1415). */
  liveIds(): number[] {
    return [...this.live.keys()];
  }

  /** Turns running in a container now (it isn't restarted under them). */
  inContainer(container: string): number {
    return [...this.live.values()].filter((t) => t.container === container).length;
  }

  /**
   * Before a contraption's service stops or restarts (#319): hold its new turns, then wait up to `capMs` for
   * its running ones to end. Resolves to a line for the deploy's output (null when none ran) and `release`,
   * which lets the held turns start: call it once the restart is done.
   */
  async drain(contraption: number, capMs = DRAIN_MS): Promise<{ said: string | null; release: () => void }> {
    let h = this.holds.get(contraption);
    if (!h) {
      let release!: () => void;
      const open = new Promise<void>((ok) => (release = ok));
      h = { count: 0, open, release };
      this.holds.set(contraption, h);
    }
    h.count++;
    const hold = h;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (--hold.count) return;
      this.holds.delete(contraption);
      hold.release();
    };
    const mine = () => [...this.live.values()].filter((t) => t.contraption === contraption);
    const started = this.clock.now();
    const ran = mine().length;
    while (mine().length && this.clock.now() - started < capMs) await new Promise<void>((ok) => this.clock.setTimeout(ok, 200));
    if (!ran) return { said: null, release };
    const left = mine();
    const waited = `Waited ${Math.round((this.clock.now() - started) / 1000)} s for ${ran} running turn${ran === 1 ? '' : 's'}`;
    if (!left.length) return { said: `${waited} to end.`, release };
    const said = `${waited}: restarting anyway, which cuts off ${left.map((t) => `turn ${t.id} (person ${t.person}, session ${t.session})`).join(', ')}.`;
    console.warn(`contraption ${contraption}: ${said}`);
    return { said, release };
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
      return { cwd: dir, onHost: dir, configDir: place.configDir ?? claudeConfigDir(this.env) };
    }
    const rel = join('.citadel', 'contraption-scratch', c.name);
    return { cwd: join(homedir(), rel), onHost: join(place.home, rel), configDir: place.configDir };
  }

  /**
   * A turn's private folder (its prompt, the contraption's system prompt and MCP tokens), as this server
   * sees it and as claude does. Never under run/turns, whose person folders the containers mount.
   */
  private turnDir(id: number, place: TurnPlace, blind: Blind | null) {
    if (blind?.root) return { onHost: join(blind.root, 'p'), inside: join(blind.root, 'p') };
    if (place.host) {
      const dir = join(this.dataDir, 'run', 'contraption-turns', String(id));
      return { onHost: dir, inside: dir };
    }
    const rel = join('.citadel', 'contraption-turns', String(id));
    return { onHost: join(place.home, rel), inside: join(homedir(), rel) };
  }

  /** Forget a session's Codex thread and its log. */
  private dropCodex(key: string, logFile: string | null) {
    this.store.deleteSetting(key);
    if (logFile) rmSync(logFile, { force: true });
  }

  /** A blind turn's folder and every transcript it left (its cwd is never used again, so nothing could resume them). */
  private dropBlind(person: number, blind: Blind, at: TurnPlace) {
    if (blind.root) rmSync(blind.root, { recursive: true, force: true });
    else if (at.container) spawnSync(this.podman, ['exec', at.container, 'rm', '-rf', blind.cwd], { stdio: 'ignore', timeout: 10_000 });
    for (const dir of this.claude.configDirs(person)) rmSync(join(dir, 'projects', projectSlug(blind.cwd)), { recursive: true, force: true });
  }

  /** Delete a Claude session's transcript and its subagents' from the person's Claude folder. */
  private dropTranscript(where: { configDir: string; cwd: string }, claudeSession: string) {
    const file = transcriptPath(where.configDir, where.cwd, claudeSession);
    if (!file) return; // an id that isn't one: no path is made from it, least of all to delete
    rmSync(file, { force: true });
    rmSync(file.replace(/\.jsonl$/, ''), { recursive: true, force: true });
  }

  /**
   * Run a turn, calling `emit` with its events, and resolve once it has ended (its last event is end or
   * error). Refusals are an error event too. Its start event carries the turn's id, for cancel(). While
   * its contraption restarts (drain) it waits to start, and `hungUp` drops it if the app goes meanwhile.
   */
  async run(c: ContraptionRow, req: TurnRequest, emit: Emit, hungUp?: AbortSignal): Promise<void> {
    const fail = (code: TurnErrorCode, message: string) => emit('error', { code, message });
    if (this.noTurns) return fail('failed', 'This is a preview of Citadel: it never runs turns');
    // Its service is about to restart (#319): start once that's done, unless the app hung up meanwhile.
    for (let h; (h = this.holds.get(c.id)); ) await h.open;
    if (hungUp?.aborted) return fail('canceled', 'The app hung up before the turn started');
    if (!this.contraptions.enabled(c.name, req.person)) return fail('not_enabled', `${c.title} isn't enabled for this person`);
    const key = this.key(c.id, req.person, req.session);
    if (this.names.has(key)) return fail('busy', `A turn is already running in ${req.session}`);
    if (c.turn_cap && this.store.contraptionTurnsSince(c.id, req.person, dayStart()) >= c.turn_cap) return fail('limit', `${c.title}'s cap of ${c.turn_cap} turns a day is used up for this person`);
    const known = !req.fresh && this.store.contraptionSession(c.id, req.person, req.session);
    const place = this.claude.place(req.person, known ? appWarmKey(c.id, req.session) : undefined);
    if (!place) return fail('no_plan', 'This person hasn\'t linked their Claude in Citadel (Settings → Claude), or it needs linking again');

    // The server login's Codex turns run in its Codex-only container (#341); its Claude turns, and the session's bookkeeping, stay on the host.
    // A blind turn is Claude's only (Codex's own prompt and folder aren't proven clean), whatever the switch says.
    const wantCodex = isCodexModel(req.model) || (!req.blind && !!this.store.getSetting<boolean>(codexSwitchKey(req.person)));
    if (wantCodex && req.imageBlocks?.length) return fail('bad_request', 'images need a Claude turn: this one runs on Codex');
    const at = (wantCodex && place.host && !this.codexWhy(req.person) && this.claude.codexPlace(req.person)) || place;

    // Busy only once the turn is recorded, so a throw here can't leave the name busy until a restart (#468 S04-8).
    const id = this.store.startContraptionTurn(c.id, req.person, req.session);
    // A neutral folder for everything of the turn's (host: its private files and cwd; a container: only the cwd, made inside it).
    const blind: Blind | null = !req.blind ? null : at.host
      ? { root: mkdtempSync(join(BLIND_ROOT, 't-')), cwd: '' } : { root: null, cwd: join(BLIND_ROOT, `t-${randomBytes(6).toString('hex')}`) };
    if (blind?.root) blind.cwd = join(blind.root, 'w');
    const dir = this.turnDir(id, at, blind);
    const live: Live = { id, contraption: c.id, person: req.person, session: req.session, container: at.host ? null : at.container, child: null, pidFile: join(dir.onHost, 'pid'), stopped: null, token: `cmt_${randomBytes(32).toString('base64url')}`, machines: [], replied: false, steers: new Set(), audit: null,
      media: req.media ? { person: req.person, name: c.name, home: c.home_scheme, emit, codex: this.codexAt(req.person, place) } : null };
    this.names.add(key);
    this.live.set(id, live);
    let outcome: string = 'failed';
    let usage: Usage | null = null;
    // A limit can show up after output went to the app (a long tool loop), so a retry on the next account only
    // happens while nothing but `start` has gone out; its own `start` is dropped, the app has had one.
    let sent = false;
    let retrying = false;
    const out: Emit = (event, data) => {
      if (event === 'start' && retrying) return;
      if (event !== 'start') sent = true;
      if (event === 'text' && live.audit && (data as { parent: string | null }).parent === null) live.audit.output += (data as { delta: string }).delta;
      emit(event, data);
    };
    try {
      let r = await this.turn(c, req, place, at, wantCodex, live, dir, blind, out, () => !sent);
      if (r.retry) {
        // The limit moved this person's turns to their next account; turn() carries the session's transcript over to it.
        retrying = true;
        const next = this.claude.place(req.person, known ? appWarmKey(c.id, req.session) : undefined);
        rmSync(dir.onHost, { recursive: true, force: true }); // turn() makes it again
        live.replied = false;
        live.steers.clear();
        // Only a Claude turn retries, and its `at` is its place.
        if (next) r = await this.turn(c, req, next, next, wantCodex, live, dir, blind, out, () => false);
        else out('error', { code: 'limit', message: 'This person has no Claude account to carry on with' });
      }
      ({ outcome, usage } = r);
    } catch (err: any) {
      fail('failed', String(err?.message ?? err).slice(0, 300));
    } finally {
      this.live.delete(id);
      this.names.delete(key);
      rmSync(dir.onHost, { recursive: true, force: true });
      if (blind) this.dropBlind(req.person, blind, at);
      this.store.endContraptionTurn(id, outcome, usage);
      const cut = cutKey(c.id, req.person, req.session);
      if (outcome === 'interrupted') this.store.setSetting(cut, true);
      else if (this.store.getSetting<boolean>(cut)) this.store.deleteSetting(cut);
      const a = live.audit;
      if (a) this.store.putTurnAudit(id, { model: a.model, blind: req.blind, images: req.imageBlocks?.length ?? 0, system: clip(a.system), prompt: clip(a.prompt), output: clip(a.output) });
    }
  }

  /** `place` is where the person's Claude turns and the session's files are; `at` is where this one runs (they differ only for the server login on Codex). */
  private async turn(c: ContraptionRow, req: TurnRequest, place: TurnPlace, at: TurnPlace, wantCodex: boolean, live: Live, dir: { onHost: string; inside: string }, blind: Blind | null, emit: Emit, canRetry: () => boolean): Promise<{ outcome: string; usage: Usage | null; retry?: true }> {
    const base = this.scratch(c, req.person, place);
    const where = blind ? { ...base, cwd: blind.cwd, onHost: blind.cwd } : base;
    if (!blind || blind.root) mkdirSync(where.onHost, { recursive: true });
    // Its working folder, inside the container it runs in: Codex's app turns run only their MCP tools, so it holds nothing they need.
    const runIn = at === place ? where : this.scratch(c, req.person, at);
    if (runIn !== where) mkdirSync(runIn.onHost, { recursive: true });
    // Codex (#337): a Codex pick, or the person's "Enable Codex override", once their container has Codex; else Claude's default.
    const codex = wantCodex && !at.host && !this.codexWhy(req.person);
    if (isCodexModel(req.model) && !codex) req = { ...req, model: isCodexModel(c.default_model) ? null : c.default_model };
    // What runs, for start and end (#409): a Codex pick the person can't run falls back above, and the override turns any pick into Codex.
    const provider = codex ? 'codex' : 'claude';
    let model: string | null = codex ? codexModelFor(req.model) : req.model;
    const ckey = codexKey(c.id, req.person, req.session);
    const logFile = codexLogFile(where.onHost, req.session);
    if (req.fresh) this.dropCodex(ckey, logFile);
    const codexSession = this.store.getSetting<CodexSession>(ckey);
    let codexLog = '';
    try {
      if (codexSession) codexLog = readFileSync(logFile, 'utf8');
    } catch {
      // No Codex turn logged anything yet.
    }
    // Resume the name's session unless asked for a fresh one, or its transcript is gone (a relinked Claude).
    const known = blind ? null : this.store.contraptionSession(c.id, req.person, req.session);
    const transcript = known ? transcriptPath(where.configDir, where.cwd, known.claude_session) : null;
    // A limit (#785) or a cold move (#793) took this session to another account, where it may have carried on: the newest
    // copy of its transcript (and its subagents') comes in, or a move back would resume the conversation as it was before.
    if (transcript && !req.fresh) {
      const here = existsSync(transcript) ? realpathSync(transcript) : null;
      let from: { path: string; at: number } | null = null;
      for (const dir of this.claude.configDirs(req.person)) {
        const path = transcriptPath(dir, where.cwd, known!.claude_session);
        // A shared projects folder (claude-link.ts, SHARED_CONFIG) is the same file: copying a file onto itself would empty it.
        if (!path || !existsSync(path) || realpathSync(path) === here) continue;
        const at = statSync(path).mtimeMs;
        if (!from || at > from.at) from = { path, at };
      }
      if (from && (!here || from.at > statSync(here).mtimeMs)) {
        mkdirSync(dirname(transcript), { recursive: true });
        copyFileSync(from.path, transcript);
        if (existsSync(from.path.replace(/\.jsonl$/, ''))) cpSync(from.path.replace(/\.jsonl$/, ''), transcript.replace(/\.jsonl$/, ''), { recursive: true });
      }
    }
    const resume = !!transcript && !req.fresh && existsSync(transcript);
    const claudeSession = resume ? known!.claude_session : randomUUID();
    // The name can never get back to the session it leaves, so that session's transcript goes.
    if (known && !resume) this.dropTranscript(where, known.claude_session);
    if (!blind) this.store.putContraptionSession(c.id, req.person, req.session, claudeSession);
    // A kept turn (#836): what it streams, written once it ends well. Not a blind one's, nor an opted-out person's.
    const keepDir = req.keep && !blind && !this.store.getSetting<boolean>(optOutKey(req.person)) ? keptDir(this.dataDir, c) : null;
    const keepAt = keepDir ? keptFile(keepDir, req.person, req.session, claudeSession) : null;
    const kept = keepAt && wantsKeep(keepAt) ? { calls: new Map<string, KeptCall>(), text: '' } : null;

    // Private: it holds the prompt, the contraption's system prompt and its MCP tokens until the turn ends.
    mkdirSync(dir.onHost, { recursive: true, mode: 0o700 });
    mkdirSync(join(dir.onHost, 'slots'), { mode: 0o700 });
    mkdirSync(join(dir.onHost, 'tmp'));
    const secret = (name: string, text: string) => writeFileSync(join(dir.onHost, name), text, { mode: 0o600 });
    const config: { mcpServers: Record<string, object> } = mcpConfig(c.port, req.mcp);
    // The person's own machines (#306), through the same stand-in minion turns use; a contraption server's name wins.
    const machines = !req.machines ? [] : this.machines(req.person).filter((m) => !req.mcp.some((s) => s.name === m.name) && !(req.media && m.name === MEDIA_SERVER));
    live.machines = machines.map((m) => m.id);
    if (machines.length) {
      secret('machine-mcp.ts', MACHINE_MCP);
      const env = { COORDINATOR_API: this.apiUrl(), COORDINATOR_TOKEN: live.token, COORDINATOR_MACHINE_ROUTE: 'contraption-session' };
      for (const m of machines) config.mcpServers[m.name] = { type: 'stdio', command: process.execPath, args: [join(dir.inside, 'machine-mcp.ts'), String(m.id), m.name, 'mcp'], env };
    }
    // Citadel's own media server (#732), over HTTP on the address machine proxies use, with the turn's token.
    if (req.media) config.mcpServers[MEDIA_SERVER] = { type: 'http', url: `${this.apiUrl()}/api/contraption-media/mcp`, headers: { Authorization: `Bearer ${live.token}` } };
    secret('mcp.json', JSON.stringify(config));
    const system = [req.system, codex ? '' : toolNamesPrompt(Object.keys(config.mcpServers)), machinesPrompt(machines)].filter(Boolean).join('\n\n');
    if (system) secret('system.md', system);
    let hook = null;
    if (req.agents) {
      secret('agent-cap.ts', AGENT_CAP);
      hook = { node: process.execPath, script: join(dir.inside, 'agent-cap.ts'), slots: join(dir.inside, 'slots') };
    }
    secret('settings.json', JSON.stringify(settings(req, hook, machines.map((m) => m.name))));
    let prompt = req.prompt;
    if (codex) {
      for (const [f, text] of CODEX_FILES) secret(f, text);
      // The hook reads this (CITADEL_CODEX_TRIPWIRE): only the contraption's own servers and the person's machines.
      secret('codex-tripwire.json', JSON.stringify({ script: join(dir.inside, 'tripwire.ts'), config: tripwireConfig(0, at.host ? place.configDir : at.configDir, false), mode: 'contraption', mcp: Object.keys(config.mcpServers) }));
      let claudeJsonl = '';
      try {
        if (resume) claudeJsonl = readFileSync(transcript!, 'utf8');
      } catch {
        // No Claude transcript: a new thread starts from the Codex turns alone, if any.
      }
      secret('handover.md', fitLog([...claudeParts(claudeJsonl), ...readParts(codexLog)]));
      if (!codexSession) this.store.setSetting(ckey, { thread: null });
    } else if (codexSession) {
      // Back on Claude after Codex turns: they come first, verbatim.
      prompt = `${toClaudePreamble(fitLog(readParts(codexLog)))}\n\n${prompt}`;
    }

    const tmp = join(dir.inside, 'tmp');
    let env: Record<string, string> = {
      ...turnEnv(this.env), TMPDIR: tmp, TMP: tmp, TEMP: tmp, CLAUDE_CODE_TMPDIR: tmp,
      // Belt and braces with --setting-sources '': no CLAUDE.md or auto-memory, and Agent calls wait for their agent (the cap's hook counts on it).
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', DISABLE_AUTOUPDATER: '1',
    };
    delete env.SSH_AUTH_SOCK;
    // Nothing of the login in the process (the model sees no env without a shell, but a tool it's given might); the config dir stays, it holds the sign-in.
    if (blind) for (const v of ['USER', 'LOGNAME', 'SHELL', 'USERNAME']) delete env[v];
    // HOME moves to the empty folder, so the sign-in must not be looked up through it.
    if (blind?.root) Object.assign(env, { HOME: blind.root, CLAUDE_CONFIG_DIR: where.configDir });
    if (req.agents && (req.agents.model ?? req.model)) env.CLAUDE_CODE_SUBAGENT_MODEL = (req.agents.model ?? req.model)!;
    let argv = args({ ...req, system }, dir.inside, claudeSession, resume);
    live.audit = { model, system, prompt, output: '' };
    if (codex) {
      env.CITADEL_CODEX_TRIPWIRE = join(dir.inside, 'codex-tripwire.json');
      // The shim reads claude's flags; --resume/--session-id are Claude's own session, which the Codex turns leave alone.
      argv = [join(dir.inside, 'codex-turn.ts'), '--codex-mode', 'contraption', '--codex-log', join(dir.inside, 'codex-log.jsonl'), '--codex-handover', join(dir.inside, 'handover.md'),
        ...(codexSession?.thread ? ['--codex-thread', codexSession.thread] : []), ...argv];
    }
    let cmd: string;
    let cmdArgs: string[];
    if (at.host) {
      // The server login's extra Claude account (#779): its folder's own sign-in, nothing of the host's over it.
      if (at.env) {
        for (const v of AUTH_VARS) delete env[v];
        env = { ...env, ...at.env };
      }
      [cmd, cmdArgs] = [this.claudeBin, argv];
    } else {
      // The person's own sign-in, so nothing of the server's may win over it.
      for (const v of AUTH_VARS) delete env[v];
      env = { ...env, ...at.env, XDG_RUNTIME_DIR: tmp };
      await at.ensure();
      // `exec` keeps the pid, written first, so a cancel can signal claude inside the container.
      cmd = this.podman;
      const exe = codex ? process.execPath : resolveClaude(this.claudeBin);
      // A blind turn makes its random folder inside the container, and runs there.
      const [wd, script, more] = blind ? [BLIND_ROOT, 'echo $$ > "$0"; mkdir -p "$1" && cd "$1" && shift && exec "$@"', [blind.cwd]] : [runIn.cwd, 'echo $$ > "$0"; exec "$@"', []];
      cmdArgs = ['exec', '-i', '-w', wd, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), at.container,
        'sh', '-c', script, join(dir.inside, 'pid'), ...more, exe, ...argv];
    }
    if (live.stopped) return { outcome: live.stopped, usage: null };

    const child = spawn(cmd, cmdArgs, { cwd: at.host ? where.cwd : undefined, env: at.host ? env : turnEnv(this.env), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    live.child = child;
    emit('start', { turn: live.id, session: req.session, claudeSession, provider, model });
    child.stdin!.on('error', () => {}); // claude exited without reading it all
    // Open until the reply is out, as the turn wrapper keeps a minion turn's: steer() writes to it meanwhile.
    child.stdin!.write(userLine(prompt, undefined, req.imageBlocks));
    const timer = setTimeout(() => this.stop(live, 'timeout'), req.timeoutSec * 1000);

    let result: any = null;
    // Each steer claude takes after a reply is a query of its own, with its own result and usage.
    const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let metered = false;
    let stderr = '';
    const streamed = new Map<string, string>();
    const said = new Map<string, string>();
    // Tool names by call id, so a failed call's digest line names its tool.
    const tools = new Map<string, string>();
    // The tools claude's init says the turn has, for the did-you-mean note on a call to one it hasn't (#1174).
    let initToolNames: string[] = [];
    let message = '';
    let waited = false;
    const handle = (ev: any) => {
      // A Grunt's events name the Agent call that started it; the top level's name none.
      const parent = ev.parent_tool_use_id ? String(ev.parent_tool_use_id) : null;
      // The full name of the model it runs (an alias, or none for the account's default, in start), for end.
      if (ev.type === 'system' && ev.subtype === 'init' && !parent && typeof ev.model === 'string' && MODEL.test(ev.model)) { model = ev.model; if (live.audit) live.audit.model = model; }
      if (ev.type === 'system' && ev.subtype === 'init' && !parent && Array.isArray(ev.tools)) initToolNames = ev.tools.filter((t: unknown): t is string => typeof t === 'string');
      if (ev.type === 'codex_waiting') {
        waited = true;
      } else if (ev.type === 'codex_rate_limits') {
        this.onCodexUsage(req.person, ev.rate_limits);
      } else if (ev.type === 'rate_limit_event' && !codex) {
        this.onUsage(ev.rate_limit_info, place.host ? null : req.person, req.person, place.account ?? 1);
      } else if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.codex_thread === 'string') {
        const t = this.store.getSetting<CodexSession>(ckey);
        if (t) this.store.setSetting(ckey, { ...t, thread: ev.codex_thread });
      } else if (!blind && ev.type === 'system' && ev.subtype === 'init' && validSessionId(ev.session_id) && ev.session_id !== claudeSession) {
        this.store.putContraptionSession(c.id, req.person, req.session, ev.session_id);
      } else if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
        emit('compacted', {});
      } else if (ev.type === 'stream_event' && !parent) {
        const e = ev.event;
        if (e?.type === 'message_start') message = String(e.message?.id ?? '');
        else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && typeof e.delta.text === 'string') {
          streamed.set(message, (streamed.get(message) ?? '') + e.delta.text);
          emit('text', { delta: e.delta.text, parent: null, message });
        }
      } else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
        const mid = String(ev.message.id ?? '');
        for (const b of ev.message.content) {
          if (b?.type === 'tool_use') {
            tools.set(String(b.id), String(b.name));
            emit('tool', { id: b.id, name: b.name, input: b.input, parent });
            kept?.calls.set(String(b.id), { name: String(b.name), input: b.input, ok: null, result: null });
          }
          else if (b?.type === 'text' && !parent && typeof b.text === 'string') {
            if (kept) kept.text += (kept.text ? '\n\n' : '') + b.text;
            // Text the partial stream missed (it is off, or cut short): the rest of it, once.
            const all = (said.get(mid) ?? '') + b.text;
            said.set(mid, all);
            const sent = streamed.get(mid) ?? '';
            if (all.length > sent.length && all.startsWith(sent)) {
              emit('text', { delta: all.slice(sent.length), parent: null, message: mid });
              streamed.set(mid, all);
            }
          }
        }
      } else if (ev.type === 'user' && ev.isReplay && !parent && live.steers.delete(ev.uuid)) {
        emit('taken', { id: ev.uuid });
      } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
        for (const b of ev.message.content) {
          if (b?.type !== 'tool_result') continue;
          const call = kept?.calls.get(String(b.tool_use_id));
          if (call) Object.assign(call, { ok: !b.is_error, result: cap(blockText(b.content)) });
          // A failed call carries the error the agent saw (a refusal before the tool ran has no other trace, #624); output never goes out.
          if (b.is_error) {
            const error = blockText(b.content).slice(0, TOOL_ERROR_MAX);
            emit('tool_result', { id: b.tool_use_id, ok: false, parent, error });
            this.onToolError(c, tools.get(String(b.tool_use_id)) ?? 'tool', error);
            // Claude Code's refusal names no alternative and runs no hook; the note goes in as a message the agent reads next (not a person's steer: no `taken` event).
            const called = unknownToolName(error);
            // Only the main agent's own calls, and not when tool search may have left the app's tools out of init's list (an incomplete list would name the wrong ones).
            const note = called && !codex && !parent && (!req.toolSearch || initToolNames.some((t) => t.startsWith('mcp__'))) ? suggestTools(called, initToolNames) : null;
            if (note && !live.replied && !live.stopped && live.child?.stdin?.writable) live.child.stdin.write(userLine(note));
          }
          else emit('tool_result', { id: b.tool_use_id, ok: true, parent });
        }
      } else if (ev.type === 'result') {
        result = ev;
        if (ev.usage) metered = true;
        const u = ev.usage ?? {};
        total.input += u.input_tokens ?? 0;
        total.output += u.output_tokens ?? 0;
        total.cacheRead += u.cache_read_input_tokens ?? 0;
        total.cacheWrite += u.cache_creation_input_tokens ?? 0;
        // The reply is out: no more steers (the turn wrapper's rule); those already written are still answered.
        if (!live.replied) {
          live.replied = true;
          child.stdin!.end();
        }
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
    let signal: NodeJS.Signals | null = null;
    const code = await new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        stderr += err.message;
        resolve(null);
      });
      child.on('close', (n, sig) => {
        signal = sig;
        resolve(n);
      });
    });
    clearTimeout(timer);
    if (!codex) this.claude.ran?.(req.person, appWarmKey(c.id, req.session), place.account ?? 1);
    if (codex) {
      // This turn's log joins the session's, for the way back to Claude; its folder goes when the turn ends.
      let log = '';
      try {
        log = readFileSync(join(dir.onHost, 'codex-log.jsonl'), 'utf8');
      } catch {
        // It logged nothing.
      }
      if (log) {
        mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
        appendFileSync(logFile, log, { mode: 0o600 });
      }
    } else if (codexSession && result && !result.is_error) {
      // Claude has the Codex turns now.
      this.dropCodex(ckey, logFile);
    }

    const usage: Usage | null = metered ? total : null;
    const error = (code: TurnErrorCode, message: string) => {
      emit('error', { code, message });
      return { outcome: code, usage };
    };
    if (live.stopped === 'timeout') return error('timeout', `The turn ran past ${req.timeoutSec} seconds and was stopped${waited ? `: ${CODEX_WAITING}` : ''}`);
    if (live.stopped === 'canceled') return error('canceled', 'The turn was stopped');
    if (result && !result.is_error) {
      emit('end', { stop: result.stop_reason ?? result.subtype ?? 'end_turn', usage: total, provider, model });
      // shortcut: steers that reached the turn aren't kept, so a replay sends only the first prompt; keep them if replays of steered turns matter.
      // Checked again at the end: the person may have opted out, or deleted the session, while the turn ran.
      if (kept && keepAt && !this.store.getSetting(optOutKey(req.person)) && this.store.contraptionSession(c.id, req.person, req.session)) {
        try {
          keepTurn(keepAt, { at: Date.now(), turn: live.id, prompt: req.prompt, images: req.imageBlocks?.length ?? 0, system: sha256(req.system), model: req.model, servers: Object.keys(config.mcpServers), agents: !!req.agents, webSearch: req.webSearch, compactWindow: req.compactWindow, effort: req.effort, toolSearch: req.toolSearch, calls: [...kept.calls.values()], text: cap(kept.text), stop: String(result.stop_reason ?? result.subtype ?? 'end_turn') });
        } catch (err: any) {
          console.warn(`contraption ${c.name}: couldn't keep a turn for replay: ${err?.code ?? 'error'}`); // no content in the log
        }
      }
      return { outcome: 'end', usage };
    }
    const why = [typeof result?.result === 'string' ? result.result : '', ...(Array.isArray(result?.errors) ? result.errors.map(String) : []), stderr].join('\n').trim();
    if (USAGE_LIMIT.test(why)) {
      let line = why.split('\n')[0].slice(0, 300);
      // Mark the account, as the runner does (Settings → Account and the minions' turns see it too); a Codex turn's limit is OpenAI's.
      const until = parseResetTime(why) ?? Date.now() + 60 * 60 * 1000;
      const r = codex ? null : this.claude.limitedView(req.person, place.account ?? 1, until);
      if (r?.next && canRetry() && !live.stopped) return { outcome: 'retry', usage, retry: true };
      if (r && !r.next && r.resetAt < until) line += ` Another of this person's Claude accounts resets first, at ${clockTime(r.resetAt, ZONE)}.`;
      return error('limit', line);
    }
    // A Codex turn's 401 is OpenAI's: it says nothing about the Claude sign-in.
    if (!codex && isAuthFailure(why)) {
      if (!place.host || (place.account ?? 1) > 1) this.claude.expire(req.person, place.account);
      return error('no_plan', 'This person\'s Claude sign-in was refused: they need to link it again in Citadel');
    }
    // SIGTERM from outside the turn (#1382): a Citadel restart (systemd stops every process of the service, claude
    // with it, while the server lingers a few seconds), or a stray `pkill`. Its work so far is in the session's
    // transcript, so the app can send a turn in it to carry on. `retry` says that holds: false on a second cut in a
    // row (cutKey), so an app retrying by itself can't loop, and on a fresh or blind turn, which kept no session.
    if (code === 143 || signal === 'SIGTERM') {
      const twice = !!this.store.getSetting<boolean>(cutKey(c.id, req.person, req.session));
      const retry = !req.fresh && !twice;
      emit('error', {
        code: 'interrupted', retry,
        message: `${this.stopping ? 'Citadel restarted and cut this turn off' : 'The turn was cut off from outside Citadel'} before it finished. ${retry
          ? 'Its work so far is kept in the session: send it again to carry on.' : twice ? 'It was cut off twice in a row, so try again in a minute.' : 'Send it again to start over.'}`,
      });
      return { outcome: 'interrupted', usage };
    }
    return error('failed', `${codex ? 'Codex' : 'Claude'} ended without a reply (exit ${code ?? 'unknown'})${why ? `: ${why.split('\n').filter(Boolean).at(-1)!.slice(0, 300)}` : ''}`);
  }

  /** Stop a running turn: its process group on the host, claude itself in a container. */
  private stop(live: Live, why: 'timeout' | 'canceled') {
    if (live.stopped) return;
    live.stopped = why;
    const child = live.child;
    if (!child?.pid) return; // not started yet: turn() sees `stopped` before it spawns
    let pid = '';
    if (live.container) {
      try {
        pid = readFileSync(live.pidFile, 'utf8').trim();
      } catch {}
    }
    const kill = (sig: 'TERM' | 'KILL') => {
      // claude in the container, which may outlive the podman exec that ran it, then the host's process group.
      if (/^\d+$/.test(pid)) spawn(this.podman, ['exec', live.container!, 'kill', `-${sig}`, pid], { stdio: 'ignore' }).on('error', () => {});
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        process.kill(-child.pid!, `SIG${sig}`);
      } catch {}
    };
    kill('TERM');
    this.clock.setTimeout(() => kill('KILL'), KILL_AFTER_MS).unref();
  }

  /** Cancel a contraption's own running turn; false when it has no such turn running. */
  cancel(contraption: number, turn: number): boolean {
    const live = this.live.get(turn);
    if (!live || live.contraption !== contraption) return false;
    this.stop(live, 'canceled');
    return true;
  }

  /**
   * Pass a message into a contraption's running turn, as minion steers go (src/runner.ts send): claude
   * reads it between tool calls, or answers it after its reply. Its `taken` event, with the id returned
   * here, says claude took it in. Only the turn's own person can steer it, and not once its reply is out.
   * null when the contraption has no such turn; 'other_person' when it isn't the person's.
   */
  steer(contraption: number, turn: number, person: number, text: string): { steered: true; id: string } | { steered: false; reason: 'ended' | 'replied' } | 'other_person' | null {
    const live = this.live.get(turn);
    if (!live) {
      const row = this.store.getContraptionTurn(turn);
      if (row?.contraption_id !== contraption) return null;
      return row.user_id === person ? { steered: false, reason: 'ended' } : 'other_person';
    }
    if (live.contraption !== contraption) return null;
    if (live.person !== person) return 'other_person';
    if (live.stopped) return { steered: false, reason: 'ended' };
    if (live.replied) return { steered: false, reason: 'replied' };
    if (!live.child?.stdin?.writable) return { steered: false, reason: 'ended' }; // claude has gone
    const id = randomUUID();
    live.steers.add(id);
    live.child.stdin.write(userLine(text, id));
    if (live.audit) live.audit.prompt += AUDIT_STEER + text;
    return { steered: true, id };
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
    this.store.deleteTurnAudit(c.id, person, name); // blind turns keep no session, so before the check
    const s = this.store.contraptionSession(c.id, person, name);
    if (!s) return 'missing';
    const place = this.claude.place(person, appWarmKey(c.id, name));
    if (place) this.dropTranscript(this.scratch(c, person, place), s.claude_session);
    this.dropCodex(codexKey(c.id, person, name), place ? codexLogFile(this.scratch(c, person, place).onHost, name) : null);
    this.store.deleteContraptionSession(c.id, person, name);
    this.store.deleteSetting(cutKey(c.id, person, name));
    dropKeptSession(keptDir(this.dataDir, c), person, name);
    return 'deleted';
  }
}
