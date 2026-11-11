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
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ContraptionRow } from './db.ts';
import { installCheck } from './pwa-check.ts';

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
}

/** The environment Citadel sets on every app's units; a manifest can't. */
export const CITADEL_ENV = ['PORT', 'DATA_DIR', 'CITADEL_KEYS', 'CITADEL_URL', 'BASE_PATH', 'PATH'];
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
  return { start: command(m.start, 'start'), workdir: relDir(m.workdir, 'workdir'), env, timers, health: m.health ?? null, build: m.build ?? [], build_timeout: m.build_timeout ?? 20 };
}

/** The first line of every unit file Citadel writes; it touches no other. */
const OWNED = (name: string) => `# Written by Citadel for contraption ${name}.`;
const ownedBy = (text: string) => /^# Written by Citadel for contraption ([a-z0-9-]+)\./.exec(text)?.[1] ?? null;

/** A value in a unit file: systemd's quoting, and % doubled so it is never a specifier. */
const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
/** An ExecStart line: the program bare (it is checked), each argument quoted; ${VAR} still expands from the unit's environment. */
const execLine = (argv: string[], home: string) => [argv[0], ...argv.slice(1).map((a) => quote(tilde(a, home)))].join(' ');
const tilde = (s: string, home: string) => (s.startsWith('~/') ? join(home, s.slice(2)) : s);

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
}

/** What a deploy hands back to its caller once it's deployed (#418). */
export interface DeployHooks {
  /** Set the registry's icon, if it's still empty; true when it took. */
  setIcon?: (icon: string) => boolean;
  /** What the deployed app still lacks: no rail icon, or a web manifest that won't install. Empty when it was checked and lacks nothing. */
  todo?: (todo: string[]) => void;
}

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
  /** A manifest's build_timeout minute, in ms (tests shorten it). */
  minuteMs: number;
  /** Where a repo is cloned from: GitHub, or CITADEL_GIT_BASE (tests). */
  gitUrl: (repo: string) => string;
}

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
    minuteMs: 60_000,
    gitUrl: (repo) => `${env.CITADEL_GIT_BASE || 'https://github.com'}/${repo}.git`,
    ...rest,
  };
}

const run = (bin: string, args: string[], timeout = 60_000) => new Promise<Ran>((ok) => {
  execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err: any, out, errText) => ok({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out), err: String(errText || (err && !out ? err.message : '')) }));
});

export class AppServices {
  readonly opts: ServiceOptions;
  /**
   * Before its service stops or restarts (#319): hold its new turns and wait for its running ones
   * (ContraptionTurns.drain). Set by server.ts; `release` lets the held turns start.
   */
  drain: (row: ContraptionRow) => Promise<{ said: string | null; release: () => void }> = async () => ({ said: null, release: () => {} });

  constructor(opts: ServiceOptions) {
    this.opts = opts;
  }

