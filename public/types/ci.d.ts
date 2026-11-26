// The CI page: runs, runners, test health, host load, numbers and the desktop PC.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

import type { TicketState } from '../types.js';

// Round 4: ci-health.js (GET api/projects/:id/test-health: src/routes/projects.ts, src/fast-mode.ts view, src/land-reds.ts)
export interface FastModeView {
  state: 'running' | 'pinning' | 'stuck' | 'verified' | 'idle';
  verified: string | null;
  stuck: string | null;
  running: { sha: string; at: number } | null;
  pin: { ids: string[]; at: number | null } | null;
  reds: { ids: string[]; sha: string; n: number | null; at: number; escalated: boolean; escalateAt: number }[];
}

export interface FlakeFix {
  state: string;
  minion: number | null;
  owner: string | null;
  startedAt: number;
  heldAt: number | null;
  cleanRuns: number;
  need: number;
  reopened: number;
}

export interface FlakeFile {
  file: string;
  count: number;
  last: number;
  ticketId: number | null;
  messages: { message: string; test: string; cls: string; count: number }[];
  none: number;
  before: number;
  changedAt: number | null;
  fix: FlakeFix | null;
  minion: number | null;
  lastMinion: number | null;
}

export type LandRedCause = 'change' | 'flaky' | 'main' | 'unknown';

export interface LandReds {
  since: number;
  runs: number;
  green: number;
  red: number;
  other: number;
  causes: Record<LandRedCause, number>;
  riders: number;
  reds: { id: number; branch: string; at: string; url: string | null; cause: LandRedCause; rider: boolean; why: string }[];
  partial: boolean;
}

export interface TestHealth {
  fast: FastModeView | null;
  flakes: FlakeFile[];
  landReds: LandReds | null;
  now: number;
  error?: undefined;
}

/** What a CI tab keeps when its read failed (ci.js). */
export interface ReadFailed {
  error: true;
}

// Round 4: ci-host.js (GET api/host-load: src/routes/machines.ts, src/host-load.ts HostLoad, src/ci-hold.ts heldRows, src/reaper.ts)
export type HostJobKind = 'turn' | 'deploy' | 'apk' | 'app';

export interface HostWaits {
  jobs: number;
  medianS: number;
  longestS: number;
}

export interface HostWeek extends HostWaits {
  scheme: string;
  parts?: (HostWaits & { label: string; kind: HostJobKind })[];
}

/** src/waits.ts HeavyJob, tagged with its scheme's name. */
export interface HostHeavyJob {
  who: string;
  what: string;
  since: number;
  reason?: string;
  slot?: number;
  scheme: string;
}

export type HostLongState = 'queued' | 'dispatched' | 'running' | 'done' | 'failed' | 'lost';

/** src/long-jobs.ts longView, tagged with its scheme's name (and the minion's number and scheme id when the viewer sees it). */
export interface HostLongJob {
  id: string;
  ticket: number;
  who: string;
  what: string;
  quiet: boolean;
  held: boolean;
  slug: string;
  state: HostLongState;
  since: number;
  queuedAt: number;
  url: string | null;
  code: number | null;
  why: string | null;
  scheme: string;
  number?: number;
  schemeId?: number;
}

export type HoldKind = 'proof' | 'heavy' | 'suite' | 'main' | 'check' | 'early';

/** src/ci-hold.ts heldRows: a held run with its minion and scheme. */
export interface HostHeldRun {
  kind: HoldKind;
  what: string;
  url: string;
  ticket: number | null;
  since: number;
  why: string;
  phase: 'stopping' | 'held' | 'resumed';
  number?: number;
  schemeId?: number;
  scheme?: string;
}

export interface HostHold {
  off: boolean;
  why: string | null;
  busy: string | null;
  running: { kind: HoldKind | 'ship'; what: string; url: string | null; ticket: number | null }[];
  held: HostHeldRun[];
  cap: string | null;
}

/** src/reaper.ts byMinion (MinionProcs). */
export interface HostMinion {
  ticket: number;
  number: number;
  title: string;
  scheme: string;
  schemeId: number;
  status: string;
  procs: { pid: number; command: string; cpuS: number; ageS: number }[];
}

/** src/reaper.ts reapedRows (Reaped plus its time and scheme name). */
export interface HostReaped {
  ticket: number;
  number: number;
  scheme: number;
  pid: number;
  command: string;
  cpuS: number;
  ageS: number;
  signal: 'TERM' | 'KILL';
  at: number;
  schemeName: string;
}

export interface HostLoad {
  slots: number;
  holders: HostHeavyJob[];
  waiters: HostHeavyJob[];
  pressure: number | null;
  maxPressure: number;
  loadWaitS: number;
  week: HostWeek[];
  long: HostLongJob[];
  now: number;
  minions?: HostMinion[];
  reaped?: HostReaped[];
  hold?: HostHold | null;
}

// Round 4: ci-numbers.js (GET api/projects/:id/ci-numbers: src/ci-numbers.ts CiNumbers.view)
export interface CiNumberStepRow {
  run_id: number;
  sha: string;
  at: number;
  baseline: number;
  level: number;
}

