// Big uploads in chunks (#832): the shared folder's Files upload, and contraptions' pages through
// /apps/_citadel/uploads/<app> (src/apps.ts). Our own four calls rather than tus, which would mean its headers,
// a PATCH verb and base64 metadata for no gain here:
//   POST   <base>             { name, size, folder? }  → 201 { id, offset: 0, size, chunk }
//   GET    <base>/<id>                                 → { id, offset, size }
//   PUT    <base>/<id>?offset=N   <the next bytes>     → { id, offset, size }, and on the last byte the finished file
//   DELETE <base>/<id>                                 → 204
// Bytes go to DATA_DIR/chunked/<id>.part beside <id>.json (who, where to, name, size). The offset is the .part's size
// on disk, so a dropped connection, a reload or a Citadel restart picks up after the last byte that arrived; a PUT at
// any other offset is a 409 and the client asks GET for the real one. On the last byte the file moves into place
// under a name nothing has (" (2)"), so nothing is overwritten. The free-disk floor (perigee is shared) is checked at
// the start, counting what every unfinished upload still has to send, and again before each chunk.
// Nothing here logs a file's name or bytes: uploads are private to their scheme or app.
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpError } from './http.ts';
import { claimName, safeFileName, uploadFolder } from './uploads.ts';

/** The most one PUT may carry; the kit's client sends 8 MiB, well under the proxy's 20 MiB and Caddy's limits. */
export const CHUNK_MAX = 16 * 1024 * 1024;
export const CHUNK_SIZE = 8 * 1024 * 1024;
/** Free space every upload leaves on the disk it writes to. */
export const DISK_FLOOR = 50 * 1024 ** 3;
/** An upload untouched this long is given up: its partial file is removed at the next start. */
export const STALE_MS = 3 * 24 * 3600 * 1000;
const ID = /^[0-9a-f]{32}$/;

