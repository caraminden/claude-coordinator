// Where a minion's time went (#1991): its stored events cut into working, waiting and lost stretches over its steps, with
// no model. `timeLog(store, ticket)` is the one reader, for the ribbon behind the progress line and for views over many
// minions. Nothing is guessed as fact: a stretch no event explains carries `guess`, and a minion from before a record
// existed has its gaps marked. Rules: the shared folder's specs/minion-time-log/minion-time-log.md.
import { applyEvent, createProgress } from '../public/progress.js';
import type { EventRow } from './db-rows.ts';
import type { Store } from './db.ts';

/** work; wait; lost (a killed turn, a run cut off by its time limit, an overloaded model alone); gone: finished or dismissed, so nobody's time. */
export type TimeKind = 'work' | 'wait' | 'lost' | 'gone';
/** What a wait was on, for views that colour by it. */
export type TimeSub = 'person' | 'ship' | 'deploy' | 'hold' | 'sealed' | 'limit' | 'job' | 'wake' | 'start' | 'stopped' | 'outside' | 'unknown' | 'kill' | 'restart' | 'cut' | 'overload' | 'finished' | 'dismissed';
export interface TimeSeg {
  start: number;
  end: number;
  kind: TimeKind;
  sub?: TimeSub;
  title?: string;
  /** The chat event that proves it; absent where no event does. */
  event?: number;
  /** Worked out, not recorded. */
  guess?: true;
  /** Its row in `rows`, or absent: a stretch too short to have one. */
  row?: number;
}
export interface TimeRow {
  /** step: a plan's step. line: the minion's own milestone line, for work no step owns. wait: time between turns. */
  type: 'step' | 'line' | 'wait';
  title: string;
  kind: TimeKind;
  sub?: TimeSub;
  /** A step's state, and the line the minion wrote when it finished. */
  status?: string;
  outcome?: string;
  /** A step a wait cut in parts, a row each: this one goes on from an earlier row, or goes on in a later one (which has its state and outcome). */
  continued?: true;
  more?: true;
  start: number | null;
  end: number | null;
  work: number;
  wait: number;
  lost: number;
  guess?: true;
  event?: number;
}
export interface TimeLog {
  start: number;
  end: number;
  /** A turn is running, so the last stretch grows. */
  running: boolean;
  closed: boolean;
  segs: TimeSeg[];
  rows: TimeRow[];
  totals: { work: number; wait: number; lost: number; guess: number };
}
/** A wait a record gives exactly, which replaces any guess over it: where a new recording slots in. */
export type RecordedWait = Omit<TimeSeg, 'row'>;

/** A gap shorter than this has no row of its own. */
const ROW_MS = 60_000;
/** A stretch shorter than this isn't drawn. */
const LEAST_MS = 1000;

type Span = [number, number];
interface Tool {
  at: number;
  end: number | null;
  event: number;
  /** work, or what its time is when nothing else runs. */
  k: 'work' | 'wait' | 'cut' | 'overload';
  turn: number;
}
interface Turn {
  start: number;
  end: number | null;
  last: number;
}
interface Step {
  subject: string;
  status: string;
  outcome?: string;
  spans: { start: number; end: number | null }[];
}
type MarkTag = 'limit' | 'kill' | 'killed-for-good' | 'restart' | 'stopped' | 'shipped' | 'live' | 'ship-failed' | 'wake' | 'hold' | 'started' | 'dismissed' | 'failed' | 'message';
interface Mark {
  at: number;
  event: number;
  tag: MarkTag;
  /** The held minion's number, or a message's author. */
  text?: string;
  /** A message the server, a Taskmaster or another minion sent. */
  server?: boolean;
  answers?: string;
}
/** What one chat's events so far have said: fed a row at a time, so a growing chat's log reads only its new events. */
interface State {
  upTo: number;
  turns: Turn[];
  tools: Tool[];
  open: Map<string, Tool>;
  says: { at: number; event: number; text: string }[];
  marks: Mark[];
  ships: { at: number; event: number; call: string }[];
  steps: Step[];
  live: Map<string, Step>;
  /** The state its newest turn set for itself: how it ended. */
  state: string | null;
  p: ReturnType<typeof createProgress>;
}

