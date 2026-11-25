// Jobs that belong to a minion, not to its turn (#1890; Josh, 2026-11-24: "Is there a way for us to rearchitect to allow
// background jobs to continue while releasing the worker?", and "End and wake" for a wait). A turn's own background
// processes end with it, so a minion waiting on one held its worker. tools/citadel-job asks here for a job instead: the
// server starts it (a unit of its own in the heavy slice for a host turn, inside the same container for a container's),
// follows its folder, and wakes the minion with how it went. citadel-wait hands a long wait over the same way: the job
// is then that wait, run on.
//   The folder, <the minion's temp folder>/jobs/<id>, is the minion's: it may be a container's, so nothing in it is
// trusted. The server writes an empty `stop` there, and reads only the exit code (a number), how it ended (one of two
// words) and the age of `beat`, which tools/citadel-job-run.sh touches each second. What the server knows of a job (whose
// it is, where it runs, its limit) is its own, in settings, so a restart loses none and wakes each minion once.
import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fallbacks } from './fallbacks.ts';
import { thpProps } from './unit-thp.ts';

export interface MinionJob {
  id: string;
  ticket: number;
  kind: 'job' | 'wait';
  /** The command or the test, as the minion typed it, cut short. */
  what: string;
  dir: string;
  /** The container it runs in; null on the host. */
  container: string | null;
  started: number;
  limitMs: number;
  /** Seconds the wait had run in the turn before it was handed over. */
  waited?: number;
  ended?: number;
  code?: number | null;
  how?: 'stopped' | 'timeout' | 'lost';
  /** Stopped by a person, the minion or its close: nobody is woken for it. */
  quiet?: boolean;
}

/** One wait that ended a turn, for the Status page. */
export interface WaitEnded {
  at: number;
  kind: 'job' | 'wait';
  ms: number;
  /** Whether the woken turn found its session's cache gone; null until that turn starts. */
  cold: boolean | null;
  ticket: number;
}

export interface JobDeps {
  store: { getSetting<T>(key: string): T | undefined | null; setSetting(key: string, value: unknown): void; deleteSetting(key: string): void };
  /** The minion's temp folder; null when it is gone or closed. */
  tmp(ticket: number): string | null;
  /** Where its running turn is, or why that turn can't start jobs. */
  turn(ticket: number): { container: string | null } | { refuse: string };
  /** Whether a turn of its runs now. */
  live(ticket: number): boolean;
  /** How long a wait stays in this minion's turn now, ms: none under pressure. */
  hold(ticket: number): Promise<number>;
  /** Whether a Grunt of its turn works now. */
  grunts(ticket: number): boolean;
  units(): boolean;
  wake(ticket: number, text: string): void;
  /** Its row changed. */
  changed(ticket: number): void;
  /** A command's job ended at its own limit (#1992). */
  cutOff?(job: MinionJob): void;
  lastTurnEnd(ticket: number): number | null;
  cacheMs: number;
  now?: () => number;
  /** Runs an argv to its end (tests replace it). */
  run?(argv: string[]): Promise<void>;
}

const KEY = 'minion-jobs';
const STATS = 'minion-jobs-ended';
const wokenKey = (ticket: number) => `minion-job-woken:${ticket}`;
const ID = /^[a-z0-9]{6,12}-[0-9a-f]{8}$/;
const JOB_MIN = 360;
const MAX_MIN = 720;
const WAIT_MIN = 180;
/** Running at once for one minion. */
const MAX_JOBS = 6;
/** The turn that started it gets this long to read a short job's end itself before it counts as a wake. */
const SEEN_MS = 10_000;
/** No beat for this long: killed, or its container went. A frozen one (memory relief) comes back well before. */
const LOST_MS = 10 * 60_000;
const STATS_MS = 7 * 24 * 3600_000;
const RETRY_S = 30;

const short = (s: string, n = 120) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};
const span = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)} s` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3600_000).toFixed(1)} h`);

