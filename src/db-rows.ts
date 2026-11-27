// The database's row types, and the option lists and limits that go with them: what a minion, scheme, person or turn row holds.
// src/db.ts re-exports all of it, so callers import from there.
import type { ModelUsage, TokenUsage } from './claude-events.ts';
import type { PromptHashes } from './prompt-hashes.ts';

export type TicketStatus = 'new' | 'running' | 'idle' | 'error' | 'closed';
/** Each project has one long-lived coordinator ticket that manages the others. */
export type TicketKind = 'ticket' | 'coordinator';

/** A row of the releases table (#625); changes and stages are JSON. */
/** One reading of perigee's memory, disk (the data folder's) and load, and the server's own resident memory, in bytes (#1123). */
export interface HostSample {
  at: number;
  mem_total: number;
  mem_avail: number;
  disk_total: number;
  disk_free: number;
  load1: number;
  rss: number;
  /** CPU and memory pressure ("some avg60", whole percent) at the reading; null before #1301 or without PSI. */
  cpu_psi?: number | null;
  mem_psi?: number | null;
  /** IO pressure the same way, and swap in use in bytes (#1325); null before it or where it can't be read. */
  io_psi?: number | null;
  swap_used?: number | null;
  /** Cumulative CPU by source and the host's counters as JSON (#1332, src/cpu-ledger.ts); null before it or when unreadable. */
  cpu_ledger?: string | null;
  /** One window of answer times and the main thread's split as JSON (#1559, src/answer-time.ts); null before it or without a probe. */
  answer_time?: string | null;
  /** File-cache health (#1501, src/cache-health.ts): the database's bytes in memory and its size, then per-second rates; null before it or when unreadable. */
  db_cached?: number | null;
  db_size?: number | null;
  kswapd_rate?: number | null;
  refault_rate?: number | null;
  server_refault_rate?: number | null;
  pgpgin_rate?: number | null;
  thp_fallback_rate?: number | null;
  /** The database warmer's last pass (#1560, src/db-warmer.ts): ms, MB read, and its backoffs since the server started; null before it or with it off. */
  warm_ms?: number | null;
  warm_mb?: number | null;
  warm_backoffs?: number | null;
  /** The growth alarm's readings (#1762, src/growth-alarm.ts): the server's open fds, running citadel-supervisor-* units, bytes used on /tmp, and each app server's memory as JSON; null before it or where unreadable. */
  open_fds?: number | null;
  supervisors?: number | null;
  tmp_used?: number | null;
  app_mem?: string | null;
}

export interface ReleaseRow {
  id: number;
  project_id: number;
  target: string;
  version: string;
  changes: string;
  started_at: number | null;
  live_at: number | null;
  outcome: string;
  stages: string;
}

/** A row of the contraption_deploys table (#627); stages and changes are JSON. */
export interface ContraptionDeployRow {
  id: number;
  name: string;
  from_sha: string | null;
  to_sha: string | null;
  by: string;
  started_at: number;
  finished_at: number | null;
  outcome: string;
  stages: string;
  changes: string;
}

