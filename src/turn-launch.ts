// What a turn is launched with: the pinned copies of the server files it runs, its hooks, settings,
// environment and tool lists. The runner (src/runner.ts) and contraption turns (src/contraption-turns.ts)
// both build their launches from these.
import { LIVE_MANIFEST } from './host-tools.ts';
import { msgEnv, msgSettings } from './msg-settings.ts';
import { chmodSync, cpSync, statSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { PoolSpec } from './pool-client.mjs';
import { linkTree, pinSparesAt, takeSpare } from './pin-spares.ts';
import { thrown } from './thrown.ts';
import { cp, rm } from 'node:fs/promises';
import { APPROVAL_TIMEOUT_MS, lines, permissionArgs, pluginDirArgs, turnPluginDirs } from './approvals.ts';
import { androidEnv, AUTH_VARS, resolveClaude, type TurnPlace } from './claude-link.ts';
import type { Project, Ticket } from './db.ts';
import { GLOBAL_OWNER } from './properties.ts';
import { claudeConfigDir } from './sessions.ts';
import type { TripwireConfig } from './tripwire.ts';
import { COPIES } from './tripwire-base.ts';
import { hookRunMatchers, type HookRunConfig } from './hook-run.ts';
import { SCHEME_REFS_MATCHER, SIDE_GUARD_MATCHER, TRIPWIRE_MATCHER, WORDING_MATCHER } from './hook-matchers.ts';
import { offSkills, skillDenies } from './skills.ts';
import { CHECKOUT, machineServers, type TurnMachine } from './prompts.ts';
import { advisedModel } from '../public/model-table.js';
import { ZONE } from './pacific.ts';
import { thpProps } from './unit-thp.ts';

// Turns run a copy of the MCP server taken when this server started, not the file on disk: a deploy
// pulls new code before the restart, and a newer MCP server would offer tools this process rejects.
// The copies live in the app's data dir, one folder per server process, swept once that process is gone.
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return thrown(err).code === 'EPERM';
  }
}

/** The pinned copies this server process made (pinTurnFiles), and the data dir they live in. */
export interface TurnPins {
  dataDir: string;
  /** Whether this pinned folder has the kit and bin/heavy: a turn's copy has what this has, so launchPlan needn't look on the server's thread (#1808). */
  PIN_HAS: { kit: boolean; heavy: boolean };
  MCP_DIR: string;
  MCP_SERVER: string;
  /** Stands in for a connected machine's MCP server; see src/machines.ts. */
  MACHINE_MCP_SERVER: string;
  /** Pinned too, so a deploy can't change the rules under a running turn. */
  TRIPWIRE: string;
  /** A side question's read-only guard (#932, src/side-guard.ts). */
  SIDE_GUARD: string;
  LINK_CHECK: string;
  WORDING: string;
  SCHEME_REFS: string;
  /** Runs every PreToolUse check above in one node process (#1296, src/hook-run.ts). */
  HOOK_RUN: string;
  TURN_WRAPPER: string;
  /** The shared turn supervisor (#1343, src/turn-supervisor.mjs), and a hash of its code: one runs per turns folder and version. */
  SUPERVISOR: string;
  SUPERVISOR_VERSION: string;
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
  /** The shared tool server (#1259, src/mcp-pool.ts), and a hash of its code: turns of one version share one pool per place. */
  POOL: string;
  POOL_VERSION: string;
}
let pins: TurnPins | null = null;
let repins = 0;
/** Every pin folder this process made: a re-pin keeps the old ones for running turns until exit. */
const pinDirs = new Set<string>();

/**
 * Make this server process's pinned copies under `dataDir`/run/mcp-<pid>, sweeping the folders of
 * processes that are gone. server.ts calls it once at start, before the Runner is built; importing
 * this module writes nothing.
 */
