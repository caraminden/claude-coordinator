// One-job runners in warm slot folders (runner pool P2, #2269; Cara, 2026-11-27, #2264's card: "One-job runners, on demand").
// Citadel starts one just-in-time runner per CI job on a machine lending CI to the job's scheme: it mints the runner's
// config with the scheme owner's GitHub login (RunnerTokens.jit), holds it here under a one-time id for a minute or two,
// and asks the machine's runner agent to start slot <n> with that id. The process that runs as the slot's low-rights
// account (tools/ci-runner/launch-slot.ps1, launch-slot.sh) swaps the id for the config at POST /api/machines/runner-jit,
// so neither Citadel nor the agent ever writes the config to a file, a log or a command line. The agent then reports
// the slot's runner started, took a job, ended (or was stopped by its 2-minute reaper), naming the runner Citadel minted
// for that start; after an end Citadel takes that runner off GitHub, which keeps a one-job runner that never ran a job.
// What decides where and when a runner starts is the pool's (src/runner-pool.ts, P1); this is the start and the end.
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { hostsCi, type Listed, type RunnerOs, type RunnerTokens } from './ci-runner.ts';
import type { Machine, Project, Store } from './db.ts';
import { HttpError } from './http.ts';
import type { MachineRelay } from './machines.ts';
import { needsOf } from './runner-pool.ts';
import { thrown } from './thrown.ts';

/** A slot number: 1 to MAX_SLOTS per scheme per machine and OS (the agent's scripts refuse more). */
export const MAX_SLOTS = 16;
/** How long a minted config waits for its launcher: the launcher asks a few seconds after the agent's start. */
export const ONCE_MS = 120_000;
/** How long the agent's start may take: the script waits up to 20 s for the launcher's first lines. */
const START_MS = 90_000;
const CLEAN_TRIES = 3;
const CLEAN_AGAIN_MS = 60_000;

/** A one-job runner's name: the machine, the OS and slot, then the job (or a random tag). Citadel removes only names of this shape, for their own machine. */
export function poolName(machineId: number, os: RunnerOs, slot: number, job?: number): string {
  return `${slotPrefix(machineId, os, slot)}${job ? `j${job}` : randomBytes(3).toString('hex')}`;
}
export const slotPrefix = (machineId: number, os: RunnerOs, slot: number) => `pool-m${machineId}-${os === 'linux' ? 'l' : 'w'}${slot}-`;
/** A one-job runner's name as poolName makes it (the agent checks the same shape). */
export const POOL_NAME = /^pool-m\d{1,9}-[wl](?:[1-9]|1[0-6])-[0-9a-z]{1,20}$/;

/** Configs waiting for their launcher, each handed out once, to whoever holds its id first. Never written anywhere. */
export class OneTime {
  private held = new Map<string, { config: string; timer: NodeJS.Timeout }>();

  put(config: string, ms = ONCE_MS): string {
    const once = randomBytes(24).toString('hex');
    const timer = setTimeout(() => this.held.delete(once), ms);
    timer.unref();
    this.held.set(once, { config, timer });
    return once;
  }

  take(once: unknown): string | null {
    if (typeof once !== 'string' || !/^[0-9a-f]{48}$/.test(once)) return null;
    const got = this.held.get(once);
    if (!got) return null;
    this.drop(once);
    return got.config;
  }

  drop(once: string) {
    clearTimeout(this.held.get(once)?.timer);
    this.held.delete(once);
  }

  get size() {
    return this.held.size;
  }
}

export type SlotEvent = 'started' | 'took' | 'ended' | 'stopped';
const EVENTS: readonly SlotEvent[] = ['started', 'took', 'ended', 'stopped'];

/** An agent's report on one slot's runner, checked field by field. */
export interface SlotReport {
  machineId: number;
  scheme: number;
  os: RunnerOs;
  slot: number;
  event: SlotEvent;
  /** The runner Citadel minted for the start this report is about: always one of this machine's slot's names. */
  runner: string;
  /** took: the job's name as the runner printed it ("Running job: <name>"); the pool reads which job from GitHub by runner name. */
  job?: string;
  /** ended: the launcher's exit code, when the agent saw it. */
  code?: number;
  at: number;
}

export function slotReport(machine: Machine, body: Record<string, unknown>, now = Date.now()): SlotReport {
  const { scheme, slot, os, event, runner, job, code } = body;
  if (!Number.isInteger(scheme) || (scheme as number) < 1) throw new HttpError(400, 'scheme must be a scheme id');
  if (!Number.isInteger(slot) || (slot as number) < 1 || (slot as number) > MAX_SLOTS) throw new HttpError(400, `slot must be 1 to ${MAX_SLOTS}`);
  if (os !== 'windows' && os !== 'linux') throw new HttpError(400, 'os must be windows or linux');
  if (!EVENTS.includes(event as SlotEvent)) throw new HttpError(400, `event must be one of ${EVENTS.join(', ')}`);
  if (typeof runner !== 'string' || !POOL_NAME.test(runner) || !runner.startsWith(slotPrefix(machine.id, os, slot as number))) throw new HttpError(400, "runner must be the name Citadel gave this slot's runner");
  const r: SlotReport = { machineId: machine.id, scheme: scheme as number, os, slot: slot as number, event: event as SlotEvent, runner, at: now };
  // A job's name comes from a file a job can write: kept short and printable, and only ever shown.
  if (typeof job === 'string' && job) r.job = job.replace(/\p{Cc}/gu, ' ').slice(0, 200);
  if (Number.isInteger(code)) r.code = code as number;
  return r;
}

