// The worker half of the machine agent (Build 7 T2): runs whole minion turns here, in a container that has the same
// paths as the server's, and keeps each turn's folder in step with the server's copy. Loaded by machine-agent.mjs only
// when machine-agent.json has a "worker" block, which only this computer's owner edits:
//
//   "worker": { "root": "/home/me/citadel-worker", "image": "citadel-worker", "max": 6,
//               "node": "/usr/local/bin/node", "claude": "/usr/local/bin/claude" }
//
// root: where turns' files live here (under <root>/fs, by their path on the server). image: the worker image (podman).
// max: turns at once. node, claude: where they are in the image, when not where the server has them. Nothing
// else of this computer is in the container. The server's side, and the contract, is src/machine-turn.ts: one call about every
// half second (`sync`) sends what is new in each turn's stream and takes back steers and signals, so nothing depends on
// the connection staying up. A turn's own tool calls home go through `forward`, with this machine's token added.
//
// Also a program: `node machine-worker.mjs --self-test <machine-agent.json>` prints the worker's self-test.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, openSync, readSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const SYNC_MS = 500;
const LOAD_MS = 10_000;
const SIGNED_IN_MS = 5 * 60_000;
/** A turn's changes go home at least this often. */
const CHECKPOINT_MS = 120_000;
/** The most of one file's new bytes in one sync: a long stream catches up over several. */
const CHUNK = 2_000_000;
const APPENDED = ['stream.jsonl', 'stderr.log'];
// host-writes.json: a host turn's count of files written to its machine's folders (T8), sent before its end.
const WHOLE = ['pid.json', 'steer.sent', 'host-writes.json', 'exit.json'];
/** Where a host turn's folders show inside its container, each at /host/<name> (T8). */
export const HOST_IN = '/host';
/** Files counted in one host folder at a turn's end; past it the line says "more than". */
const COUNT_MAX = 100_000;
/** A wrapper whose beat is older than this no longer runs (it beats every 5 s). */
const BEAT_STALE_MS = 30_000;

/** The worker block of a config file, checked; throws with what is wrong. @param {unknown} raw */
export function workerConfig(raw) {
  const c = /** @type {Record<string, unknown>} */ (raw ?? {});
  if (typeof c.root !== 'string' || !isAbsolute(c.root)) throw new Error('worker.root must be a full path');
  if (typeof c.image !== 'string' || !c.image) throw new Error('worker.image must name the worker image');
  return {
    root: c.root,
    image: c.image,
    max: Math.max(1, Math.floor(Number(c.max)) || 1),
    node: typeof c.node === 'string' ? c.node : null,
    claude: typeof c.claude === 'string' ? c.claude : null,
    container: typeof c.container === 'string' ? c.container : 'citadel-worker',
    podman: typeof c.podman === 'string' ? c.podman : 'podman',
    /** The owner's folders for a host turn (T8, worker-agent.mjs hostMounts): only a marked minion's container has them. */
    host: hostBinds(c.host),
  };
}

/** Host folders as binds, each at /host/<name>; anything else is dropped. @param {unknown} raw @returns {{ src: string, dst: string, ro: boolean }[]} */
export function hostBinds(raw) {
  return (Array.isArray(raw) ? raw : []).filter((m) => m && typeof m.src === 'string' && isAbsolute(m.src) && !m.src.includes(',') && typeof m.dst === 'string' && /^\/host\/[a-z0-9][a-z0-9_-]{0,39}$/.test(m.dst)).map((m) => ({ src: m.src, dst: m.dst, ro: m.ro !== false }));
}

/** The container a turn runs in: a marked minion's own, with the host folders, apart from every other turn's (T8). @param {{ container: string }} cfg @param {{ host?: boolean } | null | undefined} launch */
export function boxOf(cfg, launch) {
  return launch?.host === true ? `${cfg.container}-host` : cfg.container;
}

/**
 * podman run's arguments for the worker container, after `run`: the server's own shape (src/containers.ts runArgs), a
 * home volume the sign-in lives in, and each of `roots` from under the worker's root at the path the server has it.
 * Nothing else of this computer is in it: no /mnt/c, no interop socket. `extraMounts` is for a minion its owner gave
 * host folders to (T8, host reach), in its own container `name`; a plain worker passes none. Both share the home volume, so one sign-in.
 * @param {ReturnType<typeof workerConfig>} cfg @param {{ home: string, roots: string[] }} launch @param {{ src: string, dst: string, ro?: boolean }[]} [extraMounts] @param {string} [name]
 */
export function containerArgs(cfg, launch, extraMounts = [], name = cfg.container) {
  const binds = [...launch.roots.map((r) => ({ src: join(cfg.root, 'fs', r), dst: r, ro: false })), ...extraMounts];
  const spec = JSON.stringify([cfg.image, launch.home, binds]);
  const args = ['--rm', '--replace', '--name', name, '--init', '--userns=keep-id', '--network=host', '--pids-limit=32768', '--label', `citadel.spec=${createHash('sha256').update(spec).digest('hex').slice(0, 12)}`];
  args.push('-e', `HOME=${launch.home}`, '-v', `${cfg.container}-home:${launch.home}:U`);
  for (const m of binds) args.push('--mount', `type=bind,src=${m.src},dst=${m.dst}${m.ro ? ',ro' : ''}`);
  args.push(cfg.image, 'sleep', 'infinity');
  return args;
}

