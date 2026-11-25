// The nightly screenshots of every contraption (#1783, Cara's pick, 2026-11-24: "a broken page shows up without anyone
// opening it"). Once a night after 5 AM Pacific (after the backups) this
// starts tools/app-shots/app-shots.ts in a scope of its own, which shoots sealed copies of the apps, writes the nights
// to <data dir>/app-shots and the page people look at to each home scheme's shared folder, and calls no model. When the
// night is in, each problem that wasn't open the night before is told once to its app's home scheme's Taskmaster (Citadel's
// own for an app with none), not 2-9 AM Pacific. A break wakes it. A big layout change on an app that shipped since, or
// on any app once Citadel UI's own files changed, is held mail: it is most likely the ship, seen.
// The run mark moves before the run starts, so two ticks (or two servers) never start two, and a run that dies is started
// once more and then told to Citadel's own Taskmaster.
import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { quietUntil } from './alert-wakes.ts';
import { appFolder } from './app-services.ts';
import type { ContraptionRow, Store } from './db.ts';
import { every, type Job } from './every.ts';
import { pacificDay, pacificStamp, ZONE } from './pacific.ts';
import { problems, where, type AppNight, type Night, type Problem } from './shot-judge.ts';
import { redact } from './timer-alerts.ts';
import { turnEnv } from './turn-launch.ts';

const POLL_MS = 5 * 60_000;
/** The hour it may start in, Pacific: after the nightly backups and before anyone is up. A night missed is skipped. */
const FROM_HOUR = 5;
const TO_HOUR = 8;
/** A run still going after this is dead. */
export const RUN_MS = 2 * 3600_000;
const SETTLE_MS = 60_000;
const TRIES = 2;
/** What the run's own failures are told under. */
const RUN_TITLE = 'The screenshot run';
/** Settings key. */
export const STATE = 'app-shots';
/** The gallery's folder in a scheme's shared folder. */
export const PAGE_DIR = 'reports/app-shots';

/** An app to shoot, as tools/app-shots/app-shots.ts reads it. */
export interface AppSpec {
  app: string;
  title: string;
  scheme: number | null;
  /** Its deployed checkout, and the app's folder in it (a scheme's repo may hold several). */
  folder: string;
  subdir: string | null;
  /** Where its page goes: its home scheme's shared folder, or null. */
  page: string | null;
}
/** The apps file. `all`: where the page of every app goes. */
export interface Apps {
  apps: AppSpec[];
  all: string | null;
}

type How = 'wake' | 'mail' | 'report';
interface Open {
  scheme: number;
  text: string;
  /** How it is to be told, until it is; 'report' is the run's own failure. */
  owed: How | null;
  /** How it would have been told while watching only (the judge log-only): owed once the judge acts, if still broken. */
  would?: How;
  title: string;
}
interface State {
  /** The run started last. */
  run: { day: string; at: number; tries: number; pid: number } | null;
  /** The night read last. */
  read: string | null;
  open: Record<string, Open>;
}

export interface AppShotsDeps {
  /** Where the nights are kept. */
  dir: string;
  home: string;
  /** A scheme's shared folder; null for none. */
  sharedDir: (scheme: number) => string | null;
  /** The scheme whose repo this server is: apps with no home scheme, and the run's own failures, go there (0: none). */
  citadel: () => number;
  wake: (scheme: number, text: string) => boolean;
  mail: (scheme: number, text: string) => boolean;
  /** The run's own failure, held mail too: said while watching only as well, or a run that never works would look like a clean week. */
  report: (scheme: number, text: string) => boolean;
  /** Broken pages are only noted, not told (wake and mail are the judge's log-only stand-ins). */
  watching: boolean;
  /** Start the run; its pid. */
  start: (o: { dir: string; day: string; appsFile: string }) => Promise<number>;
  alive: (pid: number) => Promise<boolean>;
  kill: (pid: number) => void;
  now?: () => number;
}

