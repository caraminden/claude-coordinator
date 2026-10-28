// Runs ticket turns as headless `claude -p` processes, one turn per process. Each runs through
// src/turn-wrapper.ts in a transient systemd unit of its own (or, without units, a detached child),
// with its input and output in a turn folder the server tails, so a server restart doesn't stop it.
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { APP_NAME } from './appname.ts';
import { AGENT_NAME } from './auth.ts';
import type { EventRow, Machine, Project, Store, Ticket } from './db.ts';
import { APPROVAL_TIMEOUT_MS, Approvals, lines, permissionArgs, pluginDirArgs, unsettledCards } from './approvals.ts';
import type { TripwireConfig } from './tripwire.ts';
import { claudeConfigDir, lastEffort, projectSlug, restoreSession, saveSession } from './sessions.ts';
import { restoreTicketDir } from './workspace.ts';
import { activityLabel, applyEvent, createProgress, isWorkTool, progressLine, stepInfo } from '../public/progress.js';

const MAX_TOOL_OUTPUT = 20_000;
// Turns run a copy of the MCP server taken when this server started, not the file on disk: a deploy
// pulls new code before the restart, and a newer MCP server would offer tools this process rejects.
// The copies live in the app's data dir, one folder per server process, swept once that process is gone.
const DATA_DIR = process.env.DATA_DIR ?? join(homedir(), '.local/share/claude-coordinator');
const RUN_DIR = join(DATA_DIR, 'run');
export const MCP_DIR = join(RUN_DIR, `mcp-${process.pid}`);
function alive(pid: number): boolean {
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
export const TURN_WRAPPER = pinnedCopy('turn-wrapper.ts');
/** The slice turn units run in; its name puts it under citadel.slice, which deploy/citadel.slice caps. */
export const TURN_SLICE = 'citadel-turns.slice';

/** The tripwire's view of this server, for a turn in this project; `ask` when the turn can show approval cards. */
export function tripwireConfig(projectId: number, claudeConfig: string, ask: boolean): TripwireConfig {
  return { home: homedir(), data: DATA_DIR, checkout: join(import.meta.dirname, '..'), project: projectId, claudeConfig, ask };
}

/**
 * The PreToolUse hook every turn gets (src/tripwire.ts): it stops known accidents such as writes to
 * this server's data and checkout, and in a minion's turn sends the ones a person may allow to a card.
 * Its config travels as one JSON argument; no quoting needed, as these paths and JSON carry no single quotes.
 */
export function tripwireHooks(projectId: number, claudeConfig: string, ask = false, script = TRIPWIRE) {
  const config = tripwireConfig(projectId, claudeConfig, ask);
  const command = [process.execPath, script, JSON.stringify(config)].map((s) => `'${s}'`).join(' ');
  return { PreToolUse: [{ matcher: '^(Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob)$', hooks: [{ type: 'command', command, timeout: 10 }] }] };
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
/** Where a turn compacts, in tokens; the Taskmasters' folders have no .claude/settings.json to set it. */
const AUTO_COMPACT_WINDOW = '250000';

// Stream events that carry no information for the ticket view.
const DROPPED_TYPES = new Set(['rate_limit_event', 'stream_event']);

export type Broadcast = (msg: object) => void;

interface UsageWindow {
  utilization: number; // 0..1 of the plan's limit
  resetsAt: number | null; // epoch ms
  status: string | null;
}

/** The Claude account's plan usage, as last reported by a turn. */
export interface Usage {
  weekly: UsageWindow | null;
  session: UsageWindow | null; // the rolling five-hour window
  updatedAt: number;
}

function usageWindow(w: any): UsageWindow | null {
  if (!w || typeof w.utilization !== 'number') return null;
  return {
    utilization: w.utilization,
    resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt * 1000 : null,
    status: typeof w.status === 'string' ? w.status : null,
  };
}

export interface MessageImage {
  name: string;
  path: string;
  mediaType: string;
}

interface QueuedMessage {
  author: string;
  text: string;
  images: MessageImage[];
  about?: string; // the file a comment is on
}

/**
 * What a running turn's restart recovery needs, kept in the settings table under `turn:<ticket id>`
 * from the turn's start until the server has handled its end. A restart re-attaches to the turn from
 * this, or resumes it if its process died too.
 */
interface TurnState {
  /** Auto-resumes in a row that led to this turn; 0 for a turn people or GitHub started. */
  resumes: number;
  stopped?: true;
  /** Present (a reason or null) once the thread asked to close after this turn. */
  closing?: string | null;
  queued?: QueuedMessage[];
  /** The turn's folder (see src/turn-wrapper.ts); absent for turns from before they had one. */
  dir?: string;
  /** Its transient unit, or null when it runs as a child of the server (and dies with it). */
  unit?: string | null;
  /** Bytes of its stream.jsonl handled so far. */
  offset?: number;
  startedAt?: number;
  configDir?: string;
  /** The ticket had an effort of its own when the turn started. */
  chosenEffort?: boolean;
  /** Its result event, once seen. */
  result?: { error: boolean; text: string | null };
  /** Its minion's deploy went live mid-turn (see deployLive). */
  deployed?: true;
}

/** A turn this server follows: its folder, read up to `offset`. */
interface LiveTurn {
  dir: string;
  unit: string | null;
  offset: number;
  startedAt: number;
  configDir: string;
  chosenEffort: boolean;
  timer: NodeJS.Timeout;
  ticks: number;
  stopTimer?: NodeJS.Timeout;
}

/** A turn's wrapper still runs: its pid is alive and is that turn's wrapper, not a reused pid. */
function wrapperAlive(dir: string): boolean | null {
  let pid: number;
  try {
    pid = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8')).wrapper;
  } catch {
    return null; // not started yet, or never will be
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dir);
  } catch {
    return existsSync('/proc/self') ? false : alive(pid);
  }
}

const turnKey = (ticketId: number) => `turn:${ticketId}`;

/** Taskmaster↔minion messages (both ways) one minion may exchange per LOOP_WINDOW_MS before the next waits for a person. */
export const LOOP_LIMIT = 6;
export const LOOP_WINDOW_MS = 60 * 60 * 1000;

/** A minion's loop-guard count and held messages, in the settings table under `loop:<minion id>` so they outlive a restart. */
interface LoopState {
  /** When each recent Taskmaster↔minion message went through. */
  sent: number[];
  /** Messages waiting for a person to continue, oldest first. */
  held: { to: number; author: string; text: string }[];
}

const loopKey = (minionId: number) => `loop:${minionId}`;

/** Claude Code's words when a turn hits the plan's usage limit: "You've hit your 5-hour limit · resets 3:30pm (…)". */
export const USAGE_LIMIT = /hit your [\w -]*limit/i;

/** Auto-resumes in a row before a thread is left alone, in case its own turn is what kills the server. */
export const MAX_RESUMES = 2;
/** Said beside the role names, and passed on to Grunts, which don't see these prompts. */
const ROLE_FRAMING = `${APP_NAME}, Scheme, Taskmaster, Minion and Grunt are playful names for how the work is organised, not a comment on ability. Work as a careful, senior engineer: think things through, check your work, and push back when something looks wrong.`;
const RESUME_PROMPT =
  `The ${APP_NAME} server restarted while you were working, which interrupted your last turn. Check the state of your work (files, git, background jobs) and continue where you left off. Don't redo finished steps.`;

/** One turn's prompt as a stream-json user message, so pasted images reach Claude as images. */
export function promptMessage(batch: QueuedMessage[]): string {
  const content: object[] = [];
  for (const m of batch) {
    const text = m.text || (m.images.length ? '(sent an image)' : '');
    content.push({ type: 'text', text: `[${m.author}${m.about ? ` on ${m.about}` : ''}]: ${text}` });
    for (const img of m.images) {
      try {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: readFileSync(img.path).toString('base64') } });
      } catch {
        content.push({ type: 'text', text: `(An image ${m.author} attached could not be loaded.)` });
      }
    }
  }
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}

