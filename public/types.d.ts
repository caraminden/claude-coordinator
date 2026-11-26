// The API's shapes as the page receives them (#2021), for JSDoc in public/*.js: `/** @import { Ticket } from './types.js' */`.
// Each is copied from what the server sends, named beside it, not guessed. They can't be imported from src/: that pulls
// Node's types into the page check (tsconfig.public.json). When a server shape changes, change its copy here too.
// A field the page never reads may be left out; one it reads must be here, or its readers' checks go red.

import type { applyEvent, createProgress, planTrack } from './progress.js';
import type { chatView } from './thread.js';
import type { mergedView } from './mine.js';
import type { narrationSorter } from './narration.js';

export type TicketStatus = 'new' | 'running' | 'idle' | 'error' | 'closed';
/** src/db-rows.ts TICKET_STATES. */
export type TicketState = 'ready' | 'complete' | 'try' | 'parked' | 'blocked' | 'outside' | 'pending-deploy' | 'limited';

/** A wait for a worker (src/worker-wait.ts WorkerWait). */
export interface WorkerWait {
  since: number;
  place: number;
  of: number;
  paused: string | null;
  held?: string | null;
  quick?: true;
}

/** A ship on its way (src/branch.ts Ship). */
export interface Ship {
  stage: 'branch' | 'build' | 'main' | 'deploying' | 'live' | 'failed';
  text: string;
  commit: string;
  detail?: string;
}

/** A wait the server tracks for a minion (src/waits.ts Wait, with Frozen and EarlyTest). */
export interface Wait {
  kind: string;
  stage: string;
  label?: string;
  chip: string;
  text: string;
  brief?: string;
  since: number;
  usual: number | null;
  done?: number;
  total?: number;
  train?: { role: 'front' | 'rider' | 'waiting'; label: string; size?: number; front?: string; members?: string[] };
  failed?: string[];
  frozen?: { unit: string; since: number; thaw: string };
  ended?: number;
  early?: { state: 'running' | 'passed' | 'failed' | 'dropped'; brief: string; text: string; done?: number; total?: number; failed?: string[] };
}

/** A card waiting on people, with its link (src/card-links.ts CardLink). */
export interface CardLink {
  minion: number | null;
  kind: 'question' | 'plan' | 'approval';
  what?: 'question' | 'plan' | 'ship' | 'merge' | 'approval' | 'tripwire' | 'secret';
  label: string;
  href: string;
  below?: boolean;
  to?: string;
  doc?: string;
}

/** An account limited by its usage cap (src/resumes.ts LimitedAccount). */
export interface LimitedAccount {
  n: number;
  label: string;
  until: number;
  here?: boolean;
  kind?: string;
}

/** A message the loop guard or a wait holds (src/runner.ts heldMail). */
export interface HeldMailItem {
  id: number | null;
  author: string;
  from: number | null;
  need: string | null;
  note: boolean;
  parked: boolean;
  at: number;
  text: string;
}

