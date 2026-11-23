// Side questions (#932): a person asks a minion something on the side, even mid-turn. The question runs in a
// read-only fork of the minion's Claude session (Runner.sideLaunch: `--resume <id> --fork-session`, the guard hook of
// src/side-guard.ts) on the asker's own login. The answer goes into a side thread in the chat ('side' and
// 'side_answer' events, which no turn reads), never into the minion's session, queue or next turn. Follow-ups resume
// the fork; an idle thread's fork is deleted, and so is every fork at a restart.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Store, Turn } from './db.ts';
import { promptMessage } from './prompts.ts';
import type { Runner } from './runner.ts';
import { projectSlug, validSessionId } from './sessions.ts';

/** One side thread: its fork, once the first answer named it, and the ask running in it, if any. */
export interface SideThread {
  id: number; // the first 'side' event's id
  ticketId: number;
  asker: number;
  forkId: string | null;
  configDir: string;
  cwd: string;
  account: number;
  lastAt: number;
  run: { ask: number; dir: string; container: string | null; startedAt: number } | null;
}

type Launch = Pick<Runner, 'sideLaunch' | 'emit' | 'payerOf' | 'signal'>;

const SETTING = 'side_threads';
/** A thread idle this long loses its fork; a new question starts a new one. */
export const SIDE_IDLE_MS = 60 * 60_000;
/** An answer that takes longer than this is stopped. */
export const SIDE_LIMIT_MS = 15 * 60_000;
export const SIDE_MAX_CHARS = 8000;

const PREAMBLE = 'This message is a side question, asked while you work. It runs in a read-only copy of your session: '
  + 'you can read files and run read-only commands (git, gh, logs, ps, the database with -readonly), but nothing you do here '
  + 'reaches your real session, your task list or your next turn, and writes are refused. Answer the question directly and '
  + 'briefly. Look at the actual state (processes, logs, git, the turn folder) when asked what is going on, rather than '
  + 'answering from memory. If something needs the minion to act, say what to tell it.';

export class SideAsks {
  private threads = new Map<number, SideThread>();
  private timer: NodeJS.Timeout | null = null;
  private offsets = new Map<number, number>();
  private found = new Map<number, { forkId?: string; result?: any }>();

  private store: Store;
  private runner: Launch;
  private broadcast: (msg: unknown) => void;
  private pollMs: number;

  constructor(store: Store, runner: Launch, broadcast: (msg: unknown) => void, pollMs = 500) {
    this.store = store;
    this.runner = runner;
    this.broadcast = broadcast;
    this.pollMs = pollMs;
  }

  /** Asks running now on the host, for the restart's wait; container ones count in inContainer. */
  running(): number {
    return [...this.threads.values()].filter((t) => t.run && !t.run.container).length;
  }

  inContainer(name: string): number {
    return [...this.threads.values()].filter((t) => t.run?.container === name).length;
  }

  /**
   * Ask `text` on the side of a minion, as `asker` (who pays, on their own login), in a new thread or in `thread`, one
   * of their own. Returns the 'side' event; the answer follows as a 'side_answer' event. Throws with a reason people read.
   */
  ask(ticketId: number, asker: number, name: string, text: string, thread?: number) {
    const ticket = this.store.getTicket(ticketId);
    if (!ticket?.session_id) throw new Error('This minion has no session to ask yet.');
    const t = thread === undefined ? null : this.threads.get(thread);
    if (thread !== undefined) {
      if (!t || t.ticketId !== ticketId || !t.forkId) throw new Error('This side thread has ended; ask a new question.');
      if (t.asker !== asker) throw new Error('Only the person who started a side thread can follow it up; ask your own question.');
      if (t.run) throw new Error('This side thread is still answering.');
    }
    const prompt = promptMessage([{ author: name, text: t ? text : `${PREAMBLE}\n\n${text}`, images: [] }]);
    const launch = this.runner.sideLaunch(ticketId, asker, prompt, t ? { id: t.forkId!, fork: false } : { id: ticket.session_id, fork: true });
    const ev = this.runner.emit(ticketId, 'side', { thread: t?.id ?? null, by: name, uid: asker, q: text });
    const id = t?.id ?? ev.id;
    const row: SideThread = t ?? { id, ticketId, asker, forkId: null, configDir: launch.configDir, cwd: launch.cwd, account: launch.account, lastAt: 0, run: null };
    row.run = { ask: ev.id, dir: launch.dir, container: launch.container, startedAt: Date.now() };
    row.lastAt = Date.now();
    this.threads.set(id, row);
    this.save();
    this.tick();
    return { ...ev, thread: id };
  }

  /** At boot: asks cut off by the restart fail, and every fork the last run left is deleted. */
  recover() {
    for (const t of this.store.getSetting<SideThread[]>(SETTING) ?? []) {
      if (t.run) {
        this.runner.signal({ dir: t.run.dir, unit: null, container: t.run.container }, 'SIGKILL');
        rmSync(t.run.dir, { recursive: true, force: true });
        this.runner.emit(t.ticketId, 'side_answer', { thread: t.id, ask: t.run.ask, ok: false, text: 'The server restarted before the answer came; ask again.' });
      }
      this.dropFork(t);
    }
    this.store.setSetting(SETTING, []);
  }

