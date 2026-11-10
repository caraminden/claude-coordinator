// What a turn is launched with: the pinned copies of the server files it runs, its hooks, settings,
// environment and tool lists. The runner (src/runner.ts) and contraption turns (src/contraption-turns.ts)
// both build their launches from these.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Project, Ticket } from './db.ts';
import type { TripwireConfig } from './tripwire.ts';
import { SCHEME_REFS_MATCHER } from './scheme-refs.ts';
import { CHECKOUT } from './prompts.ts';

// Turns run a copy of the MCP server taken when this server started, not the file on disk: a deploy
// pulls new code before the restart, and a newer MCP server would offer tools this process rejects.
// The copies live in the app's data dir, one folder per server process, swept once that process is gone.
const DATA_DIR = process.env.DATA_DIR ?? join(homedir(), '.local/share/claude-coordinator');
const RUN_DIR = join(DATA_DIR, 'run');
export const MCP_DIR = join(RUN_DIR, `mcp-${process.pid}`);
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}
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
export const MCP_SERVER = pinnedCopy('mcp.ts');
// Stands in for a connected machine's MCP server; see src/machines.ts.
export const MACHINE_MCP_SERVER = pinnedCopy('machine-mcp.ts');
// Pinned too, so a deploy can't change the rules under a running turn.
export const TRIPWIRE = pinnedCopy('tripwire.ts');
export const LINK_CHECK = pinnedCopy('link-check.ts');
export const WORDING = pinnedCopy('wording.ts');
export const SCHEME_REFS = pinnedCopy('scheme-refs.ts');
export const TURN_WRAPPER = pinnedCopy('turn-wrapper.ts');
/**
 * The Citadel kit (kit/), the plugin every turn of every scheme loads; pinned like the tripwire, so a
 * deploy only reaches turns that start after the restart, and a branch's kit never reaches other schemes.
 */
export const KIT = join(MCP_DIR, 'kit');
const KIT_SOURCE = join(import.meta.dirname, '..', 'kit');
if (existsSync(KIT_SOURCE)) cpSync(KIT_SOURCE, KIT, { recursive: true });
/** citadel-heavy (tools/), the host-wide slots for heavy builds and test suites (#325), first on every turn's PATH from its pinned bin folder. */
export const HEAVY = join(MCP_DIR, 'bin', 'citadel-heavy');
const HEAVY_SOURCE = join(import.meta.dirname, '..', 'tools', 'citadel-heavy');
if (existsSync(HEAVY_SOURCE)) cpSync(HEAVY_SOURCE, HEAVY);
/** citadel-android (tools/), the shared headless emulator (#381), on every turn's PATH the same way. */
const ANDROID_SOURCE = join(import.meta.dirname, '..', 'tools', 'citadel-android');
if (existsSync(ANDROID_SOURCE)) cpSync(ANDROID_SOURCE, join(MCP_DIR, 'bin', 'citadel-android'));
/** citadel-codex-review (#330): a read-only Codex review on the person's own login, pinned with its driver like citadel-heavy. */
export const CODEX_REVIEW = pinnedCopy('codex-review.ts');
/** Codex turns (#337): the shim a turn runs in place of claude when it runs on Codex. */
export const CODEX_TURN = pinnedCopy('codex-turn.ts');
const CODEX_REVIEW_BIN = join(import.meta.dirname, '..', 'tools', 'citadel-codex-review');
if (existsSync(CODEX_REVIEW_BIN)) cpSync(CODEX_REVIEW_BIN, join(MCP_DIR, 'bin', 'citadel-codex-review'));
/** A build's default parallelism in turns, so the few heavy jobs at once (citadel-heavy's 2 slots) leave cores for the rest. */
export const TURN_BUILD_JOBS = '4';
/** The slice turn units run in; its name puts it under citadel.slice, which deploy/citadel.slice caps. */
export const TURN_SLICE = 'citadel-turns.slice';

/** The tripwire's view of this server, for a turn in this project; `ask` when the turn can show approval cards. */
export function tripwireConfig(projectId: number, claudeConfig: string, ask: boolean): TripwireConfig {
  return { home: homedir(), data: DATA_DIR, checkout: CHECKOUT, project: projectId, claudeConfig, ask };
}

/**
 * The PreToolUse hook every turn gets (src/tripwire.ts): it stops known accidents such as writes to
 * this server's data and checkout, and in a minion's turn sends the ones a person may allow to a card.
 * Its config travels as one JSON argument; no quoting needed, as these paths and JSON carry no single quotes.
 */
