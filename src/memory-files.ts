// A scheme's Claude Code memory notes (the Orders → Memory page): a MEMORY.md index plus one file per fact, under a
// Claude login's config dir at projects/<slugged repo path>/memory/. Every later session loads them, so a person can
// read, edit and delete them here. Not src/memory.ts, which is search by meaning over chats.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { projectSlug } from './sessions.ts';
import { pacificDay } from './pacific.ts';

/** One login's memory folder for a scheme. `label` names the login, never an email. */
export interface MemoryFolder {
  label: string;
  dir: string /** Stable across logins coming and going: what a write names. */;
  id: string /** The folder under a config dir, which is how claude_state rows name its files. */;
  rel: string;
}
/** A login as the caller knows it: a label and its Claude config dir. */
export interface MemoryLogin {
  label: string;
  configDir: string;
}

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
    // One folder on disk is one entry, whatever path reaches it (account 2's projects can be a symlink to account 1's, 2ME9).
    // Only the dedupe key follows the link: the id and the path stay as they were.
    let key = dir;
    try {
      key = realpathSync(dir);
    } catch {
      /* no folder yet: its path is its key */
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: l.label, dir, id: createHash('sha1').update(dir).digest('hex').slice(0, 12), rel: join('projects', projectSlug(repoDir), 'memory') });
  }
  return out;
}

export interface MemoryNote {
  file: string;
  name: string;
  description: string;
  type: string;
  text: string;
  bytes: number;
  modified: number;
  /** Whether MEMORY.md links it: only the index loads at a start, so a note it leaves out is never found. */
  inIndex: boolean;
  /** Why it may be stale: `closed` minion numbers it names, and dates that have passed or are close. */
  flags: { closed: number[]; datesPast: string[]; datesSoon: string[] };
}

const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
/** A note's file name, or null when it isn't one a folder here can hold (path tricks, the index itself). */
export const noteFile = (name: unknown): string | null => (typeof name === 'string' && FILE.test(name) && name !== 'MEMORY.md' ? name : null);

/** The frontmatter fields we show (name, description, metadata.type) from a note's text. */
export function frontmatter(text: string): { name: string; description: string; type: string } {
  const head = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
  const get = (k: string) =>
    new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm')
      .exec(head)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? '';
  return { name: get('name'), description: get('description'), type: get('type') };
}

/** A plain file, never a symlink: a note that links elsewhere would show or overwrite a file outside the memory folder. */
export const plain = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