  /** The app's folder: where its repo is checked out; default ~/apps/<name>. */
  folder(row: Pick<ContraptionRow, 'name' | 'folder'>): string {
    return row.folder ? tilde(row.folder, this.opts.home) : join(this.opts.home, 'apps', row.name);
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
  async manifest(row: Pick<ContraptionRow, 'name' | 'folder'>, folder = this.folder(row)): Promise<Manifest> {
    let text: string;
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
    return { row, manifest, folder, keysDir: this.opts.keysDir(row.name), citadelUrl: this.opts.citadelUrl(), home: this.opts.home };
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

  /** `holds` (a deploy's) takes the drain's release, for after its health check; otherwise it's released after the restart. */
  private async installNow(row: ContraptionRow, opts: { replace?: boolean; all?: ContraptionRow[]; holds?: (() => void)[] }): Promise<string[]> {
    const folder = this.folder(row);
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
    // The one thing Citadel does in an app's DATA_DIR: make it when missing (an existing one is never touched), so a service that opens its database there can start.
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
    const quiet = await this.drain(row);
    if (quiet.said) said.push(quiet.said);
    if (opts.holds) opts.holds.push(quiet.release);
    try {
      return await this.writeAndRestart(row, files, live, said);
    } finally {
      if (!opts.holds) quiet.release();
    }
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
    const quiet = action === 'start' ? null : await this.drain(row);
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

  /** Its last deploy since this server started, with the end of its log; null when none. */
  async lastDeploy(name: string): Promise<(DeployView & { tail: string }) | null> {
    const d = this.deploys.get(name);
    if (!d) return null;
    const text = await readFile(d.log, 'utf8').catch(() => '');
    // Running until the lock is off, so "finished" always means a new deploy may start.
    return { ...d, state: d.finished_at === null ? 'running' : d.state, said: [...d.said], tail: text.split('\n').slice(-60).join('\n') };
  }

  /**
   * Deploy an app from its repo (#266): clone it, or fetch and fast-forward its branch (refused on local
   * changes or a branch that isn't the registered one), build it niced with a time limit, write its units
   * and restart it, then check its health. A failure after the fast-forward rolls back to the commit
   * before, builds that, and restarts it. Starts it and returns at once; lastDeploy follows it. With
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
    const view: DeployView = { name: row.name, state: 'running', by, repo: row.repo, branch: row.branch ?? 'main', from: null, to: null, started_at: started, finished_at: null, said: [], todo: [], log };
    this.deploys.set(row.name, view);
    void this.deployNow(row, view, all, identity, hooks)
      .catch((err) => {
        view.said.push(`Failed: ${err.message}`);
        view.state = 'failed';
      })
      .finally(async () => {
        await appendFile(log, `== ${view.state} at ${new Date().toISOString()}\n`).catch(() => {});
        this.busy.delete(row.name);
        view.finished_at = Date.now();
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
    /** Run a command, its output into the log; its exit code (124 when it ran out of time). */
    const sh = (argv: string[], cwd: string, ms: number) => new Promise<number>((ok) => {
      const fd = openSync(view.log, 'a');
      const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['ignore', fd, fd] });
      closeSync(fd);
      let late = false;
      const timer = setTimeout(() => {
        late = true;
        try {
          process.kill(-child.pid!, 'SIGTERM');
          setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, 10_000).unref();
        } catch {}
      }, Math.max(1, ms));
      child.once('error', () => { clearTimeout(timer); ok(127); });
      child.once('close', (code) => { clearTimeout(timer); ok(late ? 124 : code ?? 1); });
    });
    const git = async (...args: string[]) => {
      const r = await new Promise<Ran>((ok) => execFile('git', args, { cwd: folder, env, timeout: 120_000 }, (err: any, out, errText) => ok({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out), err: String(errText) })));
      if (r.code) throw new Error(`git ${args.join(' ')} failed: ${r.err.trim().slice(0, 500) || `exit ${r.code}`}`);
      return r.out.trim();
    };
    const short = (sha: string | null) => sha?.slice(0, 9) ?? 'nothing';
    const repo = row.repo!;
    const live = (await this.handInstalled(row)).filter((u) => u.active === 'active' || u.active === 'activating' || /^enabled/.test(u.enabled));
    if (live.length) throw new Error(`Hand-installed units run ${row.name}: ${live.map((u) => u.unit).join(', ')}. An admin installs it once with replace (contraption_service install, replace: true, or Settings → Contraptions) before it can deploy.`);

    let prev: string | null = null;
    if (!existsSync(folder)) {
      await mkdir(dirname(folder), { recursive: true });
      await say(`Cloning ${repo} (${view.branch}) into ${folder}.`);
      if (await sh(['git', 'clone', '--quiet', '--branch', view.branch, '--', this.opts.gitUrl(repo), folder], dirname(folder), 600_000)) throw new Error(`Cloning ${repo} failed: see the log.`);
    } else {
      if ((await git('rev-parse', '--show-toplevel').catch(() => '')) !== (await realpath(folder))) throw new Error(`${folder} isn't a git checkout of its own: move it away, or set another folder.`);
      const origin = await git('remote', 'get-url', 'origin').catch(() => '');
      const slug = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(origin)?.[1];
      const bare = (u: string) => u.replace(/(\.git)?\/?$/, '').toLowerCase();
      if (slug?.toLowerCase() !== repo.toLowerCase() && bare(origin) !== bare(this.opts.gitUrl(repo))) throw new Error(`${folder}'s origin is ${origin || 'not set'}, not ${repo}: refusing to deploy over it.`);
      const branch = await git('branch', '--show-current');
      if (branch !== view.branch) throw new Error(`${folder} is on ${branch || 'a detached HEAD'}, not ${view.branch}: switch it back by hand first.`);
      const dirty = await git('status', '--porcelain');
      if (dirty) throw new Error(`${folder} has local changes, so nothing was fetched: commit or remove them first.\n${dirty.split('\n').slice(0, 10).join('\n')}`);
      prev = await git('rev-parse', 'HEAD');
      await say(`Fetching ${repo} ${view.branch}.`);
      if (await sh(['git', 'fetch', '--quiet', 'origin', view.branch], folder, 600_000)) throw new Error(`Fetching ${repo} failed: see the log.`);
      await git('merge', '--ff-only', '--quiet', 'FETCH_HEAD').catch((err) => {
        throw new Error(`${folder}'s ${view.branch} has commits ${repo} doesn't, or git refused: it can only fast-forward, so nothing changed. ${err.message}`);
      });
    }
    view.from = prev;
    view.to = await git('rev-parse', 'HEAD');
    await say(prev === view.to ? `Already at ${short(view.to)}: building and restarting it anyway.` : `Now at ${short(view.to)}${prev ? ` (was ${short(prev)})` : ''}.`);

    // Its turns held by the restart wait for the health check too, so they find its MCP servers up.
    const holds: (() => void)[] = [];
    const buildAndStart = async () => {
      const m = await this.manifest(row, folder);
      const deadline = Date.now() + m.build_timeout * this.opts.minuteMs;
      for (const step of m.build) {
        await say(`Build: ${step}`);
        const code = await sh(['nice', '-n', '10', 'sh', '-c', step], folder, deadline - Date.now());
        if (code === 124) throw new Error(`The build ran past its ${m.build_timeout} minutes at: ${step}`);
        if (code) throw new Error(`Build step failed (exit ${code}): ${step}`);
      }
      for (const line of await this.installNow(row, { all, holds })) await say(line);
      await this.healthy(row, m.health);
      await say(`Healthy: ${m.health ? `${m.health} answered` : `port ${row.port} open`}.`);
    };
    try {
      await buildAndStart();
      view.state = 'deployed';
      await say(`Deployed ${short(view.to)}.`);
    } catch (err: any) {
      await say(`Failed: ${err.message}`);
      if (!prev || prev === view.to) {
        view.state = 'failed';
        if (!prev) await say('Nothing to roll back to: this was its first deploy.');
        return;
      }
      await say(`Rolling back to ${short(prev)}.`);
      try {
        await git('reset', '--hard', '--quiet', prev);
        await buildAndStart();
        view.state = 'rolled back';
        await say(`Rolled back: ${short(prev)} runs again.`);
      } catch (again: any) {
        view.state = 'failed';
        await say(`Rolling back failed too: ${again.message}`);
      }
      return;
    } finally {
      for (const release of holds) release();
    }
    // After the try, so nothing here can roll back a deploy that worked.
    const header = identity?.();
    // Without a person to read its page as, only the registry's icon is checked.
    const found = header
      ? await installCheck(row.name, (path) => fetch(`http://127.0.0.1:${row.port}${path}`, { headers: { 'x-citadel-identity': header, accept: 'text/html' }, signal: AbortSignal.timeout(5000) }))
        .catch((err) => ({ problems: [`Couldn't check how it installs: ${err.message}`], icon: null }))
      : { problems: [], icon: null };
    const todo = found.problems;
    if (!row.icon && found.icon && hooks.setIcon?.(found.icon)) await say(`Rail icon set to ${found.icon}, the first icon in its manifest.`);
    else if (!row.icon) todo.unshift(`It has no rail icon, so the rail shows its first letter. Serve one and register it (update_contraption's icon, or Settings → Contraptions), or list 192 and 512 px PNG icons in its web manifest and deploy again: an empty icon is filled from there.`);
    view.todo = todo;
    for (const t of todo) await say(`To do: ${t}`);
    // An empty list only when it was checked: that says it's all done.
    if (header || todo.length) hooks.todo?.(todo);
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