/** A turn as this agent takes it up. @param {{ dir: string, local: string, launch: Launch } & Partial<Turn>} t @returns {Turn} */
const newTurn = (t) => ({ applied: 0, acked: null, sentWhole: {}, starting: false, dropped: false, seeded: false, script: null, home: 0, homeFailed: null, asked: 0, steering: false, checking: false, checked: Date.now(), nextTry: 0, failures: 0, ref: -1, final: false, counting: false, ...t });

/** @param {string} cmd @param {string[]} args @param {number} [timeout] @returns {Promise<{ code: number, out: string, err: string }>} */
const run = (cmd, args, timeout = 60_000) => new Promise((done) => execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (err, out, stderr) => done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out), err: String(stderr || err?.message || '') })));

/** How pressed this computer is: "some avg60" of its CPU and memory as whole percents (no kernel pressure files: null), and free memory in GB. */
export function hostLoad(read = (/** @type {string} */ file) => readFileSync(file, 'utf8')) {
  /** @param {string} file @param {RegExp} what */
  const number = (file, what) => {
    try {
      return Number(read(file).match(what)?.[1] ?? NaN);
    } catch {
      return NaN;
    }
  };
  const or = (/** @type {number} */ n) => (Number.isNaN(n) ? null : n);
  const pressure = (/** @type {string} */ kind) => or(Math.round(number(`/proc/pressure/${kind}`, /^some .*avg60=([\d.]+)/m)));
  return { cpu: pressure('cpu'), mem: pressure('memory'), freeGb: or(Math.round(number('/proc/meminfo', /^MemAvailable:\s+(\d+)/m) / 104858) / 10) };
}

