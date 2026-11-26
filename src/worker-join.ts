// Joining a machine as a worker and its self-test (Build 7 T5). The worker's own program on that computer
// (public/worker-agent.mjs) says here every couple of seconds how it stands: its owner's caps, its image, its sign-ins
// (that they are there, never what is in them) and the lines of a self-test its owner asked for on the Machines page.
// It is a program apart from the machine's agent, with the same token, because a Windows PC's agent and the Linux distro
// its worker lives in are two processes, and a machine's newest connection replaces its last one (src/machines.ts).
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WORKER_CHECKS } from '../public/machine-setup.js';
import { imageHashAsync } from './claude-link.ts';
import type { Machine, Store } from './db.ts';
import { gitOut } from './git.ts';
import { cleanFolders, type HostFolder } from './host-reach.ts';
import { sameClaude, type WorkerInfo } from './machine-turn.ts';

/**
 * A worker that hasn't synced for this long is away (docs/adr/0024-runner-seams.md, T5): it syncs every SYNC_MS, half a
 * second. A third of BEAT_STALE_MS (src/machine-turn.ts, 30 s), so a machine is away well before its turns' beats go stale.
 */
export const HERE_MS = 10_000;
/** A self-test that has said nothing new for this long has failed: an image build is its longest step. */
const QUIET_TEST_MS = 20 * 60_000;
const CLAUDE_MS = 60_000;
/** The most bytes of one link test, each way. */
export const BLOB_BYTES = 16 * 1024 * 1024;
const REPO = join(import.meta.dirname, '..');
/** The build files of the worker's image: people's container image (deploy/claude-container), with claude on top there. */
const IMAGE_DIR = join(REPO, 'deploy', 'claude-container');
/** What the worker's own program is made of: it restarts itself, between turns, when this hash changes from the one it first heard. */
const AGENT_FILES = ['worker-agent.mjs', 'machine-worker.mjs'].map((f) => join(REPO, 'public', f));
/** The scratch repo's files beside its nonce: what `node tools/host-tools.ts check` needs, so it runs in the checkout it came in. */
const SCRATCH_FILES = ['tools/host-tools.ts', 'src/host-tools.ts', 'deploy/host-tools.json'];

export type CheckKey = keyof typeof WORKER_CHECKS;
const KEYS = Object.keys(WORKER_CHECKS) as CheckKey[];

export type CheckLine = { key: CheckKey; name: string; state: 'waiting' | 'running' | 'ok' | 'fail'; text: string };
export type SelfTest = { id: string; at: number; done: number | null; ok: boolean; why: string | null; lines: CheckLine[] };
export type WorkerCaps = { workers: number; threads: number; memory_gb: number; disk_gb: number };
type ImageState = { state: 'ready' | 'building' | 'failed' | 'own'; text: string };
type Facts = { boot: string; at: number; since: number; host: string; wsl: boolean; caps: WorkerCaps | null; image: ImageState | null; github: boolean | null; disk_gb: number | null; full: boolean; folders: HostFolder[]; folder_problems: string[] };
/** Kept over a restart: how the worker was last set up (its newest install, by when that ran) and what its tests said. */
type Kept = { installed?: number; host: string; wsl: boolean; caps: WorkerCaps | null; seen: number; test: SelfTest | null; passed: number | null };
/** A machine's worker as its row shows it. */
export type WorkerView = {
  on: boolean;
  here: boolean;
  /** Last heard from while away; null while here, or never. */
  seen: number | null;
  host: string | null;
  wsl: boolean;
  caps: WorkerCaps | null;
  image: ImageState | null;
  claude: string | null;
  /** This server's claude when the worker's differs: no turn starts there until they match. */
  claude_wanted: string | null;
  signed_in: boolean | null;
  github: boolean | null;
  disk_gb: number | null;
  full: boolean;
  /** The owner's folders for marked minions (Build 7 T8, src/host-reach.ts), from the worker's own config; null while away. */
  folders: HostFolder[] | null;
  folder_problems: string[];
  test: SelfTest | null;
  /** The last self-test that passed whole. */
  passed: number | null;
  /** The PC's agent has a worker block too, and its syncs are refused. */
  twice: boolean;
};

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const yes = (v: unknown) => (typeof v === 'boolean' ? v : null);
const count = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v * 10) / 10 : null);

/** A worker's caps as its owner's config has them, or null when they aren't that. */
export function cleanCaps(input: unknown): WorkerCaps | null {
  const v = (input ?? {}) as Record<string, unknown>;
  const [workers, threads, memory_gb, disk_gb] = [count(v.workers, 64), count(v.threads, 1024), count(v.memory_gb, 4096), count(v.disk_gb, 100_000)];
  return workers === null || threads === null || memory_gb === null || disk_gb === null ? null : { workers, threads, memory_gb, disk_gb };
}

