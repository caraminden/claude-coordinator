// The API's shapes as the page receives them (#2021), for JSDoc in public/*.js: `/** @import { Ticket } from './types.js' */`.
// Each is copied from what the server sends, named beside it, not guessed. They can't be imported from src/: that pulls
// Node's types into the page check (tsconfig.public.json). When a server shape changes, change its copy here too.
// A field the page never reads may be left out; one it reads must be here, or its readers' checks go red.
// This file holds only the shared core (ticket, scheme, event, card, view). Each area's shapes are in types/<area>.d.ts:
// add a shape to its area's file, and import it from there.

import type { planTrack } from './progress.js';
import type { chatView } from './thread.js';
import type { Progress, ProgressTask, SessionState } from './types/chat.js';
import type { ArtifactFile, SharedFile } from './types/files.js';
import type { BuildHeader, CabalCard } from './types/list.js';
import type { RunsOnMark } from './machine-types.js';
export type * from './machine-types.js'; // the machines' shapes (Build 7)

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
  /** The one machine it may start on (src/runs-on.ts), and what it waits for there. */
  machine?: { name: string; why: string; never?: true };
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
  /** Its Runs on mark (Build 7 T4). */
  runs_on?: RunsOnMark | null;
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

/** A chat history page (GET api/tickets/:id/events): its events and the plan as of the page's start. */
export interface EventsPage {
  events: ChatEvent[];
  more: boolean;
  plan?: Partial<Progress>;
  tasks: ProgressTask[];
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
    /** Admins: "Everyone else's computers" left open. */
    machineOthersOpen?: boolean;
    machineSetupOs: 'posix' | 'windows';
    runnerSetupOs: 'posix' | 'windows';
  };