export interface CiNumberSeries {
  name: string;
  ref: string;
  unit: string;
  points: { value: number; sha: string; run_id: number; workflow: string; at: number }[];
  steps: CiNumberStepRow[];
}

export interface CiNumbersRules {
  held: number;
  base: number;
  pct: number;
  noise: number;
  keepDays: number;
}

export interface CiNumbersView {
  repo: string | null;
  series: CiNumberSeries[];
  rules: CiNumbersRules;
  error?: undefined;
}

// Round 4: ci-desktop.js (src/ci-load.ts PcView, Pool, Verdict; the CI page reads it from GET api/ci-load)
export interface CiPool {
  key: string;
  repo: string;
  title: string;
  project: number | null;
  labels: string;
  runners: string[];
  busy: number;
  waiting: number;
  oldest_ms: number;
  jobs: number;
  wait_p50_ms: number;
  wait_max_ms: number;
  cpu: number | null;
}

export type PcVerdictKind = 'none' | 'fine' | 'more' | 'over' | 'crash' | 'full';

/** [time, average CPU % or null, peak, jobs running, jobs waiting], in 5-minute steps over 24 hours. */
export type PcSample = [number, number | null, number | null, number, number];

export interface PcView {
  host: string;
  projects: number[];
  now: null | {
    at: number;
    cores: number;
    cpu: number;
    mem_total: number;
    mem_free: number;
    disk_total: number | null;
    disk_free: number | null;
    queue: number | null;
    idle_sec: number | null;
    temp: number | null;
    runners: number;
    wsl: number | null;
    vms: Record<string, number>;
  };
  series: PcSample[];
  restarts: number[];
  pools: CiPool[];
  verdict: { kind: PcVerdictKind; text: string; pool: string | null };
}

/** What trouble and pcWord read of a PC: a PcView, or the Status page's shorter copy (it sends `seen` in place of the series). */
export interface PcBrief {
  host: string;
  verdict: { kind: string };
  now: { cpu: number; mem_total: number; mem_free: number } | null;
  series?: PcSample[];
  seen?: boolean;
}

// Round 4: ci.js (GET api/ci: src/routes/machines.ts, src/ci-health.ts snapshot, src/ci-view.ts CiView, src/ci-problems.ts Problem)
/** Whose change a run or job tests: a minion's chat (`href`), or what the run is. */
export interface CiWho {
  href?: string;
  label: string;
}

/** src/ci-view.ts ViewRun, with the `who` snapshot adds. */
export interface CiRun {
  id: number;
  name: string;
  branch: string;
  event?: string;
  status: string;
  conclusion: string | null;
  at: string;
  url: string;
  minion?: number | null;
  who?: CiWho;
}

export interface CiRunner {
  name: string;
  status: string;
  busy: boolean;
  labels: string[];
  job: string | null;
  offlineSince: number | null;
}

export interface CiWaitingJob {
  name: string;
  labels: string[];
  since: string;
  run: number;
  branch?: string;
  event?: string;
  minion?: number | null;
  who?: CiWho;
}

export interface CiRunningJob {
  name: string;
  runner: string;
  since: string;
  run: number;
  branch?: string;
  event?: string;
  minion?: number | null;
  who?: CiWho;
}

export interface CiQueue {
  labels: string[];
  jobs: number;
  runners: number | null;
}

export interface CiWorkflow {
  name: string;
  file: string;
  verdict: CiRun | null;
  skipped: string[];
  quiet?: boolean;
}

export interface CiViewData {
  at: number;
  slug: string;
  branch: string;
  runners: CiRunner[] | null;
  waiting: CiWaitingJob[];
  running?: CiRunningJob[];
  queues?: CiQueue[];
  workflows: CiWorkflow[];
  runs: CiRun[];
}

/** The fix minion as the minions list draws it (src/routes/machines.ts fixTicket); the page's own stand-in has fewer fields. */
export interface CiFixTicket {
  id?: number;
  number?: number | string;
  project_id: number;
  title: string;
  status: string;
  state?: TicketState | null;
  note?: string | null;
  last_activity?: string | null;
  created_at: number;
  updated_at?: number;
  closed_at?: number | null;
}

/** src/ci-problems.ts Problem, as GET api/ci sends it. */
export interface CiProblem {
  key: string;
  title: string;
  why?: string;
  fix?: string;
  quiet?: boolean;
  held?: number;
  since?: number;
  fixMinion?: { number: number; closed: boolean };
  noFix?: { ringsAt: number; late: boolean };
  rerun?: { sha: string; url?: string; state: 'running' | 'failed' | 'manual' };
  fixTicket?: CiFixTicket;
  link?: { kind: 'minion' | 'taskmaster'; href: string; label: string; closed?: boolean };
}

export interface CiScheme {
  id: number;
  name: string;
  view: CiViewData;
  problems: CiProblem[];
}

export interface CiRead {
  schemes: CiScheme[];
  pcs: PcView[];
  now: number;
}