export function pinTurnFiles(dataDir: string): TurnPins {
  // A re-pin (a kit/ or tools/ deploy on SIGHUP, #1416) makes a new folder and keeps the old one till exit: running turns, the supervisor and the pool still use it.
  const gen = pins?.dataDir === dataDir ? ++repins : 0;
  const RUN_DIR = join(dataDir, 'run');
  const MCP_DIR = join(RUN_DIR, gen ? `mcp-${process.pid}.${gen}` : `mcp-${process.pid}`);
  mkdirSync(RUN_DIR, { recursive: true });
  for (const name of readdirSync(RUN_DIR)) {
    const pid = Number(/^mcp-(\d+)(?:\.\d+)?$/.exec(name)?.[1]);
    if (pid && pid !== process.pid && !alive(pid)) rmSync(join(RUN_DIR, name), { recursive: true, force: true });
  }
  rmSync(MCP_DIR, { recursive: true, force: true });
  mkdirSync(MCP_DIR);
  if (!pinDirs.size)
    process.once('exit', () => {
      for (const d of pinDirs) rmSync(d, { recursive: true, force: true });
    });
  pinDirs.add(MCP_DIR);
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
  const SIDE_GUARD = pinnedCopy('side-guard.ts');
  const LINK_CHECK = pinnedCopy('link-check.ts');
  const WORDING = pinnedCopy('wording.ts');
  const SCHEME_REFS = pinnedCopy('scheme-refs.ts');
  const HOOK_RUN = pinnedCopy('hook-run.ts');
  const TURN_WRAPPER = pinnedCopy('turn-wrapper.mjs');
  const POOL = pinnedCopy('mcp-pool.ts');
  /** The pool's code and every local file it imports, so a deploy that changes any of it starts a new pool. */
  const closure = (file: string, seen = new Set<string>()): Set<string> => {
    if (seen.has(file)) return seen;
    seen.add(file);
    for (const [, dep] of readFileSync(join(MCP_DIR, file), 'utf8').matchAll(/from '\.\/([^']+)'/g)) closure(dep, seen);
    return seen;
  };
  /** A hash of `file`'s closure and the slice it runs in, so moving it starts a fresh one there. */
  const version = (file: string): string => {
    const hash = createHash('sha256');
    for (const f of [...closure(file)].sort()) hash.update(`${f}\0`).update(readFileSync(join(MCP_DIR, f)));
    hash.update(`slice\0${TASKMASTER_SLICE}`);
    return hash.digest('hex').slice(0, 16);
  };
  const POOL_VERSION = version('mcp-pool.ts');
  const SUPERVISOR = pinnedCopy('turn-supervisor.mjs');
  const SUPERVISOR_VERSION = version('turn-supervisor.mjs');
  const KIT = join(MCP_DIR, 'kit');
  const KIT_SOURCE = join(import.meta.dirname, '..', 'kit');
  if (existsSync(KIT_SOURCE)) {
    cpSync(KIT_SOURCE, KIT, { recursive: true });
    // The model table beside kit/model-tiers.ts, which citadel:subagents and citadel:briefing run when they load (#1574).
    cpSync(join(import.meta.dirname, '..', 'public', 'model-table.js'), join(KIT, 'model-table.js'));
  }
  const HEAVY = join(MCP_DIR, 'bin', 'citadel-heavy');
  const HEAVY_SOURCE = join(import.meta.dirname, '..', 'tools', 'citadel-heavy');
  if (existsSync(HEAVY_SOURCE)) cpSync(HEAVY_SOURCE, HEAVY);
  // citadel-android, the shared headless emulator (#381), citadel-wait, the one blocking command a turn waits with (#481), citadel-dev-copy, a dev copy of Citadel from the turn's worktree (#482), ci-failures, what failed in a CI run (#644), citadel-test, a few test files with only the failures shown (#641), who-touches, which other worktrees change a path (#1159), who-uses, who imports or calls a file or symbol and which tests reach it (#1781), and stale-docs, which finds dead paths in instruction files and stale shared-folder files (#1164), on every turn's PATH the same way; citadel-android-mic.ts, the emulator's synthetic mic (#843), sits beside citadel-android, which runs it; citadel-build-cache shows and clears the shared build caches (#1153); heavy-ci.ts sits beside citadel-heavy, which sends heavy jobs to the scheme's CI through it (#1160), as mem-room does, which tells it how much memory is free (#1340, #1863); citadel-callgrind counts a program's instructions despite perigee's AVX-512 glibc (#1397).
  for (const tool of ['citadel-android', 'citadel-wait', 'citadel-job', 'citadel-job.ts', 'citadel-job-run.sh', 'citadel-dev-copy', 'ci-failures', 'citadel-test', 'who-touches', 'who-uses', 'stale-docs', 'citadel-android-mic.ts', 'citadel-build-cache', 'heavy-ci.ts', 'mem-room', 'citadel-callgrind']) {
    const source = join(import.meta.dirname, '..', 'tools', tool);
    if (existsSync(source)) cpSync(source, join(MCP_DIR, 'bin', tool));
  }
  // heavy-unit and its shims (#1298): pin/bin/heavy, first on every turn's PATH, sends each heavy command a turn types
  // (or a script it runs calls) to a scope of its own in citadel-heavy.slice, so memory running out stops it, not the turn.
  // claude-pace (#1748): pin/bin/heavy/claude, so a nested `claude` a turn's script starts paces itself on the box's memory.
  for (const tool of ['heavy-unit', 'heavy-shim', 'claude-pace']) {
    const source = join(import.meta.dirname, '..', 'tools', tool);
    if (existsSync(source)) cpSync(source, join(MCP_DIR, 'bin', tool));
  }
  if (existsSync(join(MCP_DIR, 'bin', 'heavy-shim'))) {
    mkdirSync(join(MCP_DIR, 'bin', 'heavy'), { recursive: true });
    // One more link in the same loop: claude goes to the pacer (copied with heavy-shim above), the rest to heavy-shim.
    for (const cmd of [...HEAVY_SHIMS, 'claude']) symlinkSync(cmd === 'claude' ? '../claude-pace' : '../heavy-shim', join(MCP_DIR, 'bin', 'heavy', cmd));
  }
  // node under another name, so ananicy-cpp's stock `node` rule (SCHED_IDLE) misses the wrapper, claude under it and the MCP servers (#506, deploy/priority.md).
  mkdirSync(join(MCP_DIR, 'bin'), { recursive: true });
  symlinkSync(process.execPath, join(MCP_DIR, 'bin', TURN_NODE));
  // citadel-replay (#836): reruns kept app chats; its shim runs the pinned replay.ts beside it.
  pinnedCopy('replay.ts');
  const REPLAY_BIN = join(import.meta.dirname, '..', 'tools', 'citadel-replay');
  if (existsSync(REPLAY_BIN)) cpSync(REPLAY_BIN, join(MCP_DIR, 'bin', 'citadel-replay'));
  // citadel-where (#1122): "show me where" links; its shim runs the pinned show-parts.ts beside it.
  pinnedCopy('show-parts.ts');
  const WHERE_BIN = join(import.meta.dirname, '..', 'tools', 'citadel-where');
  if (existsSync(WHERE_BIN)) cpSync(WHERE_BIN, join(MCP_DIR, 'bin', 'citadel-where'));
  const CODEX_REVIEW = pinnedCopy('codex-review.ts');
  const CODEX_TURN = pinnedCopy('codex-turn.ts');
  const CODEX_REVIEW_BIN = join(import.meta.dirname, '..', 'tools', 'citadel-codex-review');
  if (existsSync(CODEX_REVIEW_BIN)) cpSync(CODEX_REVIEW_BIN, join(MCP_DIR, 'bin', 'citadel-codex-review'));
  // A turn's pin copy is hard links to these files (copyPinned), so they are read-only: a write into a turn's copy must fail, not reach the server's.
  const lock = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) lock(join(d, e.name));
      else if (e.isFile()) chmodSync(join(d, e.name), statSync(join(d, e.name)).mode & ~0o222);
    }
  };
  lock(MCP_DIR);
  // Spare turn copies of these files (src/pin-spares.ts), swept like the copies themselves when their process is gone.
  const SPARES_DIR = join(RUN_DIR, 'turns', '.pin-spares');
  mkdirSync(SPARES_DIR, { recursive: true });
  for (const name of readdirSync(SPARES_DIR)) if (parseInt(name) !== process.pid && !alive(parseInt(name))) rmSync(join(SPARES_DIR, name), { recursive: true, force: true });
  pinSparesAt(join(SPARES_DIR, gen ? `${process.pid}.${gen}` : String(process.pid)), MCP_DIR);
  return (pins = {
    dataDir,
    PIN_HAS: { kit: existsSync(KIT), heavy: existsSync(join(MCP_DIR, 'bin', 'heavy')) },
    MCP_DIR,
    MCP_SERVER,
    MACHINE_MCP_SERVER,
    TRIPWIRE,
    SIDE_GUARD,
    LINK_CHECK,
    WORDING,
    SCHEME_REFS,
    HOOK_RUN,
    TURN_WRAPPER,
    SUPERVISOR,
    SUPERVISOR_VERSION,
    KIT,
    HEAVY,
    CODEX_REVIEW,
    CODEX_TURN,
    POOL,
    POOL_VERSION,
  });
}

/**
 * A turn's own copy of the pinned files: hard links, since copying ~240 files froze the server's loop for up to 7 s
 * under load (#1215, #1125). A restart's sweep of the originals only unlinks a name, so the turn's links stay good. Falls back
 * to a byte copy when links aren't possible (another filesystem). A container's turn gets copies (`link` false): its folder is
 * mounted writable and it runs as the server's user, so it could chmod a link back and change the server's pinned tripwire.
 * A turn of the server's own pins takes a spare made ahead off the loop when one is ready (#1414, src/pin-spares.ts).
 */
export async function copyPinned(src: string, dst: string, link = true): Promise<void> {
  if (await takeSpare(src, dst, link ? 'link' : 'copy')) return;
  // With fs/promises (#1808): a launch makes no blocking file call, even with no spare ready.
  if (link)
    try {
      return await linkTree(src, dst);
    } catch {
      await rm(dst, { recursive: true, force: true });
    }
  await cp(src, dst, { recursive: true, verbatimSymlinks: true });
}

/** The pinned copies pinTurnFiles made; throws if it was never called, since a turn launched without them would run with no tripwire. */
export function turnPins(): TurnPins {
  if (!pins) throw new Error('The pinned turn files were never made: call pinTurnFiles(dataDir) once at start, before any turn (src/turn-launch.ts)');
  return pins;
}

/** The commands a turn's PATH sends through tools/heavy-shim (#1298): builds, test runners, package managers, engines and browsers. */
export const HEAVY_SHIMS = ['cargo', 'gradle', 'tsc', 'vitest', 'jest', 'pytest', 'playwright', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'dotnet', 'go', 'make', 'cmake', 'ninja', 'godot', 'godot4', 'mise', 'chromium', 'chromium-browser', 'chrome', 'google-chrome', 'google-chrome-stable', 'firefox'];

