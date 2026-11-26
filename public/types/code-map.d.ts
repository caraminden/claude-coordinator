// The code map.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

// Round 4: code-map.js (GET /api/projects/:id/code-counts: src/code-counts.ts CodeCounts.view)
/** One counted file (src/code-counts.ts CodeFile). */
export interface CodeFile {
  path: string;
  lines: number;
  changed: number;
  bugs: number;
  who: number[];
}

export interface CodeCountsAnswer {
  repo: boolean;
  /** The last good count; `error` says why the newest try failed, and `at` is 0 when none ever worked. */
  kept: { at: number; branch: string; commit: string; days: number; files: CodeFile[]; error?: string } | null;
  /** File path -> the open minions splitting it (src/code-counts.ts SplitBy). */
  splitting: Record<string, { number: number; title: string }[]>;
}
