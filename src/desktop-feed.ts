// Desktop apps' update feeds (#1148; Josh, 2026-11-19: "A small launcher exe", "SHA-256 in the feed", "Auto from CI, plus
// by hand"). A scheme's Windows app ships as a zip of its build; Citadel keeps the newest few under the scheme's folder,
// <DATA_DIR>/projects/<id>/desktop/<app>/, and serves feed.json, the zips, the launcher (kit/desktop-launcher) and a
// first-install zip on open routes (src/routes/desktop.ts), so the launcher on a PC needs no login. The launcher installs
// whatever build feed.json names when it isn't the one it runs and never failed there: a roll back is the feed naming an
// older build. Numbers are Citadel's own, one past the newest it has published.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { promisify } from 'node:util';
import type { LauncherBuild } from './desktop-launcher.ts';
import { projectDir } from './workspace.ts';

const run = promisify(execFile);

/** An app's name in URLs and on the PC (its install folder and launcher, <app>.exe). */
export const DESKTOP_APP = /^[a-z][a-z0-9-]{0,39}$/;
/** How the launcher knows a new build started: it writes the file CITADEL_STARTED_FILE names, or it is still running after 30 s. */
export const STARTED = ['file', 'alive'] as const;
export type Started = (typeof STARTED)[number];
/** Builds kept besides the current one's: older ones go. */
export const KEEP = 3;
/** The biggest build accepted. */
export const MAX_BUILD = 2 * 1024 ** 3;

export interface DesktopBuild {
  build: number;
  /** The exe the launcher starts, relative to the build's folder ("TestApp.exe", "bin/App.exe"). */
  exe: string;
  started: Started;
  /** Its zip's name in the app's folder: <app>-<build>.zip. */
  zip: string;
  sha256: string;
  size: number;
  /** What the scheme calls it ("1.4.2"), and the commit it was built from, when known. */
  version?: string;
  commit?: string;
  /** Where it came from: "ci:<run id>" or "file:<name>"; a CI run is published once. */
  source?: string;
  /** Who published it: a minion "#N", a person's login, or "ci". */
  by?: string;
  at: number;
}

/** An app's feed.json on disk: the build people get and the builds kept. */
export interface DesktopIndex {
  app: string;
  /** Its name on the PC (window titles, the launcher's messages). */
  title?: string;
  current: number;
  /** Newest first. */
  builds: DesktopBuild[];
}

export interface PublishAsk {
  projectId: number;
  app: string;
  /** A .zip, .tar.gz or .tgz of the build, or the .exe alone. */
  file: string;
  /** The exe to start inside it; found when the build's top folder has exactly one. */
  exe?: string;
  started?: Started;
  title?: string;
  version?: string;
  commit?: string;
  source?: string;
  by?: string;
}

export interface Published {
  build: DesktopBuild;
  /** That source was already published: nothing new was made, and the feed now names that build. */
  already?: boolean;
  /** The feed's and the first-install zip's paths on Citadel's address. */
  feed: string;
  install: string;
}

/** A refusal people can act on (the route's 400). */
export class DesktopError extends Error {}

export function desktopPaths(projectId: number, app: string) {
  const base = `/api/desktop/${projectId}/${app}`;
  return { feed: `${base}/feed.json`, install: `${base}/install.zip` };
}

export class DesktopFeeds {
  private dataDir: string;
  /** One publish or install zip at a time per app. */
  private queues = new Map<string, Promise<unknown>>();
  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  dir(projectId: number, app: string): string {
    if (!DESKTOP_APP.test(app)) throw new DesktopError(`An app's name is lower case letters, digits and dashes, starting with a letter: not "${app}"`);
    return join(projectDir(this.dataDir, projectId), 'desktop', app);
  }

  async index(projectId: number, app: string): Promise<DesktopIndex | null> {
    try {
      const x = JSON.parse(await readFile(join(this.dir(projectId, app), 'feed.json'), 'utf8')) as DesktopIndex;
      return x && Number.isInteger(x.current) && Array.isArray(x.builds) ? x : null;
    } catch {
      return null;
    }
  }

