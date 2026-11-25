// What a closed minion left running (#1365, the reliability lens's RL5): a dev server, a watcher, a container turn's
// background job re-parented to the container's init. Close stops its preview and deletes its temp folder, and before
// this nothing stopped its processes. The reaper finds them by folder and stops each by pid: TERM, then KILL.
//
// Whose a process is: the minion whose worktree (projects/<p>/tickets/<id>) or temp folder (projects/<p>/tmp/<id>) holds
// its working folder; else, when its working folder is in none, the one minion whose folder its command line names
// (two named: nobody's). A container turn's processes show in the host's /proc with the same paths, since the projects
// folder is mounted at its own path (src/claude-link.ts).
//
// What it never touches, whatever its folder: a process at or under the server itself or a turn's wrapper (an open
// minion's turn, a Taskmaster's `git -C` into a closed minion's worktree; a supervisor turn's shell, src/turn-run.mjs SHIM, #1343); one in a ship, deploy, kit-sync, ultra review
// or tool-pool unit, a contraption's service or the server's own unit; one in a person's login session or with a
// terminal (a person's own shell, its children too, and what holds its terminal: script, tmux, a terminal app); another account's; and any minion's that isn't closed when it is
// read again right before the kill. Never by name (the tripwire's rule): only pids matched by folder, each checked to be
// the same process (pid and start time) before each signal.
//
// It reads /proc with async calls, off the server's thread (src/runner.ts's wrapperInProc is the synchronous one).
import { SHIM } from './turn-run.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, readFile, readlink, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** One process of this account, as /proc tells it. */
export interface Proc {
  pid: number;
  ppid: number;
  /** Start time in clock ticks since boot (stat field 22): with the pid, which process this is. */
  start: string;
  /** Controlling terminal (stat field 7): non-zero for a process run from a person's terminal. */
  tty: number;
  /** Working folder, or null when it can't be read. */
  cwd: string | null;
  argv: string[];
  /** The cgroup v2 path (`0::<path>`), or '' where there is none. */
  cgroup: string;
  /** User plus system CPU time, seconds. */
  cpuS: number;
  /** Seconds since it started. */
  ageS: number;
}

/** A minion's process the reaper found, with whose it is. */
export interface Owned {
  proc: Proc;
  ticketId: number;
  projectId: number;
}

/** The units whose processes are never reaped: ships and deploys (citadel-builds.slice, and each job's own unit), kit sync,
 * ultra reviews, the turns' shared tool server, the watchdog and embed services, and the server's own unit. */
const GUARDED_UNIT = /^(citadel-(land|ultrareview|fast-verify|kit-sync|mcp-pool)-|citadel-(watchdog|embed)\.|claude-coordinator[.@-])/;

/** Whether a cgroup path is one whose processes are never reaped: a person's login session, a ship or deploy, a contraption. */
export function guardedCgroup(cgroup: string): boolean {
  const parts = cgroup.split('/');
  return parts.some((p) => /^session-.+\.scope$/.test(p) || p === 'citadel-builds.slice' || p === 'contraptions.slice' || GUARDED_UNIT.test(p));
}

const CLK_TCK = 100; // Linux's USER_HZ on every architecture Citadel runs on

/** The fields of /proc/<pid>/stat after the command's closing parenthesis, or null for a zombie or a gone process. */
function statFields(text: string): string[] | null {
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return fields[0] === 'Z' || fields[0] === 'X' ? null : fields;
}

/** The start time of `pid` (as Proc.start), or null when it is gone or a zombie. */
export async function startOf(pid: number): Promise<string | null> {
  try {
    return statFields(await readFile(`/proc/${pid}/stat`, 'utf8'))?.[19] ?? null;
  } catch {
    return null;
  }
}

async function uptimeS(): Promise<number> {
  try {
    return Number((await readFile('/proc/uptime', 'utf8')).split(' ')[0]) || 0;
  } catch {
    return 0;
  }
}

