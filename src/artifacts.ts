// Artifacts: documents and pages that tickets create in their working directories.
import { execFile } from 'node:child_process';
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type FileKind = 'markdown' | 'text' | 'canvas' | 'html' | 'pdf' | 'image' | 'video' | 'audio' | 'download';

/**
 * File types the app will serve from a ticket's folder. Only documents, pages and downloads
 * (`artifact`) are listed as artifacts; images and media are served when a document embeds them.
 * Downloads (archives such as a game build, and Android apps) are never shown, only saved.
 * Other source code is left out on purpose; it lives in the branch. Scripts, styles and data show
 * as text, as a document may link them (old claude.ai page code), and an HTML page loads them.
 */
export const FILE_TYPES: Record<string, { kind: FileKind; mime: string; artifact?: true }> = {
  '.md': { kind: 'markdown', mime: 'text/plain; charset=utf-8', artifact: true },
  '.markdown': { kind: 'markdown', mime: 'text/plain; charset=utf-8', artifact: true },
  '.canvas': { kind: 'canvas', mime: 'text/plain; charset=utf-8', artifact: true },
  '.html': { kind: 'html', mime: 'text/html; charset=utf-8', artifact: true },
  '.htm': { kind: 'html', mime: 'text/html; charset=utf-8', artifact: true },
  '.pdf': { kind: 'pdf', mime: 'application/pdf', artifact: true },
  '.txt': { kind: 'text', mime: 'text/plain; charset=utf-8' },
  '.csv': { kind: 'text', mime: 'text/plain; charset=utf-8' },
  '.js': { kind: 'text', mime: 'text/javascript; charset=utf-8' },
  '.mjs': { kind: 'text', mime: 'text/javascript; charset=utf-8' },
  '.css': { kind: 'text', mime: 'text/css; charset=utf-8' },
  '.json': { kind: 'text', mime: 'application/json' },
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.avif': { kind: 'image', mime: 'image/avif' },
  '.svg': { kind: 'image', mime: 'image/svg+xml' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.ogg': { kind: 'audio', mime: 'audio/ogg' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.zip': { kind: 'download', mime: 'application/zip', artifact: true },
  '.7z': { kind: 'download', mime: 'application/octet-stream', artifact: true },
  '.tar': { kind: 'download', mime: 'application/octet-stream', artifact: true },
  '.gz': { kind: 'download', mime: 'application/octet-stream', artifact: true },
  '.tgz': { kind: 'download', mime: 'application/octet-stream', artifact: true },
  // Android's own type, so a phone's browser offers to install the app once it has downloaded.
  '.apk': { kind: 'download', mime: 'application/vnd.android.package-archive', artifact: true },
};

export function fileType(path: string) {
  return FILE_TYPES[extname(path).toLowerCase()];
}

/** What an HTML page may also load from beside it (fonts, wasm, captions), only through its file token. */
const SIBLING_TYPES: Record<string, { kind: FileKind; mime: string }> = {
  '.wasm': { kind: 'text', mime: 'application/wasm' },
  '.woff': { kind: 'text', mime: 'font/woff' },
  '.woff2': { kind: 'text', mime: 'font/woff2' },
  '.ttf': { kind: 'text', mime: 'font/ttf' },
  '.otf': { kind: 'text', mime: 'font/otf' },
  '.vtt': { kind: 'text', mime: 'text/vtt; charset=utf-8' },
};

export const siblingType = (path: string) => fileType(path) ?? SIBLING_TYPES[extname(path).toLowerCase()];

export function isArtifact(path: string): boolean {
  return !!fileType(path)?.artifact;
}

export interface FoundArtifact {
  path: string; // relative to the ticket's working directory
  size: number;
  mtime: number;
}

const MAX_FILES = 2000;
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', '__pycache__']);

const hidden = (path: string) => path.split('/').some((part) => part.startsWith('.') || SKIP_DIRS.has(part));

/** Whether a found file (path relative to the folder scanned) is one people are shown: no hidden or dependency folders. */
export function listable(path: string): boolean {
  return isArtifact(path) && !hidden(path);
}

const MEDIA = new Set<FileKind>(['image', 'video', 'audio']);
/** What the Files view lists from a scheme's shared folder (#676): artifacts, and pictures, clips and sound too; never code or data. */
export function sharedListable(path: string): boolean {
  const t = fileType(path);
  return !!t && (!!t.artifact || MEDIA.has(t.kind)) && !hidden(path);
}

/** The most files the shared folder's list holds: Delve's held about 3,300 in November 2026. */
export const MAX_SHARED_FILES = 10_000;

async function git(args: string[], cwd: string): Promise<string[]> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  return stdout.split('\0').filter(Boolean);
}