/** The run, in a scope of its own (tools/heavy-unit), so a restart of the server doesn't stop it and its memory isn't the server's. */
export async function startRun(o: { dir: string; day: string; appsFile: string }): Promise<number> {
  const tools = join(import.meta.dirname, '..', 'tools');
  const env = Object.fromEntries(Object.entries(turnEnv(process.env)).filter(([k]) => !/^(CLAUDE_|ANTHROPIC_)/.test(k)));
  const log = await open(join(o.dir, 'run.log'), 'w');
  try {
    const child = spawn('nice', ['-n', '10', join(tools, 'heavy-unit'), '--exec', '--what', 'contraption screenshots', process.execPath, join(tools, 'app-shots', 'app-shots.ts'), '--out', o.dir, '--apps', o.appsFile, '--day', o.day], { env, detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.on('error', (e) => console.error('Starting the contraption screenshots failed:', e.message));
    child.unref();
    return child.pid ?? 0;
  } finally {
    await log.close();
  }
}

/** Whether a run's pid is still that run (a pid is reused after a restart). */
export async function runAlive(pid: number): Promise<boolean> {
  try {
    return pid > 0 && (await readFile(`/proc/${pid}/cmdline`, 'utf8')).includes('app-shots.ts');
  } catch {
    return false;
  }
}

/** Its own handler stops the room it has open. */
export function killRun(pid: number) {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {} // gone already
}

const hour = (t: number) => Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hourCycle: 'h23', hour: 'numeric' }).format(t));

/** A problem as a Taskmaster reads it. */
const line = (p: Problem) => `- ${p.page === null ? 'The app' : `${p.page === '/' ? 'Front page' : p.page.replace(/^> /, 'Tab ')}${p.width === null ? '' : ` (${where(p.width)})`}`}: ${redact(p.text).replace(/\s+/g, ' ')}`;

const laidTo = (a: AppNight, p: Problem) => (p.since === 'kit' ? ", and Citadel UI's own files changed since" : p.since === 'ship' ? `, and it shipped since (now ${a.head?.slice(0, 9)})` : ', and nothing shipped since');

export class AppShots {
  private store: Store;
  private deps: AppShotsDeps;
  private busy = false;
  private timer: Job | null = null;

  constructor(store: Store, deps: AppShotsDeps) {
    this.store = store;
    this.deps = deps;
  }

  start() {
    this.timer ??= every('contraption screenshots', POLL_MS, () => this.tick(), 60_000);
  }

