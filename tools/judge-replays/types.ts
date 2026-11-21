// What every replay takes and gives back (#1503, tools/judge-replay.ts).

export interface ReplayCtx {
  /** The live database, opened read-only. */
  db: string;
  days: number;
  /** The scheme to replay, when the judge is per scheme; null for its default (every scheme, or Citadel's own). */
  scheme: number | null;
  now: number;
  /** A clone of the repo whose code the judge runs (this worktree), for git history. */
  repo: string;
}

/** One act: what the judge did (real) or would do now (a hit). `key` pairs a hit with the real act it matches. */
export interface Act {
  at: number;
  key: string;
  text: string;
}

export interface ReplayResult {
  /** What it read, in one line. */
  inputs: string;
  hits: Act[];
  real: Act[];
  /** What this replay can't see, said in the output every time. */
  limits: string[];
}
