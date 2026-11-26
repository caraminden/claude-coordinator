// The CREATE TABLE text a new database is made from (#1842). src/db.ts runs it, and keeps the migrations, SCHEMA_HISTORY and
// SCHEMA_VERSION: a change here takes the next SCHEMA_HISTORY number there.
export const SCHEMA = `
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
-- A machine's roles (Build 7 M1, src/machine-roles.ts): tools, screen, ci, turns, gpu; each switched on or off, with the owner's caps
-- (JSON; the Tools role's ticks too) and its setup's state (JSON: state, report, at). The truth since schema 121: machines.lend
-- and machine_projects are written from these for one build, for a rollback, and read by nothing else.
CREATE TABLE IF NOT EXISTS machine_roles (
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  "on" INTEGER NOT NULL DEFAULT 0,
  caps TEXT NOT NULL DEFAULT '{}',
  setup TEXT,
  PRIMARY KEY (machine_id, role)
);
-- The schemes each of a machine's roles is lent to.
CREATE TABLE IF NOT EXISTS machine_role_projects (
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (machine_id, role, project_id)
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
  swept_at INTEGER,
  pause_failed TEXT
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
-- Explain on a minion's time log (#1994, src/time-log-explain.ts): Haiku's reading of each step and wait, one row a minion,
-- kept for everyone who can open its chat. data is the Explain JSON (its v says which version wrote it).
CREATE TABLE IF NOT EXISTS time_log_explains (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  at INTEGER NOT NULL
);
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
-- What a minion's time log can't work out from its events (#1992, src/db/wait-records.ts): state changes, its ship's places and stages, cut-off commands.
CREATE TABLE IF NOT EXISTS wait_records (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wait_records_ticket ON wait_records(ticket_id, id);
`;
