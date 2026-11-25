// The memory curator (#1111, E1 from #1092; Josh picked it 2026-11-19): a weekly run proposes a tidier memory store,
// note by note, and nothing changes until a member approves on the Memory page. Josh's grilling answers, 2026-11-19:
// "Any scheme member" approves; the old notes are kept "30 days" with a put-back button; deletes are allowed but
// "Delete, each ticked" (on the page, deletes start unticked; the card's Approve all covers them since #1803); the "Run stays open with a card" until it's decided.
// A proposal is a list of changes, each to one note: its text, its MEMORY.md line, or both. Each change remembers the
// note as it was proposed against, so an approve skips a note someone changed since instead of overwriting it unseen.
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './http.ts';
import { deleteNote, memoryFolders, noteFile, plain, readFolder, writeAtomic, type FolderView, type MemoryFolder, type MemoryLogin } from './memory-files.ts';

/** How long an applied proposal's old notes are kept for Put back (Josh, 2026-11-19: "30 days"). */
export const KEEP_MS = 30 * 86_400_000;
/** Claude Code loads only MEMORY.md's first 200 lines / 25 KB (as src/memory-files.ts's indexNote). */
const INDEX_LINES = 200;
const INDEX_BYTES = 25 * 1024;

export const ACTIONS = ['edit', 'add', 'delete', 'index', 'flag'] as const;
export type Action = (typeof ACTIONS)[number];

/** One change as a run proposes it. */
export interface ProposedChange {
  action: Action;
  file: string;
  text?: string;
  line?: string;
  reason: string;
}

/** One change as stored: the proposal, the note as it was then (for the diff and the changed-since check), and what became of it. */
export interface Change {
  id: number;
  action: Action;
  file: string;
  /** The new text (edit, add). */
  text: string | null;
  /** The new MEMORY.md line (add, index, and optionally edit). */
  line: string | null;
  reason: string;
  /** The note's text and index line when proposed (null for an add, or a note with no line). */
  was: string | null;
  wasLine: string | null;
  /** Set once the proposal is decided: applied, turned down, changed since, noted (a flag), or failed: why. */
  outcome?: string;
}

/** A note's state saved before an approved change, for Put back: null text means it didn't exist. */
export interface Saved {
  file: string;
  text: string | null;
  line: string | null;
}

export interface Proposal {
  id: number;
  project_id: number;
  /** The run that proposed it, whose card waits on it. */
  ticket_id: number | null;
  folder: string;
  status: 'open' | 'applied' | 'dismissed' | 'superseded';
  changes: Change[];
  created_at: number;
  decided_by: string | null;
  decided_at: number | null;
  /** The old notes, until KEEP_MS after the decision; null once dropped or put back. */
  backup: Saved[] | null;
  restored_by: string | null;
  restored_at: number | null;
}

export const hashText = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The index line that links a note, or null. */
export const lineFor = (index: string, file: string): string | null => index.split('\n').find((l) => l.includes(`](${file})`)) ?? null;

/** A MEMORY.md line for `file`: one line, a markdown list item that links it. */
function cleanLine(raw: unknown, file: string, i: number): string {
  if (typeof raw !== 'string') throw new HttpError(400, `Change ${i + 1} (${file}) needs line: its MEMORY.md line`);
  const line = raw.trim();
  if (line.includes('\n')) throw new HttpError(400, `Change ${i + 1} (${file}): line must be one line`);
  if (!line.startsWith('- ') || !line.includes(`](${file})`)) throw new HttpError(400, `Change ${i + 1} (${file}): line must be a list item that links the note, like "- [Name](${file}) — what it holds"`);
  if (line.length > 300) throw new HttpError(400, `Change ${i + 1} (${file}): line is ${line.length} characters; keep it under about 150`);
  return line;
}

/**
 * A run's changes, checked against the folder as it is now: one change per note, notes that exist for everything but
 * an add, and only real changes. Throws a 400 naming the first bad change.
 */
