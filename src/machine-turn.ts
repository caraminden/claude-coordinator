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
import { basename, dirname, isAbsolute, join, normalize } from 'node:path';
import type { Clear } from './machine-away.ts';
import { syncDir, syncScript, type TurnState } from './machine-sync.ts';
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
  /** What its syncs go by (src/machine-sync.ts): its worktree, session and folders come from here first. */
  state?: TurnState;
  /** The person's Claude account it runs on (src/claude-link.ts accountDir): the machine runs it from that account's folder there. */
  account?: number;
  /** A minion marked for this machine, on its owner's turn (Build 7 T8, src/host-reach.ts): its own container there, with the owner's folders at /host. */
  host?: true;
}

/** The part of it the agent is sent. */
type Offered = Omit<MachineLaunch, 'state'> & { sync?: { at: string; key: string } };

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
  /** Its CPU and memory pressure (whole percents over a minute) and free memory; null where it can't say, and from an agent before T4. */
  load?: { cpu: number | null; mem: number | null; freeGb: number | null } | null;
  /** Its worker has a Claude sign-in; null when it couldn't tell. */
  signedIn?: boolean | null;
  /** Which of its owner's accounts are signed in there (#2061), each with the Claude organization it names; null: it couldn't tell, or an agent from before. */
  accounts?: { n: number; org: string | null }[] | null;
}

/** The machines' connections, set by the server at start (server.ts): a module here reads them without holding the relay. */
export const machineLink = {
  /** The machine's agent is connected. */
  online: (_machineId: number): boolean => false,
  /** Hurry its agent's next sync. Lost is fine: it syncs by itself within a second. */
  poke: (_machineId: number): void => {},
};

/** How a turn ended because its machine was away (Build 7 T6), in its exit.json. `home`: it carries on at perigee. */
export interface AwayEnd {
  name: string;
  since: number;
  /** When its last whole checkpoint looked, or null: none since it started. */
  checkpoint: number | null;
  home: boolean;
}

/**
 * What src/machine-away.ts and the runner add, set at start (server.ts). The defaults are a server with no record of
 * copies: an overdue turn ends here.
 */
export const machineAway = {
  /** A turn was placed: the machine holds its minion's copy now. */
  placed: (_machineId: number, _dir: string, _at: Placed): void => {},
  /** The turn in `dir` ended here while its machine was away. */
  left: (_machineId: number, _dir: string, _a?: AwayEnd, _signal?: string | null): void => {},
  /** Its machine has been away AWAY_MS: end it here, or keep it for a minion that must wait for that machine. */
  overdue: (_machineId: number, dir: string, since: number): unknown => endAway(dir, since, true),
  /** The answer for a folder the agent holds that is no longer a followed turn's. */
  held: (_machineId: number, _dir: string): { rescue: true } | null => null,
  rescued: (_machineId: number, _dir: string, _failed: string | null): void => {},
  /** Copies the agent is to clear, and what it says of those it did. */
  clears: (_machineId: number, _held: Set<string>): Clear[] => [],
  cleared: (_machineId: number, _dir: string, _stays: string | null): void => {},
};

/** A machine away this long has its turns carried on at perigee (Josh's pick on #2011's brief). */
export const AWAY_MS = 10 * 60_000;
/** A machine back from away counts its turns alive this long, before their first beat since lands. */
export const awayTimes = { back: 30_000 };
/** A sync this long after the last one starts a new stretch of contact. */
const GAP_MS = 10_000;
/** Each machine's worker's last sync, and when the stretch of syncs it is in began. A sync counts as contact: a restart's syncs come back before its link (T5). */
const contact = new Map<number, { at: number; since: number }>();
/** When this server could last hear machines without a break: its start, or its waking from a stall or sleep. */
let began = Date.now();
let ticked = Date.now();

/** Away since: its last sync, or before this server started, its turn's last beat. */
async function awaySince(machineId: number, dir: string): Promise<number> {
  return contact.get(machineId)?.at ?? (await stat(join(dir, 'beat')).catch(() => null))?.mtimeMs ?? Date.now();
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );
/** Turn folders being ended as away, so two at once write one end. */
const ending = new Set<string>();

