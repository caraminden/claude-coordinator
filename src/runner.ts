// Runs ticket turns as headless `claude -p` processes, one turn per process.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { EventRow, Project, Store, Ticket } from './db.ts';
import { applyEvent, createProgress, progressLine } from '../public/progress.js';

const MAX_TOOL_OUTPUT = 20_000;

// Stream events that carry no information for the ticket view.
const DROPPED_TYPES = new Set(['rate_limit_event', 'stream_event']);
const DROPPED_SYSTEM_SUBTYPES = new Set(['commands_changed']);

export type Broadcast = (msg: object) => void;

interface QueuedMessage {
  author: string;
  text: string;
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
    if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) return b.text.trim().split('\n')[0].slice(0, 160);
    if (b.type === 'tool_use') return `Using ${b.name}`;
  }
  return null;
}

function systemPrompt(project: Project, ticket: Ticket): string {
  const where = ticket.branch
    ? `Your working directory is a dedicated git worktree of the project repo on branch \`${ticket.branch}\`. Commit your work to this branch; do not push or touch other branches unless asked.`
    : 'Your working directory is a dedicated folder for this ticket.';
  return [
    `You are working on ticket #${ticket.id} "${ticket.title}" in project "${project.name}".`,
    'This ticket is managed by Claude Coordinator, a shared web app where several people chat with you.',
    'Each user message starts with the sender\'s name in brackets, like "[Cara]: ...".',
    where,
    'For work with more than a couple of steps, plan it with TaskCreate (one task per step, with a short activeForm like "Running tests") and mark each task in_progress and then completed with TaskUpdate as you go. The web UI shows this plan as a live progress readout ("Running tests… 3/7").',
    'Tool calls and their output are not shown in the chat, only in that readout, so put anything people need to see in your reply text.',
    'People read your replies in a web UI, often later. When you finish a turn, end with a short summary of what you did and, if you are blocked, exactly what you need from them.',
  ].join('\n');
}

export class Runner {
  private procs = new Map<number, ChildProcess>();
  private queues = new Map<number, QueuedMessage[]>();
  private stopping = new Set<number>();
  private progress = new Map<number, ReturnType<typeof createProgress>>();
  private store: Store;
  private broadcast: Broadcast;
  private claudeBin: string;

  constructor(store: Store, broadcast: Broadcast, claudeBin = 'claude') {
    this.store = store;
    this.broadcast = broadcast;
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
      }
    }
  }

  /** Record a user message and run it now, or queue it behind the current turn. */
  send(ticketId: number, author: string, text: string) {
    this.emit(ticketId, 'user_message', { author, text });
    const q = this.queues.get(ticketId) ?? [];
    q.push({ author, text });
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
    const prompt = batch.map((m) => `[${m.author}]: ${m.text}`).join('\n\n');
    this.startTurn(project, ticket, prompt);
  }

  private startTurn(project: Project, ticket: Ticket, prompt: string) {
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', ticket.permission_mode,
      '--append-system-prompt', systemPrompt(project, ticket),
    ];
    if (ticket.session_id) args.push('--resume', ticket.session_id);

    // The task-list tools (TaskCreate/TaskUpdate) are off by default in headless mode; they drive the progress readout.
    const env = { ...process.env, CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' };
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
    if (activity) this.store.updateTicket(ticketId, { last_activity: activity });
    this.emit(ticketId, 'claude', slim);
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

  private setStatus(ticketId: number, status: Ticket['status']) {
    this.store.updateTicket(ticketId, { status });
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
