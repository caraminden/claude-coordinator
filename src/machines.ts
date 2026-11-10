// Machines: people's own computers lending their MCP servers (a Godot editor, say) to threads.
// A machine runs public/machine-agent.mjs, which dials out to the app and holds an event stream
// open; perigee can't reach a laptop directly, so everything flows over connections the laptop
// opens. During a turn, each online machine appears to claude as a stdio MCP server
// (src/machine-mcp.ts) that pipes its messages through here: claude -> proxy -> POST -> agent
// stream -> local MCP server, and back the same way. Each proxy is one session, and the agent
// runs one copy of the MCP server per session, so concurrent threads never share one.
// An agent with a workspaces config also serves its own workspace tools (server "ws"), which threads
// see as mcp__<name>-ws__…, only while a person has the machine's workspace tools switched on.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { lendsMachine } from './access.ts';
import type { Machine, Store } from './db.ts';

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

/** The servers an agent can offer: the MCP server it lends, and its built-in workspace tools. */
export type MachineServer = 'mcp' | 'ws';
export type OnlineMachine = Machine & { servers: MachineServer[] };

// An agent that stops reading (asleep mid-stream) is dropped rather than buffered for forever.
const MAX_BACKLOG = 64 * 1024 * 1024;
const PING_MS = 25_000;
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
  fix: 'check' | 'workspace_tools' | 'lend' | 'machine_tools' | 'token' | 'remove' | 'always_on' | null;
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
  check: StoredCheck | null;
  /** A person's own machine: it goes to the turns they ask for, so it is lent to no scheme. */
  owned: boolean;
  /** The schemes it is lent to, and how many of those have machine tools on. */
  lent: number;
  lentOn: number;
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
  if (!f.offers.length) {
    return f.wsOff ? s('fix', 'Lends nothing: workspace tools are off', 'workspace_tools')
      : s('fix', 'Lends nothing: no MCP server or folder on that computer', 'token');
  }
  const results = f.offers.map((server) => f.check?.results.find((r) => r.server === server));
  if (results.some((r) => !r)) return s('checking', 'Checking its tools…');
  const checked = { label: 'checked', at: f.check!.at } as const;
  const failed = results.find((r) => !r!.ok);
  if (failed) return s('fix', `Its ${failed.server === 'ws' ? 'workspace ' : ''}tools didn't start: ${failed.error}`, 'check', checked);
  if (!f.owned && !f.lent) return s('fix', 'Lent to no scheme', 'lend', checked);
  if (!f.owned && !f.lentOn) return s('fix', f.lent === 1 ? 'Its scheme has machine tools off' : 'Every scheme it is lent to has machine tools off', 'machine_tools', checked);
  const tools = results.reduce((n, r) => n + r!.tools.length, 0);
  return s('ready', `Ready · ${tools} tool${tools === 1 ? '' : 's'}`, null, checked);
}

function storedCheck(m: Machine): StoredCheck | null {
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

/** A machine's secret: its id (to look it up) and 32 random bytes. Only the hash is stored. */
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
  workspaces: unknown[];
  problems: string[];
  /** Its hourly check, and the connect check for an agent that never posts its info (#437). */
  timers: NodeJS.Timeout[];
  /** A CI runner agent (public/runner-agent.mjs, #328): it serves no MCP server, only runner jobs. */
  runners: boolean;
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
  /** The minion's scheme, so taking a scheme off a scoped machine ends its sessions; null for a contraption turn. */
  projectId: number | null;
  server: MachineServer;
  /** Which minion, for the agent's log and its workspace lock ("#90 in Citadel"). */
  who: string;
  res: ServerResponse;
}

/** The workspaces an agent reports, cut down to what the Machines page shows. */
function cleanWorkspaces(v: unknown): unknown[] {
  const text = (x: unknown, max = 500) => (typeof x === 'string' ? x.slice(0, max) : '');
  const list = (x: unknown) => (Array.isArray(x) ? x.slice(0, 50) : []);
  return list(v).map((w: any) => ({
    name: text(w?.name, 40),
    path: text(w?.path),
    read: list(w?.read).map((r) => text(r)),
    git_sync: w?.git_sync !== false,
    tasks: list(w?.tasks).map((t: any) => ({ name: text(t?.name, 40), run: list(t?.run).map((a) => text(a)), about: text(t?.about), args: t?.args === true })),
  }));
}

const holderKey = (h: SessionHolder) => ('ticketId' in h ? `t${h.ticketId}` : 'contraptionTurn' in h ? `c${h.contraptionTurn}` : `k${h.check}`);

