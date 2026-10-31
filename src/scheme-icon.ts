// A scheme's own icon (#222): assets/icon/icon.svg in its main checkout. The file comes from a repo,
// so it is untrusted: it must stay inside the checkout, stay small, and is only ever shown via <img>.
import { readFile, realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

export const ICON_PATH = 'assets/icon/icon.svg';
export const MAX_ICON_BYTES = 256 * 1024;

/** Sent with the icon: an SVG in an <img> can't run scripts, and these keep it inert when opened on its own too. */
export const ICON_HEADERS = {
  'Content-Type': 'image/svg+xml',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
};

type Found = { file: string; size: number; mtime: number };

/** The scheme's icon file, or why there is none: missing, a link out of the checkout, or too big. */
export async function findIcon(repoDir: string | null): Promise<Found | { missing: string }> {
  if (!repoDir) return { missing: 'This scheme has no checkout' };
  // realpath, so neither the file nor a folder on its way can be a symlink out of the checkout.
  const [root, file] = await Promise.all([realpath(repoDir).catch(() => null), realpath(join(repoDir, ICON_PATH)).catch(() => null)]);
  if (!root || !file) return { missing: `This scheme has no ${ICON_PATH}` };
  if (!file.startsWith(root + sep)) return { missing: `${ICON_PATH} points outside the scheme's repo` };
  const st = await stat(file).catch(() => null);
  if (!st?.isFile()) return { missing: `This scheme has no ${ICON_PATH}` };
  if (st.size > MAX_ICON_BYTES) return { missing: `${ICON_PATH} is over ${MAX_ICON_BYTES / 1024} KB` };
  return { file, size: st.size, mtime: Math.floor(st.mtimeMs) };
}

/** The icon's version for the scheme list (its mtime, which a fast-forward that changes it moves), or null for none. */
export async function iconVersion(repoDir: string | null): Promise<number | null> {
  const found = await findIcon(repoDir);
  return 'file' in found ? found.mtime : null;
}

// Bodies by scheme, kept while the file's mtime and size stay the same.
const cache = new Map<number, Found & { body: Buffer }>();

/** The icon's bytes, read once per change of the file. */
export async function readIcon(projectId: number, repoDir: string | null): Promise<Buffer | { missing: string }> {
  const found = await findIcon(repoDir);
  if (!('file' in found)) {
    cache.delete(projectId);
    return found;
  }
  const hit = cache.get(projectId);
  if (hit && hit.file === found.file && hit.mtime === found.mtime && hit.size === found.size) return hit.body;
  const body = await readFile(found.file);
  // It may have grown between the stat and the read.
  if (body.length > MAX_ICON_BYTES) return { missing: `${ICON_PATH} is over ${MAX_ICON_BYTES / 1024} KB` };
  cache.set(projectId, { ...found, body });
  return body;
}