/** A minion or a Taskmaster as the API sends it: the row plus its live state (src/runner.ts Runner.view, src/http.ts TicketView). */
export interface Ticket {
  id: number;
  project_id: number;
  /** Shown as #n; null for a Taskmaster. */
  number: number | null;
  state: TicketState | null;
  note: string | null;
  build: number | null;
  parent: number | null;
  kind: 'ticket' | 'coordinator';
  title: string;
  session_id: string | null;
  cwd: string;
  branch: string | null;
  permission_mode: string;
  model: string | null;
  effort: string | null;
  last_model: string | null;
  last_effort: string | null;
  picked_because: string | null;
  workflow: number;
  plugin_dirs: string;
  last_activity: string | null;
  closed_at: number | null;
  person_id: number | null;
  coordinator_of: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  // Runner.live()
  turn_live: boolean;
  worker_wait: WorkerWait | null;
  urgent: { kind: 'person' | 'taskmaster' | 'server'; by: string; reason?: string; at: number } | null;
  start_now: { by: string; user: number; since: number; until: number } | null;
  step_ratio: number;
  steps: { done: number; total: number; since?: number; usual?: number } | null;
  step_track: ReturnType<typeof planTrack> | null;
  closing: boolean;
  turnStartedAt: number | null;
  activity: { at: number; tool: { name: string; label: string; started: number; limit: number } | null; quiet_since: number | null } | null;
  spend_alert: { stage: number; usd: number; event: number; at: number; href: string } | null;
  approvals: number;
  parked_for: string | null;
  start_hold: { usd: number } | null;
  held_brief: { text: string; from: string; leader: number; when: 'live' | 'merged'; is: string } | null;
  wakes_on: string | null;
  outbox_waits: unknown[];
  ship: Ship | null;
  wait: Wait | null;
  server_work: { kind: string; text?: string; since?: number } | null;
  held_line: string | null;
  context_live: number | null;
  running_cost: number;
  compactions: { n: number; ms: number } | null;
  // Runner.view()
  replies: string[];
  queued: number;
  held_ids: number[];
  queued_ids: number[];
  status: TicketStatus;
  loop_hold: { n: number; at: number; text: string } | null;
  held_mail: { until: number | null; items: HeldMailItem[] } | null;
  limit_resume_at: number | null;
  limit_accounts: LimitedAccount[] | null;
  pending_card_at: number | null;
  open_cards: CardLink[];
  properties: Record<string, string | number | string[]>;
  touched: number[];
  assignee: string | null;
  preview: boolean;
  asleep: { at: number; by: string } | null;
  cost: number;
  budget: { usd: number; basis: string; n: number; ask: number; wake: number; card: number; estimate?: number } | null;
  host_cost: number;
  payer: { id: number | null; name: string } | null;
  context_tokens: number | null;
  context_window: number;
  last_turn_end: number | null;
  fresh_pending: boolean;
  default_effort: string | null;
  optional_plugin_dirs: string[];
}

/** A scheme's row (src/db-rows.ts Project). */
export interface Scheme {
  id: number;
  name: string;
  repo_url: string | null;
  repo_dir: string | null;
  instructions: string;
  instructions_updated_by: string | null;
  instructions_updated_at: number | null;
  approval_rules: string;
  plugin_dirs: string;
  optional_plugin_dirs: string;
  default_effort: string;
  /** JSON: a list of "key: value" (base.js listGroupsOf). */
  list_groups: string;
  ci_quiet: string;
  ci_watch: string;
  land_mode: string;
  fable_ok: string;
  builds: string;
  grill: string;
  gh_runners: string;
  shot_widths: string;
  shot_themes: string;
  shots_required: number;
  shot_note: string;
  ship_path: 'citadel' | 'pr-auto' | 'pr-minion' | 'pr-person';
  go_from: 'never' | 'high' | 'medium' | 'all';
  try_first: 'never' | 'ui' | 'features';
  msg_loop_limit: number;
  msg_loop_min: number;
  msg_cold_min: number;
  msg_hold_h: number;
  msg_never_hold: string;
  rules_review: number;
  skills_off: string;
  onboarding: string;
  onboarding_mode: string;
  github_error: string | null;
  owner_id: number | null;
  created_at: number;
}

/** A scheme in GET api/projects (src/routes/projects.ts): its row plus what the shelf and the switcher show. */
export interface SchemeListed extends Scheme {
  owner: string | null;
  /** How many minions it has. */
  tickets: number;
  hidden: boolean;
  member: boolean;
  inbox: number;
  fresh: boolean;
  running: boolean;
  working: number;
  shipping: number;
  /** Its icon's version, or null for none. */
  icon: string | number | null;
  coordinator_id: number | null;
}

/** One of a split scheme's Taskmaster sessions (GET api/projects/:id `taskmasters`, with src/routes/projects.ts queueMarks). */
export interface TaskmasterSession {
  id: number;
  person_id: number | null;
  person_name: string | null;
  updated_at: number;
  status: TicketStatus;
  queued_ids?: number[];
  held_ids?: number[];
  /** Its own view, once the page has fetched it. */
  ticket?: Ticket;
}

/** A build branch's header in the minions list (src/builds.ts). */
export interface BuildHeader {
  build: number;
  merged: number;
  open: number;
  behind: number;
}