export class JobRefused extends Error {
  status: number;
  constructor(message: string, status = 409) {
    super(message);
    this.status = status;
  }
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** A small plain file's text (never a symlink, a pipe or a large one), or null. */
async function small(file: string): Promise<string | null> {
  try {
    const st = await lstat(file);
    return st.isFile() && st.size <= 64 ? (await readFile(file, 'utf8')).trim() : null;
  } catch {
    return null;
  }
}

/** What a job's folder says: its exit code, its limit or stop, and when it last beat. */
export async function readFolder(dir: string): Promise<{ code: number | null; how: 'stopped' | 'timeout' | null; beat: number | null; gone: boolean }> {
  const [code, how, beat, there] = await Promise.all([
    small(join(dir, 'code')),
    small(join(dir, 'how')),
    lstat(join(dir, 'beat')).then(
      (st) => st.mtimeMs,
      () => null,
    ),
    // Only a folder that is really not there counts as gone, never a read that failed.
    lstat(dir).then(
      () => true,
      (err: NodeJS.ErrnoException) => err.code !== 'ENOENT',
    ),
  ]);
  return { code: code !== null && /^\d{1,3}$/.test(code) ? Number(code) : null, how: how === 'stopped' || how === 'timeout' ? how : null, beat, gone: !there };
}

export class MinionJobs {
  private d: JobDeps;
  private jobs: MinionJob[];
  private pumping = false;
  private readonly now: () => number;

  constructor(d: JobDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.jobs = d.store.getSetting<MinionJob[]>(KEY) ?? [];
  }

  private save() {
    if (this.jobs.length) this.d.store.setSetting(KEY, this.jobs);
    else this.d.store.deleteSetting(KEY);
  }

  /** Its jobs still running, the ones being stopped left out. */
  running(ticket: number): MinionJob[] {
    return this.jobs.filter((j) => j.ticket === ticket && !j.quiet && j.ended === undefined);
  }

  /** Jobs in a person's container, which must not be stopped under them. */
  inContainer(container: string): number {
    return this.jobs.filter((j) => j.container === container && j.ended === undefined).length;
  }

  /** What the server does for an idle minion, as its row shows it (runner.serverWork). */
  work(ticket: number): { kind: 'job'; text: string; since: number } | null {
    const [job, ...more] = this.running(ticket);
    if (!job) return null;
    // Its files by name: a row has no room for folders.
    const text = `Waiting for ${short(job.what.replace(/[^\s'"=]*\/(?=[^\s/])/g, ''), 60)}${job.kind === 'job' ? ' to finish' : ''}`;
    return { kind: 'job', text: more.length ? `${text} (and ${more.length} more)` : text, since: job.started };
  }

  /** The line a turn gets while its jobs run on. */
  turnLine(ticket: number): string | null {
    const jobs = this.running(ticket);
    if (!jobs.length) return null;
    const list = jobs.map((j) => `${j.kind === 'wait' ? 'waiting for' : 'running'} \`${short(j.what)}\` (${j.id}, ${span(this.now() - j.started)} so far${j.kind === 'job' ? `, output: ${join(j.dir, 'output.log')}` : ''})`);
    return `The server still works on what you handed over: ${list.join('; ')}. You are woken when it ends, so don't start it again. Editing the files a test or build runs on spoils its result: stop it first (\`citadel-job --stop <id>\`) if you must.`;
  }

  /** A turn's start: whether it was woken cold, and it is first in line no more. */
  turnStarted(ticket: number) {
    const { store } = this.d;
    if (!store.getSetting(wokenKey(ticket))) return;
    store.deleteSetting(wokenKey(ticket));
    const stats = this.stats();
    const ended = this.d.lastTurnEnd(ticket);
    const cold = ended !== null && this.now() - ended >= this.d.cacheMs;
    for (const s of stats) if (s.ticket === ticket && s.cold === null) s.cold = cold;
    store.setSetting(STATS, stats);
  }

  stats(): WaitEnded[] {
    return (this.d.store.getSetting<WaitEnded[]>(STATS) ?? []).filter((s) => this.now() - s.at < STATS_MS);
  }

  private turnFor(ticket: number): { container: string | null } {
    const turn = this.d.turn(ticket);
    if ('refuse' in turn) throw new JobRefused(turn.refuse);
    return turn;
  }

  /** Whether a wait `waited` seconds long is taken over now, asked again later, or left to the turn ({}). */
  async ask(ticket: number, what: string, waited: number): Promise<{ take?: true; retryIn?: number }> {
    this.turnFor(ticket);
    const cut = short(what);
    // Run again after it was handed over, as a Grunt does: it waits in the turn.
    const room = this.running(ticket);
    if (room.length >= MAX_JOBS || room.some((j) => j.kind === 'wait' && j.what === cut)) return {};
    const left = (await this.d.hold(ticket)) / 1000 - waited;
    // A Grunt lives in the turn, so the turn stays.
    if (left <= 0) return this.d.grunts(ticket) ? { retryIn: RETRY_S } : { take: true };
    return { retryIn: Math.max(2, Math.min(RETRY_S, left)) };
  }

