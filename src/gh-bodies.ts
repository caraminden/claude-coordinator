/**
 * The fields Citadel reads from GitHub's REST answers (#1816: these replaced `any` bodies). Nothing here is checked at
 * runtime: GitHub may answer anything, so every field is optional and the code reading them keeps its own guards.
 */

/** A workflow run. */
export interface GhRun {
  id: number;
  name?: string | null;
  path?: string;
  workflow_id?: number;
  event?: string;
  head_branch?: string | null;
  head_sha?: string;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string;
  run_attempt?: number;
  run_started_at?: string;
  created_at: string;
  updated_at?: string;
}

/** One job of a run. */
export interface GhJob {
  id?: number;
  name: string;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
  labels?: string[];
  runner_name?: string | null;
  steps?: { name: string; number?: number; status?: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null }[];
}

export interface GhRunsBody {
  total_count?: number;
  workflow_runs?: GhRun[];
}

export interface GhJobsBody {
  total_count?: number;
  jobs?: GhJob[];
}

/** GitHub's error answer. */
export interface GhErrorBody {
  message?: string;
  errors?: { message?: string; field?: string; code?: string }[];
}
