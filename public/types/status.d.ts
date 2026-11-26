// The Status page.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

// Round 4: status.js (the /api/status answer: src/status-page.ts StatusData, and the shapes it holds)
export type StatusTone = 'ok' | 'warn' | 'bad';

/** src/status-page.ts Verdict. */
export interface StatusVerdict {
  tone: StatusTone;
  reasons: string[];
  tiles: string[];
}

/** src/status-page.ts Look. */
export interface StatusLook {
  sentAt: number | null;
  by: string | null;
  minion: { project: number; number: number; title: string; closed: boolean } | null;
}

/** src/ship-time.ts ShipTarget and ShipRow. */
export interface StatusShipTarget {
  key: string;
  title: string;
  scheme: number | null;
  counts: number[];
  median: (number | null)[];
  p90: (number | null)[];
  ships: { at: number; took: number; stages: Record<string, number>; label: string }[];
}

/** src/db-rows.ts HostSample, the fields the page reads. */
export interface StatusHostSample {
  at: number;
  mem_total: number;
  mem_avail: number;
  disk_total: number;
  disk_free: number;
  load1: number;
  rss: number;
  cpu_psi?: number | null;
  mem_psi?: number | null;
  db_cached?: number | null;
  db_size?: number | null;
  kswapd_rate?: number | null;
  refault_rate?: number | null;
  server_refault_rate?: number | null;
  pgpgin_rate?: number | null;
  thp_fallback_rate?: number | null;
  warm_ms?: number | null;
  warm_mb?: number | null;
  warm_backoffs?: number | null;
}

/** src/cpu-ledger.ts CpuRow, CpuWindow and CpuHour. */
export interface StatusCpuRow {
  key: string;
  label: string;
  cores: number;
  kernel: number;
}

export interface StatusCpuWindow {
  rows: StatusCpuRow[];
  host: { busy: number; kernel: number; iowait: number; started: number } | null;
}

/** src/memory-storms.ts Storm. */
export interface StatusStorm {
  group: string;
  seconds: number;
  stalled: number;
  limit: number | null;
  unit: string | null;
  unitBytes: number | null;
}

/** src/memory-ease.ts EaseWaiting. */
export interface StatusEaseWaiting {
  starts: number;
  heavy: number;
  nested: number;
}

/** src/memory-ease.ts Episode and EaseNow, with the held turns' minion named (CitadelStatus.easing). */
export interface StatusEaseHeld {
  minion: string | null;
  bytes: number;
}

export interface StatusEaseEpisode {
  since: number;
  until: number | null;
  peak: 'ok' | 'easing' | 'tight';
  why: string;
  lowestFree: number | null;
  waited: StatusEaseWaiting;
  slowed: StatusEaseHeld[];
}

export interface StatusEaseNow {
  level: 'ok' | 'easing' | 'tight';
  since: number;
  at: number | null;
  why: string;
  free: number | null;
  reclaim: number | null;
  swapOut: number | null;
  load1: number;
  waiting: StatusEaseWaiting;
  slowed: StatusEaseHeld[];
}

/** src/every.ts JobRow, with the flags CitadelStatus adds. */
export interface StatusJob {
  name: string;
  ms: number;
  fails: number;
  last: number | null;
  took: number | null;
  error: string | null;
  errorAt: number | null;
  overdue: boolean;
  slow: boolean;
}

/** src/standing-checks.ts StandingStatus. */
export interface StatusChecks {
  checks: { name: string; promise: string }[];
  last: { ranAt: number; findings: { check: string; text: string; since: number }[]; error: string | null } | null;
}

/** src/answer-time.ts and StatusPage.answerData. */
export interface StatusAnswer {
  /** [time, p50, p95, p99, max, over, load, turns] */
  rows: [number, ...number[]][];
  latest: { at: number; p95: number; p99: number; max: number } | null;
  now: number | null;
  reader: number | null;
  probing: boolean;
  line: { p95: number; p99: number };
  target: { p95: number; p99: number; max: number; load: number; turns: number };
  alert: boolean;
}

