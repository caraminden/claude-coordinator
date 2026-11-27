// Tools Citadel's own server offers to some schemes' minions (#2179): an MCP server it runs here, one copy per turn
// session, behind the same proxies a machine's tools go through (src/machine-mcp.ts, src/pool-machine.ts), so a turn
// gets it as mcp__<name>__<tool> wherever the turn runs, a person's container included. Not a machine: the Machines page
// is for computers people connect to Citadel (Cara, 2026-11-26).
//
// SERVER_TOOLS is the one place that says who gets each one: a Citadel member changes a list and ships it.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { jsonLines } from './json-lines.ts';

const ROOT = join(import.meta.dirname, '..');

export interface ServerTool {
  /** Its MCP server's name in a turn: the tools are mcp__<name>__<tool>. */
  name: string;
  /** The schemes (project ids) whose minions get it. Taskmasters never do. */
  schemes: readonly number[];
  /** The MCP server to run for one session, on stdio. */
  command: (home: string) => string[];
  /** What a minion needs to know before it calls it: put in its prompt. */
  notes: string;
}

export const SERVER_TOOLS: readonly ServerTool[] = [
  {
    // The Godot editor on perigee with godot-ai (#28): started by the first tool call, stopped when idle (#505, #1353).
    name: 'perigee-godot',
    schemes: [1 /* Delve */, 3 /* Peek Auras */],
    command: (home) => [
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      // Its own scope, out of the server's cgroup: perigee-godot's CPU line in src/cpu-ledger.ts reads this slice.
      '--slice=app-godot.slice',
      process.execPath,
      join(ROOT, 'deploy', 'perigee-godot', 'godot-on-demand.mjs'),
      '--',
      join(home, '.local', 'bin', 'uvx'),
      '--from',
      'godot-ai==4.3.0',
      'godot-ai',
      'attach',
      '--port',
      '8000',
      '--ws-port',
      '9500',
    ],
    notes:
      'This is perigee itself: the Godot 4.7.2 .NET editor with Godot AI, drawing on its Radeon 780M through a headless screen (user service perigee-godot). The editor has ~/delve-godot open, a separate Delve clone, not your worktree. To try your branch there: git -C ~/delve-godot fetch <your worktree> HEAD && git -C ~/delve-godot checkout --detach FETCH_HEAD, run dotnet build Delve.sln in ~/delve-godot, then reload the scene before project_run. One editor is shared by every minion: check what it has checked out first, and put it back on main when you finish. Never restart the service while another minion may be using it.\nThe editor sleeps after 30 minutes with no Godot tool call. The first tool call after that starts it and waits until it is up, which can take up to 3 minutes: that is start-up, not a hang. An idle stop drops unsaved scene edits, so save scenes before you leave the editor.',
  },
];

/** The server tools a turn gets: a minion's in a scheme that is on a tool's list. */
export function serverToolsFor(projectId: number, kind: string, tools: readonly ServerTool[] = SERVER_TOOLS): ServerTool[] {
  return kind === 'coordinator' ? [] : tools.filter((t) => t.schemes.includes(projectId));
}

/** What a turn's proxy names it by, in place of a machine's id: /api/machines/<key>/session and the pool's /machine/<key>/mcp. */
export const serverToolKey = (name: string) => `tool-${name}`;

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' };
const PING_MS = 25_000;

interface Session {
  tool: ServerTool;
  ticketId: number;
  who: string;
  res: ServerResponse;
  child: ChildProcess | null;
}

/** The open sessions: one MCP server each, started by the session's first message and stopped when its proxy goes. */
export class ServerToolSessions {
  private sessions = new Map<string, Session>();

  private run: (argv: string[], env: Record<string, string>) => ChildProcess;
  private log: (line: string) => void;
  private home: string;

  constructor(run?: (argv: string[], env: Record<string, string>) => ChildProcess, log?: (line: string) => void, home = homedir()) {
    this.run = run ?? ((argv, env) => spawn(argv[0]!, argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env }));
    this.log = log ?? ((line) => console.error(line));
    this.home = home;
  }

  /** Opens a session for a minion whose scheme is on the tool's list; false, writing nothing, for anyone else. */
  open(tool: ServerTool, minion: { id: number; project_id: number; kind: string }, who: string, res: ServerResponse): boolean {
    if (!serverToolsFor(minion.project_id, minion.kind, [tool]).length) return false;
    const id = randomBytes(12).toString('hex');
    this.sessions.set(id, { tool, ticketId: minion.id, who, res, child: null });
    res.writeHead(200, SSE_HEADERS);
    res.write(`data: ${JSON.stringify({ session: id })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    res.on('close', () => {
      clearInterval(ping);
      this.end(id);
    });
    return true;
  }

  /** A message from the turn's proxy. False when the session is gone (or another minion's). */
  post(id: string, ticketId: number, message: unknown): boolean {
    const s = this.sessions.get(id);
    if (!s || s.ticketId !== ticketId) return false;
    if (message === null || message === undefined) return true;
    s.child ??= this.start(id, s);
    s.child.stdin?.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  private start(id: string, s: Session): ChildProcess {
    // Its own small environment: none of the server's settings or secrets reach a third-party MCP server.
    const env: Record<string, string> = { HOME: this.home, PATH: `${join(this.home, '.local', 'bin')}:/usr/bin:/bin`, LANG: process.env.LANG ?? 'C.UTF-8' };
    for (const k of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[k]) env[k] = process.env[k]!;
    const child = this.run(s.tool.command(this.home), env);
    child.stdin?.on('error', () => {});
    jsonLines(child.stdout!, (message: unknown) => {
      if (this.sessions.get(id) === s) s.res.write(`data: ${JSON.stringify({ message })}\n\n`);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => {
      for (const line of text.split('\n')) if (line.trim()) this.log(`${s.tool.name} (${s.who}): ${line}`);
    });
    const gone = (why: string) => {
      if (this.sessions.get(id) !== s) return;
      this.log(`${s.tool.name} (${s.who}): its MCP server ${why}`);
      // The stdio proxy (src/machine-mcp.ts) gives up on it; the pooled one opens a fresh session on the next call.
      s.res.write(`data: ${JSON.stringify({ closed: true })}\n\n`);
      this.end(id);
    };
    child.on('error', (err) => gone(`could not start: ${err.message}`));
    child.on('exit', (code, signal) => gone(`exited (${signal ?? code})`));
    return child;
  }

  private end(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    s.res.end();
    const child = s.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    // As the machine agent did: stdin's close ends godot-ai attach; a SIGTERM if that wasn't enough.
    child.stdin?.end();
    setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGTERM'), 5000).unref();
  }
}