const IMAGE_STATES = ['ready', 'building', 'failed', 'own'] as const;
function cleanImage(input: unknown): ImageState | null {
  const v = (input ?? {}) as Record<string, unknown>;
  const state = IMAGE_STATES.find((s) => s === v.state);
  return state ? { state, text: text(v.text, 400) } : null;
}

export interface WorkerJoinDeps {
  store: Pick<Store, 'getSetting' | 'setSetting' | 'listMachines'>;
  lends: (m: Machine) => boolean;
  info: (machineId: number) => WorkerInfo | null;
  /** A ship's tests run on that computer: nothing that can wait starts there (ships go first). */
  ships: (machineId: number) => boolean;
  /** `claude --version` here. */
  claude: () => Promise<string | null>;
  /** A worker's row differs from what people were last sent. */
  changed: () => void;
  now: () => number;
}

export class WorkerJoin {
  private d: WorkerJoinDeps;
  private facts = new Map<number, Facts>();
  private twice = new Map<number, number>();
  private tests = new Map<number, SelfTest & { heard: number }>();
  /** Each running test's scratch repo: the commit it was sent and the answer its worker must send back. */
  private scratch = new Map<number, { id: string; sha: string; nonce: string }>();
  private claudeHere: { version: string | null; at: number } = { version: null, at: -Infinity };
  private offer: { image: { hash: string; files: string[] }; agent: string } | null = null;
  private sent = '';

  constructor(d: WorkerJoinDeps) {
    this.d = d;
  }

  /** Its worker is running and reaches this server: turns there go on, and can start. */
  here(machineId: number): boolean {
    const at = this.d.info(machineId)?.at;
    return at !== undefined && this.d.now() - at < HERE_MS;
  }

  private kept(machineId: number): Kept | null {
    return this.d.store.getSetting<Kept>(`worker-join:${machineId}`) ?? null;
  }

  private keep(machineId: number, change: Partial<Kept>) {
    const was: Kept = this.kept(machineId) ?? { host: '', wsl: false, caps: null, seen: 0, test: null, passed: null };
    const now = { ...was, ...change };
    if (JSON.stringify(now) !== JSON.stringify(was)) this.d.store.setSetting(`worker-join:${machineId}`, now);
  }

  /** A machine taken off Citadel: its worker's setup and test go with it. */
  forget(machineId: number) {
    this.facts.delete(machineId);
    this.tests.delete(machineId);
    this.scratch.delete(machineId);
    if (this.kept(machineId)) this.d.store.setSetting(`worker-join:${machineId}`, null);
  }

  /** One worker a machine: while this program is here, a sync from anything else with its token (an agent's worker block) is refused, so one start is never offered to two. `from` is the program's X-Citadel-Worker header. */
  refuses(machineId: number, from: unknown): boolean {
    const facts = this.facts.get(machineId);
    if (typeof from === 'string' && from === facts?.boot) return false;
    if (!facts || this.d.now() - facts.at >= HERE_MS) return false;
    // A program's own new boot syncs once before its first word, and one replaced syncs until it hears: only a sync with no header is an agent's block.
    if (typeof from === 'string') return true;
    if (!this.twice.has(machineId) || this.d.now() - this.twice.get(machineId)! > 30_000) this.d.changed();
    this.twice.set(machineId, this.d.now());
    return true;
  }

  /** The name of the computer its worker runs on, while it does. */
  /** The paths of the owner's read-write folders while its worker is here (T8: the agent starts nothing they hold), else null. */
  writable(machineId: number): string[] | null {
    const f = this.here(machineId) ? this.facts.get(machineId) : null;
    return f ? f.folders.filter((x) => x.write).map((x) => x.path) : null;
  }

  host(machineId: number): string {
    return this.here(machineId) ? (this.facts.get(machineId)?.host ?? '') : '';
  }

  /** Why its worker takes no turns now, or null. Green means it can: a worker whose self-test has not passed, or last failed, takes none. One set up by hand has none. */
  hold(machineId: number): string | null {
    const facts = this.facts.get(machineId);
    const kept = this.kept(machineId);
    if (!kept) return null;
    if (facts?.full) return `it is at its disk cap (${facts.disk_gb} of ${facts.caps?.disk_gb} GB)`;
    if (facts?.image?.state === 'failed') return 'its image could not be built';
    if (facts?.image?.state === 'building') return 'its image is being built';
    if (kept.test && !kept.test.ok) return 'its self-test failed';
    return kept.passed ? null : 'its self-test has not passed yet';
  }