function truncate(s: string): string {
  return s.length > MAX_TOOL_OUTPUT ? s.slice(0, MAX_TOOL_OUTPUT) + `\n… [truncated ${s.length - MAX_TOOL_OUTPUT} chars]` : s;
}

/**
 * Shrink a stream-json event before storing it, keeping only what the chat, the progress readout
 * and the coordinator's transcript read: thinking, usage, ids and background-task echoes are most
 * of a long thread's history and none of them are shown. Returns null for events not worth keeping.
 * `stored` is for events already in the database, whose tool output was capped when it was saved.
 */
export function slimEvent(ev: any, stored = false): any {
  if (ev.type === 'system') {
    return ev.subtype === 'init'
      ? { type: 'system', subtype: 'init', session_id: ev.session_id, model: ev.model, cwd: ev.cwd }
      : null;
  }
  if ((ev.type === 'assistant' || ev.type === 'user') && Array.isArray(ev.message?.content)) {
    const content = ev.message.content.flatMap((block: any) => {
      if (block?.type === 'thinking' || block?.type === 'redacted_thinking') return [];
      if (block?.type !== 'tool_result' || stored) return [block];
      let content = block.content;
      if (Array.isArray(content)) {
        content = content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
      }
      return [{ ...block, content: truncate(String(content ?? '')) }];
    });
    if (!content.length) return null;
    const slim: any = { type: ev.type, message: { role: ev.message.role, content } };
    if (ev.parent_tool_use_id) slim.parent_tool_use_id = ev.parent_tool_use_id;
    return slim;
  }
  if (ev.type === 'result') {
    const { subtype, is_error, duration_ms, num_turns, total_cost_usd } = ev;
    // A successful turn's result repeats its last message; only a failure's says something new.
    return { type: 'result', subtype, is_error, duration_ms, num_turns, total_cost_usd, ...(ev.is_error ? { result: ev.result } : {}) };
  }
  return null;
}

