import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NOT_PEOPLE } from './auth.ts';
import { GLOBAL_OWNER, Registry } from './properties.ts';
import { Schedules } from './schedules.ts';
import { scheduleFirstWeek } from './first-week.ts';
import { ReviewSet } from './review-set.ts';
import type { GruntRow } from './grunts.ts';
import { Claims } from './claims.ts';
import { MemoryProposals, MEMORY_PROPOSALS_SCHEMA } from './memory-curator.ts';
import { ShipLessons } from './ship-lessons.ts';
import { UsageLedger } from './usage-ledger.ts';
import { Ideas } from './ideas.ts';
import { Memory } from './memory.ts';
import { MinionIndex, MINION_INDEX_SCHEMA } from './minion-index.ts';
import type { PromptHashes } from './prompt-hashes.ts';
import type { KeepaliveRow } from './keepalive.ts';
import { ciNumberQueries } from './db/ci-numbers.ts';
import { contraptionRunQueries } from './db/contraption-runs.ts';
import { deliveryQueries } from './db/deliveries.ts';
import { flakeQueries } from './db/flakes.ts';
import { machineQueries } from './db/machines.ts';
import { minionQueries } from './db/minions.ts';
import { pushQueries } from './db/push.ts';
import { readWarmQueries } from './db/read-warm.ts';
import { settingQueries } from './db/settings.ts';
import { slowMomentQueries } from './db/slow-moments.ts';
import { viewQueries } from './db/views.ts';

import { askerKey, buildOwnerKey, pagePlanKey, planKey } from './db-keys.ts';
import { copyRow, inScope, scoped } from './read-scope.ts';
import { CHAT, attachEventsForWrite, cardFatesTrigger, eventsHome, eventsMoved, eventsPath, eventsSchema, moveEvents } from './events-db.ts';
export { askerKey, buildOwnerKey, pagePlanKey, planKey };

/** The newest event when #812 landed: a card at or below it still counts a typed message as handling it (PERSON_WROTE), or every old card nobody settled would wake up open. */
export const TYPED_HANDLES_UP_TO = 696493;

/**
 * SQL on user_message event `a`: a person wrote it in that chat, so a card from before #812 counts it as handling it.
 * Not a relay from another chat (`from`: a minion, this or another scheme's Taskmaster), held mail, a
 * brief, Mandate's hook news, nor a name that isn't a person's (#610).
 */
/** The Overlord's events every person's Mine shows (#920; public/mine.js inMine says the same): items marked for everyone, and its cards' answers and results so they settle there. */
const MINE_EVENTS = `(json_extract(data, '$.everyone') = 1 OR kind IN ('question_result', 'question_more', 'card_reply', 'plan_result', 'approval_result')
  OR (kind = 'user_message' AND (json_extract(data, '$.answer') IS NOT NULL OR json_extract(data, '$.plan') IS NOT NULL)))`;
const PERSON_WROTE = `json_extract(a.data, '$.from') IS NULL AND json_extract(a.data, '$.mail') IS NULL AND json_extract(a.data, '$.brief') IS NULL
  AND lower(coalesce(json_extract(a.data, '$.author'), '')) NOT IN (${[...NOT_PEOPLE, 'Mandate'].map((n) => `'${n.toLowerCase().replace(/'/g, "''")}'`).join(', ')})
  AND coalesce(json_extract(a.data, '$.author'), '') NOT LIKE '#%'`;

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
  db_cached?: number | null; db_size?: number | null;
  kswapd_rate?: number | null; refault_rate?: number | null; server_refault_rate?: number | null; pgpgin_rate?: number | null; thp_fallback_rate?: number | null;
  /** The database warmer's last pass (#1560, src/db-warmer.ts): ms, MB read, and its backoffs since the server started; null before it or with it off. */
  warm_ms?: number | null; warm_mb?: number | null; warm_backoffs?: number | null;
  /** The growth alarm's readings (#1762, src/growth-alarm.ts): the server's open fds, running citadel-supervisor-* units, bytes used on /tmp, and each app server's memory as JSON; null before it or where unreadable. */
  open_fds?: number | null; supervisors?: number | null; tmp_used?: number | null; app_mem?: string | null;
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
  /** CI on GitHub's own runners (#1045, they cost Actions minutes): ask a person first, ok to use, or never. */
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
  go: 'hours' | 'now' | 'always' | 'standing' | null;
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

const APP_INSTRUCTIONS = 'app_instructions';
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
export interface SecretRow { scope: 'person' | 'scheme'; owner_id: number; name: string; value: string; updated_by: number | null; created_at: number; updated_at: number }

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
  /** The turn's stored result event, if any. */
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
  usage?: any;
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
  modelUsage?: any;
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

/** What Store.recentCards knows of a card: its first person's reply and its result, and the newest event id it looked at. */
type CardFate = { reply: string | null; result: string | null; upTo: number };

export interface EventRow {
  id: number;
  ticket_id: number;
  kind: string;
  data: string;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  login TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  admin INTEGER NOT NULL DEFAULT 0,
  server_login INTEGER NOT NULL DEFAULT 0,
  invite_hash TEXT UNIQUE,
  invite_expires INTEGER,
  disabled_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  repo_url TEXT,
  repo_dir TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL DEFAULT 'ticket',
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  session_id TEXT,
  cwd TEXT NOT NULL,
  branch TEXT,
  permission_mode TEXT NOT NULL,
  last_activity TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- events: the chat log, set up by src/events-db.ts (in the main file until a database is moved, then in events.db).
CREATE TABLE IF NOT EXISTS card_fates (
  card_id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL,
  cid TEXT,
  reply TEXT,
  result TEXT,
  up_to INTEGER NOT NULL
);
-- card_fates_events_deleted: src/events-db.ts.
CREATE TABLE IF NOT EXISTS artifacts (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  pinned_at INTEGER,
  pinned_by TEXT,
  missing INTEGER NOT NULL DEFAULT 0,
  UNIQUE (ticket_id, path)
);
CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id, mtime);
-- CI output a scheme's runners uploaded (#658, src/ci-store.ts): the file is at projects/<project>/ci-store/<workflow>/<run>-<attempt>/<name>.
-- A row goes when its file does. published_to names the place a release was last copied to (a contraption's feed).
CREATE TABLE IF NOT EXISTS ci_files (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  workflow TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  sha TEXT NOT NULL,
  ref TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_to TEXT,
  published_at INTEGER,
  UNIQUE (project_id, workflow, run_id, run_attempt, name)
);
-- Numbers a scheme's CI sends per run (#1369, src/ci-numbers.ts): bench timings, sizes. One row per series (name) and
-- run; a re-run attempt replaces it. Kept CI_NUMBERS_KEEP_MS, far past the CI store's files.
CREATE TABLE IF NOT EXISTS ci_numbers (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  workflow TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  run_attempt INTEGER NOT NULL,
  sha TEXT NOT NULL,
  ref TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, name, run_id)
);
CREATE INDEX IF NOT EXISTS ci_numbers_series ON ci_numbers(project_id, name, created_at);
-- A step up in a series that held for three runs (#1369): run_id and created_at are the step's first run's.
CREATE TABLE IF NOT EXISTS ci_number_steps (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  ref TEXT NOT NULL,
  run_id INTEGER NOT NULL,
  sha TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  baseline REAL NOT NULL,
  level REAL NOT NULL,
  flagged_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ci_number_steps_series ON ci_number_steps(project_id, name, created_at);
-- Who published which Android build of a contraption, from which run, and when (#663): the Releases page's Deploy
-- button, auto-deploy and publish_release all write it. published_by is a person's name, '#N' for a minion, or 'auto-deploy';
-- uid the person it was for (a minion's turn: whoever asked for it), or null.
CREATE TABLE IF NOT EXISTS apk_publishes (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  contraption TEXT NOT NULL,
  version_code INTEGER NOT NULL,
  run_id INTEGER NOT NULL,
  published_by TEXT NOT NULL,
  uid INTEGER,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ticket_seen (
  name TEXT NOT NULL,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (name, ticket_id)
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  workspace_tools INTEGER NOT NULL DEFAULT 0,
  scoped INTEGER NOT NULL DEFAULT 0,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  mcp_kind TEXT,
  mcp_command TEXT NOT NULL DEFAULT '',
  always_on INTEGER NOT NULL DEFAULT 1,
  last_check TEXT,
  lend TEXT
);
-- The schemes a machine is lent to (#303; every machine's one list since #438). Before #438 read only where machines.scoped = 1: rows left from #62
-- (Oct 27, unused since #89) stay put, and choosing "only these" for a machine replaces its rows.
CREATE TABLE IF NOT EXISTS machine_projects (
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (machine_id, project_id)
);
-- A CI runner agent's load samples (#534), one every 30 seconds as JSON (src/ci-load.ts Sample), kept 14 days.
CREATE TABLE IF NOT EXISTS runner_load (
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runner_load_at ON runner_load(at);
-- Jobs on a person's own machine (#857, shared/project/specs/desktop-gpu-jobs.md): one row per job a minion or a contraption
-- queued, the server's queue of record. kind is the recipe as sent (JSON) and kind_hash its hash (src/machine-jobs.ts kindHash);
-- go is how it got its go: hours, now, always (a standing go asked on its card) or standing (an earlier standing go covered it).
CREATE TABLE IF NOT EXISTS machine_jobs (
  id INTEGER PRIMARY KEY,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  contraption_id INTEGER REFERENCES contraptions(id) ON DELETE SET NULL,
  asked_by TEXT NOT NULL,
  kind_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  kind_hash TEXT NOT NULL,
  inputs TEXT NOT NULL DEFAULT '[]',
  limit_s INTEGER NOT NULL,
  run_when TEXT NOT NULL DEFAULT 'hours',
  reason TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL,
  go TEXT,
  go_by TEXT,
  paused_by TEXT,
  card TEXT,
  input_token_hash TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  run_s INTEGER NOT NULL DEFAULT 0,
  server_run_s INTEGER NOT NULL DEFAULT 0,
  gpu_busy_s INTEGER NOT NULL DEFAULT 0,
  live TEXT,
  live_at INTEGER,
  exit_code INTEGER,
  error TEXT,
  outputs TEXT NOT NULL DEFAULT '[]',
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  swept_at INTEGER
);
CREATE INDEX IF NOT EXISTS machine_jobs_machine ON machine_jobs(machine_id, state);
CREATE INDEX IF NOT EXISTS machine_jobs_ticket ON machine_jobs(ticket_id);
-- A standing go (#857): its owner's "Always allow this kind" for one machine, keyed on the recipe's hash, so any change to
-- the image digest, command, folders, GPU, network or top limit is a new kind that asks again. It covers job hours only.
CREATE TABLE IF NOT EXISTS machine_job_kinds (
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  name TEXT NOT NULL,
  recipe TEXT NOT NULL,
  allowed_by TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (machine_id, hash)
);
-- What each finished step of a minion's plan took (#571): its guess and its working time (the part of start to
-- finish inside running turns), written as the step is marked completed, for the readout's ratio (Store.stepRatio).
CREATE TABLE IF NOT EXISTS step_times (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  task_id TEXT NOT NULL,
  subject TEXT NOT NULL,
  estimate REAL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  work_ms INTEGER NOT NULL,
  model TEXT,
  effort TEXT,
  PRIMARY KEY (ticket_id, task_id, started_at)
);
CREATE INDEX IF NOT EXISTS step_times_finished ON step_times(finished_at);
CREATE TABLE IF NOT EXISTS github_seen (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  key TEXT NOT NULL,
  delivered INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, key)
);
CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  event_id INTEGER,
  session_id TEXT,
  ended_at INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  session_cost_usd REAL NOT NULL,
  duration_ms INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  payer INTEGER,
  prompt_digest TEXT,
  keepalive INTEGER
);
CREATE INDEX IF NOT EXISTS turns_ticket ON turns(ticket_id, id);
CREATE INDEX IF NOT EXISTS turns_ended ON turns(ended_at);
CREATE TABLE IF NOT EXISTS turn_models (
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  model TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  session_cost_usd REAL NOT NULL,
  PRIMARY KEY (turn_id, model)
);
-- Each Grunt a turn started (#948), read from the session's subagents/ folder at the turn's end.
-- Every model and effort a minion started on or was moved to (#1061, A4): who picked it and why, so a scorecard can count
-- which reasons held up. No foreign key on ticket_id, like brief_starts, so an older release's deleteTicket still works.
CREATE TABLE IF NOT EXISTS ticket_picks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  model TEXT,
  effort TEXT,
  by TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_picks_ticket ON ticket_picks(ticket_id, id);
CREATE TABLE IF NOT EXISTS turn_grunts (
  agent_id TEXT PRIMARY KEY,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  agent_type TEXT,
  model TEXT,
  effort TEXT,
  calls INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  request_shape TEXT,
  spawn_depth INTEGER,
  description TEXT
);
CREATE INDEX IF NOT EXISTS turn_grunts_turn ON turn_grunts(turn_id);
CREATE TABLE IF NOT EXISTS instruction_history (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  by TEXT NOT NULL,
  at INTEGER NOT NULL,
  old_text TEXT NOT NULL,
  new_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS instruction_history_project ON instruction_history(project_id, id);
-- Saves of the Citadel-wide instructions (#148), whose text is in settings under app_instructions.
CREATE TABLE IF NOT EXISTS app_instruction_history (
  id INTEGER PRIMARY KEY,
  by TEXT NOT NULL,
  at INTEGER NOT NULL,
  old_text TEXT NOT NULL,
  new_text TEXT NOT NULL
);
-- Each person's own instructions (#688), one text for everywhere (project_id NULL) and one per scheme. Every save is a row;
-- the newest row of a person and scope holds the current text, so this is the history too.
CREATE TABLE IF NOT EXISTS personal_instructions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  old_text TEXT NOT NULL,
  new_text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS personal_instructions_scope ON personal_instructions(user_id, project_id, id);
-- A brief in a file that someone started as a minion (#129), keyed by the file's absolute path and the brief's
-- heading ('' for a whole handoff file). ticket_id is null while its minion is being made. No foreign key on
-- ticket_id, so an older release's deleteTicket still works after a rollback; reads join tickets instead.
CREATE TABLE IF NOT EXISTS brief_starts (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  path TEXT NOT NULL,
  heading TEXT NOT NULL,
  ticket_id INTEGER,
  started_by TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, path, heading)
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  muted TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  only_pinned INTEGER NOT NULL DEFAULT 0,
  everything TEXT NOT NULL DEFAULT '[]'
);
-- Each person's own saved views (#194), keyed by name like ticket_pins. saved_views, the shared ones
-- before it, moves in at start: see Store.moveSharedViews.
CREATE TABLE IF NOT EXISTS person_views (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  name TEXT NOT NULL,
  picks TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (project_id, owner, name)
);
-- People's own note on a minion (#146), kept out of the tickets row so no ticket JSON a minion or the
-- Taskmaster can read carries it. No foreign key, like brief_starts, so an older release's deleteTicket
-- still works after a rollback.
CREATE TABLE IF NOT EXISTS person_notes (
  ticket_id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Minions a person pinned to the top of their list (#179): per login name, like ticket_seen. No foreign key,
-- like person_notes, so an older release's deleteTicket still works after a rollback.
CREATE TABLE IF NOT EXISTS ticket_pins (
  name TEXT NOT NULL,
  ticket_id INTEGER NOT NULL,
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (name, ticket_id)
);
-- Schemes a person hid from their own lists, badges and pushes (#226). Never changes who is in the scheme.
CREATE TABLE IF NOT EXISTS project_hides (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hidden_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
-- Retired (#1405): the settings Minimize that wrote this is gone and nothing reads or writes it. The table stays, empty, on purpose: no migration.
CREATE TABLE IF NOT EXISTS project_minimizes (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  minimized_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, project_id)
);
-- Each person's own order of a list they dragged into shape (#649): 'schemes' (scheme ids) or 'apps'
-- (contraption names), as a JSON array. Anything it doesn't name sorts after, in the list's usual order.
CREATE TABLE IF NOT EXISTS list_orders (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  list TEXT NOT NULL,
  keys TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, list)
);
-- The Needs-you count each person last saw on a scheme's badge (#498). Unused since #539 (project_seen_items
-- replaced it); kept so a rollback to #498's release still finds it.
CREATE TABLE IF NOT EXISTS project_seen_counts (
  name TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  count INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (name, project_id)
);
-- The Needs-you items (InboxItem.key, src/inbox.ts) each person last saw waiting in a scheme, as a JSON array (#539),
-- so the scheme list can mark a badge when something new waits.
CREATE TABLE IF NOT EXISTS project_seen_items (
  name TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  keys TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (name, project_id)
);
-- When each person last acted in a scheme (a message or an approval click), for the recap (#538): reading it
-- from the events took 1.5 s with the disk cache cold. A missing row is filled from the events once (Store.recap).
CREATE TABLE IF NOT EXISTS last_actions (
  name TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  PRIMARY KEY (name, project_id)
);
CREATE TABLE IF NOT EXISTS shared_pins (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  pinned_at INTEGER NOT NULL,
  pinned_by TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
);
-- What HTML artifacts saved through the artifact bridge (#168): one row per key, per page, keyed by the
-- page's real path so a page shares its store however it was opened. Values are JSON.
CREATE TABLE IF NOT EXISTS artifact_data (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  file TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  by TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (project_id, file, key)
);
-- A person's linked accounts (src/credentials.ts): secret is AES-256-GCM, keyed from SESSION_SECRET; meta
-- is JSON in the clear (a GitHub login, never a token). One row per person and kind.
CREATE TABLE IF NOT EXISTS credentials (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  secret TEXT NOT NULL,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  failed_at INTEGER,
  PRIMARY KEY (user_id, kind)
);
-- Secrets people saved (src/secrets.ts, #838): a person's own (scope 'person', owner_id their user id) or a
-- scheme's (scope 'scheme', owner_id its project id). value is AES-256-GCM keyed from SESSION_SECRET and bound to
-- its row, like credentials; off-box copies drop the table's rows (deploy/offbox.sh). No foreign keys: owner_id
-- names a user or a project by scope.
CREATE TABLE IF NOT EXISTS stored_secrets (
  scope TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, owner_id, name)
);
-- Each person's OpenRouter calls (src/openrouter.ts, #717): booked pending at their worst-case price before the
-- request, then ok at the real cost, failed (refused, nothing billed) or unknown (may have been billed: counted at
-- the estimate). The monthly cap sums them. No foreign keys: the spend outlives a closed minion.
CREATE TABLE IF NOT EXISTS openrouter_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ticket_id INTEGER,
  project_id INTEGER,
  model TEXT NOT NULL,
  kind TEXT NOT NULL,
  estimate_usd REAL NOT NULL,
  cost_usd REAL,
  status TEXT NOT NULL,
  path TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS openrouter_calls_user ON openrouter_calls(user_id, created_at);
-- Spend on outside APIs a contraption or minion reported (src/outside-spend.ts, #839), by scheme. No foreign keys:
-- the bill outlives the app or minion that reported it.
CREATE TABLE IF NOT EXISTS outside_spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  service TEXT NOT NULL,
  usd REAL NOT NULL,
  units REAL,
  note TEXT,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS outside_spend_project ON outside_spend(project_id, created_at);
-- What Citadel did on GitHub for a scheme member (src/repo-access.ts, #310): state added or invited is
-- Citadel's own doing, undone when they leave; existing was there before, so leaving leaves it. No foreign
-- keys: the row outlives a removed person or scheme so the collaborator it made can still be taken off.
CREATE TABLE IF NOT EXISTS repo_collaborators (
  project_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  slug TEXT NOT NULL,
  login TEXT,
  state TEXT NOT NULL,
  invitation_id INTEGER,
  error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
-- Contraptions (src/contraptions.ts): personal apps with their own service, reached through Citadel.
-- identity_private is the Ed25519 private key, sealed like credentials but kept out of that table, which
-- turns can reach; key_hash is the sha256 of the bearer contraption key, which only the key files hold.
CREATE TABLE IF NOT EXISTS contraptions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  icon TEXT,
  port INTEGER NOT NULL,
  home_scheme INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  open_paths TEXT NOT NULL DEFAULT '[]',
  default_model TEXT,
  turn_cap INTEGER,
  identity_public TEXT NOT NULL,
  identity_private TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  keys_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- Each Stop and Restart run from Settings or the Taskmaster's tool (#1682, src/db/contraption-runs.ts): who, the risk it carried, the result.
CREATE TABLE IF NOT EXISTS contraption_runs (
  id INTEGER PRIMARY KEY,
  contraption_id INTEGER NOT NULL REFERENCES contraptions(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  action TEXT NOT NULL,
  risk TEXT NOT NULL,
  by TEXT NOT NULL,
  ok INTEGER NOT NULL,
  said TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS contraption_runs_by_app ON contraption_runs(contraption_id, id);
-- Who a contraption is enabled for: its own list, like project_members. Being in its home scheme grants nothing.
CREATE TABLE IF NOT EXISTS contraption_users (
  contraption_id INTEGER NOT NULL REFERENCES contraptions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (contraption_id, user_id)
);
-- A contraption's named agent chats per person (src/contraption-turns.ts): the Claude session each name
-- resumes. Only names and ids: the transcript stays in the person's own Claude folder.
CREATE TABLE IF NOT EXISTS contraption_sessions (
  contraption_id INTEGER NOT NULL REFERENCES contraptions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  claude_session TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER NOT NULL,
  PRIMARY KEY (contraption_id, user_id, name)
);
-- The usage meter for contraption turns: who, which session, tokens and time. Never a prompt, reply or tool content.
CREATE TABLE IF NOT EXISTS contraption_turns (
  id INTEGER PRIMARY KEY,
  contraption_id INTEGER NOT NULL REFERENCES contraptions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  outcome TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS contraption_turns_day ON contraption_turns(contraption_id, user_id, started_at);
-- The turn audit (#844, src/contraption-turns.ts): each contraption turn's system text, prompt and reply as the model
-- got and gave them, and the app's verdict on the reply. Kept apart from the meter above, which never holds text; only
-- members of the app's home scheme read it, and rows go after AUDIT_DAYS or with their session.
CREATE TABLE IF NOT EXISTS contraption_turn_audit (
  turn_id INTEGER PRIMARY KEY REFERENCES contraption_turns(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  model TEXT,
  blind INTEGER NOT NULL,
  images INTEGER NOT NULL,
  system TEXT NOT NULL,
  prompt TEXT NOT NULL,
  output TEXT NOT NULL,
  verdict TEXT,
  verdict_reason TEXT,
  verdict_at INTEGER
);
CREATE INDEX IF NOT EXISTS contraption_turn_audit_at ON contraption_turn_audit(at);
-- Contraptions' errors by Pacific day (#835, src/contraption-errors.ts): failed agent tool calls (tool), 5xx answers
-- through the proxy (http) and journal error lines (log), grouped by key (numbers and ids out), with a count and the
-- first scrubbed sample line. Never a prompt or reply.
CREATE TABLE IF NOT EXISTS contraption_errors (
  contraption_id INTEGER NOT NULL REFERENCES contraptions(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  count INTEGER NOT NULL,
  sample TEXT NOT NULL,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (contraption_id, day, kind, key)
);
-- Phones that take a contraption's push (#1138, src/fcm.ts): the Firebase token the Android shell registered at
-- /apps/_citadel/push/<app>, whose phone it is and for which app. One row per token: registered again by someone
-- else, or for another app, the phone moves. The token reaches the phone, so it is a secret (src/db-view.ts).
CREATE TABLE IF NOT EXISTS contraption_push_devices (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  contraption_id INTEGER NOT NULL REFERENCES contraptions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS contraption_push_devices_user ON contraption_push_devices(contraption_id, user_id);
-- One row per release of a scheme's target (#625, specs/release-monitor.md): the version people got, the minions
-- in it (JSON [{ ticketId, number, title, stages }]), when its first change started on its way and went live,
-- how it ended, and each stage's length in s (JSON { stage: s }). src/releases.ts writes and reads them.
CREATE TABLE IF NOT EXISTS releases (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  version TEXT NOT NULL,
  changes TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER,
  live_at INTEGER,
  outcome TEXT NOT NULL,
  stages TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS releases_target ON releases(project_id, target, id);
-- One row per contraption deploy (#627, src/release-readers.ts): the commit it ran before and went to, who asked,
-- when it started and ended, how it ended (deployed, failed, rolled back), each stage's length in s (JSON
-- { stage: s }) and the minions in it (JSON [{ ticketId, number, title }]). Keyed by name, so it outlives a re-register.
CREATE TABLE IF NOT EXISTS contraption_deploys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  from_sha TEXT,
  to_sha TEXT,
  by TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT NOT NULL,
  stages TEXT NOT NULL DEFAULT '{}',
  changes TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS contraption_deploys_name ON contraption_deploys(name, id);
-- Health readings the post-deploy watch compares before and after each deploy (#724, src/deploy-watch.ts): front-end
-- errors from the beacon, 5xx answers, in-server fallbacks and event-loop stalls, one row each, with the commit live
-- then and what it said. Kept for HEALTH_KEEP_MS, and at most HEALTH_MAX_ROWS rows.
CREATE TABLE IF NOT EXISTS health_events (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  commit_sha TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS health_events_kind ON health_events(kind, at);
-- Pauses over 2 s people's pages noticed (#1752, src/db/slow-moments.ts): where the time went. The newest SLOW_KEEP kept.
CREATE TABLE IF NOT EXISTS slow_moments (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  person TEXT NOT NULL,
  device TEXT NOT NULL DEFAULT '',
  tab TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  what TEXT NOT NULL DEFAULT '',
  page TEXT NOT NULL DEFAULT '',
  project_id INTEGER,
  total_ms INTEGER NOT NULL,
  server_ms INTEGER,
  network_ms INTEGER NOT NULL,
  tab_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS slow_moments_at ON slow_moments(at);
-- perigee's own memory, disk and load every 5 minutes (#1123), for the Status page's week of history. Kept HOST_SAMPLE_KEEP_MS.
CREATE TABLE IF NOT EXISTS host_samples (
  at INTEGER PRIMARY KEY,
  mem_total INTEGER NOT NULL,
  mem_avail INTEGER NOT NULL,
  disk_total INTEGER NOT NULL,
  disk_free INTEGER NOT NULL,
  load1 REAL NOT NULL,
  rss INTEGER NOT NULL,
  cpu_psi INTEGER,
  mem_psi INTEGER,
  io_psi INTEGER,
  swap_used INTEGER,
  cpu_ledger TEXT,
  answer_time TEXT,
  db_cached INTEGER,
  db_size INTEGER,
  kswapd_rate REAL,
  refault_rate REAL,
  server_refault_rate REAL,
  pgpgin_rate REAL,
  thp_fallback_rate REAL,
  warm_ms REAL,
  warm_mb REAL,
  warm_backoffs INTEGER,
  open_fds INTEGER,
  supervisors INTEGER,
  tmp_used INTEGER,
  app_mem TEXT
);
-- One row per test file that failed in a land's or fast mode's run and passed alone (#1063): the CI page's Test health tab counts them.
CREATE TABLE IF NOT EXISTS flake_events (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  file TEXT NOT NULL,
  at INTEGER NOT NULL,
  commit_sha TEXT,
  ticket_id INTEGER,
  source TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  test_name TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  class TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS flake_events_scheme ON flake_events(project_id, at);
-- One row per fix of a flaky test file (#1120): started by the file's third sighting in 7 days, held only after 50 clean runs (5 batches of 10 copies at once)
-- on the desktop runner (state 'held'), and reopened (state 'open' again, reopened + 1) by the next sighting.
CREATE TABLE IF NOT EXISTS flake_fixes (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  file TEXT NOT NULL,
  ticket_id INTEGER,
  state TEXT NOT NULL DEFAULT 'open',
  started_at INTEGER NOT NULL,
  clean_runs INTEGER NOT NULL DEFAULT 0,
  held_at INTEGER,
  reopened INTEGER NOT NULL DEFAULT 0,
  proof_run INTEGER
);
CREATE INDEX IF NOT EXISTS flake_fixes_file ON flake_fixes(project_id, file);
-- Three lines after every ship (src/ship-lessons.ts, #1119): what a minion had to find out that its brief or the docs
-- didn't say, queued per scheme for the weekly Ship lessons pass. lines '' is a ship that said nothing. No foreign keys:
-- the lines outlive the minion.
CREATE TABLE IF NOT EXISTS ship_lessons (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  ticket_id INTEGER,
  number INTEGER,
  lines TEXT NOT NULL DEFAULT '',
  files TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'land',
  at INTEGER NOT NULL,
  taken_at INTEGER,
  taken_note TEXT
);
CREATE INDEX IF NOT EXISTS ship_lessons_scheme ON ship_lessons(project_id, at);
-- The usage ledger (src/usage-ledger.ts, #1306): one row per Pacific day, kind and name; people is how many different people.
CREATE TABLE IF NOT EXISTS usage_counts (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  people INTEGER NOT NULL DEFAULT 0,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, name)
);
-- The one outbox (src/outbox.ts, ADR 0021, #1385): every saved "send this later" row, whatever its kind. Its queries are
-- in src/db/deliveries.ts; state, due and met_at follow the ADR's crash rule.
CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  to_kind TEXT NOT NULL,
  to_id INTEGER NOT NULL,
  when_kind TEXT NOT NULL,
  when_arg TEXT NOT NULL DEFAULT 'null',
  payload TEXT NOT NULL DEFAULT '{}',
  set_by TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'waiting',
  due INTEGER,
  met_at INTEGER,
  dedupe_key TEXT,
  origin TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  reason TEXT,
  event_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(state, due);
CREATE INDEX IF NOT EXISTS deliveries_event ON deliveries(state, when_kind);
CREATE INDEX IF NOT EXISTS deliveries_target ON deliveries(to_kind, to_id, state);
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_dedupe ON deliveries(kind, dedupe_key) WHERE dedupe_key IS NOT NULL AND state IN ('waiting', 'held');
-- The ideas ledger (src/ideas.ts, #1150): one row per idea a scheme was shown, on a choices page (page, card) or in a
-- handoff with no page (page '', card = the handoff's path). It fills itself from picks, handoffs, starts and ships;
-- status_manual and link_manual are hand edits the scan never undoes. No foreign keys: a row outlives its minion.
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  page TEXT NOT NULL DEFAULT '',
  card TEXT NOT NULL,
  collection TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  source_number INTEGER,
  pick TEXT,
  pick_label TEXT,
  decided_by TEXT,
  words TEXT,
  decided_at INTEGER,
  handoff TEXT,
  ticket_id INTEGER,
  number INTEGER,
  link_manual INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'proposed',
  status_manual TEXT,
  manual_by TEXT,
  manual_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, page, card)
);
CREATE INDEX IF NOT EXISTS ideas_handoff ON ideas(project_id, handoff);
-- Who touched a minion (#919): requested, assigned, wrote in its chat or answered its card. It only grows;
-- left_at is set when the person leaves it, and a later touch rejoins. Updates reach each touched person's Taskmaster.
CREATE TABLE IF NOT EXISTS ticket_touches (
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  left_at INTEGER,
  PRIMARY KEY (ticket_id, user_id)
);
-- One line per thing a scheme's Taskmaster did (#919), read by its other Taskmasters at their next turn's start.
CREATE TABLE IF NOT EXISTS taskmaster_digest (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  by_ticket INTEGER NOT NULL,
  at INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS taskmaster_digest_project ON taskmaster_digest(project_id, id);
`;

