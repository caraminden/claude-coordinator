// Runs ticket turns as headless `claude -p` processes, one turn per process.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { EventRow, Project, Store, Ticket } from './db.ts';
import { claudeConfigDir, lastEffort, restoreSession, saveSession } from './sessions.ts';
import { activityLabel, applyEvent, createProgress, isWorkTool, progressLine, stepInfo } from '../public/progress.js';

const MAX_TOOL_OUTPUT = 20_000;
// Turns run a copy of the MCP server taken when this server started, not the file on disk: a deploy
// pulls new code before the restart, and a newer MCP server would offer tools this process rejects.
const MCP_SERVER = (() => {
  const copy = join(mkdtempSync(join(tmpdir(), 'claude-coordinator-mcp-')), 'mcp.ts');
  writeFileSync(copy, readFileSync(join(import.meta.dirname, 'mcp.ts')));
  return copy;
})();

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
}

/** One turn's prompt as a stream-json user message, so pasted images reach Claude as images. */
function promptMessage(batch: QueuedMessage[]): string {
  const content: object[] = [];
  for (const m of batch) {
    const text = m.text || (m.images.length ? '(sent an image)' : '');
    content.push({ type: 'text', text: `[${m.author}]: ${text}` });
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
function showingFiles(ticket: Ticket, filesDir: string | null): string[] {
  const where = filesDir ? `inside your working directory or in ${filesDir}` : 'inside your working directory';
  return [
    `You can show people files (documents, images, GIFs, videos, web pages, PDFs) by linking them in your reply with a path ${where}; the app turns those links into previews that open the file in place of the chat:`,
    '- `![caption](path)` shows an inline preview: use it for images, GIFs and videos.',
    '- `[title](path)` shows a card: use it for documents, web pages and PDFs.',
    filesDir
      ? `Put files you fetch from elsewhere or make only to show people (not part of the work in your branch) in ${filesDir}, so they never end up in a commit. Files elsewhere on disk can't be shown; copy them there first.`
      : '',
    'Linking a file is the only way people see it; they cannot browse your folders. Files you link are also listed in the project\'s artifacts, so link only what is meant for people, not files you made for your own use (test pages, scratch notes, fixtures).',
  ].filter(Boolean);
}

/** The project's standing instructions, set by people in the app; last, so they read as the final word. */
function projectInstructions(project: Project): string[] {
  const text = project.instructions?.trim();
  if (!text) return [];
  return [
    '',
    `# Project instructions for "${project.name}"`,
    'People set these in the project\'s settings. They apply to every thread in the project and to the coordinator, and take precedence over the defaults above:',
    '',
    text,
  ];
}

function systemPrompt(project: Project, ticket: Ticket, filesDir: string | null, ticketsDir: string): string {
  if (ticket.kind === 'coordinator') return [coordinatorPrompt(project, ticketsDir), ...showingFiles(ticket, filesDir), ...projectInstructions(project)].join('\n');
  const where = ticket.branch
    ? `Your working directory is a dedicated git worktree of the project repo on branch \`${ticket.branch}\`. Commit your work to this branch; do not push or touch other branches unless asked.`
    : 'Your working directory is a dedicated folder for this ticket.';
  return [
    `You are working on ticket #${ticket.number} "${ticket.title}" in project "${project.name}".`,
    'This ticket is managed by Claude Coordinator, a shared web app where several people chat with you.',
    'Each user message starts with the sender\'s name in brackets, like "[Cara]: ...".',
    where,
    'People follow your work through a progress readout ("Running tests… 3/7") built from your task list, so for anything beyond a quick answer, plan the work with TaskCreate before starting it:',
    '- Make 3 to 7 tasks that are conceptual chunks someone skimming would follow ("Find where the sidebar text comes from", "Make the readout show phases", "Test it on a copy"), not individual commands.',
    '- Give each a one-sentence description of what it involves and why, and a short activeForm ("Finding where the sidebar text comes from").',
    '- Mark each task in_progress with TaskUpdate when you start it. When you finish it, mark it completed and set metadata.outcome to one plain sentence on what it found, decided or changed.',
    '- If the plan changes, add, reword or delete tasks so the list stays true.',
    'Tool calls and their output are not shown in the chat, only in that readout, so put anything people need to see in your reply text.',
    'When you need people to decide between clear options, ask with the `ask_question` tool (mcp__thread) instead of listing choices in prose: it shows a card they answer with a click. Then end your turn; the answers arrive as the next message.',
    'The project\'s threads list groups threads by kind and shows each as one line: number, short title, state, note. Keep yours accurate with the `set_thread_status` tool (mcp__thread):',
    '- title: the short ask, about 30 characters ("Usage bar in the top bar"), no number, tag or emoji. Your starting title may just be the opening words of the first message; replace it early in your first turn with the short ask.',
    '- tag: feature, bug, design, process (tooling, prompts, docs, setup) or idea (exploring, no code yet). Set it once the kind of work is clear, following any project conventions, and change it if the work changes kind; leave it unset for one-off questions.',
    '- At the end of every turn, set state and note: state ready (done, ready to merge or pick up), try (ready for people to try), parked, blocked (on something outside the thread) or outside (work still running elsewhere), or null when you are simply waiting on an answer; note is one terse line, max 60 chars, on where things stand ("needs a pick: tabs or list"). The state clears when the next turn starts.',
    'Give every Bash call a short plain-English description (like "Run the test suite").',
    'When the thread\'s work is done and should be closed (for example when project instructions say to close after shipping), call the `close_self` tool (mcp__thread) near the end of your turn: the thread closes once the turn ends, keeping its worktree and branch, and any new message reopens it. Do not close a thread whose result is something for people to read (a report, research, write-up, plan or doc): leave it open in state ready until someone has read it and says it can close, even if its brief says to close.',
    ...showingFiles(ticket, filesDir),
    'People read your replies in a web UI, often later. When you finish a turn, end with a short summary of what you did and, if you are blocked, exactly what you need from them.',
    ...projectInstructions(project),
  ].join('\n');
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
 */
export function coordinatorAccess(repoDir: string | null, ticketsDir: string): { addDirs: string[]; settings: object } {
  let ticketDirs: string[] = [];
  try {
    ticketDirs = readdirSync(ticketsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(ticketsDir, d.name));
  } catch {
    // No tickets yet.
  }
  const roots = repoDir ? [repoDir, ticketsDir] : [ticketsDir];
  const gitDirs = repoDir ? [repoDir, ...ticketDirs] : [];
  return {
    // Adding the parent tickets/ folder also covers worktrees made after the turn starts.
    addDirs: roots,
    settings: {
      permissions: {
        // `//` makes the path absolute. Edit rules also cover Write, NotebookEdit and Bash commands that write there.
        deny: [...roots.map((d) => `Edit(/${d}/**)`), 'Bash(git * --output*)'],
        allow: gitDirs.flatMap((d) => READ_ONLY_GIT.map((c) => `Bash(git -C ${d} ${c})`)),
      },
    },
  };
}

function coordinatorPrompt(project: Project, ticketsDir: string): string {
  return [
    `You are the coordinator for project "${project.name}" in Claude Coordinator, a shared web app where several people chat with Claude Code sessions called tickets.`,
    'People open the project and talk to you first. You keep track of the project\'s tickets and manage them with the `coordinator` MCP tools: list_tickets, read_ticket, create_ticket, message_ticket, update_ticket, close_ticket, reopen_ticket and stop_ticket.',
    'The project instructions (shown at the end of this prompt when set) reach you and every ticket on its next turn. When people ask you to add, change or drop a standing rule for the whole project, read the current text with get_project_instructions and save the full new text with set_project_instructions; tell them what changed.',
    'Each ticket is a separate Claude Code session with its own git worktree and branch. Hand real work (code changes, investigations) to tickets rather than doing it yourself; give each new ticket a self-contained first message, since it cannot see this conversation.',
    'Ticket titles are the short ask, about 30 characters ("Usage bar in the top bar"), with no number, tag or emoji; the app shows the number and the tickets label themselves as they work. Give each new ticket a tag: feature, bug, design, process (tooling, prompts, docs, setup) or idea (exploring, no code yet); none for one-off questions. You can fix a ticket\'s title, tag, state or note with update_ticket.',
    'Tickets run in the background. To see progress, read them; do not wait or poll in a loop. Close tickets when people agree they are done.',
    project.repo_dir
      ? `The project's main checkout is at ${project.repo_dir} and ticket worktrees are under ${ticketsDir} (one folder per ticket). You may read them for context, but do not edit, commit or switch branches there: edits there are denied. Search and read them with Read and with read-only Bash such as \`grep -rn … | head\`; for git, use \`git -C <folder> log\` (or status, diff, show, blame, branch -a), since \`cd <folder> && git …\` is denied.`
      : `This project has no git repo; each ticket gets a plain folder under ${ticketsDir}. You may read them for context, but do not edit them: edits there are denied.`,
    'When you need people to decide between clear options, ask with your `ask_question` tool: it shows a card in this chat they answer with a click. Then end your turn; the answers arrive as the next message.',
    'Each user message starts with the sender\'s name in brackets, like "[Cara]: ...". People read your replies in a web UI, often later, so keep them short and end each turn with what you did and what, if anything, you need from them.',
  ].join('\n');
}

/** Extra process setup for coordinator turns: how its MCP server reaches the API. */
export type CoordinatorEnv = (ticket: Ticket) => Record<string, string>;

export class Runner {
  private procs = new Map<number, ChildProcess>();
  private queues = new Map<number, QueuedMessage[]>();
  private stopping = new Set<number>();
  /** Tickets that asked to close when their current turn ends, with the reason they gave. */
  private closing = new Map<number, string | null>();
  private progress = new Map<number, ReturnType<typeof createProgress>>();
  private store: Store;
  private broadcast: Broadcast;
  private claudeBin: string;
  private coordinatorEnv: CoordinatorEnv;
  /** A folder outside the repo where a ticket can put files it fetched or made to show people. */
  filesDir: (ticket: Ticket) => string | null = () => null;
  /** The folder that holds a project's ticket folders, which the coordinator may read. */
  ticketsDir: (project: Project) => string = (project) => join(project.repo_dir ?? '.', '..', 'tickets');
  /** Called after each tool result and at the end of each turn, when files on disk may have changed. */
  onFilesMayChange: (ticketId: number) => void = () => {};

  constructor(store: Store, broadcast: Broadcast, coordinatorEnv: CoordinatorEnv, claudeBin = 'claude') {
    this.store = store;
    this.broadcast = broadcast;
    this.coordinatorEnv = coordinatorEnv;
    this.claudeBin = claudeBin;
  }

  isRunning(ticketId: number): boolean {
    return this.procs.has(ticketId);
  }

  queued(ticketId: number): number {
    return this.queues.get(ticketId)?.length ?? 0;
  }

  /** A ticket as the API shows it: plus queued messages and its task-list steps. */
  view(ticket: Ticket) {
    const { total, done } = stepInfo(this.progressFor(ticket.id));
    return { ...ticket, queued: this.queued(ticket.id), steps: total ? { done, total } : null, closing: this.closing.has(ticket.id) };
  }

  /** Close a ticket that is not running. Its worktree and branch are kept. */
  close(ticketId: number, text: string) {
    this.setStatus(ticketId, 'closed');
    this.emit(ticketId, 'note', { text });
  }

  /**
   * Close a running ticket once its current turn finishes cleanly. A turn that fails or is
   * stopped, or a message that arrives during it, leaves the ticket open instead.
   */
  closeAfterTurn(ticketId: number, reason: string | null): boolean {
    if (!this.isRunning(ticketId)) return false;
    this.closing.set(ticketId, reason);
    this.broadcastTicket(ticketId);
    return true;
  }

  /** Mark turns that were cut off by a server restart. */
  recover() {
    for (const p of this.store.listProjects()) {
      for (const t of this.store.listTickets(p.id)) {
        if (t.status === 'running') {
          this.emit(t.id, 'note', { text: 'The server restarted during this turn, so it was interrupted.' });
          this.setStatus(t.id, 'idle');
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
  }

  /** Record a user message and run it now, or queue it behind the current turn. */
  /** `extra` is stored with the message for the UI (e.g. which question card it answers), not sent to Claude. */
  send(ticketId: number, author: string, text: string, images: MessageImage[] = [], extra: object = {}) {
    this.emit(ticketId, 'user_message', { author, text, ...(images.length ? { images: images.map((i) => i.name) } : {}), ...extra });
    const q = this.queues.get(ticketId) ?? [];
    q.push({ author, text, images });
    this.queues.set(ticketId, q);
    if (!this.isRunning(ticketId)) this.next(ticketId);
    else this.broadcastTicket(ticketId);
  }

  stop(ticketId: number): boolean {
    const proc = this.procs.get(ticketId);
    if (!proc) return false;
    this.queues.delete(ticketId);
    this.stopping.add(ticketId);
    this.emit(ticketId, 'note', { text: 'Stopped by user.' });
    // claude runs in its own process group; signal the whole group so tool subprocesses stop too.
    try {
      process.kill(-proc.pid!, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
    return true;
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

  private startTurn(project: Project, ticket: Ticket, prompt: string) {
    let filesDir = this.filesDir(ticket);
    try {
      if (filesDir) mkdirSync(filesDir, { recursive: true });
    } catch {
      filesDir = null;
    }
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', ticket.permission_mode,
      '--append-system-prompt', systemPrompt(project, ticket, filesDir, this.ticketsDir(project)),
      // Nobody can answer a permission prompt in a headless turn; deny instead of waiting on one.
      '--permission-prompts', 'none',
    ];
    // Lets edit-only sessions write there too, not just in their working directory.
    const addDirs = filesDir ? [filesDir] : [];
    if (ticket.kind === 'coordinator') {
      const access = coordinatorAccess(project.repo_dir, this.ticketsDir(project));
      addDirs.push(...access.addDirs);
      args.push('--settings', JSON.stringify(access.settings));
    }
    if (addDirs.length) args.push('--add-dir', ...addDirs);
    if (ticket.session_id) args.push('--resume', ticket.session_id);
    // Chosen per thread in the composer; left out, Claude Code uses its defaults.
    if (ticket.model) args.push('--model', ticket.model);
    if (ticket.effort) args.push('--effort', ticket.effort);
    // The task-list tools (TaskCreate/TaskUpdate) are off by default in headless mode; they drive the progress readout.
    let env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' };
    // The coordinator gets tools to manage the project's tickets; a ticket gets one to set its own
    // title, tag, state and note. The token travels in the environment (which the MCP server
    // inherits), never on the command line.
    const role = ticket.kind === 'coordinator' ? 'coordinator' : 'thread';
    const mcp = { mcpServers: { [role]: { type: 'stdio', command: process.execPath, args: [MCP_SERVER] } } };
    // The built-in AskUserQuestion can't be answered in headless mode; ask_question shows a card instead.
    args.push('--mcp-config', JSON.stringify(mcp), '--allowedTools', `mcp__${role}`, '--disallowedTools', 'AskUserQuestion');
    env = { ...env, ...this.coordinatorEnv(ticket), COORDINATOR_ROLE: role, COORDINATOR_TICKET: String(ticket.id) };
    // A state describes where the last turn left things; a new turn makes it stale.
    if (ticket.state) this.store.updateTicket(ticket.id, { state: null });

    // The session's transcript, task list and memory live in the database too; put back anything this
    // config dir lacks (another account, a fresh machine) before resuming.
    const configDir = claudeConfigDir(env);
    try {
      const restored = restoreSession(this.store, ticket, project, configDir);
      if (restored) this.emit(ticket.id, 'note', { text: `Restored this thread's Claude session from the app's database (${restored} file${restored === 1 ? '' : 's'}).` });
    } catch (err: any) {
      this.emit(ticket.id, 'note', { text: `Could not restore the session from the database: ${err.message}` });
    }

    const proc = spawn(this.claudeBin, args, { cwd: ticket.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    this.procs.set(ticket.id, proc);
    this.setStatus(ticket.id, 'running');
    // If claude exits before reading its prompt, the write fails with EPIPE; the close handler reports it.
    proc.stdin!.on('error', () => {});
    proc.stdin!.end(prompt);

    let sawResult = false;
    let resultIsError = false;
    const stderr: string[] = [];

    createInterface({ input: proc.stdout! }).on('line', (line) => {
      try {
        this.handleLine(ticket.id, line, (isError) => {
          sawResult = true;
          resultIsError = isError;
        });
      } catch (err: any) {
        this.emit(ticket.id, 'note', { text: `Could not process output line: ${err.message}` });
      }
    });

    createInterface({ input: proc.stderr! }).on('line', (line) => {
      stderr.push(line);
      if (stderr.length > 50) stderr.shift();
    });

    proc.on('error', (err) => {
      this.emit(ticket.id, 'error', { text: `Could not start claude: ${err.message}` });
    });

    proc.on('close', (code, signal) => {
      this.procs.delete(ticket.id);
      const stopped = this.stopping.delete(ticket.id);
      let status: 'idle' | 'error' = 'idle';
      if (stopped || signal) {
        // Stopped by the user; leave it waiting for the next message.
      } else if (!sawResult || code !== 0 || resultIsError) {
        status = 'error';
        const detail = stderr.slice(-10).join('\n');
        this.emit(ticket.id, 'error', { text: `claude exited with code ${code}${detail ? `:\n${detail}` : ''}` });
      }
      const closing = this.closing.has(ticket.id);
      const reason = this.closing.get(ticket.id);
      this.closing.delete(ticket.id);
      if (closing && status === 'idle' && !stopped && !signal && !this.queued(ticket.id)) {
        this.close(ticket.id, `Claude closed this ticket${reason ? `: ${reason}` : '.'}`);
      } else {
        if (closing && status === 'idle' && !stopped && !signal) {
          this.emit(ticket.id, 'note', { text: 'Claude asked to close this ticket, but a new message arrived, so it stays open.' });
        }
        this.setStatus(ticket.id, status);
      }
      this.onFilesMayChange(ticket.id);
      // Re-read the ticket: the turn may have given it its first (or a new) session id.
      const after = this.store.getTicket(ticket.id);
      // Only a turn that ran on Claude Code's default effort says what "Default" means for this thread.
      const effort = after && !ticket.effort && lastEffort(after, configDir);
      if (after && effort && effort !== after.last_effort) {
        this.store.updateTicketQuietly(ticket.id, { last_effort: effort });
        this.broadcastTicket(ticket.id);
      }
      if (after) {
        saveSession(this.store, after, project, configDir, true)
          .catch((err) => console.error(`Saving the session of ticket ${ticket.id} failed:`, err));
      }
      this.next(ticket.id);
    });
  }

  private handleLine(ticketId: number, line: string, onResult: (isError: boolean) => void) {
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
    if (ev.type === 'result') onResult(!!ev.is_error);
    // Likewise the model: remembered from turns that ran without one chosen.
    const t = ev.type === 'system' && ev.subtype === 'init' && typeof ev.model === 'string' ? this.store.getTicket(ticketId) : null;
    if (t && !t.model && ev.model !== t.last_model) {
      this.store.updateTicketQuietly(ticketId, { last_model: ev.model });
      this.broadcastTicket(ticketId);
    }
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
