// What a turn is launched with: the pinned copies of the server files it runs, its hooks, settings,
// environment and tool lists. The runner (src/runner.ts) and contraption turns (src/contraption-turns.ts)
// both build their launches from these.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { APPROVAL_TIMEOUT_MS, lines, permissionArgs, pluginDirArgs, turnPluginDirs } from './approvals.ts';
import { androidEnv, AUTH_VARS, resolveClaude, type TurnPlace } from './claude-link.ts';
import type { Project, Ticket } from './db.ts';
import { GLOBAL_OWNER } from './properties.ts';
import { claudeConfigDir } from './sessions.ts';
import type { TripwireConfig } from './tripwire.ts';
import { SCHEME_REFS_MATCHER } from './scheme-refs.ts';
import { CHECKOUT, machineServers, type TurnMachine } from './prompts.ts';

// Turns run a copy of the MCP server taken when this server started, not the file on disk: a deploy
// pulls new code before the restart, and a newer MCP server would offer tools this process rejects.
// The copies live in the app's data dir, one folder per server process, swept once that process is gone.
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

/** The pinned copies this server process made (pinTurnFiles), and the data dir they live in. */
export interface TurnPins {
  dataDir: string;
  MCP_DIR: string;
  MCP_SERVER: string;
  /** Stands in for a connected machine's MCP server; see src/machines.ts. */
  MACHINE_MCP_SERVER: string;
  /** Pinned too, so a deploy can't change the rules under a running turn. */
  TRIPWIRE: string;
  LINK_CHECK: string;
  WORDING: string;
  SCHEME_REFS: string;
  TURN_WRAPPER: string;
  /**
   * The Citadel kit (kit/), the plugin every turn of every scheme loads; pinned like the tripwire, so a
   * deploy only reaches turns that start after the restart, and a branch's kit never reaches other schemes.
   */
  KIT: string;
  /** citadel-heavy (tools/), the host-wide slots for heavy builds and test suites (#325), first on every turn's PATH from its pinned bin folder. */
  HEAVY: string;
  /** citadel-codex-review (#330): a read-only Codex review on the person's own login, pinned with its driver like citadel-heavy. */
  CODEX_REVIEW: string;
  /** Codex turns (#337): the shim a turn runs in place of claude when it runs on Codex. */
  CODEX_TURN: string;
}
let pins: TurnPins | null = null;

/**
 * Make this server process's pinned copies under `dataDir`/run/mcp-<pid>, sweeping the folders of
 * processes that are gone. server.ts calls it once at start, before the Runner is built; importing
 * this module writes nothing.
 */
export function pinTurnFiles(dataDir: string): TurnPins {
  const RUN_DIR = join(dataDir, 'run');
  const MCP_DIR = join(RUN_DIR, `mcp-${process.pid}`);
  mkdirSync(RUN_DIR, { recursive: true });
  for (const name of readdirSync(RUN_DIR)) {
    const pid = Number(/^mcp-(\d+)$/.exec(name)?.[1]);
    if (pid && pid !== process.pid && !alive(pid)) rmSync(join(RUN_DIR, name), { recursive: true, force: true });
  }
  rmSync(MCP_DIR, { recursive: true, force: true });
  mkdirSync(MCP_DIR);
  process.on('exit', () => rmSync(MCP_DIR, { recursive: true, force: true }));
  /** Copy a server file and, first, every local file it imports, so the copy starts on its own. */
  function pinnedCopy(file: string): string {
    const copy = join(MCP_DIR, file);
    if (existsSync(copy)) return copy;
    const source = readFileSync(join(import.meta.dirname, file), 'utf8');
    for (const [, dep] of source.matchAll(/from '\.\/([^']+)'/g)) pinnedCopy(dep);
    writeFileSync(copy, source);
    return copy;
  }
  const MCP_SERVER = pinnedCopy('mcp.ts');
  const MACHINE_MCP_SERVER = pinnedCopy('machine-mcp.ts');
  const TRIPWIRE = pinnedCopy('tripwire.ts');
  const LINK_CHECK = pinnedCopy('link-check.ts');
  const WORDING = pinnedCopy('wording.ts');
  const SCHEME_REFS = pinnedCopy('scheme-refs.ts');
  const TURN_WRAPPER = pinnedCopy('turn-wrapper.ts');
  const KIT = join(MCP_DIR, 'kit');
  const KIT_SOURCE = join(import.meta.dirname, '..', 'kit');
  if (existsSync(KIT_SOURCE)) cpSync(KIT_SOURCE, KIT, { recursive: true });
  const HEAVY = join(MCP_DIR, 'bin', 'citadel-heavy');
  const HEAVY_SOURCE = join(import.meta.dirname, '..', 'tools', 'citadel-heavy');
  if (existsSync(HEAVY_SOURCE)) cpSync(HEAVY_SOURCE, HEAVY);
  // citadel-android, the shared headless emulator (#381), citadel-wait, the one blocking command a turn waits with (#481), and citadel-dev-copy, a dev copy of Citadel from the turn's worktree (#482), on every turn's PATH the same way.
  for (const tool of ['citadel-android', 'citadel-wait', 'citadel-dev-copy']) {
    const source = join(import.meta.dirname, '..', 'tools', tool);
    if (existsSync(source)) cpSync(source, join(MCP_DIR, 'bin', tool));
  }
  // node under another name, so ananicy-cpp's stock `node` rule (SCHED_IDLE) misses the wrapper, claude under it and the MCP servers (#506, deploy/priority.md).
  mkdirSync(join(MCP_DIR, 'bin'), { recursive: true });
  symlinkSync(process.execPath, join(MCP_DIR, 'bin', TURN_NODE));
  const CODEX_REVIEW = pinnedCopy('codex-review.ts');
  const CODEX_TURN = pinnedCopy('codex-turn.ts');
  const CODEX_REVIEW_BIN = join(import.meta.dirname, '..', 'tools', 'citadel-codex-review');
  if (existsSync(CODEX_REVIEW_BIN)) cpSync(CODEX_REVIEW_BIN, join(MCP_DIR, 'bin', 'citadel-codex-review'));
  return (pins = { dataDir, MCP_DIR, MCP_SERVER, MACHINE_MCP_SERVER, TRIPWIRE, LINK_CHECK, WORDING, SCHEME_REFS, TURN_WRAPPER, KIT, HEAVY, CODEX_REVIEW, CODEX_TURN });
}