  async start(ticket: number, ask: { id: string; dir: string; what: string; kind: 'job' | 'wait'; minutes?: number; waited?: number }): Promise<{ id: string; holdMs: number }> {
    const turn = this.turnFor(ticket);
    const tmp = this.d.tmp(ticket);
    if (!tmp) throw new JobRefused('This minion has no temp folder');
    if (!ID.test(ask.id)) throw new JobRefused('Not a job id', 400);
    const dir = join(tmp, 'jobs', ask.id);
    if (ask.dir !== dir) throw new JobRefused(`A job's folder is in ${join(tmp, 'jobs')}: run it with the turn's own TMPDIR`, 400);
    const real = await Promise.all([realpath(dir), realpath(tmp), lstat(join(dir, 'run.sh'))]).catch(() => null);
    if (!real || real[0] !== real[1] + dir.slice(tmp.length)) throw new JobRefused('Its folder is not there', 400);
    if (this.jobs.some((j) => j.id === ask.id)) throw new JobRefused('That job started already');
    if (this.running(ticket).length >= MAX_JOBS) throw new JobRefused(`${MAX_JOBS} of this minion's jobs run already`);
    const asked = ask.kind === 'wait' ? WAIT_MIN : (ask.minutes ?? JOB_MIN);
    const minutes = Math.min(MAX_MIN, Math.max(1, Number.isFinite(asked) ? asked : JOB_MIN));
    const job: MinionJob = { id: ask.id, ticket, kind: ask.kind, what: short(ask.what), dir, container: turn.container, started: this.now(), limitMs: minutes * 60_000, ...(ask.waited ? { waited: ask.waited } : {}) };
    this.jobs.push(job);
    this.save();
    try {
      await this.launch(job);
    } catch (err) {
      // Claimed here, a start that still comes late ends at once; claimed already, it did start, whatever its launcher said.
      const late = await mkdir(join(dir, 'claim')).then(
        () => false,
        (e: NodeJS.ErrnoException) => e.code === 'EEXIST',
      );
      if (!late) {
        this.drop(job);
        throw new JobRefused(`It could not be started: ${short(String((err as Error).message), 300)}`, 502);
      }
    }
    this.d.changed(ticket);
    return { id: job.id, holdMs: await this.d.hold(ticket) };
  }