export function checkChanges(folder: FolderView, raw: unknown): Change[] {
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'changes must be a list of at least one change');
  if (raw.length > 300) throw new HttpError(400, 'At most 300 changes in one proposal');
  const notes = new Map(folder.notes.map((n) => [n.file, n.text]));
  const seen = new Set<string>();
  return raw.map((c: any, i): Change => {
    const action = c?.action as Action;
    if (!ACTIONS.includes(action)) throw new HttpError(400, `Change ${i + 1}: action must be one of ${ACTIONS.join(', ')}`);
    // MEMORY.md itself can only be flagged (a long or stale line no note owns): its lines change through each note's change.
    const file = action === 'flag' && c.file === 'MEMORY.md' ? c.file : noteFile(c.file);
    if (!file) throw new HttpError(400, `Change ${i + 1}: file must be a note's file name, like some-note.md (MEMORY.md only with flag)`);
    if (seen.has(file)) throw new HttpError(400, `Change ${i + 1}: ${file} has two changes; make it one (an edit can change its text and its line)`);
    seen.add(file);
    const reason = typeof c.reason === 'string' ? c.reason.trim() : '';
    if (!reason || reason.length > 500) throw new HttpError(400, `Change ${i + 1} (${file}) needs a reason under 500 characters: people decide from it`);
    const was = file === 'MEMORY.md' ? folder.index : (notes.get(file) ?? null);
    if (action === 'add' ? was !== null : was === null) throw new HttpError(400, action === 'add' ? `Change ${i + 1}: ${file} already exists; edit it instead` : `Change ${i + 1}: there is no note ${file}`);
    const wasLine = lineFor(folder.index, file);
    let text: string | null = null;
    let line: string | null = null;
    if (action === 'edit' || action === 'add') {
      if (typeof c.text !== 'string' || !c.text.trim() || c.text.length > 200_000) throw new HttpError(400, `Change ${i + 1} (${file}) needs text: the note's whole new text, under 200 KB`);
      text = c.text.endsWith('\n') ? c.text : `${c.text}\n`;
    }
    if (action === 'add' || action === 'index' || (action === 'edit' && c.line !== undefined && c.line !== null && c.line !== '')) line = cleanLine(c.line, file, i);
    if (action === 'edit' && line === wasLine) line = null;
    if (action === 'edit' && text === was && line === null) throw new HttpError(400, `Change ${i + 1}: that is ${file} as it is now`);
    if (action === 'index' && line === wasLine) throw new HttpError(400, `Change ${i + 1}: that is ${file}'s line as it is now`);
    return { id: i + 1, action, file, text, line, reason, was, wasLine };
  });
}

/** MEMORY.md with `file`'s line set (replacing the first that links it, dropping any others) or, for null, removed. */
export function withLine(index: string, file: string, line: string | null): string {
  const links = (l: string) => l.includes(`](${file})`);
  const lines = index ? index.replace(/\n$/, '').split('\n') : [];
  const at = lines.findIndex(links);
  const out = lines.flatMap((l, i) => (!links(l) ? [l] : i === at && line !== null ? [line] : []));
  if (at < 0 && line !== null) out.push(line);
  return out.length ? `${out.join('\n')}\n` : '';
}

function writeIndex(dir: string, next: string) {
  const path = join(dir, 'MEMORY.md');
  if (existsSync(path) && !plain(path)) throw new Error('MEMORY.md is not a plain file');
  if (next.split('\n').length - 1 > INDEX_LINES || Buffer.byteLength(next) > INDEX_BYTES) throw new Error('MEMORY.md would pass the 200 lines or 25 KB that load');
  writeAtomic(path, next);
}

