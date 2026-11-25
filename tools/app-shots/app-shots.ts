// The nightly screenshots of every contraption (#1783): each app's deployed checkout is started as a throwaway copy in a
// sealed room (sandbox.sh: no network, no real data, no keys), its main pages are shot at desktop and phone widths
// (inner.ts), and each shot is compared with the night before's. Run by src/app-shots.ts; it makes no model call and
// messages nobody, it only writes <out>/<day>/ (one folder per app, and night.json last, when all of it is in) and the
// pages people look at (page.ts).
//
//   node tools/app-shots/app-shots.ts --out <dir> --apps <json file> [--day YYYY-MM-DD] [--pages 10]
//
// The apps file is src/app-shots.ts's Apps. A page that looks broken is shot again in a second copy before it counts, so
// one slow start isn't a broken page.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { availableParallelism, homedir, loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { KIT_FILE } from '../../src/front.ts';
import { pacificDay } from '../../src/pacific.ts';
import { problems, type AppNight, type Night, type Since } from '../../src/shot-judge.ts';
import { changed, readPng } from './picture.ts';
import type { Apps, AppSpec } from '../../src/app-shots.ts';
import { writePages } from './page.ts';
import type { Inner, Job } from './inner.ts';

const root = join(import.meta.dirname, '..', '..');
const NIGHT = /^\d{4}-\d{2}-\d{2}$/;
const WIDTHS = [1440, 390];
/** An app's whole turn (its boot, then inner.ts's own limit on the pages), past which its room is killed. */
const APP_MS = 6 * 60_000;
/** Its own network namespace, so any port is free. */
const PORT = 7000;

/**
 * The room's namespaces. Its own processes too, so nothing an app started outlives it, except inside a container, which
 * may not mount its own /proc (a minion's hand run); there the process group is killed instead.
 */
const ROOM = (() => {
  const base = ['--map-current-user', '--keep-caps', '--net', '--mount'];
  const pids = ['--pid', '--fork', '--kill-child', '--mount-proc'];
  try {
    execFileSync('unshare', [...base, ...pids, 'true'], { stdio: 'ignore', timeout: 10_000 });
    return [...base, ...pids];
  } catch {
    return base;
  }
})();

/** The room that is open, stopped with this run. */
let openRoom = 0;
function killRoom() {
  try {
    if (openRoom) process.kill(-openRoom, 'SIGKILL');
  } catch {} // the group is gone already
}

