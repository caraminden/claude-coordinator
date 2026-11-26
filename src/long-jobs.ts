// Long heavy jobs (#1363; Cara, 2026-11-20: "maybe we need a lane for LONG jobs like this to run while I am sleeping?").
// `citadel-heavy --long <command>` (tools/heavy-ci.ts) pushes a snapshot of the minion's working copy and writes
// <CITADEL_HEAVY_DIR>/long/<id>.json, then the minion ends its turn. This pump, once a minute, starts each queued job on
// its scheme's CI at night: from 2am Pacific until the job hours of the PC running that repo's runners end (the GPU jobs'
// hours, src/machine-jobs.ts; Cara, 2026-11-20, picked "Nights only", "Start them at 2am"), one long job per repo at a time,
// so ships never test beside one in the day. A quiet job (#1902) is an ordinary heavy job ships held: it starts as soon as
// src/ci-hold.ts lets it, day or night. A workflow with a `long` input runs it on a runner of its own (#1592: on
// 2026-11-22 one held the side runner for 5 hours while five flake proofs queued behind it). It reads
// the run from GitHub on every pass, so a restart loses nothing; when the run ends it writes the command's output to
// <id>.log beside the job and wakes the minion that queued it, as a GPU job's end does. Every scheme with a
// citadel-heavy workflow gets it: the job carries its repo, and the scheme's owner's GitHub login dispatches it.
import { readdirSync, readFileSync } from 'node:fs';
import { access, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hoursOpen, type JobSettings } from './machine-jobs.ts';

export type LongState = 'queued' | 'dispatched' | 'running' | 'done' | 'failed' | 'lost';
export interface LongJob {
  id: string;
  ticket: number;
  slug: string;
  sha: string;
  command: string;
  what: string;
  who: string;
  queued_at: number;
  state: LongState;
  /** #1902: an ordinary heavy job a ship held off CI. It starts once the line is empty (or at the hold's cap), by day too, under its usual limit. */
  quiet?: boolean;
  /** When ships first held it (src/ci-hold.ts). */
  held_at?: number;
  /** Why it waits, while held with no run yet. */
  held_why?: string;
  /** Its long hold was told to its Taskmaster (src/ci-hold.ts). */
  reported?: boolean;
  dispatched_at?: number;
  started_at?: number;
  ended_at?: number;
  run_id?: number;
  url?: string;
  code?: number | null;
  /** Why it was lost, or the last GitHub error while it keeps trying. */
  why?: string;
  /** GitHub calls that failed in a row. */
  misses?: number;
  /** Dispatches sent; a job GitHub keeps showing no run for is given up after MAX_TRIES. */
  tries?: number;
  /** False from the moment it ends until its minion is woken, so a restart in between still wakes it. */
  woke?: boolean;
}

export interface LongDeps {
  /** citadel-heavy's folder; jobs are in its long/. */
  dir: string;
  /** The minion's scheme and its repo's owner/name, and whether it is dismissed (pending-deploy isn't); null when the minion is gone. */
  scheme(ticket: number): { projectId: number; slug: string | null; closed?: boolean } | null;
  /** The job hours of the PC that runs this repo's CI runners. */
  hours(slug: string): JobSettings;
  /** `gh api <args>` as the scheme's GitHub login; resolves to its stdout. */
  gh(projectId: number, args: string[]): Promise<string>;
  wake(ticket: number, text: string, light: boolean): void;
  /** A line in the minion's chat that wakes nobody. */
  note(ticket: number, text: string): void;
  /** Why optional work may not start on this repo's CI now (src/ci-hold.ts), or null. */
  hold?(slug: string, since?: number): string | null;
  /** A run the hold stopped and will start again. */
  heldRun?(run: number): boolean;
  now?: () => number;
}

const WORKFLOW = 'citadel-heavy.yml';
/** The earliest a long job starts in the night, Pacific; it still needs the PC's job hours open. */
export const LONG_START = '02:00';
/** The run's time limit when the scheme's workflow takes a `minutes` input; a workflow without one keeps its own. */
export const LONG_MINUTES = 360;
/** GitHub errors in a row (one per pass, a minute apart) before a job is given up as lost: an hour rides out an outage. */
const MAX_MISSES = 60;
/** Dispatches GitHub showed no run for before the job is given up. */
const MAX_TRIES = 3;
/** A dispatched job GitHub shows no run for after this long goes back in line. */
const NO_RUN_MS = 5 * 60_000;
/** Ended jobs and their logs are kept this long. */
export const KEEP_MS = 7 * 24 * 3600_000;
const ID = /^[a-z0-9]+-\d+-[a-z0-9]+$/;
const ACTIVE: LongState[] = ['dispatched', 'running'];
const ENDED: LongState[] = ['done', 'failed', 'lost'];
const same = (a: string | null, b: string) => a?.toLowerCase() === b.toLowerCase();

