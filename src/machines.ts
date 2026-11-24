// Machines: people's own computers lending their MCP servers (a Godot editor, say) to threads.
// A machine runs public/machine-agent.mjs, which dials out to the app and holds an event stream
// open; perigee can't reach a laptop directly, so everything flows over connections the laptop
// opens. During a turn, each online machine appears to claude as a stdio MCP server
// (src/machine-mcp.ts) that pipes its messages through here: claude -> proxy -> POST -> agent
// stream -> local MCP server, and back the same way. Each proxy is one session, and the agent
// runs one copy of the MCP server per session, so concurrent threads never share one.
// An agent with a workspaces config also serves its own workspace tools (server "ws"), which threads
// see as mcp__<name>-ws__….
// What a machine lends is ticked on the Machines page (#439): its agent reports the MCP servers and
// workspaces it found on that computer, by name, and serves only the ticked ones. An agent set up
// before that (it posts no version) lends the MCP server on its own command line, and its workspace
// tools while a person has the machine's workspace tools switched on.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { lendsMachine } from './access.ts';
import { seal, unseal } from './credentials.ts';
import type { Machine, Store } from './db.ts';
import { type AgentJobMessage, cleanOffer, storedOffer, storedSettings } from './machine-jobs.ts';
import { every } from './every.ts';
import { thrown } from './thrown.ts';
import { asData } from './quote.ts';

/** Machine names double as MCP server names, so tools read mcp__<name>__<tool>. */
export const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,29}$/;
/** Names the app's own MCP servers already use. */
export const RESERVED_NAMES = new Set(['thread', 'coordinator']);
/** A machine's workspace tools are the MCP server <name>-ws, so no machine may be named that way. */
export const WS_SUFFIX = '-ws';

/**
 * What an agent says it runs (machine-agent.mjs `describe`), as a machine's mcp_kind and mcp_command (#308): for one
 * added before the Machines page kept them. Null when it can't tell: a description cut at the route's 200 characters, or a
 * command, which the agent joins with spaces and so loses its quoting (that machine's setup lines follow the form, saying so).
 */