  view(machine: Machine): WorkerView {
    const id = machine.id;
    const info = this.d.info(id);
    const here = this.here(id);
    const facts = here ? (this.facts.get(id) ?? null) : null;
    const kept = this.kept(id);
    const home = this.claudeHere.version;
    const seen = Math.max(info?.at ?? 0, kept?.seen ?? 0);
    const { heard: _, ...running } = this.tests.get(id) ?? { heard: 0, id: '' };
    return {
      on: this.d.lends(machine),
      here,
      seen: here || !seen ? null : seen,
      host: facts?.host || kept?.host || null,
      wsl: facts?.wsl ?? kept?.wsl ?? false,
      caps: facts?.caps ?? kept?.caps ?? null,
      image: facts?.image ?? null,
      claude: here ? (info?.claude ?? null) : null,
      claude_wanted: here && home && info?.claude && !sameClaude(home, info.claude) ? home : null,
      signed_in: here ? (info?.signedIn ?? null) : null,
      github: facts?.github ?? null,
      disk_gb: facts?.disk_gb ?? null,
      full: facts?.full ?? false,
      folders: facts?.folders ?? null,
      folder_problems: facts?.folder_problems ?? [],
      test: running.id ? (running as SelfTest) : (kept?.test ?? null),
      passed: kept?.passed ?? null,
      twice: this.d.now() - (this.twice.get(machine.id) ?? 0) < 60_000,
    };
  }

  /** The app's own side of a worker: its claude's version, the image's build files and the agent's code. */
  private async wanted() {
    const now = this.d.now();
    if (now - this.claudeHere.at >= CLAUDE_MS) {
      this.claudeHere.at = now;
      const version = await this.d.claude();
      if (version) this.claudeHere.version = version;
    }
    // Read once: a deploy that changes them restarts this server, and a front-end-only one is picked up at the next.
    this.offer ??= { image: { hash: await imageHashAsync(IMAGE_DIR), files: await filesUnder(IMAGE_DIR) }, agent: await agentHash() };
    return { claude: this.claudeHere.version, ...this.offer };
  }

  /** A worker program's word (POST /api/machines/worker), and what it should have and do. */
  async report(machine: Machine, body: Record<string, unknown>) {
    const boot = text(body.boot, 40);
    const now = this.d.now();
    const kept = this.kept(machine.id);
    // Two PCs with one token (the worker moved to another): the newest install has it, also after the other one's reboot. A clock ahead is taken as now.
    const installed = Math.min(count(body.installed, 1e14) ?? 0, now);
    if (installed < (kept?.installed ?? 0)) return { replaced: true };
    const was = this.facts.get(machine.id);
    const facts: Facts = {
      boot,
      at: now,
      // Another program spoke for this machine a moment ago: it is told, and ends its turns, before this one takes any.
      since: !was || was.boot === boot ? (was?.since ?? 0) : now - was.at < HERE_MS ? now : 0,
      host: text(body.host, 80),
      wsl: body.wsl === true,
      caps: cleanCaps(body.caps),
      image: cleanImage(body.image),
      github: yes(body.github),
      disk_gb: count(body.disk_gb, 100_000),
      full: body.full === true,
      folders: cleanFolders(body.folders),
      folder_problems: (Array.isArray(body.folder_problems) ? body.folder_problems : [])
        .filter((p): p is string => typeof p === 'string')
        .slice(0, 20)
        .map((p) => p.slice(0, 300)),
    };
    this.facts.set(machine.id, facts);
    // seen is saved now and then: it only dates "away since" after a restart of this server.
    const seen = kept?.seen ?? 0;
    this.keep(machine.id, { installed, host: facts.host, wsl: facts.wsl, caps: facts.caps, seen: now - seen > 5 * 60_000 ? now : seen });
    this.heardTest(machine.id, body.test);
    const test = this.tests.get(machine.id);
    return { ...(await this.wanted()), on: this.d.lends(machine), test: test ? test.id : null, ships: this.d.ships(machine.id), wait: now - facts.since < HERE_MS };
  }

  /** Start a self-test; its worker takes it at its next word. */
  startTest(machine: Machine): SelfTest {
    const now = this.d.now();
    const lines: CheckLine[] = KEYS.map((key) => ({ key, name: WORKER_CHECKS[key], state: 'waiting', text: '' }));
    const test = { id: randomBytes(6).toString('hex'), at: now, done: null, ok: false, why: null, lines, heard: now };
    this.tests.set(machine.id, test);
    this.scratch.delete(machine.id);
    this.tick();
    return test;
  }

  testing(machineId: number): boolean {
    return this.tests.has(machineId);
  }

