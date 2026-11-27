// A role's Set up and self-test (Build 7 M4, specs/machine-connections.md section 3; Josh, 2026-11-25: "Agent, on Set up").
// The owner presses Set up or Test on a role's card; the steps run, each step's line shows on the card as it goes, and a
// run that ends well is the role's green tick. Tools and Minion turns run here (check_machine; T5's worker self-test,
// unchanged); the Windows screen and GPU jobs, and a Windows PC's worker install, run on the PC's agent
// (public/machine-agent.mjs, the `setup` message), which says how each step went. What needs an administrator comes
// back as fixed needs, never a command (public/role-setup.js). CI runners (#2064, on one row per PC) run here: Set up
// shows the runner agent's administrator install and waits for it to connect, and its test asks each runner agent for
// a job and GitHub for each lent scheme's runners there.
// The last run of each role is kept in its machine_roles.setup, as `run`, beside what else is there (CI's runner_agent).
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanAdmin, SETUP_ROLES } from '../public/role-setup.js';
import { type Listed, onHost, schemeLabels } from './ci-runner.ts';
import type { Machine, Project, Store } from './db.ts';
import { HttpError } from './http.ts';
import { IMAGE } from './machine-jobs.ts';
import { storedReport } from './machine-join.ts';
import { ROLE_NAMES, type Role } from './machine-roles.ts';
import type { CheckResult } from './machines.ts';
import type { SelfTest } from './worker-join.ts';

/** The first agent that runs a role's steps (public/machine-agent.mjs AGENT_VERSION): an older one is asked to Update. */
export const SETUP_AGENT = 4;
/** A run whose agent has said nothing new for this long has failed: pulling the GPU test's image is its longest step. */
export const QUIET_MS = 15 * 60_000;
/** How long Set up for Minion turns waits for the worker its owner installs to come up. */
export const WORKER_WAIT_MS = 30 * 60_000;
const MAX_STEPS = 30;
/** The most bytes of the screen test's screenshot. */
export const MAX_SHOT = 20 * 1024 * 1024;

export type SetupRole = 'tools' | 'screen' | 'turns' | 'gpu' | 'ci' | 'builds';
export type StepState = 'waiting' | 'running' | 'ok' | 'fail';
export type Step = { text: string; state: StepState };
export type Admin = { needs: string[]; pm: string | null };
/** One Set up or Test, as the card shows it. */
export type Run = {
  id: string;
  role: SetupRole;
  kind: 'setup' | 'test';
  at: number;
  by: string;
  done: number | null;
  ok: boolean | null;
  why: string | null;
  /** What the PC lacks that needs an administrator; the card makes the one command (public/role-setup.js adminCommand). */
  admin: Admin | null;
  /** The card shows an install command its owner runs, which holds the token: T5's worker (Minion turns on a PC whose agent can't install it), or the runner agent (CI runners). */
  worker_install: boolean;
  steps: Step[];
  /** One line on what passed: "12 tools", "RTX 4080". */
  report: string | null;
  /** When the screen test's screenshot came; null until it does. */
  shot: number | null;
};

type Phase = 'server' | 'agent' | 'worker' | 'test' | 'runner';
type Active = { run: Run; machineId: number; phase: Phase; heard: number; test?: string };

export type RoleSetupDeps = {
  store: Store;
  online(machineId: number): boolean;
  /** Sends the agent a message on its stream; false when it isn't connected. */
  send(machineId: number, msg: unknown): boolean;
  check(machineId: number): Promise<CheckResult[]>;
  workers: { here(id: number): boolean; testing(id: number): boolean; startTest(m: Machine): SelfTest; view(m: Machine): { test: SelfTest | null } } | null;
  lendsWorker(m: Machine): boolean;
  ships(machineId: number): boolean;
  /** CI runners: the runner agents connected on the row, a list job through one, the schemes its CI is lent to, and GitHub's runners of one. */
  ci?: {
    agents(machineId: number): { os: 'windows' | 'linux'; host: string }[];
    list(machineId: number, os: 'windows' | 'linux'): Promise<{ ok: boolean; output: string }>;
    lent(m: Machine): Project[];
    listed(project: Project): Promise<Listed[]>;
  };
  shotDir: string;
  /** The build image list's text a Builds Set up reads (tests give their own); the shipped file's by default. */
  buildImages?: string;
  changed(): void;
  now(): number;
};