/** An open cabal's card in the minions list (src/cabal-cards.ts). */
export interface CabalCard {
  lead: number;
  number: number | null;
  title: string;
  overseer: string;
  build: number | null;
  done: 'merged' | 'shipped';
  members: { id: number | null; number: number | null; label: string; title: string; state: string; word: string }[];
  finished: number;
  next: number;
  asks: number;
  spend: number;
}

/** A file a minion showed (src/routes/files.ts artifactView). */
export interface ArtifactFile {
  id: number;
  project_id: number;
  ticket_id: number;
  path: string;
  size: number;
  mtime: number;
  created_at: number;
  pinned_at: number | null;
  pinned_by: string | null;
  missing: number;
  name: string;
  display_path: string;
  abs: string;
  kind: 'markdown' | 'text' | 'canvas' | 'html' | 'pdf' | 'image' | 'video' | 'audio' | 'download';
  ticket_title: string;
  ticket_kind: string;
  ticket_number: number | null;
}

/** A file in the scheme's shared folder (src/http.ts SharedFile). */
export interface SharedFile {
  path: string;
  name: string;
  kind: string;
  display_path: string;
  size: number;
  mtime: number;
  pinned_at: number | null;
  pinned_by: string | null;
  missing: number;
}

/** One thing waiting on a person in a scheme's Needs-you list (src/inbox.ts InboxItem; its `card` is the stored card, read here for who and which). */
export interface InboxItem {
  kind: string;
  ticketId: number;
  at: number;
  card?: { id?: number | string; by?: string; to?: string; stage?: number; notice?: unknown; secret?: unknown; doc?: { path?: string } };
  key: string;
  eventId?: number;
  from?: { projectId: number; scheme: string; number: number | null; kind: string; title: string };
}

/** A chat event as stored and sent (src/db-rows.ts EventRow): `data` is JSON text. */
export interface ChatEvent {
  id: number;
  ticket_id: number;
  kind: string;
  data: string;
  created_at: number;
}

/** One question on a card, as ask_question takes it (src/ci-armed.ts CardQuestion). */
export interface CardQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string; recommended?: boolean; image?: unknown }[];
}

/** A question card: the parsed `data` of a `question` event (src/ci-armed.ts postCard). */
export interface QuestionCard {
  id: string;
  questions: CardQuestion[];
  kind?: 'merge';
  into?: number;
  job?: number;
  recipe?: object;
  kitSync?: string;
  budget?: true;
  startCost?: number;
  handoff?: object;
  to?: string;
  mergeable?: true;
  notice?: string;
  doc?: { path: string; title: string };
  secret?: { name: string; scope: string; why?: string };
  asker?: number;
}

/** A release target (src/releases.ts Target). */
export interface ReleaseTarget {
  id: string;
  projectId: number;
  name: string;
  kind: string;
  link: string | null;
  numbering?: { name?: string; number?: 'run' | 'count' };
}

/** One release of a target (src/releases.ts Release, with src/ship-failures.ts FailureDetail and FailureNext). */
export interface Release {
  version: string;
  number: number | null;
  link: string | null;
  name?: string;
  changes: { ticketId: number; number: number | null; title: string; fix?: string }[];
  started: number | null;
  live: number | null;
  outcome: string;
  stages: Record<string, number>;
  commit?: string;
  failure?: {
    kind: string;
    names: string[];
    more: number;
    ci: string | null;
    next: { kind: 'again'; at: number } | { kind: 'shipped'; release: string | null } | { kind: 'line'; place: string | null; holds: boolean } | { kind: 'closed' } | { kind: 'fixing' | 'idle'; note: string | null };
  };
}

/** The signed-in person (GET api/me, src/routes/app.ts meView). */
/** One chunk search by meaning found: GET api/projects/:id/memory's hits (src/memory.ts MemoryHit). */
export interface MemoryHit {
  ticket_id: number;
  /** null for the Taskmaster's chat (kind 'coordinator'). */
  number: number | null;
  title: string;
  kind: string;
  status: string;
  source_kind: 'turn' | 'ticket';
  source_id: number;
  ts: number;
  text: string;
  score: number;
}

