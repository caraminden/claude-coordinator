// Long heavy jobs (#1363; Cara, 2026-11-20: "maybe we need a lane for LONG jobs like this to run while I am sleeping?").
// `citadel-heavy --long <command>` (tools/heavy-ci.ts) pushes a snapshot of the minion's working copy and writes
// <CITADEL_HEAVY_DIR>/long/<id>.json, then the minion ends its turn. This pump, once a minute, starts each queued job on
// its scheme's CI at night: from 2am Pacific until the job hours of the PC running that repo's runners end (the GPU jobs'
// hours, src/machine-jobs.ts; Cara, 2026-11-20, picked "Nights only", "Start them at 2am"), one long job per repo at a time,
// so ships never test beside one in the day. A workflow with a `long` input runs it on a runner of its own (#1592: on
// 2026-11-22 one held the side runner for 5 hours while five flake proofs queued behind it). It reads
// the run from GitHub on every pass, so a restart loses nothing; when the run ends it writes the command's output to
// <id>.log beside the job and wakes the minion that queued it, as a GPU job's end does. Every scheme with a
// citadel-heavy workflow gets it: the job carries its repo, and the scheme's owner's GitHub login dispatches it.
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  /** The minion's scheme and its repo's owner/name; null when the minion is gone. */
  scheme(ticket: number): { projectId: number; slug: string | null } | null;
  /** The job hours of the PC that runs this repo's CI runners. */
  hours(slug: string): JobSettings;
  /** `gh api <args>` as the scheme's GitHub login; resolves to its stdout. */
  gh(projectId: number, args: string[]): Promise<string>;
  wake(ticket: number, text: string, light: boolean): void;
  /** A line in the minion's chat that wakes nobody. */
  note(ticket: number, text: string): void;
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
export function cleanJob(raw: any): LongJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max;
  if (!str(raw.id, 60) || !ID.test(raw.id) || !Number.isInteger(raw.ticket) || raw.ticket <= 0) return null;
  if (!str(raw.slug, 200) || !/^[\w.-]+\/[\w.-]+$/.test(raw.slug) || !str(raw.sha, 40) || !/^[0-9a-f]{40}$/.test(raw.sha)) return null;
  if (!str(raw.command, 20_000) || !str(raw.what, 200) || !str(raw.who, 200) || !Number.isFinite(raw.queued_at)) return null;
  if (!['queued', 'dispatched', 'running', 'done', 'failed', 'lost'].includes(raw.state)) return null;
  return raw as LongJob;
}

/** Every job in citadel-heavy's folder's long/, oldest first. */
export function readLongJobs(heavyDir: string): LongJob[] {
  const root = join(heavyDir, 'long');
  let names: string[] = [];
  try { names = readdirSync(root).filter((n) => n.endsWith('.json')); } catch { return []; }
  const jobs: LongJob[] = [];
  for (const n of names) {
    try { const j = cleanJob(JSON.parse(readFileSync(join(root, n), 'utf8'))); if (j && n === `${j.id}.json`) jobs.push(j); } catch { /* half written or not a job */ }
  }
  return jobs.sort((a, b) => a.queued_at - b.queued_at);
}

export class LongJobs {
  private busy = false;
  private readonly d: LongDeps;
  private readonly root: string;
  constructor(d: LongDeps) {
    this.d = d;
    this.root = join(d.dir, 'long');
  }
  private now() { return this.d.now?.() ?? Date.now(); }
  logPath(id: string) { return join(this.root, `${id}.log`); }

  list(): LongJob[] { return readLongJobs(this.d.dir); }

  private save(j: LongJob) {
    const tmp = join(this.root, `.${j.id}.server.tmp`);
    writeFileSync(tmp, JSON.stringify(j) + '\n', { mode: 0o666 });
    renameSync(tmp, join(this.root, `${j.id}.json`));
  }

