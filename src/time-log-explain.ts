// Explain on the time log (#1994; Josh, 2026-11-25: "Kept for everyone", "Haiku"): a person presses it, and a one-shot
// Haiku call on their own login (src/review-describe.ts) writes 1 to 4 lines of what happened in each step and wait of a
// minion's time log (src/time-log.ts), each resting on chat events. It runs beside the minion, never in it: no tools, no
// session kept, in the presser's scratch folder. The server keeps only lines whose evidence is in the chat and that state
// no length or clock time (the page prints those itself). Kept per minion; a second press writes only the parts whose
// events are new. Rules: the shared folder's specs/minion-time-log/minion-time-log.md ("Explain").
import type { EventRow } from './db-rows.ts';
import type { TimeLog, TimeRow } from './time-log.ts';

/** A line of the reading: what happened, and the chat events it rests on. */
export interface ExplainLine {
  kind: 'work' | 'wait' | 'lost';
  text: string;
  ev: number[];
}
/** One step's or wait's lines. `end` is where its row ended when it was read. */
export interface ExplainPart {
  lines: ExplainLine[];
  end: number;
}
export interface ExplainPress {
  by: string;
  at: number;
  /** Dollars, as Claude reported them; null when it didn't. */
  cost: number | null;
  parts: number;
}
/**
 * What is kept per minion (the time_log_explains row's data). Version 1. A later version may add fields; readExplain
 * keeps reading every version's fields it knows and drops the rest, so a saved reading always opens.
 */
export interface Explain {
  v: number;
  parts: Record<string, ExplainPart>;
  /** The newest chat event the reading had seen: a row with events after it is out of date. */
  upTo: number;
  presses: ExplainPress[];
  /** A press under way, so everyone who opens the log sees it. */
  writing?: { by: string; at: number };
}
/** What the page gets beside the log. */
export interface ExplainView {
  parts: Record<string, ExplainLine[]>;
  presses: ExplainPress[];
  /** Rows with no reading yet, or with events since theirs. */
  fresh: string[];
  writing: { by: string; at: number } | null;
}

export const EXPLAIN_VERSION = 1;
export const EXPLAIN_MODEL = 'haiku';
/** A press older than this is taken as gone (a restart, a lost call): another can start. */
export const WRITE_MS = 4 * 60_000;
/** At most this many parts in one press, and this much input: what's left stays fresh, for the next press. */
const MAX_PARTS = 40;
const MAX_INPUT = 90_000;
const PART_LINES = 60;
const KEEP_PRESSES = 20;

/** The same key the page gives a row (public/time-log.js rowKey). */
export const rowKey = (r: Pick<TimeRow, 'type' | 'start'>): string | null => (r.start == null ? null : `${r.type}:${r.start}`);

const asKind = (k: unknown): ExplainLine['kind'] | null => (k === 'work' || k === 'wait' || k === 'lost' ? k : null);

/** A saved reading of any version, or an empty one. Never throws: a row it can't read is no reading. */
export function readExplain(data: string | null | undefined): Explain {
  const empty: Explain = { v: EXPLAIN_VERSION, parts: {}, upTo: 0, presses: [] };
  let d: Record<string, unknown>;
  try {
    d = data ? JSON.parse(data) : null;
  } catch {
    return empty;
  }
  if (!d || typeof d !== 'object') return empty;
  const parts: Record<string, ExplainPart> = {};
  for (const [key, p] of Object.entries((d.parts && typeof d.parts === 'object' ? d.parts : {}) as Record<string, { lines?: unknown; end?: unknown }>)) {
    if (!p || typeof p !== 'object') continue;
    const lines = (Array.isArray(p.lines) ? p.lines : [])
      .map((l: { kind?: unknown; text?: unknown; ev?: unknown }): ExplainLine | null => {
        const ev = Array.isArray(l?.ev) ? l.ev.filter((n: unknown): n is number => Number.isInteger(n)) : [];
        return typeof l?.text === 'string' && l.text.trim() && ev.length ? { kind: asKind(l.kind) ?? 'work', text: l.text, ev } : null;
      })
      .filter((l): l is ExplainLine => !!l);
    parts[key] = { lines, end: typeof p.end === 'number' ? p.end : 0 };
  }
  const presses = (Array.isArray(d.presses) ? d.presses : [])
    .filter((p: { by?: unknown; at?: unknown }) => typeof p?.by === 'string' && typeof p?.at === 'number')
    .map((p: { by: string; at: number; cost?: unknown; parts?: unknown }) => ({ by: p.by, at: p.at, cost: typeof p.cost === 'number' ? p.cost : null, parts: typeof p.parts === 'number' ? p.parts : 0 }));
  const w = d.writing as { by?: unknown; at?: unknown } | undefined;
  return { v: typeof d.v === 'number' ? d.v : EXPLAIN_VERSION, parts, upTo: typeof d.upTo === 'number' ? d.upTo : 0, presses, ...(typeof w?.by === 'string' && typeof w?.at === 'number' && { writing: { by: w.by, at: w.at } }) };
}