/** The pinned copies pinTurnFiles made; throws if it was never called, since a turn launched without them would run with no tripwire. */
export function turnPins(): TurnPins {
  if (!pins) throw new Error('The pinned turn files were never made: call pinTurnFiles(dataDir) once at start, before any turn (src/turn-launch.ts)');
  return pins;
}

/** The name a turn's long-lived node processes run under, from a link to node in the turn's pin/bin: anything but `node` (#506). */
export const TURN_NODE = 'citadel-node';

/** A build's default parallelism in turns, so the few heavy jobs at once (citadel-heavy's 2 slots) leave cores for the rest. */
export const TURN_BUILD_JOBS = '4';
/** The slice turn units run in; its name puts it under citadel.slice, which deploy/citadel.slice caps. */
export const TURN_SLICE = 'citadel-turns.slice';

/** The tripwire's view of this server, for a turn in this project; `ask` when the turn can show approval cards. */
export function tripwireConfig(projectId: number, claudeConfig: string, ask: boolean): TripwireConfig {
  return { home: homedir(), data: turnPins().dataDir, checkout: CHECKOUT, project: projectId, claudeConfig, ask };
}

/**
 * The PreToolUse hook every turn gets (src/tripwire.ts): it stops known accidents such as writes to
 * this server's data and checkout, and in a minion's turn sends the ones a person may allow to a card.
 * Its config travels as one JSON argument; no quoting needed, as these paths and JSON carry no single quotes.
 */
export function tripwireHooks(projectId: number, claudeConfig: string, ask = false, script = turnPins().TRIPWIRE) {
  const config = tripwireConfig(projectId, claudeConfig, ask);
  const command = [process.execPath, script, JSON.stringify(config)].map((s) => `'${s}'`).join(' ');
  return { PreToolUse: [{ matcher: '^(Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|Skill)$', hooks: [{ type: 'command', command, timeout: 10 }] }] };
}

/**
 * The Stop hook every turn gets (src/link-check.ts): it sends a reply back once if a file it links
 * wouldn't open in the chat. `roots` are the folders the server shows the turn's files from
 * (ticketRoots in routes/files.ts), its working directory first. `nudged` is a file in the turn's
 * folder the check leaves once it has sent the reply back. `refs` is the scheme-refs snapshot (writeSchemeRefs).
 */
export function linkCheckHooks(roots: string[], script = turnPins().LINK_CHECK, nudged?: string, refs?: string) {
  const command = [process.execPath, script, JSON.stringify({ cwd: roots[0], roots, ...(nudged ? { nudged } : {}), ...(refs ? { refs } : {}) })].map((s) => `'${s}'`).join(' ');
  return { Stop: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] };
}

/** The tools whose text the wording check reads before it goes out: messages, cards, notes and file writes. */
export const WORDING_MATCHER = '^(mcp__(thread|coordinator)__(message_coordinator|message_taskmaster|message_ticket|ask_question|propose_plan|update_ticket)|Write|Edit|MultiEdit)$';

