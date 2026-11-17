// A scheme's own icon (#222): its favicon, from where the schemes keep one in their main checkout.
// The file comes from a repo, so it is untrusted: it must stay inside the checkout, stay small, and
// is only ever shown via <img>.
import { readFile, realpath, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { join, sep } from 'node:path';
import type { ContraptionRow, Store } from './db.ts';

/** Where a scheme's favicon may be, best first: the first that exists is the scheme's icon. */
export const ICON_PATHS = [
  'assets/icon/icon.svg', 'assets/icon/favicon.svg', 'assets/icon/favicon-48.svg', 'assets/icon/favicon-32.svg',
  'web/public/icon.svg', 'public/icon.svg', 'public/favicon.svg', 'static/favicon.svg', 'favicon.svg',
];
export const MAX_ICON_BYTES = 256 * 1024;

/** Sent with the icon: an SVG in an <img> can't run scripts, and these keep it inert when opened on its own too. */
export const ICON_HEADERS = {
  'Content-Type': 'image/svg+xml',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  'X-Content-Type-Options': 'nosniff',
};

type Found = { file: string; size: number; mtime: number };

const NO_ICON = { missing: 'This scheme has no favicon' };

/** The first usable of ICON_PATHS, or why there is none: none there, a link out of the checkout, or too big. */
export async function findIcon(repoDir: string | null): Promise<Found | { missing: string }> {
  const root = repoDir && await realpath(repoDir).catch(() => null);
  if (!root) return NO_ICON;
  let refused: { missing: string } | undefined;
  // citadel-app.json's icon (#840): the scheme's own override for this use, else the source it names, then the usual places.
  const cfg = await readFile(join(root, 'citadel-app.json'), 'utf8').then((t) => JSON.parse(t).icon, () => null).catch(() => null);
  const named = [cfg?.overrides?.scheme, cfg?.source].filter((p): p is string => typeof p === 'string' && !!p && !p.startsWith('/') && !p.split('/').includes('..'));
  for (const path of [...named, ...ICON_PATHS]) {
    // realpath, so neither the file nor a folder on its way can be a symlink out of the checkout.
    const file = await realpath(join(root, path)).catch(() => null);
    if (!file) continue;
    if (!file.startsWith(root + sep)) {
      refused ??= { missing: `${path} points outside the scheme's repo` };
      continue;
    }
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) continue;
    if (st.size > MAX_ICON_BYTES) {
      refused ??= { missing: `${path} is over ${MAX_ICON_BYTES / 1024} KB` };
      continue;
    }
    return { file, size: st.size, mtime: Math.floor(st.mtimeMs) };
  }
  return refused ?? NO_ICON;
}

/**
 * The contraption whose icon stands in for a scheme's when its repo has none (#810): the scheme's home contraption
 * with an icon on its own service. With several, the oldest registration (lowest id) wins, so the pick never flips.
 */
export function homeApp(store: Store, projectId: number): ContraptionRow | undefined {
  return store.listContraptions().filter((c) => c.home_scheme === projectId && c.icon && !/^https?:/.test(c.icon)).sort((a, b) => a.id - b.id)[0];
}

/** Where the app serves its icon, as the rail's icon proxy builds it (src/apps.ts). */
const appIconPath = (c: ContraptionRow) => c.icon!.startsWith('/apps/') ? c.icon! : `/apps/${c.name}/${c.icon!.replace(/^\//, '')}`;

/** The app icon's version: its last deployed commit (a redeploy is when its icon can change), as a number for the URL. */
function appVersion(store: Store, c: ContraptionRow): number {
  const sha = store.listContraptionDeploys(c.name, 1, 'deployed')[0]?.to_sha;
  const n = parseInt((sha ?? '').slice(0, 12), 16);
  return Number.isFinite(n) ? n : 1;
}

/** The icon's version for the scheme list (a repo icon's mtime, which a fast-forward that changes it moves; else the home app's), or null for none. */
export async function iconVersion(repoDir: string | null, app?: { store: Store; projectId: number }): Promise<number | null> {
  const found = await findIcon(repoDir);
  if ('file' in found) return found.mtime;
  const c = app && homeApp(app.store, app.projectId);
  return c ? appVersion(app!.store, c) : null;
}

// Bodies by scheme, kept while the file's mtime and size stay the same.
const cache = new Map<number, Found & { body: Buffer }>();
const appCache = new Map<number, { key: string; body: Buffer; type: string }>();

/** Image types an app's icon may be served as; an SVG keeps the inert headers, the rest are sandboxed too. */
const IMAGE_TYPE = /^image\/(svg\+xml|png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon)$/;

function fetchAppIcon(c: ContraptionRow): Promise<{ body: Buffer; type: string } | { missing: string }> {
  return new Promise((resolve) => {
    const fail = (missing: string) => resolve({ missing });
    let up: ReturnType<typeof request>;
    try { up = request({ host: '127.0.0.1', port: c.port, path: appIconPath(c), headers: { accept: 'image/*' } }, (r) => {
      const type = String(r.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
      if (r.statusCode !== 200 || !IMAGE_TYPE.test(type)) { r.resume(); return fail(`${c.title} has no icon`); }
      const chunks: Buffer[] = [];
      let size = 0;
      r.on('data', (d: Buffer) => {
        size += d.length;
        if (size > MAX_ICON_BYTES) { up.destroy(); return fail(`${c.title}'s icon is over ${MAX_ICON_BYTES / 1024} KB`); }
        chunks.push(d);
      });
      r.on('end', () => resolve({ body: Buffer.concat(chunks), type }));
      r.on('error', () => fail(`${c.title} is not answering`));
    }); } catch { return fail(`${c.title} has no icon`); } // a path request() refuses
    up.setTimeout(10_000, () => { up.destroy(); fail(`${c.title} is not answering`); });
    up.on('error', () => fail(`${c.title} is not answering`));
    up.end();
  });
}

/** What goes out with an icon of this type: SVG's inert headers, or the same lockdown (plus a sandbox) for a raster type. */
export function iconHeaders(type: string) {
  return type === 'image/svg+xml' ? ICON_HEADERS : { ...ICON_HEADERS, 'Content-Type': type, 'Content-Security-Policy': "sandbox; default-src 'none'" };
}

/** The icon's bytes and type, read once per change of the file (or of the home app's deploy). */
export async function readIcon(projectId: number, repoDir: string | null, store?: Store): Promise<{ body: Buffer; type: string } | { missing: string }> {
  const found = await findIcon(repoDir);
  if (!('file' in found)) {
    cache.delete(projectId);
    const c = store && homeApp(store, projectId);
    if (!c) { appCache.delete(projectId); return found; }
    const key = `${c.id}:${c.icon}:${appVersion(store, c)}`;
    const hit = appCache.get(projectId);
    if (hit?.key === key) return hit;
    const got = await fetchAppIcon(c);
    if ('missing' in got) return got;
    appCache.set(projectId, { key, ...got });
    return got;
  }
  appCache.delete(projectId);
  const hit = cache.get(projectId);
  if (hit && hit.file === found.file && hit.mtime === found.mtime && hit.size === found.size) return { body: hit.body, type: 'image/svg+xml' };
  const body = await readFile(found.file);
  // It may have grown between the stat and the read.
  if (body.length > MAX_ICON_BYTES) return { missing: `The favicon is over ${MAX_ICON_BYTES / 1024} KB` };
  cache.set(projectId, { ...found, body });
  return { body, type: 'image/svg+xml' };
}
