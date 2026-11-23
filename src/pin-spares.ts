/**
 * Spare copies of a server's pinned turn files, made ahead off the loop (#1414). A turn's start took its copy with
 * ~370 links or a byte copy of the tree on the loop: 3 to 10.8 s held under load with a cold disk cache. Now it takes a
 * ready spare with one rename and a new one is made behind it with fs/promises. With no spare ready (a burst, or just
 * after boot), copyPinned makes the copy on the loop as before.
 *
 * Spares sit in run/turns/.pin-spares/<pid>: the same filesystem as every turn's folder, so a rename moves them, and
 * outside every container's mounts (a container mounts only its person-<uid> folder), so a container turn can't reach a
 * link spare or another turn's copy. A link spare only ever goes to a host turn; a container turn gets a byte copy.
 */
import { renameSync, rmSync, mkdirSync } from 'node:fs';
import { cp, link, mkdir, readdir, readlink, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

export type SpareKind = 'link' | 'copy';
/** How many of each to keep ready: host turns start far more often than container ones. */
export const SPARES: Record<SpareKind, number> = { link: 6, copy: 3 };

let at: { dir: string; src: string } | null = null;
let on = false;
const ready: Record<SpareKind, string[]> = { link: [], copy: [] };
let seq = 0;
let making: Promise<void> | null = null;
let failed = false;
/** The old spares' removal after a re-pin, off the loop; fillPinSpares waits for it. */
let removing: Promise<void> = Promise.resolve();
/** Every spares folder this process made, removed when it exits. */
const swept = new Set<string>();

/** Where this process's spares go and what they copy. Makes none yet: fillPinSpares starts that (server.ts, after boot). */
export function pinSparesAt(dir: string, src: string): void {
  // A re-pin (#1416): the old folder's spares can never be taken (takeSpare checks src), so they go now, not at exit.
  if (at && at.dir !== dir) { swept.delete(at.dir); removing = rm(at.dir, { recursive: true, force: true }).catch(() => {}); }
  at = { dir, src };
  on = false;
  ready.link = [];
  ready.copy = [];
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  if (!swept.size) process.once('exit', () => { for (const d of swept) rmSync(d, { recursive: true, force: true }); });
  swept.add(dir);
}

/** Start keeping spares ready; resolves once they are all made (tests wait on it). */
export async function fillPinSpares(): Promise<void> {
  on = true;
  failed = false;
  await removing;
  while (need()) await fill();
}

/** The spares ready now, for tests. */
export function readySpares(kind: SpareKind): string[] {
  return [...ready[kind]];
}

/**
 * Move a ready spare of `src` to `dst`. False when there is none (or it can't be moved), and the caller copies on the
 * loop; either way, a new spare is made behind it.
 */
export function takeSpare(src: string, dst: string, kind: SpareKind): boolean {
  if (!at || src !== at.src) return false;
  const spare = ready[kind].shift();
  try {
    if (!spare) {
      if (on) console.warn(`pin spares: none ready for a ${kind === 'link' ? 'host' : 'container'} turn, copying on the loop`);
      return false;
    }
    try {
      renameSync(spare, dst);
      return true;
    } catch (e) {
      console.warn(`pin spares: could not move ${spare} to ${dst}, copying on the loop: ${(e as Error).message}`);
      rmSync(spare, { recursive: true, force: true });
      return false;
    }
  } finally {
    failed = false;
    void fill();
  }
}

/** The kind to make next, if any: links first, since host turns start far more often. None after a failure, until a take. */
const need = (): SpareKind | undefined => (at && on && !failed ? (['link', 'copy'] as const).find((k) => ready[k].length < SPARES[k]) : undefined);

/** Make spares one at a time until each kind has its count, so a refill never crowds the disk. */
function fill(): Promise<void> {
  if (!making && need()) making = pass().finally(() => {
    making = null;
    void fill(); // a take or a fill that came while this pass was ending
  });
  return making ?? Promise.resolve();
}

async function pass(): Promise<void> {
  for (let kind = need(); kind; kind = need()) {
    const now = at!;
    const dir = join(now.dir, `${kind}-${++seq}`);
    try {
      if (kind === 'link') await linkTree(now.src, dir);
      else await cp(now.src, dir, { recursive: true, verbatimSymlinks: true });
    } catch (e) {
      failed = true;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      console.warn(`pin spares: making a ${kind} spare failed, trying again at the next turn: ${(e as Error).message}`);
      return;
    }
    if (at !== now) return void (await rm(dir, { recursive: true, force: true }).catch(() => {}));
    ready[kind].push(dir);
  }
}

/** copyPinned's links, made with fs/promises: folders made, files linked, symlinks kept as they are. */
async function linkTree(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  for (const e of await readdir(src, { withFileTypes: true })) {
    const from = join(src, e.name), to = join(dst, e.name);
    if (e.isDirectory()) await linkTree(from, to);
    else if (e.isSymbolicLink()) await symlink(await readlink(from), to);
    else await link(from, to);
  }
}
