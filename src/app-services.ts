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
import { execFile } from 'node:child_process';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ContraptionRow } from './db.ts';

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
  return { start: command(m.start, 'start'), workdir: relDir(m.workdir, 'workdir'), env, timers, health: m.health ?? null };
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

/** The unit name for a contraption, or one of its jobs. */
export const unitName = (name: string, job?: string) => `citadel-app-${name}${job ? `-${job}` : ''}`;

/** Every unit file for an app, by file name. Pure: the tests check it as text. */
export function unitFiles({ row, manifest, folder, keysDir, citadelUrl, home }: UnitInputs): Map<string, string> {
  const env = {
    // Toolchains mise installs, then the usual: a user unit's PATH has neither ~/.local/bin nor mise's shims.
    PATH: `${join(home, '.local/share/mise/shims')}:${join(home, '.local/bin')}:/usr/local/bin:/usr/bin:/bin`,
    ...Object.fromEntries(Object.entries(manifest.env).map(([k, v]) => [k, tilde(v, home)])),
    PORT: String(row.port),
    DATA_DIR: join(home, '.local/share', row.name),
    CITADEL_KEYS: keysDir,
    CITADEL_URL: citadelUrl,
    BASE_PATH: `/apps/${row.name}`,
  };
  const envLines = Object.entries(env).map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`);
  // WorkingDirectory takes the rest of the line as the path, unquoted.
  const dir = (rel: string) => `WorkingDirectory=${(rel === '.' ? folder : join(folder, rel)).replace(/%/g, '%%')}`;
  const head = [OWNED(row.name), `# Citadel rewrites it on install and deploy: change the app's ${MANIFEST} or its entry in Settings → Contraptions, not this file.`];
  const files = new Map<string, string>();
  files.set(`${unitName(row.name)}.service`, [
    ...head,
    '[Unit]', `Description=${row.title.replace(/[%\\]/g, '')} (Citadel contraption)`, 'After=network.target', 'StartLimitIntervalSec=0', '',
    '[Service]', dir(manifest.workdir), `ExecStart=${execLine(manifest.start, home)}`, ...envLines, 'Restart=on-failure', 'RestartSec=5', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n'));
  for (const [job, t] of Object.entries(manifest.timers)) {
    files.set(`${unitName(row.name, job)}.service`, [
      ...head,
      '[Unit]', `Description=${row.title.replace(/[%\\]/g, '')}: ${job} (Citadel contraption job)`, '',
      '[Service]', 'Type=oneshot', dir(t.workdir), `ExecStart=${execLine(t.command, home)}`, ...envLines, '',
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
}

/** Defaults from the environment: CITADEL_SYSTEMCTL and CITADEL_JOURNALCTL stand in for the real ones (tests). */
export function serviceOptions(env: NodeJS.ProcessEnv, liveData: boolean, bootCheck: boolean, rest: Pick<ServiceOptions, 'keysDir' | 'citadelUrl'>): ServiceOptions {
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
    ...rest,
  };
}

const run = (bin: string, args: string[], timeout = 60_000) => new Promise<Ran>((ok) => {
  execFile(bin, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err: any, out, errText) => ok({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(out), err: String(errText || (err && !out ? err.message : '')) }));
});

export class AppServices {
  readonly opts: ServiceOptions;

  constructor(opts: ServiceOptions) {
    this.opts = opts;
  }

  /** The app's folder: where its repo is checked out. */
  folder(row: Pick<ContraptionRow, 'name'>): string {
    return join(this.opts.home, 'apps', row.name);
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
  async manifest(row: Pick<ContraptionRow, 'name'>, folder = this.folder(row)): Promise<Manifest> {
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
  async handInstalled(row: Pick<ContraptionRow, 'name' | 'port'>): Promise<HandUnit[]> {
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

  private async installNow(row: ContraptionRow, opts: { replace?: boolean; all?: ContraptionRow[] }): Promise<string[]> {
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
    const said: string[] = [];
    const live = (await this.handInstalled(row)).filter((u) => u.active === 'active' || u.active === 'activating' || /^enabled/.test(u.enabled));
    if (live.length && !opts.replace) {
      throw new ServiceError(409, `Hand-installed units run ${row.name} already: ${live.map((u) => `${u.unit} (${u.active}, ${u.enabled || 'no file state'}; ${u.why})`).join('; ')}. Install again with replace to stop and disable them first; their files stay.`);
    }
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
  async act(row: ContraptionRow, action: 'start' | 'stop' | 'restart'): Promise<UnitState> {
    this.guard();
    const main = `${unitName(row.name)}.service`;
    if (!(await this.owned(row.name)).includes(main)) throw new ServiceError(409, `${row.title} has no service yet: install it first.`);
    await this.must(action, main);
    return this.state(main);
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