const DAY = 86_400_000;
/** Minions a note names (#N) and dates that passed or fall in the next 3 days (Pacific), when written after a "recheck/after/until/before/due" word. */
export function staleFlags(text: string, isClosed: (n: number) => boolean, now = Date.now()): MemoryNote['flags'] {
  const today = pacificDay(now);
  const soon = pacificDay(now + 3 * DAY);
  const closed = [...new Set([...text.matchAll(/(?<![\w&])#(\d{1,6})\b/g)].map((m) => Number(m[1])))].filter(isClosed).sort((a, b) => a - b);
  const datesPast: string[] = [];
  const datesSoon: string[] = [];
  for (const m of text.matchAll(/\b(?:re-?check|after|until|before|expires?|due)\b[^\n\d]{0,25}(\d{4}-\d{2}-\d{2})\b/gi)) {
    const list = m[1] < today ? datesPast : m[1] <= soon ? datesSoon : null;
    if (list && !list.includes(m[1])) list.push(m[1]);
  }
  return { closed, datesPast, datesSoon };
}

export interface FolderView {
  id?: string;
  label: string;
  reachable: boolean;
  bytes: number;
  notes: MemoryNote[];
  index: string;
}

/** A folder's notes, in the index's order first, then the rest by newest. An unreadable or missing folder is "not reachable". */
export function readFolder(f: MemoryFolder, isClosed: (n: number) => boolean, now = Date.now()): FolderView {
  if (!existsSync(f.dir)) return { label: f.label, reachable: false, bytes: 0, notes: [], index: '' };
  let names: string[];
  try {
    names = readdirSync(f.dir);
  } catch {
    return { label: f.label, reachable: false, bytes: 0, notes: [], index: '' };
  }
  let index = '';
  try {
    if (plain(join(f.dir, 'MEMORY.md'))) index = readFileSync(join(f.dir, 'MEMORY.md'), 'utf8');
  } catch {
    /* an unreadable index doesn't hide the notes */
  }
  const notes: MemoryNote[] = [];
  for (const file of names) {
    if (!noteFile(file)) continue;
    const path = join(f.dir, file);
    let st;
    let text;
    try {
      if (!plain(path)) continue;
      st = lstatSync(path);
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    const fm = frontmatter(text);
    notes.push({ file, name: fm.name || file.replace(/\.md$/, ''), description: fm.description, type: fm.type, text, bytes: st.size, modified: st.mtimeMs, inIndex: false, flags: staleFlags(text, isClosed, now) });
  }
  // Listed: MEMORY.md links it, as `](file)` or `[[name]]`, or links a note that does (a topic index): what a session can reach.
  const links = (text: string, n: MemoryNote) => text.includes(`](${n.file})`) || text.includes(`[[${n.name}]]`) || text.includes(`[[${n.file.replace(/\.md$/, '')}]]`);
  for (const n of notes) n.inIndex = links(index, n);
  const hubs = notes.filter((n) => n.inIndex);
  for (const n of notes) if (!n.inIndex) n.inIndex = hubs.some((h) => links(h.text, n));
  const at = (n: MemoryNote) => {
    const i = index.indexOf(`](${n.file})`);
    return i < 0 ? Infinity : i;
  };
  notes.sort((a, b) => at(a) - at(b) || b.modified - a.modified);
  return { id: f.id, label: f.label, reachable: true, bytes: notes.reduce((s, n) => s + n.bytes, 0), notes, index };
}

/** Write a whole file in one step (a new temp file made exclusively, then a rename), so a session reading it never sees half. */
export function writeAtomic(path: string, text: string) {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    closeSync(fd);
    renameSync(tmp, path);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Replace one note's text (it must exist: this edits, never adds). */
export function saveNote(dir: string, file: string, text: string, was?: string) {
  if (!plain(join(dir, file))) throw new Error('No such note');
  // `was` is the text the page showed: a note written since (a session's update) isn't overwritten unseen (2ME4). Without it, the save is unchecked.
  if (was !== undefined && readFileSync(join(dir, file), 'utf8') !== was) throw Object.assign(new Error('This note changed since you opened it (a session may have updated it). Reload the page to see the new text, then make your edit again.'), { status: 409 });
  writeAtomic(join(dir, file), text);
}

/** Add a note's line to MEMORY.md (made if missing), as `- [name](file) — description`. False when the index already links it. */
export function indexNote(dir: string, file: string): boolean {
  const path = join(dir, file);
  if (!plain(path)) throw new Error('No such note');
  const indexPath = join(dir, 'MEMORY.md');
  if (existsSync(indexPath) && !plain(indexPath)) throw new Error('MEMORY.md is not a plain file');
  const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : '';
  if (index.includes(`](${file})`)) return false;
  const fm = frontmatter(readFileSync(path, 'utf8'));
  const name = (fm.name || file.replace(/\.md$/, '')).replace(/[[\]\n]/g, ' ');
  const line = `- [${name}](${file})${fm.description ? ` — ${fm.description.replace(/\n/g, ' ')}` : ''}`;
  const next = `${index}${index && !index.endsWith('\n') ? '\n' : ''}${line}\n`;
  // Claude Code loads only MEMORY.md's first 200 lines / 25 KB; a line past that would look listed but never load.
  if (next.split('\n').length - 1 > 200 || Buffer.byteLength(next) > 25 * 1024) throw Object.assign(new Error('MEMORY.md is full: tidy it before adding more'), { status: 409 });
  writeAtomic(indexPath, next);
  return true;
}

/** Delete a note and its MEMORY.md line(s): the file first, then the index rewritten without the lines that link it (a stray index line is a smaller harm than a note the index forgot). */
/** An index line without `file`'s link: null when that was its only link (the line goes), else the line with just that link's text left in place (ME3). */
export function withoutLink(line: string, file: string): string | null {
  const others = [...line.matchAll(/\]\(([^)\s]+\.md)\)/g)].some((m) => m[1] !== file);
  if (!others) return null;
  return line
    .split(`](${file})`)
    .map((part, i, all) => (i < all.length - 1 ? part.replace(/\[([^\]]*)$/, '$1') : part))
    .join('');
}

export function deleteNote(dir: string, file: string): number {
  const path = join(dir, file);
  if (!plain(path)) throw new Error('No such note');
  rmSync(path);
  const indexPath = join(dir, 'MEMORY.md');
  if (!plain(indexPath)) return 0;
  let removed = 0;
  const kept = readFileSync(indexPath, 'utf8')
    .split('\n')
    .flatMap((l) => {
      if (!l.includes(`](${file})`)) return [l];
      removed++;
      const left = withoutLink(l, file);
      return left === null ? [] : [left];
    });
  writeAtomic(indexPath, kept.join('\n'));
  return removed;
}