/** One app's copy in the sandbox, its shots written to `out`. */
async function inSandbox(spec: AppSpec, out: string, pages: number): Promise<Inner> {
  const home = homedir();
  mkdirSync(out, { recursive: true });
  const job: Job = { app: spec.app, folder: join(spec.folder, spec.subdir ?? ''), port: PORT, widths: WIDTHS, pages, out };
  // What the room shows of the home: the app's checkout, this repo's code, the toolchain, the browser, and what the app's build
  // keeps in ~/.cache/<app> (a toolchain of its own). No data.
  const show = [realpathSync(spec.folder), root, ...['.local/share/mise', '.local/share/uv', '.local/bin', '.config/mise', '.cache/ms-playwright', join('.cache', spec.app)].map((p) => join(home, p))];
  // A deploy slot's link, made again in the room.
  if (spec.folder !== show[0]) show.push(spec.folder);
  // Nothing of the server's environment goes in: it holds secrets.
  const env = { HOME: home, USER: process.env.USER ?? '', LANG: 'C.UTF-8', TZ: 'America/Los_Angeles', PATH: `/usr/local/bin:/usr/bin:/bin:${dirname(process.execPath)}` };
  const args = [...ROOM, join(import.meta.dirname, 'sandbox.sh'), out, ...show, '--', process.execPath, join(import.meta.dirname, 'inner.ts'), JSON.stringify(job)];
  const said = await new Promise<string>((ok) => {
    const child = spawn('unshare', args, { env, cwd: '/', detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    for (const s of [child.stdout, child.stderr]) s.on('data', (d) => (text = (text + d).slice(-1500)));
    openRoom = child.pid ?? 0;
    const late = setTimeout(() => ((text = `no answer in ${APP_MS / 60_000} min\n${text}`), killRoom()), APP_MS);
    child.on('error', (e) => (clearTimeout(late), ok(e.message)));
    // Its group too: where the room has no processes of its own, what the app started is in it.
    child.on('exit', (code, sig) => (clearTimeout(late), killRoom(), (openRoom = 0), ok(code ? text.trim() || `it ended with ${code}` : sig ? `killed (${sig})\n${text}` : '')));
  });
  rmSync(join(out, '.tmp'), { recursive: true, force: true });
  if (existsSync(join(out, 'inner.json'))) return JSON.parse(readFileSync(join(out, 'inner.json'), 'utf8'));
  throw new Error(said || 'the sandbox wrote no answer');
}

/** An app's nights before `day`, the newest first. */
function* earlier(outDir: string, day: string, app: string): Generator<[string, AppNight]> {
  const nights = existsSync(outDir) ? readdirSync(outDir).filter((d) => NIGHT.test(d) && d < day) : [];
  for (const d of nights.sort().reverse()) {
    const file = join(outDir, d, app, 'night.json');
    if (existsSync(file)) yield [d, JSON.parse(readFileSync(file, 'utf8'))];
  }
}

/** What changed since the night it is compared with. A night whose kit couldn't be read says nothing of it. */
const since = (was: AppNight, now: AppNight): Since => (was.kit && now.kit && was.kit !== now.kit ? 'kit' : was.head !== now.head ? 'ship' : null);

/** Sets each picture's change since the newest good one of its page, and the main pages gone since the newest night that started. */
export function compare(outDir: string, day: string, dir: string, a: AppNight) {
  const nights = [...earlier(outDir, day, a.app)];
  for (const s of a.shots) {
    if (!s.file) continue;
    for (const [d, was] of nights) {
      const old = was.shots.find((x) => x.page === s.page && x.width === s.width && x.file);
      // A broken picture is nothing to compare with: its fix would look like a change.
      if (!old?.file || problems({ ...was, once: [], gone: [], shots: [{ ...old, errors: [], moved: null }] }).length || !existsSync(join(outDir, d, a.app, old.file))) continue;
      s.was = join(d, a.app, old.file);
      s.moved = changed(readPng(readFileSync(join(outDir, s.was))), readPng(readFileSync(join(dir, s.file))));
      s.since = since(was, a);
      break;
    }
  }
  const last = nights.find(([, was]) => was.boot === null && was.found.length);
  if (!last || a.boot !== null) return;
  a.gone = last[1].found.filter((k) => !a.found.includes(k));
  a.goneSince = since(last[1], a);
}

/** The better of two tries: one that started, then the one with less wrong. What only one of them saw was a flake. */
export function agreed(tries: AppNight[]): AppNight {
  const [keep, other] = [...tries].sort((x, y) => Number(x.boot !== null) - Number(y.boot !== null) || problems(x).length - problems(y).length);
  const found = problems(keep).map((p) => p.key);
  if (!other && found.length) throw new Error('only one of its two tries could be made');
  const twice = new Set(other && problems(other).map((p) => p.key));
  keep.once = found.filter((k) => !twice.has(k));
  return keep;
}

/** How long a run waits in all for a busy box to calm down, and how often it looks. */
let patience = 30 * 60_000;
const LOOK_MS = 30_000;
/** More runnable than twice its cores: slow pages say nothing about the app. */
export const tooBusy = (load = loadavg()[0], cores = availableParallelism()) => load > cores * 2;

async function calm(): Promise<boolean> {
  for (; tooBusy() && patience > 0; patience -= LOOK_MS) await sleep(LOOK_MS);
  return !tooBusy();
}

async function shootApp(spec: AppSpec, outDir: string, day: string, pages: number, kit: string | null): Promise<AppNight> {
  const a: AppNight = { app: spec.app, title: spec.title, scheme: spec.scheme, head: null, kit, skipped: null, unshot: null, boot: null, once: [], shots: [], found: [], gone: [], goneSince: null, called: [] };
  if (!existsSync(join(spec.folder, spec.subdir ?? '', 'citadel-app.json'))) return { ...a, skipped: existsSync(spec.folder) ? "its deployed checkout has no citadel-app.json, so Citadel can't start a copy" : 'not deployed yet' };
  try {
    a.head = execFileSync('git', ['-C', spec.folder, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {} // not a git checkout: no commit to name
  const dir = join(outDir, day, spec.app);
  // Both tries are made in scratch folders and the better one becomes the night's, so a retry never leaves half of each.
  const work = mkdtempSync(join(outDir, `.${spec.app}-`));
  try {
    const tries: { out: string; night: AppNight }[] = [];
    for (const n of [1, 2]) {
      const out = join(work, String(n));
      try {
        const r = await inSandbox(spec, out, pages);
        const night = { ...a, ...r };
        compare(outDir, day, out, night);
        tries.push({ out, night });
      } catch (e) {
        // The run's own trouble, which the second try may not have.
        // One with findings the other couldn't check says nothing yet.
        if (n === 2) throw e;
        await calm();
        continue;
      }
      if (!problems(tries[tries.length - 1].night).length) break;
      if (!(await calm())) throw new Error(`the box was too busy to trust what was found (load ${Math.round(loadavg()[0])} on ${availableParallelism()} cores)`);
    }
    const kept = agreed(tries.map((t) => t.night));
    const keep = tries.find((t) => t.night === kept)!;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(keep.out, dir);
    rmSync(join(dir, 'inner.json'), { force: true });
    kept.called = problems(kept);
    writeFileSync(join(dir, 'night.json'), JSON.stringify(kept));
    return kept;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Citadel UI's files (the ones KIT_FILE serves to apps), as git names them. */
function kitFiles(): string | null {
  try {
    const tree = execFileSync('git', ['-C', root, 'ls-tree', '-r', 'HEAD', 'public/'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const served = tree.split('\n').filter((l) => /\tpublic\/style\.css$/.test(l) || KIT_FILE.test(l.replace(/^.*\tpublic\//, '/apps/_citadel/')));
    return served.length ? createHash('sha256').update(served.join('\n')).digest('hex').slice(0, 16) : null;
  } catch {
    return null;
  }
}

/** Keep the newest nights, and their whole size under the cap (the two newest always stay). */
export function prune(outDir: string, keep = 14, cap = 1024 ** 3) {
  const nights = readdirSync(outDir)
    .filter((d) => NIGHT.test(d))
    .sort()
    .reverse();
  let total = 0;
  for (const [i, d] of nights.entries()) {
    const dir = join(outDir, d);
    for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) if (f.isFile()) total += statSync(join(f.parentPath, f.name)).size;
    if (i >= keep || (i >= 2 && total > cap)) rmSync(dir, { recursive: true, force: true });
  }
  // A killed run's scratch folders.
  for (const d of readdirSync(outDir)) if (/^\.[a-z0-9-]+-\w{6}$/.test(d)) rmSync(join(outDir, d), { recursive: true, force: true });
}

if (import.meta.main) {
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) process.on(sig, () => (killRoom(), process.exit(1)));
  const argv = process.argv.slice(2);
  const opt = (n: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const out = opt('--out'),
    list = opt('--apps');
  if (!out || !list) throw new Error('--out and --apps are required');
  const outDir = resolve(out),
    day = opt('--day') ?? pacificDay(Date.now());
  const { apps, all }: Apps = JSON.parse(readFileSync(list, 'utf8'));
  mkdirSync(join(outDir, day), { recursive: true });
  const night: Night = { day, startedAt: Date.now(), endedAt: 0, kit: kitFiles(), apps: [] };
  for (const spec of apps) {
    const t = Date.now();
    const a = await shootApp(spec, outDir, day, Number(opt('--pages') ?? 10), night.kit).catch(
      (e): AppNight => ({ app: spec.app, title: spec.title, scheme: spec.scheme, head: null, kit: night.kit, skipped: null, unshot: String(e.message).slice(-600), boot: null, once: [], shots: [], found: [], gone: [], goneSince: null, called: [] }),
    );
    night.apps.push(a);
    console.log(`${spec.app}: ${a.skipped ?? a.unshot ?? a.boot ?? `${a.shots.length} shots`}, ${problems(a).length} problems, ${Math.round((Date.now() - t) / 1000)} s`);
  }
  night.endedAt = Date.now();
  prune(outDir);
  // A page that can't be written never loses the night.
  try {
    writePages(outDir, night, apps, all);
  } catch (e) {
    console.error('writing the pages failed:', e);
  }
  // Whole or not at all: the server reads it the moment it's there.
  writeFileSync(join(outDir, day, 'night.json.tmp'), JSON.stringify(night));
  renameSync(join(outDir, day, 'night.json.tmp'), join(outDir, day, 'night.json'));
}