async function readProc(pid: number, uid: number, now: number): Promise<Proc | null> {
  try {
    if ((await stat(`/proc/${pid}`)).uid !== uid) return null;
    const fields = statFields(await readFile(`/proc/${pid}/stat`, 'utf8'));
    if (!fields) return null;
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    if (argv.at(-1) === '') argv.pop();
    if (!argv.length) return null; // a kernel thread
    const cwd = await readlink(`/proc/${pid}/cwd`).catch(() => null);
    const cgroup = /^0::(.*)$/m.exec(await readFile(`/proc/${pid}/cgroup`, 'utf8').catch(() => ''))?.[1] ?? '';
    return {
      pid,
      ppid: Number(fields[1]),
      start: fields[19],
      tty: Number(fields[4]),
      cwd,
      argv,
      cgroup,
      cpuS: (Number(fields[11]) + Number(fields[12])) / CLK_TCK,
      ageS: Math.max(0, now - Number(fields[19]) / CLK_TCK),
    };
  } catch {
    return null; // ended meanwhile
  }
}

/** Every live process of this account, read a batch at a time so a sweep holds few files open. */
export async function scanProcs(): Promise<Proc[]> {
  const uid = process.getuid!();
  const now = await uptimeS();
  let names: string[];
  try {
    names = (await readdir('/proc')).filter((n) => /^\d+$/.test(n));
  } catch {
    return []; // no /proc: nothing can be matched, so nothing is reaped
  }
  const out: Proc[] = [];
  for (let i = 0; i < names.length; i += 64) {
    for (const p of await Promise.all(names.slice(i, i + 64).map((n) => readProc(Number(n), uid, now)))) if (p) out.push(p);
  }
  return out;
}

/** A minion's folder that `path` is in or is: its project, its id and which folder. Null for anything else. */
export function folderOf(projectsRoot: string, path: string): { projectId: number; ticketId: number } | null {
  if (!path.startsWith(projectsRoot + '/')) return null;
  // Close removes the scratch folder before it reaps, so a process still in it reads `…/tmp/<id> (deleted)`.
  path = path.replace(/ \(deleted\)$/, '');
  const m = /^(\d+)\/(tickets|tmp)\/(\d+)(\/|$)/.exec(path.slice(projectsRoot.length + 1));
  return m ? { projectId: Number(m[1]), ticketId: Number(m[3]) } : null;
}

/** Whose process `p` is by its folders (the header's rule), or null. */
export function ownerOf(projectsRoot: string, p: Proc): { projectId: number; ticketId: number } | null {
  const byCwd = p.cwd ? folderOf(projectsRoot, p.cwd) : null;
  if (byCwd) return byCwd;
  // A working folder elsewhere under the projects folder (a scheme's main checkout: a Taskmaster's) names its owner as nobody.
  if (p.cwd && p.cwd.startsWith(projectsRoot + '/')) return null;
  const named = new Map<string, { projectId: number; ticketId: number }>();
  for (const arg of p.argv) {
    for (const part of [arg, arg.slice(arg.indexOf('=') + 1)]) {
      const f = folderOf(projectsRoot, part);
      if (f) named.set(`${f.projectId}/${f.ticketId}`, f);
    }
  }
  return named.size === 1 ? [...named.values()][0] : null;
}

/** The pids that are, or are under, a process the reaper never touches (the header's list). */
export function guardedPids(procs: Proc[], o: { selfPid: number; wrapperMark: string | readonly string[]; guardCgroup: (cg: string) => boolean }): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const marks = typeof o.wrapperMark === 'string' ? [o.wrapperMark] : o.wrapperMark;
  const own = (p: Proc) => p.pid === o.selfPid || p.tty !== 0 || o.guardCgroup(p.cgroup) || marks.some((m) => !!p.argv.at(-2)?.endsWith(m)) || (p.argv[1] === '-c' && p.argv[2] === SHIM);
  const memo = new Map<number, boolean>();
  const guarded = (p: Proc): boolean => {
    const known = memo.get(p.pid);
    if (known !== undefined) return known;
    memo.set(p.pid, false); // a cycle (a pid reused mid-scan) ends here
    const parent = byPid.get(p.ppid);
    const g = own(p) || (!!parent && parent.pid !== p.pid && guarded(parent));
    memo.set(p.pid, g);
    return g;
  };
  const out = new Set(procs.filter(guarded).map((p) => p.pid));
  // What holds a terminal (script, a tmux server) has none itself; killing it would hang up the shell in it.
  for (const p of procs) {
    if (p.tty === 0) continue;
    for (let up = byPid.get(p.ppid), n = 0; up && n < 64 && !out.has(up.pid); up = byPid.get(up.ppid), n++) out.add(up.pid);
  }
  return out;
}