export interface Account {
  id: number | null;
  name: string;
  login: string | null;
  admin: boolean;
  turns: boolean;
  payer: number | null;
  avatars: { on: boolean; pic: string | null; people: Record<string, string | null> } | null;
  keepChats: boolean;
  welcome: { steps: Record<string, boolean>; card: string | null; done: boolean } | null;
}

/** A step of a chat's plan (progress.js createProgress's `tasks`, built by applyEvent). */
export interface ProgressTask {
  id: string;
  /** The plan tool's step number. */
  n?: number;
  subject: string;
  activeForm?: string;
  description?: string;
  outcome?: string;
  note?: string;
  /** 'pending', 'in_progress' or 'completed'. */
  status: string;
  actions: number;
  estimate?: number | null;
  startedAt?: number | null;
  doneN?: number;
  work?: number;
  workFrom?: number | null;
  kind?: string;
  /** The status the minion set on this step itself (the plan tool's `status`), which wins over the server's guess. */
  own?: 'todo' | 'doing' | 'done' | 'dropped';
  seen?: boolean;
  stage?: string;
}

/** A chat's plan and turn state (progress.js createProgress), its steps typed. */
export type Progress = Omit<ReturnType<typeof createProgress>, 'tasks'> & { tasks: ProgressTask[] };

/** A chat history page (GET api/tickets/:id/events): its events and the plan as of the page's start. */
export interface EventsPage {
  events: ChatEvent[];
  more: boolean;
  plan?: Partial<Progress>;
  tasks: ProgressTask[];
}

/** A tool call in the open chat (thread.js drawEvent): the block, its plan step, and its result once it comes. */
export interface ChatAction {
  block: ReturnType<typeof applyEvent>[number]['block'];
  taskId: ReturnType<typeof applyEvent>[number]['taskId'];
  result: { content: unknown; is_error?: boolean; cut?: boolean; event: { id: number; ticket: number } } | null;
  startedAt: number;
  doneAt?: number;
  event: { id: number; ticket: number };
}

/** One of Claude's words in the open chat, as thread.js hands it to narration.js: its message and body. */
export interface NarrationText {
  el: HTMLElement;
  body?: Node;
  text: string;
}
/** The open chat's narration sorter (narration.js), carrying thread.js's lines. */
export type NarrationSorter = ReturnType<typeof narrationSorter<NarrationText>>;

/** A line of the running turn's words waiting to fold or stay (narration.js), or a break between stretches. */
export type Fold = ReturnType<NarrationSorter['text']>[number] | { fate: 'break'; text?: undefined };

/** A message you sent that the server's history doesn't have yet (composer.js send). */
export interface PendingMessage {
  el: HTMLElement;
  urls: string[];
  text: string;
  sendId: string;
  saved: unknown[];
  state: string;
  retry?: () => Promise<unknown>;
}

/** The chat's newest plan card (cards.js planCard): a later one is shown as a revision of it. */
export interface PlanMemo {
  plan: string;
  summary: string;
  /** Its card, once drawn: `status` is 'approved' once someone approved it. */
  handle: { status: string } | null;
}

/** A chat's drawing state that a merged Taskmaster view swaps per session (thread.js SESSION_STATE). */
interface SessionState {
  part?: NonNullable<ReturnType<typeof mergedView>>['parts'][number];
  progress: Progress;
  turnActions: ChatAction[];
  actions: Map<string, ChatAction>;
  folds: Fold[];
  heldCards: Node[];
  pendingMessages: PendingMessage[];
  lastPlan: PlanMemo | null;
  gruntStarts: Map<string, number>;
  sawInit: boolean;
  latestReply: number | null;
  turnNote: string | null;
  turnInitAt: number | undefined;
  narration: NarrationSorter;
  narrationEl: HTMLElement | null;
  pendingRequest: { id: number; author: string; text: string }[];
  turnRequest: { id: number; author: string; text: string }[] | undefined;
}

