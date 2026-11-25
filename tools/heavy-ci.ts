// Heavy jobs on the scheme's own CI (#1160, Josh 2026-11-20: "make it part of CI, the goal is to NOT hammer perigee"):
//   node heavy-ci.ts --repo                 prints owner/repo when this repo can take heavy jobs on CI
//   node heavy-ci.ts <command> [args...]    runs the command there and exits with its status
// tools/citadel-heavy calls it; it is not for people. A repo takes heavy jobs when it has
// .github/workflows/citadel-heavy.yml (the kit's scheme-setup/templates/citadel-heavy.yml) on GitHub's default branch and an
// origin on github.com. The job runs the minion's working copy as it is, uncommitted files included: a snapshot
// commit (the branch and index are left alone) pushed to refs/citadel-heavy/<id>, which no push trigger sees, and
// deleted again at the end. It runs in the same folder of the repo, but the caller's environment doesn't go along;
// untracked key and .env files are left out of the snapshot. The workflow prints the command's output between two markers; GitHub only hands a
// job's log over once the job ends, so the output comes then, all at once.
// When nothing ran on CI (no workflow, no gh login, a push or dispatch refused, or no runner took the job within
// CITADEL_HEAVY_CI_QUEUE s, default 600, while nothing else on the repo's CI ran either: the desktop is off) it says why, writes the reason to the file
// CITADEL_HEAVY_FALLBACK_FILE names and exits FALLBACK, and citadel-heavy runs it in perigee's small slot instead.
// Once a run has started it never falls back: a stop or a lost run is reported, not run twice.
//   node heavy-ci.ts --long <command> [args...]   queues a long job and exits at once (#1363, below)
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { HoldFile } from '../src/ci-hold-file.ts';

export const FALLBACK = 120;
export const BEGIN = '=== citadel-heavy: the command starts ===';
export const END = '=== citadel-heavy: the command exited ';
/** The end marker whole, at its line's end. */
const ENDED = new RegExp(`${END}\\D*(\\d+) ===$`);
const WORKFLOW = 'citadel-heavy.yml';
/** A hold.json (src/ci-hold-file.ts) older than this holds nothing. Turns run this file alone (src/turn-launch.ts): it imports only types. */
const HOLD_STALE_MS = 2 * 60_000;
const say = (text: string) => process.stderr.write(`citadel-heavy: ${text}\n`);

/** owner/repo from a github.com remote URL (https or ssh), else null. */
export function slugOf(url: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : null;
}