/** What a Builds Set up pulls and makes: tools/build-images/images.json, each image pinned by digest. */
const BUILD_KINDS = ['android', 'node', 'rust'];
export type BuildImages = { images: Record<string, string>; volumes: string[] };
export const BUILD_IMAGES_FILE = fileURLToPath(new URL('../tools/build-images/images.json', import.meta.url));
/** That file as this release shipped it, read once at load (a ship that changes it restarts the server). */
const SHIPPED_IMAGES = (() => {
  try {
    return readFileSync(BUILD_IMAGES_FILE, 'utf8');
  } catch (err) {
    return err as Error;
  }
})();

/**
 * The build images to pull, from the file's text. Throws a 409 until all three are published, so a green tick means a
 * machine has every one, and a 500 when the file is broken.
 */
export function buildImages(text: string | Error = SHIPPED_IMAGES): BuildImages {
  let raw: { images?: Record<string, { image?: unknown } | null>; volumes?: unknown };
  try {
    if (text instanceof Error) throw text;
    raw = JSON.parse(text);
  } catch (err) {
    throw new HttpError(500, `Citadel's build image list (tools/build-images/images.json) can't be read: ${(err as Error).message}`);
  }
  const images: Record<string, string> = {};
  for (const [kind, v] of Object.entries(raw.images ?? {})) {
    if (v?.image == null) continue;
    if (!/^[a-z]+$/.test(kind) || typeof v.image !== 'string' || !IMAGE.test(v.image)) throw new HttpError(500, `Citadel's build image list has a bad ${kind} image: each is pinned by digest`);
    images[kind] = v.image;
  }
  const missing = BUILD_KINDS.filter((k) => !images[k]);
  if (missing.length) throw new HttpError(409, `Citadel's build images aren't all published yet (${missing.map((k) => `citadel-build-${k}`).join(', ')}): try again once they are`);
  const volumes = Array.isArray(raw.volumes) ? raw.volumes.filter((v): v is string => typeof v === 'string' && /^citadel-[a-z]+$/.test(v)) : [];
  return { images, volumes };
}

export const isSetupRole = (v: unknown): v is SetupRole => typeof v === 'string' && SETUP_ROLES.includes(v);
const clean = (v: unknown, n: number) =>
  typeof v === 'string'
    ? v
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
        .trim()
        .slice(0, n)
    : '';

/** A role's last run, as kept. */
export function storedRun(store: Store, machineId: number, role: Role): Run | null {
  const run = store.machineRoles(machineId).find((r) => r.role === role)?.setup?.run;
  return run && typeof run === 'object' ? (run as Run) : null;
}

export class RoleSetups {
  private d: RoleSetupDeps;
  /** The run going on each machine: its agent does one at a time. */
  private active = new Map<number, Active>();

  constructor(d: RoleSetupDeps) {
    this.d = d;
    // A run this process didn't start was cut off by a restart.
    for (const m of d.store.listMachines()) {
      for (const r of d.store.machineRoles(m.id)) {
        const run = r.setup?.run as Run | undefined;
        if (run && typeof run === 'object' && run.done === null) this.save(m.id, { ...run, done: d.now(), ok: false, why: 'Citadel restarted while it ran: press it again.' });
      }
    }
  }

