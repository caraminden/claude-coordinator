// Claude Code keeps what a session needs to resume (its transcript, saved tool output, task list
// and the project's auto-memory) under its config dir, which belongs to one account on one machine.
// These copy that state into the app's database after each turn and put it back before the next,
// so a thread survives a switch of Claude account or config dir.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import { isMainThread, parentPort, threadId, Worker, workerData } from 'node:worker_threads';
import { gunzipSync, gzip, gzipSync } from 'node:zlib';
import { track } from './settled.ts';
import { StateDb, type ClaudeStateRow, type Project, type Store, type Ticket } from './db.ts';

const gz = promisify(gzip);

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
  /** Rows that belong to this ticket alone; the rest of `roots` are the project's shared memory. */
  ticketRoots: string[];
  projectRoots: string[];
}

/** What a ticket's session reads on resume, as paths relative to the config dir (files or folders). */
function scope(ticket: Ticket, project: Project): Scope {
  const cwdSlug = projectSlug(ticket.cwd);
  const ticketRoots = [join('projects', cwdSlug, 'memory')];
  if (validSessionId(ticket.session_id)) {
    ticketRoots.push(
      join('projects', cwdSlug, `${ticket.session_id}.jsonl`),
      join('projects', cwdSlug, ticket.session_id), // saved tool output, subagent transcripts
      join('tasks', ticket.session_id), // the task list behind the progress readout
    );
  }
  // Sessions in a git worktree keep auto-memory under the main checkout's folder, shared by the project.
  const projectRoots = project.repo_dir ? [join('projects', projectSlug(project.repo_dir), 'memory')] : [];
  return { ticketRoots, projectRoots };
}

/** The files under a root; null when a link leads it out of the config dir, which says nothing about what was deleted. */
async function listFiles(configDir: string, root: string): Promise<string[] | null> {
  const abs = join(configDir, root);
  let st;
  try {
    // A person's container owns its volume and can plant links there: none is followed, as the last name or on
    // the way to it, or the server would read a host file into the database and a restore would hand it over.
    if (!(await realpath(abs)).startsWith((await realpath(configDir)) + sep)) return null;
    st = await lstat(abs);
  } catch {
    return [];
  }
  if (st.isFile()) return [root];
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  for (const entry of await readdir(abs, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) out.push(relative(configDir, join(entry.parentPath, entry.name)));
  }
  return out;
}

/**
 * Copy a ticket's session state from the config dir into the database. A file only replaces a row
 * when it is newer: a login holding an older copy (the boot sweep on the host, after turns ran in a
 * container) never rolls the database back (#259). `prunable` is what the turn's config dir held
 * when it started (storedPaths, after restoreSession): only those rows may be dropped, when their
 * file has gone since or they belong to an earlier session. A row the config dir never had (another
 * login's new memory note) is no proof of anything, so it stays. Null prunes nothing.
 */