export function tripwireHooks(projectId: number, claudeConfig: string, ask = false, script = TRIPWIRE) {
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
export function linkCheckHooks(roots: string[], script = LINK_CHECK, nudged?: string, refs?: string) {
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
export function wordingHooks(shared: string[], sent: string, script = WORDING) {
  const command = [process.execPath, script, JSON.stringify({ shared, sent })].map((s) => `'${s}'`).join(' ');
  return { matcher: WORDING_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] };
}

/**
 * The PreToolUse hook every turn gets (src/scheme-refs.ts): it refuses once a message or card shown in
 * this scheme whose bare #N likely means another scheme's minion. `refs` is the snapshot (writeSchemeRefs),
 * `sent` a file in the turn's folder listing the numbers already refused.
 */
export function schemeRefsHooks(refs: string, sent: string, script = SCHEME_REFS) {
  const command = [process.execPath, script, JSON.stringify({ refs, sent })].map((s) => `'${s}'`).join(' ');
  return { matcher: SCHEME_REFS_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] };
}

/**
 * The parts of this server's environment a turn inherits. Anything else (MACHINES_URL, PORT, HOST,
 * COORDINATOR_PASSWORD, SESSION_SECRET, the D-Bus address) belongs to the live service, not to minions.
 * XDG_RUNTIME_DIR stays so tools/deploy.sh can reach the user bus (systemctl --user, systemd-run); the
 * COORDINATOR_* values it posts with are the runner's per-turn ones, set below.
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
 * and state.db with its backups (every minion's session). Claude Code enforces these, unlike the
 * tripwire's pattern match; Bash is the tripwire's.
 */
export function credentialDenies(home: string, claudeConfig: string, dataDir: string, runtimeDir = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 0}`): string[] {
  // podman's storage and socket (#213): every person's Claude container and its sign-in. If Claude
  // Code's sandbox is ever turned on for turns, these same paths go in its filesystem denyRead list.
  const files = [join(home, '.claude/.credentials.json'), join(claudeConfig, '.credentials.json'), join(home, '.ssh/**'), join(home, '.config/claude-coordinator/**'),
    join(home, '.config/gh/hosts.yml'), join(home, '.config/citadel-claude/**'), join(dataDir, 'state.db*'), join(dataDir, 'backups/state-*'),
    join(home, '.local/share/containers/storage/**'), join(runtimeDir, 'podman/**'), join(runtimeDir, 'containers/**')];
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
  ...['log', 'show', 'status', 'diff', 'blame', 'ls-files', 'rev-parse', 'shortlog', 'worktree list'].map((c) => `${c}:*`),
  ...['branch', 'branch -a', 'branch -r', 'branch -v', 'branch -vv', 'branch -av', 'branch --list'],
];

/**
 * How the coordinator may look at the project's code: its main checkout and every ticket folder,
 * readable but not writable. Bash runs only read-only commands there: Claude Code already allows
 * plain reads (grep, cat, ls, find) in added directories, and `git -C <dir> <read-only command>` is
 * allowed per folder. Each rule pins the exact folder as a prefix, since `*` in a rule would also
 * match `git -C x commit -m "fix log"`. Anything else that would ask for approval is denied.
 * Two more folders are added with no deny rule: the project's shared folder, which acceptEdits then
 * lets the coordinator write, and the repo's Claude Code memory. Claude Code treats files under its
 * config dir as sensitive, so neither allow rules nor a hook's allow let it write there (tried with
 * real runs); making that folder its auto-memory does, so its memory is the one minions load too.
 */
export function coordinatorAccess(repoDir: string | null, ticketsDir: string, sharedDir: string | null = null, memoryDir: string | null = null, liveDir: string | null = null): { addDirs: string[]; settings: { permissions: { deny: string[]; allow: string[] }; autoMemoryDirectory?: string } } {
  let ticketDirs: string[] = [];
  try {
    ticketDirs = readdirSync(ticketsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(ticketsDir, d.name));
  } catch {
    // No tickets yet.
  }
  const roots = [repoDir, ticketsDir, liveDir].filter((d): d is string => !!d);
  const gitDirs = [repoDir, ...(repoDir ? ticketDirs : []), liveDir].filter((d): d is string => !!d);
  const writable = [sharedDir, memoryDir].filter((d): d is string => !!d);
  return {
    // Adding the parent tickets/ folder also covers worktrees made after the turn starts.
    addDirs: [...roots, ...writable],
    settings: {
      permissions: {
        // `//` makes the path absolute. Edit rules also cover Write, NotebookEdit and Bash commands that write there.
        deny: [...roots.map((d) => `Edit(/${d}/**)`), 'Bash(git * --output*)'],
        // The web tools ask by default, and nobody can answer a Taskmaster's prompts, so they were denied (#210).
        allow: ['WebSearch', 'WebFetch', ...gitDirs.flatMap((d) => READ_ONLY_GIT.map((c) => `Bash(git -C ${d} ${c})`))],
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
