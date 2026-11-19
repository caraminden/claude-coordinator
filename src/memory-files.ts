// A scheme's Claude Code memory notes (the Scheme → Memory page): a MEMORY.md index plus one file per fact, under a
// Claude login's config dir at projects/<slugged repo path>/memory/. Every later session loads them, so a person can
// read, edit and delete them here. Not src/memory.ts, which is search by meaning over chats.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectSlug } from './sessions.ts';

/** One login's memory folder for a scheme. `label` names the login, never an email. */
export interface MemoryFolder { label: string; dir: string }
/** A login as the caller knows it: a label and its Claude config dir. */
export interface MemoryLogin { label: string; configDir: string }

/** The memory folder inside one config dir, for a repo path. */
export const memoryDir = (configDir: string, repoDir: string): string => join(configDir, 'projects', projectSlug(repoDir), 'memory');

/**
 * Every login's memory folder for a scheme: the one mapping (the decisions page reuses it). Logins that share a
 * config dir (a container's accounts mount the server's copy, claude-link.ts) give one folder, labelled by the first.
 * Only projects/<slug>/memory/ is ever named: nothing else in a config dir (credentials) is reachable from here.
 */
export function memoryFolders(repoDir: string | null, logins: MemoryLogin[]): MemoryFolder[] {
  if (!repoDir) return [];
  const seen = new Set<string>();
  const out: MemoryFolder[] = [];
  for (const l of logins) {
    const dir = memoryDir(l.configDir, repoDir);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push({ label: l.label, dir });
  }
  return out;
}

export interface MemoryNote {
  file: string; name: string; description: string; type: string; text: string; bytes: number; modified: number;
  /** Why it may be stale: `closed` minion numbers it names, and dates that have passed or are close. */
  flags: { closed: number[]; datesPast: string[]; datesSoon: string[] };
}

const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
/** A note's file name, or null when it isn't one a folder here can hold (path tricks, the index itself). */
export const noteFile = (name: unknown): string | null => (typeof name === 'string' && FILE.test(name) && name !== 'MEMORY.md' ? name : null);

/** The frontmatter fields we show (name, description, metadata.type) from a note's text. */
export function frontmatter(text: string): { name: string; description: string; type: string } {
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const get = (k: string) => new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm').exec(head)?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
  return { name: get('name'), description: get('description'), type: get('type') };
}

const DAY = 86_400_000;
/** Minions a note names (#N) and dates that passed or fall in the next 3 days, when written after a "recheck/after/until/by" word. */
export function staleFlags(text: string, isClosed: (n: number) => boolean, now = Date.now()): MemoryNote['flags'] {
  const closed = [...new Set([...text.matchAll(/(?<![\w&])#(\d{1,6})\b/g)].map((m) => Number(m[1])))].filter(isClosed).sort((a, b) => a - b);
  const datesPast: string[] = [];
  const datesSoon: string[] = [];
  for (const m of text.matchAll(/\b(?:re-?check|after|until|by|before|expires?|due|owed|on)\b[^\n\d]{0,25}(\d{4}-\d{2}-\d{2})\b/gi)) {
    const t = Date.parse(`${m[1]}T23:59:59-08:00`);
    if (Number.isNaN(t)) continue;
    const list = t < now ? datesPast : t < now + 3 * DAY ? datesSoon : null;
    if (list && !list.includes(m[1])) list.push(m[1]);
  }
  return { closed, datesPast, datesSoon };
}

export interface FolderView { label: string; reachable: boolean; bytes: number; notes: MemoryNote[]; index: string }

/** A folder's notes, in the index's order first, then the rest by newest. An unreadable or missing folder is "not reachable". */
export function readFolder(f: MemoryFolder, isClosed: (n: number) => boolean, now = Date.now()): FolderView {
  if (!existsSync(f.dir)) return { label: f.label, reachable: false, bytes: 0, notes: [], index: '' };
  let names: string[];
  try { names = readdirSync(f.dir); } catch { return { label: f.label, reachable: false, bytes: 0, notes: [], index: '' }; }
  const index = existsSync(join(f.dir, 'MEMORY.md')) ? readFileSync(join(f.dir, 'MEMORY.md'), 'utf8') : '';
  const notes: MemoryNote[] = [];
  for (const file of names) {
    if (!noteFile(file)) continue;
    const path = join(f.dir, file);
    let st; let text;
    try { st = statSync(path); if (!st.isFile()) continue; text = readFileSync(path, 'utf8'); } catch { continue; }
    const fm = frontmatter(text);
    notes.push({ file, name: fm.name || file.replace(/\.md$/, ''), description: fm.description, type: fm.type, text, bytes: st.size, modified: st.mtimeMs, flags: staleFlags(text, isClosed, now) });
  }
  const at = (n: MemoryNote) => { const i = index.indexOf(`](${n.file})`); return i < 0 ? Infinity : i; };
  notes.sort((a, b) => at(a) - at(b) || b.modified - a.modified);
  return { label: f.label, reachable: true, bytes: notes.reduce((s, n) => s + n.bytes, 0), notes, index };
}

/** Write a whole file in one step (a temp file then a rename), so a session reading it never sees half. */
function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Replace one note's text (it must exist: this edits, never adds). */
export function saveNote(dir: string, file: string, text: string) {
  if (!existsSync(join(dir, file))) throw new Error('No such note');
  writeAtomic(join(dir, file), text);
}

/** Delete a note and its MEMORY.md line(s) together: the file first, then the index rewritten without the lines that link it. */
export function deleteNote(dir: string, file: string): number {
  const path = join(dir, file);
  if (!existsSync(path)) throw new Error('No such note');
  const indexPath = join(dir, 'MEMORY.md');
  let removed = 0;
  if (existsSync(indexPath)) {
    const kept = readFileSync(indexPath, 'utf8').split('\n').filter((l) => {
      const gone = l.includes(`](${file})`);
      if (gone) removed++;
      return !gone;
    });
    writeAtomic(indexPath, kept.join('\n'));
  }
  rmSync(path);
  return removed;
}

/** Make sure a folder exists before a first write (a scheme whose Taskmaster hasn't written yet has none). */
export const ensureFolder = (dir: string) => mkdirSync(dir, { recursive: true });