/** The name a turn's long-lived node processes run under, from a link to node in the turn's pin/bin: anything but `node` (#506). */
export const TURN_NODE = 'citadel-node';

/** A build's default parallelism in turns, so the few heavy jobs at once (citadel-heavy's 2 slots) leave cores for the rest. */
export const TURN_BUILD_JOBS = '4';
/** The slice turn units run in; its name puts it under citadel.slice, which deploy/citadel.slice caps. */
export const TURN_SLICE = 'citadel-turns.slice';
/** Host Taskmaster turns and the shared Citadel tools pool they call (#1280): apart from minion turns, so a storm there doesn't stall them. */
export const TASKMASTER_SLICE = 'citadel-taskmasters.slice';

/** The folder beside a turn's pinned scripts that keeps Node's compile cache for its hook starts (hookCommand). */
export const COMPILE_CACHE = '.compile-cache';

/**
 * A hook's shell command: node, the pinned script and its arguments, each quoted, with Node's compile cache in
 * COMPILE_CACHE beside the script (#1296). Node keys the cache by path, so each turn's pin folder warms its own on its
 * first call and it goes with the turn, and a deploy's new copies never read an old one. A warm start costs about a bare
 * node start: the tripwire's 167 ms of CPU fell to 33 on a quiet box.
 */
export function hookCommand(script: string, ...args: string[]): string {
  return [`NODE_COMPILE_CACHE='${join(dirname(script), COMPILE_CACHE)}'`, ...[process.execPath, script, ...args].map((s) => `'${s}'`)].join(' ');
}

/** The tripwire's view of this server, for a turn in this project; `ask` when the turn can show approval cards. */
export function tripwireConfig(projectId: number, claudeConfig: string, ask: boolean, readOnly: string[] = [], envFiles: string[] = []): TripwireConfig {
  return { home: homedir(), data: turnPins().dataDir, checkout: CHECKOUT, project: projectId, claudeConfig, ask, ...(readOnly.length ? { readOnly } : {}), ...(envFiles.length ? { envFiles } : {}) };
}

/**
 * The tripwire as a hook of its own (src/tripwire.ts; every turn runs it inside hookRunHooks, #1296, and the tests
 * hold the runner to this one): it stops known accidents such as writes to
 * this server's data and checkout, and in a minion's turn sends the ones a person may allow to a card.
 * Its config travels as one JSON argument; no quoting needed, as these paths and JSON carry no single quotes.
 */
export function tripwireHooks(projectId: number, claudeConfig: string, ask = false, script = turnPins().TRIPWIRE, readOnly: string[] = [], envFiles: string[] = []) {
  const config = tripwireConfig(projectId, claudeConfig, ask, readOnly, envFiles);
  const command = hookCommand(script, JSON.stringify(config));
  // onFailure: a check that times out (or dies outside tripwire.ts's own fail-open catch) blocks the call; without it Claude Code lets it through.
  return { PreToolUse: [{ matcher: TRIPWIRE_MATCHER, hooks: [{ type: 'command', command, timeout: 10, onFailure: 'block' }] }] };
}

/** The side question's guard as a hook of its own (#932; a fork runs it inside hookRunHooks, #1296): every tool goes through src/side-guard.ts, which refuses writes. */
export function sideGuardHook(script = turnPins().SIDE_GUARD) {
  return { matcher: SIDE_GUARD_MATCHER, hooks: [{ type: 'command', command: hookCommand(script), timeout: 10, onFailure: 'block' }] };
}

/**
 * The Stop hook every turn gets (src/link-check.ts): it sends a reply back once if a file it links
 * wouldn't open in the chat. `roots` are the folders the server shows the turn's files from
 * (ticketRoots in routes/files.ts), its working directory first. `nudged` is a file in the turn's
 * folder the check leaves once it has sent the reply back. `refs` is the scheme-refs snapshot (writeSchemeRefs).
 */
export function linkCheckHooks(roots: string[], script = turnPins().LINK_CHECK, nudged?: string, refs?: string) {
  const command = hookCommand(script, JSON.stringify({ cwd: roots[0], roots, ...(nudged ? { nudged } : {}), ...(refs ? { refs } : {}) }));
  return { Stop: [{ hooks: [{ type: 'command', command, timeout: 10 }] }] };
}

export { WORDING_MATCHER };

/**
 * The wording check as a hook of its own (src/wording.ts; every turn runs it inside hookRunHooks, #1296): it refuses once a message, card, note or a
 * .md or .html file written into `shared` that uses a retired or misused word ("fold", "merge" for main). `shared`
 * is the scheme's shared folder and the minion's own, since people read the files in both. `sent` is a file in the turn's folder listing the sentences already refused.
 */
export function wordingHooks(shared: string[], sent: string, script = turnPins().WORDING) {
  const command = hookCommand(script, JSON.stringify({ shared, sent }));
  return { matcher: WORDING_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] };
}

/**
 * The scheme-refs check as a hook of its own (src/scheme-refs.ts; every turn runs it inside hookRunHooks, #1296): it refuses once a message or card shown in
 * this scheme whose bare #N likely means another scheme's minion. `refs` is the snapshot (writeSchemeRefs),
 * `sent` a file in the turn's folder listing the numbers already refused.
 */
export function schemeRefsHooks(refs: string, sent: string, script = turnPins().SCHEME_REFS) {
  const command = hookCommand(script, JSON.stringify({ refs, sent }));
  return { matcher: SCHEME_REFS_MATCHER, hooks: [{ type: 'command', command, timeout: 10 }] };
}

/**
 * The PreToolUse hooks a turn gets (#1296, src/hook-run.ts): the side question's guard, the tripwire, the wording
 * and scheme-refs checks and, when the turn loads the kit, its big-read guard, in one node process instead of one each.
 * Each check runs only on its own matcher (hook-matchers.ts). The runner is registered on two matchers that never
 * overlap, so a call still starts one process: the tools a hard check reads keep the tripwire's 10 s and
 * `onFailure: 'block'` (#817), and the message and card tools only the soft checks read go through when it fails, as
 * before. `cfg` is each check's own config, as its old hook took it.
 */
export function hookRunHooks(cfg: HookRunConfig, script = turnPins().HOOK_RUN) {
  const { hard, soft } = hookRunMatchers(!!cfg.side);
  const command = hookCommand(script, JSON.stringify(cfg));
  return [{ matcher: hard, hooks: [{ type: 'command', command, timeout: 10, onFailure: 'block' }] }, ...(soft ? [{ matcher: soft, hooks: [{ type: 'command', command, timeout: 10 }] }] : [])];
}

/**
 * The parts of this server's environment a turn inherits. Anything else (MACHINES_URL, PORT, HOST,
 * COORDINATOR_PASSWORD, SESSION_SECRET, the D-Bus address) belongs to the live service, not to minions.
 * XDG_RUNTIME_DIR stays so tools/deploy.sh can reach the user bus (systemctl --user, systemd-run); the
 * COORDINATOR_* values it posts with are the runner's per-turn ones (src/runner.ts).
 */