  /** Start a role's Set up or Test on the owner's press. Throws an HttpError when it can't start, before anything runs. */
  start(machine: Machine, role: unknown, kind: unknown, person: { id: number; name: string; admin: boolean }): Run {
    if (!isSetupRole(role)) throw new HttpError(400, `role must be one of ${SETUP_ROLES.join(', ')}`);
    if (kind !== 'setup' && kind !== 'test') throw new HttpError(400, 'kind must be setup or test');
    const name = ROLE_NAMES[role];
    // It runs installers and programs on that PC: its owner's press (a shared machine's: an admin's).
    if (machine.owner_id === null ? !person.admin : machine.owner_id !== person.id) throw new HttpError(403, `Only ${machine.name}'s owner sets up and tests its roles`);
    const going = this.active.get(machine.id);
    if (going) throw new HttpError(409, `${ROLE_NAMES[going.run.role]} ${going.run.kind === 'setup' ? 'Set up' : 'test'} is still running on ${machine.name}: one at a time`);
    const report = storedReport(machine);
    const fresh = (report?.agent ?? 0) >= SETUP_AGENT;
    const online = this.d.online(machine.id);
    let phase: Phase = 'server';
    let workerInstall = false;
    let images: BuildImages | null = null;
    if (role === 'ci') {
      // The runner agent is its own program (as administrator), so the machine agent may be off or absent.
      if (!this.d.ci) throw new HttpError(503, 'No CI runners here');
      if (report?.os === 'macos') throw new HttpError(409, 'CI runners need Windows or Linux');
      if (this.d.ci.agents(machine.id).length) phase = 'test';
      else if (kind === 'test') throw new HttpError(409, `No runner agent is connected to ${machine.name}: press Set up`);
      else {
        phase = 'runner';
        workerInstall = true;
      }
    } else if (role === 'turns') {
      const w = this.d.workers;
      if (!w) throw new HttpError(503, 'No worker machines here');
      if (w.here(machine.id)) {
        this.canTest(machine);
        phase = 'test';
      } else if (kind === 'test') throw new HttpError(409, `${machine.name}'s worker isn't running: press Set up`);
      else if (report?.os === 'windows' && fresh && online) phase = 'agent';
      else {
        phase = 'worker';
        workerInstall = true;
      }
    } else {
      if (!online) throw new HttpError(409, `${machine.name} is offline: start it, then press it again`);
      if (role !== 'tools') {
        if (!fresh) throw new HttpError(409, `${machine.name}'s agent is from before Set up: press Update on its row, run that command there, then press it again`);
        if (role === 'screen' && report?.os !== 'windows') throw new HttpError(409, `The Windows screen needs a Windows PC, and ${machine.name} runs ${report?.os_name || report?.os || 'something else'}`);
        if (role === 'gpu' && report?.os === 'macos') throw new HttpError(409, 'GPU jobs need Linux or WSL with an NVIDIA GPU');
        if (role === 'builds' && report?.os === 'macos') throw new HttpError(409, 'Builds need Linux, or Windows with WSL');
        if (role === 'builds') images = buildImages(this.d.buildImages);
        phase = 'agent';
      }
    }
    const now = this.d.now();
    const run: Run = { id: randomBytes(6).toString('hex'), role, kind, at: now, by: person.name, done: null, ok: null, why: null, admin: null, worker_install: workerInstall, steps: [], report: null, shot: null };
    const a: Active = { run, machineId: machine.id, phase, heard: now };
    this.active.set(machine.id, a);
    if (workerInstall && role === 'ci') run.steps.push({ text: 'Run the install commands below on that PC', state: 'running' }, { text: "The runner agent connects to Citadel (it's waited for up to 30 minutes)", state: 'waiting' });
    else if (workerInstall) run.steps.push({ text: 'Run the install command below on that PC, as its owner', state: 'running' }, { text: "The worker connects to Citadel (it's waited for up to 30 minutes)", state: 'waiting' });
    this.save(machine.id, run);
    if (phase === 'agent') {
      // Minion turns' caps go to the worker's install; Builds' threads cap to its self-test.
      const caps = this.d.store.machineRoles(machine.id).find((r) => r.role === role)?.caps ?? {};
      const { ticks: _, ...own } = caps;
      if (!this.d.send(machine.id, { setup: { id: run.id, role, kind, ...(role === 'turns' || role === 'builds' ? { caps: own } : {}), ...(images ? { builds: images } : {}) } })) this.finish(a, false, `${machine.name} went offline`);
    } else if (phase === 'test' && role === 'ci') void this.ciTest(a, machine);
    else if (phase === 'test') this.startTest(a, machine);
    else if (role === 'tools') void this.tools(a);
    return { ...run };
  }

