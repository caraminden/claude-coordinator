// How long the server takes to answer (#1559). The server is one thread, so it can't time itself: a worker thread makes
// one real `GET /api/health` a second on a fresh connection and times it, and a slow answer never delays the next probe
// (each probe has its own socket and its own timer; a reused connection queues behind a slow one and reads several times
// too high, #1537). The same worker looks at the main thread's kernel state every 20 ms and its schedstat every second,
// so each 5-minute host sample can say where the answer time went: on CPU, waiting for a core, blocked, or idle.
//
// The worker posts one small message a second; the main thread only adds it to a window. `take` closes the window into
// the JSON stored in host_samples.answer_time. Nothing here names a port or a cgroup: the port is the one the server is
// bound to, the thread is this process's own.
import { Worker } from 'node:worker_threads';

/** One window as stored (host_samples.answer_time): answer times in ms, the main thread's split in ms, the box's load and running turns. */
export interface AnswerWindow {
  v: 1;
  /** Probes answered, and probes that failed or timed out (a failure counts as the worst answer). */
  n: number; fail: number;
  p50: number; p95: number; p99: number; max: number;
  /** The share of probes over 0.5 s, 0 to 1. */
  over: number;
  /** The main thread's time over the window: on CPU, waiting for a core, blocked (D state), idle. Null where /proc can't be read. */
  split: { cpu: number; wait: number; blocked: number; idle: number } | null;
  load: number; turns: number;
}

/** The target (Cara, 2026-11-21: "AS RESPONSIVE AS POSSIBLE"): at a load up to 100 and up to 50 running turns, 95% of probes within 100 ms, 99% within 500 ms, none over 2 s. */
export const TARGET = { p95: 100, p99: 500, max: 2000, load: 100, turns: 50 };
/** Until the other responsiveness changes are live the alert uses this line: p95 under 250 ms, p99 under 1 s. Both are settings. */
export const INTERIM = { p95: 250, p99: 1000 };
export const SETTING_P95 = 'answer-time:p95-ms';
export const SETTING_P99 = 'answer-time:p99-ms';
/** Samples in a row outside the line that wake the Taskmaster, and inside it that clear the alert. */
export const ALERT_RUN = 3;
export const SLOW_OVER_MS = 500;

/** The value at the share `q` (0 to 1) of the sorted times, nearest rank. */
export function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** One probe's reading from the worker: its time (null when it failed), and the main thread's counters since the last message. */
export interface ProbeMessage { ms: number | null; run: number; wait: number; samples: number; blocked: number; wallMs: number }

/** A window's numbers from its probes and the worker's counters; null with no probe at all. Pure, so a test feeds it. */
export function summarize(messages: ProbeMessage[], load: number, turns: number): AnswerWindow | null {
  const times = messages.map((m) => m.ms ?? Infinity);
  if (!times.length) return null;
  const answered = times.filter(Number.isFinite).sort((a, b) => a - b);
  const fail = times.length - answered.length;
  // A failure is the worst answer there is: it sits above every real one, so the percentiles can't hide it.
  const all = [...answered, ...Array<number>(fail).fill(60_000)];
  const r1 = (n: number) => Math.round(n * 10) / 10;
  let split: AnswerWindow['split'] = null;
  const wall = messages.reduce((s, m) => s + m.wallMs, 0);
  if (messages.some((m) => m.samples > 0 || m.run > 0)) {
    const cpu = messages.reduce((s, m) => s + m.run, 0) / 1e6;
    const wait = messages.reduce((s, m) => s + m.wait, 0) / 1e6;
    const samples = messages.reduce((s, m) => s + m.samples, 0);
    const blocked = samples ? (messages.reduce((s, m) => s + m.blocked, 0) / samples) * wall : 0;
    split = { cpu: Math.round(cpu), wait: Math.round(wait), blocked: Math.round(blocked), idle: Math.max(0, Math.round(wall - cpu - wait - blocked)) };
  }
  return {
    v: 1, n: answered.length, fail, p50: r1(percentile(all, 0.5)), p95: r1(percentile(all, 0.95)), p99: r1(percentile(all, 0.99)), max: r1(all.at(-1)!),
    over: Math.round((all.filter((t) => t > SLOW_OVER_MS).length / all.length) * 1000) / 1000, split, load: Math.round(load * 10) / 10, turns,
  };
}

/** A stored window, or null for a row from before this column or an odd value. */
export function parseWindow(text: string | null | undefined): AnswerWindow | null {
  if (!text) return null;
  try {
    const w = JSON.parse(text);
    return w && w.v === 1 && Number.isFinite(w.p95) ? (w as AnswerWindow) : null;
  } catch { return null; }
}

/** Whether a window counts against the line: only at a load and a turn count the target covers (above them the box is out of its design). */
export function judged(w: AnswerWindow): boolean {
  return w.load <= TARGET.load && w.turns <= TARGET.turns;
}
export function outside(w: AnswerWindow, line: { p95: number; p99: number }): boolean {
  return w.p95 > line.p95 || w.p99 > line.p99;
}

