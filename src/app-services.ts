// Contraptions' own services (#266): Citadel writes each one's systemd user unit itself, from its registry
// row and the citadel-app.json manifest in its folder, and starts, stops and restarts it. Sessions can't
// (the tripwire keeps them out of the unit folder and off `systemctl enable`); this server does, but only
// for units it names and owns:
//   - citadel-app-<name>.service, the app itself;
//   - citadel-app-<name>-<job>.service and .timer, one pair per timer the manifest names.
// Every file it writes starts with OWNED, naming the contraption, and it only ever rewrites or removes
// files that do. Units an app's people installed by hand before (same port, or run from its folder) are
// reported, and stopped and disabled only when an admin asks with replace: their files stay.
// A boot check, a preview or a dev copy without a stand-in systemctl gets `off`: it never touches systemd.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { execResult, runLogged } from './exec.ts';
import { closeSync, existsSync, openSync, readdirSync } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, stat, statfs, symlink, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { constants as osConstants, homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { ContraptionRow } from './db.ts';
import type { GithubEnv } from './scheme-repo.ts';
import { installCheck } from './pwa-check.ts';
import { listSnapshots, restoreSnapshot, snapshotsDir, takeSnapshot, type Snapshot } from './app-snapshots.ts';

/** The manifest's file name, in the app's folder. */
export const MANIFEST = 'citadel-app.json';

/** What an app says about running itself, in MANIFEST. */
export interface Manifest {
  /** The command that runs it: its program (an absolute path, or a name systemd finds, like node) and arguments. */
  start: string[];
  /** Where it runs, relative to the app's folder; default the folder. */
  workdir: string;
  /** Extra environment; a value starting with ~/ is under the home folder. */
  env: Record<string, string>;
  /** Jobs on a schedule: a systemd OnCalendar and a command, run with the app's environment. */
  timers: Record<string, { command: string[]; on_calendar: string; workdir: string }>;
  /** A path that answers 2xx once it is up, like /health; without one, an open port counts. */
  health: string | null;
  /** Shell commands a deploy runs in the folder, in order, niced; any failing fails the deploy. */
  build: string[];
  /** Minutes the whole build may take (default 20, at most 60). */
  build_timeout: number;
  /** Settings warns when DATA_DIR grows past this many GB (#847); null: no warning. */
  disk_warn_gb: number | null;
  /** Paths in its repo whose change means the data moved on (#1016): a roll back past one is refused. */
  migrations: string[];
  /**
   * 'write' lets its frame in Citadel use navigator.clipboard.writeText (#1086); null: it can't, and a Copy button copies
   * the old way inside its click (Citadel UI's copyText falls back to that by itself). For an app whose own Copy buttons call
   * navigator.clipboard; nothing grants clipboard reads.
   */
  clipboard: 'write' | null;
}

/** An app's DATA_DIR size, from the last background measure (#847). */
export interface DiskUse { data_bytes: number | null; measured_at: string; warn_gb: number | null }

/** The environment Citadel sets on every app's units; a manifest can't. */
export const CITADEL_ENV = ['PORT', 'DATA_DIR', 'CITADEL_KEYS', 'CITADEL_URL', 'BASE_PATH', 'PATH', 'CITADEL_HEAVY'];
const JOB = /^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$/;
const MAX_TIMERS = 5;

const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
/** A path inside the app's folder: relative, no `..`, no odd characters. */
const relDir = (v: unknown, what: string): string => {
  if (v === undefined || v === '' || v === '.') return '.';
  if (typeof v !== 'string' || !/^[\w.+-]+(?:\/[\w.+-]+)*\/?$/.test(v) || v.split('/').includes('..')) throw new Error(`${what} must be a folder inside the app's, like companion`);
  return v.replace(/\/$/, '');
};
function command(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.length || v.length > 50 || !v.every((a) => isText(a, 1000))) throw new Error(`${what} must be a list of 1 to 50 words, like ["/usr/bin/node", "server.ts"]`);
  if (!/^(?:\/[\w.+@-]+)+$|^[\w.+@-]+$/.test(v[0])) throw new Error(`${what} must start with an absolute path or a program name, like /usr/bin/node or node`);
  return v;
}

