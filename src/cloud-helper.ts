// citadel-cloud (#2200, docs/adr/0041-cloud-helpers.md): one step of a home minion's turn run in a Claude Code cloud session,
// the way it runs a Grunt or citadel-heavy. The minion keeps its chat, cards, tools and shared folder; the session runs on
// the turn's own Claude login (sender pays) and draws on that person's plan. On every turn's PATH (src/turn-launch.ts pins
// this file with cloud-turn.mjs and cloud-run-vm.mjs beside it), so it imports nothing that reaches the database.
//
//   citadel-cloud run [--minutes 30] [--files a,b] [--out <dir>] -- <command>
//       A command job: <command> (bash) runs on your branch's last commit, in the cloud VM. Its runner pushes a progress
//       line every 2 minutes (printed here as it comes) and the output's end, its exit code and the files named come back.
//   citadel-cloud brief <file> [--minutes 30] [--model sonnet|opus] [--out <dir>]
//       A brief job (research, a review): the session reads <file> and works on its own up to --minutes, then pushes its
//       reply and files. Nobody can answer a question there: one it asks comes back as text.
//
// Exit codes: 0 done (a command's exit 0), 1 done and the command failed (or hit its limit), 69 the cloud couldn't be used
// or didn't deliver: run the step at home now, 2 a usage error. Run it as a background command and wait with
// `citadel-wait pid`; not under citadel-job, which leaves out your Claude login (exit 69 there).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jsonLines } from './json-lines.ts';

/** Exit code for "run it at home" (EX_UNAVAILABLE), as citadel-heavy's 75 is "the server has it". */
export const AT_HOME = 69;
/** A session's progress line is due every 2 minutes; none for this long means it isn't running the job. */
export const QUIET_MS = 8 * 60_000;
/** A background command with a timeout runs up to 2 hours in a session (CLOUD.stepMinutes, src/cloud-pool.ts). */
export const MAX_MINUTES = 110;
/** CLOUD's start and poll (src/cloud-pool.ts), which this can't import: it reaches the database. */
const START_MS = 180_000;
const POLL_MS = 20_000;
const SKIP = '[skip ci]';

export interface Job {
  kind: 'run' | 'brief';
  cmd: string;
  brief: string;
  minutes: number;
  files: string[];
  out: string;
  model: string;
}

/** What the helper reaches outside itself: swapped out by test/cloud-helper.test.ts. */
export const io = {
  claude: 'claude',
  cwd: () => process.cwd(),
  helpersOff: () => helpersOff(),
  log: (line: string) => console.log(line),
  pollMs: POLL_MS,
  quietMs: QUIET_MS,
  everyMs: 60_000,
};

/** The usage line for a bad call. */
const USAGE = 'usage: citadel-cloud run [--minutes N] [--files a,b] [--out <dir>] -- <command> | citadel-cloud brief <file> [--minutes N] [--model sonnet|opus] [--out <dir>]';

/** The job a command line asks for, or a usage error. */
export function parse(args: string[], now = Date.now()): Job | string {
  const [kind, ...rest] = args;
  if (kind !== 'run' && kind !== 'brief') return USAGE;
  const dash = rest.indexOf('--');
  const opts = kind === 'run' ? (dash < 0 ? rest : rest.slice(0, dash)) : rest.slice(1);
  const val = (name: string) => {
    const i = opts.indexOf(`--${name}`);
    return i < 0 ? null : (opts[i + 1] ?? '');
  };
  const minutes = Number(val('minutes') ?? 30);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) return `--minutes: a whole number from 1 to ${MAX_MINUTES} (a session's command stops at 2 hours)`;
  const model = val('model') ?? 'sonnet';
  if (!['sonnet', 'opus', 'haiku'].includes(model)) return '--model: sonnet, opus or haiku';
  const files = (val('files') ?? '').split(',').filter(Boolean);
  if (files.length > 19) return '--files: at most 19 (with the output, 20 come home)';
  const out = val('out') ?? join(process.env.TMPDIR || tmpdir(), `citadel-cloud-${now.toString(36)}`);
  if (kind === 'run') {
    const cmd = dash < 0 ? '' : rest.slice(dash + 1).join(' ');
    return cmd.trim() ? { kind, cmd, brief: '', minutes, files, out, model: 'sonnet' } : `run: the command goes after --\n${USAGE}`;
  }
  const file = rest[0];
  if (!file || file.startsWith('--')) return `brief: name the file the session reads\n${USAGE}`;
  let brief: string;
  try {
    brief = readFileSync(file, 'utf8');
  } catch (err) {
    return `brief: ${(err as Error).message}`;
  }
  return { kind, cmd: '', brief, minutes, files, out, model };
}