const ENV_NAMES = new Set([
  'HOME',
  'PATH',
  'LANG',
  'TERM',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'SSH_AUTH_SOCK',
  'XDG_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'DOTNET_ROOT',
  'DOTNET_CLI_TELEMETRY_OPTOUT',
  'GODOT',
]);
// LC_* is the locale; CLAUDE_* and ANTHROPIC_* configure Claude Code itself (its config dir, its login).
const ENV_PREFIXES = ['LC_', 'CLAUDE_', 'ANTHROPIC_'];
export const TURN_TZ = ZONE;
export function turnEnv(from: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(from)) {
    if (v !== undefined && (ENV_NAMES.has(k) || ENV_PREFIXES.some((p) => k.startsWith(p)))) env[k] = v;
  }
  // Claude Code's date line is in the turn's own zone. On the server's UTC it flips at 4 PM PST, in the middle of keepalive
  // hours, and the flip changes the cached prefix. Pacific flips at midnight (#862, Cara 2026-11-17). The server's clock stays UTC.
  env.TZ = TURN_TZ;
  return env;
}
/**
 * A turn's environment as it goes to a connected machine (Build 7, specs/worker-machines.md section 4): claude and gh sign in
 * there with that machine's own logins, so no Claude or GitHub sign-in of the server's or the person's is sent, by name or by family.
 */
export function machineEnv(env: Record<string, string>): Record<string, string> {
  const signIn = (k: string) => AUTH_VARS.includes(k) || /^(ANTHROPIC_|CLAUDE_CODE_OAUTH|CLAUDE_CONFIG_DIR$|GH_TOKEN$|GITHUB_TOKEN$|GH_ENTERPRISE_TOKEN$|GH_CONFIG_DIR$)/.test(k);
  return Object.fromEntries(Object.entries(env).filter(([k]) => !signIn(k)));
}
/** Cara's pick on #760 (2026-11-15), no real calls in a week: ListAgents lists other local sessions; ReportFindings is the built-in code-review's (citadel:self-review reviews instead). */
const UNPICKED_TOOLS = ['ListAgents', 'ReportFindings'];
/**
 * Built-in tools no turn calls, kept out of the context every API call re-reads (#138, ~3.7k tokens):
 * Citadel schedules its own work, so /loop's wakeups, cron and remote triggers go. Workflow (~2k tokens)
 * goes too, except for a minion opted in with its `workflow` switch (#359; disallowedTools).
 */