/** Check a manifest's text; an Error says what is wrong in words for whoever writes it. */
export function parseManifest(text: string): Manifest {
  let m: any;
  try {
    m = JSON.parse(text);
  } catch (err: any) {
    throw new Error(`${MANIFEST} isn't JSON: ${err.message}`);
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error(`${MANIFEST} must be an object`);
  const env: Record<string, string> = {};
  if (m.env !== undefined) {
    if (!m.env || typeof m.env !== 'object' || Array.isArray(m.env)) throw new Error('env must be an object of NAME: "value"');
    for (const [k, v] of Object.entries(m.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw new Error(`env name ${JSON.stringify(k)} isn't a variable name`);
      if (CITADEL_ENV.includes(k)) throw new Error(`env can't set ${k}: Citadel sets ${CITADEL_ENV.join(', ')}`);
      if (typeof v !== 'string' || v.length > 1000 || /[\x00-\x1f\x7f]/.test(v)) throw new Error(`env ${k} must be one line of text`);
      env[k] = v;
    }
  }
  const timers: Manifest['timers'] = {};
  if (m.timers !== undefined) {
    if (!m.timers || typeof m.timers !== 'object' || Array.isArray(m.timers) || Object.keys(m.timers).length > MAX_TIMERS) throw new Error(`timers must be an object of at most ${MAX_TIMERS} named jobs`);
    for (const [job, t] of Object.entries<any>(m.timers)) {
      if (!JOB.test(job)) throw new Error(`timer name ${JSON.stringify(job)} must be a short slug, like backup`);
      if (!t || typeof t !== 'object') throw new Error(`timer ${job} must be an object with command and on_calendar`);
      if (!isText(t.on_calendar, 100)) throw new Error(`timer ${job} needs on_calendar, a systemd calendar time like "*-*-* 03:30:00" or daily`);
      timers[job] = { command: command(t.command, `timer ${job}'s command`), on_calendar: t.on_calendar, workdir: relDir(t.workdir, `timer ${job}'s workdir`) };
    }
  }
  if (m.health !== undefined && m.health !== null && !(typeof m.health === 'string' && /^\/[\x21-\x7e]{0,199}$/.test(m.health))) throw new Error('health must be a path starting with /, like /health');
  if (m.build !== undefined && (!Array.isArray(m.build) || m.build.length > 20 || !m.build.every((b: unknown) => isText(b, 2000)))) throw new Error('build must be a list of at most 20 shell commands, like ["npm ci", "npm run build"]');
  if (m.build_timeout !== undefined && !(Number.isInteger(m.build_timeout) && m.build_timeout >= 1 && m.build_timeout <= 60)) throw new Error('build_timeout must be whole minutes from 1 to 60');
  if (m.disk_warn_gb !== undefined && !(typeof m.disk_warn_gb === 'number' && m.disk_warn_gb > 0 && m.disk_warn_gb <= 1e6)) throw new Error('disk_warn_gb must be a number of GB above 0');
  if (m.migrations !== undefined && (!Array.isArray(m.migrations) || m.migrations.length > 20)) throw new Error('migrations must be a list of at most 20 paths in the repo, like ["src/migrations", "src/schema.ts"]');
  const migrations = (m.migrations ?? []).map((v: unknown) => relDir(v, 'each of migrations'));
  if (m.clipboard !== undefined && m.clipboard !== null && m.clipboard !== 'write') throw new Error('clipboard must be "write" (its Copy buttons call navigator.clipboard), or left out');
  return { start: command(m.start, 'start'), workdir: relDir(m.workdir, 'workdir'), env, timers, health: m.health ?? null, build: m.build ?? [], build_timeout: m.build_timeout ?? 20, disk_warn_gb: m.disk_warn_gb ?? null, migrations, clipboard: m.clipboard ?? null };
}

/** The first line of every unit file Citadel writes; it touches no other. */
const OWNED = (name: string) => `# Written by Citadel for contraption ${name}.`;
const ownedBy = (text: string) => /^# Written by Citadel for contraption ([a-z0-9-]+)\./.exec(text)?.[1] ?? null;

/** A value in a unit file: systemd's quoting, and % doubled so it is never a specifier. */
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
/** An ExecStart line: the program bare (it is checked), each argument quoted; ${VAR} still expands from the unit's environment. */
const execLine = (argv: string[], home: string) => [argv[0], ...argv.slice(1).map((a) => quote(tilde(a, home)))].join(' ');
const tilde = (s: string, home: string) => (s.startsWith('~/') ? join(home, s.slice(2)) : s);
/** A contraption's folder: where its repo is checked out; default ~/apps/<name>. */
export const appFolder = (row: Pick<ContraptionRow, 'name' | 'folder'>, home: string) => (row.folder ? tilde(row.folder, home) : join(home, 'apps', row.name));
/** Where the app itself is in a checkout of its repo: its subdir (#1136, an app in a folder of a scheme's repo), else the root. */
export const appRoot = (row: { subdir?: string | null }, checkout: string) => (row.subdir ? join(checkout, row.subdir) : checkout);
/** A repo path of the app's, from one relative to its own folder (its manifest's migrations, say). */
export const repoPath = (row: { subdir?: string | null }, rel: string) => (row.subdir ? `${row.subdir.replace(/\/$/, '')}/${rel}` : rel);
/**
 * For an app in a folder of its scheme's repo (#1136): whether a build of `deployed` holds all of the app's at `landed`,
 * nothing in its folder differing, so a ship that didn't touch the folder doesn't redeploy it. Read in the scheme's
 * clone, which has both commits.
 */
export async function folderHolds(repoDir: string, subdir: string, landed: string, deployed: string): Promise<boolean> {
  return (await execResult('git', ['diff', '--quiet', deployed, landed, '--', subdir], { cwd: repoDir, timeout: 30_000 })).code === 0;
}
/** Whether its manifest is on `ref` yet: make_app registers an app before its first ship puts the folder on main. Sync: the land's apps list is. */
export function manifestOn(repoDir: string, subdir: string, ref = 'main'): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${repoPath({ subdir }, MANIFEST)}`], { cwd: repoDir, stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}
/** Where a deploy keeps an app's two builds (#801), `.<folder's name>/a` and `/b` beside it; the folder links to the live one. */
export const slotsOf = (folder: string) => join(dirname(folder), `.${basename(folder)}`);

export interface UnitInputs {
  row: Pick<ContraptionRow, 'name' | 'title' | 'port'>;
  manifest: Manifest;
  /** The app's folder, absolute. */
  folder: string;
  keysDir: string;
  citadelUrl: string;
  home: string;
}

/** Toolchains mise installs, then the usual: a user unit's PATH has neither ~/.local/bin nor mise's shims. */
const toolPath = (home: string) => `${join(home, '.local/share/mise/shims')}:${join(home, '.local/bin')}:/usr/local/bin:/usr/bin:/bin`;

const TOOLS = join(import.meta.dirname, '..', 'tools');

/** The unit name for a contraption, or one of its jobs. */
export const unitName = (name: string, job?: string) => `citadel-app-${name}${job ? `-${job}` : ''}`;

/** Every unit file for an app, by file name. Pure: the tests check it as text. */
export function unitFiles({ row, manifest, folder, keysDir, citadelUrl, home }: UnitInputs): Map<string, string> {
  const own = Object.fromEntries(Object.entries(manifest.env).map(([k, v]) => [k, tilde(v, home)]));
  const env = {
    PATH: toolPath(home),
    ...own,
    PORT: String(row.port),
    DATA_DIR: join(home, '.local/share', row.name),
    CITADEL_KEYS: keysDir,
    CITADEL_URL: citadelUrl,
    BASE_PATH: `/apps/${row.name}`,
    // An app runs a heavy step as `"$CITADEL_HEAVY" <command>`: a capped hold in a shared slot (#847).
    CITADEL_HEAVY: join(TOOLS, 'citadel-app-heavy'),
    // The build trusts the app's .mise.toml, so its units do too; an app's own trusted paths are kept after it.
    MISE_TRUSTED_CONFIG_PATHS: [folder, own.MISE_TRUSTED_CONFIG_PATHS].filter(Boolean).join(':'),
  };
  // systemd finds a bare program name on its own path, not the unit's PATH: point it at the build's, so `node` is mise's shim.
  const search = `ExecSearchPath=${toolPath(home).replace(/%/g, '%%')}`;
  const envLines = Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`);
  // WorkingDirectory takes the rest of the line as the path, unquoted.
  const dir = (rel: string) => `WorkingDirectory=${(rel === '.' ? folder : join(folder, rel)).replace(/%/g, '%%')}`;
  const head = [OWNED(row.name), `# Citadel rewrites it on install and deploy: change the app's ${MANIFEST} or its entry in Settings → Contraptions, not this file.`];
  const files = new Map<string, string>();
  files.set(`${unitName(row.name)}.service`, [
    ...head,
    '[Unit]', `Description=${row.title.replace(/[%\\]/g, '')} (Citadel contraption)`, 'After=network.target', 'StartLimitIntervalSec=0', '',
    '[Service]', dir(manifest.workdir), `ExecStart=${execLine(manifest.start, home)}`, search, ...envLines, 'Restart=always', 'RestartSec=5', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n'));
  for (const [job, t] of Object.entries(manifest.timers)) {
    files.set(`${unitName(row.name, job)}.service`, [
      ...head,
      '[Unit]', `Description=${row.title.replace(/[%\\]/g, '')}: ${job} (Citadel contraption job)`, '',
      '[Service]', 'Type=oneshot', dir(t.workdir), `ExecStart=${execLine(t.command, home)}`, search, ...envLines, '',
    ].join('\n'));
    files.set(`${unitName(row.name, job)}.timer`, [
      ...head,
      '[Unit]', `Description=${row.title.replace(/[%\\]/g, '')}: ${job} timer`, '',
      '[Timer]', `OnCalendar=${t.on_calendar.replace(/%/g, '%%')}`, 'Persistent=true', '',
      '[Install]', 'WantedBy=timers.target', '',
    ].join('\n'));
  }
  return files;
}

/** One unit as systemctl show tells it. */
export interface UnitState {
  unit: string;
  /** loaded, not-found, … */
  load: string;
  /** active, inactive, failed, activating, … */
  active: string;
  sub: string;
  /** enabled, disabled, or '' when there is no file. */
  enabled: string;
}

/** A timer job's last run (AppServices.timerRuns). */
export interface TimerRun {
  app: ContraptionRow;
  job: string;
  /** Its service, citadel-app-<name>-<job>.service. */
  unit: string;
  /** failed after a run that failed, inactive after one that worked or none, activating while it runs. */
  active: string;
  /** systemd's Result: success, exit-code, signal, timeout, … */
  result: string;
  /** The exit status of its command. */
  status: string;
  exitAt: number | null;
}

/** A unit someone installed by hand for this app before Citadel did. */
export interface HandUnit extends UnitState {
  path: string;
  /** What gave it away: its port or its folder. */
  why: string;
}

export interface ServiceStatus {
  unit: string;
  folder: string;
  /** Null when the manifest reads fine. */
  manifestError: string | null;
  health: string | null;
  installed: boolean;
  service: UnitState;
  timers: UnitState[];
  hand: HandUnit[];
}

/** A deploy as the tools and Settings show it. */
export interface DeployView {
  name: string;
  state: 'running' | 'deployed' | 'failed' | 'rolled back';
  /** Who asked: a person's name, or #N of a minion. */
  by: string;
  repo: string;
  branch: string;
  /** The commit it ran before, and the one it went to (null until known). */
  from: string | null;
  to: string | null;
  started_at: number;
  finished_at: number | null;
  /** What it did, a line per step. */
  said: string[];
  /** What the app still lacks once deployed (#418): no rail icon, or a manifest that won't install. Also in said, as "To do: …". */
  todo: string[];
  /** Its whole log: git's and the build's output. */
  log: string;
  /** When each stage began (ms): build (fetch and build steps), drain (its turns), restart (and the health check). */
  stages: Record<string, number>;
}

/** What a deploy hands back to its caller once it's deployed (#418). */
export interface DeployHooks {
  /** Set the registry's icon, if it's still empty; true when it took. */
  setIcon?: (icon: string) => boolean;
  /** Record the manifest and icon files an installer may fetch with no login (#987). */
  setStatics?: (paths: string[]) => void;
  /** What the deployed app still lacks: no rail icon, or a web manifest that won't install. Empty when it was checked and lacks nothing. */
  todo?: (todo: string[]) => void;
  /** The install check couldn't run, even on a retry: one plain line for the home scheme, not a to-do list. */
  unchecked?: (line: string) => void;
  /** Whom the install check reads the page as: kept in the deploy's marker, for starting it again after a restart (#847). */
  uid?: number | null;
  /** It starts again a deploy a Citadel restart cut short: cut short again, it is left for a person. */
  resumed?: boolean;
  /** A roll back (#1016): deploy this older commit of its branch, not the branch's head. */
  to?: string;
}

/** A deploy cut short by a Citadel restart or crash, from its marker (#847). */
export interface Interrupted {
  name: string;
  by: string;
  uid: number | null;
  resumed: boolean;
  /** It was a roll back to this commit (#1016). */
  to?: string;
}

/** The user unit an app's build steps run in, one at a time (#847): not citadel-app-…, which a timer named build would be. */
export const buildUnit = (name: string) => `citadel-build-${name}.service`;
/** In the app's deploy log folder while a deploy runs: one left there at boot is a deploy a restart cut short. */
const DEPLOYING = 'deploying.json';
const SIGNALS: Record<number, string> = Object.fromEntries(Object.entries(osConstants.signals).map(([k, v]) => [v, k]));
/** The end of a failed step's output in the log, from byte `from`: the lines that say why, for the failure line. */
async function lastLines(log: string, from: number): Promise<string> {
  const f = await open(log, 'r').catch(() => null);
  if (!f) return '';
  try {
    const size = (await f.stat()).size;
    const start = Math.max(from, size - 8192);
    const buf = Buffer.alloc(size - start);
    await f.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-12);
    return lines.length ? `\nIts last lines:\n${lines.map((l) => `  ${l.slice(0, 300)}`).join('\n')}` : '\nIt printed nothing.';
  } finally {
    await f.close();
  }
}
/** A build step's status for people: 128+N is the signal that killed it (a shell's way of saying so). */
export const exitWhy = (code: number) => (code > 128 && SIGNALS[code - 128] ? `killed by ${SIGNALS[code - 128]}` : code === 75 ? 'no heavy slot came free, status 75' : `exit ${code}`);

export class ServiceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface Ran {
  code: number;
  out: string;
  err: string;
}

export interface ServiceOptions {
  /** Why this server must not touch systemd (a boot check, a preview, a dev copy), or null when it may. */
  off: string | null;
  /** The user unit folder: $XDG_CONFIG_HOME/systemd/user. */
  unitDir: string;
  systemctl: string;
  journalctl: string;
  home: string;
  keysDir: (name: string) => string;
  citadelUrl: () => string;
  /** Where deploys' logs go, a folder per app. */
  logDir: string;
  /** How long a started app has to answer its health check. */
  healthMs: number;
  /** How long after a deploy an install check that couldn't run is tried again (ms). */
  installRetryMs: number;
  /** A manifest's build_timeout minute, in ms (tests shorten it). */
  minuteMs: number;
  /** Where a repo is cloned from: GitHub, or CITADEL_GIT_BASE (tests). */
  gitUrl: (repo: string) => string;
  /**
   * systemd-run, which runs each build step in its own user unit (#847), out of Citadel's cgroup, so a Citadel restart
   * or crash doesn't kill an app's build; null (a dev copy with a stand-in systemctl) runs them as Citadel's children.
   */
  systemdRun: string | null;
  /** tools/citadel-heavy: a deploy build holds one host-wide heavy slot for all its steps (#847, #885). */
  heavy: string;
}

/** Citadel's tools folder, beside src/: the live checkout's on the live server. */

/** Defaults from the environment: CITADEL_SYSTEMCTL and CITADEL_JOURNALCTL stand in for the real ones (tests). */
export function serviceOptions(env: NodeJS.ProcessEnv, liveData: boolean, bootCheck: boolean, rest: Pick<ServiceOptions, 'keysDir' | 'citadelUrl' | 'logDir'>): ServiceOptions {
  const home = homedir();
  const stand = !!env.CITADEL_SYSTEMCTL && !!env.XDG_CONFIG_HOME;
  const off = bootCheck ? 'A boot check or a preview never touches app services.'
    : !liveData && !stand ? "Only the live Citadel manages app services: a dev copy needs CITADEL_SYSTEMCTL and XDG_CONFIG_HOME pointing somewhere else."
    : null;
  return {
    off,
    unitDir: join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user'),
    systemctl: env.CITADEL_SYSTEMCTL || 'systemctl',
    journalctl: env.CITADEL_JOURNALCTL || 'journalctl',
    home,
    healthMs: Number(env.CITADEL_HEALTH_MS) || 60_000,
    installRetryMs: Number(env.CITADEL_INSTALL_RETRY_MS) || 30_000,
    minuteMs: 60_000,
    gitUrl: (repo) => `${env.CITADEL_GIT_BASE || 'https://github.com'}/${repo}.git`,
    systemdRun: env.CITADEL_SYSTEMD_RUN || (stand ? null : 'systemd-run'),
    heavy: join(TOOLS, 'citadel-heavy'),
    ...rest,
  };
}

const run = (bin: string, args: string[], timeout = 60_000) => execResult(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }).then((r): Ran => ({ code: r.code, out: r.out, err: r.err || (r.fail && !r.out ? r.fail : '') }));

export class AppServices {
  readonly opts: ServiceOptions;
  /**
   * Before its service stops or restarts (#319): hold its new turns and wait for its running ones
   * (ContraptionTurns.drain). Set by server.ts; `release` lets the held turns start. `stop`: it isn't coming back.
   */
  drain: (row: ContraptionRow, stop?: boolean) => Promise<{ said: string | null; release: () => void }> = async () => ({ said: null, release: () => {} });
  /** A deploy reached a stage, or ended (finished_at set): the release monitor records and shows it (#627). */
  onDeploy: (view: DeployView) => void = () => {};
  /**
   * The GitHub login a deploy clones and fetches as (#915): its home scheme owner's link, as CI and releases read it
   * (server.ts githubOf), since a member's private repo lets the box's login in nowhere. Undefined: the box's login.
   */
  githubAs: (row: ContraptionRow) => GithubEnv = () => undefined;
  /** Set on SIGTERM: a deploy ending now was cut short by the restart, so its marker stays for the next server (#847). */
  stopping = false;

  /** Each app's DATA_DIR size, measured in the background, never on a request (#847). */
  private disk = new Map<string, DiskUse>();

  constructor(opts: ServiceOptions) {
    this.opts = opts;
  }

  /** The app's last measured DATA_DIR size and warning line, or null before the first measure. */
  diskUse(row: Pick<ContraptionRow, 'name'>): DiskUse | null {
    return this.disk.get(row.name) ?? null;
  }

  /** Free and total bytes on the disk the apps' data lives on: one statfs, cheap enough for a request. */
  async freeDisk(): Promise<{ free_bytes: number; total_bytes: number }> {
    const s = await statfs(join(this.opts.home, '.local/share'));
    return { free_bytes: s.bavail * s.bsize, total_bytes: s.blocks * s.bsize };
  }

  /** Measure every app's DATA_DIR one at a time, idle-priority, and keep the sizes and warning lines. */
  async measureDisk(rows: Pick<ContraptionRow, 'name' | 'folder'>[]): Promise<void> {
    for (const row of rows) {
      const warn_gb = (await this.manifest(row).catch(() => null))?.disk_warn_gb ?? null;
      // du exits 1 on a file it can't read but still prints the total: take the number whatever the status.
      const r = await run('nice', ['-n', '19', 'ionice', '-c', '3', 'du', '-sbx', this.dataDir(row)], 10 * 60_000);
      const bytes = Number(r.out.split('\t')[0]);
      this.disk.set(row.name, { data_bytes: r.out && Number.isFinite(bytes) ? bytes : null, measured_at: new Date().toISOString(), warn_gb });
    }
  }

  /** Measure 2 min after boot, then every 30 min after each round ends. */
  watchDisk(rows: () => Pick<ContraptionRow, 'name' | 'folder'>[]): void {
    const round = () => void this.measureDisk(rows()).catch((err) => console.warn(`Measuring the apps' disk use failed: ${err.message}`)).finally(() => setTimeout(round, 30 * 60_000).unref());
    setTimeout(round, 2 * 60_000).unref();
  }

  /** The app's DATA_DIR (#834): the only place a turn's images may come from. */
  dataDir(row: Pick<ContraptionRow, 'name'>): string {
    return join(this.opts.home, '.local/share', row.name);
  }

  /** The app's folder: where its repo is checked out; default ~/apps/<name>. */
  folder(row: Pick<ContraptionRow, 'name' | 'folder'>): string {
    return appFolder(row, this.opts.home);
  }

  unitOf(row: Pick<ContraptionRow, 'name'>): string {
    return `${unitName(row.name)}.service`;
  }

  private guard() {
    if (this.opts.off) throw new ServiceError(409, this.opts.off);
  }

  private async systemctl(...args: string[]): Promise<Ran> {
    return run(this.opts.systemctl, ['--user', ...args]);
  }

  private async must(...args: string[]) {
    const r = await this.systemctl(...args);
    if (r.code) throw new ServiceError(500, `systemctl ${args.join(' ')} failed: ${(r.err || r.out).trim().slice(0, 1000) || `exit ${r.code}`}`);
    return r;
  }

  /** The manifest in the app's folder, or an Error saying why not. */
  async manifest(row: Pick<ContraptionRow, 'name' | 'folder'> & { subdir?: string | null }, folder = this.folder(row)): Promise<Manifest> {
    let text: string;
    folder = appRoot(row, folder);
    try {
      text = await readFile(join(folder, MANIFEST), 'utf8');
    } catch {
      throw new ServiceError(409, `No ${MANIFEST} in ${folder}: the app's repo needs one to run as a service (its format: app-rail.md in the contraptions specs).`);
    }
    try {
      return parseManifest(text);
    } catch (err: any) {
      throw new ServiceError(409, err.message);
    }
  }

  private inputs(row: ContraptionRow, manifest: Manifest, folder: string): UnitInputs {
    return { row, manifest, folder: appRoot(row, folder), keysDir: this.opts.keysDir(row.name), citadelUrl: this.opts.citadelUrl(), home: this.opts.home };
  }

  /** The unit files this contraption owns now, by file name. */
  private async owned(name: string): Promise<string[]> {
    const files = await readdir(this.opts.unitDir).catch(() => [] as string[]);
    const mine: string[] = [];
    for (const f of files) {
      if (!f.startsWith(unitName(name)) || !/\.(service|timer)$/.test(f)) continue;
      const text = await readFile(join(this.opts.unitDir, f), 'utf8').catch(() => '');
      if (ownedBy(text) === name) mine.push(f);
    }
    return mine;
  }

  private async state(unit: string): Promise<UnitState> {
    const r = await this.systemctl('show', unit, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState');
    const v = Object.fromEntries(r.out.split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    return { unit, load: v.LoadState ?? 'unknown', active: v.ActiveState ?? 'unknown', sub: v.SubState ?? '', enabled: v.UnitFileState ?? '' };
  }

  /** Units in the unit folder that Citadel didn't write but run this app: the same port, or from its folder. */
  async handInstalled(row: Pick<ContraptionRow, 'name' | 'port' | 'folder'>): Promise<HandUnit[]> {
    const folder = this.folder(row);
    const files = await readdir(this.opts.unitDir).catch(() => [] as string[]);
    const found: HandUnit[] = [];
    for (const f of files.filter((x) => x.endsWith('.service')).sort()) {
      const text = await readFile(join(this.opts.unitDir, f), 'utf8').catch(() => '');
      if (!text || ownedBy(text) !== null) continue;
      const plain = text.replace(/%h/g, this.opts.home).replace(/^\s*#.*$/gm, '');
      const why = new RegExp(`\\bPORT=${row.port}\\b`).test(plain) ? `port ${row.port}`
        : plain.split('\n').some((l) => /^\s*(WorkingDirectory|ExecStart)\s*=/.test(l) && (l.includes(`${folder}/`) || new RegExp(`${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|"|$)`).test(l))) ? `runs from ${folder}`
        : null;
      if (!why) continue;
      const base = f.replace(/\.service$/, '');
      found.push({ ...(await this.state(f)), path: join(this.opts.unitDir, f), why });
      if (files.includes(`${base}.timer`)) found.push({ ...(await this.state(`${base}.timer`)), path: join(this.opts.unitDir, `${base}.timer`), why: `starts ${f}` });
    }
    return found;
  }

  async status(row: ContraptionRow): Promise<ServiceStatus> {
    this.guard();
    const folder = this.folder(row);
    let manifestError: string | null = null;
    let health: string | null = null;
    try {
      health = (await this.manifest(row, folder)).health;
    } catch (err: any) {
      manifestError = err.message;
    }
    const owned = await this.owned(row.name);
    const timers = await Promise.all(owned.filter((f) => f.endsWith('.timer')).sort().map((f) => this.state(f)));
    return {
      unit: `${unitName(row.name)}.service`, folder, manifestError, health,
      installed: owned.includes(`${unitName(row.name)}.service`),
      service: await this.state(`${unitName(row.name)}.service`), timers, hand: await this.handInstalled(row),
    };
  }

  /**
   * Write the app's units from its manifest, drop ones it no longer names, reload, enable and (re)start
   * them. A hand-installed unit for it that is running or enabled stops this unless `replace`, which
   * stops and disables it first (its file stays).
   */
  async install(row: ContraptionRow, opts: { replace?: boolean; all?: ContraptionRow[] } = {}): Promise<string[]> {
    this.guard();
    return this.alone(row.name, () => this.installNow(row, opts));
  }

  private busy = new Set<string>();
  /** One install (or deploy) per app at a time: a second is refused rather than racing the first's files. */
  private async alone<T>(name: string, work: () => Promise<T>): Promise<T> {
    if (this.busy.has(name)) throw new ServiceError(409, `${name} is being installed or deployed already: wait for that to finish.`);
    this.busy.add(name);
    try {
      return await work();
    } finally {
      this.busy.delete(name);
    }
  }

  /**
   * `holds` (a deploy's) takes the drain's release, for after its health check; otherwise it's released after the restart.
   * `slot` (a deploy's): the slot to run from, which the app's folder is pointed at once its turns are drained (#801).
   */
  private async installNow(row: ContraptionRow, opts: { replace?: boolean; all?: ContraptionRow[]; holds?: (() => void)[]; stage?: (stage: string) => void; slot?: string; data?: () => Promise<void> }): Promise<string[]> {
    // Units run from the real folder, never through the link, so a running app never sees a deploy's flip (#801).
    const folder = opts.slot ?? await realpath(this.folder(row)).catch(() => this.folder(row));
    const manifest = await this.manifest(row, folder);
    const files = unitFiles(this.inputs(row, manifest, folder));
    // citadel-app-<name>-<job> mustn't be another contraption's own unit.
    for (const job of Object.keys(manifest.timers)) {
      if (opts.all?.some((c) => c.name === `${row.name}-${job}`)) throw new ServiceError(409, `Timer ${job} would share its unit name with the contraption ${row.name}-${job}: rename the timer.`);
    }
    // Every file it will write must be its own (or new) before anything is stopped.
    for (const f of files.keys()) {
      const path = join(this.opts.unitDir, f);
      const old = await readFile(path, 'utf8').catch(() => null);
      if (old !== null && ownedBy(old) !== row.name) throw new ServiceError(409, `${path} exists and Citadel didn't write it for ${row.name}: move it away first.`);
    }
    // Citadel makes an app's DATA_DIR when missing, so a service that opens its database there can start; otherwise only a
    // deploy's `data` step touches it (#1137: a snapshot before a migration, a restore on roll back), with the app stopped.
    const data = join(this.opts.home, '.local/share', row.name);
    let created = '';
    if (!existsSync(data)) {
      await mkdir(data, { recursive: true, mode: 0o700 });
      created = `Created ${data}.`;
    }
    const said: string[] = created ? [created] : [];
    const live = (await this.handInstalled(row)).filter((u) => u.active === 'active' || u.active === 'activating' || /^enabled/.test(u.enabled));
    if (live.length && !opts.replace) {
      throw new ServiceError(409, `Hand-installed units run ${row.name} already: ${live.map((u) => `${u.unit} (${u.active}, ${u.enabled || 'no file state'}; ${u.why})`).join('; ')}. Install again with replace to stop and disable them first; their files stay.`);
    }
    opts.stage?.('drain');
    const quiet = await this.drain(row);
    opts.stage?.('restart');
    if (quiet.said) said.push(quiet.said);
    if (opts.holds) opts.holds.push(quiet.release);
    try {
      // Stopped for a whole copy of its data, its timers and their jobs too (a running job is cut short, as by a restart); only
      // units it has installed, so one that never got a service isn't a failure. writeAndRestart starts them again, and a data
      // step that throws starts its service and timers again here.
      if (opts.data) {
        const units = (await this.owned(row.name)).sort((a, b) => Number(b.endsWith('.timer')) - Number(a.endsWith('.timer')));
        if (units.length) await this.must('stop', ...units);
        try {
          await opts.data();
        } catch (err) {
          const back = units.filter((u) => u === `${unitName(row.name)}.service` || u.endsWith('.timer'));
          if (back.length) await this.systemctl('start', ...back);
          throw err;
        }
      }
      if (opts.slot) said.push(await this.point(row, opts.slot));
      return await this.writeAndRestart(row, files, live, said);
    } finally {
      if (!opts.holds) quiet.release();
    }
  }

  /** Point the app's folder at `slot`: a new link renamed over the old one, so it is never missing or half-made. */
  private async point(row: ContraptionRow, slot: string): Promise<string> {
    const folder = this.folder(row);
    const tmp = `${folder}.link-tmp`;
    await rm(tmp, { force: true });
    await symlink(relative(dirname(folder), slot), tmp);
    await rename(tmp, folder);
    return `Pointed ${folder} at ${slot}.`;
  }

  private async writeAndRestart(row: ContraptionRow, files: Map<string, string>, live: HandUnit[], said: string[]): Promise<string[]> {
    if (live.length) {
      // Timers first, so none starts its service again meanwhile.
      const units = live.map((u) => u.unit).sort((a, b) => Number(b.endsWith('.timer')) - Number(a.endsWith('.timer')));
      await this.must('disable', '--now', ...units);
      said.push(`Stopped and disabled ${units.join(', ')} (their files stay in ${this.opts.unitDir}).`);
    }
    const stale = (await this.owned(row.name)).filter((f) => !files.has(f));
    if (stale.length) {
      await this.systemctl('disable', '--now', ...stale);
      for (const f of stale) await rm(join(this.opts.unitDir, f), { force: true });
      said.push(`Removed ${stale.join(', ')}, which the manifest no longer names.`);
    }
    for (const [f, text] of files) {
      const path = join(this.opts.unitDir, f);
      await writeFile(`${path}.tmp`, text, { mode: 0o644 });
      await rename(`${path}.tmp`, path);
    }
    said.push(`Wrote ${[...files.keys()].join(', ')}.`);
    await this.must('daemon-reload');
    const main = `${unitName(row.name)}.service`;
    const timers = [...files.keys()].filter((f) => f.endsWith('.timer'));
    await this.must('enable', main, ...timers);
    await this.must('restart', main);
    if (timers.length) await this.must('start', ...timers);
    said.push(`Enabled and (re)started ${[main, ...timers].join(', ')}.`);
    return said;
  }

  /** start, stop or restart its service (an installed one). Its timers stay as they are. */
  async act(row: ContraptionRow, action: 'start' | 'stop' | 'restart'): Promise<UnitState & { waited: string | null }> {
    this.guard();
    // A stop during a deploy's health check would fail it and roll it back.
    if (this.busy.has(row.name)) throw new ServiceError(409, `${row.name} is being installed or deployed already: wait for that to finish.`);
    const main = `${unitName(row.name)}.service`;
    if (!(await this.owned(row.name)).includes(main)) throw new ServiceError(409, `${row.title} has no service yet: install it first.`);
    const quiet = action === 'start' ? null : await this.drain(row, action === 'stop');
    try {
      await this.must(action, main);
    } finally {
      quiet?.release();
    }
    return { ...(await this.state(main)), waited: quiet?.said ?? null };
  }

  /** Deploys running now, so a Citadel restart waits for them (runner.hostJobs). */
  jobs(): number {
    return [...this.deploys.values()].filter((d) => d.state === 'running').length;
  }

  private deploys = new Map<string, DeployView>();

  /** Its deploy running now, or null. */
  running(name: string): DeployView | null {
    const d = this.deploys.get(name);
    return d && d.finished_at === null ? d : null;
  }

  private stage(view: DeployView, stage: string) {
    view.stages[stage] = Date.now();
    this.safely(view);
  }

  private safely(view: DeployView) {
    try {
      this.onDeploy(view);
    } catch (err) {
      console.error(`Recording ${view.name}'s deploy failed:`, err);
    }
  }

  /**
   * Deploys a Citadel restart or crash cut short (#847), from the markers they left; each marker goes as it is read, and
   * its log gets a line saying what happened. server.ts starts again those not started again already.
   */
  async interrupted(): Promise<Interrupted[]> {
    if (this.opts.off) return [];
    const found: Interrupted[] = [];
    for (const name of await readdir(this.opts.logDir).catch(() => [] as string[])) {
      if (this.busy.has(name)) continue;
      const file = join(this.opts.logDir, name, DEPLOYING);
      const m = await readFile(file, 'utf8').then((t) => JSON.parse(t), () => null);
      if (!m || typeof m !== 'object') continue;
      await rm(file, { force: true });
      if (typeof m.log === 'string' && dirname(m.log) === join(this.opts.logDir, name)) {
        await appendFile(m.log, `== interrupted: Citadel stopped (a restart or a crash) while this deploy ran; found at ${new Date().toISOString()}\n`).catch(() => {});
      }
      found.push({ name, by: typeof m.by === 'string' ? m.by : 'Citadel', uid: typeof m.uid === 'number' ? m.uid : null, resumed: m.resumed === true, ...(typeof m.to === 'string' && /^[0-9a-f]{40}$/.test(m.to) && { to: m.to }) });
    }
    return found;
  }

  /**
   * Waits for a build an earlier deploy left running in the app's build unit (#847): its Citadel restarted mid-build, and
   * the unit ran on. Never two builds at once in one app's checkouts; after an hour it stops the old one.
   */
  private async awaitOlderBuild(name: string, say: (line: string) => Promise<void>) {
    if (!this.opts.systemdRun) return;
    const unit = buildUnit(name);
    const running = async () => /^ActiveState=(active|activating|deactivating|reloading)$/m.test((await run(this.opts.systemctl, ['--user', 'show', unit])).out);
    const since = Date.now();
    if (!(await running())) return;
    await say(`An earlier deploy's build is still running in ${unit} (a Citadel restart cut that deploy short): waiting for it to end.`);
    while (await running()) {
      if (Date.now() - since >= 60 * this.opts.minuteMs) {
        await run(this.opts.systemctl, ['--user', 'stop', unit]);
        await say(`Stopped ${unit} after waiting an hour for it.`);
        return;
      }
      await new Promise((r) => setTimeout(r, this.opts.minuteMs / 30));
    }
    await say('The earlier build ended: going on.');
  }

  /** Its last deploy since this server started, with the end of its log; null when none. */
  async lastDeploy(name: string): Promise<(DeployView & { tail: string }) | null> {
    const d = this.deploys.get(name);
    if (!d) return null;
    const text = await readFile(d.log, 'utf8').catch(() => '');
    // Running until the lock is off, so "finished" always means a new deploy may start.
    return { ...d, state: d.finished_at === null ? 'running' : d.state, said: [...d.said], tail: text.split('\n').slice(-60).join('\n') };
  }

  /**
   * Deploy an app from its repo (#266): clone it, or check its branch's new commit out in the idle one of
   * its two slots (#801; refused on local changes, or commits the branch doesn't have), build it there niced
   * with a time limit while the live slot runs on, point the folder at it, write its units and restart it,
   * then check its health. A failed build changes nothing; an unhealthy one points back at the old slot and
   * restarts that, with no rebuild. Starts it and returns at once; lastDeploy follows it. With
   * `identity` (a fresh X-Citadel-Identity header for the person deploying), a deployed app's page and
   * manifest are checked for installing as its own app (src/pwa-check.ts). A registry entry with no icon
   * gets its manifest's first icon (`hooks.setIcon`, answering whether it took). What's still missing goes
   * in `todo` and to `hooks.todo` (#418): a to-do, never a failure, so an app can ship its first shell.
   */
  deploy(row: ContraptionRow, by: string, all: ContraptionRow[] = [], identity?: () => string | null, hooks: DeployHooks = {}): DeployView {
    this.guard();
    if (!row.repo) throw new ServiceError(409, `${row.title} has no repo set: an admin sets one (owner/name) in Settings → Contraptions first.`);
    if (this.busy.has(row.name)) throw new ServiceError(409, `${row.name} is being installed or deployed already: wait for that to finish.`);
    this.busy.add(row.name);
    const started = Date.now();
    const log = join(this.opts.logDir, row.name, `${new Date(started).toISOString().replace(/[:.]/g, '-')}.log`);
    const view: DeployView = { name: row.name, state: 'running', by, repo: row.repo, branch: row.branch ?? 'main', from: null, to: null, started_at: started, finished_at: null, said: [], todo: [], log, stages: { build: started } };
    this.deploys.set(row.name, view);
    void this.deployNow(row, view, all, identity, hooks)
      .catch((err) => {
        view.said.push(`Failed: ${err.message}`);
        view.state = 'failed';
      })
      .finally(async () => {
        await appendFile(log, `== ${view.state} at ${new Date().toISOString()}\n`).catch(() => {});
        if (this.stopping) await appendFile(log, '== Citadel is restarting: this deploy starts again once it is back.\n').catch(() => {});
        else await rm(join(this.opts.logDir, row.name, DEPLOYING), { force: true }).catch(() => {});
        this.busy.delete(row.name);
        view.finished_at = Date.now();
        this.safely(view);
        await this.pruneLogs(row.name).catch(() => {});
      });
    return view;
  }

  private async pruneLogs(name: string) {
    const dir = join(this.opts.logDir, name);
    const old = (await readdir(dir)).filter((f) => f.endsWith('.log')).sort().slice(0, -20);
    for (const f of old) await rm(join(dir, f), { force: true });
  }

  /** The environment builds and git run with: none of Citadel's own, mise's toolchains on PATH. */
  private buildEnv(folder: string): NodeJS.ProcessEnv {
    const keep = ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'SSH_AUTH_SOCK'];
    const env: NodeJS.ProcessEnv = Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    return { ...env, PATH: toolPath(this.opts.home), GIT_TERMINAL_PROMPT: '0', MISE_TRUSTED_CONFIG_PATHS: folder };
  }

  private async deployNow(row: ContraptionRow, view: DeployView, all: ContraptionRow[], identity?: () => string | null, hooks: DeployHooks = {}) {
    const folder = this.folder(row);
    const env = this.buildEnv(folder);
    await mkdir(dirname(view.log), { recursive: true });
    const say = async (line: string) => {
      view.said.push(line);
      await appendFile(view.log, `== ${line}\n`);
    };
    await writeFile(join(dirname(view.log), DEPLOYING), JSON.stringify({ by: view.by, uid: hooks.uid ?? null, resumed: !!hooks.resumed, log: view.log, ...(hooks.to && { to: hooks.to }) }));
    if (hooks.resumed) await say('Started again: a Citadel restart cut the last deploy short.');
    await this.awaitOlderBuild(row.name, say);
    /** Run a command, its output into the log; its exit code (124 when it ran out of time). */
    const sh = (argv: string[], cwd: string, ms: number, withEnv = env) => runLogged(argv, cwd, withEnv, view.log, ms);
    // Only git's network calls get the owner's login (its token through gh's credential helper, never in a URL); builds run app code.
    const as = this.githubAs(row);
    /** Clone or fetch as the owner, then once more as the box's login when theirs can't reach it (a limited link, no App there). */
    const network = async (argv: string[], cwd: string) => {
      if (!as) return sh(argv, cwd, 600_000);
      const code = await sh(argv, cwd, 600_000, { ...env, ...as });
      if (code === 0 || code === 124) return code;
      await say(`The home scheme owner's GitHub link couldn't reach ${repo}: trying Citadel's own login.`);
      return sh(argv, cwd, 600_000);
    };
    const git = async (cwd: string, ...args: string[]) => {
      const r = await execResult('git', args, { cwd, env, timeout: 120_000 });
      if (r.code) throw new Error(`git ${args.join(' ')} failed: ${r.err.trim().slice(0, 500) || `exit ${r.code}`}`);
      return r.out.trim();
    };
    const short = (sha: string | null) => sha?.slice(0, 9) ?? 'nothing';
    const repo = row.repo!;
    const hand = (await this.handInstalled(row)).filter((u) => u.active === 'active' || u.active === 'activating' || /^enabled/.test(u.enabled));
    if (hand.length) throw new Error(`Hand-installed units run ${row.name}: ${hand.map((u) => u.unit).join(', ')}. An admin installs it once with replace (contraption_service install, replace: true, or Settings → Contraptions) before it can deploy.`);
    /** A clean checkout of the app's repo, or an Error naming what's in the way. */
    const checkout = async (dir: string, nothing: string) => {
      if ((await git(dir, 'rev-parse', '--show-toplevel').catch(() => '')) !== (await realpath(dir))) throw new Error(`${dir} isn't a git checkout of its own: move it away, or set another folder.`);
      const origin = await git(dir, 'remote', 'get-url', 'origin').catch(() => '');
      const slug = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(origin)?.[1];
      const bare = (u: string) => u.replace(/(\.git)?\/?$/, '').toLowerCase();
      if (slug?.toLowerCase() !== repo.toLowerCase() && bare(origin) !== bare(this.opts.gitUrl(repo))) throw new Error(`${dir}'s origin is ${origin || 'not set'}, not ${repo}: refusing to deploy over it.`);
      const dirty = await git(dir, 'status', '--porcelain');
      if (dirty) throw new Error(`${dir} has local changes, so nothing was ${nothing}: commit or remove them first.\n${dirty.split('\n').slice(0, 10).join('\n')}`);
    };

    // Two slots behind the app's folder (#801): the folder links to the live one, and a deploy builds in the other, so
    // the running app never sees the new commit's files before its restart. A roll back points at the old slot again.
    const slots = slotsOf(folder);
    const [a, b] = [join(slots, 'a'), join(slots, 'b')];
    let prev: string | null = null;
    /** The live slot, kept as it is for a roll back; null on a first deploy. */
    let old: string | null = null;
    let next: string;
    /** A roll back past a migration change (#1137): the snapshot whose data that older code reads. */
    let restore: Snapshot | null = null;
    let link = await readlink(folder).catch(() => null);
    /** An empty slots folder is one a deploy stopped right after making. */
    const inTheWay = () => existsSync(slots) && readdirSync(slots).length > 0;
    if (link === null && !existsSync(folder) && existsSync(join(a, '.git'))) {
      // A deploy stopped before linking the folder (a failed first deploy, or a move into the slot cut short): link it now.
      link = relative(dirname(folder), a);
      await symlink(link, folder);
      await say(`Linked ${folder} to ${a} again: an earlier deploy stopped before linking it.`);
    }
    if (link === null && !existsSync(folder)) {
      if (inTheWay()) throw new Error(`${slots} is there but ${folder} isn't: move it away first.`);
      if (hooks.to) throw new Error(`${row.name} has never been deployed, so there is nothing to roll back.`);
      next = a;
      await mkdir(slots, { recursive: true });
      await say(`Cloning ${repo} (${view.branch}) into ${next}.`);
      if (await network(['git', 'clone', '--quiet', '--branch', view.branch, '--', this.opts.gitUrl(repo), next], slots)) throw new Error(`Cloning ${repo} failed: see the log.`);
    } else {
      if (link === null) {
        // A plain folder from before the slots: move it, as it is, into the first slot. Its service runs on, its cwd moving with it.
        await checkout(folder, 'fetched');
        const branch = await git(folder, 'branch', '--show-current');
        if (branch !== view.branch) throw new Error(`${folder} is on ${branch || 'a detached HEAD'}, not ${view.branch}: switch it back by hand first.`);
        if (inTheWay()) throw new Error(`${slots} is there already: move it away first.`);
        await mkdir(slots, { recursive: true });
        await rename(folder, a);
        link = relative(dirname(folder), a);
        try {
          await symlink(link, folder);
        } catch (err: any) {
          const back = await rename(a, folder).then(() => 'so it was moved back', (e) => `and moving it back failed too (${e.message}): the next deploy links it`);
          throw new Error(`Couldn't link ${folder} to ${a}, ${back}: ${err.message}`);
        }
        await say(`Moved ${folder} to ${a} and linked it there: from now on a deploy builds in a second folder beside it.`);
      }
      old = resolve(dirname(folder), link);
      if (old !== a && old !== b) throw new Error(`${folder} links to ${old}, not to ${a} or ${b}: point it back by hand.`);
      next = old === a ? b : a;
      await checkout(old, 'fetched');
      prev = await git(old, 'rev-parse', 'HEAD');
      if (!existsSync(next)) {
        await git(old, 'worktree', 'add', '--detach', '--quiet', next, 'HEAD');
        await say(`Made ${next}, a second checkout to build in.`);
      } else {
        await checkout(next, 'built');
      }
      await say(`Fetching ${repo} ${view.branch}.`);
      if (await network(['git', 'fetch', '--quiet', 'origin', view.branch], next)) throw new Error(`Fetching ${repo} failed: see the log.`);
      let to = await git(next, 'rev-parse', 'FETCH_HEAD');
      const inBranch = (ancestor: string, commit: string) => git(next, 'merge-base', '--is-ancestor', ancestor, commit).then(() => true, () => false);
      if (hooks.to) {
        // A roll back (#1016) goes to an older commit of the branch, never one off it; nor past a change to the data's shape.
        if (!(await inBranch(hooks.to, to))) throw new Error(`${short(hooks.to)} isn't on ${repo}'s ${view.branch}, so nothing changed.`);
        // Both ends' migrations: the commit it goes back to may list a path the live one dropped.
        const there = await git(next, 'show', `${hooks.to}:${repoPath(row, MANIFEST)}`).then(parseManifest).catch(() => null);
        const paths = [...new Set([...((await this.manifest(row, old).catch(() => null))?.migrations ?? []), ...(there?.migrations ?? [])])].map((p) => repoPath(row, p));
        const moved = paths.length ? (await git(next, 'diff', '--name-only', hooks.to, prev, '--', ...paths)).split('\n').filter(Boolean) : [];
        if (moved.length) {
          // The newest snapshot whose code has the same migrations as the commit it goes back to (#1137).
          const changed = `Its migrations changed since ${short(hooks.to)} (${moved.slice(0, 5).join(', ')}${moved.length > 5 ? `, ${moved.length - 5} more` : ''})`;
          for (const snap of await listSnapshots(snapshotsDir(this.opts.home, row.name))) {
            if (snap.failed) continue; // what a failed start left: its code ran on it, but it's the shape that failed
            const same = await git(next, 'diff', '--name-only', snap.commit, hooks.to, '--', ...paths).then((out) => !out, () => false);
            if (same) {
              restore = snap;
              break;
            }
          }
          if (!restore) throw new Error(`${changed}, and no snapshot of its data matches that code, so going back could leave its data in a shape that code can't read. Nothing changed: fix forward instead.`);
          await say(`${changed}: its data goes back too, to the snapshot taken at ${short(restore.commit)}.`);
        }
        await say(`Rolling back to ${short(hooks.to)}${prev ? ` from ${short(prev)}` : ''}.`);
        to = hooks.to;
      } else if (!(await inBranch(prev, to))) {
        throw new Error(`${old} has commits ${repo}'s ${view.branch} doesn't: a deploy only goes forward, so nothing changed.`);
      }
      await git(next, 'checkout', '--detach', '--quiet', to);
    }
    env.MISE_TRUSTED_CONFIG_PATHS = next;
    view.from = prev;
    view.to = await git(next, 'rev-parse', 'HEAD');
    await say(prev === view.to ? `Already at ${short(view.to)}: building and restarting it anyway.` : `Building ${short(view.to)}${prev ? ` (${short(prev)} runs meanwhile)` : ''}.`);
    const unchanged = () => say(prev ? `Nothing changed: ${short(prev)} still runs.` : 'Nothing to roll back to: this was its first deploy.');

    // Its turns held by the restart wait for the health check too, so they find its MCP servers up.
    const holds: (() => void)[] = [];
    const start = async (slot: string, m: Manifest, data?: () => Promise<void>) => {
      for (const line of await this.installNow(row, { all, holds, slot, stage: (s) => this.stage(view, s), data })) await say(line);
      await this.healthy(row, m.health);
      await say(`Healthy: ${m.health ? `${m.health} answered` : `port ${row.port} open`}.`);
    };
    try {
      let m: Manifest;
      try {
        m = await this.manifest(row, next);
        const who = `${row.name} deploy`;
        // One heavy slot (#847) for all its steps, taken ahead of minions' jobs waiting in line (#885): a holder process keeps
        // it until its stdin closes. The time limit starts once it holds it, so the wait in line doesn't count against it.
        // shortcut: a Citadel restart mid-build ends the holder while the build unit runs on unslotted, a few minutes at most.
        let holder: ChildProcess | null = null;
        try {
          if (m.build.length) {
            // Citadel's own CITADEL_HEAVY_* settings (a dev copy's lock folder, a test's pressure gate) carry over.
            const heavyEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CITADEL_HEAVY_') && k !== 'CITADEL_HEAVY_HELD'));
            const fd = openSync(view.log, 'a');
            holder = spawn(this.opts.heavy, ['sh', '-c', 'echo; exec cat >/dev/null'], {
              cwd: appRoot(row, next), env: { ...env, ...heavyEnv, CITADEL_HEAVY_WHO: who, CITADEL_HEAVY_PRIORITY: '1', CITADEL_HEAVY_WHAT: `build: ${m.build.join('; ')}` }, stdio: ['pipe', 'pipe', fd],
            });
            closeSync(fd);
            holder.stdin!.on('error', () => {}); // it may be gone already when the build ends
            const asked = Date.now();
            const ended = await new Promise<number | null>((ok) => {
              holder!.stdout!.once('data', () => ok(null));
              holder!.once('close', (code) => ok(code ?? 1));
              holder!.once('error', () => ok(127));
            });
            if (ended !== null) throw new Error(`Waiting for a heavy slot ended (${exitWhy(ended)}): see the log.`);
            const waited = Math.round((Date.now() - asked) / 1000);
            if (waited >= 2) await say(`Got a heavy slot after ${waited} s in line.`);
          }
          const deadline = Date.now() + m.build_timeout * this.opts.minuteMs;
          for (const step of m.build) {
            await say(`Build: ${step}`);
            const from = (await stat(view.log)).size;
            const secs = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
            const inner = ['timeout', '-k', '10', String(secs), 'nice', '-n', '10', 'sh', '-c', step];
            // In the deploy's slot: a step that calls citadel-heavy itself runs straight away rather than queue behind it.
            const stepEnv = { ...env, CITADEL_HEAVY_HELD: '1', CITADEL_HEAVY_WHO: who };
            const unit = buildUnit(row.name);
            const argv = this.opts.systemdRun
              ? [this.opts.systemdRun, '--user', '--wait', '--collect', `--unit=${unit}`, `--working-directory=${appRoot(row, next)}`, `--property=StandardOutput=append:${view.log}`,
                `--property=StandardError=append:${view.log}`, ...Object.entries(stepEnv).map(([k, v]) => `--setenv=${k}=${v}`), '--', ...inner]
              : inner;
            // A backstop past timeout's own kill: the unit is stopped too (stopping systemd-run alone leaves it running).
            const code = await sh(argv, appRoot(row, next), secs * 1000 + 15_000, stepEnv);
            if (code === 124 && this.opts.systemdRun) await run(this.opts.systemctl, ['--user', 'stop', unit]);
            if (code === 124) throw new Error(`The build ran past its ${m.build_timeout} minutes at: ${step}`);
            if (code) throw new Error(`Build step failed (${exitWhy(code)}): ${step}${await lastLines(view.log, from)}`);
          }
        } finally {
          holder?.stdin!.end();
        }
      } catch (err: any) {
        // The live slot was never touched, nor its service restarted.
        await say(`Failed: ${err.message}`);
        view.state = 'failed';
        await unchanged();
        return;
      }
      // A deploy forward that changes its migrations snapshots its data first, with the app stopped (#1137).
      const dataDir = this.dataDir(row);
      const snapRoot = snapshotsDir(this.opts.home, row.name);
      /** The snapshot a failed start goes back to: the one this deploy took, or the data a restore set aside. */
      let taken = null as Snapshot | null;
      let snapWhy: string | null = null;
      if (!hooks.to && prev && prev !== view.to) {
        const paths = [...new Set([...((await this.manifest(row, old!).catch(() => null))?.migrations ?? []), ...m.migrations])].map((p) => repoPath(row, p));
        const moved = paths.length ? (await git(next, 'diff', '--name-only', prev, view.to, '--', ...paths)).split('\n').filter(Boolean) : [];
        if (moved.length) snapWhy = `before ${short(view.to)} deployed, which changes ${moved.slice(0, 5).join(', ')}${moved.length > 5 ? `, ${moved.length - 5} more` : ''}`;
      }
      const data = snapWhy
        ? async () => {
          const r = await takeSnapshot(dataDir, snapRoot, { commit: prev!, why: `${short(prev)}'s data, ${snapWhy}` });
          taken = r.snap;
          for (const line of r.said) await say(line);
        }
        : restore
          ? async () => {
            const r = await restoreSnapshot(dataDir, snapRoot, restore!, { commit: prev!, why: `${short(prev)}'s data, kept when ${view.by} rolled back to ${short(view.to)}` });
            taken = r.kept;
            for (const line of r.said) await say(line);
          }
          : undefined;
      try {
        await start(next, m, data);
        view.state = 'deployed';
        await say(`Deployed ${short(view.to)}${taken && !restore ? `; its data was snapshotted first, so a roll back brings that back too` : restore ? `, with its data as it was at ${short(restore.commit)}` : ''}.`);
      } catch (err: any) {
        await say(`Failed: ${err.message}`);
        // Refused before its folder was pointed at the new slot: the old one runs on, untouched.
        if (!old || (await realpath(folder).catch(() => null)) !== (await realpath(next))) {
          view.state = 'failed';
          await unchanged();
          return;
        }
        await say(`Rolling back to ${short(prev)}, built as it was in ${old}${taken ? `, and its data to ${restore ? 'what it had before' : 'the snapshot taken before this deploy'}` : ''}.`);
        const back: Snapshot | null = taken;
        try {
          await start(old, await this.manifest(row, old), back ? async () => {
            for (const line of (await restoreSnapshot(dataDir, snapRoot, back, { commit: view.to!, why: `the data ${short(view.to)} left when its deploy failed and rolled back`, failed: true })).said) await say(line);
          } : undefined);
          view.state = 'rolled back';
          await say(`Rolled back: ${short(prev)} runs again.`);
        } catch (again: any) {
          view.state = 'failed';
          await say(`Rolling back failed too: ${again.message}`);
        }
      }
      if (view.state !== 'deployed') return;
    } finally {
      for (const release of holds) release();
    }
    // After the try, so nothing here can roll back a deploy that worked.
    const header = identity?.();
    // Without a person to read its page as, only the registry's icon is checked.
    const check = async (ms: number) => {
      if (!header) return { problems: [] as string[], icon: null, statics: [] as string[] };
      try {
        return await installCheck(row.name, (path) => fetch(`http://127.0.0.1:${row.port}${path}`, { headers: { 'x-citadel-identity': header, accept: 'text/html' }, signal: AbortSignal.timeout(ms) }));
      } catch (err: any) {
        return { problems: [], icon: null, statics: [] as string[], unchecked: err?.message ?? String(err) };
      }
    };
    // A check that couldn't run says nothing about the app (a timeout under load is not "no manifest"): no to-dos, no
    // "no rail icon" either, and one try again a little later with a longer wait.
    const finish = async (found: Awaited<ReturnType<typeof check>>) => {
      if (found.statics.length) hooks.setStatics?.(found.statics);
      const todo = found.problems;
      if (!row.icon && found.icon && hooks.setIcon?.(found.icon)) await say(`Rail icon set to ${found.icon}, the first icon in its manifest.`);
      else if (!row.icon) todo.unshift(`It has no rail icon, so the rail shows its first letter. Serve one and register it (update_contraption's icon, or Settings → Contraptions), or list 192 and 512 px PNG icons in its web manifest and deploy again: an empty icon is filled from there.`);
      view.todo = todo;
      for (const t of todo) await say(`To do: ${t}`);
      // An empty list only when it was checked: that says it's all done.
      if (header || todo.length) hooks.todo?.(todo);
    };
    const first = await check(5000);
    if (!first.unchecked) return finish(first);
    await say(`Couldn't check how it installs: ${first.unchecked}. Trying again shortly.`);
    const timer = setTimeout(async () => {
      try {
        const again = await check(20_000);
        if (!again.unchecked) return await finish(again);
        const line = `Couldn't check how ${row.name} installs: ${again.unchecked}. Nothing to do unless it repeats.`;
        await say(line);
        hooks.unchecked?.(line);
      } catch (err) {
        console.error(`${row.name}'s install check retry failed:`, err);
      }
    }, this.opts.installRetryMs);
    timer.unref();
  }

  /** Wait for its service to be active and its health path (or port) to answer, twice, a few seconds apart. */
  private async healthy(row: ContraptionRow, health: string | null) {
    const main = `${unitName(row.name)}.service`;
    const until = Date.now() + this.opts.healthMs;
    const probe = async () => (health
      ? fetch(`http://127.0.0.1:${row.port}${health}`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false)
      : new Promise<boolean>((ok) => {
        const sock = connect({ host: '127.0.0.1', port: row.port, timeout: 1000 });
        const done = (v: boolean) => { sock.destroy(); ok(v); };
        sock.once('connect', () => done(true)).once('error', () => done(false)).once('timeout', () => done(false));
      }));
    let seen = '';
    // Polls scale with healthMs (1 s at most), so a short healthMs isn't spent asleep (#377).
    const poll = Math.min(1000, this.opts.healthMs / 10);
    for (let first = true; Date.now() < until; await new Promise((r) => setTimeout(r, poll))) {
      const state = (await this.state(main)).active;
      const ok = state === 'active' && await probe();
      if (!ok) {
        seen = `${main} ${state}${state === 'active' ? `, ${health ?? `port ${row.port}`} not answering` : ''}`;
        first = true;
        continue;
      }
      seen = `${main} ${state}, ${health ?? `port ${row.port}`} answered, but time ran out before the second check`;
      // Once more after a pause, so a service that starts and then crashes doesn't pass.
      if (!first) return;
      first = false;
      await new Promise((r) => setTimeout(r, Math.min(3000, this.opts.healthMs / 10)));
    }
    throw new Error(`Not healthy after ${Math.round(this.opts.healthMs / 1000)}s: ${seen || 'no answer'}. Its journal: contraption_service logs.`);
  }

  /**
   * Each timer job's last run, for the timer units Citadel owns of every app in `rows` (#555, src/timer-alerts.ts):
   * the job's service state (failed, inactive, activating, …), how it ended, and when, in ms (null: never ran).
   */
  async timerRuns(rows: ContraptionRow[]): Promise<TimerRun[]> {
    this.guard();
    const out: TimerRun[] = [];
    for (const row of rows) {
      for (const timer of (await this.owned(row.name)).filter((f) => f.endsWith('.timer')).sort()) {
        const unit = timer.replace(/\.timer$/, '.service');
        const r = await this.systemctl('show', unit, '--timestamp=unix', '-p', 'ActiveState', '-p', 'Result', '-p', 'ExecMainStatus', '-p', 'ExecMainExitTimestamp');
        // An unreadable one is still there (`unknown`): leaving it out would read as the job gone and clear its alert.
        const v = r.code ? {} : Object.fromEntries(r.out.split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
        const at = /^@(\d+)/.exec(v.ExecMainExitTimestamp ?? '');
        out.push({ app: row, job: unit.slice(unitName(row.name).length + 1, -'.service'.length), unit, active: v.ActiveState ?? 'unknown', result: v.Result ?? '', status: v.ExecMainStatus ?? '', exitAt: at ? Number(at[1]) * 1000 : null });
      }
    }
    return out;
  }

  /** A unit's own output from its last `lines` journal lines, without systemd's lines about it. */
  async journalTail(unit: string, lines = 30): Promise<string[]> {
    this.guard();
    const r = await run(this.opts.journalctl, ['--user', '-u', unit, '-n', String(lines), '--no-pager', '-o', 'cat']);
    if (r.code) return [];
    return r.out.split('\n').filter((l) => l.trim() && !l.startsWith(`${unit}:`) && !/^(Starting|Started|Finished|Failed to start) /.test(l));
  }

  /**
   * Its units' journal entries after `cursor` (null: the last 10 minutes), at most the newest 1,000, and the cursor
   * to read on from, for the error digest (#835). Entries come as JSON, so a line is one entry however it looks.
   */
  async journalSince(row: ContraptionRow, cursor: string | null): Promise<{ entries: { at: number; unit: string; text: string; priority: number }[]; cursor: string | null }> {
    this.guard();
    const units = (await this.owned(row.name)).flatMap((f) => ['-u', f]);
    if (!units.length) units.push('-u', `${unitName(row.name)}.service`);
    const from = cursor ? [`--after-cursor=${cursor}`] : ['--since', `@${Math.floor(Date.now() / 1000) - 600}`];
    const r = await run(this.opts.journalctl, ['--user', ...units, ...from, '-n', '1000', '--no-pager', '-o', 'json']);
    if (r.code) throw new Error(`journalctl failed: ${(r.err || r.out).trim().slice(0, 300)}`);
    const entries = [];
    let next = cursor;
    for (const line of r.out.split('\n')) {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof e.__CURSOR === 'string') next = e.__CURSOR;
      // A message that isn't valid UTF-8 comes as an array of bytes: not worth a digest line.
      if (typeof e.MESSAGE !== 'string') continue;
      entries.push({ at: Math.floor(Number(e.__REALTIME_TIMESTAMP) / 1000) || Date.now(), unit: String(e.USER_UNIT ?? e._SYSTEMD_USER_UNIT ?? ''), text: e.MESSAGE, priority: Number(e.PRIORITY ?? 6) });
    }
    return { entries, cursor: next };
  }

  /** The last lines of its units' journal. */
  async logs(row: ContraptionRow, lines = 100): Promise<string> {
    this.guard();
    const units = (await this.owned(row.name)).flatMap((f) => ['-u', f]);
    if (!units.length) units.push('-u', `${unitName(row.name)}.service`);
    const r = await run(this.opts.journalctl, ['--user', ...units, '-n', String(Math.min(Math.max(1, lines), 1000)), '--no-pager', '-o', 'short-iso']);
    if (r.code) throw new ServiceError(500, `journalctl failed: ${(r.err || r.out).trim().slice(0, 1000)}`);
    return r.out;
  }
}
