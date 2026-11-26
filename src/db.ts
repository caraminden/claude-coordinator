import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from './properties.ts';
import { Schedules } from './schedules.ts';
import { ReviewSet } from './review-set.ts';
import { Claims } from './claims.ts';
import { MemoryProposals, MEMORY_PROPOSALS_SCHEMA } from './memory-curator.ts';
import { ShipLessons } from './ship-lessons.ts';
import { UsageLedger } from './usage-ledger.ts';
import { Ideas } from './ideas.ts';
import { Memory } from './memory.ts';
import { MinionIndex, MINION_INDEX_SCHEMA } from './minion-index.ts';
import { ciNumberQueries } from './db/ci-numbers.ts';
import { contraptionRunQueries } from './db/contraption-runs.ts';
import { deliveryQueries } from './db/deliveries.ts';
import { flakeQueries } from './db/flakes.ts';
import { flowQueries } from './db/flow.ts';
import { machineQueries } from './db/machines.ts';
import { legacyFromRoles, parseLegacyLend, ROLE_NAMES, rolesFromLegacy, runnerHost, runnerSeen, sameLend } from './machine-roles.ts';
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
import { schemeQueries } from './db/schemes.ts';
import { peopleQueries } from './db/people.ts';
import { credentialQueries } from './db/credentials.ts';
import { turnQueries } from './db/turns.ts';
import { healthQueries } from './db/health.ts';
import { slowMomentQueries } from './db/slow-moments.ts';
import { cabalQueries } from './db/cabals.ts';
import { waitRecordQueries } from './db/wait-records.ts';
import { viewQueries } from './db/views.ts';

import { askerKey, buildOwnerKey, ownMemoryKey, pagePlanKey, planKey, WAITS_SINCE_KEY } from './db-keys.ts';
import { scoped } from './read-scope.ts';
import { CHAT, attachEventsForWrite, cardFatesTrigger, eventsHome, eventsMoved, eventsPath, eventsSchema, moveEvents } from './events-db.ts';
export { askerKey, buildOwnerKey, ownMemoryKey, pagePlanKey, planKey };
import { SCHEMA } from './db-schema.ts';
import { type ClaudeStateRow, type EventRow, type Machine, titleWithoutBuild, type CardFate, PUT_CLAUDE_STATE } from './db-rows.ts';
export * from './db-rows.ts';

/** The newest event when #812 landed: a card at or below it still counts a typed message as handling it (PERSON_WROTE), or every old card nobody settled would wake up open. */
export const TYPED_HANDLES_UP_TO = 696493;

/** How long the write worker's connection waits out another connection's write lock: giving up loses the write. */
export const WRITER_BUSY_MS = 30_000;

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
  // Why a running job's last pause didn't take (#1956, 2MA1).
  ['machine_jobs', 'pause_failed', 'ALTER TABLE machine_jobs ADD COLUMN pause_failed TEXT'],
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
  ['machines', 'priority', 'ALTER TABLE machines ADD COLUMN priority INTEGER'],
  ['machines', 'last_check', 'ALTER TABLE machines ADD COLUMN last_check TEXT'],
  ['machines', 'lend', 'ALTER TABLE machines ADD COLUMN lend TEXT'],
  // What its agent says the PC can do (Build 7 M2, src/machine-join.ts MachineReport), as JSON; null before an agent that reports.
  ['machines', 'report', 'ALTER TABLE machines ADD COLUMN report TEXT'],
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
  // A cabal's roster as its forming card approves it, and its width (#2091, src/cabal-start.ts).
  ['cabals', 'width', 'ALTER TABLE cabals ADD COLUMN width INTEGER NOT NULL DEFAULT 4'],
  ['cabal_rows', 'handoff', "ALTER TABLE cabal_rows ADD COLUMN handoff TEXT NOT NULL DEFAULT ''"],
  ['cabal_rows', 'model', "ALTER TABLE cabal_rows ADD COLUMN model TEXT NOT NULL DEFAULT ''"],
  ['cabal_rows', 'effort', "ALTER TABLE cabal_rows ADD COLUMN effort TEXT NOT NULL DEFAULT ''"],
  ['cabal_rows', 'cost', 'ALTER TABLE cabal_rows ADD COLUMN cost REAL'],
  ['cabal_rows', 'approved_by', 'ALTER TABLE cabal_rows ADD COLUMN approved_by TEXT'],
  ['cabal_rows', 'approved_at', 'ALTER TABLE cabal_rows ADD COLUMN approved_at INTEGER'],
  ['cabal_rows', 'next_at', 'ALTER TABLE cabal_rows ADD COLUMN next_at INTEGER'],
];