  /** T5's own refusals (routes/machines.ts self-test), so Set up and the old button agree. */
  private canTest(machine: Machine) {
    if (!this.d.lendsWorker(machine)) throw new HttpError(409, `Minion turns are off for ${machine.name}: switch them on, then press it again`);
    if (this.d.ships(machine.id)) throw new HttpError(409, "A ship's tests are running on that PC: run it once they end");
    if (this.d.workers?.testing(machine.id)) throw new HttpError(409, 'Its self-test is already running');
  }

  /** Tools: nothing to install; its test is check_machine, the way a turn would use it. */
  private async tools(a: Active) {
    const { run } = a;
    if (run.kind === 'setup') this.step(a, 0, { text: 'Nothing to install: Tools and folders need only the agent, which is connected', state: 'ok' });
    const at = run.steps.length;
    this.step(a, at, { text: 'Starting the ticked MCP server and workspace tools, and listing their tools', state: 'running' });
    let results: CheckResult[];
    try {
      results = await this.d.check(a.machineId);
    } catch (err) {
      return this.finish(a, false, `The check failed: ${(err as Error).message}`);
    }
    if (this.active.get(a.machineId) !== a) return;
    if (!results.length) {
      this.step(a, at, { text: 'Nothing is ticked to check', state: 'fail' });
      return this.finish(a, false, 'Tick an MCP server or a folder on Tools and folders, then test again.');
    }
    results.forEach((r, i) => this.step(a, at + i, { text: `${r.server === 'ws' ? 'Workspace tools' : 'MCP server'}: ${r.ok ? `${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}${r.tools.length ? `: ${clean(r.tools.join(', '), 240)}` : ''}` : (r.error ?? 'failed')}`, state: r.ok ? 'ok' : 'fail' }));
    const ok = results.every((r) => r.ok);
    run.report = ok ? `${results.reduce((n, r) => n + r.tools.length, 0)} tools` : null;
    this.finish(a, ok, ok ? null : 'A server failed to list its tools: its line says why.');
  }

  /**
   * CI runners' self-test: each runner agent connected answers a list job, and for each scheme its CI is lent to, GitHub
   * lists this PC's runners registered and idle (or busy). A scheme with none yet passes: one registers when its CI first
   * asks (src/ci-auto.ts).
   */
  private async ciTest(a: Active, machine: Machine) {
    const ci = this.d.ci!;
    a.phase = 'test';
    const agents = ci.agents(machine.id);
    const kinds = (os: string) => (os === 'linux' ? 'Linux' : 'Windows');
    for (const g of agents) this.step(a, a.run.steps.length, { text: `${kinds(g.os)} runner agent connected, from ${clean(g.host, 80)}`, state: 'ok' });
    let ok = true;
    for (const g of agents) {
      const at = a.run.steps.length;
      this.step(a, at, { text: `The ${kinds(g.os)} runner agent answers a job (it lists its runners)`, state: 'running' });
      const r = await ci.list(machine.id, g.os).catch((err: Error) => ({ ok: false, output: err.message }));
      if (this.active.get(a.machineId) !== a) return;
      const last = clean(r.output.trim().split('\n').at(-1), 160);
      this.step(a, at, { text: `The ${kinds(g.os)} runner agent answers a job${r.ok ? '' : `: ${last || 'it failed'}`}`, state: r.ok ? 'ok' : 'fail' });
      ok &&= r.ok;
    }
    let runners = 0;
    const schemes = ci.lent(machine);
    for (const p of schemes) {
      const at = a.run.steps.length;
      this.step(a, at, { text: `${p.name}: asking GitHub for its runners here`, state: 'running' });
      let mine: Listed[];
      try {
        const labels = new Set(schemeLabels(p.name));
        // Its labels and their role labels (land, side, long, check) all start with one of the scheme's labels.
        const ofScheme = (l: string) => [...labels].some((x) => l === x || l.startsWith(`${x}-`));
        mine = (await ci.listed(p)).filter((x) => agents.some((g) => onHost(x.name, g.host)) && x.labels.some(ofScheme));
      } catch (err) {
        if (this.active.get(a.machineId) !== a) return;
        this.step(a, at, { text: `${p.name}: ${clean((err as Error).message, 240)}`, state: 'fail' });
        ok = false;
        continue;
      }
      if (this.active.get(a.machineId) !== a) return;
      runners += mine.length;
      const off = mine.filter((x) => x.status !== 'online');
      const words = mine.map((x) => `${clean(x.name, 60)} ${x.status !== 'online' ? x.status : x.busy ? 'busy' : 'idle'}`).join(', ');
      this.step(a, at, { text: mine.length ? `${p.name}: ${words}` : `${p.name}: no runner here yet; one registers by itself when its CI first asks`, state: off.length ? 'fail' : 'ok' });
      ok &&= !off.length;
    }
    a.run.report = ok ? `${runners} runner${runners === 1 ? '' : 's'} for ${schemes.length} scheme${schemes.length === 1 ? '' : 's'}` : null;
    this.finish(a, ok, ok ? null : 'A check failed: its line says why.');
  }