/** End the turn in `dir` here because its machine is away, or came back without it (`home` false: it restarted). `since` defaults to when it was last heard from. */
export async function endAway(dir: string, since: number | null, home: boolean, signal: string | null = null) {
  const at = placedAt(dir);
  if (!at || ending.has(dir)) return;
  ending.add(dir);
  try {
    if (await exists(join(dir, 'exit.json'))) return;
    const checkpoint = Number(await readFile(join(dir, 'checkpoint'), 'utf8').catch(() => '')) || null;
    const away: AwayEnd = { name: at.name, since: since ?? (await awaySince(at.id, dir)), checkpoint, home };
    put(dir, 'exit.json', JSON.stringify({ code: null, signal, away }));
    machineAway.left(at.id, dir, away, signal);
  } finally {
    ending.delete(dir);
  }
}

/** The away clock, every few seconds: a machine away AWAY_MS since it was last heard from (or since this server could hear it) has its turns ended here. */
export async function awayTick(now = Date.now()) {
  // This server slept or stalled: no machine could reach it meanwhile, so none is counted away for that time.
  if (now - ticked > 60_000) began = now;
  ticked = now;
  for (const machineId of placed.keys()) {
    if (machineLink.online(machineId) || now - heardAt(machineId) < AWAY_MS) continue;
    for (const dir of await liveOn(machineId)) machineAway.overdue(machineId, dir, await awaySince(machineId, dir));
  }
}

/** When this server last heard from a machine: its last sync, or when this server last started or woke from a stall. */
export const heardAt = (machineId: number): number => Math.max(contact.get(machineId)?.at ?? 0, began);

/** The turns placed on a machine that have not ended. */
export async function liveOn(machineId: number): Promise<string[]> {
  const dirs = [...(placed.get(machineId) ?? [])];
  const live = await Promise.all(dirs.map(async (dir) => (await exists(join(dir, 'machine'))) && !(await exists(join(dir, 'exit.json')))));
  return dirs.filter((_, i) => live[i]);
}

/** The turns the runner follows on each machine, by folder: filled as the runner asks about them (MachineTurn), so a restart rebuilds it. */
const placed = new Map<number, Set<string>>();
/** Each noted turn's machine, by folder: what a running minion's status line asks (Runner.view), with no file read on the server's thread. */
const placedOn = new Map<string, { id: number; name: string }>();
const workers = new Map<number, WorkerInfo>();

/** A machine turn's sync counts as its heartbeat; one silent this long, with its agent connected, is gone. */
const BEAT_STALE_MS = 30_000;
/** The agent's copy of these only grows: sent as bytes past the size the server holds. */
const APPENDED = ['stream.jsonl', 'stderr.log'];
/** Small files the agent sends whole when they change. exit.json is put last, after the stream it ends; host-writes.json (T8) before it. */
const WHOLE = ['pid.json', 'steer.sent', 'host-writes.json', 'exit.json'];
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
  note(machine.id, dir, machine.name);
  machineAway.placed(machine.id, dir, { id: machine.id, name: machine.name, ...launch });
  machineLink.poke(machine.id);
}

function note(machineId: number, dir: string, name: string) {
  let dirs = placed.get(machineId);
  if (!dirs) placed.set(machineId, (dirs = new Set()));
  dirs.add(dir);
  placedOn.set(dir, { id: machineId, name });
}

