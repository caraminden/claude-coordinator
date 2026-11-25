// Claude Code keeps what a session needs to resume (its transcript, saved tool output, task list
// and the project's auto-memory) under its config dir, which belongs to one account on one machine.
// These copy that state into the app's database after each turn and put it back before the next,
// so a thread survives a switch of Claude account or config dir.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { isMainThread, parentPort, threadId, Worker, workerData } from 'node:worker_threads';
import { gunzip as gunzipCb, gunzipSync, gzip, gzipSync } from 'node:zlib';
import { track } from './settled.ts';
import { StateDb, type ClaudeStateRow, type Project, type Store, type Ticket } from './db.ts';

const gz = promisify(gzip);
const gunzip = promisify(gunzipCb);

export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/**
 * A Claude session id fit to be a file name and an argument. They come from a turn's stream, which a person's
 * container can write, and are joined into paths here: nothing with a separator or dots, nor a leading dash.
 */
export function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^\w[\w-]*$/.test(id);
}

/** Claude Code's folder name for a working directory under `projects/`. */
export function projectSlug(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Fold a Taskmaster's old auto-memory (under its own working folder) into the scheme's repo memory,
 * which is its auto-memory now, then rename the old folder so this runs once. A note never replaces
 * one already there: a clashing name lands as `taskmaster-<name>`. Index lines the repo's MEMORY.md
 * lacks are appended. Safe to run again if the old folder comes back from the database.
 */
export function mergeMemory(oldDir: string, memoryDir: string): number {
  if (oldDir === memoryDir || !existsSync(oldDir)) return 0;
  mkdirSync(memoryDir, { recursive: true });
  let index = '';
  let copied = 0;
  const renamed: [string, string][] = [];
  for (const name of readdirSync(oldDir)) {
    const from = join(oldDir, name);
    if (!statSync(from).isFile()) continue;
    if (name === 'MEMORY.md') {
      index = readFileSync(from, 'utf8');
      continue;
    }
    const text = readFileSync(from, 'utf8');
    let to = name;
    if (existsSync(join(memoryDir, to)) && readFileSync(join(memoryDir, to), 'utf8') !== text) to = `taskmaster-${name}`;
    if (to !== name) renamed.push([name, to]);
    if (!existsSync(join(memoryDir, to))) {
      writeFileSync(join(memoryDir, to), text);
      copied++;
    }
  }
  const target = join(memoryDir, 'MEMORY.md');
  const have = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const lines = index
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => renamed.reduce((s, [a, b]) => s.replaceAll(`](${a})`, `](${b})`), l));
  const missing = lines.filter((l) => !have.includes(l));
  if (missing.length) writeFileSync(target, `${have}${have && !have.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
  renameSync(oldDir, `${oldDir}-merged-${Date.now()}`);
  return copied;
}

interface Scope {
  /** Rows that belong to this ticket alone, in the turn's config dir. */
  ticketRoots: string[];
  /** A memory folder the ticket's cwd has to itself, when it isn't the scheme's. */
  ownMemory: string | null;
  /** The scheme's memory folder. The server's own one is the truth, whichever login a turn ran on (#1952). */
  sharedMemory: string | null;
}

/** What a ticket's session reads on resume, as paths relative to the config dir (files or folders). */
function scope(ticket: Ticket, project: Project): Scope {
  const cwdSlug = projectSlug(ticket.cwd);
  // Sessions in a git worktree keep auto-memory under the main checkout's folder, shared by the project.
  const sharedMemory = project.repo_dir ? join('projects', projectSlug(project.repo_dir), 'memory') : null;
  const cwdMemory = join('projects', cwdSlug, 'memory');
  const ownMemory = cwdMemory === sharedMemory ? null : cwdMemory;
  const ticketRoots = ownMemory ? [ownMemory] : [];
  if (validSessionId(ticket.session_id)) {
    ticketRoots.push(
      join('projects', cwdSlug, `${ticket.session_id}.jsonl`),
      join('projects', cwdSlug, ticket.session_id), // saved tool output, subagent transcripts
      join('tasks', ticket.session_id), // the task list behind the progress readout
    );
  }
  return { ticketRoots, ownMemory, sharedMemory };
}

const under = (root: string | null, path: string) => root !== null && (path === root || path.startsWith(root + sep));

/** The files under a root; null when a link leads it out of the config dir, which says nothing about what was deleted. */
async function listFiles(configDir: string, root: string): Promise<string[] | null> {
  const abs = join(configDir, root);
  let st;
  try {
    // A person's container owns its volume and can plant links there: none is followed, as the last name or on
    // the way to it, or the server would read a host file into the database and a restore would hand it over.
    if (!(await realpath(abs)).startsWith((await realpath(configDir)) + sep)) return null;
    st = await lstat(abs);
  } catch (err) {
    // Only "not there" is a missing folder: one that can't be read says nothing about what was deleted.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  if (st.isFile()) return [root];
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of await readdir(abs, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.push(relative(configDir, join(entry.parentPath, entry.name)));
  }
  return out;
}

/** The files under a root with their mtimes, rounded as rows store them; null as listFiles. */
async function fileTimes(configDir: string, root: string): Promise<Map<string, number> | null> {
  const files = await listFiles(configDir, root);
  if (!files) return null;
  const out = new Map<string, number>();
  for (const path of files) {
    const st = await stat(join(configDir, path)).catch(() => null);
    if (st) out.set(path, Math.round(st.mtimeMs));
  }
  return out;
}

/** What a memory folder held (path to mtime) when it was last matched up: a note it held then and lacks now was deleted. */
type Seen = Record<string, number>;
const seenKey = (configDir: string, root: string) => `memory-seen:${join(configDir, root)}`;
function putSeen(store: Store, key: string, seen: Seen) {
  const was = store.getSetting<Seen>(key);
  if (!was && !Object.keys(seen).length) return;
  if (JSON.stringify(was) !== JSON.stringify(seen)) store.setSetting(key, seen);
}

/** Set while the server's empty memory folder is refilled from the database, so a refill cut off goes on. */
const refillKey = (project: Project) => `memory-refill:${project.id}`;

/**
 * Match a config dir's copy of the scheme's memory up with the server's folder, when it isn't the same folder: a
 * container started before the scheme was made lacks the mount, and an account's folder may not be linked. Only what
 * changed in the copy since the last time goes to the server, so a copy of a note deleted there never brings it back.
 * (A container with the mount has such a copy too, on the host's side, under the mount: nothing changes in it.)
 */
async function syncMemory(store: Store, project: Project, root: string, configDir: string) {
  const server = claudeConfigDir(process.env);
  const real = (dir: string) => realpath(join(dir, root)).catch(() => null);
  const [a, b] = await Promise.all([real(configDir), real(server)]);
  if (a === b) return;
  const [here, there] = await Promise.all([fileTimes(configDir, root), fileTimes(server, root)]);
  if (!here || !there) return;
  const key = seenKey(configDir, root);
  // Never matched up (from before #1952): its notes are old copies. Empty: a new volume.
  const seen: Seen = here.size ? (store.getSetting<Seen>(key) ?? Object.fromEntries(here)) : {};
  const next: Seen = {};
  const copy = async (from: string, to: string, path: string, mtime: number) => placeFile(to, path, await readFile(join(from, path)), mtime);
  for (const [path, mtime] of here) {
    next[path] = mtime;
    if (seen[path] === mtime) continue;
    const theirs = there.get(path);
    // Known here before and gone there: deleted on the server, and the delete stands.
    if (theirs === undefined ? seen[path] !== undefined : theirs >= mtime) continue;
    await copy(configDir, server, path, mtime);
    there.set(path, mtime);
  }
  for (const [path, mtime] of there) {
    const mine = here.get(path);
    if (mine === undefined && seen[path] >= mtime)
      next[path] = seen[path]; // deleted here
    else if (mine === undefined || mine < mtime) {
      await copy(server, configDir, path, mtime);
      next[path] = mtime;
    }
  }
  putSeen(store, key, next);
}

/**
 * Copy a ticket's session state from the config dir into the database, and the scheme's memory from the server's folder. A file only replaces a row
 * when it is newer: a login holding an older copy (the boot sweep on the host, after turns ran in a
 * container) never rolls the database back (#259). `prunable` is what the turn's config dir held
 * when it started (storedPaths, after restoreSession): only those rows may be dropped, when their
 * file has gone since or they belong to an earlier session. A row the config dir never had (another
 * login's new memory note) is no proof of anything, so it stays. Null prunes nothing.
 * The scheme's memory is the server's folder: a row stored at the start whose note isn't there now was deleted.
 */
export async function saveSession(store: Store, ticket: Ticket, project: Project, configDir: string, prunable: Set<string> | null) {
  const { ticketRoots, ownMemory, sharedMemory } = scope(ticket, project);
  if (sharedMemory) await syncMemory(store, project, sharedMemory, configDir);
  const seenOwn = ownMemory ? store.getSetting<Seen>(seenKey(configDir, ownMemory)) : null;
  for (const [roots, ticketId, from] of [
    [ticketRoots, ticket.id, configDir],
    [sharedMemory ? [sharedMemory] : [], null, claudeConfigDir(process.env)],
  ] as const) {
    const seen = new Set<string>();
    const unread: string[] = [];
    const puts: Put[] = [];
    for (const root of roots) {
      const files = await listFiles(from, root);
      // A memory folder gone whole (a disk that isn't mounted) proves no delete either: the next turn's start refills it.
      if (!files || (ticketId === null && !existsSync(join(from, root)))) unread.push(root);
      for (const path of files ?? []) {
        seen.add(path);
        let st;
        try {
          st = await stat(join(from, path));
        } catch {
          continue;
        }
        const mtime = Math.round(st.mtimeMs);
        const row = store.getClaudeState(path);
        if (row && (row.mtime > mtime || (row.mtime === mtime && row.size === st.size))) continue;
        // An old copy of a note another login deleted.
        if (!row && under(ownMemory, path) && seenOwn?.[path] === mtime) continue;
        puts.push({ row: { path, project_id: project.id, ticket_id: ticketId, size: st.size, mtime }, file: join(from, path) });
      }
    }
    await putFiles(store, puts);
    if (!prunable) continue;
    // A config dir without the session's transcript (a restore that failed) doesn't hold everything: keep the database's copy.
    const transcript = ticket.session_id ? transcriptPath(configDir, ticket.cwd, ticket.session_id) : null;
    if (ticketId !== null && ticket.session_id && !(transcript && existsSync(transcript))) continue;
    const rows = ticketId === null ? store.listClaudeState(project.id, null) : store.listClaudeState(project.id, ticketId);
    for (const row of rows) {
      const inRoots = roots.some((r) => under(r, row.path));
      // A row this turn's config dir held at its start that is outside the current roots (an earlier session id) or whose file was deleted since: drop it.
      if (unread.some((r) => under(r, row.path))) continue;
      if (prunable.has(row.path) && (!inRoots || !seen.has(row.path))) store.deleteClaudeState(row.path);
    }
  }
}

/** A file saveSession stores: its row without the data, which is the file gzipped. */
interface Put {
  row: Omit<ClaudeStateRow, 'data'>;
  file: string;
}

/** Store each file, on a worker thread (sessionWorker): writing a 60 MB row held the event loop for seconds (#612). */
async function putFiles(store: Store, puts: Put[]) {
  if (!puts.length) return;
  if (store.statePath) return void (await sessionWorker(store.statePath, { kind: 'put', puts }));
  // An in-memory store (tests) has no file a second connection could open.
  for (const { row, file } of puts) store.putClaudeState({ ...row, data: await gz(await readFile(file)) });
}

/** A stored file to write back, and the config dir it goes in. */
interface Stale {
  path: string;
  configDir: string;
}

/**
 * The stored files of a ticket's session that the config dir lacks or holds an older copy of, but for a note of its own
 * memory folder deleted there; and all of the scheme's memory that the server's folder lacks, when that is empty (a
 * fresh machine). Otherwise that folder is the truth: a note missing from it was deleted (#1952). Only stats, with
 * fs/promises (#1808).
 */
async function staleRows(store: Store, ticket: Ticket, project: Project, configDir: string): Promise<Stale[]> {
  const { ownMemory, sharedMemory } = scope(ticket, project);
  const all = [...store.listClaudeState(project.id, ticket.id), ...store.listClaudeState(project.id, null)];
  const stale: Stale[] = [];
  const server = claudeConfigDir(process.env);
  const notes = all.filter((r) => under(sharedMemory, r.path) && join(server, r.path).startsWith(server + sep));
  const held = notes.length ? await listFiles(server, sharedMemory!) : null;
  if (held && (!held.length || store.getSetting(refillKey(project)))) {
    store.setSetting(refillKey(project), true);
    stale.push(...notes.filter((r) => !held.includes(r.path)).map((r) => ({ path: r.path, configDir: server })));
  }
  const rows = all.filter((r) => !under(sharedMemory, r.path) && join(configDir, r.path).startsWith(configDir + sep));
  const own = rows.some((r) => under(ownMemory, r.path)) && (await listFiles(configDir, ownMemory!))?.length ? store.getSetting<Seen>(seenKey(configDir, ownMemory!)) : null;
  const mtimes = await Promise.all(
    rows.map((meta) =>
      stat(join(configDir, meta.path)).then(
        (st) => st.mtimeMs,
        () => null,
      ),
    ),
  );
  // Rounded as saveSession stores it: unrounded, a file whose mtime rounded up looked older than its own copy,
  // so each turn after one wrote its transcript back on the same login (#612).
  const missing = (r: ClaudeStateRow) => !(under(ownMemory, r.path) && (own?.[r.path] ?? -1) >= r.mtime);
  stale.push(...rows.filter((r, i) => (mtimes[i] === null ? missing(r) : Math.round(mtimes[i]) < r.mtime)).map((r) => ({ path: r.path, configDir })));
  return stale;
}

/** The part file a restore writes before its rename: one name per restore in this process and thread, so two restores at once never share one (#1808). */
let parts = 0;
const partFile = (configDir: string) => join(configDir, `.citadel-restore-${process.pid}-${threadId}-${++parts}`);

/** Write a file under a config dir whole, with fs/promises: writeBack's way, for the event loop's thread (#1808). */
async function placeFile(configDir: string, path: string, data: Uint8Array, mtime: number) {
  const abs = join(configDir, path);
  await mkdir(dirname(abs), { recursive: true, mode: 0o700 });
  const part = partFile(configDir);
  await writeFile(part, data, { mode: 0o600 });
  await utimes(part, new Date(mtime), new Date(mtime));
  try {
    await rename(part, abs);
  } catch (err) {
    await rm(part, { force: true });
    throw err;
  }
}

/** Write each stored path back under its config dir, as of its row now. Returns how many files it wrote. On the session worker's thread. */
function writeBack(get: (path: string) => { data?: Uint8Array | null; mtime: number } | undefined, files: Stale[]): number {
  let written = 0;
  for (const { path, configDir } of files) {
    const row = get(path);
    if (!row?.data) continue;
    const abs = join(configDir, path);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    // Whole or not at all: a half-written file has a new mtime, so a turn (or the next save) would take it for the latest.
    // Outside the saved folders, so one a crash leaves behind is never saved; the config dir is one filesystem.
    const part = partFile(configDir);
    writeFileSync(part, gunzipSync(row.data), { mode: 0o600 });
    utimesSync(part, new Date(row.mtime), new Date(row.mtime));
    try {
      renameSync(part, abs);
    } catch (err) {
      rmSync(part, { force: true });
      throw err;
    }
    written++;
  }
  return written;
}

/**
 * Write back any of a ticket's stored session state that the config dir is missing or has an older copy of, just
 * before the turn's process starts. Normally it only stats, as restoreAhead has put back what was missing; what it
 * writes, it writes as writeBack does, with fs/promises (#1808). Returns how many files it wrote.
 */
export async function restoreSession(store: Store, ticket: Ticket, project: Project, configDir: string): Promise<number> {
  let written = 0;
  for (const { path, configDir: to } of await staleRows(store, ticket, project, configDir)) {
    const row = store.getClaudeState(path, true);
    if (!row?.data) continue;
    await placeFile(to, path, await gunzip(row.data), row.mtime);
    written++;
  }
  if (store.getSetting(refillKey(project))) store.deleteSetting(refillKey(project));
  const { ownMemory, sharedMemory } = scope(ticket, project);
  if (sharedMemory) await syncMemory(store, project, sharedMemory, configDir);
  const own = ownMemory && (await fileTimes(configDir, ownMemory));
  if (own) {
    const key = seenKey(configDir, ownMemory);
    // A stored note that isn't there after the restore was deleted there: still known.
    const was = store.getSetting<Seen>(key) ?? {};
    const gone = store.listClaudeState(project.id, ticket.id).filter((r) => under(ownMemory, r.path) && !own.has(r.path) && r.path in was);
    putSeen(store, key, { ...Object.fromEntries(own), ...Object.fromEntries(gone.map((r) => [r.path, was[r.path]])) });
  }
  return written;
}

/**
 * restoreSession's reads, gunzips and writes on a worker thread, run before the turn starts: a 60 MB transcript
 * held the event loop for seconds (#612). Resolves to how many files it wrote, 0 with nothing to restore (no worker);
 * a failure rejects, and restoreSession then tries again and reports it.
 */
export async function restoreAhead(store: Store, ticket: Ticket, project: Project, configDir: string): Promise<number> {
  const files = await staleRows(store, ticket, project, configDir);
  if (!files.length || !store.statePath) return 0;
  return sessionWorker(store.statePath, { kind: 'restore', files }) as Promise<number>;
}

type Job = { kind: 'restore'; files: Stale[] } | { kind: 'put'; puts: Put[] };

/** Run a job on a worker thread of its own, with its own connection to state.db. */
function sessionWorker(statePath: string, job: Job): Promise<unknown> {
  return track(
    job.kind === 'put' ? 'session save threads' : 'session restore threads',
    new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { sessionJob: { statePath, job } } });
      worker.once('message', resolve);
      worker.once('error', reject);
      // After a message this is a no-op; without one the worker died before it finished.
      worker.once('exit', (code) => reject(new Error(`the session worker stopped (exit code ${code}) before it finished`)));
    }),
  );
}

if (!isMainThread && workerData?.sessionJob) {
  const { statePath, job } = workerData.sessionJob as { statePath: string; job: Job };
  const state = new StateDb(statePath);
  try {
    if (job.kind === 'restore') parentPort!.postMessage(writeBack((path) => state.getData(path), job.files));
    else {
      for (const { row, file } of job.puts) state.put({ ...row, data: gzipSync(readFileSync(file)) });
      parentPort!.postMessage(job.puts.length);
    }
  } finally {
    state.close();
  }
}

/** The paths of a ticket's stored session state and its project's shared memory: after a restore that worked, one whose file isn't there was deleted. */
export function storedPaths(store: Store, ticket: Ticket, project: Project): Set<string> {
  return new Set([...store.listClaudeState(project.id, ticket.id), ...store.listClaudeState(project.id, null)].map((r) => r.path));
}

/** Where Claude Code keeps a session's transcript, for a turn run in `cwd`; null for an id that isn't one (validSessionId). */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string | null {
  if (!validSessionId(sessionId)) return null;
  return join(configDir, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

/**
 * The effort level the session's latest reply ran at, read from the end of its transcript (the
 * stream Claude Code prints doesn't report it). Null if there is no transcript or no effort in it.
 */
export function lastEffort(ticket: Ticket, configDir: string): string | null {
  if (!ticket.session_id || !ticket.cwd) return null;
  const path = transcriptPath(configDir, ticket.cwd, ticket.session_id);
  if (!path) return null;
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const all = [...buf.toString('utf8').matchAll(/"effort":"([a-z]+)"/g)];
    return all.length ? all[all.length - 1][1] : null;
  } finally {
    closeSync(fd);
  }
}
