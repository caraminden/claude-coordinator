// Relay files across schemes (#405): message_taskmaster's `file` is copied by the server from the
// sender's shared folder into the receiver's, under inbox/<sender scheme>/, so a long write-up travels
// as a path, not as text through two Taskmasters' contexts. The server does the copy: no turn gets
// write access to another scheme's folder (the tripwire still blocks that).
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, sep } from 'node:path';
import { HttpError } from './http.ts';
import { thrown } from './thrown.ts';

export const RELAY_FILE_MAX = 2 * 1024 * 1024;

const safe = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80) || 'file';

/** Copy `file` (absolute, or relative to `fromShared`) into `toShared`/inbox/<fromScheme>/; returns where it landed. */
export function relayFile(fromShared: string, toShared: string, fromScheme: string, file: string): { path: string; size: number } {
  let real: string;
  try {
    real = realpathSync(isAbsolute(file) ? file : join(fromShared, file));
  } catch {
    throw new HttpError(400, `No file at ${file}. Attach a file from your scheme's shared folder (${fromShared})`);
  }
  // Resolved, so a symlink or ../ can't reach past the sender's own shared folder.
  let root: string;
  try {
    root = realpathSync(fromShared);
  } catch {
    throw new HttpError(400, `Your scheme's shared folder (${fromShared}) doesn't exist yet`);
  }
  if (!real.startsWith(root + sep)) throw new HttpError(400, `Only files in your scheme's shared folder (${fromShared}) can be attached`);
  const st = statSync(real);
  if (!st.isFile()) throw new HttpError(400, `${file} is not a file`);
  const tooBig = () => new HttpError(413, `${file} is over ${RELAY_FILE_MAX / 1024 / 1024} MB: attach a shorter file, or a summary of it`);
  if (st.size > RELAY_FILE_MAX) throw tooBig(); // before reading: a huge file never comes into memory
  const data = readFileSync(real);
  if (data.length > RELAY_FILE_MAX) throw tooBig(); // grew since the stat
  const dir = join(toShared, 'inbox', safe(fromScheme));
  mkdirSync(dir, { recursive: true });
  // Its real place, so a symlinked inbox can't send the copy outside the receiver's shared folder.
  const realDir = realpathSync(dir);
  if (!realDir.startsWith(realpathSync(toShared) + sep)) throw new HttpError(409, "The receiving scheme's inbox folder points outside its shared folder");
  const name = safe(basename(real));
  const ext = extname(name);
  for (let n = 1; ; n++) {
    const path = join(realDir, n === 1 ? name : `${name.slice(0, name.length - ext.length)}-${n}${ext}`);
    try {
      writeFileSync(path, data, { flag: 'wx' }); // never overwrites what the receiver has
      return { path, size: data.length };
    } catch (e) {
      if (thrown(e).code !== 'EEXIST' || n >= 100) throw e;
    }
  }
}
