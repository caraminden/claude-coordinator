// Compactions called out (#1920; Josh, 2026-11-24: "we cant have that kind of thing just silently going on"). Each one stops a
// turn for about a minute, and a minion that re-reads its files after it soon fills up and stops again: #1918 lost four
// minutes of fourteen that way and nobody saw. Counted per turn from its own stream. The second within BURST_MS of the one
// before is said in the minion's chat and to its Taskmaster, with the files it keeps reading again; then at the fourth, the
// eighth and so on. The kit's after-compact hook speaks to the minion itself.
import { basename } from 'node:path';
import type { ClaudeEvent } from './claude-events.ts';
import type { Ticket } from './db.ts';

/** How close two compactions are to be one burst (a starting value). */
export const BURST_MS = 15 * 60_000;

/** One turn's compactions, for the thread head. */
export interface Compactions {
  n: number;
  /** How long they stopped the turn, all told. */
  ms: number;
}

interface TurnCount extends Compactions {
  last: number;
  /** Compactions in a row, each within BURST_MS of the one before. */
  burst: number;
  /** File → the stretches between compactions (by number) it was read in. */
  reads: Map<string, Set<number>>;
  /** Reads let past the big-read checks with allow_large. */
  escapes: number;
}

const READERS = /^\s*(?:cat|sed|head|tail|nl|awk|less)\s/;
const PATH = /[\w@%+=:,./~-]*\w\.[A-Za-z]\w{0,9}(?=$|['"\s;|&)>])/g;

/**
 * The files a tool call reads, by name: Read's, or the paths on a printing command's line.
 * shortcut: by base name, since a path after a cd has no folder to compare, so two index.ts count as one; resolve against the cwd if that misleads.
 */
export function filesRead(name: string, input: Record<string, unknown> | undefined): string[] {
  if (name === 'Read') return typeof input?.file_path === 'string' ? [basename(input.file_path)] : [];
  if (name !== 'Bash' || typeof input?.command !== 'string') return [];
  const found = input.command.split(/\n|;|&&|\|\|/).flatMap((part) => (READERS.test(part) && !/>\s*\S|<</.test(part) ? (part.match(PATH) ?? []) : []));
  return [...new Set(found.map((p) => basename(p)))];
}

/** "; about 3 min of this turn stopped for it so far", or nothing when the stream gave no times. */
const stopped = (ms: number) => (ms ? `; ${Math.max(1, Math.round(ms / 60_000))} min of this turn stopped for it so far` : '');

export interface CompactDeps {
  ticket: (id: number) => Ticket | undefined;
  /** Message the minion's Taskmaster; wake false leaves it as held mail. */
  tell: (ticket: Ticket, text: string, wake: boolean) => void;
  /** A note in the minion's own chat. */
  note: (ticketId: number, text: string) => void;
  now?: () => number;
}

// shortcut: in memory, so a server restart mid-turn starts its count again; two more compactions still call it out.
export class CompactWatch {
  private turns = new Map<number, TurnCount>();
  private d: CompactDeps;
  constructor(d: CompactDeps) {
    this.d = d;
  }

  of(ticketId: number): Compactions | null {
    const t = this.turns.get(ticketId);
    return t?.n ? { n: t.n, ms: t.ms } : null;
  }

  /** A turn's process ended: its count goes with it. */
  ended(ticketId: number) {
    this.turns.delete(ticketId);
  }

  /** One raw stream event; true when the count changed. A Grunt's own events don't count. */
  observe(ticketId: number, ev: ClaudeEvent): boolean {
    if (ev.parent_tool_use_id) return false;
    if (ev.type === 'system' && ev.subtype === 'compact_boundary') {
      this.compacted(ticketId, Number(ev.compact_metadata?.duration_ms) || 0);
      return true;
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const b of ev.message.content) {
        if (b?.type !== 'tool_use') continue;
        const input = b.input as Record<string, unknown> | undefined;
        const t = this.turn(ticketId);
        for (const f of filesRead(String(b.name), input)) (t.reads.get(f) ?? t.reads.set(f, new Set()).get(f)!).add(t.n);
        if (input?.allow_large || (b.name === 'Bash' && /#\s*allow_large\b/.test(String(input?.command)))) t.escapes++;
      }
    }
    return false;
  }

  private turn(ticketId: number): TurnCount {
    const t = this.turns.get(ticketId) ?? { n: 0, ms: 0, last: 0, burst: 0, reads: new Map(), escapes: 0 };
    this.turns.set(ticketId, t);
    return t;
  }

  private compacted(ticketId: number, ms: number) {
    const t = this.turn(ticketId);
    const now = (this.d.now ?? Date.now)();
    t.burst = t.n && now - t.last <= BURST_MS ? t.burst + 1 : 1;
    t.n++;
    t.ms += ms;
    t.last = now;
    // 2, 4, 8, ...: a burst that goes on is said again, not every minute.
    if (t.burst < 2 || (t.burst & (t.burst - 1)) !== 0) return;
    const ticket = this.d.ticket(ticketId);
    if (!ticket || ticket.kind !== 'ticket' || ticket.status === 'closed') return;
    const again = [...t.reads].filter(([, s]) => s.size > 1).sort((a, b) => b[1].size - a[1].size);
    const files = again.slice(0, 5).map(([f, s]) => `${f} (in ${s.size} of ${t.n} stretches)`);
    const what = `Its memory filled up and was summarised ${t.burst} times in a row, each within 15 minutes of the last${stopped(t.ms)}.`;
    const reads = files.length ? ` It reads these again after each one: ${files.join(', ')}.` : ' No file was read again after one; something else it prints or writes is filling it.';
    const large = t.escapes ? ` It went past the big-read checks ${t.escapes === 1 ? 'once' : `${t.escapes} times`} (allow_large).` : '';
    this.d.note(ticketId, what + reads + large);
    this.d.tell(ticket, `Stall signal on #${ticket.number} ${ticket.title}: compacting over and over.\n${what}${reads}${large}\nIf it goes on, split the work or hand it on with a handoff file. Nothing was changed.`, t.burst >= 4);
  }
}
