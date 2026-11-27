// A heavy job on another machine's Builds role (H2, src/heavy-builds.ts), for tools/citadel-heavy: it asks the server
// where the job goes, sends a snapshot of the working copy there, prints the log and brings back the files it was told
// to (--back), and exits with the command's status. Exit 120 (with CITADEL_HEAVY_FALLBACK_FILE written): nothing took
// it, so citadel-heavy runs it in perigee's line. A machine that goes away mid-job stops it and says so (a minion's job
// is never run twice behind its back); with CITADEL_HEAVY_UNATTENDED=1 it is placed once more.
//   heavy-builds.ts [--place-only] [--back <path>]... -- <command> [args...]
// --place-only exits 0 when a machine could take it now, 1 when none can. Like heavy-ci.ts beside it, a turn runs this
// file alone (src/turn-launch.ts): it imports only from heavy-ci.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FALLBACK, SECRETS } from './heavy-ci.ts';

const env = process.env;
const say = (s: string) => process.stderr.write(`citadel-heavy: ${s}\n`);
const POLL_MS = Number(env.CITADEL_HEAVY_BUILD_POLL_MS) || 5_000;
/** Offline this long while it runs: the machine went away. */
const AWAY_MS = Number(env.CITADEL_HEAVY_AWAY_MS) || 90_000;
const INPUT_MAX = 2 * 1024 ** 3;

/** The kind a command is (its image and size on the server): the first word past env settings and wrappers. */
export function kindOf(argv: readonly string[]): 'apk' | 'cargo' | 'suite' | 'other' {
  const words = [...argv];
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ['env', 'nice', 'time', 'timeout', 'ionice'].includes(basename(words[0])) || /^-|^[0-9]+[smhd]?$/.test(words[0]))) words.shift();
  const cmd = basename(words[0] ?? '');
  if (cmd === 'cargo') return 'cargo';
  if (cmd === 'gradlew' || cmd === 'gradle' || cmd === 'apk-build.ts') return 'apk';
  if (['npm', 'npx', 'node', 'pnpm', 'yarn', 'citadel-node', 'citadel-test'].includes(cmd)) return 'suite';
  return 'other';
}

