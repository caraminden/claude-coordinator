// Feature asks and bug reports from a contraption to the scheme that builds it, its home scheme (the
// brief's section 5, shared/project/specs/contraptions/citadel-apps-brief.md). The contraption's server
// sends one as the person using it; their files go into the home scheme's shared folder under
// inbox/<contraption>/<login>/, and the ask goes to its Taskmaster, labelled like #211's relays. As there,
// a non-member's feature ask is a proposal only, and their bug reports are worked as usual. A data ask (#318)
// only files: its files plus a `<time>-ask.json` sidecar with its item, summary and text, waking no one.
import { randomBytes } from 'node:crypto';
import { constants, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import type { ContraptionRow, Project, User } from './db.ts';
import { HttpError } from './http.ts';
import { asData } from './quote.ts';
import { MAX_UPLOAD_BYTES, saveUpload } from './uploads.ts';

/** The most a single ask's files may come to, decoded. */
export const ASK_FILES_MAX = 16 * 1024 * 1024;
const MAX_FILES = 20;

export const README_INBOX_LINE = "- `inbox/` (written by Citadel): files people sent with a contraption's bug report, feature ask or data, under `inbox/<contraption>/<person's login>/`. A bug or feature ask itself is in the Taskmaster's chat; a data ask's words are in the `<time>-ask.json` beside its files.";

/** A name that is safe as one path segment: no folders, no leading dot, letters, digits, dots, dashes and underscores only. */
export function safeName(name: string): string {
  const last = name.split(/[\\/]/).pop() ?? '';
  return (
    last
      .replace(/[^\w.-]+/g, '-')
      .slice(-100)
      .replace(/^[.-]+/, '') || 'file'
  );
}

/** A file to file with an ask: its bytes, or (#1841) an upload staged on disk, moved in rather than read. */
export type AskFile = { name: string; data: Buffer } | { name: string; path: string };

/**
 * The files a body carries, checked whole before any is written: `{ name, data }` with data in base64 (16 MiB
 * in all), or `{ upload, name? }` naming a file sent first to POST /api/contraptions/asks/files, which `upload`
 * finds (the caller's own uploads only).
 */
export async function askFiles(v: unknown, upload: (id: string) => Promise<{ name: string; path: string }> = noUpload): Promise<AskFile[]> {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MAX_FILES) throw new HttpError(400, `Files must be a list of at most ${MAX_FILES}`);
  let total = 0;
  const ids = new Set<string>();
  const files = v.map((f): AskFile | { name?: string; upload: string } => {
    if (f && f.upload !== undefined) {
      if (typeof f.upload !== 'string' || !UPLOAD_ID.test(f.upload) || (f.name !== undefined && (typeof f.name !== 'string' || !f.name.trim()))) {
        throw new HttpError(400, 'An uploaded file is { upload, name? }: the id POST /api/contraptions/asks/files answered');
      }
      if (ids.has(f.upload)) throw new HttpError(400, `Upload ${f.upload} is named twice`);
      ids.add(f.upload);
      return { name: f.name, upload: f.upload };
    }
    if (!f || typeof f.name !== 'string' || !f.name.trim() || typeof f.data !== 'string' || !f.data || f.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.data)) {
      throw new HttpError(400, 'Each file needs a name and its data in base64');
    }
    const data = Buffer.from(f.data, 'base64');
    total += data.length;
    if (total > ASK_FILES_MAX) throw new HttpError(413, `Files come to more than ${ASK_FILES_MAX / 1024 / 1024} MiB`);
    return { name: f.name, data };
  });
  // Each checked first, so a bad entry anywhere refuses the ask before any upload is looked for.
  const out: AskFile[] = [];
  for (const f of files) {
    if (!('upload' in f)) out.push(f);
    else {
      const up = await upload(f.upload);
      out.push({ name: f.name ?? up.name, path: up.path });
    }
  }
  return out;
}

const noUpload = async (id: string): Promise<never> => {
  throw new HttpError(404, `No upload ${id}`);
};

// Big files (#1841): a contraption streams each one to POST /api/contraptions/asks/files first, so a 100 MB screen
// recording is never a base64 string in a JSON body held whole in memory, then names it in the ask's files. It is
// staged at <dataDir>/ask-uploads/<contraption>/<person id>/<upload id>/<name> until an ask moves it into the inbox.