/**
 * Why Citadel's cloud helpers switch keeps this step home ('cloud-helpers', src/cloud-flakes.ts; Cara, 2026-11-27, "Ship dark,
 * switch off"), or null when it's on. tools/cloud-flake.ts reads the same route; this copy imports nothing from there, which
 * reaches the database. Outside a turn, or when it can't be read, it counts as off.
 */
export async function helpersOff(read?: () => Promise<unknown>): Promise<string | null> {
  const base = process.env.COORDINATOR_API;
  const ticket = process.env.COORDINATOR_TICKET;
  if (!base || !ticket) return "outside a minion's turn there's no cloud helpers switch to read";
  try {
    const got = read
      ? await read()
      : await fetch(`${base}/api/tickets/${ticket}/cloud-helpers/switch`, { headers: { Authorization: `Bearer ${process.env.COORDINATOR_TOKEN ?? ''}` } }).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
    return (got as { on?: unknown }).on === true ? null : "Citadel's cloud helpers are off (an admin switch, off by default)";
  } catch (err) {
    return `couldn't read the cloud helpers switch: ${(err as Error).message}`;
  }
}

/** Why this turn can't reach a cloud session at all, or null. */
export function noCloud(cwd: string, claude: string): string | null {
  if (process.env.CITADEL_CLOUD === '0') return 'CITADEL_CLOUD=0';
  if (process.env.CITADEL_JOB) return "under citadel-job there's no Claude login to start a session on: run it as a background command in your turn";
  if (spawnSync('sh', ['-c', `command -v "$0"`, claude], { stdio: 'ignore' }).status !== 0) return 'no claude CLI here';
  const url = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  if (!/github\.com[:/]/.test(url) && process.env.CITADEL_CLOUD_ORIGIN !== url) return "this repo's origin isn't on GitHub, where a session clones it";
  return null;
}

/** The runner, sent in the brief so it works in any scheme's repo. */
const runner = () => readFileSync(join(import.meta.dirname, 'cloud-run-vm.mjs'));

/** What the session is told. A command job: only run the runner until it says DONE. A brief: the work, then the result's shape. */
export function sessionText(job: Job, branch: string, ref: string, beat: string, ticket: number): string {
  if (job.kind === 'brief')
    return [
      `Citadel's cloud helper for minion #${ticket}: your reply goes to the branch ${branch}. Work on your own; nobody can answer a question here, so pick and say what you picked.`,
      `Finish within ${job.minutes} minutes. Start a command that takes minutes in the background with a timeout, wait for it in the same turn, and never end your turn while one still runs.`,
      '',
      '--- The brief ---',
      job.brief.trim(),
      '--- End of the brief ---',
      '',
      `When it's done: write .citadel/result.json as {"job": "${branch}", "reply": "<your answer, markdown>", "files": ["<paths under .citadel/out/>"]} (at most 20 files of 5 MB each in .citadel/out/), commit them and run \`git push origin HEAD:refs/heads/${branch}\`. A hook may also ask you to push your own working branch: do both, but this push is the one Citadel reads. ${SKIP} goes in the commit message.`,
    ].join('\n');
  const vm = { ref, branch, beat, cmd: job.cmd, minutes: job.minutes, files: job.files };
  const arg = Buffer.from(JSON.stringify(vm)).toString('base64');
  return [
    `Citadel's cloud helper for minion #${ticket}: run one command job, its result to ${branch}. Do nothing else: don't read or change the repo, don't commit or push anything yourself, and ask nobody anything.`,
    '',
    '1. Write the runner, in one Bash call:',
    `echo ${runner().toString('base64')} | base64 -d > /tmp/citadel-run.mjs`,
    '2. Run this in the foreground with a timeout of 600000 ms (10 minutes):',
    `node /tmp/citadel-run.mjs ${arg}`,
    '3. It prints STILL RUNNING, DONE, STOPPED or FAILED. On STILL RUNNING run exactly the same command again, and again, until it prints one of the others. Never end your turn before that: the job stops with your turn.',
    '4. Then end your turn with its last line. The runner pushes the result itself; if a hook asks you to push your working branch, there is nothing of yours to push: say so and stop.',
  ].join('\n');
}

let stopping: (() => void) | null = null;
/** Stop the running step: the driver ends, and the deleted source branch makes the runner kill its job at its next beat. */
export const stop = () => stopping?.();