/**
 * What is on screen (base.js `view`): a scheme's page with its list, and the chat open in it (thread.js chatView). The
 * no-scheme page (sidebar.js openStartScheme) sets only `kind: 'projects'`; the code that reads the rest runs on a
 * scheme's page.
 */
export type View = Omit<ReturnType<typeof chatView>, keyof SessionState | 'sendingTo'> &
  SessionState & {
    kind: 'project' | 'projects';
    /** The ticket id while a message is on its way, before the server confirms the turn (thread.js chatView). */
    sendingTo: number | null;
    home: boolean;
    /** What the main panel shows: 'chat', 'releases', 'home', a settings page… */
    main: string;
    projectId: number;
    project: Scheme;
    coordinator: Ticket;
    tickets: Map<number, Ticket>;
    taskmasters: TaskmasterSession[];
    /** Ticket id -> when you last looked at it (server time). */
    seen: Record<number, number>;
    /** Ticket id -> people's note on it. */
    personNotes: Record<number, { text: string; by: string; at: number }>;
    pins: number[];
    builds: BuildHeader[];
    cabals: CabalCard[];
    buildPreviews: boolean;
    artifacts: ArtifactFile[] | null;
    shared: SharedFile[] | null;
    filesFailed: boolean;
    artifactId: number | null;
    machines: unknown[];
    projects: SchemeListed[];
    /** The shared-folder file open in the main panel. */
    file: SharedFile | null;
    showClosed: boolean;
    page: EventsPage;
    openedSeenAt: number;
    /** When the open chat was last seen, or unset (seen.js). */
    sawAt?: number;
    /** Settings > Machines (settings-machines.js): a token just made, shown until you leave the page. */
    machineToken: { id: number; name: string; token: string; url: string; runners: boolean } | null;
    machineOpen: Set<number>;
    machineSetupOs: 'posix' | 'windows';
    runnerSetupOs: 'posix' | 'windows';
  };

// Round 4: chains.js
/** How one minion waits on another (src/chains.ts EdgeKind). */
export type EdgeKind = 'start_after' | 'wait' | 'claim' | 'build';

/** One minion (or an unowned build) in a chain (src/chains.ts ChainNode, from GET api/projects/:id/chains). */
export interface ChainNode {
  /** The ticket's id, or `build:<n>` for a build with no build minion named. */
  key: string;
  id: number | null;
  project: number;
  number: number | null;
  title: string;
  status: string;
  state: string | null;
  /** The column it sits in, left to right: 0 waits on nobody in the chain. */
  col: number;
}

/** A wire between two nodes (src/chains.ts ChainEdge): `from` waits on `to`. */
export interface ChainEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  label: string;
}

/** A set of minions joined by waits (src/chains.ts Chain). */
export interface Chain {
  key: string;
  title: string;
  kinds: EdgeKind[];
  nodes: ChainNode[];
  edges: ChainEdge[];
}

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

// Round 4: releases.js (GET api/releases, src/releases.ts; ReleaseTarget and Release are above)
/** A ship try's early test (src/waits.ts EarlyTest). */
export interface EarlyTest {
  state: 'running' | 'passed' | 'failed' | 'dropped';
  brief: string;
  text: string;
}

/** A failed try seen again in line (src/ship-failures.ts LastTry). */
export interface LastTry {
  kind: string;
  names: string[];
  more: number;
  ci: string | null;
  at: number;
}

/** Where a change or release is (src/releases.ts Progress). */
export interface ReleaseProgress {
  stage: string;
  since: number;
  usual: number | null;
  waitingOn: string | null;
  text: string;
  brief?: string;
  label?: string;
  done?: number;
  total?: number;
  early?: EarlyTest;
  train?: { role: 'front' | 'rider' | 'waiting'; label: string; size?: number; front?: string; members?: string[] };
}

/** One minion's change in the release under way (src/releases.ts Change). */
export interface ReleaseChange extends ReleaseProgress {
  ticketId: number;
  number: number | null;
  title: string;
  canPreview?: boolean;
  later?: boolean;
  idle?: boolean;
  lastTry?: LastTry;
  fix?: string;
}

/** A line of the ship under way (src/land-news.ts NewsItem). */
export interface NewsItem {
  tone: 'bad' | 'warn' | 'info';
  text: string;
  refs?: Record<string, number>;
}