/**
 * The PreToolUse hook every turn gets (src/wording.ts): it refuses once a message, card, note or a
 * .md or .html file written into `shared` that uses a reserved word ("fold") in another sense. `shared`
 * is the scheme's shared folder and the minion's own, since people read the files in both. `sent` is a file in the turn's folder listing the sentences already refused.
 */
export function wordingHooks(shared: string[], sent: string, script = turnPins().WORDING) {
  const command = [process.execPath, script, JSON.stringify({ shared, sent })].map((s) => `'${s}'`).join(' ');
  return { matcher: WORDING_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] };
}

/**
 * The PreToolUse hook every turn gets (src/scheme-refs.ts): it refuses once a message or card shown in
 * this scheme whose bare #N likely means another scheme's minion. `refs` is the snapshot (writeSchemeRefs),
 * `sent` a file in the turn's folder listing the numbers already refused.
 */
export function schemeRefsHooks(refs: string, sent: string, script = turnPins().SCHEME_REFS) {
  const command = [process.execPath, script, JSON.stringify({ refs, sent })].map((s) => `'${s}'`).join(' ');
  return { matcher: SCHEME_REFS_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] };
}

/**
 * The parts of this server's environment a turn inherits. Anything else (MACHINES_URL, PORT, HOST,
 * COORDINATOR_PASSWORD, SESSION_SECRET, the D-Bus address) belongs to the live service, not to minions.
 * XDG_RUNTIME_DIR stays so tools/deploy.sh can reach the user bus (systemctl --user, systemd-run); the
 * COORDINATOR_* values it posts with are the runner's per-turn ones (src/runner.ts).
 */
const ENV_NAMES = new Set([
  'HOME', 'PATH', 'LANG', 'TERM', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TZ', 'SSH_AUTH_SOCK', 'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS',
  'DOTNET_ROOT', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'GODOT',
]);
// LC_* is the locale; CLAUDE_* and ANTHROPIC_* configure Claude Code itself (its config dir, its login).
const ENV_PREFIXES = ['LC_', 'CLAUDE_', 'ANTHROPIC_'];
export function turnEnv(from: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) {
    if (v !== undefined && (ENV_NAMES.has(k) || ENV_PREFIXES.some((p) => k.startsWith(p)))) env[k] = v;
  }
  return env;
}
/**
 * Built-in tools no turn calls, kept out of the context every API call re-reads (#138, ~3.7k tokens):
 * Citadel schedules its own work, so /loop's wakeups, cron and remote triggers go. Workflow (~2k tokens)
 * goes too, except for a minion opted in with its `workflow` switch (#359; disallowedTools).
 */
