// A turn placed on a connected machine (Build 7 T2, shared/project/specs/worker-machines.md section 3). The server
// builds the turn's folder as for any turn and keeps reading its own copy; the machine's agent (public/machine-worker.mjs)
// downloads it, runs the turn's wrapper in a worker container there, and keeps the two copies in step through one call it
// makes about every half second (`sync`): the stream and stderr up, appended only at the size this copy already has, the
// small files up whole, steers and signals down. Everything is asked for by the agent and kept in the folder, so a
// restart of this server or a dropped connection loses nothing: the agent sends again from the size it is told.
//
// A machine turn's folder holds a `machine` file (as a container turn's holds `container`): which machine, and what its
// agent needs to start it. Its `signals` file is every signal asked of it, one a line; the agent applies those past the
// count it has applied, so a stop asked while the machine is away is applied when it returns.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { appendFile, readFile, rename, stat, utimes, writeFile } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import { basename, isAbsolute, join, normalize } from 'node:path';
import type { ProcCheck } from './quiet.ts';
import type { RunningTurn } from './running-turn.ts';

/** What the agent needs to start the turn: all of it paths and argv as they are on the server, the same in its container. */
export interface MachineLaunch {
  /** `<node> <pin>/turn-wrapper.mjs <dir>`, the command a container turn's `podman exec` runs. */
  wrapper: string[];
  cwd: string | null;
  /** The person's home, where the sign-in lives on the machine: a volume there, never sent. */
  home: string;
  /** The folders the turn's paths sit under, each a bind mount at the same path in the machine's container. */
  roots: string[];
}

/** A turn folder's `machine` file. */
export interface Placed extends MachineLaunch {
  id: number;
  name: string;
}

/** What a machine's agent last said of itself as a worker. */
export interface WorkerInfo {
  /** `claude --version` in its worker container, or null when it couldn't say. */
  claude: string | null;
  /** Its owner's cap on turns at once. */
  max: number;
  at: number;
}

/** The machines' connections, set by the server at start (server.ts): a module here reads them without holding the relay. */
export const machineLink = {
  /** The machine's agent is connected. */
  online: (_machineId: number): boolean => false,
  /** Hurry its agent's next sync. Lost is fine: it syncs by itself within a second. */
  poke: (_machineId: number): void => {},
};

/** The turns the runner follows on each machine, by folder: filled as the runner asks about them (MachineTurn), so a restart rebuilds it. */
const placed = new Map<number, Set<string>>();
const workers = new Map<number, WorkerInfo>();

/** A machine turn's sync counts as its heartbeat; one silent this long, with its agent connected, is gone. */
const BEAT_STALE_MS = 30_000;
/** The agent's copy of these only grows: sent as bytes past the size the server holds. */
const APPENDED = ['stream.jsonl', 'stderr.log'];
/** Small files the agent sends whole when they change. exit.json is put last, after the stream it ends. */
const WHOLE = ['pid.json', 'steer.sent', 'exit.json'];
const SIGNALS = /^SIG(INT|TERM|KILL)$/;

/** The folder's `machine` file, or null: not a machine turn (or its folder is gone). */
export function placedAt(dir: string): Placed | null {
  try {
    return asPlaced(readFileSync(join(dir, 'machine'), 'utf8'));
  } catch {
    return null;
  }
}

/** placedAt for the agent's routes, which can wait. */
const placedNow = (dir: string): Promise<Placed | null> => readFile(join(dir, 'machine'), 'utf8').then(asPlaced, () => null);

function asPlaced(text: string): Placed | null {
  const p = JSON.parse(text);
  return Number.isInteger(p?.id) && Array.isArray(p.wrapper) ? p : null;
}

/** Mark the turn in `dir` as `machine`'s, before it is told: the file is what every later call goes by. Its first beat counts it as running while the agent fetches it. */
export async function placeTurn(dir: string, machine: { id: number; name: string }, launch: MachineLaunch) {
  await writeFile(join(dir, 'signals'), '');
  await writeFile(join(dir, 'beat'), '');
  await writeFile(join(dir, 'machine'), JSON.stringify({ id: machine.id, name: machine.name, ...launch } satisfies Placed), { mode: 0o600 });
  note(machine.id, dir);
  machineLink.poke(machine.id);
}

