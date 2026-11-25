// When a running turn has gone quiet (#906): no output for well past its usual gap. Cara picked the look on #906's
// page (2026-11-17): running blue with a stopped dot, counted in the requester's Needs you, and a server check of the
// turn's process behind "Is this still going?" ("lets not call it nudge, that implies action").
//
// The limits come from 10 days of turn events (5,620 turns, to 2026-11-17): the model's gap after a tool result was
// p50 2 s, p99 52 s, p99.9 118 s. So a turn is quiet 5 min after its last output, or 2 min past an open tool's own
// timeout when that is later (a test run with a 10 min timeout is not quiet until 12 min).
import { readdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

export const QUIET_MS = 5 * 60_000;
export const GRACE_MS = 2 * 60_000;
/** An MCP call has no timeout of its own we can read; the slow ones (a land) ran up to ~10 min. */
const MCP_MS = 10 * 60_000;
/** Claude Code's Bash default and ceiling. */
const BASH_MS = 120_000,
  BASH_MAX_MS = 600_000;

export interface OpenTool {
  id: string;
  name: string;
  label: string;
  started: number;
  limit: number;
}

/** What a running turn last did: when it last wrote anything, and the tool calls still waiting on their result. */
export interface Activity {
  at: number;
  tools: OpenTool[];
}

/** How long a tool call may run before its silence counts against it: its own timeout where it has one. */
export function toolLimit(name: string, input: any): number {
  if (input?.run_in_background) return 0;
  if (name === 'Bash') return Math.min(BASH_MAX_MS, Number(input?.timeout) > 0 ? Number(input.timeout) : BASH_MS);
  if (name.startsWith('mcp__')) return MCP_MS;
  return 0;
}

/** A tool call in words, short: "Bash: npm test", "Read: src/db.ts". */
export function toolWords(name: string, input: any): string {
  const arg = input?.description ?? input?.command ?? input?.file_path ?? input?.pattern ?? input?.url ?? input?.query ?? '';
  const short = String(arg).split('\n')[0].slice(0, 80);
  return short ? `${name}: ${short}` : name;
}

/** Note a stream event (the main thread's or a Grunt's): any line is a sign of life; tool calls open, their results close. */
export function noteEvent(a: Activity, ev: any, now: number): Activity {
  let tools = a.tools;
  const blocks: any[] = Array.isArray(ev?.message?.content) ? ev.message.content : [];
  if (ev?.type === 'assistant') {
    const opened = blocks.filter((b) => b?.type === 'tool_use' && typeof b.id === 'string').map((b) => ({ id: b.id, name: String(b.name ?? ''), label: toolWords(String(b.name ?? ''), b.input), started: now, limit: toolLimit(String(b.name ?? ''), b.input) }));
    if (opened.length) tools = [...tools, ...opened];
  } else if (ev?.type === 'user') {
    const done = new Set(blocks.filter((b) => b?.type === 'tool_result').map((b) => b.tool_use_id));
    if (done.size) tools = tools.filter((t) => !done.has(t.id));
  }
  return { at: now, tools };
}

/** When the turn counts as quiet: 5 min after its last output, or later while an open tool is still inside its timeout. */
export function quietAt(a: Activity): number {
  return Math.max(a.at + QUIET_MS, ...a.tools.map((t) => t.started + t.limit + GRACE_MS));
}

/** The open tool that has run longest: what the popover names. */
export const longestTool = (a: Activity): OpenTool | null => a.tools.reduce<OpenTool | null>((m, t) => (!m || t.started < m.started ? t : m), null);

export interface ProcCheck {
  /** Alive and working, alive but idle, or gone; unknown where the server can't see the process (a container, another machine). */
  verdict: 'busy' | 'idle' | 'gone' | 'unknown';
  /** One line for the popover. */
  text: string;
  /** The longest-running command under the turn, if any. */
  command?: string;
  /** How long it has run, ms. */
  ranMs?: number;
}

interface Proc {
  pid: number;
  ppid: number;
  start: number;
  cpu: number;
  comm: string;
}

/** Every process's parent, start (clock ticks since boot) and CPU ticks, from /proc. */
function procs(root = '/proc'): Map<number, Proc> {
  const out = new Map<number, Proc>();
  for (const d of readdirSync(root)) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = readFileSync(`${root}/${d}/stat`, 'utf8');
      const close = s.lastIndexOf(')');
      const comm = s.slice(s.indexOf('(') + 1, close);
      const f = s.slice(close + 2).split(' ');
      // After the name: state(0) ppid(1) ... utime(11) stime(12) ... starttime(19).
      out.set(+d, { pid: +d, ppid: +f[1], cpu: +f[11] + +f[12], start: +f[19], comm });
    } catch {
      /* gone meanwhile */
    }
  }
  return out;
}