/** A command line as people may see it: tokens, keys and passwords in it masked, and cut to 160 characters. */
export function shownCommand(argv: string[]): string {
  return argv
    .join(' ')
    .replace(/\bBearer \S+/g, 'Bearer …')
    .replace(/(:\/\/)[^\s/@]+@/g, '$1…@')
    .replace(/((?:token|key|secret|password|passwd|auth|cookie|credential)[\w-]*[=: ]+)\S+/gi, '$1…')
    .replace(/[A-Za-z0-9+/_-]{32,}/g, '…')
    .slice(0, 160);
}

/** A turn supervisor's folder, from its command line (`<node> <folder>/turn-supervisor.mjs <folder> <version>`, src/supervisor-client.ts), or null for any other process. */
export function supervisorHome(argv: string[]): string | null {
  return argv.length >= 4 && argv[1] === join(argv[2], 'turn-supervisor.mjs') ? argv[2] : null;
}

/**
 * Whether no runner will hand the supervisor in `home` a turn again (#1758): its folder is gone (a test's data
 * deleted), or it is a test server's in a ship whose land.sh has ended (`run/landings/<n>/tmp/…`, kept 14 days).
 */
export async function supervisorOrphaned(home: string, landingsRoots: string[]): Promise<boolean> {
  try {
    await stat(home);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT';
  }
  for (const root of landingsRoots) {
    const n = home.startsWith(root + '/') && /^(\d+)\/tmp\//.exec(home.slice(root.length + 1))?.[1];
    if (n)
      return stat(join(root, n, 'code')).then(
        () => true,
        () => false,
      );
  }
  return false;
}

/** What the reaper reads and writes of the store. */
export interface ReaperStore {
  getTicket(id: number): { id: number; number: number; title: string; project_id: number; kind: string; status: string } | undefined;
  addHealthEvent(kind: string, at: number, commit: string | null, detail: string): unknown;
}

export interface ReaperOptions {
  store: ReaperStore;
  dataDir: string;
  /** The commit live, for the health rows. */
  commit?: string | null;
  selfPid?: number;
  /** What a turn wrapper's command line has second to last (src/turn-launch.ts: `<node> <pin>/turn-wrapper.mjs <dir>`; `.ts` before #1343). */
  wrapperMark?: string | readonly string[];
  guardCgroup?: (cgroup: string) => boolean;
  scan?: () => Promise<Proc[]>;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** `systemctl --user stop`, for a supervisor's unit whose process ignored TERM. */
  stopUnit?: (unit: string) => Promise<unknown>;
  /** How long a process has after TERM before KILL. */
  termWaitMs?: number;
  log?: (line: string) => void;
}

/** One process a reap stopped (or found gone), as its health row says it. */
export interface Reaped {
  ticket: number;
  number: number;
  scheme: number;
  pid: number;
  command: string;
  cpuS: number;
  ageS: number;
  signal: 'TERM' | 'KILL';
}

/** The health_events kind of a reaped process. */
export const REAPED = 'reaped';

/** The turn wrapper's file, as a turn started now (.mjs) or before #1343 (.ts) runs it. */
export const WRAPPER_MARKS = ['/turn-wrapper.mjs', '/turn-wrapper.ts'] as const;

export class Reaper {
  private readonly o: Required<Omit<ReaperOptions, 'commit'>> & { commit: string | null };
  readonly projectsRoot: string;
  /** Ships' folders (src/land.ts), as given and as resolved: a test's tmpdir() may name either. */
  private readonly landingsRoots: string[];

