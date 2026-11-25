// The child behind src/app-copy.ts (#1884): copies an app's live DATA_DIR into a new folder, reading the live one only.
// Databases by SQLite's own backup in one step, so a copy taken while the app writes is of one moment; with `files`, the
// rest too. Run as a child, so a big copy never holds the server's thread and can be stopped: its argument is one JSON
// CopyAsk, its one line of output a CopyResult or { error }. It exits when its stdin closes, so it never outlives the server.
import { constants } from 'node:fs';
import { chmod, copyFile as copyPlain, lstat, mkdir, open, readdir, realpath, rm, statfs } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { human } from './app-snapshots.ts';
import type { CopyAsk } from './app-copy.ts';
import { copyFile } from './db-copy.ts';
import type { CopyResult } from './mcp-text.ts';

/** What never leaves the live folder: env files, keys and logins by name. A secret inside a database is copied with it. */
const SECRET = /^\.env|\.env$|^\.(netrc|npmrc|pgpass|git-credentials)$|^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p8|p12|pfx|jks|keystore)$|secret|credential|token|password/i;
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

/** Every file under `root` worth copying; the names left out on purpose go in `out`. Links are never followed. */
async function find(root: string, out: string[]): Promise<Found[]> {
  const found: Found[] = [];
  const walk = async (rel: string) => {
    for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
      const name = join(rel, e.name);
      if ((!rel && e.name === 'backups') || SECRET.test(e.name) || !(e.isDirectory() || e.isFile())) out.push(name);
      else if (e.isDirectory()) await walk(name);
      else {
        // Gone or unreadable between the listing and here: the app's temp file, say.
        const st = await lstat(join(root, name)).catch(() => null);
        if (st) found.push({ name, bytes: st.size, db: await isDatabase(join(root, name)) });
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
  const plain = files ? found.filter((f) => !f.db && !(SIDE.test(f.name) && side.has(f.name))) : [];
  // A database's WAL can hold as much again as its file.
  const bytes = [...dbs, ...plain, ...found.filter((f) => f.name.endsWith('-wal') && side.has(f.name))].reduce((n, f) => n + f.bytes, 0);
  if (bytes > cap) throw new Error(`That is ${human(bytes)}, over the ${human(cap)} a copy may take`);
  await mkdir(to, { mode: 0o700 });
  const disk = await statfs(to);
  const free = disk.bavail * disk.bsize;
  if (free - bytes < spare) throw new Error(`Not enough disk: a ${human(bytes)} copy would leave ${human(Math.max(0, free - bytes))} free, under the ${human(spare)} kept free`);
  for (const f of [...dbs, ...plain]) {
    const dest = join(to, f.name);
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    if (f.db) await copyFile(join(root, f.name), dest).catch((err) => Promise.reject(new Error(`Copying ${f.name} failed: ${err.message}`)));
    else await copyPlain(join(root, f.name), dest, constants.COPYFILE_FICLONE);
    await chmod(dest, 0o600);
  }
  return { databases: await Promise.all(dbs.map(async (d) => ({ name: d.name, bytes: (await lstat(join(to, d.name))).size }))), files: plain.length, left_out };
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