export function mcpFromAgent(describe: string): Pick<Machine, 'mcp_kind' | 'mcp_command'> | null {
  if (!describe || describe.length >= 200) return null;
  if (describe === 'workspace tools only') return { mcp_kind: 'none', mcp_command: '' };
  const claude = describe.match(/^(.+) \(from Claude Code's config\)$/);
  return claude ? { mcp_kind: 'claude', mcp_command: claude[1] } : null;
}

/** An MCP server's name as an agent reports it (machine-agent.mjs SERVER_NAME), and a workspace's. */
export const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
export const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
/** What the setup lines ran for a machine added as a Claude Code server with no name typed (#308). */
const DEFAULT_CLAUDE_MCP = 'godot-ai';

/**
 * What a person ticked for a machine to lend (#439): one of the MCP servers its agent found, and its workspaces, by name.
 * gpu_off (#1175): GPU jobs switched off, so a GPU_TASK is refused and one running is stopped.
 * before_ticks: saved for an agent from before #439, only to hold gpu_off; its ticks start fresh once it is managed.
 */
export type Lend = { server: string | null; workspaces: string[]; gpu_off?: true; before_ticks?: true };
/** The workspace task that runs a job with the machine's GPU on (tools/win-test-box/gpu.ps1 adds it). */
export const GPU_TASK = 'run-gpu';
const GPU_OFF_WHO = 'the GPU jobs switch on the Machines page';
/** An MCP server an agent found on its computer: in Claude Code's config, or in its own machine-agent.json. */
export type FoundServer = { name: string; from: 'claude' | 'file' };

/** A lend as a person's PATCH or machines.lend gives it, or null when it isn't one. */
export function cleanLend(input: unknown): Lend | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const v = input as { server?: unknown; workspaces?: unknown; gpu_off?: unknown; before_ticks?: unknown };
  if (v.server !== null && !(typeof v.server === 'string' && SERVER_NAME.test(v.server))) return null;
  if (!Array.isArray(v.workspaces) || v.workspaces.length > 50 || !v.workspaces.every((w: unknown) => typeof w === 'string' && WORKSPACE_NAME.test(w))) return null;
  return { server: v.server as string | null, workspaces: [...new Set<string>(v.workspaces)], ...(v.gpu_off === true ? { gpu_off: true as const } : {}), ...(v.before_ticks === true ? { before_ticks: true as const } : {}) };
}

function storedLend(m: Machine): Lend | null {
  try {
    return m.lend ? cleanLend(JSON.parse(m.lend)) : null;
  } catch {
    return null;
  }
}

/** The servers an agent can offer: the MCP server it lends, and its built-in workspace tools. */
export type MachineServer = 'mcp' | 'ws';
export type OnlineMachine = Machine & { servers: MachineServer[] };

// An agent that stops reading (asleep mid-stream) is dropped rather than buffered for forever.
const MAX_BACKLOG = 64 * 1024 * 1024;
const PING_MS = 25_000;
// An agent that beats (public/machine-agent.mjs posts one every 20 s) and has gone this long without one is
// asleep or gone: a ping the app writes can't tell, since the kernel, or Caddy in front, takes it anyway.
const BEAT_LOST_MS = 70_000;
// How long a check (#307) waits on each server: a machine's MCP server may take a while to start.
const CHECK_MS = 30_000;

/** One server's check (#307): whether MCP initialize and tools/list came back, and what it lists. */
export type CheckResult = { server: MachineServer; ok: boolean; tools: string[]; error: string | null; ms: number };
/** A machine's last check as machines.last_check keeps it (#437); a CI runner host's says runners, with no results. */
export type StoredCheck = { at: number; results: CheckResult[]; runners?: true };

// Citadel checks a machine when its agent connects and hourly while connected (#437): a check starts a copy of its MCP server.
const CHECK_EVERY_MS = 60 * 60_000;
// An agent from before workspaces never posts its info, so its connect check starts this long after it connects.
const CHECK_UNASKED_MS = 10_000;
// An always-on machine is Down once offline this long; one never connected is Down this long after it was added.
const DOWN_AFTER_MS = 5 * 60_000;
const NEVER_CONNECTED_MS = 60 * 60_000;

/**
 * What a machine's line says (#437). ready, fix (yellow) and down (red) are the colours; asleep has none.
 * checking (no colour either) is the few seconds between connecting and its first check.
 */
export type MachineStatus = {
  status: 'ready' | 'fix' | 'down' | 'asleep' | 'checking';
  /** One line saying why, without a time: `when` carries that. */
  reason: string;
  /** The button that fixes it, if one does. */
  fix: 'check' | 'workspace_tools' | 'tick' | 'lend' | 'token' | 'remove' | 'always_on' | null;
  when: { label: 'checked' | 'seen' | 'added'; at: number } | null;
};

export type StatusFacts = {
  now: number;
  /** When this server started: an agent can't have been seen offline before then. */
  startedAt: number;
  online: boolean;
  /** A CI runner host: its agent is the runner agent, or was at its last connection. */
  runners: boolean;
  alwaysOn: boolean;
  createdAt: number;
  lastSeenAt: number | null;
  /** The servers a turn would get from it now (relay.online()). */
  offers: MachineServer[];
  /** Its agent offers workspace tools, but its switch is off. */
  wsOff: boolean;
  /** Its agent takes ticks from the Machines page (#439), and whether it found anything there to tick. */
  managed: boolean;
  finds: boolean;
  check: StoredCheck | null;
  /** How many schemes are on its list (#438). */
  lent: number;
};

/** The one place a machine's status is decided (#437); test/machine-status.test.ts holds its table. */
export function machineStatus(f: StatusFacts): MachineStatus {
  const s = (status: MachineStatus['status'], reason: string, fix: MachineStatus['fix'] = null, when: MachineStatus['when'] = null): MachineStatus => ({ status, reason, fix, when });
  if (!f.online) {
    const added = { label: 'added', at: f.createdAt } as const;
    if (f.lastSeenAt === null) return f.now - f.createdAt >= NEVER_CONNECTED_MS ? s('down', 'Never connected', 'remove', added) : s('asleep', 'Not connected yet', null, added);
    const seen = { label: 'seen', at: f.lastSeenAt } as const;
    // Offline since this server started at the earliest: a restart isn't the machine's fault.
    if (f.alwaysOn && f.now - Math.max(f.lastSeenAt, f.startedAt) >= DOWN_AFTER_MS) return s('down', 'Offline', 'always_on', seen);
    return s('asleep', f.alwaysOn ? 'Offline' : 'Asleep', null, seen);
  }
  if (f.runners) return s('ready', 'CI runner host, connected');
  if (!f.offers.length && f.managed) {
    return f.finds ? s('fix', 'Lends nothing: nothing is ticked', 'tick') : s('fix', 'Found nothing to lend on that computer', 'tick');
  }
  if (!f.offers.length) {
    return f.wsOff ? s('fix', 'Lends nothing: workspace tools are off', 'workspace_tools') : s('fix', 'Lends nothing: no MCP server or folder on that computer', 'token');
  }
  const results = f.offers.map((server) => f.check?.results.find((r) => r.server === server));
  if (results.some((r) => !r)) return s('checking', 'Checking its tools…');
  const checked = { label: 'checked', at: f.check!.at } as const;
  const failed = results.find((r) => !r!.ok);
  if (failed) return s('fix', `Its ${failed.server === 'ws' ? 'workspace ' : ''}tools didn't start: ${failed.error}`, 'check', checked);
  if (!f.lent) return s('fix', 'Lent to no scheme', 'lend', checked);
  const tools = results.reduce((n, r) => n + r!.tools.length, 0);
  return s('ready', `Ready · ${tools} tool${tools === 1 ? '' : 's'}`, null, checked);
}

export function storedCheck(m: Pick<Machine, 'last_check'>): StoredCheck | null {
  try {
    return m.last_check ? JSON.parse(m.last_check) : null;
  } catch {
    return null;
  }
}

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A machine's secret: its id (to look it up) and 32 random bytes. Its hash checks it; a sealed copy is only for its owner's Show (#1355). */
export function newToken(machineId: number): string {
  return `ccm_${machineId}_${randomBytes(32).toString('base64url')}`;
}

interface Agent {
  res: ServerResponse;
  host: string;
  command: string;
  since: number;
  sessions: Set<string>;
  // What the agent says it offers; an agent from before workspaces never says, and lends its MCP server.
  servers: MachineServer[];
  /** It posts v 2 (#439): it reports what it found and serves what is ticked. Otherwise it lends what its own command line says. */
  managed: boolean;
  found: FoundServer[];
  workspaces: { name: string }[];
  problems: string[];
  /** Its hourly check, and the connect check for an agent that never posts its info (#437). */
  timers: NodeJS.Timeout[];
  /** A CI runner agent (public/runner-agent.mjs, #328): it serves no MCP server, only runner jobs. */
  runners: boolean;
  /** Which runners it adds (#510): Windows services, or Linux ones inside WSL. An agent that doesn't say is a Windows one. */
  os: 'windows' | 'linux';
  /** When it last beat; null for an agent from before beats, which is never dropped for missing them. */
  beat?: number;
  /** A test box's screen (#1422), from its beats: who has it and who waits in its line. */
  screen?: ScreenState | null;
}

export type ScreenUser = { what: string; who: string; since: number | null };
export type ScreenState = { holder: ScreenUser | null; line: ScreenUser[] };

/** The screen a beat reports, cut to size; null when it says nothing usable. */
export function cleanScreen(v: unknown): ScreenState | null {
  type Raw = { what?: unknown; who?: unknown; since?: unknown } | null | undefined;
  const s = v as { holder?: Raw; line?: Raw[] } | null;
  if (!s || typeof s !== 'object' || !Array.isArray(s.line)) return null;
  const user = (u: Raw): ScreenUser | null => (u && typeof u === 'object' ? { what: String(u.what ?? '').slice(0, 200), who: String(u.who ?? '').slice(0, 200), since: Number.isFinite(u.since) ? (u.since as number) : null } : null);
  return {
    holder: user(s.holder),
    line: s.line
      .slice(0, 50)
      .map(user)
      .filter((u: ScreenUser | null): u is ScreenUser => !!u),
  };
}

/** One job for a CI runner agent (#328): add, list or remove one scheme's runners on its PC. */
export type RunnerJob = { op: 'add'; scheme: number; count: number } | { op: 'list' } | { op: 'remove'; scheme: number };
/** What the agent answers: whether its script exited 0, and the end of what it printed. */
export type RunnerJobResult = { ok: boolean; output: string };
// Downloading the 100 MB runner and configuring four instances takes minutes; a stuck script ends at the agent's own limit first.
const RUNNER_JOB_MS = 20 * 60_000;

/** Whose turn a session serves: a minion's (its ticket and scheme), a contraption turn's (#306), or Citadel's own check of a machine (#437). */
export type SessionHolder = { ticketId: number; projectId: number } | { contraptionTurn: number } | { check: number };

interface Session {
  machineId: number;
  /** 't<ticket id>' or 'c<contraption turn id>': only that turn's proxy may send on it. */
  holder: string;
  /** The minion, for fetch_file; null for a contraption turn. */
  ticketId: number | null;
  /** The minion's scheme, so taking a scheme off a machine's list ends its sessions; null for a contraption turn. */
  projectId: number | null;
  server: MachineServer;
  /** Which minion, for the agent's log and its workspace lock ("#90 in Citadel"). */
  who: string;
  res: ServerResponse;
  /** Its GPU_TASK calls waiting on the agent's answer, by JSON-RPC id, to learn the job's id. */
  gpuAsks?: Set<unknown>;
  /** A minion's run_task, job and stop_job calls waiting on the agent's answer, by JSON-RPC id: a job waiting for the screen gets a box watch (#1425). */
  jobAsks?: Set<unknown>;
}

/**
 * A test-box job waiting in line for the screen that Citadel follows for its minion (#1425), so the minion can end
 * its turn: Citadel calls job for it, which keeps its place in the line, and messages the minion's chat when it gets
 * the screen and when it ends. Kept in a setting, so a restart carries on following it.
 */
export type BoxWatch = { machine: number; job: string; ticket: number; what: string; since: number; started?: true };
/** A watch while Citadel follows it: `cancel` ends the call it is waiting on, closing its session. */
type LiveWatch = BoxWatch & { done?: true; cancel?: () => void };
const BOX_WATCHES = 'box-watches';
/** A waiting job is asked after this often (its start is heard within about this long), a running one as long as the agent allows. */
const WATCH_QUEUED_WAIT_S = 10;
const WATCH_RUNNING_WAIT_S = 50;
/** No answer this long: the session is closed and another opened. */
const WATCH_ASK_MS = 90_000;
const WATCH_RETRY_MS = 15_000;
/** Past the line's worst case (CI's 40 minute take and 30 minute holds) and a 30 minute run: Citadel stops and says so, taking a job still in line out of it. */
const WATCH_MAX_MS = 12 * 60 * 60_000;
/** The agent's words (public/machine-agent.mjs report()) for a job waiting, running, ended, or forgotten by a restart. */
export const JOB_WORDS = {
  queued: /waiting in line for the screen \(job ([0-9a-f]+)\)/,
  running: /still running after \d+ s \(job ([0-9a-f]+)\)/,
  ended: /\. Job ([0-9a-f]+); full log/,
  gone: /^No job \S+ here/,
};
const { queued: QUEUED_JOB, running: RUNNING_JOB, ended: ENDED_JOB, gone: NO_JOB } = JOB_WORDS;
/** A JSON-RPC reply from a machine's MCP server, as far as Citadel reads it. */
type RpcReply = { id?: unknown; result?: { content?: { type?: string; text?: unknown }[]; tools?: { name?: unknown }[] }; error?: { message?: string } } | null | undefined;
const replyText = (reply: RpcReply): string => String(reply?.result?.content?.[0]?.text ?? reply?.error?.message ?? '');
/** A job reply's head, without the output tail, which can quote any of JOB_WORDS. */
const replyHead = (text: string): string => text.split('\n--- ')[0];
const watchKey = (w: Pick<BoxWatch, 'machine' | 'job'>) => `${w.machine}:${w.job}`;

function cleanWatches(v: unknown): BoxWatch[] {
  return (Array.isArray(v) ? v : []).flatMap((w: { machine?: number; ticket?: number; job?: string; what?: unknown; since?: number; started?: unknown } | null) =>
    Number.isInteger(w?.machine) && Number.isInteger(w?.ticket) && typeof w?.job === 'string' && /^[0-9a-f]{1,32}$/.test(w.job) && Number.isFinite(w?.since)
      ? [{ machine: w!.machine!, job: w!.job, ticket: w!.ticket!, what: String(w!.what ?? 'a task').slice(0, 200), since: w!.since!, ...(w.started ? { started: true as const } : {}) }]
      : [],
  );
}

/** `p`, or a throw once `ms` pass without it. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new Error(`no answer in ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** The workspaces an agent reports, cut down to what the Machines page shows. */
function cleanWorkspaces(v: unknown): { name: string }[] {
  const text = (x: unknown, max = 500) => (typeof x === 'string' ? x.slice(0, max) : '');
  const list = (x: unknown) => (Array.isArray(x) ? x.slice(0, 50) : []);
  return list(v).map((w: { name?: unknown; path?: unknown; read?: unknown; git_sync?: unknown; tasks?: unknown } | null) => ({
    name: text(w?.name, 40),
    path: text(w?.path),
    read: list(w?.read).map((r) => text(r)),
    git_sync: w?.git_sync !== false,
    tasks: list(w?.tasks).map((t: { name?: unknown; run?: unknown; about?: unknown; args?: unknown } | null) => ({ name: text(t?.name, 40), run: list(t?.run).map((a) => text(a)), about: text(t?.about), args: t?.args === true })),
  }));
}

/** The MCP servers an agent says it found, cut down to valid names, each once. */
function cleanFound(v: unknown): FoundServer[] {
  const seen = new Set<string>();
  return (Array.isArray(v) ? v.slice(0, 50) : []).flatMap((f: { name?: unknown; from?: unknown } | null) => {
    if (typeof f?.name !== 'string' || !SERVER_NAME.test(f.name) || seen.has(f.name)) return [];
    seen.add(f.name);
    return [{ name: f.name, from: f.from === 'file' ? 'file' : 'claude' } as FoundServer];
  });
}

/** The servers a turn gets from a connected machine: what is ticked and found (#439), or as an old agent says with its switch. */
function lentServers(m: Machine, agent: Agent): MachineServer[] {
  if (!agent.managed) return agent.servers.filter((s) => s === 'mcp' || m.workspace_tools);
  const lend = storedLend(m);
  if (!lend) return [];
  return [...(lend.server && agent.found.some((f) => f.name === lend.server) ? ['mcp' as const] : []), ...(agent.workspaces.some((w) => lend.workspaces.includes(w.name)) ? ['ws' as const] : [])];
}

const holderKey = (h: SessionHolder) => ('ticketId' in h ? `t${h.ticketId}` : 'contraptionTurn' in h ? `c${h.contraptionTurn}` : `k${h.check}`);

export class MachineRelay {
  private agents = new Map<number, Agent>();
  private sessions = new Map<string, Session>();
  /** Runner jobs sent to an agent and waiting on its answer, by job id. */
  private jobs = new Map<string, { machineId: number; done: (r: RunnerJobResult) => void }>();
  /**
   * GPU_TASK jobs a machine said were still running, by machine: the GPU jobs switch stops them.
   * shortcut: a job switched off inside its run_task call's first wait (50 s at most) is stopped when that answer comes, not at once.
   */
  private gpuJobs = new Map<number, Set<string>>();
  /** Test-box jobs waiting for the screen that Citadel follows for their minions (#1425), by machine and job. */
  private watches = new Map<string, LiveWatch>();
  /** How a box watch reaches its minion's chat; null (a preview, a test that doesn't ask) follows no jobs. */
  private wake: ((ticketId: number, text: string) => void) | null = null;
  /** Checks running now, by machine: one at a time each (#437). */
  private checks = new Map<number, Promise<CheckResult[]>>();
  private store: Store;
  private onChange: () => void;
  private startedAt = Date.now();
  private shown = '';
  /** The jobs queue's hooks (#857), set once by the server: an agent's report of the jobs it knows, and an agent gone. */
  jobHooks: { info(machine: Machine, known: { id: number; state: string }[] | null, since: number): void; offline(machineId: number): void } | null = null;

  constructor(store: Store, onChange: () => void) {
    this.store = store;
    this.onChange = onChange;
    // A status also changes with time alone (offline 5 minutes is Down): say so when one does.
    every('machine statuses', 60_000, () => this.statuses());
  }

  /** Every machine's status, telling the stream when one changed since last asked. */
  private statuses() {
    const now = JSON.stringify(this.list().map((m) => [m.id, m.status, m.reason, m.gets]));
    if (this.shown && now !== this.shown) this.onChange();
    this.shown = now;
  }

  /** Seals tokens for their owner's Show (#1355); server.ts derives it from SESSION_SECRET. */
  tokenKey: Buffer | null = null;

  /** A new token for a machine: its hash checks the agent, and a sealed copy lets its owner show it again (#1355). */
  issueToken(machineId: number): string {
    if (!this.tokenKey) throw new Error('MachineRelay.tokenKey is not set');
    const token = newToken(machineId);
    this.store.updateMachine(machineId, { token_hash: hashToken(token), token_sealed: seal(this.tokenKey, `machine:${machineId}`, token) });
    return token;
  }

  /** The machine's token, or null: linked before #1355, or sealed under another SESSION_SECRET. */
  shownToken(machine: Pick<Machine, 'id' | 'token_sealed'>): string | null {
    return this.tokenKey && machine.token_sealed ? unseal(this.tokenKey, `machine:${machine.id}`, machine.token_sealed) : null;
  }

  /** The machine whose token the request carries, or null. */
  authenticate(req: IncomingMessage): Machine | null {
    const m = (req.headers.authorization ?? '').match(/^Bearer (ccm_(\d+)_[\w-]{43})$/);
    if (!m) return null;
    const machine = this.store.getMachine(Number(m[2]));
    if (!machine) return null;
    const expected = Buffer.from(machine.token_hash, 'hex');
    const given = Buffer.from(hashToken(m[1]), 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given) ? machine : null;
  }

  view(machine: Machine) {
    const agent = this.agents.get(machine.id);
    const check = storedCheck(machine);
    // Its list of schemes (#438), and which of those schemes' turns get it: all of them, or for a person's own,
    // the ones its owner is in (and only the turns they ask for).
    const projects = this.store.machineProjects(machine.id);
    const owner = machine.owner_id === null ? [] : [machine.owner_id];
    const gets = this.store
      .listProjects()
      .filter((p) => lendsMachine(this.store, machine, p, owner))
      .map((p) => p.id);
    const offers = this.online().find((m) => m.id === machine.id)?.servers ?? [];
    const st = machineStatus({
      now: Date.now(),
      startedAt: this.startedAt,
      online: !!agent,
      runners: agent ? agent.runners : !!check?.runners,
      alwaysOn: !!machine.always_on,
      createdAt: machine.created_at,
      lastSeenAt: machine.last_seen_at,
      offers,
      wsOff: !machine.workspace_tools && !!agent?.servers.includes('ws'),
      check,
      managed: !!agent?.managed,
      finds: !!(agent?.found.length || agent?.workspaces.length),
      lent: projects.length,
    });
    return {
      ...st,
      always_on: !!machine.always_on,
      checked: check,
      checking: this.checks.has(machine.id),
      /** The schemes whose minions get it (a person's own: its owner's turns there). */
      gets,
      id: machine.id,
      name: machine.name,
      created_by: machine.created_by,
      owner_id: machine.owner_id,
      /** Whether its owner can show its token (#1355): false for one linked before, until a relink. */
      token_showable: !!this.shownToken(machine),
      notes: machine.notes,
      created_at: machine.created_at,
      last_seen_at: machine.last_seen_at,
      online: !!agent,
      host: agent?.host ?? null,
      command: agent?.command ?? null,
      connected_at: agent?.since ?? null,
      sessions: agent?.sessions.size ?? 0,
      workspace_tools: !!machine.workspace_tools,
      mcp_kind: machine.mcp_kind,
      mcp_command: machine.mcp_command,
      /** The schemes it is lent to: its list. */
      projects,
      /** False only for a CI runner host from before #438 with no list: it serves every scheme an admin owns. */
      scoped: !!machine.scoped,
      servers: agent?.servers ?? [],
      /** Whether its agent takes ticks (#439); null while offline, when nobody knows which agent will connect. */
      managed: agent ? agent.managed : null,
      /** The MCP servers its agent found there, and what is ticked; lend is null until a managed agent first reports. */
      found: agent?.found ?? [],
      lend: storedLend(machine),
      runners: agent ? agent.runners : !!check?.runners,
      workspaces: agent?.workspaces ?? [],
      problems: agent?.problems ?? [],
      /** What its owner's machine-agent.json lets jobs use (#857), or null: no jobs there. */
      jobs: storedOffer(machine),
      job_settings: storedSettings(machine),
      /** A test box's screen (#1422): who has it and who waits; null for other machines and while offline. */
      screen: agent?.screen ?? null,
    };
  }

  /** Send a job message (#857) to a machine's agent, if one with a jobs block is connected. */
  sendJob(machineId: number, msg: AgentJobMessage): boolean {
    const agent = this.agents.get(machineId);
    const machine = this.store.getMachine(machineId);
    if (!agent || agent.runners || !machine || !storedOffer(machine)) return false;
    agent.res.write(`data: ${JSON.stringify({ job: msg })}\n\n`);
    return true;
  }

  list() {
    return this.store.listMachines().map((m) => this.view(m));
  }

  /** Machines connected right now, with the servers a starting turn in any scheme should get. */
  online(): OnlineMachine[] {
    return this.store.listMachines().flatMap((m) => {
      const agent = this.agents.get(m.id);
      const servers = agent ? lentServers(m, agent) : [];
      return servers.length ? [{ ...m, servers }] : [];
    });
  }

  isOnline(machineId: number): boolean {
    return this.agents.has(machineId);
  }

  /** A machine's agent connected: hold the stream open and send it its sessions' messages. */
  connectAgent(machine: Machine, res: ServerResponse, info: { host: string; command: string; runners?: boolean; managed?: boolean; os?: 'windows' | 'linux' }) {
    // A newer connection wins: the old one is a laptop that dropped off without the server noticing.
    // Told so, the old one waits a while before it tries again: two agents with one token would otherwise drop each other at once, forever.
    const old = this.agents.get(machine.id);
    if (old) {
      old.res.write(`data: ${JSON.stringify({ replaced: true, by: info.host })}\n\n`);
      this.dropAgent(machine.id, old);
    }
    res.writeHead(200, SSE_HEADERS);
    res.write(`data: ${JSON.stringify({ hello: machine.name })}\n\n`);
    const mcp = !info.runners && machine.mcp_kind === null && mcpFromAgent(info.command);
    if (mcp) this.store.updateMachine(machine.id, mcp);
    const agent: Agent = { res, host: info.host, command: info.command, since: Date.now(), sessions: new Set(), servers: info.runners || info.managed ? [] : ['mcp'], managed: !info.runners && !!info.managed, found: [], workspaces: [], problems: [], timers: [], runners: !!info.runners, os: info.os ?? 'windows' };
    this.agents.set(machine.id, agent);
    if (agent.runners && this.shipList.length) res.write(`data: ${JSON.stringify({ ships: this.shipList })}\n\n`);
    // A runner host's check is its agent connecting: an hourly runner list could collide with a person's add, which the agent would refuse as busy.
    this.store.updateMachine(machine.id, { last_seen_at: agent.since, ...(info.runners ? { last_check: JSON.stringify({ at: agent.since, results: [], runners: true }) } : {}) });
    this.onChange();
    if (!info.runners) {
      agent.timers.push(
        setTimeout(() => this.checkIfDue(machine.id), CHECK_UNASKED_MS),
        setInterval(() => this.checkIfDue(machine.id), CHECK_EVERY_MS),
      );
      for (const t of agent.timers) t.unref();
    }
    const ping = setInterval(() => {
      if (agent.beat && Date.now() - agent.beat > BEAT_LOST_MS && this.agents.get(machine.id) === agent) return this.dropAgent(machine.id, agent);
      res.write(': ping\n\n');
    }, PING_MS);
    res.on('close', () => {
      clearInterval(ping);
      for (const t of agent.timers) clearTimeout(t);
      if (this.agents.get(machine.id) === agent) this.dropAgent(machine.id, agent);
    });
  }

  private dropAgent(machineId: number, agent: Agent) {
    this.agents.delete(machineId);
    // Their MCP servers are gone with the agent; ending the proxies' streams tells claude so.
    for (const id of agent.sessions) this.endSession(id, false);
    for (const [id, j] of this.jobs) if (j.machineId === machineId) j.done({ ok: false, output: 'The runner agent went offline before it answered; what it did so far is on its PC (list shows it).' });
    agent.res.end();
    if (this.store.getMachine(machineId)) this.store.updateMachine(machineId, { last_seen_at: Date.now() });
    this.onChange();
    this.jobHooks?.offline(machineId);
  }

  /** The agent says it is awake, and a test box's agent who has its screen. False if it isn't connected. */
  beat(machine: Machine, screen?: unknown): boolean {
    const agent = this.agents.get(machine.id);
    if (!agent) return false;
    agent.beat = Date.now();
    const next = screen === undefined ? null : cleanScreen(screen);
    const key = (st: ScreenState | null | undefined) => JSON.stringify(st ?? null);
    const was = key(agent.screen);
    agent.screen = next;
    if (key(next) !== was) this.onChange();
    return true;
  }

  /** Disconnect a machine's agent (it was removed, or got a new token). */
  disconnect(machineId: number) {
    const agent = this.agents.get(machineId);
    if (agent) this.dropAgent(machineId, agent);
  }

  /** The agent says what it offers: its servers, and the workspaces in its config. False if it isn't connected. */
  setInfo(machine: Machine, body: { v?: unknown; found?: unknown; servers?: unknown; workspaces?: unknown; problems?: unknown; jobs?: unknown; known_jobs?: unknown }): boolean {
    const agent = this.agents.get(machine.id);
    if (!agent) return false;
    // A runner agent offers no MCP server or workspaces, whatever it says.
    if (agent.runners) return true;
    agent.managed = body.v === 2;
    agent.found = agent.managed ? cleanFound(body.found) : [];
    agent.workspaces = cleanWorkspaces(body.workspaces);
    agent.servers = agent.managed ? [...(agent.found.length ? ['mcp' as const] : []), ...(agent.workspaces.length ? ['ws' as const] : [])] : (['mcp', 'ws'] as const).filter((s) => Array.isArray(body.servers) && body.servers.includes(s));
    agent.problems = (Array.isArray(body.problems) ? body.problems : []).slice(0, 50).map((p) => String(p).slice(0, 500));
    // Its owner's jobs block (#857), or none, and the jobs it holds, which the queue reconciles. An agent lists them even
    // with no block (a typo in its config still leaves them running there); with no list at all nothing is taken as lost (MA1).
    const offer = cleanOffer(body.jobs);
    this.store.updateMachine(machine.id, { jobs: offer ? JSON.stringify(offer) : null });
    const known = Array.isArray(body.known_jobs) ? body.known_jobs.slice(0, 100).flatMap((k: { id?: unknown; state?: unknown } | null) => (Number.isInteger(k?.id) && typeof k!.state === 'string' ? [{ id: k!.id as number, state: k!.state.slice(0, 20) as string }] : [])) : null;
    if (offer || machine.jobs || known) this.jobHooks?.info(this.store.getMachine(machine.id)!, known, agent.since);
    if (agent.managed) {
      // Its first report as a managed agent: the ticks start from what it lent before, so a reinstall changes nothing a minion gets.
      const prev = storedLend(machine);
      if (!prev || prev.before_ticks) {
        const was = machine.mcp_kind === 'claude' ? machine.mcp_command || DEFAULT_CLAUDE_MCP : null;
        const lend: Lend = { server: was && agent.found.some((f) => f.name === was) ? was : null, workspaces: machine.workspace_tools ? agent.workspaces.map((w) => w.name).filter((n) => WORKSPACE_NAME.test(n)) : [], ...(prev?.gpu_off ? { gpu_off: true as const } : {}) };
        this.store.updateMachine(machine.id, { lend: JSON.stringify(lend) });
      }
      this.sendLend(machine.id);
    }
    // A server it no longer offers is gone for the sessions using it.
    const offers = lentServers(this.store.getMachine(machine.id)!, agent);
    for (const id of agent.sessions) if (!offers.includes(this.sessions.get(id)!.server)) this.endSession(id, true);
    this.onChange();
    this.checkIfDue(machine.id);
    return true;
  }

  /** Tell a managed agent what is ticked; it serves nothing else. */
  private sendLend(machineId: number) {
    const agent = this.agents.get(machineId);
    const machine = this.store.getMachine(machineId);
    if (agent?.managed && machine) agent.res.write(`data: ${JSON.stringify({ lend: storedLend(machine) ?? { server: null, workspaces: [] } })}\n\n`);
  }

  /**
   * A person changed a machine's ticks (#439): keep them, tell its agent, end the sessions on what is no longer
   * lent, and check what is new. Another MCP server ticked is a new server to check.
   */
  setLend(machineId: number, lend: Lend) {
    const machine = this.store.getMachine(machineId);
    if (!machine) return;
    // An agent from before #439 lends what its command line says: only its GPU switch is saved here.
    const swapped = !lend.before_ticks && storedLend(machine)?.server !== lend.server;
    const check = swapped && storedCheck(machine);
    this.store.updateMachine(machineId, { lend: JSON.stringify(lend), ...(check ? { last_check: JSON.stringify({ ...check, results: check.results.filter((r) => r.server !== 'mcp') }) } : {}) });
    this.sendLend(machineId);
    if (lend.gpu_off) for (const job of this.gpuJobs.get(machineId) ?? []) this.stopGpuJob(machineId, job);
    const offers = this.online().find((m) => m.id === machineId)?.servers ?? [];
    for (const server of ['mcp', 'ws'] as const) if ((server === 'mcp' && swapped) || !offers.includes(server)) this.endServer(machineId, server);
    this.checkIfDue(machineId);
  }

  /**
   * Check a connected machine when its last check is an hour old, or failed before this connection (its owner
   * may have fixed it and restarted the agent), and otherwise only what it offers that no check covers yet
   * (#437): on connect, hourly, and when what it offers changes. No server is started more often unasked.
   */
  checkIfDue(machineId: number) {
    const machine = this.store.getMachine(machineId);
    const agent = this.agents.get(machineId);
    if (!machine || !agent || agent.runners || this.checks.has(machineId)) return;
    const check = storedCheck(machine);
    const offers = this.online().find((m) => m.id === machineId)?.servers ?? [];
    const stale = !check || Date.now() - check.at >= CHECK_EVERY_MS - 60_000 || (check.at < agent.since && check.results.some((r) => !r.ok));
    const missing = offers.filter((s) => !check?.results.some((r) => r.server === s));
    if (stale || missing.length) this.check(machineId, CHECK_MS, stale ? undefined : missing).catch(() => {});
  }

  /** Machines whose CI runner agent for `os` (#510) is connected now (#328). */
  runnerMachines(os: 'windows' | 'linux' = 'windows'): Machine[] {
    return this.store.listMachines().filter((m) => {
      const a = this.agents.get(m.id);
      return a?.runners && a.os === os;
    });
  }

  /** The runners on a ship run's job now (#1268), sent to every runner agent at each look and to one as it connects. */
  private shipList: { repo: string; runner: string }[] = [];
  sendShips(ships: { repo: string; runner: string }[]) {
    this.shipList = ships;
    for (const agent of this.agents.values()) if (agent.runners) agent.res.write(`data: ${JSON.stringify({ ships })}\n\n`);
  }

  /** Send a runner agent one job and wait for its answer; a refusal, an offline agent or no answer in time comes back as ok: false. */
  runnerJob(machineId: number, job: RunnerJob, timeoutMs = RUNNER_JOB_MS): Promise<RunnerJobResult> {
    const agent = this.agents.get(machineId);
    if (!agent?.runners) return Promise.resolve({ ok: false, output: 'No runner agent is connected for that machine.' });
    const id = randomBytes(12).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => done({ ok: false, output: `The runner agent didn't answer in ${Math.round(timeoutMs / 60_000)} minutes; list shows what it did.` }), timeoutMs);
      const done = (r: RunnerJobResult) => {
        if (!this.jobs.delete(id)) return;
        clearTimeout(timer);
        resolve(r);
      };
      this.jobs.set(id, { machineId, done });
      agent.res.write(`data: ${JSON.stringify({ runners: { id, ...job } })}\n\n`);
    });
  }

  /** A runner agent's answer to a job. False if no such job is waiting on that machine. */
  runnerResult(machine: Machine, body: { id?: unknown; ok?: unknown; output?: unknown }): boolean {
    const job = typeof body.id === 'string' ? this.jobs.get(body.id) : undefined;
    if (!job || job.machineId !== machine.id) return false;
    job.done({ ok: body.ok === true, output: typeof body.output === 'string' ? body.output.slice(-20_000) : '' });
    return true;
  }

  /** A machine's last check (#307), kept in the database (#437), or null. */
  lastCheck(machineId: number): StoredCheck | null {
    const machine = this.store.getMachine(machineId);
    return machine ? storedCheck(machine) : null;
  }

  /**
   * Test a machine the way a turn uses it (#307): on each server a turn would get, open a session as a
   * turn's proxy does, send MCP initialize and tools/list, and close it. The agent starts a copy of its
   * server for the session, as for any turn, and no tool is called, so nothing on the machine changes.
   * One at a time per machine: asking while one runs gets that one's results (#437).
   */
  check(machineId: number, timeoutMs = CHECK_MS, only?: MachineServer[]): Promise<CheckResult[]> {
    const running = this.checks.get(machineId);
    if (running) return running;
    const run = this.runCheck(machineId, timeoutMs, only).finally(() => {
      this.checks.delete(machineId);
      this.onChange();
    });
    this.checks.set(machineId, run);
    this.onChange();
    return run;
  }

  /** `only`: check just these servers, keeping the last check's results for the others and its time. */
  private async runCheck(machineId: number, timeoutMs: number, only?: MachineServer[]): Promise<CheckResult[]> {
    const servers = (this.online().find((m) => m.id === machineId)?.servers ?? []).filter((s) => !only || only.includes(s));
    const agent = this.agents.get(machineId);
    const ticked = () => storedLend(this.store.getMachine(machineId) ?? ({} as Machine))?.server ?? null;
    const was = ticked();
    let results: CheckResult[] = [];
    for (const server of servers) results.push(await this.checkServer(machineId, { check: machineId }, server, "Citadel's check", timeoutMs));
    // Another MCP server was ticked meanwhile (#439): this result is the old one's, so the new one is checked next.
    if (ticked() !== was) {
      results = results.filter((r) => r.server !== 'mcp');
      setImmediate(() => this.checkIfDue(machineId));
    }
    // A reconnect mid-check is a new agent, and an offline one wasn't tested: keep the last real check.
    if (agent && this.agents.get(machineId) === agent && results.length) {
      const last = only && this.lastCheck(machineId);
      const kept = last ? last.results.filter((r) => !servers.includes(r.server)) : [];
      this.store.updateMachine(machineId, { last_check: JSON.stringify({ at: last ? last.at : Date.now(), results: [...kept, ...results] }) });
    }
    return results;
  }

  private checkServer(machineId: number, holder: SessionHolder, server: MachineServer, who: string, timeoutMs: number): Promise<CheckResult> {
    return this.converse(machineId, holder, server, who, timeoutMs, async (ask) => {
      const list = await ask(2, 'tools/list', {});
      if (list?.error) throw new Error(`tools/list failed: ${list.error.message ?? JSON.stringify(list.error)}`);
      if (!Array.isArray(list?.result?.tools)) throw new Error(`tools/list sent no tools: ${JSON.stringify(list).slice(0, 300)}`);
      return list.result.tools.map((t) => String(t?.name));
    });
  }

  /** Stop a GPU_TASK job (the GPU jobs switch went off) over a session of its own: the turn that ran it may be gone. */
  private stopGpuJob(machineId: number, job: string) {
    this.gpuJobs.get(machineId)?.delete(job);
    this.stopJob(machineId, job, GPU_OFF_WHO);
  }

  /** Stop a job on a machine, or take it out of the screen's line, over a session of its own. */
  private stopJob(machineId: number, job: string, who: string) {
    this.converse(machineId, { check: machineId }, 'ws', who, CHECK_MS, async (ask) => {
      const r = await ask(2, 'tools/call', { name: 'stop_job', arguments: { id: job } });
      if (r?.error) throw new Error(r.error.message ?? JSON.stringify(r.error));
      return [];
    }).then((r) => r.ok || console.error(`[machines] couldn't stop job ${job} on machine ${machineId} for ${who}: ${r.error}`));
  }

  /** Start following test-box jobs for minions (#1425), with how a message reaches a minion's chat; carries on with the ones a restart left. */
  watchBoxes(wake: (ticketId: number, text: string) => void) {
    this.wake = wake;
    for (const w of cleanWatches(this.store.getSetting(BOX_WATCHES))) this.watch(w);
  }

  /** The jobs Citadel follows now. */
  boxWatches(): BoxWatch[] {
    return [...this.watches.values()].map(({ done: _, cancel: __, ...w }) => w);
  }

  /** A person stopped this minion's turn: Citadel stops following its jobs, and one still waiting for the screen leaves the line. */
  minionStopped(ticketId: number): number {
    const mine = [...this.watches.values()].filter((w) => w.ticket === ticketId);
    for (const w of mine) this.unwatch(w, 'stopped');
    return mine.length;
  }

  /** Follow a job for a minion; false if another minion's watch has it. */
  private watch(w: BoxWatch): boolean {
    const had = this.watches.get(watchKey(w));
    if (had) return had.ticket === w.ticket;
    const mine = { ...w };
    this.watches.set(watchKey(w), mine);
    this.saveWatches();
    void this.follow(mine);
    return true;
  }

  private saveWatches() {
    this.store.setSetting(BOX_WATCHES, this.boxWatches());
  }

  /** Stop following a job. A minion stopped or closed takes a job still waiting for the screen out of the line, as its turn ending did before. */
  private unwatch(w: LiveWatch, why: 'seen' | 'told' | 'stopped' | 'closed' | 'unlent' | 'capped') {
    if (w.done) return;
    w.done = true;
    if (this.watches.get(watchKey(w)) === w) this.watches.delete(watchKey(w));
    this.saveWatches();
    w.cancel?.();
    const because = { stopped: 'its turn was stopped', closed: 'it was closed', unlent: 'the box is no longer lent to its scheme', capped: `it waited ${WATCH_MAX_MS / 3_600_000} hours in line` } as Record<string, string>;
    if (because[why] && !w.started) this.stopJob(w.machine, w.job, `Citadel, for ${this.minionName(w.ticket)} (${because[why]})`);
  }

  private minionName(ticketId: number): string {
    const t = this.store.getTicket(ticketId);
    const p = t && this.store.getProject(t.project_id);
    return t ? `${p ? `${p.name} ` : ''}#${t.number}` : `minion ${ticketId}`;
  }

  private machineName(machineId: number): string {
    return this.store.getMachine(machineId)?.name ?? `machine ${machineId}`;
  }

  /** Ask after a watched job until it ends, over sessions of Citadel's own, opened again after the machine drops or stalls. */
  private async follow(w: LiveWatch) {
    while (!w.done) {
      const r = await this.converse(w.machine, { check: w.machine }, 'ws', `Citadel, following job ${w.job} for ${this.minionName(w.ticket)}`, WATCH_MAX_MS, (ask) => this.followJob(w, ask));
      if (w.done || this.watchOver(w)) return;
      if (!r.ok) console.error(`[machines] following job ${w.job} on machine ${w.machine}: ${r.error}; trying again`);
      await new Promise((ok) => setTimeout(ok, WATCH_RETRY_MS).unref?.());
    }
  }

  /** True, with the watch ended, once its minion is closed or Citadel has followed it too long. */
  private watchOver(w: LiveWatch): boolean {
    if (w.done) return true;
    const t = this.store.getTicket(w.ticket);
    if (!t || t.status === 'closed') {
      this.unwatch(w, 'closed');
      return true;
    }
    if (!this.store.machineGranted(w.machine, t.project_id)) {
      this.unwatch(w, 'unlent');
      this.tell(w, `Citadel stopped following your job ${w.job} on ${this.machineName(w.machine)} (${w.what}): that computer is no longer lent to this scheme${w.started ? '' : ', so the job left the line'}.`);
      return true;
    }
    if (Date.now() - w.since > WATCH_MAX_MS) {
      // Still in line at the cap: it leaves now and says so, rather than wait on unfollowed and leave later unseen.
      this.unwatch(w, 'capped');
      const hours = WATCH_MAX_MS / 3_600_000;
      this.tell(
        w,
        w.started
          ? `Citadel stopped following your job ${w.job} on ${this.machineName(w.machine)} (${w.what}) after ${hours} hours. Call job with id "${w.job}" there to see where it is.`
          : `Your job ${w.job} on ${this.machineName(w.machine)} (${w.what}) waited ${hours} hours in line for the screen without getting it, so Citadel took it out of the line: nothing was started. Run run_task again if you still need it.`,
      );
      return true;
    }
    return false;
  }

  private tell(w: BoxWatch, text: string) {
    try {
      this.wake?.(w.ticket, text);
    } catch (err) {
      console.error(`[machines] couldn't tell ${this.minionName(w.ticket)} about job ${w.job}: ${thrown(err).message}`);
    }
  }

  private async followJob(w: LiveWatch, ask: (id: number, method: string, params: object) => Promise<RpcReply>): Promise<string[]> {
    const box = this.machineName(w.machine);
    const cancelled = new Promise<never>((_, fail) => {
      w.cancel = () => fail(new Error('Citadel stopped following it'));
    });
    cancelled.catch(() => {});
    for (let id = 2; !this.watchOver(w); id++) {
      const asked = ask(id, 'tools/call', { name: 'job', arguments: { id: w.job, wait: w.started ? WATCH_RUNNING_WAIT_S : WATCH_QUEUED_WAIT_S, lines: 40 } });
      const reply = await Promise.race([within(asked, WATCH_ASK_MS), cancelled]);
      if (w.done) break;
      const text = replyText(reply);
      if (reply?.error) throw new Error(text || JSON.stringify(reply.error));
      const head = replyHead(text);
      if (QUEUED_JOB.exec(head)?.[1] === w.job) continue;
      if (RUNNING_JOB.exec(head)?.[1] === w.job) {
        if (!w.started) {
          w.started = true;
          this.saveWatches();
          this.tell(w, `Your job ${w.job} on ${box} (${w.what}) has the screen now and is running. Citadel messages you again when it ends, with its exit code and last lines. While it runs you can take a screenshot, or stop it with stop_job (id "${w.job}"); if you're only waiting for its result, end your turn.`);
        }
        continue;
      }
      // Told before the watch is dropped: a restart between the two repeats the message rather than losing it.
      if (ENDED_JOB.exec(head)?.[1] === w.job) this.tell(w, `Your job ${w.job} on ${box} (${w.what}) ${w.started ? 'has ended' : 'got the screen and has ended'}. Its report:\n${asData(box, text)}`);
      else if (NO_JOB.test(head)) this.tell(w, `Your job ${w.job} on ${box} (${w.what}) is gone: the box's agent restarted and forgot it, so whether it ${w.started ? 'finished' : 'ran'} is unknown (its log, if any, stays on that computer). Run it again if you still need it.`);
      else this.tell(w, `Citadel stopped following your job ${w.job} on ${box} (${w.what}): the box answered\n${asData(box, text)}`);
      this.unwatch(w, 'told');
    }
    return [];
  }

  /** A minion heard of a job (#1425): one waiting for the screen gets a watch, and the reply says so; one it saw start or end needs no message for that. */
  private heardJob(s: Session, reply: RpcReply): RpcReply {
    if (s.ticketId === null || !this.wake || reply?.error) return reply;
    const text = replyHead(replyText(reply));
    const queued = QUEUED_JOB.exec(text)?.[1];
    if (queued) {
      const what = /^(.+?) is waiting in line for the screen/.exec(text)?.[1]?.slice(0, 200) ?? 'a task';
      const had = this.watches.get(watchKey({ machine: s.machineId, job: queued }));
      if (had) return reply; // already followed: said once, in the reply that queued it
      if (!this.watch({ machine: s.machineId, job: queued, ticket: s.ticketId, what, since: Date.now() })) return reply;
      const note = `\n\nCitadel is following job ${queued} for you, which keeps its place in line: you can end your turn now. A message comes to this chat when it gets the screen and again when it ends, with its exit code and last lines. Calling job yourself still works too.`;
      const content = [...reply!.result!.content!];
      content[0] = { ...content[0], text: `${content[0].text}${note}` };
      return { ...reply, result: { ...reply!.result, content } };
    }
    const job = RUNNING_JOB.exec(text)?.[1] ?? ENDED_JOB.exec(text)?.[1];
    const w = job && this.watches.get(watchKey({ machine: s.machineId, job }));
    if (w && w.ticket === s.ticketId) {
      if (ENDED_JOB.test(text)) this.unwatch(w, 'seen');
      else if (!w.started) {
        w.started = true;
        this.saveWatches();
      }
    }
    return reply;
  }

  /** Open a session on a machine's server as a turn's proxy does, initialize it, run `talk`, and close it. */
  private converse(machineId: number, holder: SessionHolder, server: MachineServer, who: string, timeoutMs: number, talk: (ask: (id: number, method: string, params: object) => Promise<RpcReply>) => Promise<string[]>): Promise<CheckResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      // Stands in for the proxy's stream: the session id, then the machine's replies, as server-sent events.
      const sink = new EventEmitter() as EventEmitter & { writeHead(): void; write(chunk: string): boolean; end(): void };
      const waiting = new Map<number, (reply: RpcReply) => void>();
      let session = '';
      let done = false;
      let ended = false;
      const finish = (ok: boolean, tools: string[], error: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({ server, ok, tools, error, ms: Date.now() - started });
        sink.end();
      };
      sink.writeHead = () => {};
      sink.write = (chunk: string) => {
        for (const line of String(chunk).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const msg = JSON.parse(line.slice(6));
          if (msg.session) session = msg.session;
          else waiting.get(msg.message?.id)?.(msg.message);
        }
        return true;
      };
      // The relay ends the stream when the agent drops or its server exits; ending it ourselves closes the session.
      sink.end = () => {
        if (!ended) {
          ended = true;
          sink.emit('close');
        }
        finish(false, [], 'the session ended: the machine went offline or its MCP server exited');
      };
      const timer = setTimeout(() => finish(false, [], `no answer in ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
      const send = (message: object) => this.fromSession(session, holder, { jsonrpc: '2.0', ...message }) || finish(false, [], 'the machine went offline');
      const ask = (id: number, method: string, params: object) =>
        new Promise<RpcReply>((res) => {
          waiting.set(id, res);
          send({ id, method, params });
        });
      if (!this.openSession(machineId, holder, server, who, sink as unknown as ServerResponse)) {
        return finish(false, [], server === 'ws' ? 'offline, or its workspace tools are off' : 'offline');
      }
      (async () => {
        const init = await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'citadel-check', version: '1' } });
        if (init?.error) return finish(false, [], `initialize failed: ${init.error.message ?? JSON.stringify(init.error)}`);
        send({ method: 'notifications/initialized' });
        finish(true, await talk(ask), null);
      })().catch((err) => finish(false, [], err.message));
    });
  }

  /** End a machine's sessions of one server (its workspace tools were switched off). */
  endServer(machineId: number, server: MachineServer) {
    for (const [id, s] of this.sessions) if (s.machineId === machineId && s.server === server) this.endSession(id, true);
  }

  /** End a machine's sessions in schemes it is no longer lent to. */
  endSessionsWhere(machineId: number, gone: (projectId: number) => boolean) {
    for (const [id, s] of this.sessions) if (s.machineId === machineId && s.projectId !== null && gone(s.projectId)) this.endSession(id, true);
  }

  /** The thread a machine's workspace session serves, for a file its agent sends; null if none. */
  workspaceTicket(machine: Machine, sessionId: string): number | null {
    const s = this.sessions.get(sessionId);
    return s && s.machineId === machine.id && s.server === 'ws' ? s.ticketId : null;
  }

  /** A message from a machine's MCP server, or word that it exited. False if the session is gone. */
  fromAgent(machine: Machine, sessionId: string, body: { message?: unknown; closed?: boolean }): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.machineId !== machine.id) return false;
    if (body.closed) {
      // Its proxy gives up rather than reconnecting, which would start the server again.
      s.res.write(`data: ${JSON.stringify({ closed: true })}\n\n`);
      this.endSession(sessionId, false);
      return true;
    }
    const reply = body.message as RpcReply;
    if (s.gpuAsks?.delete(reply?.id)) {
      // The agent's report of a job that outlasted the call's wait: "... still running after 50 s (job 1a2b3c4d).",
      // or one still waiting in the screen's line (#1422): "... is waiting in line for the screen (job 1a2b3c4d)".
      const job = /(?:still running after \d+ s|waiting in line for the screen) \(job ([0-9a-f]+)\)/.exec(String(reply?.result?.content?.[0]?.text ?? ''))?.[1];
      if (job) {
        const jobs = this.gpuJobs.get(s.machineId) ?? new Set();
        this.gpuJobs.set(s.machineId, jobs.add(job));
        // Ended ones aren't told apart; stopping one is harmless, and a job runs 30 min at most, so the newest few cover it.
        for (const old of jobs) if (jobs.size > 20) jobs.delete(old);
        // Switched off while the call was on its way.
        const now = this.store.getMachine(machine.id);
        if (now && storedLend(now)?.gpu_off) this.stopGpuJob(s.machineId, job);
      }
    }
    const message = s.jobAsks?.delete(reply?.id) ? this.heardJob(s, reply) : body.message;
    s.res.write(`data: ${JSON.stringify({ message })}\n\n`);
    return true;
  }

  /** A turn's proxy started: give it a session whose stream carries the machine's replies. */
  openSession(machineId: number, holder: SessionHolder, server: MachineServer, who: string, res: ServerResponse): boolean {
    const agent = this.agents.get(machineId);
    if (!agent || !this.online().some((m) => m.id === machineId && m.servers.includes(server))) return false;
    const id = randomBytes(12).toString('hex');
    const minion = 'ticketId' in holder ? holder : null;
    this.sessions.set(id, { machineId, holder: holderKey(holder), ticketId: minion?.ticketId ?? null, projectId: minion?.projectId ?? null, server, who, res });
    agent.sessions.add(id);
    res.writeHead(200, SSE_HEADERS);
    res.write(`data: ${JSON.stringify({ session: id })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    res.on('close', () => {
      clearInterval(ping);
      this.endSession(id, true);
    });
    this.onChange();
    return true;
  }

  /** A message from a thread's proxy to the machine. False if the session or machine is gone. */
  fromSession(sessionId: string, holder: SessionHolder, message: unknown): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.holder !== holderKey(holder)) return false;
    const call = message as { id?: unknown; method?: string; params?: { name?: string; arguments?: { task?: string } } } | null | undefined;
    if (s.server === 'ws' && call?.method === 'tools/call' && call.params?.name === 'run_task' && call.params?.arguments?.task === GPU_TASK) {
      const machine = this.store.getMachine(s.machineId);
      if (machine && storedLend(machine)?.gpu_off) {
        const text = `GPU jobs are switched off for ${machine.name} on Citadel's Machines page. Nothing was run. Don't retry: use the run task (software drawing), or ask a person to switch GPU jobs back on.`;
        s.res.write(`data: ${JSON.stringify({ message: { jsonrpc: '2.0', id: call.id, result: { content: [{ type: 'text', text }], isError: true } } })}\n\n`);
        return true;
      }
      (s.gpuAsks ??= new Set()).add(call.id);
    }
    if (s.server === 'ws' && s.ticketId !== null && call?.method === 'tools/call' && ['run_task', 'job', 'stop_job'].includes(call.params?.name as string)) (s.jobAsks ??= new Set()).add(call.id);
    const agent = this.agents.get(s.machineId);
    if (!agent) return false;
    if (agent.res.writableLength > MAX_BACKLOG) {
      this.dropAgent(s.machineId, agent);
      return false;
    }
    // The agent starts a session's server on its first message, so each one says which.
    agent.res.write(`data: ${JSON.stringify({ session: sessionId, server: s.server, who: s.who, message })}\n\n`);
    return true;
  }

  private endSession(id: string, tellAgent: boolean) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    const agent = this.agents.get(s.machineId);
    agent?.sessions.delete(id);
    // The agent stops that session's MCP server.
    if (tellAgent && agent) agent.res.write(`data: ${JSON.stringify({ session: id, close: true })}\n\n`);
    s.res.end();
    this.onChange();
  }
}