/** The most one uploaded file may be: the composer's limit. */
export const ASK_UPLOAD_MAX = MAX_UPLOAD_BYTES;
/** The most a person may have uploaded through one contraption and not yet sent with an ask. */
export const ASK_UPLOAD_PENDING_MAX = 1024 * 1024 * 1024;
/** An upload no ask has taken is deleted after this. */
export const ASK_UPLOAD_TTL_MS = 24 * 60 * 60_000;
const UPLOAD_ID = /^[0-9a-f]{24}$/;

export const askUploadsDir = (dataDir: string) => join(dataDir, 'ask-uploads');

/** Where one person's uploads through one contraption are staged. */
const uploadsOf = (dir: string, contraption: string, person: number) => join(dir, safeName(contraption), String(person));

/** One staged upload's file (each id folder holds one), or null when it's gone. */
async function stagedFile(folder: string): Promise<{ name: string; path: string; size: number; at: number } | null> {
  try {
    const [name] = await readdir(folder);
    if (!name) return null;
    const st = await stat(join(folder, name));
    return { name, path: join(folder, name), size: st.size, at: st.mtimeMs };
  } catch {
    return null;
  }
}

/** A folder's entries; none when it's gone (another request may take or sweep one meanwhile). */
const ls = (dir: string) => readdir(dir).catch(() => [] as string[]);

/** Bytes a person has staged through a contraption and not yet sent. */
export async function pendingUploadBytes(dir: string, contraption: string, person: number): Promise<number> {
  const mine = uploadsOf(dir, contraption, person);
  let sum = 0;
  for (const id of await ls(mine)) sum += (await stagedFile(join(mine, id)))?.size ?? 0;
  return sum;
}

/**
 * Stream `body` into a new upload for `person` through `contraption`, at most `max` bytes (413 past it, the partial
 * file removed). Returns its id, which only that contraption and person can name in an ask.
 */
export async function stageAskUpload(dir: string, contraption: string, person: number, rawName: string, body: AsyncIterable<Buffer>, max = ASK_UPLOAD_MAX) {
  const id = randomBytes(12).toString('hex');
  const folder = join(uploadsOf(dir, contraption, person), id);
  try {
    const saved = await saveUpload(folder, rawName, body, max);
    return { upload: id, name: saved.name, size: saved.size };
  } catch (err) {
    await rm(folder, { recursive: true, force: true });
    throw err;
  }
}

/** The staged upload `id` of this contraption and person: 404 when it's another's, used or expired. */
export async function findAskUpload(dir: string, contraption: string, person: number, id: string) {
  const up = UPLOAD_ID.test(id) ? await stagedFile(join(uploadsOf(dir, contraption, person), id)) : null;
  if (!up) throw new HttpError(404, `No upload ${id}: an upload is used by one ask, and kept ${ASK_UPLOAD_TTL_MS / 3_600_000} hours`);
  return up;
}

/**
 * Delete uploads no ask took within ASK_UPLOAD_TTL_MS. shortcut: run on each upload and ask, not on a timer, so a
 * stray waits for the next one; the pending cap bounds it. A timer if that ever matters.
 */
export async function sweepAskUploads(dir: string, now = Date.now()) {
  for (const c of await ls(dir))
    for (const p of await ls(join(dir, c)))
      for (const id of await ls(join(dir, c, p))) {
        const folder = join(dir, c, p, id);
        // An empty folder is an upload still claiming its name: an old one goes too.
        const at = (await stagedFile(folder))?.at ?? (await stat(folder).then((st) => st.mtimeMs, () => now));
        if (now - at > ASK_UPLOAD_TTL_MS) await rm(folder, { recursive: true, force: true });
      }
}

/**
 * Write an ask's files into `shared`/inbox/<contraption>/<login>/, never over one already there (clip.peekclip,
 * then clip-2.peekclip); an upload is moved in. The first time inbox/ is made, the shared folder's README gets a
 * line saying what it is. Returns their paths relative to the shared folder.
 */