export interface Project {
  id: number;
  name: string;
  repo_url: string | null;
  repo_dir: string | null;
  /** Standing rules every turn in the project gets, coordinator included; '' for none. */
  instructions: string;
  instructions_updated_by: string | null;
  instructions_updated_at: number | null;
  /** Claude Code permission rules, one per line, that make a thread ask people first; '' for none. */
  approval_rules: string;
  /** Folders in the repo, one per line, that each thread loads as Claude Code plugins; '' for none. */
  plugin_dirs: string;
  /** Plugin folders, one per line, that only a minion that picks them loads (#361; tickets.plugin_dirs); '' for none. */
  optional_plugin_dirs: string;
  /** Effort for turns of minions (and a Taskmaster) with none of their own; '' leaves it to Claude Code. */
  default_effort: string;
  /** The minions list's promoted groups (#253): a JSON list of "key: value" of the scheme's own keys, shown above the types. */
  list_groups: string;
  /** Workflow files, one per line, whose red scheduled or dispatched runs don't tell the Taskmaster (#678, src/ci-health.ts); '' for none. */
  ci_quiet: string;
  /** Workflow files, one per line, whose first red run on main in a streak wakes the Taskmaster (#774, src/ci-health.ts); '' for none. */
  ci_watch: string;
  /** How its lands go (#1017, src/fast-mode.ts): off, the full gate; fast, a low or medium risk land lands on the smoke check and the full suite runs behind it. */
  land_mode: LandMode;
  /** Whether Fable may be used for this scheme's sessions and Grunts (#1045): on, the model table as it stands; off, the table and the prompt drop it. */
  fable_ok: FableOk;
  /** Whether its Taskmaster may suggest numbered builds (#1045): suggest, as before; off, the builds line is left out. */
  builds: BuildsMode;
  /** Grilling before code (#1045): design, the Citadel-wide rule as written; all, every feature; never, none. */
  grill: GrillMode;
  /** CI on GitHub's own runners (#1045; free on a public repo, may cost Actions minutes on a private one or larger runners): ask a person first, ok to use, or never. */
  gh_runners: GhRunnersMode;
  /** Screenshot widths in px, comma-separated, for a minion's UI checks (#1044); ui-shot's default. */
  shot_widths: string;
  /** Themes shot, comma-separated, light and/or dark (#1044). */
  shot_themes: string;
  /** 1 when a UI change's ready note must carry its shots (#1044). */
  shots_required: number;
  /** Free text added to the screenshot line of the prompt, e.g. "1x in her window" (#1044). */
  shot_note: string;
  /** How a change ships (#1043, public/shipping.js): citadel (hand_off_land runs tools/land.sh), pr-auto, pr-minion (the minion merges once CI is green: repos GitHub won't auto-merge, #1569) or pr-person. */
  ship_path: ShipPath;
  /** From which risk label a change waits for a person's go: never, high, medium or all; pr-person is always all. */
  go_from: GoFrom;
  /** What waits for a person to try it before it ships: never, ui (front-end changes) or features. */
  try_first: TryFirst;
  /** Message settings (#1059, src/msg-settings.ts): loop guard count and window (minutes), cold after (minutes), cold hold at most (hours). */
  msg_loop_limit: number;
  msg_loop_min: number;
  msg_cold_min: number;
  msg_hold_h: number;
  /** Kinds of held mail this scheme never holds (#1067), comma-separated: src/msg-settings.ts neverHold. */
  msg_never_hold: string;
  /** 1 while the members' pass on Minion rules after setup is open (#1046): onboarding done sets it, "Looks right" clears it. */
  rules_review: number;
  /** Kit skills this scheme turned off on its Skills page (#1062), space-separated folder names under kit/skills ('' = every kit skill on, the default). */
  skills_off: string;
  /** Where its setup stands (#172): the Taskmaster gets its onboarding prompt section until it is done or skipped. */
  onboarding: Onboarding;
  /** first-run for a new scheme, tune-up for a re-run on an existing one. */
  onboarding_mode: OnboardingMode;
  /** Why a new scheme's GitHub repo wasn't created (#173), for the Retry strip; null when it was, or for other sources. */
  github_error: string | null;
  /** The person who owns it (users.id): they add members and change its settings. Null only before the first start migrates it. */
  owner_id: number | null;
  created_at: number;
}

/** A job on a person's own machine (#857, src/machine-jobs.ts). JSON columns are text. */
export interface MachineJob {
  id: number;
  machine_id: number;
  project_id: number;
  /** The minion that queued it, or null for a contraption's. */
  ticket_id: number | null;
  contraption_id: number | null;
  /** Who asked, as people read it: "#857 GPU jobs" or a contraption's name. */
  asked_by: string;
  kind_name: string;
  /** The recipe as sent (src/machine-jobs.ts JobKind), JSON. */
  kind: string;
  kind_hash: string;
  /** [{ name, size, sha256, path }] as JSON; path is where on this server the agent's fetch reads it. */
  inputs: string;
  limit_s: number;
  run_when: 'hours' | 'now';
  reason: string;
  state: string;
  /** 'builds': a build job (H2), whose go is its machine's Builds role switch. */
  go: 'hours' | 'now' | 'always' | 'standing' | 'builds' | null;
  go_by: string | null;
  /** Why it is paused: 'owner' (a person's click), 'hours' (job hours ended) or 'machine' (the whole-machine Pause). */
  paused_by: string | null;
  /** Its go card as JSON { ticket, question }, while one is out. */
  card: string | null;
  input_token_hash: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  run_s: number;
  /** Running time the server counted from the agent's reports, for the limit in case the agent's own count is off. */
  server_run_s: number;
  gpu_busy_s: number;
  /** The agent's last report's live fields (gpu_pct, vram_mb, held_vram_mb, log_tail) as JSON. */
  live: string | null;
  live_at: number | null;
  exit_code: number | null;
  error: string | null;
  /** [{ path, size, uploaded }] as JSON. */
  outputs: string;
  upload_bytes: number;
  swept_at: number | null;
  /** Why its last pause didn't take, while it runs on (2MA1); null once it paused or ended. Never `error`, which on an active job means a stop was asked. */
  pause_failed: string | null;
}

