// Artifacts: documents and pages that tickets create in their working directories.
import { execFile } from 'node:child_process';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type FileKind = 'markdown' | 'text' | 'canvas' | 'html' | 'pdf' | 'image' | 'video' | 'audio';

/**
 * File types the app will serve from a ticket's folder. Only documents and pages (`artifact`)
 * are listed as artifacts; images and media are served when a document embeds them.
 * Source code is left out on purpose; it lives in the branch.
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
};

export function fileType(path: string) {
  return FILE_TYPES[extname(path).toLowerCase()];
}

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

async function git(args: string[], cwd: string): Promise<string[]> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 16 * 1024 * 1024, timeout: 30_000 });
  return stdout.split('\0').filter(Boolean);
}

/** Files a git worktree has added since it branched: committed, staged, or untracked but not ignored. */
async function gitAdded(cwd: string): Promise<string[]> {
  const files = new Set(await git(['ls-files', '-z', '--others', '--exclude-standard'], cwd));
  try {
    const [base] = await git(['merge-base', '-z', 'HEAD', 'refs/remotes/origin/HEAD'], cwd);
    const added = await git(['diff', '-z', '--name-only', '--no-renames', '--diff-filter=A', base.trim()], cwd);
    for (const f of added) files.add(f);
  } catch {
    // No origin/HEAD to compare against; untracked files are all we can tell apart.
  }
  return [...files];
}

/** Every file in a plain folder, which starts out empty, minus hidden and dependency directories. */
async function walk(cwd: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (rel: string) => {
    let entries;
    try {
      entries = await readdir(join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith('.')) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await visit(path);
      } else if (e.isFile()) {
        out.push(path);
      }
    }
  };
  await visit('');
  return out;
}

/** The artifacts a ticket has made in its working directory so far. */
export async function findArtifacts(cwd: string, isGit: boolean): Promise<FoundArtifact[]> {
  if (!cwd) return [];
  const paths = (isGit ? await gitAdded(cwd) : await walk(cwd))
    .filter((p) => isArtifact(p) && !p.split('/').some((part) => part.startsWith('.') || SKIP_DIRS.has(part)))
    .slice(0, MAX_FILES);
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
export async function resolveFile(path: string, cwd: string, roots: string[]) {
  const type = fileType(path);
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