const dur = (ms: number) => (ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : `${(ms / 3600_000).toFixed(1)} h`);

/** A job file as a turn wrote it, or null when it isn't one: it comes from a turn, so every field is checked. */
export function cleanJob(value: unknown): LongJob | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Record<keyof LongJob, unknown>>;
  const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!str(raw.id, 60) || !ID.test(raw.id) || typeof raw.ticket !== 'number' || !Number.isInteger(raw.ticket) || raw.ticket <= 0) return null;
  if (!str(raw.slug, 200) || !/^[\w.-]+\/[\w.-]+$/.test(raw.slug) || !str(raw.sha, 40) || !/^[0-9a-f]{40}$/.test(raw.sha)) return null;
  if (!str(raw.command, 20_000) || !str(raw.what, 200) || !str(raw.who, 200) || !Number.isFinite(raw.queued_at)) return null;
  if (!['queued', 'dispatched', 'running', 'done', 'failed', 'lost'].includes(raw.state as string)) return null;
  return raw as LongJob;
}

/** Every job in citadel-heavy's folder's long/, oldest first. */
export function readLongJobs(heavyDir: string): LongJob[] {
  const root = join(heavyDir, 'long');
  let names: string[] = [];
  try {
    names = readdirSync(root).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return jobsFrom(
    names.map((n) => {
      try {
        return [n, readFileSync(join(root, n), 'utf8')];
      } catch {
        return [n, ''];
      }
    }),
  );
}

/** readLongJobs with every file read off the server's thread (#1980). Throws when the folder is there and can't be listed. */
export async function readLongJobsA(heavyDir: string): Promise<LongJob[]> {
  const root = join(heavyDir, 'long');
  const names = (
    await readdir(root).catch((err): string[] => {
      if (err.code === 'ENOENT') return [];
      throw err;
    })
  ).filter((n) => n.endsWith('.json'));
  return jobsFrom(await Promise.all(names.map(async (n): Promise<[string, string]> => [n, await readFile(join(root, n), 'utf8').catch(() => '')])));
}

function jobsFrom(files: [name: string, text: string][]): LongJob[] {
  const jobs: LongJob[] = [];
  for (const [n, text] of files) {
    try {
      const j = cleanJob(JSON.parse(text));
      if (j && n === `${j.id}.json`) jobs.push(j);
    } catch {
      /* gone, half written or not a job */
    }
  }
  return jobs.sort((a, b) => a.queued_at - b.queued_at);
}

export class LongJobs {
  private busy = false;
  /** The jobs as last read off the thread; while a pump runs, the ones it is working on are its own objects. */
  private jobs: LongJob[] = [];
  /** Goes up when a pump takes the jobs over and when it is done with them: a refresh that began before is older than what it left. */
  private reads = 0;
  private reading: Promise<void> | null = null;
  private readonly d: LongDeps;
  private readonly root: string;
  constructor(d: LongDeps) {
    this.d = d;
    this.root = join(d.dir, 'long');
  }
  private now() {
    return this.d.now?.() ?? Date.now();
  }
  logPath(id: string) {
    return join(this.root, `${id}.log`);
  }

  /** The jobs as the last pump or refresh left them, with no file read (#1980). */
  list(): LongJob[] {
    return this.jobs;
  }

  /** Read the folder off the server's thread; one read at a time. A failed read keeps the last answer; nothing here throws. */
  refresh(): Promise<void> {
    const at = this.reads;
    return (this.reading ??= readLongJobsA(this.d.dir)
      .then((read) => {
        if (at !== this.reads) return;
        const mine = new Map(this.busy ? this.jobs.map((j) => [j.id, j]) : []);
        this.jobs = read.map((j) => mine.get(j.id) ?? j);
      })
      .catch(() => {})
      .finally(() => {
        this.reading = null;
      }));
  }

  private async save(j: LongJob) {
    const tmp = join(this.root, `.${j.id}.server.tmp`);
    await writeFile(tmp, JSON.stringify(j) + '\n', { mode: 0o666 });
    await rename(tmp, join(this.root, `${j.id}.json`));
  }

  /** One pass: start what may start, read what runs, sweep what ended long ago. */
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      // Its own read, never a refresh's: one begun before the last pump's saves would start a job twice.
      const jobs = await readLongJobsA(this.d.dir);
      this.jobs = jobs;
      this.reads++;
      // One long job per repo at a time, and one quiet one beside it: they run on different runners.
      const lane = (j: LongJob) => `${j.quiet ? 'quiet ' : ''}${j.slug.toLowerCase()}`;
      // A run the hold stopped runs nowhere, so it keeps no other job of its repo from asking the hold, and its cap (#2121:
      // on Nov 25 one such run kept Peek's older jobs from their 4 h cap, and #942's waited 5 h 32 min). Should it come back
      // while one started meanwhile still runs, the two overlap: accepted, as each runner takes one job and the other queues on GitHub.
      const held = new Set(jobs.filter((j) => ACTIVE.includes(j.state) && !(j.run_id && this.d.heldRun?.(j.run_id))).map(lane));
      for (const j of jobs) {
        const s = this.d.scheme(j.ticket);
        if (ENDED.includes(j.state)) {
          if (j.woke === false && s) await this.tell(j);
          continue;
        }
        if (!s) {
          await this.finish(j, 'lost', null, 'the minion that queued it is gone', null);
          continue;
        }
        // Nobody reads it (#2059). A run already on a runner is left alone; and no wake, which would reopen the minion.
        if (s.closed && j.state === 'queued') {
          await this.finish(j, 'lost', null, 'its minion closed', s.projectId, false);
          this.d.note(j.ticket, `${j.quiet ? 'Heavy' : 'Long'} job ${j.id} (${j.what}) was dropped before it started: its minion closed.`);
          continue;
        }
        if (!same(s.slug, j.slug)) {
          await this.finish(j, 'lost', null, `its repo ${j.slug} isn't its scheme's (${s.slug ?? 'none'})`, s.projectId);
          continue;
        }
        try {
          if (j.state === 'queued' && !held.has(lane(j))) {
            if (await this.start(j, s.projectId)) held.add(lane(j));
          } else if (ACTIVE.includes(j.state)) await this.watch(j, s.projectId);
          if (j.misses && !ENDED.includes(j.state)) {
            j.misses = 0;
            await this.save(j);
          }
        } catch (e) {
          j.misses = (j.misses ?? 0) + 1;
          j.why = (e as Error).message.slice(0, 300);
          if (j.misses < MAX_MISSES) {
            await this.save(j);
            continue;
          }
          // A run GitHub may still be running is cancelled, so a requeued copy never runs beside it.
          if (j.run_id)
            this.d.gh(s.projectId, ['-X', 'POST', `repos/${j.slug}/actions/runs/${j.run_id}/cancel`]).catch(() => {
              /* GitHub is down anyway */
            });
          await this.finish(j, 'lost', null, `GitHub kept failing for an hour (${j.why})`, s.projectId);
        }
      }
      await this.sweep(jobs);
    } finally {
      this.reads++;
      this.busy = false;
    }
  }

  /** Whether a long job may run now: from 2am until its PC's job hours end. A paused machine (its GPU jobs' pause) holds it too. */
  private open(j: LongJob): boolean {
    const hours = this.d.hours(j.slug),
      now = this.now();
    return !hours.paused && hoursOpen(hours, now) && hoursOpen({ ...hours, start: LONG_START, until: null }, now);
  }

  /** Whether a stopped heavy run may start again now (src/ci-hold.ts): a long job only in its hours, any other whenever. */
  mayResume(id: string): boolean {
    const j = this.list().find((x) => x.id === id);
    return !j || !!j.quiet || this.open(j);
  }

  /** Since when ships have held a job, before it had a run or after. */
  heldSince(id: string): number | undefined {
    return this.list().find((x) => x.id === id)?.held_at;
  }

  /** A long hold of this job was told to its Taskmaster: it isn't told again. */
  async told(id: string) {
    const j = this.jobs.find((x) => x.id === id);
    if (!j) return;
    j.reported = true;
    await this.save(j);
  }

  /** Dispatch a queued job: a long one in its hours, either kind only while no ship holds the desktop; false when it waits. */
  private async start(j: LongJob, projectId: number): Promise<boolean> {
    const outside = !j.quiet && !this.open(j);
    const why = outside ? (j.held_at ? 'it is a long job, which starts only in its hours' : null) : this.d.hold?.(j.slug, j.held_at);
    if (why && (!j.held_at || j.held_why !== why)) {
      j.held_at ||= j.quiet ? j.queued_at : this.now();
      j.held_why = why;
      await this.save(j);
    }
    if (why || outside) return false;
    const branch = JSON.parse(await this.d.gh(projectId, [`repos/${j.slug}`])).default_branch;
    // GitHub checks inputs against the workflow on the branch it runs, so `minutes` goes only when that copy declares it.
    const wf = JSON.parse(await this.d.gh(projectId, [`repos/${j.slug}/contents/.github/workflows/${WORKFLOW}?ref=${encodeURIComponent(branch)}`]));
    const text = Buffer.from(wf.content ?? '', 'base64').toString('utf8');
    const minutes = !j.quiet && /^\s+minutes:\s*$/m.test(text) ? ['-f', `inputs[minutes]=${LONG_MINUTES}`] : [];
    // A `long` input sends it to the runner with the long label, so flake proofs and heavy runs never queue behind it on the side runner (#1592; that runner takes side work too between long jobs, #1646).
    if (!j.quiet && /^\s+long:\s*$/m.test(text)) minutes.push('-f', 'inputs[long]=true');
    // Dismissed while GitHub answered: the next pass drops it.
    if (this.d.scheme(j.ticket)?.closed) return false;
    // Saved first and never put back on an error: a dispatch GitHub took but didn't answer is found by watch(), and one it
    // never took goes back in line there once it shows no run, so the command can't run twice.
    Object.assign(j, { state: 'dispatched', dispatched_at: this.now(), tries: (j.tries ?? 0) + 1, held_why: undefined });
    await this.save(j);
    await this.d.gh(projectId, ['-X', 'POST', `repos/${j.slug}/actions/workflows/${WORKFLOW}/dispatches`, '-f', `ref=${branch}`, '-f', `inputs[sha]=${j.sha}`, '-f', `inputs[command]=${j.command}`, '-f', `inputs[id]=${j.id}`, ...minutes]);
    this.d.note(j.ticket, j.quiet ? `Heavy job ${j.id} (${j.what}) went to ${j.slug}'s CI: nothing is ahead of it now.` : `Long job ${j.id} (${j.what}) went to ${j.slug}'s CI for the night.`);
    return true;
  }

  /** Find a dispatched job's run, mark it running, and finish it once GitHub says it completed. */
  private async watch(j: LongJob, projectId: number) {
    if (!j.run_id) {
      const runs = JSON.parse(await this.d.gh(projectId, [`repos/${j.slug}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=100`])).workflow_runs ?? [];
      const run = runs.find((r: Record<string, unknown>) => r.display_title === `heavy ${j.id}`);
      if (!run) {
        if (this.now() - (j.dispatched_at ?? 0) < NO_RUN_MS) return;
        if ((j.tries ?? 0) >= MAX_TRIES) {
          await this.finish(j, 'lost', null, `GitHub showed no run for any of its ${j.tries} dispatches${j.why ? ` (last error: ${j.why})` : ''}`, projectId);
          return;
        }
        Object.assign(j, { state: 'queued', dispatched_at: undefined });
        await this.save(j);
        return;
      }
      Object.assign(j, { run_id: run.id, url: run.html_url });
      await this.save(j);
    }
    // Stopped for a ship: the same run starts again, so its cancelled end isn't the job's.
    if (this.d.heldRun?.(j.run_id!)) {
      if (j.state === 'running') {
        Object.assign(j, { state: 'dispatched', started_at: undefined }); // its deadline (hungProblems) starts again too
        await this.save(j);
      }
      return;
    }
    const run = JSON.parse(await this.d.gh(projectId, [`repos/${j.slug}/actions/runs/${j.run_id}`]));
    if (run.status !== 'completed') {
      if (j.state === 'dispatched' && run.status === 'in_progress') {
        Object.assign(j, { state: 'running', started_at: this.now() });
        await this.save(j);
      }
      return;
    }
    const job = JSON.parse(await this.d.gh(projectId, [`repos/${j.slug}/actions/runs/${j.run_id}/jobs`])).jobs?.[0];
    // shortcut: a run no runner took for GitHub's 24 hours ends here as lost; requeue it instead if desktops are often off that long.
    if (!job?.runner_name) {
      await this.finish(j, 'lost', null, `the CI run ended ${run.conclusion} before a runner took it`, projectId);
      return;
    }
    // Loaded on use: a server copy with only server.ts, src/ and public/ still boots (test/boot-imports.test.ts).
    const { commandOutput } = await import('../tools/heavy-ci.ts');
    const out = commandOutput(await this.d.gh(projectId, ['--allow-escape-sequences', `repos/${j.slug}/actions/jobs/${job.id}/logs`]), run.conclusion);
    await writeFile(this.logPath(j.id), out.lines.join('\n') + (out.lines.length ? '\n' : ''), { mode: 0o666 });
    if (out.code === null) await this.finish(j, 'lost', null, `the CI run ended ${run.conclusion} before the command finished`, projectId);
    else await this.finish(j, out.code === 0 ? 'done' : 'failed', out.code, undefined, projectId);
  }

  /** End a job: save it, drop its snapshot ref, wake its minion (unless `wake` is false) with the status and where the output is. */
  private async finish(j: LongJob, state: 'done' | 'failed' | 'lost', code: number | null, why: string | undefined, projectId: number | null, wake = true) {
    Object.assign(j, { state, code, why, ended_at: this.now(), woke: !wake || projectId === null });
    await this.save(j);
    if (projectId === null) return;
    this.d.gh(projectId, ['-X', 'DELETE', `repos/${j.slug}/git/refs/citadel-heavy/${j.id}`]).catch(() => {
      /* a stray ref costs nothing */
    });
    if (wake) await this.tell(j);
  }

  /** Wake an ended job's minion, then mark it woken. */
  private async tell(j: LongJob) {
    const { state, code, why } = j;
    const ran = j.started_at ? ` after ${dur((j.ended_at ?? this.now()) - j.started_at)}` : '';
    const log = await access(this.logPath(j.id)).then(
      () => this.logPath(j.id),
      () => null,
    );
    const run = j.url ? ` CI run: ${j.url}` : '';
    const name = j.quiet ? 'Heavy job' : 'Long job';
    const text =
      state === 'lost'
        ? `${name} ${j.id} (${j.what}) was lost: ${why}.${log ? ` What it printed: ${log}.` : ''}${run} Nothing more runs; ${j.quiet ? 'run it again with citadel-heavy' : 'queue it again with citadel-heavy --long'} if it still needs to run.`
        : `${name} ${j.id} (${j.what}) ${state === 'done' ? 'passed' : 'failed'} with exit ${code}${ran}. Output: ${log}.${run}`;
    this.d.wake(j.ticket, text, state === 'done');
    j.woke = true;
    await this.save(j);
  }

  /** Ended jobs past KEEP_MS go, with their logs; a turn's leftover temp file goes after a day. */
  private async sweep(jobs: LongJob[]) {
    const now = this.now();
    for (const j of jobs) {
      if (j.ended_at && now - j.ended_at > KEEP_MS) for (const f of [`${j.id}.json`, `${j.id}.log`]) await rm(join(this.root, f), { force: true });
    }
    try {
      for (const n of await readdir(this.root)) if (n.endsWith('.tmp') && now - (await stat(join(this.root, n))).mtimeMs > 24 * 3600_000) await rm(join(this.root, n), { force: true });
    } catch {
      /* none */
    }
  }
}

/** What the CI page's host load shows: queued and running long jobs, and those that ended in the last day. */
export function longView(jobs: LongJob[], now = Date.now()) {
  return jobs
    .filter((j) => !j.ended_at || now - j.ended_at < 24 * 3600_000)
    .map((j) => ({
      id: j.id,
      ticket: j.ticket,
      who: j.who,
      what: j.what,
      quiet: !!j.quiet,
      held: !!j.held_at,
      slug: j.slug,
      state: j.state,
      since: j.ended_at ?? j.started_at ?? j.dispatched_at ?? j.queued_at,
      queuedAt: j.queued_at,
      url: j.url ?? null,
      code: j.code ?? null,
      why: j.why ?? null,
    }));
}