function note(machineId: number, dir: string) {
  let dirs = placed.get(machineId);
  if (!dirs) placed.set(machineId, (dirs = new Set()));
  dirs.add(dir);
}

/** Both known and the same version (the first word of `claude --version`): the only case a turn is placed in. */
export const sameClaude = (home: string | null, there: string | null): boolean => !!home && !!there && home.split(/\s/)[0] === there.split(/\s/)[0];

export const workerInfo = (machineId: number): WorkerInfo | null => workers.get(machineId) ?? null;

const size = (file: string) =>
  stat(file).then(
    (s) => s.size,
    () => 0,
  );
const there = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** A turn on a connected machine: signalled through its folder's `signals`, alive by its agent's syncs. */
export class MachineTurn implements RunningTurn {
  readonly outlivesServer = true;
  readonly where: string;
  readonly dir: string;
  readonly machine: number;

  constructor(dir: string, at: Placed) {
    this.dir = dir;
    this.machine = at.id;
    this.where = `machine ${at.name}`;
    note(at.id, dir);
  }

  /** Recorded, then applied by the agent in order; the runner keeps its clock (SIGINT, SIGTERM, SIGKILL), as for every kind. */
  signal(sig: NodeJS.Signals) {
    if (!existsSync(this.dir)) return;
    appendFileSync(join(this.dir, 'signals'), `${sig}\n`);
    machineLink.poke(this.machine);
    // A stop wins at once (spec section 6): with its machine away nothing will write the turn's end, so the kill does,
    // and the machine applies the recorded signals when it returns (its copy is then dropped: sync answers `gone`).
    if (sig === 'SIGKILL' && !machineLink.online(this.machine) && !existsSync(join(this.dir, 'exit.json'))) put(this.dir, 'exit.json', JSON.stringify({ code: null, signal: 'SIGKILL' }));
  }

  /** Stopped before its claude started, as far as this copy knows: ended here, and the agent drops the start (it has its SIGTERM). */
  endStart() {
    put(this.dir, 'exit.json', JSON.stringify({ code: null, signal: null, stopped: true }));
  }

  /**
   * By its agent's syncs, each of which touches `beat`. With the agent not connected it is away, not gone (spec section 3,
   * "never killed"): it counts as running until a person stops it. shortcut: no clock on away, T6 adds the 10 minute wait.
   */
  alive() {
    let age: number;
    try {
      age = Date.now() - statSync(join(this.dir, 'beat')).mtimeMs;
    } catch {
      return null;
    }
    return age < BEAT_STALE_MS || !machineLink.online(this.machine);
  }

  /** Always: its folder says whose it is, and the agent sends from wherever this copy stops. */
  reattachable() {
    return true;
  }

  keepUp(_ensureSupervisor: () => void) {}

  async look(): Promise<ProcCheck> {
    return { verdict: 'unknown', text: `This turn runs on ${this.where.replace(/^machine /, '')}, so the server can't look at its process.` };
  }
}

/** Write a file the runner may read at any moment: renamed into place. */
function put(dir: string, name: string, data: string) {
  writeFileSync(join(dir, `${name}.tmp`), data);
  renameSync(join(dir, `${name}.tmp`), join(dir, name));
}

/** One turn's part of an agent's sync. */
interface SyncTurn {
  dir: string;
  /** New bytes of an appended file, from `at` in the agent's copy. */
  append?: Record<string, { at: number; data: string }>;
  /** Small files, whole. */
  put?: Record<string, string>;
  /** The size of the agent's steer.jsonl, and how many signals it has applied. */
  steer?: number;
  signals?: number;
  /** Its wrapper runs there, or it is still being started. */
  alive?: boolean;
}

type SyncReply = { gone: true } | { sizes: Record<string, number>; steer?: string; signals: string[] };

/** The folder is a turn placed on `machineId` that is still followed: an agent may only name its own. */
async function owned(machineId: number, dir: unknown): Promise<boolean> {
  return typeof dir === 'string' && isAbsolute(dir) && normalize(dir) === dir && (await placedNow(dir))?.id === machineId;
}

/**
 * An agent's sync: its worker facts, the turns it holds with what is new in each, answered with what each needs from
 * here and the turns it should start. A turn it names that is no longer the machine's (ended and tidied here) is `gone`.
 */
