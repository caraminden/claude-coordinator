#!/usr/bin/env node
// A minion worker's own program (Build 7 T5), on Linux or in a Windows PC's citadel-workers distro. tools/worker/install-worker.sh
// makes it a service there, run only by the PC's machine agent: its Set up on Minion turns, or on Linux its elevate script (H2). It runs the worker that syncs and starts turns (machine-worker.mjs, downloaded from the app), keeps
// that worker's image current (the app's build files, with the app's own claude version on top), holds the owner's caps from
// config.json, and runs the self-test the owner asks for on the Machines page. It is apart from machine-agent.mjs, and opens no
// connection of its own, because that computer's agent holds the machine's one connection.
//   node worker-agent.mjs <app url> <config.json>
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, homedir, hostname, totalmem } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPORT_MS = 2_000;
const DISK_MS = 5 * 60_000;
const SIGN_IN_MS = 10_000;
/** A failed image build is tried again after this long. */
const BUILD_AGAIN_MS = 10 * 60_000;
const BUILD_MS = 60 * 60_000;
const IMAGE = 'localhost/citadel-worker';
/** Before there is an image: never run, so podman doesn't go looking for it. */
const NO_IMAGE = `${IMAGE}:none`;
/** Exit status the service takes as "don't start me again" (RestartPreventExitStatus): a newer install has this machine's token. */
const REPLACED = 64;
/** The root helper's one command this user may run through sudo (install-worker.sh's sudoers file): the page's caps, raised. */
const PAGE_CAPS = ['-n', '/usr/local/bin/citadel-worker', 'page-caps'];
/** Where the self-test's folders show inside its container. */
const TEST_ROOT = '/citadel-self-test';
/** Where `citadel-worker folder add` mounts each of the owner's host folders in this distro, as root (T8). */
export const HOST_SRC = '/mnt/citadel-host';
/** A host folder's name: its place in a marked minion's container, /host/<name>. */
export const FOLDER_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/** @param {string} cmd @param {string[]} args @param {number} [timeout] @returns {Promise<{ code: number, out: string, err: string }>} */
const run = (cmd, args, timeout = 60_000) => new Promise((done) => execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (err, out, stderr) => done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out), err: String(stderr || err?.message || '') })));
const lastLine = (/** @type {string} */ s) => s.trim().split('\n').pop()?.slice(0, 300) ?? '';

/** The owner's config, checked; throws with what is wrong. @param {unknown} raw */
export function agentConfig(raw) {
  const c = /** @type {Record<string, unknown>} */ (raw ?? {});
  const num = (/** @type {string} */ k, /** @type {number} */ max) => {
    const n = Number(c[k]);
    if (!Number.isFinite(n) || n < 1 || n > max) throw new Error(`${k} must be a number from 1 to ${max}`);
    return Math.floor(n);
  };
  if (typeof c.root !== 'string' || !isAbsolute(c.root)) throw new Error('root must be a full path');
  return {
    root: c.root,
    /** An image of the owner's own in place of Citadel's; they keep it current. */
    image: typeof c.image === 'string' && c.image ? c.image : null,
    podman: typeof c.podman === 'string' ? c.podman : 'podman',
    caps: { workers: num('workers', 64), threads: num('threads', 1024), memory_gb: num('memory_gb', 4096), disk_gb: num('disk_gb', 100_000) },
    ...hostFolders(c.folders),
  };
}

/**
 * The caps the Machines page sent (Build 7 M3): whole numbers from 0, each a ceiling under config.json's; anything else is left out.
 * @param {unknown} raw @returns {Partial<Record<'workers' | 'threads' | 'memory_gb' | 'disk_gb', number>>}
 */
export function pageCaps(raw) {
  const c = /** @type {Record<string, unknown>} */ (raw && typeof raw === 'object' ? raw : {});
  /** @type {Partial<Record<'workers' | 'threads' | 'memory_gb' | 'disk_gb', number>>} */
  const out = {};
  for (const k of /** @type {const} */ (['workers', 'threads', 'memory_gb', 'disk_gb'])) if (Number.isInteger(c[k]) && /** @type {number} */ (c[k]) >= 0) out[k] = /** @type {number} */ (c[k]);
  return out;
}