export async function saveAskFiles(shared: string, contraption: string, login: string, files: AskFile[]): Promise<string[]> {
  if (!files.length) return [];
  const inbox = join(shared, 'inbox');
  if (!existsSync(inbox)) {
    await mkdir(inbox, { recursive: true });
    noteInbox(shared);
  }
  const rel = ['inbox', safeName(contraption), safeName(login)];
  const dir = join(shared, ...rel);
  await mkdir(dir, { recursive: true });
  // A folder some minion swapped for a link elsewhere is not followed out of the shared folder.
  if (!((await realpath(dir)) + sep).startsWith((await realpath(shared)) + sep)) throw new HttpError(409, 'The inbox folder points outside the shared folder');
  const paths: string[] = [];
  for (const f of files) {
    const name = safeName(f.name);
    const ext = extname(name);
    for (let n = 1; ; n++) {
      const as = n === 1 ? name : `${name.slice(0, name.length - ext.length)}-${n}${ext}`;
      try {
        if ('data' in f) await writeFile(join(dir, as), f.data, { flag: 'wx' });
        else await moveIn(f.path, join(dir, as));
        paths.push([...rel, as].join('/'));
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 999) throw err;
      }
    }
  }
  return paths;
}

/** Move a staged upload to `to`, never over a file there (EEXIST), then drop its upload folder: one ask uses it. */
async function moveIn(from: string, to: string) {
  try {
    await link(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new HttpError(409, 'An upload was used by another ask meanwhile');
    if (code !== 'EXDEV') throw err;
    await copyFile(from, to, constants.COPYFILE_EXCL); // a data dir split over two filesystems
  }
  try {
    await unlink(from);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // Another ask linked it too and took it first: that one files it, this one leaves no copy.
    await rm(to, { force: true });
    throw new HttpError(409, 'An upload was used by another ask meanwhile');
  }
  await rm(join(from, '..'), { recursive: true, force: true });
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

/** The most an ask's summary may be, and its item (the aura or thing it's about). */
export const ASK_SUMMARY_MAX = 200;
export const ASK_ITEM_MAX = 100;

/** An optional one-line field: whitespace runs collapsed to one space, null when missing or blank. */
export function askLine(v: unknown, field: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`);
  const line = v.replace(/\s+/g, ' ').trim();
  if (line.length > max) throw new HttpError(400, `${field} is at most ${max} characters`);
  return line || null;
}

/** The summary Citadel makes when the contraption sends none: the text's first sentence, cut to ASK_SUMMARY_MAX. */
export function askSummary(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const first = flat.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? flat;
  return first.length <= ASK_SUMMARY_MAX ? first : `${first.slice(0, ASK_SUMMARY_MAX - 1).replace(/\s+\S*$/, '')}…`;
}

/** Names that could fake the label's member clause come quoted, as in #211. */
const label = (s: string) => (/[,"[\]\n]/.test(s) ? JSON.stringify(s) : s);

/**
 * The ask as it reaches the home scheme's Taskmaster: who sent it (the label) and what to do with it.
 * The person's words come quoted as data; the handling note is outside the quote, so it can't be forged.
 */
export function askMessage(c: ContraptionRow, scheme: Project, person: User, member: boolean, kind: 'bug' | 'feature', text: string, files: string[], item: string | null = null) {
  const who = `${person.name} (${person.login})`;
  // The item is the contraption's word (an aura's name, say), quoted so it can't pass for the label.
  const about = item ? ` about ${JSON.stringify(item)}` : '';
  const lines = [`${kind === 'bug' ? 'A bug report' : 'A feature ask'}${about} from the ${c.title} contraption (${c.name}), sent by ${who} while using it:`, asData(`${person.name}, through ${c.title}`, text)];
  if (files.length) lines.push(`Files they sent, in this scheme's shared folder: ${files.join(', ')}`);
  if (!member) {
    lines.push(
      kind === 'feature'
        ? `Proposal only: ${person.name} isn't a ${scheme.name} member, so this is never built on their word. Start an idea minion that writes a proposal into specs/ in the shared folder, and build it only once a ${scheme.name} member says go.`
        : `${person.name} isn't a ${scheme.name} member: a bug (${c.title} broken, or doing what its own rules or docs say it shouldn't) you may work as usual, but if this is really new or changed behaviour, it is a proposal only, built once a ${scheme.name} member says go.`,
    );
  }
  lines.push(`The contraption doesn't see your reply here.`);
  return {
    author: `Contraption ${label(c.title)}, for ${label(person.name)}, ${member ? 'a' : 'not a'} ${scheme.name} member`,
    text: lines.join('\n'),
  };
}