/** The rows a reading can be about: the ones with times. */
const timed = (log: TimeLog) => log.rows.filter((r) => r.start != null);

/**
 * The reading as the page shows it over `log`. `since` is when the first event after the reading's `upTo` was written
 * (null: none), so a row reaching it has something new.
 */
export function explainView(e: Explain, log: TimeLog, since: number | null, now = Date.now()): ExplainView {
  const parts: Record<string, ExplainLine[]> = {};
  const fresh: string[] = [];
  for (const r of timed(log)) {
    const key = rowKey(r)!;
    const p = e.parts[key];
    if (p) parts[key] = p.lines;
    if (!p || (since !== null && r.end !== null && r.end >= since)) fresh.push(key);
  }
  const writing = e.writing && now - e.writing.at < WRITE_MS ? e.writing : null;
  return { parts, presses: e.presses, fresh, writing };
}

// ---- The input: the log's parts, each with what its events say, every event labelled e1…eN.

type Block = { type?: string; text?: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown; is_error?: boolean };
const D = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const clock = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
const one = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);
const resultText = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (typeof x?.text === 'string' ? x.text : '')).join('\n') : '');
const READS = new Set(['Read', 'Grep', 'Glob', 'LSP', 'ToolSearch', 'WebFetch', 'WebSearch', 'TaskOutput', 'Skill']);
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const TESTS = /\b(citadel-test|npm (run )?test|node --test|pytest|cargo test|go test|vitest|jest|typecheck)\b/;
const CUT_OFF = /Exit code (?:124|143)\b|Command timed out after/;
const OVERLOADED = /\b529\b|[Oo]verloaded/;
/** A Grunt's report, from where its findings start (the trials: excerpts from "Findings" or "Must fix" helped). */
const report = (text: string) => {
  const k = text.search(/\*{0,2}(Findings|Must fix|Verdict|Risk)\b/);
  return one(text.slice(Math.max(0, k)), 1300);
};

interface Entry {
  at: number;
  event: number | null;
  text: string;
}
interface Part {
  label: string;
  key: string;
  row: TimeRow;
  entries: Entry[];
  reads: number;
  edits: Set<string>;
  errors: number;
}

