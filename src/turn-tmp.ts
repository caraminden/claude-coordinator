/**
 * Each minion's and Taskmaster's own temp folder (#218), on disk in its scheme's data folder rather
 * than in perigee's /tmp, a 15 GB tmpfs every session shares, which their leftovers filled on 2026-10-31.
 * A folder is named by its ticket id; nothing but such a folder, directly under the root, is ever removed.
 */
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const TICKET_NAME = /^[1-9]\d*$/;

export function tmpDirFor(root: string, ticketId: number): string {
  if (!isAbsolute(root)) throw new Error(`The temp root must be an absolute path, not ${JSON.stringify(root)}`);
  if (!Number.isSafeInteger(ticketId) || ticketId <= 0) throw new Error(`Not a ticket id: ${ticketId}`);
  return join(root, String(ticketId));
}

/** Make the ticket's folder, private like its root, and return it. */
export function makeTmpDir(root: string, ticketId: number): string {
  const dir = tmpDirFor(root, ticketId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by the umask and skips folders that exist already.
  chmodSync(root, 0o700);
  chmodSync(dir, 0o700);
  return dir;
}

/** Remove the ticket's folder and all in it (symlinks inside are removed, never followed). */
export function clearTmpDir(root: string, ticketId: number) {
  rmSync(tmpDirFor(root, ticketId), { recursive: true, force: true });
}

/** The same without holding up the server (#526): a minion's folder can hold 20,000 files, over a second of deleting. */
export function clearTmpDirLater(root: string, ticketId: number): Promise<void> {
  return rm(tmpDirFor(root, ticketId), { recursive: true, force: true });
}

/** Remove every ticket's folder that `keep` refuses; anything else in the root stays. Returns the ids removed. */
export function sweepTmpDirs(root: string, keep: (ticketId: number) => boolean): number[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const gone = names.filter((n) => TICKET_NAME.test(n) && !keep(Number(n))).map(Number);
  for (const id of gone) clearTmpDir(root, id);
  return gone;
}

/** A finished turn's folder renamed aside, awaiting its delete: not `<minion>-<ms>`, so no sweep takes it for a turn. */
export const DROPPED_SUFFIX = '.gone';

/**
 * Remove a finished turn's folder without holding the server's thread (#1459): one cheap synchronous rename
 * takes it out of sight, the delete runs async. Resolves once it is gone; never rejects.
 */
export function dropTurnDir(dir: string): Promise<void> {
  let target = dir;
  try {
    target = `${dir}${DROPPED_SUFFIX}`;
    renameSync(dir, target);
  } catch {
    target = dir; // already gone, or can't be renamed: the delete below copes with both
  }
  return rm(target, { recursive: true, force: true }).catch(() => {});
}

/** Delete the leftovers of a crash mid-delete, in `root` and in the person folders under it, async. */
export async function sweepDroppedTurnDirs(root: string): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  const found = names.filter((n) => n.endsWith(DROPPED_SUFFIX)).map((n) => join(root, n));
  for (const n of names.filter((n) => /^person-\d+$/.test(n))) {
    for (const m of await readdir(join(root, n)).catch(() => [] as string[])) if (m.endsWith(DROPPED_SUFFIX)) found.push(join(root, n, m));
  }
  await Promise.all(found.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
}