/** The release being made (src/releases.ts Next). */
export interface ReleaseNext extends ReleaseProgress {
  number: number | null;
  name?: string;
  link: string | null;
  stages: { name: string; usual: number | null }[];
  eta: number | null;
  news?: NewsItem[];
  changes: ReleaseChange[];
}

/** Who placed a waiter in the ship line (src/ship-line-state.ts Placed). */
export interface Placed {
  by: string;
  at: number;
  reason?: string;
  taskmaster: boolean;
}

/** One entry of the ship line (src/releases.ts LineEntry). */
export interface LineEntry {
  name: string;
  ticketId: number | null;
  holds: boolean;
  label?: string;
  place: string;
  seq: number;
  movable: boolean;
  why?: string;
  placed?: Placed;
  stage: string;
  since: number;
  lastTry?: LastTry;
  /** src/frozen-ships.ts Frozen. */
  frozen?: { unit: string; since: number; thaw: string };
}

/** A preview, download or site made to try a change (src/releases.ts TestCopy). */
export interface TestCopy {
  kind: 'preview' | 'build-preview' | 'download' | 'site' | 'debug-apk';
  target: string | null;
  name: string;
  path?: string;
  file?: string;
  port?: number;
  link?: string;
  at?: number;
  ticketId?: number;
  number?: number;
  build?: number;
  running: boolean;
  commit: string | null;
}

/** A target's Deploy button state (src/auto-deploy.ts DeployInfo). */
export interface DeployInfo {
  can: boolean;
  auto: boolean;
  due: number | null;
  more: boolean;
}

/** A roll back's pin (src/last-green.ts Pin). */
export interface Pin {
  sha: string;
  from: string;
  at: number;
  by: string;
  build?: { run: number; sha: string; workflow: string };
  code?: number;
}

/** A target's Roll back to last green state (src/rollback.ts RollbackInfo). */
export interface RollbackInfo {
  sha: string;
  can: boolean;
  pin: Pin | null;
  running: boolean;
  failed: { sha: string; at: number; why: string } | null;
}

/** One target's card (src/releases.ts TargetView). */
export interface TargetView {
  target: ReleaseTarget;
  current: Release | null;
  next: ReleaseNext | null;
  line: LineEntry[];
  testCopies: TestCopy[];
  recent: Release[];
  deploy?: DeployInfo;
  releaseKey?: string;
  rollback?: RollbackInfo;
}

