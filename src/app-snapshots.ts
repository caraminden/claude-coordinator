// Snapshots of an app's DATA_DIR around a deploy that changes its migrations (#1137, docs/adr/0015-app-data-snapshots.md;
// Josh, 2026-11-19, picked "Build it" on #1093's idea A6, reversing #828's "Citadel never snapshots app data").
// A deploy whose commit changes a path the app's manifest lists under `migrations` copies its data first, with the app
// stopped, so a roll back (the failed health check's, or Roll back to last green's) can put code and data back together.
// Restoring never deletes: the data it replaces is kept as a snapshot of its own. Each app keeps its newest KEEP
// snapshots within MAX_BYTES; the ones a step just took or restored are never pruned by that step. The apps' nightly
// backups (#828's $DATA_DIR/backups/<day>/ convention) are unchanged: these are for roll backs, and never leave the box.
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { execResult } from './exec.ts';

/** How many snapshots an app keeps, newest first. */
export const KEEP = 3;
/** The most an app's snapshots may add up to (apparent size; btrfs shares the blocks of a reflinked copy). */
export const MAX_BYTES = 10 * 1024 ** 3;

export interface Snapshot {
  /** Its folder's name under the app's snapshots folder: `<time>-<commit>`. */
  id: string;
  dir: string;
  /** The commit whose code last ran on this data. */
  commit: string;
  taken_at: number;
  /** Why it was taken, for the deploy line and a person reading the folder. */
  why: string;
  bytes: number;
}

/** Beside the apps' DATA_DIRs, so a reflinked copy shares their filesystem; the dot keeps it off every app's name. */
export const snapshotsDir = (home: string, name: string) => join(home, '.local/share', `.${name}.snapshots`);

const META = 'snapshot.json';
const sh = (bin: string, args: string[], timeout = 30 * 60_000) => execResult(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 });

/** A folder's apparent size in bytes (du exits 1 on an unreadable file but still prints the total). */
export async function sizeOf(dir: string): Promise<number> {
  const r = await sh('du', ['-sbx', dir], 10 * 60_000);
  const n = Number(r.out.split('\t')[0]);
  if (!r.out || !Number.isFinite(n)) throw new Error(`couldn't measure ${dir}: ${(r.err || r.fail).trim().slice(0, 300)}`);
  return n;
}