  /** One pass: start what may start, read what runs, sweep what ended long ago. */
  async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      const jobs = this.list();
      const held = new Set(jobs.filter((j) => ACTIVE.includes(j.state)).map((j) => j.slug.toLowerCase()));
      for (const j of jobs) {
        const s = this.d.scheme(j.ticket);
        if (ENDED.includes(j.state)) { if (j.woke === false && s) this.tell(j); continue; }
        if (!s) { this.finish(j, 'lost', null, 'the minion that queued it is gone', null); continue; }
        if (!same(s.slug, j.slug)) { this.finish(j, 'lost', null, `its repo ${j.slug} isn't its scheme's (${s.slug ?? 'none'})`, s.projectId); continue; }
        try {
          if (j.state === 'queued' && !held.has(j.slug.toLowerCase())) { if (await this.start(j, s.projectId)) held.add(j.slug.toLowerCase()); }
          else if (ACTIVE.includes(j.state)) await this.watch(j, s.projectId);
          if (j.misses && !ENDED.includes(j.state)) { j.misses = 0; this.save(j); }
        } catch (e) {
          j.misses = (j.misses ?? 0) + 1;
          j.why = (e as Error).message.slice(0, 300);
          if (j.misses < MAX_MISSES) { this.save(j); continue; }
          // A run GitHub may still be running is cancelled, so a requeued copy never runs beside it.
          if (j.run_id) this.d.gh(s.projectId, ['-X', 'POST', `repos/${j.slug}/actions/runs/${j.run_id}/cancel`]).catch(() => { /* GitHub is down anyway */ });
          this.finish(j, 'lost', null, `GitHub kept failing for an hour (${j.why})`, s.projectId);
        }
      }
      this.sweep(jobs);
    } finally {
      this.busy = false;
    }
  }

  /** Dispatch a queued job from 2am until its PC's job hours end; false when it waits. */
  private async start(j: LongJob, projectId: number): Promise<boolean> {
    const hours = this.d.hours(j.slug), now = this.now();
    // A paused machine (its GPU jobs' pause) holds long jobs too.
    if (hours.paused || !hoursOpen(hours, now) || !hoursOpen({ ...hours, start: LONG_START, until: null }, now)) return false;
    const branch = JSON.parse(await this.d.gh(projectId, [`repos/${j.slug}`])).default_branch;
    // GitHub checks inputs against the workflow on the branch it runs, so `minutes` goes only when that copy declares it.
    const wf = JSON.parse(await this.d.gh(projectId, [`repos/${j.slug}/contents/.github/workflows/${WORKFLOW}?ref=${encodeURIComponent(branch)}`]));
    const text = Buffer.from(wf.content ?? '', 'base64').toString('utf8');
    const minutes = /^\s+minutes:\s*$/m.test(text) ? ['-f', `inputs[minutes]=${LONG_MINUTES}`] : [];
    // A `long` input sends it to a runner only long jobs use, so flake proofs and heavy runs never queue behind it (#1592).
    if (/^\s+long:\s*$/m.test(text)) minutes.push('-f', 'inputs[long]=true');
    // Saved first and never put back on an error: a dispatch GitHub took but didn't answer is found by watch(), and one it
    // never took goes back in line there once it shows no run, so the command can't run twice.
    Object.assign(j, { state: 'dispatched', dispatched_at: this.now(), tries: (j.tries ?? 0) + 1 });
    this.save(j);
    await this.d.gh(projectId, ['-X', 'POST', `repos/${j.slug}/actions/workflows/${WORKFLOW}/dispatches`, '-f', `ref=${branch}`,
      '-f', `inputs[sha]=${j.sha}`, '-f', `inputs[command]=${j.command}`, '-f', `inputs[id]=${j.id}`, ...minutes]);
    this.d.note(j.ticket, `Long job ${j.id} (${j.what}) went to ${j.slug}'s CI for the night.`);
    return true;
  }

  /** Find a dispatched job's run, mark it running, and finish it once GitHub says it completed. */
  private async watch(j: LongJob, projectId: number) {
    if (!j.run_id) {
      const runs = JSON.parse(await this.d.gh(projectId, [`repos/${j.slug}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=100`])).workflow_runs ?? [];
      const run = runs.find((r: any) => r.display_title === `heavy ${j.id}`);
      if (!run) {
        if (this.now() - (j.dispatched_at ?? 0) < NO_RUN_MS) return;
        if ((j.tries ?? 0) >= MAX_TRIES) { this.finish(j, 'lost', null, `GitHub showed no run for any of its ${j.tries} dispatches${j.why ? ` (last error: ${j.why})` : ''}`, projectId); return; }
        Object.assign(j, { state: 'queued', dispatched_at: undefined });
        this.save(j);
        return;
      }
      Object.assign(j, { run_id: run.id, url: run.html_url });
      this.save(j);
    }
    const run = JSON.parse(await this.d.gh(projectId, [`repos/${j.slug}/actions/runs/${j.run_id}`]));
    if (run.status !== 'completed') {
      if (j.state === 'dispatched' && run.status === 'in_progress') { Object.assign(j, { state: 'running', started_at: this.now() }); this.save(j); }
      return;
    }
    const job = JSON.parse(await this.d.gh(projectId, [`repos/${j.slug}/actions/runs/${j.run_id}/jobs`])).jobs?.[0];
    // shortcut: a run no runner took for GitHub's 24 hours ends here as lost; requeue it instead if desktops are often off that long.
    if (!job?.runner_name) { this.finish(j, 'lost', null, `the CI run ended ${run.conclusion} before a runner took it`, projectId); return; }
    // Loaded on use: a server copy with only server.ts, src/ and public/ still boots (test/boot-imports.test.ts).
    const { commandOutput } = await import('../tools/heavy-ci.ts');
    const out = commandOutput(await this.d.gh(projectId, ['--allow-escape-sequences', `repos/${j.slug}/actions/jobs/${job.id}/logs`]));
    writeFileSync(this.logPath(j.id), out.lines.join('\n') + (out.lines.length ? '\n' : ''), { mode: 0o666 });
    if (out.code === null) this.finish(j, 'lost', null, `the CI run ended ${run.conclusion} before the command finished`, projectId);
    else this.finish(j, out.code === 0 ? 'done' : 'failed', out.code, undefined, projectId);
  }

  /** End a job: save it, drop its snapshot ref, wake its minion with the status and where the output is. */
  private finish(j: LongJob, state: 'done' | 'failed' | 'lost', code: number | null, why: string | undefined, projectId: number | null) {
    Object.assign(j, { state, code, why, ended_at: this.now(), woke: projectId === null });
    this.save(j);
    if (projectId === null) return;
    this.d.gh(projectId, ['-X', 'DELETE', `repos/${j.slug}/git/refs/citadel-heavy/${j.id}`]).catch(() => { /* a stray ref costs nothing */ });
    this.tell(j);
  }

  /** Wake an ended job's minion, then mark it woken. */
  private tell(j: LongJob) {
    const { state, code, why } = j;
    const ran = j.started_at ? ` after ${dur((j.ended_at ?? this.now()) - j.started_at)}` : '';
    const log = existsSync(this.logPath(j.id)) ? this.logPath(j.id) : null;
    const run = j.url ? ` CI run: ${j.url}` : '';
    const text = state === 'lost'
      ? `Long job ${j.id} (${j.what}) was lost: ${why}.${log ? ` What it printed: ${log}.` : ''}${run} Nothing more runs; queue it again with citadel-heavy --long if it still needs to run.`
      : `Long job ${j.id} (${j.what}) ${state === 'done' ? 'passed' : 'failed'} with exit ${code}${ran}. Output: ${log}.${run}`;
    this.d.wake(j.ticket, text, state === 'done');
    j.woke = true;
    this.save(j);
  }

  /** Ended jobs past KEEP_MS go, with their logs; a turn's leftover temp file goes after a day. */
  private sweep(jobs: LongJob[]) {
    const now = this.now();
    for (const j of jobs) {
      if (j.ended_at && now - j.ended_at > KEEP_MS) for (const f of [`${j.id}.json`, `${j.id}.log`]) rmSync(join(this.root, f), { force: true });
    }
    try {
      for (const n of readdirSync(this.root)) if (n.endsWith('.tmp') && now - statSync(join(this.root, n)).mtimeMs > 24 * 3600_000) rmSync(join(this.root, n), { force: true });
    } catch { /* none */ }
  }
}

/** What the CI page's host load shows: queued and running long jobs, and those that ended in the last day. */
export function longView(jobs: LongJob[], now = Date.now()) {
  return jobs.filter((j) => !j.ended_at || now - j.ended_at < 24 * 3600_000).map((j) => ({
    id: j.id, who: j.who, what: j.what, slug: j.slug, state: j.state, since: j.ended_at ?? j.started_at ?? j.dispatched_at ?? j.queued_at,
    queuedAt: j.queued_at, url: j.url ?? null, code: j.code ?? null, why: j.why ?? null,
  }));
}