  constructor(o: ReaperOptions) {
    const root = join(o.dataDir, 'projects');
    let real = root;
    try {
      real = realpathSync(root);
    } catch {
      /* not made yet: the path as given */
    }
    this.projectsRoot = real;
    this.landingsRoots = [...new Set([join(resolve(o.dataDir), 'run', 'landings'), join(dirname(real), 'run', 'landings')])];
    this.o = {
      store: o.store,
      dataDir: o.dataDir,
      commit: o.commit ?? null,
      selfPid: o.selfPid ?? process.pid,
      wrapperMark: o.wrapperMark ?? WRAPPER_MARKS,
      guardCgroup: o.guardCgroup ?? guardedCgroup,
      scan: o.scan ?? scanProcs,
      kill: o.kill ?? ((pid, sig) => process.kill(pid, sig)),
      stopUnit: o.stopUnit ?? ((unit) => promisify(execFile)('systemctl', ['--user', 'stop', unit], { timeout: 30_000 })),
      termWaitMs: o.termWaitMs ?? 5000,
      log: o.log ?? ((l) => console.log(l)),
    };
  }

  /** Every minion's process this account runs, guarded ones left out, with whose it is (any status). */
  async owned(): Promise<Owned[]> {
    const procs = await this.o.scan();
    const guarded = guardedPids(procs, this.o);
    const out: Owned[] = [];
    for (const proc of procs) {
      if (guarded.has(proc.pid)) continue;
      const owner = ownerOf(this.projectsRoot, proc);
      if (owner) out.push({ proc, ...owner });
    }
    return out;
  }

  private listed: { at: number; rows: Promise<Owned[]> } | null = null;
  /** owned(), read at most every 30 s, for the host-load page, which asks again every few seconds. */
  running(now = Date.now()): Promise<Owned[]> {
    if (!this.listed || now - this.listed.at > 30_000 || this.listed.at < this.reapedAt) this.listed = { at: now, rows: this.owned().catch(() => []) };
    return this.listed.rows;
  }
  private reapedAt = 0; // a reap since the last read makes the page read /proc again

  /** The minion `ticketId` if it is a closed minion of `projectId` (not a Taskmaster), read now. */
  private closed(ticketId: number, projectId: number) {
    const t = this.o.store.getTicket(ticketId);
    return t && t.project_id === projectId && t.kind !== 'coordinator' && t.status === 'closed' ? t : null;
  }

  /** TERM each, then KILL what is still there after termWaitMs; each checked to be the same process before each signal. */
  private async stop<T extends { proc: Proc }>(found: T[]): Promise<{ sent: T[]; killed: Set<number> }> {
    const sent: T[] = [];
    for (const x of found) {
      if ((await startOf(x.proc.pid)) !== x.proc.start) continue; // gone, or the pid is another process now
      try {
        this.o.kill(x.proc.pid, 'SIGTERM');
        sent.push(x);
      } catch {
        /* gone meanwhile */
      }
    }
    const killed = new Set<number>();
    const deadline = Date.now() + this.o.termWaitMs;
    let left = sent;
    while (left.length && Date.now() < deadline) {
      await sleep(200);
      left = (await Promise.all(left.map(async (x) => ((await startOf(x.proc.pid)) === x.proc.start ? x : null)))).filter((x): x is T => !!x);
    }
    for (const x of left) {
      if ((await startOf(x.proc.pid)) !== x.proc.start) continue;
      try {
        this.o.kill(x.proc.pid, 'SIGKILL');
        killed.add(x.proc.pid);
      } catch {
        /* gone meanwhile */
      }
    }
    return { sent, killed };
  }

  /**
   * Stop turn supervisors no runner will use again (supervisorOrphaned): test servers' left in their own units, which a
   * test's kill by pid doesn't end (#1758). TERM ends one cleanly, so its unit's Restart=on-failure doesn't bring it back.
   */
  async reapSupervisors(): Promise<number[]> {
    const found: { proc: Proc; home: string }[] = [];
    for (const proc of await this.o.scan()) {
      const home = supervisorHome(proc.argv);
      if (home && proc.pid !== this.o.selfPid && (await supervisorOrphaned(home, this.landingsRoots))) found.push({ proc, home });
    }
    if (!found.length) return [];
    const { sent, killed } = await this.stop(found);
    // KILLed, Restart=on-failure would bring it back from its folder (a finished ship's still has one): stop its unit too.
    for (const x of sent) {
      const unit = killed.has(x.proc.pid) && /\/(citadel-supervisor-[^/]+\.service)$/.exec(x.proc.cgroup)?.[1];
      if (unit) await this.o.stopUnit(unit).catch((err) => this.o.log(`Stopping ${unit} failed: ${(err as Error).message}`));
    }
    for (const x of sent) this.o.log(`Stopped turn supervisor pid ${x.proc.pid} (${killed.has(x.proc.pid) ? 'KILL' : 'TERM'}): nothing will hand it a turn again, ${x.home}`);
    if (sent.length) this.reapedAt = Date.now();
    return sent.map((x) => x.proc.pid);
  }