/**
 * The owner's host folders (T8, "Chosen folders + programs"): { <name>: { path, write? } } in config.json, which only
 * `citadel-worker folder` (as root) changes. A bad one is left out with a problem saying why; read-only unless write is true.
 * @param {unknown} raw @returns {{ folders: { name: string, path: string, write: boolean }[], problems: string[] }}
 */
export function hostFolders(raw) {
  /** @type {{ name: string, path: string, write: boolean }[]} */
  const folders = [];
  /** @type {string[]} */
  const problems = [];
  if (raw === undefined || raw === null) return { folders, problems };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { folders, problems: ['folders must be { <name>: { path, write } }'] };
  for (const [name, v] of Object.entries(raw)) {
    const f = /** @type {Record<string, unknown>} */ (v ?? {});
    if (!FOLDER_NAME.test(name)) problems.push(`folder "${name}": names are lower-case letters, digits, - and _`);
    else if (typeof f.path !== 'string' || !folderPath(f.path)) problems.push(`folder ${name}: its path must be a full Windows or Linux path to a folder, not a whole drive`);
    else if (f.write !== undefined && typeof f.write !== 'boolean') problems.push(`folder ${name}: write must be true or false`);
    else folders.push({ name, path: f.path, write: f.write === true });
  }
  return { folders: folders.slice(0, 20), problems: folders.length > 20 ? [...problems, 'only the first 20 folders are used'] : problems };
}

/** A folder's path as the owner gives it: C:\\Users\\me\\Photos, or /home/me/photos on Linux. Never a drive's root, nor / . @param {string} p */
export function folderPath(p) {
  if (/[\0-\x1f,]/.test(p)) return false;
  if (/^[A-Za-z]:\\/.test(p)) return /^[A-Za-z]:\\(?!\\)[^:*?"<>|]*[^\\:*?"<>|\s]$/.test(p) && !/(^|\\)\.\.(\\|$)/.test(p);
  return isAbsolute(p) && normalize(p) === p && p !== '/' && !p.endsWith('/');
}

/** Which of `folders` are mounted at HOST_SRC now (citadel-worker mount-folders), from this distro's mount table. @param {string} [table] */
export function mountedFolders(table = safeRead('/proc/self/mountinfo')) {
  const at = new Set(
    table
      .split('\n')
      .map((l) => l.split(' ')[4] ?? '')
      .filter((p) => p.startsWith(`${HOST_SRC}/`))
      .map((p) => p.slice(HOST_SRC.length + 1)),
  );
  return at;
}

/** The binds a marked minion's container gets: each mounted folder at /host/<name>, read-only unless the owner said write. @param {{ name: string, write: boolean }[]} folders @param {Set<string>} mounted */
export function hostMounts(folders, mounted) {
  return folders.filter((f) => mounted.has(f.name)).map((f) => ({ src: `${HOST_SRC}/${f.name}`, dst: `/host/${f.name}`, ro: !f.write }));
}