export const UNUSED_TOOLS = ['Workflow', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger'];
/** The built-in tools a turn leaves out: AskUserQuestion can't be answered headless (ask_question shows a card instead). */
export function disallowedTools(ticket: Pick<Ticket, 'kind' | 'workflow'>): string[] {
  const optedIn = ticket.kind !== 'coordinator' && !!ticket.workflow;
  return ['AskUserQuestion', ...UNUSED_TOOLS.filter((t) => !(optedIn && t === 'Workflow'))];
}
/**
 * The account's claude.ai skill packs (docx, pptx, browsers, morning brief…) and connectors (Claude Docs)
 * stay out of turns too (#138, ~3.3k tokens, ~1.8k more once the connector attaches mid-turn). In
 * --settings both apply to that one invocation only.
 */
export const LEAN_CONTEXT = { syncClaudeAiSkills: false, disableClaudeAiConnectors: true };
/**
 * Claude Code settings every turn of every scheme gets, whatever the repo's own .claude/settings.json
 * says (Taskmasters' folders have none): where a turn compacts, in tokens, and how much of a Bash
 * command's output it keeps.
 */
export const TURN_SETTINGS = { autoCompactWindow: 250_000, bashOutputMaxChars: 12_000 };
/** A Taskmaster's compact window (#423): a backstop, as it hands off past FRESH_CONTEXT_TOKENS anyway. */
export const TASKMASTER_COMPACT_WINDOW = 180_000;
/**
 * Read rules every turn gets, so the Read, Grep and Glob tools can't open a login or a transcript
 * (#185): the Claude login, SSH keys, the service's env file, the GitHub login, a runner's sign-in,
 * state.db with its backups (every minion's session) and the push key (vapid.json, #483). Claude Code enforces these, unlike the
 * tripwire's pattern match; Bash is the tripwire's.
 */
export function credentialDenies(home: string, claudeConfig: string, dataDir: string): string[] {
  // Files only: a folder-wide Read(…/**) rule makes Claude Code refuse any Bash read after a cd it can't
  // resolve (#485). The tripwire guards ~/.ssh, ~/.config/claude-coordinator, ~/.config/citadel-claude and
  // podman's storage and socket (#213) for every tool. If Claude Code's sandbox is ever turned on for
  // turns, those folders go in its filesystem denyRead list.
  const files = [join(home, '.claude/.credentials.json'), join(claudeConfig, '.credentials.json'), join(home, '.config/gh/hosts.yml'),
    join(dataDir, 'state.db*'), join(dataDir, 'backups/state-*'), join(dataDir, 'vapid.json')];
  // `//` makes the path absolute.
  return [...new Set(files)].map((f) => `Read(/${f})`);
}
/** Merging a pull request through a GitHub MCP server waits for a person, in every scheme's minions. */
export const MERGE_ASKS = ['mcp__*__merge_pull_request', 'mcp__*__enable_pr_auto_merge'];

/** Claude Code's words when a turn hits the plan's usage limit: "You've hit your 5-hour limit · resets 3:30pm (…)". */
export const USAGE_LIMIT = /hit your [\w -]*limit/i;

// Read-only git subcommands the coordinator may run with `git -C <dir>` in the repo and ticket worktrees.
// Branch listing is matched exactly, since `branch -v -D x` would delete.
const READ_ONLY_GIT = [
  ...['log', 'show', 'status', 'diff', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'merge-base', 'cat-file', 'describe', 'for-each-ref', 'shortlog', 'worktree list'].map((c) => `${c}:*`),
  ...['branch', 'branch -a', 'branch -r', 'branch -v', 'branch -vv', 'branch -av', 'branch --list', 'branch -a -vv', 'branch --show-current', 'remote', 'remote -v'],
];
/**
 * Fetches a Taskmaster may run in its scheme's repo and worktrees (#621), exact: they only move remote-tracking refs.
 * Any other form could name a refspec that moves a local branch (`origin main:main`) or a command (--upload-pack).
 * Not in the live checkout, which only deploy.sh changes.
 */
const GIT_FETCH = ['fetch', 'fetch -q', 'fetch origin', 'fetch -q origin', 'fetch --all', 'fetch --prune', 'fetch origin --prune'];

/**
 * Shell commands a Taskmaster may run on any path (#483): they read and print. The tripwire still
 * refuses a secret path, a process's environment, state.db opened writable and the credentials table.
 * sqlite3 only with -readonly and -safe: -safe refuses .shell, .output, .backup, ATTACH, VACUUM INTO
 * and writefile(). curl only as the exact health check: a deny list never caught up with its ways to
 * write or reach elsewhere (--expand-output, -w %output{}, a second URL; #483 review).
 */
const READ_ONLY_COMMANDS = [
  ...['grep', 'ls', 'find', 'cat', 'head', 'tail', 'wc', 'stat', 'sort', 'uniq', 'cut', 'echo', 'uptime', 'free', 'df', 'du', 'ps', 'journalctl --user',
    'ss -ltn', 'ss -tln', 'ss -lnt', 'ss -ltnp', 'ss -tlnp', 'ss -lntp',
    'systemctl --user status', 'systemctl --user is-active', 'systemctl --user show', 'systemctl --user list-units', 'systemctl --user list-timers',
    'sqlite3 -readonly -safe', 'sqlite3 -safe -readonly',
    'gh pr view', 'gh pr list', 'gh pr checks', 'gh pr diff', 'gh pr status', 'gh run list', 'gh run view', 'gh issue view', 'gh issue list', 'gh api',
    // #621: more reads a Taskmaster reached for. Not sed or file: a writing flag bundled anywhere (-nsi, -bC) passes any rule.
    'gh repo view', 'gh release list', 'gh release view', 'gh workflow list', 'gh workflow view', 'gh label list',
  ].map((c) => `Bash(${c}:*)`),
  ...['-s', '-sS', '-s -m 5'].flatMap((f) => ['127.0.0.1', 'localhost'].map((host) => `Bash(curl ${f} http://${host}:8573/api/health)`)),
];
/**
 * The ways those commands write, run something else or reach further, denied (deny wins over allow).
 * Each flag has a space before it, so a path like /some-dir isn't caught by -d, and comes in two
 * rules, since `cmd * -X*` needs a word between (tried in real runs). Long flags are cut to their
 * shortest unique start, since sort and journalctl take `--co` for --compress-program.
 * shortcut: a short flag bundled after another (`sort -uo x`) still matches; the tripwire's sort
 * check refuses this server's paths, and that's fine for accidents.
 */
const READ_ONLY_EXCEPTIONS = [
  ['find', '-delete', '-exec', '-ok', '-fprint', '-fls'], ['sort', '-o', '--o', '--co'], ['ss', '-D', '--d', '-K', '--k'],
  ['journalctl', '--vac', '--rot', '--fl', '--syn', '--rel', '--sm', '--se', '--up', '--cursor-f'],
  ['sqlite3', '-nonce', '--nonce', '-unsafe', '--unsafe'],
  ['gh api', '-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'],
  // A file it saves, or a browser it opens.
  ['gh release view', '-w', '--w'], ['gh repo view', '-w', '--w'], ['gh workflow view', '-w', '--w'],
].flatMap(([cmd, ...flags]) => flags.flatMap((f) => [`Bash(${cmd} ${f}*)`, `Bash(${cmd} * ${f}*)`]))
  // uniq's second operand is a file it writes.
  .concat('Bash(uniq * *)');
/** Box-health files a Taskmaster may Read beside its read folders. */
const HEALTH_FILES = ['/proc/loadavg', '/proc/meminfo', '/proc/uptime', '/proc/pressure/**'];

/**
 * How the coordinator may look at the project's code: its main checkout and every ticket folder,
 * readable but not writable. Bash runs only read-only commands (READ_ONLY_COMMANDS), on those folders,
 * readDirs and the box-health files: Claude Code still refuses a read command's path outside them.
 * `git -C <dir> <read-only command>` is allowed per folder; each rule pins the exact folder as a prefix,
 * since `*` in a rule would also match `git -C x commit -m "fix log"`. Anything else that would ask
 * for approval is denied (test/coordinator-access.test.ts replays the calls that used to be).
 * Two more folders are added with no deny rule: the project's shared folder, which acceptEdits then
 * lets the coordinator write, and the repo's Claude Code memory. Claude Code treats files under its
 * config dir as sensitive, so neither allow rules nor a hook's allow let it write there (tried with
 * real runs); making that folder its auto-memory does, so its memory is the one minions load too.
 */
export function coordinatorAccess(repoDir: string | null, ticketsDir: string, sharedDir: string | null = null, memoryDir: string | null = null, liveDir: string | null = null, readDirs: string[] = []): { addDirs: string[]; settings: { permissions: { deny: string[]; allow: string[] }; autoMemoryDirectory?: string } } {
  const subdirs = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name));
    } catch {
      return []; // No tickets yet.
    }
  };
  const roots = [repoDir, ticketsDir, liveDir].filter((d): d is string => !!d);
  const gitDirs = [repoDir, ...(repoDir ? subdirs(ticketsDir) : []), liveDir].filter((d): d is string => !!d);
  const writable = [sharedDir, memoryDir].filter((d): d is string => !!d);
  return {
    // Adding the parent tickets/ folder also covers worktrees made after the turn starts.
    addDirs: [...roots, ...writable],
    settings: {
      permissions: {
        // `//` makes the path absolute. Edit rules also cover Write, NotebookEdit and Bash commands that write there.
        deny: [...roots.map((d) => `Edit(/${d}/**)`), 'Bash(git * --output*)', ...READ_ONLY_EXCEPTIONS],
        // The web tools ask by default, and nobody can answer a Taskmaster's prompts, so they were denied (#210).
        // readDirs (the live data folder, mise's installs) are readable but not added, so acceptEdits can't write there.
        allow: ['WebSearch', 'WebFetch', ...[...readDirs.map((d) => `${d}/**`), ...HEALTH_FILES].map((p) => `Read(/${p})`), ...READ_ONLY_COMMANDS,
          ...gitDirs.flatMap((d) => READ_ONLY_GIT.map((c) => `Bash(git -C ${d} ${c})`)),
          ...gitDirs.filter((d) => d !== liveDir).flatMap((d) => GIT_FETCH.map((c) => `Bash(git -C ${d} ${c})`))],
      },
      ...(memoryDir ? { autoMemoryDirectory: memoryDir } : {}),
    },
  };
}