  /** Stop what closed minions left running: only `ticketId`'s when given (its close), else every closed minion's (the sweep). */
  async reap(ticketId?: number): Promise<Reaped[]> {
    const found = (await this.owned()).filter((x) => (ticketId === undefined || x.ticketId === ticketId) && this.closed(x.ticketId, x.projectId));
    if (!found.length) return [];
    // Read again at the kill: a minion reopened while /proc was read keeps its processes.
    const { sent, killed } = await this.stop(found.filter((x) => this.closed(x.ticketId, x.projectId)));
    const now = Date.now();
    this.reapedAt = now;
    return sent.map((x) => {
      const t = this.o.store.getTicket(x.ticketId)!;
      const r: Reaped = { ticket: x.ticketId, number: t.number, scheme: x.projectId, pid: x.proc.pid, command: shownCommand(x.proc.argv), cpuS: Math.round(x.proc.cpuS), ageS: Math.round(x.proc.ageS), signal: killed.has(x.proc.pid) ? 'KILL' : 'TERM' };
      this.o.store.addHealthEvent(REAPED, now, this.o.commit, JSON.stringify(r));
      this.o.log(`Reaped pid ${r.pid} of closed minion #${r.number} (${r.signal}, ${r.cpuS} s of CPU over ${Math.round(r.ageS / 60)} min): ${r.command}`);
      return r;
    });
  }
}

/** One minion's processes on the host-load page. */
export interface MinionProcs {
  ticket: number;
  number: number;
  title: string;
  scheme: string;
  schemeId: number;
  status: string;
  procs: { pid: number; command: string; cpuS: number; ageS: number }[];
}

/** `owned` grouped by minion, for the schemes `canSee` lets the viewer see, most CPU first. */
export function byMinion(owned: Owned[], store: ReaperStore & { getProject(id: number): { name: string } | undefined }, canSee: (projectId: number) => boolean): MinionProcs[] {
  const rows = new Map<number, MinionProcs>();
  for (const x of owned) {
    const t = store.getTicket(x.ticketId);
    if (!t || t.project_id !== x.projectId || t.kind === 'coordinator' || !canSee(x.projectId)) continue;
    const row = rows.get(t.id) ?? rows.set(t.id, { ticket: t.id, number: t.number, title: t.title, scheme: store.getProject(t.project_id)?.name ?? '', schemeId: t.project_id, status: t.status, procs: [] }).get(t.id)!;
    row.procs.push({ pid: x.proc.pid, command: shownCommand(x.proc.argv), cpuS: Math.round(x.proc.cpuS), ageS: Math.round(x.proc.ageS) });
  }
  const cpu = (r: MinionProcs) => r.procs.reduce((a, p) => a + p.cpuS, 0);
  return [...rows.values()].sort((a, b) => cpu(b) - cpu(a));
}

/** The week's reaped processes (health rows), newest first, for the schemes `canSee` lets the viewer see. */
export function reapedRows(events: { at: number; detail: string }[], store: { getProject(id: number): { name: string } | undefined }, canSee: (projectId: number) => boolean): (Reaped & { at: number; schemeName: string })[] {
  const out: (Reaped & { at: number; schemeName: string })[] = [];
  for (const e of events) {
    let r: Reaped;
    try {
      r = JSON.parse(e.detail);
    } catch {
      continue;
    }
    if (!Number.isInteger(r?.scheme) || !canSee(r.scheme)) continue;
    out.push({ ...r, at: e.at, schemeName: store.getProject(r.scheme)?.name ?? '' });
  }
  return out.reverse();
}