export const UNUSED_TOOLS = ['Workflow', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger', ...UNPICKED_TOOLS];
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
 * command's output it keeps, and the bundled skills that stay out of the prefix (#708). Minions compact at about 217k (Claude Code compacts about 33k under the window). Josh, 2026-11-25, picked
 * "220k, for every minion" over Cara's 2026-11-14 150k (#703): its saving was mostly re-reading after each summary (#1920).
 */
/**
 * Bundled Claude Code skills that never fired in 19 days of transcripts (#699), set "off" (Claude Code 2.1.323's
 * skillOverrides: skill name -> "off" | "name-only" | "user-invocable-only"). Each one's listing is read on every call.
 * #760 adds four with no use in a week of turns, each with a Citadel twin: simplify (citadel:self-review),
 * fewer-permission-prompts (turns run without prompts), run (citadel-dev-copy) and security-review; then code-review
 * (2 uses, by Grunts; Cara's pick, 2026-11-15), whose reviews citadel:self-review does.
 * plugin-authoring (Delve's mods) and the rest stay on.
 */
export const UNUSED_BUNDLED_SKILLS = Object.fromEntries(['update-config', 'schedule', 'loop', 'keybindings-help', 'workflow-authoring', 'init', 'simplify', 'fewer-permission-prompts', 'run', 'security-review', 'code-review'].map((n) => [n, 'off'])) as Record<string, 'off'>;
export const TURN_SETTINGS = { autoCompactWindow: 250_000, bashOutputMaxChars: 12_000, skillOverrides: UNUSED_BUNDLED_SKILLS };
/** A Taskmaster's compact window (#423): about 147k; #1920's 220k is minions' only. It hands off past FRESH_CONTEXT_TOKENS (turn end) or FRESH_IDLE_CONTEXT_TOKENS (idle) anyway. */
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
  const files = [join(home, '.claude/.credentials.json'), join(claudeConfig, '.credentials.json'), join(home, '.config/gh/hosts.yml'), join(dataDir, 'state.db*'), join(dataDir, 'backups/state-*'), join(dataDir, 'vapid.json')];
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
 * Fetches a Taskmaster may run in its scheme's repo (#621), exact: they only move remote-tracking refs.
 * Any other form could name a refspec that moves a local branch (`origin main:main`) or a command (--upload-pack).
 * Not in worktrees: they share the repo's refs, so its fetch is theirs, and 7 rules a worktree helped pass the 2 MiB cap (#661).
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
  ...[
    'grep',
    'ls',
    'find',
    'cat',
    'head',
    'tail',
    'wc',
    'stat',
    'sort',
    'uniq',
    'cut',
    'echo',
    'uptime',
    'free',
    'df',
    'du',
    'ps',
    'journalctl --user',
    'ss -ltn',
    'ss -tln',
    'ss -lnt',
    'ss -ltnp',
    'ss -tlnp',
    'ss -lntp',
    'systemctl --user status',
    'systemctl --user is-active',
    'systemctl --user show',
    'systemctl --user list-units',
    'systemctl --user list-timers',
    'sqlite3 -readonly -safe',
    'sqlite3 -safe -readonly',
    'gh pr view',
    'gh pr list',
    'gh pr checks',
    'gh pr diff',
    'gh pr status',
    'gh run list',
    'gh run view',
    'gh issue view',
    'gh issue list',
    'gh api',
    // #621: more reads a Taskmaster reached for. Not sed or file: a writing flag bundled anywhere (-nsi, -bC) passes any rule.
    'gh repo view',
    'gh release list',
    'gh release view',
    'gh workflow list',
    'gh workflow view',
    'gh label list',
    // #1122: looks up a part of Citadel's UI and prints its link; reads nothing but its own list.
    'citadel-where',
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
  ['find', '-delete', '-exec', '-ok', '-fprint', '-fls'],
  ['sort', '-o', '--o', '--co'],
  ['ss', '-D', '--d', '-K', '--k'],
  ['journalctl', '--vac', '--rot', '--fl', '--syn', '--rel', '--sm', '--se', '--up', '--cursor-f'],
  ['sqlite3', '-nonce', '--nonce', '-unsafe', '--unsafe'],
  ['gh api', '-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'],
  // A file it saves, or a browser it opens.
  ['gh release view', '-w', '--w'],
  ['gh repo view', '-w', '--w'],
  ['gh workflow view', '-w', '--w'],
]
  .flatMap(([cmd, ...flags]) => flags.flatMap((f) => [`Bash(${cmd} ${f}*)`, `Bash(${cmd} * ${f}*)`]))
  // uniq's second operand is a file it writes.
  .concat('Bash(uniq * *)');
/** Box-health files a Taskmaster may Read beside its read folders. */
const HEALTH_FILES = ['/proc/loadavg', '/proc/meminfo', '/proc/uptime', '/proc/pressure/**']; // host-signal-ok: paths a turn's sandbox may read, not a read here

/**
 * What the Citadel scheme's Taskmaster may read beyond its own scheme (#656, Josh: "the Citadel taskmaster should
 * have full read access to all schemes"), on a turn a Citadel member or admin asked for: runner.ts everySchemeFor.
 */
export interface EveryScheme {
  /** Every other scheme's main checkout and its open minions' worktrees: read-only `git -C` there, never fetch. */
  gitDirs: string[];
  /** Each contraption's folder (~/apps/<name>): readable, not added (so nothing writes there), read-only `git -C`. */
  apps: string[];
  /** The live data folder, where every scheme's folders are (projects/<id>). */
  data: string;
  /** The contraptions' key folders (src/contraptions.ts), whose keys stay denied. */
  keysDir: string;
}

/** .env files under the folders a Taskmaster reads (its own scheme's, other schemes', the contraptions'): denied to every Taskmaster (#656). */
const envDenies = (folders: string[]) => folders.flatMap((d) => [`Read(/${d}/**/.env)`, `Read(/${d}/**/.env.*)`]);

/**
 * The one `node` command a Taskmaster may run: citadel:briefing and citadel:subagents run kit/model-tiers.ts when
 * they load, and a refused `!` command fails the whole skill (#1979). Exact rules, each path as Claude Code fills it
 * in (`..` and all; tried in real runs), so no other script or argument matches. Each part of a chain still needs its own rule.
 */
const modelTierRules = (kit: string) => ['briefing', 'subagents'].map((skill) => `Bash(node "${kit}/skills/${skill}/../../model-tiers.ts")`);

/**
 * How the coordinator may look at the project's code: its main checkout and every ticket folder,
 * readable but not writable. Bash runs only read-only commands (READ_ONLY_COMMANDS), on those folders,
 * readDirs and the box-health files: Claude Code still refuses a read command's path outside them.
 * Given the turn's kit, it also runs the model table's script (modelTierRules).
 * `git -C <dir> <read-only command>` is allowed per folder; each rule pins the exact folder as a prefix,
 * since `*` in a rule would also match `git -C x commit -m "fix log"`. Anything else that would ask
 * for approval is denied (test/coordinator-access.test.ts replays the calls that used to be).
 * Two more folders are added with no deny rule: the project's shared folder, which acceptEdits then
 * lets the coordinator write, and the repo's Claude Code memory. Claude Code treats files under its
 * config dir as sensitive, so neither allow rules nor a hook's allow let it write there (tried with
 * real runs); making that folder its auto-memory does, so its memory is the one minions load too.
 */
export function coordinatorAccess(
  repoDir: string | null,
  ticketsDir: string,
  sharedDir: string | null = null,
  memoryDir: string | null = null,
  liveDir: string | null = null,
  readDirs: string[] = [],
  everyScheme: EveryScheme | null = null,
  openTickets: string[] | null = null,
  kit: string | null = null,
): { addDirs: string[]; settings: { permissions: { deny: string[]; allow: string[] }; autoMemoryDirectory?: string } } {
  const subdirs = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => join(dir, d.name));
    } catch {
      return []; // No tickets yet.
    }
  };
  const roots = [repoDir, ticketsDir, liveDir].filter((d): d is string => !!d);
  // Git rules only for open minions' worktrees when the runner names them: one set per folder in tickets/, closed ones
  // included, outgrew Claude Code's 2 MiB cap on a settings file (Citadel had 661 folders, 10 open). The repo reads every branch.
  const ticketGit = openTickets ?? subdirs(ticketsDir);
  const gitDirs = [repoDir, ...(repoDir ? ticketGit : []), liveDir].filter((d): d is string => !!d);
  const writable = [sharedDir, memoryDir].filter((d): d is string => !!d);
  // Other schemes' folders sit in the data folder, already in readDirs; the contraptions' are read here (#656).
  const apps = everyScheme?.apps ?? [];
  const readGit = [...gitDirs, ...(everyScheme?.gitDirs ?? []), ...apps];
  return {
    // Adding the parent tickets/ folder also covers worktrees made after the turn starts.
    addDirs: [...roots, ...writable],
    settings: {
      permissions: {
        // `//` makes the path absolute. Edit rules also cover Write, NotebookEdit and Bash commands that write there.
        deny: [...roots.map((d) => `Edit(/${d}/**)`), 'Bash(git * --output*)', ...READ_ONLY_EXCEPTIONS, ...envDenies([...readDirs, ...apps]), ...(everyScheme ? [`Read(/${join(everyScheme.keysDir, '*/contraption.key')})`] : [])],
        // The web tools ask by default, and nobody can answer a Taskmaster's prompts, so they were denied (#210).
        // readDirs (the live data folder, mise's installs) and the contraptions' folders are readable but not added, so acceptEdits can't write there.
        allow: [
          'WebSearch',
          'WebFetch',
          ...[...readDirs, ...apps]
            .map((d) => `${d}/**`)
            .concat(HEALTH_FILES)
            .map((p) => `Read(/${p})`),
          ...READ_ONLY_COMMANDS,
          ...(kit ? modelTierRules(kit) : []),
          ...readGit.flatMap((d) => READ_ONLY_GIT.map((c) => `Bash(git -C ${d} ${c})`)),
          ...(repoDir ? GIT_FETCH.map((c) => `Bash(git -C ${repoDir} ${c})`) : []),
        ],
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
  /** The folders it may use; null where there is none. `data` is the folder the database is in; `openTickets`, a Taskmaster's open minions' worktrees. */
  folders: { files: string | null; shared: string | null; memory: string | null; tmp: string | null; tickets: string; data: string; openTickets?: string[] };
  /** The machines lending it their tools. */
  machines: TurnMachine[];
  model: string | null;
  effort: string | null;
  /** Set when it runs on Codex: the thread it resumes, or null for a new one. */
  codex: { thread: string | null } | null;
  /** The container a host turn's Codex reviews run in (#398). */
  codexReview: { container: string; turnsDir: string; env: Record<string, string> } | null;
  /** Its environment's sources: the server's own (filtered by turnEnv), how its MCP server reaches the API, citadel-heavy's, and the person's GitHub login. */
  env: { server: NodeJS.ProcessEnv; coordinator: Record<string, string>; heavy: Record<string, string>; github: Record<string, string> | null; secrets?: Record<string, string> };
  /** It is in the scheme whose code this server runs, so deploys mean something. */
  deploys: boolean;
  /** Its scheme has semantic memory. */
  memory: boolean;
  /** The person it runs for has OpenRouter connected: a minion is offered the media tools (#717). */
  media?: boolean;
  /** The person it runs for has a Codex login this turn can reach: a minion is offered generate_image_codex (#733). */
  codexImages?: boolean;
  /** The one person whose own typed message it answers (#295). */
  typer: { id: number; login: string } | null;
  /** The contraptions its scheme is home to (#266). */
  homeContraptions: string[];
  /** Machines this minion may queue jobs on (#857): queue_job, job_status and stop_job are offered only with one. */
  jobMachines?: string[];
  /** It is the run of its scheme's app turns check working now: offered contraption_turns (#844). */
  appTurnsRun?: boolean;
  /** For the Citadel scheme's Taskmaster on a Citadel member's ask, what it may read in every scheme (#656); else null. */
  everyScheme?: EveryScheme | null;
  claudeBin: string;
  /**
   * A side question's fork (#932): the same launch, plus a hook that refuses every write. A hook, not fewer tools,
   * so the tools and prompt (the cached prefix) stay the minion's own.
   */
  side?: boolean;
  /** The systemd unit it runs in, or null for a plain child (and in a container). */
  unit: string | null;
  /** Its Citadel tools and machine links come from its place's shared tool server (#1259), not helpers of its own. Never a Codex turn's. */
  pool?: boolean;
  /** It is placed on a connected machine (Build 7 T2, src/machine-turn.ts): its agent runs the wrapper there, and nothing is spawned here. */
  machine?: boolean;
  /** Its machine's name when it reaches that PC's host (Build 7 T8, src/host-reach.ts): offered run_on_host. */
  hostReach?: string;
}

/** Claude Code refuses a settings file past 2 MiB (2.1.x: "Settings file exceeds the 2MiB limit"). */
export const SETTINGS_CAP = 2 * 1024 * 1024;

/** Why a turn's settings.json passes SETTINGS_CAP, with the counts that grow: the Taskmaster's per-folder git rules. */
function settingsTooBig(bytes: number, allow: string[], facts: TurnFacts): string {
  const git = allow.filter((r) => r.startsWith('Bash(git -C '));
  const folders = new Set(git.map((r) => r.slice('Bash(git -C '.length).split(' ')[0])).size;
  const n = (x: number) => x.toLocaleString('en-US');
  const own = facts.folders.openTickets?.length ?? 0;
  const every = facts.everyScheme ? `, ${n(facts.everyScheme.gitDirs.length)} folders in other schemes and ${n(facts.everyScheme.apps.length)} contraptions' (every-scheme reads)` : '';
  return (
    `This turn's settings.json would be ${(bytes / 1024 / 1024).toFixed(1)} MiB, over Claude Code's ${SETTINGS_CAP / 1024 / 1024} MiB cap, so it can't start: ` +
    `${n(allow.length)} allow rules, ${n(git.length)} of them read-only git rules for ${n(folders)} folders (${n(own)} open minions' worktrees in this scheme${every}). ` +
    'Closing finished minions shrinks it; for good, the per-folder git rules need a hook in their place (shared handoffs/taskmaster-settings-2mib.md, follow-up 4).'
  );
}

/** What the runner writes to a turn's spec.json for its wrapper, from every path that starts one: one place, so the pool can't go missing from one (#1272). */
export function wrapperSpec(plan: Pick<LaunchPlan, 'command' | 'args' | 'env' | 'pool'>, cwd: string | null) {
  return { command: plan.command, args: plan.args, cwd, env: plan.env, ...(plan.pool ? { pool: plan.pool } : {}) };
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
  /**
   * `unit`: a host turn with a unit of its own. The runner hands it to the shared turn supervisor (#1343,
   * src/turn-supervisor.mjs), which runs it in a scope from `scope` (systemd-run's arguments: the same name, slice and
   * memory marks), and starts the wrapper in a unit from `systemdRun` when the supervisor doesn't take it.
   */
  spawn: { how: 'container'; wrapper: string[] } | { how: 'unit'; systemdRun: string[]; scope: string[]; wrapper: string[] } | { how: 'child'; wrapper: string[] } | { how: 'machine'; wrapper: string[] };
  /** The shared tool server the wrapper keeps up for this turn (src/pool-client.mjs); with it, `mcp.json` reaches the pool and `mcp-stdio.json` is the fallback. */
  pool?: PoolSpec;
}

/** Schemes (project ids) whose turns run with Claude Code's --exclude-dynamic-system-prompt-sections (#1188): the per-machine
 * parts of the system prompt (cwd, git status, auto-memory path) move into the first user message, so new minions share one
 * cached prefix. Citadel's own scheme only while we measure it (reports/shared-prompt-cache-2026-11.md); add an id to widen, empty it to turn off. */
export const EXCLUDE_DYNAMIC_PROMPT_SCHEMES: readonly number[] = [];

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
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    ticket.permission_mode,
    '--append-system-prompt-file',
    join(dir, 'system-prompt.md'),
    // Claude Code otherwise replays a session's first system prompt on every resume, so saved instructions,
    // lent machines or a build never reached a running minion (#618). Unchanged text still reads from cache.
    '--system-prompt-snapshot',
    'off',
    // A minion's tripwire asks and approval rules become Approve / Deny cards; nobody can answer a
    // Taskmaster's prompts, so those are denied instead of waiting.
    ...permissionArgs(ticket.kind !== 'coordinator'),
    ...(EXCLUDE_DYNAMIC_PROMPT_SCHEMES.includes(project.id) ? ['--exclude-dynamic-system-prompt-sections'] : []),
  ];
  // Lets edit-only sessions write there too, not just in their working directory. The temp folder too:
  // Claude Code asks before `cd <dir> && rm <glob>` outside the working directories, even in bypassPermissions.
  const addDirs = [filesDir, sharedDir, tmp].filter((d): d is string => !!d);
  // One --settings per turn: the tripwire hook and the shared settings, plus approval rules or the Taskmaster's access rules.
  // A scheme's off kit skills (#1062) are also pruned from the turn's kit copy; the deny stops one named anyway.
  const deny = [...credentialDenies(homedir(), claudeConfigDir(facts.env.server), facts.folders.data), ...skillDenies(offSkills(project))];
  // The link check reads the reply against the folders the chat serves this turn's files from (ticketRoots).
  // A file, not an argument: a scheme's minion list outgrows a command line.
  const refsFile = join(dir, 'scheme-refs.json');
  const linkCheck = ticket.cwd
    ? linkCheckHooks(
        [ticket.cwd, filesDir, sharedDir].filter((d): d is string => !!d),
        pinned(pins.LINK_CHECK),
        join(dir, 'link-check-nudged'),
        refsFile,
      )
    : {};
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
  // Pooled (#1259): the same servers by name, over HTTP to the place's shared tool server; Claude Code fills in the port
  // the wrapper found and the turn's own token from the env. The stdio config stays beside it for when the pool won't start.
  const pooled = facts.pool && !codex;
  if (pooled) {
    const pool = (path: string, extra: object = {}) => ({ type: 'http', url: `http://127.0.0.1:\${CITADEL_POOL_PORT}${path}`, headers: { Authorization: 'Bearer ${COORDINATOR_TOKEN}' }, ...extra });
    const http: Record<string, object> = { [role]: pool('/mcp', role === 'thread' ? { timeout: APPROVAL_TIMEOUT_MS } : {}) };
    for (const m of machines) for (const s of machineServers(m)) http[s.name] = pool(`/machine/${m.id}/${s.server}?name=${encodeURIComponent(s.name)}${s.server === 'mcp' && m.lent ? `&lent=${encodeURIComponent(m.lent)}` : ''}`);
    files.push({ name: 'mcp.json', text: JSON.stringify({ mcpServers: http }) });
    files.push({ name: 'mcp-stdio.json', text: JSON.stringify({ mcpServers: servers }) });
  } else {
    files.push({ name: 'mcp.json', text: JSON.stringify({ mcpServers: servers }) });
  }
  // The contraptions' folders the Citadel scheme's Taskmaster reads this turn (#656) stay unwritable to it.
  const readOnly = ticket.kind === 'coordinator' && project.id === GLOBAL_OWNER ? (facts.everyScheme?.apps ?? []) : [];
  // A Taskmaster reads the whole data folder (and the contraptions'), never a .env file in it.
  const envFiles = ticket.kind === 'coordinator' ? [facts.folders.data, ...readOnly] : [];
  // A minion's copies of its scheme's apps' data (src/app-copy.ts) are its own to change.
  const copies = ticket.kind !== 'coordinator' && facts.homeContraptions.length ? { copies: join(dir, COPIES) } : {};
  const kit = pins.PIN_HAS.kit ? pinned(pins.KIT) : null;
  // Every PreToolUse check in one process (#1296); the kit's big-read guard rides it, so hooks.json leaves it out.
  const preToolUse = hookRunHooks(
    {
      ...(facts.side ? { side: true } : {}),
      tripwire: { ...tripwireConfig(project.id, claudeConfigDir(facts.env.server), ticket.kind !== 'coordinator', readOnly, envFiles), ...copies },
      wording: { shared: [filesDir, sharedDir].filter((d): d is string => !!d), sent: join(dir, 'wording-sent') },
      schemeRefs: { refs: refsFile, sent: join(dir, 'scheme-refs-sent') },
      ...(kit ? { kit } : {}),
    },
    pinned(pins.HOOK_RUN),
  );
  // Codex's managed hook (deploy/claude-container/codex) reads the turn's tripwire from this file: its command can't carry it.
  // A Codex turn's own run is checked in turn mode: its patches and MCP calls too, with no cards, and never its own folder.
  // A host turn has no hook, so the server login's Codex reviews run in its Codex container (#398): named here, where
  // the turn can't change it.
  const container = facts.codexReview ? { container: { name: facts.codexReview.container, turnsDir: facts.codexReview.turnsDir, env: facts.codexReview.env } } : {};
  const codexTripwire = join(dir, 'codex-tripwire.json');
  files.push({
    name: 'codex-tripwire.json',
    text: JSON.stringify({ script: pinned(pins.TRIPWIRE), config: { ...tripwireConfig(project.id, claudeConfigDir(facts.env.server), false, readOnly, envFiles), ...copies, ...(codex ? { turnDir: dir } : {}) }, ...(codex ? { mode: 'turn', mcp: Object.keys(servers), rules } : {}), ...container }),
    mode: 0o444,
  });
  const settings: { permissions: { deny: string[]; ask?: string[]; allow?: string[] }; autoMemoryDirectory?: string; hooks: object } & typeof LEAN_CONTEXT & typeof TURN_SETTINGS = {
    hooks: { ...linkCheck, PreToolUse: preToolUse },
    ...LEAN_CONTEXT,
    ...TURN_SETTINGS,
    permissions: { deny },
  };
  if (rules.length) settings.permissions.ask = rules;
  if (ticket.kind === 'coordinator') {
    const access = coordinatorAccess(
      project.repo_dir,
      facts.folders.tickets,
      sharedDir,
      memoryDir,
      project.id === GLOBAL_OWNER ? CHECKOUT : null,
      [facts.folders.data, join(homedir(), '.local/share/mise/installs')],
      project.id === GLOBAL_OWNER ? (facts.everyScheme ?? null) : null,
      facts.folders.openTickets ?? null,
      kit,
    );
    addDirs.push(...access.addDirs.filter((d) => !addDirs.includes(d)));
    const { permissions, ...rest } = access.settings;
    Object.assign(settings, rest);
    settings.permissions = { ...permissions, deny: [...permissions.deny, ...deny] };
    settings.autoCompactWindow = TASKMASTER_COMPACT_WINDOW;
  }
  settings.permissions.allow = [...(settings.permissions.allow ?? []), ...Object.keys(servers).map((name) => `mcp__${name}`)];
  // As a file: the Taskmaster's git rules (one per worktree) outgrew Linux's 128 KiB cap on one argument (E2BIG).
  const settingsText = JSON.stringify(settings);
  // Past Claude Code's cap the turn dies at launch with a bare "Settings file exceeds the 2MiB limit" (#661): say why instead.
  if (Buffer.byteLength(settingsText) > SETTINGS_CAP) throw new Error(settingsTooBig(Buffer.byteLength(settingsText), settings.permissions.allow ?? [], facts));
  files.push({ name: 'settings.json', text: settingsText });
  args.push('--settings', join(dir, 'settings.json'));
  if (addDirs.length) args.push('--add-dir', ...addDirs);
  if (kit) args.push('--plugin-dir', kit);
  args.push(...pluginDirArgs(turnPluginDirs(project, ticket), ticket.cwd));
  // The advisor trial (#817): `claude-sonnet-5-5+opus-advisor` runs Sonnet with Opus as its advisor. Never a Taskmaster's or Codex's
  // (codex-turn.ts maps the plain --model, so Sonnet's Codex pick).
  // Claude Code's CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1, in the service's env, switches the tool off for every turn.
  const advised = advisedModel(model);
  if (advised.model) args.push('--model', advised.model);
  if (advised.advisor && ticket.kind !== 'coordinator' && !codex) args.push('--advisor', advised.advisor);
  if (effort) args.push('--effort', effort);
  // The task-list tools (TaskCreate/TaskUpdate) are off by default in headless mode. A Taskmaster's drive its progress readout; a
  // minion plans with the always-loaded `plan` tool instead (#1275), so it never spends a ToolSearch on them nor is nudged to.
  let env: Record<string, string> = { ...turnEnv(facts.env.server), ...(ticket.kind === 'coordinator' ? { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } : {}) };
  // Its own temp folder on disk, cleared on dismissal (#218). CLAUDE_CODE_TMPDIR moves Claude Code's
  // /tmp/claude-<uid>, which ignores TMPDIR. A command or script that sets its own TMPDIR still wins.
  if (tmp) env = { ...env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CLAUDE_CODE_TMPDIR: tmp };
  args.push('--mcp-config', join(dir, 'mcp.json'), '--disallowedTools', ...disallowedTools(ticket));
  env = { ...env, ...facts.env.coordinator, COORDINATOR_ROLE: role, COORDINATOR_TICKET: String(ticket.id), ...(ticket.number == null ? {} : { COORDINATOR_NUMBER: String(ticket.number) }) };
  // The kit's hooks (kit/hooks/hooks.json) keep their compile cache where the turn's own hooks do (hookCommand).
  env.CITADEL_HOOK_CACHE = join(pin, COMPILE_CACHE);
  // The kit's title check (kit/hooks/answer-check.ts, #1154) compares the title the turn starts with to its prompt. Not
  // COORDINATOR_: those count toward the cached prefix's fingerprint (src/keepalive.ts), which a rename doesn't change.
  if (ticket.kind !== 'coordinator') env.CITADEL_MINION_TITLE = ticket.title;
  // The server login's extra Claude account (#779): its own config folder, so nothing of the host's own login may win over it.
  if (place.host && place.env) {
    for (const v of AUTH_VARS) delete env[v];
    env = { ...env, ...place.env };
  }
  // In a container, claude signs in with the person's own login, so nothing of the server's may win over it.
  if (!place.host) {
    for (const v of AUTH_VARS) delete env[v];
    env = { ...env, ...place.env, COORDINATOR_CONTAINER: '1' };
    // The host's /run/user/<uid> isn't in the container, and .NET keeps named mutexes under
    // XDG_RUNTIME_DIR: without it every one fails, NuGet's restore included (#225).
    if (tmp) env.XDG_RUNTIME_DIR = tmp;
  }
  env = { ...env, ...androidEnv(homedir(), env.PATH) };
  // mise's shims last (#1147): an approved host tool runs by name, and never shadows one the turn had before.
  env = { ...env, ...facts.env.heavy, PATH: [...(pins.PIN_HAS.heavy ? [join(pin, 'bin', 'heavy')] : []), join(pin, 'bin'), env.PATH, join(homedir(), '.local/share/mise/shims')].filter(Boolean).join(':') };
  // The server's host tools list (#1147), which propose_host_tool names; the live checkout is in every container too.
  env.COORDINATOR_HOST_TOOLS = LIVE_MANIFEST;
  // For plugins and hooks: the folders the prompt names (Delve's mod writes its retro log there).
  if (sharedDir) env.COORDINATOR_SHARED_DIR = sharedDir;
  if (filesDir) env.COORDINATOR_FILES_DIR = filesDir;
  env.CITADEL_CODEX_TRIPWIRE = codexTripwire;
  // The thread's MCP server offers the approval tool, which holds its call open until someone clicks.
  if (ticket.kind !== 'coordinator') env = { ...env, COORDINATOR_APPROVALS: '1', MCP_TOOL_TIMEOUT: String(APPROVAL_TIMEOUT_MS) };
  // The scheme's screenshot widths and themes (#1044): tools/ui-shot.ts's defaults when a minion passes none.
  if (ticket.kind !== 'coordinator' && project.shot_widths && project.shot_themes) Object.assign(env, { COORDINATOR_SHOT_WIDTHS: project.shot_widths, COORDINATOR_SHOT_THEMES: project.shot_themes });
  // The scheme's message numbers (#1059) for the tool text; unset at the defaults so the prompt hash stays put.
  const msg = msgEnv(msgSettings(project));
  if (msg) env.COORDINATOR_MSG = msg;
  if (facts.deploys) env.COORDINATOR_DEPLOYS = '1';
  // kit/model-tiers.ts leaves Fable out of the tiers citadel:subagents and citadel:briefing show (#1574).
  if (project.fable_ok === 'off') env.CITADEL_FABLE_OFF = '1';
  if (facts.memory) env.COORDINATOR_MEMORY = '1';
  if (facts.media && ticket.kind !== 'coordinator') env.COORDINATOR_MEDIA = '1';
  if (facts.codexImages && ticket.kind !== 'coordinator') env.COORDINATOR_CODEX_IMAGES = '1';
  // The person's own GitHub token (or none, so it can't push).
  if (facts.env.github) env = { ...env, ...facts.env.github };
  // Saved secrets (#838): CITADEL_SECRET_<NAME>, and CITADEL_SECRET_NAMES listing them.
  if (facts.env.secrets) env = { ...env, ...facts.env.secrets };
  // Grunts on a Fable turn default to Opus, not Fable (#705, Cara 2026-11-14: "No Fable for helper Grunts"):
  // general-purpose Grunts were most of a week's $691 of Fable Grunts. An Agent call's own `model` (self-review's
  // `fable` finding-checkers and build reviewers) and an agent definition's `model:`, `inherit` included, still win.
  // Not CLAUDE_CODE_SUBAGENT_MODEL_FORCE: that would drop the explicit `fable` on a high-risk review too.
  // A backstop now (#947): the kit's grunt-model hook sends back Agent calls with no model, so few Grunts reach it.
  if (model && /fable/i.test(model)) env.CLAUDE_CODE_SUBAGENT_MODEL = 'claude-opus-5-5';
  // Whose data this turn may read (#295): the person whose own typed message it answers, as the identity's
  // `sub`, for contraptions' own hook guards. Set fresh per process and absent (never empty) on any other turn:
  // a relay, a wake, a schedule, a resume, GitHub or a contraption's post. turnEnv never passes CITADEL_*
  // through, and a steer can't change a running process's env, so it stays narrower than typedBy, never wider.
  if (facts.typer) Object.assign(env, { CITADEL_PERSON_ID: String(facts.typer.id), CITADEL_PERSON_LOGIN: facts.typer.login });
  // Only the Citadel scheme's Taskmaster is offered the app instruction and contraption tools (the API checks too).
  if (ticket.kind === 'coordinator' && project.id === GLOBAL_OWNER) env.COORDINATOR_APP_INSTRUCTIONS = '1';
  // A contraption's home scheme may deploy it (#266): its Taskmaster and minions are offered deploy_contraption for it.
  if (facts.homeContraptions.length) env.COORDINATOR_HOME_CONTRAPTIONS = facts.homeContraptions.join(',');
  if (facts.appTurnsRun) env.COORDINATOR_APP_TURNS_RUN = '1';
  // A minion may propose new notes for the machines its turn got (#617).
  if (ticket.kind !== 'coordinator' && machines.length) env.COORDINATOR_MACHINES = machines.map((m) => m.name).join(',');
  if (facts.jobMachines?.length) env.COORDINATOR_JOB_MACHINES = facts.jobMachines.join(',');
  if (facts.machine && facts.hostReach && ticket.kind !== 'coordinator') env.COORDINATOR_HOST_REACH = facts.hostReach;
  const configDir = place.host ? claudeConfigDir(env) : place.configDir;
  if (facts.machine) env = machineEnv(env);
  let command = place.host ? facts.claudeBin : resolveClaude(facts.claudeBin);
  if (codex) {
    // The shim runs in claude's place (src/codex-turn.ts), from the hand-over the runner writes; it skips that when it resumes the thread.
    command = node;
    args.unshift(pinned(pins.CODEX_TURN), '--codex-mode', 'turn', '--codex-log', join(dir, 'codex-log.jsonl'), '--codex-handover', join(dir, 'handover.md'), ...(codex.thread ? ['--codex-thread', codex.thread] : []));
  }
  const wrapper = [node, pinned(pins.TURN_WRAPPER), dir];
  // The turn's own memory group, a unit for the wrapper or a scope from the supervisor: its slice and oomd's mark on it.
  // systemd-oomd (#1338): a minion turn is `avoid`, the last pick once heavy commands, ships and test scopes are gone;
  // a Taskmaster turn is `omit`, never picked. A turn unit or scope is a leaf cgroup, which is where oomd reads the mark.
  const group = [`--unit=${facts.unit}`, ...(ticket.kind === 'coordinator' ? [`--slice=${TASKMASTER_SLICE}`, '-p', 'ManagedOOMPreference=omit'] : [`--slice=${TURN_SLICE}`, '-p', 'ManagedOOMPreference=avoid']), '-p', 'TimeoutStopSec=15'];
  const spawn: LaunchPlan['spawn'] = facts.machine
    ? { how: 'machine', wrapper }
    : !place.host
      ? { how: 'container', wrapper }
      : facts.unit
        ? { how: 'unit', systemdRun: ['--user', '--collect', '--quiet', ...group, '-p', 'UMask=0077', ...thpProps(), ...wrapper], scope: ['--user', '--scope', '--collect', '--quiet', ...group], wrapper }
        : { how: 'child', wrapper };
  // One pool per place (the host's turns folder, or a person's; their Taskmaster container's apart, as it counts pids apart and the
  // record is kept by pid, #1882) and version; it gets a plain env, each turn's own comes with its registration.
  // On the host it runs in a unit of its own, so it outlives the turn that started it, in the Taskmasters' slice (#1280):
  // it serves their Citadel tools too, so a minion storm mustn't stall it (about 70M). `omit` (#1338): every turn's
  // Citadel tools go through it, and with minion turns `avoid` it would otherwise be oomd's pick ahead of all of them.
  const poolDir = join(dirname(dir), !place.host && ticket.kind === 'coordinator' ? '.pool-taskmaster' : '.pool', pins.POOL_VERSION);
  const poolEnv = Object.fromEntries(['PATH', 'HOME', 'LANG', 'TZ'].filter((k) => env[k]).map((k) => [k, env[k]]));
  const poolUnit = `citadel-mcp-pool-${createHash('sha256').update(poolDir).digest('hex').slice(0, 12)}`;
  const pool: PoolSpec | undefined = pooled
    ? {
        dir: poolDir,
        script: pinned(pins.POOL),
        node,
        version: pins.POOL_VERSION,
        env: poolEnv,
        ...(place.host && facts.unit ? { systemdRun: ['--user', '--collect', '--quiet', `--unit=${poolUnit}`, `--slice=${TASKMASTER_SLICE}`, '-p', 'ManagedOOMPreference=omit', '-p', 'UMask=0077', ...thpProps()] } : {}),
      }
    : undefined;
  return { command, args, env, configDir, files, spawn, ...(pool ? { pool } : {}) };
}