/**
 * Model and effort for a ticket's turns: its own choice (composer or update_ticket) first, then the
 * Taskmaster pin (opus at high, so a change in Claude Code's defaults never moves it), then the
 * scheme's default effort. Null leaves it to Claude Code.
 */
export function turnSettings(ticket: Pick<Ticket, 'kind' | 'model' | 'effort'>, project: Pick<Project, 'default_effort'>) {
  const taskmaster = ticket.kind === 'coordinator';
  return {
    model: ticket.model ?? (taskmaster ? 'opus' : null),
    effort: ticket.effort ?? (taskmaster ? 'high' : project.default_effort || null),
  };
}

/** What the runner knows about one turn before it starts: everything its launch is built from. The runner chooses these (whose login, Codex or Claude, which machines); launchPlan only reflects them. */
export interface TurnFacts {
  project: Project;
  ticket: Ticket;
  /** The turn's folder. Its `pin` folder holds the turn's own copy of the pinned files, made before the plan. */
  dir: string;
  pins: TurnPins;
  /** Where it runs: the host, or a person's container (for a Codex turn, their Codex container). */
  place: TurnPlace;
  /** The folders it may use; null where there is none. `data` is the folder the database is in. */
  folders: { files: string | null; shared: string | null; memory: string | null; tmp: string | null; tickets: string; data: string };
  /** The machines lending it their tools. */
  machines: TurnMachine[];
  model: string | null;
  effort: string | null;
  /** Set when it runs on Codex: the thread it resumes, or null for a new one. */
  codex: { thread: string | null } | null;
  /** The container a host turn's Codex reviews run in (#398). */
  codexReview: { container: string; turnsDir: string; env: Record<string, string> } | null;
  /** Its environment's sources: the server's own (filtered by turnEnv), how its MCP server reaches the API, citadel-heavy's, and the person's GitHub login. */
  env: { server: NodeJS.ProcessEnv; coordinator: Record<string, string>; heavy: Record<string, string>; github: Record<string, string> | null };
  /** It is in the scheme whose code this server runs, so deploys mean something. */
  deploys: boolean;
  /** Its scheme has semantic memory. */
  memory: boolean;
  /** The one person whose own typed message it answers (#295). */
  typer: { id: number; login: string } | null;
  /** The contraptions its scheme is home to (#266). */
  homeContraptions: string[];
  claudeBin: string;
  /** The systemd unit it runs in, or null for a plain child (and in a container). */
  unit: string | null;
}