class Refused extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, path: string, body?: object): Promise<T> {
  const { COORDINATOR_API: url, COORDINATOR_TOKEN: token, COORDINATOR_TICKET: ticket } = env;
  if (!url || !token || !ticket) throw new Refused(0, 'no Citadel server here');
  const res = await fetch(`${url.replace(/\/$/, '')}/api/tickets/${ticket}/heavy-builds${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Refused(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `the server said ${res.status}`);
  return (path.endsWith('name=log') || path.endsWith('name=back') ? Buffer.from(await res.arrayBuffer()) : await res.json()) as T;
}

type Spot = { id: number; name: string; free: number };
type Job = { id: number; state: string; exit_code: number | null; error: string | null; machine: string | null; online: boolean; waits: string | null };

const place = (kind: string) => call<{ spots: Spot[] }>('POST', '', { do: 'place', kind }).then((r) => r.spots);

/** The working copy as it is (tracked and untracked files, .gitignore kept, no .env or key files), as heavy-ci.ts snapshots it. */
function snapshot(top: string, into: string): string {
  const file = join(into, 'snapshot.tgz');
  const list = execFileSync('git', ['-C', top, 'ls-files', '-z', '-co', '--exclude-standard', '--', ':/', ...SECRETS.map((g) => `:(top,exclude,glob)${g}`)], { maxBuffer: 256 << 20 });
  // A file deleted since it was added is in the list but not on disk: left out, not an error.
  const r = spawnSync('tar', ['-C', top, '--null', '--ignore-failed-read', '-czf', file, '-T', '-'], { input: list, stdio: ['pipe', 'ignore', 'pipe'] });
  if (r.status !== 0 && r.status !== 1) throw new Error(`tar couldn't pack the working copy: ${String(r.stderr).trim().slice(-300)}`);
  if (statSync(file).size > INPUT_MAX) throw new Error('the working copy packs to over 2 GB');
  return file;
}

function fallback(why: string): number {
  say(`${why}, so it runs here, in perigee's line`);
  if (env.CITADEL_HEAVY_FALLBACK_FILE) writeFileSync(env.CITADEL_HEAVY_FALLBACK_FILE, `${why}\n`);
  return FALLBACK;
}

/** Runs it on the first machine that takes it. Returns its status, FALLBACK, or 'away' when its machine went away mid-job. */
async function runOnce(kind: string, argv: string[], back: string[], top: string, scratch: string): Promise<number | 'away'> {
  const spots = await place(kind);
  if (!spots.length) return fallback('no machine with the Builds role has room for it now');
  const snap = snapshot(top, scratch);
  const dir = execFileSync('git', ['rev-parse', '--show-prefix'], { encoding: 'utf8' }).trim().replace(/\/$/, '');
  let started: { job: number; machine: string } | null = null;
  for (const s of spots) {
    try {
      started = await call('POST', '', { do: 'start', machine: s.id, kind, argv, dir, back, snapshot: snap, ...(env.CITADEL_HEAVY_BUILD_MINUTES ? { minutes: Number(env.CITADEL_HEAVY_BUILD_MINUTES) } : {}) });
      break;
    } catch (e) {
      if (!(e instanceof Refused) || e.status !== 409) throw e;
    }
  }
  if (!started) return fallback('the machines with room turned it down');
  const { job: id, machine } = started;
  say(`runs on ${machine} (job #${id}), in Citadel's ${kind} build image`);
  if (env.CITADEL_HEAVY_ON_FILE) writeFileSync(env.CITADEL_HEAVY_ON_FILE, machine);
  const stop = async (sig: NodeJS.Signals) => {
    await call('POST', '', { do: 'stop', job: id }).catch(() => {});
    process.exit(128 + (sig === 'SIGINT' ? 2 : 15));
  };
  process.once('SIGINT', stop).once('SIGTERM', stop);
  let away: number | null = null;
  let ranFrom: number | null = null;
  let told = Date.now();
  let j: Job | null = null;
  for (let look = 0; !j || !['done', 'failed', 'stopped', 'refused'].includes(j.state); look++) {
    if (look) await sleep(POLL_MS);
    // A blip reading it is no news; a 404 (it's gone) is the end.
    const now = await call<Job>('GET', `/${id}`).catch((e) => {
      if (e instanceof Refused && e.status === 404) throw e;
      return null;
    });
    if (!now) continue;
    j = now;
    if (j.state === 'running') ranFrom ??= Date.now();
    away = j.online ? null : (away ?? Date.now());
    if (away !== null && Date.now() - away >= AWAY_MS) {
      await call('POST', '', { do: 'stop', job: id }).catch(() => {});
      say(`${machine} went away mid-job, so job #${id} was stopped`);
      return 'away';
    }
    if (Date.now() - told >= 60_000) {
      say(j.state === 'queued' ? `waits on ${machine}: ${j.waits ?? 'for room'}` : `still ${j.state} on ${machine}, ${Math.round((Date.now() - (ranFrom ?? told)) / 60_000)} min`);
      told = Date.now();
    }
  }
  const ran = ranFrom ? Math.round((Date.now() - ranFrom) / 1000) : 0;
  if (env.CITADEL_HEAVY_RAN_FILE) writeFileSync(env.CITADEL_HEAVY_RAN_FILE, String(ran));
  const log = await call<Buffer>('GET', `/${id}/file?name=log`).catch(() => null);
  if (log) process.stdout.write(log);
  // Refused before it ran (its role switched off, an image it lacks): nothing ran there, so it runs here.
  if (j.state === 'refused' || (j.state === 'failed' && !ranFrom && j.exit_code === null)) {
    await call('POST', '', { do: 'done', job: id }).catch(() => {});
    return fallback(`${machine} didn't run it (${j.error ?? j.state})`);
  }
  if (back.length && j.exit_code !== null) {
    const tar = await call<Buffer>('GET', `/${id}/file?name=back`).catch(() => null);
    if (!tar) say(`none of ${back.join(', ')} came back`);
    else {
      const t = join(scratch, 'back.tar');
      writeFileSync(t, tar);
      // podman cp's tar holds back.tgz, the files as the command left them, relative to the working copy's top.
      const r = spawnSync('sh', ['-c', 'tar -xOf "$1" back.tgz | tar -xzf - -C "$2"', 'sh', t, top], { stdio: ['ignore', 'inherit', 'pipe'] });
      if (r.status !== 0) say(`the files that came back couldn't be unpacked: ${String(r.stderr).trim().slice(-300)}`);
      else say(`brought back ${back.join(', ')} from ${machine}`);
    }
  }
  await call('POST', '', { do: 'done', job: id }).catch(() => {});
  if (j.exit_code !== null) return j.exit_code;
  say(`job #${id} on ${machine} ended ${j.state}${j.error ? `: ${j.error}` : ''}; nothing more runs here`);
  return 1;
}

export async function main(args: string[]): Promise<number> {
  const back: string[] = [];
  let only = false;
  while (args.length && args[0] !== '--') {
    const a = args.shift()!;
    if (a === '--place-only') only = true;
    else if (a === '--back' && args.length) back.push(args.shift()!);
    else return (say(`heavy-builds.ts: unknown option ${a}`), 2);
  }
  args.shift();
  if (!args.length) return (say('usage: heavy-builds.ts [--place-only] [--back <path>]... -- <command> [args...]'), 2);
  const kind = kindOf(args);
  if (only) return (await place(kind).catch(() => [])).length ? 0 : 1;
  let top: string;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback('this folder is not a git working copy');
  }
  const scratch = mkdtempSync(join(env.TMPDIR || '/tmp', 'heavy-builds-'));
  try {
    for (let tries = env.CITADEL_HEAVY_UNATTENDED === '1' ? 2 : 1; tries > 0; tries--) {
      const r = await runOnce(kind, args, back, top, scratch);
      if (r !== 'away') return r;
      if (tries > 1) say('placing it once more (an unattended job)');
    }
    say('nothing more runs here: run it again when you want it');
    return 1;
  } catch (e) {
    if (e instanceof Refused) return fallback(`Citadel didn't place it (${e.message})`);
    return fallback(`it couldn't be sent (${(e as Error).message})`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