const size = (/** @type {string} */ file) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};
const read = (/** @type {string} */ file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * @typedef {{ wrapper: string[], cwd: string | null, home: string, roots: string[], sync?: { at: string, key: string }, host?: boolean }} Launch sync: its state comes from the server and goes back (public/machine-sync.mjs); `at` is that program's folder, `key` what one of it at a time runs for
 * @typedef {{ start?: boolean, git?: boolean, roots?: string[], final?: boolean, mode?: 'rescue' | 'clear', all?: boolean }} SyncAsk
 * @typedef {{ dir: string, local: string, launch: Launch, applied: number, acked: Record<string, number> | null, sentWhole: Record<string, string>, starting: boolean, dropped: boolean, seeded: boolean, script: string | null, home: number, homeFailed: string | null, asked: number, steering: boolean, checking: boolean, checked: number, nextTry: number, failures: number, ref: number, final: boolean, boot?: string | null, rescuing?: boolean, rescued?: true | string, counting: boolean }} Turn
 */

export class Worker {
  /** @param {{ config: unknown, appUrl: string, token: string, log?: (...a: unknown[]) => void, run?: typeof run, checkpointMs?: number }} o */
  constructor(o) {
    this.cfg = workerConfig(o.config);
    this.appUrl = o.appUrl;
    this.token = o.token;
    this.log = o.log ?? (() => {});
    this.exec = o.run ?? run;
    /** @type {Map<string, Turn>} */
    this.turns = new Map();
    this.claude = null;
    this.load = { at: 0, now: hostLoad() };
    /** @type {{ at: number, now: boolean | null }} */
    this.signedIn = { at: 0, now: null };
    this.busy = false;
    this.again = false;
    this.port = 0;
    /** What each scheme's syncs wait in line behind: two at once would write the same repo. @type {Map<string, Promise<unknown>>} */
    this.lines = new Map();
    /** This computer's boot: a turn begun in another one ended with it (`lost`). */
    this.boot = read('/proc/sys/kernel/random/boot_id')?.trim() ?? null;
    /** Copies being cleared, and those cleared that the app has not heard of yet (src/machine-away.ts). @type {Set<string>} */
    this.clearing = new Set();
    /** @type {{ dir: string, stays?: string }[]} */
    this.cleared = [];
    this.checkpointMs = o.checkpointMs ?? CHECKPOINT_MS;
    mkdirSync(join(this.cfg.root, 'fs'), { recursive: true, mode: 0o700 });
    // The turns an earlier run of this agent held: their wrappers ran on in the container without it.
    try {
      for (const t of JSON.parse(readFileSync(this.index(), 'utf8')))
        if (this.mine(t.dir) && existsSync(this.local(t.dir))) this.turns.set(t.dir, newTurn({ dir: t.dir, local: this.local(t.dir), launch: t.launch, applied: Number(t.applied) || 0, seeded: t.seeded === true, script: typeof t.script === 'string' ? t.script : null, boot: typeof t.boot === 'string' ? t.boot : null }));
    } catch {}
  }

  index() {
    return join(this.cfg.root, 'turns.json');
  }

  /** Where a server path is here. @param {string} p */
  local(p) {
    return join(this.cfg.root, 'fs', p);
  }

  /** A turn folder's path as the server names it: full, plain, and so always under this worker's root here. @param {unknown} dir */
  mine(dir) {
    return typeof dir === 'string' && isAbsolute(dir) && normalize(dir) === dir && dir !== '/';
  }

  save() {
    writeFileSync(`${this.index()}.tmp`, JSON.stringify([...this.turns.values()].map((t) => ({ dir: t.dir, launch: t.launch, applied: t.applied, seeded: t.seeded, script: t.script, boot: t.boot }))), { mode: 0o600 });
    renameSync(`${this.index()}.tmp`, this.index());
  }

  /** Start syncing, and the forwarder turns' tools call home through. */
  async start() {
    await this.forward();
    // Its claude's version, before any turn: the server places none here while it differs from its own.
    void this.version(['run', '--rm', this.cfg.image]);
    this.timer = setInterval(() => this.poke(), SYNC_MS);
    this.poke();
  }

  stop() {
    clearInterval(this.timer);
    this.server?.close();
  }

  /** Sync now; one at a time, and once more after one that was running. */
  poke() {
    if (this.busy) return void (this.again = true);
    this.busy = true;
    this.sync()
      .catch((err) => this.quiet(`Turns: could not reach the app (${err.message})`))
      .finally(() => {
        this.busy = false;
        if (this.again) {
          this.again = false;
          this.poke();
        }
      });
  }

  /** A fact logged when it changes. @param {string} text */
  quietly(text) {
    if (text !== this.told) this.log((this.told = text));
  }

  /** Log a trouble once until it changes, not twice a second. @param {string} text */
  quiet(text) {
    if (text !== this.said) this.log((this.said = text));
  }

  /** @param {string} path @param {RequestInit} [init] */
  call(path, init = {}) {
    return fetch(new URL(path, this.appUrl), { ...init, headers: { Authorization: `Bearer ${this.token}`, ...init.headers } });
  }

  async sync() {
    for (const t of this.turns.values()) this.checkpointIfDue(t);
    const turns = [...this.turns.values()].map((t) => this.report(t));
    const claude = this.claude;
    const cleared = this.cleared;
    const res = await this.call('/api/machines/turns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker: { claude, max: this.cfg.max, ...this.facts() }, turns: turns.map((r) => r.body), ...(cleared.length ? { cleared } : {}) }), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`it answered ${res.status}`);
    this.said = null;
    // Said once the app has it: with another version than the app's own claude, no turn comes here.
    if (claude) this.quietly(`Minion turns: claude here is ${claude}`);
    const reply = await res.json();
    this.cleared = this.cleared.filter((c) => !cleared.includes(c));
    for (const c of cleared) this.clearing.delete(c.dir);
    for (const c of Array.isArray(reply.clear) ? reply.clear : []) this.clear(c);
    for (const r of turns) await this.heard(r.turn, r, reply.turns?.[r.turn.dir]);
    for (const s of Array.isArray(reply.start) ? reply.start : []) {
      if (!this.mine(s?.dir) || this.turns.has(s.dir) || this.clearing.has(s.dir)) continue;
      // Its owner's cap: a turn past it stays the server's to place elsewhere, and is asked for again next sync.
      if (this.turns.size >= this.cfg.max) break;
      void this.begin(s.dir, s.launch);
    }
  }

  /** What is new in a turn here. @param {Turn} t */
  report(t) {
    /** @type {Record<string, { at: number, data: string }>} */
    const append = {};
    /** @type {Record<string, string>} */
    const put = {};
    let caughtUp = !!t.acked;
    for (const name of t.acked ? APPENDED : []) {
      const file = join(t.local, name);
      const at = t.acked[name] ?? 0;
      const have = size(file);
      if (have <= at) continue;
      caughtUp = false;
      const buf = Buffer.alloc(Math.min(CHUNK, have - at));
      try {
        const fd = openSync(file, 'r');
        try {
          append[name] = { at, data: buf.subarray(0, readSync(fd, buf, 0, buf.length, at)).toString('base64') };
        } finally {
          closeSync(fd);
        }
      } catch {}
    }
    for (const name of WHOLE) {
      const text = read(join(t.local, name));
      // Its end goes last: only once the server holds the whole stream it ends.
      if (text === null || text === t.sentWhole[name] || (name === 'exit.json' && (!caughtUp || !this.settled(t) || !this.counted(t)))) continue;
      put[name] = text;
    }
    const alive = t.starting || this.beats(t) || !this.settled(t);
    // Begun before this computer last started: its wrapper went with that boot, and what it had is home (settled).
    const lost = !alive && !!t.boot && !!this.boot && t.boot !== this.boot && !existsSync(join(t.local, 'exit.json'));
    const rescued = t.rescued ? { rescued: true, ...(t.rescued === true ? {} : { rescueFailed: t.rescued }) } : {};
    const body = { dir: t.dir, append, put, steer: size(join(t.local, 'steer.jsonl')), signals: t.applied, alive, ...(lost ? { lost } : {}), ...rescued, ...(t.home ? { home: t.home } : {}), ...(t.homeFailed ? { homeFailed: t.homeFailed } : {}) };
    return { turn: t, body, put };
  }

  /** The server's answer for a turn. @param {Turn} t @param {{ put: Record<string, string> }} sent @param {any} r */
  async heard(t, sent, r) {
    if (!r) return;
    if (r.gone) return this.drop(t);
    if (r.rescue) return this.rescue(t);
    t.acked = r.sizes ?? {};
    Object.assign(t.sentWhole, sent.put);
    if (typeof r.script === 'string') t.script = r.script;
    if (Number(r.checkpoint) > t.asked) t.asked = Number(r.checkpoint);
    if (typeof r.steer === 'string' && !t.steering) void this.steer(t, Buffer.from(r.steer, 'base64'));
    if (Array.isArray(r.signals) && r.signals.length) await this.signal(t, r.signals);
  }

  /**
   * The app carried this turn on without this machine (it was away): the turn here stops, and what it did that never
   * came home goes there beside the minion's work (public/machine-sync.mjs, rescue). Then the app answers `gone`.
   * @param {Turn} t
   */
  rescue(t) {
    if (t.rescuing || t.rescued) return;
    t.rescuing = true;
    const stop = async () => {
      const pid = this.pid(t);
      if (!pid || existsSync(join(t.local, 'exit.json'))) return;
      await this.exec(this.cfg.podman, ['exec', boxOf(this.cfg, t.launch), 'sh', '-c', `kill -KILL -${pid} 2>/dev/null || kill -KILL ${pid}`]);
      // Its wrapper writes its end once claude is gone: what it wrote last is part of what goes.
      for (let i = 0; i < 20 && !existsSync(join(t.local, 'exit.json')); i++) await sleep(250);
    };
    void (t.seeded ? this.stateSync(t, { mode: 'rescue' }, stop) : stop().then(() => ({ ok: true }))).then((r) => {
      t.rescuing = false;
      if (r.ok || r.gone) t.rescued = true;
      else if (r.offline) t.nextTry = Date.now() + 2000;
      else if (++t.failures >= 3) t.rescued = r.error ?? 'its sync program stopped 3 times with no reason given';
      this.poke();
    });
  }

  /** Delete this machine's copy of a minion the app is done with, once its work is home. @param {any} c */
  clear(c) {
    if (!this.mine(c?.dir) || this.clearing.has(c.dir) || this.turns.has(c.dir) || !c.launch?.sync || !this.mine(c.launch.sync.at) || !Array.isArray(c.launch.roots) || !c.launch.roots.every((/** @type {unknown} */ r) => this.mine(r))) return;
    this.clearing.add(c.dir);
    const t = newTurn({ dir: c.dir, local: this.local(c.dir), launch: c.launch });
    // A rescue of a copy whose turn this agent no longer holds (it was restarted, say) goes the same way.
    void this.stateSync(t, { mode: c.mode === 'rescue' ? 'rescue' : 'clear', all: c.all === true }).then((r) => {
      if (r.ok) return void this.cleared.push({ dir: c.dir, ...(typeof r.stays === 'string' ? { stays: r.stays } : {}) });
      this.quiet(`Could not clear this machine's copy of minion ${c.ticket}: ${r.error}`);
      setTimeout(() => this.clearing.delete(c.dir), r.offline ? 2000 : 60_000).unref?.();
    });
  }

  /** Steers for the turn, once the pictures they may name are here. @param {Turn} t @param {Buffer} lines */
  async steer(t, lines) {
    // Asked for again at every sync until it is written: the server sends from the size this file has.
    t.steering = true;
    if (t.seeded) await this.stateSync(t, { git: false, roots: ['uploads', 'files'] });
    if (existsSync(t.local)) appendFileSync(join(t.local, 'steer.jsonl'), lines);
    t.steering = false;
    this.poke();
  }

  /** The turn's wrapper says it runs. @param {Turn} t */
  beats(t) {
    try {
      return Date.now() - statSync(join(t.local, 'beat')).mtimeMs < BEAT_STALE_MS;
    } catch {
      return false;
    }
  }

  /** Nothing of it is left to send home: its end may be told. @param {Turn} t */
  settled(t) {
    return !t.seeded || t.final;
  }

  /** A host turn's end waits for its count of what it wrote to the machine's folders (T8). @param {Turn} t */
  counted(t) {
    return t.launch?.host !== true || existsSync(join(t.local, 'host-writes.json'));
  }

  /**
   * The files a host turn wrote to each of the machine's read-write folders, counted once it ends: its chat says so in
   * one line (src/host-reach.ts). A count that fails says why, and the turn's end goes home all the same.
   * @param {Turn} t
   */
  async countWrites(t) {
    t.counting = true;
    /** @type {{ name: string, files: number, more?: true }[]} */
    const folders = [];
    let error = null;
    try {
      const since = join(t.dir, 'host-began');
      for (const m of this.cfg.host.filter((b) => !b.ro)) {
        if (!existsSync(join(t.local, 'host-began'))) throw new Error('its start mark is gone');
        const r = await this.exec(this.cfg.podman, ['exec', boxOf(this.cfg, t.launch), 'sh', '-c', `find "$1" -xdev -type f -newer "$2" 2>/dev/null | head -n ${COUNT_MAX + 1} | wc -l`, 'sh', m.dst, since], 5 * 60_000);
        const n = Number(r.out.trim());
        if (r.code || !Number.isFinite(n)) throw new Error(`counting ${m.dst} failed: ${r.err.trim().split('\n').pop() || `exit ${r.code}`}`);
        if (n) folders.push({ name: m.dst.slice(HOST_IN.length + 1), files: Math.min(n, COUNT_MAX), ...(n > COUNT_MAX ? { more: /** @type {const} */ (true) } : {}) });
      }
    } catch (err) {
      error = err.message;
    }
    writeFileSync(join(t.local, 'host-writes.json'), JSON.stringify({ folders, ...(error ? { error } : {}) }));
    t.counting = false;
    this.poke();
  }

  /** The program a turn's state is synced by (public/machine-sync.mjs), in the version the app wants. Its path on both sides is under the turns' folder. @param {Turn} t */
  async syncProgram(t) {
    const { at } = /** @type {{ at: string }} */ (t.launch.sync);
    // Before the first sync says which: the app's own, asked for anew.
    const name = join(at, `machine-sync-${t.script ?? 'first'}.mjs`);
    if (t.script && existsSync(this.local(name))) return name;
    const res = await this.call('/api/machines/state/script', { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw Object.assign(new Error(`the app answered ${res.status} for the sync program`), { offline: res.status === 502 || res.status === 503 });
    mkdirSync(this.local(at), { recursive: true, mode: 0o700 });
    writeFileSync(`${this.local(name)}.tmp`, await res.text(), { mode: 0o600 });
    renameSync(`${this.local(name)}.tmp`, this.local(name));
    return name;
  }

  /**
   * Run the sync program for a turn in the worker container, where the server's paths are and whatever a minion put in
   * its git config stays. Never throws. @param {Turn} t @param {SyncAsk} ask
   * @param {() => Promise<void>} [first] what goes in the line before the program
   * @returns {Promise<{ ok?: true, gone?: true, error?: string, offline?: boolean, kept?: string | null, stays?: string }>}
   */
  stateSync(t, ask, first = async () => {}) {
    const { at, key } = /** @type {{ at: string, key: string }} */ (t.launch.sync);
    const now = async () => {
      try {
        await first();
        const program = await this.syncProgram(t);
        // Its container may have stopped with the machine since the turn began.
        if (!ask.start) await this.ensureContainer(t.launch);
        const arg = Buffer.from(JSON.stringify({ app: `http://127.0.0.1:${this.port}`, dir: t.dir, state: at, ...ask })).toString('base64');
        const r = await this.exec(this.cfg.podman, ['exec', boxOf(this.cfg, t.launch), this.cfg.node ?? t.launch.wrapper[0], program, arg], ask.start ? 60 * 60_000 : 15 * 60_000);
        const last = r.out.trim().split('\n').pop() ?? '';
        return r.code || !last.startsWith('{') ? { error: (r.err.trim() || last || `exit ${r.code}`).slice(-300) } : JSON.parse(last);
      } catch (err) {
        // fetch says a TypeError when it can't reach the app.
        return { error: err.message, offline: err.offline ?? (err instanceof TypeError || err.name === 'TimeoutError') };
      }
    };
    const next = (this.lines.get(key) ?? Promise.resolve()).then(now);
    this.lines.set(key, next);
    void next.then(() => this.lines.get(key) === next && this.lines.delete(key));
    return next;
  }

  /** The size of the worktree's HEAD log: it grows with each commit. @param {Turn} t */
  headLog(t) {
    const cwd = this.local(t.launch.cwd ?? '');
    const to = /^gitdir: (.+)$/m.exec(read(join(cwd, '.git')) ?? '')?.[1];
    return to ? size(join(resolve(cwd, to), 'logs', 'HEAD')) : 0;
  }

  /** Send home what a turn changed: at its end, when the server asks, on a commit, and every couple of minutes. @param {Turn} t */
  checkpointIfDue(t) {
    if (!this.counted(t) && !t.counting && existsSync(join(t.local, 'exit.json'))) void this.countWrites(t);
    if (!t.seeded || t.starting || t.checking || t.rescuing || t.rescued) return;
    const over = existsSync(join(t.local, 'exit.json')) || !this.beats(t);
    // A machine that slept looks over until its wrapper beats again.
    if (!over) t.final = false;
    const ref = this.headLog(t);
    const due = over ? !t.final : t.asked > t.home || ref !== t.ref || Date.now() - t.checked > this.checkpointMs;
    if (!due || (Date.now() < t.nextTry && t.asked <= t.home)) return;
    void this.checkpoint(t, over, ref);
  }

  /** @param {Turn} t @param {boolean} over @param {number} ref */
  async checkpoint(t, over, ref) {
    t.checking = true;
    const { asked } = t;
    const r = await this.stateSync(t, { final: over || asked > t.home });
    t.checked = Date.now();
    t.homeFailed = r.ok ? (r.kept ?? null) : (r.error ?? 'the turn has ended here');
    if (asked > t.home) t.home = asked;
    if (r.ok || r.gone) {
      t.ref = ref;
      t.failures = 0;
      if (over) t.final = true;
    } else {
      this.quiet(`Turn ${t.dir.split('/').pop()}: could not send its files home: ${r.error}`);
      t.nextTry = Date.now() + (r.offline ? 2000 : 10_000);
      // Out of reach is waited out, however long; a sync that fails by itself is not going to mend, and the turn's end must be told.
      if (!r.offline && ++t.failures >= 3 && over) {
        t.final = true;
        await this.call(`/api/machines/state/failed?dir=${encodeURIComponent(t.dir)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: r.error }), signal: AbortSignal.timeout(30_000) }).catch(() => {});
      }
    }
    t.checking = false;
    this.poke();
  }

  /** The pid of the turn's claude in the container, once its wrapper has one. @param {Turn} t */
  pid(t) {
    try {
      return Number(JSON.parse(readFileSync(join(t.local, 'pid.json'), 'utf8')).claude) || null;
    } catch {
      return null;
    }
  }

  /** Apply the server's signals, in order, to the turn's process group (as the server does for its own container turns). @param {Turn} t @param {string[]} sigs */
  async signal(t, sigs) {
    const pid = this.pid(t);
    if (!pid) {
      // Stopped before its claude started: nothing claims its spec now, and the signals wait for a pid that may yet come.
      t.dropped = true;
      rmSync(join(t.local, 'spec.json'), { force: true });
      return;
    }
    for (const sig of sigs) {
      if (!/^SIG(INT|TERM|KILL)$/.test(sig)) continue;
      const s = sig.slice(3);
      await this.exec(this.cfg.podman, ['exec', boxOf(this.cfg, t.launch), 'sh', '-c', `kill -${s} -${pid} 2>/dev/null || kill -${s} ${pid}`]);
    }
    t.applied += sigs.length;
    this.save();
  }

  /** The server no longer follows it: whatever still runs is killed, and its folder here goes. @param {Turn} t */
  async drop(t) {
    this.turns.delete(t.dir);
    this.save();
    const pid = this.pid(t);
    if (pid && !existsSync(join(t.local, 'exit.json'))) await this.exec(this.cfg.podman, ['exec', boxOf(this.cfg, t.launch), 'sh', '-c', `kill -KILL -${pid} 2>/dev/null || kill -KILL ${pid}`]);
    rmSync(t.local, { recursive: true, force: true });
  }

  /** Fetch a turn's folder and start its wrapper in the worker container. @param {string} dir @param {Launch} launch */
  async begin(dir, launch) {
    const t = newTurn({ dir, local: this.local(dir), launch, starting: true, boot: this.boot });
    this.turns.set(dir, t);
    this.save();
    try {
      if (!launch || !Array.isArray(launch.wrapper) || !launch.wrapper.every((a) => typeof a === 'string') || !Array.isArray(launch.roots) || !launch.roots.every((r) => this.mine(r)) || !this.mine(launch.home) || (launch.sync && !this.mine(launch.sync.at)))
        throw new Error('the app sent a start this worker cannot read');
      await this.fetchFolder(t);
      for (const r of launch.roots) mkdirSync(this.local(r), { recursive: true });
      if (launch.cwd && this.mine(launch.cwd)) mkdirSync(this.local(launch.cwd), { recursive: true });
      this.fitSpec(t);
      // A host turn's start (T8): the folders' files written after it are the ones its end counts.
      if (launch.host === true) writeFileSync(join(t.local, 'host-began'), '');
      await this.ensureContainer(launch, launch.host === true ? this.cfg.host : [], boxOf(this.cfg, launch));
      if (launch.sync && !t.dropped) await this.bring(t);
      if (t.dropped || !existsSync(join(t.local, 'spec.json'))) return;
      const wrapper = [this.cfg.node ?? launch.wrapper[0], ...launch.wrapper.slice(1)];
      const r = await this.exec(this.cfg.podman, ['exec', '-d', boxOf(this.cfg, launch), ...wrapper]);
      if (r.code) throw new Error(`the turn's wrapper did not start: ${r.err.trim()}`);
      this.log(`Turn ${dir.split('/').pop()} started.`);
    } catch (err) {
      this.log(`Turn ${dir.split('/').pop()} could not start: ${err.message}`);
      // Told as the turn's end, the way a container that won't start is at home.
      if (existsSync(t.local) && !existsSync(join(t.local, 'exit.json'))) writeFileSync(join(t.local, 'exit.json'), JSON.stringify({ code: null, signal: null, error: `${boxOf(this.cfg, launch)}: ${err.message}` }));
      else if (!existsSync(t.local)) this.turns.delete(dir);
    } finally {
      t.starting = false;
      // From the top: the server's copy is empty, and this one starts as the folder it sent.
      t.acked = Object.fromEntries(APPENDED.map((n) => [n, 0]));
    }
  }

  /** Bring the minion's worktree, session and folders here, before its turn starts. @param {Turn} t */
  async bring(t) {
    for (let tries = 1; ; tries++) {
      const r = await this.stateSync(t, { start: true });
      if (r.gone) return void (t.dropped = true);
      if (r.ok) break;
      if (tries >= 3) throw new Error(`this minion's files could not be brought here: ${r.error}`);
      await sleep(2000);
    }
    t.seeded = true;
    t.checked = Date.now();
    t.ref = this.headLog(t);
    this.save();
  }

  /** The turn's folder from the server, unpacked here. @param {Turn} t */
  async fetchFolder(t) {
    const res = await this.call(`/api/machines/turn-folder?dir=${encodeURIComponent(t.dir)}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`the app answered ${res.status} for the turn's folder`);
    mkdirSync(t.local, { recursive: true, mode: 0o700 });
    const tar = spawn('tar', ['-C', t.local, '-xf', '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    tar.stderr.on('data', (d) => (err += d));
    const done = new Promise((ok, fail) => tar.on('error', fail).on('exit', (code) => (code ? fail(new Error(`tar: ${err.trim() || `exit ${code}`}`)) : ok(null))));
    tar.stdin.on('error', () => {});
    for await (const chunk of res.body) if (!tar.stdin.write(chunk)) await new Promise((r) => tar.stdin.once('drain', r));
    tar.stdin.end();
    await done;
  }

  /** The turn's spec, fitted to this machine: its tools call home through the forwarder, and claude and node are the image's. @param {Turn} t */
  fitSpec(t) {
    const file = join(t.local, 'spec.json');
    const spec = JSON.parse(readFileSync(file, 'utf8'));
    spec.env = { ...spec.env, COORDINATOR_API: `http://127.0.0.1:${this.port}` };
    // The sign-in is this machine's own, in the container's home volume: the server's config folder isn't here.
    delete spec.env.CLAUDE_CONFIG_DIR;
    // The turn's temp, files and shared folders are there even with nothing to bring.
    for (const dir of [spec.env.TMPDIR, spec.env.COORDINATOR_FILES_DIR, spec.env.COORDINATOR_SHARED_DIR]) if (this.mine(dir) && t.launch.roots.some((r) => dir.startsWith(`${r}/`))) mkdirSync(this.local(dir), { recursive: true });
    if (this.cfg.claude) spec.command = this.cfg.claude;
    if (this.cfg.node && spec.pool) spec.pool.node = this.cfg.node;
    writeFileSync(file, JSON.stringify(spec), { mode: 0o600 });
  }

  /**
   * The worker container, running from the spec `launch` needs. One running from another spec is replaced only when no
   * turn runs in it (shortcut: a busy one keeps its old mounts, as a person's container at home does).
   * @param {Launch} launch @param {{ src: string, dst: string, ro?: boolean }[]} [extraMounts] @param {string} [container] a host turn's own (boxOf)
   */
  async ensureContainer(launch, extraMounts = [], container = this.cfg.container) {
    const { podman } = this.cfg;
    const args = containerArgs(this.cfg, launch, extraMounts, container);
    const want = args[args.indexOf('--label') + 1].split('=')[1];
    const st = await this.exec(podman, ['container', 'inspect', '--format', '{{.State.Running}} {{index .Config.Labels "citadel.spec"}}', container]);
    const [running, has] = st.code ? [] : st.out.trim().split(' ');
    const others = [...this.turns.values()].some((t) => boxOf(this.cfg, t.launch) === container && !t.starting && !existsSync(join(t.local, 'exit.json')));
    if (running === 'true' && (has === want || others)) return;
    const r = await this.exec(podman, ['run', '-d', ...args], 15 * 60_000);
    if (r.code) throw new Error(`the worker container did not start: ${r.err.trim().split('\n').pop()}`);
    await this.version(['exec', container]);
  }

  /** Its load and sign-in, for the app's placement: each read again as it ages, on the sync that finds it old. */
  facts(now = Date.now()) {
    if (now - this.load.at >= LOAD_MS) this.load = { at: now, now: hostLoad() };
    if (now - this.signedIn.at >= SIGNED_IN_MS) {
      this.signedIn.at = now;
      void this.checkSignIn();
    }
    return { load: this.load.now, signedIn: this.signedIn.now };
  }

  /** Whether the worker's home volume holds a Claude sign-in: that the file is there, never what is in it. */
  async checkSignIn() {
    const { podman, container, image } = this.cfg;
    const has = await this.exec(podman, ['volume', 'ls', '-q', '--filter', `name=^${container}-home$`]);
    if (has.code) return void (this.signedIn.now = null);
    if (!has.out.trim()) return void (this.signedIn.now = false);
    // Words, not an exit code: a podman that failed or timed out says nothing about the sign-in.
    const said = (await this.exec(podman, ['run', '--rm', '--userns=keep-id', '-v', `${container}-home:/h:ro`, image, 'sh', '-c', 'test -s /h/.claude/.credentials.json && echo yes || echo no'])).out.trim();
    this.signedIn.now = said === 'yes' ? true : said === 'no' ? false : null;
  }

  /** `claude --version` there, by `podman <how…>`. @param {string[]} how */
  async version(how) {
    const v = await this.exec(this.cfg.podman, [...how, this.cfg.claude ?? 'claude', '--version'], 15 * 60_000);
    // Unknown when it can't say: the server then places nothing here, rather than trust an old answer.
    this.claude = v.code ? null : v.out.trim().split('\n')[0].slice(0, 80) || null;
    this.poke();
  }

  /**
   * The forwarder: turns' tool servers call it on this machine's loopback (their COORDINATOR_API), and each request goes
   * to the app's machines address with this machine's token, the turn's own moved to X-Turn-Authorization. It keeps one
   * port for good (running turns hold it in their env), saved in the worker's root.
   */
  forward() {
    const up = new URL(this.appUrl);
    this.server = createServer((req, res) => {
      const headers = { ...req.headers, host: up.host, authorization: `Bearer ${this.token}`, 'x-turn-authorization': String(req.headers.authorization ?? '') };
      delete headers.connection;
      // A turn's sync program (stateSync) calls through here too, so it holds no token either.
      const path = req.url?.startsWith('/_state/') ? `/api/machines/state/${req.url.slice(8)}` : `/api/machines/turn-call${req.url}`;
      const out = (up.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(path, up), { method: req.method, headers }, async (back) => {
        // What the call wrote at home is here before the turn hears that it did.
        const t = this.turns.get(String(back.headers['x-citadel-sync'] ?? ''));
        if (t?.seeded) await this.stateSync(t, {});
        res.writeHead(back.statusCode ?? 502, back.headers);
        back.pipe(res);
      });
      out.on('error', (err) => {
        if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `This machine could not reach the app: ${err.message}` }));
        else res.destroy();
      });
      res.on('close', () => out.destroy());
      req.pipe(out);
    });
    const portFile = join(this.cfg.root, 'forward-port');
    const last = Number(read(portFile)) || 0;
    const listen = (/** @type {number} */ port) =>
      new Promise((ok) => {
        this.server.once('error', () => ok(false));
        this.server.listen(port, '127.0.0.1', () => ok(true));
      });
    return (async () => {
      if (!(last && (await listen(last))) && !(await listen(0))) throw new Error('the worker could not listen on 127.0.0.1');
      this.port = this.server.address().port;
      writeFileSync(portFile, String(this.port));
    })();
  }

  /**
   * The worker's self-test, a line each: the container runs; a file written on either side of a mounted folder shows on
   * the other; and the wall (host reach, T8): no /mnt/c inside, and a Windows program can't start there.
   * @param {Launch} launch @returns {Promise<{ name: string, ok: boolean, text: string }[]>}
   */
  async selfTest(launch) {
    const { podman, container } = this.cfg;
    const lines = [];
    const line = (/** @type {string} */ name, /** @type {boolean} */ ok, /** @type {string} */ text) => lines.push({ name, ok, text });
    const inside = (/** @type {string} */ sh) => this.exec(podman, ['exec', container, 'sh', '-c', sh]);
    try {
      for (const r of launch.roots) mkdirSync(this.local(r), { recursive: true });
      await this.ensureContainer(launch);
      line('container', true, `${container} runs from ${this.cfg.image}; claude there is ${this.claude ?? 'not found'}`);
    } catch (err) {
      line('container', false, err.message);
      return lines;
    }
    const root = launch.roots[0];
    const probe = join(root, '.self-test');
    mkdirSync(this.local(probe), { recursive: true });
    writeFileSync(join(this.local(probe), 'from-host'), 'host');
    const seen = await inside(`cat ${probe}/from-host && echo inside > ${probe}/from-container`);
    const back = read(join(this.local(probe), 'from-container'));
    line('folders', seen.out.trim() === 'host' && back?.trim() === 'inside', seen.out.trim() === 'host' && back?.trim() === 'inside' ? 'a file written on either side of a mounted folder shows on the other' : `a mounted folder does not pass files both ways: ${seen.err.trim() || 'the file did not arrive'}`);
    const mnt = await inside('test -e /mnt/c');
    line('no host disk', mnt.code !== 0, mnt.code !== 0 ? '/mnt/c is not visible inside the container' : '/mnt/c IS visible inside the container');
    const cmd = '/mnt/c/Windows/System32/cmd.exe';
    if (!existsSync(cmd)) line('no Windows programs', true, 'not a Windows PC (no /mnt/c here), so there is no Windows program to try');
    else {
      copyFileSync(cmd, join(this.local(probe), 'cmd.exe'));
      chmodSync(join(this.local(probe), 'cmd.exe'), 0o755);
      const exe = await inside(`${probe}/cmd.exe /c exit 0`);
      line('no Windows programs', exe.code !== 0, exe.code !== 0 ? 'a Windows program (cmd.exe) cannot start inside the container' : 'cmd.exe STARTED inside the container: WSL interop reaches it');
    }
    rmSync(this.local(probe), { recursive: true, force: true });
    return lines;
  }
}

// As a program: the self-test, with a scratch folder standing in for a turn's.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--self-test') {
  const config = JSON.parse(readFileSync(process.argv[3], 'utf8')).worker;
  const w = new Worker({ config, appUrl: 'http://127.0.0.1:9', token: '' });
  const lines = await w.selfTest({ wrapper: [], cwd: null, home: '/home/worker', roots: ['/citadel-self-test'] });
  for (const l of lines) console.log(`${l.ok ? 'ok  ' : 'FAIL'} ${l.name}: ${l.text}`);
  process.exit(lines.every((l) => l.ok) ? 0 : 1);
}
