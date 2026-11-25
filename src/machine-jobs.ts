// Jobs on a person's own machine (#857): the queue of record, the owner's go, job hours, pause and stop. The design and
// the wire contract with the machine agent are shared/project/specs/desktop-gpu-jobs.md (Cara's picks, 2026-11-16);
// src/machines.ts only carries the messages. A job is a kind (a recipe: an image pinned by digest, a command, the
// owner's folders it reads, GPU, network, a top limit) plus input files and a limit. Nothing reaches the agent as
// job.start without a go for that job: its owner's click on its card, or a standing go for the recipe's exact hash,
// which covers job hours only.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Machine, MachineJob, Store, User } from './db.ts';
import { HttpError } from './http.ts';
import { ZONE } from './pacific.ts';
import { every, type Job } from './every.ts';
import type { CardQuestion } from './ci-armed.ts';

export const JOB_STATES = ['needs-go', 'queued', 'starting', 'running', 'paused', 'uploading', 'done', 'failed', 'stopped', 'refused'] as const;
export type JobState = (typeof JOB_STATES)[number];
/** States that hold the machine's one job slot. */
export const ACTIVE: readonly JobState[] = ['starting', 'running', 'paused', 'uploading'];
export const ENDED: readonly JobState[] = ['done', 'failed', 'stopped', 'refused'];
/** What the agent may report a job as (the contract's job-state). */
const AGENT_STATES: readonly JobState[] = ['starting', 'running', 'paused', 'uploading', 'done', 'failed', 'stopped'];

/** The spec's numbers (Cara's picks, 2026-11-16). */
export const JOB_CAPS = {
  /** A job's results kept on this server. */
  jobBytes: 2 * 1024 ** 3,
  /** A scheme's job results kept on this server. */
  schemeBytes: 20 * 1024 ** 3,
  /** A job's inputs. */
  inputBytes: 2 * 1024 ** 3,
  /** Results older than this are deleted from this server; the machine keeps its copy. */
  keepMs: 14 * 24 * 3600_000,
  /** A job's longest limit unless its owner's file allows more (the agent enforces the file's). */
  limitS: 12 * 3600,
  /** A job's whole log (job-upload with log=1), kept beside its results outside the caps above. */
  logBytes: 20 * 1024 ** 2,
  inputs: 50,
  outputs: 500,
};
/** How far past its limit the server lets a running job go before it sends job.stop itself, for the agent's own stop to land first. */
const LIMIT_GRACE_S = 120;
/** A report gap longer than this isn't counted as running time (the agent was offline or stalled). */
const MAX_REPORT_GAP_S = 30;
const LOG_TAIL = 4096;

/** A job kind: the recipe a go is for. */
export interface JobKind {
  name: string;
  /** A container image pinned by digest: something@sha256:<64 hex>. */
  image: string;
  /** The command, one argument per item. */
  command: string[];
  /** The owner's named folders it may read (machine-agent.json's jobs.folders), mounted read-only at /private/<name>. */
  reads: string[];
  gpu: boolean;
  network: boolean;
  /** Its program skips work already in /out or /state when started again, so Pause can stop it and free the GPU. */
  resumable: boolean;
  /** Its top time limit, in seconds; a job's own limit is at or under it. */
  max_limit_s: number;
}

/** What a machine's agent says jobs may use there (its owner's `jobs` block in machine-agent.json; no paths). */
export interface JobsOffer {
  folders: string[];
  max_limit_h: number;
  max_disk_gb: number | null;
  gpu: boolean;
}

/** A machine's job hours (Pacific, "HH:MM"), its one-off window and its whole-machine Pause. */
export interface JobSettings {
  start: string;
  end: string;
  /** "Jobs may run until <time>": a one-off window, in ms; lapses by itself. */
  until: number | null;
  paused: boolean;
}

export const DEFAULT_SETTINGS: JobSettings = { start: '23:00', end: '08:00', until: null, paused: false };

export type Choice = 'hours' | 'now' | 'always' | 'no';
/** The go card's options, in order; the first is what a go defaults to. */
export const CHOICES: { choice: Choice; label: string; description: string }[] = [
  { choice: 'hours', label: 'Run in job hours', description: 'Queue it; it starts once job hours open.' },
  { choice: 'now', label: 'Run now', description: "Start it as soon as the machine is free, outside job hours too; job hours ending won't pause it." },
  { choice: 'always', label: 'Always allow this kind', description: 'Run this one in job hours, and let this exact recipe run in job hours from now on without asking. A changed image, command, folder, GPU, network or limit asks again.' },
  { choice: 'no', label: 'No', description: 'Refuse it; the minion that asked is told.' },
];

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const IMAGE = /^[a-z0-9][a-z0-9._\/:-]{0,250}@sha256:[a-f0-9]{64}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const bool = (v: unknown, field: string, dflt?: boolean): boolean => {
  if (v === undefined && dflt !== undefined) return dflt;
  if (typeof v !== 'boolean') throw new HttpError(400, `kind.${field} must be true or false`);
  return v;
};

/** A kind as sent, checked; throws a 400 naming what is wrong. */
export function cleanKind(kind: unknown): JobKind {
  if (!kind || typeof kind !== 'object') throw new HttpError(400, 'kind must be { name, image, command, reads, gpu, network, resumable, max_limit_h }');
  const raw = kind as Record<string, unknown>;
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!NAME.test(name)) throw new HttpError(400, 'kind.name: 1 to 60 letters, digits, spaces, dots, dashes or underscores');
  const image = typeof raw.image === 'string' ? raw.image.trim() : '';
  if (!IMAGE.test(image)) throw new HttpError(400, 'kind.image must be pinned by digest: registry/name@sha256:<64 hex>, fully qualified (docker.io/..., ghcr.io/...)');
  if (!Array.isArray(raw.command) || !raw.command.length || raw.command.length > 64 || raw.command.some((a: unknown) => typeof a !== 'string' || a.length > 2000 || a.includes('\0'))) {
    throw new HttpError(400, 'kind.command must be 1 to 64 arguments (text), the first the program');
  }
  const reads = raw.reads === undefined ? [] : raw.reads;
  if (!Array.isArray(reads) || reads.length > 20 || reads.some((r: unknown) => typeof r !== 'string' || !FOLDER.test(r))) throw new HttpError(400, "kind.reads must be a list of the owner's folder names");
  const hours = Number(raw.max_limit_h);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 48) throw new HttpError(400, 'kind.max_limit_h must be a number of hours, at most 48');
  return {
    name,
    image,
    command: raw.command.slice(),
    reads: [...new Set(reads as string[])].sort(),
    gpu: bool(raw.gpu, 'gpu', true),
    network: bool(raw.network, 'network', false),
    resumable: bool(raw.resumable, 'resumable', false),
    max_limit_s: Math.round(hours * 3600),
  };
}

/** The recipe's hash: everything but its name, so any change to what runs, what it reads or its top limit is a new kind. */
export function kindHash(k: JobKind): string {
  const { image, command, reads, gpu, network, resumable, max_limit_s } = k;
  return createHash('sha256')
    .update(JSON.stringify({ image, command, reads: [...reads].sort(), gpu, network, resumable, max_limit_s }))
    .digest('hex');
}

