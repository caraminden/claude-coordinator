// Machines: people's own computers lending their MCP servers (a Godot editor, say) to threads.
// A machine runs public/machine-agent.mjs, which dials out to the app and holds an event stream
// open; perigee can't reach a laptop directly, so everything flows over connections the laptop
// opens. During a turn, each online machine appears to claude as a stdio MCP server
// (src/machine-mcp.ts) that pipes its messages through here: claude -> proxy -> POST -> agent
// stream -> local MCP server, and back the same way. Each proxy is one session, and the agent
// runs one copy of the MCP server per session, so concurrent threads never share one.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Machine, Store } from './db.ts';

/** Machine names double as MCP server names, so tools read mcp__<name>__<tool>. */
export const MACHINE_NAME = /^[a-z0-9][a-z0-9-]{0,29}$/;
/** Names the app's own MCP servers already use. */
export const RESERVED_NAMES = new Set(['thread', 'coordinator']);

// An agent that stops reading (asleep mid-stream) is dropped rather than buffered for forever.
const MAX_BACKLOG = 64 * 1024 * 1024;
const PING_MS = 25_000;

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
}

interface Session {
  machineId: number;
  ticketId: number;
  res: ServerResponse;
}

export class MachineRelay {
  private agents = new Map<number, Agent>();
  private sessions = new Map<string, Session>();
  private store: Store;
  private onChange: () => void;

  constructor(store: Store, onChange: () => void) {
    this.store = store;
    this.onChange = onChange;
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
    return {
      id: machine.id,
      name: machine.name,
      created_by: machine.created_by,
      notes: machine.notes,
      created_at: machine.created_at,
      last_seen_at: machine.last_seen_at,
      online: !!agent,
      host: agent?.host ?? null,
      command: agent?.command ?? null,
      connected_at: agent?.since ?? null,
      sessions: agent?.sessions.size ?? 0,
    };
  }

  list() {
    return this.store.listMachines().map((m) => this.view(m));
  }

  /** Machines connected right now, whose tools a starting turn should get. */
  online(): Machine[] {
    return this.store.listMachines().filter((m) => this.agents.has(m.id));
  }

  isOnline(machineId: number): boolean {
    return this.agents.has(machineId);
  }

  /** A machine's agent connected: hold the stream open and send it its sessions' messages. */
  connectAgent(machine: Machine, res: ServerResponse, info: { host: string; command: string }) {
    // A newer connection wins: the old one is a laptop that dropped off without the server noticing.
    const old = this.agents.get(machine.id);
    if (old) this.dropAgent(machine.id, old);
    res.writeHead(200, SSE_HEADERS);
    res.write(`data: ${JSON.stringify({ hello: machine.name })}\n\n`);
    const agent: Agent = { res, host: info.host, command: info.command, since: Date.now(), sessions: new Set() };
    this.agents.set(machine.id, agent);
    this.store.updateMachine(machine.id, { last_seen_at: agent.since });
    this.onChange();
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    res.on('close', () => {
      clearInterval(ping);
      if (this.agents.get(machine.id) === agent) this.dropAgent(machine.id, agent);
    });
  }

  private dropAgent(machineId: number, agent: Agent) {
    this.agents.delete(machineId);
    // Their MCP servers are gone with the agent; ending the proxies' streams tells claude so.
    for (const id of agent.sessions) this.endSession(id, false);
    agent.res.end();
    if (this.store.getMachine(machineId)) this.store.updateMachine(machineId, { last_seen_at: Date.now() });
    this.onChange();
  }

  /** Disconnect a machine's agent (it was removed, or got a new token). */
  disconnect(machineId: number) {
    const agent = this.agents.get(machineId);
    if (agent) this.dropAgent(machineId, agent);
  }

  /** A message from a machine's MCP server, or word that it exited. False if the session is gone. */
  fromAgent(machine: Machine, sessionId: string, body: { message?: unknown; closed?: boolean }): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.machineId !== machine.id) return false;
    if (body.closed) this.endSession(sessionId, false);
    else s.res.write(`data: ${JSON.stringify({ message: body.message })}\n\n`);
    return true;
  }

  /** A thread's proxy started: give it a session whose stream carries the machine's replies. */
  openSession(machineId: number, ticketId: number, res: ServerResponse): boolean {
    const agent = this.agents.get(machineId);
    if (!agent) return false;
    const id = randomBytes(12).toString('hex');
    this.sessions.set(id, { machineId, ticketId, res });
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
  fromSession(sessionId: string, ticketId: number, message: unknown): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || s.ticketId !== ticketId) return false;
    const agent = this.agents.get(s.machineId);
    if (!agent) return false;
    if (agent.res.writableLength > MAX_BACKLOG) {
      this.dropAgent(s.machineId, agent);
      return false;
    }
    agent.res.write(`data: ${JSON.stringify({ session: sessionId, message })}\n\n`);
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
