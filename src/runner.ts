// Runs ticket turns as headless `claude -p` processes, one turn per process.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { EventRow, Project, Store, Ticket } from './db.ts';
import { activityLabel, applyEvent, createProgress, isWorkTool, progressLine } from '../public/progress.js';

const MAX_TOOL_OUTPUT = 20_000;
const MCP_SERVER = join(import.meta.dirname, 'mcp.ts');

// Stream events that carry no information for the ticket view.
const DROPPED_TYPES = new Set(['rate_limit_event', 'stream_event']);
const DROPPED_SYSTEM_SUBTYPES = new Set(['commands_changed']);

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

/** Shrink a stream-json event before storing it: drop duplicated raw tool results and cap output size. */
function slimEvent(ev: any): any {
  if (ev.type === 'system' && ev.subtype === 'init') {
    return { type: 'system', subtype: 'init', session_id: ev.session_id, model: ev.model, cwd: ev.cwd };
  }
  if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
    const { tool_use_result: _raw, ...rest } = ev;
    rest.message = {
      ...ev.message,
      content: ev.message.content.map((block: any) => {
        if (block.type !== 'tool_result') return block;
        let content = block.content;
        if (Array.isArray(content)) {
          content = content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
        }
        return { ...block, content: truncate(String(content ?? '')) };
      }),
    };
    return rest;
  }
  return ev;
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
    'Linking a file is the only way people see it; they cannot browse your folders.',
  ].filter(Boolean);
}

function systemPrompt(project: Project, ticket: Ticket, filesDir: string | null): string {
  if (ticket.kind === 'coordinator') return [coordinatorPrompt(project), ...showingFiles(ticket, filesDir)].join('\n');
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
    'Give every Bash call a short plain-English description (like "Run the test suite").',
    ...showingFiles(ticket, filesDir),
    'People read your replies in a web UI, often later. When you finish a turn, end with a short summary of what you did and, if you are blocked, exactly what you need from them.',
  ].join('\n');
}

function coordinatorPrompt(project: Project): string {
  return [
    `You are the coordinator for project "${project.name}" in Claude Coordinator, a shared web app where several people chat with Claude Code sessions called tickets.`,
    'People open the project and talk to you first. You keep track of the project\'s tickets and manage them with the `coordinator` MCP tools: list_tickets, read_ticket, create_ticket, message_ticket, update_ticket, close_ticket, reopen_ticket and stop_ticket.',
    'Each ticket is a separate Claude Code session with its own git worktree and branch. Hand real work (code changes, investigations) to tickets rather than doing it yourself; give each new ticket a clear title and a self-contained first message, since it cannot see this conversation.',
    'Tickets run in the background. To see progress, read them; do not wait or poll in a loop. Close tickets when people agree they are done.',
    project.repo_dir
      ? `The project's main checkout is at ${project.repo_dir} and ticket worktrees are under ${join(project.repo_dir, '..', 'tickets')}. You may read them for context, but do not edit, commit or switch branches there.`
      : 'This project has no git repo; each ticket gets a plain folder.',
    'Each user message starts with the sender\'s name in brackets, like "[Cara]: ...". People read your replies in a web UI, often later, so keep them short and end each turn with what you did and what, if anything, you need from them.',
  ].join('\n');
}

/** Extra process setup for coordinator turns: how its MCP server reaches the API. */
export type CoordinatorEnv = (ticket: Ticket) => Record<string, string>;

export class Runner {
  private procs = new Map<number, ChildProcess>();
  private queues = new Map<number, QueuedMessage[]>();
  private stopping = new Set<number>();
  private progress = new Map<number, ReturnType<typeof createProgress>>();
  private store: Store;
  private broadcast: Broadcast;
  private claudeBin: string;
  private coordinatorEnv: CoordinatorEnv;
  /** A folder outside the repo where a ticket can put files it fetched or made to show people. */
  filesDir: (ticket: Ticket) => string | null = () => null;
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
  send(ticketId: number, author: string, text: string, images: MessageImage[] = []) {
    this.emit(ticketId, 'user_message', images.length ? { author, text, images: images.map((i) => i.name) } : { author, text });
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
      '--append-system-prompt', systemPrompt(project, ticket, filesDir),
    ];
    // Lets edit-only sessions write there too, not just in their working directory.
    if (filesDir) args.push('--add-dir', filesDir);
    if (ticket.session_id) args.push('--resume', ticket.session_id);
    // The task-list tools (TaskCreate/TaskUpdate) are off by default in headless mode; they drive the progress readout.
    let env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' };
    if (ticket.kind === 'coordinator') {
      // The token travels in the environment (which the MCP server inherits), never on the command line.
      const mcp = { mcpServers: { coordinator: { type: 'stdio', command: process.execPath, args: [MCP_SERVER] } } };
      args.push('--mcp-config', JSON.stringify(mcp), '--allowedTools', 'mcp__coordinator');
      env = { ...env, ...this.coordinatorEnv(ticket) };
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
      this.setStatus(ticket.id, status);
      this.onFilesMayChange(ticket.id);
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
    if (ev.type === 'system' && DROPPED_SYSTEM_SUBTYPES.has(ev.subtype)) return;
    if (ev.session_id && ev.session_id !== this.store.getTicket(ticketId)?.session_id) {
      this.store.updateTicket(ticketId, { session_id: ev.session_id });
    }
    if (ev.type === 'result') onResult(!!ev.is_error);
    const slim = slimEvent(ev);
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
    if (ticket) this.broadcast({ type: 'ticket', ticket: { ...ticket, queued: this.queued(ticketId) } });
  }

  emit(ticketId: number, kind: string, data: unknown): EventRow {
    const row = this.store.addEvent(ticketId, kind, data);
    this.broadcast({ type: 'event', event: row });
    return row;
  }
}