/** One scheme's releases (src/releases.ts SchemeReleases). */
export interface SchemeReleases {
  projectId: number;
  targets: TargetView[];
  testCopies: TestCopy[];
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

// Round 4b: time-log.js (GET api/tickets/:id/time-log: src/time-log.ts TimeLog)
export type TimeKind = 'work' | 'wait' | 'lost' | 'gone';
export type TimeSub = 'person' | 'ship' | 'deploy' | 'hold' | 'sealed' | 'limit' | 'job' | 'wake' | 'start' | 'stopped' | 'outside' | 'unknown' | 'kill' | 'restart' | 'cut' | 'overload' | 'finished' | 'dismissed';
export interface TimeSeg {
  start: number;
  end: number;
  kind: TimeKind;
  sub?: TimeSub;
  title?: string;
  event?: number;
  guess?: true;
  row?: number;
}
export interface TimeRow {
  type: 'step' | 'line' | 'wait';
  title: string;
  kind: TimeKind;
  sub?: TimeSub;
  status?: string;
  outcome?: string;
  continued?: true;
  more?: true;
  start: number | null;
  end: number | null;
  work: number;
  wait: number;
  lost: number;
  guess?: true;
  event?: number;
}
export interface TimeLog {
  start: number;
  end: number;
  running: boolean;
  closed: boolean;
  segs: TimeSeg[];
  rows: TimeRow[];
  totals: { work: number; wait: number; lost: number; guess: number };
  /** Haiku's reading of it (src/time-log-explain.ts ExplainView). */
  explain?: TimeExplain;
}
export interface TimeExplainLine {
  kind: 'work' | 'wait' | 'lost';
  text: string;
  ev: number[];
}
export interface TimeExplain {
  parts: Record<string, TimeExplainLine[]>;
  presses: { by: string; at: number; cost: number | null; parts: number }[];
  fresh: string[];
  writing: { by: string; at: number } | null;
}

// Ultra review (public/ultrareview.js; src/ultrareview.ts, src/routes/tickets.ts).
export interface UltraSize {
  files: number;
  lines: number;
}
/** GET api/tickets/:id/ultrareview: how big a review would be, before it is confirmed. */
export interface UltraCheck {
  mode: 'branch' | 'area';
  base: string;
  branch?: string;
  paths?: string[];
  size: UltraSize;
  limits: UltraSize;
  linked: boolean;
  running: boolean;
}
/** A prepped review's row, without the repo and person the server keeps. */
export interface UltraBatchRow {
  id: string;
  ticketId: number;
  by: string;
  name: string;
  paths: string[];
  question?: string;
  base: string;
  size: UltraSize;
  state: 'prepping' | 'ready' | 'running' | 'failed';
  error?: string;
  pr?: { number?: number; url?: string };
  at: number;
}
/** An area the batch form refused, by its place in what was sent. */
export interface UltraRefused {
  index?: number;
  name: string;
  error: string;
}
/** A review's chat card (the `ultrareview` event). */
export interface UltraStarted {
  id: string;
  by: string;
  mode: 'branch' | 'area';
  base?: string;
  branch?: string;
  paths?: string[];
  size: UltraSize;
  pr?: { number: number; url: string };
  question?: string;
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
/** One step of a plan call's `steps` (src/mcp.ts PLAN; progress.js planError checks it). */
export interface PlanStep {
  n: number;
  step?: string;
  doing?: string;
  why?: string;
  outcome?: string;
  minutes?: number;
  status?: string;
  kind?: string;
}

/** What a tool call's input holds that progress.js and the readouts read (Claude's tool inputs; the plan tools' too). */
export interface ToolInput {
  command?: string;
  description?: string;
  file_path?: string;
  notebook_path?: string;
  pattern?: string;
  path?: string;
  url?: string;
  query?: string;
  prompt?: string;
  skill?: string;
  subagent_type?: string;
  ticket_id?: number | string;
  title?: string;
  text?: string;
  notice?: string;
  kind?: string;
  state?: string;
  taskId?: string | number;
  subject?: string;
  activeForm?: string;
  status?: string;
  metadata?: { estimate?: unknown; outcome?: unknown };
  todos?: { content: string; activeForm?: string; status: string }[];
  steps?: PlanStep[];
}

/** A tool call in a Claude message (stream-json `tool_use` block); `work` and `cut` come from eventcut.js's cut-down copy. */
export interface ToolBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input?: ToolInput;
  work?: string;
  /** Input field -> its whole length, for each field a page's copy cut short. */
  cut?: Record<string, number>;
}

/** A tool's result in a user message (stream-json `tool_result` block). */
export interface ResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
  /** The whole length, when a page's copy was cut short. */
  cut?: number;
}

/** A block of a Claude message's content as the server stores it (src/claude-events.ts ContentBlock): which fields it has depends on `type`; ToolBlock and ResultBlock are the two a page reads. */
export interface ChatBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: ToolInput;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  work?: string;
  cut?: unknown;
}

/** The `data` of a `claude` chat event, as progress.js reads it (stream-json). */
export interface ClaudeEvent {
  type?: string;
  subtype?: string;
  model?: unknown;
  is_error?: boolean;
  parent_tool_use_id?: string | null;
  turn_state?: string | null;
  message?: { content?: ChatBlock[] | string };
}