/** A turn's launch as plain data: nothing here is written or started. The runner writes `files` into the turn's folder, puts command, args and env in its spec.json and spawns the wrapper as `spawn` says. */
export interface LaunchPlan {
  command: string;
  /** Without `--resume`: the runner adds it last, once it has put the session back under `configDir`. */
  args: string[];
  env: Record<string, string>;
  /** Where this turn's Claude keeps its sessions. */
  configDir: string;
  /** Files for the turn's folder, in the order to write them. */
  files: { name: string; text: string; mode?: number }[];
  spawn: { how: 'container'; wrapper: string[] } | { how: 'unit'; systemdRun: string[]; wrapper: string[] } | { how: 'child'; wrapper: string[] };
}

/** What a turn is launched with, from its facts. It writes nothing and reads no store. From disk it only looks: is the kit in the turn's pin folder, a Taskmaster's minion folders (coordinatorAccess), this machine's Android toolchain (androidEnv) and, for a container turn, where claude is (resolveClaude, which throws when it isn't on the server's PATH). */
export function launchPlan(facts: TurnFacts): LaunchPlan {
  const { project, ticket, dir, pins, place, machines, model, effort, codex } = facts;
  const { files: filesDir, shared: sharedDir, memory: memoryDir, tmp } = facts.folders;
  const pin = join(dir, 'pin');
  const pinned = (file: string) => join(pin, basename(file));
  const node = join(pin, 'bin', TURN_NODE);
  // Tool calls matching the merge asks or the project's approval rules wait for a person (threads only:
  // a Taskmaster can't show cards, so an ask would be a silent deny there).
  const rules = ticket.kind === 'coordinator' ? [] : [...new Set([...MERGE_ASKS, ...lines(project.approval_rules)])];
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--permission-mode', ticket.permission_mode,
    '--append-system-prompt-file', join(dir, 'system-prompt.md'),
    // Claude Code otherwise replays a session's first system prompt on every resume, so saved instructions,
    // lent machines or a build never reached a running minion (#618). Unchanged text still reads from cache.
    '--system-prompt-snapshot', 'off',
    // A minion's tripwire asks and approval rules become Approve / Deny cards; nobody can answer a
    // Taskmaster's prompts, so those are denied instead of waiting.
    ...permissionArgs(ticket.kind !== 'coordinator'),
  ];
  // Lets edit-only sessions write there too, not just in their working directory. The temp folder too:
  // Claude Code asks before `cd <dir> && rm <glob>` outside the working directories, even in bypassPermissions.
  const addDirs = [filesDir, sharedDir, tmp].filter((d): d is string => !!d);
  // One --settings per turn: the tripwire hook and the shared settings, plus approval rules or the Taskmaster's access rules.
  const deny = credentialDenies(homedir(), claudeConfigDir(facts.env.server), facts.folders.data);
  // The link check reads the reply against the folders the chat serves this turn's files from (ticketRoots).
  // A file, not an argument: a scheme's minion list outgrows a command line.
  const refsFile = join(dir, 'scheme-refs.json');
  const linkCheck = ticket.cwd ? linkCheckHooks([ticket.cwd, filesDir, sharedDir].filter((d): d is string => !!d), pinned(pins.LINK_CHECK), join(dir, 'link-check-nudged'), refsFile) : {};
  // The coordinator gets tools to manage the project's tickets; a ticket gets one to set its own
  // title, state and note. The token travels in the environment (which the MCP server
  // inherits), never on the command line.
  const role = ticket.kind === 'coordinator' ? 'coordinator' : 'thread';
  // A card can wait for days: past MCP_TOOL_TIMEOUT, Claude Code also drops a tool silent for 30 minutes unless its server sets a timeout.
  const servers: Record<string, object> = { [role]: { type: 'stdio', command: node, args: [pinned(pins.MCP_SERVER)], ...(role === 'thread' ? { timeout: APPROVAL_TIMEOUT_MS } : {}) } };
  for (const m of machines) {
    for (const s of machineServers(m)) servers[s.name] = { type: 'stdio', command: node, args: [pinned(pins.MACHINE_MCP_SERVER), String(m.id), s.name, s.server] };
  }
  const files: LaunchPlan['files'] = [];
  // Files, like the prompt: machine names (perigee-godot) in claude's argv would let a turn's `pkill -f godot` hit claude.
  files.push({ name: 'mcp.json', text: JSON.stringify({ mcpServers: servers }) });
  const tripwire = tripwireHooks(project.id, claudeConfigDir(facts.env.server), ticket.kind !== 'coordinator', pinned(pins.TRIPWIRE));
  // Codex's managed hook (deploy/claude-container/codex) reads the turn's tripwire from this file: its command can't carry it.
  // A Codex turn's own run is checked in turn mode: its patches and MCP calls too, with no cards, and never its own folder.
  // A host turn has no hook, so the server login's Codex reviews run in its Codex container (#398): named here, where
  // the turn can't change it.
  const container = facts.codexReview ? { container: { name: facts.codexReview.container, turnsDir: facts.codexReview.turnsDir, env: facts.codexReview.env } } : {};
  const codexTripwire = join(dir, 'codex-tripwire.json');
  files.push({ name: 'codex-tripwire.json', text: JSON.stringify({ script: pinned(pins.TRIPWIRE), config: { ...tripwireConfig(project.id, claudeConfigDir(facts.env.server), false), ...(codex ? { turnDir: dir } : {}) }, ...(codex ? { mode: 'turn', mcp: Object.keys(servers), rules } : {}), ...container }), mode: 0o444 });
  const settings: { permissions: { deny: string[]; ask?: string[]; allow?: string[] }; autoMemoryDirectory?: string; hooks: object } & typeof LEAN_CONTEXT & typeof TURN_SETTINGS = {
    hooks: { ...linkCheck, PreToolUse: [...tripwire.PreToolUse, wordingHooks([filesDir, sharedDir].filter((d): d is string => !!d), join(dir, 'wording-sent'), pinned(pins.WORDING)), schemeRefsHooks(refsFile, join(dir, 'scheme-refs-sent'), pinned(pins.SCHEME_REFS))] }, ...LEAN_CONTEXT, ...TURN_SETTINGS, permissions: { deny },
  };
  if (rules.length) settings.permissions.ask = rules;
  if (ticket.kind === 'coordinator') {
    const access = coordinatorAccess(project.repo_dir, facts.folders.tickets, sharedDir, memoryDir, project.id === GLOBAL_OWNER ? CHECKOUT : null, [facts.folders.data, join(homedir(), '.local/share/mise/installs')]);
    addDirs.push(...access.addDirs.filter((d) => !addDirs.includes(d)));
    const { permissions, ...rest } = access.settings;
    Object.assign(settings, rest);
    settings.permissions = { ...permissions, deny: [...permissions.deny, ...deny] };
    settings.autoCompactWindow = TASKMASTER_COMPACT_WINDOW;
  }
  settings.permissions.allow = [...(settings.permissions.allow ?? []), ...Object.keys(servers).map((name) => `mcp__${name}`)];
  // As a file: the Taskmaster's git rules (one per worktree) outgrew Linux's 128 KiB cap on one argument (E2BIG).
  files.push({ name: 'settings.json', text: JSON.stringify(settings) });
  args.push('--settings', join(dir, 'settings.json'));
  if (addDirs.length) args.push('--add-dir', ...addDirs);
  if (existsSync(pinned(pins.KIT))) args.push('--plugin-dir', pinned(pins.KIT));
  args.push(...pluginDirArgs(turnPluginDirs(project, ticket), ticket.cwd));
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  // The task-list tools (TaskCreate/TaskUpdate) are off by default in headless mode; they drive the progress readout.
  let env: Record<string, string> = { ...turnEnv(facts.env.server), CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' };
  // Its own temp folder on disk, cleared on dismissal (#218). CLAUDE_CODE_TMPDIR moves Claude Code's
  // /tmp/claude-<uid>, which ignores TMPDIR. A command or script that sets its own TMPDIR still wins.
  if (tmp) env = { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CLAUDE_CODE_TMPDIR: tmp };
  args.push('--mcp-config', join(dir, 'mcp.json'), '--disallowedTools', ...disallowedTools(ticket));
  env = { ...env, ...facts.env.coordinator, COORDINATOR_ROLE: role, COORDINATOR_TICKET: String(ticket.id) };
  // In a container, claude signs in with the person's own login, so nothing of the server's may win over it.
  if (!place.host) {
    for (const v of AUTH_VARS) delete env[v];
    env = { ...env, ...place.env, COORDINATOR_CONTAINER: '1' };
    // The host's /run/user/<uid> isn't in the container, and .NET keeps named mutexes under
    // XDG_RUNTIME_DIR: without it every one fails, NuGet's restore included (#225).
    if (tmp) env.XDG_RUNTIME_DIR = tmp;
  }
  env = { ...env, ...androidEnv(homedir(), env.PATH) };
  env = { ...env, ...facts.env.heavy, PATH: [join(pin, 'bin'), env.PATH].filter(Boolean).join(':') };
  // For plugins and hooks: the folders the prompt names (Delve's mod writes its retro log there).
  if (sharedDir) env.COORDINATOR_SHARED_DIR = sharedDir;
  if (filesDir) env.COORDINATOR_FILES_DIR = filesDir;
  env.CITADEL_CODEX_TRIPWIRE = codexTripwire;
  // The thread's MCP server offers the approval tool, which holds its call open until someone clicks.
  if (ticket.kind !== 'coordinator') env = { ...env, COORDINATOR_APPROVALS: '1', MCP_TOOL_TIMEOUT: String(APPROVAL_TIMEOUT_MS) };
  if (facts.deploys) env.COORDINATOR_DEPLOYS = '1';
  if (facts.memory) env.COORDINATOR_MEMORY = '1';
  // The person's own GitHub token (or none, so it can't push).
  if (facts.env.github) env = { ...env, ...facts.env.github };
  // Whose data this turn may read (#295): the person whose own typed message it answers, as the identity's
  // `sub`, for contraptions' own hook guards. Set fresh per process and absent (never empty) on any other turn:
  // a relay, a wake, a schedule, a resume, GitHub or a contraption's post. turnEnv never passes CITADEL_*
  // through, and a steer can't change a running process's env, so it stays narrower than typedBy, never wider.
  if (facts.typer) Object.assign(env, { CITADEL_PERSON_ID: String(facts.typer.id), CITADEL_PERSON_LOGIN: facts.typer.login });
  // Only the Citadel scheme's Taskmaster is offered the app instruction and contraption tools (the API checks too).
  if (ticket.kind === 'coordinator' && project.id === GLOBAL_OWNER) env.COORDINATOR_APP_INSTRUCTIONS = '1';
  // A contraption's home scheme may deploy it (#266): its Taskmaster and minions are offered deploy_contraption for it.
  if (facts.homeContraptions.length) env.COORDINATOR_HOME_CONTRAPTIONS = facts.homeContraptions.join(',');
  // A minion may propose new notes for the machines its turn got (#617).
  if (ticket.kind !== 'coordinator' && machines.length) env.COORDINATOR_MACHINES = machines.map((m) => m.name).join(',');
  const configDir = place.host ? claudeConfigDir(env) : place.configDir;
  let command = place.host ? facts.claudeBin : resolveClaude(facts.claudeBin);
  if (codex) {
    // The shim runs in claude's place (src/codex-turn.ts), from the hand-over the runner writes; it skips that when it resumes the thread.
    command = node;
    args.unshift(pinned(pins.CODEX_TURN), '--codex-mode', 'turn', '--codex-log', join(dir, 'codex-log.jsonl'), '--codex-handover', join(dir, 'handover.md'), ...(codex.thread ? ['--codex-thread', codex.thread] : []));
  }
  const wrapper = [node, pinned(pins.TURN_WRAPPER), dir];
  const spawn: LaunchPlan['spawn'] = !place.host ? { how: 'container', wrapper }
    : facts.unit ? { how: 'unit', systemdRun: ['--user', '--collect', '--quiet', `--unit=${facts.unit}`, `--slice=${TURN_SLICE}`, '-p', 'TimeoutStopSec=15', '-p', 'UMask=0077', ...wrapper], wrapper }
    : { how: 'child', wrapper };
  return { command, args, env, configDir, files, spawn };
}
