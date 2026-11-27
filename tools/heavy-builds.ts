// A heavy job on another machine's Builds role (H2, src/heavy-builds.ts), for tools/citadel-heavy: it asks the server
// where the job goes, sends a snapshot of the working copy there, prints the log and brings back the files it was told
// to (--back), and exits with the command's status. Exit 120 (with CITADEL_HEAVY_FALLBACK_FILE written): nothing took
// it, so citadel-heavy runs it in perigee's line. A machine that goes away mid-job stops it and says so (a minion's job
// is never run twice behind its back); with CITADEL_HEAVY_UNATTENDED=1 it is placed once more.
//   heavy-builds.ts [--place-only] [--back <path>]... -- <command> [args...]
// --place-only exits 0 when a machine could take it now, 1 when none can. Like heavy-ci.ts beside it, a turn runs this
// file alone (src/turn-launch.ts): it imports only from heavy-ci.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FALLBACK, SECRETS } from './heavy-ci.ts';

const env = process.env;
const say = (s: string) => process.stderr.write(`citadel-heavy: ${s}\n`);
const POLL_MS = Number(env.CITADEL_HEAVY_BUILD_POLL_MS) || 5_000;
/** Offline this long while it runs: the machine went away. */
const AWAY_MS = Number(env.CITADEL_HEAVY_AWAY_MS) || 90_000;
const INPUT_MAX = 2 * 1024 ** 3;

/**
 * The kind a command is (its image and size on the server): the first word past env settings and wrappers. Null for
 * Citadel's own tools (citadel-node, citadel-test), which live only on perigee's turn PATH, not in a build image.
 */
export function kindOf(argv: readonly string[]): 'apk' | 'cargo' | 'suite' | 'other' | null {
  const words = [...argv];
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ['env', 'nice', 'time', 'timeout', 'ionice'].includes(basename(words[0])) || /^-|^[0-9]+[smhd]?$/.test(words[0]))) words.shift();
  const cmd = basename(words[0] ?? '');
  if (cmd.startsWith('citadel-')) return null;
  if (cmd === 'cargo') return 'cargo';
  if (cmd === 'gradlew' || cmd === 'gradle' || cmd === 'apk-build.ts') return 'apk';
  if (['npm', 'npx', 'node', 'pnpm', 'yarn'].includes(cmd)) return 'suite';
  return 'other';
}

/** podman never ran the command there (public/machine-agent.mjs, BUILD_NEVER_RAN): it may run here. */
const NEVER_RAN = "podman couldn't start the build";

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

/** The ignored files a Capacitor build reads, from the Gradle project: what `cap sync` writes, and apk-build.ts's init script. Nothing else ignored goes, since that's where people keep keys. */
const SYNCED = /^(app\/src\/main\/assets\/|app\/src\/main\/res\/xml\/config\.xml$|capacitor-cordova-android-plugins\/|capacitor\.settings\.gradle$|app\/capacitor\.build\.gradle$|\.citadel-apk-version\.gradle$)/;
/** Never among the extras either: SECRETS' file names, and Android's own places for keys and local paths. */
const KEPT_HOME = new RegExp(`^(?:${[...SECRETS.map((g) => g.replace('**/', '')), 'local.properties', 'keystore.properties', '*.pass'].map((g) => g.replace(/\./g, '\\.').replace(/\*/g, '.*')).join('|')})$`);

/**
 * What a Capacitor Android build needs that .gitignore leaves out (H3): `cap sync`'s output in the Gradle project
 * (SYNCED) and the node_modules packages capacitor.settings.gradle names. `dir` is the
 * Gradle project, from `top`; the files are named from `top`. Gradle's own output (a build/ beside a build.gradle)
 * and key files stay. None for a project that isn't Capacitor's.
 */
