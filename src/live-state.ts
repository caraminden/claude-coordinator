// read_ticket's live view (#620): what a minion's turn is doing right now, from the events the server
// already stores, so a Taskmaster can tell "hung" from "busy" in a container turn as on the host.
// Runs inside the pinned MCP server, so it imports only ./ files (turn-launch.ts pinnedCopy).
import { hideTokens } from './hide-tokens.ts';
import { stateWord } from './needs.ts';
import { type WorkerWait, workerWaitText } from './worker-wait.ts';

interface EventRow {
  kind: string;
  data: string;
  created_at: number;
}
interface Call {
  name: string;
  input: unknown;
  at: number;
  grunt: string | null;
  id: string;
  result?: { at: number; error: boolean; text: string };
}

const RECENT = 6;
/** The Grunt tools: a call to one stays open while its Grunt works. */
const GRUNT_TOOLS = new Set(['Agent', 'Task']);

/** Values that read like secrets but have no token shape: env assignments (`PASSWORD=x`, an `env` dump), a URL's password, a bearer token. */
const hideValues = (s: string) =>
  s
    .replace(/\b([A-Z][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1=…')
    .replace(/(\w+:\/\/[^\s:/@]+):[^\s@]+@/g, '$1:…@')
    .replace(/\b(Bearer|token)\s+[\w.~+/=-]{8,}/gi, '$1 …');

const oneLine = (s: unknown, max: number) => {
  const t = hideTokens(hideValues(String(s ?? '')))
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A tool call's input in a few words: a Bash call's description and command, a file, a pattern, or its arguments. */
function inputText(c: Call): string {
  const i = (c.input ?? {}) as Record<string, unknown>;
  if (typeof i.command === 'string') return oneLine(i.description ? `${i.description}: ${i.command}` : i.command, 160);
  for (const k of ['file_path', 'notebook_path', 'path', 'pattern', 'url', 'query', 'description', 'skill', 'subject']) {
    if (typeof i[k] === 'string' && i[k]) return oneLine(i[k], 160);
  }
  return oneLine(JSON.stringify(i), 120);
}

function callLine(c: Call, now: number, running: boolean): string {
  const who = c.grunt ? ' (Grunt)' : '';
  const head = `- ${ago(now - c.at)} ago${who} ${c.name}: ${inputText(c)}`;
  if (!c.result) return `${head} → ${running ? `still running (${ago(now - c.at)})` : 'no result (the turn ended)'}`;
  const out = c.result.text ? `: ${oneLine(c.result.text, 200)}` : '';
  return `${head} → ${c.result.error ? 'error' : 'ok'} after ${ago(c.result.at - c.at)}${out}`;
}

/** Whether a Grunt works in the turn these events are from: its call is open, or one it made itself is. */
export function gruntAtWork(events: EventRow[]): boolean {
  const open = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'claude') continue;
    const ev = JSON.parse(e.data);
    if (ev.type === 'system' && ev.subtype === 'init') open.clear();
    for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) {
      if (b?.type === 'tool_use' && (ev.parent_tool_use_id || GRUNT_TOOLS.has(b.name))) open.add(String(b.id));
      else if (b?.type === 'tool_result') open.delete(String(b.tool_use_id));
    }
  }
  return open.size > 0;
}

/** A minion as read_minion's API answer gives it, the fields read here. */
interface LiveMinion {
  number: number;
  status: string;
  state?: string | null;
  cwd?: string;
  turnStartedAt?: number | null;
  wait?: { kind: string; text: string; since: number } | null;
  limit_resume_at?: number | string | null;
  worker_wait?: WorkerWait | null;
  queued?: number;
  approvals?: number;
  server_work?: { kind: string; text?: string; since?: number } | null;
}

/**
 * The live view's lines for one minion: its worktree, what its turn waits on (a tool, the model, a
 * person's card, the usage limit, the land line), its queued messages and its last few tool calls,
 * input and output trimmed and token-shaped strings hidden. `ticket` is the API's view of the minion.
 */
export function liveState(ticket: LiveMinion, events: EventRow[], now = Date.now()): string[] {
  // This turn's (or, between turns, the last turn's) events: from its last init on.
  let from = 0;
  const parsed = events.map((e) => ({ ...e, ev: e.kind === 'claude' ? JSON.parse(e.data) : null }));
  parsed.forEach((e, i) => {
    if (e.ev?.type === 'system' && e.ev.subtype === 'init') from = i;
  });
  const running = ticket.status === 'running' && !ticket.worker_wait;
  // A turn that started but hasn't sent its init yet isn't the last one: an old unanswered call isn't running.
  const turnStart = ticket.turnStartedAt;
  if (running && turnStart && (parsed[from]?.created_at ?? 0) < turnStart) {
    from = parsed.findIndex((e) => e.created_at >= turnStart);
    if (from < 0) from = parsed.length;
  }
  const turn = parsed.slice(from);
  const calls: Call[] = [];
  const byId = new Map<string, Call>();
  let lastAt: number | null = null;
  for (const e of turn) {
    if (!e.ev) continue;
    lastAt = e.created_at;
    for (const b of Array.isArray(e.ev.message?.content) ? e.ev.message.content : []) {
      if (b?.type === 'tool_use' && typeof b.id === 'string') {
        const c: Call = { name: String(b.name), input: b.input, at: e.created_at, grunt: e.ev.parent_tool_use_id ?? null, id: b.id };
        calls.push(c);
        byId.set(b.id, c);
      } else if (b?.type === 'tool_result') {
        const c = byId.get(b.tool_use_id);
        if (c) c.result = { at: e.created_at, error: !!b.is_error, text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '') };
      }
    }
  }
  const started = ticket.turnStartedAt ?? turn[0]?.created_at ?? null;
  const out = [`Live state of #${ticket.number}: status ${ticket.worker_wait ? 'waiting for a worker' : ticket.status}${running && started ? `, turn running ${ago(now - started)}` : ''}`];
  if (ticket.cwd) out.push(`worktree: ${ticket.cwd}`);

  const waits: string[] = [];
  if (running) {
    // The newest open call the minion made itself; a Grunt's open calls show under it.
    const open = calls.filter((c) => !c.result && !c.grunt).at(-1);
    if (ticket.approvals) waits.push(`a person: ${ticket.approvals} approval card(s) waiting`);
    if (open) {
      waits.push(`a tool: ${open.name} (${inputText(open)}), running ${ago(now - open.at)}`);
      if (GRUNT_TOOLS.has(open.name)) {
        const inner = calls.filter((c) => c.grunt === open.id);
        const latest = inner.at(-1);
        waits.push(latest ? `its Grunt's latest call, ${ago(now - latest.at)} ago: ${latest.name} (${inputText(latest)})${latest.result ? '' : ', still running'}` : "its Grunt hasn't called a tool yet");
      }
    } else if (!ticket.approvals) {
      waits.push(`the model: ${lastAt ? `${ago(now - lastAt)} since the turn's last event` : 'no events from this turn yet'}`);
    }
  } else if (ticket.approvals) {
    waits.push(`a person: ${ticket.approvals} approval card(s) waiting, its process ended to free its memory until the answer`);
  } else if (ticket.worker_wait) {
    waits.push(`a worker: no turn is running, its next one starts by itself (${workerWaitText(ticket.worker_wait)})`);
  } else if (ticket.server_work?.kind === 'job') {
    waits.push(`a job of its own the server runs on, for ${ago(now - (ticket.server_work.since ?? now))} so far (${ticket.server_work.text}): no turn is running, and its end wakes it`);
  } else {
    waits.push(`nothing: no turn is running (${ticket.state ? `state ${stateWord(ticket.state)}` : 'its turn ended'})`);
  }
  if (ticket.wait?.text) waits.push(`${ticket.wait.kind}: ${ticket.wait.text} (for ${ago(now - ticket.wait.since)})`);
  if (ticket.limit_resume_at) waits.push(`the usage limit: resumes at ${new Date(ticket.limit_resume_at).toISOString()}`);
  out.push(`waiting on: ${waits.join('; ')}`);
  if (ticket.queued) out.push(`queued: ${ticket.queued} message(s) from people, sent in once this turn ends`);

  const recent = calls.slice(-RECENT);
  const which = running ? 'this' : 'the last';
  out.push(recent.length ? `Last ${recent.length} of ${which} turn's ${calls.length} tool call(s), newest last:` : `No tool calls in ${which} turn.`);
  out.push(...recent.map((c) => callLine(c, now, running)));
  return out;
}