/** Files a git worktree has added since it branched: committed, staged, or untracked but not ignored. */
async function gitAdded(cwd: string): Promise<string[]> {
  const files = new Set(await git(['ls-files', '-z', '--others', '--exclude-standard'], cwd));
  try {
    const [base] = await git(['merge-base', 'HEAD', 'refs/remotes/origin/HEAD'], cwd);
    const added = await git(['diff', '-z', '--name-only', '--no-renames', '--diff-filter=A', base.trim()], cwd);
    for (const f of added) files.add(f);
  } catch {
    // No origin/HEAD to compare against; untracked files are all we can tell apart.
  }
  return [...files];
}

/** The files `keep` takes in a plain folder, which starts out empty, minus hidden and dependency directories, up to `max`. */
async function walk(cwd: string, keep: (path: string) => boolean, max: number): Promise<string[]> {
  const out: string[] = [];
  const visit = async (rel: string) => {
    let entries;
    try {
      entries = await readdir(join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (e.name.startsWith('.')) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await visit(path);
      } else if (e.isFile() && keep(path)) {
        out.push(path);
      }
    }
  };
  await visit('');
  return out;
}

/** The artifacts a ticket has made in its working directory so far (or the files `keep` takes, up to `max`). */
export async function findArtifacts(cwd: string, isGit: boolean, keep = listable, max = MAX_FILES): Promise<FoundArtifact[]> {
  if (!cwd) return [];
  const paths = (isGit ? (await gitAdded(cwd)).filter(keep) : await walk(cwd, keep, max)).slice(0, max);
  const found: FoundArtifact[] = [];
  for (const path of paths) {
    try {
      // lstat so a symlink pointing elsewhere on disk never becomes an artifact.
      const st = await lstat(join(cwd, path));
      if (st.isFile()) found.push({ path, size: st.size, mtime: Math.round(st.mtimeMs) });
    } catch {
      // Deleted between listing and stat.
    }
  }
  return found;
}

/**
 * The files a ticket's replies link, as absolute paths. A ticket links what it means people to
 * see; files it makes for its own use (test pages, scratch notes) go unlinked, so only linked
 * files are listed as artifacts.
 */
export function linkedPaths(texts: string[], cwd: string): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    // [title](path), ![caption](path), with an optional <> around the path and a "title" after it.
    for (const m of text.matchAll(/\]\(\s*(<[^>\n]+>|[^)\s]+)/g)) {
      let href = m[1].replace(/^<|>$/g, '').split(/[?#]/)[0];
      if (!href || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(href)) continue;
      try {
        href = decodeURI(href);
      } catch {}
      out.add(isAbsolute(href) ? normalize(href) : join(cwd, href));
    }
  }
  return out;
}

/**
 * Find a file a ticket may show: `path` is absolute or relative to its working directory `cwd`, and
 * must resolve (symlinks included) to a servable file type inside one of `roots` (the working
 * directory and the ticket's shared folder).
 */