const newState = (): State => ({ upTo: 0, turns: [], tools: [], open: new Map(), says: [], marks: [], ships: [], steps: [], live: new Map(), state: null, p: createProgress() });

/** A command that waits for a job instead of doing work. */
const WAITS = /\bcitadel-wait\b|\bgh run watch\b|\btail --pid\b|\bsleep \d{2,}|\buntil (?:grep|\[)/;
const CUT_OFF = /Exit code (?:124|143)\b|Command timed out after/;
const OVERLOADED = /\b529\b|[Oo]verloaded/;

/** What a note's text says of the minion's time, or null. */
function noteTag(text: string): { tag: MarkTag; text?: string } | null {
  const hold = /held until #(\d+)/.exec(text);
  if (hold) return { tag: 'hold', text: hold[1] };
  if (/unsealed (it|this)|so this minion started/.test(text)) return { tag: 'started' };
  if (/^Resumed/.test(text)) return null;
  if (/process was killed|^Killed by SIG/.test(text)) return { tag: /resumes it by itself/.test(text) ? 'kill' : 'killed-for-good' };
  if (/server restarted during this turn/.test(text)) return { tag: 'restart' };
  if (/hit your .*limit|usage limit/i.test(text)) return { tag: 'limit' };
  if (/^Stopped by user/.test(text)) return { tag: 'stopped' };
  if (/stopped this ship/.test(text)) return { tag: 'ship-failed' };
  if (/^Shipped and live/.test(text)) return { tag: 'live' };
  if (/dismissed this minion|so it dismissed/.test(text)) return { tag: /live/.test(text) ? 'live' : 'dismissed' };
  if (/^Shipped\b/.test(text)) return { tag: 'shipped' };
  if (/^Wake set/.test(text)) return { tag: 'wake' };
  return null;
}

/** A message someone or something sent, as a mark; null for one that doesn't wake the minion (held mail). */
function messageMark(row: EventRow, d: Record<string, unknown>): Mark | null {
  if (d.mail || d.note) return null;
  const author = typeof d.author === 'string' ? d.author : '';
  const text = typeof d.text === 'string' ? d.text : '';
  if (author === 'Citadel' && /land (went through|didn't go through|was stopped)/.test(text)) return { at: row.created_at, event: row.id, tag: /went through/.test(text) ? 'shipped' : 'ship-failed', server: true };
  const answer = (d.answer as { questionId?: unknown } | undefined)?.questionId;
  return { at: row.created_at, event: row.id, tag: 'message', text: author, server: /^(Citadel|System|The Taskmaster|Taskmaster|#|\[|GitHub)/.test(author), ...(typeof answer === 'string' && { answers: answer }) };
}

type Block = { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };

/** Bring `s` up to date with one more event of the chat, oldest first. */
export function foldEvent(s: State, row: EventRow) {
  s.upTo = row.id;
  let d: Record<string, unknown>;
  try {
    d = JSON.parse(row.data);
  } catch {
    return;
  }
  const at = row.created_at;
  if (row.kind === 'note') {
    const t = noteTag(typeof d.text === 'string' ? d.text : '');
    if (t) s.marks.push({ at, event: row.id, ...t });
    const cur = s.turns.at(-1);
    if (cur && cur.end === null && t && (t.tag === 'kill' || t.tag === 'restart' || t.tag === 'stopped' || t.tag === 'limit')) cur.end = cur.last;
    return;
  }
  if (row.kind === 'error') {
    const text = typeof d.text === 'string' ? d.text : '';
    const t = noteTag(text);
    s.marks.push({ at, event: row.id, tag: 'failed', ...(t?.tag === 'killed-for-good' || t?.tag === 'kill' ? { tag: t.tag } : t?.tag === 'limit' ? { tag: 'limit' } : {}) });
    const cur = s.turns.at(-1);
    if (cur && cur.end === null) cur.end = cur.last;
    return;
  }
  if (row.kind === 'user_message') {
    const m = messageMark(row, d);
    if (m) s.marks.push(m);
    return;
  }
  if (row.kind !== 'claude') return;
  claudeEvent(s, row, d);
  applyEvent(s.p, 'claude', d, at);
  syncSteps(s, at);
}

function claudeEvent(s: State, row: EventRow, d: Record<string, unknown>) {
  const at = row.created_at;
  let cur = s.turns.at(-1);
  if (d.type === 'system') {
    if (d.subtype !== 'init') return;
    if (cur && cur.end === null) cur.end = cur.last;
    s.turns.push({ start: at, end: null, last: at });
    s.state = null;
    return;
  }
  if (d.type === 'result') {
    if (cur && cur.end === null) (cur.end = at), (cur.last = at);
    return;
  }
  // Words after a turn's result with no new start: a turn whose start wasn't kept.
  if (!cur || cur.end !== null) s.turns.push((cur = { start: at, end: null, last: at }));
  cur.last = at;
  const content = (d.message as { content?: unknown } | undefined)?.content;
  const blocks = (Array.isArray(content) ? content : []) as Block[];
  const grunt = !!d.parent_tool_use_id;
  if (typeof d.turn_state === 'string') s.state = d.turn_state;
  for (const b of blocks) {
    if (b.type === 'text' && d.type === 'assistant' && !grunt && b.text && b.text.trim().length > 15) s.says.push({ at, event: row.id, text: b.text.trim() });
    else if (b.type === 'tool_use' && b.id) {
      const tool: Tool = { at, end: null, event: row.id, k: (b.name === 'Bash' && WAITS.test(String(b.input?.command ?? ''))) || (b.name === 'TaskOutput' && b.input?.block !== false) ? 'wait' : 'work', turn: s.turns.length - 1 };
      s.open.set(b.id, tool);
      if (b.name === 'mcp__thread__set_thread_status' && typeof b.input?.state === 'string') s.state = b.input.state;
      if (b.name?.endsWith('hand_off_land')) s.ships.push({ at, event: row.id, call: b.id });
      if (b.name !== 'mcp__thread__plan') s.tools.push(tool);
    } else if (b.type === 'tool_result' && b.tool_use_id) {
      const tool = s.open.get(b.tool_use_id);
      if (!tool) continue;
      s.open.delete(b.tool_use_id);
      tool.end = at;
      if (b.is_error) {
        const text = (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')).slice(0, 2000);
        if (tool.k === 'work' && CUT_OFF.test(text)) tool.k = 'cut';
        if (tool.k === 'work' && OVERLOADED.test(text)) tool.k = 'overload';
        s.ships = s.ships.filter((x) => x.call !== b.tool_use_id); // a refused hand-off joined no line
      }
    }
  }
}

/** Record each plan step's times from the plan the progress line shows. */
function syncSteps(s: State, at: number) {
  const tasks = s.p.tasks as unknown as { id: string; subject: string; status: string; outcome?: string }[];
  for (const id of [...s.live.keys()])
    if (!tasks.some((t) => t.id === id)) {
      const span = s.live.get(id)!.spans.at(-1);
      if (span && span.end === null) span.end = at;
      s.live.delete(id);
    }
  for (const t of tasks) {
    let step = s.live.get(t.id);
    if (!step) {
      step = { subject: t.subject, status: t.status, spans: [] };
      s.live.set(t.id, step);
      s.steps.push(step);
    }
    Object.assign(step, { subject: t.subject, status: t.status, outcome: t.outcome });
    const span = step.spans.at(-1);
    if (t.status === 'in_progress') {
      if (!span || span.end !== null) step.spans.push({ start: at, end: null });
    } else if (span && span.end === null) span.end = at;
    // Done without ever being seen underway: its time is what work it got, none.
    if (t.status === 'completed' && !step.spans.length) step.spans.push({ start: at, end: at });
  }
}

/** What's left of `span` after taking out `outs`. */
function subtract(span: Span, outs: Span[]): Span[] {
  let left: Span[] = [span];
  for (const [a, b] of outs)
    left = left.flatMap(([s, e]): Span[] =>
      b <= s || a >= e
        ? [[s, e]]
        : [
            [s, Math.min(a, e)],
            [Math.max(b, s), e],
          ].filter((x): x is Span => x[1] - x[0] > 0),
    );
  return left;
}

/** A card, by when it opened and closed. */
export interface CardTime {
  id: string;
  event: number;
  at: number;
  end: number | null;
}
/** What the cut needs of the minion itself, beside its events. */
export interface LogTicket {
  created_at: number;
  status: string;
  state: string | null;
  closed_at: number | null;
  worker_wait?: unknown;
}

/** Waits whose ends events give, over the whole chat: cards, ships, holds, limits, kills, dismissals. */
function knownWaits(s: State, cards: CardTime[], now: number, recorded: RecordedWait[]): (TimeSeg & { prio: number })[] {
  const out: (TimeSeg & { prio: number })[] = recorded.map((r) => ({ ...r, prio: 0 }));
  const nextTurn = (t: number) => s.turns.find((u) => u.start > t)?.start ?? Number.MAX_SAFE_INTEGER;
  const after = (t: number, ...tags: MarkTag[]) => s.marks.find((m) => m.at >= t && tags.includes(m.tag));
  for (const m of s.marks) {
    const until = nextTurn(m.at);
    if (m.tag === 'limit') out.push({ start: m.at, end: until, kind: 'wait', sub: 'limit', title: 'Waited for the usage limit to reset', event: m.event, prio: 1 });
    // The turn's last sign of life came before its note, so the wait starts there.
    const from = s.turns.filter((u) => u.start <= m.at).at(-1)?.last ?? m.at;
    if (m.tag === 'kill') out.push({ start: from, end: until, kind: 'lost', sub: 'kill', title: 'Its turn was killed from outside, then resumed', event: m.event, prio: 2 });
    if (m.tag === 'restart') out.push({ start: from, end: until, kind: 'lost', sub: 'restart', title: 'The server restarted during its turn', event: m.event, prio: 2 });
    if (m.tag === 'killed-for-good') out.push({ start: from, end: until, kind: 'wait', sub: 'stopped', title: 'Its turn was killed and waited for a message', event: m.event, prio: 2 });
    if (m.tag === 'stopped') out.push({ start: m.at, end: until, kind: 'wait', sub: 'stopped', title: 'Stopped, waiting for a message', event: m.event, prio: 6 });
    if (m.tag === 'failed') out.push({ start: m.at, end: until, kind: 'wait', sub: 'stopped', title: 'Its turn failed, waiting for a message', event: m.event, prio: 6 });
    if (m.tag === 'dismissed' || (m.tag === 'live' && after(m.at + 1, 'dismissed', 'live') === undefined)) out.push({ start: m.at, end: until, kind: 'gone', sub: 'dismissed', title: 'Dismissed', event: m.event, prio: 1 });
    if (m.tag === 'hold') {
      const begin = after(m.at, 'started');
      out.push({ start: m.at, end: Math.min(begin?.at ?? until, until), kind: 'wait', sub: 'hold', title: `Held for #${m.text}`, event: m.event, prio: 5 });
    }
    if (m.tag === 'shipped') {
      const live = after(m.at, 'live');
      if (live) out.push({ start: m.at, end: live.at, kind: 'wait', sub: 'deploy', title: 'Waiting for the deploy', event: m.event, prio: 5 });
    }
  }
  s.ships.forEach((ship, i) => {
    const end = after(ship.at, 'shipped', 'ship-failed', 'live');
    // No end on record and it isn't the newest hand-off: its line is only known until the next turn.
    const done = end?.at ?? (i === s.ships.length - 1 && nextTurn(ship.at) === Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : nextTurn(ship.at));
    out.push({ start: ship.at, end: done, kind: 'wait', sub: 'ship', title: end?.tag === 'ship-failed' ? 'In the ship line; the ship was refused' : 'In the ship line', event: ship.event, prio: 4 });
  });
  const lastTurn = s.turns.at(-1);
  for (const c of cards) {
    // One never answered holds the minion only after its last turn.
    const from = c.end === null && lastTurn ? Math.max(c.at, lastTurn.end ?? lastTurn.last) : c.at;
    out.push({ start: from, end: c.end ?? now, kind: 'wait', sub: 'person', title: "Waiting for a card's answer", event: c.event, prio: 3 });
  }
  return out.sort((a, b) => a.prio - b.prio);
}

/** The in-turn stretches of `t`: working, but for its waits, cut-off runs and overloaded model where nothing else ran. */
function turnSegs(turn: Turn, tools: Tool[], end: number): TimeSeg[] {
  const ends = (t: Tool) => Math.min(t.end ?? end, end);
  const busy = tools.filter((t) => t.k === 'work').map((t): Span => [t.at, ends(t)]);
  const said: Record<Exclude<Tool['k'], 'work'>, Omit<TimeSeg, 'start' | 'end'>> = {
    cut: { kind: 'lost', sub: 'cut', title: 'A run cut off by a time limit' },
    wait: { kind: 'wait', sub: 'job', title: 'Waiting on a job' },
    overload: { kind: 'lost', sub: 'overload', title: 'A Grunt stopped: the model was overloaded' },
  };
  const taken: TimeSeg[] = [];
  for (const k of ['cut', 'wait', 'overload'] as const)
    for (const t of tools) {
      if (t.k !== k) continue;
      const over = busy.filter(([s, e]) => s < ends(t) && e > t.at);
      const free = subtract([Math.max(t.at, turn.start), ends(t)], [...over, ...taken.map((x): Span => [x.start, x.end])]).filter(([a, b]) => b - a >= LEAST_MS);
      for (const [a, b] of free) taken.push({ start: a, end: b, ...said[k], event: t.event, ...(k === 'overload' && { guess: true as const }) });
    }
  const work = subtract(
    [turn.start, end],
    taken.map((x): Span => [x.start, x.end]),
  ).map(([a, b]): TimeSeg => ({ start: a, end: b, kind: 'work' }));
  return [...taken, ...work].sort((a, b) => a.start - b.start);
}

/** The whole log: every stretch from the minion's making to now (or its dismissal), and its rows. Pure. */
export function cutTime(s: State, ticket: LogTicket, cards: CardTime[], now: number, recorded: RecordedWait[] = []): TimeLog {
  const closed = ticket.status === 'closed';
  const last = s.turns.at(-1);
  const running = !closed && !ticket.worker_wait && ticket.status === 'running' && !!last && last.end === null;
  const stop = closed ? Math.min(now, Math.max(ticket.closed_at ?? last?.last ?? ticket.created_at, last?.last ?? 0)) : now;
  const segs: TimeSeg[] = [];
  const known = knownWaits(s, cards, stop, recorded);
  const gap = (a: number, b: number, tail: boolean) => {
    // The last wait counts from its first moment: it is the one still going on.
    const least = tail ? 1 : LEAST_MS;
    if (b - a < least) return;
    const got: TimeSeg[] = [];
    for (const w of known) {
      if (w.end <= a || w.start >= b) continue;
      const free = subtract(
        [Math.max(a, w.start), Math.min(b, w.end)],
        got.map((x): Span => [x.start, x.end]),
      ).filter(([x, y]) => y - x >= least);
      for (const [x, y] of free) got.push({ start: x, end: y, kind: w.kind, sub: w.sub, title: w.title, event: w.event, ...(w.guess && { guess: w.guess }) });
    }
    for (const [x, y] of subtract(
      [a, b],
      got.map((g): Span => [g.start, g.end]),
    ))
      if (y - x >= least) got.push(...unknown(s, ticket, x, y, tail && y >= b, closed, known));
    segs.push(...got.sort((m, n) => m.start - n.start));
  };
  if (s.turns.length) gap(ticket.created_at, s.turns[0].start, false);
  else gap(ticket.created_at, stop, true);
  s.turns.forEach((turn, i) => {
    const end = turn.end ?? (running && i === s.turns.length - 1 ? stop : turn.last);
    segs.push(
      ...turnSegs(
        turn,
        s.tools.filter((t) => t.turn === i),
        end,
      ),
    );
    const next = s.turns[i + 1];
    if (next) gap(end, next.start, false);
    else if (!running) gap(end, stop, true);
  });
  return shape(s, segs, { start: ticket.created_at, end: stop, running, closed });
}

/** A gap no record explains: what its ends say, marked as a guess. */
function unknown(s: State, ticket: LogTicket, a: number, b: number, tail: boolean, closed: boolean, known: TimeSeg[]): TimeSeg[] {
  if (tail) {
    const held = (kind: TimeKind, sub: TimeSub, title: string, guess = false): TimeSeg[] => [{ start: a, end: b, kind, sub, title, ...(guess && { guess: true as const }) }];
    if (closed) return held('gone', 'finished', 'Finished; open until it was dismissed', true);
    if (ticket.worker_wait) {
      const msg = s.marks.findLast((m) => m.tag === 'message' && m.at > a && m.at < b);
      if (msg) return [...held('wait', 'person', 'Waiting on a person', true).map((x) => ({ ...x, end: msg.at })), { start: msg.at, end: b, kind: 'wait', sub: 'start', title: 'Waiting for a worker' }];
      return held('wait', 'start', 'Waiting for a worker', s.turns.length > 0);
    }
    if (!s.turns.length) return held('wait', 'start', 'Waiting to start', true);
    const st = ticket.state;
    // Only a state its last turn set is known to have held all along; one set since (a Taskmaster's seal) is not.
    const guess = s.state !== st;
    if (st === 'complete') return held('gone', 'finished', 'Finished; open until someone has seen it', guess);
    if (st === 'pending-deploy') return held('wait', 'deploy', 'Waiting for the deploy', guess);
    if (st === 'parked') return held('wait', 'sealed', 'Sealed', guess);
    if (st === 'outside' || st === 'blocked') return held('wait', 'outside', st === 'blocked' ? 'Blocked on something outside the minion' : 'Work running elsewhere', guess);
    if (st === 'limited') return held('wait', 'limit', 'Waiting for the usage limit to reset', guess);
    return held('wait', 'person', 'Waiting on a person', true);
  }
  // Between turns: the message that started the next one says who it waited on.
  const msg = s.marks.findLast((m) => m.tag === 'message' && m.at >= a && m.at <= b + 1500);
  const from = msg ? Math.min(b, Math.max(a, msg.at)) : b;
  const out: TimeSeg[] = [];
  const inLine = known.some((w) => w.sub === 'ship' && w.start < b && w.end > a);
  if (from - a >= LEAST_MS) {
    if (msg && !msg.server) out.push({ start: a, end: from, kind: 'wait', sub: 'person', title: `Waiting on ${msg.text || 'a person'}`, event: msg.event, guess: true });
    else if (s.marks.some((m) => m.tag === 'wake' && m.at < a + 1500 && m.at > a - 6 * 3600_000) && msg) out.push({ start: a, end: from, kind: 'wait', sub: 'wake', title: 'Waiting for its own alarm', event: msg.event, guess: true });
    else out.push({ start: a, end: from, kind: 'wait', sub: 'unknown', title: inLine ? 'In the ship line' : 'Nothing recorded', guess: true, ...(msg && { event: msg.event }) });
  }
  if (b - from >= LEAST_MS) out.push({ start: from, end: b, kind: 'wait', sub: 'start', title: 'Starting up', ...(b - from > ROW_MS && { guess: true as const }) });
  return out;
}

/** A line row's title until the minion speaks. */
const UNSAID = 'No line posted';

const clean = (text: string) => {
  const line =
    text
      .replace(/```[\s\S]*?(```|$)/g, ' ')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !/^[-*#>|]+$/.test(l)) ?? text;
  return line
    .replace(/[*_`#]/g, '')
    .trim()
    .slice(0, 160);
};

/** The stretches with their rows: a step per plan step, the minion's lines for work no step owns, and waits between them. */
function shape(s: State, raw: TimeSeg[], meta: { start: number; end: number; running: boolean; closed: boolean }): TimeLog {
  const steps = s.steps.map((step) => ({ step, spans: step.spans.map((x): Span => [x.start, x.end ?? Number.MAX_SAFE_INTEGER]) }));
  // Every edge that could change whose work a moment is.
  const spans = steps.flatMap(({ step, spans: sp }) => sp.map((x) => ({ step, start: x[0], end: x[1] })));
  const cuts = [...new Set(spans.flatMap((x) => [x.start, x.end]))].sort((a, b) => a - b);
  const owner = (a: number, b: number): Step | null => {
    let best: { start: number; step: Step } | null = null;
    for (const x of spans) if (x.start <= a && x.end >= b && (!best || x.start >= best.start)) best = { start: x.start, step: x.step };
    return best?.step ?? null;
  };
  const { says } = s;
  const rows: TimeRow[] = [];
  const stepRow = new Map<Step, number>();
  let line: { row: number; from: number } | null = null;
  let lastWait = -1;
  // The first of its lines after the stretch being cut: says and stretches both run in time order.
  let spoke = 0;
  const segs: TimeSeg[] = [];
  const push = (seg: TimeSeg) => {
    const prev = segs.at(-1);
    if (prev && prev.end === seg.start && prev.kind === seg.kind && prev.sub === seg.sub && prev.title === seg.title && prev.row === seg.row && !!prev.guess === !!seg.guess) prev.end = seg.end;
    else segs.push(seg);
  };
  const lineRow = (a: number, b: number): number => {
    const turn = s.turns.findLast((t) => t.start <= a)?.start ?? a;
    const say = says.findLast((x) => x.at <= a + 1500 && x.at >= turn);
    const row = rows.length;
    rows.push({ type: 'line', title: say ? clean(say.text) : UNSAID, kind: 'work', start: a, end: b, work: 0, wait: 0, lost: 0, ...(say && { event: say.event }) });
    return row;
  };
  for (const seg of raw) {
    const inTurn = seg.kind === 'work' || seg.sub === 'job' || seg.sub === 'cut' || seg.sub === 'overload';
    if (!inTurn) {
      const long = seg.end - seg.start >= ROW_MS || seg.kind === 'lost';
      let row: number | undefined;
      if (long && seg.kind !== 'gone') {
        row = lastWait = rows.length;
        rows.push({ type: 'wait', title: seg.title ?? 'Waiting', kind: seg.kind, sub: seg.sub, start: seg.start, end: seg.end, work: 0, wait: 0, lost: 0, ...(seg.guess && { guess: seg.guess }), ...(seg.event && { event: seg.event }) });
        line = null;
      }
      push({ ...seg, ...(row !== undefined && { row }) });
      continue;
    }
    // Cut at every step edge inside it, so an owner's stretch ends where its step does, and (for unowned work) where the minion spoke.
    const edges = cuts.filter((c) => c > seg.start && c < seg.end);
    while (spoke < says.length && says[spoke].at <= seg.start) spoke++;
    const speak = new Set<number>();
    for (let i = spoke; i < says.length && says[i].at < seg.end; i++) speak.add(says[i].at);
    const all = [...new Set([seg.start, ...edges, ...speak, seg.end])].sort((x, y) => x - y);
    for (let i = 0; i + 1 < all.length; i++) {
      const [a, b] = [all[i], all[i + 1]];
      const own = owner(a, b);
      let row: number | undefined;
      if (own) {
        row = stepRow.get(own);
        if (row === undefined || lastWait > row) {
          const before = row === undefined ? undefined : rows[row];
          if (before) Object.assign(before, { more: true, outcome: undefined, status: own.status === 'completed' ? 'completed' : undefined });
          row = rows.length;
          rows.push({ type: 'step', title: own.subject, kind: 'work', status: own.status, outcome: own.outcome, ...(before && { continued: true as const }), start: a, end: b, work: 0, wait: 0, lost: 0 });
          stepRow.set(own, row);
        }
        line = null;
      } else {
        if (!line || (speak.has(a) && a - line.from >= ROW_MS)) line = { row: lineRow(a, b), from: a };
        // Work before it had said anything takes its first line.
        else if (speak.has(a) && rows[line.row].title === UNSAID) {
          const say = says.find((x) => x.at === a)!;
          Object.assign(rows[line.row], { title: clean(say.text), event: say.event });
        }
        row = line.row;
      }
      push({ ...seg, start: a, end: b, row });
    }
  }
  return finish(s, segs, rows, stepRow, meta);
}

/** Sum each row, drop the tiny rows of a planned minion, and put in the plan's steps that never got time. */
function finish(s: State, segs: TimeSeg[], rows: TimeRow[], stepRow: Map<Step, number>, meta: { start: number; end: number; running: boolean; closed: boolean }): TimeLog {
  const totals = { work: 0, wait: 0, lost: 0, guess: 0 };
  for (const seg of segs) {
    const ms = seg.end - seg.start;
    if (seg.kind !== 'gone') totals[seg.kind] += ms;
    if (seg.guess && seg.kind !== 'gone') totals.guess += ms;
    if (seg.row === undefined) continue;
    const r = rows[seg.row];
    r.start = Math.min(r.start ?? seg.start, seg.start);
    r.end = Math.max(r.end ?? seg.end, seg.end);
    if (seg.kind !== 'gone') r[seg.kind] += ms;
  }
  const planned = stepRow.size > 0;
  const keep = rows.map((r) => r.type !== 'line' || !planned || r.work + r.wait + r.lost >= ROW_MS);
  const index: number[] = [];
  let n = 0;
  for (const k of keep) index.push(k ? n++ : -1);
  const out = rows.filter((_, i) => keep[i]);
  for (const seg of segs) if (seg.row !== undefined) index[seg.row] >= 0 ? (seg.row = index[seg.row]) : delete seg.row;
  // The plan's steps that got no time yet, after the ones that did.
  for (const t of s.p.tasks as unknown as { id: string; subject: string; status: string; outcome?: string }[]) {
    const step = s.live.get(t.id);
    if (step && !stepRow.has(step)) out.push({ type: 'step', title: t.subject, kind: 'work', status: t.status, outcome: t.outcome, start: null, end: null, work: 0, wait: 0, lost: 0 });
  }
  return { ...meta, segs, rows: out, totals };
}

/** Each card's opening and closing, from the cards and answers in a chat: its settled record, a result event, or the message that answered it. */
export function cardTimes(rows: EventRow[], marks: Mark[]): CardTime[] {
  const cards = new Map<string, CardTime>();
  const closeAt = (id: string, at: number) => {
    const c = cards.get(id);
    if (c) c.end = c.end === null ? Math.max(at, c.at) : Math.min(c.end, Math.max(at, c.at));
  };
  for (const r of rows) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(r.data);
    } catch {
      continue;
    }
    const id = typeof d.id === 'string' ? d.id : '';
    if (!id) continue;
    if (r.kind === 'question' || r.kind === 'plan' || r.kind === 'approval') {
      if (d.notice) continue;
      cards.set(id, { id, event: r.id, at: r.created_at, end: null });
      const settled = d.settled as { at?: unknown } | undefined;
      if (typeof settled?.at === 'number') closeAt(id, settled.at);
    } else closeAt(id, ((d.settled as { at?: number } | undefined)?.at ?? r.created_at) as number);
  }
  for (const m of marks) if (m.answers) closeAt(m.answers, m.at);
  return [...cards.values()];
}

const PAGE = 200;
const CARD_KINDS = ['question', 'plan', 'approval', 'question_result', 'plan_result', 'approval_result'];
/** Logs kept folded, per store, newest used last: an open log costs only its new events. */
const KEPT = 24;
const kept = new WeakMap<Store, Map<number, { s: State; busy: Promise<void> }>>();

/** Bring a chat's fold up to date, a page at a time so other requests run between pages. */
async function catchUp(store: Store, id: number, s: State) {
  for (;;) {
    const rows = store.timeLogEvents(id, s.upTo, PAGE);
    for (const r of rows) foldEvent(s, r);
    if (rows.length < PAGE) return;
    await new Promise<void>((r) => setImmediate(r));
  }
}

/**
 * A minion's time log, right now: the one reader every view shares. Reads only what the chat holds, and only what is
 * new since the last call for this minion, but for its cards, which settle in place and are read again.
 */
export async function timeLog(store: Store, ticket: LogTicket & { id: number }, now = Date.now(), recorded: RecordedWait[] = []): Promise<TimeLog> {
  let logs = kept.get(store);
  if (!logs) kept.set(store, (logs = new Map()));
  let entry = logs.get(ticket.id);
  if (!entry) entry = { s: newState(), busy: Promise.resolve() };
  logs.delete(ticket.id); // re-added last, so the oldest-used goes first
  logs.set(ticket.id, entry);
  if (logs.size > KEPT) logs.delete(logs.keys().next().value!);
  // Two reads of one chat at once share the fold: the second waits for the first.
  const turn = entry.busy.catch(() => {}).then(() => catchUp(store, ticket.id, entry.s));
  entry.busy = turn;
  await turn;
  const cards = cardTimes(store.eventsOfKinds(ticket.id, CARD_KINDS), entry.s.marks);
  return cutTime(entry.s, ticket, cards, now, recorded);
}
