// Three lines after every ship (#1119, E4 from #1092): at ship a minion says in at most three lines what it had to find
// out that its brief or the docs didn't tell it ("nothing" is a fine answer). They queue here per scheme with the
// minion and the files it touched, never in memory. A line said twice becomes a proposed doc, skill or brief edit:
// the weekly "Ship lessons" schedule (kit/schedules/ship-lessons.md) groups the open lines and puts the repeats on one
// card, and marks the lines it turned into a proposal taken. The curator hook: whatever turns lines into edits later
// (the memory curator, #1111) reads the same queue with the ship_lessons tool and marks lines taken the same way;
// once it does, the scheme pauses its Ship lessons schedule. Writing the lines never blocks a ship: every caller
// catches and logs.
import type { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import type { Store } from './db.ts';
import { addShipLessons } from './standard-audits.ts';

/** At most this many lines a ship, and characters a line. */
export const MAX_LINES = 3;
export const MAX_LINE = 300;
/** At most this many touched files kept a ship: enough to group by area, not a manifest. */
export const MAX_FILES = 40;
/** How far back the weekly pass reads open lines: a repeat a month apart still pairs. */
export const OPEN_WINDOW_MS = 60 * 24 * 60 * 60_000;

export interface Lesson {
  id: number;
  project_id: number;
  ticket_id: number | null;
  /** The minion's #N, kept so the row reads after the minion is gone. */
  number: number | null;
  /** The lines, newline-separated; '' when the minion said there was nothing. */
  lines: string;
  files: string[];
  /** 'land' (hand_off_land, written on a clean land) or 'tool' (log_learned, on a pull-request ship path). */
  source: string;
  at: number;
  taken_at: number | null;
  /** What became of it: the proposal or handoff it went into, or why it was dropped. */
  taken_note: string | null;
}

/**
 * A minion's `learned` text, tidied: its first three non-empty lines, each cut to 300 characters, bullets dropped.
 * "Nothing" (or none, n/a, a dash) is '' and still counts as the ship's answer; null when it gave no text at all.
 * Cuts rather than refuses: writing the lines never blocks a ship.
 */
export function parseLearned(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const lines = raw.split('\n').map((l) => l.trim().replace(/^[-*•]\s+/, '').trim()).filter(Boolean);
  if (lines.length === 1 && /^(nothing|none|n\/a|-+|—)[.!]?$/i.test(lines[0])) return '';
  return lines.slice(0, MAX_LINES).map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE - 1)}…` : l)).join('\n');
}

/**
 * The files a branch touched since it left `bases`' first one that resolves (main, then origin's default), as paths
 * relative to the repo; [] when none resolves or git fails. Never throws: it only labels a row.
 */
export function touchedFiles(cwd: string, bases: string[] = ['main', 'origin/HEAD', 'origin/main']): Promise<string[]> {
  const git = (args: string[]) => new Promise<string | null>((done) => execFile('git', args, { cwd, timeout: 10_000 }, (err, out) => done(err ? null : out)));
  return (async () => {
    for (const base of bases) {
      const out = await git(['diff', '--name-only', `${base}...HEAD`]);
      if (out !== null) return out.split('\n').map((f) => f.trim()).filter(Boolean).slice(0, MAX_FILES);
    }
    return [];
  })();
}

type Row = Omit<Lesson, 'files'> & { files: string };
const row = (r: Row): Lesson => ({ ...r, files: JSON.parse(r.files || '[]') });

export class ShipLessons {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * One ship's lines. A land always adds a row (each clean land is a ship); log_learned replaces the same minion's
   * untaken row from its last 6 hours, so a second call corrects the first rather than counting twice.
   */
  add(l: Pick<Lesson, 'project_id' | 'ticket_id' | 'number' | 'lines' | 'files' | 'source'>, now = Date.now()): Lesson {
    const files = JSON.stringify(l.files.slice(0, MAX_FILES));
    if (l.source === 'tool' && l.ticket_id != null) {
      const old = this.db.prepare("SELECT id FROM ship_lessons WHERE ticket_id = ? AND source = 'tool' AND taken_at IS NULL AND at >= ? ORDER BY id DESC LIMIT 1").get(l.ticket_id, now - 6 * 3600_000) as { id: number } | undefined;
      if (old) {
        this.db.prepare('UPDATE ship_lessons SET lines = ?, files = ?, at = ? WHERE id = ?').run(l.lines, files, now, old.id);
        return this.get(old.id)!;
      }
    }
    const { id } = this.db.prepare('INSERT INTO ship_lessons (project_id, ticket_id, number, lines, files, source, at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .get(l.project_id, l.ticket_id, l.number, l.lines, files, l.source, now) as { id: number };
    return this.get(id)!;
  }

  get(id: number): Lesson | undefined {
    const r = this.db.prepare('SELECT * FROM ship_lessons WHERE id = ?').get(id) as Row | undefined;
    return r && row(r);
  }

  /** A scheme's rows with lines since `since`, newest first: open ones only unless `taken` is true. Nothing-rows are left out. */
  list(projectId: number, opts: { since?: number; taken?: boolean; limit?: number } = {}, now = Date.now()): Lesson[] {
    const since = opts.since ?? now - OPEN_WINDOW_MS;
    const rows = this.db.prepare(`SELECT * FROM ship_lessons WHERE project_id = ? AND at >= ? AND lines != ''${opts.taken ? '' : ' AND taken_at IS NULL'} ORDER BY at DESC, id DESC LIMIT ?`)
      .all(projectId, since, Math.min(opts.limit ?? 200, 500)) as unknown as Row[];
    return rows.map(row);
  }

  /** Ships with an answer since `since`: how many, and how many had lines (the rest said nothing). */
  stats(projectId: number, since: number): { ships: number; withLines: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS ships, SUM(lines != '') AS withLines FROM ship_lessons WHERE project_id = ? AND at >= ?").get(projectId, since) as { ships: number; withLines: number | null };
    return { ships: r.ships, withLines: r.withLines ?? 0 };
  }

  /** The newest open row with lines, for the weekly pass's free skip. */
  newestOpen(projectId: number): number | null {
    const r = this.db.prepare("SELECT MAX(at) AS at FROM ship_lessons WHERE project_id = ? AND lines != '' AND taken_at IS NULL").get(projectId) as { at: number | null };
    return r.at;
  }

  /** Mark this scheme's rows `ids` taken, with what became of them. Ids of another scheme or already taken are skipped. Returns the ids marked. */
  take(projectId: number, ids: number[], note: string, now = Date.now()): number[] {
    const done: number[] = [];
    const mark = this.db.prepare('UPDATE ship_lessons SET taken_at = ?, taken_note = ? WHERE id = ? AND project_id = ? AND taken_at IS NULL');
    for (const id of new Set(ids)) if (Number(mark.run(now, note, id, projectId).changes)) done.push(id);
    return done;
  }
}

/**
 * Queue a ship's lines (from a clean land or log_learned). The scheme's first real lines add its weekly Ship lessons
 * schedule, once (a deleted one stays deleted). Callers catch: this never blocks a ship.
 */
export function queueLesson(store: Store, dataDir: string, t: { id: number; project_id: number; number: number | null }, lines: string, files: string[], source: 'land' | 'tool'): Lesson {
  const row = store.lessons.add({ project_id: t.project_id, ticket_id: t.id, number: t.number, lines, files, source });
  if (lines) {
    const added = addShipLessons(store, dataDir, t.project_id);
    if (added) console.log(`Ship lessons (#1119): ${added}`);
  }
  return row;
}