/** The input for the parts `keys` of `log`, from the chat's `events` (oldest first). */
export function explainInput(title: string, log: TimeLog, events: EventRow[], keys: string[]): { text: string; labels: Map<string, number>; parts: Map<string, string> } {
  const want = new Set(keys);
  const rowParts = new Map<number, Part>();
  timed(log).forEach((r) => {
    const key = rowKey(r)!;
    if (want.has(key)) rowParts.set(log.rows.indexOf(r), { label: '', key, row: r, entries: [], reads: 0, edits: new Set(), errors: 0 });
  });
  // The segment an event falls in names its row; one with no row (a short gap) gives it to the row before.
  const segs = log.segs;
  const rowAt = (at: number): number | undefined => {
    let i = segs.findLastIndex((s) => s.start <= at);
    if (i < 0) i = 0;
    for (let j = i; j >= 0; j--) if (segs[j].row !== undefined) return segs[j].row;
    return segs.find((s) => s.row !== undefined)?.row;
  };
  const tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  const says: { at: number; text: string }[] = [];
  for (const ev of events) {
    let d: Record<string, unknown>;
    try {
      d = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const at = ev.created_at;
    const add = (text: string, event: number | null = ev.id) => {
      const p = rowParts.get(rowAt(at) ?? -1);
      if (p) p.entries.push({ at, event, text });
      return p;
    };
    if (ev.kind === 'note') {
      if (typeof d.text === 'string') add(`Citadel noted: ${one(d.text, 260)}`);
    } else if (ev.kind === 'error') {
      if (typeof d.text === 'string') add(`Error: ${one(d.text, 220)}`);
    } else if (ev.kind === 'user_message') {
      if (typeof d.text === 'string' && !d.mail) add(`${typeof d.author === 'string' ? d.author : 'Someone'} wrote to it: ${one(d.text, 260)}`);
    } else if (ev.kind === 'question' || ev.kind === 'plan' || ev.kind === 'approval') {
      const q = (d.questions as { question?: unknown }[] | undefined)?.[0]?.question ?? d.summary ?? d.notice;
      if (!d.notice && typeof q === 'string') add(`It asked people on a card: ${one(q, 200)}`);
    } else if (ev.kind === 'claude') {
      if (d.parent_tool_use_id) continue; // a Grunt's own steps: its report comes back to the minion
      const blocks = ((d.message as { content?: unknown } | undefined)?.content ?? []) as Block[];
      if (!Array.isArray(blocks)) continue;
      for (const b of blocks) {
        if (b.type === 'text' && d.type === 'assistant' && b.text && b.text.trim().length > 15) {
          says.push({ at, text: b.text });
          add(`The minion wrote: "${one(b.text, 240)}"`);
        } else if (b.type === 'tool_use' && b.id && b.name) {
          const input = b.input ?? {};
          tools.set(b.id, { name: b.name, input });
          const p = rowParts.get(rowAt(at) ?? -1);
          if (!p) continue;
          const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
          if (READS.has(b.name)) p.reads++;
          else if (EDITS.has(b.name)) p.edits.add((s('file_path') || s('notebook_path')).split('/').pop() || 'a file');
          else if (b.name === 'Bash') add(`Command: ${one(s('description') || s('command'), 160)}`);
          else if (b.name === 'Agent' || b.name === 'Task') add(`Started a Grunt (helper): ${one(s('description'), 120)}`);
          else if (b.name.endsWith('hand_off_land')) add(`Handed its change off to ship: ${one(s('summary'), 200)}${s('risk') ? ` (risk ${s('risk')})` : ''}`);
          else if (b.name.endsWith('message_coordinator') || b.name.endsWith('message_minion')) add(`Messaged ${b.name.endsWith('coordinator') ? 'the Taskmaster' : 'another minion'}: ${one(s('text') || s('message'), 200)}`);
          else if (b.name.endsWith('ask_question')) {
            const q = (input.questions as { question?: unknown }[] | undefined)?.[0]?.question;
            add(`Asked people: ${typeof q === 'string' ? one(q, 200) : 'a card'}`);
          }
        } else if (b.type === 'tool_result' && b.tool_use_id) {
          const t = tools.get(b.tool_use_id);
          if (!t) continue;
          const text = resultText(b.content);
          if (b.is_error) {
            const p = rowParts.get(rowAt(at) ?? -1);
            if (t.name === 'Bash' && CUT_OFF.test(text)) add(`That command was CUT OFF by a time limit: ${one(String(t.input.description ?? t.input.command ?? ''), 120)}`);
            else if (OVERLOADED.test(text)) add(`A call STOPPED: the model was overloaded (HTTP 529)`);
            else if (t.name === 'Bash') add(`That command failed: ${one(text.split('\n').find((l) => l.trim()) ?? '', 160)}`);
            else if (p) p.errors++;
          } else if (t.name === 'Agent' || t.name === 'Task') add(`The Grunt reported: ${report(text)}`);
          else if (t.name === 'Bash' && TESTS.test(String(t.input.command ?? ''))) {
            const tail = text
              .trim()
              .split('\n')
              .filter((l) => l.trim())
              .slice(-2)
              .join(' / ');
            if (tail) add(`Test output ended: ${one(tail, 200)}`);
          }
        }
      }
    }
  }
  // The parts in order, labelled, with as much as fits.
  const labels = new Map<string, number>();
  const partLabels = new Map<string, string>();
  const byEvent = new Map<number, string>();
  const L: string[] = [`Minion: ${one(title, 200)}`];
  let n = 0;
  let used = L[0].length;
  const ordered = [...rowParts.values()].sort((a, b) => a.row.start! - b.row.start!);
  for (const p of ordered.slice(0, MAX_PARTS)) {
    const r = p.row;
    const lab = (event: number | null | undefined) => {
      if (!event) return '';
      // One label an event, however many lines quote it.
      const k = byEvent.get(event) ?? `e${++n}`;
      byEvent.set(event, k);
      labels.set(k, event);
      return `[${k}] `;
    };
    const label = `P${partLabels.size + 1}`;
    const span = `${clock(r.start!)} to ${r.end ? clock(r.end) : 'now'}`;
    const lens = [r.work >= 1000 && `working ${D(r.work)}`, r.wait >= 1000 && `waiting ${D(r.wait)}`, r.lost >= 1000 && `lost ${D(r.lost)}`].filter(Boolean).join(', ');
    const head =
      r.type === 'step'
        ? `step "${one(r.title, 120)}"${r.status === 'completed' ? ' (done)' : ''}${r.continued ? ' (goes on from before a wait)' : ''}${r.outcome ? `; the minion's own outcome: "${one(r.outcome, 200)}"` : ''}`
        : r.type === 'wait'
          ? `${r.kind === 'lost' ? 'LOST' : 'WAIT'}: ${one(r.title, 160)}${r.guess ? ' (cause is a guess)' : ''}`
          : `work outside any step, under the minion's line "${one(r.title, 160)}"`;
    const out = [`== PART ${label}: ${lab(r.event)}${head}. ${span}${lens ? `, ${lens}` : ''}`];
    if (r.type === 'wait') {
      const last = says.findLast((x) => x.at <= r.start!);
      if (last) out.push(`   the minion's last words before it: "${one(last.text, 260)}"`);
    }
    const entries = p.entries.length > PART_LINES ? [...p.entries.slice(0, 15), null, ...p.entries.slice(-(PART_LINES - 15))] : p.entries;
    for (const e of entries) out.push(e ? `   ${lab(e.event)}${clock(e.at)} ${e.text}` : `   … ${p.entries.length - PART_LINES} more actions`);
    if (p.reads) out.push(`   (read or searched ${p.reads} times)`);
    if (p.edits.size) out.push(`   (edited ${[...p.edits].slice(0, 8).join(', ')}${p.edits.size > 8 ? ` and ${p.edits.size - 8} more` : ''})`);
    if (p.errors) out.push(`   (${p.errors} other tool call(s) returned an error)`);
    const text = out.join('\n');
    if (partLabels.size && used + text.length > MAX_INPUT) break;
    used += text.length + 1;
    partLabels.set(label, p.key);
    L.push('', text);
  }
  return { text: L.join('\n'), labels, parts: partLabels };
}

export const EXPLAIN_SYSTEM = `You explain, in plain words, what happened in each part of an AI coding worker's (a minion's) recorded time log, for a person who has not followed the work. A Grunt is a helper it started; a ship is its change going live; a card is a question it asked people. The page already shows each part's name, times, lengths and waits; you add what happened.
Rules:
- Use only the log. Never guess a cause. For lost or waiting time whose reason is in the log (a label, a note, a message, or the minion's last words before it) give that reason; otherwise write "No reason recorded."
- For every PART give 1 to 4 lines, in time order. A short quiet part gets one. A part with a review, a failure, a cut-off or a wait gets a line for each.
- One sentence a line, at most 30 words, no jargon, no em dashes.
- If a review found something that matters, say what could have gone wrong in plain words. Reviews are excerpts and may be cut short: never say a review found nothing else.
- Say if the work in a part differs from its step's name.
- Each line lists 1 to 4 evidence labels it rests on, like "e3", taken only from that part's own [eN] labels.
- Never write a duration, a number of minutes or hours, or a clock time.
- "kind": "work", "wait" or "lost" per line. "lost" only when the log says lost, cut off, stopped or killed.
- No summary of the whole log.
Reply with JSON only: {"parts":[{"part":"P1","lines":[{"text":"...","kind":"work","evidence":["e1"]}]}]}`;

/** Lines that say how long something took or when: the page prints those from the record, so a model's are dropped. */
const LENGTH =
  /\b(\d+(\.\d+)?|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|ninety|several|a few|few|half an?|many|couple of)[\s-]+(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b|\b\d+(\.\d+)?\s?(s|m|h|ms|min|hr)\b|\b\d{1,2}:\d{2}\b|\b(an?|half an?) (hour|minute|day)\b/i;
export const statesLength = (text: string) => LENGTH.test(text);

/**
 * The model's reply as lines per part key, keeping only lines with evidence the input labelled and no length or time.
 * Every part asked about gets an entry, empty when nothing came back for it. Throws when the reply isn't the JSON asked for.
 */
export function readReading(reply: string, labels: Map<string, number>, parts: Map<string, string>): Map<string, ExplainLine[]> {
  const text = reply
    .trim()
    .replace(/^```(?:json)?\s*/, '')
    .replace(/```$/, '')
    .trim();
  let data: { parts?: unknown };
  try {
    data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    throw new Error("Haiku's answer wasn't the reading it should be");
  }
  const out = new Map<string, ExplainLine[]>([...parts.values()].map((k) => [k, []]));
  for (const p of Array.isArray(data?.parts) ? data.parts : []) {
    const label = typeof p?.part === 'number' ? `P${p.part}` : String(p?.part ?? '');
    const key = parts.get(label);
    if (!key || !Array.isArray(p.lines)) continue;
    const lines = out.get(key)!;
    for (const l of p.lines) {
      if (lines.length >= 4) break;
      const t = typeof l?.text === 'string' ? l.text.replace(/\s+/g, ' ').trim() : '';
      if (!t || t.length > 400 || statesLength(t)) continue;
      const ev = [...new Set((Array.isArray(l.evidence) ? l.evidence : []).map((x: unknown) => labels.get(String(x).replace(/^\[|\]$/g, ''))).filter((x: number | undefined): x is number => x !== undefined))].slice(0, 4) as number[];
      if (!ev.length) continue;
      lines.push({ kind: asKind(l.kind) ?? 'work', text: t, ev });
    }
  }
  return out;
}

/** The saved reading after a press: the new parts' lines over the old, parts no longer in the log dropped. */
export function mergeReading(e: Explain, log: TimeLog, read: Map<string, ExplainLine[]>, asked: string[], press: ExplainPress, upTo: number): Explain {
  const ends = new Map(timed(log).map((r) => [rowKey(r)!, r.end ?? r.start!]));
  const parts: Record<string, ExplainPart> = {};
  for (const [key, p] of Object.entries(e.parts)) if (ends.has(key) && !asked.includes(key)) parts[key] = p;
  for (const [key, lines] of read) if (ends.has(key)) parts[key] = { lines, end: ends.get(key)! };
  return { v: EXPLAIN_VERSION, parts, upTo: Math.max(e.upTo, upTo), presses: [...e.presses, press].slice(-KEEP_PRESSES) };
}

/** The empty-handed outcome: true when the model wrote nothing the log backs up for any part. */
export const nothingRead = (read: Map<string, ExplainLine[]>) => [...read.values()].every((l) => !l.length);