  private startTest(a: Active, machine: Machine) {
    a.phase = 'test';
    a.test = this.d.workers!.startTest(machine).id;
    a.heard = this.d.now();
    this.mirror(a, machine);
  }

  /** T5's self-test lines, shown as this run's steps after any of its own. */
  private mirror(a: Active, machine: Machine) {
    const test = this.d.workers?.view(machine).test;
    if (!test || test.id !== a.test) return this.finish(a, false, "The worker's self-test went away before it ended");
    const base = a.run.steps.findIndex((s) => s.text.startsWith('Self-test: '));
    const at = base < 0 ? a.run.steps.length : base;
    test.lines.forEach((l, i) => this.step(a, at + i, { text: `Self-test: ${l.name}${l.text ? `: ${l.text}` : ''}`, state: l.state }, false));
    if (test.done !== null) {
      a.run.report = test.ok ? 'every check passed' : null;
      return this.finish(a, test.ok, test.ok ? null : (test.why ?? 'A check failed: its line says why.'));
    }
    this.save(a.machineId, a.run);
  }

  /** Each few seconds: a turns run moves on, and a run whose agent went quiet or offline ends. */
  tick() {
    const now = this.d.now();
    for (const a of [...this.active.values()]) {
      const machine = this.d.store.getMachine(a.machineId);
      if (!machine) {
        this.active.delete(a.machineId);
        continue;
      }
      if (a.phase === 'agent' && !this.d.online(a.machineId)) this.finish(a, false, `${machine.name} went offline before its steps ended`);
      else if (a.phase === 'agent' && now - a.heard > QUIET_MS) this.finish(a, false, `${machine.name}'s agent said nothing for ${QUIET_MS / 60_000} minutes`);
      else if (a.phase === 'worker') {
        if (this.d.workers?.here(a.machineId)) {
          const at = a.run.steps.findIndex((s) => s.text.startsWith('The worker connects'));
          this.step(a, 0, { ...a.run.steps[0], state: 'ok' }, false);
          if (at >= 0) this.step(a, at, { text: 'The worker connected to Citadel', state: 'ok' }, false);
          a.run.worker_install = false;
          try {
            this.canTest(machine);
          } catch (err) {
            this.finish(a, false, (err as Error).message);
            continue;
          }
          this.startTest(a, machine);
        } else if (now - a.heard > WORKER_WAIT_MS) this.finish(a, false, `No worker came up on ${machine.name} in ${WORKER_WAIT_MS / 60_000} minutes: run the install command there, then press Set up again`);
      } else if (a.phase === 'runner') {
        if (this.d.ci?.agents(a.machineId).length) {
          a.run.steps = a.run.steps.map((s) => ({ ...s, state: 'ok' }));
          a.run.steps[1] = { text: 'The runner agent connected to Citadel', state: 'ok' };
          a.run.worker_install = false;
          void this.ciTest(a, machine);
        } else if (now - a.heard > WORKER_WAIT_MS) this.finish(a, false, `No runner agent connected to ${machine.name} in ${WORKER_WAIT_MS / 60_000} minutes: run the install command there as administrator, then press Set up again`);
      } else if (a.phase === 'test' && a.run.role !== 'ci') this.mirror(a, machine);
    }
  }

