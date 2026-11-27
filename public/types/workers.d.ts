// Workers: limits, the line, the flow, day strips and box capacity.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

// Round 4: workers.js (GET /api/workers: src/routes/workers.ts tile(), from src/turn-line.ts summary())
/** One limit Auto steers by (src/routes/workers.ts limitRows). */
export interface WorkerLimit {
  key: string;
  label: string;
  unit: string;
  lo: number;
  hi: number;
  value: number;
  default: number;
  by?: string;
  at?: number;
  share?: number;
}

export interface WorkersTile {
  used: number;
  lent: number;
  running: number;
  forced: number;
  lane: { used: number; size: number; moved: number };
  size: number;
  pool: { size: number; at: number; why?: string; fixed?: { size: number; by: string } };
  paused: { by: string; stop?: true; at: number } | null;
  waiting: number;
  people: { name: string; used: number; lane?: number; waiting: number; lent: number; stalled?: true }[];
  min: number;
  max: number;
  limits: WorkerLimit[];
  /** The waits that gave their worker back (src/routes/workers.ts waitsEnded). */
  waits: { count: number; median: number | null; woken: number; cold: number };
  /** The heavy jobs each place holds or has waiting (#2109, src/heavy-now.ts). */
  heavy: HeavyNow;
  /** The machines that lend workers (Build 7 T4), one row each. */
  machines: import('../machine-types.js').WorkerMachine[];
}

/** A heavy job on a place's row (src/heavy-now.ts HeavyNowJob). */
export interface HeavyNowJob {
  scheme: string;
  what: string;
  threads: number | null;
  waiting: string | null;
}

export interface HeavyNow {
  home: HeavyNowJob[];
  machines: { id: number; name: string; jobs: HeavyNowJob[] }[];
}

// Round 4b: work-flow.js and flowmath.js (GET /api/projects/:id/flow: src/work-flow.ts FlowView)
export type FlowKind = 'feature' | 'bug' | 'chore' | 'research' | 'other';

export type FlowPath = 'shipped' | 'untold' | 'refused' | 'other' | 'never';

export type FlowEnd = 'live' | 'late' | 'main' | 'build' | 'nothing' | 'why' | 'norepo' | 'answer' | 'open';

export interface FlowMinion {
  id: number;
  number: number;
  title: string;
  kind: FlowKind;
  path: FlowPath;
  end: FlowEnd;
  why: string | null;
  cost: number;
  refused: number;
  said: string;
}

export interface FlowView {
  from: number;
  to: number;
  minions: FlowMinion[];
  unread: number;
  repo: boolean;
  git: boolean;
  early: boolean;
  releases: boolean;
}

// Round 4b: day-strips.js (GET /api/projects/:id/day-strips: src/day-strips.ts)
export type StripPartName = 'work' | 'person' | 'line' | 'ci' | 'deploy' | 'other' | 'none';

export interface Strip {
  id: number;
  number: number | null;
  title: string;
  type: string | null;
  start: number;
  live: number;
  parts: { start: number; end: number; part: StripPartName }[];
  totals: Record<StripPartName, number>;
}

export interface DayStrips {
  day: string;
  from: number;
  to: number;
  strips: Strip[];
}

// Round 4b: box-capacity.js (GET /api/box-capacity: src/box-capacity.ts boxCapacity)
export interface BoxRow {
  count: number;
  typical: number | null;
  high: number | null;
  stalls: number;
  stallOf: number;
}

/** One reading: when, turns running, load, memory used (%), memory stall (%). */
export type BoxReadingRow = [at: number, turns: number, load: number, used: number, stall: number | null];

export interface BoxCapacity {
  cores: number;
  enough: number;
  stallPct: number;
  stallShare: number;
  readings: BoxReadingRow[];
  near: BoxRow[];
  bands: (BoxRow & { from: number; to: number | null })[];
  comfortable: { turns: number | null; past: number | null };
  waiting: { until: number; count: number };
}

// Round 4b: worker-line.js and worker-linemath.js (GET /api/line: src/routes/urgent.ts line)
/** A row of the line as any of its lists sends it, or as a press adds it: `ticket` is null for a minion in a scheme the person can't see. */
export interface LineRow {
  ticket: number | null;
  project?: number;
  number?: number;
  title?: string;
  person?: string | null;
  since?: number;
  waiting?: boolean;
  working?: boolean;
  urgent?: boolean;
  forced?: boolean;
  held?: string | null;
  first?: boolean;
  warm?: boolean;
  fresh?: boolean;
  quick?: boolean;
  after?: boolean;
  kind?: 'person' | 'taskmaster' | 'server';
  by?: string | null;
  reason?: string;
  at?: number;
  user?: number;
}

export interface LaneRow {
  ticket: number | null;
  project?: number;
  number?: number;
  title?: string;
  person: string | null;
  since: number;
  moved: boolean;
}

export interface LineData {
  forced: LineRow[];
  urgent: LineRow[];
  lane?: LaneRow[];
  line: LineRow[];
}

/** The Urgent group and everyone else, as worker-linemath.js lineGroups makes them. */
export interface LineGroups {
  urgent: LineRow[];
  rest: LineRow[];
}