/**
 * The alert's next step from the stored windows, oldest first: 'slow' when the newest ALERT_RUN judged windows are all
 * outside the line and it isn't already raised; 'ok' when raised and the newest ALERT_RUN are all inside; else null.
 * Windows outside the target's load aren't judged: they neither raise nor clear.
 */
export function alertStep(windows: AnswerWindow[], line: { p95: number; p99: number }, raised: boolean): 'slow' | 'ok' | null {
  const last = windows.filter(judged).slice(-ALERT_RUN);
  if (last.length < ALERT_RUN) return null;
  if (!raised && last.every((w) => outside(w, line))) return 'slow';
  if (raised && last.every((w) => !outside(w, line))) return 'ok';
  return null;
}

/** "p95 1.2 s, p99 6.0 s, worst 7.5 s; 17% over 0.5 s; the thread was on CPU 40%, waited for a core 30%..." for the alert and the tile. */
export function describe(w: AnswerWindow): string {
  const t = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
  const parts = [`p50 ${t(w.p50)}, p95 ${t(w.p95)}, p99 ${t(w.p99)}, worst ${t(w.max)}; ${Math.round(w.over * 100)}% over 0.5 s; load ${w.load}, ${w.turns} turns running`];
  if (w.split) {
    const tot = w.split.cpu + w.split.wait + w.split.blocked + w.split.idle || 1;
    const pc = (n: number) => `${Math.round((n / tot) * 100)}%`;
    parts.push(`main thread: ${pc(w.split.cpu)} on CPU, ${pc(w.split.wait)} waiting for a core, ${pc(w.split.blocked)} blocked, ${pc(w.split.idle)} idle`);
  }
  return parts.join('; ');
}

/**
 * The worker's code. It uses async file reads only (a blocking call in a worker is harmless to the server, but the
 * sync-calls ratchet counts the word). Each second it starts a probe on its own socket; a probe's result is posted when
 * it ends, with the main thread's counters since the last post. The 20 ms looks only read the thread's state letter.
 */
const WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const fs = require('node:fs/promises');
const http = require('node:http');
const { port, pid, everyMs, lookMs } = workerData;
let samples = 0, blocked = 0, lastSched = null, lastAt = performance.now(), looking = false;
const sched = async () => {
  try { const p = (await fs.readFile('/proc/' + pid + '/task/' + pid + '/schedstat', 'utf8')).split(' ').map(Number); return { run: p[0] || 0, wait: p[1] || 0 }; } catch { return null; }
};
const look = async () => {
  if (looking) return; looking = true;
  try {
    const st = await fs.readFile('/proc/' + pid + '/task/' + pid + '/stat', 'utf8');
    samples++;
    if (st.slice(st.lastIndexOf(')') + 2, st.lastIndexOf(')') + 3) === 'D') blocked++;
  } catch {} finally { looking = false; }
};
setInterval(look, lookMs);
const post = async (ms) => {
  const now = performance.now(), s = await sched();
  const run = s && lastSched ? s.run - lastSched.run : 0, wait = s && lastSched ? s.wait - lastSched.wait : 0;
  if (s) lastSched = s;
  parentPort.postMessage({ ms, run, wait, samples, blocked, wallMs: now - lastAt });
  samples = 0; blocked = 0; lastAt = now;
};
sched().then((s) => { lastSched = s; });
const probe = () => {
  const t0 = performance.now();
  let done = false;
  const end = (ms) => { if (!done) { done = true; void post(ms); } };
  const req = http.get({ host: '127.0.0.1', port, path: '/api/health', agent: false, timeout: 60000 }, (res) => {
    res.resume();
    res.on('end', () => end(Math.round((performance.now() - t0) * 10) / 10));
    res.on('error', () => end(null));
  });
  req.on('error', () => end(null));
  req.on('timeout', () => req.destroy());
};
setInterval(probe, everyMs);
`;

/** The probe: start it once the server is listening; `take` closes the window since the last one. */
export class AnswerProbe {
  private msgs: ProbeMessage[] = [];
  private worker: Worker | null = null;
  /** The newest answer time in ms, null before the first or after a failed one. */
  lastMs: number | null = null;
  private opts: { everyMs?: number; lookMs?: number };
  constructor(opts: { everyMs?: number; lookMs?: number } = {}) { this.opts = opts; }

  /** `port` is the one the server is bound to (the socket systemd hands over included). */
  start(port: number) {
    if (this.worker) return;
    const worker = new Worker(WORKER, { eval: true, workerData: { port, pid: process.pid, everyMs: this.opts.everyMs ?? 1000, lookMs: this.opts.lookMs ?? 20 } });
    worker.on('message', (m: ProbeMessage) => {
      this.lastMs = m.ms;
      this.msgs.push(m);
      // A window is read every 5 minutes; this bounds a run that nobody reads.
      if (this.msgs.length > 3000) this.msgs.splice(0, this.msgs.length - 3000);
    });
    worker.on('error', () => {});
    worker.unref();
    this.worker = worker;
  }

  /** The window since the last take, with the load and running turns the caller reads; null when no probe ended. */
  take(load: number, turns: number): AnswerWindow | null {
    const m = this.msgs;
    this.msgs = [];
    return summarize(m, load, turns);
  }

  stop() { void this.worker?.terminate(); this.worker = null; }
}
