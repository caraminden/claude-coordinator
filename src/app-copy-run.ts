// The child behind src/app-copy.ts (#1884): copies an app's live DATA_DIR into a new folder, reading the live one only.
// Databases by SQLite's own backup in one step, so a copy taken while the app writes is of one moment; with `files`, the
// rest too. Run as a child, so a big copy never holds the server's thread and can be stopped: its argument is one JSON
// CopyAsk, its one line of output a CopyResult or { error }. It exits when its stdin closes, so it never outlives the server.
import { constants } from 'node:fs';
import { chmod, copyFile as copyPlain, lstat, mkdir, open, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { human } from './app-snapshots.ts';
import type { CopyAsk } from './app-copy.ts';
import { copyFile } from './db-copy.ts';
import type { CopyResult } from './mcp-text.ts';

/** Files that never leave the live folder: env files, keys and logins by name, or in a folder so named. Never a database: a secret inside one is copied with it. */
const SECRET = /^\.env|\.env$|^\.(netrc|npmrc|pgpass|git-credentials)$|^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p8|p12|pfx|jks|keystore)$|secret|credential|token|password/i;
/** Folders that never do, whole. */
const SECRET_DIR = /^\.?(secrets?|credentials?|tokens?|passwords?|keys|ssh|aws|gnupg)$/i;
/** SQLite's own files beside a database: the backup reads them, so they are never copied. */
const SIDE = /-(wal|shm|journal)$/;

async function isDatabase(file: string): Promise<boolean> {
  const f = await open(file, 'r');
  try {
    const { bytesRead, buffer } = await f.read(Buffer.alloc(16), 0, 16, 0);
    return bytesRead === 16 && buffer.toString('latin1') === 'SQLite format 3\0';
  } finally {
    await f.close();
  }
}

interface Found {
  name: string;
  bytes: number;
  db: boolean;
}

/** The app removed it meanwhile, or it can't be read: left out, and said so, rather than failing the copy. */
const lost = (name: string, out: string[]) => (err: NodeJS.ErrnoException) => {
  if (err.code !== 'ENOENT' && err.code !== 'EACCES') throw err;
  out.push(name);
  return null;
};

/** Every file under `root` that may be copied; the names left out go in `out`. Links are never followed. */
async function find(root: string, out: string[]): Promise<Found[]> {
  const found: Found[] = [];
  const walk = async (rel: string) => {
    for (const e of (await readdir(join(root, rel), { withFileTypes: true }).catch(lost(rel, out))) ?? []) {
      const name = join(rel, e.name);
      if (e.isDirectory() ? (!rel && e.name === 'backups') || SECRET_DIR.test(e.name) : !e.isFile()) out.push(name);
      else if (e.isDirectory()) await walk(name);
      else {
        const db = await isDatabase(join(root, name)).catch(lost(name, out));
        const st = db === null ? null : await lstat(join(root, name)).catch(lost(name, out));
        if (st) found.push({ name, bytes: st.size, db: db === true });
      }
    }
  };
  await walk('');
  return found;
}

export async function copyData({ from, to, files, cap, spare }: CopyAsk): Promise<CopyResult> {
  const root = await realpath(from).catch(() => null);
  if (!root) throw new Error(`The app has no data folder (${from}) to copy yet`);
  const left_out: string[] = [];
  const found = await find(root, left_out);
  const dbs = found.filter((f) => f.db);
  if (!dbs.length && !files) throw new Error('The app has no SQLite database in its data folder: ask with files: true for the rest of its files');
  const side = new Set(dbs.flatMap((d) => ['-wal', '-shm', '-journal'].map((s) => d.name + s)));
  const rest = found.filter((f) => !f.db && !(SIDE.test(f.name) && side.has(f.name)));
  const secret = (f: Found) => f.name.split(sep).some((part) => SECRET.test(part));
  left_out.push(...rest.filter(secret).map((f) => f.name));
  const plain = files ? rest.filter((f) => !secret(f)) : [];
  // A database's WAL can hold as much again as its file.
  const bytes = [...dbs, ...plain, ...found.filter((f) => f.name.endsWith('-wal') && side.has(f.name))].reduce((n, f) => n + f.bytes, 0);
  if (bytes > cap) throw new Error(`That is ${human(bytes)}, over the ${human(cap)} a copy may take`);
  await mkdir(to, { mode: 0o700 });
  const disk = await statfs(to);
  const free = disk.bavail * disk.bsize;
  if (free - bytes < spare) throw new Error(`Not enough disk: a ${human(bytes)} copy would leave ${human(Math.max(0, free - bytes))} free, under the ${human(spare)} kept free`);
  let copied = 0;
  for (const f of [...dbs, ...plain]) {
    const dest = join(to, f.name);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    if (f.db) await copyFile(join(root, f.name), dest).catch((err) => Promise.reject(new Error(`Copying ${f.name} failed: ${err.message}`)));
    else if ((await copyPlain(join(root, f.name), dest, constants.COPYFILE_FICLONE).catch(lost(f.name, left_out))) === null) continue;
    else copied++;
    await chmod(dest, 0o600);
  }
  return { databases: await Promise.all(dbs.map(async (d) => ({ name: d.name, bytes: (await lstat(join(to, d.name))).size }))), files: copied, left_out };
}

if (import.meta.main) {
  process.umask(0o077);
  process.stdin.on('end', () => process.exit(1)).resume();
  const ask = JSON.parse(process.argv[2]) as CopyAsk;
  copyData(ask).then(
    (r) => process.stdout.write(JSON.stringify(r), () => process.exit(0)),
    async (err) => {
      await rm(ask.to, { recursive: true, force: true });
      process.stdout.write(JSON.stringify({ error: String(err?.message ?? err) }), () => process.exit(0));
    },
  );
}