/**
 * The database's shape, kept in the `schema_version` setting. Add a line to SCHEMA_HISTORY below (the next number, what changed) with any change to SCHEMA (src/db-schema.ts) or
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
  [116, 'machine_jobs.pause_failed (#1956)'],
  [117, 'claims.landed, keep (#1985)'],
  [118, 'wait_records (#1992)'],
  [119, 'claims.handed, beside, beside_since, beside_handed, beside_landed, claim_queue.ready (#1985)'],
  [120, 'time_log_explains (#1994)'],
  [121, 'cabals, cabal_rows, cabal_asks, cabal_log (#2090)'],
  [122, 'cabals.width; cabal_rows handoff, model, effort, cost, approved_by, approved_at, next_at (#2091)'],
  [123, 'machine_roles, machine_role_projects, filled from machines.lend and machine_projects (Build 7 M1, #2052)'],
  [124, 'machine_joins, machines.report (Build 7 M2, #2053)'],
  [125, 'machines.priority (Build 7 M6, #2056)'],
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
    this.machineRoleTables();
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
        // machine_projects itself: this runs before the roles exist (machineRoleTables), and Store.machineProjects reads them.
        const rows = (this.db.prepare('SELECT project_id FROM machine_projects WHERE machine_id = ? ORDER BY project_id').all(m.id) as { project_id: number }[]).map((r) => r.project_id);
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

  /**
   * A machine's roles (Build 7 M1, src/machine-roles.ts rolesFromLegacy): each machine's lend and one list of schemes
   * become its roles and a list per role, so every turn, tool and runner token goes where it went before. Every boot,
   * for a machine with no role rows (the first boot from schema 121, or one an older release added after a rollback)
   * and one whose old columns no longer say what its roles do (an older release changed them, or made it a CI runner
   * host this release never saw: machine-roles.ts runnerSeen): this release writes those columns from the roles on
   * every change, so a difference is a rollback's, and the old columns win.
   * Says what it did, for the deploy's notes.
   */
  private machineRoleTables() {
    const machines = this.db.prepare('SELECT * FROM machines ORDER BY id').all() as unknown as Machine[];
    const has = new Set((this.db.prepare('SELECT DISTINCT machine_id FROM machine_roles').all() as { machine_id: number }[]).map((r) => r.machine_id));
    const list = (id: number) => (this.db.prepare('SELECT project_id FROM machine_projects WHERE machine_id = ? ORDER BY project_id').all(id) as { project_id: number }[]).map((r) => r.project_id);
    const stale = machines.filter((m) => {
      if (!has.has(m.id)) return true;
      const roles = this.machineRoles(m.id);
      const now = legacyFromRoles(roles);
      return !sameLend(parseLegacyLend(m.lend), now.lend) || list(m.id).join() !== now.projects.join() || (runnerHost(m.last_check) && !runnerSeen(roles));
    });
    if (!stale.length) return;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const m of stale) {
        const roles = this.writeMachineRoles(m.id, () => rolesFromLegacy(m, list(m.id)));
        const on = roles.filter((r) => r.on).map((r) => `${ROLE_NAMES[r.role]} (${r.projects.join(', ') || 'no scheme'})`);
        console.log(`Machine roles (M1): ${m.name}${has.has(m.id) ? ', changed by an older release,' : ''} now lends ${on.join('; ') || 'nothing'}.`);
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
    if (this.getSetting(WAITS_SINCE_KEY) === null) this.setSetting(WAITS_SINCE_KEY, Date.now());
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

  /** How many `kind` readings fell in [from, to), the first one's time, and the commonest details with their counts. */
  healthCount(kind: string, from: number, to: number, top = 3): { count: number; first: number | null; top: { detail: string; n: number }[] } {
    const { count, first } = this.db.prepare('SELECT COUNT(*) AS count, MIN(at) AS first FROM health_events WHERE kind = ? AND at >= ? AND at < ?').get(kind, from, to) as { count: number; first: number | null };
    const rows = count ? (this.db.prepare('SELECT detail, COUNT(*) AS n FROM health_events WHERE kind = ? AND at >= ? AND at < ? GROUP BY detail ORDER BY n DESC, MIN(at) LIMIT ?').all(kind, from, to, top) as { detail: string; n: number }[]) : [];
    return { count: Number(count), first: first ?? null, top: rows.map((r) => ({ detail: r.detail, n: Number(r.n) })) };
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
const AREAS = [
  healthQueries,
  turnQueries,
  credentialQueries,
  peopleQueries,
  schemeQueries,
  releaseQueries,
  claudeStateQueries,
  artifactQueries,
  contraptionQueries,
  seenQueries,
  cardQueries,
  eventQueries,
  ciNumberQueries,
  contraptionRunQueries,
  deliveryQueries,
  flakeQueries,
  flowQueries,
  machineQueries,
  minionQueries,
  pushQueries,
  readWarmQueries,
  settingQueries,
  slowMomentQueries,
  cabalQueries,
  waitRecordQueries,
  viewQueries,
];
// The same list as a type: written out, since a type taken from AREAS would loop through Store's own type.
type Areas = typeof healthQueries &
  typeof turnQueries &
  typeof credentialQueries &
  typeof peopleQueries &
  typeof schemeQueries &
  typeof releaseQueries &
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
  typeof flowQueries &
  typeof machineQueries &
  typeof minionQueries &
  typeof pushQueries &
  typeof readWarmQueries &
  typeof settingQueries &
  typeof slowMomentQueries &
  typeof cabalQueries &
  typeof waitRecordQueries &
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