export class MachineRelay {
  private agents = new Map<number, Agent>();
  private sessions = new Map<string, Session>();
  /** Runner jobs sent to an agent and waiting on its answer, by job id. */
  private jobs = new Map<string, { machineId: number; done: (r: RunnerJobResult) => void }>();
  /** Checks running now, by machine: one at a time each (#437). */
  private checks = new Map<number, Promise<CheckResult[]>>();
  private store: Store;
  private onChange: () => void;
  private startedAt = Date.now();
  private shown = '';

  constructor(store: Store, onChange: () => void) {
    this.store = store;
    this.onChange = onChange;
    // A status also changes with time alone (offline 5 minutes is Down): say so when one does.
    setInterval(() => this.statuses(), 60_000).unref();
  }

  /** Every machine's status, telling the stream when one changed since last asked. */
  private statuses() {
    const now = JSON.stringify(this.list().map((m) => [m.id, m.status, m.reason, m.gets]));
    if (this.shown && now !== this.shown) this.onChange();
    this.shown = now;
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
    // Whom it is lent to, and which of those schemes' minions get it (machine tools on); a person's own goes to their asks instead.
    const lent = machine.owner_id !== null ? [] : this.store.listProjects().filter((p) => lendsMachine(this.store, machine, p));
    const gets = lent.filter((p) => p.machine_tools).map((p) => p.id);
    const offers = this.online().find((m) => m.id === machine.id)?.servers ?? [];
    const st = machineStatus({
      now: Date.now(), startedAt: this.startedAt, online: !!agent, runners: agent ? agent.runners : !!check?.runners,
      alwaysOn: !!machine.always_on, createdAt: machine.created_at, lastSeenAt: machine.last_seen_at,
      offers, wsOff: !machine.workspace_tools && !!agent?.servers.includes('ws'), check,
      owned: machine.owner_id !== null, lent: lent.length, lentOn: gets.length,
    });
    return {
      ...st,
      always_on: !!machine.always_on,
      checked: check,
      checking: this.checks.has(machine.id),
      /** The schemes it is lent to, resolved, and those whose minions get it. */
      lent_to: lent.map((p) => p.id),
      gets,
      id: machine.id,
      name: machine.name,
      created_by: machine.created_by,
      owner_id: machine.owner_id,
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
      /** The schemes it is lent to, or null for every scheme an admin owns. */
      projects: machine.scoped ? this.store.machineProjects(machine.id) : null,
      servers: agent?.servers ?? [],
      runners: agent ? agent.runners : !!check?.runners,
      workspaces: agent?.workspaces ?? [],
      problems: agent?.problems ?? [],
    };
  }

  list() {
    return this.store.listMachines().map((m) => this.view(m));
  }

  /** Machines connected right now, with the servers a starting turn in any scheme should get. */
  online(): OnlineMachine[] {
    return this.store.listMachines().flatMap((m) => {
      const agent = this.agents.get(m.id);
      const servers = agent?.servers.filter((s) => s === 'mcp' || m.workspace_tools) ?? [];
      return servers.length ? [{ ...m, servers }] : [];
    });
  }

  isOnline(machineId: number): boolean {
    return this.agents.has(machineId);
  }

  /** A machine's agent connected: hold the stream open and send it its sessions' messages. */
  connectAgent(machine: Machine, res: ServerResponse, info: { host: string; command: string; runners?: boolean }) {
    // A newer connection wins: the old one is a laptop that dropped off without the server noticing.
    const old = this.agents.get(machine.id);
    if (old) this.dropAgent(machine.id, old);
    res.writeHead(200, SSE_HEADERS);
    res.write(`data: ${JSON.stringify({ hello: machine.name })}\n\n`);
    const mcp = !info.runners && machine.mcp_kind === null && mcpFromAgent(info.command);
    if (mcp) this.store.updateMachine(machine.id, mcp);
    const agent: Agent = { res, host: info.host, command: info.command, since: Date.now(), sessions: new Set(), servers: info.runners ? [] : ['mcp'], workspaces: [], problems: [], timers: [], runners: !!info.runners };
    this.agents.set(machine.id, agent);
    // A runner host's check is its agent connecting: an hourly runner list could collide with a person's add, which the agent would refuse as busy.
    this.store.updateMachine(machine.id, { last_seen_at: agent.since, ...(info.runners ? { last_check: JSON.stringify({ at: agent.since, results: [], runners: true }) } : {}) });
    this.onChange();
    if (!info.runners) {
      agent.timers.push(setTimeout(() => this.checkIfDue(machine.id), CHECK_UNASKED_MS), setInterval(() => this.checkIfDue(machine.id), CHECK_EVERY_MS));
      for (const t of agent.timers) t.unref();
    }
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
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
  }