const readIndex = (dir: string) => (plain(join(dir, 'MEMORY.md')) ? readFileSync(join(dir, 'MEMORY.md'), 'utf8') : '');
const readNote = (dir: string, file: string) => (plain(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : null);

/**
 * Apply the approved changes to the folder, in order. A change whose note moved on since it was proposed is skipped
 * ("changed since"); one that throws is "failed" and the rest go on. Returns the changes with outcomes and what each
 * applied change replaced, for Put back. `gone` is told each note file this removes (its saved copy goes too).
 */
export function applyChanges(dir: string, changes: Change[], approved: Set<number>, gone: (file: string) => void = () => {}): { changes: Change[]; backup: Saved[] } {
  const backup: Saved[] = [];
  const out = changes.map((c): Change => {
    if (c.action === 'flag') return { ...c, outcome: 'noted' };
    if (!approved.has(c.id)) return { ...c, outcome: 'turned down' };
    const now = readNote(dir, c.file);
    const index = readIndex(dir);
    const nowLine = lineFor(index, c.file);
    if (c.action === 'add' ? now !== null : now === null || hashText(now) !== hashText(c.was ?? '')) return { ...c, outcome: 'changed since' };
    // A line moved on too (someone added it to the index by hand): the line part would undo theirs.
    if (c.line !== null && c.action !== 'add' && nowLine !== c.wasLine) return { ...c, outcome: 'changed since' };
    try {
      if (c.action === 'delete') {
        deleteNote(dir, c.file);
        gone(c.file);
      } else {
        // The line first: a full MEMORY.md refuses the change before its note is touched.
        if (c.line !== null) writeIndex(dir, withLine(index, c.file, c.line));
        if (c.text !== null) writeAtomic(join(dir, c.file), c.text);
      }
      backup.push({ file: c.file, text: now, line: nowLine });
      return { ...c, outcome: 'applied' };
    } catch (err: any) {
      return { ...c, outcome: `failed: ${err.message}` };
    }
  });
  return { changes: out, backup };
}

/**
 * Put each saved note back as it was: its text (or no file, for a note the proposal added) and its MEMORY.md line.
 * A note that can't go back (MEMORY.md full, a file that isn't plain) is listed in `failed` with why, and the rest go on.
 */
export function restoreSaved(dir: string, saved: Saved[], gone: (file: string) => void = () => {}): { restored: number; failed: string[] } {
  let restored = 0;
  const failed: string[] = [];
  for (const s of saved) {
    const path = join(dir, s.file);
    try {
      if (existsSync(path) && !plain(path)) throw new Error('not a plain file');
      // The line first, as in applyChanges: a full MEMORY.md refuses before the note is touched.
      writeIndex(dir, withLine(readIndex(dir), s.file, s.text === null ? null : s.line));
      if (s.text === null) {
        if (existsSync(path)) {
          rmSync(path);
          gone(s.file);
        }
      } else writeAtomic(path, s.text);
      restored++;
    } catch (err: any) {
      failed.push(`${s.file} (${err.message})`);
    }
  }
  return { restored, failed };
}

/** The changes as the Memory page shows them: whether each note has moved on since, so a person sees it before approving. */
export function withDrift(dir: string, changes: Change[]): (Change & { drifted: boolean })[] {
  const index = readIndex(dir);
  return changes.map((c) => {
    const now = readNote(dir, c.file);
    const drifted = c.action === 'add' ? now !== null : now === null || hashText(now) !== hashText(c.was ?? '') || (c.line !== null && lineFor(index, c.file) !== c.wasLine);
    return { ...c, drifted };
  });
}

/** A short count of a proposal's changes by kind, for the card and the page: "3 edits, 11 index lines, 2 deletes, 8 flags". */
export function countLine(changes: Pick<Change, 'action'>[]): string {
  const names: Record<Action, [string, string]> = { edit: ['edit', 'edits'], add: ['new note', 'new notes'], delete: ['delete', 'deletes'], index: ['index line', 'index lines'], flag: ['flag', 'flags'] };
  return ACTIONS.map((a) => [a, changes.filter((c) => c.action === a).length] as const)
    .filter(([, n]) => n)
    .map(([a, n]) => `${n} ${names[a][n === 1 ? 0 : 1]}`)
    .join(', ');
}

export const MEMORY_PROPOSALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_proposals (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id INTEGER,
  folder TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  changes TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  decided_by TEXT,
  decided_at INTEGER,
  backup TEXT,
  restored_by TEXT,
  restored_at INTEGER
);
CREATE INDEX IF NOT EXISTS memory_proposals_project ON memory_proposals(project_id, status);
`;

type Row = Omit<Proposal, 'changes' | 'backup'> & { changes: string; backup: string | null };
const parse = (r: Row | undefined): Proposal | null => (r ? { ...r, changes: JSON.parse(r.changes), backup: r.backup ? JSON.parse(r.backup) : null } : null);

/** The proposals table. The schema is in src/db.ts's SCHEMA, so a new database makes it in its one setup commit. */
export class MemoryProposals {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  get(id: number): Proposal | null {
    return parse(this.db.prepare('SELECT * FROM memory_proposals WHERE id = ?').get(id) as Row | undefined);
  }

  /** The scheme's open proposal, if any (a new one supersedes the old). */
  open(projectId: number): Proposal | null {
    return parse(this.db.prepare("SELECT * FROM memory_proposals WHERE project_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(projectId) as Row | undefined);
  }

  /** The newest proposal a run made, whatever became of it (#1803: its apply_memory applies only this one). */
  latestOf(ticketId: number): Proposal | null {
    return parse(this.db.prepare('SELECT * FROM memory_proposals WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(ticketId) as Row | undefined);
  }

  /** Decided proposals whose old notes are still kept, newest first. */
  kept(projectId: number): Proposal[] {
    return (this.db.prepare('SELECT * FROM memory_proposals WHERE project_id = ? AND backup IS NOT NULL ORDER BY decided_at DESC').all(projectId) as Row[]).map((r) => parse(r)!);
  }

  /** A new open proposal; the scheme's earlier open ones become superseded, and are returned so their cards can say so. */
  create(p: Pick<Proposal, 'project_id' | 'ticket_id' | 'folder' | 'changes'>, now = Date.now()): { proposal: Proposal; superseded: Proposal[] } {
    const superseded = (this.db.prepare("SELECT * FROM memory_proposals WHERE project_id = ? AND status = 'open'").all(p.project_id) as Row[]).map((r) => parse(r)!);
    this.db.prepare("UPDATE memory_proposals SET status = 'superseded', decided_at = ? WHERE project_id = ? AND status = 'open'").run(now, p.project_id);
    const r = this.db.prepare('INSERT INTO memory_proposals (project_id, ticket_id, folder, changes, created_at) VALUES (?, ?, ?, ?, ?)').run(p.project_id, p.ticket_id, p.folder, JSON.stringify(p.changes), now);
    return { proposal: this.get(Number(r.lastInsertRowid))!, superseded };
  }

  /** Record the decision: applied (with the old notes) or dismissed. Only an open proposal can be decided; false otherwise. */
  decide(id: number, d: { status: 'applied' | 'dismissed'; changes: Change[]; backup: Saved[]; by: string }, now = Date.now()): boolean {
    const r = this.db.prepare("UPDATE memory_proposals SET status = ?, changes = ?, backup = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'open'").run(d.status, JSON.stringify(d.changes), d.backup.length ? JSON.stringify(d.backup) : null, d.by, now, id);
    return Number(r.changes) === 1;
  }

  /** The old notes were put back: they are dropped, so Put back can't run twice. */
  restored(id: number, by: string, now = Date.now()) {
    this.db.prepare('UPDATE memory_proposals SET backup = NULL, restored_by = ?, restored_at = ? WHERE id = ?').run(by, now, id);
  }

  /** Drop old notes kept past KEEP_MS. Returns how many proposals lost theirs. */
  prune(now = Date.now()): number {
    return Number(this.db.prepare('UPDATE memory_proposals SET backup = NULL WHERE backup IS NOT NULL AND decided_at < ?').run(now - KEEP_MS).changes);
  }
}

/** The folder a tidy works on: the scheme's reachable memory folder with the most notes (one per scheme in practice). */
export function curatorTarget(repoDir: string | null, logins: MemoryLogin[]): { folder: MemoryFolder; notes: number } | null {
  return (
    memoryFolders(repoDir, logins)
      .map((folder) => ({ folder, view: readFolder(folder, () => false) }))
      .filter((f) => f.view.reachable)
      .sort((a, b) => b.view.notes.length - a.view.notes.length)
      .map(({ folder, view }) => ({ folder, notes: view.notes.length }))[0] ?? null
  );
}
