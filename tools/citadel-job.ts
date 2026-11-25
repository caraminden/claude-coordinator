// citadel-job (#1890): a heavy job that belongs to the minion, not to its turn. The server starts it (POST
// /api/tickets/<id>/minion-jobs, src/minion-jobs.ts), so it runs on when the turn ends, and the server wakes the minion with
// how it went.
//   citadel-job [--minutes N] <command> [args…]   run it through citadel-heavy; a short one's output is printed here
//   citadel-job --watch <id>                      wait in the turn for one handed over (124: still running, run it again)
//   citadel-job --stop <id>                       stop one
//   citadel-job --handover <kind> <arg> <secs> <pid>    citadel-wait's own: whether the server takes its wait over
// Exits with the command's code; 75 once it is handed over (end your turn: you are woken). With no server to start it
// (a person's shell, an older server, a turn that can't) it runs the command in the turn, as citadel-heavy would.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants, cpSync, existsSync, fstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const HANDED = 75;
/** Under the Bash tool's own two-minute default, which would cut the hold off. */
const MAX_HOLD_MS = 110_000;
const WATCH_MS = 570_000;
/** Longer than the server tries to launch one. */
const START_MS = 45_000;
/** How much of a job's output is printed here; the log has all of it. */
const TAIL = 16 * 1024;

const here = import.meta.dirname;
const env = process.env;
const say = (s: string) => console.error(`citadel-job: ${s}`);
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

interface Answer {
  id?: string;
  holdMs?: number;
  retryIn?: number;
  take?: boolean;
  error?: string;
}

/** The server said no: nothing of it was started. */
class Refused extends Error {}