function describeActivity(ev: any): string | null {
  if (ev.type !== 'assistant') return null;
  const blocks: any[] = ev.message?.content ?? [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text.trim().split('\n')[0].replace(/\*\*|`/g, '').slice(0, 160);
    // The same plain words as the readout ("Ran the tests", "Edited app.js"), not "Using Bash".
    if (b.type === 'tool_use' && isWorkTool(b.name)) return activityLabel(b);
  }
  return null;
}

/** How a session can put files in front of people: links in its reply that the app turns into previews. */
function showingFiles(ticket: Ticket, filesDir: string | null, sharedDir: string | null): string[] {
  const where = filesDir ? `inside your working directory or in ${filesDir}` : 'inside your working directory';
  return [
    `You can show people files (documents, images, GIFs, videos, web pages, PDFs) by linking them in your reply with a path ${where}; the app turns those links into previews that open the file in place of the chat:`,
    '- `![caption](path)` shows an inline preview: use it for images, GIFs and videos.',
    '- `[title](path)` shows a card: use it for documents, web pages and PDFs.',
    filesDir
      ? `Put files you fetch from elsewhere or make only to show people (not part of the work in your branch) in ${filesDir}, so they never end up in a commit. Files elsewhere on disk can't be shown; copy them there first.`
      : '',
    'Linking a file is the only way people see it; they cannot browse your folders. Files you link are also listed in the scheme\'s artifacts, so link only what is meant for people, not files you made for your own use (test pages, scratch notes, fixtures).',
    sharedDir
      ? `${sharedDir} is a folder every minion in the scheme and the Taskmaster can read and write. Put handoffs, specs and notes that other minions should be able to find there (for example a handoff file a fresh minion can start from), and look there before starting related work. Keep scratch files, build output and secrets out of it. Documents and pages in it are listed as Shared in the scheme's artifacts.`
      : '',
  ].filter(Boolean);
}

/** The project's standing instructions, set by people in the app; last, so they read as the final word. */
function projectInstructions(project: Project): string[] {
  const text = project.instructions?.trim();
  if (!text) return [];
  return [
    '',
    `# Scheme instructions for "${project.name}"`,
    'People set these in the scheme\'s settings. They apply to every minion in the scheme and to the Taskmaster, and take precedence over the defaults above:',
    '',
    text,
  ];
}

export function systemPrompt(project: Project, ticket: Ticket, filesDir: string | null, sharedDir: string | null, ticketsDir: string, memoryDir: string | null, machines: Machine[] = []): string {
  if (ticket.kind === 'coordinator') return [coordinatorPrompt(project, ticketsDir, memoryDir), ...showingFiles(ticket, filesDir, sharedDir), ...projectInstructions(project)].join('\n');
  const where = ticket.branch
    ? `Your working directory is a dedicated git worktree of the scheme repo on branch \`${ticket.branch}\`. Commit your work to this branch; do not push or touch other branches unless asked.`
    : 'Your working directory is a dedicated folder for this minion.';
  return [
    `You are a minion working on #${ticket.number} "${ticket.title}" in scheme "${project.name}".`,
    `You are managed by ${APP_NAME}, a shared web app where several people chat with you. The scheme's Taskmaster is the Claude session that coordinates the scheme's minions.`,
    'Subagents you start with the Agent tool are called Grunts. When you brief a Grunt, include this line, since Grunts don\'t see this prompt:',
    ROLE_FRAMING,
    'Each user message starts with the sender\'s name in brackets, like "[Cara]: ...".',
    where,
    'People follow your work through a progress readout ("Running tests… 3/7") built from your task list, so for anything beyond a quick answer, plan the work with TaskCreate before starting it:',
    '- Make 3 to 7 tasks that are conceptual chunks someone skimming would follow ("Find where the sidebar text comes from", "Make the readout show phases", "Test it on a copy"), not individual commands.',
    '- Give each a one-sentence description of what it involves and why, and a short activeForm ("Finding where the sidebar text comes from").',
    '- Mark each task in_progress with TaskUpdate when you start it. When you finish it, mark it completed and set metadata.outcome to one plain sentence on what it found, decided or changed.',
    '- If the plan changes, add, reword or delete tasks so the list stays true.',
    'Tool calls and their output are not shown in the chat, only in that readout, so put anything people need to see in your reply text.',
    'When you need people to decide between clear options, ask with the `ask_question` tool (mcp__thread) instead of listing choices in prose: it shows a card they answer with a click. Then end your turn; the answers arrive as the next message.',
    'When people want to hear your plan before you build, post it with the `propose_plan` tool (mcp__thread): a card with Approve and Revise that only a person can approve. Then end your turn and write no code until the go arrives as the next message.',
    'The scheme\'s minions list groups minions by kind and shows each as one line: number, short title, state, note. Keep yours accurate with the `set_thread_status` tool (mcp__thread):',
    '- title: the short ask, about 30 characters ("Usage bar in the top bar"), no number, tag or emoji. Your starting title may just be the opening words of the first message; replace it early in your first turn with the short ask.',
    '- tag: feature, bug, design, process (tooling, prompts, docs, setup) or idea (exploring, no code yet). Set it once the kind of work is clear, following any scheme conventions, and change it if the work changes kind; leave it unset for one-off questions.',
    '- build: the major build number, only when the work has been assigned to one (the list groups a build\'s minions together).',
    'Your minion also carries properties from the scheme\'s property registry (`list_properties`, mcp__thread): a `type` (feature, bug, art, ideation, design, research, chore or other), a `stage`, and any keys the scheme registers. Set them with `set_properties` once the work is clear, and keep `type` right if the work changes kind (setting the tag sets the type too). Use only registered keys and values; aliases are fine. If nothing fits, set `type: other` and ask people with a card whether it stays `other` or moves to another bucket; for any other key, use `propose_property` instead of a near-duplicate. Show properties as `key: value`.',
    '- At the end of every turn, set state and note: state ready (done, ready to merge or pick up), try (ready for people to try), parked, blocked (on something outside the minion), outside (work still running elsewhere) or pending-deploy (deployed with tools/deploy.sh, not live yet), or null when you are simply waiting on an answer; note is one terse line, max 60 chars, on where things stand ("needs a pick: tabs or list"). The state clears when the next turn starts, except pending-deploy, which stays until you set another state: change it if a later turn starts new work.',
    'When your branch has an open GitHub pull request, the app watches it and messages you as "[GitHub]: ..." when CI on its head commit passes or fails, someone reviews or comments, or it is merged or closed, so you need not wait on CI in a turn; act on those messages as the scheme expects (fix a red build, answer a review).',
    'Give every Bash call a short plain-English description (like "Run the test suite").',
    'After you deploy with tools/deploy.sh, set state pending-deploy and do not call close_self: a successful deploy dismisses the minion once it is live and your turn has ended (the restart does not interrupt your turn), and a failed one leaves it open with the error.',
    'When the minion\'s work is done and should be dismissed with nothing to deploy, call the `close_self` tool (mcp__thread) near the end of your turn: the minion is dismissed once the turn ends, keeping its worktree and branch, and any new message reopens it. Do not dismiss a minion whose result is something for people to read (a report, research, write-up, plan or doc): leave it open in state ready until someone has read it and says it can be dismissed, even if its brief says to dismiss.',
    'You cannot message other minions directly. When something needs the scheme\'s Taskmaster (passing information to another minion, starting a new minion, a decision for it), message it with the `message_coordinator` tool (mcp__thread) with a self-contained message.',
    `Waiting on another minion's change to be deployed? Call the \`wake_when_live\` tool (mcp__thread) with its commit and a reason, set state parked and end your turn, instead of asking the Taskmaster to remember: ${APP_NAME} messages you once it is live.`,
    ...showingFiles(ticket, filesDir, sharedDir),
    ...machineTools(machines),
    ...approvalNote(project),
    'People read your replies in a web UI, often later. When you finish a turn, end with a short summary of what you did and, if you are blocked, exactly what you need from them.',
    ...projectInstructions(project),
  ].join('\n');
}

/** Which tool calls wait for a person's OK in this project. */
function approvalNote(project: Project): string[] {
  const rules = lines(project.approval_rules);
  const tripwire = 'Some tripwire blocks (deleting or changing files in the data dir, installing or enabling a user unit) can go to a person as an Approve / Deny card for that one exact Bash call, if its description explains why. Every card interrupts a person, so ask only when the work truly needs that call and nothing else does the job, and ask once. A card left waiting when your turn ends expires. If it is denied, do not retry it or get there another way: stop, and hand the commands to a person in your reply.';
  if (!rules.length) return [tripwire];
  return [
    tripwire,
    `In this scheme, tool calls matching these rules wait for a person to approve them in the chat before they run: ${rules.join(', ')}. Make such a call when the work is ready for it; the turn pauses until someone clicks Approve or Deny. If it is denied or expires, do not retry it or reach the same result another way; say what you needed it for.`,
  ];
}

/** Which people's computers lend this turn their MCP tools. */
function machineTools(machines: Machine[]): string[] {
  if (!machines.length) return [];
  const names = machines.map((m) => `${m.name} (mcp__${m.name})`).join(', ');
  return [
    `Connected machines: ${names}. Their MCP tools run on people's own computers, not on this server: files and builds there are separate from your working directory, so sync code there (for example with git) before building, and expect a tool to fail if that computer goes offline mid-turn.`,
    ...machines.filter((m) => m.notes).map((m) => `Notes on ${m.name} from its owner:\n${m.notes}`),
  ];
}

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
 * Two more folders are added with no deny rule, so acceptEdits lets the coordinator read and write
 * files in them (tried with a real run, the memory folder included; other shell commands are still
 * denied): the project's shared folder and the repo's Claude Code memory.
 */
export function coordinatorAccess(repoDir: string | null, ticketsDir: string, sharedDir: string | null = null, memoryDir: string | null = null): { addDirs: string[]; settings: { permissions: object } } {
  let ticketDirs: string[] = [];
  try {
    ticketDirs = readdirSync(ticketsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(ticketsDir, d.name));
  } catch {
    // No tickets yet.
  }
  const roots = repoDir ? [repoDir, ticketsDir] : [ticketsDir];
  const gitDirs = repoDir ? [repoDir, ...ticketDirs] : [];
  const writable = [sharedDir, memoryDir].filter((d): d is string => !!d);
  return {
    // Adding the parent tickets/ folder also covers worktrees made after the turn starts.
    addDirs: [...roots, ...writable],
    settings: {
      permissions: {
        // `//` makes the path absolute. Edit rules also cover Write, NotebookEdit and Bash commands that write there.
        deny: [...roots.map((d) => `Edit(/${d}/**)`), 'Bash(git * --output*)'],
        allow: gitDirs.flatMap((d) => READ_ONLY_GIT.map((c) => `Bash(git -C ${d} ${c})`)),
      },
    },
  };
}

function coordinatorPrompt(project: Project, ticketsDir: string, memoryDir: string | null): string {
  return [
    `You are the Taskmaster for scheme "${project.name}" in ${APP_NAME}, a shared web app where several people chat with Claude Code sessions called minions.`,
    ROLE_FRAMING,
    'People open the scheme and talk to you first. You keep track of the scheme\'s minions and manage them with the `coordinator` MCP tools: list_tickets, read_ticket, create_ticket, message_ticket, update_ticket, close_ticket, reopen_ticket and stop_ticket. When you park a minion that waits on another minion\'s deploy, call wake_when_live for it rather than remembering to wake it yourself.',
    `Properties: minions and their files carry properties from the property registry (list_properties). Global keys (type, stage, requestedBy) belong to the ${APP_NAME} scheme's Taskmaster; each scheme's Taskmaster registers its own keys and values. Every new minion gets properties in create_ticket, always with a \`type\` (feature, bug, art, ideation, design, research, chore; \`other\` when none fits, and then ask people with a card whether it stays \`other\` or moves to another bucket), plus any scheme keys that apply. Stage moves by itself (new → in-progress, dismissed → done). Fix them with set_properties. You may add a new distinct value to one of your scheme's keys with register_property_values when nothing fits (never a near-duplicate: add an alias instead); it is live at once but unreviewed, so say in your reply which values you added so people can approve or correct them. New keys (register_property_key) wait for a person. When a minion proposes a value, approve or reject it with review_property, and archive values that are no longer used. Show properties as \`key: value\`, since one word can be a value of two keys. The scheme's shared property-vocabulary.md is generated from the registry: never edit it.`,
    'The scheme instructions (shown at the end of this prompt when set) reach you and every minion on its next turn. When people ask you to add, change or drop a standing rule for the whole scheme, read the current text with get_project_instructions and save the full new text with set_project_instructions; tell them what changed.',
    'Each minion is a separate Claude Code session with its own git worktree and branch. Hand real work (code changes, investigations) to minions rather than doing it yourself; give each new minion a self-contained first message, since it cannot see this conversation.',
    'Minion titles are the short ask, about 30 characters ("Usage bar in the top bar"), with no number, tag or emoji; the app shows the number and the minions label themselves as they work. Give each new minion a tag too when one fits: feature, bug, design, process (tooling, prompts, docs, setup) or idea (exploring, no code yet). You can fix a minion\'s title, tag, state or note with update_ticket, and assign it to a major build with its build field (the minions list groups each build\'s minions together; null takes it out).',
    'Minions run in the background. To see progress, read them; do not wait or poll in a loop. Dismiss minions when people agree they are done.',
    project.repo_dir
      ? `The scheme's main checkout is at ${project.repo_dir} and minion worktrees are under ${ticketsDir} (one folder per minion). You may read them for context, but do not edit, commit or switch branches there: edits there are denied. Search and read them with Read and with read-only Bash such as \`grep -rn … | head\`; for git, use \`git -C <folder> log\` (or status, diff, show, blame, branch -a), since \`cd <folder> && git …\` is denied.`
      : `This scheme has no git repo; each minion gets a plain folder under ${ticketsDir}. You may read them for context, but do not edit them: edits there are denied.`,
    memoryDir
      ? `You can read and write files (Read, Write, Edit) in the scheme's shared folder, described below, and in ${memoryDir}, the scheme's Claude Code memory that its minions load too. Keep what is worth remembering across conversations in the memory as short topic files with an index in MEMORY.md. You still cannot run shell commands.`
      : '',
    'When you need people to decide between clear options, ask with your `ask_question` tool: it shows a card in this chat they answer with a click. Then end your turn; the answers arrive as the next message.',
    'Minions can message you with their `message_coordinator` tool; those arrive named by the minion, like "[#12 Some title]: ...". Do what they ask when it is yours to do (relay to another minion with message_ticket, start a minion from a handoff), and do not reply to a minion just to acknowledge it.',
    'Each user message starts with the sender\'s name in brackets, like "[Cara]: ...". People read your replies in a web UI, often later, so keep them short and end each turn with what you did and what, if anything, you need from them.',
  ].join('\n');
}

/** Extra process setup for coordinator turns: how its MCP server reaches the API. */
export type CoordinatorEnv = (ticket: Ticket) => Record<string, string>;

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

export class Runner {
  private turns = new Map<number, LiveTurn>();
  private queues = new Map<number, QueuedMessage[]>();
  /** Tickets that asked to close when their current turn ends, with the reason they gave. */
  private closing = new Map<number, string | null>();
  /** Minions whose deploy went live mid-turn: dismissed when that turn ends, if still pending-deploy. */
  private deployedMidTurn = new Set<number>();
  private progress = new Map<number, ReturnType<typeof createProgress>>();
  private store: Store;
  private broadcast: Broadcast;
  private claudeBin: string;
  private coordinatorEnv: CoordinatorEnv;
  /** The clock the loop guard's window runs on; tests move it. */
  now = () => Date.now();
  /** Gap between auto-resumes after a restart, so they don't all start at once. */
  resumeGapMs = 3000;
  /** How often a running turn's stream file is read. */
  pollMs = 250;
  /** Run turns in transient systemd user units, which outlive this server, rather than as its children. */
  units = false;
  /** Where turn folders go: beside the database, so a test's or dev copy's never mix with the live ones. */
  turnsDir: string;
  /** Tells this server's turn units apart from another server's (a dev copy) on the same user manager. */
  private unitTag: string;
  /** A folder outside the repo where a ticket can put files it fetched or made to show people. */
  filesDir: (ticket: Ticket) => string | null = () => null;
  /** The folder every thread and the coordinator of a project can read and write, for handoffs and notes. */
  sharedDir: (project: Project) => string | null = () => null;
  /** The folder that holds a project's ticket folders, which the coordinator may read. */
  ticketsDir: (project: Project) => string = (project) => join(project.repo_dir ?? '.', '..', 'tickets');
  /** Machines online now and granted to the project; a thread's turn gets each one's MCP tools. */
  machines: (project: Project) => Machine[] = () => [];
  /** Called after each tool result and at the end of each turn, when files on disk may have changed. */
  onFilesMayChange: (ticketId: number) => void = () => {};
  /** Called when a turn's process has exited, however the turn ended. */
  onTurnEnd: (ticketId: number) => void = () => {};
  /** Approve / Deny cards waiting on people, for projects with approval rules. */
  approvals: Approvals;
  /** Called when a turn fails (not when someone stops it), with the error shown in the chat. */
  onTurnError: (ticketId: number, text: string) => void = () => {};

  constructor(store: Store, broadcast: Broadcast, coordinatorEnv: CoordinatorEnv, claudeBin = 'claude') {
    this.store = store;
    this.broadcast = broadcast;
    this.approvals = new Approvals((ticketId, kind, data) => {
      this.emit(ticketId, kind, data);
      // The threads list shows which threads are waiting on an approval.
      this.broadcastTicket(ticketId);
    });
    this.coordinatorEnv = coordinatorEnv;
    this.claudeBin = claudeBin;
    this.turnsDir = join(dirname(store.path), 'run', 'turns');
    this.unitTag = createHash('sha256').update(this.turnsDir).digest('hex').slice(0, 8);
  }

  isRunning(ticketId: number): boolean {
    return this.turns.has(ticketId);
  }

  /** Running turns a restart of this server would kill: those not in a unit of their own. */
  interruptible(): number {
    return [...this.turns.values()].filter((t) => !t.unit).length;
  }

  /** Stop following turns, for a server shutting down; they keep running, and the next server re-attaches. */
  detachAll() {
    for (const t of this.turns.values()) {
      clearInterval(t.timer);
      clearTimeout(t.stopTimer);
    }
    this.turns.clear();
  }

  queued(ticketId: number): number {
    return this.queues.get(ticketId)?.length ?? 0;
  }

  /** A ticket as the API shows it: plus queued messages and its task-list steps. */
  view(ticket: Ticket) {
    const { total, done } = stepInfo(this.progressFor(ticket.id));
    return {
      ...ticket, queued: this.queued(ticket.id), steps: total ? { done, total } : null, closing: this.closing.has(ticket.id),
      approvals: this.approvals.waiting(ticket.id), properties: this.store.props.forTarget('minion', ticket.id),
      // What "Default" means in the composer: the effort a turn gets when the ticket has none of its own.
      default_effort: turnSettings({ ...ticket, effort: null }, this.store.getProject(ticket.project_id) ?? { default_effort: '' }).effort,
    };
  }

  /** Close a ticket that is not running. Its worktree and branch are kept. */
  close(ticketId: number, text: string) {
    this.setStatus(ticketId, 'closed');
    this.emit(ticketId, 'note', { text });
  }

  /**
   * A deploy this minion queued is live (tools/deploy.sh reported ok). A minion waiting on it in state
   * pending-deploy is dismissed, unless something is still open: a question card, or a failed last turn.
   * Mid-turn or with messages queued (approval cards only exist mid-turn), it waits for the last of
   * those turns to end. Returns whether it was dismissed.
   */
  deployLive(ticketId: number): boolean {
    if (this.isRunning(ticketId) || this.queued(ticketId)) {
      this.deployedMidTurn.add(ticketId);
      if (this.isRunning(ticketId)) this.saveTurn(ticketId, { deployed: true });
      return false;
    }
    const t = this.store.getTicket(ticketId);
    // shortcut: also takes the interim "outside" + "pending deploy" note, for minions that deployed before this state existed; drop it once none are left.
    const pending = t?.state === 'pending-deploy' || (t?.state === 'outside' && /pending deploy/i.test(t.note ?? ''));
    if (!t || t.status === 'closed' || t.status === 'error' || !pending) return false;
    const events = this.store.listEvents(ticketId);
    const answered = new Set(events.map((e) => e.kind === 'user_message' && JSON.parse(e.data).answer?.questionId).filter(Boolean));
    if (events.some((e) => e.kind === 'question' && !answered.has(JSON.parse(e.data).id))) {
      this.emit(ticketId, 'note', { text: 'The deploy is live, but a question card is still open, so this minion stays open.' });
      return false;
    }
    this.store.updateTicket(ticketId, { state: null });
    this.close(ticketId, 'The deploy is live, so it dismissed this minion.');
    return true;
  }

  /**
   * Close a running ticket once its current turn finishes cleanly. A turn that fails or is
   * stopped, or a message that arrives during it, leaves the ticket open instead.
   */
  closeAfterTurn(ticketId: number, reason: string | null): boolean {
    if (!this.isRunning(ticketId)) return false;
    this.closing.set(ticketId, reason);
    this.saveTurn(ticketId, { closing: reason });
    this.broadcastTicket(ticketId);
    return true;
  }

  /**
   * After a server restart: re-attach to turns still running in their units (or that ended while the
   * server was down), and catch up on their output. Turns whose process died too were cut off: mark
   * them, and resume them a few seconds apart unless they were stopped, set to close, or already
   * resumed MAX_RESUMES times in a row. Messages queued behind a cut-off turn go into its resume (or,
   * for one not resumed, into a turn of their own). A turn that failed (the usage limit included)
   * ended before the restart, so it isn't 'running'.
   */
  recover() {
    const later: (() => void)[] = [];
    for (const p of this.store.listProjects()) {
      for (const t of this.store.listTickets(p.id)) {
        if (t.status === 'running') {
          // Waiting cards lived in the old server's memory; nobody's click can count for them now.
          for (const id of unsettledCards(this.store.listEvents(t.id))) {
            this.emit(t.id, 'approval_result', { id, state: 'expired', reason: 'The server restarted while this waited.' });
          }
          const turn = this.store.getSetting<TurnState>(turnKey(t.id));
          try {
            if (turn?.dir && this.reattach(t.id, turn)) continue;
          } catch (err: any) {
            console.error(`Ticket ${t.id}: could not re-attach to its turn, so it counts as interrupted:`, err);
          }
          this.store.deleteSetting(turnKey(t.id));
          if (turn?.dir) rmSync(turn.dir, { recursive: true, force: true });
          this.setStatus(t.id, 'idle');
          // Stopped on purpose: it already says so, and nothing queued survives a stop.
          if (turn?.stopped) continue;
          if (turn?.queued?.length) this.queues.set(t.id, turn.queued);
          const resumes = turn?.resumes ?? 0;
          let skipped: string | null = null;
          if (turn && 'closing' in turn) skipped = 'It was set to be dismissed, so it was not resumed.';
          else if (resumes >= MAX_RESUMES) skipped = `It was not resumed: it had already been resumed ${resumes} times in a row.`;
          if (skipped) {
            this.emit(t.id, 'note', { text: `The server restarted during this turn, so it was interrupted. ${skipped}` });
            if (this.queued(t.id)) later.push(() => !this.isRunning(t.id) && this.next(t.id));
          } else {
            later.push(() => this.resume(t.id, resumes + 1));
          }
        }
        if (/^Using \w+$/.test(t.last_activity ?? '')) {
          // Reword lines saved before activity was described in plain words.
          const events = this.store.listEvents(t.id);
          for (let i = events.length - 1; i >= 0; i--) {
            const activity = events[i].kind === 'claude' ? describeActivity(JSON.parse(events[i].data)) : null;
            if (activity) {
              this.store.setLastActivity(t.id, activity);
              break;
            }
          }
        }
      }
    }
    later.forEach((start, i) => setTimeout(start, this.resumeGapMs * (i + 1)));
    // Folders of turns nobody follows any more and whose process is gone.
    try {
      const followed = new Set([...this.turns.values()].map((t) => t.dir));
      for (const name of readdirSync(this.turnsDir)) {
        const dir = join(this.turnsDir, name);
        if (!followed.has(dir) && !wrapperAlive(dir)) rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // No turns yet.
    }
  }

  /** Follow a turn a previous server started, if it still runs or ended while no server watched it. */
  private reattach(ticketId: number, turn: TurnState): boolean {
    const live = this.follow(ticketId, turn);
    if (!existsSync(join(live.dir, 'exit.json')) && !this.running(live)) {
      clearInterval(live.timer);
      this.turns.delete(ticketId);
      return false;
    }
    if (turn.queued?.length) this.queues.set(ticketId, turn.queued);
    if ('closing' in turn) this.closing.set(ticketId, turn.closing ?? null);
    if (turn.deployed) this.deployedMidTurn.add(ticketId);
    console.log(`Ticket ${ticketId}: re-attached to its running turn${live.unit ? ` in ${live.unit}` : ''}.`);
    return true;
  }

  /** Whether a followed turn's process may still be running: started, or still starting. */
  private running(live: LiveTurn): boolean {
    return wrapperAlive(live.dir) ?? Date.now() - live.startedAt < 60_000;
  }

  /** Start an auto-resume turn, with any messages that were queued behind the cut-off one. */
  private resume(ticketId: number, resumes: number) {
    // Someone's message got in first; its turn took the queue, and that is resume enough.
    if (this.isRunning(ticketId)) return;
    const ticket = this.store.getTicket(ticketId);
    const project = ticket && this.store.getProject(ticket.project_id);
    if (!ticket || !project || ticket.status === 'closed') return;
    this.emit(ticketId, 'note', { text: 'Resumed after a server restart' });
    const batch = this.queues.get(ticketId)?.splice(0) ?? [];
    this.startTurn(project, ticket, promptMessage([{ author: 'System', text: RESUME_PROMPT, images: [] }, ...batch]), resumes);
  }

  /** Merge into the saved state of a ticket's running turn. */
  private saveTurn(ticketId: number, patch: Partial<TurnState>) {
    const turn = this.store.getSetting<TurnState>(turnKey(ticketId)) ?? { resumes: 0 };
    this.store.setSetting(turnKey(ticketId), { ...turn, ...patch });
  }

  /** Record a user message and run it now, or queue it behind the current turn. */
  /**
   * `extra` is stored with the message for the UI (e.g. which question card it answers), not sent
   * to Claude; a comment's file (`extra.comment.about`) is, in its "[Name on file]:" prefix.
   */
  send(ticketId: number, author: string, text: string, images: MessageImage[] = [], extra: { comment?: { about: string } } & object = {}) {
    this.emit(ticketId, 'user_message', { author, text, ...(images.length ? { images: images.map((i) => i.name) } : {}), ...extra });
    const q = this.queues.get(ticketId) ?? [];
    q.push({ author, text, images, about: extra.comment?.about });
    this.queues.set(ticketId, q);
    if (!this.isRunning(ticketId)) return this.next(ticketId);
    this.saveTurn(ticketId, { queued: q });
    this.broadcastTicket(ticketId);
  }

  /**
   * A message between a minion and its Taskmaster, either way (`to` is the receiving ticket). Up to
   * LOOP_LIMIT per LOOP_WINDOW_MS go through; after that each is held, with a note in both chats asking
   * a person to continue, until continueLoop. Returns whether it was held.
   */
  relay(minionId: number, to: number, author: string, text: string): boolean {
    const loop = this.store.getSetting<LoopState>(loopKey(minionId)) ?? { sent: [], held: [] };
    const now = this.now();
    loop.sent = loop.sent.filter((t) => now - t < LOOP_WINDOW_MS);
    if (!loop.held.length && loop.sent.length < LOOP_LIMIT) {
      loop.sent.push(now);
      this.store.setSetting(loopKey(minionId), loop);
      this.send(to, author, text);
      return false;
    }
    loop.held.push({ to, author, text });
    this.store.setSetting(loopKey(minionId), loop);
    const minion = this.store.getTicket(minionId)!;
    const what = `${to === minionId ? `the ${AGENT_NAME}'s message to #${minion.number}` : `#${minion.number}'s message to the ${AGENT_NAME}`} ("${text.length > 140 ? text.slice(0, 140) + '…' : text}")`;
    const note = loop.held.length === 1
      ? `Paused: #${minion.number} and the ${AGENT_NAME} have exchanged ${LOOP_LIMIT} messages in the last hour, so ${what} is held until a person continues.`
      : `Also held: ${what}.`;
    for (const id of this.loopChats(minion)) this.emit(id, 'loop_paused', { minion: minionId, text: note });
    return true;
  }

  /**
   * A person continued a minion paused by the loop guard, or wrote into its chat or its Taskmaster's:
   * the held messages go through in order and its count starts again. Returns how many were held.
   */
  continueLoop(minionId: number, by: string): number {
    const loop = this.store.getSetting<LoopState>(loopKey(minionId));
    if (!loop) return 0;
    this.store.deleteSetting(loopKey(minionId));
    if (!loop.held.length) return 0;
    const n = loop.held.length;
    const text = `${by} continued, so ${n === 1 ? 'the held message' : `the ${n} held messages`} went through.`;
    for (const id of this.loopChats(this.store.getTicket(minionId)!)) this.emit(id, 'loop_continued', { minion: minionId, by, text });
    for (const m of loop.held) this.send(m.to, m.author, m.text);
    return n;
  }

  /** The chats a loop-guard note shows in: the minion's and its Taskmaster's. */
  private loopChats(minion: Ticket): number[] {
    const coordinator = this.store.getCoordinator(minion.project_id);
    return coordinator ? [minion.id, coordinator.id] : [minion.id];
  }

  stop(ticketId: number): boolean {
    const live = this.turns.get(ticketId);
    if (!live) return false;
    this.queues.delete(ticketId);
    this.saveTurn(ticketId, { stopped: true, queued: [] });
    this.emit(ticketId, 'note', { text: 'Stopped by user.' });
    this.signal(live, 'SIGTERM');
    // A turn that ignores the stop (or hadn't started claude yet) gets killed.
    clearTimeout(live.stopTimer);
    live.stopTimer = setTimeout(() => this.turns.get(ticketId) === live && this.signal(live, 'SIGKILL'), 15_000);
    live.stopTimer.unref();
    return true;
  }

  /** Signal a turn's claude and, as it runs in its own process group, its tool subprocesses too. */
  private signal(live: LiveTurn, sig: NodeJS.Signals) {
    let pid = 0;
    try {
      pid = JSON.parse(readFileSync(join(live.dir, 'pid.json'), 'utf8')).claude;
    } catch {
      // Not started yet.
    }
    if (pid) {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          process.kill(pid, sig);
        } catch {
          // Already gone.
        }
      }
    }
    // A unit's other processes (claude not started yet, or something it left behind) go with the unit.
    if (live.unit && (!pid || sig === 'SIGKILL')) execFile('systemctl', ['--user', 'stop', live.unit], () => {});
  }

  private next(ticketId: number) {
    const q = this.queues.get(ticketId);
    if (!q?.length) return;
    // Everything queued while the last turn ran goes into one turn.
    const batch = q.splice(0);
    const ticket = this.store.getTicket(ticketId);
    const project = ticket && this.store.getProject(ticket.project_id);
    if (!ticket || !project) return;
    this.startTurn(project, ticket, promptMessage(batch));
  }

  private startTurn(project: Project, ticket: Ticket, prompt: string, resumes = 0) {
    // deploy/prune.sh removes worktrees of long-closed minions; a reopened one gets its back.
    try {
      if (restoreTicketDir(ticket.cwd, project.repo_dir, ticket.branch)) this.emit(ticket.id, 'note', { text: `Recreated this minion's worktree from its branch ${ticket.branch}.` });
    } catch (err: any) {
      this.emit(ticket.id, 'note', { text: `Could not recreate the worktree: ${err.message}` });
    }
    let filesDir = this.filesDir(ticket);
    try {
      if (filesDir) mkdirSync(filesDir, { recursive: true });
    } catch {
      filesDir = null;
    }
    let sharedDir = this.sharedDir(project);
    try {
      if (sharedDir) mkdirSync(sharedDir, { recursive: true });
    } catch {
      sharedDir = null;
    }
    // Claude Code keeps auto-memory under the main checkout's folder, shared by the project's worktrees.
    let memoryDir = project.repo_dir && ticket.kind === 'coordinator' ? join(claudeConfigDir(process.env), 'projects', projectSlug(project.repo_dir), 'memory') : null;
    try {
      if (memoryDir) mkdirSync(memoryDir, { recursive: true });
    } catch {
      memoryDir = null;
    }
    // Threads (not the coordinator, which hands work off) get the tools of the scheme's machines online now.
    const machines = ticket.kind === 'coordinator' ? [] : this.machines(project);
    // Tool calls matching the project's approval rules wait for a person (threads only).
    const rules = ticket.kind === 'coordinator' ? [] : lines(project.approval_rules);
    // The turn's folder, with its own copy of the pinned files: a restart sweeps the server's copy, and
    // the tripwire hook must still be there for a turn that outlives it.
    const dir = join(this.turnsDir, `${ticket.id}-${Date.now()}`);
    const pin = join(dir, 'pin');
    mkdirSync(dir, { recursive: true });
    cpSync(MCP_DIR, pin, { recursive: true });
    const pinned = (file: string) => join(pin, basename(file));
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', ticket.permission_mode,
      '--append-system-prompt', systemPrompt(project, ticket, filesDir, sharedDir, this.ticketsDir(project), memoryDir, machines),
      // A minion's tripwire asks and approval rules become Approve / Deny cards; nobody can answer a
      // Taskmaster's prompts, so those are denied instead of waiting.
      ...permissionArgs(ticket.kind !== 'coordinator'),
    ];
    // Lets edit-only sessions write there too, not just in their working directory.
    const addDirs = [filesDir, sharedDir].filter((d): d is string => !!d);
    // One --settings per turn: the tripwire hook, plus approval rules or the Taskmaster's access rules.
    const settings: { permissions?: object; hooks: object } = { hooks: tripwireHooks(project.id, claudeConfigDir(process.env), ticket.kind !== 'coordinator', pinned(TRIPWIRE)) };
    if (rules.length) settings.permissions = { ask: rules };
    if (ticket.kind === 'coordinator') {
      const access = coordinatorAccess(project.repo_dir, this.ticketsDir(project), sharedDir, memoryDir);
      addDirs.push(...access.addDirs.filter((d) => !addDirs.includes(d)));
      settings.permissions = access.settings.permissions;
    }
    args.push('--settings', JSON.stringify(settings));
    if (addDirs.length) args.push('--add-dir', ...addDirs);
    if (ticket.kind !== 'coordinator') args.push(...pluginDirArgs(lines(project.plugin_dirs), ticket.cwd));
    if (ticket.session_id) args.push('--resume', ticket.session_id);
    const { model, effort } = turnSettings(ticket, project);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    // The task-list tools (TaskCreate/TaskUpdate) are off by default in headless mode; they drive the progress readout.
    let env: Record<string, string> = { ...turnEnv(process.env), CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', CLAUDE_CODE_AUTO_COMPACT_WINDOW: AUTO_COMPACT_WINDOW };
    // The coordinator gets tools to manage the project's tickets; a ticket gets one to set its own
    // title, tag, state and note. The token travels in the environment (which the MCP server
    // inherits), never on the command line.
    const role = ticket.kind === 'coordinator' ? 'coordinator' : 'thread';
    const servers: Record<string, object> = { [role]: { type: 'stdio', command: process.execPath, args: [pinned(MCP_SERVER)] } };
    for (const m of machines) servers[m.name] = { type: 'stdio', command: process.execPath, args: [pinned(MACHINE_MCP_SERVER), String(m.id), m.name] };
    const allowed = Object.keys(servers).map((name) => `mcp__${name}`);
    // The built-in AskUserQuestion can't be answered in headless mode; ask_question shows a card instead.
    args.push('--mcp-config', JSON.stringify({ mcpServers: servers }), '--allowedTools', ...allowed, '--disallowedTools', 'AskUserQuestion');
    env = { ...env, ...this.coordinatorEnv(ticket), COORDINATOR_ROLE: role, COORDINATOR_TICKET: String(ticket.id) };
    // For plugins and hooks: the folders the prompt names (Delve's mod writes its retro log there).
    if (sharedDir) env.COORDINATOR_SHARED_DIR = sharedDir;
    if (filesDir) env.COORDINATOR_FILES_DIR = filesDir;
    // The thread's MCP server offers the approval tool, which holds its call open until someone clicks.
    if (ticket.kind !== 'coordinator') env = { ...env, COORDINATOR_APPROVALS: '1', MCP_TOOL_TIMEOUT: String(APPROVAL_TIMEOUT_MS) };
    // A state describes where the last turn left things; a new turn makes it stale. Pending-deploy
    // outlasts a stray turn, so the deploy still dismisses the minion unless the turn sets another state.
    if (ticket.state && ticket.state !== 'pending-deploy') this.store.updateTicket(ticket.id, { state: null });

    // The session's transcript, task list and memory live in the database too; put back anything this
    // config dir lacks (another account, a fresh machine) before resuming.
    const configDir = claudeConfigDir(env);
    try {
      const restored = restoreSession(this.store, ticket, project, configDir);
      if (restored) console.log(`Ticket ${ticket.id}: restored the Claude session from the database (${restored} file${restored === 1 ? '' : 's'}).`);
    } catch (err: any) {
      this.emit(ticket.id, 'note', { text: `Could not restore the session from the database: ${err.message}` });
    }

    writeFileSync(join(dir, 'prompt.jsonl'), prompt);
    for (const f of ['stream.jsonl', 'stderr.log']) writeFileSync(join(dir, f), '');
    // Holds the turn's token: private, and the wrapper deletes it once read.
    writeFileSync(join(dir, 'spec.json'), JSON.stringify({ command: this.claudeBin, args, cwd: ticket.cwd, env }), { mode: 0o600 });
    const unit = this.units ? `citadel-turn-${this.unitTag}-${basename(dir)}` : null;
    const turn: TurnState = { resumes, dir, unit, offset: 0, startedAt: Date.now(), configDir, chosenEffort: !!ticket.effort };
    this.store.setSetting(turnKey(ticket.id), turn);
    const live = this.follow(ticket.id, turn);
    this.setStatus(ticket.id, 'running');
    const wrapper = [process.execPath, pinned(TURN_WRAPPER), dir];
    if (!unit) return this.spawnWrapper(wrapper, dir);
    const run = ['--user', '--collect', '--quiet', `--unit=${unit}`, `--slice=${TURN_SLICE}`, '-p', 'TimeoutStopSec=15', '-p', 'UMask=0077', ...wrapper];
    execFile('systemd-run', run, (err, _out, stderr) => {
      if (!err) return;
      console.error(`Ticket ${ticket.id}: systemd-run failed (${String(stderr).trim() || err.message}), so this turn runs as a child of the server.`);
      live.unit = null;
      this.saveTurn(ticket.id, { unit: null });
      this.spawnWrapper(wrapper, dir);
    });
  }

  /** Start a turn's wrapper as a detached child: no unit, so it dies when the service restarts. */
  private spawnWrapper([command, ...args]: string[], dir: string) {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => writeFileSync(join(dir, 'exit.json'), JSON.stringify({ code: null, signal: null, error: err.message })));
    child.unref();
  }

  /** Start tailing a turn's folder; the turn counts as running from here until finish(). */
  private follow(ticketId: number, turn: TurnState): LiveTurn {
    const live: LiveTurn = {
      dir: turn.dir!, unit: turn.unit ?? null, offset: turn.offset ?? 0, startedAt: turn.startedAt ?? Date.now(),
      configDir: turn.configDir ?? claudeConfigDir(process.env), chosenEffort: !!turn.chosenEffort, ticks: 0,
      timer: setInterval(() => this.poll(ticketId), this.pollMs),
    };
    this.turns.set(ticketId, live);
    return live;
  }

  private poll(ticketId: number) {
    const live = this.turns.get(ticketId);
    if (!live) return;
    try {
      // Checked before reading: once exit.json is there, everything claude wrote is in the stream.
      const exited = existsSync(join(live.dir, 'exit.json'));
      this.readStream(ticketId, live, exited);
      if (exited) return this.finish(ticketId, live, JSON.parse(readFileSync(join(live.dir, 'exit.json'), 'utf8')));
      // Gone without a word: killed with its unit (out of memory, say).
      if (++live.ticks % 20 === 0 && !this.running(live)) {
        this.readStream(ticketId, live, true);
        this.finish(ticketId, live, null);
      }
    } catch (err: any) {
      console.error(`Ticket ${ticketId}: following its turn failed:`, err);
    }
  }

  /** Handle the stream's new complete lines, and with `toEnd` a last line without its newline. */
  private readStream(ticketId: number, live: LiveTurn, toEnd: boolean) {
    let fd: number;
    try {
      fd = openSync(join(live.dir, 'stream.jsonl'), 'r');
    } catch {
      return;
    }
    try {
      let size = 1 << 20;
      for (;;) {
        const buf = Buffer.alloc(size);
        const n = readSync(fd, buf, 0, size, live.offset);
        if (!n) return;
        const atEnd = n < size;
        const end = buf.lastIndexOf(10, n - 1) + 1;
        if (!end && !atEnd) {
          size *= 2; // one line longer than the buffer
          continue;
        }
        const take = toEnd && atEnd ? n : end;
        if (!take) return;
        const base = live.offset;
        for (let start = 0; start < take; ) {
          const nl = buf.indexOf(10, start);
          const stop = nl < 0 || nl >= take ? take : nl;
          const line = buf.toString('utf8', start, stop);
          start = stop + 1;
          try {
            this.handleLine(ticketId, line, (error, text) => this.saveTurn(ticketId, { result: { error, text } }));
          } catch (err: any) {
            this.emit(ticketId, 'note', { text: `Could not process output line: ${err.message}` });
          }
          // Saved per line, so a restart carries on from the next one: nothing shown twice or skipped.
          live.offset = base + Math.min(start, take);
          this.saveTurn(ticketId, { offset: live.offset });
        }
        if (atEnd) return;
      }
    } finally {
      closeSync(fd);
    }
  }

  /** A turn's process has exited (exit is null when it was killed without recording how). */
  private finish(ticketId: number, live: LiveTurn, exit: { code: number | null; signal: string | null; error?: string } | null) {
    clearInterval(live.timer);
    clearTimeout(live.stopTimer);
    this.turns.delete(ticketId);
    const turn = this.store.getSetting<TurnState>(turnKey(ticketId));
    this.store.deleteSetting(turnKey(ticketId));
    const stopped = !!turn?.stopped;
    const code = exit?.code ?? null;
    const signal = exit ? exit.signal : 'SIGKILL';
    if (exit?.error) this.emit(ticketId, 'error', { text: `Could not start claude: ${exit.error}` });
    if (!exit && !stopped) this.emit(ticketId, 'note', { text: 'The turn\'s process was killed before it finished.' });
    const sawResult = !!turn?.result;
    const resultIsError = !!turn?.result?.error;
    const resultError = turn?.result?.error ? turn.result.text : null;
    let stderr: string[] = [];
    try {
      stderr = readFileSync(join(live.dir, 'stderr.log'), 'utf8').split('\n').filter(Boolean);
    } catch {
      // No stderr.
    }
    this.approvals.endTurn(ticketId, stopped ? 'The turn was stopped while this waited.' : 'The turn ended while this waited.');
    let status: 'idle' | 'error' = 'idle';
    if (stopped || signal) {
      // Stopped by the user; leave it waiting for the next message.
    } else if (!sawResult || code !== 0 || resultIsError) {
      status = 'error';
      const detail = stderr.slice(-10).join('\n');
      const text = `claude exited with code ${code}${detail ? `:\n${detail}` : ''}`;
      this.emit(ticketId, 'error', { text });
      this.onTurnError(ticketId, resultError ?? text);
      // Waiting on the usage window, not stuck; the note keeps Claude's words on when it resets.
      if (resultError && USAGE_LIMIT.test(resultError) && this.store.getTicket(ticketId)?.state !== 'pending-deploy') {
        this.store.updateTicket(ticketId, { state: 'limited', note: resultError });
      }
    }
    const closing = this.closing.has(ticketId);
    const reason = this.closing.get(ticketId);
    this.closing.delete(ticketId);
    if (closing && status === 'idle' && !stopped && !signal && !this.queued(ticketId)) {
      this.close(ticketId, `Claude dismissed this minion${reason ? `: ${reason}` : '.'}`);
    } else {
      if (closing && status === 'idle' && !stopped && !signal) {
        this.emit(ticketId, 'note', { text: 'Claude asked to dismiss this minion, but a new message arrived, so it stays open.' });
      }
      this.setStatus(ticketId, status);
    }
    // A failed or stopped turn leaves it open; a queued message makes deployLive wait for that turn too.
    if (this.deployedMidTurn.delete(ticketId) && status === 'idle' && !stopped && !signal && !closing) this.deployLive(ticketId);
    rmSync(live.dir, { recursive: true, force: true });
    this.onFilesMayChange(ticketId);
    this.onTurnEnd(ticketId);
    // Re-read the ticket: the turn may have given it its first (or a new) session id.
    const after = this.store.getTicket(ticketId);
    const project = after && this.store.getProject(after.project_id);
    // Only a turn that ran on Claude Code's default effort says what "Default" means for this thread.
    const effort = after && !live.chosenEffort && lastEffort(after, live.configDir);
    if (after && effort && effort !== after.last_effort) {
      this.store.updateTicketQuietly(ticketId, { last_effort: effort });
      this.broadcastTicket(ticketId);
    }
    if (after && project) {
      saveSession(this.store, after, project, live.configDir, true)
        .catch((err) => console.error(`Saving the session of ticket ${ticketId} failed:`, err));
    }
    this.next(ticketId);
  }

  private handleLine(ticketId: number, line: string, onResult: (isError: boolean, result: string | null) => void) {
    if (!line.trim()) return;
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      this.emit(ticketId, 'note', { text: line });
      return;
    }
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'rate_limit_event') this.updateUsage(ev.rate_limit_info);
    if (DROPPED_TYPES.has(ev.type)) return;
    if (ev.session_id && ev.session_id !== this.store.getTicket(ticketId)?.session_id) {
      this.store.updateTicket(ticketId, { session_id: ev.session_id });
    }
    if (ev.type === 'result') onResult(!!ev.is_error, typeof ev.result === 'string' ? ev.result : null);
    // Likewise the model: remembered from turns that ran without one chosen.
    const t = ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string' ? this.store.getTicket(ticketId) : null;
    if (t && !t.model && ev.model !== t.last_model) {
      this.store.updateTicketQuietly(ticketId, { last_model: ev.model });
      this.broadcastTicket(ticketId);
    }
    if (ev.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.mcp_servers)) this.checkMcp(ticketId, ev.mcp_servers);
    const slim = slimEvent(ev);
    if (!slim) return;
    const progress = this.progressFor(ticketId);
    applyEvent(progress, 'claude', slim);
    const activity = progress.tasks.length ? progressLine(progress, ev.type !== 'result') : describeActivity(ev);
    if (activity && activity !== this.store.getTicket(ticketId)?.last_activity) {
      this.store.updateTicket(ticketId, { last_activity: activity });
      // Keep the board's progress line live, not just on status changes.
      this.broadcastTicket(ticketId);
    }
    this.emit(ticketId, 'claude', slim);
    if (ev.type === 'user' && Array.isArray(ev.message?.content) && ev.message.content.some((b: any) => b?.type === 'tool_result')) {
      this.onFilesMayChange(ticketId);
    }
  }

  /**
   * Say so in the chat (as an error, which pushes) when the turn's own MCP server didn't connect:
   * without it a minion can't set its status or ask questions, and a Taskmaster can't manage minions.
   */
  private checkMcp(ticketId: number, servers: any[]) {
    const role = this.store.getTicket(ticketId)?.kind === 'coordinator' ? 'coordinator' : 'thread';
    const status = servers.find((s) => s?.name === role)?.status;
    // Pending: still starting after Claude Code's startup wait; it may yet connect.
    if (status === 'connected' || status === 'pending') return;
    const text = `The ${role} MCP server is ${typeof status === 'string' ? status : 'missing'} in this turn, so its mcp__${role} tools are unavailable. Check the server log.`;
    console.error(`Ticket ${ticketId}: ${text}`);
    this.emit(ticketId, 'error', { text });
    this.onTurnError(ticketId, text);
  }

  /** Task-list state for a ticket, rebuilt from its stored events the first time it is needed. */
  private progressFor(ticketId: number) {
    let p = this.progress.get(ticketId);
    if (!p) {
      p = createProgress();
      for (const row of this.store.listEvents(ticketId)) applyEvent(p, row.kind, JSON.parse(row.data));
      this.progress.set(ticketId, p);
    }
    return p;
  }

  get usage(): Usage | null {
    return this.store.getSetting<Usage>('usage');
  }

  private updateUsage(info: any) {
    const windows = info?.unifiedWindows;
    if (!windows) return;
    const usage: Usage = { weekly: usageWindow(windows.seven_day), session: usageWindow(windows.five_hour), updatedAt: Date.now() };
    if (!usage.weekly && !usage.session) return;
    this.store.setSetting('usage', usage);
    this.broadcast({ type: 'usage', usage });
  }

  private setStatus(ticketId: number, status: Ticket['status']) {
    const progress = this.progressFor(ticketId);
    // Re-word the plan's line too, so a stopped or interrupted turn stops saying "Running tests… 3/7".
    const activity = progress.tasks.length ? progressLine(progress, status === 'running') : undefined;
    this.store.updateTicket(ticketId, activity ? { status, last_activity: activity } : { status });
    this.broadcastTicket(ticketId);
  }

  broadcastTicket(ticketId: number) {
    const ticket = this.store.getTicket(ticketId);
    if (ticket) this.broadcast({ type: 'ticket', ticket: this.view(ticket) });
  }

  emit(ticketId: number, kind: string, data: unknown): EventRow {
    const row = this.store.addEvent(ticketId, kind, data);
    this.broadcast({ type: 'event', event: row });
    return row;
  }
}