/** What an agent's info says about jobs, or null when it has no jobs block. */
export function cleanOffer(offer: unknown): JobsOffer | null {
  if (!offer || typeof offer !== 'object') return null;
  const v = offer as Record<string, unknown>;
  const folders = Array.isArray(v.folders) ? v.folders.filter((f: unknown) => typeof f === 'string' && FOLDER.test(f)).slice(0, 50) : [];
  const h = Number(v.max_limit_h);
  const gb = Number(v.max_disk_gb);
  return { folders, max_limit_h: Number.isFinite(h) && h > 0 ? Math.min(h, 48) : JOB_CAPS.limitS / 3600, max_disk_gb: Number.isFinite(gb) && gb > 0 ? gb : null, gpu: v.gpu !== false };
}

export function storedOffer(m: Pick<Machine, 'jobs'>): JobsOffer | null {
  try {
    return m.jobs ? cleanOffer(JSON.parse(m.jobs)) : null;
  } catch {
    return null;
  }
}

export function storedSettings(m: Pick<Machine, 'job_settings'>): JobSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...(m.job_settings ? JSON.parse(m.job_settings) : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** New settings from a PATCH body over the old; throws a 400. */
export function cleanSettings(old: JobSettings, body: Record<string, unknown>, now = Date.now()): JobSettings {
  const next = { ...old };
  for (const k of ['start', 'end'] as const) {
    if (body[k] === undefined) continue;
    if (typeof body[k] !== 'string' || !HHMM.test(body[k])) throw new HttpError(400, `${k} must be a time like 23:00 (Pacific)`);
    next[k] = body[k];
  }
  if (body.until !== undefined) {
    if (body.until !== null && (typeof body.until !== 'number' || !Number.isFinite(body.until) || body.until <= now || body.until > now + 7 * 24 * 3600_000)) throw new HttpError(400, 'until must be a time in the next 7 days (ms), or null');
    next.until = body.until;
  }
  if (body.paused !== undefined) next.paused = bool(body.paused, 'paused');
  return next;
}

/** Minutes since midnight Pacific, and the zone's short name (PST or PDT). `zone`: a test reading a test server's (#1536). */
export function pacificClock(ms: number, zone = ZONE): { minutes: number; zone: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'short' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { minutes: Number(get('hour')) * 60 + Number(get('minute')), zone: get('timeZoneName') };
}

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));

/** Whether jobs may start on a machine now: inside its hours (which may wrap midnight), or inside its one-off window. */
export function hoursOpen(s: JobSettings, now = Date.now()): boolean {
  if (s.until !== null && now < s.until) return true;
  const m = pacificClock(now).minutes;
  const a = toMinutes(s.start);
  const b = toMinutes(s.end);
  return a === b ? true : a < b ? m >= a && m < b : m >= a || m < b;
}

/** A job's public fields: what the UI, the minion's job_status and a contraption's GET read. */
export function jobView(j: MachineJob, extra: { machine?: string; waits?: string | null; decider?: number | null; ticketNumber?: number | null } = {}) {
  const parse = (s: string | null, d: unknown) => {
    try {
      return s ? JSON.parse(s) : d;
    } catch {
      return d;
    }
  };
  const kind = parse(j.kind, {}) as JobKind;
  const live = parse(j.live, {}) as Record<string, unknown>;
  return {
    id: j.id,
    machine_id: j.machine_id,
    machine: extra.machine ?? null,
    project_id: j.project_id,
    ticket_id: j.ticket_id,
    /** The minion's number in its scheme, for a link to its chat. */
    ticket_number: extra.ticketNumber ?? null,
    contraption_id: j.contraption_id,
    asked_by: j.asked_by,
    /** The person whose go, Pause, Resume, Stop and Run now it takes (an admin may too): the machine's owner. */
    decider_id: extra.decider ?? null,
    kind: { ...kind, max_limit_h: kind.max_limit_s / 3600 },
    kind_hash: j.kind_hash,
    inputs: (parse(j.inputs, []) as { name: string; size: number; sha256: string }[]).map(({ name, size, sha256 }) => ({ name, size, sha256 })),
    limit_s: j.limit_s,
    when: j.run_when,
    reason: j.reason,
    state: j.state as JobState,
    /** Why a queued job hasn't started: "machine offline", "outside job hours (opens 23:00 PST)", "behind job #N", "machine paused". */
    waits: extra.waits ?? null,
    go: j.go,
    go_by: j.go_by,
    paused_by: j.paused_by,
    created_at: j.created_at,
    started_at: j.started_at,
    ended_at: j.ended_at,
    run_s: Math.max(j.run_s, j.server_run_s),
    gpu_busy_s: j.gpu_busy_s,
    gpu_pct: typeof live.gpu_pct === 'number' ? live.gpu_pct : null,
    vram_mb: typeof live.vram_mb === 'number' ? live.vram_mb : null,
    held_vram_mb: typeof live.held_vram_mb === 'number' ? live.held_vram_mb : null,
    log_tail: typeof live.log_tail === 'string' ? live.log_tail : '',
    live_at: j.live_at,
    exit_code: j.exit_code,
    error: j.error,
    pause_failed: j.pause_failed,
    outputs: parse(j.outputs, []),
    upload_bytes: j.upload_bytes,
    swept: j.swept_at !== null,
  };
}
export type JobView = ReturnType<typeof jobView>;

/** How long a job may sit in "starting" with no word from its machine: inputs and an image pull fit well inside. */
export const STARTING_TIMEOUT_S = 2 * 3600;

/** The results a job's machine kept because the server didn't take them, named with where they are there (MA3). */
export function notTaken(job: MachineJob, machine: string): string {
  let all: unknown = [];
  try {
    all = job.outputs ? JSON.parse(job.outputs) : [];
  } catch {}
  const left = ((Array.isArray(all) ? all : []) as { path: string; uploaded: boolean; why?: string }[]).filter((o) => !o.uploaded);
  if (!left.length) return '';
  const names = left
    .slice(0, 5)
    .map((o) => `${o.path}${o.why ? ` (${o.why})` : ''}`)
    .join(', ');
  return ` Not taken, so still only on ${machine}, in job folder ${job.id}/out/ of its jobs folder: ${names}${left.length > 5 ? ` and ${left.length - 5} more` : ''}. Its owner has them; nothing fetches them from here.`;
}

/** A message for a machine's agent, on its stream (the contract's server-to-agent messages). */
export type AgentJobMessage =
  | { type: 'job.start'; id: number; kind: Omit<JobKind, 'max_limit_s'>; limit_s: number; inputs: { name: string; size: number; sha256: string }[]; input_token: string; resume: boolean }
  | { type: 'job.pause' | 'job.resume' | 'job.stop'; id: number }
  | { type: 'job.fetch'; id: number; path: string };

/** Who acts on a job from a person's side: the session's fields MachineJobs needs. */
export type Actor = { uid: number; name: string; admin: boolean };