async function api(body: object, timeout = 15_000): Promise<Answer> {
  const { COORDINATOR_API: url, COORDINATOR_TOKEN: token, COORDINATOR_TICKET: ticket } = env;
  if (!url || !token || !ticket) throw new Error('no server here');
  const res = await fetch(`${url.replace(/\/$/, '')}/api/tickets/${ticket}/minion-jobs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const answer = (await res.json().catch(() => ({}))) as Answer;
  if (!res.ok) throw new Refused(answer.error ?? `the server said ${res.status}`);
  return answer;
}

const jobsDir = () => join(env.TMPDIR ?? '/nowhere', 'jobs');

// Left out of a job's env: what a Claude session or this turn alone may use, and names bash won't take.
const DROP = /^(COORDINATOR_TOKEN|CITADEL_POOL_PORT|CLAUDE.*|ANTHROPIC_.*|BASH.*|SHELLOPTS|UID|EUID|PPID|ENV|_|__cj.*)$/;

/** Write the job's folder: its command, the turn's env (gone once the job has read it) and its own copy of the turn's tools. */
function prepare(id: string, argv: string[], more: Record<string, string> = {}, stdin: Buffer | null = null): string {
  const dir = join(jobsDir(), id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // On a turn's PATH this sits in its pin's bin/, which goes with the turn.
  const pin = join(here, '..');
  const pinned = basename(here) === 'bin' && existsSync(join(pin, 'bin', 'citadel-wait'));
  const own = join(dir, 'pin');
  if (pinned) cpSync(pin, own, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, filter: (p) => basename(p) !== '.compile-cache' });
  const paths = new Set([pin, realpathSync(pin)]);
  mkdirSync(join(dir, 'gh'), { mode: 0o700 });
  const vars: Record<string, string | undefined> = { ...env, ...(env.GH_CONFIG_DIR ? { GH_CONFIG_DIR: join(dir, 'gh') } : {}), CITADEL_JOB: id, ...more };
  const moved = (s: string) => (pinned ? [...paths].reduce((v, from) => v.split(from).join(own), s) : s);
  const lines = Object.entries(vars).flatMap(([k, v]) => {
    if (v === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || DROP.test(k)) return [];
    return [`export ${k}=${quote(moved(v))}\n`];
  });
  writeFileSync(join(dir, 'env'), lines.join(''), { mode: 0o600 });
  writeFileSync(join(dir, 'cmd'), `cd ${quote(process.cwd())} && set -- ${argv.map((a) => quote(moved(a))).join(' ')}\n`);
  if (stdin) writeFileSync(join(dir, 'stdin'), stdin, { mode: 0o600 });
  cpSync(join(here, 'citadel-job-run.sh'), join(dir, 'run.sh'));
  return dir;
}

/**
 * Ask the server to start a prepared job. True: it runs there. False: it never will, so the turn may run it itself.
 * A start whose answer is lost is settled by who makes `claim` first, run.sh or this: one of them runs it, never both.
 */
async function started(dir: string, ask: object): Promise<{ holdMs: number } | { why: string }> {
  try {
    return { holdMs: (await api({ do: 'start', dir, ...ask }, START_MS)).holdMs ?? 0 };
  } catch (err) {
    const why = (err as Error).message;
    if (!(err instanceof Refused)) {
      try {
        mkdirSync(join(dir, 'claim'));
        // The server may still hear of it: it finds it over, and read.
        for (const f of ['env', 'stdin', 'pin']) rmSync(join(dir, f), { recursive: true, force: true });
        writeFileSync(join(dir, 'seen'), '');
        writeFileSync(join(dir, 'code'), '0\n');
        return { why };
      } catch {
        // Claimed: by a run.sh, which beats at once, or by the server, which gave up on it.
        await sleep(2_000);
        if (existsSync(join(dir, 'beat'))) return { holdMs: 0 };
      }
    }
    rmSync(dir, { recursive: true, force: true });
    return { why };
  }
}

/** What is piped to the command, or null. */
async function piped(): Promise<Buffer | null> {
  const st = fstatSync(0);
  if (st.isFile()) return readFileSync(0);
  if (!st.isFIFO()) return null;
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const newId = () => `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

function codeOf(dir: string): number | null {
  try {
    const n = Number(readFileSync(join(dir, 'code'), 'utf8').trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function printEnd(dir: string, code: number) {
  // The turn has its result: no wake for it.
  writeFileSync(join(dir, 'seen'), '');
  const log = join(dir, 'output.log');
  const text = existsSync(log) ? readFileSync(log, 'utf8') : '';
  if (text.length > TAIL) say(`the last ${TAIL / 1024} KB (all of it: ${log})`);
  process.stdout.write(text.slice(-TAIL));
  if (code) say(`exit ${code}`);
}

async function hold(dir: string, ms: number): Promise<number | null> {
  const until = Date.now() + ms;
  for (;;) {
    const code = codeOf(dir);
    if (code !== null) {
      printEnd(dir, code);
      return code;
    }
    if (Date.now() >= until) return null;
    await sleep(Math.min(500, Math.max(1, until - Date.now())));
  }
}

/** Old jobs' folders: ended, or cut off, over a day ago (a running one beats), so a minion's scratch doesn't grow with each. */
function prune() {
  try {
    for (const id of readdirSync(jobsDir())) {
      const dir = join(jobsDir(), id);
      const last = Math.max(...['.', 'beat', 'code'].map((f) => statSync(join(dir, f), { throwIfNoEntry: false })?.mtimeMs ?? 0));
      if (Date.now() - last > 24 * 3600_000) rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    /* none yet */
  }
}

async function start(argv: string[], minutes: number | undefined): Promise<number> {
  const command = argv[0] === 'citadel-heavy' ? argv : ['citadel-heavy', ...argv];
  let stdin: Buffer | null = null;
  const inTurn = (why: string) => {
    say(`${why}, so it runs in this turn`);
    const r = spawnSync(command[0], command.slice(1), stdin ? { input: stdin, stdio: ['pipe', 'inherit', 'inherit'] } : { stdio: 'inherit' });
    if (r.error) say(r.error.message);
    return r.status ?? 1;
  };
  if (env.CITADEL_JOB || !env.TMPDIR) return inTurn(env.CITADEL_JOB ? 'already inside a job' : 'no temp folder');
  const began = Date.now();
  stdin = await piped();
  const id = newId();
  let dir: string;
  try {
    prune();
    dir = prepare(id, command, {}, stdin);
  } catch (err) {
    return inTurn((err as Error).message);
  }
  const ran = await started(dir, { id, what: argv.join(' '), minutes });
  if ('why' in ran) return inTurn(ran.why);
  const code = await hold(dir, Math.min(ran.holdMs, MAX_HOLD_MS - (Date.now() - began)));
  if (code !== null) return code;
  console.log(`citadel-job: handed over as ${id}. It runs on the server whatever this turn does; its output goes to ${join(dir, 'output.log')}.
End your turn now (or do other work that doesn't touch the files it runs on): you are woken with how it went.
In a Grunt, or with a Grunt of yours still running, wait here instead: citadel-job --watch ${id} (Bash timeout 600000, again on exit 124).`);
  return HANDED;
}

// --- citadel-wait's handover ---------------------------------------------------------------------------------------

interface P {
  ppid: number;
  cmd: string;
  cwd: string;
}
function procs(): Map<number, P> {
  const out = new Map<number, P>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const cmd = readFileSync(`/proc/${name}/cmdline`, 'utf8').replace(/\0/g, ' ');
      out.set(Number(name), { ppid, cmd, cwd: readlinkSync(`/proc/${name}/cwd`) });
    } catch {
      /* gone, or another's */
    }
  }
  return out;
}

/**
 * Whether citadel-wait was typed on its own in the turn's Bash tool and nothing else of the turn runs: ending the turn
 * then loses nothing. `self` is citadel-wait's pid, `claude` the session's.
 */
export function waitsAlone(all: Map<number, P>, self: number, claude: number, folders: string[]): boolean {
  const ancestors = (pid: number) => {
    const line: number[] = [];
    for (let p = all.get(pid)?.ppid; p && !line.includes(p); p = all.get(p)?.ppid) line.push(p);
    return line;
  };
  const shell = all.get(self)?.ppid;
  if (!shell || all.get(shell)?.ppid !== claude || !all.get(shell)!.cmd.includes('shell-snapshots')) return false;
  const above = ancestors(claude);
  for (const [pid, p] of all) {
    const line = ancestors(pid);
    if (pid === claude || pid === self || line.includes(self) || above.includes(pid)) continue;
    // Another Bash command of the turn; claude's other children are its helpers (MCP and language servers).
    if (line.includes(claude)) {
      if (p.ppid === claude && pid !== shell && p.cmd.includes('shell-snapshots')) return false;
      if (line.includes(shell) && pid !== shell) return false;
      continue;
    }
    // Left running by the turn (nohup, setsid) in its folders; a server-run job there isn't the turn's.
    const own = [pid, ...line].some((x) => / \S*\/jobs\/[a-z0-9-]+\/run\.sh /.test(all.get(x)?.cmd ?? ''));
    if (!own && folders.some((f) => p.cwd === f || p.cwd.startsWith(`${f}/`))) return false;
  }
  return true;
}

/** Print what citadel-wait does next: a number of seconds to ask again after; nothing (exit 1) never; exit 75 handed over. */
async function handover(kind: string, arg: string, waited: number, self: number): Promise<number> {
  const claude = Number(env.CLAUDE_PID);
  if (!['file', 'cmd'].includes(kind) || !claude || !env.TMPDIR || env.CITADEL_JOB) return 1;
  if (!waitsAlone(procs(), self, claude, [process.cwd(), join(env.TMPDIR)])) return 1;
  const what = kind === 'file' ? `${arg} to exist` : arg;
  const asked = await api({ do: 'ask', what, waited });
  if (!asked.take) {
    if (!asked.retryIn) return 1;
    console.log(Math.ceil(asked.retryIn));
    return 0;
  }
  prune();
  const id = newId();
  // Its own long limit: the job's, which the server also keeps.
  const dir = prepare(id, [join(here, 'citadel-wait'), kind, arg], { CITADEL_WAIT_SECONDS: '10800', CITADEL_WAIT_HANDOVER: '0' });
  if ('why' in (await started(dir, { id, kind: 'wait', what, waited }))) return 1;
  console.error(`citadel-wait: handed over: the server goes on waiting for ${kind === 'file' ? what : `\`${arg}\``}, up to 3 hours, and wakes you when it happens.
End your turn now; what you planned to do next waits for the wake. If you are a Grunt, or one of yours is still running, run the same citadel-wait again: it then waits here.`);
  return HANDED;
}

async function main(args: string[]): Promise<number> {
  if (args[0] === '--handover') return handover(args[1] ?? '', args[2] ?? '', Number(args[3]) || 0, Number(args[4])).catch(() => 1);
  if (args[0] === '--watch' && /^[a-z0-9]+-[a-z0-9]+$/.test(args[1] ?? '')) {
    const dir = join(jobsDir(), args[1]);
    if (!existsSync(dir)) return (say(`no job ${args[1]}`), 2);
    const code = await hold(dir, Number(env.CITADEL_WAIT_SECONDS) * 1000 || WATCH_MS);
    if (code === null) say(`still running; run it again to keep waiting (output so far: ${join(dir, 'output.log')})`);
    return code ?? 124;
  }
  if (args[0] === '--stop' && args[1]) {
    try {
      await api({ do: 'stop', id: args[1] });
    } catch (err) {
      return (say((err as Error).message), 1);
    }
    return (say('stopping it'), 0);
  }
  let minutes: number | undefined;
  if (args[0] === '--minutes') {
    minutes = Number(args[1]);
    args = args.slice(2);
  }
  if (args[0] === '--') args = args.slice(1);
  if (!args.length || args[0].startsWith('-') || (minutes !== undefined && !(minutes > 0))) {
    say('usage: citadel-job [--minutes N] <command> [args…] | --watch <id> | --stop <id>');
    return 2;
  }
  return start(args, minutes);
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