export class WorkerAgent {
  /** @param {{ config: unknown, appUrl: string, token: string, Worker: typeof import('./machine-worker.mjs').Worker, accounts?: { ACCOUNTS: number, accountDir: (n: number) => string }, installed?: number, log?: (...a: unknown[]) => void, run?: typeof run, exit?: (code: number) => void }} o */
  constructor(o) {
    this.cfg = agentConfig(o.config);
    this.appUrl = o.appUrl;
    this.token = o.token;
    this.Worker = o.Worker;
    /** The account folders to watch for a sign-in: machine-worker.mjs's own (ACCOUNTS, accountDir), so a raised count follows; without them (an older copy of it) the first only. */
    this.accountDirs = o.accounts ? Array.from({ length: o.accounts.ACCOUNTS }, (_, i) => o.accounts.accountDir(i + 1)) : ['.claude'];
    this.log = o.log ?? (() => {});
    this.exec = o.run ?? run;
    /** @type {typeof run} */
    this.podman = (cmd, args, timeout) => (args.includes(NO_IMAGE) ? Promise.resolve({ code: 1, out: '', err: 'no image yet' }) : this.exec(cmd, args, timeout));
    this.exit = o.exit ?? ((code) => process.exit(code));
    this.boot = randomBytes(8).toString('hex');
    this.installed = o.installed ?? 0;
    /** Another program spoke for this machine a moment ago: it ends its turns first. */
    this.wait = true;
    /** The caps its owner set on the Machines page (Build 7 M3), from each sync's reply: it holds these where set, else config.json's (want). */
    this.page = {};
    /** What this PC has: the page's threads and memory are held to it. */
    this.here = { threads: cpus().length, memory_gb: Math.floor(totalmem() / 1024 ** 3) };
    /** The threads and memory the root helper last set this PC's slice to (#2085); null: config.json's, as install and caps set it. */
    this.slice = null;
    /** The last threads and memory it asked the root helper for, so a refused ask is made once until they change. */
    this.asked = '';
    this.raising = false;
    // WSL2 says so in its kernel's name; the app then shows PowerShell commands.
    this.wsl = /microsoft/i.test(safeRead('/proc/sys/kernel/osrelease'));
    // No image yet: its claude is unknown, so the app places nothing here until it is.
    this.worker = this.newWorker('citadel-worker', this.cfg.root, this.cfg.image ?? NO_IMAGE);
    this.worker.cfg.max = 0;
    /** @type {{ state: string, text: string } | null} */
    this.image = this.cfg.image ? { state: 'own', text: this.cfg.image } : null;
    this.building = false;
    this.builtAt = 0;
    /** @type {boolean | null} */
    this.github = null;
    /** @type {number | null} */
    this.disk = null;
    this.at = { disk: 0, signIn: 0, worker: 0 };
    /** The agent code's hash as the app first gave it. @type {string | null} */
    this.code = null;
    /** @type {{ id: string, done: boolean, lines: { key: string, state: string, text: string }[] } | null} */
    this.test = null;
  }

  /** @param {string} container @param {string} root @param {string} image */
  newWorker(container, root, image) {
    // No link of the agent's here: a start, steer or stop reaches it at its next sync (SYNC_MS, half a second). Machines.pokeWorker
    // writes to the PC's other agent's stream, if it has one, whose worker is null without a worker block.
    const w = new this.Worker({ config: { root, image, container, podman: this.cfg.podman, max: this.cfg.caps.workers, node: 'node', claude: 'claude' }, appUrl: this.appUrl, token: this.token, log: this.log, run: this.podman });
    const call = w.call.bind(w);
    // Its syncs say they are this program's: another worker with this token (an agent's worker block) is refused.
    w.call = (path, init = {}) => call(path, { ...init, headers: { ...init.headers, 'X-Citadel-Worker': this.boot } });
    return w;
  }

  async start() {
    this.worker.cfg.host = hostMounts(this.cfg.folders, mountedFolders());
    await this.worker.start();
    this.fit();
    this.log(`Minion turns: up to ${this.cfg.caps.workers} at once, in ${this.cfg.root}`);
    for (;;) {
      await this.report().catch((err) => this.quiet(`Could not reach the app (${err.message})`));
      if (this.stopped) return;
      await sleep(REPORT_MS);
    }
  }

  stop() {
    this.stopped = true;
    this.worker.stop();
  }

  /** Log a trouble once until it changes. @param {string} text */
  quiet(text) {
    if (text !== this.said) this.log((this.said = text));
  }

  /** @param {string} path @param {RequestInit} [init] */
  call(path, init = {}) {
    return fetch(new URL(path, this.appUrl), { ...init, headers: { Authorization: `Bearer ${this.token}`, ...init.headers }, signal: init.signal ?? AbortSignal.timeout(30_000) });
  }