/** What the queue needs from the rest of the server; tests hand it fakes. */
export interface JobDeps {
  store: Store;
  /** Send an agent a job message; false if no agent with a jobs block is connected for that machine. */
  send(machineId: number, msg: AgentJobMessage): boolean;
  online(machineId: number): boolean;
  broadcast(msg: object): void;
  /** Post the go card; returns where it is, or null when there is nowhere to post it. */
  postCard(job: MachineJob, card: { questions: CardQuestion[]; recipe?: object; to?: string }): { ticket: number; question: string } | null;
  /** The card was answered from somewhere else (the Machines page): settle it, and say in its chat what happened. */
  settleCard(card: { ticket: number; question: string }, by: string, line: string): void;
  /** Tell the minion that queued a job that it ended or was refused; this wakes it, as CI does. `light` for a job that finished OK (#951). */
  wake(ticketId: number, text: string, light?: boolean): void;
  /** A line in the minion's chat that wakes nobody. */
  note(ticketId: number, text: string): void;
  /** Put a minion's live job card at the bottom of its chat: when queued (after the go card), and again each time it starts, pauses or ends. */
  placed?(job: MachineJob, stage: JobStage, view: JobView): void;
  /** Where a job's results go: the scheme's shared folder's jobs/<id>/ for a minion's, the app's DATA_DIR/jobs/<id>/ for a contraption's. */
  resultsDir(job: MachineJob): string | null;
  now?: () => number;
}

/**
 * Where a job's card stands in its minion's chat (#859, Cara's pick "The card follows the bottom"): a change of
 * stage moves the card to the bottom, and its old place becomes a one-line note. Starting and uploading don't move it.
 */
export type JobStage = 'waiting' | 'running' | 'paused' | 'ended';
export function jobStage(state: string): JobStage {
  if (state === 'needs-go' || state === 'queued') return 'waiting';
  if (state === 'paused') return 'paused';
  return (ENDED as readonly string[]).includes(state) ? 'ended' : 'running';
}

const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

/** How long an agent may take over a job.resume before its "paused" is believed (2MA3); it reports every 10 s. */
const RESUME_ACTS_MS = 15_000;

export class MachineJobs {
  private d: JobDeps;
  private timers: Job[] = [];

  constructor(deps: JobDeps) {
    this.d = deps;
  }

  private now() {
    return this.d.now ? this.d.now() : Date.now();
  }
  private get store() {
    return this.d.store;
  }

  /** Every minute: open or close job hours, enforce limits; every 6 hours: sweep old results. */
  start() {
    this.timers.push(
      every('machine jobs', 60_000, () => this.tickAll()),
      every('machine job results sweep', 6 * 3600_000, () => this.sweep(), 5 * 60_000),
    );
  }

  stop() {
    for (const t of this.timers) t.stop();
  }

  /** The person whose go a machine's jobs need: its owner, or for one from before owners, the person who added it. */
  ownerOf(m: Machine): User | null {
    if (m.owner_id !== null) return this.store.getUser(m.owner_id) ?? null;
    return this.store.listUsers().find((u) => u.name === m.created_by) ?? null;
  }

  /** Whether this person may pause, resume or stop a machine's jobs, or see them: its owner, or an admin (a Citadel scheme member). The go itself is isOwner. */
  mayDecide(who: Actor, m: Machine): boolean {
    return who.admin || this.ownerOf(m)?.id === who.uid;
  }

  /** Whether this person is the machine's owner: the go, "Always allow", run now and job hours are theirs alone (spec 6: it is their PC), admins and scheme members included. */
  isOwner(who: Actor, m: Machine): boolean {
    return this.ownerOf(m)?.id === who.uid;
  }

  machineOf(job: MachineJob): Machine {
    const m = this.store.getMachine(job.machine_id);
    if (!m) throw new HttpError(404, "That job's machine is gone");
    return m;
  }

  /** Why a queued job hasn't started yet, or null when it would start at the next pump. */
  waits(job: MachineJob, m = this.machineOf(job)): string | null {
    if (job.state !== 'queued') return null;
    if (!this.d.online(m.id)) return 'machine offline';
    const s = storedSettings(m);
    if (s.paused) return 'machine paused';
    const active = this.store.machineJobs({ machine: m.id, states: ACTIVE }, 1)[0];
    if (active) return `behind job #${active.id}`;
    if (job.go !== 'now' && !hoursOpen(s, this.now())) return `outside job hours (opens ${s.start} ${pacificClock(this.now()).zone})`;
    const ahead = this.store.machineJobs({ machine: m.id, states: ['queued'] }, 1000).filter((q) => q.id < job.id && (q.go === 'now' || hoursOpen(s, this.now())));
    if (ahead.length) return `behind job #${ahead.at(-1)!.id}`;
    return null;
  }

  view(job: MachineJob): JobView {
    const m = this.store.getMachine(job.machine_id);
    return jobView(job, { machine: m?.name, waits: m ? this.waits(job, m) : null, decider: m ? (this.ownerOf(m)?.id ?? null) : null, ticketNumber: job.ticket_id === null ? null : (this.store.getTicket(job.ticket_id)?.number ?? null) });
  }

  /** Tell the job's viewers what changed: the scheme's people, and its machine's owner wherever they are. */
  private changed(id: number) {
    const job = this.store.getMachineJob(id);
    if (!job) return;
    const view = this.view(job);
    this.place(job, view);
    this.d.broadcast({ type: 'machine_job', projectId: job.project_id, job: view });
    const owner = this.ownerOf(this.machineOf(job));
    if (owner && !this.store.canSee({ uid: owner.id, admin: this.store.isAdmin(owner) }, job.project_id)) this.d.broadcast({ type: 'machine_job', to: owner.id, job: view });
  }

  /** The stage each live minion's job card was last put at the bottom for; read back from the chat after a restart. */
  private stages = new Map<number, JobStage>();
  private place(job: MachineJob, view: JobView) {
    if (job.ticket_id === null || !this.d.placed) return;
    const stage = jobStage(job.state);
    // 'starting' (the go given, the machine told) is still waiting to the eye, and moves nothing until it runs.
    const shown = job.state === 'starting' ? 'waiting' : stage;
    let last = this.stages.get(job.id);
    if (last === undefined) {
      const ev = this.store
        .eventsOfKinds(job.ticket_id, ['job'])
        .map((e) => JSON.parse(e.data))
        .filter((d) => d.job === job.id)
        .at(-1);
      last = ev ? (ev.stage ?? 'waiting') : undefined;
    }
    if (last !== shown) this.d.placed(job, shown, view);
    if (shown === 'ended') this.stages.delete(job.id);
    else this.stages.set(job.id, shown);
  }

  /** A machine's agent went away: its queued jobs now wait on it. */
  offline(machineId: number) {
    this.changedMachine(machineId);
  }

  /** Every queued job on a machine changes its "waits" when the machine does: tell the viewers. */
  private changedMachine(machineId: number) {
    for (const j of this.store.machineJobs({ machine: machineId, states: ['queued', ...ACTIVE] }, 200)) this.changed(j.id);
  }

