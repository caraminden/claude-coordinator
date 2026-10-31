/**
 * Each minion's and Taskmaster's own temp folder (#218), on disk beside the database rather than in
 * perigee's /tmp, a 15 GB tmpfs every session shares, which their leftovers filled on 2026-10-31.
 * A folder is named by its ticket id; nothing but such a folder, directly under the root, is ever removed.
 */
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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
