import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NOT_PEOPLE } from './auth.ts';
import { Registry } from './properties.ts';
import { Schedules } from './schedules.ts';
import { Memory } from './memory.ts';

/** Settings key: who asked for a ticket's turns, when that isn't whom they run as (Store.turnAsker). */
export const askerKey = (ticketId: number) => `asker:${ticketId}`;

export type TicketStatus = 'new' | 'running' | 'idle' | 'error' | 'closed';
/** Each project has one long-lived coordinator ticket that manages the others. */
export type TicketKind = 'ticket' | 'coordinator';

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
  /** 1 when its minions get the connected machines' tools (#138): Godot's ~1.1k tokens of names on every call. */
  machine_tools: number;
  /** The minions list's promoted groups (#253): a JSON list of "key: value" of the scheme's own keys, shown above the types. */
  list_groups: string;
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

/** Whether a scheme is still being set up, which is what gives its Taskmaster the onboarding section. */
export const onboardingOpen = (p: Pick<Project, 'onboarding'>) => p.onboarding !== 'done' && p.onboarding !== 'skipped';

/** Longest project instructions the app accepts, the same cap as Claude Code's own projects. */
export const MAX_INSTRUCTIONS = 16_000;

const APP_INSTRUCTIONS = 'app_instructions';
export interface AppInstructions {
  text: string;
  by: string | null;
  at: number | null;
}

/** Models a thread can be set to (null = Claude Code's default), and effort levels for `claude --effort`. */
// Codex's (#337) run in the person's own container, signed in to Codex (src/codex.ts CODEX_MODELS).
export const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'] as const;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** ready: done, ready to merge or pick up · try: ready for people to try · parked: on hold on purpose ·
 * blocked: stuck on something outside the thread · outside: work still running elsewhere (CI, someone's machine) ·
 * pending-deploy: deployed, not live yet; outlasts a new turn, and a successful deploy dismisses the thread ·
 * limited: the last turn hit the account's usage limit (set by the server, not the thread). */
export const TICKET_STATES = ['ready', 'try', 'parked', 'blocked', 'outside', 'pending-deploy', 'limited'] as const;
export type TicketState = (typeof TICKET_STATES)[number];

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
  /** 1: its turns may call Claude Code's Workflow tool (#359), off by default as it costs ~2k tokens a call. */
  workflow: number;
  /** Its picks from the scheme's optional plugin folders (#361), one per line; '' for none. */
  plugin_dirs: string;
  last_activity: string | null;
  /** Whose turn it last ran (users.id; src/access.ts turnPerson): set when a minion is made, then at each turn's start. */
  person_id: number | null;
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

/** One of a person's linked accounts (src/credentials.ts); `secret` is still encrypted. */
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
  created_by: string;
  created_at: number;
  /** When its agent last connected or disconnected; null if it never has. */
  last_seen_at: number | null;
  /** What threads should know when using it ("never restart it", where the clone is); '' for none. */
  notes: string;
  /** 1 when minions get the workspace tools its agent offers (git sync, its owner's tasks); off until a person turns it on. */
  workspace_tools: number;
  /** 1 when it is lent only to the schemes in machine_projects (#303); 0 lends it as access.ts lendsMachines says. */
  scoped: number;
  /** The person who added it and manages it (#306); null for one from before, which admins manage. */
  owner_id: number | null;
  /** What its setup lines run (#308): 'claude' (a Claude Code MCP server named mcp_command), 'command' or 'none'; null for one added before. */
  mcp_kind: 'claude' | 'command' | 'none' | null;
  mcp_command: string;
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
}