/** One number a CI run sent (#1369, src/ci-numbers.ts). */
export interface CiNumber {
  id: number;
  project_id: number;
  name: string;
  value: number;
  unit: string;
  workflow: string;
  run_id: number;
  run_attempt: number;
  sha: string;
  ref: string;
  created_at: number;
}

/** A step up that held (#1369): its first run, the level before and after. */
export interface CiNumberStep {
  id: number;
  project_id: number;
  name: string;
  ref: string;
  run_id: number;
  sha: string;
  created_at: number;
  baseline: number;
  level: number;
  flagged_at: number;
}

/** A file in the CI store (#658, src/ci-store.ts). */
export interface CiFile {
  id: number;
  project_id: number;
  /** The workflow's file name, "android.yml". */
  workflow: string;
  run_id: number;
  run_attempt: number;
  sha: string;
  ref: string;
  name: string;
  kind: string;
  /** What the rules group by beside the workflow, '' for a workflow with one. */
  target: string;
  size: number;
  sha256: string;
  created_at: number;
  published_to: string | null;
  published_at: number | null;
}

/** A person who signs in. `name` is what their messages are signed with. */
export interface User {
  id: number;
  name: string;
  login: string;
  /** scrypt hash (see auth.ts); null until they set a password through an invite link. */
  password_hash: string | null;
  admin: number;
  /** 1 when their turns may run on the server's own Claude login (Cara's own logins only: plans are per person). */
  server_login: number;
  /** sha256 of the one-time set-password link's token, while one is open. */
  invite_hash: string | null;
  invite_expires: number | null;
  /** Set when an admin disabled them: no sign-in, and their cookies stop working. */
  disabled_at: number | null;
  created_at: number;
}

export const ONBOARDING = ['interview', 'planned', 'setting-up', 'done', 'skipped'] as const;
export type Onboarding = (typeof ONBOARDING)[number];
export const ONBOARDING_MODES = ['first-run', 'tune-up'] as const;
export type OnboardingMode = (typeof ONBOARDING_MODES)[number];
/** A scheme's land modes (#1017): Settings shows them as a toggle. */
export const LAND_MODES = ['off', 'fast'] as const;
export type LandMode = (typeof LAND_MODES)[number];
/** The four Minion rules switches (#1045); the first value of each is today's behaviour. */
export const FABLE_OKS = ['on', 'off'] as const;
export type FableOk = (typeof FABLE_OKS)[number];
export const BUILDS_MODES = ['suggest', 'off'] as const;
export type BuildsMode = (typeof BUILDS_MODES)[number];
export const GRILL_MODES = ['design', 'all', 'never'] as const;
export type GrillMode = (typeof GRILL_MODES)[number];
export const GH_RUNNERS_MODES = ['ask', 'ok', 'never'] as const;
export type GhRunnersMode = (typeof GH_RUNNERS_MODES)[number];
/** A scheme's Shipping settings (#1043): their values and labels are public/shipping.js's, shared with the page. */
export type ShipPath = 'citadel' | 'pr-auto' | 'pr-minion' | 'pr-person';
export type GoFrom = 'never' | 'high' | 'medium' | 'all';
export type TryFirst = 'never' | 'ui' | 'features';

/** Whether a scheme is still being set up, which is what gives its Taskmaster the onboarding section. */
export const onboardingOpen = (p: Pick<Project, 'onboarding'>) => p.onboarding !== 'done' && p.onboarding !== 'skipped';

/** Longest Citadel-wide or scheme instructions the app accepts. Every turn of every minion pays for every character, so the cap keeps the text lean; it is ours, not Claude Code's (which only warns on size). */
export const MAX_INSTRUCTIONS = 32_000;
export const MAX_PERSONAL_INSTRUCTIONS = 4_000;
/** A person's own instructions as a minion they own loads them: for everywhere, then for its scheme ('' for none). */
export type PersonalLayer = { name: string; everywhere: string; scheme: string };