  private heardTest(machineId: number, input: unknown) {
    const test = this.tests.get(machineId);
    const said = (input ?? {}) as { id?: unknown; done?: unknown; lines?: unknown };
    if (!test || said.id !== test.id || !Array.isArray(said.lines)) return;
    for (const l of said.lines.slice(0, 20) as { key?: unknown; state?: unknown; text?: unknown }[]) {
      const line = test.lines.find((t) => t.key === l?.key);
      const state = (['running', 'ok', 'fail'] as const).find((s) => s === l?.state);
      if (!line || !state) continue;
      if (line.state !== state || line.text !== text(l.text, 400)) test.heard = this.d.now();
      line.state = state;
      line.text = text(l.text, 400);
    }
    if (said.done === true) this.endTest(machineId, null);
  }

  private endTest(machineId: number, why: string | null) {
    const test = this.tests.get(machineId);
    if (!test) return;
    this.tests.delete(machineId);
    this.scratch.delete(machineId);
    const { heard: _, ...rest } = test;
    const ok = why === null && test.lines.every((l) => l.state === 'ok');
    const at = this.d.now();
    this.keep(machineId, { test: { ...rest, done: at, ok, why }, ...(ok ? { passed: at } : {}) });
  }

  /** The scratch repo of this machine's running test, as a git bundle: a nonce to answer and the host tools check. */
  async sendScratch(machineId: number): Promise<{ bundle: string } | null> {
    const test = this.tests.get(machineId);
    if (!test) return null;
    const dir = await mkdtemp(join(tmpdir(), 'citadel-worker-scratch-'));
    try {
      const nonce = randomBytes(16).toString('hex');
      for (const f of SCRATCH_FILES) {
        await mkdir(dirname(join(dir, f)), { recursive: true });
        await cp(join(REPO, f), join(dir, f));
      }
      await writeFile(join(dir, 'nonce'), nonce);
      const git = (...args: string[]) => gitOut(['-c', 'user.name=Citadel', '-c', 'user.email=citadel@localhost', '-c', 'core.hooksPath=/dev/null', ...args], dir);
      await git('init', '-q', '-b', 'scratch');
      await git('add', '-A');
      await git('commit', '-q', '-m', 'self-test');
      const sha = await git('rev-parse', 'HEAD');
      await git('bundle', 'create', '.git/out.bundle', 'scratch');
      if (!sha) throw new Error('git could not make the scratch repo');
      this.scratch.set(machineId, { id: test.id, sha, nonce });
      return { bundle: (await readFile(join(dir, '.git', 'out.bundle'))).toString('base64') };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** The scratch repo back from the worker: null when it holds the commit sent with the answer on top, else what's wrong. */
  async takeScratch(machineId: number, bundle: string): Promise<string | null> {
    const sent = this.scratch.get(machineId);
    if (!sent || this.tests.get(machineId)?.id !== sent.id) return 'no self-test is running';
    const dir = await mkdtemp(join(tmpdir(), 'citadel-worker-scratch-'));
    try {
      await writeFile(join(dir, 'in.bundle'), Buffer.from(bundle, 'base64'));
      if ((await gitOut(['clone', '-q', '--bare', '--branch', 'scratch', 'in.bundle', 'back.git'], dir)) === null) return 'what came back is not a git bundle';
      const git = (...args: string[]) => gitOut(args, join(dir, 'back.git'));
      if ((await git('rev-parse', 'scratch^')) !== sent.sha) return 'what came back is not built on what was sent';
      return (await git('show', 'scratch:answer')) === `${sent.nonce} back` ? null : 'the file made there did not come back';
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Tell people when a row's worker changed, and end a test whose worker went away or stopped talking. Every second (server.ts). */
  tick() {
    const now = this.d.now();
    for (const [id, test] of this.tests) {
      const at = this.d.info(id)?.at ?? 0;
      // A minute's grace: the program restarts itself when its code changes.
      if (now - Math.max(at, test.at) > 60_000) this.endTest(id, 'The worker went away during the test.');
      else if (now - test.heard > QUIET_TEST_MS) this.endTest(id, 'The worker stopped reporting on the test.');
    }
    const views = JSON.stringify(
      this.d.store
        .listMachines()
        .filter((m) => this.d.lends(m) || this.facts.has(m.id))
        .map((m) => [m.id, this.view(m)]),
    );
    if (views === this.sent) return;
    this.sent = views;
    this.d.changed();
  }
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of ((await readdir(dir, { recursive: true })) as string[]).sort()) if ((await stat(join(dir, f))).isFile()) out.push(f);
  return out;
}

/** One of the image's build files by its name in a worker's offer, as a path in this repo, or null when there is none by that name. */
export async function imageFile(name: string): Promise<string | null> {
  return (await filesUnder(IMAGE_DIR)).includes(name) ? join('deploy', 'claude-container', name) : null;
}

async function agentHash(): Promise<string> {
  const h = createHash('sha256');
  for (const f of AGENT_FILES) h.update(await readFile(f));
  return h.digest('hex').slice(0, 12);
}