export async function saveSession(store: Store, ticket: Ticket, project: Project, configDir: string, prunable: Set<string> | null) {
  const { ticketRoots, projectRoots } = scope(ticket, project);
  for (const [roots, ticketId] of [
    [ticketRoots, ticket.id],
    [projectRoots, null],
  ] as const) {
    const seen = new Set<string>();
    const unread: string[] = [];
    const puts: Put[] = [];
    for (const root of roots) {
      const files = await listFiles(configDir, root);
      if (!files) unread.push(root);
      for (const path of files ?? []) {
        seen.add(path);
        let st;
        try {
          st = await stat(join(configDir, path));
        } catch {
          continue;
        }
        const mtime = Math.round(st.mtimeMs);
        const row = store.getClaudeState(path);
        if (row && (row.mtime > mtime || (row.mtime === mtime && row.size === st.size))) continue;
        puts.push({ row: { path, project_id: project.id, ticket_id: ticketId, size: st.size, mtime }, file: join(configDir, path) });
      }
    }
    await putFiles(store, puts);
    if (!prunable) continue;
    // A config dir without the session's transcript (a restore that failed) doesn't hold everything: keep the database's copy.
    const transcript = ticket.session_id ? transcriptPath(configDir, ticket.cwd, ticket.session_id) : null;
    if (ticketId !== null && ticket.session_id && !(transcript && existsSync(transcript))) continue;
    const rows = ticketId === null ? store.listClaudeState(project.id, null) : store.listClaudeState(project.id, ticketId);
    for (const row of rows) {
      const inRoots = roots.some((r) => row.path === r || row.path.startsWith(r + sep));
      // A row this turn's config dir held at its start that is outside the current roots (an earlier session id) or whose file was deleted since: drop it.
      if (unread.some((r) => row.path === r || row.path.startsWith(r + sep))) continue;
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

/** The stored paths of a ticket's session state (and its project's memory) that the config dir lacks or holds an older copy of. Only stats. */
function staleRows(store: Store, ticket: Ticket, project: Project, configDir: string): string[] {
  const stale: string[] = [];
  for (const meta of [...store.listClaudeState(project.id, ticket.id), ...store.listClaudeState(project.id, null)]) {
    const abs = join(configDir, meta.path);
    if (!abs.startsWith(configDir + sep)) continue;
    // Rounded as saveSession stores it: unrounded, a file whose mtime rounded up looked older than its own copy,
    // so each turn after one wrote its transcript back on the same login (#612).
    if (existsSync(abs) && Math.round(statSync(abs).mtimeMs) >= meta.mtime) continue;
    stale.push(meta.path);
  }
  return stale;
}

/** Write each stored path back under the config dir, as of its row now. Returns how many files it wrote. */
function writeBack(get: (path: string) => { data?: Uint8Array | null; mtime: number } | undefined, configDir: string, paths: string[]): number {
  let written = 0;
  for (const path of paths) {
    const row = get(path);
    if (!row?.data) continue;
    const abs = join(configDir, path);
    mkdirSync(dirname(abs), { recursive: true, mode: 0o700 });
    // Whole or not at all: a half-written file has a new mtime, so a turn (or the next save) would take it for the latest.
    // Outside the saved folders, so one a crash leaves behind is never saved; the config dir is one filesystem.
    const part = join(configDir, `.citadel-restore-${process.pid}-${threadId}-${written}`);
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
 * Write back any of a ticket's stored session state that the config dir is missing or has an older
 * copy of. Synchronous, since it runs just before the turn's process starts; normally it only stats,
 * as restoreAhead has put back what was missing. Returns how many files it wrote.
 */
export function restoreSession(store: Store, ticket: Ticket, project: Project, configDir: string): number {
  return writeBack((path) => store.getClaudeState(path, true), configDir, staleRows(store, ticket, project, configDir));
}

/**
 * restoreSession's reads, gunzips and writes on a worker thread, run before the turn starts: a 60 MB transcript
 * held the event loop for seconds (#612). Null when there is nothing to restore, so the turn starts at once.
 * Resolves to how many files it wrote; a failure rejects, and restoreSession then tries again and reports it.
 */
export function restoreAhead(store: Store, ticket: Ticket, project: Project, configDir: string): Promise<number> | null {
  const paths = staleRows(store, ticket, project, configDir);
  if (!paths.length || !store.statePath) return null;
  return sessionWorker(store.statePath, { kind: 'restore', configDir, paths }) as Promise<number>;
}

type Job = { kind: 'restore'; configDir: string; paths: string[] } | { kind: 'put'; puts: Put[] };

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
    if (job.kind === 'restore') parentPort!.postMessage(writeBack((path) => state.getData(path), job.configDir, job.paths));
    else {
      for (const { row, file } of job.puts) state.put({ ...row, data: gzipSync(readFileSync(file)) });
      parentPort!.postMessage(job.puts.length);
    }
  } finally {
    state.close();
  }
}

/** The paths of a ticket's stored session state and its project's shared memory: after a restore that worked, all are in the config dir. */
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
