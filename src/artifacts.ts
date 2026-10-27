// Artifacts: documents and pages that tickets create in their working directories.
import { execFile } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
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
