// Feature asks and bug reports from a contraption to the scheme that builds it, its home scheme (the
// brief's section 5, shared/project/specs/contraptions/citadel-apps-brief.md). The contraption's server
// sends one as the person using it; their files go into the home scheme's shared folder under
// inbox/<contraption>/<login>/, and the ask goes to its Taskmaster, labelled like #211's relays. As there,
// a non-member's feature ask is a proposal only, and their bug reports are worked as usual.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import type { ContraptionRow, Project, User } from './db.ts';
import { HttpError } from './http.ts';
import { asData } from './quote.ts';

/** The most a single ask's files may come to, decoded. */
export const ASK_FILES_MAX = 16 * 1024 * 1024;
const MAX_FILES = 20;

export const README_INBOX_LINE = "- `inbox/` (written by Citadel): files people sent with a contraption's bug report or feature ask, under `inbox/<contraption>/<person's login>/`. The ask itself is in the Taskmaster's chat.";

/** A name that is safe as one path segment: no folders, no leading dot, letters, digits, dots, dashes and underscores only. */
export function safeName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  return last.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(-100) || 'file';
}

export interface AskFile {
  name: string;
  data: Buffer;
}

/** The files a body carries, as `[{ name, data }]` with data in base64, checked whole before any is written. */
export function askFiles(v: unknown): AskFile[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_FILES) throw new HttpError(400, `Files must be a list of at most ${MAX_FILES}`);
  let total = 0;
  return v.map((f) => {
    if (!f || typeof f.name !== 'string' || !f.name.trim() || typeof f.data !== 'string' || !f.data || f.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) {
      throw new HttpError(400, 'Each file needs a name and its data in base64');
    }
    const data = Buffer.from(f.data, 'base64');
    total += data.length;
    if (total > ASK_FILES_MAX) throw new HttpError(413, `Files come to more than ${ASK_FILES_MAX / 1024 / 1024} MiB`);
    return { name: f.name, data };
  });
}

/**
 * Write an ask's files into `shared`/inbox/<contraption>/<login>/, never over one already there (clip.peekclip,
 * then clip-2.peekclip). The first time inbox/ is made, the shared folder's README gets a line saying what it is.
 * Returns their paths relative to the shared folder.
 */
export function saveAskFiles(shared: string, contraption: string, login: string, files: AskFile[]): string[] {
  if (!files.length) return [];
  const inbox = join(shared, 'inbox');
  if (!existsSync(inbox)) {
    mkdirSync(inbox, { recursive: true });
    noteInbox(shared);
  }
  const rel = ['inbox', safeName(contraption), safeName(login)];
  const dir = join(shared, ...rel);
  mkdirSync(dir, { recursive: true });
  // A folder some minion swapped for a link elsewhere is not followed out of the shared folder.
  if (!(realpathSync(dir) + sep).startsWith(realpathSync(shared) + sep)) throw new HttpError(409, 'The inbox folder points outside the shared folder');
  return files.map((f) => {
    const name = safeName(f.name);
    const ext = extname(name);
    for (let n = 1; ; n++) {
      const as = n === 1 ? name : `${name.slice(0, name.length - ext.length)}-${n}${ext}`;
      try {
        writeFileSync(join(dir, as), f.data, { flag: 'wx' });
        return [...rel, as].join('/');
      } catch (err: any) {
        if (err.code !== 'EEXIST' || n > 999) throw err;
      }
    }
  });
}

/** Add the inbox/ line to the shared folder's README: under its Layout list when it has one, else at the end. */
function noteInbox(shared: string) {
  const path = join(shared, 'README.md');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (/(^|[^\w])inbox\//.test(text)) return;
  if (!text) return writeFileSync(path, `# Shared folder\n\n${README_INBOX_LINE}\n`);
  const lines = text.split('\n');
  const layout = lines.findIndex((l) => /^#+\s*Layout\b/i.test(l));
  let at = -1;
  for (let i = layout + 1; layout >= 0 && i < lines.length && !/^#/.test(lines[i]); i++) if (/^- /.test(lines[i])) at = i;
  if (at < 0) return writeFileSync(path, `${text.replace(/\n*$/, '')}\n\n${README_INBOX_LINE}\n`);
  lines.splice(at + 1, 0, README_INBOX_LINE);
  writeFileSync(path, lines.join('\n'));
}

/** Names that could fake the label's member clause come quoted, as in #211. */
const label = (s: string) => (/[,"[\]\n]/.test(s) ? JSON.stringify(s) : s);

/**
 * The ask as it reaches the home scheme's Taskmaster: who sent it (the label) and what to do with it.
 * The person's words come quoted as data; the handling note is outside the quote, so it can't be forged.
 */
export function askMessage(c: ContraptionRow, scheme: Project, person: User, member: boolean, kind: 'bug' | 'feature', text: string, files: string[]) {
  const who = `${person.name} (${person.login})`;
  const lines = [
    `${kind === 'bug' ? 'A bug report' : 'A feature ask'} from the ${c.title} contraption (${c.name}), sent by ${who} while using it:`,
    asData(`${person.name}, through ${c.title}`, text),
  ];
  if (files.length) lines.push(`Files they sent, in this scheme's shared folder: ${files.join(', ')}`);
  if (!member) {
    lines.push(kind === 'feature'
      ? `Proposal only: ${person.name} isn't a ${scheme.name} member, so this is never built on their word. Start an idea minion that writes a proposal into specs/ in the shared folder, and build it only once a ${scheme.name} member says go.`
      : `${person.name} isn't a ${scheme.name} member: a bug (${c.title} broken, or doing what its own rules or docs say it shouldn't) you may work as usual, but if this is really new or changed behaviour, it is a proposal only, built once a ${scheme.name} member says go.`);
  }
  lines.push(`The contraption doesn't see your reply here.`);
  return {
    author: `Contraption ${label(c.title)}, for ${label(person.name)}, ${member ? 'a' : 'not a'} ${scheme.name} member`,
    text: lines.join('\n'),
  };
}