export function capacitorExtras(top: string, dir: string): string[] {
  const project = resolve(top, dir);
  let settings: string;
  try {
    settings = readFileSync(join(project, 'capacitor.settings.gradle'), 'utf8');
  } catch {
    return [];
  }
  const gradleHere = (at: string) => existsSync(join(at, 'build.gradle')) || existsSync(join(at, 'build.gradle.kts'));
  const outputs = (at: string, name: string) => name === '.gradle' || name === '.cxx' || (name === 'build' && gradleHere(at));
  const out = new Set<string>();
  const ignored = execFileSync('git', ['-C', top, 'ls-files', '-z', '-oi', '--exclude-standard', '--', dir || '.'], { encoding: 'utf8', maxBuffer: 256 << 20 });
  for (const f of ignored.split('\0').filter(Boolean)) {
    const parts = f.split('/');
    if (!SYNCED.test(relative(project, join(top, f)))) continue;
    if (!parts.some((p, i) => p === 'node_modules' || outputs(join(top, ...parts.slice(0, i)), p)) && !KEPT_HOME.test(parts.at(-1)!)) out.add(f);
  }
  const walk = (at: string) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, e.name);
      if (e.name === 'node_modules' || outputs(at, e.name) || KEPT_HOME.test(e.name)) continue;
      if (e.isDirectory()) walk(path);
      else out.add(relative(top, path));
    }
  };
  for (const [, pkg] of settings.matchAll(/new File\(\s*['"]([^'"]*node_modules\/(?:@[^/'"]+\/)?[^/'"]+)/g)) {
    const at = resolve(project, pkg);
    if (!relative(top, at).startsWith('..') && existsSync(at)) walk(at);
  }
  return [...out];
}

/**
 * The working copy as it is (tracked and untracked files, .gitignore kept, no .env or key files but a tracked
 * debug.keystore), plus `extras` (capacitorExtras), whose links are followed: a linked node_modules goes as its files.
 */
export function snapshot(top: string, into: string, extras: string[] = []): string {
  const file = join(into, 'snapshot.tgz');
  const listed = execFileSync('git', ['-C', top, 'ls-files', '-z', '-co', '--exclude-standard', '--', ':/', ...SECRETS.map((g) => `:(top,exclude,glob)${g}`)], { encoding: 'utf8', maxBuffer: 256 << 20 });
  // A link on the way to an extra file (node_modules itself, where .gitignore names only the folder) isn't packed as a link.
  const parents = new Set(extras.flatMap((f) => f.split('/').map((_, i, p) => p.slice(0, i).join('/'))));
  // The one key file that goes: a tracked debug.keystore, which is public by the android-app skill's rule and which debug builds sign with.
  const debug = execFileSync('git', ['-C', top, 'ls-files', '-z', '--', ':(top,glob)**/debug.keystore'], { encoding: 'utf8' });
  const list = `${listed}${debug}`.split('\0').filter((f) => f && !parents.has(f));
  const plain = extras.length ? join(into, 'snapshot.tar') : file;
  // A file deleted since it was added is in the list but not on disk: left out, not an error. --no-recursion: a
  // checked-out submodule is listed as its folder, and its own .env and keys must not ride along inside it.
  const tar = (args: string[], names: string[]) => {
    const r = spawnSync('tar', ['-C', top, '--null', '--no-recursion', '--ignore-failed-read', ...args, '-T', '-'], { input: names.map((n) => `${n}\0`).join(''), stdio: ['pipe', 'ignore', 'pipe'] });
    if (r.status !== 0 && r.status !== 1) throw new Error(`tar couldn't pack the working copy: ${String(r.stderr).trim().slice(-300)}`);
  };
  tar([extras.length ? '-cf' : '-czf', plain], list);
  if (extras.length) {
    tar(['--dereference', '-rf', plain], extras);
    const z = spawnSync('gzip', ['-f', plain], { stdio: ['ignore', 'ignore', 'pipe'] });
    if (z.status !== 0) throw new Error(`gzip couldn't pack the working copy: ${String(z.stderr).trim().slice(-300)}`);
    renameSync(`${plain}.gz`, file);
  }
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
  const dir = execFileSync('git', ['rev-parse', '--show-prefix'], { encoding: 'utf8' }).trim().replace(/\/$/, '');
  const snap = snapshot(top, scratch, kind === 'apk' ? capacitorExtras(top, dir) : []);
  let started: { job: number; machine: string } | null = null;
  for (const s of spots) {
    try {
      started = await call('POST', '', { do: 'start', machine: s.id, kind, argv, dir, back, snapshot: snap, ...(env.CITADEL_HEAVY_BUILD_MINUTES ? { minutes: Number(env.CITADEL_HEAVY_BUILD_MINUTES) } : {}) });
      break;
    } catch (e) {
      if (e instanceof Refused && e.status === 409) continue;
      // Citadel's own refusal: nothing was queued. No answer at all: it may have been, so it never runs here too.
      if (e instanceof Refused) throw e;
      say(`no answer from Citadel on sending it to ${s.name} (${(e as Error).message}), so it may run there: nothing more runs here`);
      return 1;
    }
  }
  if (!started) return fallback('the machines with room turned it down');
  try {
    return await follow(started, kind, back, top, scratch);
  } catch (e) {
    say(`lost track of job #${started.job} on ${started.machine} (${(e as Error).message}): nothing more runs here`);
    return 1;
  }
}

/** Follows a started job to its end: its log, its files back, its status. */
async function follow(started: { job: number; machine: string }, kind: string, back: string[], top: string, scratch: string): Promise<number | 'away'> {
  const { job: id, machine } = started;
  say(`runs on ${machine} (job #${id}), in Citadel's build image for ${kind === 'other' ? 'any command' : kind} jobs`);
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
    // For citadel-heavy's history line (#2109): what held it on the machine, kept once it starts.
    if (j.state === 'queued' && env.CITADEL_HEAVY_WAITED_FILE) {
      try {
        writeFileSync(env.CITADEL_HEAVY_WAITED_FILE, j.online ? 'room' : 'offline');
      } catch {
        // A note for the history: the job is followed to its end without it.
      }
    }
    away = j.online ? null : (away ?? Date.now());
    if (away !== null && Date.now() - away >= AWAY_MS) {
      const stopped = await call('POST', '', { do: 'stop', job: id }).then(
        () => true,
        () => false,
      );
      // Still waiting there: it never started, so perigee's line takes it.
      if (stopped && j.state === 'queued') {
        await call('POST', '', { do: 'done', job: id }).catch(() => {});
        return fallback(`${machine} went away before job #${id} started`);
      }
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
  // Refused before it ran (its role switched off), or podman never ran it (an image it couldn't get): it runs here.
  if (j.state === 'refused' || (j.state === 'failed' && j.exit_code === null && (j.error ?? '').startsWith(NEVER_RAN))) {
    await call('POST', '', { do: 'done', job: id }).catch(() => {});
    return fallback(`${machine} didn't run it (${j.error ?? j.state})`);
  }
  if (back.length && j.exit_code !== null) {
    const tar = await call<Buffer>('GET', `/${id}/file?name=back`).catch(() => null);
    let why = tar ? null : "they couldn't be fetched";
    if (tar) {
      const t = join(scratch, 'back.tar');
      writeFileSync(t, tar);
      // podman cp's tar holds back.tgz, the files as the command left them, relative to the working copy's top.
      const r = spawnSync('tar', ['-xf', t, '-C', scratch, 'back.tgz'], { stdio: ['ignore', 'inherit', 'pipe'] });
      const u = r.status === 0 ? spawnSync('tar', ['-xzf', join(scratch, 'back.tgz'), '-C', top], { stdio: ['ignore', 'inherit', 'pipe'] }) : r;
      if (u.status !== 0) why = `they couldn't be unpacked: ${String(u.stderr).trim().slice(-300)}`;
    }
    if (why) {
      // Kept on Citadel, so a second look can still get them; a green build without its files isn't green here.
      say(`${back.join(', ')} didn't come back from ${machine}: ${why}; job #${id}'s results stay on Citadel`);
      return j.exit_code || 1;
    }
    say(`unpacked what came back from ${machine} (asked for ${back.join(', ')}; tar names any it didn't find above)`);
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
  if (!kind) return only ? 1 : fallback("Citadel's own tools are only here");
  if (only) return (await place(kind).catch(() => [])).length ? 0 : 1;
  let top: string;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback('this folder is not a git working copy');
  }
  // --back paths are from here; the server and the image take them from the working copy's top.
  for (const [i, b] of back.entries()) {
    const rel = relative(top, resolve(b));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return (say(`--back ${b} isn't inside the working copy`), 2);
    back[i] = rel;
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
  const argv = process.argv.slice(2);
  // `--pack <top> <into> <dir>`: how Citadel snapshots a release build's checkout off its own thread (src/apk-machine.ts).
  if (argv[0] === '--pack') snapshot(argv[1], argv[2], capacitorExtras(argv[1], argv[3]));
  else
    main(argv).then((code) => {
      process.exitCode = code;
    });
}