  /** A scheme's apps that have a build. */
  async apps(projectId: number): Promise<DesktopIndex[]> {
    const names = await readdir(join(projectDir(this.dataDir, projectId), 'desktop')).catch(() => [] as string[]);
    const out = await Promise.all(names.filter((n) => DESKTOP_APP.test(n)).map((n) => this.index(projectId, n)));
    return out.filter((x): x is DesktopIndex => !!x);
  }

  /** What the launcher reads: the current build, and the newest launcher when there is one. */
  static feed(index: DesktopIndex, launcher: LauncherBuild | null) {
    const b = index.builds.find((x) => x.build === index.current);
    if (!b) return null;
    return {
      app: index.app, ...(index.title ? { title: index.title } : {}), build: b.build, exe: b.exe, started: b.started, zip: b.zip, sha256: b.sha256, size: b.size,
      ...(b.version ? { version: b.version } : {}), ...(b.commit ? { commit: b.commit } : {}), at: b.at,
      ...(launcher ? { launcher: { version: launcher.version, file: 'launcher.exe', sha256: launcher.sha256, size: launcher.size } } : {}),
    };
  }

  /** A kept build's zip, by its name; null for any other name. */
  async zip(projectId: number, app: string, name: string): Promise<string | null> {
    const index = await this.index(projectId, app);
    const b = index?.builds.find((x) => x.zip === name);
    return b ? join(this.dir(projectId, app), b.zip) : null;
  }

  publish(ask: PublishAsk): Promise<Published> {
    return this.queued(`${ask.projectId}/${ask.app}`, () => this.publishNow(ask));
  }