  /**
   * Queue a job. Inputs are already checked and hashed by the caller (paths it may read). A kind its owner always
   * allows goes straight to the queue for job hours; anything else, run-now included, waits on its owner's card.
   */
  queue(q: { machine: Machine; projectId: number; ticketId: number | null; contraptionId: number | null; askedBy: string; kind: JobKind; inputs: { name: string; size: number; sha256: string; path: string }[]; limitS: number; when: 'hours' | 'now'; reason: string }): MachineJob {
    const offer = storedOffer(q.machine);
    if (!offer) throw new HttpError(409, `${q.machine.name}'s agent has no jobs block: its owner sets one up in machine-agent.json first`);
    const missing = q.kind.reads.filter((r) => !offer.folders.includes(r));
    if (missing.length) throw new HttpError(400, `${q.machine.name} has no folder called ${missing.join(', ')} for jobs; it offers ${offer.folders.join(', ') || 'none'}`);
    if (q.kind.gpu && !offer.gpu) throw new HttpError(400, `${q.machine.name} doesn't lend its GPU to jobs`);
    if (q.kind.max_limit_s > offer.max_limit_h * 3600) throw new HttpError(400, `kind.max_limit_h is over ${q.machine.name}'s ${offer.max_limit_h} h`);
    if (!Number.isInteger(q.limitS) || q.limitS < 60 || q.limitS > q.kind.max_limit_s) throw new HttpError(400, `The limit must be 1 minute to the kind's ${q.kind.max_limit_s / 3600} h`);
    if (q.when === 'now' && !q.reason.trim()) throw new HttpError(400, 'when "now" needs a reason: its owner reads it on the card');
    const hash = kindHash(q.kind);
    const standing = q.when === 'hours' && !!this.store.jobKind(q.machine.id, hash);
    const job = this.store.addMachineJob({
      machine_id: q.machine.id,
      project_id: q.projectId,
      ticket_id: q.ticketId,
      contraption_id: q.contraptionId,
      asked_by: q.askedBy,
      kind_name: q.kind.name,
      kind: JSON.stringify(q.kind),
      kind_hash: hash,
      inputs: JSON.stringify(q.inputs),
      limit_s: q.limitS,
      run_when: q.when,
      reason: q.reason,
      state: standing ? 'queued' : 'needs-go',
      created_at: this.now(),
      ...(standing ? { go: 'standing' as const, go_by: this.store.jobKind(q.machine.id, hash)!.allowed_by } : {}),
    });
    if (!standing) this.askOwner(job, q.machine);
    this.changed(job.id);
    this.pump(q.machine.id);
    return this.store.getMachineJob(job.id)!;
  }

  /** The go card: to the machine's owner, showing what runs, what it reads, GPU, network, limit, inputs and who asked. */
  private askOwner(job: MachineJob, m: Machine) {
    const k = JSON.parse(job.kind) as JobKind;
    const inputs = JSON.parse(job.inputs) as { name: string; size: number }[];
    const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
    const h = (s: number) => (s % 3600 ? `${Math.round(s / 60)} min` : `${s / 3600} h`);
    const line = {
      who: `${job.asked_by} wants to run job #${job.id} "${k.name}" on ${m.name}${job.run_when === 'now' ? ' NOW' : ' in job hours'}${job.reason ? ` (${job.reason})` : ''}.`,
      reads: `Reads ${k.reads.length ? k.reads.join(', ') : 'none of your folders'}; GPU ${k.gpu ? 'yes' : 'no'}; network ${k.network ? 'yes' : 'no'}; limit ${h(job.limit_s)}`,
      image: `Image ${k.image}`,
      command: `Command ${k.command.join(' ')}`,
      inputs: `Inputs ${inputs.length ? inputs.map((i) => `${i.name} (${mb(i.size)})`).join(', ') : 'none'}`,
    };
    // A card's question is at most 500 characters. What it reads, GPU, network and the image stay whole; the inputs,
    // then the command, then the reason give way (down to 40 characters each), and the job's page has them whole.
    let over = Object.values(line).join('\n').length - 500;
    for (const key of ['inputs', 'command', 'who'] as const) {
      const cut = Math.min(over, line[key].length - 40);
      if (cut > 0) {
        line[key] = `${line[key].slice(0, line[key].length - cut - 1)}…`;
        over -= cut;
      }
    }
    let question = [line.who, line.reads, line.image, line.command, line.inputs].join('\n');
    if (question.length > 500) question = `${question.slice(0, 499)}…`;
    const owner = this.ownerOf(m);
    const card = this.d.postCard(job, {
      questions: [{ header: 'GPU job go', question, options: CHOICES.map(({ label, description }, i) => ({ label, description, ...(i === (job.run_when === 'now' ? 1 : 0) ? { recommended: true } : {}) })) }],
      // The page lays these out whole (#859); the question's text is the same, cut to 500 characters, for everything else.
      recipe: { machine: m.name, asked_by: job.asked_by, when: job.run_when, reason: job.reason, limit_s: job.limit_s, kind: { name: k.name, image: k.image, command: k.command, reads: k.reads, gpu: k.gpu, network: k.network, resumable: k.resumable }, inputs: inputs.map(({ name, size }) => ({ name, size })) },
      // Addressed to its owner when they are in the scheme; otherwise it waits in the chat and on their Machines page.
      ...(owner && this.store.canSee({ uid: owner.id, admin: this.store.isAdmin(owner) }, job.project_id) ? { to: owner.name } : {}),
    });
    if (card) this.store.updateMachineJob(job.id, { card: JSON.stringify(card) });
  }

  /** The label on the go card for a choice, or the choice for a label. */
  static choiceOf(label: string): Choice | null {
    return CHOICES.find((c) => c.label === label)?.choice ?? null;
  }

  /**
   * Its owner's answer to a job's go. `fromCard`: answered on the card itself (which records the answer); otherwise
   * from the Machines page, and the card is settled here. Throws 403 for anyone but its owner or an admin.
   */
  decide(id: number, choice: Choice, who: Actor, fromCard = false): MachineJob {
    const job = this.get(id);
    const m = this.machineOf(job);
    if (!this.isOwner(who, m)) throw new HttpError(403, `Only ${this.ownerOf(m)?.name ?? 'its owner'} (${m.name}'s owner) can give this job its go`);
    if (job.state !== 'needs-go') throw new HttpError(409, `Job #${id} isn't waiting on a go (it is ${job.state})`);
    const card = job.card ? (JSON.parse(job.card) as { ticket: number; question: string }) : null;
    const said = CHOICES.find((c) => c.choice === choice)!.label;
    if (card && !fromCard) this.d.settleCard(card, who.name, `${who.name} answered job #${id}'s go on the Machines page: ${said}`);
    if (choice === 'no') {
      this.store.updateMachineJob(id, { state: 'refused', go_by: who.name, ended_at: this.now(), card: null, error: `${who.name} said no` });
      this.ended(id, `Job #${id} (${job.kind_name}) on ${m.name} was refused by ${who.name}.`);
      return this.store.getMachineJob(id)!;
    }
    if (choice === 'always') this.store.allowJobKind(m.id, job.kind_hash, job.kind_name, job.kind, who.name);
    this.store.updateMachineJob(id, { state: 'queued', go: choice, go_by: who.name, card: null });
    if (job.ticket_id !== null && fromCard) this.d.note(job.ticket_id, `${who.name} gave job #${id} its go: ${said}.`);
    this.changed(id);
    this.pump(m.id);
    return this.store.getMachineJob(id)!;
  }