type Sync = { turns: Record<string, SyncReply>; start: { dir: string; launch: MachineLaunch }[] };
type SyncBody = { worker?: { claude?: unknown; max?: unknown }; turns?: unknown };
/** Each machine's syncs run one after another: an append is checked against the size read just before it, so two at once (a retry of one that timed out) could write the same bytes twice. */
const lines = new Map<number, Promise<unknown>>();
export function syncTurns(machineId: number, body: SyncBody): Promise<Sync> {
  const next = (lines.get(machineId) ?? Promise.resolve()).then(() => syncNow(machineId, body));
  lines.set(
    machineId,
    next.catch(() => {}),
  );
  return next;
}

async function syncNow(machineId: number, body: SyncBody): Promise<Sync> {
  if (body.worker) workers.set(machineId, { claude: typeof body.worker.claude === 'string' ? body.worker.claude.slice(0, 80) : null, max: Math.max(0, Math.floor(Number(body.worker.max)) || 0), at: Date.now() });
  const turns: Record<string, SyncReply> = {};
  const held = new Set<string>();
  for (const t of (Array.isArray(body.turns) ? body.turns : []) as SyncTurn[]) {
    if (!t || typeof t.dir !== 'string') continue;
    held.add(t.dir);
    turns[t.dir] = (await owned(machineId, t.dir)) ? await syncTurn(t) : { gone: true };
  }
  const start: { dir: string; launch: MachineLaunch }[] = [];
  for (const dir of [...(placed.get(machineId) ?? [])]) {
    const at = await placedNow(dir);
    if (!at || at.id !== machineId) placed.get(machineId)?.delete(dir);
    // Not one that has ended here (a stop before it started): there is nothing to run.
    else if (!held.has(dir) && !(await there(join(dir, 'exit.json')))) start.push({ dir, launch: { wrapper: at.wrapper, cwd: at.cwd, home: at.home, roots: at.roots } });
  }
  return { turns, start };
}

async function syncTurn(t: SyncTurn): Promise<SyncReply> {
  const { dir } = t;
  const over = await there(join(dir, 'exit.json'));
  const sizes: Record<string, number> = {};
  for (const name of APPENDED) {
    const file = join(dir, name);
    const part = t.append?.[name];
    // Only at the size this copy has: anything else is a resend or a gap, and the answer says where to send from.
    if (part && typeof part.data === 'string' && !over && part.at === (await size(file))) await appendFile(file, Buffer.from(part.data, 'base64'));
    sizes[name] = await size(file);
  }
  // A turn ended here (stopped before it started, or killed while its machine was away) keeps the end it has.
  if (!over)
    for (const name of WHOLE) {
      const data = t.put?.[name];
      if (typeof data !== 'string' || data.length >= 10_000) continue;
      await writeFile(join(dir, `${name}.tmp`), data);
      await rename(join(dir, `${name}.tmp`), join(dir, name));
    }
  if (t.alive) await utimes(join(dir, 'beat'), new Date(), new Date()).catch(() => {});
  let steer: string | undefined;
  const from = Number(t.steer) || 0;
  // A turn from before steering has no steer file.
  const all = await readFile(join(dir, 'steer.jsonl')).catch(() => null);
  const end = all ? all.lastIndexOf(10) + 1 : 0; // whole lines only: the runner may be mid-append
  if (all && end > from) steer = all.subarray(from, end).toString('base64');
  const signals = (await readFile(join(dir, 'signals'), 'utf8').catch(() => ''))
    .split('\n')
    .filter((s) => SIGNALS.test(s))
    .slice(Math.max(0, Number(t.signals) || 0));
  return { sizes, ...(steer ? { steer } : {}), signals };
}

/** The turn's folder as a tar stream, for the agent that is to start it. shortcut: `pin/` (4 MB) goes every time; cache it by version on the machine if that shows on a slow link. */
export async function sendFolder(machineId: number, dir: string | null, res: ServerResponse): Promise<boolean> {
  if (!dir || !(await owned(machineId, dir))) return false;
  res.writeHead(200, { 'Content-Type': 'application/x-tar', 'X-Turn': basename(dir) });
  const tar = spawn('tar', ['-C', dir, '-cf', '-', '.'], { stdio: ['ignore', 'pipe', 'ignore'] });
  tar.stdout.pipe(res);
  tar.on('error', () => res.destroy());
  res.on('close', () => tar.kill());
  return true;
}