/** Run one job to its end; the exit code. */
export async function cloud(job: Job): Promise<number> {
  const off = await io.helpersOff();
  const cwd = io.cwd();
  const why = off ?? noCloud(cwd, io.claude);
  if (why) return home(why);
  const git = (...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const ticket = Number(process.env.COORDINATOR_TICKET) || 0;
  const t = Date.now().toString(36);
  const branch = `cloud/t${ticket}-${t}`;
  const ref = `cloud/src-t${ticket}-${t}`;
  const beat = `${branch}-beat`;
  if (job.kind === 'run') {
    if (git('status', '--porcelain', '--untracked-files=no')) io.log('citadel-cloud: uncommitted changes stay here: the session runs your last commit');
    try {
      git('push', '-q', 'origin', `HEAD:refs/heads/${ref}`);
    } catch (err) {
      return home(`couldn't push your commit for the session: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  mkdirSync(job.out, { recursive: true });
  const file = join(job.out, '.job.json');
  writeFileSync(
    file,
    JSON.stringify({
      claude: io.claude,
      cwd,
      branch,
      session: null,
      sha: null,
      text: sessionText(job, branch, ref, beat, ticket),
      files: job.out,
      model: job.model,
      effort: job.kind === 'run' ? 'low' : null,
      cost: 0.4,
      limitMs: (job.minutes + 15) * 60_000,
      pollMs: io.pollMs,
      startMs: START_MS,
      beat: job.kind === 'run' ? beat : null,
      quietMs: job.kind === 'run' ? io.quietMs : null,
      cards: false,
    }),
  );
  const began = Date.now();
  const mins = () => Math.round((Date.now() - began) / 60_000);
  let code: number | null = null;
  let reply = '';
  let result: { is_error?: boolean; result?: string } | null = null;
  let url = '';
  let stopped = false;
  const driver = spawn(process.execPath, [join(import.meta.dirname, 'cloud-turn.mjs'), file], { cwd, stdio: ['pipe', 'pipe', 'inherit'], detached: true });
  driver.stdin.end();
  let last = Date.now();
  const say = (line: string) => {
    last = Date.now();
    io.log(`citadel-cloud: ${line}`);
  };
  const tick = setInterval(() => {
    if (Date.now() - last >= io.everyMs) say(`running, ${mins()} min${url ? `, ${url}` : ''}`);
  }, 1000);
  stopping = () => {
    stopped = true;
    try {
      if (driver.pid) process.kill(-driver.pid, 'SIGTERM');
    } catch {}
  };
  jsonLines<{ type?: string; subtype?: string; session?: string; url?: string; text?: string; code?: number; is_error?: boolean; result?: string; message?: { content?: { text?: string }[] } }>(driver.stdout, (ev) => {
    if (ev.type === 'system' && ev.subtype === 'cloud' && ev.url && !url) say(`session ${(url = ev.url)}, its result on ${branch}`);
    else if (ev.subtype === 'cloud_progress' && ev.text) say(ev.text);
    else if (ev.subtype === 'cloud_result' && Number.isInteger(ev.code)) code = ev.code ?? null;
    else if (ev.type === 'assistant') reply = (ev.message?.content ?? []).map((c) => c.text ?? '').join('\n') || reply;
    else if (ev.type === 'result') result = ev;
  });
  await new Promise((r) => driver.once('exit', r));
  clearInterval(tick);
  stopping = null;
  for (const b of [ref, beat, branch]) if (job.kind === 'run' || b === branch) spawnSync('git', ['-C', cwd, 'push', '-q', 'origin', '--delete', b], { stdio: 'ignore' });
  const cost = `about $${Math.max(0.4, mins() * 0.025).toFixed(2)} of your plan's usage (an estimate)`;
  if (stopped) return (say(`stopped after ${mins()} min; ${url ? 'the cloud job stops at its next beat' : 'no session had started'}`), 143);
  const r = result as { is_error?: boolean; result?: string } | null;
  if (!r || r.is_error) return home(`${(r?.result ?? 'the session ended with no result').slice(0, 1500)}${url ? `\nIts session: ${url}; ${cost}` : ''}`);
  if (job.kind === 'run' && code === null) return home(`the session's result has no exit code, so the command didn't run through Citadel's runner${url ? ` (${url})` : ''}`);
  io.log(reply);
  io.log(`citadel-cloud: done after ${mins()} min, ${cost}. Files: ${job.out}`);
  return job.kind === 'brief' || code === 0 ? 0 : 1;
}

/** The cloud can't take this step: say why, and that it runs at home. */
function home(why: string): number {
  io.log(`citadel-cloud: not in the cloud: ${why}\ncitadel-cloud: exit ${AT_HOME}: run this step at home now (citadel-heavy, or a Grunt for a brief).`);
  return AT_HOME;
}

if (import.meta.main) {
  const job = parse(process.argv.slice(2));
  if (typeof job === 'string') {
    console.error(job);
    process.exit(2);
  }
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  cloud(job).then(
    (c) => process.exit(c),
    (err) => {
      home(`the helper failed: ${(err as Error).message}`);
      process.exit(AT_HOME);
    },
  );
}