/** POSIX shell quoting of an argv, for the workflow's `bash -c`. */
export function commandLine(argv: string[]): string {
  return argv.map((a) => (/^[\w./:=+,@%-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** The command's output and status from a job log: the lines between the markers, timestamps cut. No end marker, or a 0 from a run that didn't succeed: code null. */
export function commandOutput(log: string, conclusion: string | null): { lines: string[]; code: number | null } {
  const lines = log
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''));
  const from = lines.findIndex((l) => l === BEGIN);
  if (from < 0) return { lines: [], code: null };
  // The marker can share its line with output that had no newline at its end (CB3, #1519): the workflow prints a newline
  // before it now, and that added line goes again here; a workflow copied before that still ends mid-line.
  // The last whole one that agrees with the run's conclusion: the command's own output, or the clean-up after it, may quote the marker (#1954, 2CA12).
  const to = lines.findLastIndex((l, i) => i > from && ENDED.test(l) && (Number(ENDED.exec(l)?.[1]) === 0) === (conclusion === 'success'));
  if (to < 0) return { lines: lines.slice(from + 1), code: null };
  const at = lines[to].lastIndexOf(END);
  const code = Number(ENDED.exec(lines[to])?.[1]);
  const out = lines.slice(from + 1, to);
  if (at > 0) out.push(lines[to].slice(0, at));
  else if (out.length && out[out.length - 1] === '') out.pop();
  return { lines: out, code };
}

class Fallback extends Error {}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();
const pollSeconds = () => Number(process.env.CITADEL_HEAVY_CI_POLL) || 10;
const sleepSync = (s: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);
/** A gh call, tried up to `tries` times a poll apart: one blip in GitHub's answers isn't an answer (CB1, #1519). A POST
 *  that starts something (the dispatch) passes 1, since a try that timed out may have started it. */
function retried<T>(what: string, tries: number, call: () => T): T {
  for (let n = 1; ; n++) {
    try {
      return call();
    } catch (e: any) {
      if (n >= tries)
        throw new Error(
          `${what}: ${String(e.stderr || e.message)
            .trim()
            .split('\n')
            .pop()}`,
        );
      sleepSync(pollSeconds());
    }
  }
}
function gh(args: string[], what: string, tries = 3): any {
  return retried(what, tries, () => {
    const out = execFileSync('gh', ['api', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    return out.trim() ? JSON.parse(out) : null;
  });
}
function ghText(path: string, what: string): string {
  // gh refuses to print a body with terminal escapes in it unless told to, and job logs carry colour codes.
  return retried(what, 3, () => execFileSync('gh', ['api', '--allow-escape-sequences', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 256 << 20 }));
}

/** The repo's slug when it can take heavy jobs on CI; a Fallback says why not. */
function repo(): string {
  let root: string;
  try {
    root = git('rev-parse', '--show-toplevel');
  } catch {
    throw new Fallback('this is not a git checkout');
  }
  if (!existsSync(join(root, '.github', 'workflows', WORKFLOW))) throw new Fallback(`this repo has no .github/workflows/${WORKFLOW} (the kit's scheme-setup template citadel-heavy.yml shows how to add one)`);
  let url = '';
  try {
    url = git('config', '--get', 'remote.origin.url');
  } catch {
    /* none */
  }
  const slug = slugOf(url);
  if (!slug) throw new Fallback(`its origin (${url || 'none'}) is not on github.com`);
  return slug;
}

// Files a snapshot leaves out: an untracked secret pushed to GitHub would outlive the scratch ref.
const SECRETS = ['**/.env', '**/.env.*', '**/*.pem', '**/*.key', '**/*.p12', '**/*.jks', '**/*.keystore', '**/id_rsa*', '**/id_ed25519*'];

/** A commit of the working copy as it is (tracked and untracked files, .gitignore kept), on top of HEAD. */
function snapshot(): string {
  const tmp = mkdtempSync(join(tmpdir(), 'heavy-ci-'));
  try {
    const index = join(tmp, 'index');
    // A copy of the real index, so git add only hashes what changed.
    try {
      copyFileSync(git('rev-parse', '--path-format=absolute', '--git-path', 'index'), index);
    } catch {
      /* none yet */
    }
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const run = (...args: string[]) => execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
    run('add', '-A', '--', ':/', ...SECRETS.map((g) => `:(top,exclude,glob)${g}`));
    const tree = run('write-tree');
    return run('commit-tree', tree, '-p', 'HEAD', '-m', 'citadel-heavy snapshot');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** How many ship runs (land/* branches, tools/land.sh) are queued or running on the repo's CI now; 0 when GitHub doesn't say. */
function shipRuns(slug: string): number {
  // Only runs from the last 15 minutes count: GitHub keeps some abandoned ones queued.
  const since = Date.now() - 15 * 60_000;
  let n = 0;
  for (const status of ['queued', 'in_progress']) {
    try {
      const runs = gh([`repos/${slug}/actions/runs?status=${status}&per_page=50`], 'reading the ship runs').workflow_runs ?? [];
      n += runs.filter((r: any) => String(r.head_branch || '').startsWith('land/') && Date.parse(r.created_at) >= since).length;
    } catch {
      /* unread: the job goes ahead rather than wait on a blip */
    }
  }
  return n;
}

/** Ships first (#1347, Cara 2026-11-20: "maybe heavy jobs should wait if they are slowing down the ship train?"): while a
 *  ship's run is queued or running, a new heavy job waits here, up to CITADEL_HEAVY_SHIP_WAIT s (default 1800), before it
 *  is dispatched. It waits rather than run on perigee, where a ship that fell back runs its suite too; a job already on
 *  CI goes on. After the limit it goes to CI's queue anyway, so a stuck run never holds it for good. CITADEL_HEAVY_SHIP=1
 *  skips it, for a ship's own light check (tools/light-check.sh, #1620), which is there to spare the ships' runs. */
async function waitForShips(slug: string, poll: number) {
  const limit = Number(process.env.CITADEL_HEAVY_SHIP_WAIT) || 1800;
  const from = Date.now();
  let told = 0;
  for (let n = shipRuns(slug); n > 0; n = shipRuns(slug)) {
    if (Date.now() - from >= limit * 1000) {
      say(`a ship's CI run is still going after ${Math.round(limit / 60)} min; starting anyway`);
      return;
    }
    if (Date.now() - told >= 300_000) {
      say(`waiting for ${n} ship run(s) on CI to finish first (${Math.round((Date.now() - from) / 60000)} min)`);
      told = Date.now();
    }
    await sleep(poll * 1000);
  }
}

/** Deploys first (#1902): the server's word on why a job may not start on the CI desktop now, or null (its file stale or
 *  unread, so the job goes ahead). */
function readHold(): HoldFile | null {
  try {
    const h = JSON.parse(readFileSync(join(longDir(), 'hold.json'), 'utf8'));
    return Number.isFinite(h?.at) && Date.now() - h.at < HOLD_STALE_MS && Array.isArray(h.held) && Array.isArray(h.repos) ? h : null;
  } catch {
    return null;
  }
}
function holdWhy(slug: string): string | null {
  const h = readHold();
  return h?.repos.includes(slug.toLowerCase()) ? (h.why ?? (h.own === slug.toLowerCase() ? (h.busy ?? null) : null)) : null;
}
const heldRun = (run: number) => readHold()?.held.some((h) => h.run === run) ?? false;
/** The exit status of a job handed to Citadel's queue: nothing has run yet, or it was stopped and starts again. */
export const HANDED_OVER = 75;

/** Wait here while ships hold the CI desktop, up to CITADEL_HEAVY_HOLD_WAIT s (default 300); false when they still do. */
async function waitForHold(slug: string, poll: number): Promise<boolean> {
  const limit = (Number(process.env.CITADEL_HEAVY_HOLD_WAIT) || 300) * 1000;
  const from = Date.now();
  let told = 0;
  for (let why = holdWhy(slug); why; why = holdWhy(slug)) {
    if (Date.now() - from >= limit) return false;
    if (Date.now() - told >= 300_000) {
      say(`waiting: ${why} (${Math.round((Date.now() - from) / 60000)} min)`);
      told = Date.now();
    }
    await sleep(poll * 1000);
  }
  return true;
}

/** Write a job for the server's queue (src/long-jobs.ts). */
function writeJob(job: Record<string, unknown> & { id: string }) {
  const dir = longDir();
  // Open to every account: turns in people's containers write here, and the server rewrites the files as jobs move.
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    try {
      chmodSync(dir, 0o777);
    } catch {
      /* not ours */
    }
  }
  writeFileSync(join(dir, `.${job.id}.tmp`), JSON.stringify(job) + '\n', { mode: 0o666 });
  renameSync(join(dir, `.${job.id}.tmp`), join(dir, `${job.id}.json`));
}

/** Hand a job ships hold to Citadel, which starts it once the line is empty and wakes the minion with its result; false
 *  outside a minion's turn, or with a command too long for the queue (nobody to wake: the caller keeps waiting). */
function handOver(job: { id: string; slug: string; sha: string; command: string; argv: string[] }, run?: { id: number; url: string }): boolean {
  const ticket = Number(process.env.COORDINATOR_TICKET);
  if (!Number.isInteger(ticket) || ticket <= 0 || job.command.length > 20_000) return false;
  const { argv, ...rest } = job;
  const what = (process.env.CITADEL_HEAVY_WHAT || argv.join(' ')).slice(0, 100);
  const now = Date.now();
  writeJob({ ...rest, ticket, what, who: (process.env.CITADEL_HEAVY_WHO || 'someone').slice(0, 200), queued_at: now, quiet: true, ...(run ? { state: 'running', dispatched_at: now, run_id: run.id, url: run.url } : { state: 'queued' }) });
  say(
    `${run ? 'another CI job goes first, so this job was stopped' : 'the CI desktop is still taken'}: Citadel ${run ? 'starts it again' : 'starts it'} by itself when it may go, and wakes you with its exit status and output (${join(longDir(), `${job.id}.log`)}). Nothing has passed or failed (exit ${HANDED_OVER}); end your turn, and don't run it again`,
  );
  return true;
}

/** The command line the workflow runs: in the same folder of the repo as here. */
function remoteCommand(argv: string[]): string {
  const prefix = git('rev-parse', '--show-prefix');
  return prefix ? `cd ${commandLine([prefix])} && ${commandLine(argv)}` : commandLine(argv);
}
const newId = () => `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;

/** Where long jobs wait, beside citadel-heavy's slots: <CITADEL_HEAVY_DIR>/long/<id>.json (and <id>.log once it ends). */
export const longDir = (env: NodeJS.ProcessEnv = process.env) => join(env.CITADEL_HEAVY_DIR || join(homedir(), '.local/share/claude-coordinator/projects/.heavy'), 'long');

/**
 * A long job (#1363; Cara, 2026-11-20: "maybe we need a lane for LONG jobs like this to run while I am sleeping?"):
 * snapshot and push the working copy now, write the job's file and exit; the server (src/long-jobs.ts) starts it on CI
 * at night, from 2am until the job hours of the PC with the repo's runners end, and wakes this minion
 * with its status and output when it ends. Prints the job's id.
 */
function queueLong(argv: string[]): number {
  const ticket = Number(process.env.COORDINATOR_TICKET);
  if (!Number.isInteger(ticket) || ticket <= 0) {
    say("--long is for a minion's turn (it needs COORDINATOR_TICKET): the minion that queues it is woken when it ends");
    return 2;
  }
  const command = remoteCommand(argv);
  // The server drops a job file it can't trust (src/long-jobs.ts cleanJob), so a job it would drop is refused here instead.
  if (command.length > 20_000) {
    say(`the command is ${command.length} characters; a long job takes at most 20000: put it in a script`);
    return 2;
  }
  let slug: string;
  try {
    slug = repo();
  } catch (e) {
    say(`a long job runs only on the scheme's CI, and ${(e as Error).message}; run it without --long`);
    return 2;
  }
  const id = newId();
  let sha: string;
  try {
    sha = snapshot();
    git('push', '-q', '--no-verify', 'origin', `${sha}:refs/citadel-heavy/${id}`);
  } catch (e: any) {
    say(
      `pushing the snapshot to GitHub failed (${String(e.stderr || e.message)
        .trim()
        .split('\n')
        .pop()}), so nothing is queued`,
    );
    return 1;
  }
  const what = (process.env.CITADEL_HEAVY_WHAT || argv.join(' ')).slice(0, 100);
  const job = { id, ticket, slug, sha, command, what, who: (process.env.CITADEL_HEAVY_WHO || 'someone').slice(0, 200), queued_at: Date.now(), state: 'queued' };
  const dir = longDir();
  writeJob(job);
  process.stdout.write(`${id}\n`);
  say(`queued long job ${id} (${what}) for ${slug}'s CI. It starts at night (from 2am, in the CI PC's job hours), so end your turn now: you are woken with its exit status and output (${join(dir, `${id}.log`)}) when it ends`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const poll = pollSeconds();
  const findLimit = Number(process.env.CITADEL_HEAVY_CI_FIND) || 60;
  const queueLimit = Number(process.env.CITADEL_HEAVY_CI_QUEUE) || 600;
  const slug = repo();
  const command = remoteCommand(argv);
  const ship = process.env.CITADEL_HEAVY_SHIP === '1'; // a ship's own light check (#1620): stopped only, never handed over
  const id = `${ship ? 'ship' : ''}${newId()}`;
  const ref = `refs/citadel-heavy/${id}`;
  let sha: string;
  try {
    sha = snapshot();
    // --no-verify: a repo's own pre-push hook (Peek's runs its whole check) is for its branches, not this scratch ref (#1254).
    git('push', '-q', '--no-verify', 'origin', `${sha}:${ref}`);
  } catch (e: any) {
    throw new Fallback(
      `pushing the snapshot to GitHub failed (${String(e.stderr || e.message)
        .trim()
        .split('\n')
        .pop()})`,
    );
  }
  let kept = false; // handed over: the queued job still needs its snapshot
  const unref = () => {
    if (kept) return;
    try {
      git('push', '-q', '--no-verify', 'origin', `:${ref}`);
    } catch {
      /* a stray ref costs nothing */
    }
  };
  let runId: number | null = null;
  let dispatched = false;
  let started = false;
  let completed = false;
  let cancelled = false;
  /** The dispatch answers with no run id: the run is found by its name, which carries the id. */
  const findRun = (tries = 3): number | null => {
    const runs = gh([`repos/${slug}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=30`], 'finding the run', tries).workflow_runs ?? [];
    return runs.find((r: any) => r.display_title === `heavy ${id}`)?.id ?? null;
  };
  /** False when a run exists, or may, and GitHub refused to cancel it: it may still run, so nothing runs here too. A run
   *  dispatched but not found yet is looked for a while first, so a stop or a fallback can't leave it to start later (CB4). */
  const cancel = () => {
    for (let n = 0; dispatched && !runId && n < 15; n++) {
      try {
        runId = findRun(1);
      } catch {
        /* looked again below: one try each, so a stop waits about 30 s, not minutes */
      }
      if (!runId) sleepSync(Math.min(2, poll));
    }
    if (dispatched && !runId) return false;
    if (!runId || cancelled) return true;
    try {
      gh(['-X', 'POST', `repos/${slug}/actions/runs/${runId}/cancel`], 'cancel');
      return (cancelled = true);
    } catch {
      try {
        return gh([`repos/${slug}/actions/runs/${runId}`], 'reading the run').status === 'completed';
      } catch {
        return false;
      }
    }
  };
  const stop = (signal: number) => {
    say(`stopped; cancelling the CI run`);
    if (!cancel()) say(`GitHub wouldn't cancel the CI run, or it couldn't be found yet: look for "heavy ${id}" in ${slug}'s Actions and cancel it there`);
    unref();
    process.exit(128 + signal);
  };
  process.on('SIGINT', () => stop(2));
  process.on('SIGTERM', () => stop(15));
  try {
    if (!ship) {
      while (!(await waitForHold(slug, poll))) if (handOver({ id, slug, sha, command, argv })) return ((kept = true), HANDED_OVER);
      await waitForShips(slug, poll); // the repo's own ships, and what the hold says when it can't be read
    }
    try {
      const branch = gh([`repos/${slug}`], 'reading the repo').default_branch;
      // From here a run may exist even if the call failed (it timed out after GitHub took it), so it is looked for.
      dispatched = true;
      gh(['-X', 'POST', `repos/${slug}/actions/workflows/${WORKFLOW}/dispatches`, '-f', `ref=${branch}`, '-f', `inputs[sha]=${sha}`, '-f', `inputs[command]=${command}`, '-f', `inputs[id]=${id}`], 'starting the workflow', 1);
    } catch (e: any) {
      // GitHub answering 4xx refused it outright: no run to look for.
      if (/HTTP 4\d\d/.test(e.message)) dispatched = false;
      throw new Fallback(`${e.message} (is ${WORKFLOW} on the default branch yet?)`);
    }
    for (const from = Date.now(); !runId; ) {
      try {
        runId = findRun();
      } catch {
        /* a blip: looked again until the limit */
      }
      if (!runId && Date.now() - from >= findLimit * 1000) throw new Fallback(`GitHub took the workflow but showed no run for it in ${findLimit} s`);
      if (!runId) await sleep(Math.min(2, poll) * 1000);
    }
    let queued = Date.now();
    const asked = queued;
    // A blip in GitHub's answers is waited out: three misses in a row end it (gh tries three times).
    const read = async () => gh([`repos/${slug}/actions/runs/${runId}`], 'reading the run');
    let run = await read();
    say(`running on ${slug}'s CI, not here: ${run.html_url}`);
    let told = 0;
    for (;;) {
      if (run.status === 'completed') {
        // Stopped for a ship (#1902): the same run starts again, so this is no result.
        if (ship || !heldRun(run.id)) {
          // a ship's light check is never waited for: no verdict, and its ship goes on
          completed = true;
          break;
        }
        if (handOver({ id, slug, sha, command, argv }, { id: run.id, url: run.html_url })) return ((kept = true), HANDED_OVER);
        started = false;
        queued = Date.now();
      }
      if (!started && run.status !== 'completed' && run.status !== 'queued' && run.status !== 'waiting' && run.status !== 'pending' && run.status !== 'requested') {
        started = true;
        // Only for the runner's name: an unread answer here must not cancel a run a runner just took.
        let job: any;
        try {
          job = gh([`repos/${slug}/actions/runs/${runId}/jobs`], 'reading the job').jobs?.[0];
        } catch {
          /* named nowhere, that's all */
        }
        say(`a runner took it${job?.runner_name ? ` (${job.runner_name})` : ''}; its output comes when it ends`);
      }
      if (!started && run.status !== 'completed' && Date.now() - queued >= queueLimit * 1000) {
        // Busy runners mean wait (Josh: "things slow down, but perigee is fine"); only a CI running nothing at all,
        // the desktop off, sends the job back here. Reading the runners themselves needs admin, so other runs tell.
        if (gh([`repos/${slug}/actions/runs?status=in_progress&per_page=1`], 'reading the runs').total_count > 0) {
          queued = Date.now();
        } else {
          if (!cancel()) {
            say(`no runner took the job and GitHub wouldn't cancel the run (${run.html_url}); nothing runs here`);
            return 1;
          }
          throw new Fallback(`no runner took the job in ${Math.round(queueLimit / 60)} min and nothing else ran on CI (the desktop may be off), so the CI run is cancelled`);
        }
      }
      if (Date.now() - told >= 300_000) {
        if (told) say(`still ${started ? 'running' : 'waiting for a runner'} (${Math.round((Date.now() - asked) / 60000)} min)`);
        told = Date.now();
      }
      await sleep(poll * 1000);
      run = await read();
    }
    const job = gh([`repos/${slug}/actions/runs/${runId}/jobs`], 'reading the job').jobs?.[0];
    if (!started && !job?.runner_name) {
      // Cancelled before any runner had it (by a person on GitHub): nothing ran, so it runs here.
      throw new Fallback(`the CI run ended ${run.conclusion} before a runner took it`);
    }
    started = true;
    const took = Math.round((Date.parse(job?.completed_at) - Date.parse(job?.started_at)) / 1000);
    if (took >= 0 && process.env.CITADEL_HEAVY_RAN_FILE) writeFileSync(process.env.CITADEL_HEAVY_RAN_FILE, `${took}\n`);
    const out = job ? commandOutput(ghText(`repos/${slug}/actions/jobs/${job.id}/logs`, 'reading the log'), run.conclusion) : { lines: [], code: null };
    if (out.lines.length) process.stdout.write(out.lines.join('\n') + '\n');
    if (out.code === null) {
      say(`the CI run ended ${run.conclusion} before the command finished (${run.html_url}); nothing more runs here`);
      return 1;
    }
    return out.code;
  } catch (e) {
    // Once the run completed it never runs here: a read that failed after that can't tell whether the command ran on
    // CI (a run can go from queued to completed between two looks, leaving `started` false: CB1, #1519).
    if (e instanceof Fallback || (!started && !completed)) {
      // A run still queued must not start after this runs here.
      if (!cancel()) {
        say(`${(e as Error).message}, and GitHub wouldn't cancel the CI run, or it couldn't be found yet; nothing runs here: look for "heavy ${id}" in ${slug}'s Actions and cancel it there`);
        return 1;
      }
      throw e instanceof Fallback ? e : new Fallback(String((e as Error).message));
    }
    say(`${(e as Error).message}; the CI run is cancelled and nothing more runs here`);
    cancel();
    return 1;
  } finally {
    unref();
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const fallback = (why: string) => {
    if (process.env.CITADEL_HEAVY_FALLBACK_FILE) writeFileSync(process.env.CITADEL_HEAVY_FALLBACK_FILE, `${why}\n`);
    process.exitCode = FALLBACK;
  };
  if (argv[0] === '--long') {
    process.exitCode = argv.length > 1 ? queueLong(argv.slice(1)) : (say('usage: citadel-heavy --long <command> [args...]'), 2);
  } else if (argv[0] === '--repo') {
    try {
      process.stdout.write(repo() + '\n');
    } catch (e) {
      say(`not on CI: ${(e as Error).message}`);
      fallback((e as Error).message);
    }
  } else if (!argv.length) {
    say('usage: heavy-ci.ts --repo | <command> [args...]');
    process.exit(2);
  } else {
    // exitCode, not exit(): a long log piped to the caller is written out in full first.
    main(argv).then(
      (code) => {
        process.exitCode = code;
      },
      (e) => {
        say(`not on CI: ${(e as Error).message}; running it here in perigee's small slot`);
        fallback((e as Error).message);
      },
    );
  }
}
