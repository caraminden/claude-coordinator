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
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FALLBACK = 120;
export const BEGIN = '=== citadel-heavy: the command starts ===';
export const END = '=== citadel-heavy: the command exited ';
const WORKFLOW = 'citadel-heavy.yml';
const say = (text: string) => process.stderr.write(`citadel-heavy: ${text}\n`);
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

/** owner/repo from a github.com remote URL (https or ssh), else null. */
export function slugOf(url: string): string | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? m[1] : null;
}

/** POSIX shell quoting of an argv, for the workflow's `bash -c`. */
export function commandLine(argv: string[]): string {
  return argv.map((a) => (/^[\w./:=+,@%-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** The command's output and status from a job log: the lines between the markers, timestamps cut. No end marker: code null. */
export function commandOutput(log: string): { lines: string[]; code: number | null } {
  const lines = log.replace(/\r/g, '').split('\n').map((l) => l.replace(/^﻿?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, ''));
  const from = lines.findIndex((l) => l === BEGIN);
  if (from < 0) return { lines: [], code: null };
  const to = lines.findIndex((l, i) => i > from && l.startsWith(END));
  if (to < 0) return { lines: lines.slice(from + 1), code: null };
  const code = Number(/(\d+)/.exec(lines[to].slice(END.length))?.[1]);
  return { lines: lines.slice(from + 1, to), code: Number.isInteger(code) ? code : null };
}

class Fallback extends Error {}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 }).trim();
function gh(args: string[], what: string): any {
  try {
    const out = execFileSync('gh', ['api', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
    return out.trim() ? JSON.parse(out) : null;
  } catch (e: any) {
    throw new Error(`${what}: ${String(e.stderr || e.message).trim().split('\n').pop()}`);
  }
}
function ghText(path: string, what: string): string {
  // gh refuses to print a body with terminal escapes in it unless told to, and job logs carry colour codes.
  try { return execFileSync('gh', ['api', '--allow-escape-sequences', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 256 << 20 }); }
  catch (e: any) { throw new Error(`${what}: ${String(e.stderr || e.message).trim().split('\n').pop()}`); }
}

/** The repo's slug when it can take heavy jobs on CI; a Fallback says why not. */
function repo(): string {
  let root: string;
  try { root = git('rev-parse', '--show-toplevel'); } catch { throw new Fallback('this is not a git checkout'); }
  if (!existsSync(join(root, '.github', 'workflows', WORKFLOW))) throw new Fallback(`this repo has no .github/workflows/${WORKFLOW} (the kit's scheme-setup template citadel-heavy.yml shows how to add one)`);
  let url = '';
  try { url = git('config', '--get', 'remote.origin.url'); } catch { /* none */ }
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
    try { copyFileSync(git('rev-parse', '--path-format=absolute', '--git-path', 'index'), index); } catch { /* none yet */ }
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const run = (...args: string[]) => execFileSync('git', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }).trim();
    run('add', '-A', '--', ':/', ...SECRETS.map((g) => `:(top,exclude,glob)${g}`));
    const tree = run('write-tree');
    return run('commit-tree', tree, '-p', 'HEAD', '-m', 'citadel-heavy snapshot');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function main(argv: string[]): Promise<number> {
  const poll = Number(process.env.CITADEL_HEAVY_CI_POLL) || 10;
  const queueLimit = Number(process.env.CITADEL_HEAVY_CI_QUEUE) || 600;
  const slug = repo();
  const prefix = git('rev-parse', '--show-prefix');
  const command = prefix ? `cd ${commandLine([prefix])} && ${commandLine(argv)}` : commandLine(argv);
  const id = `${Date.now().toString(36)}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const ref = `refs/citadel-heavy/${id}`;
  let sha: string;
  try {
    sha = snapshot();
    // --no-verify: a repo's own pre-push hook (Peek's runs its whole check) is for its branches, not this scratch ref (#1254).
    git('push', '-q', '--no-verify', 'origin', `${sha}:${ref}`);
  } catch (e: any) {
    throw new Fallback(`pushing the snapshot to GitHub failed (${String(e.stderr || e.message).trim().split('\n').pop()})`);
  }
  const unref = () => { try { git('push', '-q', '--no-verify', 'origin', `:${ref}`); } catch { /* a stray ref costs nothing */ } };
  let runId: number | null = null;
  let started = false;
  let cancelled = false;
  /** False when a run exists and GitHub refused to cancel it: it may still run, so nothing runs here too. */
  const cancel = () => {
    if (!runId || cancelled) return true;
    try { gh(['-X', 'POST', `repos/${slug}/actions/runs/${runId}/cancel`], 'cancel'); return (cancelled = true); }
    catch { try { return gh([`repos/${slug}/actions/runs/${runId}`], 'reading the run').status === 'completed'; } catch { return false; } }
  };
  const stop = (signal: number) => { say(`stopped; cancelling the CI run`); cancel(); unref(); process.exit(128 + signal); };
  process.on('SIGINT', () => stop(2));
  process.on('SIGTERM', () => stop(15));
  try {
    try {
      const branch = gh([`repos/${slug}`], 'reading the repo').default_branch;
      gh(['-X', 'POST', `repos/${slug}/actions/workflows/${WORKFLOW}/dispatches`, '-f', `ref=${branch}`,
        '-f', `inputs[sha]=${sha}`, '-f', `inputs[command]=${command}`, '-f', `inputs[id]=${id}`], 'starting the workflow');
    } catch (e: any) {
      throw new Fallback(`${e.message} (is ${WORKFLOW} on the default branch yet?)`);
    }
    // The dispatch answers with no run id: the run is found by its name, which carries the id.
    for (let i = 0; !runId; i++) {
      const runs = gh([`repos/${slug}/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=30`], 'finding the run').workflow_runs ?? [];
      runId = runs.find((r: any) => r.display_title === `heavy ${id}`)?.id ?? null;
      if (!runId && i * 2 >= 60) throw new Fallback('GitHub took the workflow but showed no run for it in a minute');
      if (!runId) await sleep(2);
    }
    let queued = Date.now();
    const asked = queued;
    // A blip in GitHub's answers is waited out: three misses in a row end it.
    const read = async () => {
      for (let miss = 1; ; miss++) {
        try { return gh([`repos/${slug}/actions/runs/${runId}`], 'reading the run'); }
        catch (e) { if (miss >= 3) throw e; await sleep(poll); }
      }
    };
    let run = await read();
    say(`running on ${slug}'s CI, not here: ${run.html_url}`);
    let told = 0;
    for (;;) {
      if (run.status === 'completed') break;
      if (!started && run.status !== 'queued' && run.status !== 'waiting' && run.status !== 'pending' && run.status !== 'requested') {
        started = true;
        const job = gh([`repos/${slug}/actions/runs/${runId}/jobs`], 'reading the job').jobs?.[0];
        say(`a runner took it${job?.runner_name ? ` (${job.runner_name})` : ''}; its output comes when it ends`);
      }
      if (!started && Date.now() - queued >= queueLimit * 1000) {
        // Busy runners mean wait (Josh: "things slow down, but perigee is fine"); only a CI running nothing at all,
        // the desktop off, sends the job back here. Reading the runners themselves needs admin, so other runs tell.
        if (gh([`repos/${slug}/actions/runs?status=in_progress&per_page=1`], 'reading the runs').total_count > 0) {
          queued = Date.now();
        } else {
          if (!cancel()) { say(`no runner took the job and GitHub wouldn't cancel the run (${run.html_url}); nothing runs here`); return 1; }
          throw new Fallback(`no runner took the job in ${Math.round(queueLimit / 60)} min and nothing else ran on CI (the desktop may be off), so the CI run is cancelled`);
        }
      }
      if (Date.now() - told >= 300_000) { if (told) say(`still ${started ? 'running' : 'waiting for a runner'} (${Math.round((Date.now() - asked) / 60000)} min)`); told = Date.now(); }
      await sleep(poll);
      run = await read();
    }
    const job = gh([`repos/${slug}/actions/runs/${runId}/jobs`], 'reading the job').jobs?.[0];
    if (!started && !job?.runner_name) {
      // Cancelled before any runner had it (by a person on GitHub): nothing ran, so it runs here.
      throw new Fallback(`the CI run ended ${run.conclusion} before a runner took it`);
    }
    started = true;
    const out = job ? commandOutput(ghText(`repos/${slug}/actions/jobs/${job.id}/logs`, 'reading the log')) : { lines: [], code: null };
    if (out.lines.length) process.stdout.write(out.lines.join('\n') + '\n');
    if (out.code === null) {
      say(`the CI run ended ${run.conclusion} before the command finished (${run.html_url}); nothing more runs here`);
      return 1;
    }
    return out.code;
  } catch (e) {
    if (e instanceof Fallback || !started) {
      // A run still queued must not start after this runs here.
      if (!cancel()) { say(`${(e as Error).message}, and GitHub wouldn't cancel the CI run; nothing runs here`); return 1; }
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
  if (argv[0] === '--repo') {
    try { process.stdout.write(repo() + '\n'); } catch (e) { say(`not on CI: ${(e as Error).message}`); fallback((e as Error).message); }
  } else if (!argv.length) {
    say('usage: heavy-ci.ts --repo | <command> [args...]');
    process.exit(2);
  } else {
    // exitCode, not exit(): a long log piped to the caller is written out in full first.
    main(argv).then((code) => { process.exitCode = code; }, (e) => {
      say(`not on CI: ${(e as Error).message}; running it here in perigee's small slot`);
      fallback((e as Error).message);
    });
  }
}