  private async publishNow(ask: PublishAsk): Promise<Published> {
    const dir = this.dir(ask.projectId, ask.app);
    const started = ask.started ?? 'file';
    if (!(STARTED as readonly string[]).includes(started)) throw new DesktopError(`started is one of ${STARTED.join(', ')}`);
    if (ask.exe !== undefined && !exeName(ask.exe)) throw new DesktopError(`exe is a path to an .exe inside the build, like "App.exe" or "bin/App.exe": not "${ask.exe}"`);
    await mkdir(dir, { recursive: true });
    const index: DesktopIndex = (await this.index(ask.projectId, ask.app)) ?? { app: ask.app, current: 0, builds: [] };
    if (ask.title?.trim()) index.title = ask.title.trim().slice(0, 80);
    const paths = desktopPaths(ask.projectId, ask.app);
    // A CI run (or a roll back to one) that is already here: the feed names it again, no new number.
    const seen = ask.source ? index.builds.find((b) => b.source === ask.source) : undefined;
    if (seen) {
      if (index.current !== seen.build) await writeIndex(dir, { ...index, current: seen.build });
      return { build: seen, already: true, ...paths };
    }
    const st = await stat(ask.file).catch(() => null);
    if (!st?.isFile()) throw new DesktopError(`No file at ${ask.file}`);
    if (st.size > MAX_BUILD) throw new DesktopError(`The build is ${st.size} bytes; the most is ${MAX_BUILD}`);
    const tmp = await mkdtemp(join(dir, '.in-'));
    try {
      const root = await unpack(ask.file, join(tmp, 'x'));
      const exe = ask.exe ?? (await onlyExe(root));
      const exeAt = await lstat(join(root, ...exe.split('/'))).catch(() => null);
      if (!exeAt?.isFile()) throw new DesktopError(`The build has no ${exe}: give exe, its path inside the build`);
      const build = Math.max(0, ...index.builds.map((b) => b.build)) + 1;
      const zip = `${ask.app}-${build}.zip`;
      await zipFolder(root, join(tmp, zip));
      const { sha256, size } = await digest(join(tmp, zip));
      await rename(join(tmp, zip), join(dir, zip));
      const entry: DesktopBuild = {
        build, exe, started, zip, sha256, size, at: Date.now(),
        ...(ask.version ? { version: String(ask.version).slice(0, 40) } : {}), ...(ask.commit ? { commit: String(ask.commit).slice(0, 40) } : {}),
        ...(ask.source ? { source: ask.source } : { source: `file:${basename(ask.file)}` }), ...(ask.by ? { by: ask.by } : {}),
      };
      const builds = [entry, ...index.builds];
      const kept = builds.slice(0, KEEP);
      await writeIndex(dir, { ...index, current: build, builds: kept });
      for (const b of builds.slice(KEEP)) await rm(join(dir, b.zip), { force: true });
      return { build: entry, ...paths };
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  /**
   * The first-install zip: an <app>/ folder with the launcher as <app>.exe, launcher.json pointing at `feedUrl`, and
   * the current build already unpacked, so the first start needs no download. Made once per build, feed and launcher.
   */
  install(projectId: number, app: string, feedUrl: string, launcher: LauncherBuild): Promise<string | null> {
    return this.queued(`${projectId}/${app}`, async () => {
      const dir = this.dir(projectId, app);
      const index = await this.index(projectId, app);
      const b = index?.builds.find((x) => x.build === index.current);
      if (!index || !b) return null;
      const key = createHash('sha256').update(`${b.build} ${b.sha256} ${feedUrl} ${launcher.sha256}`).digest('hex').slice(0, 16);
      const name = `install-${key}.zip`;
      const out = join(dir, name);
      if (await stat(out).then(() => true, () => false)) return out;
      const tmp = await mkdtemp(join(dir, '.install-'));
      try {
        const top = join(tmp, app);
        await mkdir(join(top, 'versions'), { recursive: true });
        await copyFile(launcher.path, join(top, `${app}.exe`));
        await writeFile(join(top, 'launcher.json'), JSON.stringify({ app, feed: feedUrl, ...(index.title ? { title: index.title } : {}) }, null, 2));
        await writeFile(join(top, 'state.json'), JSON.stringify({ current: { id: b.build, exe: b.exe, started: b.started }, failed: [] }, null, 2));
        await unzip(join(dir, b.zip), join(top, 'versions', String(b.build)));
        await zipFolder(tmp, join(tmp, name));
        for (const old of await readdir(dir)) if (/^install-[0-9a-f]+\.zip$/.test(old)) await rm(join(dir, old), { force: true });
        await rename(join(tmp, name), out);
        return out;
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    });
  }

  private queued<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(fn, fn);
    this.queues.set(key, next.catch(() => {}));
    return next;
  }
}

/** A relative path to an .exe with no way out of its folder. */
function exeName(exe: unknown): exe is string {
  return typeof exe === 'string' && /\.exe$/i.test(exe) && !exe.startsWith('/') && !exe.includes('\\') && !exe.includes('\0') && exe.split('/').every((s) => s && s !== '.' && s !== '..');
}

/** Unpack a build into `into`; the folder that holds it (a lone top folder is stripped). Refuses links and odd files. */
async function unpack(file: string, into: string): Promise<string> {
  await mkdir(into, { recursive: true });
  const name = basename(file).toLowerCase();
  try {
    if (name.endsWith('.zip')) await unzip(file, into);
    else if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) await run('tar', ['-xzf', file, '-C', into, '--no-same-owner', '--no-same-permissions'], { maxBuffer: 1 << 20 });
    else if (name.endsWith('.exe')) await copyFile(file, join(into, basename(file)));
    else throw new DesktopError('A build is a .zip, .tar.gz or .tgz of its folder, or the .exe alone');
  } catch (err) {
    if (err instanceof DesktopError) throw err;
    throw new DesktopError(`Couldn't unpack ${basename(file)}: ${String((err as { stderr?: string }).stderr || (err as Error).message).trim().slice(0, 300)}`);
  }
  let count = 0;
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (!e.isFile()) throw new DesktopError(`The build holds a link or special file (${relative(into, p)}): only plain files and folders`);
      else count++;
    }
  };
  await walk(into);
  if (!count) throw new DesktopError('The build is empty');
  const top = await readdir(into, { withFileTypes: true });
  return top.length === 1 && top[0].isDirectory() ? join(into, top[0].name) : into;
}

