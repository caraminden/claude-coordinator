import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
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
import { thrown } from './thrown.ts';
import { ciNumberQueries } from './db/ci-numbers.ts';
import { contraptionRunQueries } from './db/contraption-runs.ts';
import { deliveryQueries } from './db/deliveries.ts';
import { flakeQueries } from './db/flakes.ts';
import { machineQueries } from './db/machines.ts';
import { minionQueries } from './db/minions.ts';
import { pushQueries } from './db/push.ts';
import { readWarmQueries } from './db/read-warm.ts';
import { settingQueries } from './db/settings.ts';
import { eventQueries } from './db/events.ts';
import { cardQueries } from './db/cards.ts';
import { seenQueries } from './db/seen.ts';
import { contraptionQueries } from './db/contraptions.ts';
import { artifactQueries } from './db/artifacts.ts';
import { claudeStateQueries } from './db/claude-state.ts';
import { releaseQueries } from './db/releases.ts';
import { slowMomentQueries } from './db/slow-moments.ts';
import { viewQueries } from './db/views.ts';

import { askerKey, buildOwnerKey, pagePlanKey, planKey } from './db-keys.ts';
import { copyRow, scoped } from './read-scope.ts';
import { CHAT, attachEventsForWrite, cardFatesTrigger, eventsHome, eventsMoved, eventsPath, eventsSchema, moveEvents } from './events-db.ts';
export { askerKey, buildOwnerKey, pagePlanKey, planKey };
import {
  type AppInstructions,
  type ClaudeStateRow,
  type CredentialRow,
  type EventRow,
  FLAKE_KEEP_MS,
  type FinishedStep,
  type FlakeFix,
  HEALTH_KEEP_MS,
  HEALTH_MAX_ROWS,
  HOST_SAMPLE_KEEP_MS,
  type HostSample,
  type Machine,
  type OpenrouterCallKind,
  type PersonNote,
  type PersonalLayer,
  type Project,
  type RepoCollaborator,
  STEP_RATIO,
  type SecretRow,
  type SpendRowRaw,
  type Ticket,
  type Turn,
  type TurnResult,
  type User,
  onboardingOpen,
  titleWithoutBuild,
  type CardFate,
  PUT_CLAUDE_STATE,
} from './db-rows.ts';
export * from './db-rows.ts';

/** The newest event when #812 landed: a card at or below it still counts a typed message as handling it (PERSON_WROTE), or every old card nobody settled would wake up open. */
export const TYPED_HANDLES_UP_TO = 696493;