  private state(): State {
    return { run: null, read: null, open: {}, ...this.store.getSetting<Partial<State>>(STATE) };
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.read();
      this.tell();
      await this.maybeStart();
    } finally {
      this.busy = false;
    }
  }

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private async maybeStart() {
    const s = this.state(),
      now = this.now(),
      day = pacificDay(now);
    const going = s.run && s.read !== s.run.day ? s.run : null;
    // A pid just started may still be on its way to being the run (two execs in a row).
    if (going && now - going.at < SETTLE_MS) return;
    if (going && (await this.deps.alive(going.pid))) {
      if (now - going.at < RUN_MS) return;
      this.deps.kill(going.pid);
    }
    if (going && going.tries >= TRIES) return this.gaveUp(going.day);
    // A run that died is started again the same night.
    const again = going?.day === day;
    const off = hour(now) < FROM_HOUR || hour(now) >= TO_HOUR;
    if (going && (!again || off)) return this.gaveUp(going.day);
    if (off || (!again && s.run?.day === day)) return;
    const appsFile = await this.appsFile();
    // The mark first: a start that throws or a server that stops here counts as one try.
    const run = { day, at: now, tries: again ? going.tries + 1 : 1, pid: 0 };
    this.store.setSetting(STATE, { ...this.state(), run });
    const pid = await this.deps.start({ dir: this.deps.dir, day, appsFile });
    this.store.setSetting(STATE, { ...this.state(), run: { ...run, pid } });
  }

  private async appsFile(): Promise<string> {
    const page = (scheme: number | null) => {
      const dir = scheme === null || !scheme ? null : this.deps.sharedDir(scheme);
      return dir && join(dir, PAGE_DIR);
    };
    const apps: AppSpec[] = this.store.listContraptions().map((c: ContraptionRow) => ({ app: c.name, title: c.title, scheme: c.home_scheme, folder: appFolder(c, this.deps.home), subdir: c.subdir, page: page(c.home_scheme) }));
    await mkdir(this.deps.dir, { recursive: true });
    const file = join(this.deps.dir, 'apps.json');
    await writeFile(`${file}.tmp`, JSON.stringify({ apps, all: page(this.deps.citadel()) } satisfies Apps));
    await rename(`${file}.tmp`, file);
    return file;
  }

  /** Both tries of a night died: told once, as held mail, and the next night starts afresh. */
  private async gaveUp(day: string) {
    const log = await readFile(join(this.deps.dir, 'run.log'), 'utf8').catch(() => '');
    const s = this.state();
    s.read = day;
    s.open['run'] = {
      scheme: this.deps.citadel(),
      title: RUN_TITLE,
      owed: 'report',
      text: `The nightly contraption screenshots of ${day} didn't finish (${TRIES} tries at most), so no app was checked that night. The end of ${join(this.deps.dir, 'run.log')}: ${redact(log.slice(-600)).replace(/\s+/g, ' ') || '(empty)'}`,
    };
    this.store.setSetting(STATE, s);
  }

  /** A night that is in: its new problems become owed, and the ones it no longer has are closed. */
  private async read() {
    const s = this.state();
    if (!s.run || s.read === s.run.day) return;
    const file = join(this.deps.dir, s.run.day, 'night.json');
    const text = await readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e; // not in yet
    });
    if (text === undefined) return;
    const night: Night = JSON.parse(text);
    const open: State['open'] = {};
    for (const a of night.apps) {
      const scheme = a.scheme ?? this.deps.citadel();
      for (const [k, o] of Object.entries(s.open)) if (a.unshot !== null && k.startsWith(`${a.app}|`)) open[k] = o;
      if (a.unshot !== null) {
        // The run's own failure is Citadel's to fix, not the app's scheme's.
        const k = `run|${a.app}`;
        open[k] = s.open[k] ?? { scheme: this.deps.citadel(), title: RUN_TITLE, owed: 'report', text: `${a.title} (${a.app}) couldn't be shot: ${redact(a.unshot).replace(/\s+/g, ' ').slice(-400)}` };
        continue;
      }
      for (const p of problems(a)) {
        const moved = p.kind === 'layout' || p.kind === 'gone';
        const quiet = moved && p.since !== null;
        // What moved is news each time; anything else stays told while it stays broken.
        const old = moved ? undefined : s.open[p.key];
        open[p.key] = old ?? { scheme, title: `${a.title} (${a.app})`, owed: quiet ? 'mail' : 'wake', text: line(p) + (moved ? laidTo(a, p) : '') };
      }
    }
    this.store.setSetting(STATE, { ...s, read: night.day, open });
  }

  /** Each scheme's owed problems in one message, outside 2-9 AM Pacific. */
  private tell() {
    const s = this.state(),
      now = this.now();
    if (quietUntil(now) !== null) return;
    if (!this.deps.watching) for (const o of Object.values(s.open)) if (o.would) [o.owed, o.would] = [o.would, undefined];
    const owed = Object.entries(s.open).filter(([, o]) => o.owed);
    for (const scheme of new Set(owed.map(([, o]) => o.scheme)))
      for (const how of ['wake', 'mail', 'report'] as const) {
        const mine = owed.filter(([, o]) => o.scheme === scheme && o.owed === how);
        if (
          !mine.length ||
          !this.deps[how](
            scheme,
            this.words(
              scheme,
              how,
              mine.map(([, o]) => o),
            ),
          )
        )
          continue;
        for (const [k, o] of mine) s.open[k] = { ...o, owed: null, would: this.deps.watching && how !== 'report' ? how : undefined };
        this.store.setSetting(STATE, s);
      }
  }

  private words(scheme: number, how: How, mine: Open[]): string {
    const apps = [...new Set(mine.map((o) => o.title))];
    const shared = this.deps.sharedDir(scheme);
    const body = apps.map((t) => {
      const all = mine.filter((o) => o.title === t).map((o) => o.text);
      return `${t}:\n${all.slice(0, 8).join('\n')}${all.length > 8 ? `\n- and ${all.length - 8} more` : ''}`;
    });
    return [
      how === 'wake' ? `Last night's contraption screenshots found something newly broken (${pacificStamp(this.now())}).` : 'From the nightly contraption screenshots, no action needed unless it looks wrong.',
      ...body,
      mine.every((o) => o.title === RUN_TITLE)
        ? ''
        : `${shared ? `The pictures: ${join(shared, PAGE_DIR)} (one page per app, also under Files). ` : ''}Each app was shot as a throwaway copy of its deployed checkout: no network, empty data, signed in as the test person, two tries agreeing. So real data can't cause or hide it. Said once; it isn't repeated while it stays broken.`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
}
