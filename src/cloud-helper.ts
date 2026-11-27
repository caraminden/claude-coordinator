// citadel-cloud (#2200, docs/adr/0041-cloud-helpers.md): one step of a home minion's turn run in a Claude Code cloud session,
// the way it runs a Grunt or citadel-heavy. The minion keeps its chat, cards, tools and shared folder; the session runs on
// the turn's own Claude login (sender pays) and draws on that person's plan. On every turn's PATH (src/turn-launch.ts pins
// this file with cloud-turn.mjs and cloud-run-vm.mjs beside it), so it imports nothing that reaches the database.
//
//   citadel-cloud run [--minutes 30] [--files a,b] [--out <dir>] -- <command>
//       A command job: <command> (bash) runs where Cara's four priorities put it (pickPlace below): a PC lending this
//       scheme CI with room, GitHub's free runners on a public repo, a cloud session on your branch's last commit, or
//       perigee's own heavy-job slot. Wherever it runs its output streams here; in the cloud its runner pushes a progress
//       line every 2 minutes and the output's end, its exit code and the --files named come back. A cloud session that
//       can't start or goes quiet falls back to perigee's slot by itself.
//   citadel-cloud brief <file> [--minutes 30] [--model sonnet|opus] [--out <dir>]
//       A brief job (research, a review): the session reads <file> and works on its own up to --minutes, then pushes its
//       reply and files. Nobody can answer a question there: one it asks comes back as text.
//
// Exit codes: the command's own (0 done, 1 failed or hit its limit in the cloud), 75 citadel-heavy handed it to the server,
// 69 a brief the cloud couldn't take (run it as a Grunt), 2 a usage error, 143 stopped. Run it as a background command and
// wait with `citadel-wait pid`; not under citadel-job, which leaves out your Claude login (no cloud there).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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
  place: () => readPlace(),
  isPublic: (cwd: string) => isPublic(cwd),
  heavy: 'citadel-heavy',
  line: (text: string, detail: string, event: number | null) => postLine(text, detail, event),
  lineMs: 120_000,
  heavyDir: () => process.env.CITADEL_HEAVY_DIR || join(homedir(), '.local/share/claude-coordinator/projects/.heavy'),
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
export async function cloud(job: Job, on: (state: string, detail?: string) => void = () => {}): Promise<number> {
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
    if (ev.type === 'system' && ev.subtype === 'cloud' && ev.url && !url) {
      say(`session ${(url = ev.url)}, its result on ${branch}`);
      on('started', `Its session: ${url}`);
    } else if (ev.subtype === 'cloud_progress' && ev.text) {
      say(ev.text);
      on(ev.text, `Its session: ${url}`);
    } else if (ev.subtype === 'cloud_result' && Number.isInteger(ev.code)) code = ev.code ?? null;
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
  on(job.kind === 'run' ? `exit ${code} after ${mins()} min` : `done after ${mins()} min`, `${reply}\n\nIts session: ${url}; ${cost}.`);
  return job.kind === 'brief' || code === 0 ? 0 : 1;
}

/** Where a step runs (ADR 0041, Cara's four priorities and her pick "Helper checks first", 2026-11-27). */
export type Place = 'machine' | 'github' | 'cloud' | 'home';
/** What the pick reads. `slower`: the cloud's runs of this command over perigee's (medians), null with none of either. */
export interface Facts {
  on: boolean;
  machine: boolean;
  workflow: boolean;
  public: boolean;
  slower: number | null;
}
/** A cloud session this many times slower than home is "WAY slower" (priority 3). */
export const SLOWER = 3;

/**
 * Cara's order: a PC lending the scheme CI with room and nothing time-sensitive waiting (1 and 2: off perigee, no overload);
 * GitHub's free runners on a public repo (4: no session when they'd do); a cloud session unless its runs of this command were
 * WAY slower (3); else perigee's own small slot. A command that brings files back skips the CI places, which return only
 * output. A brief needs a model, so it's a cloud session or a Grunt at home.
 */
export function pickPlace(f: Facts, job: Pick<Job, 'kind' | 'files'>): { place: Place; why: string } {
  const off = 'cloud helpers are off';
  if (job.kind === 'brief') return f.on ? { place: 'cloud', why: 'a brief runs in a cloud session' } : { place: 'home', why: off };
  const ci = f.workflow && !job.files.length;
  if (ci && f.machine) return { place: 'machine', why: 'a PC lending this scheme CI has room, with no ship or CI waiting there' };
  if (ci && f.public) return { place: 'github', why: "this repo is public, so GitHub's own runners take it free" };
  if (f.on && !(f.slower !== null && f.slower >= SLOWER)) return { place: 'cloud', why: "no PC has room and GitHub can't take it" };
  return { place: 'home', why: f.on ? `its cloud runs took ${f.slower?.toFixed(1)}× its runs here` : off };
}