  get(id: number): MachineJob {
    const job = this.store.getMachineJob(id);
    if (!job) throw new HttpError(404, `No job #${id}`);
    return job;
  }

  /** "Run now" on a queued job: its owner's override of job hours for that one job. */
  runNow(id: number, who: Actor): MachineJob {
    const job = this.get(id);
    const m = this.machineOf(job);
    if (!this.isOwner(who, m)) throw new HttpError(403, `Only ${m.name}'s owner can run a job now`);
    if (job.state === 'needs-go') return this.decide(id, 'now', who);
    if (job.state === 'paused' && job.paused_by === 'hours') {
      this.store.updateMachineJob(id, { go: 'now', go_by: who.name });
      return this.resume(id, who);
    }
    if (job.state !== 'queued') throw new HttpError(409, `Job #${id} is ${job.state}, not waiting`);
    this.store.updateMachineJob(id, { go: 'now', go_by: who.name });
    this.changed(id);
    this.pump(m.id);
    return this.store.getMachineJob(id)!;
  }

  /** Pause a running job: its owner's click. The agent frees the GPU (a resumable kind) or freezes it. */
  pause(id: number, who: Actor): MachineJob {
    const job = this.get(id);
    const m = this.machineOf(job);
    if (!this.mayDecide(who, m)) throw new HttpError(403, `Only ${m.name}'s owner or an admin can pause its jobs`);
    if (job.state !== 'running' && job.state !== 'starting') throw new HttpError(409, `Job #${id} is ${job.state}, not running`);
    if (!this.d.send(m.id, { type: 'job.pause', id })) throw new HttpError(409, this.unreachable(m));
    this.resumeSent.delete(id);
    this.store.updateMachineJob(id, { state: 'paused', paused_by: 'owner' });
    this.changed(id);
    return this.store.getMachineJob(id)!;
  }

  resume(id: number, who: Actor): MachineJob {
    const job = this.get(id);
    const m = this.machineOf(job);
    if (!this.mayDecide(who, m)) throw new HttpError(403, `Only ${m.name}'s owner or an admin can resume its jobs`);
    if (job.state !== 'paused') throw new HttpError(409, `Job #${id} is ${job.state}, not paused`);
    if (storedSettings(m).paused) throw new HttpError(409, `${m.name}'s jobs are paused: switch the machine's Pause off first`);
    if (!this.d.send(m.id, { type: 'job.resume', id })) throw new HttpError(409, this.unreachable(m));
    // Resumed outside job hours by a person: it runs now, or the next pump would pause it again.
    const now = !hoursOpen(storedSettings(m), this.now()) && job.go !== 'now' ? { go: 'now' as const, go_by: who.name } : {};
    this.store.updateMachineJob(id, { state: 'running', paused_by: null, live_at: this.now(), ...now });
    this.changed(id);
    return this.store.getMachineJob(id)!;
  }

  /**
   * Stop a job: its owner (or an admin) for any, and whoever queued it (`asker`) for their own. A job not yet on the
   * machine ends at once; one on it is told to stop and ends when the agent says so.
   */
  stopJob(id: number, who: Actor | { asker: true }, why = 'stopped'): MachineJob {
    const job = this.get(id);
    const m = this.machineOf(job);
    if (!('asker' in who) && !this.mayDecide(who, m)) throw new HttpError(403, `Only ${m.name}'s owner, an admin or whoever queued it can stop job #${id}`);
    const by = 'asker' in who ? job.asked_by : who.name;
    if ((ENDED as readonly string[]).includes(job.state)) throw new HttpError(409, `Job #${id} already ended (${job.state})`);
    if (job.state === 'needs-go' || job.state === 'queued') {
      const card = job.card ? (JSON.parse(job.card) as { ticket: number; question: string }) : null;
      if (card) this.d.settleCard(card, by, `Job #${id} was stopped by ${by} before its go`);
      this.store.updateMachineJob(id, { state: 'stopped', ended_at: this.now(), card: null, error: `${why} by ${by}` });
      this.ended(id, `Job #${id} (${job.kind_name}) on ${m.name} was stopped by ${by} before it started.`, 'asker' in who);
      this.pump(m.id);
      return this.store.getMachineJob(id)!;
    }
    // On the machine: tell it, and end it here too if it is offline (it reconciles when it comes back and is told to stop then).
    const sent = this.d.send(m.id, { type: 'job.stop', id });
    this.store.updateMachineJob(id, { error: `${why} by ${by}`, ...(sent ? {} : { state: 'stopped', ended_at: this.now() }) });
    if (!sent) this.ended(id, `Job #${id} (${job.kind_name}) on ${m.name} was stopped by ${by}; ${this.unreachable(m)} and is told when it next lists its jobs.`, 'asker' in who);
    else this.changed(id);
    return this.store.getMachineJob(id)!;
  }

  /** Why a message about a job can't reach its machine: offline, or (2MA10) there with jobs off and not listing it. */
  private unreachable(m: Machine): string {
    return this.d.online(m.id) ? `${m.name} has jobs switched off and doesn't list this one` : `${m.name} is offline`;
  }

  /** Its machine is being removed, or its scheme came off it (2MA9; only what hasn't started): the job ends, its card settles and its minion hears. */
  drop(machineId: number, why: string, which: (j: MachineJob) => boolean) {
    for (const j of this.store.machineJobs({ machine: machineId, states: ['needs-go', 'queued', ...ACTIVE] }, 1000).filter(which)) {
      if ((ACTIVE as readonly string[]).includes(j.state)) this.d.send(machineId, { type: 'job.stop', id: j.id });
      const card = j.card ? (JSON.parse(j.card) as { ticket: number; question: string }) : null;
      if (card) this.d.settleCard(card, 'Citadel', `Job #${j.id} was stopped: ${why}`);
      this.store.updateMachineJob(j.id, { state: 'stopped', ended_at: this.now(), input_token_hash: null, card: null, error: why });
      this.ended(j.id, `Job #${j.id} (${j.kind_name}) was stopped: ${why}.`);
    }
  }

  /** The owner (or an admin) takes back an "Always allow": the next job of that kind asks again, as does one queued on it. */
  forgetKind(m: Machine, hash: string, who: Actor) {
    if (!this.isOwner(who, m)) throw new HttpError(403, `Only ${m.name}'s owner can change what it always allows`);
    if (!this.store.forgetJobKind(m.id, hash)) throw new HttpError(404, `${m.name} doesn't always allow that kind`);
    // Left on their standing go they would never start, and hold up the line behind them (2MA4).
    for (const j of this.store.machineJobs({ machine: m.id, states: ['queued'] }, 1000)) {
      if (j.go !== 'standing' || j.kind_hash !== hash) continue;
      this.store.updateMachineJob(j.id, { state: 'needs-go', go: null, go_by: null });
      this.askOwner(j, m);
      this.changed(j.id);
    }
    this.pump(m.id);
  }

  /** A machine's job hours, one-off window or Pause changed (its owner's): pause or resume what runs, start what may. */
  setSettings(m: Machine, body: unknown, who: Actor): JobSettings {
    if (!this.isOwner(who, m)) throw new HttpError(403, `Only ${m.name}'s owner can change its job hours`);
    const s = cleanSettings(storedSettings(m), (body ?? {}) as Record<string, unknown>, this.now());
    this.store.updateMachine(m.id, { job_settings: JSON.stringify(s) });
    this.pump(m.id);
    this.changedMachine(m.id);
    return s;
  }