/** The machine the turn in `dir` was placed on, if it is away now (memory only: safe on the server's thread). Since is unknown until the agent's first sync after this server started. */
export function awayAt(dir: string): { name: string; since: number | null } | null {
  const m = placedOn.get(dir);
  return !m || machineLink.online(m.id) ? null : { name: m.name, since: contact.get(m.id)?.at ?? null };
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
    note(at.id, dir, at.name);
  }

  /** Recorded, then applied by the agent in order; the runner keeps its clock (SIGINT, SIGTERM, SIGKILL), as for every kind. */
  signal(sig: NodeJS.Signals) {
    if (!existsSync(this.dir)) return;
    appendFileSync(join(this.dir, 'signals'), `${sig}\n`);
    machineLink.poke(this.machine);
    // A stop wins at once (spec section 6): with its machine away nothing will write the turn's end, so the stop does.
    // When the machine is back the turn there is stopped and what it did comes home aside (src/machine-away.ts).
    if (!machineLink.online(this.machine)) void endAway(this.dir, null, true, sig);
  }

  /** Stopped before its claude started, as far as this copy knows: ended here, and the agent drops the start (it has its SIGTERM). */
  endStart() {
    put(this.dir, 'exit.json', JSON.stringify({ code: null, signal: null, stopped: true }));
    if (!machineLink.online(this.machine)) machineAway.left(this.machine, this.dir);
  }

  /**
   * By its agent's syncs, each of which touches `beat`. With the agent not connected it is away, not gone (spec section 3,
   * "never killed"): it counts as running until a person stops it or awayTick ends it. Back from away, it has awayTimes.back for
   * a sync that names it: the first syncs carry the worker's facts before its turns' beats.
   */
  alive() {
    let age: number;
    try {
      age = Date.now() - statSync(join(this.dir, 'beat')).mtimeMs;
    } catch {
      return null;
    }
    return age < BEAT_STALE_MS || !machineLink.online(this.machine) || Date.now() - (contact.get(this.machine)?.since ?? began) < awayTimes.back;
  }

  /** Its machine is away: which, and since when, for the minion's working line. */
  away(): { name: string; since: number | null } | null {
    // shortcut: since is unknown until the agent's first sync after this server started; the row then says only "away".
    return awayAt(this.dir);
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
  /** The last checkpoint asked for here (askCheckpoint) that it finished, or why it couldn't. */
  home?: number;
  homeFailed?: string;
  /** Its machine restarted under it: its wrapper is gone, and what it had is home. */
  lost?: boolean;
  /** A rescue (src/machine-away.ts) is done, or why it failed. */
  rescued?: boolean;
  rescueFailed?: string;
}

/** `script`: the sync program's id, of a turn whose state is synced; `checkpoint`: one asked for here. */
type SyncReply = { gone: true } | { rescue: true } | { sizes: Record<string, number>; steer?: string; signals: string[]; script?: string; checkpoint?: number };

/** Checkpoints waited for, by turn folder. In memory: what waits is a request, which ends with this process. */
const asked = new Map<string, { id: number; done: (problem: string | null) => void }[]>();

/** Bring home what the turn in `dir` has changed, for something here that is about to read it. Null once it is here, else why not. */
export async function askCheckpoint(dir: string, timeout = 60_000): Promise<string | null> {
  const at = placedAt(dir);
  if (!at?.state) return null;
  if (!machineLink.online(at.id)) return `${at.name}, where this turn runs, is not connected`;
  const waiting = asked.get(dir) ?? [];
  asked.set(dir, waiting);
  const id = Math.max(Date.now(), (waiting.at(-1)?.id ?? 0) + 1);
  let timer: NodeJS.Timeout | undefined;
  const problem = await new Promise<string | null>((done) => {
    waiting.push({ id, done });
    timer = setTimeout(() => done(`${at.name} did not send this turn's files within ${Math.round(timeout / 1000)} seconds`), timeout);
    machineLink.poke(at.id);
  });
  clearTimeout(timer);
  const left = (asked.get(dir) ?? []).filter((w) => w.id !== id);
  if (left.length) asked.set(dir, left);
  else asked.delete(dir);
  return problem;
}

/** The folder is a turn placed on `machineId` that is still followed: an agent may only name its own. */
export async function owned(machineId: number, dir: unknown): Promise<boolean> {
  return typeof dir === 'string' && isAbsolute(dir) && normalize(dir) === dir && (await placedNow(dir))?.id === machineId;
}

/**
 * An agent's sync: its worker facts, the turns it holds with what is new in each, answered with what each needs from
 * here and the turns it should start. A turn it names that is no longer the machine's (ended and tidied here) is `gone`.
 */
