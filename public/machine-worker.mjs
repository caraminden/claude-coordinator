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
import { isAbsolute, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const SYNC_MS = 500;
/** The most of one file's new bytes in one sync: a long stream catches up over several. */
const CHUNK = 2_000_000;
const APPENDED = ['stream.jsonl', 'stderr.log'];
const WHOLE = ['pid.json', 'steer.sent', 'exit.json'];
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
  };
}

/**
 * podman run's arguments for the worker container, after `run`: the server's own shape (src/containers.ts runArgs), a
 * home volume the sign-in lives in, and each of `roots` from under the worker's root at the path the server has it.
 * Nothing else of this computer is in it: no /mnt/c, no interop socket. `extraMounts` is for a minion its owner gave
 * host folders to (T8, host reach); a plain worker passes none.
 * @param {ReturnType<typeof workerConfig>} cfg @param {{ home: string, roots: string[] }} launch @param {{ src: string, dst: string, ro?: boolean }[]} [extraMounts]
 */
export function containerArgs(cfg, launch, extraMounts = []) {
  const binds = [...launch.roots.map((r) => ({ src: join(cfg.root, 'fs', r), dst: r, ro: false })), ...extraMounts];
  const spec = JSON.stringify([cfg.image, launch.home, binds]);
  const args = ['--rm', '--replace', '--name', cfg.container, '--init', '--userns=keep-id', '--network=host', '--pids-limit=32768', '--label', `citadel.spec=${createHash('sha256').update(spec).digest('hex').slice(0, 12)}`];
  args.push('-e', `HOME=${launch.home}`, '-v', `${cfg.container}-home:${launch.home}:U`);
  for (const m of binds) args.push('--mount', `type=bind,src=${m.src},dst=${m.dst}${m.ro ? ',ro' : ''}`);
  args.push(cfg.image, 'sleep', 'infinity');
  return args;
}

/** @param {string} cmd @param {string[]} args @param {number} [timeout] @returns {Promise<{ code: number, out: string, err: string }>} */
const run = (cmd, args, timeout = 60_000) => new Promise((done) => execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (err, out, stderr) => done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out), err: String(stderr || err?.message || '') })));

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
 * @typedef {{ wrapper: string[], cwd: string | null, home: string, roots: string[] }} Launch
 * @typedef {{ dir: string, local: string, launch: Launch, applied: number, acked: Record<string, number> | null, sentWhole: Record<string, string>, starting: boolean, dropped: boolean }} Turn
 */