/** One window of a Claude account's plan usage (src/turn-messages.ts UsageWindow). */
export interface UsageWindow {
  utilization: number;
  resetsAt: number | null;
  status: string | null;
}
/** A Claude account's plan usage as a turn last reported it (src/turn-messages.ts Usage). */
export interface PlanUsage {
  weekly: UsageWindow | null;
  session: UsageWindow | null;
  updatedAt: number;
}
/** A person's Claude usage as the stream and api/me give it (src/runner.ts usageOf: Usage, which account new minions use and why, and each account). */
export interface ClaudeUsage extends PlanUsage {
  account?: number;
  why?: string;
  pinned?: number;
  accounts?: { n: number; label: string; same?: string; usage: PlanUsage | null }[];
}
/** One window of a person's Codex usage (src/codex.ts CodexUsage): resetsAt in seconds. */
export interface CodexWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}
export interface CodexUsage {
  primary: CodexWindow | null;
  secondary: CodexWindow | null;
  updatedAt: number;
}
/** A person's Codex override as the stream gives it (src/runner.ts codexView). */
export interface CodexState {
  ready: boolean;
  why: string | null;
  on: boolean;
  usage: CodexUsage | null;
}

/** The desktop app's bridge (desktop/preload.cjs), on `window` only in it. */
export interface CitadelDesktop {
  app: string;
  show(): void;
  /** A PNG of `rect` (desktop/main.cjs: capturePage().toPNG(), a Buffer over IPC). */
  capture(rect: object): Promise<Uint8Array<ArrayBuffer>>;
  inspect(x: number, y: number): void;
  /** The sign-in page's saved password (desktop/saved-login.cjs). */
  savedLogin(): Promise<{ canSave: boolean; login: { login: string; password: string } | null }>;
  saveLogin(login: string, password: string): Promise<boolean>;
  forgetLogin(): Promise<boolean>;
}
declare global {
  interface Window {
    citadelDesktop?: CitadelDesktop;
  }
  interface Navigator {
    /** Chromium's Network Information API. */
    connection?: { saveData?: boolean };
  }
  interface NotificationOptions {
    renotify?: boolean;
  }
}

/** A picture or file waiting on a message, as a draft saves it (composer.js createAttachments). */
export interface SavedItem {
  mediaType?: string;
  data?: string;
  upload?: { name: string; size: number; type: string; label?: string };
  note?: { text: string; label: string };
}

/** The chat's message box form with the hooks composer.js hangs on it for thread.js, replies and the paste listener. */
export type ComposerForm = HTMLFormElement & {
  pasteAnywhere: (e: ClipboardEvent) => void;
  sendAndUnpark: () => void;
  sendText: (text: string) => Promise<unknown>;
  editBack: (text: string, saved?: SavedItem[]) => () => void;
  attach: (saved: SavedItem[]) => unknown[];
};

/** A minion's change on its way in a release (releases.js pendingRelease), which the list adds to the row as `release`. */
export interface PendingRelease {
  target: string;
  targetId?: string;
  name: string;
  stage: string;
  text?: string;
  since?: number;
  stuck?: boolean;
}

/** A minion as a list row (sidebar.js, threadstate.js): the ticket plus its release on its way, once the list has set it. */
export type ListedTicket = Ticket & { release?: PendingRelease | null };

/** A row's state pill as data (threadstate.js rowState). */
export interface RowState {
  rank: number;
  fam: string;
  cell: string;
  label: string;
  pulse?: boolean;
  counted?: boolean;
  server?: boolean;
  quiet?: boolean;
  since?: number;
  mention?: { by: string; at: number };
}

/** A person's message drawn in the chat (bubbles.js userBubble), with what thread.js hangs on it for its ✎ (markQueued). */
export interface Bubble extends HTMLElement {
  /** What the ✎ puts back in the message box while it waits in the queue. */
  sent?: { text: string; images: string[]; files: NonNullable<SavedItem['upload']>[] };
}

/** One line of what a minion waits for, in its list row's popover (src/waits-readout.ts WaitRow). */
export interface WaitRow {
  /** The delivery's id, or null for a wait still in an old key (no Cancel here). */
  id: number | null;
  kind: string;
  chip: string;
  what: string;
  headline: string;
  line: string;
  text: string;
  facts: string[];
  link: { project: number; number: number } | null;
  set_by: string;
  since: number | null;
  due: number | null;
  state: 'waiting' | 'held' | 'sending' | 'dropped' | 'failed';
  reason: string | null;
  cancellable: boolean;
}