  private save() {
    this.store.setSetting(SETTING, [...this.threads.values()]);
  }

  private tick() {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.timer.unref();
  }

  /** Read each running ask's stream; finish the ones whose wrapper exited, end idle threads. */
  poll() {
    const now = Date.now();
    for (const t of [...this.threads.values()]) {
      if (!t.run) {
        if (now - t.lastAt > SIDE_IDLE_MS) this.end(t);
        continue;
      }
      // Looked for before the read, as the runner's own poll does: once exit.json is there, everything claude wrote is
      // in the stream, so this tick's read takes the answer with it. Read first and an answer written in between is
      // lost, and the thread ends saying it stopped without one (#1619).
      const exited = existsSync(join(t.run.dir, 'exit.json'));
      this.read(t, exited);
      if (!exited && now - t.run.startedAt > SIDE_LIMIT_MS) {
        this.runner.signal({ dir: t.run.dir, unit: null, container: t.run.container }, 'SIGKILL');
        // The read above may have taken an answer printed in the last moment before the deadline: a whole answer counts,
        // late as it is, rather than a timeout message in its place.
        const answered = !!this.found.get(t.run.ask)?.result;
        this.finish(t, answered ? undefined : `It took longer than ${SIDE_LIMIT_MS / 60_000} minutes, so it was stopped.`);
      } else if (exited) {
        this.finish(t);
      }
    }
    if (![...this.threads.values()].length && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** @param toEnd claude has exited, so its last line is all there is, newline or not. */
  private read(t: SideThread, toEnd = false) {
    const run = t.run!;
    let text: string;
    try {
      text = readFileSync(join(run.dir, 'stream.jsonl'), 'utf8');
    } catch {
      return;
    }
    const from = this.offsets.get(run.ask) ?? 0;
    const end = toEnd ? text.length : text.lastIndexOf('\n') + 1;
    if (end <= from) return;
    const seen = this.found.get(run.ask) ?? {};
    for (const line of text.slice(from, end).split('\n')) {
      if (!line.trim()) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev?.type === 'system' && ev.subtype === 'init' && validSessionId(ev.session_id)) seen.forkId = ev.session_id;
      if (ev?.type === 'result') seen.result = ev;
    }
    this.offsets.set(run.ask, end);
    this.found.set(run.ask, seen);
  }

  private finish(t: SideThread, failed?: string) {
    const run = t.run!;
    const { forkId, result } = this.found.get(run.ask) ?? {};
    this.offsets.delete(run.ask);
    this.found.delete(run.ask);
    // The fork is a new session: never the minion's own, which must not be touched or deleted.
    const minion = this.store.getTicket(t.ticketId)?.session_id;
    if (forkId && forkId !== minion) t.forkId = forkId;
    const ok = !failed && !!result && !result.is_error && typeof result.result === 'string';
    let why = failed;
    if (!ok && !why) {
      let stderr = '';
      try {
        stderr = readFileSync(join(run.dir, 'stderr.log'), 'utf8').trim().split('\n').slice(-3).join('\n');
      } catch {}
      why = (typeof result?.result === 'string' && result.result) || stderr || 'It stopped without an answer.';
    }
    const cost = typeof result?.total_cost_usd === 'number' ? result.total_cost_usd : null;
    const ev = this.runner.emit(t.ticketId, 'side_answer', { thread: t.id, ask: run.ask, ok, text: ok ? result.result : why, cost_usd: cost });
    // Its cost is the asker's (sender pays), kept apart from the minion's own turns.
    if (cost !== null && t.forkId) {
      const turn: Turn = this.store.recordTurn(t.ticketId, {
        event_id: ev.id, session_id: t.forkId, ended_at: ev.created_at, session_cost_usd: cost, duration_ms: result.duration_ms,
        usage: result.usage, payer: this.runner.payerOf(t.asker), account: t.account, modelUsage: result.modelUsage, side: true, fork_of: minion,
      });
      this.broadcast({ type: 'turn', turn, projectId: this.store.getTicket(t.ticketId)?.project_id });
    }
    rmSync(run.dir, { recursive: true, force: true });
    t.run = null;
    t.lastAt = Date.now();
    if (!t.forkId) this.end(t);
    else this.save();
  }

  /** The thread is over: its fork's files go. */
  private end(t: SideThread) {
    this.threads.delete(t.id);
    this.dropFork(t);
    this.save();
  }

  private dropFork(t: SideThread) {
    if (!t.forkId || !validSessionId(t.forkId) || t.forkId === this.store.getTicket(t.ticketId)?.session_id) return;
    const base = join(t.configDir, 'projects', projectSlug(t.cwd));
    for (const p of [join(base, `${t.forkId}.jsonl`), join(base, t.forkId), join(t.configDir, 'tasks', t.forkId), join(t.configDir, 'session-env', t.forkId)]) {
      rmSync(p, { recursive: true, force: true });
    }
  }
}