/**
 * Session state lives in state.db beside the database, attached as `state`: it is most of the bytes,
 * and previews, boot-check and the pre-deploy copy (which copy only the main file) never need it.
 * No foreign keys, as SQLite can't enforce them across files; deleteTicket clears a minion's rows.
 */
const STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS state.claude_state (
  path TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL,
  ticket_id INTEGER,
  size INTEGER NOT NULL,
  mtime INTEGER NOT NULL,
  data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS state.claude_state_owner ON claude_state(project_id, ticket_id);
`;

const PUT_CLAUDE_STATE = `INSERT INTO claude_state (path, project_id, ticket_id, size, mtime, data) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, ticket_id = excluded.ticket_id,
    size = excluded.size, mtime = excluded.mtime, data = excluded.data`;

/**
 * state.db on a connection of its own, for the worker thread that moves session blobs (src/sessions.ts): a
 * 60 MB row read or written on the server's connection held the event loop for seconds (#612).
 */
export class StateDb {
  private db: DatabaseSync;

  constructor(path: string) {
    // A long wait: it runs off the event loop, and the server's own connection may be writing.
    this.db = new DatabaseSync(path, { timeout: 30_000 });
    this.db.exec('PRAGMA synchronous = NORMAL; PRAGMA journal_size_limit = 16777216;');
  }

  getData(path: string): { data: Uint8Array; mtime: number } | undefined {
    return this.db.prepare('SELECT data, mtime FROM claude_state WHERE path = ?').get(path) as { data: Uint8Array; mtime: number } | undefined;
  }

  /** As Store.putClaudeState, but never over a newer copy: another login's save may have landed since this one's check (#259). */
  put(row: Required<ClaudeStateRow>) {
    this.db.prepare(`${PUT_CLAUDE_STATE} WHERE excluded.mtime >= claude_state.mtime`).run(row.path, row.project_id, row.ticket_id, row.size, row.mtime, row.data);
  }

  close() {
    this.db.close();
  }
}

/** Columns added after the first release, for databases created before them. */
const MIGRATIONS: [table: string, column: string, ddl: string][] = [
  ['flake_events', 'test_name', "ALTER TABLE flake_events ADD COLUMN test_name TEXT NOT NULL DEFAULT ''"],
  ['flake_events', 'message', "ALTER TABLE flake_events ADD COLUMN message TEXT NOT NULL DEFAULT ''"],
  ['flake_events', 'class', "ALTER TABLE flake_events ADD COLUMN class TEXT NOT NULL DEFAULT ''"],
  ['contraptions', 'static_paths', 'ALTER TABLE contraptions ADD COLUMN static_paths TEXT'],
  ['contraptions', 'subdir', 'ALTER TABLE contraptions ADD COLUMN subdir TEXT'],
  ['host_samples', 'cpu_psi', 'ALTER TABLE host_samples ADD COLUMN cpu_psi INTEGER'],
  ['host_samples', 'mem_psi', 'ALTER TABLE host_samples ADD COLUMN mem_psi INTEGER'],
  ['host_samples', 'io_psi', 'ALTER TABLE host_samples ADD COLUMN io_psi INTEGER'],
  ['host_samples', 'swap_used', 'ALTER TABLE host_samples ADD COLUMN swap_used INTEGER'],
  ['host_samples', 'cpu_ledger', 'ALTER TABLE host_samples ADD COLUMN cpu_ledger TEXT'],
  ['host_samples', 'answer_time', 'ALTER TABLE host_samples ADD COLUMN answer_time TEXT'],
  ['host_samples', 'db_cached', 'ALTER TABLE host_samples ADD COLUMN db_cached INTEGER'],
  ['host_samples', 'db_size', 'ALTER TABLE host_samples ADD COLUMN db_size INTEGER'],
  ['host_samples', 'kswapd_rate', 'ALTER TABLE host_samples ADD COLUMN kswapd_rate REAL'],
  ['host_samples', 'refault_rate', 'ALTER TABLE host_samples ADD COLUMN refault_rate REAL'],
  ['host_samples', 'server_refault_rate', 'ALTER TABLE host_samples ADD COLUMN server_refault_rate REAL'],
  ['host_samples', 'pgpgin_rate', 'ALTER TABLE host_samples ADD COLUMN pgpgin_rate REAL'],
  ['host_samples', 'thp_fallback_rate', 'ALTER TABLE host_samples ADD COLUMN thp_fallback_rate REAL'],
  ['host_samples', 'warm_ms', 'ALTER TABLE host_samples ADD COLUMN warm_ms REAL'],
  ['host_samples', 'warm_mb', 'ALTER TABLE host_samples ADD COLUMN warm_mb REAL'],
  ['host_samples', 'warm_backoffs', 'ALTER TABLE host_samples ADD COLUMN warm_backoffs INTEGER'],
  ['host_samples', 'open_fds', 'ALTER TABLE host_samples ADD COLUMN open_fds INTEGER'],
  ['host_samples', 'supervisors', 'ALTER TABLE host_samples ADD COLUMN supervisors INTEGER'],
  ['host_samples', 'tmp_used', 'ALTER TABLE host_samples ADD COLUMN tmp_used INTEGER'],
  ['host_samples', 'app_mem', 'ALTER TABLE host_samples ADD COLUMN app_mem TEXT'],
  ['tickets', 'closed_at', 'ALTER TABLE tickets ADD COLUMN closed_at INTEGER'],
  ['tickets', 'kind', "ALTER TABLE tickets ADD COLUMN kind TEXT NOT NULL DEFAULT 'ticket'"],
  ['tickets', 'number', 'ALTER TABLE tickets ADD COLUMN number INTEGER'],
  // shortcut: tag is retired (#254) and nothing writes it; the column stays so a rollback still boots, drop it in a later release.
  ['tickets', 'tag', 'ALTER TABLE tickets ADD COLUMN tag TEXT'],
  ['tickets', 'state', 'ALTER TABLE tickets ADD COLUMN state TEXT'],
  ['tickets', 'note', 'ALTER TABLE tickets ADD COLUMN note TEXT'],
  ['tickets', 'build', 'ALTER TABLE tickets ADD COLUMN build INTEGER'],
  ['tickets', 'replies', 'ALTER TABLE tickets ADD COLUMN replies TEXT'],
  ['tickets', 'model', 'ALTER TABLE tickets ADD COLUMN model TEXT'],
  ['tickets', 'effort', 'ALTER TABLE tickets ADD COLUMN effort TEXT'],
  ['tickets', 'last_model', 'ALTER TABLE tickets ADD COLUMN last_model TEXT'],
  ['tickets', 'picked_because', 'ALTER TABLE tickets ADD COLUMN picked_because TEXT'],
  // tickets.goal (#1130) is no longer read or written (#1241, Josh 2026-11-20: the strip it fed is gone). The column stays, with its saved
  // text, on purpose: no migration, no data deleted, and a new database still builds the same schema.
  ['tickets', 'goal', 'ALTER TABLE tickets ADD COLUMN goal TEXT'],
  ['tickets', 'last_effort', 'ALTER TABLE tickets ADD COLUMN last_effort TEXT'],
  ['tickets', 'workflow', 'ALTER TABLE tickets ADD COLUMN workflow INTEGER NOT NULL DEFAULT 0'],
  ['tickets', 'plugin_dirs', "ALTER TABLE tickets ADD COLUMN plugin_dirs TEXT NOT NULL DEFAULT ''"],
  // What a machine's agent says its owner allows jobs to use (#857, src/machine-jobs.ts JobsOffer), kept while it is offline; null: no jobs block.
  ['machines', 'jobs', 'ALTER TABLE machines ADD COLUMN jobs TEXT'],
  // Its owner's job hours, one-off window and Pause (#857, src/machine-jobs.ts JobSettings); null: the defaults.
  ['machines', 'job_settings', 'ALTER TABLE machines ADD COLUMN job_settings TEXT'],
  // Its token sealed under SESSION_SECRET (#1355), so its owner can show it again; null for one linked before, until a relink.
  ['machines', 'token_sealed', 'ALTER TABLE machines ADD COLUMN token_sealed TEXT'],
  ['projects', 'instructions', "ALTER TABLE projects ADD COLUMN instructions TEXT NOT NULL DEFAULT ''"],
  ['projects', 'instructions_updated_by', 'ALTER TABLE projects ADD COLUMN instructions_updated_by TEXT'],
  ['projects', 'instructions_updated_at', 'ALTER TABLE projects ADD COLUMN instructions_updated_at INTEGER'],
  ['projects', 'approval_rules', "ALTER TABLE projects ADD COLUMN approval_rules TEXT NOT NULL DEFAULT ''"],
  ['projects', 'plugin_dirs', "ALTER TABLE projects ADD COLUMN plugin_dirs TEXT NOT NULL DEFAULT ''"],
  ['projects', 'optional_plugin_dirs', "ALTER TABLE projects ADD COLUMN optional_plugin_dirs TEXT NOT NULL DEFAULT ''"],
  ['projects', 'default_effort', "ALTER TABLE projects ADD COLUMN default_effort TEXT NOT NULL DEFAULT 'high'"],
  ['projects', 'machine_tools', 'ALTER TABLE projects ADD COLUMN machine_tools INTEGER NOT NULL DEFAULT 1'],
  // Schemes from before onboarding (#172) are set up already.
  ['projects', 'onboarding', "ALTER TABLE projects ADD COLUMN onboarding TEXT NOT NULL DEFAULT 'done'"],
  ['projects', 'onboarding_mode', "ALTER TABLE projects ADD COLUMN onboarding_mode TEXT NOT NULL DEFAULT 'first-run'"],
  ['projects', 'github_error', 'ALTER TABLE projects ADD COLUMN github_error TEXT'],
  ['projects', 'owner_id', 'ALTER TABLE projects ADD COLUMN owner_id INTEGER REFERENCES users(id)'],
  ['projects', 'list_groups', "ALTER TABLE projects ADD COLUMN list_groups TEXT NOT NULL DEFAULT '[]'"],
  ['projects', 'ci_quiet', "ALTER TABLE projects ADD COLUMN ci_quiet TEXT NOT NULL DEFAULT ''"],
  ['projects', 'ci_watch', "ALTER TABLE projects ADD COLUMN ci_watch TEXT NOT NULL DEFAULT ''"],
  ['projects', 'land_mode', "ALTER TABLE projects ADD COLUMN land_mode TEXT NOT NULL DEFAULT 'off'"],
  ['projects', 'fable_ok', "ALTER TABLE projects ADD COLUMN fable_ok TEXT NOT NULL DEFAULT 'on'"],
  ['projects', 'builds', "ALTER TABLE projects ADD COLUMN builds TEXT NOT NULL DEFAULT 'suggest'"],
  ['projects', 'grill', "ALTER TABLE projects ADD COLUMN grill TEXT NOT NULL DEFAULT 'design'"],
  ['projects', 'gh_runners', "ALTER TABLE projects ADD COLUMN gh_runners TEXT NOT NULL DEFAULT 'ask'"],
  ['projects', 'shot_widths', "ALTER TABLE projects ADD COLUMN shot_widths TEXT NOT NULL DEFAULT '1440,390'"],
  ['projects', 'shot_themes', "ALTER TABLE projects ADD COLUMN shot_themes TEXT NOT NULL DEFAULT 'light'"],
  ['projects', 'shots_required', 'ALTER TABLE projects ADD COLUMN shots_required INTEGER NOT NULL DEFAULT 1'],
  ['projects', 'msg_loop_limit', 'ALTER TABLE projects ADD COLUMN msg_loop_limit INTEGER NOT NULL DEFAULT 6'],
  ['projects', 'msg_loop_min', 'ALTER TABLE projects ADD COLUMN msg_loop_min INTEGER NOT NULL DEFAULT 10'],
  ['projects', 'msg_cold_min', 'ALTER TABLE projects ADD COLUMN msg_cold_min INTEGER NOT NULL DEFAULT 55'],
  ['projects', 'msg_hold_h', 'ALTER TABLE projects ADD COLUMN msg_hold_h INTEGER NOT NULL DEFAULT 3'],
  ['projects', 'msg_never_hold', "ALTER TABLE projects ADD COLUMN msg_never_hold TEXT NOT NULL DEFAULT ''"],
  ['projects', 'shot_note', "ALTER TABLE projects ADD COLUMN shot_note TEXT NOT NULL DEFAULT ''"],
  // Today's behaviour by default (#1043): Citadel ships it, a go from high, no try first. shippingFromRules moves the PR schemes.
  ['projects', 'ship_path', "ALTER TABLE projects ADD COLUMN ship_path TEXT NOT NULL DEFAULT 'citadel'"],
  ['projects', 'go_from', "ALTER TABLE projects ADD COLUMN go_from TEXT NOT NULL DEFAULT 'high'"],
  ['projects', 'try_first', "ALTER TABLE projects ADD COLUMN try_first TEXT NOT NULL DEFAULT 'never'"],
  ['projects', 'rules_review', 'ALTER TABLE projects ADD COLUMN rules_review INTEGER NOT NULL DEFAULT 0'],
  ['projects', 'skills_off', "ALTER TABLE projects ADD COLUMN skills_off TEXT NOT NULL DEFAULT ''"],
  ['tickets', 'person_id', 'ALTER TABLE tickets ADD COLUMN person_id INTEGER REFERENCES users(id) ON DELETE SET NULL'],
  ['tickets', 'parent', 'ALTER TABLE tickets ADD COLUMN parent INTEGER'],
  // No REFERENCES: ON DELETE SET NULL would turn a removed person's Taskmaster into a second Overlord, which one_coordinator refuses.
  ['tickets', 'coordinator_of', 'ALTER TABLE tickets ADD COLUMN coordinator_of INTEGER'],
  ['machines', 'notes', "ALTER TABLE machines ADD COLUMN notes TEXT NOT NULL DEFAULT ''"],
  ['machines', 'workspace_tools', 'ALTER TABLE machines ADD COLUMN workspace_tools INTEGER NOT NULL DEFAULT 0'],
  ['machines', 'scoped', 'ALTER TABLE machines ADD COLUMN scoped INTEGER NOT NULL DEFAULT 0'],
  ['machines', 'owner_id', 'ALTER TABLE machines ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL'],
  ['machines', 'mcp_kind', 'ALTER TABLE machines ADD COLUMN mcp_kind TEXT'],
  ['machines', 'mcp_command', "ALTER TABLE machines ADD COLUMN mcp_command TEXT NOT NULL DEFAULT ''"],
  ['machines', 'always_on', 'ALTER TABLE machines ADD COLUMN always_on INTEGER NOT NULL DEFAULT 1'],
  ['machines', 'last_check', 'ALTER TABLE machines ADD COLUMN last_check TEXT'],
  ['machines', 'lend', 'ALTER TABLE machines ADD COLUMN lend TEXT'],
  ['turns', 'payer', 'ALTER TABLE turns ADD COLUMN payer INTEGER'],
  ['turns', 'prompt_digest', 'ALTER TABLE turns ADD COLUMN prompt_digest TEXT'],
  ['turns', 'keepalive', 'ALTER TABLE turns ADD COLUMN keepalive INTEGER'],
  ['turns', 'account', 'ALTER TABLE turns ADD COLUMN account INTEGER'],
  ['turns', 'side', 'ALTER TABLE turns ADD COLUMN side INTEGER'],
  ['contraptions', 'relay_paths', "ALTER TABLE contraptions ADD COLUMN relay_paths TEXT NOT NULL DEFAULT '[]'"],
  ['contraptions', 'repo', 'ALTER TABLE contraptions ADD COLUMN repo TEXT'],
  ['contraptions', 'branch', 'ALTER TABLE contraptions ADD COLUMN branch TEXT'],
  ['contraptions', 'folder', 'ALTER TABLE contraptions ADD COLUMN folder TEXT'],
  ['contraptions', 'restart_risk', "ALTER TABLE contraptions ADD COLUMN restart_risk TEXT NOT NULL DEFAULT 'unassessed'"],
  ['contraptions', 'restart_note', "ALTER TABLE contraptions ADD COLUMN restart_note TEXT NOT NULL DEFAULT ''"],
  ['push_subscriptions', 'only_pinned', 'ALTER TABLE push_subscriptions ADD COLUMN only_pinned INTEGER NOT NULL DEFAULT 0'],
  ['push_subscriptions', 'everything', "ALTER TABLE push_subscriptions ADD COLUMN everything TEXT NOT NULL DEFAULT '[]'"],
];

/**
 * The database's shape, kept in the `schema_version` setting. Add a line to SCHEMA_HISTORY below (the next number, what changed) with any change to SCHEMA or
 * MIGRATIONS, or a one-off rewrite of data, so an older release that opens the database (a rollback)
 * knows a newer one has been at it. test/schema-compat.test.ts checks the last release still opens it.
 */
export const SCHEMA_HISTORY = [
  [2, 'claude_state moved to state.db'],
  [3, 'brief_starts'],
  [4, 'saved_views'],
  [5, 'person_notes'],
  [6, 'projects.machine_tools'],
  [7, 'app_instruction_history'],
  [8, 'shared_pins'],
  [9, 'artifact_data'],
  [10, 'projects.onboarding'],
  [11, 'projects.github_error'],
  [12, 'ticket_pins'],
  [13, 'users, project_members, projects.owner_id'],
  [14, 'credentials, tickets.person_id'],
  [15, 'person_views replaces saved_views'],
  [16, 'push_subscriptions.only_pinned'],
  [17, 'server_login only for its owner (#213)'],
  [18, 'project_hides'],
  [19, 'contraptions, contraption_users'],
  [20, 'contraption_sessions, contraption_turns'],
  [21, 'projects.list_groups, type: other backfill'],
  [22, 'contraptions.relay_paths'],
  [23, 'contraptions.repo, branch, folder'],
  [24, 'tickets.parent'],
  [25, 'machines.scoped (#303)'],
  [26, 'machines.owner_id (#306)'],
  [27, 'machines.mcp_kind, mcp_command (#308)'],
  [28, 'repo_collaborators (#310)'],
  [29, 'memory_chunks (#331)'],
  [30, 'tickets.workflow (#359)'],
  [31, 'projects.optional_plugin_dirs, tickets.plugin_dirs (#361)'],
  [32, 'schedules.model, effort (#387)'],
  [33, 'machines.always_on, last_check (#437)'],
  [34, 'one lending list per machine, projects.machine_tools unread, machines.scoped read only for a CI runner host (#438)'],
  [35, 'machines.lend (#439)'],
  [36, 'turns.payer (#468 S05-3)'],
  [37, 'project_seen_counts (#498)'],
  [38, 'project_seen_items (#539)'],
  [39, 'last_actions (#538)'],
  [40, 'runner_load (#534)'],
  [41, 'step_times (#571)'],
  [42, 'releases (#625)'],
  [43, 'contraption_deploys (#627)'],
  [44, 'list_orders (#649)'],
  [45, 'ci_files (#658)'],
  [46, 'apk_publishes (#663)'],
  [47, 'projects.ci_quiet (#678)'],
  [48, 'personal_instructions (#688)'],
  [49, 'push_subscriptions.everything (#690)'],
  [50, 'openrouter_calls (#717)'],
  [51, 'health_events (#724)'],
  [52, 'schedules.min_minions, gate_scope, last_skip, once (#745)'],
  [53, 'events_cards partial index (#759)'],
  [54, 'card_fates (#762)'],
  [55, 'projects.ci_watch (#774)'],
  [56, 'schedules.template, notes; standard audits backfill (#799)'],
  [57, 'contraption_errors (#835)'],
  [58, 'outside_spend (#839)'],
  [59, 'contraption_turn_audit (#844)'],
  [60, 'stored_secrets (#838)'],
  [61, 'turns.keepalive (#862)'],
  [62, 'turns.prompt_digest (#878)'],
  [63, 'tickets.coordinator_of, one_coordinator per person, ticket_touches, taskmaster_digest (#919)'],
  [64, 'claims (#921)'],
  [65, 'turns.side (#932)'],
  [66, 'machine_jobs, machine_job_kinds, machines.jobs and job_settings (#857)'],
  [67, 'turn_grunts (#948)'],
  [68, 'contraptions.static_paths (#987)'],
  [69, "drop Peek Auras' Windows Builds 1277-1291 recorded live before PCs could take them (#1019)"],
  [70, 'projects.land_mode (#1017)'],
  [71, 'projects.fable_ok, builds, grill, gh_runners (#1045)'],
  [72, 'projects.shot_widths, shot_themes, shots_required, shot_note (#1044)'],
  [73, 'projects.ship_path, go_from, try_first; schemes whose merges wait for a person start on pr-person (#1043)'],
  [74, 'tickets.picked_because (#1061)'],
  [75, 'projects.msg_loop_limit, msg_loop_min, msg_cold_min, msg_hold_h (#1059)'],
  [76, 'projects.rules_review (#1046)'],
  [77, 'flake_events (#1063)'],
  [78, 'projects.skills_off (#1062)'],
  [79, 'tickets.closed_at, backfilled from the close notes (#1072)'],
  [80, 'projects.msg_never_hold (#1067)'],
  [81, 'review_entries, review_versions, review_runs, review_verdicts; repo rubric files imported once (#1051, #1054)'],
  [82, 'schedules.category, backfilled from template and name (#1083)'],
  [83, 'review_runs.source (#1095)'],
  [84, 'events_errors index (#1178)'],
  [85, 'ticket_picks (#1061)'],
  [86, 'memory_proposals (#1111)'],
  [87, 'ship_lessons (#1119)'],
  [88, 'minion_index and handoff_index, full-text (#1156)'],
  [89, 'ideas (#1150)'],
  [90, 'flake_fixes (#1120)'],
  [91, 'review_refutes (#1158)'],
  [92, 'contraptions.subdir (#1136)'],
  [93, 'contraption_push_devices (#1138)'],
  [94, 'host_samples (#1123)'],
  [95, 'tickets.goal (#1130)'],
  [96, 'events_notes and events_asks indexes (#1251)'],
  [97, 'project_minimizes (#1243)'],
  [98, 'host_samples.cpu_psi, mem_psi (#1301)'],
  [99, 'usage_counts (#1306)'],
  [100, 'host_samples.io_psi, swap_used (#1325)'],
  [101, 'claim_queue, claim_spans (#1334)'],
  [102, 'host_samples.cpu_ledger (#1332)'],
  [103, 'machines.token_sealed (#1355)'],
  [104, 'deliveries (#1385)'],
  [105, 'ci_numbers, ci_number_steps (#1369)'],
  [106, 'flake_events.test_name, message, class (#1438)'],
  [107, 'host_samples cache-health columns (#1501)'],
  [108, 'events moved to events.db; the main file keeps them as events_old (#1169)'],
  [109, 'host_samples warm_ms, warm_mb, warm_backoffs (#1560)'],
  [110, 'host_samples.answer_time (#1559)'],
  [111, 'events_old dropped and the main file vacuumed, by the server at start (#1169 ship 3)'],
  [112, 'contraptions.restart_risk, restart_note and contraption_runs (#1682)'],
  [113, 'slow_moments (#1752)'],
  [114, 'host_samples open_fds, supervisors, tmp_used, app_mem (#1762)'],
  [115, "schedules.trigger_kind, trigger_count, trigger_gap_hours; standard audits' rows take their template's trigger (#1798)"],
] as const;
export const SCHEMA_VERSION = SCHEMA_HISTORY.at(-1)![0];

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

/** A finished step as public/progress.js applyEvent collects it (#571). */
export type FinishedStep = { id: string; subject: string; estimate: number | null; startedAt: number; finishedAt: number; work: number; model: string | null };

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
export interface SkillEvent { id: number; ticket_id: number; at: number; skills: string | null; agents: string | null; edit: number; error: number; ship: number; result: number; grunt: number }
/** A minion in skillTimeline (src/skills.ts): its type property and the id of its newest "Shipped" note in the window (null if none). */
export interface SkillTicket { id: number; project_id: number; number: number | null; title: string; kind: string; type: string | null; shipped: number | null }
export interface SkillTimeline { events: SkillEvent[]; tickets: SkillTicket[] }

export class Store {
  db: DatabaseSync;
  /** The property registry and the properties minions and artifacts carry. */
  props: Registry;
  /** Scheduled minions (src/schedules.ts). */
  schedules: Schedules;
  /** Each scheme's reviewers and critics (src/review-set.ts, Build 4). */
  reviews: ReviewSet;
  /** Single-holder duties such as the pipeline lane (src/claims.ts, #921). */
  claims: Claims;
  /** Three lines after every ship, per scheme (src/ship-lessons.ts, #1119). */
  lessons: ShipLessons;
  /** The ideas ledger, per scheme (src/ideas.ts, #1150). */
  ideas: Ideas;
  /** What gets used, by day (src/usage-ledger.ts, #1306). */
  usage: UsageLedger;
  /** Semantic memory: chunks of the chats and their embeddings (src/memory.ts, #331). */
  memory: Memory;
  /** Past minions and handoffs, full-text, for search_minions and the scout (src/minion-index.ts, #1156). */
  minionIndex: MinionIndex;
  /** The memory curator's proposals, waiting on a member (src/memory-curator.ts, #1111). */
  memoryProposals: MemoryProposals;
  /** The database file; the runner keeps its turn folders beside it. */
  readonly path: string;

  /** `writer`: the write worker's own connection (src/db-writer.ts) to a database the server's Store already set up, so no setup or migrations.
   *  `reader`: the same, opened read-only by SQLite, for a reader thread (src/reader.ts): any write throws. */
  constructor(path: string, opts: { writer?: boolean; reader?: boolean } = {}) {
    this.path = path;
    // Wait out another connection's write (a test's second Store, a backup) instead of failing at once with SQLITE_BUSY.
    // The writer waits longer: it waits on its own thread, and giving up loses the write.
    this.db = new DatabaseSync(path, { timeout: opts.writer ? 30_000 : 5000, readOnly: !!opts.reader });
    // NORMAL: in WAL mode it fsyncs at checkpoints, not on every commit, which a busy disk made cost 150-300 ms
    // each. A power cut can lose the last few seconds of writes; an app crash loses nothing (#470, Cara 2026-11-10).
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
    // FAST zeroes a freed cell's bytes inside its page at no extra I/O: an update, a REPLACE or a page split left the old
    // cell's text in the page's free space, so a swept audit row's prompt outlived the sweep (#844, #836). dropAudit
    // turns it fully on, which also zeroes whole freed pages, a cost the 1.3 GB database's other prunes don't need.
    this.db.exec('PRAGMA main.secure_delete = FAST;');
    if (opts.writer || opts.reader) {
      this.db.prepare('ATTACH DATABASE ? AS state').run(this.statePath);
      this.db.exec('PRAGMA state.synchronous = NORMAL; PRAGMA main.journal_size_limit = 16777216; PRAGMA state.journal_size_limit = 16777216;');
      this.db.prepare(`ATTACH DATABASE ? AS ${CHAT}`).run(this.eventsPath);
      this.db.exec(`PRAGMA ${CHAT}.synchronous = NORMAL; PRAGMA ${CHAT}.journal_size_limit = 16777216;`);
      if (!opts.reader && eventsHome(this.db) === CHAT) this.db.exec(cardFatesTrigger(CHAT)); // a TEMP trigger is this connection's own
      this.props = new Registry(this.db);
      this.schedules = new Schedules(this.db, (at) => this.eventIdAt(at));
      this.reviews = new ReviewSet(this.db);
      this.claims = new Claims(this.db);
    this.lessons = new ShipLessons(this.db);
    this.ideas = new Ideas(this.db);
    this.usage = new UsageLedger(this.db);
      this.memory = new Memory(this);
      this.minionIndex = new MinionIndex(this);
      this.memoryProposals = new MemoryProposals(this.db);
      return;
    }
    // Setup commits once per block, not once per statement: each commit is an fsync, and a new database's
    // hundred of them took a boot past 15 s when the disk was busy (#426).
    const events = this.attachEvents();
    this.db.exec(`BEGIN IMMEDIATE; ${SCHEMA} ${MEMORY_PROPOSALS_SCHEMA} ${MINION_INDEX_SCHEMA} ${eventsSchema(events)} ${cardFatesTrigger(events)} COMMIT;`);
    this.attachState();
    this.moveSharedViews();
    this.db.exec('BEGIN IMMEDIATE'); // IMMEDIATE: a read-then-write transaction can't take a write lock once another connection has written
    for (const [table, column, ddl] of MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.db.exec(ddl);
    }
    // One Taskmaster per person and one Overlord per scheme (#919). The name stays, so an older release's IF NOT EXISTS skips it.
    const idx = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'one_coordinator'").get() as { sql: string } | undefined;
    if (idx && !idx.sql.includes('coordinator_of')) this.db.exec('DROP INDEX one_coordinator');
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_coordinator ON tickets(project_id, coalesce(coordinator_of, 0)) WHERE kind = 'coordinator'");
    this.db.exec('COMMIT');
    this.numberTickets();
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ticket_number ON tickets(project_id, number)');
    this.props = new Registry(this.db);
    this.props.seed();
    this.settleBuilds();
    this.schedules = new Schedules(this.db, (at) => this.eventIdAt(at));
    this.reviews = new ReviewSet(this.db);
    this.claims = new Claims(this.db);
    this.lessons = new ShipLessons(this.db);
    this.ideas = new Ideas(this.db);
    this.usage = new UsageLedger(this.db);
    this.memory = new Memory(this);
    this.minionIndex = new MinionIndex(this);
    this.memoryProposals = new MemoryProposals(this.db);
    this.serverLoginOwnerOnly();
    this.groupByType();
    this.dropEarlyPeekAurasBuilds();
    this.closedAtFromNotes();
    if ((this.getSetting<number>('schema_version') ?? 0) < 82) this.schedules.categorize();
    this.shippingFromRules();
    this.lendingLists();
    this.noteSchemaVersion();
  }

  /**
   * Attach events.db, the chat log's own file (#1169), moving the events there from the main file if they are still in
   * it. A new database starts its chat log there. One marked moved whose events.db has no events refuses to open:
   * starting on an empty chat log would bury the real one.
   */
  private attachEvents(): typeof CHAT {
    attachEventsForWrite(this.db, this.eventsPath ?? ':memory:');
    if (eventsHome(this.db) === 'main') moveEvents(this.db, this.eventsPath ?? ':memory:'); // the server moves them on a worker first (moveEventsOffThread)
    if (eventsHome(this.db) !== CHAT && eventsMoved(this.db)) throw new Error(`This database's chat log moved to ${this.eventsPath}, which has no events table: put events.db back from backups/ (events-<day>.db) before starting, or run tools/events-unsplit.ts on a copy taken before the move.`);
    return CHAT;
  }

  /**
   * Attach state.db (claude_state's home), and move claude_state there from the main file if it is
   * still in it: from before state.db, created by an older release after a rollback, or in a restored
   * backup. Copy, then drop, as two commits: SQLite doesn't commit two WAL
   * files as one, so a crash in between leaves the rows in both and the next start repeats it.
   */
  private attachState() {
    this.db.prepare('ATTACH DATABASE ? AS state').run(this.statePath ?? ':memory:');
    // auto_vacuum only takes before the file's first table, so a new state.db gets it, so the file can shrink when a vacuum is run on it.
    this.db.exec('PRAGMA state.auto_vacuum = INCREMENTAL; PRAGMA state.journal_mode = WAL; PRAGMA state.synchronous = NORMAL;');
    // A WAL file keeps its biggest size unless capped: the move alone grew state.db's to its whole size.
    this.db.exec('PRAGMA main.journal_size_limit = 16777216; PRAGMA state.journal_size_limit = 16777216;');
    this.db.exec(`BEGIN IMMEDIATE; ${STATE_SCHEMA} COMMIT;`);
    if (!this.db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'claude_state'").get()) return;
    const cols = 'path, project_id, ticket_id, size, mtime, data';
    // The newer copy of each file wins: an older release's after a rollback, state.db's after restoring an old backup.
    this.db.exec(`BEGIN; INSERT INTO state.claude_state (${cols}) SELECT ${cols} FROM main.claude_state WHERE true
      ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, ticket_id = excluded.ticket_id, size = excluded.size,
        mtime = excluded.mtime, data = excluded.data WHERE excluded.mtime > claude_state.mtime; COMMIT;`);
    this.db.exec('DROP TABLE main.claude_state');
    // Minions an older release deleted meanwhile cleared only its own table.
    this.db.exec('DELETE FROM state.claude_state WHERE ticket_id IS NOT NULL AND ticket_id NOT IN (SELECT id FROM main.tickets)');
    this.db.exec('VACUUM main'); // hand the freed pages back, so the main file shrinks
  }

  /**
   * Saved views were shared by the scheme until #194: each becomes its saver's own. An older release
   * after a rollback makes saved_views again, so this runs whenever it's there; a name its saver
   * already has keeps theirs.
   */
  private moveSharedViews() {
    if (!this.db.prepare("SELECT 1 FROM main.sqlite_master WHERE type = 'table' AND name = 'saved_views'").get()) return;
    this.db.exec(`BEGIN; INSERT INTO person_views (project_id, owner, name, picks, created_at)
      SELECT project_id, created_by, name, picks, created_at FROM saved_views WHERE true ON CONFLICT DO NOTHING;
      DROP TABLE saved_views; COMMIT;`);
  }

  /**
   * The server's Claude login is one person's subscription (#213): from schema 17 only its owner runs
   * on it, and everyone else links their own Claude. Once, so a later grant isn't undone.
   */
  private serverLoginOwnerOnly() {
    if ((this.getSetting<number>('schema_version') ?? 0) >= 17) return;
    this.db.prepare('UPDATE users SET server_login = 0 WHERE id IS NOT (SELECT min(id) FROM users WHERE admin = 1)').run();
  }

  /** The list groups by type from 21 (#253), once: every minion gets one, and Delve promotes its balance work. */
  private groupByType() {
    if ((this.getSetting<number>('schema_version') ?? 0) >= 21) return;
    this.props.backfillOther();
    this.db.prepare(`UPDATE projects SET list_groups = '["area: balance"]' WHERE name = 'Delve' AND list_groups = '[]'`).run();
  }

  /**
   * closed_at for minions dismissed before it was kept (#1072): the time of the last note a dismissal wrote
   * (runner.close's texts). One with no such note stays empty. Once, before 79.
   */
  private closedAtFromNotes() {
    if ((this.getSetting<number>('schema_version') ?? 0) >= 79) return;
    this.db.exec(`UPDATE tickets SET closed_at = (
        SELECT max(e.created_at) FROM events e WHERE e.ticket_id = tickets.id AND e.kind = 'note'
          AND (json_extract(e.data, '$.text') LIKE '% dismissed this minion.'
            OR json_extract(e.data, '$.text') LIKE 'Claude dismissed this minion%'
            OR json_extract(e.data, '$.text') LIKE 'Closed: % saw its result'
            OR json_extract(e.data, '$.text') LIKE 'Claude closed this ticket%'))
      WHERE status = 'closed' AND closed_at IS NULL`);
  }

  /**
   * Peek Auras' Windows Builds 1277-1291 were recorded live when windows.yml passed, before desktop.yml let PCs take them (#1019;
   * Cara, 2026-11-18: "Remove them"). Once, before 69, and only rows that are exactly those builds.
   */
  private dropEarlyPeekAurasBuilds() {
    if ((this.getSetting<number>('schema_version') ?? 0) >= 69) return;
    this.db.prepare(`DELETE FROM releases WHERE target = 'ci:windows:release' AND outcome = 'live'
      AND project_id IN (SELECT id FROM projects WHERE name = 'Peek Auras')
      AND version IN ('run:1277', 'run:1279', 'run:1282', 'run:1284', 'run:1286', 'run:1289', 'run:1291')`).run();
  }

  /**
   * Shipping's starting values (#1043; Josh, 2026-11-19, "Yes, use the table"): a scheme whose merges already wait for a
   * person's Approve (both merge rules stored: Delve and Threadspace) starts on "Pull request, a person merges", which is
   * a go on every change; the rest keep the columns' defaults. Once, before 73.
   */
  private shippingFromRules() {
    if ((this.getSetting<number>('schema_version') ?? 0) >= 73) return;
    this.db.prepare(`UPDATE projects SET ship_path = 'pr-person', go_from = 'all'
      WHERE instr(char(10) || approval_rules || char(10), char(10) || 'Bash(gh pr merge:*)' || char(10)) > 0
        AND instr(char(10) || approval_rules || char(10), char(10) || 'mcp__*__merge_pull_request' || char(10)) > 0`).run();
  }

  /** Whose subscription the server's own Claude login is: the first admin, the one Citadel made at its first start. */
  serverLoginOwner(): number | null {
    return (this.db.prepare('SELECT min(id) AS id FROM users WHERE admin = 1').get() as { id: number | null }).id;
  }

  /**
   * Lending becomes one list of schemes per machine (#438): each machine's machine_projects rows become exactly
   * the schemes whose minions got it under the old rules, so no scheme gains or loses one. The old rules: a scheme
   * needed projects.machine_tools on; a shared machine went to every scheme an admin owns, or (scoped) to its rows;
   * a person's own to the schemes its owner is in. A CI runner host is left as it is: it lends turns nothing, and
   * its runner tokens (ci-runner.ts mayFetch) still read its rows and scoped. Once, from schema 34; a shared machine
   * an older release left unscoped (a rollback) is converted whenever one is found. Not caught after a rollback:
   * a person's own machine added there starts lent to no scheme, and a scheme whose switch was turned off there
   * keeps its place on the lists. Says what it did, for the deploy's notes.
   */
  private lendingLists() {
    const first = (this.getSetting<number>('schema_version') ?? 0) < 34;
    const machines = (this.db.prepare('SELECT * FROM machines ORDER BY id').all() as unknown as Machine[]).filter((m) => first || (!m.scoped && m.owner_id === null));
    if (!machines.length) return;
    const schemes = this.db.prepare('SELECT id, name, machine_tools, owner_id FROM projects ORDER BY id').all() as { id: number; name: string; machine_tools: number; owner_id: number | null }[];
    const names = (ids: number[]) => ids.map((id) => schemes.find((p) => p.id === id)?.name ?? `scheme ${id}`).join(', ') || 'no scheme';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of machines) {
        if (/"runners":true/.test(m.last_check ?? '')) {
          // Left as it is, less the rows nothing read while it was unscoped: they would lend it if it ever stopped being a runner host.
          if (!m.scoped) this.db.prepare('DELETE FROM machine_projects WHERE machine_id = ?').run(m.id);
          continue;
        }
        const rows = this.machineProjects(m.id);
        const owner = m.owner_id === null ? undefined : this.getUser(m.owner_id);
        const ids = m.owner_id !== null
          ? schemes.filter((p) => p.machine_tools && owner && this.canSee({ uid: owner.id, admin: !!owner.admin }, p.id)).map((p) => p.id)
          : m.scoped
            ? rows.filter((id) => schemes.find((p) => p.id === id)?.machine_tools)
            : schemes.filter((p) => p.machine_tools && this.getUser(p.owner_id ?? -1)?.admin).map((p) => p.id);
        this.db.prepare('DELETE FROM machine_projects WHERE machine_id = ?').run(m.id);
        const add = this.db.prepare('INSERT INTO machine_projects (machine_id, project_id) VALUES (?, ?)');
        for (const id of ids) add.run(m.id, id);
        this.db.prepare('UPDATE machines SET scoped = 1 WHERE id = ?').run(m.id);
        const was = m.owner_id !== null ? `${owner?.name ?? 'its owner'}'s turns in the schemes they are in` : m.scoped ? `only ${names(rows)}` : 'every scheme an admin owns';
        console.log(`Lending lists (#438): ${m.name}: was ${was}, where machine tools are on; its list is now ${names(ids)}.`);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Records SCHEMA_VERSION, never lowering it: after a rollback, the newer number says what migrated it. */
  private noteSchemaVersion() {
    const stored = this.getSetting<number>('schema_version') ?? 0;
    if (stored > SCHEMA_VERSION) {
      console.warn(`The database is at schema version ${stored}, newer than this code's ${SCHEMA_VERSION}: a newer release migrated it. If something fails to read, backups/pre-deploy-*.db holds it from before that deploy.`);
    } else if (stored < SCHEMA_VERSION) this.setSetting('schema_version', SCHEMA_VERSION);
  }

  /**
   * Tickets used to be numbered by their global id. Give each project its own 1, 2, 3… in
   * creation order, and leave a note in every thread whose number changed.
   */
  private numberTickets() {
    const unnumbered = this.db
      .prepare("SELECT id, project_id FROM tickets WHERE kind = 'ticket' AND number IS NULL ORDER BY id")
      .all() as { id: number; project_id: number }[];
    if (!unnumbered.length) return;
    const changed = new Map<number, string[]>(); // project_id -> "#old is now #new"
    this.db.exec('BEGIN');
    try {
      for (const { id, project_id } of unnumbered) {
        const number = this.nextNumber(project_id);
        this.db.prepare('UPDATE tickets SET number = ? WHERE id = ?').run(number, id);
        if (number === id) continue;
        this.addEvent(id, 'note', { text: `Minions are now numbered per scheme. This minion is now #${number} (it was #${id}).` });
        changed.set(project_id, [...(changed.get(project_id) ?? []), `#${id} → #${number}`]);
      }
      for (const [projectId, moves] of changed) {
        const coordinator = this.getCoordinator(projectId);
        if (coordinator) this.addEvent(coordinator.id, 'note', { text: `Threads are now numbered per scheme: ${moves.join(', ')}.` });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Once (2026-10-29): the build column and the scheme's `build` property agree (the column wins
   * where both are set), and titles stop repeating the build ("Lairs · Build #8" becomes "Lairs").
   */
  private settleBuilds() {
    if (this.db.prepare("SELECT 1 FROM settings WHERE key = 'builds_settled'").get()) return;
    this.db.exec('BEGIN');
    try {
      const tickets = this.db.prepare("SELECT id, title, build FROM tickets WHERE kind = 'ticket'").all() as { id: number; title: string; build: number | null }[];
      for (const t of tickets) {
        const build = t.build ?? (Number(this.props.forTarget('minion', t.id).build) || null);
        if (build === null) continue;
        if (t.build === null) this.db.prepare('UPDATE tickets SET build = ? WHERE id = ?').run(build, t.id);
        else this.props.setBuild(t.id, build, 'migration');
        const title = titleWithoutBuild(t.title, build);
        if (title === t.title) continue;
        this.db.prepare('UPDATE tickets SET title = ? WHERE id = ?').run(title, t.id);
        this.addEvent(t.id, 'note', { text: `Citadel renamed this minion from "${t.title}" to "${title}": its build shows in the minions list, so the title no longer carries it.` });
      }
      this.db.prepare("INSERT INTO settings (key, value) VALUES ('builds_settled', ?)").run(JSON.stringify(Date.now()));
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name').all() as unknown as Project[];
  }

  getProject(id: number): Project | undefined {
    const p = scoped(this.db, `project:${id}`, () => this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as Project | undefined);
    return copyRow(p);
  }

  createProject(name: string, repoUrl: string | null, ownerId: number | null = null): Project {
    const r = this.db
      .prepare('INSERT INTO projects (name, repo_url, owner_id, created_at) VALUES (?, ?, ?, ?)')
      .run(name, repoUrl, ownerId, Date.now());
    return this.getProject(Number(r.lastInsertRowid))!;
  }

  setProjectRepoDir(id: number, dir: string) {
    this.db.prepare('UPDATE projects SET repo_dir = ? WHERE id = ?').run(dir, id);
  }

  /** Where a scheme's repo lives upstream, and why putting it on GitHub failed (null once it worked). */
  setProjectUpstream(id: number, repoUrl: string | null, githubError: string | null) {
    this.db.prepare('UPDATE projects SET repo_url = ?, github_error = ? WHERE id = ?').run(repoUrl, githubError, id);
  }

  /** Saves a scheme's instructions, with a history row of who changed them from what. */
  setProjectInstructions(id: number, instructions: string, by: string) {
    const at = Date.now();
    this.db.exec('BEGIN');
    try {
      const old = (this.db.prepare('SELECT instructions FROM projects WHERE id = ?').get(id) as { instructions: string } | undefined)?.instructions ?? '';
      this.db
        .prepare('UPDATE projects SET instructions = ?, instructions_updated_by = ?, instructions_updated_at = ? WHERE id = ?')
        .run(instructions, by, at, id);
      this.db.prepare('INSERT INTO instruction_history (project_id, by, at, old_text, new_text) VALUES (?, ?, ?, ?, ?)').run(id, by, at, old, instructions);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** A scheme's latest instruction saves, newest first. */
  instructionHistory(projectId: number, limit: number): { by: string; at: number; old_text: string; new_text: string }[] {
    return this.db
      .prepare('SELECT by, at, old_text, new_text FROM instruction_history WHERE project_id = ? ORDER BY id DESC LIMIT ?')
      .all(projectId, limit) as any[];
  }

  /** The Citadel-wide instructions every minion and Taskmaster in every scheme gets; '' when unset. */
  appInstructions(): AppInstructions {
    return this.getSetting<AppInstructions>(APP_INSTRUCTIONS) ?? { text: '', by: null, at: null };
  }

  /** Saves the Citadel-wide instructions, with a history row of who changed them from what. */
  setAppInstructions(text: string, by: string) {
    const at = Date.now();
    this.db.exec('BEGIN');
    try {
      const old = this.appInstructions().text;
      this.setSetting(APP_INSTRUCTIONS, { text, by, at });
      this.db.prepare('INSERT INTO app_instruction_history (by, at, old_text, new_text) VALUES (?, ?, ?, ?)').run(by, at, old, text);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** A person's own instructions for everywhere (projectId null) or one scheme, with when they last changed; '' when unset. */
  personalInstructions(userId: number, projectId: number | null): { text: string; at: number | null } {
    const r = this.db.prepare('SELECT new_text, at FROM personal_instructions WHERE user_id = ? AND project_id IS ? ORDER BY id DESC LIMIT 1')
      .get(userId, projectId) as { new_text: string; at: number } | undefined;
    return { text: r?.new_text ?? '', at: r?.at ?? null };
  }

  /** Saves a person's own instructions for one scope; the row is its history entry too. */
  setPersonalInstructions(userId: number, projectId: number | null, text: string) {
    const old = this.personalInstructions(userId, projectId).text;
    if (old === text) return;
    this.db.prepare('INSERT INTO personal_instructions (user_id, project_id, at, old_text, new_text) VALUES (?, ?, ?, ?, ?)').run(userId, projectId, Date.now(), old, text);
  }

  /** The personal layer of a minion's prompt (#688): its owner's (`assigned`) texts; null for the Taskmaster, nobody or no text. */
  personalLayer(ticket: Pick<Ticket, 'id' | 'kind' | 'project_id'>): PersonalLayer | null {
    if (ticket.kind === 'coordinator') return null;
    const assigned = String(this.props.forTarget('minion', ticket.id).assigned ?? '').trim();
    const name = assigned && this.props.personName(assigned);
    const user = name ? this.findUser('name', name) : undefined;
    if (!user) return null;
    const layer = { name: user.name, everywhere: this.personalInstructions(user.id, null).text, scheme: this.personalInstructions(user.id, ticket.project_id).text };
    return layer.everywhere || layer.scheme ? layer : null;
  }

  /** A person's latest saves for one scope, newest first. */
  personalInstructionHistory(userId: number, projectId: number | null, limit: number): { at: number; old_text: string; new_text: string }[] {
    return this.db.prepare('SELECT at, old_text, new_text FROM personal_instructions WHERE user_id = ? AND project_id IS ? ORDER BY id DESC LIMIT ?')
      .all(userId, projectId, limit) as any[];
  }

  /** The latest Citadel-wide instruction saves, newest first. */
  appInstructionHistory(limit: number): { by: string; at: number; old_text: string; new_text: string }[] {
    return this.db.prepare('SELECT by, at, old_text, new_text FROM app_instruction_history ORDER BY id DESC LIMIT ?').all(limit) as any[];
  }

  setProjectSettings(id: number, fields: Partial<Pick<Project, 'approval_rules' | 'plugin_dirs' | 'optional_plugin_dirs' | 'default_effort' | 'onboarding' | 'onboarding_mode' | 'list_groups' | 'ci_quiet' | 'ci_watch' | 'land_mode' | 'fable_ok' | 'builds' | 'grill' | 'gh_runners' | 'shot_widths' | 'shot_themes' | 'shots_required' | 'shot_note' | 'ship_path' | 'go_from' | 'try_first' | 'msg_loop_limit' | 'msg_loop_min' | 'msg_cold_min' | 'msg_hold_h' | 'msg_never_hold' | 'rules_review' | 'skills_off'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    // A setup round starts at interview, or when a closed one opens again: only plans approved after it count (#180).
    const was = this.getProject(id);
    if (fields.onboarding && onboardingOpen(fields as Pick<Project, 'onboarding'>) && (fields.onboarding === 'interview' || (was && !onboardingOpen(was)))) {
      this.setSetting(`onboarding_opened:${id}`, Date.now());
    }
    // Setup finishing opens the pass on Minion rules, whoever or whatever set it (#1046).
    if (fields.onboarding === 'done' && was && was.onboarding !== 'done' && fields.rules_review === undefined) fields = { ...fields, rules_review: 1 };
    const keys2 = Object.keys(fields) as (keyof typeof fields)[];
    this.db.prepare(`UPDATE projects SET ${keys2.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys2.map((k) => fields[k] ?? ''), id);
    // Setup reaching done books the first-week check, seven days out, in that scheme (#1101).
    if (fields.onboarding === 'done' && was && was.onboarding !== 'done') scheduleFirstWeek(this, id);
  }

  /** When this scheme's current setup or tune-up round opened, or 0 for one opened before that was recorded. */
  onboardingOpenedAt(id: number): number {
    return this.getSetting<number>(`onboarding_opened:${id}`) ?? 0;
  }

  /** Change a project's display name; its repo, folders and links go by id and stay put. */
  renameProject(id: number, name: string): Project {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('The scheme name cannot be empty');
    try {
      this.db.prepare('UPDATE projects SET name = ? WHERE id = ?').run(trimmed, id);
    } catch (err: any) {
      if (/UNIQUE/.test(err.message)) throw new Error(`There is already a scheme called "${trimmed}"`);
      throw err;
    }
    return this.getProject(id)!;
  }

  listUsers(): User[] {
    return this.db.prepare('SELECT * FROM users ORDER BY id').all() as unknown as User[];
  }

  getUser(id: number): User | undefined {
    const u = scoped(this.db, `user:id:${id}`, () => this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as User | undefined);
    return copyRow(u);
  }

  /** By login, name or open invite, either case: cookies from the shared-password days carry only the name. */
  findUser(field: 'login' | 'name' | 'invite_hash', value: string): User | undefined {
    const u = scoped(this.db, `user:${field}:${value}`, () => this.db.prepare(`SELECT * FROM users WHERE ${field} = ?`).get(value) as unknown as User | undefined);
    return copyRow(u);
  }

  /** A new person gets an id no one has ever had: a removed person's cookie names their id (#468 S05-1). */
  createUser(u: Pick<User, 'name' | 'login'> & { admin?: boolean; server_login?: boolean }): User {
    const { max } = this.db.prepare('SELECT COALESCE(MAX(id), 0) AS max FROM users').get() as { max: number };
    const id = Math.max(this.getSetting<number>('user_id_high') ?? 0, max) + 1;
    this.db
      .prepare('INSERT INTO users (id, name, login, admin, server_login, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, u.name, u.login, u.admin ? 1 : 0, u.server_login ? 1 : 0, Date.now());
    this.setSetting('user_id_high', id);
    return this.getUser(id)!;
  }

  updateUser(id: number, fields: Partial<Omit<User, 'id' | 'login' | 'admin' | 'created_at'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  }

  /** Remove a person: their schemes go to `heir`, their memberships with them, and their machines to no one (#306). Their messages keep their name. */
  deleteUser(id: number, heir: number) {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE projects SET owner_id = ? WHERE owner_id = ?').run(heir, id);
      // Ownerless and lent to no scheme, so a gone person's computer reaches no one's turns; an admin removes it.
      this.db.prepare('DELETE FROM machine_projects WHERE machine_id IN (SELECT id FROM machines WHERE owner_id = ?)').run(id);
      this.db.prepare('UPDATE machines SET owner_id = NULL, scoped = 1 WHERE owner_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
      // People added before user_id_high existed: remember the removed id so it is never reused.
      if (id > (this.getSetting<number>('user_id_high') ?? 0)) this.setSetting('user_id_high', id);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getCredential(userId: number, kind: string): CredentialRow | undefined {
    return this.db.prepare('SELECT * FROM credentials WHERE user_id = ? AND kind = ?').get(userId, kind) as CredentialRow | undefined;
  }

  listCredentials(kind: string): CredentialRow[] {
    return this.db.prepare('SELECT * FROM credentials WHERE kind = ?').all(kind) as unknown as CredentialRow[];
  }

  putCredential(userId: number, kind: string, secret: string, meta: object) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO credentials (user_id, kind, secret, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, kind) DO UPDATE SET secret = excluded.secret, meta = excluded.meta, updated_at = excluded.updated_at, failed_at = NULL`)
      .run(userId, kind, secret, JSON.stringify(meta), now, now);
  }

  getSecret(scope: string, ownerId: number, name: string): SecretRow | undefined {
    return this.db.prepare('SELECT * FROM stored_secrets WHERE scope = ? AND owner_id = ? AND name = ?').get(scope, ownerId, name) as SecretRow | undefined;
  }

  /** One owner's secrets, by name. */
  listSecrets(scope: string, ownerId: number): SecretRow[] {
    return this.db.prepare('SELECT * FROM stored_secrets WHERE scope = ? AND owner_id = ? ORDER BY name').all(scope, ownerId) as unknown as SecretRow[];
  }

  putSecret(scope: string, ownerId: number, name: string, value: string, by: number | null) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO stored_secrets (scope, owner_id, name, value, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, owner_id, name) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(scope, ownerId, name, value, by, now, now);
  }

  deleteSecret(scope: string, ownerId: number, name: string): boolean {
    return this.db.prepare('DELETE FROM stored_secrets WHERE scope = ? AND owner_id = ? AND name = ?').run(scope, ownerId, name).changes > 0;
  }

  /** The account refused it (revoked, or it can't be decrypted): kept, so Settings can say "link again". */
  failCredential(userId: number, kind: string) {
    this.db.prepare('UPDATE credentials SET failed_at = ? WHERE user_id = ? AND kind = ? AND failed_at IS NULL').run(Date.now(), userId, kind);
  }

  deleteCredential(userId: number, kind: string) {
    this.db.prepare('DELETE FROM credentials WHERE user_id = ? AND kind = ?').run(userId, kind);
  }

  /** What a person's OpenRouter calls since `since` count against their cap: real costs, and estimates where it isn't known. */
  openrouterSpent(userId: number, since: number): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(CASE status WHEN 'ok' THEN cost_usd WHEN 'failed' THEN 0 ELSE estimate_usd END), 0) AS spent
      FROM openrouter_calls WHERE user_id = ? AND created_at >= ?`).get(userId, since) as { spent: number };
    return row.spent;
  }

  addOpenrouterCall(c: { user_id: number; ticket_id: number | null; project_id: number | null; model: string; kind: OpenrouterCallKind; estimate_usd: number }): number {
    return Number(this.db.prepare(`INSERT INTO openrouter_calls (user_id, ticket_id, project_id, model, kind, estimate_usd, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`).run(c.user_id, c.ticket_id, c.project_id, c.model, c.kind, c.estimate_usd, Date.now()).lastInsertRowid);
  }

  finishOpenrouterCall(id: number, status: 'ok' | 'failed' | 'unknown', cost: number | null) {
    this.db.prepare('UPDATE openrouter_calls SET status = ?, cost_usd = ?, finished_at = ? WHERE id = ?').run(status, cost, Date.now(), id);
  }

  setOpenrouterCallPath(id: number, path: string) {
    this.db.prepare('UPDATE openrouter_calls SET path = ? WHERE id = ?').run(path, id);
  }

  /** At boot, calls still pending died with the last server: they may have been billed, so they count at their estimate. */
  sweepOpenrouterCalls() {
    this.db.prepare(`UPDATE openrouter_calls SET status = 'unknown', finished_at = ? WHERE status = 'pending'`).run(Date.now());
  }

  /** Schemes from before owners (and any whose owner is gone) become this admin's. */
  adoptOwnerless(adminId: number) {
    this.db.prepare('UPDATE projects SET owner_id = ? WHERE owner_id IS NULL OR owner_id NOT IN (SELECT id FROM users)').run(adminId);
  }

  /** A scheme's people: the owner first, then members in the order they were added. */
  listMembers(projectId: number): (Pick<User, 'id' | 'name' | 'login'> & { owner: boolean })[] {
    return (this.db.prepare(`SELECT u.id, u.name, u.login, u.id = p.owner_id AS owner FROM users u JOIN projects p ON p.id = ?
      LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = u.id
      WHERE u.id = p.owner_id OR m.user_id IS NOT NULL ORDER BY owner DESC, m.added_at`).all(projectId) as any[]).map((r) => ({ ...r, owner: !!r.owner }));
  }

  addMember(projectId: number, userId: number) {
    this.db.prepare('INSERT OR IGNORE INTO project_members (project_id, user_id, added_at) VALUES (?, ?, ?)').run(projectId, userId, Date.now());
  }

  removeMember(projectId: number, userId: number) {
    this.db.prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, userId);
  }

  /** What Citadel did on GitHub for scheme members (src/repo-access.ts): one row, or all of them. */
  getRepoCollaborator(projectId: number, userId: number): RepoCollaborator | undefined {
    return this.db.prepare('SELECT * FROM repo_collaborators WHERE project_id = ? AND user_id = ?').get(projectId, userId) as unknown as RepoCollaborator | undefined;
  }

  listRepoCollaborators(): RepoCollaborator[] {
    return this.db.prepare('SELECT * FROM repo_collaborators').all() as unknown as RepoCollaborator[];
  }

  putRepoCollaborator(r: Omit<RepoCollaborator, 'updated_at'>) {
    this.db.prepare(`INSERT INTO repo_collaborators (project_id, user_id, slug, login, state, invitation_id, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, user_id) DO UPDATE SET slug = excluded.slug, login = excluded.login, state = excluded.state,
        invitation_id = excluded.invitation_id, error = excluded.error, updated_at = excluded.updated_at`)
      .run(r.project_id, r.user_id, r.slug, r.login, r.state, r.invitation_id, r.error, Date.now());
  }

  deleteRepoCollaborator(projectId: number, userId: number) {
    this.db.prepare('DELETE FROM repo_collaborators WHERE project_id = ? AND user_id = ?').run(projectId, userId);
  }

  /**
   * Whether a person counts as a Citadel admin: the admin flag, or being in the Citadel scheme (#621, Cara 2026-11-12:
   * "any scheme member should have access to everything they need"). Admin gates, sessions and canSee read this; the
   * bare flag is left for whose GitHub owns new schemes' repos and who gets admins' push alerts.
   */
  isAdmin(user: Pick<User, 'id' | 'admin' | 'disabled_at'> | undefined | null): boolean {
    return !!user && !user.disabled_at && (!!user.admin || this.inScheme(user.id, GLOBAL_OWNER));
  }

  /** Whether a person owns or is a member of a scheme (no admin shortcut). */
  private inScheme(uid: number | undefined, projectId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM projects WHERE id = ?1 AND owner_id = ?2
      UNION SELECT 1 FROM project_members WHERE project_id = ?1 AND user_id = ?2`).get(projectId, uid ?? -1);
  }

  /** The schemes a person is in, as owner or member; null for an admin (isAdmin's sense), who is in all of them. */
  visibleProjects(who: { uid?: number; admin?: boolean }): Set<number> | null {
    if (who.admin || this.inScheme(who.uid, GLOBAL_OWNER)) return null;
    const rows = this.db.prepare(`SELECT id FROM projects WHERE owner_id = ?1
      UNION SELECT project_id FROM project_members WHERE user_id = ?1`).all(who.uid ?? -1) as { id: number }[];
    return new Set(rows.map((r) => r.id));
  }

  /** The schemes a person owns or is a member of, admin or not: the Releases page's All view (#625). */
  memberSchemes(uid: number | undefined): Set<number> {
    const rows = scoped(this.db, `member-schemes:${uid ?? -1}`, () => this.db.prepare(`SELECT id FROM projects WHERE owner_id = ?1
      UNION SELECT project_id FROM project_members WHERE user_id = ?1`).all(uid ?? -1) as { id: number }[]);
    return new Set(rows.map((r) => r.id));
  }

  /** Whether a person may see a scheme: an admin (a Citadel member too: isAdmin), its owner, or a member. */
  canSee(who: { uid?: number; admin?: boolean }, projectId: number): boolean {
    return !!who.admin || this.inScheme(who.uid, projectId) || this.inScheme(who.uid, GLOBAL_OWNER);
  }

  listContraptions(): ContraptionRow[] {
    return this.db.prepare('SELECT * FROM contraptions ORDER BY title COLLATE NOCASE').all() as unknown as ContraptionRow[];
  }

  getContraption(name: string): ContraptionRow | undefined {
    return this.db.prepare('SELECT * FROM contraptions WHERE name = ?').get(name) as unknown as ContraptionRow | undefined;
  }

  /** The contraption a bearer key's hash belongs to. */
  contraptionByKeyHash(hash: string): ContraptionRow | undefined {
    return this.db.prepare('SELECT * FROM contraptions WHERE key_hash = ?').get(hash) as unknown as ContraptionRow | undefined;
  }

  createContraption(c: Omit<ContraptionRow, 'id' | 'created_at'>): ContraptionRow {
    const keys = Object.keys(c) as (keyof typeof c)[];
    this.db.prepare(`INSERT INTO contraptions (${keys.join(', ')}, created_at) VALUES (${keys.map(() => '?').join(', ')}, ?)`)
      .run(...keys.map((k) => c[k] ?? null), Date.now());
    return this.getContraption(c.name)!;
  }

  updateContraption(name: string, fields: Partial<Omit<ContraptionRow, 'id' | 'name' | 'created_at'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE contraptions SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE name = ?`).run(...keys.map((k) => fields[k] ?? null), name);
  }

  /** The ids of the people a contraption is enabled for. */
  contraptionUsers(contraptionId: number): number[] {
    return (this.db.prepare('SELECT user_id FROM contraption_users WHERE contraption_id = ? ORDER BY added_at').all(contraptionId) as { user_id: number }[]).map((r) => r.user_id);
  }

  setContraptionUser(contraptionId: number, userId: number, enabled: boolean, by: number | null) {
    if (enabled) this.db.prepare('INSERT OR IGNORE INTO contraption_users (contraption_id, user_id, added_at, added_by) VALUES (?, ?, ?, ?)').run(contraptionId, userId, Date.now(), by);
    else this.db.prepare('DELETE FROM contraption_users WHERE contraption_id = ? AND user_id = ?').run(contraptionId, userId);
  }

  /** Whether a contraption is enabled for a person who can still sign in. Read fresh each call, so a change takes at once. */
  contraptionEnabled(name: string, userId: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM contraption_users cu JOIN contraptions c ON c.id = cu.contraption_id
      JOIN users u ON u.id = cu.user_id WHERE c.name = ? AND cu.user_id = ? AND u.disabled_at IS NULL`).get(name, userId);
  }

  /** The contraptions enabled for a person, for their app rail. */
  contraptionsFor(userId: number): Pick<ContraptionRow, 'name' | 'title' | 'icon' | 'port' | 'identity_private' | 'folder'>[] {
    return this.db.prepare(`SELECT c.name, c.title, c.icon, c.port, c.identity_private, c.folder FROM contraptions c JOIN contraption_users cu ON cu.contraption_id = c.id
      JOIN users u ON u.id = cu.user_id WHERE cu.user_id = ? AND u.disabled_at IS NULL ORDER BY c.title COLLATE NOCASE`).all(userId) as unknown as Pick<ContraptionRow, 'name' | 'title' | 'icon' | 'port' | 'identity_private' | 'folder'>[];
  }

  /** A person's named session in a contraption. */
  contraptionSession(contraptionId: number, userId: number, name: string): ContraptionSession | undefined {
    return this.db.prepare('SELECT * FROM contraption_sessions WHERE contraption_id = ? AND user_id = ? AND name = ?').get(contraptionId, userId, name) as unknown as ContraptionSession | undefined;
  }

  contraptionSessions(contraptionId: number, userId: number): ContraptionSession[] {
    return this.db.prepare('SELECT * FROM contraption_sessions WHERE contraption_id = ? AND user_id = ? ORDER BY used_at DESC').all(contraptionId, userId) as unknown as ContraptionSession[];
  }

  /** Point a session name at a Claude session (a new one, or the id a resume reported), and mark it used now. */
  putContraptionSession(contraptionId: number, userId: number, name: string, claudeSession: string) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO contraption_sessions (contraption_id, user_id, name, claude_session, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (contraption_id, user_id, name) DO UPDATE SET claude_session = excluded.claude_session, used_at = excluded.used_at`).run(contraptionId, userId, name, claudeSession, now, now);
  }

  deleteContraptionSession(contraptionId: number, userId: number, name: string): boolean {
    return this.db.prepare('DELETE FROM contraption_sessions WHERE contraption_id = ? AND user_id = ? AND name = ?').run(contraptionId, userId, name).changes > 0;
  }

  /** A finished turn's audit row (#844). */
  putTurnAudit(turnId: number, row: { model: string | null; blind: boolean; images: number; system: string; prompt: string; output: string }) {
    this.db.prepare('INSERT OR REPLACE INTO contraption_turn_audit (turn_id, at, model, blind, images, system, prompt, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(turnId, Date.now(), row.model, row.blind ? 1 : 0, row.images, row.system, row.prompt, row.output);
  }

  turnAudit(turnId: number): TurnAuditRow | undefined {
    return this.db.prepare('SELECT * FROM contraption_turn_audit WHERE turn_id = ?').get(turnId) as unknown as TurnAuditRow | undefined;
  }

  /** The app's verdict on its turn's reply (#844): it passed the app's output check, or the app fell back to its own text. */
  setTurnVerdict(turnId: number, verdict: 'pass' | 'fallback', reason: string | null) {
    this.db.prepare('UPDATE contraption_turn_audit SET verdict = ?, verdict_reason = ?, verdict_at = ? WHERE turn_id = ?').run(verdict, reason, Date.now(), turnId);
  }

  /** secure_delete zeroes the rows' pages in the database file (#844). Their text can stay in the WAL until later
   * writes reuse it, and in backups for as long as those are kept (deploy/backup.sh). */
  private dropAudit(where: string, ...args: (number | string)[]) {
    this.db.exec('PRAGMA main.secure_delete = ON');
    try {
      this.db.prepare(`DELETE FROM contraption_turn_audit WHERE ${where}`).run(...args);
    } finally {
      this.db.exec('PRAGMA main.secure_delete = FAST');
    }
  }

  sweepTurnAudit(before: number) {
    this.dropAudit('at < ?', before);
  }

  /** A session's audit rows, when the app deletes the session. */
  deleteTurnAudit(contraptionId: number, userId: number, session: string) {
    this.dropAudit('turn_id IN (SELECT id FROM contraption_turns WHERE contraption_id = ? AND user_id = ? AND session = ?)', contraptionId, userId, session);
  }

  /** A scheme's audit page (#844): its home apps' turns, newest first, `limit` of them before turn `before`, one app's if named. */
  schemeTurnAudit(projectId: number, opts: { before?: number; contraption?: string; limit: number }) {
    return this.db.prepare(`SELECT a.*, t.session, t.outcome, t.started_at, c.name AS contraption, c.title AS contraption_title, u.name AS person
      FROM contraption_turn_audit a JOIN contraption_turns t ON t.id = a.turn_id JOIN contraptions c ON c.id = t.contraption_id JOIN users u ON u.id = t.user_id
      WHERE c.home_scheme = ? AND a.turn_id < ? AND (? IS NULL OR c.name = ?) ORDER BY a.turn_id DESC LIMIT ?`)
      .all(projectId, opts.before ?? Number.MAX_SAFE_INTEGER, opts.contraption ?? null, opts.contraption ?? null, opts.limit) as unknown as (TurnAuditRow & { session: string; outcome: string | null; started_at: number; contraption: string; contraption_title: string; person: string })[];
  }

  /** One more of a contraption's errors on a day (#835); the first one's sample stays. */
  addContraptionError(contraptionId: number, day: string, kind: string, key: string, sample: string, at: number) {
    this.db.prepare(`INSERT INTO contraption_errors (contraption_id, day, kind, key, count, sample, first_at, last_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT (contraption_id, day, kind, key) DO UPDATE SET count = count + 1, last_at = excluded.last_at`).run(contraptionId, day, kind, key, sample, at, at);
  }

  /** A day's contraption errors with their app's name, title and home scheme, biggest first. */
  contraptionErrors(day: string): ContraptionErrorRow[] {
    return this.db.prepare(`SELECT e.*, c.name, c.title, c.home_scheme FROM contraption_errors e JOIN contraptions c ON c.id = e.contraption_id
      WHERE e.day = ? ORDER BY e.count DESC, e.first_at`).all(day) as unknown as ContraptionErrorRow[];
  }

  /** A contraption turn's meter row, at its start (so it counts towards the day's cap at once). */
  startContraptionTurn(contraptionId: number, userId: number, session: string): number {
    return Number(this.db.prepare('INSERT INTO contraption_turns (contraption_id, user_id, session, started_at) VALUES (?, ?, ?, ?)').run(contraptionId, userId, session, Date.now()).lastInsertRowid);
  }

  endContraptionTurn(id: number, outcome: string, usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null) {
    this.db.prepare(`UPDATE contraption_turns SET ended_at = ?, outcome = ?, input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ? WHERE id = ?`)
      .run(Date.now(), outcome, usage?.input ?? null, usage?.output ?? null, usage?.cacheRead ?? null, usage?.cacheWrite ?? null, id);
  }

  getContraptionTurn(id: number): ContraptionTurnRow | undefined {
    return this.db.prepare('SELECT * FROM contraption_turns WHERE id = ?').get(id) as unknown as ContraptionTurnRow | undefined;
  }

  /** A person's turns in a contraption since `since` (the start of the server's day, for its turn_cap). */
  contraptionTurnsSince(contraptionId: number, userId: number, since: number): number {
    return (this.db.prepare('SELECT count(*) AS n FROM contraption_turns WHERE contraption_id = ? AND user_id = ? AND started_at >= ?').get(contraptionId, userId, since) as { n: number }).n;
  }

  /** The schemes this person hid for themselves (#226). */
  hiddenProjects(uid: number): Set<number> {
    const rows = this.db.prepare('SELECT project_id FROM project_hides WHERE user_id = ?').all(uid) as { project_id: number }[];
    return new Set(rows.map((r) => r.project_id));
  }

  setProjectHidden(uid: number, projectId: number, hidden: boolean) {
    if (hidden) this.db.prepare('INSERT INTO project_hides (user_id, project_id, hidden_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(uid, projectId, Date.now());
    else this.db.prepare('DELETE FROM project_hides WHERE user_id = ? AND project_id = ?').run(uid, projectId);
  }

  /** The order this person dragged a list into (#649): scheme ids or contraption names; [] when they never did. */
  listOrder(uid: number, list: 'schemes' | 'apps'): (number | string)[] {
    const row = this.db.prepare('SELECT keys FROM list_orders WHERE user_id = ? AND list = ?').get(uid, list) as { keys: string } | undefined;
    return row ? JSON.parse(row.keys) : [];
  }

  setListOrder(uid: number, list: 'schemes' | 'apps', keys: (number | string)[]) {
    this.db.prepare(`INSERT INTO list_orders (user_id, list, keys, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, list) DO UPDATE SET keys = excluded.keys, updated_at = excluded.updated_at`).run(uid, list, JSON.stringify(keys), Date.now());
  }

  /** The Needs-you items `name` last saw waiting in each scheme (#539): project id -> their keys. */
  seenItems(name: string): Map<number, Set<string>> {
    const rows = this.db.prepare('SELECT project_id, keys FROM project_seen_items WHERE name = ?').all(name) as { project_id: number; keys: string }[];
    return new Map(rows.map((r) => [r.project_id, new Set(JSON.parse(r.keys) as string[])]));
  }

  /** Record the items `name` saw waiting in a scheme; with `keep`, only when none are recorded yet. */
  setSeenItems(name: string, projectId: number, keys: string[], keep = false) {
    this.db.prepare(`INSERT INTO project_seen_items (name, project_id, keys, seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(name, project_id) DO ${keep ? 'NOTHING' : 'UPDATE SET keys = excluded.keys, seen_at = excluded.seen_at'}`).run(name, projectId, JSON.stringify(keys), Date.now());
  }

  deleteProject(id: number) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /** updateTicket's (src/db/minions.ts): each close gets its own closed_at. */
  lastClosedAt = 0;

  addEvent(ticketId: number, kind: string, data: unknown, reserved?: number): EventRow {
    const now = Date.now();
    const json = JSON.stringify(data);
    // With the write worker on, the id is handed out here, so the row is known before the worker writes it (src/db-writer.ts).
    let id: number | null = reserved ?? null;
    if (id === null && this.eventIds) this.eventIds.next = (id = Math.max(this.eventIds.next, this.eventIds.floor())) + 1;
    const rowid = this.insertEvent(id, ticketId, kind, json, now, data);
    if (kind === 'user_message' && json.includes('status:')) this.noteLooks(ticketId, json, now);
    return { id: id ?? (rowid as number), ticket_id: ticketId, kind, data: json, created_at: now };
  }

  /**
   * The Status page's looks (#1273): a minion whose title, or a message to it, quotes a tile's tag ("status:citadel/cpu") is
   * on that tile. Noted as it's written, a health event per tag, so the page reads a few rows and never scans messages.
   */
  noteLooks(ticketId: number, text: string, at: number) {
    for (const tag of new Set(text.match(/status:(?:citadel|app:[\w.-]+)\/[a-z][a-z0-9-]*/g))) this.addHealthEvent('look', at, null, `${tag}\n${ticketId}`);
  }

  /** The next events.id to hand out, set by the write worker's start (src/db-writer.ts); null writes inline and lets SQLite pick. */
  eventIds: { next: number; floor: () => number } | null = null;

  /** addEvent's write: the row (its id, if one was handed out), and its author's latest action. Returns the row's id. */
  insertEvent(id: number | null, ticketId: number, kind: string, json: string, now: number, data: unknown): number {
    const r = this.db
      .prepare('INSERT INTO events (id, ticket_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, ticketId, kind, json, now);
    // A message or an approval click is its author's latest action in the scheme, for the recap (Store.recap).
    const actor = kind === 'user_message' ? (data as any)?.author : kind === 'approval_result' ? (data as any)?.by : null;
    if (typeof actor === 'string') {
      this.db.prepare(`INSERT INTO last_actions (name, project_id, at) SELECT ?, project_id, ? FROM tickets WHERE id = ?
        ON CONFLICT (name, project_id) DO UPDATE SET at = MAX(at, excluded.at)`).run(actor, now, ticketId);
    }
    return Number(r.lastInsertRowid);
  }


  getEvent(id: number): EventRow | undefined {
    const e = scoped(this.db, `event:${id}`, () => this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined);
    return copyRow(e);
  }

  /** Replace an event's data, for cards whose status lives in the card (plans). */
  setEventData(id: number, data: unknown) {
    this.db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
    this.forgetCards(id);
  }

  /**
   * A chat's events of these kinds after event `afterId`, oldest first: by index, so a long chat's thousands of Claude
   * events are never read. Reading a Taskmaster's whole chat to answer one card held the server 1-3 s (#759).
   */
  eventsOfKinds(ticketId: number, kinds: string[], afterId = 0): EventRow[] {
    return this.db.prepare('SELECT * FROM events INDEXED BY events_ticket_kind WHERE ticket_id = ? AND kind IN (SELECT value FROM json_each(?)) AND id > ? ORDER BY id')
      .all(ticketId, JSON.stringify(kinds), afterId) as unknown as EventRow[];
  }

  /** A project's artifacts, newest first, with the title of the ticket that made each. */
  listArtifacts(projectId: number): (Artifact & { ticket_title: string; ticket_kind: TicketKind; ticket_number: number | null })[] {
    return this.db
      .prepare(
        `SELECT a.*, t.title AS ticket_title, t.kind AS ticket_kind, t.number AS ticket_number FROM artifacts a JOIN tickets t ON t.id = a.ticket_id
         WHERE a.project_id = ? ORDER BY a.mtime DESC`,
      )
      .all(projectId) as any;
  }

  /** Drop artifact rows whose path `keep` rejects. */
  pruneArtifacts(keep: (path: string) => boolean) {
    const rows = this.db.prepare('SELECT id, path FROM artifacts').all() as { id: number; path: string }[];
    const del = this.db.prepare('DELETE FROM artifacts WHERE id = ?');
    for (const r of rows) if (!keep(r.path)) del.run(r.id);
  }

  /** A ticket's artifact row for any of the given paths. */
  findArtifact(ticketId: number, paths: string[]): Artifact | undefined {
    const q = this.db.prepare('SELECT * FROM artifacts WHERE ticket_id = ? AND path = ?');
    for (const p of paths) {
      const a = q.get(ticketId, p) as unknown as Artifact | undefined;
      if (a) return a;
    }
    return undefined;
  }

  /**
   * The newest artifact row of a scheme for any of the given paths: the minion that last started linking that file.
   * shortcut: a minion that links the file again keeps its first created_at, so a later linker wins; track the latest link if that misroutes answers.
   */
  latestArtifact(projectId: number, paths: string[]): Artifact | undefined {
    const q = this.db.prepare('SELECT * FROM artifacts WHERE project_id = ? AND path = ? ORDER BY created_at DESC, id DESC LIMIT 1');
    const rows = paths.map((p) => q.get(projectId, p) as unknown as Artifact | undefined).filter((a) => a !== undefined);
    return rows.sort((a, b) => b.created_at - a.created_at || b.id - a.id)[0];
  }

    getArtifact(id: number): Artifact | undefined {
    return this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as unknown as Artifact | undefined;
  }

  setArtifactPinned(id: number, by: string | null) {
    this.db.prepare('UPDATE artifacts SET pinned_at = ?, pinned_by = ? WHERE id = ?').run(by ? Date.now() : null, by, id);
    // Unpinning a file that is already gone leaves nothing worth showing.
    if (!by) this.db.prepare('DELETE FROM artifacts WHERE id = ? AND missing = 1').run(id);
  }

  pinnedArtifactPaths(ticketId: number): string[] {
    return (this.db.prepare('SELECT path FROM artifacts WHERE ticket_id = ? AND pinned_at IS NOT NULL').all(ticketId) as { path: string }[]).map((r) => r.path);
  }

  /** Record an upload; the same run, attempt and name again replaces its row (and is no longer published). */
  putCiFile(f: Omit<CiFile, 'id' | 'published_to' | 'published_at'>): CiFile {
    return this.db
      .prepare(
        `INSERT INTO ci_files (project_id, workflow, run_id, run_attempt, sha, ref, name, kind, target, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (project_id, workflow, run_id, run_attempt, name) DO UPDATE SET sha = excluded.sha, ref = excluded.ref, kind = excluded.kind, target = excluded.target,
           size = excluded.size, sha256 = excluded.sha256, created_at = excluded.created_at, published_to = NULL, published_at = NULL
         RETURNING *`,
      )
      .get(f.project_id, f.workflow, f.run_id, f.run_attempt, f.sha, f.ref, f.name, f.kind, f.target, f.size, f.sha256, f.created_at) as unknown as CiFile;
  }

  getCiFile(id: number): CiFile | undefined {
    return this.db.prepare('SELECT * FROM ci_files WHERE id = ?').get(id) as unknown as CiFile | undefined;
  }

  /** The CI store's files, newest first: every scheme's, or one's. */
  ciFiles(projectId?: number): CiFile[] {
    const where = projectId === undefined ? '' : 'WHERE project_id = ?';
    return this.db.prepare(`SELECT * FROM ci_files ${where} ORDER BY created_at DESC, id DESC`).all(...(projectId === undefined ? [] : [projectId])) as unknown as CiFile[];
  }

  deleteCiFile(id: number) {
    this.db.prepare('DELETE FROM ci_files WHERE id = ?').run(id);
  }

  /** A file was copied to `to` (a contraption's feed): the newest one published there is never swept. */
  publishCiFile(id: number, to: string) {
    this.db.prepare('UPDATE ci_files SET published_to = ?, published_at = ? WHERE id = ?').run(to, Date.now(), id);
  }

  /** A contraption's Android build was published into its feed (#663). */
  recordApkPublish(r: { projectId: number; contraption: string; versionCode: number; runId: number; by: string; uid: number | null }) {
    this.db.prepare('INSERT INTO apk_publishes (project_id, contraption, version_code, run_id, published_by, uid, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.projectId, r.contraption, r.versionCode, r.runId, r.by, r.uid, Date.now());
  }

  /** The newest Android build Citadel published into a contraption's feed (#764: what the next release counts from). */
  lastApkPublish(projectId: number, contraption: string): { version_code: number; run_id: number } | null {
    return (this.db.prepare('SELECT version_code, run_id FROM apk_publishes WHERE project_id = ? AND contraption = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(projectId, contraption) as { version_code: number; run_id: number } | undefined) ?? null;
  }

  /** Pins on files of a project's shared folder, by path relative to it. Kept while the file is gone, like an artifact's. */
  sharedPins(projectId: number): SharedPin[] {
    return this.db.prepare('SELECT path, pinned_at, pinned_by FROM shared_pins WHERE project_id = ?').all(projectId) as unknown as SharedPin[];
  }

  setSharedPin(projectId: number, path: string, by: string | null) {
    if (by) this.db.prepare('INSERT INTO shared_pins (project_id, path, pinned_at, pinned_by) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').run(projectId, path, Date.now(), by);
    else this.db.prepare('DELETE FROM shared_pins WHERE project_id = ? AND path = ?').run(projectId, path);
  }

  /** What an HTML page saved through the artifact bridge, oldest key first; values still JSON text. */
  artifactData(projectId: number, file: string): ArtifactDatum[] {
    return this.db.prepare('SELECT key, value, by, at FROM artifact_data WHERE project_id = ? AND file = ? ORDER BY at, key').all(projectId, file) as unknown as ArtifactDatum[];
  }

  /** Set (JSON text) or delete (null) keys of a page's store, all or none. */
  writeArtifactData(projectId: number, file: string, entries: { key: string; value: string | null }[], by: string) {
    const set = this.db.prepare('INSERT INTO artifact_data (project_id, file, key, value, by, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value, by = excluded.by, at = excluded.at');
    const del = this.db.prepare('DELETE FROM artifact_data WHERE project_id = ? AND file = ? AND key = ?');
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const e of entries) {
        if (e.value === null) del.run(projectId, file, e.key);
        else set.run(projectId, file, e.key, e.value, by, now);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Bring a ticket's artifact rows in line with what is on disk. Returns whether anything changed. */
  syncArtifacts(ticket: Ticket, found: { path: string; size: number; mtime: number }[]): boolean {
    const existing = new Map(
      (this.db.prepare('SELECT * FROM artifacts WHERE ticket_id = ?').all(ticket.id) as unknown as Artifact[]).map((a) => [a.path, a]),
    );
    let changed = false;
    const insert = this.db.prepare(
      'INSERT INTO artifacts (project_id, ticket_id, path, size, mtime, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const update = this.db.prepare('UPDATE artifacts SET size = ?, mtime = ?, missing = 0 WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const f of found) {
        const a = existing.get(f.path);
        existing.delete(f.path);
        if (!a) insert.run(ticket.project_id, ticket.id, f.path, f.size, f.mtime, Date.now());
        else if (a.size !== f.size || a.mtime !== f.mtime || a.missing) update.run(f.size, f.mtime, a.id);
        else continue;
        changed = true;
      }
      for (const a of existing.values()) {
        if (a.pinned_at === null) this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(a.id);
        else if (!a.missing) this.db.prepare('UPDATE artifacts SET missing = 1 WHERE id = ?').run(a.id);
        else continue;
        changed = true;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return changed;
  }

  /** Session state rows without their data: a ticket's own, or the project's shared ones (ticketId null). */
  listClaudeState(projectId: number, ticketId: number | null): ClaudeStateRow[] {
    return (ticketId === null
      ? this.db.prepare('SELECT path, project_id, ticket_id, size, mtime FROM claude_state WHERE project_id = ? AND ticket_id IS NULL').all(projectId)
      : this.db.prepare('SELECT path, project_id, ticket_id, size, mtime FROM claude_state WHERE project_id = ? AND ticket_id = ?').all(projectId, ticketId)
    ) as unknown as ClaudeStateRow[];
  }

  getClaudeState(path: string, withData = false): ClaudeStateRow | undefined {
    const cols = withData ? '*' : 'path, project_id, ticket_id, size, mtime';
    return this.db.prepare(`SELECT ${cols} FROM claude_state WHERE path = ?`).get(path) as unknown as ClaudeStateRow | undefined;
  }

  putClaudeState(row: Required<ClaudeStateRow>) {
    this.db.prepare(PUT_CLAUDE_STATE).run(row.path, row.project_id, row.ticket_id, row.size, row.mtime, row.data);
  }

  /** events.db, the chat log's own file (src/events-db.ts); null for an in-memory store. */
  get eventsPath(): string | null {
    return eventsPath(this.path);
  }

  /** state.db's file, for a second connection to it (StateDb); null for an in-memory store. */
  get statePath(): string | null {
    return this.path === ':memory:' ? null : join(dirname(this.path), 'state.db');
  }

  deleteClaudeState(path: string) {
    this.db.prepare('DELETE FROM claude_state WHERE path = ?').run(path);
  }

  /** When `name` last looked at each of a project's threads: ticket id -> time. */
  seenTimes(name: string, projectId: number): Record<number, number> {
    // In a read scope (#1527) one read for every scheme: the scheme list asked twice a scheme, each walking all their marks.
    if (inScope(this.db)) {
      const all = scoped(this.db, `seen:${name}`, () => (this.db
        .prepare('SELECT s.ticket_id, s.seen_at, t.project_id FROM ticket_seen s JOIN tickets t ON t.id = s.ticket_id WHERE s.name = ?')
        .all(name) as { ticket_id: number; seen_at: number; project_id: number }[]));
      return Object.fromEntries(all.filter((r) => r.project_id === projectId).map((r) => [r.ticket_id, r.seen_at]));
    }
    const rows = this.db
      .prepare('SELECT s.ticket_id, s.seen_at FROM ticket_seen s JOIN tickets t ON t.id = s.ticket_id WHERE s.name = ? AND t.project_id = ?')
      .all(name, projectId) as { ticket_id: number; seen_at: number }[];
    return Object.fromEntries(rows.map((r) => [r.ticket_id, r.seen_at]));
  }

  /** When `name` last had this minion open, or 0. */
  seenAt(name: string, ticketId: number): number {
    const row = this.db.prepare('SELECT seen_at FROM ticket_seen WHERE name = ? AND ticket_id = ?').get(name, ticketId) as { seen_at: number } | undefined;
    return row?.seen_at ?? 0;
  }

  markSeen(name: string, ticketId: number): number {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO ticket_seen (name, ticket_id, seen_at) VALUES (?, ?, ?) ON CONFLICT(name, ticket_id) DO UPDATE SET seen_at = excluded.seen_at')
      .run(name, ticketId, now);
    return now;
  }

  /** The minions `name` pinned in a project, oldest pin first (#179). */
  pinnedTickets(name: string, projectId: number): number[] {
    // A pin older than its minion belongs to a deleted one whose id was reused: a rolled-back release's deleteTicket leaves it behind.
    const rows = this.db
      .prepare('SELECT p.ticket_id FROM ticket_pins p JOIN tickets t ON t.id = p.ticket_id WHERE p.name = ? AND t.project_id = ? AND p.pinned_at >= t.created_at ORDER BY p.pinned_at, p.ticket_id')
      .all(name, projectId) as { ticket_id: number }[];
    return rows.map((r) => r.ticket_id);
  }

  /** Whether `name` pinned this minion, by the same rule as pinnedTickets. */
  isTicketPinned(name: string, ticketId: number): boolean {
    return !!this.db
      .prepare('SELECT 1 FROM ticket_pins p JOIN tickets t ON t.id = p.ticket_id WHERE p.name = ? AND p.ticket_id = ? AND p.pinned_at >= t.created_at')
      .get(name, ticketId);
  }

  setTicketPinned(name: string, ticketId: number, pinned: boolean) {
    if (pinned) this.db.prepare('INSERT INTO ticket_pins (name, ticket_id, pinned_at) VALUES (?, ?, ?) ON CONFLICT(name, ticket_id) DO NOTHING').run(name, ticketId, Date.now());
    else this.db.prepare('DELETE FROM ticket_pins WHERE name = ? AND ticket_id = ?').run(name, ticketId);
  }

  /** People's notes on a scheme's minions, by ticket id. Only people's routes may hand these out. */
  personNotes(projectId: number): Record<number, PersonNote> {
    // A note older than its minion belongs to a deleted one whose id was reused: a rolled-back release's deleteTicket leaves it behind.
    const rows = this.db
      .prepare('SELECT n.ticket_id, n.text, n.updated_by, n.updated_at FROM person_notes n JOIN tickets t ON t.id = n.ticket_id WHERE t.project_id = ? AND n.updated_at >= t.created_at')
      .all(projectId) as { ticket_id: number; text: string; updated_by: string; updated_at: number }[];
    return Object.fromEntries(rows.map((r) => [r.ticket_id, { text: r.text, by: r.updated_by, at: r.updated_at }]));
  }

  /** Set a minion's person note, or clear it with an empty text. */
  setPersonNote(ticketId: number, text: string, by: string): PersonNote | null {
    if (!text) {
      this.db.prepare('DELETE FROM person_notes WHERE ticket_id = ?').run(ticketId);
      return null;
    }
    const at = Date.now();
    this.db
      .prepare('INSERT INTO person_notes (ticket_id, text, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ticket_id) DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by, updated_at = excluded.updated_at')
      .run(ticketId, text, by, at);
    return { text, by, at };
  }

  /** Whether `name` has ever written or acted anywhere (#1151's welcome): recap leaves 0 for "never", so that doesn't count. */
  hasActed(name: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM last_actions WHERE name = ? AND at > 0 LIMIT 1').get(name);
  }

  /**
   * For the scheme recap: when `name` last acted anywhere in the scheme (a message, a card answer or
   * plan verdict, which are messages too, or an approval click), and how many turns each thread
   * has finished since. `since` is null if they never have.
   */
  recap(name: string, projectId: number): { since: number | null; turns: Record<number, number> } {
    let row = this.db.prepare('SELECT at FROM last_actions WHERE name = ? AND project_id = ?').get(name, projectId) as { at: number } | undefined;
    if (!row) {
      // Once per person and scheme: from before last_actions, read from the events (1.5 s cold for Citadel, #538). 0: never acted.
      const { since } = this.db.prepare(`
        SELECT MAX(e.created_at) AS since FROM events e INDEXED BY events_ticket_kind JOIN tickets t ON t.id = e.ticket_id
        WHERE t.project_id = ? AND e.kind IN ('user_message', 'approval_result') AND (
          (e.kind = 'user_message' AND json_extract(e.data, '$.author') = ?)
          OR (e.kind = 'approval_result' AND json_extract(e.data, '$.by') = ?))`).get(projectId, name, name) as { since: number | null };
      row = { at: since ?? 0 };
      this.db.prepare('INSERT INTO last_actions (name, project_id, at) VALUES (?, ?, ?) ON CONFLICT (name, project_id) DO UPDATE SET at = MAX(at, excluded.at)').run(name, projectId, row.at);
    }
    const since = row.at || null;
    // The page shows the recap only after RECAP_AWAY_MS without an action, so the count isn't read before then:
    // it reads every Claude event in the scheme since (0.3 s warm for Citadel, #538).
    if (since == null || Date.now() - since < RECAP_AWAY_MS) return { since, turns: {} };
    // Event ids grow with time, so start after the last turn that ended by `since` (turns_ended finds it): the index skips everything older.
    const before = this.db.prepare('SELECT event_id FROM turns WHERE ended_at <= ? AND event_id IS NOT NULL ORDER BY ended_at DESC LIMIT 1').get(since) as { event_id: number } | undefined;
    const rows = this.db.prepare(`
      SELECT e.ticket_id, COUNT(*) AS n FROM events e INDEXED BY events_ticket_kind JOIN tickets t ON t.id = e.ticket_id
      WHERE t.project_id = ? AND e.kind = 'claude' AND e.id > ? AND e.created_at > ? AND json_extract(e.data, '$.type') = 'result'
      GROUP BY e.ticket_id`).all(projectId, before?.event_id ?? 0, since) as { ticket_id: number; n: number }[];
    return { since, turns: Object.fromEntries(rows.map((r) => [r.ticket_id, r.n])) };
  }

  /**
   * Words a thread wrote that show in a chat, newest first, at most `limit`: its own replies, and its messages relayed
   * into other threads (strike_text). Read lazily from its first event on: reading them all at once held the server 9 s (#622).
   */
  *wordsBy(ticketId: number, limit: number): Generator<EventRow> {
    const first = (this.db.prepare('SELECT min(id) AS id FROM events WHERE ticket_id = ?').get(ticketId) as { id: number | null }).id;
    if (first == null) return;
    let n = 0;
    for (const row of this.db
      .prepare(`SELECT * FROM events WHERE id >= ? AND ((ticket_id = ? AND kind = 'claude' AND json_extract(data, '$.type') = 'assistant' AND instr(data, '"type":"text"') > 0)
        OR (kind = 'user_message' AND json_extract(data, '$.from') = ?)) ORDER BY id DESC`)
      .iterate(first, ticketId, ticketId)) {
      yield row as unknown as EventRow;
      if (++n >= limit) return;
    }
  }

  /** A chat's newest plan card, or undefined: a real plan, not a machine's notes (#617), its lending (#1638) or a release key card (#837), which ride the same event kind. */
  latestPlan(ticketId: number): EventRow | undefined {
    return this.db.prepare(`SELECT * FROM events WHERE ticket_id = ? AND kind = 'plan' AND json_extract(data, '$.machine') IS NULL
      AND json_extract(data, '$.releaseKey') IS NULL AND json_extract(data, '$.machineLend') IS NULL ORDER BY id DESC LIMIT 1`).get(ticketId) as unknown as EventRow | undefined;
  }

  /** The backup chat's lines (src/backup.ts): the newest `limit` messages, notes, errors and replies with text after `afterId`, oldest first. */
  chatTextEvents(ticketId: number, afterId: number, limit: number): EventRow[] {
    return (this.db.prepare(`SELECT * FROM events WHERE ticket_id = ? AND id > ? AND (kind IN ('user_message', 'note', 'error')
      OR (kind = 'claude' AND json_extract(data, '$.type') = 'assistant' AND instr(data, '"type":"text"') > 0))
      ORDER BY id DESC LIMIT ?`).all(ticketId, afterId, limit) as unknown as EventRow[]).reverse();
  }

  /** A chat's events in [from, before), oldest first; `mine` keeps only what Mine shows from the Overlord (MINE_EVENTS). */
  eventsBetween(ticketId: number, from: number, before: number, mine = false): EventRow[] {
    return this.db.prepare(`SELECT * FROM events WHERE ticket_id = ? AND id >= ? AND id < ? ${mine ? `AND ${MINE_EVENTS}` : ''} ORDER BY id`)
      .all(ticketId, from, before) as unknown as EventRow[];
  }

  /** A chat's newest `limit` events before `before`, newest first; `mine` as in eventsBetween. */
  eventsBefore(ticketId: number, before: number, limit: number, mine = false): EventRow[] {
    return this.db.prepare(`SELECT * FROM events WHERE ticket_id = ? AND id < ? ${mine ? `AND ${MINE_EVENTS}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(ticketId, before, limit) as unknown as EventRow[];
  }

  /** A chat's newest event of `kind` (#1149: the message a person just sent). */
  lastEventOf(ticketId: number, kind: string): EventRow | undefined {
    return this.db.prepare('SELECT * FROM events WHERE ticket_id = ? AND kind = ? ORDER BY id DESC LIMIT 1').get(ticketId, kind) as unknown as EventRow | undefined;
  }

  listEvents(ticketId: number, afterId = 0): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE ticket_id = ? AND id > ? ORDER BY id')
      .all(ticketId, afterId) as unknown as EventRow[];
  }

  /**
   * A page of a ticket's history before `before`, oldest first, in whole turns: as many of the newest
   * turns as fit in `limit` events, and always at least one, so a running or long turn comes whole.
   * A turn starts just after the previous turn's result, so the messages that started it come with it.
   * With `from`, the page reaches back to the start of the turn holding that event too.
   */
  eventsPage(ticketId: number, before: number, limit: number, from?: number): { events: EventRow[]; more: boolean } {
    const recent = this.db.prepare(`
      SELECT id, kind = 'claude' AND json_extract(data, '$.type') = 'result' AS ends FROM events
      WHERE ticket_id = ? AND id < ? ORDER BY id DESC LIMIT ?`).all(ticketId, before, limit + 1) as { id: number; ends: number }[];
    if (!recent.length) return { events: [], more: false };
    let start = recent.at(-1)!.id;
    if (recent.length > limit) {
      // The oldest turn start in the newest `limit` events: the event after a result.
      const i = recent.findLastIndex((r, n) => n > 0 && r.ends);
      start = i > 0 ? recent[i - 1].id : this.turnStart(ticketId, recent[0].id);
    }
    if (from != null) start = Math.min(start, this.turnStart(ticketId, from));
    // Notes after a long last turn (dismissed, deployed) aren't a turn: they come with the turn before them,
    // so a minion never opens on nothing but "Load earlier" (#288).
    const hasTurn = this.db.prepare(`
      SELECT 1 FROM events WHERE ticket_id = ? AND id >= ? AND id < ? AND (kind = 'user_message'
        OR (kind = 'claude' AND json_extract(data, '$.type') = 'system' AND json_extract(data, '$.subtype') = 'init')) LIMIT 1`)
      .get(ticketId, start, before);
    const prev = !hasTurn && this.db.prepare('SELECT MAX(id) AS id FROM events WHERE ticket_id = ? AND id < ?').get(ticketId, start) as { id: number | null };
    if (prev && prev.id != null) start = this.turnStart(ticketId, prev.id);
    const events = this.db
      .prepare('SELECT * FROM events WHERE ticket_id = ? AND id >= ? AND id < ? ORDER BY id')
      .all(ticketId, start, before) as unknown as EventRow[];
    const more = !!this.db.prepare('SELECT 1 FROM events WHERE ticket_id = ? AND id < ? LIMIT 1').get(ticketId, start);
    return { events, more };
  }

  /** The first event of the turn holding event `id`: the one after the last result before it. */
  private turnStart(ticketId: number, id: number): number {
    const row = this.db.prepare(`
      SELECT MIN(id) AS id FROM events WHERE ticket_id = ? AND id > COALESCE((
        SELECT MAX(id) FROM events WHERE ticket_id = ? AND id < ? AND kind = 'claude' AND json_extract(data, '$.type') = 'result'), 0)`)
      .get(ticketId, ticketId, id) as { id: number | null };
    return row.id ?? id;
  }

  /**
   * A ticket's events before `before` that can change its task list (progress.js applyEvent): turn
   * starts, Claude's messages and tool calls, and the results that give a TaskCreate its id. Tool results
   * are most of the bytes, so they are left out by prefix, without parsing anyone's JSON (#497).
   */
  planEvents(ticketId: number, before = Number.MAX_SAFE_INTEGER, after = 0): EventRow[] {
    return this.db.prepare(`
      SELECT * FROM events WHERE ticket_id = ? AND id < ? AND id > ? AND kind = 'claude' AND (data NOT LIKE '{"type":"user"%' OR instr(data, 'Task #') > 0)
      ORDER BY id`).all(ticketId, before, after) as unknown as EventRow[];
  }

  /**
   * A project's stored cards still waiting on a person, in threads that aren't dismissed: questions
   * nobody has answered (nor the minion settled), and plans still pending. Approval cards live in memory (Approvals.pending).
   * Only a card's own answer (a click, a doc Send, a held answer) clears it; a message typed in the chat doesn't (#812),
   * since it may be about anything. The minion settles a card someone answered by typing (settle_question).
   */
  openCards(projectId: number): EventRow[] {
    return this.openCardsWhere('t.project_id = ?', projectId);
  }

  /** One minion's open cards (openCards), oldest first. */
  openCardsOf(ticketId: number): EventRow[] {
    return [...scoped(this.db, `open-cards:${ticketId}`, () => this.openCardsWhere('e.ticket_id = ?', ticketId))];
  }

  /** When the oldest of a minion's open cards (openCards) was posted, or null with none. */
  openCardAt(ticketId: number): number | null {
    return this.openCardsOf(ticketId)[0]?.created_at ?? null;
  }

  /** The event id of the oldest of a minion's open cards (openCards) with at most `within` events after it, or null. */
  openCardEventId(ticketId: number, within: number): number | null {
    const id = this.openCardsWhere('e.ticket_id = ?', ticketId)[0]?.id;
    if (id == null) return null;
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE ticket_id = ? AND id > ?').get(ticketId, id) as { n: number };
    return n <= within ? id : null;
  }

  /** Whether the chat still shows card event `eventId` under its turn's words: no message and no turn end since (public/thread.js heldCards). */
  heldBelow(ticketId: number, eventId: number): boolean {
    return !this.db.prepare("SELECT 1 FROM events WHERE ticket_id = ? AND id > ? AND (kind = 'user_message' OR (kind = 'claude' AND json_extract(data, '$.type') = 'result')) LIMIT 1")
      .get(ticketId, eventId);
  }

  /** The id of the chat event that posted a minion's card `cardId` of `kind`, or null if there's none. */
  cardEventId(ticketId: number, kind: string, cardId: string): number | null {
    const row = this.db.prepare("SELECT id FROM events WHERE ticket_id = ? AND kind = ? AND json_extract(data, '$.id') = ? ORDER BY id DESC LIMIT 1")
      .get(ticketId, kind, cardId) as { id: number } | undefined;
    return row?.id ?? null;
  }

  private pickedCards(projectId: number, limit: number) {
    return this.db.prepare(`
      SELECT * FROM (
        SELECT e.id, t.number, t.kind AS tkind, t.status AS tstatus
        FROM events e INDEXED BY events_cards JOIN tickets t ON t.id = e.ticket_id
        WHERE t.project_id = ? AND e.kind IN ('question', 'plan', 'approval')
        ORDER BY e.id DESC LIMIT ?)
      ORDER BY id`).all(projectId, limit) as { id: number; number: number | null; tkind: string; tstatus: string }[];
  }

  private readCardRows(ids: number[]) {
    if (!ids.length) return;
    for (const row of this.db.prepare('SELECT * FROM events WHERE id IN (SELECT value FROM json_each(?))').all(JSON.stringify(ids)) as unknown as EventRow[]) {
      this.cardRows.set(row.id, { ...row, cid: JSON.parse(row.data).id ?? null });
    }
  }

  /**
   * Read up to `chunk` of recentCards' card rows it hasn't read yet, and say how many are still unread. The first
   * recentCards after a restart reads all 500 rows at once, scattered over a gigabyte file: 1.3 s of held loop when the
   * disk was busy. The server calls this in small steps at start, so that first call finds them read.
   */
  warmCardRows(projectId: number, limit: number, chunk: number): number {
    const unread = this.pickedCards(projectId, limit).filter((p) => !this.cardRows.has(p.id)).map((p) => p.id);
    this.readCardRows(unread.slice(0, chunk));
    return Math.max(unread.length - chunk, 0);
  }

  /**
   * A project's newest `limit` question, plan and approval cards, oldest first,
   * each with its minion and how it was settled: the answer to it (`reply`), and an approval's result (`result`). For the link check (#531).
   */
  recentCards(projectId: number, limit: number): (EventRow & { number: number | null; tkind: string; tstatus: string; reply: string | null; result: string | null })[] {
    // Which cards, from the index alone; their rows only for cards not read before. Re-reading the 500 rows every
    // time, scattered over a gigabyte file, held the event loop 1-5 s whenever the page cache had dropped them (#759).
    const picked = this.pickedCards(projectId, limit);
    this.readCardRows(picked.filter((p) => !this.cardRows.has(p.id)).map((p) => p.id));
    const cards = picked.flatMap((p) => {
      const row = this.cardRows.get(p.id);
      return row ? [{ ...row, number: p.number, tkind: p.tkind, tstatus: p.tstatus }] : [];
    });
    const upTo = (this.db.prepare('SELECT max(id) AS id FROM events').get() as { id: number | null }).id ?? 0;
    // After a restart the memory is empty: take what was saved, as long as it is of this very card and not newer than the
    // events (a deleted newest id can come back as another card, #762). Anything else is read again from the card on.
    const lost = cards.filter((c) => !this.cardFates.has(c.id));
    if (lost.length) {
      const saved = new Map((this.db.prepare('SELECT * FROM card_fates WHERE card_id IN (SELECT value FROM json_each(?))')
        .all(JSON.stringify(lost.map((c) => c.id))) as unknown as (CardFate & { card_id: number; ticket_id: number; cid: string | null; up_to: number })[])
        .map((r) => [r.card_id, r]));
      for (const c of lost) {
        const r = saved.get(c.id);
        if (r && r.ticket_id === c.ticket_id && r.cid === (c.cid == null ? null : String(c.cid)) && r.up_to >= c.id && r.up_to <= upTo) {
          this.cardFates.set(c.id, { reply: r.reply, result: r.result, upTo: r.up_to });
          this.savedFates.set(c.id, { reply: r.reply, result: r.result, upTo: r.up_to });
        }
      }
    }
    const fates = cards.map((c) => this.cardFates.get(c.id) ?? { reply: null, result: null, upTo: c.id });
    // Each chat's messages are read once from its oldest card still waiting, not once per card: 500 cards each
    // scanning the rest of a long chat held the event loop 1-3 s (#622). By kind: left to itself SQLite walked
    // events_ticket, every event of the chat (56,619 rows for 1,861 messages), 2-3 s from a cold cache after a restart.
    for (const ticket of new Set(cards.map((c) => c.ticket_id))) {
      const mine = cards.flatMap((c, i) => c.ticket_id === ticket ? [{ cid: c.cid, approval: c.kind === 'approval', fate: fates[i] }] : []);
      const from = (pick: (f: CardFate) => string | null, of = mine) => Math.min(...of.filter((m) => pick(m.fate) == null).map((m) => m.fate.upTo));
      const replyFrom = from((f) => f.reply);
      const replies = replyFrom === Infinity ? [] : this.db.prepare(`
        SELECT a.id, coalesce(json_extract(a.data, '$.answer.questionId'), json_extract(a.data, '$.plan.planId')) AS card,
          json_object('author', json_extract(a.data, '$.author'), 'at', a.created_at, 'text', substr(json_extract(a.data, '$.text'), 1, 200),
            'answer', json(json_extract(a.data, '$.answer'))) AS reply
        FROM events a INDEXED BY events_ticket_kind WHERE a.ticket_id = ? AND a.kind = 'user_message' AND a.id > ? AND a.id <= ?
          AND coalesce(json_extract(a.data, '$.answer.questionId'), json_extract(a.data, '$.plan.planId')) IS NOT NULL ORDER BY a.id`)
        .all(ticket, replyFrom, upTo) as { id: number; card: unknown; reply: string }[];
      // Only an approval gets a result: looking one up for every chat's questions and plans was half a cold call (#759).
      const resultFrom = from((f) => f.result, mine.filter((m) => m.approval));
      const results = resultFrom === Infinity ? [] : this.db.prepare(`
        SELECT id, json_extract(data, '$.id') AS card, json_set(data, '$.at', created_at) AS result
        FROM events INDEXED BY events_ticket_kind WHERE ticket_id = ? AND kind = 'approval_result' AND id > ? AND id <= ? ORDER BY id`)
        .all(ticket, resultFrom, upTo) as { id: number; card: unknown; result: string }[];
      for (const { cid, approval, fate } of mine) {
        // Only a click on this card answers it: not one on another card, not a typed message (#812).
        fate.reply ??= replies.find((a) => a.id > fate.upTo && a.card === cid)?.reply ?? null;
        if (approval) fate.result ??= results.find((r) => r.id > fate.upTo && r.card === cid)?.result ?? null;
        fate.upTo = upTo;
      }
    }
    this.saveFates(cards, fates);
    return cards.map(({ cid, ...c }, i) => {
      this.cardFates.set(c.id, fates[i]);
      return { ...c, reply: fates[i].reply, result: fates[i].result };
    });
  }

  // The fates as last written to card_fates. A fate is written when it is new or found something, and the newest event it
  // looked at only now and then (an unsettled card would otherwise write every call): a stale `up_to` only means
  // the next read after a restart scans a little more.
  private savedFates = new Map<number, CardFate>();
  private fatesSavedAt = 0;
  private saveFates(cards: { id: number; ticket_id: number; cid: unknown }[], fates: CardFate[]) {
    const now = Date.now();
    const lagging = now - this.fatesSavedAt > 5 * 60_000;
    const todo = cards.flatMap((c, i) => {
      const was = this.savedFates.get(c.id), f = fates[i];
      return !was || was.reply !== f.reply || was.result !== f.result || (lagging && was.upTo !== f.upTo) ? [{ c, f }] : [];
    });
    if (!todo.length) return;
    if (lagging) this.fatesSavedAt = now;
    // On the write worker a failed write is only logged, so this remembers it as saved: it is read again after a restart.
    if (this.putFates(todo.map(({ c, f }) => [c.id, c.ticket_id, c.cid == null ? null : String(c.cid), f.reply, f.result, f.upTo])) === false) return;
    for (const { c, f } of todo) this.savedFates.set(c.id, { ...f });
  }

  /** saveFates' write, in one commit: rows of card_fates' columns. False if it failed. */
  putFates(rows: unknown[][]): boolean {
    const put = this.db.prepare('INSERT OR REPLACE INTO card_fates (card_id, ticket_id, cid, reply, result, up_to) VALUES (?, ?, ?, ?, ?, ?)');
    try {
      this.db.exec('BEGIN');
      for (const r of rows) put.run(...(r as any[]));
      this.db.exec('COMMIT');
      return true;
    } catch {
      try { this.db.exec('ROLLBACK'); } catch { /* no transaction was open */ }
      return false; // not saved: it is read again after a restart
    }
  }


  // What recentCards found of each card, by event id: a reply or result once found stays (events are only appended),
  // and `upTo` is the newest event looked at, so the next read only scans messages after it (#622).
  private cardFates = new Map<number, CardFate>();

  // recentCards' card rows, by event id, with the card's own id: a card's row only changes through setEventData and
  // goes with deleteTicket, which both drop it here (#759).
  private cardRows = new Map<number, EventRow & { cid: unknown }>();

  // Card events found answered, settled or no longer pending. None ever waits again (a plan never goes back to pending,
  // and events are only appended), so later reads skip their rows: cold, re-reading Citadel's 335 card rows and the
  // messages after them was 270 ms of the scheme list's 340 ms (#614).
  private doneCards = new Set<number>();

  /** Drop what recentCards and openCardsWhere remember of cards: one card's row (its data changed), or everything. */
  forgetCards(id?: number) {
    if (id !== undefined) return void this.cardRows.delete(id);
    this.doneCards.clear();
    this.cardFates.clear();
    this.savedFates.clear();
    this.cardRows.clear();
  }

  /** TYPED_HANDLES_UP_TO; a test sets 0 to run the new rule on its small ids. */
  typedHandlesUpTo = TYPED_HANDLES_UP_TO;

  private openCardsWhere(scope: string, id: number): EventRow[] {
    // Index-only: events_ticket_kind holds (ticket_id, kind, id).
    const ids = (this.db.prepare(`SELECT e.id FROM events e INDEXED BY events_ticket_kind JOIN tickets t ON t.id = e.ticket_id
      WHERE ${scope} AND t.status != 'closed' AND e.kind IN ('plan', 'question')`).all(id) as { id: number }[])
      .map((r) => r.id).filter((i) => !this.doneCards.has(i));
    if (!ids.length) return [];
    const open = this.db.prepare(`
      SELECT e.* FROM events e WHERE e.id IN (SELECT value FROM json_each(?)) AND (
        (e.kind = 'plan' AND json_extract(e.data, '$.status') = 'pending')
        OR (e.kind = 'question' AND json_extract(e.data, '$.settled') IS NULL))
      AND NOT EXISTS (
        SELECT 1 FROM events a WHERE a.ticket_id = e.ticket_id AND a.kind = 'user_message' AND a.id > e.id
          -- only this card's own answer settles it, a held one for a cold asker (#687) too; a typed message answers nothing (#812)
          AND (coalesce(json_extract(a.data, '$.answer.questionId'), json_extract(a.data, '$.plan.planId')) = json_extract(e.data, '$.id')
            OR (e.id <= ${this.typedHandlesUpTo} AND ${PERSON_WROTE} AND json_extract(e.data, '$.to') IS NULL
              AND coalesce(json_extract(a.data, '$.answer.questionId'), json_extract(a.data, '$.plan.planId')) IS NULL)))
      ORDER BY e.id`).all(JSON.stringify(ids)) as unknown as EventRow[];
    const still = new Set(open.map((e) => e.id));
    for (const i of ids) if (!still.has(i)) this.doneCards.add(i);
    return open;
  }

  /**
   * The text of a ticket's replies that may link files (subagents' included), from its Claude events after event
   * `after`, at most `limit` events read: `upTo` is the last one read, and `more` that there may be more after it.
   * Read in pages from where the last scan stopped, since a long chat's whole history read cold held the server
   * a second (#609).
   */
  replyTexts(ticketId: number, after = 0, limit = -1): { texts: string[]; upTo: number; more: boolean } {
    const rows = this.db
      .prepare("SELECT id, CASE WHEN data LIKE '%\"type\":\"assistant\"%' AND data LIKE '%](%' THEN data END AS data FROM events WHERE ticket_id = ? AND kind = 'claude' AND id > ? ORDER BY id LIMIT ?")
      .all(ticketId, after, limit) as { id: number; data: string | null }[];
    const texts: string[] = [];
    for (const { data } of rows) {
      if (data == null) continue;
      const content = JSON.parse(data).message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
    return { texts, upTo: rows.at(-1)?.id ?? after, more: limit >= 0 && rows.length === limit };
  }

  /** Pass every stored Claude event through `fn` and save what it returns (null deletes the event). */
  rewriteClaudeEvents(fn: (data: any) => any): { changed: number; deleted: number } {
    const changes: { id: number; data: string | null }[] = [];
    for (const row of this.db.prepare("SELECT id, data FROM events WHERE kind = 'claude'").iterate() as Iterable<any>) {
      const next = fn(JSON.parse(row.data));
      const data = next == null ? null : JSON.stringify(next);
      if (data !== row.data) changes.push({ id: row.id, data });
    }
    const update = this.db.prepare('UPDATE events SET data = ? WHERE id = ?');
    const remove = this.db.prepare('DELETE FROM events WHERE id = ?');
    this.db.exec('BEGIN');
    try {
      for (const c of changes) c.data == null ? remove.run(c.id) : update.run(c.data, c.id);
      // Task-list states saved from the old events (planKey) no longer match them.
      if (changes.length) this.db.prepare("DELETE FROM settings WHERE key LIKE 'plan:%'").run();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const deleted = changes.filter((c) => c.data == null).length;
    if (deleted) { // a deleted newest id can come back, below recentCards' `upTo`, as a card
      this.cardFates.clear();
      this.savedFates.clear();
      this.db.prepare('DELETE FROM card_fates').run();
      this.cardRows.clear();
    }
    return { changed: changes.length - deleted, deleted };
  }

  /** Newest-first messages and Claude output in a project whose raw JSON contains the text (case-insensitive for ASCII). */
  findEvents(projectId: number, text: string, limit = 3000, ticketId?: number): EventRow[] {
    // The data is JSON text: a quote, backslash or line break is stored escaped, so the needle is too.
    const like = `%${JSON.stringify(text).slice(1, -1).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return this.db
      .prepare(`SELECT e.* FROM events e JOIN tickets t ON t.id = e.ticket_id
        WHERE t.project_id = ? AND e.kind IN ('user_message', 'claude') AND e.data LIKE ? ESCAPE '\\' ${ticketId ? 'AND e.ticket_id = ?' : ''}
        ORDER BY e.id DESC LIMIT ?`)
      .all(projectId, like, ...(ticketId ? [ticketId] : []), limit) as unknown as EventRow[];
  }

  /** PR events already handled for a ticket (keys starting with `prefix`, which is stripped). */
  githubSeen(ticketId: number, prefix: string): string[] {
    const like = `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return (this.db.prepare("SELECT key FROM github_seen WHERE ticket_id = ? AND key LIKE ? ESCAPE '\\'").all(ticketId, like) as { key: string }[])
      .map((r) => r.key.slice(prefix.length));
  }

  /** Record PR events as handled; `delivered` says whether any were sent to the ticket. */
  addGithubSeen(ticketId: number, keys: string[], delivered: boolean) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO github_seen (ticket_id, key, delivered, created_at) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    this.db.exec('BEGIN');
    try {
      for (const k of keys) insert.run(ticketId, k, delivered ? 1 : 0, now);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * When a ticket's turns since `since` started and ended: a turn starts with Claude's init event
   * and ends with its result, an error, or a stop or restart note.
   */
  turnMarks(ticketId: number, since: number): { at: number; start: boolean }[] {
    const rows = this.db
      .prepare(`SELECT created_at, kind, data FROM events WHERE ticket_id = ? AND created_at >= ? AND (
          (kind = 'claude' AND (data LIKE '{"type":"system","subtype":"init"%' OR data LIKE '{"type":"result"%'))
          OR kind = 'error'
          OR (kind = 'note' AND (data LIKE '{"text":"Stopped by user.%' OR data LIKE '{"text":"The server restarted during this turn%')))
        ORDER BY id`)
      .all(ticketId, since) as { created_at: number; kind: string; data: string }[];
    return rows.map((r) => ({ at: r.created_at, start: r.kind === 'claude' && r.data.startsWith('{"type":"system"') }));
  }

  /**
   * Store a finished turn. Its cost is the session's running total minus the total at the session's
   * previous turn; a total that went down means Claude Code started counting afresh (it restores the
   * running total on --resume only when the session was the last one run in that folder), so the
   * whole total is this turn's.
   */
  recordTurn(ticketId: number, r: TurnResult): Turn {
    const last = (side: boolean, session?: string | null) => this.db
      .prepare(`SELECT id, session_id, session_cost_usd FROM turns WHERE ticket_id = ? AND side IS ?${session ? ' AND session_id = ?' : ''} ORDER BY id DESC LIMIT 1`)
      .get(ticketId, side ? 1 : null, ...(session ? [session] : [])) as { id: number; session_id: string | null; session_cost_usd: number } | undefined;
    // A side thread's turns follow its own fork's (threads interleave); the fork's first starts from its parent's total.
    const prev = r.side && r.session_id ? last(true, r.session_id) ?? (r.fork_of ? last(false, r.fork_of) : undefined) : last(!!r.side);
    const sameSession = prev && (prev.session_id ?? null) === (r.session_id ?? null) || (r.side && !!r.fork_of && prev?.session_id === r.fork_of);
    const base = sameSession && prev.session_cost_usd <= r.session_cost_usd ? prev.session_cost_usd : 0;
    const u = r.usage ?? null;
    const n = (v: unknown) => (typeof v === 'number' ? v : null);
    const row = this.db
      .prepare(`INSERT INTO turns (ticket_id, event_id, session_id, ended_at, cost_usd, session_cost_usd, duration_ms,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, payer, keepalive, account, prompt_digest, side) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(ticketId, r.event_id ?? null, r.session_id ?? null, r.ended_at, r.session_cost_usd - base, r.session_cost_usd,
        n(r.duration_ms), n(u?.input_tokens), n(u?.output_tokens), n(u?.cache_read_input_tokens), n(u?.cache_creation_input_tokens), r.payer ?? null, r.keepalive ? 1 : null,
        n(r.account), r.hashes ? JSON.stringify(r.hashes) : null, r.side ? 1 : null) as unknown as Turn;
    // Each model's running total, less its total at the session's previous turn, as the whole turn's cost is (#905).
    const models = r.modelUsage && typeof r.modelUsage === 'object' ? Object.entries(r.modelUsage) : [];
    const was = this.db.prepare('SELECT session_cost_usd FROM turn_models WHERE turn_id = ? AND model = ?');
    const add = this.db.prepare('INSERT INTO turn_models (turn_id, model, cost_usd, session_cost_usd) VALUES (?, ?, ?, ?)');
    const totals = models.flatMap(([model, m]) => {
      const total = (m as any)?.costUSD;
      return typeof total === 'number' && Number.isFinite(total) && total >= 0 && model ? [[model.slice(0, 100), total] as const] : [];
    });
    // The session's previous turn ran before the split was kept: its share of each model is unknown, so split this turn's cost pro rata.
    const unsplit = base > 0 && !this.db.prepare('SELECT 1 FROM turn_models WHERE turn_id = ?').get(prev!.id);
    const sum = totals.reduce((a, [, t]) => a + t, 0);
    for (const [model, total] of totals) {
      const before = base > 0 && !unsplit ? (was.get(prev!.id, model) as { session_cost_usd: number } | undefined)?.session_cost_usd ?? 0 : 0;
      add.run(row.id, model, unsplit ? (sum ? row.cost_usd * total / sum : 0) : before <= total ? total - before : total, total);
    }
    return row;
  }

  /** Keep a turn's Grunts (#948). A Grunt already kept (it was still running at an earlier turn's end) has its calls and cost refreshed, and stays under the turn that first saw it. */
  recordGrunts(turnId: number, rows: GruntRow[]) {
    const put = this.db.prepare(`INSERT INTO turn_grunts (agent_id, turn_id, agent_type, model, effort, calls, cost_usd, request_shape, spawn_depth, description)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET calls = excluded.calls, cost_usd = excluded.cost_usd, model = excluded.model, effort = excluded.effort`);
    for (const g of rows) put.run(g.agent_id, turnId, g.agent_type, g.model, g.effort, g.calls, g.cost_usd, g.request_shape, g.spawn_depth, g.description);
  }

  /** Minions' turns that ended since `since`, oldest first, for the keepalive readout and its miss check (#862). */
  minionTurnsSince(since: number): KeepaliveRow[] {
    return this.db
      .prepare(`SELECT t.ticket_id, t.ended_at, t.duration_ms, t.cost_usd, t.input_tokens, t.output_tokens,
          t.cache_read_tokens, t.cache_write_tokens, t.keepalive FROM turns t JOIN tickets k ON k.id = t.ticket_id
          WHERE t.ended_at >= ? AND k.kind != 'coordinator' AND t.side IS NULL ORDER BY t.ended_at, t.id`)
      .all(since) as unknown as KeepaliveRow[];
  }

  /** A minion's latest turns' hash logs (#878), newest first, with how much of each turn's prompt came from the cache. */
  promptHashes(ticketId: number, limit = 1): { ended_at: number; cache_read_tokens: number | null; cache_write_tokens: number | null; hashes: PromptHashes }[] {
    const rows = this.db.prepare(`SELECT ended_at, cache_read_tokens, cache_write_tokens, prompt_digest FROM turns
        WHERE ticket_id = ? AND prompt_digest IS NOT NULL ORDER BY id DESC LIMIT ?`).all(ticketId, limit) as any[];
    return rows.map(({ prompt_digest, ...r }) => ({ ...r, hashes: JSON.parse(prompt_digest) }));
  }

  /**
   * Fill the turns table from stored result events, for turns from before it existed. Session ids
   * come from each turn's init event. Only runs on an empty table; returns how many turns it added.
   */
  backfillTurns(): number {
    if ((this.db.prepare('SELECT 1 FROM turns LIMIT 1').get())) return 0;
    const rows = this.db
      .prepare(`SELECT id, ticket_id, data, created_at FROM events WHERE kind = 'claude'
          AND (data LIKE '{"type":"system","subtype":"init"%' OR data LIKE '{"type":"result"%') ORDER BY id`)
      .iterate() as Iterable<{ id: number; ticket_id: number; data: string; created_at: number }>;
    const session = new Map<number, string | null>();
    let added = 0;
    this.db.exec('BEGIN');
    try {
      for (const row of rows) {
        const ev = JSON.parse(row.data);
        if (ev.type === 'system') {
          session.set(row.ticket_id, ev.session_id ?? null);
        } else if (typeof ev.total_cost_usd === 'number') {
          this.recordTurn(row.ticket_id, {
            event_id: row.id, session_id: session.get(row.ticket_id) ?? null, ended_at: row.created_at,
            session_cost_usd: ev.total_cost_usd, duration_ms: ev.duration_ms,
          });
          added++;
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return added;
  }

  /** A ticket's turns, oldest first. */
  listTurns(ticketId: number): Turn[] {
    return this.db.prepare('SELECT * FROM turns WHERE ticket_id = ? ORDER BY id').all(ticketId) as unknown as Turn[];
  }

  /** Record finished steps (#571, public/progress.js applyEvent's `finished`); one already recorded (same start) is kept. */
  addStepTimes(ticketId: number, steps: FinishedStep[], effort: string | null) {
    if (!steps.length) return;
    const add = this.db.prepare(`INSERT OR IGNORE INTO step_times (ticket_id, task_id, subject, estimate, started_at, finished_at, work_ms, model, effort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    this.db.exec('BEGIN');
    try {
      for (const s of steps) add.run(ticketId, s.id, s.subject, s.estimate, s.startedAt, s.finishedAt, Math.round(s.work), s.model, effort);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * What steps really took against their guesses (#571): working minutes over guessed minutes, summed over the
   * newest STEP_RATIO.recent finished steps with a guess. The scheme's own once it has STEP_RATIO.scheme of them,
   * else every scheme's, and 1 until there are STEP_RATIO.least anywhere. A sum, not the median step's ratio:
   * that undershoots whole plans (progress-estimates-2026-11 report).
   */
  stepRatio(projectId: number): number {
    const sum = (where: string, ...args: number[]) => this.db.prepare(`SELECT COUNT(*) AS n, SUM(work_ms) AS work, SUM(estimate) AS guess FROM (
      SELECT s.work_ms, s.estimate FROM step_times s JOIN tickets t ON t.id = s.ticket_id WHERE s.estimate IS NOT NULL ${where}
      ORDER BY s.finished_at DESC LIMIT ${STEP_RATIO.recent})`).get(...args) as { n: number; work: number | null; guess: number | null };
    const own = sum('AND t.project_id = ?', projectId);
    const pick = own.n >= STEP_RATIO.scheme ? own : sum('');
    const ratio = pick.n >= STEP_RATIO.least && pick.guess ? pick.work! / 60_000 / pick.guess : 1;
    return ratio > 0 ? ratio : 1;
  }

  /** When a ticket's last finished turn ended (ms), or null before its first. */
  lastTurnEnd(ticketId: number): number | null {
    // A side question's fork (#932) isn't the minion's turn: its prefix may sit on another login, and the minion's own is no warmer for it.
    return scoped(this.db, `last-turn-end:${ticketId}`, () => (this.db.prepare('SELECT ended_at FROM turns WHERE ticket_id = ? AND side IS NULL ORDER BY id DESC LIMIT 1').get(ticketId) as { ended_at: number } | undefined)?.ended_at ?? null);
  }

  /** What a ticket's turns have cost so far; `hostOnly`: the server login's turns only. */
  ticketCost(ticketId: number, hostOnly = false): number {
    return scoped(this.db, `cost:${ticketId}:${hostOnly}`, () => (this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM turns WHERE ticket_id = ?${hostOnly ? ' AND payer IS NULL' : ''}`).get(ticketId) as { c: number }).c);
  }

  /**
   * Every closed minion created since `since` that cost anything (open ones are still short of their final cost), every scheme (#1114): its `type` property (null untyped),
   * the model it was set to or last ran on, and what its turns cost. src/minion-budget.ts takes the usual cost from these.
   */
  minionCosts(since: number): { type: string | null; model: string | null; cost: number }[] {
    return this.db.prepare(`SELECT (SELECT p.value FROM properties p JOIN property_keys pk ON pk.id = p.key_id
          WHERE p.target_type = 'minion' AND p.target_id = k.id AND pk.key = 'type' LIMIT 1) AS type,
        coalesce(k.model, k.last_model) AS model, c.cost
      FROM tickets k JOIN (SELECT ticket_id, SUM(cost_usd) AS cost FROM turns GROUP BY ticket_id) c ON c.ticket_id = k.id
      WHERE k.kind = 'ticket' AND k.status = 'closed' AND k.created_at >= ? AND c.cost > 0`).all(since) as unknown as { type: string | null; model: string | null; cost: number }[];
  }

  /** Cost per local day ('2026-10-28') and project, for turns ended at or after `since`; `hostOnly`: the server login's turns only. */
  dailyCosts(since: number, hostOnly = false): { day: string; project_id: number; cost: number; turns: number }[] {
    return this.db
      .prepare(`SELECT date(u.ended_at / 1000, 'unixepoch', 'localtime') AS day, t.project_id, SUM(u.cost_usd) AS cost, COUNT(*) AS turns
          FROM turns u JOIN tickets t ON t.id = u.ticket_id WHERE u.ended_at >= ? ${hostOnly ? 'AND u.payer IS NULL ' : ''}GROUP BY day, t.project_id ORDER BY day`)
      .all(since) as unknown as { day: string; project_id: number; cost: number; turns: number }[];
  }

  /** Spend since `since` by payer (null: the server login) and project, every payer's turns (#689). */
  spendByPayer(since: number): { payer: number | null; project_id: number; cost: number }[] {
    return this.db
      .prepare('SELECT u.payer, t.project_id, SUM(u.cost_usd) AS cost FROM turns u JOIN tickets t ON t.id = u.ticket_id WHERE u.ended_at >= ? GROUP BY u.payer, t.project_id')
      .all(since) as unknown as { payer: number | null; project_id: number; cost: number }[];
  }

  /** What one payer's turns on one of their accounts cost since `since`; a turn from before #905 kept no account and counts as account 1's. */
  accountSpend(payer: number | null, account: number, since: number): number | null {
    // Turns kept no account before #905, so a window holding one of those can't be split by account (keepalive pings keep none, and cost next to nothing).
    if (this.db.prepare('SELECT 1 FROM turns WHERE payer IS ? AND ended_at >= ? AND account IS NULL AND keepalive IS NULL LIMIT 1').get(payer, since)) return null;
    return (this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM turns WHERE payer IS ? AND ended_at >= ? AND ${account === 1 ? '(account IS NULL OR account = 1)' : 'account = ?'}`)
      .get(payer, since, ...(account === 1 ? [] : [account])) as { c: number }).c;
  }

  /**
   * One payer's turns that ended in [since, until), summed in the database to one row per minion, kind of turn and model (#905,
   * #956: all time stays a few thousand rows, never one per turn). Turns from before the split was kept sum under `model` null.
   */
  spendRows(payer: number | null, since: number, until: number): SpendRowRaw[] {
    return this.db
      .prepare(`SELECT u.ticket_id, u.keepalive, u.side, k.project_id, k.number, k.title, k.kind, k.created_by,
          coalesce(k.last_model, k.model) AS minion_model, m.model, sum(coalesce(m.cost_usd, u.cost_usd)) AS cost,
          (SELECT p.value FROM properties p JOIN property_keys pk ON pk.id = p.key_id
            WHERE p.target_type = 'minion' AND p.target_id = k.id AND pk.key = 'type' LIMIT 1) AS type
        FROM turns u JOIN tickets k ON k.id = u.ticket_id LEFT JOIN turn_models m ON m.turn_id = u.id
        WHERE u.ended_at >= ? AND u.ended_at < ? AND u.payer IS ?
        GROUP BY u.ticket_id, u.keepalive, u.side, m.model`)
      .all(since, until, payer) as unknown as SpendRowRaw[];
  }

  /** Health readings of these kinds since `since`, oldest first (#1123, the Status page). */
  healthEventsSince(kinds: string[], since: number): { kind: string; at: number; commit_sha: string | null; detail: string }[] {
    return this.db.prepare(`SELECT kind, at, commit_sha, detail FROM health_events WHERE kind IN (${kinds.map(() => '?').join(', ')}) AND at >= ? ORDER BY at`)
      .all(...kinds, since) as unknown as { kind: string; at: number; commit_sha: string | null; detail: string }[];
  }

  /** One reading of perigee's memory, disk and load (#1123); drops readings past HOST_SAMPLE_KEEP_MS. */
  addHostSample(s: HostSample) {
    this.db.prepare('INSERT OR REPLACE INTO host_samples (at, mem_total, mem_avail, disk_total, disk_free, load1, rss, cpu_psi, mem_psi, io_psi, swap_used, cpu_ledger, answer_time, db_cached, db_size, kswapd_rate, refault_rate, server_refault_rate, pgpgin_rate, thp_fallback_rate, warm_ms, warm_mb, warm_backoffs, open_fds, supervisors, tmp_used, app_mem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(s.at, s.mem_total, s.mem_avail, s.disk_total, s.disk_free, s.load1, s.rss, s.cpu_psi ?? null, s.mem_psi ?? null, s.io_psi ?? null, s.swap_used ?? null, s.cpu_ledger ?? null, s.answer_time ?? null,
        s.db_cached ?? null, s.db_size ?? null, s.kswapd_rate ?? null, s.refault_rate ?? null, s.server_refault_rate ?? null, s.pgpgin_rate ?? null, s.thp_fallback_rate ?? null,
        s.warm_ms ?? null, s.warm_mb ?? null, s.warm_backoffs ?? null, s.open_fds ?? null, s.supervisors ?? null, s.tmp_used ?? null, s.app_mem ?? null);
    this.db.prepare('DELETE FROM host_samples WHERE at < ?').run(s.at - HOST_SAMPLE_KEEP_MS);
  }

  hostSamples(since: number): HostSample[] {
    return this.db.prepare('SELECT * FROM host_samples WHERE at >= ? ORDER BY at').all(since) as unknown as HostSample[];
  }

  /** A scheme's releases of one target started or live since `since`, oldest first (#1123). */
  releasesSince(projectId: number, target: string, since: number): ReleaseRow[] {
    return this.db.prepare('SELECT * FROM releases WHERE project_id = ? AND target = ? AND coalesce(live_at, started_at) >= ? ORDER BY id')
      .all(projectId, target, since) as unknown as ReleaseRow[];
  }

  /** Every scheme's releases that went live since `since`, with a start (#1132). */
  liveReleasesSince(since: number): ReleaseRow[] {
    return this.db.prepare("SELECT * FROM releases WHERE outcome = 'live' AND live_at >= ? AND started_at IS NOT NULL ORDER BY id").all(since) as unknown as ReleaseRow[];
  }

  /** Every app's deploys that went live since `since`, with their stages (#1132). */
  deployedSince(since: number): ContraptionDeployRow[] {
    return this.db.prepare("SELECT * FROM contraption_deploys WHERE outcome = 'deployed' AND finished_at >= ? ORDER BY id").all(since) as unknown as ContraptionDeployRow[];
  }

  /** An app's deploys started since `since`, oldest first (#1123). */
  appDeploysSince(name: string, since: number): { started_at: number; finished_at: number | null; outcome: string; to_sha: string | null; by: string }[] {
    return this.db.prepare('SELECT started_at, finished_at, outcome, to_sha, by FROM contraption_deploys WHERE name = ? AND started_at >= ? ORDER BY started_at, id')
      .all(name, since) as unknown as { started_at: number; finished_at: number | null; outcome: string; to_sha: string | null; by: string }[];
  }

  /** An app's error counts per Pacific day, kind and key from `fromDay` on (#1123). */
  appErrorsSince(contraptionId: number, fromDay: string): { day: string; kind: string; key: string; count: number; sample: string; last_at: number }[] {
    return this.db.prepare("SELECT day, kind, key, count, sample, last_at FROM contraption_errors WHERE contraption_id = ? AND day >= ? AND kind != 'deploy' ORDER BY day, count DESC")
      .all(contraptionId, fromDay) as unknown as { day: string; kind: string; key: string; count: number; sample: string; last_at: number }[];
  }

  /** An app's agent turns started since `since`: when, whose, and its tokens (#1123). */
  appTurnsSince(contraptionId: number, since: number): { started_at: number; person: string; outcome: string | null; tokens: number }[] {
    return this.db.prepare(`SELECT t.started_at, u.name AS person, t.outcome, coalesce(t.input_tokens, 0) + coalesce(t.output_tokens, 0) + coalesce(t.cache_read_tokens, 0) + coalesce(t.cache_write_tokens, 0) AS tokens
      FROM contraption_turns t JOIN users u ON u.id = t.user_id WHERE t.contraption_id = ? AND t.started_at >= ? ORDER BY t.started_at`).all(contraptionId, since) as unknown as { started_at: number; person: string; outcome: string | null; tokens: number }[];
  }

  /** Bug minions of every scheme created since `since`, with their brief's first 4,000 characters: the third-fix flag's pool (#1157). */
  bugBriefs(since: number): { project_id: number; number: number; title: string; at: number; brief: string }[] {
    return this.db
      .prepare(`SELECT k.project_id, k.number, k.title, k.created_at AS at,
          coalesce((SELECT substr(json_extract(e.data, '$.text'), 1, 4000) FROM events e WHERE e.ticket_id = k.id AND e.kind = 'user_message' ORDER BY e.id LIMIT 1), '') AS brief
        FROM tickets k JOIN properties p ON p.target_type = 'minion' AND p.target_id = k.id JOIN property_keys pk ON pk.id = p.key_id AND pk.key = 'type'
        WHERE k.created_at >= ? AND k.kind != 'coordinator' AND k.number IS NOT NULL AND p.value = 'bug'`)
      .all(since) as unknown as { project_id: number; number: number; title: string; at: number; brief: string }[];
  }

  /** Record a health reading (#724); every 100th insert also drops rows past HEALTH_KEEP_MS and HEALTH_MAX_ROWS. */
  addHealthEvent(kind: string, at: number, commit: string | null, detail: string) {
    const { id } = this.db.prepare('INSERT INTO health_events (kind, at, commit_sha, detail) VALUES (?, ?, ?, ?) RETURNING id').get(kind, at, commit, detail.slice(0, 1000)) as { id: number };
    if (Number(id) % 100 === 0) {
      this.db.prepare('DELETE FROM health_events WHERE at < ?').run(at - HEALTH_KEEP_MS);
      // Boots, slow-ship nudges, Investigate clicks and looks (#1273) are few and the Status page and the once-a-day rule need them: only the time keep drops them.
      this.db.prepare("DELETE FROM health_events WHERE id <= ? AND kind NOT IN ('boot', 'live', 'stop', 'ship-slow', 'investigate', 'look')").run(Number(id) - HEALTH_MAX_ROWS);
    }
  }

  /** Record the flakes of one run (#1063); rows older than FLAKE_KEEP_MS go with each write. */
  addFlakeEvents(projectId: number, ticketId: number | null, commit: string | null, at: number, flakes: { file: string; source: string; detail: string; testName?: string; message?: string; cls?: string }[]) {
    const add = this.db.prepare('INSERT INTO flake_events (project_id, file, at, commit_sha, ticket_id, source, detail, test_name, message, class) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const f of flakes) add.run(projectId, f.file.slice(0, 200), at, commit, ticketId, f.source.slice(0, 40), f.detail.slice(0, 1500), (f.testName ?? '').slice(0, 200), (f.message ?? '').slice(0, 600), (f.cls ?? '').slice(0, 40));
    if (flakes.length) this.db.prepare('DELETE FROM flake_events WHERE at < ?').run(at - FLAKE_KEEP_MS);
  }

  /** A scheme's flakiest test files since `since`: how often, when last, and the minion whose land saw the last one. */
  flakeCounts(projectId: number, since: number, limit = 10): { file: string; count: number; last: number; ticketId: number | null }[] {
    return this.db.prepare(`SELECT file, COUNT(*) AS count, MAX(at) AS last,
        (SELECT e2.ticket_id FROM flake_events e2 WHERE e2.project_id = e.project_id AND e2.file = e.file ORDER BY e2.at DESC, e2.id DESC LIMIT 1) AS ticketId
      FROM flake_events e WHERE project_id = ? AND at >= ? GROUP BY file ORDER BY count DESC, last DESC LIMIT ?`).all(projectId, since, limit) as any;
  }

  /** Whether `file` already has a sighting within `tolMs` of `at`: a retro-log line the server already counted from the land's own output. */
  hasFlakeNear(projectId: number, file: string, at: number, tolMs: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM flake_events WHERE project_id = ? AND file = ? AND at BETWEEN ? AND ? LIMIT 1').get(projectId, file, at - tolMs, at + tolMs);
  }

  /** Sighting times of `file` since `since`, oldest first. */
  flakeSightings(projectId: number, file: string, since: number): number[] {
    return (this.db.prepare('SELECT at FROM flake_events WHERE project_id = ? AND file = ? AND at >= ? ORDER BY at').all(projectId, file, since) as { at: number }[]).map((r) => r.at);
  }

  /** Files with a sighting since `since`. */
  flakeFiles(projectId: number, since: number): string[] {
    return (this.db.prepare('SELECT DISTINCT file FROM flake_events WHERE project_id = ? AND at >= ?').all(projectId, since) as { file: string }[]).map((r) => r.file);
  }

  /** The newest fix of a file (#1120), or undefined. */
  flakeFix(projectId: number, file: string): FlakeFix | undefined {
    return this.db.prepare('SELECT * FROM flake_fixes WHERE project_id = ? AND file = ? ORDER BY id DESC LIMIT 1').get(projectId, file) as FlakeFix | undefined;
  }

  flakeFixes(projectId: number): FlakeFix[] {
    return this.db.prepare('SELECT * FROM flake_fixes WHERE project_id = ? ORDER BY id DESC').all(projectId) as unknown as FlakeFix[];
  }

  addFlakeFix(projectId: number, file: string, ticketId: number | null, startedAt: number, patch: Partial<FlakeFix> = {}): number {
    const r = this.db.prepare('INSERT INTO flake_fixes (project_id, file, ticket_id, state, started_at, clean_runs, held_at, reopened) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(projectId, file, ticketId, patch.state ?? 'open', startedAt, patch.clean_runs ?? 0, patch.held_at ?? null, patch.reopened ?? 0);
    return Number(r.lastInsertRowid);
  }

  updateFlakeFix(id: number, patch: Partial<Omit<FlakeFix, 'id' | 'project_id' | 'file'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE flake_fixes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k] as any), id);
  }

  /** The newest `n` failing outputs kept for a file. */
  flakeDetails(projectId: number, file: string, n = 3): { at: number; detail: string }[] {
    return this.db.prepare("SELECT at, detail FROM flake_events WHERE project_id = ? AND file = ? AND detail != '' ORDER BY at DESC, id DESC LIMIT ?").all(projectId, file, n) as any;
  }

  /** How many `kind` readings fell in [from, to), the first one's time, and the commonest details with their counts. */
  healthCount(kind: string, from: number, to: number, top = 3): { count: number; first: number | null; top: { detail: string; n: number }[] } {
    const { count, first } = this.db.prepare('SELECT COUNT(*) AS count, MIN(at) AS first FROM health_events WHERE kind = ? AND at >= ? AND at < ?').get(kind, from, to) as { count: number; first: number | null };
    const rows = count ? (this.db.prepare('SELECT detail, COUNT(*) AS n FROM health_events WHERE kind = ? AND at >= ? AND at < ? GROUP BY detail ORDER BY n DESC, MIN(at) LIMIT ?').all(kind, from, to, top) as { detail: string; n: number }[]) : [];
    return { count: Number(count), first: first ?? null, top: rows.map((r) => ({ detail: r.detail, n: Number(r.n) })) };
  }

  /** The readings in [from, to), oldest first, at most `limit`, of `kinds` only if given: an incident's timeline (#1145). */
  healthBetween(from: number, to: number, limit: number, kinds?: string[]): { at: number; kind: string; commit_sha: string | null; detail: string }[] {
    const only = kinds?.length ? ` AND kind IN (${kinds.map(() => '?').join(', ')})` : '';
    return this.db.prepare(`SELECT at, kind, commit_sha, detail FROM health_events WHERE at >= ? AND at < ?${only} ORDER BY at, id LIMIT ?`).all(from, to, ...(kinds ?? []), limit) as any;
  }

  /** The newest `kind` reading before `before` (#1135: the last stall before a watchdog restart), or null. */
  lastHealthEvent(kind: string, before: number): { at: number; detail: string } | null {
    return (this.db.prepare('SELECT at, detail FROM health_events WHERE kind = ? AND at < ? ORDER BY at DESC LIMIT 1').get(kind, before) as { at: number; detail: string } | undefined) ?? null;
  }

  /** The first event id created at or after `at`, by halving over ids (they grow with time), or one past the last: events has no index on time. */
  eventIdAt(at: number): number {
    // Two one-row lookups on the primary key: the one-query MIN(id), MAX(id) scanned the whole events table (0.7-1.3 s of stall).
    const first = this.db.prepare('SELECT id FROM events ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    const last = this.db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
    if (!first || !last) return 1;
    const ends = { lo: first.id, hi: last.id };
    const next = this.db.prepare('SELECT id, created_at FROM events WHERE id >= ? ORDER BY id LIMIT 1');
    let lo = Number(ends.lo), hi = Number(ends.hi) + 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const row = next.get(mid) as { id: number; created_at: number } | undefined;
      if (!row || row.created_at >= at) hi = mid;
      else lo = Number(row.id) + 1;
    }
    return lo;
  }

  /**
   * How turns ended in [from, to) (#724): every finished turn (the turns table) plus every error event (a turn that
   * couldn't start or crashed), minus the turns that stopped on "Not logged in" (loggedOut: their accounts) or on a usage limit ("You've hit your 5-hour limit", USAGE_LIMIT: a person's
   * plan running out says nothing about a deploy, and they are left out of both counts), how many of those failed (a result with is_error, or an error), and the first failure's time.
   */
  turnOutcomes(from: number, to: number): { turns: number; failed: number; first: number | null; loggedOut: number[] } {
    const ok = this.db.prepare(`SELECT COUNT(*) AS n, SUM(e.data LIKE '%"is_error":true%') AS bad, MIN(CASE WHEN e.data LIKE '%"is_error":true%' THEN t.ended_at END) AS first
        FROM turns t LEFT JOIN events e ON e.id = t.event_id WHERE t.ended_at >= ? AND t.ended_at < ? AND t.keepalive IS NULL AND t.side IS NULL AND NOT COALESCE(e.data LIKE '%"is_error":true%' AND (e.data LIKE '%hit your %limit%' OR e.data LIKE '%Not logged in%'), 0)`).get(from, to) as { n: number; bad: number | null; first: number | null };
    // Through events_errors: without it this read every event of the window (43 ms a day's window, #1178), eventIdAt or not.
    const errs = this.db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM events WHERE kind = 'error' AND created_at >= ? AND created_at < ? AND data NOT LIKE '%hit your %limit%' AND data NOT LIKE '%Not logged in%'")
      .get(from, to) as { n: number; first: number | null };
    // Left out too ("Not logged in", #1481: one account's login dropping after a deploy isn't the deploy's fault), but named, so a real logout shows: the account numbers (a turn from before #905 kept none: account 1). shortcut: only finished turns are named; a "Not logged in" error event has no account, so it is left out unnamed, name those if one ever shows up.
    const out = this.db.prepare(`SELECT DISTINCT COALESCE(t.account, 1) AS a FROM turns t JOIN events e ON e.id = t.event_id WHERE t.ended_at >= ? AND t.ended_at < ? AND t.keepalive IS NULL AND t.side IS NULL AND e.data LIKE '%"is_error":true%' AND e.data LIKE '%Not logged in%' ORDER BY a`).all(from, to) as { a: number }[];
    const firsts = [ok.first, errs.first].filter((f): f is number => f != null);
    return { turns: Number(ok.n) + Number(errs.n), failed: Number(ok.bad ?? 0) + Number(errs.n), first: firsts.length ? Math.min(...firsts) : null, loggedOut: out.map((r) => Number(r.a)) };
  }

  /** The "Shipped <commit> …" notes LandHandoffs posted at or after `since`: the main commit each land moved to, and its minion. */
  shippedSince(since: number): { ticket_id: number; commit: string }[] {
    const rows = this.db.prepare(`SELECT ticket_id, data FROM events WHERE id >= ? AND kind = 'note' AND data LIKE '{"text":"Shipped %' ORDER BY id`).all(this.eventIdAt(since)) as { ticket_id: number; data: string }[];
    return rows.flatMap((r) => {
      const m = /^Shipped ([0-9a-f]{7,40}) /.exec(JSON.parse(r.data).text ?? '');
      return m ? [{ ticket_id: Number(r.ticket_id), commit: m[1] }] : [];
    });
  }

  /** The "Shipped …" notes posted at or after `since`, newest first, each with its minion's scheme, number and title: Home's "Shipped since your last visit" (#1140). A push that failed isn't one; one waiting for the restart is (main has it).
   * `ids`, [from, to): only the notes of those event ids, `since` aside: Home's paced first read, a range at a time (#1414). */
  shippedNotes(since: number, ids?: [number, number]): { ticket_id: number; project_id: number; number: number | null; kind: TicketKind; title: string; text: string; at: number }[] {
    return this.db.prepare(`SELECT e.ticket_id, t.project_id, t.number, t.kind, t.title, json_extract(e.data, '$.text') AS text, e.created_at AS at
      FROM events e JOIN tickets t ON t.id = e.ticket_id WHERE e.id >= ? AND e.id < ? AND e.kind = 'note' AND e.data LIKE '{"text":"Shipped %'
      AND e.data NOT LIKE '%not pushed to origin: the push failed.%' ORDER BY e.id DESC`)
      .all(...(ids ?? [this.eventIdAt(since), Number.MAX_SAFE_INTEGER])) as ReturnType<Store['shippedNotes']>;
  }

  /** Every ship note ("Shipped …", "Merged …") posted at or after `since`, with its scheme (#1196): ship-risk's input. */
  shipNotesSince(since: number): { project_id: number; created_at: number; text: string }[] {
    const rows = this.db.prepare(`SELECT t.project_id, e.created_at, e.data FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE e.id >= ? AND e.created_at >= ? AND e.kind = 'note' AND (e.data LIKE '{"text":"Shipped %' OR e.data LIKE '{"text":"Merged %') ORDER BY e.id`).all(this.eventIdAt(since), since) as { project_id: number; created_at: number; data: string }[];
    return rows.map((r) => ({ project_id: Number(r.project_id), created_at: Number(r.created_at), text: String(JSON.parse(r.data).text ?? '') }));
  }

  getSetting<T>(key: string): T | null {
    // The text, not the parsed value, is what a read scope keeps: each caller gets its own copy to change.
    const value = scoped(this.db, `setting:${key}`, () => (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null);
    return value == null ? null : JSON.parse(value);
  }

  /** Every setting whose key starts with `prefix`, as key and value. */
  settingsWithPrefix<T>(prefix: string): { key: string; value: T }[] {
    // A range on the key's index like settingKeys: LIKE with ESCAPE read every row of the table (part of a 0.6 s hold in fableMeter, #1251).
    const [where, args] = this.keyRange(prefix);
    return (this.db.prepare(`SELECT key, value FROM settings WHERE ${where} ORDER BY key`).all(...args) as { key: string; value: string }[])
      .map((r) => ({ key: r.key, value: JSON.parse(r.value) as T }));
  }

  /** What every payer's Fable turns cost since `since` (#1061), from the per-model split, so turns before it was kept count for nothing. */
  fableSpend(since: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(m.cost_usd), 0) AS c FROM turn_models m JOIN turns u ON u.id = m.turn_id WHERE u.ended_at >= ? AND m.model LIKE '%fable%'").get(since) as { c: number }).c;
  }

  setSetting(key: string, value: unknown) {
    // An unchanged value writes nothing: ci-health alone rewrote 250 KB of the same job lists every 5 minutes (#680).
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value')
      .run(key, JSON.stringify(value));
  }

  /** Whether this connection checkpoints the WAL itself on commit (SQLite's default) or leaves it to checkpointOffThread (src/checkpoint.ts, #680). */
  autoCheckpoint(on: boolean) {
    this.db.exec(`PRAGMA wal_autocheckpoint = ${on ? 1000 : 0}`);
  }

  deleteSetting(key: string) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  /** Record a release of a scheme's target (src/releases.ts). */
  addRelease(r: Omit<ReleaseRow, 'id'>): number {
    return Number(this.db.prepare('INSERT INTO releases (project_id, target, version, changes, started_at, live_at, outcome, stages) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.project_id, r.target, r.version, r.changes, r.started_at, r.live_at, r.outcome, r.stages).lastInsertRowid);
  }

  /** Record a finished contraption deploy (src/release-readers.ts). */
  addContraptionDeploy(r: Omit<ContraptionDeployRow, 'id'>): number {
    return Number(this.db.prepare('INSERT INTO contraption_deploys (name, from_sha, to_sha, by, started_at, finished_at, outcome, stages, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.name, r.from_sha, r.to_sha, r.by, r.started_at, r.finished_at, r.outcome, r.stages, r.changes).lastInsertRowid);
  }

  /** A contraption's newest deploys (only those that ended as `outcome`, when given), newest first. */
  listContraptionDeploys(name: string, limit: number, outcome?: string): ContraptionDeployRow[] {
    return (outcome
      ? this.db.prepare('SELECT * FROM contraption_deploys WHERE name = ? AND outcome = ? ORDER BY id DESC LIMIT ?').all(name, outcome, limit)
      : this.db.prepare('SELECT * FROM contraption_deploys WHERE name = ? ORDER BY id DESC LIMIT ?').all(name, limit)) as unknown as ContraptionDeployRow[];
  }

  /**
   * How many releases a contraption has had, its newest deploy's number: its deploys that went live, plus the one it
   * served before its first recorded deploy (that deploy started from a commit), so numbers don't move once recording began.
   */
  contraptionReleases(name: string): number {
    return (this.db.prepare(`SELECT (SELECT COUNT(*) FROM contraption_deploys WHERE name = ? AND outcome = 'deployed')
      + COALESCE((SELECT from_sha IS NOT NULL FROM contraption_deploys WHERE name = ? ORDER BY id LIMIT 1), 0) AS n`).get(name, name) as { n: number }).n;
  }

  /** How many releases a target has recorded: its newest one's release number. */
  countReleases(projectId: number, target: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM releases WHERE project_id = ? AND target = ?').get(projectId, target) as { n: number }).n;
  }

  /** A target's newest releases, newest first. */
  listReleases(projectId: number, target: string, limit: number): ReleaseRow[] {
    return this.db.prepare('SELECT * FROM releases WHERE project_id = ? AND target = ? ORDER BY id DESC LIMIT ?').all(projectId, target, limit) as unknown as ReleaseRow[];
  }

  /** Every settings key starting with `prefix`. */
  settingKeys(prefix: string): string[] {
    const [where, args] = this.keyRange(prefix);
    return (this.db.prepare(`SELECT key FROM settings WHERE ${where} ORDER BY key`).all(...args) as { key: string }[]).map((r) => r.key);
  }

  /** The settings keys starting with `prefix`, as a range on the key's index: substr() alone scanned every key, 0.4 ms a call on the live table (#1029). */
  private keyRange(prefix: string): [string, (string | number)[]] {
    const last = prefix.codePointAt(prefix.length - 1);
    const upto = last === undefined || last >= 0xd800 ? null : prefix.slice(0, -1) + String.fromCodePoint(last + 1);
    return [`key >= ? ${upto === null ? '' : 'AND key < ?'} AND substr(key, 1, ?) = ?`, [prefix, upto, prefix.length, prefix].filter((v) => v !== null)];
  }
}

/**
 * Each area's queries live in src/db/<area>.ts and are attached to Store's prototype here (#1313), so callers keep calling
 * store.listMachines() and the rest. A new query goes in its area's file, not the class above: test/db-areas.test.ts fails on that.
 */
// One area per line, so two branches adding areas touch different lines (#1313: a single long list here was a conflict hotspot).
const AREAS = [
  ciNumberQueries,
  contraptionRunQueries,
  deliveryQueries,
  flakeQueries,
  machineQueries,
  minionQueries,
  pushQueries,
  readWarmQueries,
  settingQueries,
  slowMomentQueries,
  viewQueries,
];
// The same list as a type: written out, since a type taken from AREAS would loop through Store's own type.
type Areas =
  & typeof ciNumberQueries
  & typeof contraptionRunQueries
  & typeof deliveryQueries
  & typeof flakeQueries
  & typeof machineQueries
  & typeof minionQueries
  & typeof pushQueries
  & typeof readWarmQueries
  & typeof settingQueries
  & typeof slowMomentQueries
  & typeof viewQueries;
// Without `this: Store` on the class's side, so a caller holding a Pick<Store, ...> can still call them.
type AreaQueries = { [K in keyof Areas]: OmitThisParameter<Areas[K]> };
export interface Store extends AreaQueries {}
for (const area of AREAS) {
  for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(area))) {
    if (name in Store.prototype) throw new Error(`Store.${name} is defined twice: in src/db.ts and src/db/, or in two area files`);
    Object.defineProperty(Store.prototype, name, { ...d, enumerable: false });
  }
}