  /** A job ended (or was refused): tell its viewers, wake the minion that asked, start the next. */
  private ended(id: number, text: string, quiet = false) {
    const job = this.store.getMachineJob(id)!;
    this.changed(id);
    if (job.ticket_id !== null && !quiet) {
      const res = job.state === 'done' ? ` Results: ${job.upload_bytes ? `jobs/${id}/ in the scheme's shared folder` : 'none uploaded'}.` : '';
      this.d.wake(job.ticket_id, `${text}${res}${notTaken(job, this.machineOf(job).name)} job_status ${id} has the details.`, job.state === 'done');
    }
  }

  /**
   * Start what may start on a machine, and pause or resume for job hours. One job at a time: a running or paused one
   * holds the slot. Only a job with a go is ever sent job.start.
   */
  pump(machineId: number) {
    const m = this.store.getMachine(machineId);
    if (!m || !this.d.online(machineId) || !storedOffer(m)) return;
    const s = storedSettings(m);
    const open = hoursOpen(s, this.now());
    const active = this.store.machineJobs({ machine: machineId, states: ACTIVE }, 1)[0];
    if (active) {
      if (active.state === 'running' && !s.paused && !open && active.go !== 'now') this.hold(active, 'hours');
      else if (active.state === 'running' && s.paused) this.hold(active, 'machine');
      else if (active.state === 'paused' && active.paused_by === 'machine' && !s.paused && !open && active.go !== 'now') {
        // The machine's Pause is off, but job hours are closed: they hold it now (2MA8).
        this.store.updateMachineJob(active.id, { paused_by: 'hours' });
        this.changed(active.id);
      } else if (active.state === 'paused' && ((active.paused_by === 'hours' && open) || (active.paused_by === 'machine' && !s.paused)) && !s.paused) {
        if (this.d.send(machineId, { type: 'job.resume', id: active.id })) {
          this.store.updateMachineJob(active.id, { state: 'running', paused_by: null, live_at: this.now() });
          this.changed(active.id);
        }
      }
      return;
    }
    if (s.paused) return;
    const next = this.store
      .machineJobs({ machine: machineId, states: ['queued'] }, 1000)
      .reverse()
      .find((j) => j.go !== null && (j.go === 'now' || open));
    if (!next) return;
    this.startJob(next);
  }

  private hold(job: MachineJob, by: 'hours' | 'machine') {
    if (!this.d.send(job.machine_id, { type: 'job.pause', id: job.id })) return;
    this.resumeSent.delete(job.id);
    this.store.updateMachineJob(job.id, { state: 'paused', paused_by: by });
    this.changed(job.id);
  }

  private startJob(job: MachineJob) {
    // The one gate: a go of its own, or a standing go that still holds for this exact recipe and isn't a run-now.
    if (job.go === null || (job.go === 'standing' && (job.run_when !== 'hours' || !this.store.jobKind(job.machine_id, job.kind_hash)))) return;
    const k = JSON.parse(job.kind) as JobKind;
    const token = randomBytes(24).toString('base64url');
    const { max_limit_s: _, ...kind } = k;
    const inputs = (JSON.parse(job.inputs) as { name: string; size: number; sha256: string }[]).map(({ name, size, sha256 }) => ({ name, size, sha256 }));
    this.store.updateMachineJob(job.id, { state: 'starting', input_token_hash: tokenHash(token), started_at: this.now(), live_at: this.now() });
    if (!this.d.send(job.machine_id, { type: 'job.start', id: job.id, kind, limit_s: job.limit_s, inputs, input_token: token, resume: false })) {
      this.store.updateMachineJob(job.id, { state: 'queued', input_token_hash: null, started_at: null });
      return;
    }
    this.changed(job.id);
  }

  /** Every machine with jobs: job hours opening or closing, a one-off window lapsing, a limit passed. */
  tickAll() {
    for (const m of this.store.listMachines()) {
      if (!storedOffer(m)) continue;
      const s = storedSettings(m);
      if (s.until !== null && s.until <= this.now()) this.store.updateMachine(m.id, { job_settings: JSON.stringify({ ...s, until: null }) });
      this.enforceLimit(m.id);
      this.timeOutStart(m.id);
      this.pump(m.id);
      // "outside job hours" and "behind job #N" change with the clock: keep viewers' lines true.
      for (const j of this.store.machineJobs({ machine: m.id, states: ['queued'] }, 200)) this.changed(j.id);
    }
  }

  /** The server enforces the limit too, in case the agent doesn't: past it and a grace, it sends job.stop. Paused time doesn't count. */
  private enforceLimit(machineId: number) {
    const j = this.store.machineJobs({ machine: machineId, states: ['running'] }, 1)[0];
    if (!j || Math.max(j.run_s, j.server_run_s) <= j.limit_s + LIMIT_GRACE_S || j.error) return;
    this.d.send(machineId, { type: 'job.stop', id: j.id });
    this.store.updateMachineJob(j.id, { error: `over its ${Math.round(j.limit_s / 60)} min limit; Citadel stopped it` });
    this.changed(j.id);
  }

  /** A job the machine never moved past "starting" (MA8: an agent that lost it, or a refusal it couldn't report) fails, so the queue moves. */
  private timeOutStart(machineId: number) {
    const j = this.store.machineJobs({ machine: machineId, states: ['starting'] }, 1)[0];
    if (!j || this.now() - (j.live_at ?? j.started_at ?? this.now()) < STARTING_TIMEOUT_S * 1000) return;
    this.d.send(machineId, { type: 'job.stop', id: j.id });
    const error = `the machine said nothing for ${STARTING_TIMEOUT_S / 3600} h while starting it; Citadel gave up on it`;
    this.store.updateMachineJob(j.id, { state: 'failed', ended_at: this.now(), input_token_hash: null, error });
    this.ended(j.id, `Job #${j.id} (${j.kind_name}) on ${this.machineOf(j).name} failed: ${error}.`);
  }

  /** When each job was last sent a job.resume again; a pause or a person's resume starts it afresh. */
  private resumeSent = new Map<number, number>();

  /** Send job.resume again, at most once a minute for a job. False when it wasn't sent. */
  private sendResume(machineId: number, id: number): boolean {
    if (this.now() - (this.resumeSent.get(id) ?? -Infinity) < 60_000) return false;
    if (!this.d.send(machineId, { type: 'job.resume', id })) return false;
    this.resumeSent.set(id, this.now());
    return true;
  }