  /**
   * The agent's word on its run: { id, step?: { n, text, state }, admin?: { needs, pm }, done?: { ok, report?, why? } }.
   * False when no such run is going on that machine (it ended, or the server restarted).
   */
  heard(machine: Machine, body: Record<string, unknown>): boolean {
    const a = this.active.get(machine.id);
    if (!a || a.phase !== 'agent' || body.id !== a.run.id) return false;
    a.heard = this.d.now();
    const s = body.step as { n?: unknown; text?: unknown; state?: unknown } | undefined;
    const state = (['running', 'ok', 'fail'] as const).find((x) => x === s?.state);
    if (s && Number.isInteger(s.n) && (s.n as number) >= 0 && (s.n as number) < MAX_STEPS && state) this.step(a, Math.min(s.n as number, a.run.steps.length), { text: clean(s.text, 300) || '…', state }, false);
    if (body.admin !== undefined) a.run.admin = cleanAdmin(body.admin);
    const done = body.done as { ok?: unknown; report?: unknown; why?: unknown } | undefined;
    if (done && typeof done === 'object') {
      const ok = done.ok === true;
      // A Windows PC's worker is installed: Citadel waits for it, then runs T5's self-test.
      if (ok && a.run.role === 'turns') {
        a.phase = 'worker';
        a.run.steps.push({ text: "The worker connects to Citadel (it's waited for up to 30 minutes)", state: 'running' });
      } else {
        a.run.report = ok ? clean(done.report, 200) || null : null;
        this.finish(a, ok, ok ? null : clean(done.why, 400) || 'A step failed: its line says why.');
        return true;
      }
    }
    this.save(machine.id, a.run);
    return true;
  }

  /** The screen test's screenshot, from its agent; false when no screen run of that id is going there. */
  async shot(machine: Machine, id: string, bytes: Buffer): Promise<boolean> {
    const a = this.active.get(machine.id);
    if (!a || a.run.id !== id || a.run.role !== 'screen') return false;
    await mkdir(this.d.shotDir, { recursive: true });
    await writeFile(this.shotFile(machine.id), bytes);
    a.heard = this.d.now();
    a.run.shot = a.heard;
    this.save(machine.id, a.run);
    return true;
  }

  shotFile(machineId: number) {
    return join(this.d.shotDir, `${machineId}-screen.png`);
  }

  /** The screenshot people may see: only one this machine's own last screen run took, since machine ids are reused. */
  servedShot(machineId: number): string | null {
    return storedRun(this.d.store, machineId, 'screen')?.shot ? this.shotFile(machineId) : null;
  }

  running(machineId: number): Run | null {
    return this.active.get(machineId)?.run ?? null;
  }

  private step(a: Active, n: number, step: Step, save = true) {
    a.run.steps[Math.min(n, a.run.steps.length)] = step;
    if (save) this.save(a.machineId, a.run);
  }

  private finish(a: Active, ok: boolean, why: string | null) {
    if (this.active.get(a.machineId) === a) this.active.delete(a.machineId);
    // Steps still going when it ended didn't finish.
    for (const s of a.run.steps) if (s.state === 'running' || s.state === 'waiting') s.state = ok ? 'ok' : 'fail';
    this.save(a.machineId, { ...a.run, done: this.d.now(), ok, why });
  }

  private save(machineId: number, run: Run) {
    if (!this.d.store.getMachine(machineId)) return;
    this.d.store.writeMachineRoles(machineId, (roles) => roles.map((r) => (r.role === run.role ? { ...r, setup: { ...(r.setup ?? {}), run } } : r)));
    this.d.changed();
  }
}