/** The server's half of the facts: the switch and a PC's room. Unreadable counts as off and no room. */
async function readPlace(): Promise<{ on: boolean; machine: boolean }> {
  const base = process.env.COORDINATOR_API;
  const ticket = process.env.COORDINATOR_TICKET;
  if (!base || !ticket) return { on: false, machine: false };
  try {
    const r = await fetch(`${base}/api/tickets/${ticket}/cloud-helpers/place`, { headers: { Authorization: `Bearer ${process.env.COORDINATOR_TOKEN ?? ''}` } });
    const got = (r.ok ? await r.json() : {}) as { on?: unknown; machine?: unknown };
    return { on: got.on === true, machine: got.machine === true };
  } catch {
    return { on: false, machine: false };
  }
}

/** Whether origin is a public GitHub repo (GitHub's runners are free there); a failed look counts as private. */
function isPublic(cwd: string): boolean {
  const url = spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout?.trim() ?? '';
  const slug = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1];
  if (!slug) return false;
  return spawnSync('gh', ['api', `repos/${slug}`, '--jq', '.private'], { encoding: 'utf8', timeout: 20_000 }).stdout?.trim() === 'false';
}

/** The command as citadel-heavy's history names it (CITADEL_HEAVY_WHAT, cut the same way). */
const whatOf = (cmd: string) => {
  const w = cmd.replace(/[\t\n]/g, ' ');
  return w.length <= 100 ? w : `${w.slice(0, 97)}...`;
};
/** This scheme's part of CITADEL_HEAVY_WHO ("Citadel #12 (title)" → "Citadel"), as citadel-heavy matches past runs. */
const scheme = (who: string) => who.split(/ #| \(/)[0];
const median = (xs: number[]) => (xs.length ? xs.toSorted((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

/** The cloud's runs of `cmd` over perigee's, the newest 5 of each; null when either has none. */
export function slower(cmd: string, dir = io.heavyDir()): number | null {
  const what = whatOf(cmd);
  const who = scheme(process.env.CITADEL_HEAVY_WHO ?? '');
  const runs = (file: string, keep: (reason: string) => boolean) => {
    if (!existsSync(join(dir, file))) return null;
    const secs = readFileSync(join(dir, file), 'utf8')
      .split('\n')
      .map((l) => l.split('\t'))
      .filter((f) => f.length >= 7 && f[2] === what && scheme(f[1]) === who && keep(f[3]) && /^[01]$/.test(f[6]))
      .map((f) => Number(f[5]))
      .filter((n) => n > 0);
    return median(secs.slice(-5));
  };
  const home = runs('history', (r) => !r.startsWith('ci:'));
  const cloud = runs('cloud-history', () => true);
  return home && cloud ? cloud / home : null;
}

/** A cloud run's line for `slower`, in citadel-heavy's history shape. */
function remember(cmd: string, seconds: number, code: number): void {
  try {
    mkdirSync(io.heavyDir(), { recursive: true });
    const who = (process.env.CITADEL_HEAVY_WHO ?? '').replace(/[\t\n]/g, ' ');
    appendFileSync(join(io.heavyDir(), 'cloud-history'), `${new Date().toISOString()}\t${who}\t${whatOf(cmd)}\tcloud\t0\t${seconds}\t${code}\t-\n`);
  } catch {}
}

/** A command through citadel-heavy: a PC's CI, GitHub's runners or perigee's slot. Its exit code (75: the server has it). */
async function heavy(place: Exclude<Place, 'cloud'>, job: Job, on: (state: string, detail?: string) => void): Promise<number> {
  const args = place === 'home' ? ['--here', 'bash', '-c', job.cmd] : ['bash', '-c', job.cmd];
  const env = { ...process.env, CITADEL_HEAVY_WHAT: whatOf(job.cmd), ...(place === 'github' ? { CITADEL_HEAVY_GITHUB: '1' } : {}) };
  const child = spawn(io.heavy, args, { cwd: io.cwd(), stdio: ['inherit', 'pipe', 'pipe'], env });
  // The output still streams to the turn; its end is kept for the chat line.
  let out = '';
  const keep = (to: NodeJS.WriteStream) => (b: Buffer) => {
    to.write(b);
    out = (out + b.toString()).slice(-16_384);
  };
  child.stdout.on('data', keep(process.stdout));
  child.stderr.on('data', keep(process.stderr));
  const tail = (n: number) => out.trimEnd().split('\n').slice(-n).join('\n');
  const began = Date.now();
  const mins = () => Math.round((Date.now() - began) / 60_000);
  const timer = setInterval(() => on(`${mins()} min: ${tail(1).slice(0, 200)}`, tail(30)), io.lineMs);
  stopping = () => child.kill('SIGTERM');
  const code = await new Promise<number>((r) => {
    child.once('error', () => r(127));
    child.once('close', (c, sig) => r(c ?? (sig === 'SIGTERM' ? 143 : 1)));
  });
  clearInterval(timer);
  stopping = null;
  on(code === 75 ? 'handed to Citadel to finish as a minion job' : code === 143 ? `stopped after ${mins()} min` : `exit ${code} after ${mins()} min`, tail(30));
  return code;
}

const WHERE: Record<Place, string> = { machine: 'on a PC lending this scheme CI', github: "on GitHub's own runners", cloud: 'in a cloud session', home: "here, in perigee's heavy-job slot" };

/** POST the step's chat line, or rewrite it; its event id, or null when it couldn't (a missing line, never a failed step). */
async function postLine(text: string, detail: string, event: number | null): Promise<number | null> {
  const base = process.env.COORDINATOR_API;
  const ticket = process.env.COORDINATOR_TICKET;
  if (!base || !ticket) return null;
  try {
    const r = await fetch(`${base}/api/tickets/${ticket}/cloud-helpers/line`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.COORDINATOR_TOKEN ?? ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, detail: detail.slice(-8000), ...(event === null ? {} : { event }) }),
    });
    return r.ok ? (((await r.json()) as { event?: number }).event ?? null) : null;
  } catch {
    return null;
  }
}

/** The step's one line in the minion's chat (Cara's "Live line per step"): what runs, where, and how it stands, rewritten in place. */
function liveLine(job: Job) {
  let event: number | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  const what = job.kind === 'run' ? `\`${job.cmd.length > 120 ? `${job.cmd.slice(0, 117)}...` : job.cmd}\`` : 'a brief';
  let where = '';
  const set = (state: string, detail = '') => {
    const text = `citadel-cloud: ${what} ${where} · ${state}`.replace(/\s+/g, ' ').slice(0, 400);
    chain = chain.then(async () => {
      event = (await io.line(text, detail, event)) ?? event;
    });
  };
  return { set, at: (place: Place) => (where = WHERE[place]), done: () => chain };
}

/** The helper's whole call: pick the place, run there, and bring a cloud job that didn't deliver home. */
export async function helper(job: Job): Promise<number> {
  const cwd = io.cwd();
  const server = await io.place();
  const workflow = existsSync(join(cwd, '.github/workflows/citadel-heavy.yml'));
  const facts: Facts = { ...server, workflow, public: job.kind === 'run' && workflow && !server.machine && !job.files.length && io.isPublic(cwd), slower: job.kind === 'run' ? slower(job.cmd) : null };
  const { place, why } = pickPlace(facts, job);
  io.log(`citadel-cloud: runs ${WHERE[place]}: ${why}`);
  const line = liveLine(job);
  line.at(place);
  const code = await (async () => {
    if (place === 'home' && job.kind === 'brief') {
      line.set('not run: a Grunt takes it', why);
      return home(why);
    }
    line.set('starting', `Why here: ${why}.`);
    if (place !== 'cloud') return heavy(place, job, line.set);
    const began = Date.now();
    const c = await cloud(job, line.set);
    if (c === 143) line.set(`stopped after ${Math.round((Date.now() - began) / 60_000)} min`);
    if (job.kind === 'brief' || c !== AT_HOME) {
      if (job.kind === 'run' && (c === 0 || c === 1)) remember(job.cmd, Math.round((Date.now() - began) / 1000), c);
      if (c === AT_HOME) line.set("didn't deliver: a Grunt takes it");
      return c;
    }
    io.log(`citadel-cloud: runs ${WHERE.home} instead`);
    line.set("the cloud session didn't deliver, so it runs here");
    line.at('home');
    return heavy('home', job, line.set);
  })();
  await line.done();
  return code;
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
  helper(job).then(
    (c) => process.exit(c),
    (err) => {
      home(`the helper failed: ${(err as Error).message}`);
      process.exit(AT_HOME);
    },
  );
}
