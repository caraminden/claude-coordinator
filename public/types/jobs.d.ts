// The Jobs page.
// Part of the page's shapes: the rules and the shared core are in ../types.d.ts.

// Round 4: jobs.js (GPU jobs on a person's machine: src/machine-jobs.ts jobView, JobKind and JobSettings)
export type JobState = 'needs-go' | 'queued' | 'starting' | 'running' | 'paused' | 'uploading' | 'done' | 'failed' | 'stopped' | 'refused';

/** A job's recipe (src/machine-jobs.ts JobKind, as jobView sends it, and a go card's recipe). */
export interface JobKindView {
  name: string;
  image: string;
  command: string[];
  reads: string[];
  gpu: boolean;
  network: boolean;
  resumable: boolean;
}

/** A job's public fields (src/machine-jobs.ts JobView). */
export interface JobView {
  id: number;
  machine_id: number;
  machine: string | null;
  project_id: number;
  ticket_id: number | null;
  ticket_number: number | null;
  asked_by: string;
  decider_id: number | null;
  kind: JobKindView;
  inputs: { name: string; size: number }[];
  limit_s: number;
  when: 'hours' | 'now';
  reason: string | null;
  state: JobState;
  waits: string | null;
  go: 'hours' | 'now' | 'always' | 'standing' | null;
  go_by: string | null;
  paused_by: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  run_s: number;
  gpu_busy_s: number;
  gpu_pct: number | null;
  vram_mb: number | null;
  held_vram_mb: number | null;
  log_tail: string;
  live_at: number | null;
  exit_code: number | null;
  error: string | null;
  pause_failed: string | null;
  outputs: { path: string; size: number; uploaded: boolean }[];
  swept: boolean;
}

/** A machine's job hours, one-off window and pause (src/machine-jobs.ts JobSettings). */
export interface JobSettings {
  start: string;
  end: string;
  until: number | null;
  paused: boolean;
}