/** `pid` and everything under it. */
export function descendants(all: Map<number, { pid: number; ppid: number }>, pid: number): number[] {
  const kids = new Map<number, number[]>();
  for (const p of all.values()) kids.set(p.ppid, [...(kids.get(p.ppid) ?? []), p.pid]);
  const out: number[] = [],
    todo = [pid];
  while (todo.length) {
    const p = todo.pop()!;
    if (!all.has(p)) continue;
    out.push(p);
    todo.push(...(kids.get(p) ?? []));
  }
  return out;
}

const uptimeTicks = () => parseFloat(readFileSync('/proc/uptime', 'utf8')) * 100;
const cmdline = (pid: number) => {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 120);
  } catch {
    return '';
  }
};

/**
 * Look at a turn's claude process and what runs under it, twice a second apart: busy if any of them used CPU, idle if
 * none did, gone if claude isn't there. Reads only /proc's stat and cmdline. The longest-running command under claude
 * (not claude, not its MCP servers) is named, with how long it has run.
 */
export async function checkProcess(claudePid: number | null, sampleMs = 1000): Promise<ProcCheck> {
  if (!claudePid) return { verdict: 'unknown', text: "Couldn't find this turn's process: it may run in a container or on another machine." };
  const a = procs();
  if (!a.has(claudePid)) return { verdict: 'gone', text: "The turn's process is gone: it should end by itself in a moment." };
  await sleep(sampleMs);
  const b = procs();
  if (!b.has(claudePid)) return { verdict: 'gone', text: "The turn's process just ended." };
  const tree = descendants(b, claudePid);
  const used = tree.some((p) => b.get(p)!.cpu - (a.get(p)?.cpu ?? b.get(p)!.cpu) > 0);
  // MCP servers and the like start with claude; a command the turn ran started later.
  const claudeStart = b.get(claudePid)!.start;
  const cmds = tree.filter((p) => p !== claudePid && b.get(p)!.start > claudeStart + 200 && b.get(b.get(p)!.ppid)?.pid === claudePid).sort((x, y) => b.get(x)!.start - b.get(y)!.start);
  const oldest = cmds[0];
  const command = oldest ? cmdline(oldest) || b.get(oldest)!.comm : undefined;
  const ranMs = oldest ? Math.max(0, (uptimeTicks() - b.get(oldest)!.start) * 10) : undefined;
  const mins = ranMs !== undefined ? `${Math.round(ranMs / 60_000)}m` : '';
  const text = used
    ? command
      ? `Still going: \`${command}\` has run ${mins} and is using CPU.`
      : 'Still going: the model is working (using CPU) with no command running.'
    : command
      ? `Idle: \`${command}\` has run ${mins} but used no CPU in the last second. It may be stuck, or waiting on the network.`
      : 'Idle: no command running and no CPU used. It may be waiting on the API; Stop it if this goes on.';
  return { verdict: used ? 'busy' : 'idle', text, ...(command ? { command, ranMs } : {}) };
}