/** The one .exe at the top of a build. */
async function onlyExe(root: string): Promise<string> {
  const exes = (await readdir(root)).filter((n) => /\.exe$/i.test(n));
  if (exes.length === 1) return exes[0];
  throw new DesktopError(exes.length ? `The build has ${exes.length} .exe files at its top (${exes.join(', ')}): give exe, the one to start` : 'The build has no .exe at its top: give exe, its path inside the build');
}

// Python's zipfile, which every Linux box has (zip and unzip often aren't), and which drops "../" and absolute names on
// extracting and writes no links.
const zipfile = (args: string[], cwd?: string) => run('python3', ['-I', '-m', 'zipfile', ...args], { cwd, maxBuffer: 1 << 20, timeout: 10 * 60_000 });
const unzip = (file: string, into: string) => zipfile(['-e', file, into]);

/** Zip a folder's contents (not the folder itself). */
async function zipFolder(folder: string, out: string) {
  const items = (await readdir(folder)).filter((n) => join(folder, n) !== out);
  await zipfile(['-c', out, ...items], folder);
}

async function digest(file: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return { sha256: h.digest('hex'), size: (await stat(file)).size };
}

async function writeIndex(dir: string, index: DesktopIndex) {
  const tmp = join(dir, `.feed-${process.pid}-${Date.now()}.json`);
  await writeFile(tmp, JSON.stringify(index, null, 2));
  await rename(tmp, join(dir, 'feed.json'));
}

/** A ci target's desktop app, from citadel-app.json's `targets` (`"desktop": { "app": "peek", "exe": "Peek.exe" }`). */
export interface DesktopTarget {
  app: string;
  exe?: string;
  started?: Started;
  title?: string;
}

export interface CiPublishDeps {
  feeds: DesktopFeeds;
  /** The run's release build in the CI store, as a path on this server; null until it is there. */
  file: (projectId: number, run: number) => Promise<string | null>;
  /** News for the scheme's Taskmaster. */
  tell: (projectId: number, text: string) => void;
  log?: (msg: string) => void;
}

/**
 * Publishes the build a ci target with a desktop app has out (Josh, 2026-11-19: "Auto from CI, plus by hand"): its newest
 * released run, or the run a roll back pins. Each run once per server start (a restart finds it already published).
 */
export function ciPublisher(d: CiPublishDeps) {
  const tried = new Set<string>();
  const busy = new Set<string>();
  return (t: { projectId: number; name: string; desktop: DesktopTarget }, run: { id: number; sha: string }) => {
    const key = `${t.projectId}/${t.desktop.app}/${run.id}`;
    if (tried.has(key) || busy.has(key)) return;
    busy.add(key);
    return (async () => {
      const file = await d.file(t.projectId, run.id);
      if (!file) return;
      tried.add(key);
      try {
        const out = await d.feeds.publish({ projectId: t.projectId, app: t.desktop.app, file, exe: t.desktop.exe, started: t.desktop.started, title: t.desktop.title ?? t.name, commit: run.sha, source: `ci:${run.id}`, by: 'ci' });
        if (!out.already) d.tell(t.projectId, `${t.name}: published desktop build ${out.build.build} of ${t.desktop.app} from CI run ${run.id} (${run.sha.slice(0, 9)}). PCs pick it up on their next start; a first install is at ${out.install}.`);
      } catch (err) {
        d.log?.(`desktop: publishing ${key} failed: ${(err as Error).message}`);
        d.tell(t.projectId, `${t.name}: couldn't publish CI run ${run.id}'s build to the ${t.desktop.app} desktop feed: ${(err as Error).message}. PCs keep the build they have. Fix the build or citadel-app.json's desktop settings; the next green run tries again, or publish_desktop publishes a build by hand.`);
      }
    })().finally(() => busy.delete(key));
  };
}

/** A target override's `desktop`, kept when well formed. */
export function desktopTargetOf(x: unknown): DesktopTarget | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.app !== 'string' || !DESKTOP_APP.test(o.app)) return null;
  return {
    app: o.app, ...(exeName(o.exe) ? { exe: o.exe } : {}), ...((STARTED as readonly unknown[]).includes(o.started) ? { started: o.started as Started } : {}),
    ...(typeof o.title === 'string' && o.title.trim() ? { title: o.title.trim().slice(0, 80) } : {}),
  };
}