export class Worker {
  /** @param {{ config: unknown, appUrl: string, token: string, log?: (...a: unknown[]) => void, run?: typeof run }} o */
  constructor(o) {
    this.cfg = workerConfig(o.config);
    this.appUrl = o.appUrl;
    this.token = o.token;
    this.log = o.log ?? (() => {});
    this.exec = o.run ?? run;
    /** @type {Map<string, Turn>} */
    this.turns = new Map();
    this.claude = null;
    this.busy = false;
    this.again = false;
    this.port = 0;
    mkdirSync(join(this.cfg.root, 'fs'), { recursive: true, mode: 0o700 });
    // The turns an earlier run of this agent held: their wrappers ran on in the container without it.
    try {
      for (const t of JSON.parse(readFileSync(this.index(), 'utf8'))) if (this.mine(t.dir) && existsSync(this.local(t.dir))) this.turns.set(t.dir, { dir: t.dir, local: this.local(t.dir), launch: t.launch, applied: Number(t.applied) || 0, acked: null, sentWhole: {}, starting: false, dropped: false });
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
    writeFileSync(`${this.index()}.tmp`, JSON.stringify([...this.turns.values()].map((t) => ({ dir: t.dir, launch: t.launch, applied: t.applied }))), { mode: 0o600 });
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

  /** Log a trouble once until it changes, not twice a second. @param {string} text */
  quiet(text) {
    if (text !== this.said) this.log((this.said = text));
  }

  /** @param {string} path @param {RequestInit} [init] */
  call(path, init = {}) {
    return fetch(new URL(path, this.appUrl), { ...init, headers: { Authorization: `Bearer ${this.token}`, ...init.headers } });
  }

  async sync() {
    const turns = [...this.turns.values()].map((t) => this.report(t));
    const res = await this.call('/api/machines/turns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ worker: { claude: this.claude, max: this.cfg.max }, turns: turns.map((r) => r.body) }), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`it answered ${res.status}`);
    this.said = null;
    const reply = await res.json();
    for (const r of turns) await this.heard(r.turn, r, reply.turns?.[r.turn.dir]);
    for (const s of Array.isArray(reply.start) ? reply.start : []) {
      if (!this.mine(s?.dir) || this.turns.has(s.dir)) continue;
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
      if (text === null || text === t.sentWhole[name] || (name === 'exit.json' && !caughtUp)) continue;
      put[name] = text;
    }
    let beat = Infinity;
    try {
      beat = Date.now() - statSync(join(t.local, 'beat')).mtimeMs;
    } catch {}
    const body = { dir: t.dir, append, put, steer: size(join(t.local, 'steer.jsonl')), signals: t.applied, alive: t.starting || beat < BEAT_STALE_MS };
    return { turn: t, body, put };
  }

  /** The server's answer for a turn. @param {Turn} t @param {{ put: Record<string, string> }} sent @param {any} r */
  async heard(t, sent, r) {
    if (!r) return;
    if (r.gone) return this.drop(t);
    t.acked = r.sizes ?? {};
    Object.assign(t.sentWhole, sent.put);
    if (typeof r.steer === 'string' && existsSync(t.local)) appendFileSync(join(t.local, 'steer.jsonl'), Buffer.from(r.steer, 'base64'));
    if (Array.isArray(r.signals) && r.signals.length) await this.signal(t, r.signals);
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
      await this.exec(this.cfg.podman, ['exec', this.cfg.container, 'sh', '-c', `kill -${s} -${pid} 2>/dev/null || kill -${s} ${pid}`]);
    }
    t.applied += sigs.length;
    this.save();
  }

  /** The server no longer follows it: whatever still runs is killed, and its folder here goes. @param {Turn} t */
  async drop(t) {
    this.turns.delete(t.dir);
    this.save();
    const pid = this.pid(t);
    if (pid && !existsSync(join(t.local, 'exit.json'))) await this.exec(this.cfg.podman, ['exec', this.cfg.container, 'sh', '-c', `kill -KILL -${pid} 2>/dev/null || kill -KILL ${pid}`]);
    rmSync(t.local, { recursive: true, force: true });
  }

  /** Fetch a turn's folder and start its wrapper in the worker container. @param {string} dir @param {Launch} launch */
  async begin(dir, launch) {
    /** @type {Turn} */
    const t = { dir, local: this.local(dir), launch, applied: 0, acked: null, sentWhole: {}, starting: true, dropped: false };
    this.turns.set(dir, t);
    this.save();
    try {
      if (!launch || !Array.isArray(launch.wrapper) || !launch.wrapper.every((a) => typeof a === 'string') || !Array.isArray(launch.roots) || !launch.roots.every((r) => this.mine(r)) || !this.mine(launch.home)) throw new Error('the app sent a start this worker cannot read');
      await this.fetchFolder(t);
      for (const r of launch.roots) mkdirSync(this.local(r), { recursive: true });
      // shortcut: an empty folder where the minion's worktree goes, until state sync (T3) brings it.
      if (launch.cwd && this.mine(launch.cwd)) mkdirSync(this.local(launch.cwd), { recursive: true });
      this.fitSpec(t);
      await this.ensureContainer(launch);
      if (t.dropped || !existsSync(join(t.local, 'spec.json'))) return;
      const wrapper = [this.cfg.node ?? launch.wrapper[0], ...launch.wrapper.slice(1)];
      const r = await this.exec(this.cfg.podman, ['exec', '-d', this.cfg.container, ...wrapper]);
      if (r.code) throw new Error(`the turn's wrapper did not start: ${r.err.trim()}`);
      this.log(`Turn ${dir.split('/').pop()} started.`);
    } catch (err) {
      this.log(`Turn ${dir.split('/').pop()} could not start: ${err.message}`);
      // Told as the turn's end, the way a container that won't start is at home.
      if (existsSync(t.local) && !existsSync(join(t.local, 'exit.json'))) writeFileSync(join(t.local, 'exit.json'), JSON.stringify({ code: null, signal: null, error: `${this.cfg.container}: ${err.message}` }));
      else if (!existsSync(t.local)) this.turns.delete(dir);
    } finally {
      t.starting = false;
      // From the top: the server's copy is empty, and this one starts as the folder it sent.
      t.acked = Object.fromEntries(APPENDED.map((n) => [n, 0]));
    }
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
    if (this.cfg.claude) spec.command = this.cfg.claude;
    if (this.cfg.node && spec.pool) spec.pool.node = this.cfg.node;
    writeFileSync(file, JSON.stringify(spec), { mode: 0o600 });
  }

  /**
   * The worker container, running from the spec `launch` needs. One running from another spec is replaced only when no
   * turn runs in it (shortcut: a busy one keeps its old mounts, as a person's container at home does).
   * @param {Launch} launch @param {{ src: string, dst: string, ro?: boolean }[]} [extraMounts]
   */
  async ensureContainer(launch, extraMounts = []) {
    const { podman, container } = this.cfg;
    const args = containerArgs(this.cfg, launch, extraMounts);
    const want = args[args.indexOf('--label') + 1].split('=')[1];
    const st = await this.exec(podman, ['container', 'inspect', '--format', '{{.State.Running}} {{index .Config.Labels "citadel.spec"}}', container]);
    const [running, has] = st.code ? [] : st.out.trim().split(' ');
    const others = [...this.turns.values()].some((t) => !t.starting && !existsSync(join(t.local, 'exit.json')));
    if (running === 'true' && (has === want || others)) return;
    const r = await this.exec(podman, ['run', '-d', ...args], 15 * 60_000);
    if (r.code) throw new Error(`the worker container did not start: ${r.err.trim().split('\n').pop()}`);
    await this.version(['exec', container]);
  }

  /** `claude --version` there, by `podman <how…>`. @param {string[]} how */
  async version(how) {
    const v = await this.exec(this.cfg.podman, [...how, this.cfg.claude ?? 'claude', '--version'], 15 * 60_000);
    // Unknown when it can't say: the server then places nothing here, rather than trust an old answer.
    this.claude = v.code ? null : v.out.trim().split('\n')[0].slice(0, 80) || null;
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
      const out = (up.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(`/api/machines/turn-call${req.url}`, up), { method: req.method, headers }, (back) => {
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