/** src/db/slow-moments.ts SlowMoment, as slowView sends it. */
export interface StatusSlowMoment {
  at: number;
  person: string;
  device: string;
  kind: string;
  what: string;
  page: string;
  scheme: string | null;
  total_ms: number;
  server_ms: number | null;
  network_ms: number;
  tab_ms: number;
}

/** src/status-page.ts CitadelStatus. */
export interface StatusCitadel {
  verdict: StatusVerdict;
  looks: Record<string, StatusLook>;
  canInvestigate: boolean;
  uptime: { bootAt: number; reason: string | null; restarts: number[] };
  stalls: { counts: number[]; afterBoot: number[]; longest: number[]; last: { at: number; seconds: number | null; cause: string | null; work: string | null; afterBoot: boolean } | null };
  host: {
    answer: StatusAnswer;
    /** Hourly [time, memory used %, disk used %, highest load, highest CPU pressure %, memory pressure %]. */
    series: [number, number, number, number, number | null, number | null][];
    /** Hourly [time, least % of the database in memory, highest discard MB/s, highest re-read MB/s]. */
    cache: [number, number, number, number][];
    latest: StatusHostSample | null;
    cores: number;
    cpuWarn: number;
    cpuWarnMin: number;
    peak: { at: number; load1: number } | null;
    cpu: { windows: { hour: StatusCpuWindow; day: StatusCpuWindow; week: StatusCpuWindow }; hours: { at: number; seconds: number; groups: Record<string, number> }[]; groups: { key: string; label: string }[] };
  };
  storms: { counts: number[]; stalled: number[]; last: (StatusStorm & { at: number }) | null; now: StatusStorm[] };
  easing: { counts: number[]; minutes: number[]; last: StatusEaseEpisode | null; now: StatusEaseNow | null };
  jobs: StatusJob[];
  checks: StatusChecks | null;
  ships: { counts: number[]; median: (number | null)[]; last: { at: number; version: string; changes: string[] } | null };
  ciVisible: boolean;
  ci: { tone: StatusTone; at: number; url: string; workflows: { name: string; conclusion: string | null; status: string | null; url: string | null }[]; runs: number; green: number } | null;
  unitsFailed: boolean;
  units: { unit: string; load: string; active: string; sub: string }[];
  /** src/ci-load.ts PcView, the fields pcWord (ci-desktop.js) and this page read. */
  desktops: { host: string; verdict: { kind: string }; now: { cpu: number; mem_total: number; mem_free: number } | null }[];
  backup: { db: { at: number; size: number } | null; pulledAt: number | null; apps: { title: string; day: string | null; ok: boolean }[]; problems: string[] };
  slots: { key: string; title: string; note: string }[];
  slow: { count: number; longest: number; rows: StatusSlowMoment[] };
}

/** src/status-page.ts AppStatus. */
export interface StatusApp {
  name: string;
  title: string;
  scheme: number | null;
  verdict: StatusVerdict;
  looks: Record<string, StatusLook>;
  service: { unit: string; active: string; installed: boolean } | null;
  deploys: { tone: StatusTone; counts: number[]; failed: number[]; median: number | null; longest: number | null; last: { at: number; outcome: string; by: string; took: number | null } | null };
  errors: { counts: number[]; kinds: Record<string, number>; top: { kind: string; count: number; sample: string; last_at: number }[]; lastDay: number };
  turns: { counts: number[]; tokens: number[]; people: { name: string; turns: number }[] };
  disk: { bytes: number | null; at: number; warn_gb: number | null } | null;
  backup: { day: string | null; ok: boolean };
}

/** src/status-page.ts StatusData. */
export interface StatusData {
  now: number;
  days: string[];
  shipTimes: StatusShipTarget[];
  citadel: StatusCitadel;
  apps: StatusApp[];
}

/** One line of /api/ship-lines (src/ship-stop.ts shipLines, ShipRow). */
export interface StatusShipLine {
  projectId: number;
  scheme: string;
  rows: { seq: number; name: string; ticketId: number | null; holds: boolean; place: string; heldSince: number | null; since: number; text: string; noStop: string | null }[];
}