  private async launch(job: MinionJob): Promise<void> {
    const run = this.d.run ?? ((argv) => new Promise<void>((done, fail) => execFile(argv[0], argv.slice(1), { timeout: 30_000 }, (err, _out, stderr) => (err ? fail(new Error(String(stderr).trim() || err.message)) : done()))));
    const wrapper = ['env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'bash', '--noprofile', '--norc', join(job.dir, 'run.sh'), job.dir, String(Math.round(job.limitMs / 1000))];
    const unit = `--unit=citadel-job-${job.id}`;
    const said = `A job of minion ${job.ticket}`;
    if (job.container) {
      const exec = ['podman', 'exec', '-d', job.container, ...wrapper];
      if (!this.d.units()) return run(exec);
      // In a scope of its own, as a container's turns are (runner.ts spawnInContainer): a restart of the server leaves it alone.
      try {
        await run(['systemd-run', '--user', '--scope', '--collect', '--quiet', unit, '--slice=citadel-turns.slice', ...exec]);
        fallbacks.started('scope');
      } catch (err) {
        await run(exec);
        fallbacks.record(job.ticket, said, (err as Error).message, this.now(), 'scope');
      }
      return;
    }
    if (this.d.units()) {
      try {
        // Memory running out in it stops the command, not the wrapper that records its end.
        await run(['systemd-run', '--user', '--collect', '--quiet', unit, '--slice=citadel-heavy.slice', '-p', 'UMask=0077', '-p', 'OOMPolicy=continue', ...thpProps(), `--description=${said}`, '--', ...wrapper]);
        return fallbacks.started();
      } catch (err) {
        fallbacks.record(job.ticket, said, (err as Error).message);
      }
    }
    const child = spawn(wrapper[0], wrapper.slice(1), { detached: true, stdio: 'ignore' });
    child.unref();
    await new Promise<void>((done, fail) => child.once('spawn', done).once('error', fail));
  }

  private drop(job: MinionJob) {
    this.jobs = this.jobs.filter((j) => j !== job);
    this.save();
  }

  private stopJob(job: MinionJob) {
    job.quiet = true;
    // There already, or its folder went, which stops it too. pump() asks again.
    void open(join(job.dir, 'stop'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      .then((f) => f.close())
      .catch(() => {});
  }

  /** Stop a minion's jobs (or one): a person's Stop, its close, or its own ask. False when none ran. */
  stop(ticket: number, id?: string): boolean {
    const jobs = this.running(ticket).filter((j) => !id || j.id === id);
    for (const job of jobs) this.stopJob(job);
    // One that ended unseen meanwhile wakes nobody either, nor is a wake still in the line first in it.
    for (const j of this.jobs) if (j.ticket === ticket && (!id || j.id === id)) j.quiet = true;
    if (!id) this.d.store.deleteSetting(wokenKey(ticket));
    this.save();
    if (jobs.length) this.d.changed(ticket);
    return jobs.length > 0;
  }

  /** One look at each job; the server's clock calls it every few seconds. */
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (const job of [...this.jobs]) await this.look(job).catch((err) => console.error(`Job ${job.id} of minion ${job.ticket}:`, err));
    } finally {
      this.pumping = false;
    }
  }

  private async look(job: MinionJob) {
    if (job.ended === undefined) {
      if (job.quiet) this.stopJob(job);
      const f = await readFolder(job.dir);
      const now = this.now();
      const lost = f.gone || now - Math.max(f.beat ?? 0, job.started) > LOST_MS;
      if (f.code === null && !lost) return;
      Object.assign(job, { ended: now, code: f.code, ...(f.code === null ? { how: 'lost' } : f.how ? { how: f.how } : {}) });
      this.save();
      this.d.changed(job.ticket);
      if (job.how === 'timeout' && job.kind === 'job') this.d.cutOff?.(job);
    }
    const seen = await exists(join(job.dir, 'seen'));
    // No await from here on: a Stop or close in between is heard.
    if (job.quiet || this.d.tmp(job.ticket) === null || seen) return this.drop(job);
    const now = this.now();
    // Its turn reads a short one's end itself, unless the turn is over.
    if (now - job.ended! < SEEN_MS && this.d.live(job.ticket)) return;
    this.wake(job, now);
  }

  private wake(job: MinionJob, now: number) {
    const { store } = this.d;
    if (!this.d.live(job.ticket)) {
      store.setSetting(wokenKey(job.ticket), true);
      store.setSetting(STATS, [...this.stats(), { at: now, kind: job.kind, ms: this.ran(job), cold: null, ticket: job.ticket } satisfies WaitEnded].slice(-5000));
    }
    this.d.wake(job.ticket, this.wakeText(job));
    this.drop(job);
  }

  /** How long it took, the part a wait spent in its turn included. */
  private ran(job: MinionJob): number {
    return job.ended! - job.started + (job.waited ?? 0) * 1000;
  }

  private wakeText(job: MinionJob): string {
    const ran = span(this.ran(job));
    const log = join(job.dir, 'output.log');
    const what = `\`${job.what}\``;
    if (job.how === 'lost') return `${job.kind === 'wait' ? 'The wait' : 'The job'} you handed over (${what}) was cut off after ${ran}, with no result: killed from outside, or its container stopped. What it printed: ${log}. Check where things stand, then run it again if it's still needed.`;
    if (job.kind === 'wait') {
      if (job.code === 0) return `What you waited for has happened, after ${ran}: ${what}. Carry on from there.`;
      if (job.how !== 'timeout' && job.code !== 124) return `The wait you handed over (${what}) was stopped after ${ran}, before it happened (exit ${job.code}). What it printed: ${log}. Check where things stand, then wait again if it's still needed.`;
      return `The wait you handed over reached its time limit after ${ran} and ${what} hasn't happened. Find out why before waiting again (what it printed: ${log}).`;
    }
    if (job.how === 'timeout') return `The job you handed over (${what}) was stopped at its time limit, ${ran}. Its output: ${log}`;
    return `The job you handed over has ended: ${what} exited ${job.code} after ${ran}. Its output: ${log}`;
  }
}

/** Whether a job's wake waits for this minion's turn: it goes ahead of new turns in the line (src/line-place.ts). */
export const wokenWaits = (store: { getSetting<T>(key: string): T | undefined | null }, ticket: number) => !!store.getSetting(wokenKey(ticket));