export const human = (bytes: number) => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(0.1, bytes / 1024 ** 2).toFixed(1)} MB`;
const when = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

/** An app's snapshots, newest first. A `.part` folder (a copy cut short) isn't one, and is left for a person. */
export async function listSnapshots(root: string): Promise<Snapshot[]> {
  const names = await readdir(root).catch(() => [] as string[]);
  const out: Snapshot[] = [];
  for (const id of names) {
    if (id.endsWith('.part')) continue;
    const meta = await readFile(join(root, id, META), 'utf8').then((t) => JSON.parse(t), () => null);
    if (!meta || typeof meta.commit !== 'string' || typeof meta.taken_at !== 'number') continue;
    out.push({ id, dir: join(root, id), commit: meta.commit, taken_at: meta.taken_at, why: String(meta.why ?? ''), bytes: Number(meta.bytes) || 0 });
  }
  return out.sort((a, b) => b.taken_at - a.taken_at || (b.id < a.id ? -1 : 1));
}

/** A new snapshot's folder name, never one that's there already. */
function newId(root: string, commit: string, now: number): string {
  const base = `${new Date(now).toISOString().replace(/[:.]/g, '-')}-${commit.slice(0, 9)}`;
  let id = base;
  for (let i = 2; existsSync(join(root, id)) || existsSync(join(root, `${id}.part`)); i++) id = `${base}-${i}`;
  return id;
}

/** cp -a with reflinks where the filesystem has them: on btrfs a copy costs metadata, not the data's size. */
async function copy(from: string, to: string) {
  const r = await sh('cp', ['-a', '--reflink=auto', '--', from, to]);
  if (r.code) throw new Error(`copying ${from} failed: ${(r.err || r.fail).trim().slice(0, 500) || `exit ${r.code}`}`);
}

/**
 * Copy `data` into a new snapshot (the app is stopped meanwhile, so the copy is whole), then prune past the cap.
 * Null with a line saying why when there's nothing to copy or it's over the cap. Throws when the copy fails.
 */
export async function takeSnapshot(data: string, root: string, meta: { commit: string; why: string }, cap = { keep: KEEP, maxBytes: MAX_BYTES }, now = Date.now()): Promise<{ snap: Snapshot | null; said: string[] }> {
  if (!existsSync(data)) return { snap: null, said: [`No snapshot: ${data} isn't there yet, so there is no data to keep.`] };
  const bytes = await sizeOf(data);
  if (bytes > cap.maxBytes) return { snap: null, said: [`No snapshot: its data is ${human(bytes)}, over the ${human(cap.maxBytes)} cap, so a roll back can't bring this data back.`] };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const id = newId(root, meta.commit, now);
  const part = join(root, `${id}.part`);
  await mkdir(part, { mode: 0o700 });
  try {
    await copy(data, join(part, 'data'));
  } catch (err) {
    await rm(part, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  const snap: Snapshot = { id, dir: join(root, id), commit: meta.commit, taken_at: now, why: meta.why, bytes };
  await writeFile(join(part, META), JSON.stringify({ commit: snap.commit, taken_at: now, why: snap.why, bytes }, null, 2));
  await rename(part, snap.dir);
  return { snap, said: [`Snapshotted its data (${human(bytes)}) as ${snap.dir}.`, ...(await prune(root, [id], cap))] };
}

/**
 * Put `snap`'s data back as `data`. What's there now isn't deleted: it's moved, whole, into a snapshot of its own
 * (`now`: the commit that wrote it), which a later roll forward can't use but a person can. Then prune past the cap.
 */
export async function restoreSnapshot(data: string, root: string, snap: Snapshot, current: { commit: string; why: string }, cap = { keep: KEEP, maxBytes: MAX_BYTES }, now = Date.now()): Promise<{ said: string[]; kept: Snapshot | null }> {
  const said: string[] = [];
  const protect = [snap.id];
  let kept: Snapshot | null = null;
  // Copy first, beside the data, so a failed copy leaves the data as it was.
  const incoming = join(dirname(data), `.${basename(data)}.restoring`);
  await rm(incoming, { recursive: true, force: true });
  try {
    await copy(join(snap.dir, 'data'), incoming);
  } catch (err) {
    await rm(incoming, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  if (existsSync(data)) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const id = newId(root, current.commit, now);
    const part = join(root, `${id}.part`);
    await mkdir(part, { mode: 0o700 });
    const bytes = await sizeOf(data).catch(() => 0);
    await writeFile(join(part, META), JSON.stringify({ commit: current.commit, taken_at: now, why: current.why, bytes }, null, 2));
    await rename(data, join(part, 'data'));
    await rename(part, join(root, id));
    kept = { id, dir: join(root, id), commit: current.commit, taken_at: now, why: current.why, bytes };
    protect.push(id);
    said.push(`Kept the data it had (${human(bytes)}) as ${join(root, id)}.`);
  }
  await rename(incoming, data);
  said.push(`Restored its data from the snapshot taken ${when(snap.taken_at)} at ${snap.commit.slice(0, 9)} (${snap.dir}): anything it wrote since is in the kept copy, not in the app.`);
  return { said: [...said, ...(await prune(root, protect, cap))], kept };
}

/** Remove the oldest snapshots past the cap (KEEP of them, MAX_BYTES together), never one in `protect`; says what goes and what's kept. */
export async function prune(root: string, protect: string[], cap = { keep: KEEP, maxBytes: MAX_BYTES }): Promise<string[]> {
  const all = await listSnapshots(root);
  const kept: Snapshot[] = all.filter((s) => protect.includes(s.id));
  let total = kept.reduce((n, s) => n + s.bytes, 0);
  const gone: Snapshot[] = [];
  for (const s of all) {
    if (protect.includes(s.id)) continue;
    if (kept.length < cap.keep && total + s.bytes <= cap.maxBytes) {
      kept.push(s);
      total += s.bytes;
    } else gone.push(s);
  }
  for (const s of gone) await rm(s.dir, { recursive: true, force: true });
  if (!gone.length) return [];
  return [`Removed ${gone.length} older snapshot${gone.length > 1 ? 's' : ''} past the cap (${cap.keep} kept, ${human(cap.maxBytes)} at most): ${gone.map((s) => s.id).join(', ')}. Kept: ${kept.map((s) => s.id).join(', ')}.`];
}