  /** Disconnect a machine's agent (it was removed, or got a new token). */
  disconnect(machineId: number) {
    const agent = this.agents.get(machineId);
    if (agent) this.dropAgent(machineId, agent);
  }

  /** The agent says what it offers: its servers, and the workspaces in its config. False if it isn't connected. */
  setInfo(machine: Machine, body: { servers?: unknown; workspaces?: unknown; problems?: unknown }): boolean {
    const agent = this.agents.get(machine.id);
    if (!agent) return false;
    // A runner agent offers no MCP server or workspaces, whatever it says.
    if (agent.runners) return true;
    agent.servers = (['mcp', 'ws'] as const).filter((s) => Array.isArray(body.servers) && body.servers.includes(s));
    agent.workspaces = cleanWorkspaces(body.workspaces);
    agent.problems = (Array.isArray(body.problems) ? body.problems : []).slice(0, 50).map((p) => String(p).slice(0, 500));
    // A server it no longer offers is gone for the sessions using it.
    for (const id of agent.sessions) if (!agent.servers.includes(this.sessions.get(id)!.server)) this.endSession(id, true);
    this.onChange();
    this.checkIfDue(machine.id);
    return true;
  }

  /**
   * Check a connected machine unless its last check is under an hour old and covers what it offers now (#437):
   * on connect, hourly, and when what it offers changes. Never more often than that unasked.
   */
  checkIfDue(machineId: number) {
    const machine = this.store.getMachine(machineId);
    const agent = this.agents.get(machineId);
    if (!machine || !agent || agent.runners || this.checks.has(machineId)) return;
    const check = storedCheck(machine);
    const offers = this.online().find((m) => m.id === machineId)?.servers ?? [];
    const covered = offers.every((s) => check?.results.some((r) => r.server === s));
    if (offers.length && (!check || !covered || Date.now() - check.at >= CHECK_EVERY_MS - 60_000)) this.check(machineId).catch(() => {});
  }

  /** Machines whose CI runner agent is connected now (#328). */
  runnerMachines(): Machine[] {
    return this.store.listMachines().filter((m) => this.agents.get(m.id)?.runners);
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
  check(machineId: number, timeoutMs = CHECK_MS): Promise<CheckResult[]> {
    const running = this.checks.get(machineId);
    if (running) return running;
    const run = this.runCheck(machineId, timeoutMs).finally(() => {
      this.checks.delete(machineId);
      this.onChange();
    });
    this.checks.set(machineId, run);
    this.onChange();
    return run;
  }

  private async runCheck(machineId: number, timeoutMs: number): Promise<CheckResult[]> {
    const servers = this.online().find((m) => m.id === machineId)?.servers ?? [];
    const agent = this.agents.get(machineId);
    const results: CheckResult[] = [];
    for (const server of servers) results.push(await this.checkServer(machineId, { check: machineId }, server, "Citadel's check", timeoutMs));
    // A reconnect mid-check is a new agent, and an offline one wasn't tested: keep the last real check.
    if (agent && this.agents.get(machineId) === agent && results.length) this.store.updateMachine(machineId, { last_check: JSON.stringify({ at: Date.now(), results }) });
    return results;
  }

  private checkServer(machineId: number, holder: SessionHolder, server: MachineServer, who: string, timeoutMs: number): Promise<CheckResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      // Stands in for the proxy's stream: the session id, then the machine's replies, as server-sent events.
      const sink = new EventEmitter() as EventEmitter & { writeHead(): void; write(chunk: string): boolean; end(): void };
      const waiting = new Map<number, (reply: any) => void>();
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
      const ask = (id: number, method: string, params: object) => new Promise<any>((res) => {
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
        const list = await ask(2, 'tools/list', {});
        if (list?.error) return finish(false, [], `tools/list failed: ${list.error.message ?? JSON.stringify(list.error)}`);
        if (!Array.isArray(list?.result?.tools)) return finish(false, [], `tools/list sent no tools: ${JSON.stringify(list).slice(0, 300)}`);
        finish(true, list.result.tools.map((t: any) => String(t?.name)), null);
      })();
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
    if (body.closed) this.endSession(sessionId, false);
    else s.res.write(`data: ${JSON.stringify({ message: body.message })}\n\n`);
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