type Sync = { turns: Record<string, SyncReply>; start: { dir: string; launch: Offered }[]; clear?: Clear[] };
type SyncBody = { worker?: { claude?: unknown; max?: unknown; load?: unknown; signedIn?: unknown; accounts?: unknown }; turns?: unknown; cleared?: unknown };
/** An agent's signed-in accounts, checked: account numbers 1 to 3, once each, with an organization id or null. */
function accountsSaid(raw: unknown): WorkerInfo['accounts'] {
  if (!Array.isArray(raw)) return null;
  const out = new Map<number, string | null>();
  for (const a of raw as { n?: unknown; org?: unknown }[]) if (Number.isInteger(a?.n) && (a.n as number) >= 1 && (a.n as number) <= 3) out.set(a.n as number, typeof a.org === 'string' && /^[\w-]{1,80}$/.test(a.org) ? a.org : null);
  return [...out].map(([n, org]) => ({ n, org }));
}
/** An agent's load, checked: nothing for a kernel without pressure files, which Auto reads as not known. */
function loadSaid(raw: unknown): WorkerInfo['load'] {
  const o = (raw ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof o[k] === 'number' && o[k] >= 0 ? o[k] : null);
  return n('cpu') === null && n('mem') === null ? null : { cpu: n('cpu'), mem: n('mem'), freeGb: n('freeGb') };
}
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
  const now = Date.now();
  const c = contact.get(machineId);
  contact.set(machineId, { at: now, since: c && now - c.at < GAP_MS ? c.since : now });
  if (body.worker)
    workers.set(machineId, {
      claude: typeof body.worker.claude === 'string' ? body.worker.claude.slice(0, 80) : null,
      max: Math.max(0, Math.floor(Number(body.worker.max)) || 0),
      at: Date.now(),
      load: loadSaid(body.worker.load),
      signedIn: typeof body.worker.signedIn === 'boolean' ? body.worker.signedIn : null,
      accounts: accountsSaid(body.worker.accounts),
    });
  const turns: Record<string, SyncReply> = {};
  const held = new Set<string>();
  for (const t of (Array.isArray(body.turns) ? body.turns : []) as SyncTurn[]) {
    if (!t || typeof t.dir !== 'string') continue;
    held.add(t.dir);
    if (t.rescued) machineAway.rescued(machineId, t.dir, typeof t.rescueFailed === 'string' ? t.rescueFailed : null);
    turns[t.dir] = (await owned(machineId, t.dir)) ? await syncTurn(machineId, t) : (!t.rescued && machineAway.held(machineId, t.dir)) || { gone: true };
  }
  for (const c of (Array.isArray(body.cleared) ? body.cleared : []) as { dir?: unknown; stays?: unknown }[]) if (typeof c?.dir === 'string') machineAway.cleared(machineId, c.dir, typeof c.stays === 'string' ? c.stays : null);
  const clear = machineAway.clears(machineId, held);
  const start: Sync['start'] = [];
  for (const dir of [...(placed.get(machineId) ?? [])]) {
    const at = await placedNow(dir);
    if (!at || at.id !== machineId) {
      placed.get(machineId)?.delete(dir);
      if (placedOn.get(dir)?.id === machineId) placedOn.delete(dir);
    }
    // Not one that has ended here (a stop before it started): there is nothing to run.
    else if (!held.has(dir) && !(await there(join(dir, 'exit.json'))))
      start.push({ dir, launch: { wrapper: at.wrapper, cwd: at.cwd, home: at.home, roots: at.roots, ...(at.account ? { account: at.account } : {}), ...(at.host ? { host: true } : {}), ...(at.state ? { sync: { at: syncDir(dir), key: at.cwd ? dirname(at.cwd) : dir } } : {}) } });
  }
  return { turns, start, ...(clear.length ? { clear } : {}) };
}

async function syncTurn(machineId: number, t: SyncTurn): Promise<SyncReply> {
  const { dir } = t;
  for (const w of asked.get(dir) ?? []) if (typeof t.home === 'number' && t.home >= w.id) w.done(typeof t.homeFailed === 'string' ? t.homeFailed.slice(0, 300) : null);
  if (t.lost) await endAway(dir, (await stat(join(dir, 'beat')).catch(() => null))?.mtimeMs ?? Date.now(), false);
  const over = await there(join(dir, 'exit.json'));
  // Ended here while its machine was away (a stop, the clock, a restart there): the agent stops it, and sends what it did home aside.
  if (over && !t.rescued && machineAway.held(machineId, dir)) return { rescue: true };
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
  const at = await placedNow(dir);
  const checkpoint = asked.get(dir)?.at(-1)?.id;
  return { sizes, ...(steer ? { steer } : {}), signals, ...(at?.state ? { script: (await syncScript()).hash } : {}), ...(checkpoint ? { checkpoint } : {}) };
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