/** Where a finished upload goes: a scheme's shared folder, or a contraption's DATA_DIR/uploads/<login>/. */
export type Target = { kind: 'shared'; project: number } | { kind: 'app'; app: string };
export interface Uploader { uid: number; login: string }
export interface Meta { id: string; uid: number; login: string; target: Target; name: string; folder: string[]; size: number; created: number }
/** Moves the finished .part into place and says what it became. */
export type Finish = (meta: Meta, part: string) => Promise<Record<string, unknown>>;

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`;
const sameTarget = (a: Target, b: Target) => a.kind === b.kind && (a.kind === 'shared' ? a.project === (b as typeof a).project : a.app === (b as typeof a).app);

export class ChunkedUploads {
  readonly dir: string;
  private floor: number;
  /** Ids with a PUT on its way: a second PUT for one (a retry racing the first) waits its turn as a 409. */
  private busy = new Set<string>();
  /** Free bytes on the disk under `dir`; replaceable in tests. */
  free: (dir: string) => Promise<number> = async (dir) => {
    const s = await statfs(dir);
    return s.bavail * s.bsize;
  };

  constructor(dataDir: string, floor = DISK_FLOOR) {
    this.dir = join(dataDir, 'chunked');
    this.floor = floor;
  }

  private part = (id: string) => join(this.dir, `${id}.part`);
  private metaPath = (id: string) => join(this.dir, `${id}.json`);

  /** Begin an upload of `size` bytes, refused when it would take the disk below the floor. */
  async start(who: Uploader, target: Target, body: any): Promise<{ id: string; offset: number; size: number; chunk: number }> {
    const size = body?.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'size must be the file\'s size in bytes');
    if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 1000) throw new HttpError(400, 'name must be the file\'s name');
    const folder = uploadFolder(typeof body.folder === 'string' ? body.folder.slice(0, 2000) : '');
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const open = await this.sweep();
    const owed = open.reduce((n, m) => n + m.left, 0);
    const free = await this.free(this.dir);
    if (free - owed - size < this.floor) {
      throw new HttpError(507, `Not enough room on the server: ${gb(Math.max(0, free - owed))} free${owed ? ' after the uploads already under way' : ''}, and uploads always leave ${gb(this.floor)}. This file is ${gb(size)}.`, true);
    }
    const meta: Meta = { id: randomBytes(16).toString('hex'), uid: who.uid, login: who.login, target, name: safeFileName(body.name), folder, size, created: Date.now() };
    // Busy while half-written, so another start's sweep doesn't take it for a stray.
    this.busy.add(meta.id);
    try {
      await writeFile(this.part(meta.id), '', { mode: 0o600 });
      await writeFile(this.metaPath(meta.id), JSON.stringify(meta), { mode: 0o600 });
    } finally {
      this.busy.delete(meta.id);
    }
    return { id: meta.id, offset: 0, size, chunk: CHUNK_SIZE };
  }

  /** How far an upload has got: the bytes on disk. */
  async status(who: Uploader, target: Target, id: string) {
    const meta = await this.load(who, target, id);
    return { id, offset: await this.offset(id), size: meta.size };
  }

  /** Append the body at `offset`; on the last byte, `finish` moves the file into place and its answer comes back too. */
  async put(who: Uploader, target: Target, id: string, offset: number, body: AsyncIterable<Buffer>, finish: Finish) {
    const meta = await this.load(who, target, id);
    if (this.busy.has(id)) throw new HttpError(409, 'A chunk of this upload is still on its way; ask where it got to and go on from there', true);
    this.busy.add(id);
    try {
      const have = await this.offset(id);
      if (offset !== have) throw new HttpError(409, `The upload is at byte ${have}, not ${offset}`, true);
      if (have < meta.size && (await this.free(this.dir)) < this.floor) throw new HttpError(507, `The server is down to its last ${gb(this.floor)} of free space, so uploads are paused; try again once there is room`, true);
      const file = await open(this.part(id), 'r+');
      let n = 0;
      try {
        for await (const chunk of body) {
          n += chunk.length;
          if (n > CHUNK_MAX || have + n > meta.size) throw new HttpError(413, n > CHUNK_MAX ? `Chunks are at most ${CHUNK_MAX / 1024 / 1024} MiB` : 'That is more than the size the upload started with');
          await file.write(chunk, 0, chunk.length, have + n - chunk.length);
        }
      } catch (err) {
        // A connection that broke off keeps the bytes that arrived (the next PUT goes on from them); too much keeps none of this chunk.
        if (err instanceof HttpError) await file.truncate(have);
        throw err;
      } finally {
        await file.close();
      }
      if (have + n < meta.size) return { id, offset: have + n, size: meta.size };
      const done = await finish(meta, this.part(id));
      await rm(this.metaPath(id), { force: true });
      return { id, offset: meta.size, size: meta.size, done: true, ...done };
    } finally {
      this.busy.delete(id);
    }
  }

  async cancel(who: Uploader, target: Target, id: string) {
    await this.load(who, target, id);
    await this.drop(id);
  }

  private async load(who: Uploader, target: Target, id: string): Promise<Meta> {
    const meta: Meta | null = ID.test(id) ? await readFile(this.metaPath(id), 'utf8').then(JSON.parse, () => null) : null;
    // Someone else's upload, or one for another place, is as missing as one that never was.
    if (!meta || meta.uid !== who.uid || !sameTarget(meta.target, target)) throw new HttpError(404, 'No such upload: it finished, was cancelled, or sat untouched for 3 days', true);
    return meta;
  }

  private offset = async (id: string) => (await stat(this.part(id)).catch(() => null))?.size ?? 0;

  private async drop(id: string) {
    await rm(this.metaPath(id), { force: true });
    await rm(this.part(id), { force: true });
  }

  /** Remove uploads untouched for STALE_MS (and strays); the rest, with the bytes each still has to send. */
  private async sweep(): Promise<{ id: string; left: number }[]> {
    const open: { id: string; left: number }[] = [];
    const ids = new Set((await readdir(this.dir)).map((f) => f.replace(/\.(part|json)$/, '')));
    for (const id of ids) {
      const [meta, part] = await Promise.all([readFile(this.metaPath(id), 'utf8').then(JSON.parse, () => null), stat(this.part(id)).catch(() => null)]);
      if (!meta || !part || Date.now() - part.mtimeMs > STALE_MS) {
        if (ID.test(id) && !this.busy.has(id)) await this.drop(id);
        continue;
      }
      open.push({ id, left: Math.max(0, meta.size - part.size) });
    }
    return open;
  }
}

/** Move a finished .part into `dir` under its name, never over another file: " (2)" and on. */
export async function place(part: string, dir: string, name: string): Promise<string> {
  const { path, file } = await claimName(dir, name);
  await file.close();
  // rename replaces the empty file claimName made; across disks it's a copy.
  await rename(part, path).catch(async (err) => {
    if (err.code !== 'EXDEV') throw err;
    await copyFile(part, path);
    await rm(part, { force: true });
  });
  return path;
}