const APP_INSTRUCTIONS = 'app_instructions';
/** How long the write worker's connection waits out another connection's write lock: giving up loses the write. */
export const WRITER_BUSY_MS = 30_000;

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
    this.db = new DatabaseSync(path, { timeout: opts.writer ? WRITER_BUSY_MS : 5000, readOnly: !!opts.reader });
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
    this.db
      .prepare(`DELETE FROM releases WHERE target = 'ci:windows:release' AND outcome = 'live'
      AND project_id IN (SELECT id FROM projects WHERE name = 'Peek Auras')
      AND version IN ('run:1277', 'run:1279', 'run:1282', 'run:1284', 'run:1286', 'run:1289', 'run:1291')`)
      .run();
  }

  /**
   * Shipping's starting values (#1043; Josh, 2026-11-19, "Yes, use the table"): a scheme whose merges already wait for a
   * person's Approve (both merge rules stored: Delve and Threadspace) starts on "Pull request, a person merges", which is
   * a go on every change; the rest keep the columns' defaults. Once, before 73.
   */
  private shippingFromRules() {
    if ((this.getSetting<number>('schema_version') ?? 0) >= 73) return;
    this.db
      .prepare(`UPDATE projects SET ship_path = 'pr-person', go_from = 'all'
      WHERE instr(char(10) || approval_rules || char(10), char(10) || 'Bash(gh pr merge:*)' || char(10)) > 0
        AND instr(char(10) || approval_rules || char(10), char(10) || 'mcp__*__merge_pull_request' || char(10)) > 0`)
      .run();
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
        const ids =
          m.owner_id !== null
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
    const unnumbered = this.db.prepare("SELECT id, project_id FROM tickets WHERE kind = 'ticket' AND number IS NULL ORDER BY id").all() as { id: number; project_id: number }[];
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
    const r = this.db.prepare('INSERT INTO projects (name, repo_url, owner_id, created_at) VALUES (?, ?, ?, ?)').run(name, repoUrl, ownerId, Date.now());
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
      this.db.prepare('UPDATE projects SET instructions = ?, instructions_updated_by = ?, instructions_updated_at = ? WHERE id = ?').run(instructions, by, at, id);
      this.db.prepare('INSERT INTO instruction_history (project_id, by, at, old_text, new_text) VALUES (?, ?, ?, ?, ?)').run(id, by, at, old, instructions);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** A scheme's latest instruction saves, newest first. */
  instructionHistory(projectId: number, limit: number): { by: string; at: number; old_text: string; new_text: string }[] {
    return this.db.prepare('SELECT by, at, old_text, new_text FROM instruction_history WHERE project_id = ? ORDER BY id DESC LIMIT ?').all(projectId, limit) as { by: string; at: number; old_text: string; new_text: string }[];
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
    const r = this.db.prepare('SELECT new_text, at FROM personal_instructions WHERE user_id = ? AND project_id IS ? ORDER BY id DESC LIMIT 1').get(userId, projectId) as { new_text: string; at: number } | undefined;
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
    return this.db.prepare('SELECT at, old_text, new_text FROM personal_instructions WHERE user_id = ? AND project_id IS ? ORDER BY id DESC LIMIT ?').all(userId, projectId, limit) as { at: number; old_text: string; new_text: string }[];
  }

  /** The latest Citadel-wide instruction saves, newest first. */
  appInstructionHistory(limit: number): { by: string; at: number; old_text: string; new_text: string }[] {
    return this.db.prepare('SELECT by, at, old_text, new_text FROM app_instruction_history ORDER BY id DESC LIMIT ?').all(limit) as { by: string; at: number; old_text: string; new_text: string }[];
  }

  setProjectSettings(
    id: number,
    fields: Partial<
      Pick<
        Project,
        | 'approval_rules'
        | 'plugin_dirs'
        | 'optional_plugin_dirs'
        | 'default_effort'
        | 'onboarding'
        | 'onboarding_mode'
        | 'list_groups'
        | 'ci_quiet'
        | 'ci_watch'
        | 'land_mode'
        | 'fable_ok'
        | 'builds'
        | 'grill'
        | 'gh_runners'
        | 'shot_widths'
        | 'shot_themes'
        | 'shots_required'
        | 'shot_note'
        | 'ship_path'
        | 'go_from'
        | 'try_first'
        | 'msg_loop_limit'
        | 'msg_loop_min'
        | 'msg_cold_min'
        | 'msg_hold_h'
        | 'msg_never_hold'
        | 'rules_review'
        | 'skills_off'
      >
    >,
  ) {
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
    } catch (err) {
      if (/UNIQUE/.test(thrown(err).message ?? '')) throw new Error(`There is already a scheme called "${trimmed}"`);
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
    this.db.prepare('INSERT INTO users (id, name, login, admin, server_login, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, u.name, u.login, u.admin ? 1 : 0, u.server_login ? 1 : 0, Date.now());
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
    this.db
      .prepare(`INSERT INTO credentials (user_id, kind, secret, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
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
    this.db
      .prepare(`INSERT INTO stored_secrets (scope, owner_id, name, value, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
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
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(CASE status WHEN 'ok' THEN cost_usd WHEN 'failed' THEN 0 ELSE estimate_usd END), 0) AS spent
      FROM openrouter_calls WHERE user_id = ? AND created_at >= ?`)
      .get(userId, since) as { spent: number };
    return row.spent;
  }

  addOpenrouterCall(c: { user_id: number; ticket_id: number | null; project_id: number | null; model: string; kind: OpenrouterCallKind; estimate_usd: number }): number {
    return Number(
      this.db
        .prepare(`INSERT INTO openrouter_calls (user_id, ticket_id, project_id, model, kind, estimate_usd, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(c.user_id, c.ticket_id, c.project_id, c.model, c.kind, c.estimate_usd, Date.now()).lastInsertRowid,
    );
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
    return (
      this.db
        .prepare(`SELECT u.id, u.name, u.login, u.id = p.owner_id AS owner FROM users u JOIN projects p ON p.id = ?
      LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = u.id
      WHERE u.id = p.owner_id OR m.user_id IS NOT NULL ORDER BY owner DESC, m.added_at`)
        .all(projectId) as (Pick<User, 'id' | 'name' | 'login'> & { owner: number })[]
    ).map((r) => ({ ...r, owner: !!r.owner }));
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
    this.db
      .prepare(`INSERT INTO repo_collaborators (project_id, user_id, slug, login, state, invitation_id, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
    return !!this.db
      .prepare(`SELECT 1 FROM projects WHERE id = ?1 AND owner_id = ?2
      UNION SELECT 1 FROM project_members WHERE project_id = ?1 AND user_id = ?2`)
      .get(projectId, uid ?? -1);
  }

  /** The schemes a person is in, as owner or member; null for an admin (isAdmin's sense), who is in all of them. */
  visibleProjects(who: { uid?: number; admin?: boolean }): Set<number> | null {
    if (who.admin || this.inScheme(who.uid, GLOBAL_OWNER)) return null;
    const rows = this.db
      .prepare(`SELECT id FROM projects WHERE owner_id = ?1
      UNION SELECT project_id FROM project_members WHERE user_id = ?1`)
      .all(who.uid ?? -1) as { id: number }[];
    return new Set(rows.map((r) => r.id));
  }

  /** The schemes a person owns or is a member of, admin or not: the Releases page's All view (#625). */
  memberSchemes(uid: number | undefined): Set<number> {
    const rows = scoped(
      this.db,
      `member-schemes:${uid ?? -1}`,
      () =>
        this.db
          .prepare(`SELECT id FROM projects WHERE owner_id = ?1
      UNION SELECT project_id FROM project_members WHERE user_id = ?1`)
          .all(uid ?? -1) as { id: number }[],
    );
    return new Set(rows.map((r) => r.id));
  }

  /** Whether a person may see a scheme: an admin (a Citadel member too: isAdmin), its owner, or a member. */
  canSee(who: { uid?: number; admin?: boolean }, projectId: number): boolean {
    return !!who.admin || this.inScheme(who.uid, projectId) || this.inScheme(who.uid, GLOBAL_OWNER);
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
    this.db
      .prepare(`INSERT INTO list_orders (user_id, list, keys, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, list) DO UPDATE SET keys = excluded.keys, updated_at = excluded.updated_at`)
      .run(uid, list, JSON.stringify(keys), Date.now());
  }

  /** The Needs-you items `name` last saw waiting in each scheme (#539): project id -> their keys. */
  seenItems(name: string): Map<number, Set<string>> {
    const rows = this.db.prepare('SELECT project_id, keys FROM project_seen_items WHERE name = ?').all(name) as { project_id: number; keys: string }[];
    return new Map(rows.map((r) => [r.project_id, new Set(JSON.parse(r.keys) as string[])]));
  }

  /** Record the items `name` saw waiting in a scheme; with `keep`, only when none are recorded yet. */
  setSeenItems(name: string, projectId: number, keys: string[], keep = false) {
    this.db
      .prepare(`INSERT INTO project_seen_items (name, project_id, keys, seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(name, project_id) DO ${keep ? 'NOTHING' : 'UPDATE SET keys = excluded.keys, seen_at = excluded.seen_at'}`)
      .run(name, projectId, JSON.stringify(keys), Date.now());
  }

  deleteProject(id: number) {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  /** updateTicket's (src/db/minions.ts): each close gets its own closed_at. */
  lastClosedAt = 0;

  /** The next events.id to hand out, set by the write worker's start (src/db-writer.ts); null writes inline and lets SQLite pick. */
  eventIds: { next: number; floor: () => number } | null = null;
  /** Resolves once every write queued on the write worker has run (null: none queued, or no worker), for async code
   * that writes on this thread next, so it waits off the event loop (src/db-writer.ts). */
  allWritten: () => Promise<void> | null = () => null;

  /** events.db, the chat log's own file (src/events-db.ts); null for an in-memory store. */
  get eventsPath(): string | null {
    return eventsPath(this.path);
  }

  /** state.db's file, for a second connection to it (StateDb); null for an in-memory store. */
  get statePath(): string | null {
    return this.path === ':memory:' ? null : join(dirname(this.path), 'state.db');
  }

  /** People's notes on a scheme's minions, by ticket id. Only people's routes may hand these out. */
  personNotes(projectId: number): Record<number, PersonNote> {
    // A note older than its minion belongs to a deleted one whose id was reused: a rolled-back release's deleteTicket leaves it behind.
    const rows = this.db.prepare('SELECT n.ticket_id, n.text, n.updated_by, n.updated_at FROM person_notes n JOIN tickets t ON t.id = n.ticket_id WHERE t.project_id = ? AND n.updated_at >= t.created_at').all(projectId) as { ticket_id: number; text: string; updated_by: string; updated_at: number }[];
    return Object.fromEntries(rows.map((r) => [r.ticket_id, { text: r.text, by: r.updated_by, at: r.updated_at }]));
  }

  /** Set a minion's person note, or clear it with an empty text. */
  setPersonNote(ticketId: number, text: string, by: string): PersonNote | null {
    if (!text) {
      this.db.prepare('DELETE FROM person_notes WHERE ticket_id = ?').run(ticketId);
      return null;
    }
    const at = Date.now();
    this.db.prepare('INSERT INTO person_notes (ticket_id, text, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(ticket_id) DO UPDATE SET text = excluded.text, updated_by = excluded.updated_by, updated_at = excluded.updated_at').run(ticketId, text, by, at);
    return { text, by, at };
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

  // The fates as last written to card_fates. A fate is written when it is new or found something, and the newest event it
  // looked at only now and then (an unsettled card would otherwise write every call): a stale `up_to` only means
  // the next read after a restart scans a little more.
  savedFates = new Map<number, CardFate>();
  fatesSavedAt = 0;
  // What recentCards found of each card, by event id: a reply or result once found stays (events are only appended),
  // and `upTo` is the newest event looked at, so the next read only scans messages after it (#622).
  cardFates = new Map<number, CardFate>();

  // recentCards' card rows, by event id, with the card's own id: a card's row only changes through setEventData and
  // goes with deleteTicket, which both drop it here (#759).
  cardRows = new Map<number, EventRow & { cid: unknown }>();

  // Card events found answered, settled or no longer pending. None ever waits again (a plan never goes back to pending,
  // and events are only appended), so later reads skip their rows: cold, re-reading Citadel's 335 card rows and the
  // messages after them was 270 ms of the scheme list's 340 ms (#614).
  doneCards = new Set<number>();

  /** TYPED_HANDLES_UP_TO; a test sets 0 to run the new rule on its small ids. */
  typedHandlesUpTo = TYPED_HANDLES_UP_TO;

  /**
   * Store a finished turn. Its cost is the session's running total minus the total at the session's
   * previous turn; a total that went down means Claude Code started counting afresh (it restores the
   * running total on --resume only when the session was the last one run in that folder), so the
   * whole total is this turn's.
   */
  async recordTurn(ticketId: number, r: TurnResult): Promise<Turn> {
    return turnRow(this.db, ticketId, r);
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
    const rows = this.db
      .prepare(`SELECT ended_at, cache_read_tokens, cache_write_tokens, prompt_digest FROM turns
        WHERE ticket_id = ? AND prompt_digest IS NOT NULL ORDER BY id DESC LIMIT ?`)
      .all(ticketId, limit) as { ended_at: number; cache_read_tokens: number | null; cache_write_tokens: number | null; prompt_digest: string }[];
    return rows.map(({ prompt_digest, ...r }) => ({ ...r, hashes: JSON.parse(prompt_digest) }));
  }

  /**
   * Fill the turns table from stored result events, for turns from before it existed. Session ids
   * come from each turn's init event. Only runs on an empty table; returns how many turns it added.
   */
  backfillTurns(): number {
    if (this.db.prepare('SELECT 1 FROM turns LIMIT 1').get()) return 0;
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
          turnRow(this.db, row.ticket_id, {
            event_id: row.id,
            session_id: session.get(row.ticket_id) ?? null,
            ended_at: row.created_at,
            session_cost_usd: ev.total_cost_usd,
            duration_ms: ev.duration_ms,
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
    const sum = (where: string, ...args: number[]) =>
      this.db
        .prepare(`SELECT COUNT(*) AS n, SUM(work_ms) AS work, SUM(estimate) AS guess FROM (
      SELECT s.work_ms, s.estimate FROM step_times s JOIN tickets t ON t.id = s.ticket_id WHERE s.estimate IS NOT NULL ${where}
      ORDER BY s.finished_at DESC LIMIT ${STEP_RATIO.recent})`)
        .get(...args) as { n: number; work: number | null; guess: number | null };
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
    return this.db
      .prepare(`SELECT (SELECT p.value FROM properties p JOIN property_keys pk ON pk.id = p.key_id
          WHERE p.target_type = 'minion' AND p.target_id = k.id AND pk.key = 'type' LIMIT 1) AS type,
        coalesce(k.model, k.last_model) AS model, c.cost
      FROM tickets k JOIN (SELECT ticket_id, SUM(cost_usd) AS cost FROM turns GROUP BY ticket_id) c ON c.ticket_id = k.id
      WHERE k.kind = 'ticket' AND k.status = 'closed' AND k.created_at >= ? AND c.cost > 0`)
      .all(since) as unknown as { type: string | null; model: string | null; cost: number }[];
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
    return this.db.prepare('SELECT u.payer, t.project_id, SUM(u.cost_usd) AS cost FROM turns u JOIN tickets t ON t.id = u.ticket_id WHERE u.ended_at >= ? GROUP BY u.payer, t.project_id').all(since) as unknown as { payer: number | null; project_id: number; cost: number }[];
  }

  /** What one payer's turns on one of their accounts cost since `since`; a turn from before #905 kept no account and counts as account 1's. */
  accountSpend(payer: number | null, account: number, since: number): number | null {
    // Turns kept no account before #905, so a window holding one of those can't be split by account (keepalive pings keep none, and cost next to nothing).
    if (this.db.prepare('SELECT 1 FROM turns WHERE payer IS ? AND ended_at >= ? AND account IS NULL AND keepalive IS NULL LIMIT 1').get(payer, since)) return null;
    return (this.db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS c FROM turns WHERE payer IS ? AND ended_at >= ? AND ${account === 1 ? '(account IS NULL OR account = 1)' : 'account = ?'}`).get(payer, since, ...(account === 1 ? [] : [account])) as { c: number }).c;
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
    return this.db.prepare(`SELECT kind, at, commit_sha, detail FROM health_events WHERE kind IN (${kinds.map(() => '?').join(', ')}) AND at >= ? ORDER BY at`).all(...kinds, since) as unknown as { kind: string; at: number; commit_sha: string | null; detail: string }[];
  }

  /** One reading of perigee's memory, disk and load (#1123); drops readings past HOST_SAMPLE_KEEP_MS. */
  addHostSample(s: HostSample) {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO host_samples (at, mem_total, mem_avail, disk_total, disk_free, load1, rss, cpu_psi, mem_psi, io_psi, swap_used, cpu_ledger, answer_time, db_cached, db_size, kswapd_rate, refault_rate, server_refault_rate, pgpgin_rate, thp_fallback_rate, warm_ms, warm_mb, warm_backoffs, open_fds, supervisors, tmp_used, app_mem) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        s.at,
        s.mem_total,
        s.mem_avail,
        s.disk_total,
        s.disk_free,
        s.load1,
        s.rss,
        s.cpu_psi ?? null,
        s.mem_psi ?? null,
        s.io_psi ?? null,
        s.swap_used ?? null,
        s.cpu_ledger ?? null,
        s.answer_time ?? null,
        s.db_cached ?? null,
        s.db_size ?? null,
        s.kswapd_rate ?? null,
        s.refault_rate ?? null,
        s.server_refault_rate ?? null,
        s.pgpgin_rate ?? null,
        s.thp_fallback_rate ?? null,
        s.warm_ms ?? null,
        s.warm_mb ?? null,
        s.warm_backoffs ?? null,
        s.open_fds ?? null,
        s.supervisors ?? null,
        s.tmp_used ?? null,
        s.app_mem ?? null,
      );
    this.db.prepare('DELETE FROM host_samples WHERE at < ?').run(s.at - HOST_SAMPLE_KEEP_MS);
  }

  hostSamples(since: number): HostSample[] {
    return this.db.prepare('SELECT * FROM host_samples WHERE at >= ? ORDER BY at').all(since) as unknown as HostSample[];
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
    return this.db
      .prepare(`SELECT file, COUNT(*) AS count, MAX(at) AS last,
        (SELECT e2.ticket_id FROM flake_events e2 WHERE e2.project_id = e.project_id AND e2.file = e.file ORDER BY e2.at DESC, e2.id DESC LIMIT 1) AS ticketId
      FROM flake_events e WHERE project_id = ? AND at >= ? GROUP BY file ORDER BY count DESC, last DESC LIMIT ?`)
      .all(projectId, since, limit) as { file: string; count: number; last: number; ticketId: number | null }[];
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
    const r = this.db.prepare('INSERT INTO flake_fixes (project_id, file, ticket_id, state, started_at, clean_runs, held_at, reopened) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(projectId, file, ticketId, patch.state ?? 'open', startedAt, patch.clean_runs ?? 0, patch.held_at ?? null, patch.reopened ?? 0);
    return Number(r.lastInsertRowid);
  }

  updateFlakeFix(id: number, patch: Partial<Omit<FlakeFix, 'id' | 'project_id' | 'file'>>) {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (!keys.length) return;
    this.db.prepare(`UPDATE flake_fixes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k] as SQLInputValue), id);
  }

  /** The newest `n` failing outputs kept for a file. */
  flakeDetails(projectId: number, file: string, n = 3): { at: number; detail: string }[] {
    return this.db.prepare("SELECT at, detail FROM flake_events WHERE project_id = ? AND file = ? AND detail != '' ORDER BY at DESC, id DESC LIMIT ?").all(projectId, file, n) as { at: number; detail: string }[];
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
    return this.db.prepare(`SELECT at, kind, commit_sha, detail FROM health_events WHERE at >= ? AND at < ?${only} ORDER BY at, id LIMIT ?`).all(from, to, ...(kinds ?? []), limit) as { at: number; kind: string; commit_sha: string | null; detail: string }[];
  }

  /** The newest `kind` reading before `before` (#1135: the last stall before a watchdog restart), or null. */
  lastHealthEvent(kind: string, before: number): { at: number; detail: string } | null {
    return (this.db.prepare('SELECT at, detail FROM health_events WHERE kind = ? AND at < ? ORDER BY at DESC LIMIT 1').get(kind, before) as { at: number; detail: string } | undefined) ?? null;
  }

  /**
   * How turns ended in [from, to) (#724): every finished turn (the turns table) plus every error event (a turn that
   * couldn't start or crashed), minus the turns that stopped on "Not logged in" (loggedOut: their accounts) or on a usage limit ("You've hit your 5-hour limit", USAGE_LIMIT: a person's
   * plan running out says nothing about a deploy, and they are left out of both counts), how many of those failed (a result with is_error, or an error), and the first failure's time.
   */
  turnOutcomes(from: number, to: number): { turns: number; failed: number; first: number | null; loggedOut: number[] } {
    const ok = this.db
      .prepare(`SELECT COUNT(*) AS n, SUM(e.data LIKE '%"is_error":true%') AS bad, MIN(CASE WHEN e.data LIKE '%"is_error":true%' THEN t.ended_at END) AS first
        FROM turns t LEFT JOIN events e ON e.id = t.event_id WHERE t.ended_at >= ? AND t.ended_at < ? AND t.keepalive IS NULL AND t.side IS NULL AND NOT COALESCE(e.data LIKE '%"is_error":true%' AND (e.data LIKE '%hit your %limit%' OR e.data LIKE '%Not logged in%'), 0)`)
      .get(from, to) as { n: number; bad: number | null; first: number | null };
    // Through events_errors: without it this read every event of the window (43 ms a day's window, #1178), eventIdAt or not.
    const errs = this.db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS first FROM events WHERE kind = 'error' AND created_at >= ? AND created_at < ? AND data NOT LIKE '%hit your %limit%' AND data NOT LIKE '%Not logged in%'").get(from, to) as { n: number; first: number | null };
    // Left out too ("Not logged in", #1481: one account's login dropping after a deploy isn't the deploy's fault), but named, so a real logout shows: the account numbers (a turn from before #905 kept none: account 1). shortcut: only finished turns are named; a "Not logged in" error event has no account, so it is left out unnamed, name those if one ever shows up.
    const out = this.db.prepare(`SELECT DISTINCT COALESCE(t.account, 1) AS a FROM turns t JOIN events e ON e.id = t.event_id WHERE t.ended_at >= ? AND t.ended_at < ? AND t.keepalive IS NULL AND t.side IS NULL AND e.data LIKE '%"is_error":true%' AND e.data LIKE '%Not logged in%' ORDER BY a`).all(from, to) as {
      a: number;
    }[];
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

  getSetting<T>(key: string): T | null {
    // The text, not the parsed value, is what a read scope keeps: each caller gets its own copy to change.
    const value = scoped(this.db, `setting:${key}`, () => (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null);
    return value == null ? null : JSON.parse(value);
  }

  /** Every setting whose key starts with `prefix`, as key and value. */
  settingsWithPrefix<T>(prefix: string): { key: string; value: T }[] {
    // A range on the key's index like settingKeys: LIKE with ESCAPE read every row of the table (part of a 0.6 s hold in fableMeter, #1251).
    const [where, args] = this.keyRange(prefix);
    return (this.db.prepare(`SELECT key, value FROM settings WHERE ${where} ORDER BY key`).all(...args) as { key: string; value: string }[]).map((r) => ({ key: r.key, value: JSON.parse(r.value) as T }));
  }

  /** What every payer's Fable turns cost since `since` (#1061), from the per-model split, so turns before it was kept count for nothing. */
  fableSpend(since: number): number {
    return (this.db.prepare("SELECT COALESCE(SUM(m.cost_usd), 0) AS c FROM turn_models m JOIN turns u ON u.id = m.turn_id WHERE u.ended_at >= ? AND m.model LIKE '%fable%'").get(since) as { c: number }).c;
  }

  setSetting(key: string, value: unknown) {
    // An unchanged value writes nothing: ci-health alone rewrote 250 KB of the same job lists every 5 minutes (#680).
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE value IS NOT excluded.value').run(key, JSON.stringify(value));
  }

  /** Whether this connection checkpoints the WAL itself on commit (SQLite's default) or leaves it to checkpointOffThread (src/checkpoint.ts, #680). */
  autoCheckpoint(on: boolean) {
    this.db.exec(`PRAGMA wal_autocheckpoint = ${on ? 1000 : 0}`);
  }

  deleteSetting(key: string) {
    this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
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
const AREAS = [releaseQueries, claudeStateQueries, artifactQueries, contraptionQueries, seenQueries, cardQueries, eventQueries, ciNumberQueries, contraptionRunQueries, deliveryQueries, flakeQueries, machineQueries, minionQueries, pushQueries, readWarmQueries, settingQueries, slowMomentQueries, viewQueries];
// The same list as a type: written out, since a type taken from AREAS would loop through Store's own type.
type Areas = typeof releaseQueries &
  typeof claudeStateQueries &
  typeof artifactQueries &
  typeof contraptionQueries &
  typeof seenQueries &
  typeof cardQueries &
  typeof eventQueries &
  typeof ciNumberQueries &
  typeof contraptionRunQueries &
  typeof deliveryQueries &
  typeof flakeQueries &
  typeof machineQueries &
  typeof minionQueries &
  typeof pushQueries &
  typeof readWarmQueries &
  typeof settingQueries &
  typeof slowMomentQueries &
  typeof viewQueries;
// Without `this: Store` on the class's side, so a caller holding a Pick<Store, ...> can still call them.
type AreaQueries = { [K in keyof Areas]: OmitThisParameter<Areas[K]> };
export interface Store extends AreaQueries {}
for (const area of AREAS) {
  for (const [name, d] of Object.entries(Object.getOwnPropertyDescriptors(area))) {
    if (name in Store.prototype) throw new Error(`Store.${name} is defined twice: in src/db.ts and src/db/, or in two area files`);
    Object.defineProperty(Store.prototype, name, { ...d, enumerable: false });
  }
}

/** recordTurn's write, run at once: backfillTurns runs it in its own transaction. */
function turnRow(db: DatabaseSync, ticketId: number, r: TurnResult): Turn {
  const last = (side: boolean, session?: string | null) =>
    db.prepare(`SELECT id, session_id, session_cost_usd FROM turns WHERE ticket_id = ? AND side IS ?${session ? ' AND session_id = ?' : ''} ORDER BY id DESC LIMIT 1`).get(ticketId, side ? 1 : null, ...(session ? [session] : [])) as { id: number; session_id: string | null; session_cost_usd: number } | undefined;
  // A side thread's turns follow its own fork's (threads interleave); the fork's first starts from its parent's total.
  const prev = r.side && r.session_id ? (last(true, r.session_id) ?? (r.fork_of ? last(false, r.fork_of) : undefined)) : last(!!r.side);
  const sameSession = (prev && (prev.session_id ?? null) === (r.session_id ?? null)) || (r.side && !!r.fork_of && prev?.session_id === r.fork_of);
  const base = sameSession && prev.session_cost_usd <= r.session_cost_usd ? prev.session_cost_usd : 0;
  const u = r.usage ?? null;
  const n = (v: unknown) => (typeof v === 'number' ? v : null);
  const row = db
    .prepare(`INSERT INTO turns (ticket_id, event_id, session_id, ended_at, cost_usd, session_cost_usd, duration_ms,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, payer, keepalive, account, prompt_digest, side) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`)
    .get(
      ticketId,
      r.event_id ?? null,
      r.session_id ?? null,
      r.ended_at,
      r.session_cost_usd - base,
      r.session_cost_usd,
      n(r.duration_ms),
      n(u?.input_tokens),
      n(u?.output_tokens),
      n(u?.cache_read_input_tokens),
      n(u?.cache_creation_input_tokens),
      r.payer ?? null,
      r.keepalive ? 1 : null,
      n(r.account),
      r.hashes ? JSON.stringify(r.hashes) : null,
      r.side ? 1 : null,
    ) as unknown as Turn;
  // Each model's running total, less its total at the session's previous turn, as the whole turn's cost is (#905).
  const models = r.modelUsage && typeof r.modelUsage === 'object' ? Object.entries(r.modelUsage) : [];
  const was = db.prepare('SELECT session_cost_usd FROM turn_models WHERE turn_id = ? AND model = ?');
  const add = db.prepare('INSERT INTO turn_models (turn_id, model, cost_usd, session_cost_usd) VALUES (?, ?, ?, ?)');
  const totals = models.flatMap(([model, m]) => {
    const total = m?.costUSD;
    return typeof total === 'number' && Number.isFinite(total) && total >= 0 && model ? [[model.slice(0, 100), total] as const] : [];
  });
  // The session's previous turn ran before the split was kept: its share of each model is unknown, so split this turn's cost pro rata.
  const unsplit = base > 0 && !db.prepare('SELECT 1 FROM turn_models WHERE turn_id = ?').get(prev!.id);
  const sum = totals.reduce((a, [, t]) => a + t, 0);
  for (const [model, total] of totals) {
    const before = base > 0 && !unsplit ? ((was.get(prev!.id, model) as { session_cost_usd: number } | undefined)?.session_cost_usd ?? 0) : 0;
    add.run(row.id, model, unsplit ? (sum ? (row.cost_usd * total) / sum : 0) : before <= total ? total - before : total, total);
  }
  return row;
}