export async function resolveFile(path: string, cwd: string, roots: string[], typeOf = fileType) {
  const type = typeOf(path);
  if (!type || !cwd || path.includes('\0')) return null;
  try {
    const file = await realpath(isAbsolute(path) ? path : join(cwd, path));
    for (const root of roots) {
      const real = await realpath(root).catch(() => null);
      if (!real || !file.startsWith(real + sep)) continue;
      const st = await stat(file);
      if (!st.isFile()) return null;
      // The path the ticket used, made absolute, so artifact rows and links agree.
      const abs = isAbsolute(path) ? normalize(path) : join(cwd, path);
      return { file, abs, type, size: st.size, mtime: Math.round(st.mtimeMs) };
    }
  } catch {}
  return null;
}

// How many folder entries a name search reads per root before giving up, so a huge tree can't stall it.
const MAX_SEARCH = 20_000;

/**
 * The one file named like `path` (its last segment) under `roots`, for a link whose folders are wrong
 * (#281): its path, or null when there are none or several. Hidden and dependency folders and
 * symlinks are skipped, like the artifact scan.
 */
export async function findByName(path: string, roots: string[]): Promise<string | null> {
  const name = basename(path);
  if (!fileType(name)) return null;
  const hits = new Map<string, string>(); // real path → path found, so overlapping roots count a file once
  let capped = false; // a tree too big to search whole may hold a second one
  for (const root of roots) {
    let seen = 0;
    const visit = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (++seen > MAX_SEARCH) capped = true;
        if (capped || hits.size > 1) return;
        if (e.name.startsWith('.')) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await visit(p);
        } else if (e.isFile() && e.name === name) {
          hits.set(await realpath(p).catch(() => p), p);
        }
      }
    };
    await visit(root);
  }
  return hits.size === 1 && !capped ? [...hits.values()][0] : null;
}

/**
 * A file a link names (see resolveFile), or else the one file with its name in `roots` (findByName),
 * marked `fixed`; null if neither.
 */
export async function resolveLink(path: string, cwd: string, roots: string[]) {
  const found = await resolveFile(path, cwd, roots);
  if (found || !cwd || !fileType(path)) return found;
  const match = await findByName(path, roots);
  const fixed = match ? await resolveFile(match, cwd, roots) : null;
  return fixed && { ...fixed, fixed: true as const };
}

/** A document's own title, from the start of the file: an HTML page's <title> or a Markdown file's first heading. */
export async function fileTitle(abs: string): Promise<string | null> {
  const kind = fileType(abs)?.kind;
  if (kind !== 'html' && kind !== 'markdown') return null;
  let head: string;
  try {
    const f = await open(abs);
    try {
      const { buffer, bytesRead } = await f.read(Buffer.alloc(8192), 0, 8192, 0);
      head = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await f.close();
    }
  } catch {
    return null;
  }
  const m = kind === 'html' ? head.match(/<title[^>]*>([^<]*)</i) : head.match(/^#\s+(.+)$/m);
  return m?.[1].replace(/\s+/g, ' ').trim().slice(0, 200) || null;
}

/** Why `path` can't be a question option's picture, or null if it can: an image or video the ticket may show. */
export async function optionImageProblem(path: string, cwd: string, roots: string[]): Promise<string | null> {
  const kind = fileType(path)?.kind;
  if (kind !== 'image' && kind !== 'video') return 'must be an image (png, jpg, gif, webp, avif, svg) or a video (mp4, webm, mov)';
  if (!(await resolveFile(path, cwd, roots))) return 'must be a file in your working directory or shared folder';
  return null;
}

/**
 * A person's comment on a file as a chat message: `about` names the file in the message's
 * "[Name on about]:" prefix, and a quoted passage leads the text as a Markdown quote.
 */
export function commentMessage(path: string, text: string, quote = '') {
  // Like display names, the file sits inside "[...]:" in the prompt, so keep brackets and newlines out.
  const plain = path.replace(/[\x00-\x1f\x7f\[\]]/g, '').trim();
  const about = plain.length > 200 ? `…${plain.slice(-199)}` : plain;
  const quoted = quote.trim() ? `${quote.trim().split('\n').map((l) => `> ${l}`.trimEnd()).join('\n')}\n\n` : '';
  return { about, text: `${quoted}${text.trim()}` };
}