  /** The agent's job-state report (every 10 s while a job runs, and on every change). */
  report(m: Machine, body: Record<string, unknown>): void {
    const id = Number(body?.id);
    const job = Number.isInteger(id) ? this.store.getMachineJob(id) : undefined;
    if (!job || job.machine_id !== m.id) throw new HttpError(404, 'No such job on this machine');
    const state = body.state as JobState;
    if (!AGENT_STATES.includes(state)) throw new HttpError(400, `state must be one of ${AGENT_STATES.join(', ')}`);
    if ((ENDED as readonly string[]).includes(job.state)) {
      // Ended here (stopped while it was offline): it shouldn't still run there.
      if (!(ENDED as readonly string[]).includes(state)) this.d.send(m.id, { type: 'job.stop', id });
      throw new HttpError(409, `Job #${id} already ended (${job.state})`);
    }
    if (job.state === 'needs-go' || job.state === 'queued') {
      // Never started by this server: whatever the agent thinks, it must stop.
      this.d.send(m.id, { type: 'job.stop', id });
      throw new HttpError(409, `Job #${id} hasn't been started`);
    }
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
    const now = this.now();
    // Running time as the server sees it: report gaps while running, each capped, so a lost agent's silence doesn't count.
    const gap = job.state === 'running' && job.live_at ? Math.min(MAX_REPORT_GAP_S, Math.max(0, (now - job.live_at) / 1000)) : 0;
    const outputs = Array.isArray(body.outputs)
      ? body.outputs
          .slice(0, JOB_CAPS.outputs)
          .flatMap((o: Record<string, unknown>) => (typeof o?.path === 'string' && num(o.size) !== null ? [{ path: o.path.slice(0, 500), size: num(o.size), uploaded: o.uploaded === true, ...(o.uploaded !== true && typeof o.why === 'string' ? { why: o.why.slice(0, 300) } : {}) }] : []))
      : undefined;
    const live = {
      gpu_pct: num(body.gpu_pct),
      vram_mb: num(body.vram_mb),
      held_vram_mb: num(body.held_vram_mb),
      log_tail: typeof body.log_tail === 'string' ? body.log_tail.slice(-LOG_TAIL) : '',
    };
    const ended = (ENDED as readonly string[]).includes(state);
    if (ended) this.resumeSent.delete(id);
    // A pause stays the server's: a "running" report sent before the agent got job.pause (a resumable kind's grace)
    // leaves it paused, and the agent saying "paused" keeps who paused it, so job hours can resume it.
    // ...unless the agent says its pause failed (MA2): then it runs, and the owner sees why.
    const pauseFailed = typeof body.pause_failed === 'string' ? body.pause_failed.slice(0, 500) : null;
    const held = job.state === 'paused' && (state === 'running' || state === 'starting') && !pauseFailed;
    // A "paused" from before the agent acted on a job.resume, or one it never got (2MA3): told again, at most once a
    // minute, and the agent gets a few seconds to act on it; one still paused after those is believed.
    const acting = now - (this.resumeSent.get(id) ?? -Infinity) < RESUME_ACTS_MS;
    const resumes = job.state === 'running' && state === 'paused' && !job.error && (acting || this.sendResume(m.id, id));
    this.store.updateMachineJob(id, {
      state: held ? 'paused' : resumes ? 'running' : state,
      live: JSON.stringify(live),
      live_at: now,
      run_s: Math.round(num(body.run_s) ?? job.run_s),
      server_run_s: Math.round(job.server_run_s + gap),
      gpu_busy_s: Math.round(num(body.gpu_busy_s) ?? job.gpu_busy_s),
      ...(state === 'paused' && !resumes && !job.paused_by ? { paused_by: 'owner' } : {}),
      ...(state !== 'paused' && !held ? { paused_by: null } : {}),
      ...(outputs ? { outputs: JSON.stringify(outputs) } : {}),
      ...(ended || (state === 'paused' && !resumes) ? { pause_failed: null } : pauseFailed ? { pause_failed: pauseFailed } : {}),
      ...(ended ? { ended_at: now, input_token_hash: null, exit_code: Number.isInteger(body.exit_code) ? (body.exit_code as number) : null, error: typeof body.error === 'string' ? body.error.slice(0, 2000) : job.error } : {}),
    });
    if (ended) {
      const m2 = this.machineOf(job);
      const j = this.store.getMachineJob(id)!;
      const time = `${Math.round(Math.max(j.run_s, j.server_run_s) / 60)} min, GPU busy ${Math.round(j.gpu_busy_s / 60)} min`;
      this.ended(id, `Job #${id} (${job.kind_name}) on ${m2.name} ${state === 'done' ? 'is done' : state === 'failed' ? `failed${j.error ? `: ${j.error}` : ''}` : `was stopped${j.error ? ` (${j.error})` : ''}`} after ${time}.`);
      this.pump(m.id);
    } else {
      this.changed(id);
      this.enforceLimit(m.id);
    }
  }

  /**
   * The agent connected and said which jobs it knows (the contract's reconcile). The server is the queue of record: a
   * job it thinks is on the machine that the agent lost failed ("the machine restarted"); one the agent runs that ended
   * here, or that this server never started, is told to stop. Then start what may start. `known` is null when the info
   * named no jobs at all (an agent from before MA1 whose block broke): nothing is lost on that.
   */
  reconcile(m: Machine, known: { id: number; state: string }[] | null, since: number) {
    const knows = new Map((known ?? []).map((k) => [k.id, k.state]));
    if (known)
      for (const j of this.store.machineJobs({ machine: m.id, states: ACTIVE }, 50)) {
        // One started on this connection may not be in the agent's list yet: only one from before it can be lost.
        if (knows.has(j.id) || (j.started_at ?? 0) >= since) continue;
        this.store.updateMachineJob(j.id, { state: 'failed', ended_at: this.now(), input_token_hash: null, error: 'the machine restarted' });
        this.ended(j.id, `Job #${j.id} (${j.kind_name}) on ${m.name} failed: the machine restarted and lost it.`);
      }
    for (const [id, state] of knows) {
      const j = this.store.getMachineJob(id);
      const ours = j && j.machine_id === m.id;
      if (!ours || !(ACTIVE as readonly string[]).includes(j.state)) {
        if (!(ENDED as readonly string[]).includes(state as JobState)) this.d.send(m.id, { type: 'job.stop', id });
        continue;
      }
      // A stop asked while it was offline (stopJob and the limit set error), or a pause: tell it again.
      if (j.error && !(ENDED as readonly string[]).includes(state as JobState)) this.d.send(m.id, { type: 'job.stop', id });
      else if (j.state === 'paused' && (state === 'running' || state === 'starting')) this.d.send(m.id, { type: 'job.pause', id });
      else if (j.state === 'running' && state === 'paused') this.sendResume(m.id, id);
    }
    this.pump(m.id);
    this.changedMachine(m.id);
  }