/** What a turn's result event says, for Store.recordTurn. */
export interface TurnResult {
  event_id?: number | null;
  session_id?: string | null;
  ended_at: number;
  session_cost_usd: number;
  duration_ms?: number | null;
  usage?: any;
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
export interface ContraptionRow {
  id: number;
  name: string;
  title: string;
  icon: string | null;
  port: number;
  home_scheme: number | null;
  open_paths: string;
  /** Path prefixes other contraptions may call for a person through the relay (src/relay.ts). */
  relay_paths: string;
  /** Where Citadel deploys it from (#266): a GitHub owner/name, the branch (null: main) and its folder (null: ~/apps/<name>). */
  repo: string | null;
  branch: string | null;
  folder: string | null;
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
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  kind TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket_id, id);
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
  mcp_command TEXT NOT NULL DEFAULT ''
);
-- The schemes a scoped machine is lent to (#303). Read only where machines.scoped = 1: rows left from #62
-- (Oct 27, unused since #89) stay put, and choosing "only these" for a machine replaces its rows.
CREATE TABLE IF NOT EXISTS machine_projects (
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (machine_id, project_id)
);
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
  cache_write_tokens INTEGER
);
CREATE INDEX IF NOT EXISTS turns_ticket ON turns(ticket_id, id);
CREATE INDEX IF NOT EXISTS turns_ended ON turns(ended_at);
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
  only_pinned INTEGER NOT NULL DEFAULT 0
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

/** Columns added after the first release, for databases created before them. */
const MIGRATIONS: [table: string, column: string, ddl: string][] = [
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
  ['tickets', 'last_effort', 'ALTER TABLE tickets ADD COLUMN last_effort TEXT'],
  ['tickets', 'workflow', 'ALTER TABLE tickets ADD COLUMN workflow INTEGER NOT NULL DEFAULT 0'],
  ['tickets', 'plugin_dirs', "ALTER TABLE tickets ADD COLUMN plugin_dirs TEXT NOT NULL DEFAULT ''"],
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
  ['tickets', 'person_id', 'ALTER TABLE tickets ADD COLUMN person_id INTEGER REFERENCES users(id) ON DELETE SET NULL'],
  ['tickets', 'parent', 'ALTER TABLE tickets ADD COLUMN parent INTEGER'],
  ['machines', 'notes', "ALTER TABLE machines ADD COLUMN notes TEXT NOT NULL DEFAULT ''"],
  ['machines', 'workspace_tools', 'ALTER TABLE machines ADD COLUMN workspace_tools INTEGER NOT NULL DEFAULT 0'],
  ['machines', 'scoped', 'ALTER TABLE machines ADD COLUMN scoped INTEGER NOT NULL DEFAULT 0'],
  ['machines', 'owner_id', 'ALTER TABLE machines ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL'],
  ['machines', 'mcp_kind', 'ALTER TABLE machines ADD COLUMN mcp_kind TEXT'],
  ['machines', 'mcp_command', "ALTER TABLE machines ADD COLUMN mcp_command TEXT NOT NULL DEFAULT ''"],
  ['contraptions', 'relay_paths', "ALTER TABLE contraptions ADD COLUMN relay_paths TEXT NOT NULL DEFAULT '[]'"],
  ['contraptions', 'repo', 'ALTER TABLE contraptions ADD COLUMN repo TEXT'],
  ['contraptions', 'branch', 'ALTER TABLE contraptions ADD COLUMN branch TEXT'],
  ['contraptions', 'folder', 'ALTER TABLE contraptions ADD COLUMN folder TEXT'],
  ['push_subscriptions', 'only_pinned', 'ALTER TABLE push_subscriptions ADD COLUMN only_pinned INTEGER NOT NULL DEFAULT 0'],
];

/**
 * The database's shape, kept in the `schema_version` setting. Bump it with any change to SCHEMA or
 * MIGRATIONS, or a one-off rewrite of data, so an older release that opens the database (a rollback)
 * knows a newer one has been at it. test/schema-compat.test.ts checks the last release still opens it.
 */
export const SCHEMA_VERSION = 32; // 2: claude_state moved to state.db; 3: brief_starts; 4: saved_views; 5: person_notes; 6: projects.machine_tools; 7: app_instruction_history; 8: shared_pins; 9: artifact_data; 10: projects.onboarding; 11: projects.github_error; 12: ticket_pins; 13: users, project_members, projects.owner_id; 14: credentials, tickets.person_id; 15: person_views replaces saved_views; 16: push_subscriptions.only_pinned; 17: server_login only for its owner (#213); 18: project_hides; 19: contraptions, contraption_users; 20: contraption_sessions, contraption_turns; 21: projects.list_groups, type: other backfill; 22: contraptions.relay_paths; 23: contraptions.repo, branch, folder; 24: tickets.parent; 25: machines.scoped (#303); 26: machines.owner_id (#306); 27: machines.mcp_kind, mcp_command (#308); 28: repo_collaborators (#310); 29: memory_chunks (#331); 30: tickets.workflow (#359); 31: projects.optional_plugin_dirs, tickets.plugin_dirs (#361); 32: schedules.model, effort (#387)

/**
 * A title without a trailing build that matches its build field: "Lairs · Build #8" → "Lairs".
 * The build needs a separator or brackets, so a title that names the build ("Major Build #7") stays.
 */
export function titleWithoutBuild(title: string, build: number): string {
  const m = title.match(/^(.*\S)\s*(?:[·|:–—-]\s*build\s*#?(\d+)|\(\s*build\s*#?(\d+)\s*\))\s*$/i);
  return m && Number(m[2] ?? m[3]) === build ? m[1] : title;
}

export class Store {
  db: DatabaseSync;
  /** The property registry and the properties minions and artifacts carry. */
  props: Registry;
  /** Scheduled minions (src/schedules.ts). */
  schedules: Schedules;
  /** Semantic memory: chunks of the chats and their embeddings (src/memory.ts, #331). */
  memory: Memory;
  /** The database file; the runner keeps its turn folders beside it. */
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    // Wait out another connection's write (a test's second Store, a backup) instead of failing at once with SQLITE_BUSY.
    this.db = new DatabaseSync(path, { timeout: 5000 });
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.attachState();
    this.moveSharedViews();
    for (const [table, column, ddl] of MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      if (!cols.some((c) => c.name === column)) this.db.exec(ddl);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_coordinator ON tickets(project_id) WHERE kind = 'coordinator'");
    this.numberTickets();
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ticket_number ON tickets(project_id, number)');
    this.props = new Registry(this.db);
    this.props.seed();
    this.settleBuilds();
    this.schedules = new Schedules(this.db);
    this.memory = new Memory(this);
    this.serverLoginOwnerOnly();
    this.groupByType();
    this.noteSchemaVersion();
  }

  /**
   * Attach state.db (claude_state's home), and move claude_state there from the main file if it is
   * still in it: from before state.db, created by an older release after a rollback, or in a restored
   * backup. Copy, then drop, as two commits: SQLite doesn't commit two WAL
   * files as one, so a crash in between leaves the rows in both and the next start repeats it.
   */
  private attachState() {
    this.db.prepare('ATTACH DATABASE ? AS state').run(this.path === ':memory:' ? ':memory:' : join(dirname(this.path), 'state.db'));
    // auto_vacuum only takes before the file's first table, so a new state.db gets it; the prune frees space with incremental_vacuum.
    this.db.exec('PRAGMA state.auto_vacuum = INCREMENTAL; PRAGMA state.journal_mode = WAL;');
    // A WAL file keeps its biggest size unless capped: the move alone grew state.db's to its whole size.
    this.db.exec('PRAGMA main.journal_size_limit = 16777216; PRAGMA state.journal_size_limit = 16777216;');
    this.db.exec(STATE_SCHEMA);
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

  /** Whose subscription the server's own Claude login is: the first admin, the one Citadel made at its first start. */
  serverLoginOwner(): number | null {
    return (this.db.prepare('SELECT min(id) AS id FROM users WHERE admin = 1').get() as { id: number | null }).id;
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

  private nextNumber(projectId: number): number {
    const row = this.db.prepare('SELECT MAX(number) AS n FROM tickets WHERE project_id = ?').get(projectId) as { n: number | null };
    return (row.n ?? 0) + 1;
  }

  getTicketByNumber(projectId: number, number: number): Ticket | undefined {
    return this.db.prepare('SELECT * FROM tickets WHERE project_id = ? AND number = ?').get(projectId, number) as unknown as Ticket | undefined;
  }

  listProjects(): Project[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY name').all() as unknown as Project[];
  }

  getProject(id: number): Project | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as Project | undefined;
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

  /** The latest Citadel-wide instruction saves, newest first. */
  appInstructionHistory(limit: number): { by: string; at: number; old_text: string; new_text: string }[] {
    return this.db.prepare('SELECT by, at, old_text, new_text FROM app_instruction_history ORDER BY id DESC LIMIT ?').all(limit) as any[];
  }

  setProjectSettings(id: number, fields: Partial<Pick<Project, 'approval_rules' | 'plugin_dirs' | 'optional_plugin_dirs' | 'default_effort' | 'machine_tools' | 'onboarding' | 'onboarding_mode' | 'list_groups'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    // A setup round starts at interview, or when a closed one opens again: only plans approved after it count (#180).
    const was = this.getProject(id);
    if (fields.onboarding && onboardingOpen(fields as Pick<Project, 'onboarding'>) && (fields.onboarding === 'interview' || (was && !onboardingOpen(was)))) {
      this.setSetting(`onboarding_opened:${id}`, Date.now());
    }
    this.db.prepare(`UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? ''), id);
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
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as User | undefined;
  }

  /** By login, name or open invite, either case: cookies from the shared-password days carry only the name. */
  findUser(field: 'login' | 'name' | 'invite_hash', value: string): User | undefined {
    return this.db.prepare(`SELECT * FROM users WHERE ${field} = ?`).get(value) as unknown as User | undefined;
  }

  createUser(u: Pick<User, 'name' | 'login'> & { admin?: boolean; server_login?: boolean }): User {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO users (name, login, admin, server_login, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(u.name, u.login, u.admin ? 1 : 0, u.server_login ? 1 : 0, Date.now());
    return this.getUser(Number(lastInsertRowid))!;
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
      // Ownerless but still scoped to no scheme, so a gone person's computer reaches no one's turns; an admin removes it.
      this.db.prepare('UPDATE machines SET owner_id = NULL, scoped = 1 WHERE owner_id = ?').run(id);
      this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
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

  /** The account refused it (revoked, or it can't be decrypted): kept, so Settings can say "link again". */
  failCredential(userId: number, kind: string) {
    this.db.prepare('UPDATE credentials SET failed_at = ? WHERE user_id = ? AND kind = ? AND failed_at IS NULL').run(Date.now(), userId, kind);
  }

  deleteCredential(userId: number, kind: string) {
    this.db.prepare('DELETE FROM credentials WHERE user_id = ? AND kind = ?').run(userId, kind);
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

  /** The schemes a person is in, as owner or member; null for an admin, who is in all of them. */
  visibleProjects(who: { uid?: number; admin?: boolean }): Set<number> | null {
    if (who.admin) return null;
    const rows = this.db.prepare(`SELECT id FROM projects WHERE owner_id = ?1
      UNION SELECT project_id FROM project_members WHERE user_id = ?1`).all(who.uid ?? -1) as { id: number }[];
    return new Set(rows.map((r) => r.id));
  }

  /** Whether a person may see a scheme: an admin, its owner, or a member. */
  canSee(who: { uid?: number; admin?: boolean }, projectId: number): boolean {
    return !!who.admin || !!this.db.prepare(`SELECT 1 FROM projects WHERE id = ?1 AND owner_id = ?2
      UNION SELECT 1 FROM project_members WHERE project_id = ?1 AND user_id = ?2`).get(projectId, who.uid ?? -1);
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
  contraptionsFor(userId: number): Pick<ContraptionRow, 'name' | 'title' | 'icon' | 'port' | 'identity_private'>[] {
    return this.db.prepare(`SELECT c.name, c.title, c.icon, c.port, c.identity_private FROM contraptions c JOIN contraption_users cu ON cu.contraption_id = c.id
      JOIN users u ON u.id = cu.user_id WHERE cu.user_id = ? AND u.disabled_at IS NULL ORDER BY c.title COLLATE NOCASE`).all(userId) as unknown as Pick<ContraptionRow, 'name' | 'title' | 'icon' | 'port' | 'identity_private'>[];
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

  deleteProject(id: number) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /** All tickets in a project, including the coordinator. */
  listTickets(projectId: number): Ticket[] {
    return this.db
      .prepare('SELECT * FROM tickets WHERE project_id = ? ORDER BY updated_at DESC')
      .all(projectId) as unknown as Ticket[];
  }

  getCoordinator(projectId: number): Ticket | undefined {
    return this.db
      .prepare("SELECT * FROM tickets WHERE project_id = ? AND kind = 'coordinator'")
      .get(projectId) as unknown as Ticket | undefined;
  }

  getTicket(id: number): Ticket | undefined {
    return this.db.prepare('SELECT * FROM tickets WHERE id = ?').get(id) as unknown as Ticket | undefined;
  }

  /** Insert a ticket with no working directory yet; call setTicketDir once it exists. */
  createTicket(t: Pick<Ticket, 'project_id' | 'title' | 'permission_mode' | 'created_by'> & { kind?: TicketKind }): Ticket {
    const now = Date.now();
    const kind = t.kind ?? 'ticket';
    const r = this.db
      .prepare(
        `INSERT INTO tickets (project_id, kind, number, title, status, cwd, permission_mode, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'new', '', ?, ?, ?, ?)`,
      )
      .run(t.project_id, kind, kind === 'coordinator' ? null : this.nextNumber(t.project_id), t.title, t.permission_mode, t.created_by, now, now);
    return this.getTicket(Number(r.lastInsertRowid))!;
  }

  setTicketDir(id: number, cwd: string, branch: string | null) {
    this.db.prepare('UPDATE tickets SET cwd = ?, branch = ? WHERE id = ?').run(cwd, branch, id);
  }

  /**
   * Who asked for a ticket's current (or last) turn (#255): the person whose ask it carries on, set at
   * each turn's start (src/runner.ts startTurn). Usually whom it runs as; not for a non-member's relay,
   * which runs as the scheme's owner (#211) but is still the non-member's ask.
   */
  turnAsker(ticketId: number): number | null {
    return this.getSetting<number>(askerKey(ticketId)) ?? this.getTicket(ticketId)?.person_id ?? null;
  }

  deleteTicket(id: number) {
    this.deleteSetting(askerKey(id));
    this.db.prepare('DELETE FROM events WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM artifacts WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM claude_state WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM ticket_seen WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM github_seen WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM turns WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM brief_starts WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM person_notes WHERE ticket_id = ?').run(id);
    this.db.prepare('DELETE FROM ticket_pins WHERE ticket_id = ?').run(id);
    this.memory.deleteTicket(id);
    this.db.prepare('DELETE FROM tickets WHERE id = ?').run(id);
  }

  /** Record what a ticket last ran with, without counting as activity (updated_at stays). */
  updateTicketQuietly(id: number, fields: Partial<Pick<Ticket, 'last_model' | 'last_effort'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE tickets SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  }

  updateTicket(id: number, fields: Partial<Pick<Ticket, 'status' | 'session_id' | 'last_activity' | 'title' | 'state' | 'note' | 'replies' | 'build' | 'parent' | 'model' | 'effort' | 'workflow' | 'plugin_dirs' | 'last_model' | 'last_effort' | 'person_id'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const values = keys.map((k) => fields[k] ?? null);
    const before = fields.status ? this.getTicket(id)?.status : undefined;
    this.db.prepare(`UPDATE tickets SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, Date.now(), id);
    // Dismissing moves the stage to done, reopening back to in-progress.
    if (before && fields.status) this.props.statusChanged(id, before, fields.status);
  }

  /** Change a ticket's activity line without counting it as new activity. */
  setLastActivity(id: number, text: string) {
    this.db.prepare('UPDATE tickets SET last_activity = ? WHERE id = ?').run(text, id);
  }

  addEvent(ticketId: number, kind: string, data: unknown): EventRow {
    const now = Date.now();
    const json = JSON.stringify(data);
    const r = this.db
      .prepare('INSERT INTO events (ticket_id, kind, data, created_at) VALUES (?, ?, ?, ?)')
      .run(ticketId, kind, json, now);
    return { id: Number(r.lastInsertRowid), ticket_id: ticketId, kind, data: json, created_at: now };
  }

  /** Replace an event's data, for cards whose status lives in the card (plans). */
  setEventData(id: number, data: unknown) {
    this.db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify(data), id);
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
    this.db
      .prepare(
        `INSERT INTO claude_state (path, project_id, ticket_id, size, mtime, data) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET project_id = excluded.project_id, ticket_id = excluded.ticket_id,
           size = excluded.size, mtime = excluded.mtime, data = excluded.data`,
      )
      .run(row.path, row.project_id, row.ticket_id, row.size, row.mtime, row.data);
  }

  deleteClaudeState(path: string) {
    this.db.prepare('DELETE FROM claude_state WHERE path = ?').run(path);
  }

  /** When `name` last looked at each of a project's threads: ticket id -> time. */
  seenTimes(name: string, projectId: number): Record<number, number> {
    const rows = this.db
      .prepare('SELECT s.ticket_id, s.seen_at FROM ticket_seen s JOIN tickets t ON t.id = s.ticket_id WHERE s.name = ? AND t.project_id = ?')
      .all(name, projectId) as { ticket_id: number; seen_at: number }[];
    return Object.fromEntries(rows.map((r) => [r.ticket_id, r.seen_at]));
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

  /** The briefs in one file that have been started as minions, with the number of each one's minion. */
  briefStarts(projectId: number, path: string): { heading: string; number: number }[] {
    return this.db
      .prepare('SELECT b.heading, t.number FROM brief_starts b JOIN tickets t ON t.id = b.ticket_id WHERE b.project_id = ? AND b.path = ?')
      .all(projectId, path) as { heading: string; number: number }[];
  }

  /**
   * Claim a brief before its minion is made, so two taps can't start it twice: false if it was started
   * already or is being started. A claim left by a start that never finished (a restart mid-way) lapses.
   */
  claimBrief(projectId: number, path: string, heading: string, by: string): boolean {
    const now = Date.now();
    this.db.prepare('DELETE FROM brief_starts WHERE ticket_id IS NULL AND started_at < ?').run(now - 5 * 60_000);
    this.db.prepare('DELETE FROM brief_starts WHERE ticket_id IS NOT NULL AND ticket_id NOT IN (SELECT id FROM tickets)').run();
    const r = this.db
      .prepare('INSERT OR IGNORE INTO brief_starts (project_id, path, heading, ticket_id, started_by, started_at) VALUES (?, ?, ?, NULL, ?, ?)')
      .run(projectId, path, heading, by, now);
    return r.changes > 0;
  }

  /** Settle a claim: the minion it made (a ticket id), or null to drop it because the start failed. */
  settleBrief(projectId: number, path: string, heading: string, ticketId: number | null) {
    if (ticketId === null) this.db.prepare('DELETE FROM brief_starts WHERE project_id = ? AND path = ? AND heading = ? AND ticket_id IS NULL').run(projectId, path, heading);
    else this.db.prepare('UPDATE brief_starts SET ticket_id = ? WHERE project_id = ? AND path = ? AND heading = ?').run(ticketId, projectId, path, heading);
  }

  /**
   * For the scheme recap: when `name` last acted anywhere in the scheme (a message, a card answer or
   * plan verdict, which are messages too, or an approval click), and how many turns each thread
   * has finished since. `since` is null if they never have.
   */
  recap(name: string, projectId: number): { since: number | null; turns: Record<number, number> } {
    const { since } = this.db.prepare(`
      SELECT MAX(e.created_at) AS since FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE t.project_id = ? AND (
        (e.kind = 'user_message' AND json_extract(e.data, '$.author') = ?)
        OR (e.kind = 'approval_result' AND json_extract(e.data, '$.by') = ?))`).get(projectId, name, name) as { since: number | null };
    if (since == null) return { since: null, turns: {} };
    const rows = this.db.prepare(`
      SELECT e.ticket_id, COUNT(*) AS n FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE t.project_id = ? AND e.created_at > ? AND e.kind = 'claude' AND json_extract(e.data, '$.type') = 'result'
      GROUP BY e.ticket_id`).all(projectId, since) as { ticket_id: number; n: number }[];
    return { since, turns: Object.fromEntries(rows.map((r) => [r.ticket_id, r.n])) };
  }

  /** Words a thread wrote that show in a chat, newest first: its own replies, and its messages relayed into other threads (strike_text). */
  wordsBy(ticketId: number): EventRow[] {
    return this.db
      .prepare(`SELECT * FROM events WHERE (ticket_id = ? AND kind = 'claude') OR (kind = 'user_message' AND json_extract(data, '$.from') = ?) ORDER BY id DESC`)
      .all(ticketId, ticketId) as unknown as EventRow[];
  }

  /** A chat's newest plan card, or undefined. */
  latestPlan(ticketId: number): EventRow | undefined {
    return this.db.prepare("SELECT * FROM events WHERE ticket_id = ? AND kind = 'plan' ORDER BY id DESC LIMIT 1").get(ticketId) as unknown as EventRow | undefined;
  }

  /** The backup chat's lines (src/backup.ts): the newest `limit` messages, notes, errors and replies with text after `afterId`, oldest first. */
  chatTextEvents(ticketId: number, afterId: number, limit: number): EventRow[] {
    return (this.db.prepare(`SELECT * FROM events WHERE ticket_id = ? AND id > ? AND (kind IN ('user_message', 'note', 'error')
      OR (kind = 'claude' AND json_extract(data, '$.type') = 'assistant' AND instr(data, '"type":"text"') > 0))
      ORDER BY id DESC LIMIT ?`).all(ticketId, afterId, limit) as unknown as EventRow[]).reverse();
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
   * starts, Claude's messages and tool calls, and the results that give a TaskCreate its id.
   */
  planEvents(ticketId: number, before: number): EventRow[] {
    return this.db.prepare(`
      SELECT * FROM events WHERE ticket_id = ? AND id < ? AND kind = 'claude' AND (
        json_extract(data, '$.type') IN ('system', 'assistant') OR (json_extract(data, '$.type') = 'user' AND data LIKE '%Task #%'))
      ORDER BY id`).all(ticketId, before) as unknown as EventRow[];
  }

  /**
   * A project's stored cards still waiting on a person, in threads that aren't dismissed: questions
   * nobody has answered (nor the minion settled), and plans still pending. Approval cards live in memory (Approvals.pending).
   * A person writing in the minion after a card counts as handling it there: typed replies clear it, not just clicks.
   */
  openCards(projectId: number): EventRow[] {
    return this.openCardsWhere('t.project_id = ?', projectId);
  }

  /** One minion's open cards (openCards), oldest first. */
  openCardsOf(ticketId: number): EventRow[] {
    return this.openCardsWhere('e.ticket_id = ?', ticketId);
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

  private openCardsWhere(scope: string, id: number): EventRow[] {
    const bots = NOT_PEOPLE.map((n) => n.toLowerCase());
    return this.db.prepare(`
      SELECT e.* FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE ${scope} AND t.status != 'closed' AND (
        (e.kind = 'plan' AND json_extract(e.data, '$.status') = 'pending')
        OR (e.kind = 'question' AND json_extract(e.data, '$.settled') IS NULL))
      AND NOT EXISTS (
        SELECT 1 FROM events a WHERE a.ticket_id = e.ticket_id AND a.kind = 'user_message' AND a.id > e.id
          AND lower(coalesce(json_extract(a.data, '$.author'), '')) NOT IN (${bots.map(() => '?').join(', ')})
          AND coalesce(json_extract(a.data, '$.author'), '') NOT LIKE '#%'
          -- a click on another card answers that card, not this one
          AND coalesce(json_extract(a.data, '$.answer.questionId'), json_extract(a.data, '$.plan.planId'), json_extract(e.data, '$.id')) = json_extract(e.data, '$.id'))
      ORDER BY e.id`).all(id, ...bots) as unknown as EventRow[];
  }

  /** The text of a ticket's replies that may link files (subagents' included). */
  replyTexts(ticketId: number): string[] {
    const rows = this.db
      .prepare("SELECT data FROM events WHERE ticket_id = ? AND kind = 'claude' AND data LIKE '%\"type\":\"assistant\"%' AND data LIKE '%](%'")
      .all(ticketId) as { data: string }[];
    const texts: string[] = [];
    for (const { data } of rows) {
      const content = JSON.parse(data).message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text);
    }
    return texts;
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
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const deleted = changes.filter((c) => c.data == null).length;
    return { changed: changes.length - deleted, deleted };
  }

  /** Newest-first messages and Claude output in a project whose raw JSON contains the text (case-insensitive for ASCII). */
  findEvents(projectId: number, text: string, limit = 3000, ticketId?: number): EventRow[] {
    const like = `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
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
    const prev = this.db
      .prepare('SELECT session_id, session_cost_usd FROM turns WHERE ticket_id = ? ORDER BY id DESC LIMIT 1')
      .get(ticketId) as { session_id: string | null; session_cost_usd: number } | undefined;
    const sameSession = prev && (prev.session_id ?? null) === (r.session_id ?? null);
    const base = sameSession && prev.session_cost_usd <= r.session_cost_usd ? prev.session_cost_usd : 0;
    const u = r.usage ?? null;
    const n = (v: unknown) => (typeof v === 'number' ? v : null);
    const row = this.db
      .prepare(`INSERT INTO turns (ticket_id, event_id, session_id, ended_at, cost_usd, session_cost_usd, duration_ms,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
      .get(ticketId, r.event_id ?? null, r.session_id ?? null, r.ended_at, r.session_cost_usd - base, r.session_cost_usd,
        n(r.duration_ms), n(u?.input_tokens), n(u?.output_tokens), n(u?.cache_read_input_tokens), n(u?.cache_creation_input_tokens));
    return row as unknown as Turn;
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

  /** When a ticket's last finished turn ended (ms), or null before its first. */
  lastTurnEnd(ticketId: number): number | null {
    const r = this.db.prepare('SELECT ended_at FROM turns WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(ticketId) as { ended_at: number } | undefined;
    return r?.ended_at ?? null;
  }

  /** What a ticket's turns have cost so far. */
  ticketCost(ticketId: number): number {
    return (this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS c FROM turns WHERE ticket_id = ?').get(ticketId) as { c: number }).c;
  }

  /** Cost per local day ('2026-10-28') and project, for turns ended at or after `since`. */
  dailyCosts(since: number): { day: string; project_id: number; cost: number; turns: number }[] {
    return this.db
      .prepare(`SELECT date(u.ended_at / 1000, 'unixepoch', 'localtime') AS day, t.project_id, SUM(u.cost_usd) AS cost, COUNT(*) AS turns
          FROM turns u JOIN tickets t ON t.id = u.ticket_id WHERE u.ended_at >= ? GROUP BY day, t.project_id ORDER BY day`)
      .all(since) as unknown as { day: string; project_id: number; cost: number; turns: number }[];
  }

  getSetting<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : null;
  }

  setSetting(key: string, value: unknown) {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  deleteSetting(key: string) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  }

  listMachines(): Machine[] {
    return this.db.prepare('SELECT * FROM machines ORDER BY name').all() as unknown as Machine[];
  }

  getMachine(id: number): Machine | undefined {
    return this.db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as unknown as Machine | undefined;
  }

  /** A machine `ownerId` manages (#306), or a shared one with none; `scoped` lends it to no scheme until some are ticked. */
  createMachine(name: string, tokenHash: string, by: string, ownerId: number | null = null, scoped = false): Machine {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO machines (name, token_hash, created_by, created_at, owner_id, scoped) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, tokenHash, by, Date.now(), ownerId, scoped ? 1 : 0);
    return this.getMachine(Number(lastInsertRowid))!;
  }

  updateMachine(id: number, fields: Partial<Pick<Machine, 'name' | 'token_hash' | 'last_seen_at' | 'notes' | 'workspace_tools' | 'mcp_kind' | 'mcp_command'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE machines SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
  }

  /** The schemes a scoped machine is lent to. */
  machineProjects(machineId: number): number[] {
    return (this.db.prepare('SELECT project_id FROM machine_projects WHERE machine_id = ? ORDER BY project_id').all(machineId) as { project_id: number }[]).map((r) => r.project_id);
  }

  machineGranted(machineId: number, projectId: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM machine_projects WHERE machine_id = ? AND project_id = ?').get(machineId, projectId);
  }

  /** Lend a machine to these schemes only, or (null) as before: its old grant rows stay, unread, until it is scoped again. */
  setMachineProjects(machineId: number, projectIds: number[] | null) {
    this.db.exec('BEGIN');
    try {
      if (projectIds) {
        this.db.prepare('DELETE FROM machine_projects WHERE machine_id = ?').run(machineId);
        const add = this.db.prepare('INSERT OR IGNORE INTO machine_projects (machine_id, project_id) VALUES (?, ?)');
        for (const id of projectIds) add.run(machineId, id);
      }
      this.db.prepare('UPDATE machines SET scoped = ? WHERE id = ?').run(projectIds ? 1 : 0, machineId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  deleteMachine(id: number) {
    this.db.prepare('DELETE FROM machines WHERE id = ?').run(id);
  }

  listViews(projectId: number, owner: string): SavedView[] {
    const rows = this.db.prepare('SELECT * FROM person_views WHERE project_id = ? AND owner = ? ORDER BY name COLLATE NOCASE').all(projectId, owner) as any[];
    return rows.map((r) => ({ ...r, picks: JSON.parse(r.picks) }));
  }

  /** Save the picks under a name; saving under a name this person already has replaces that view. */
  saveView(projectId: number, owner: string, name: string, picks: SavedView['picks']) {
    this.db
      .prepare('INSERT INTO person_views (project_id, owner, name, picks, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project_id, owner, name) DO UPDATE SET picks = excluded.picks, created_at = excluded.created_at')
      .run(projectId, owner, name, JSON.stringify(picks), Date.now());
  }

  deleteView(projectId: number, owner: string, id: number): boolean {
    return this.db.prepare('DELETE FROM person_views WHERE project_id = ? AND owner = ? AND id = ?').run(projectId, owner, id).changes > 0;
  }

  listPushSubscriptions(): PushSubscriptionRow[] {
    return this.db.prepare('SELECT * FROM push_subscriptions ORDER BY id').all() as unknown as PushSubscriptionRow[];
  }

  getPushSubscription(endpoint: string): PushSubscriptionRow | undefined {
    return this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as unknown as PushSubscriptionRow | undefined;
  }

  /** Save a browser's subscription for `name`; a browser someone else signed in on before becomes theirs. */
  savePushSubscription(name: string, endpoint: string, p256dh: string, auth: string): PushSubscriptionRow {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (name, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
           muted = CASE WHEN name = excluded.name THEN muted ELSE '[]' END,
           only_pinned = CASE WHEN name = excluded.name THEN only_pinned ELSE 0 END, name = excluded.name`,
      )
      .run(name, endpoint, p256dh, auth, Date.now());
    return this.getPushSubscription(endpoint)!;
  }

  setPushMuted(endpoint: string, muted: number[]) {
    this.db.prepare('UPDATE push_subscriptions SET muted = ? WHERE endpoint = ?').run(JSON.stringify(muted), endpoint);
  }

  setPushOnlyPinned(endpoint: string, onlyPinned: boolean) {
    this.db.prepare('UPDATE push_subscriptions SET only_pinned = ? WHERE endpoint = ?').run(onlyPinned ? 1 : 0, endpoint);
  }

  deletePushSubscription(endpoint: string) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }
}