export interface AppInstructions {
  text: string;
  by: string | null;
  at: number | null;
}

/** Models a thread can be set to (null = Claude Code's default), and effort levels for `claude --effort`. */
// Codex's (#337) run in the person's own container, signed in to Codex (src/codex.ts CODEX_MODELS).
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-sonnet-5-5+opus-advisor', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-fable-5-2', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** ready: done, ready to merge or pick up · try: ready for people to try · sealed: on hold on purpose ·
 * blocked: stuck on something outside the thread · outside: work still running elsewhere (CI, someone's machine) ·
 * pending-deploy: deployed, not live yet; outlasts a new turn, and a successful deploy dismisses the thread ·
 * limited: the last turn hit the account's usage limit (set by the server, not the thread). */
export const TICKET_STATES = ['ready', 'complete', 'try', 'parked', 'blocked', 'outside', 'pending-deploy', 'limited'] as const;
export type TicketState = (typeof TICKET_STATES)[number];

/** A fix of a flaky test file (#1120). */
export interface FlakeFix {
  id: number;
  project_id: number;
  file: string;
  ticket_id: number | null;
  state: 'open' | 'held';
  started_at: number;
  clean_runs: number;
  held_at: number | null;
  reopened: number;
  proof_run: number | null;
}

export interface Ticket {
  id: number;
  project_id: number;
  number: number | null; // shown as #n; counts up per project, null for the coordinator
  state: TicketState | null; // set by the thread at the end of a turn; cleared when the next turn starts
  note: string | null; // the thread's own one-line status, ≤ 60 chars
  /** One-tap replies the thread offers at the end of a turn, as a JSON array of strings; cleared when anyone writes or the next turn starts. */
  replies: string | null;
  build: number | null; // the major build it is assigned to; the threads list groups by it
  parent: number | null; // the #N of the minion it was started for (#273), in the same scheme; it inherits that one's build
  kind: TicketKind;
  title: string;
  status: TicketStatus;
  session_id: string | null;
  cwd: string;
  branch: string | null;
  permission_mode: string;
  /** Chosen for this thread; null uses Claude Code's default. */
  model: string | null;
  effort: string | null;
  /** What Claude Code's defaults came out as on this thread's latest turn without a choice. */
  last_model: string | null;
  last_effort: string | null;
  /** Why it runs on its model and effort (#1061), a line like "bug → Sonnet 5.5 medium"; null for a minion from before. */
  picked_because: string | null;
  /** 1: its turns may call Claude Code's Workflow tool (#359), off by default as it costs ~2k tokens a call. */
  workflow: number;
  /** Its picks from the scheme's optional plugin folders (#361), one per line; '' for none. */
  plugin_dirs: string;
  last_activity: string | null;
  /** When it was dismissed (ms), set on dismiss and cleared on reopen (#1072); null while open, and for one dismissed before this was kept whose close note can't be found. */
  closed_at: number | null;
  /** Whose turn it last ran (users.id; src/access.ts turnPerson): set when a minion is made, then at each turn's start. */
  person_id: number | null;
  /** A Taskmaster's person (#919): users.id of whose own it is; NULL for the Overlord, which before a scheme's split is its only Taskmaster. */
  coordinator_of: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}
/** What a tickets row and a view of one (Runner.view, whose replies are parsed) share. */
export type TicketFields = Omit<Ticket, 'replies'>;

/** A row of repo_collaborators: see its CREATE TABLE. */
export interface RepoCollaborator {
  project_id: number;
  user_id: number;
  slug: string;
  login: string | null;
  state: 'added' | 'invited' | 'existing' | 'waiting' | 'failed';
  invitation_id: number | null;
  error: string | null;
  updated_at: number;
}

/** A saved secret (src/secrets.ts); `value` is still encrypted. */
export interface SecretRow {
  scope: 'person' | 'scheme';
  owner_id: number;
  name: string;
  value: string;
  updated_by: number | null;
  created_at: number;
  updated_at: number;
}

/** One of a person's linked accounts (src/credentials.ts); `secret` is still encrypted. */
export type OpenrouterCallKind = 'image' | 'effect' | 'music' | 'speech' | 'text';

export interface CredentialRow {
  user_id: number;
  kind: string;
  secret: string;
  meta: string;
  created_at: number;
  updated_at: number;
  failed_at: number | null;
}

export interface Artifact {
  id: number;
  project_id: number;
  ticket_id: number;
  path: string;
  size: number;
  mtime: number;
  created_at: number;
  pinned_at: number | null;
  pinned_by: string | null;
  /** A pinned file that has since disappeared; kept so the pin isn't silently lost. */
  missing: number;
}

/** One key an HTML page saved through the artifact bridge; `value` is JSON text. */
export interface ArtifactDatum {
  key: string;
  value: string;
  by: string;
  at: number;
}

export interface SharedPin {
  path: string;
  pinned_at: number;
  pinned_by: string;
}

/** A file of Claude Code session state, gzipped; `path` is relative to the Claude config dir. */
export interface ClaudeStateRow {
  path: string;
  project_id: number;
  /** Null for state the whole project shares (auto-memory). */
  ticket_id: number | null;
  size: number;
  mtime: number;
  data?: Uint8Array;
}

/** Someone's own computer, which connects out to the app and lends threads its MCP tools. */
export interface Machine {
  id: number;
  /** Also the MCP server name threads see, so its tools are mcp__<name>__*. */
  name: string;
  token_hash: string;
  /** The token sealed under SESSION_SECRET (#1355), for its owner's Show; null for one linked before that, until a relink. */
  token_sealed?: string | null;
  created_by: string;
  created_at: number;
  /** When its agent last connected or disconnected; null if it never has. */
  last_seen_at: number | null;
  /** What threads should know when using it ("never restart it", where the clone is); '' for none. */
  notes: string;
  /** 1 when minions get the workspace tools its agent offers (git sync, its owner's tasks); off until a person turns it on. */
  workspace_tools: number;
  /** Not read for lending since #438: every machine is lent to the schemes in machine_projects. Kept at 1 for an older release (a rollback); CI runner hosts from before #438 are still told apart by it (ci-runner.ts, public/settings.js). */
  scoped: number;
  /** The person who added it and manages it (#306); null for one from before, which admins manage. */
  owner_id: number | null;
  /** What its setup lines run (#308): 'claude' (a Claude Code MCP server named mcp_command), 'command' or 'none'; null for one added before. */
  mcp_kind: 'claude' | 'command' | 'none' | null;
  mcp_command: string;
  /** 1 (the default) when it should stay connected, so offline is Down; 0 for a laptop that comes and goes (Asleep) (#437). */
  always_on: number;
  /** Its last check as JSON (src/machines.ts StoredCheck), kept through restarts (#437); null before its first. */
  last_check: string | null;
  /** What its agent last said the PC can do (Build 7 M2, src/machine-join.ts MachineReport), as JSON; null before one that reports. */
  report?: string | null;
  /** Its owner's order among their machines for work (Build 7 M6; 1 first); null: no order, today's placement. */
  priority?: number | null;
  /** What a person ticked for it to lend, as JSON (src/machines.ts Lend) (#439); null until its agent first reports what it found. */
  lend: string | null;
  /** What its agent says jobs may use there (#857, src/machine-jobs.ts JobsOffer) as JSON; null when its agent has no jobs block. */
  jobs: string | null;
  /** Its owner's job hours, one-off window and Pause (#857, src/machine-jobs.ts JobSettings) as JSON; null for the defaults. */
  job_settings: string | null;
}

/** One browser of one signed-in person that wants Web Push notifications (src/push.ts). */
export interface PushSubscriptionRow {
  id: number;
  name: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** JSON list of project ids this device doesn't want notifications from. */
  muted: string;
  /** 1: only minions this device's person pinned (#198); 0: every minion that needs them. */
  only_pinned: number;
  /** JSON list of project ids where this device hears every minion, not only its person's own (#690). */
  everything: string;
  created_at: number;
}

/**
 * One finished Claude turn's cost at API prices (what Claude Code reports, not a bill on a subscription).
 * Claude Code's `total_cost_usd` is the session's running total, carried over on --resume, so a turn's
 * own cost is the rise since the session's previous turn. Tokens are the turn's own (`usage`), and
 * null for turns from before they were kept.
 */
export interface Turn {
  id: number;
  ticket_id: number;
  /** The turn's stored result event, if it has one. */
  event_id: number | null;
  session_id: string | null;
  ended_at: number;
  cost_usd: number;
  session_cost_usd: number;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  /** Whose plan paid (Runner.payerOf): null for the server login's, else that person's id. */
  payer: number | null;
  /** Its hash log as JSON (#878): Store.promptHashes parses it. Not "hashes": host_check masks columns named like a secret. */
  prompt_digest: string | null;
  /** 1 for a hidden keepalive turn (#862), costed apart; null for a real turn. */
  keepalive: number | null;
  /** Which of the payer's Claude accounts ran it (#779); null for turns from before #905 and Codex turns. */
  account: number | null;
  /** 1 for a side question's fork (#932), paid by its asker and kept out of the minion's own turn readouts; null for a turn. */
  side: number | null;
}

/** Store.spendRows: a minion's spend on one model (keepalive and side turns apart) over a window, with its minion's facts (#905, #956). */
export interface SpendRowRaw {
  ticket_id: number;
  keepalive: number | null;
  side: number | null;
  project_id: number;
  number: number | null;
  title: string;
  kind: string;
  created_by: string;
  /** The model the minion's session last ran, or its picked one: an older turn's estimate. */
  minion_model: string | null;
  /** Null for a turn from before the split was kept. */
  model: string | null;
  cost: number;
  type: string | null;
}

/** What a turn's result event says, for Store.recordTurn. */
export interface TurnResult {
  event_id?: number | null;
  session_id?: string | null;
  ended_at: number;
  session_cost_usd: number;
  duration_ms?: number | null;
  usage?: TokenUsage;
  payer?: number | null;
  /** What it was launched with (#878, src/prompt-hashes.ts). */
  hashes?: PromptHashes | null;
  keepalive?: boolean;
  /** A side question's fork (#932): its cost is the session's total less the fork's own previous total, never a turn's. */
  side?: boolean;
  /** A side question's first turn: the minion's session it forked. The fork's total starts from that session's, so its cost is the total less the parent's latest. */
  fork_of?: string | null;
  account?: number | null;
  /** The result's `modelUsage`: each model's running session cost, Grunts' models included (#905). */
  modelUsage?: Record<string, ModelUsage>;
  /** A killed turn's estimated spend by model (#1938), in place of a result's: the session's running totals stay as they were, since claude saved none of it. */
  estimate?: Record<string, number>;
}

/** A person's own named property filter in a scheme (#194): key → the values ticked for it. */
export interface SavedView {
  id: number;
  project_id: number;
  owner: string;
  name: string;
  picks: Record<string, (string | number)[]>;
  created_at: number;
}

/** A contraption's row (src/contraptions.ts). open_paths and relay_paths are JSON arrays of paths. */
export interface ContraptionErrorRow {
  contraption_id: number;
  day: string;
  kind: 'tool' | 'http' | 'log' | 'deploy';
  key: string;
  count: number;
  sample: string;
  first_at: number;
  last_at: number;
  name: string;
  title: string;
  home_scheme: number | null;
}

export interface ContraptionRow {
  id: number;
  name: string;
  title: string;
  icon: string | null;
  port: number;
  home_scheme: number | null;
  open_paths: string;
  /** JSON array of the manifest and icon files an installer may fetch with no login (#987), read from its page at deploy; null: not read yet. */
  static_paths: string | null;
  /** Path prefixes other contraptions may call for a person through the relay (src/relay.ts). */
  relay_paths: string;
  /** Where Citadel deploys it from (#266): a GitHub owner/name, the branch (null: main) and its folder (null: ~/apps/<name>). */
  repo: string | null;
  branch: string | null;
  folder: string | null;
  /** What its Restart and Stop risk (#1682): unassessed (the default), safe, interrupts or loses_data, and a note for whoever is about to press them. */
  restart_risk: 'unassessed' | 'safe' | 'interrupts' | 'loses_data';
  restart_note: string;
  /** The app's own folder inside its repo, like apps/notes (#1136): its citadel-app.json, units and build run there; null: the repo's root. */
  subdir: string | null;
  default_model: string | null;
  turn_cap: number | null;
  identity_public: string;
  identity_private: string;
  key_hash: string;
  keys_at: number;
  created_at: number;
}

/** What a new contraption's row needs: the columns with a default, or that may be null, can be left out (#1817). */
export type NewContraption = Omit<ContraptionRow, 'id' | 'created_at' | Defaulted> & Partial<Pick<ContraptionRow, Defaulted>>;
type Defaulted = 'icon' | 'home_scheme' | 'open_paths' | 'static_paths' | 'relay_paths' | 'repo' | 'branch' | 'folder' | 'subdir' | 'restart_risk' | 'restart_note' | 'default_model' | 'turn_cap';

/** A contraption's named session for one person, and the Claude session it resumes. */
export interface ContraptionSession {
  contraption_id: number;
  user_id: number;
  name: string;
  claude_session: string;
  created_at: number;
  used_at: number;
}

/** One contraption turn on the usage meter. outcome: 'end' or the error code it ended with. */
/** A contraption turn's audit row (#844, src/contraption-turns.ts): what the model got and said, and the app's verdict. */
export interface TurnAuditRow {
  turn_id: number;
  at: number;
  model: string | null;
  blind: number;
  images: number;
  system: string;
  prompt: string;
  output: string;
  verdict: 'pass' | 'fallback' | null;
  verdict_reason: string | null;
  verdict_at: number | null;
}

export interface ContraptionTurnRow {
  id: number;
  contraption_id: number;
  user_id: number;
  session: string;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

/** People's own note on a minion (#146): who last wrote it and when. Never shown to agents. */
export const PERSON_NOTE_MAX = 200; // public/thread.js keeps the same limit on its input
export interface PersonNote {
  text: string;
  by: string;
  at: number;
}

export interface EventRow {
  id: number;
  ticket_id: number;
  kind: string;
  data: string;
  created_at: number;
}

/** How long health_events rows are kept: the longest deploy check compares a day before with the day after (#724), and the Status page shows a week of stalls and restarts (#1123). */
export const HEALTH_KEEP_MS = 8 * 24 * 60 * 60_000;
/** How long host_samples rows are kept (#1123): the Status page's week plus a day. */
export const HOST_SAMPLE_KEEP_MS = 8 * 24 * 60 * 60_000;
/** How long flake_events rows are kept (#1063): the tab counts 14 days, and the brief quotes older failures. */
export const FLAKE_KEEP_MS = 90 * 24 * 60 * 60_000;
/** The most health_events rows kept, oldest dropped first, so a page that throws in a loop can't grow the database. */
export const HEALTH_MAX_ROWS = 5000;

/** Store.stepRatio's numbers (#571): steps it sums, a scheme's own it needs, and the fewest it uses at all. */
export const STEP_RATIO = { recent: 200, scheme: 50, least: 30 };

export type { FinishedStep } from '../public/progress.js';

/**
 * A title without a trailing build that matches its build field: "Lairs · Build #8" → "Lairs".
 * The build needs a separator or brackets, so a title that names the build ("Major Build #7") stays.
 */
export function titleWithoutBuild(title: string, build: number): string {
  const m = title.match(/^(.*\S)\s*(?:[·|:–—-]\s*build\s*#?(\d+)|\(\s*build\s*#?(\d+)\s*\))\s*$/i);
  return m && Number(m[2] ?? m[3]) === build ? m[1] : title;
}

/** How long without an action before the Taskmaster chat shows the recap: AWAY_MS in public/recap.js. */
export const RECAP_AWAY_MS = 6 * 60 * 60 * 1000;

/** One event of skillTimeline (src/skills.ts): what it called (space-separated), and 0/1 flags. */
export interface SkillEvent {
  id: number;
  ticket_id: number;
  at: number;
  skills: string | null;
  agents: string | null;
  edit: number;
  error: number;
  ship: number;
  result: number;
  grunt: number;
}
/** A minion in skillTimeline (src/skills.ts): its type property and the id of its newest "Shipped" note in the window (null if none). */
export interface SkillTicket {
  id: number;
  project_id: number;
  number: number | null;
  title: string;
  kind: string;
  type: string | null;
  shipped: number | null;
}
export interface SkillTimeline {
  events: SkillEvent[];
  tickets: SkillTicket[];
}

/** What Store.recentCards knows of a card: its first person's reply and its result, and the newest event id it looked at. */
export type CardFate = { reply: string | null; result: string | null; upTo: number };

/** The write Store.putClaudeState and StateDb.put share. */
export const PUT_CLAUDE_STATE = `INSERT INTO claude_state (path, project_id, ticket_id, size, mtime, data) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, ticket_id = excluded.ticket_id,
    size = excluded.size, mtime = excluded.mtime, data = excluded.data`;