  /** @param {string} path @param {RequestInit} [init] */
  async json(path, init) {
    const res = await this.call(path, init);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `it answered ${res.status}`);
    return body;
  }

  /** What its owner wants: the Machines page's caps where set, else config.json's (the PC's own); threads and memory within what this PC has. */
  want() {
    const c = this.cfg.caps;
    /** @param {'workers' | 'threads' | 'memory_gb' | 'disk_gb'} k */
    const pick = (k) => this.page[k] ?? c[k];
    return { workers: pick('workers'), threads: Math.min(pick('threads'), this.here.threads), memory_gb: Math.min(pick('memory_gb'), this.here.memory_gb), disk_gb: pick('disk_gb') };
  }

  /** The caps it holds now: what its owner wants, threads and memory as far as this PC's slice was set. */
  held() {
    const w = this.want();
    const slice = this.slice ?? this.cfg.caps;
    return { ...w, threads: Math.min(w.threads, slice.threads), memory_gb: Math.min(w.memory_gb, slice.memory_gb) };
  }

  /**
   * Set this PC's slice to the threads and memory its owner wants, through the root helper (citadel-worker page-caps), at
   * its first sync and whenever they change: config.json stays the PC's own, and the worker holds workers and disk itself.
   */
  async raise() {
    const w = this.want();
    const ask = `${w.threads} ${w.memory_gb}`;
    if (ask === this.asked || this.raising) return;
    this.asked = ask;
    this.raising = true;
    const got = await this.exec('sudo', [...PAGE_CAPS, '--threads', String(w.threads), '--memory', String(w.memory_gb)]).finally(() => (this.raising = false));
    if (!got.code) {
      this.slice = { threads: w.threads, memory_gb: w.memory_gb };
      this.log(lastLine(got.out));
    } else if (w.threads > (this.slice ?? this.cfg.caps).threads || w.memory_gb > (this.slice ?? this.cfg.caps).memory_gb)
      // Only a raise needs it: a PC set up before the helper holds lower ones on its containers (fit).
      this.log(`Could not raise this PC's threads and memory to the Machines page's (${lastLine(got.err || got.out)}). A PC set up before this could run its install command again, or citadel-worker caps sets them here.`);
    this.fit();
  }

  full() {
    return this.disk !== null && this.disk >= this.held().disk_gb;
  }

  /** The owner's most workers, or none while there is no image, it has only just taken this machine over or the disk cap is reached: turns that run go on. */
  fit() {
    this.worker.cfg.max = this.wait || this.full() || !(this.image?.state === 'own' || this.image?.state === 'ready') ? 0 : this.held().workers;
    // Threads and memory below what the PC's slice holds go on its containers too (machine-worker.mjs containerArgs).
    const held = this.held();
    const slice = this.slice ?? this.cfg.caps;
    this.worker.cfg.limits = held.threads < slice.threads || held.memory_gb < slice.memory_gb ? { threads: held.threads, memory_gb: held.memory_gb } : null;
  }

  /** Tell the app how this worker stands, and do what it answers. */
  async report() {
    // The owner's folders as mounted now: a marked minion's turn starting next gets these (machine-worker.mjs boxOf).
    const mounted = mountedFolders();
    this.worker.cfg.host = hostMounts(this.cfg.folders, mounted);
    const folders = this.cfg.folders.map((f) => ({ ...f, ready: mounted.has(f.name) }));
    const body = { boot: this.boot, installed: this.installed, host: hostname(), wsl: this.wsl, caps: this.cfg.caps, held: this.held(), image: this.image, github: this.github, disk_gb: this.disk, full: this.full(), test: this.test, folders, folder_problems: this.cfg.problems };
    const reply = await this.json('/api/machines/worker', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    this.said = null;
    if (!this.code && !reply.replaced) this.log(`Connected to ${this.appUrl} as ${hostname()}`);
    if (reply.replaced) {
      this.log('Another worker has this machine: this one stops, and its turns with it. (Run the install command here again to move it back.)');
      this.stop();
      // The other one is handed these turns: they must not run on both.
      await this.exec(this.cfg.podman, ['rm', '-f', '-t', '0', 'citadel-worker']);
      // And a marked minion's own container, with the owner's folders (T8).
      await this.exec(this.cfg.podman, ['rm', '-f', '-t', '0', 'citadel-worker-host']);
      this.worker.turns.clear();
      this.worker.save();
      return this.exit(REPLACED);
    }
    this.wait = reply.wait === true;
    this.page = pageCaps(reply.caps);
    this.fit();
    void this.raise();
    // Newer code at the app: the service starts this again, on it. Turns run on in the container, but a restart can wait for them.
    this.code ??= reply.agent;
    if (reply.agent !== this.code && !this.worker.turns.size && !this.building && !this.testing) {
      this.log('The app has newer worker code: starting again on it.');
      this.stop();
      return this.exit(0);
    }
    // Ships go first: a build would slow the tests a ship is waiting on.
    if (reply.ships && !this.building && !this.image) this.image = { state: 'building', text: "Waiting for a ship's tests on this PC to end." };
    else if (reply.claude && reply.image && !reply.ships) void this.keepImage(String(reply.claude).split(' ')[0], reply.image);
    void this.keepFacts();
    if (reply.test && reply.test !== this.test?.id && !this.testing) void this.selfTest(reply.test);
    else if (!reply.test && this.test?.done) this.test = null;
  }

  /** The disk it uses and which sign-ins are there. */
  async keepFacts() {
    const now = Date.now();
    if (now - this.at.disk >= DISK_MS) {
      this.at.disk = now;
      // Inside podman's user namespace: an image's files belong to ids only that can read.
      const du = await this.exec('nice', ['-n', '19', this.cfg.podman, 'unshare', 'du', '-skxc', this.cfg.root, join(homedir(), '.local/share/containers')], 10 * 60_000);
      const kb = Number(du.out.trim().split('\n').pop()?.split('\t')[0]);
      this.disk = Number.isFinite(kb) && kb > 0 ? Math.round(kb / 104858) / 10 : this.disk;
      this.fit();
      if (this.full()) this.quiet(`Disk cap reached (${this.disk} of ${this.held().disk_gb} GB): no turn starts here.`);
    }
    if (now - this.at.signIn >= SIGN_IN_MS) {
      this.at.signIn = now;
      const vol = await this.exec(this.cfg.podman, ['volume', 'inspect', '--format', '{{.Mountpoint}}', 'citadel-worker-home']);
      const has = (/** @type {string} */ file) => (vol.code ? (/no such volume/i.test(vol.err) ? false : null) : thereIn(vol.out.trim(), file));
      this.github = has('.config/gh/hosts.yml');
      // The worker looks for itself every few minutes; a sign-in just made there shows at once.
      // Each account's folder (machine-worker.mjs accountDir): a sign-in made or gone in any of them is read again.
      const slots = this.accountDirs.map((dir) => has(`${dir}/.credentials.json`));
      const known = this.worker.signedIn.slots?.map((s) => s.n) ?? null;
      if (!slots.includes(null) && String(slots.flatMap((is, i) => (is ? [i + 1] : []))) !== String(known)) await this.worker.checkSignIn();
    }
  }

  /** Have the image the app's build files and claude make, and use it. @param {string} claude @param {{ hash: string, files: string[] }} want */
  async keepImage(claude, want) {
    if (this.cfg.image) {
      if (Date.now() - this.at.worker >= DISK_MS) {
        this.at.worker = Date.now();
        await this.worker.version(['run', '--rm', this.cfg.image]);
      }
      return;
    }
    if (!/^[\w.-]{1,40}$/.test(claude) || !/^[0-9a-f]{6,64}$/.test(want.hash)) return;
    const tag = `${IMAGE}:${want.hash}-${claude}`;
    if (this.building || (this.worker.cfg.image === tag && this.image?.state === 'ready')) return;
    if (this.image?.state === 'failed' && Date.now() - this.builtAt < BUILD_AGAIN_MS) return;
    this.building = true;
    this.builtAt = Date.now();
    try {
      if ((await this.exec(this.cfg.podman, ['image', 'exists', tag])).code) await this.build(tag, claude, want);
      const there = await this.exec(this.cfg.podman, ['container', 'inspect', '--format', '{{.ImageName}}', 'citadel-worker']);
      const from = there.code ? '' : there.out.trim();
      // Running turns keep the container they are in, and a turn started now would join them there: none is (fit), and the new image takes over when they end.
      // With no container (a reboot), the turns' next checkpoint makes one from the new image.
      if (this.worker.cfg.image !== tag && this.worker.turns.size && from && from !== tag) {
        if (this.worker.cfg.image === NO_IMAGE) this.worker.cfg.image = from;
        this.image = { state: 'building', text: 'Its new image is ready, and takes over when the turns running there end.' };
        return;
      }
      this.worker.cfg.image = tag;
      await this.worker.version(['run', '--rm', tag]);
      if (!this.worker.claude) throw new Error('claude does not start in the image it built');
      this.image = { state: 'ready', text: `claude ${claude}` };
      // What `citadel-worker signin` runs.
      writeFileSync(join(this.cfg.root, 'image-tag'), tag);
      this.log(`Image ready: ${tag}`);
      void this.prune(tag);
    } catch (err) {
      this.image = { state: 'failed', text: err.message.slice(0, 300) };
      this.log(`The image could not be built: ${err.message}`);
    } finally {
      this.building = false;
      this.fit();
    }
  }

  /** @param {string} tag @param {string} claude @param {{ hash: string, files: string[] }} want */
  async build(tag, claude, want) {
    const { podman, root } = this.cfg;
    const dir = join(root, 'image');
    const base = `${IMAGE}-base:${want.hash}`;
    const step = async (/** @type {string} */ text, /** @type {string[]} */ args) => {
      this.image = { state: 'building', text };
      this.log(text);
      const r = await this.exec('nice', ['-n', '19', podman, 'build', ...args], BUILD_MS);
      if (r.code) throw new Error(lastLine(r.err) || lastLine(r.out) || `podman build ended with ${r.code}`);
    };
    if ((await this.exec(podman, ['image', 'exists', base])).code) {
      rmSync(dir, { recursive: true, force: true });
      for (const f of want.files) {
        const to = join(dir, f);
        // Names come from the app; one that leaves the folder is never written.
        if (normalize(f) !== f || isAbsolute(f) || f.startsWith('..')) throw new Error('the app named a build file outside its folder');
        const res = await this.call(`/worker-image/${f}`);
        if (!res.ok) throw new Error(`could not download ${f} (${res.status})`);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, Buffer.from(await res.arrayBuffer()));
      }
      await step('Building its image (1 of 2): the tools turns use. The first build takes about 5 minutes.', ['-t', base, dir]);
    }
    const top = join(root, 'image-claude');
    mkdirSync(top, { recursive: true });
    writeFileSync(join(top, 'Containerfile'), `FROM ${base}\nRUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code@${claude} && npm cache clean --force\n`);
    await step(`Building its image (2 of 2): claude ${claude}`, ['-t', tag, top]);
  }

  /** Earlier images, but one a container still uses (podman refuses those). @param {string} tag */
  async prune(tag) {
    const { podman } = this.cfg;
    const all = (await this.exec(podman, ['images', '--format', '{{.Repository}}:{{.Tag}}'])).out.split('\n').filter((t) => t.startsWith(`${IMAGE}:`) || t.startsWith(`${IMAGE}-base:`));
    const base = `${IMAGE}-base:${tag.split(':')[1].split('-')[0]}`;
    for (const old of all.filter((t) => t !== tag && t !== base)) await this.exec(podman, ['rmi', old]);
    await this.exec(podman, ['image', 'prune', '-f']);
  }

  /**
   * The self-test, in a container and folders of its own so no running turn feels it; each check is told as it ends.
   * @param {string} id
   */
  async selfTest(id) {
    this.testing = true;
    /** @type {NonNullable<WorkerAgent['test']>} */
    const test = (this.test = { id, done: false, lines: [] });
    const root = join(this.cfg.root, 'self-test');
    const container = 'citadel-worker-selftest';
    const { podman } = this.cfg;
    const line = (/** @type {string} */ key, /** @type {string} */ state, /** @type {string} */ text) => {
      const has = test.lines.find((l) => l.key === key);
      if (has) Object.assign(has, { state, text });
      else test.lines.push({ key, state, text });
    };
    /** One check: its text when it passes; what it throws says why it didn't. @param {string} key @param {() => Promise<string>} what */
    const check = async (key, what) => {
      line(key, 'running', '');
      try {
        line(key, 'ok', await what());
        return true;
      } catch (err) {
        line(key, 'fail', err.message.slice(0, 300));
        return false;
      }
    };
    const inside = (/** @type {string} */ sh, timeout = 60_000) => this.exec(podman, ['exec', container, 'sh', '-c', sh], timeout);
    try {
      line('image', 'running', 'Waiting for the image');
      while (this.building) await sleep(500);
      if (this.image?.state === 'failed') throw new Error(`its image is not built: ${this.image.text}`);
      const w = this.newWorker(container, root, this.worker.cfg.image);
      // It has this machine's token, and would be handed its turns.
      w.poke = () => {};
      // Left by a test cut short: its container would stand in for this one's.
      await this.exec(podman, ['rm', '-f', '-t', '0', container]);
      line('image', 'running', 'Starting a container from it');
      const said = await w.selfTest({ wrapper: [], cwd: null, home: '/home/worker', roots: [TEST_ROOT] });
      const of = (/** @type {string} */ name) => said.find((l) => l.name === name);
      const image = of('container');
      line('image', image?.ok ? 'ok' : 'fail', image?.ok ? `claude ${w.claude ?? 'not found'}` : (image?.text ?? 'it said nothing'));
      if (!image?.ok) throw new Error('not tried: the container did not start');
      await check('folders', async () => {
        const l = of('folders');
        if (!l?.ok) throw new Error(l?.text ?? 'it said nothing');
        const mount = (await this.exec('findmnt', ['-no', 'PROPAGATION', '/'])).out.trim();
        if (!mount.startsWith('shared')) throw new Error(`/ is mounted ${mount || 'unknown'}, not shared, so folders added later would not reach the container: run the install command again`);
        return 'A file made on either side shows on the other';
      });
      line('disk', of('no host disk')?.ok ? 'ok' : 'fail', of('no host disk')?.text ?? 'it said nothing');
      await check('programs', async () => {
        const l = of('no Windows programs');
        if (!l?.ok) throw new Error(l?.text ?? 'it said nothing');
        if (!this.wsl) return l.text;
        // With its drives off there is no Windows program here to try, so this reads what turns them off, and looks for a way round it.
        if (!interopOff(safeRead('/etc/wsl.conf'))) throw new Error('Windows programs are not switched off in /etc/wsl.conf: run the install command again');
        if ((await inside('test -e /run/WSL')).code === 0) throw new Error("the container can reach WSL's own sockets (/run/WSL)");
        return 'Windows drives and programs are off in this distro';
      });
      const there = w.local(join(TEST_ROOT, 'scratch'));
      const synced = await check('sync', async () => {
        const began = performance.now();
        const { bundle } = await this.json('/api/machines/worker/scratch');
        mkdirSync(there, { recursive: true });
        writeFileSync(join(there, 'in.bundle'), Buffer.from(bundle, 'base64'));
        const git = await inside(`cd ${TEST_ROOT}/scratch && git clone -q -b scratch in.bundle repo && cd repo && printf '%s back' "$(cat nonce)" > answer && git add answer && git -c user.name=worker -c user.email=worker@localhost commit -q -m answer && git bundle create -q ../out.bundle scratch`);
        if (git.code) throw new Error(`git there: ${lastLine(git.err) || `exit ${git.code}`}`);
        const back = await this.json('/api/machines/worker/scratch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bundle: readFileSync(join(there, 'out.bundle')).toString('base64') }) });
        if (!back.ok) throw new Error(back.why);
        return `${((performance.now() - began) / 1000).toFixed(1)} s`;
      });
      await check('process', async () => {
        const began = performance.now();
        const file = join(TEST_ROOT, 'pid');
        const r = await this.exec(podman, ['exec', '-d', container, 'sh', '-c', `echo $$ > ${file}; exec sleep 300`]);
        if (r.code) throw new Error(`it did not start: ${lastLine(r.err)}`);
        const pid = await until(() => Number(safeRead(w.local(file))) || 0);
        if (!pid) throw new Error('it did not start');
        if ((await inside(`kill -0 ${pid} && kill ${pid}`)).code) throw new Error('it was not running a moment after it started');
        if (!(await until(async () => (await inside(`kill -0 ${pid}`)).code !== 0))) throw new Error('it did not stop');
        return `${((performance.now() - began) / 1000).toFixed(1)} s`;
      });
      await check('link', () => this.link());
      await check('tools', async () => {
        if (!synced) throw new Error('not tried: the scratch repo did not arrive');
        const r = await inside(`cd ${TEST_ROOT}/scratch/repo && node tools/host-tools.ts check`);
        if (r.code) throw new Error(r.out.trim().split('\n').join('; ').slice(0, 300) || lastLine(r.err));
        return lastLine(r.out);
      });
    } catch (err) {
      // What stopped it is the first check's failure; the rest were never reached.
      if (!test.lines.some((l) => l.state === 'fail')) line('image', 'fail', err.message);
      for (const key of ['image', 'folders', 'sync', 'process', 'link', 'tools', 'disk', 'programs']) {
        const l = test.lines.find((t) => t.key === key);
        if (!l || l.state === 'running') line(key, 'fail', 'Not tried: the check before it failed');
      }
    } finally {
      await this.exec(podman, ['rm', '-f', '-t', '0', container]);
      await this.exec(podman, ['volume', 'rm', '-f', `${container}-home`]);
      rmSync(root, { recursive: true, force: true });
      test.done = true;
      this.testing = false;
      this.log(`Self-test: ${test.lines.map((l) => `${l.key} ${l.state}`).join(', ')}`);
    }
  }

  /** The link to the app, measured: a small round trip, and 16 MB each way. */
  async link() {
    const trips = [];
    for (let i = 0; i < 6; i++) {
      const began = performance.now();
      const res = await this.call('/api/machines/worker/blob?bytes=0');
      await res.arrayBuffer();
      if (!res.ok) throw new Error(`the app answered ${res.status}`);
      trips.push(performance.now() - began);
    }
    // The first opened the connection; the middle of the rest is the link.
    const ms = trips.slice(1).sort((a, b) => a - b)[2];
    const bytes = 16 * 1024 * 1024;
    const mbit = (/** @type {number} */ began) => Math.round((bytes * 8) / 1000 / Math.max(1, performance.now() - began));
    let began = performance.now();
    const down = await this.call(`/api/machines/worker/blob?bytes=${bytes}`, { signal: AbortSignal.timeout(300_000) });
    if (!down.ok || (await down.arrayBuffer()).byteLength !== bytes) throw new Error('the download did not arrive whole');
    const speed = mbit(began);
    began = performance.now();
    const up = await this.json('/api/machines/worker/blob', { method: 'POST', body: Buffer.alloc(bytes), signal: AbortSignal.timeout(300_000) });
    if (up.bytes !== bytes) throw new Error('the upload did not arrive whole');
    return `${speed} Mbit/s down, ${mbit(began)} up, ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  }
}

/** What `what` gives once it is truthy, within 10 s; else its last answer. @template T @param {() => T | Promise<T>} what */
async function until(what) {
  const end = Date.now() + 10_000;
  for (;;) {
    const got = await what();
    if (got || Date.now() > end) return got;
    await sleep(100);
  }
}

/** Whether a wsl.conf turns Windows programs off. @param {string} conf */
export function interopOff(conf) {
  const part = conf.split(/^\s*\[/m).find((p) => /^interop\s*\]/i.test(p)) ?? '';
  return /^\s*enabled\s*=\s*"?false\b/im.test(part);
}

/** @param {string} file */
function safeRead(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Whether a folder holds a file with something in it; null when that can't be told. Never what is in it. @param {string} dir @param {string} file */
function thereIn(dir, file) {
  try {
    return statSync(join(dir, file)).size > 0;
  } catch (err) {
    return err.code === 'ENOENT' ? (existsSync(dir) ? false : null) : null;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [appUrl, file] = process.argv.slice(2);
  const log = (/** @type {unknown[]} */ ...a) => console.log(...a);
  try {
    if (!appUrl || !file) throw new Error('usage: node worker-agent.mjs <app url> <config.json>');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    const token = readFileSync(join(dirname(file), 'machine-token'), 'utf8').trim();
    // The sync's code, taken again at each start so it never falls behind the app's side; the copy here serves when the app can't be reached.
    const to = join(dirname(fileURLToPath(import.meta.url)), 'machine-worker.mjs');
    const res = await fetch(new URL('/machine-worker.mjs', appUrl), { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    if (res?.ok) writeFileSync(to, await res.text());
    else if (!existsSync(to)) throw new Error(`could not download machine-worker.mjs (${res?.status ?? 'no answer'})`);
    const mod = await import('./machine-worker.mjs');
    const { Worker } = mod;
    const installed = Number(safeRead(join(dirname(file), 'installed'))) || 0;
    await new WorkerAgent({ config, appUrl, token, installed, Worker, accounts: mod.accountDir && mod.ACCOUNTS ? { ACCOUNTS: mod.ACCOUNTS, accountDir: mod.accountDir } : undefined, log }).start();
  } catch (err) {
    log(`This worker can't start: ${err.message}`);
    process.exit(1);
  }
}
