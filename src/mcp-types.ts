/** Shapes the MCP tools read from Citadel's own API answers and requests (#1799: these replaced any in src/mcp.ts). */
import type { CardLink } from './card-links.ts';
import type { WorkerWait } from './worker-wait.ts';

/** A minion as the API's views send it: the fields these tools read. */
export interface TicketView {
  id: number;
  number: number;
  worker_wait?: WorkerWait | null;
  title: string;
  properties?: Record<string, unknown>;
  build?: number | string | null;
  model?: string | null;
  effort?: string | null;
  workflow?: unknown;
  plugin_dirs?: string;
  status: string;
  state?: string;
  asleep?: { by: string } | null;
  queued?: number;
  closing?: boolean;
  note?: string;
  branch?: string;
  worktree?: string;
  cwd?: string;
  created_by: string;
  parent?: number | null;
  last_activity?: string;
  cost?: number;
  /** The running turn's estimated cost (#1913), not yet in `cost`; 0 with no turn running. */
  running_cost?: number;
  budget?: { usd: number; estimate: boolean; basis: string; ask: number; wake: number; card: number };
  open_cards?: CardLink[];
  notes?: string[];
}

/** A stored event: its data is a JSON string. */
export interface StoredEvent {
  kind: string;
  data: string;
  created_at: number;
}

export interface UltraBatch {
  for?: string;
  refused?: { name?: string; index: number; error: string }[];
  rows: { name: string; state: string; pr?: { number?: number; url?: string }; size: { lines: number; files: number }; error?: string }[];
}

export interface ArtifactRow {
  shared?: boolean;
  id?: number | string;
  title?: string;
  name?: string;
  display_path?: string;
  ticket_kind?: string;
  ticket_number?: number;
  pinned_at?: number | null;
  pinned_by?: string;
  missing?: boolean;
}

export interface ClaimView {
  name: string;
  minion?: number | null;
  holder_name: string;
  taken_by: string;
  since_text: string;
  note?: string | null;
  queue?: { number: number; state: string; after?: number }[] | null;
  done: number;
  total: number;
  estimate?: { left_ms: number; of: number };
}

export interface ToolDef {
  name: string;
  inputSchema: { properties: Record<string, { type?: unknown } | undefined> };
  _meta?: Record<string, unknown>;
}

export interface RpcRequest {
  id?: unknown;
  method?: string;
  params?: { protocolVersion?: string; name?: string; arguments?: Record<string, unknown> };
}

export interface CiFile {
  kind: string;
  name: string;
  size: number;
  workflow: string;
  run_id: number;
  run_attempt: number;
  sha: string;
  target?: string;
  published_to?: string;
  created_at: number;
  path: string;
  url: string;
}

export interface CiJob {
  op: string;
  machine: string;
  ok: boolean | null;
  count?: number;
  os?: string;
  by: string;
  text: string;
}

export interface QueuedJob {
  id: number;
  kind: { name: string };
  machine: string;
  state: string;
  waits?: string;
  paused_by?: string;
  error?: string;
  run_s: number;
  limit_s: number;
  gpu_busy_s: number;
  gpu_pct: number | null;
  vram_mb?: number;
  exit_code: number | null;
  outputs: { path: string; size: number; uploaded?: boolean; why?: string }[];
  upload_bytes?: number;
  log_tail?: string;
}

export interface PropertyValue {
  value: string;
  aliases: string[];
  status: string;
  reviewed?: boolean;
}

export interface PropertyKey {
  key: string;
  status: string;
  value_kind?: string;
  multi?: boolean;
  scope: string;
  description?: string;
  values: PropertyValue[];
}

/** The registry calls' answers: warnings, notes and the properties after the change. */
export interface RegistryReply {
  warnings?: string[];
  notes?: string[];
  properties?: Record<string, unknown>;
  status?: string;
}

/** A scheme's own fields, as GET and PATCH /api/projects/:id send them. */
export interface ProjectView {
  name: string;
  instructions?: string;
  instructions_updated_by?: string;
  approval_rules: string;
  plugin_dirs: string;
  optional_plugin_dirs: string;
  ci_quiet?: string;
  ci_watch?: string;
  default_effort?: string;
  ship_path: string;
  go_from: string;
  try_first: string;
  land_mode?: string;
  fable_ok?: string;
  builds: unknown;
  grill: unknown;
  gh_runners: unknown;
  shot_widths: unknown;
  shot_themes: unknown;
  shots_required?: boolean;
  shot_note?: string;
  onboarding?: unknown;
  onboarding_mode?: unknown;
  repo_url?: string;
}

export interface ErrorsDay {
  day: string;
  total: number;
  apps: { title: string; count: number }[];
  file: string;
}

export interface Counted {
  kind: string;
  count: number;
  last: number;
  why: string;
}

export interface ReviewEntry {
  slug: string;
  kind?: string;
  enabled?: boolean;
  kit?: boolean;
  file?: string;
  trial?: boolean;
  gate?: string;
  panel?: string;
  extends?: string;
  calibrated?: string;
  calibration?: string;
  rate?: number | null;
  when?: string;
  version?: number;
  name?: string;
  what?: string;
  body?: string;
  lessons?: Counted[];
  agent?: { text: string };
  updated_by?: string;
  text?: string;
}

/** A contraption turn in the audit (list_contraption_turns): the fields turnText reads. */
export interface AuditTurn {
  id: number;
  at: number;
  verdict?: string;
  verdict_reason?: string;
  contraption?: string;
  person?: string;
  model?: string;
  blind?: boolean;
  outcome?: string;
  system: string;
  prompt: string;
  output: string;
  images?: number;
}

export interface ShipLesson {
  id: number;
  number?: number | null;
  at: number;
  taken_at?: number | null;
  taken_note?: string;
  lines: string;
  files: string[];
}

/** A Claude event's data, as the stream-json line sends it. */
export interface EventData {
  author?: string;
  comment?: { about: string };
  text?: string;
  tool?: string;
  input?: unknown;
  state?: string;
  by?: string;
  via?: { scheme?: string; text: string; ticket?: number | null; to?: number | null; [k: string]: unknown };
  type?: string;
  replaced?: unknown;
  message?: { content?: { type?: string; text?: string }[] };
  parent_tool_use_id?: unknown;
  is_error?: boolean;
  [k: string]: unknown;
}