  /** The agent fetches one input file of a running job with its per-job token. */
  async input(m: Machine, req: IncomingMessage, res: ServerResponse, url: URL) {
    const id = Number(url.searchParams.get('job'));
    const job = Number.isInteger(id) ? this.store.getMachineJob(id) : undefined;
    if (!job || job.machine_id !== m.id) throw new HttpError(404, 'No such job on this machine');
    const given = String(req.headers['x-job-token'] ?? url.searchParams.get('token') ?? '');
    const expected = job.input_token_hash ? Buffer.from(job.input_token_hash, 'hex') : null;
    const got = Buffer.from(tokenHash(given), 'hex');
    if (!expected || !given || !timingSafeEqual(expected, got) || !(ACTIVE as readonly string[]).includes(job.state)) throw new HttpError(403, "Wrong input token, or the job isn't running");
    const name = url.searchParams.get('name') ?? '';
    const file = (JSON.parse(job.inputs) as { name: string; size: number; path: string }[]).find((f) => f.name === name);
    if (!file) throw new HttpError(404, `Job #${id} has no input called ${name}`);
    const st = await fs.stat(file.path).catch(() => null);
    if (!st?.isFile() || st.size !== file.size) throw new HttpError(410, `${name} changed or is gone since the job was queued`);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(st.size) });
    await pipeline(createReadStream(file.path), res);
  }

  /** One output file, streamed to disk under the job's results folder; refused past the job's or the scheme's cap. */
  async upload(m: Machine, req: IncomingMessage, url: URL): Promise<{ path: string; size: number }> {
    const id = Number(url.searchParams.get('job'));
    const job = Number.isInteger(id) ? this.store.getMachineJob(id) : undefined;
    if (!job || job.machine_id !== m.id) throw new HttpError(404, 'No such job on this machine');
    // The job's whole log (log=1) may also come once it has ended, kept as .job.log (no /out path starts with a dot) under its own small cap.
    const log = url.searchParams.get('log') === '1';
    const ok = log ? !['needs-go', 'queued', 'refused'].includes(job.state) && !job.swept_at : (['running', 'uploading', 'paused'] as string[]).includes(job.state);
    if (!ok) throw new HttpError(409, `Job #${id} is ${job.state}; results upload while it runs or uploads`);
    const rel = log ? '.job.log' : safeRelPath(url.searchParams.get('path') ?? '');
    const dir = this.d.resultsDir(job);
    if (!dir) throw new HttpError(410, "Nowhere to keep this job's results: whoever queued it is gone");
    const declared = Number(req.headers['content-length']);
    const room = () => (log ? JOB_CAPS.logBytes : Math.min(JOB_CAPS.jobBytes - this.store.getMachineJob(id)!.upload_bytes, JOB_CAPS.schemeBytes - this.store.jobResultBytes(job.project_id)));
    if (Number.isFinite(declared) && declared > room()) throw new HttpError(413, `Over the cap: a job keeps ${JOB_CAPS.jobBytes / 1024 ** 3} GB here and a scheme ${JOB_CAPS.schemeBytes / 1024 ** 3} GB; the file stays on the machine`);
    const dest = join(dir, rel);
    await fs.mkdir(dirname(dest), { recursive: true });
    const tmp = `${dest}.${randomBytes(4).toString('hex')}.part`;
    const limit = room();
    let size = 0;
    try {
      await pipeline(
        req,
        async function* (source: AsyncIterable<Buffer>) {
          for await (const chunk of source) {
            size += chunk.length;
            if (size > limit) throw new HttpError(413, `Over the cap: a job keeps ${JOB_CAPS.jobBytes / 1024 ** 3} GB here and a scheme ${JOB_CAPS.schemeBytes / 1024 ** 3} GB; the file stays on the machine`);
            yield chunk;
          }
        },
        createWriteStream(tmp, { flags: 'wx' }),
      );
      // A file sent again replaces its first copy, which no longer counts.
      const old = await fs.stat(dest).then(
        (s) => s.size,
        () => 0,
      );
      await fs.rename(tmp, dest);
      if (!log) this.store.updateMachineJob(id, { upload_bytes: this.store.getMachineJob(id)!.upload_bytes - old + size });
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    this.changed(id);
    return { path: rel, size };
  }

  /** Delete results older than 14 days from this server (the machine keeps its copy). */
  async sweep() {
    for (const j of this.store.machineJobs({ endedBefore: this.now() - JOB_CAPS.keepMs }, 500)) {
      const dir = this.d.resultsDir(j);
      if (dir) await fs.rm(dir, { recursive: true, force: true });
      this.store.updateMachineJob(j.id, { swept_at: this.now(), upload_bytes: 0 });
    }
  }
}

/** An output's path as the agent sends it, relative to /out: segments of safe names, no `..`, no absolute paths. */
export function safeRelPath(p: string): string {
  const parts = p
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s && s !== '.');
  if (!parts.length || parts.length > 20 || isAbsolute(p) || /^[A-Za-z]:/.test(p)) throw new HttpError(400, 'path must be a relative path inside /out');
  for (const s of parts) if (s === '..' || !/^[\w][\w .-]{0,199}$/.test(s) || s.endsWith('.part')) throw new HttpError(400, `path segment "${s.slice(0, 40)}" isn't allowed: letters, digits, spaces, dots, dashes and underscores`);
  return parts.join(sep);
}

/**
 * A job's input files: each path must resolve (symlinks too) inside one of `roots`. Returns them with size and
 * sha256; throws a 400 naming the first bad one, or a 413 over the input cap. Names must be distinct.
 */
export async function jobInputs(paths: unknown, roots: string[]): Promise<{ name: string; size: number; sha256: string; path: string }[]> {
  if (paths === undefined) return [];
  if (!Array.isArray(paths) || paths.length > JOB_CAPS.inputs) throw new HttpError(400, `inputs must be a list of at most ${JOB_CAPS.inputs} file paths`);
  const real = (await Promise.all(roots.map((r) => fs.realpath(r).catch(() => null)))).filter((r): r is string => !!r);
  if (!real.length) throw new HttpError(400, 'There is no folder to read inputs from');
  const out: { name: string; size: number; sha256: string; path: string }[] = [];
  let total = 0;
  for (const p of paths) {
    if (typeof p !== 'string' || !p || p.includes('\0')) throw new HttpError(400, 'Each input must be a file path');
    const abs = isAbsolute(p) ? p : join(real[0], p);
    const r = await fs.realpath(abs).catch(() => null);
    if (!r || !real.some((root) => r.startsWith(root + sep))) throw new HttpError(400, `${p} isn't a file inside ${real.length > 1 ? 'your worktree or shared folders' : "the app's data folder"}`);
    const st = await fs.stat(r);
    if (!st.isFile()) throw new HttpError(400, `${p} isn't a file`);
    total += st.size;
    if (total > JOB_CAPS.inputBytes) throw new HttpError(413, `A job's inputs are limited to ${JOB_CAPS.inputBytes / 1024 ** 3} GB`);
    const name = r.split(sep).pop()!;
    // The agent's own pattern (public/machine-agent.mjs JOB_FILE): a name it would refuse at start fails here, before the owner is asked.
    if (!/^[A-Za-z0-9_][A-Za-z0-9_ .-]{0,199}$/.test(name)) throw new HttpError(400, `${name}: an input's name may use letters, digits, spaces, dots, dashes and underscores only, and not start with a dot or dash`);
    if (out.some((o) => o.name === name)) throw new HttpError(400, `Two inputs are called ${name}; inputs land side by side in /in`);
    const hash = createHash('sha256');
    await pipeline(createReadStream(r), hash);
    out.push({ name, size: st.size, sha256: hash.digest('hex'), path: r });
  }
  return out;
}

/** The machines a scheme's minions may queue jobs on: granted to it, not a CI runner host, with a jobs block. */
export function jobMachinesFor(store: Store, projectId: number): string[] {
  return store
    .listMachines()
    .filter((m) => storedOffer(m) && !m.last_check?.includes('"runners":true') && store.machineGranted(m.id, projectId))
    .map((m) => m.name);
}