type Relay = Pick<MachineRelay, 'runnerJob'>;

export class RunnerSlots {
  readonly once = new OneTime();
  /** Told every report, for the pool's books (P1). */
  onReport: (r: SlotReport) => void = () => {};
  log: (line: string) => void = () => {};

  private store: Store;
  private tokens: Pick<RunnerTokens, 'jit' | 'listed' | 'removeById'>;
  private relay: Relay;
  private againMs: number;

  constructor(store: Store, tokens: Pick<RunnerTokens, 'jit' | 'listed' | 'removeById'>, relay: Relay, againMs = CLEAN_AGAIN_MS) {
    this.store = store;
    this.tokens = tokens;
    this.relay = relay;
    this.againMs = againMs;
  }

  /**
   * Start one one-job runner in slot `slot` of `project` on `machine`'s `os` agent, with exactly `labels` (the job's
   * runs-on labels) and a name for `job` when the pool knows it. Throws an HttpError when the machine doesn't run CI for
   * the scheme or GitHub won't mint; otherwise the agent's answer.
   */
  async start(project: Project, machine: Machine, ask: { os: RunnerOs; slot: number; labels: string[]; job?: number }): Promise<{ name: string; ok: boolean; output: string }> {
    const { os, slot, labels, job } = ask;
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_SLOTS) throw new HttpError(400, `slot must be 1 to ${MAX_SLOTS}`);
    if (!Array.isArray(labels) || !labels.length || labels.length > 10 || !labels.every((l) => typeof l === 'string' && /^[\w.-]{1,100}$/.test(l))) throw new HttpError(400, 'labels must be 1 to 10 runner labels');
    if (job !== undefined && (!Number.isSafeInteger(job) || job < 1)) throw new HttpError(400, 'job must be a GitHub job id');
    // A desktop job opens windows and reads the screen: its runner runs in the signed-in person's session (P6, #2305;
    // runner-slot.ps1 -Session), which only Windows has. The pool's own reading, so `citadel-heavy-desktop` (a size) isn't one.
    const session = needsOf(labels, project.name).session;
    if (session && os !== 'windows') throw new HttpError(400, "a desktop job's runner needs a Windows session");
    const name = poolName(machine.id, os, slot, job);
    const config = await this.tokens.jit(machine, project, name, labels);
    const once = this.once.put(config);
    const r = await this.relay.runnerJob(machine.id, { op: 'start', scheme: project.id, slot, once, name, ...(session ? { session: true } : {}) }, os, START_MS);
    if (!r.ok) {
      // Never started (or its launcher never asked): GitHub keeps the registration, so take this one off now.
      this.once.drop(once);
      void this.cleanUp(project, name);
    }
    return { name, ...r };
  }

  /** An agent's report on a slot; after an end or a stop, its runner goes from GitHub if it is still there. */
  report(machine: Machine, body: Record<string, unknown>) {
    const r = slotReport(machine, body);
    const project = this.store.getProject(r.scheme);
    // A PC that hosts CI: one that just stopped lending there still reports its last end.
    if (!project || !hostsCi(this.store, machine, project)) throw new HttpError(404, `No scheme ${r.scheme} that machine ${machine.name} runs CI for`);
    this.log(`${machine.name} ${r.os} slot ${r.slot} of ${project.name}: ${r.event}${r.job ? ` (${r.job})` : ''}${r.code !== undefined ? `, exit ${r.code}` : ''}`);
    this.onReport(r);
    if (r.event === 'ended' || r.event === 'stopped') void this.cleanUp(project, r.runner);
    return r;
  }

  /**
   * Take runner `name` off GitHub if it is still there: a one-job runner that ended its job is gone already, one that never
   * took a job stays listed (P0, #2266). One GitHub still calls busy (it hasn't seen a killed runner go), or a list that
   * failed, is tried again, up to CLEAN_TRIES times; true once it's gone.
   */
  async cleanUp(project: Project, name: string): Promise<boolean> {
    for (let tried = 1; tried <= CLEAN_TRIES; tried++) {
      if (tried > 1) await sleep(this.againMs, undefined, { ref: false });
      let listed: Listed | undefined;
      try {
        listed = (await this.tokens.listed(project)).find((x) => x.name === name);
      } catch (err) {
        this.log(`couldn't list ${project.name}'s runners to take ${name} off: ${thrown(err).message}`);
        continue;
      }
      if (!listed) return true;
      if (listed.busy) continue;
      try {
        await this.tokens.removeById(project, listed.id);
        this.log(`took ${name} off ${project.name}`);
        return true;
      } catch (err) {
        this.log(`couldn't take ${name} off ${project.name}: ${thrown(err).message}`);
      }
    }
    this.log(`${name} is still on ${project.name} after ${CLEAN_TRIES} tries`);
    return false;
  }
}
