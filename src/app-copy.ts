// copy_app_data (#1884): a private, throwaway copy of an app's live data, for a minion of its home scheme to try a
// migration on. Josh, 2026-11-25, picked "Copy into the turn" and "Any home scheme member" on #1884's card.
//   - The child (src/app-copy-run.ts) copies into `<data dir>/run/app-copies/<minion>-<ms>`, which no container mounts;
//     the finished copy is then renamed into the asking turn's own folder (`<turn>/app-copy/<app>`): a container turn's is
//     mounted only in its person's container, and the server deletes it when the turn ends, fails or is killed (dropTurnDir),
//     or at the next start after a crash. A turn that ends mid-copy stops the child, and what it copied goes.
//   - The turn's tripwire lets it write there (TripwireConfig.copies) and nowhere else in the live data dir.
//   - Everyone's rows come along, so each copy leaves a line in the chat naming who asked.
import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_BYTES } from './app-snapshots.ts';
import { HttpError, json, readJson, type Ctx } from './http.ts';
import type { Store, Ticket } from './db.ts';
import type { CopyResult } from './mcp-text.ts';
import { thrown } from './thrown.ts';
import { COPIES } from './tripwire-base.ts';

export interface CopyAsk {
  from: string;
  to: string;
  /** The other files too, not only the databases. */
  files: boolean;
  /** The most it may take, in bytes. */
  cap: number;
  /** The disk space it must leave free, in bytes. */
  spare: number;
}
/** The disk a copy leaves free: a database's copy shares no blocks with the live one. */
const SPARE = 10 * 1024 ** 3;
/** Under the 5 minutes the MCP tool's fetch waits for an answer. */
const TIMEOUT_MS = 4 * 60_000;

/** Why this minion's turn may not copy that app's data, or null. */
export function copyRefusal(store: Store, ticket: Pick<Ticket, 'id' | 'project_id'>, name: string): string | null {
  const c = store.getContraption(name);
  if (!c || c.home_scheme === null || c.home_scheme !== ticket.project_id) return `${name} isn't one of this scheme's contraptions: only a minion in an app's home scheme may copy its data. Ask that scheme's Taskmaster.`;
  const id = store.turnAsker(ticket.id);
  const user = id === null ? undefined : store.getUser(id);
  if (!user || user.disabled_at) return `A copy of ${c.title}'s data needs a turn someone asked for, and this one is no one's ask. Ask a member of this scheme to send the request in this chat.`;
  // Membership itself, not canSee: the copy holds everyone's rows, and the pick was the home scheme's members.
  if (!store.inScheme(user.id, c.home_scheme)) return `${user.name} isn't a member of ${store.getProject(c.home_scheme)!.name}, ${c.title}'s home scheme: a copy of its data needs a member's ask. Ask a member to send the request in this chat.`;
  return null;
}

/** Run the copying child; a failed or stopped one leaves nothing at `to`. */
export async function runCopy({ signal, ...ask }: CopyAsk & { signal?: AbortSignal }): Promise<CopyResult> {
  try {
    const out = await new Promise<string>((ok, fail) => {
      const child = execFile(process.execPath, [join(import.meta.dirname, 'app-copy-run.ts'), JSON.stringify(ask)], { timeout: TIMEOUT_MS, killSignal: 'SIGKILL', signal, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        // execFile reports a stop before the child has gone: what it copied is only removed once it can't write more.
        const done = () => (err ? fail(new Error(err.killed ? `The copy took over ${TIMEOUT_MS / 60_000} minutes` : stderr.trim().slice(-500) || err.message, { cause: err })) : ok(stdout));
        if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) done();
        else child.once('exit', done);
      });
    });
    const r = JSON.parse(out) as CopyResult & { error?: string };
    if (r.error) throw new Error(r.error);
    return r;
  } catch (err) {
    await rm(ask.to, { recursive: true, force: true });
    throw err;
  }
}

const copiesRoot = (dataDir: string) => join(dataDir, 'run', 'app-copies');

/** Remove half-made copies a crash left (a finished one sits in its turn's folder, which has its own sweep): those begun before `before`, so a new one is never touched. */
export async function sweepAppCopies(dataDir: string, before = Date.now()): Promise<void> {
  const root = copiesRoot(dataDir);
  for (const n of await readdir(root).catch(() => [] as string[])) if (Number(n.split('-')[1]) < before) await rm(join(root, n), { recursive: true, force: true });
}

/** One copy at a time: two could each find room on the disk and together take what must stay free. */
let copying = false;

export async function copyAppData({ req, res, app, params, caller }: Ctx) {
  const { store, runner } = app;
  const ticket = caller!;
  const { files } = ((await readJson(req)) ?? {}) as { files?: unknown };
  if (files !== undefined && typeof files !== 'boolean') throw new HttpError(400, 'files must be true or false');
  const refused = copyRefusal(store, ticket, params.app);
  if (refused) throw new HttpError(403, refused);
  const c = store.getContraption(params.app)!;
  const asker = store.getUser(store.turnAsker(ticket.id)!)!;
  const turn = runner.turnFolder(ticket.id);
  if (!turn) throw new HttpError(409, 'The turn that asked has ended');
  if (copying) throw new HttpError(409, "Another copy of an app's data is under way, and one runs at a time: try again in a minute");
  copying = true;
  const ended = new AbortController();
  // Stopped within a second of the turn's end, however it ended.
  const watch = setInterval(() => runner.turnFolder(ticket.id) !== turn && ended.abort(), 1000);
  const root = copiesRoot(app.dataDir);
  const part = join(root, `${ticket.id}-${Date.now()}`);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const r = await runCopy({ from: app.services.dataDir(c), to: part, files: files === true, cap: MAX_BYTES, spare: SPARE, signal: ended.signal });
    const dir = join(turn, COPIES, c.name);
    if (runner.turnFolder(ticket.id) !== turn) throw new Error('the turn ended');
    // Never recursive: once the turn's folder is gone (renamed aside, dropTurnDir), nothing here may make it again.
    await mkdir(join(turn, COPIES), { mode: 0o700 }).catch((err) => {
      if (err.code !== 'EEXIST') throw err;
    });
    await rm(dir, { recursive: true, force: true });
    await rename(part, dir);
    runner.emit(ticket.id, 'note', { text: `${asker.name}'s turn took a private copy of the live data of ${c.title} (everyone's rows) to try something on; it is deleted when the turn ends.` });
    json(res, 200, { ...r, dir });
  } catch (err) {
    if (ended.signal.aborted || runner.turnFolder(ticket.id) !== turn) throw new HttpError(409, 'The turn that asked has ended, so its copy was removed');
    throw new HttpError(409, `No copy was made. ${thrown(err).message}`);
  } finally {
    clearInterval(watch);
    await rm(part, { recursive: true, force: true });
    copying = false;
  }
}
