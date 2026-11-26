// The land tool (#213): a minion whose turn runs in its person's container can't run tools/land.sh
// there (no deploy lock, user bus or GitHub login), so the server runs it on the host, in the minion's
// worktree, as a host turn would. Its tests and boot check run as the server's user: landing is as
// trusted as it was before containers. That holds for every scheme's minions (#574): a container turn
// that lands runs its worktree's land.sh on the host, with the box's GitHub login.
//
// It runs as a host job (src/host-job.ts, #508), in a unit of its own: a restart of
// the server neither kills it nor waits for it, and its output and exit code go to files under
// run/landings/<minion>/, so the next server reports them to the tool still polling. Without units
// (tests, a dev copy) or when systemd-run fails, it runs as the server's child, which a restart would
// cut off: only those count toward the runner's interruptible().
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { access, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { faultPoint } from './fault-points.ts';
import { HostJobs } from './host-job.ts';
import type { Probe } from './live-probe.ts';
import { pacificStamp } from './pacific.ts';
import { thrown } from './thrown.ts';

export interface Landing {
  /** The tail of what land.sh printed so far. */
  output: string;
  /** Its exit code once it ended, null while it runs. */
  code: number | null;
}

const MAX_OUTPUT = 64 * 1024;
/** Finished landings' folders older than this go at the daily prune (server.ts). */
const KEEP_MS = 14 * 24 * 3600_000;
/** Said when the wrapper ended without writing a code: its unit was stopped, or a restart cut off a child. */
export const NO_CODE = '\n[land.sh ended without an exit code: it was stopped, or a restart cut it off. Check `git log main`.]';

const HANDOFF = 'handoff.json';
const STOPPED = 'stopped.json';
/** The steps a hand-off's report already did (C2, #1406); a new landing's folder starts without it. */
const REPORTED = 'reported.json';

/** What the minion says about the change it hands off (hand_off_land), for the shipped line. */
export interface Handoff {
  summary: string;
  risk: 'low' | 'medium' | 'high';
  reason: string;
  /** With risk high: who gave the go, and when. */
  go?: string;
  /** False: the scheme's apps aren't deployed after the land (#712), for a change with nothing to serve. */
  deploy?: false;
  /** True (#909): the brief has more pieces for this minion, so a clean land leaves it open (ready) instead of dismissing it. */
  stayOpen?: true;
  /** With stayOpen: what it waits on next. It is never sealed (#942): once its work is live it is woken with the shipped line, for its after-land steps. */
  waitingOn?: string;
  /** Its three lines (#1119, src/ship-lessons.ts): what it had to find out; '' for nothing. Queued only on a clean land. */
  learned?: string;
  /** The files its branch touched, for the lines' row. */
  touched?: string[];
  /** Its live probe (#1741, src/live-probe.ts): run once the ship is live, with no model. */
  probe?: Probe;
  /** The branch's commit when it was handed off, before land.sh's rebase: a re-queue (#2030) needs the same change. */
  head?: string;
  /** hand_off_land's fix and outage, kept for a re-queue's land.sh (LAND_FIX, LAND_URGENT). */
  fix?: true;
  outage?: true;
  /** The server put this hand-off back in line itself after a refusal that wasn't the change's (#2030): its next refusal wakes the minion. */
  requeued?: true;
}

/** At most this many test files in one call: a feeder names the few its change touched. */
const MAX_FILES = 200;

/**
 * The land tool's arguments, turned into land.sh's (#597), or an Error saying what was wrong. Only the shapes
 * land.sh accepts come out: nothing, `--build`, `--into build/<n> --full`, or `--into build/<n> <files>` with
 * each file an existing file inside the worktree, passed as a path relative to it. No free-form text reaches it.
 */
export function landArgs(body: { into?: unknown; files?: unknown; full?: unknown; build?: unknown }, cwd: string): string[] {
  const { into, files, full, build } = body;
  if (build !== undefined && typeof build !== 'boolean') throw new Error('build must be true or false');
  if (full !== undefined && typeof full !== 'boolean') throw new Error('full must be true or false');
  if (into !== undefined && into !== null && typeof into !== 'string') throw new Error('into must be a build branch, build/<n>');
  if (files !== undefined && files !== null && !(Array.isArray(files) && files.every((f) => typeof f === 'string'))) throw new Error('files must be a list of test file paths');
  const list = (files ?? []) as string[];
  if (build) {
    if ((into !== undefined && into !== null) || full || list.length) throw new Error('build takes nothing more: not into, full or files (it lands the build your branch is at the tip of)');
    return ['--build'];
  }
  // Only a missing into is a plain land: an empty or wrong one is refused, never read as main.
  if (into === undefined || into === null) {
    if (full || list.length) throw new Error("full and files go with into: build/<n> (a feeder's or build minion's merge). For a plain ship to main, drop full and files and call again with just summary, risk, risk_reason, go and learned.");
    return [];
  }
  if (!/^build\/[1-9][0-9]{0,5}$/.test(into)) throw new Error(`into must be a build branch, build/<n>, not ${JSON.stringify(into.slice(0, 80))}`);
  if (full) {
    if (list.length) throw new Error('full runs the whole suite: name no files with it');
    return ['--into', into, '--full'];
  }
  if (list.length > MAX_FILES) throw new Error(`at most ${MAX_FILES} files`);
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    throw new Error("this minion's worktree is missing");
  }
  const rel = list.map((f) => {
    const bad = () => new Error(`${JSON.stringify(f.slice(0, 200))} is not a file in your worktree: name the test files this change touched, as paths inside it`);
    if (!f || f.includes('\0')) throw bad();
    let real: string;
    try {
      // Symlinks resolved, so a link can't point the run outside the worktree.
      real = realpathSync(resolve(root, f));
      if (!statSync(real).isFile()) throw bad();
    } catch {
      throw bad();
    }
    const r = relative(root, real);
    if (!r || r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r)) throw bad();
    // Never one land.sh or node would read as an option.
    return r.startsWith('-') ? `.${sep}${r}` : r;
  });
  return ['--into', into, ...rel];
}

/**
 * The early conflict check at hand-off (#770): `tools/land.sh --check <args>` in the worktree, which runs git merge-tree
 * against what the land would rebase onto (main, a build, another scheme's BRANCH). Its refusal when it says the branch
 * would conflict (exit 3), else null: clean, or no verdict (a land.sh from before --check refuses the argument with 1,
 * a hang, a git error), and then the hand-off goes on as before. Its three-way merge can refuse a branch the rebase would
 * take (a commit main has as a cherry-pick, under a later one on the same lines); the git rebase it names fixes that.
 */
export function landConflict(cwd: string, env: Record<string, string>, args: string[], timeout = 30_000): Promise<string | null> {
  return new Promise((done) => {
    execFile('bash', ['tools/land.sh', '--check', ...args], { cwd, env, timeout, maxBuffer: MAX_OUTPUT }, (err, _out, stderr) => {
      done(
        err?.code === 3
          ? String(stderr)
              .replace(/^land: /gm, '')
              .trim() || 'land.sh --check says it would conflict, but named nothing'
          : null,
      );
    });
  });
}

export class Landings {
  private readonly root: string;
  private readonly unitTag: string;
  private readonly jobs: HostJobs;

  /** `units`: whether to start each landing in a unit of its own (the runner's `units`, read at each start). */
  constructor(dataDir: string, units: () => boolean = () => false) {
    this.jobs = new HostJobs(units);
    this.root = join(resolve(dataDir), 'run', 'landings');
    // As the runner tags turn units: two servers on one box (a dev copy) never share a unit name.
    this.unitTag = createHash('sha256').update(this.root).digest('hex').slice(0, 8);
    this.scanned = this.scan();
  }

  /** Minions with a hand-off not yet reported: kept in memory, read from the folders once at start (#1210: a scan per call froze the server). */
  private readonly waiting = new Set<number>();
  /** Settled while the start's scan ran: it may have seen their hand-off before the rename, and must not add them back. */
  private readonly goneWhileScanning = new Set<number>();
  private scanDone = false;
  /** The start's scan of the folders, off the server's thread (#1463: 9.5 s under load, and it held the listen). */
  readonly scanned: Promise<void>;

  private async scan() {
    try {
      const names = (await readdir(this.root)).filter((n) => /^\d+$/.test(n));
      for (let i = 0; i < names.length; i += 16) {
        const found = await Promise.all(
          names.slice(i, i + 16).map((n) =>
            access(join(this.root, n, HANDOFF)).then(
              () => Number(n),
              () => null,
            ),
          ),
        );
        for (const id of found) if (id !== null && !this.goneWhileScanning.has(id)) this.waiting.add(id);
      }
    } catch {
      // No landings yet.
    } finally {
      this.scanDone = true;
      this.goneWhileScanning.clear();
    }
  }

  private dir(ticketId: number): string {
    return join(this.root, String(ticketId));
  }

  /** Start land.sh for a minion, with `args` from landArgs(), unless one runs already; the tool polls get() until it ends. */
  start(ticketId: number, cwd: string, env: Record<string, string>, args: string[] = []): Landing {
    const now = this.get(ticketId);
    // Nor over a hand-off that ended but isn't reported yet: starting afresh would wipe its output (the land tool then reads that one).
    if (now && (now.code === null || existsSync(join(this.dir(ticketId), HANDOFF)))) return now;
    this.jobs.start({ dir: this.dir(ticketId), cwd, argv: ['bash', 'tools/land.sh', ...args], env, unit: `citadel-land-${this.unitTag}-${ticketId}-${Date.now()}`, description: `tools/land.sh for minion ${ticketId}`, ticketId });
    return { output: '', code: null };
  }

  /**
   * Start land.sh as a hand-off (#706): the minion ends its turn and the server reports how it went
   * (LandHandoffs). The hand-off sits in the landing's folder, so a restart mid-land (the deploy's own,
   * most often) still reports it. False when a landing already runs for this minion.
   */
  handOff(ticketId: number, cwd: string, env: Record<string, string>, args: string[], h: Handoff, again = false): boolean {
    const now = this.get(ticketId);
    if (now && now.code === null) return false;
    // A re-queue (#2030) takes the ended, unreported hand-off's place with no await between, so a restart can't lose both.
    if (again) this.settled(ticketId);
    if (existsSync(join(this.dir(ticketId), HANDOFF))) return false;
    this.start(ticketId, cwd, env, args);
    writeFileSync(join(this.dir(ticketId), HANDOFF), JSON.stringify({ ...h, args }));
    this.waiting.add(ticketId);
    return true;
  }

  /** Minions whose handed-off landing isn't reported yet. Until the start's scan ends, only the ones this server handed off. */
  handoffs(): number[] {
    return [...this.waiting];
  }

  /** handoffs(), once the start's scan has ended: the reporter's list, so a land that ended across a restart is reported. */
  async pending(): Promise<number[]> {
    await this.scanned;
    return [...this.waiting];
  }

  /** Whether this one minion's hand-off is unreported: from memory, else one stat on its own folder (a turn's start, not the poll). */
  hasHandoff(ticketId: number): boolean {
    return this.waiting.has(ticketId) || existsSync(join(this.dir(ticketId), HANDOFF));
  }

  /** The hand-off's own file, read off the server's thread (#1463). */
  async readHandoff(ticketId: number): Promise<(Handoff & { args: string[] }) | null> {
    try {
      return JSON.parse(await readFile(join(this.dir(ticketId), HANDOFF), 'utf8'));
    } catch {
      return null;
    }
  }

  /** The steps this hand-off's report already did, each with what it gave, so a report cut off by a throw or a kill doesn't do them again (C2, #1406). */
  async reported(ticketId: number): Promise<Record<string, { v?: unknown }>> {
    try {
      return JSON.parse(await readFile(join(this.dir(ticketId), REPORTED), 'utf8'));
    } catch {
      return {};
    }
  }

  /** Save the report's steps, written aside and renamed in so a kill mid-write keeps the last whole copy. */
  async markReported(ticketId: number, steps: Record<string, { v?: unknown }>) {
    const file = join(this.dir(ticketId), REPORTED);
    await writeFile(`${file}.tmp`, JSON.stringify(steps));
    await rename(`${file}.tmp`, file);
  }

  /** Whether the hand-off is still unreported, from memory alone. */
  isWaiting(ticketId: number): boolean {
    return this.waiting.has(ticketId);
  }

  /** Reported: it no longer counts as a hand-off. */
  settled(ticketId: number) {
    this.waiting.delete(ticketId);
    if (!this.scanDone) this.goneWhileScanning.add(ticketId);
    try {
      renameSync(join(this.dir(ticketId), HANDOFF), join(this.dir(ticketId), 'handoff.done.json'));
    } catch {
      // Already settled.
    }
  }

  /** A message came for the minion (a person's, a relay): if its land is handed off, a clean land then leaves it open. */
  talked(ticketId: number) {
    if (this.hasHandoff(ticketId)) writeFileSync(join(this.dir(ticketId), 'talked'), '');
  }

  wasTalked(ticketId: number): boolean {
    return existsSync(join(this.dir(ticketId), 'talked'));
  }

  /** Whether the minion still has to hear about this conflict-prep `key` (#1366); true once, then it's noted for this run. */
  prepNew(ticketId: number, key: string): boolean {
    const f = join(this.dir(ticketId), 'prep-told');
    const told = existsSync(f) ? readFileSync(f, 'utf8').split('\n') : [];
    if (told.includes(key)) return false;
    writeFileSync(f, [...told.filter(Boolean), key, ''].join('\n'));
    return true;
  }

  /** A person stopped this landing (#1168): its report says who, not "fix the cause". The folder is made afresh at each start. */
  markStopped(ticketId: number, by: string, at = Date.now(), via = 'from the Status page') {
    try {
      writeFileSync(join(this.dir(ticketId), STOPPED), JSON.stringify({ by, at, via }));
    } catch {
      /* no landing folder: nothing to report */
    }
  }

  stopped(ticketId: number): { by: string; at: number; via?: string } | null {
    try {
      return JSON.parse(readFileSync(join(this.dir(ticketId), STOPPED), 'utf8'));
    } catch {
      return null;
    }
  }

  /** The pid of the land.sh a minion's running landing started (its wrapper's child), or null when none runs. */
  landPid(ticketId: number, children = (pid: number) => readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8'), cmdline = (pid: number) => readFileSync(`/proc/${pid}/cmdline`, 'utf8')): number | null {
    if (this.get(ticketId)?.code !== null) return null;
    try {
      const wrapper = Number(readFileSync(join(this.dir(ticketId), 'pid'), 'utf8'));
      // Only land.sh itself: the wrapper's own mv and rm run just after its pid file appears, and a stop sent to one of them missed the ship.
      return (
        children(wrapper)
          .trim()
          .split(/\s+/)
          .map(Number)
          .find((p) => {
            try {
              return p > 0 && cmdline(p).includes('tools/land.sh');
            } catch {
              return false;
            }
          }) ?? null
      );
    } catch {
      return null;
    }
  }

  /** Where a landing's whole output is. */
  log(ticketId: number): string {
    return join(this.dir(ticketId), 'output.log');
  }

  /** Landings running as the server's child: the ones a restart would cut off. */
  running(): number {
    return this.jobs.running();
  }

  /** The landing a minion started last, from its folder, whichever server started it. */
  get(ticketId: number): Landing | null {
    const r = this.jobs.state(this.dir(ticketId), MAX_OUTPUT);
    return r && r.code === -1 ? { output: r.output + NO_CODE, code: 1 } : r;
  }

  /** get(), read off the server's thread (#1463): the hand-off poll's read, every few seconds for each landing. */
  async look(ticketId: number): Promise<Landing | null> {
    const r = await this.jobs.look(this.dir(ticketId), MAX_OUTPUT);
    return r && r.code === -1 ? { output: r.output + NO_CODE, code: 1 } : r;
  }

  /**
   * Drop finished landings' folders from long ago, one at a time and off the server's thread: a daily job (server.ts),
   * not the start, where it held the listen (#1463). A hand-off not yet reported keeps its folder.
   */
  async prune(now = Date.now()) {
    await this.scanned;
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      if (this.waiting.has(Number(name))) continue;
      try {
        // A last run a restart cut off mid-delete (HostJobs.start renames it away, #1734) goes whatever its age.
        if (/\.old-\d+$/.test(name) || now - (await stat(join(this.root, name, 'code'))).mtimeMs > KEEP_MS) await rm(join(this.root, name), { recursive: true, force: true });
      } catch {
        // Still running, or never started: left alone.
      }
    }
  }
}

/** What a finished land.sh run means for the minion that handed it off. */
export interface LandResult {
  /** live: deployed and live now; restart: deployed, live after a queued restart; landed: done with no deploy
   * (another scheme's land.sh, or a merge into a build); no-ci: exit 75, CI gave no verdict; failed: anything else;
   * unpushed: the kit template's land.sh moved the branch locally, then its push to origin failed (#911). */
  kind: 'live' | 'restart' | 'landed' | 'no-ci' | 'failed' | 'unpushed';
  /** The commit main moved to and its subject, from land.sh's "main is now at" line; from its ship line (#1320), the
   * landing's own commit (a batch member's sits under main's), with the subject only when that line names it too. */
  commit?: string;
  subject?: string;
  /** With unpushed: the branch that moved, and what git said. */
  branch?: string;
  error?: string;
  /** With failed: the smoke check refused it before it got in line (#1012), so it never held the line or waited on CI. */
  smoke?: boolean;
}

export function landResult(output: string, code: number): LandResult {
  if (code === 75) return { kind: 'no-ci' };
  // The kit template's "<branch> moved, but the push to origin failed: <git's output>", which runs on until land.sh's next line.
  const unpushed = code !== 0 && /^land: (\S+) moved, but the push to origin failed: ([\s\S]*?)(?:\n(?=land: )|\n?(?![\s\S]))/m.exec(output);
  if (unpushed) {
    const branch = unpushed[1];
    const at = [...output.matchAll(/^land: (\S+) is now at ([0-9a-f]{7,40}) "(.*)"$/gm)].filter((m) => m[1] === branch).pop();
    return { kind: 'unpushed', branch, error: unpushed[2].trim(), ...(at ? { commit: at[2], subject: at[3] } : {}) };
  }
  // land.sh's smoke refusal (#1012), or the kit template's: "land: smoke: <what>, before the line (<n> s), so nothing landed".
  if (code !== 0) return /^land: smoke: .*, before the line \(\d+ s\), so nothing landed/m.test(output) ? { kind: 'failed', smoke: true } : { kind: 'failed' };
  // "<default branch> is now at": main, or master and the like in a scheme on the kit's land.sh (KT2, #1519). A merge
  // into a build says "build/<n> is now at", which isn't the commit main moved to.
  // A batch member's own line names its commit, which sits under main's tip (KT3): "land: landed <sha> "<subject>" in a batch".
  const at = [...output.matchAll(/^land: (?:(?!build\/)\S+ is now at|landed) ([0-9a-f]{7,40}) "(.*)"/gm)].pop();
  // The kit template's last line (#1320), when there is one: "ship: <landed|refused> <commit> batch <n> of <m> deploy
  // <state|none>". It decides; a land.sh without it (Citadel's own, until it prints one) falls back to the lines below.
  const ship = [...output.matchAll(/^ship: (landed|refused) ([0-9a-f]{7,40}|-) batch \d+ of \d+ deploy (\S+)$/gm)].pop();
  if (ship) {
    if (ship[1] === 'refused') return { kind: 'failed' };
    const own = ship[2] === '-' ? {} : { commit: ship[2], ...(at && (at[1].startsWith(ship[2]) || ship[2].startsWith(at[1])) ? { subject: at[2] } : {}) };
    return { kind: ship[3] === 'live' ? 'live' : ship[3] === 'restart' ? 'restart' : 'landed', ...own };
  }
  const commit = at ? { commit: at[1], subject: at[2] } : {};
  // deploy.sh's lines: "live now:" (front end reloaded, or the restart went live), "nothing to deploy: the server
  // already runs" (live already), "restart queued" / "a restart is already queued" / "not live yet" (waiting on it).
  // Only deploy.sh's own lines: a commit subject or another scheme's land.sh could say the same words.
  if (/^deploy: (live now:|nothing to deploy: the server already runs)/m.test(output)) return { kind: 'live', ...commit };
  if (/^deploy: (restart queued|a restart is already queued|not live yet)/m.test(output)) return { kind: 'restart', ...commit };
  return { kind: 'landed', ...commit };
}

/**
 * Whether a failed push of the default branch will fail the same way again (KT1, #1519): a login or access problem, or
 * origin's branch moved on its own. Anything else (the network, GitHub's 5xx, the 60 s timeout's empty output) passes.
 */
export function lastingPushFailure(error: string): 'access' | 'moved' | 'refused' | null {
  if (/GH006|protected branch|hook declined|pre-receive hook/i.test(error)) return 'refused';
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(error)) return 'moved';
  if (/repository not found|permission denied|permission to \S+ denied|denied to|error: 40[13]\b|\b40[13]\b.*(forbidden|unauthori[sz]ed)|authentication failed|could not read (username|password)|invalid username or password|not authori[sz]ed|write access|bad credentials|access denied/i.test(error)) return 'access';
  return null;
}

/** The wake for a land that moved the default branch locally, then failed to push it (#911, KT1). */
function unpushedWake(r: LandResult, what: string, apps: string[], tail: string): string {
  const b = r.branch!;
  const lasting = lastingPushFailure(r.error ?? '');
  const head = `Your handed-off land merged, but isn't on GitHub: ${b} moved locally to ${what}, and the push to origin failed:\n\`\`\`\n${r.error || '(no output: the push timed out after 60 s)'}\n\`\`\``;
  const own = `Don't push ${b} yourself: the scheme's guard, its pre-push hook and the tripwire all refuse it, and land.sh is its one route.`;
  const again = `hand it off again with hand_off_land: nothing new merges, it re-checks the branch and pushes ${b}${apps.length ? `, and the scheme's apps (${apps.join(', ')}), not deployed for it yet, deploy once it's pushed` : ''}`;
  const body = lasting
    ? `That won't clear by itself (${lasting === 'access' ? "the GitHub login this scheme's ships push with can't reach or write to the repo" : lasting === 'refused' ? `origin refuses pushes to ${b}: a protected branch or a server hook, which a person changes on GitHub` : `origin's ${b} moved on its own, so a person merges it into the local ${b} first`}), so shipping again now fails the same way. Tell a person in your reply, quoting the error, and stay open. Never try another login. ${own} Once they say it's fixed, ${again}.`
    : `That looks like a passing failure (the network or GitHub), so ${again}. ${own} If it fails the same way again, tell a person in your reply, quoting the error.`;
  return `${head}\n\n${body}\n\n${tail}`;
}

/** The test files tools/always-tests.txt adds to every run: a red in one is a repo-wide snapshot or budget, not the change's own test. */
const ALWAYS_TESTS = ['access-matrix', 'prompt-budget', 'schema-compat', 'pipeline-files'];

/**
 * The kind of red a refused land is (#1013), from land.sh's own output, so the wake leads with one line saying whose
 * problem it is and what to do (a minion once called a syntax error "infra" three times). Null when nothing matches:
 * the wake then keeps its plain text. The first match wins, most specific first.
 */
export function classifyLandFailure(output: string): { kind: string; line: string } | null {
  // Indented under the smoke or guard prefix is a failing test's own output, quoted: nothing below may read it (#1961).
  output = output.replace(/^land: (smoke|guard): {3}.*$/gm, '');
  // After a retry in place (#1360), only the second attempt counts: the first one's flake labels are no proof now.
  const again = output.lastIndexOf('not your change: keeping its place in line');
  if (again >= 0) output = output.slice(again);
  // citadel-test's `✖ file › name` (the smoke check and the guards), and where the suite itself refused the ship, run-tests.sh's
  // labels in the last run's log: an earlier one can be a train's, with another ship's tests.
  const suiteLog = /^land: tests failed on the rebased branch/m.test(output) ? (output.split(/^land: .*$/m).findLast((s) => /run-tests: \S+\.test\.ts: /.test(s)) ?? '') : '';
  const failedFiles = [...new Set([...output.matchAll(/✖ ([^ :]+\.test\.ts)(?::\d+)? › /gm), ...suiteLog.matchAll(/run-tests: (\S+\.test\.ts): (?:failed again alone|hung when rerun alone|rerun alone stopped)/g)].map((m) => m[1]))];
  const k = (kind: string, line: string) => ({ kind, line });
  if (/(won't (rebase|merge) \S+ .*cleanly|^land: smoke: it conflicts with main|^CONFLICT \(|the (rebase onto|merging) .* failed \(see git's output)/m.test(output)) return k('conflict', "Kind: merge conflict. Yours: rebase onto main by hand, keep the other minions' changes, re-test, commit, hand off again.");
  // The refusal's own line, from either ship script. A "SyntaxError" alone says nothing: tests log them on purpose (#1961).
  if (/^(land: smoke: )?a \.ts file does not parse/m.test(output)) return k('parse', 'Kind: parse error (a .ts file does not parse, which would stop the server). Yours, not infra: the lines below name the file and line; fix it, re-test, hand off again.');
  // A burn-in red (#1443) quotes the failing copy's output, which can hold a "passed alone" line: still the ship's own.
  if (/failed its burn-in in CI/.test(output)) return k('burn-in', 'Kind: a new or changed test failed its burn-in (racy when run as copies at once). Yours: fix the race (a shared path, a fixed port, a timing assumption), not the wait; run it with tools/burn-in.sh <file>, then hand off again.');
  // The fallback's no-answers on perigee (#1863): the log shown above them can hold a ✖ of a file that then passed alone.
  if (/^land: .*(ran out of its time limit and no test is known to be|packages the tests import could not be installed)/m.test(output))
    return k('no-answer', 'Kind: the suite on perigee gave no answer (it ran out of time, or its packages could not be installed). Not yours: nothing is known to fail in your change. Hand off again; if it repeats, tell the Taskmaster.');
  const testsRed = /tests failed on the rebased branch/.test(output) || failedFiles.length > 0;
  if (!testsRed && /failed in its setup step|runner clock:|the runner needs fixing/.test(output)) return k('ci', 'Kind: CI or runner problem. Not yours: nothing in your change failed. Hand off again; if it repeats, tell the Taskmaster.');
  // Only the copy's own troubles: node marks every SQL error, the change's own too, ERR_SQLITE_ERROR.
  if (/^deploy: boot check failed|^land: .*fails the same check here/m.test(output) && /SQLITE_(BUSY|LOCKED|CORRUPT|IOERR|FULL)|database (table )?is locked|database or disk is full|disk I\/O error|database disk image is malformed|sqlite.*(crash|abort|segfault)/i.test(output))
    return k('boot-copy', 'Kind: boot-check copy failure (SQLite lock or sqlite crash on the database copy). Not yours: nothing is wrong with your change. Just hand off again.');
  // A run that skipped a test (#1914) is refused whatever else failed, its flakes included: before the passed-alone line.
  if (/^land: (a test was|\d+ tests were) skipped in CI /m.test(output))
    return k('skipped-test', "Kind: CI skipped a test, so a check didn't run. Never a flake, so handing off the same commit again is refused too. Make the test run in CI (or not register there); if your change has nothing to do with it, the runner lacks something: tell the Taskmaster which test.");
  // What land.sh's flake_only would call passed-alone (#1013, G1 of #1283): some file passed alone and none has another label
  // from tools/run-tests.sh: "failed again alone", "hung when rerun alone", "rerun alone stopped … counts as a real failure",
  // "not rerun: …". Not a "flake" for people: that word is for a known one (#1419), which ships and is never refused.
  if (/: failed in the full run, passed alone/.test(output) && !/run-tests: \S+: (failed again alone|hung when rerun alone|rerun alone stopped|not rerun:|killed \(exit \d+\) when rerun alone)/.test(output))
    return k('passed-alone', 'Kind: the failed files failed in the full run but passed alone (so load, not your change, going by that). Not yours: hand off again; no code change needed.');
  const always = failedFiles.filter((f) => ALWAYS_TESTS.some((a) => f.includes(a)));
  if (always.length) return k('always-test', `Kind: repo-wide snapshot or budget test (${always.join(', ')}). Your change moved it: regenerate the snapshot, or trim what you added (prompt text, tools, routes), then re-test that file and hand off again.`);
  if (failedFiles.length) return k('own-test', `Kind: a test failed (${failedFiles.join(', ')}). Probably yours: run that file alone with citadel-test, fix the code (or the test, if it is out of date), then hand off again.`);
  return null;
}

/**
 * Why a refused hand-off goes back in line with no turn (#2030, Josh, 2026-11-25, "Yes, re-queue it"), said in its note;
 * null when it wakes the minion. Only a red the box or the pipeline caused: load alone, and since #2051 a cut-off run, a
 * boot-check copy failure, a run on perigee out of time, a second red after one of flakes only. Once a hand-off, never
 * with deploy refusing, nor past what already says it isn't load: a broken test (#1487), land.sh's own keeps in place used
 * up (flake_keep), the leak guard's red. requeueShip asks about broken tests too.
 */
export function requeueReason(output: string, cls: { kind: string } | null, h: Handoff): string | null {
  if (h.requeued || /^land: (broken test, not a flake: |deploy has been refusing since )/m.test(output) || /has kept its place \d+ times already/.test(output) || /The tests left \d+ process\(es\) running/.test(output)) return null;
  if (output.endsWith(NO_CODE)) return 'land.sh was cut off with no exit code';
  if (cls?.kind === 'passed-alone') return 'the failed test files passed when rerun alone';
  if (cls?.kind === 'boot-copy') return 'the boot check failed on its copy of the database';
  if (/^land: the suite on perigee ran out of its time limit and no test is known to be/m.test(output)) return 'the test run on perigee ran out of its time limit';
  // Not a second red the ship's own change is known to have caused: a file that failed again alone or hung there, a burn-in, a skip.
  if (/on the one fresh run after a red whose files all passed alone/.test(output) && !/run-tests: \S+: (failed again alone|hung when rerun alone)/.test(output) && !['conflict', 'parse', 'burn-in', 'skipped-test'].includes(cls?.kind ?? '')) return 'a second red after one of flakes only';
  return null;
}

/** land.sh's phase lines, newest first wins: the note a handed-off land shows in the minions list (#962). */
const PHASES: [RegExp, string][] = [
  [/^(deploy: |land: (?!build\/)\S+ is now at )/, 'deploying'],
  [/^land: waiting for CI or a quiet perigee/, 'waiting for CI or a quiet perigee'],
  [/^land: (waiting for CI|failed in the full run but passed alone.*running CI once more)/, 'waiting on CI'],
  [/^land: (running |CI FALLBACK)/, 'running tests'],
  [/^land: (rebasing|merging main)/, 'rebasing'],
  [/^land: smoke: /, 'smoke check'],
  [/^land: own check: /, 'own check'], // a ship's own CI before the line (#1567)
  [/^queue: got the (deploy|land) lock/, 'starting'],
  [/^queue: /, 'in line'],
  // A rider waits outside the line for its train's verdict (#1166); "back in line" puts it in line again.
  [/^land: riding in \S+'s ship train/, 'riding'],
  [/^land: pulled off \S+'s ship train/, 'pulled off its train'], // until the train without it has a verdict (#1918)
  [/^land: back in line on its own/, 'in line'],
];

export function landPhase(output: string): string {
  for (const line of output.split('\n').reverse())
    for (const [re, phase] of PHASES)
      if (re.test(line)) {
        if (phase !== 'riding') return `landing: ${phase}`;
        const front = /^land: riding in (\S+)'s ship train/.exec(line)![1];
        const n = /^ticket\/(\d+)-/.exec(front)?.[1];
        return `landing: riding in ${n ? `#${n}` : front}'s train`;
      }
  return 'landing: starting';
}

/** land.sh's conflict-prep lines (#1366): a ship waiting in line that will conflict once the train ahead ships. The kit's
 *  template (CONFLICT_PREP, #1571) says "once <the ship ahead> ships", with no train. */
const PREP = /^land: prep: (\S+) will conflict with (.+) once (\S+?)('s ship train)? ships; conflicted files: (.*); record the fix against ([0-9a-f]{7,64}) from ([0-9a-f]{7,64}) to ([0-9a-f]{7,64})$/;

export interface PrepConflict {
  branch: string;
  cause: string;
  front: string;
  files: string;
  top: string;
  base: string;
  head: string;
  train: boolean;
}

/** The newest conflict-prep line in a landing's output, if any. */
export function prepConflict(output: string): PrepConflict | null {
  for (const line of output.split('\n').reverse()) {
    if (/^land: prep: \S+ conflicts with .* resolves it/.test(line)) return null; // the fix is recorded already
    const m = PREP.exec(line);
    if (m) return { branch: m[1], cause: m[2], front: m[3], train: !!m[4], files: m[5], top: m[6], base: m[7], head: m[8] };
  }
  return null;
}

/** The wake for a prep conflict: record the fix with git rerere in a scratch worktree, off the minion's branch. */
export function prepMessage(p: PrepConflict): string {
  const wt = '"$TMPDIR/train-prep"';
  return [
    `Heads-up while your ship waits in line: once ${p.front}${p.train ? "'s ship train" : ''} ships, your rebase onto it will conflict with ${p.cause} in ${p.files || "files git didn't name"}. Record the fix now, ahead of time, so the real rebase replays it and your ship isn't refused (conflict prep, #1366).`,
    '',
    `Don't touch your branch or worktree: land.sh is running in it, and your branch must never take those unshipped commits. Work in a scratch worktree (\`git worktree\` and \`git cherry-pick\` there are fine; the folder is yours):`,
    '```bash',
    `git worktree add --detach ${wt} ${p.top}`,
    `git -C ${wt} -c rerere.enabled=true cherry-pick ${p.base}..${p.head}`,
    '```',
    `At each stop, resolve the conflicted files in ${wt} keeping both sides' intent, \`git -C ${wt} add\` them, then run \`git -C ${wt} -c rerere.enabled=true -c core.editor=true cherry-pick --continue\` until the pick is done. If it says there is nothing to commit (your fix kept the side ahead whole), run \`git -C ${wt} -c rerere.enabled=true rerere\` and then \`git -C ${wt} cherry-pick --skip\` instead. Then \`git worktree remove --force ${wt}\`.`,
    '',
    `Don't hand it off again: your ship keeps its place. land.sh checks again within seconds and says "prep: … resolves it" in its output. If what's ahead changes before it ships, the record just goes unused. End your turn once it's recorded.`,
  ].join('\n');
}

/** The end of land.sh's output for a wake message: its last lines, not the whole 64 KB. */
export function outputTail(output: string, lines = 60, max = 6000): string {
  const tail = output.trimEnd().split('\n').slice(-lines).join('\n');
  return tail.length > max ? `…${tail.slice(-max)}` : tail;
}

/** One home contraption's deploy after a clean land (#712), as the shipped line tells it. */
export interface AppDeploy {
  name: string;
  ok: boolean;
  /** One line for the shipped line: deployed and healthy, or what went wrong. */
  line: string;
  /** With a failure: the deploy's steps and the end of its log, for the wake message. */
  detail?: string;
}

/** How deployApps reaches the contraption deploys (server.ts: auto-deploy's deployNow and the app services). */
export interface DeployOps {
  /** Whether a deploy of the app runs now. */
  running(name: string): boolean;
  /** Start its deploy for the minion, as deploy_contraption would; throws when it can't start. */
  start(name: string, ticketId: number): Promise<unknown>;
  /** Its last deploy, as deploy_contraption's status reads it. */
  last(name: string): Promise<{ state: string; to: string | null; said: string[]; tail?: string; log: string } | null>;
  /** Whether `deployed` holds `landed` in the app's checkout (git merge-base --is-ancestor); without it, only the same commit does. */
  has?(name: string, landed: string, deployed: string): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  now?(): number;
}

/** A deploy is followed this long, as deploy_contraption waits; past that the minion is told it still runs. */
const DEPLOY_WAIT_MS = 60 * 60_000;

/**
 * Deploy each of the scheme's apps after a clean land and wait for the outcome (#712): behind a deploy already
 * running (an auto-deploy of an older main, most often), then one of its own, so the landed commit is what goes out.
 * `commit` is the one land.sh moved main to. An app already deployed at a commit holding it (a batch's other lands,
 * a newer land's deploy) isn't deployed again; a deploy that went to a commit without it (GitHub didn't have it yet) didn't ship it.
 */
export async function deployApps(ticketId: number, names: string[], commit: string | undefined, ops: DeployOps): Promise<AppDeploy[]> {
  const rest = ops.sleep ?? sleep;
  const now = ops.now ?? Date.now;
  const holds = async (name: string, to: string | null) => !!(commit && to && (to.startsWith(commit) || (await ops.has?.(name, commit, to).catch(() => false))));
  const healthy = (name: string, to: string | null) => `Deployed ${name}${to ? ` at ${to.slice(0, 9)}` : ''}, healthy.`;
  const out: AppDeploy[] = [];
  apps: for (const name of names) {
    const until = now() + DEPLOY_WAIT_MS;
    for (let tries = 0; ; tries++) {
      while (ops.running(name) && now() < until) await rest(3000);
      const before = await ops.last(name);
      if (before?.state === 'deployed' && (await holds(name, before.to))) {
        out.push({ name, ok: true, line: healthy(name, before.to) });
        continue apps;
      }
      try {
        await ops.start(name, ticketId);
        break;
      } catch (err) {
        // Another deploy started between the check and this start (auto-deploy's own, still starting): wait, then try once more.
        if (tries) {
          out.push({ name, ok: false, line: `${name}'s deploy couldn't start: ${String(thrown(err).message ?? err).trim()}` });
          continue apps;
        }
        await rest(3000);
      }
    }
    let d = await ops.last(name);
    while (d?.state === 'running' && now() < until) {
      await rest(3000);
      d = await ops.last(name);
    }
    // The log's tail holds its said lines and the build's output between them.
    const detail = d ? [`Log: ${d.log}`, ...(d.tail ? ['Last lines of the log:', d.tail] : d.said.map((l) => `- ${l}`))].join('\n') : undefined;
    const why = d?.said.find((l) => l.startsWith('Failed: '))?.slice(8) ?? d?.said.at(-1) ?? 'no reason given';
    if (!d) out.push({ name, ok: false, line: `${name}'s deploy left no record.` });
    else if (d.state === 'running') out.push({ name, ok: false, line: `${name}'s deploy is still running after an hour: call deploy_contraption with follow: true to see how it ends.`, detail });
    else if (d.state !== 'deployed') out.push({ name, ok: false, line: `${name}'s deploy ${d.state}: ${why}`, detail });
    else if (commit && !(await holds(name, d.to))) out.push({ name, ok: false, line: `${name} deployed ${d.to?.slice(0, 9) ?? 'nothing'}, which doesn't hold the landed ${commit}: GitHub's main didn't have it yet (land.sh's output says whether its push failed).`, detail });
    else out.push({ name, ok: true, line: healthy(name, d.to) });
  }
  return out;
}

export interface HandoffDeps {
  landings: Pick<Landings, 'pending' | 'look' | 'readHandoff' | 'isWaiting' | 'settled' | 'wasTalked' | 'log' | 'prepNew' | 'reported' | 'markReported'> & Partial<Pick<Landings, 'stopped'>>;
  store: { getTicket(id: number): { status: string; state: string | null; note?: string | null } | undefined | null; updateTicket(id: number, fields: { state?: string | null; note?: string | null }): unknown };
  runner: {
    emit(id: number, kind: string, data: unknown): unknown;
    send(id: number, author: string, text: string, images?: never[], extra?: { fyi?: boolean; light?: boolean; quick?: boolean }): void;
    close(id: number, text: string): Promise<void>;
    unpark(id: number, by: string, author: string, quiet?: boolean): boolean;
    relayMinion(from: number, to: number, author: string, text: string, urgent?: boolean, wake?: boolean, unparked?: boolean): unknown;
    closeAfterTurn(id: number, reason: string | null): boolean;
    keptOpen(id: number, atCall?: boolean): string | null;
    isRunning(id: number): boolean;
    queued(id: number): number;
    deployPending(id: number): void;
    deployLive(id: number): boolean;
    broadcastTicket(id: number): void;
  };
  /** Who the server's messages are from. */
  from: string;
  /** A finished land's output, for the flakes it names (#1063). */
  flakes?(id: number, output: string): void;
  /** The minion that owns build/<n> for this minion's scheme, if one is set. */
  buildOwner?(id: number, build: number): number | null;
  /** Seal the minion until its scheme's CI runners are back; false when it has none to watch. */
  runnersBack(id: number, reason: string): boolean;
  /** Whether the server already runs this minion's branch (a restart that went live before land.sh's end was read). */
  liveAlready(id: number): Promise<boolean>;
  /** Wake the minion with `text` once `commit` (null: the next deploy) is live, the way wake_when_live does, as a success notice (low effort, #951); false when it is live already. */
  wakeWhenLive?(id: number, commit: string | null, text: string): Promise<boolean>;
  /** The minion's scheme's apps a clean land on main deploys (#712): its home contraptions; none where deploys can't run. */
  apps?(id: number): string[];
  deployOps?: DeployOps;
  /** A clean land on main moved it to `commit` (fast mode's testing behind, src/fast-mode.ts, #1017). */
  landed?(id: number, commit: string): void;
  /** A handed-off land that didn't go through, with classifyLandFailure's kind (the stall signals, #1139). */
  failed?(id: number, kind: string | null): void;
  /** A clean land, wherever it went (main or a build): queue the minion's lines (#1119). Its errors are caught. */
  learned?(id: number, h: Handoff): void;
  /** Put a refused hand-off back in line with no turn (#2030): null once it is, else why not, said in the wake. */
  requeue?(id: number, h: Handoff & { args: string[] }, output: string): Promise<string | null>;
  /** A ship on main with a live probe (#1741, LiveProbes.shipped): true when it failed and woke the minion. */
  probe?(id: number, probe: Probe, commit: string | null, when: 'live' | 'later' | 'nowhere'): Promise<boolean>;
}

/**
 * Reports handed-off landings once land.sh ends (#706), with no model call on a clean land: the scheme's apps
 * deployed and waited for (#712), the shipped line, then a dismissal (live now) or pending-deploy (live after the restart, which dismisses it). A failed land wakes
 * the minion with the end of land.sh's output, so it fixes it with its own context and hands off again.
 * poll() runs every few seconds and once at boot, so a land that ended across a restart is still reported.
 */
export class LandHandoffs {
  private busy = new Set<number>();
  private readonly d: HandoffDeps;

  constructor(d: HandoffDeps) {
    this.d = d;
  }

  async poll() {
    for (const id of await this.d.landings.pending()) {
      if (this.busy.has(id)) continue;
      const [run, h] = await Promise.all([this.d.landings.look(id), this.d.landings.readHandoff(id)]);
      // Polls overlap now that they read off the thread: one that settled it while this one read leaves it alone.
      if (this.busy.has(id) || !this.d.landings.isWaiting(id)) continue;
      if (h && run && run.code === null) {
        this.showLanding(id, run);
        this.tellPrep(id, run);
      }
      if (!h || !run || run.code === null) continue;
      this.busy.add(id);
      try {
        // A re-queued one (#2030) is a new hand-off already: settling it now would drop that one.
        if (!(await this.settle(id, run, h))) this.d.landings.settled(id);
      } catch (err) {
        console.error(`Reporting minion ${id}'s land failed: ${thrown(err).message ?? err}`);
      } finally {
        this.busy.delete(id);
      }
    }
  }

  /**
   * The server owns a handed-off land's state (#962): outside, its note the phase land.sh is in, until the land ends.
   * Kept here, not only set at hand-off, so whatever cleared it meanwhile (a turn a person started, set_thread_status,
   * a server from before the hand-off) is put right within a poll.
   */
  private showLanding(id: number, run: Landing) {
    const t = this.d.store.getTicket(id);
    const note = landPhase(run.output);
    if (!t || t.status === 'closed' || (t.state === 'outside' && t.note === note)) return;
    this.d.store.updateTicket(id, { state: 'outside', note });
    this.d.runner.broadcastTicket(id);
  }

  /** A ship in line that will conflict once the train ahead ships (#1366): its minion records the fix now, once per train top and head. */
  private tellPrep(id: number, run: Landing) {
    const p = prepConflict(run.output);
    if (!p || !this.d.landings.prepNew(id, `${p.top} ${p.head}`)) return;
    // fyi: it still runs a turn, but isn't someone writing in line (Landings.talked), so a clean ship still closes it.
    this.d.runner.send(id, this.d.from, prepMessage(p), [], { fyi: true });
  }

  /**
   * A feeder's merge into build/<n> is the build minion's main event: it gets one message that wakes it, sealed or
   * cold alike (urgent, and unsealed first), so it never sits sealed after its feeders are in.
   */
  private wakeBuildOwner(id: number, into: string | null, what: string) {
    const n = Number(/^build\/(\d+)$/.exec(into ?? '')?.[1]);
    if (!n) return;
    const { store, runner } = this.d;
    const owner = this.d.buildOwner?.(id, n);
    const o = owner ? store.getTicket(owner) : null;
    const t = store.getTicket(id) as { number?: number; title?: string } | null | undefined;
    if (!owner || owner === id || !o || o.status === 'closed' || !t?.number) return;
    const by = `#${t.number}`;
    const parked = o.state === 'parked' && runner.unpark(owner, by, `${by} ${t.title}`, true);
    runner.relayMinion(id, owner, `${by} ${t.title}`, `${by} ${t.title} merged into ${into}: ${what}`, true, true, parked);
  }

  /** True when the hand-off was put back in line (#2030), so it is the new one's and not to be settled. */
  private async settle(id: number, run: Landing, h: Handoff & { args: string[] }): Promise<boolean | void> {
    const { store, runner, from } = this.d;
    const r = landResult(run.output, run.code!);
    // Each step that says, counts or deploys something runs once per hand-off, even when a throw or a kill cuts the
    // report off and the next poll or server runs it again (C2, #1406). Setting the ticket's state is safe to repeat.
    const done = await this.d.landings.reported(id);
    const once = async <T>(step: string, fn: () => T | Promise<T>): Promise<T> => {
      if (step in done) return done[step].v as T;
      const v = await fn();
      done[step] = { v };
      await this.d.landings.markReported(id, done);
      return v;
    };
    try {
      await once('flakes', () => this.d.flakes?.(id, run.output));
    } catch (err) {
      console.error(`Recording minion ${id}'s flakes failed: ${thrown(err).message ?? err}`);
    }
    const tail = () => `The end of its output (all of it: ${this.d.landings.log(id)}):\n\`\`\`\n${outputTail(run.output)}\n\`\`\``;
    const stop = r.kind === 'failed' ? this.d.landings.stopped?.(id) : null;
    if (stop) {
      // A person stopped it, from the Status page or by stopping the minion (#1168): not the minion's red, so no failure count and no "fix the cause".
      store.updateTicket(id, { state: null, note: 'ship stopped' });
      runner.broadcastTicket(id);
      const at = pacificStamp(stop.at);
      const moved = /^land: \S+ is now at [0-9a-f]{7,40} /m.test(run.output);
      await once('told', () =>
        runner.send(
          id,
          from,
          `Your handed-off land was stopped by ${stop.by} ${stop.via ?? 'from the Status page'} at ${at}. ${moved ? 'Its output says main had already moved, so check `git log main` before handing it off again.' : 'Nothing landed and main is untouched.'} It left the line and let go of the lock. Check your worktree with \`git status\` (a rebase it was in may need \`git rebase --abort\`), ask why if the reason isn't in your chat, and hand it off again when it should go.\n\n${tail()}`,
        ),
      );
      return;
    }
    if (r.kind === 'failed' || (r.kind === 'no-ci' && !(await once('runners', () => this.d.runnersBack(id, 'Your handed-off land sealed because CI gave no verdict (land.sh exit 75). Hand it off again with hand_off_land.'))))) {
      const cls = classifyLandFailure(run.output);
      try {
        await once('failed', () => this.d.failed?.(id, cls?.kind ?? null));
      } catch (err) {
        console.error(`Counting minion ${id}'s failed ship failed: ${thrown(err).message ?? err}`);
      }
      // Not in once(): the new hand-off starts in a fresh folder, and a step marked done would carry over into it.
      const again = r.kind === 'failed' && this.d.requeue && !('told' in done) ? requeueReason(run.output, cls, h) : null;
      const notAgain = again ? await this.d.requeue!(id, h, run.output) : '';
      if (notAgain === null) {
        runner.emit(id, 'note', { text: `Shipping was refused (${again}), so the server put this ship back in line by itself, once, with no turn. It wakes you only if it is refused again.` });
        return true;
      }
      store.updateTicket(id, { state: null, note: null });
      runner.broadcastTicket(id);
      const why = r.smoke ? `its smoke check refused it before it got in line (nothing landed, and it never waited on the line or CI)` : `tools/land.sh exited ${run.code} (main only moved if its output says so)`;
      const kept = notAgain ? ` It wasn't put back in line by itself: ${notAgain}.` : '';
      await once('told', () => runner.send(id, from, `${cls ? `${cls.line}${kept}\n\n` : ''}Your handed-off land didn't go through: ${why}. Fix the cause, re-test, and hand it off again with hand_off_land.\n\n${tail()}`, [], { quick: false }));
      return;
    }
    // It landed (on main or a build, pushed or not): its lines go in the queue, and nothing here can stop the ship (#1119).
    if (r.kind !== 'no-ci') {
      try {
        await once('learned', () => this.d.learned?.(id, h));
      } catch (err) {
        console.error(`Queueing minion ${id}'s ship lines failed: ${thrown(err).message ?? err}`);
      }
    }
    if (r.kind === 'unpushed') {
      // It landed, but only locally. The minion can't push the default branch itself (the kit's guard.sh, pre-push and
      // the tripwire all refuse it, KT1 #1519): a passing failure ships again, a lasting one goes to a person.
      const what = r.commit ? `${r.commit}${r.subject === undefined ? '' : ` "${r.subject}"`}` : `the branch's new tip`;
      const apps = h.deploy !== false && this.d.deployOps ? (this.d.apps?.(id) ?? []) : [];
      store.updateTicket(id, { state: null, note: 'shipped locally; push to origin failed' });
      runner.broadcastTicket(id);
      await once('noted', () => runner.emit(id, 'note', { text: `Shipped ${what}: ${h.summary.trim().replace(/[.\s]+$/, '')}. Risk ${h.risk}. Shipped locally, not pushed to origin: the push failed.` }));
      await once('told', () => runner.send(id, from, unpushedWake(r, what, apps, tail())));
      return;
    }
    if (r.kind === 'no-ci') {
      store.updateTicket(id, { state: 'parked', note: 'ship sealed: waiting for CI runners' });
      runner.broadcastTicket(id);
      await once('noted', () => runner.emit(id, 'note', { text: `Shipping parked: CI gave no verdict (land.sh exit 75), most likely because the runners' machine is off. This minion is woken once the scheme's runners are back, to hand it off again.` }));
      return;
    }
    const into = h.args[0] === '--into' ? h.args[1] : null;
    if (!into && r.commit) await once('landed', () => this.d.landed?.(id, r.commit!));
    const what = r.commit ? `${r.commit}${r.subject === undefined ? '' : ` "${r.subject}"`}` : into ? `into ${into}` : 'the branch';
    // #1417: a restart held for a starved box says when it expects to go: "the box is starved (CPU pressure 63%), … live by about 14:05 PST".
    const held = r.kind === 'restart' ? /^deploy: not live yet: .*the box is starved \(([^)]*)\).*?(live by about \d\d?:\d\d [A-Z]{3,4})/m.exec(run.output) : null;
    const where = r.kind === 'live' ? 'Live now.' : held ? `Waiting for the restart, held while the box is starved (${held[1]}): ${held[2]} at the latest.` : r.kind === 'restart' ? 'Waiting for the restart.' : into ? `Merged into ${into}, not live until the build ships.` : 'Shipped.';
    const strip = (s: string) => s.trim().replace(/[.\s]+$/, '');
    // On main, the scheme's apps go out now rather than at auto-deploy's next tick (#712), and the line says how.
    const apps = !into && h.deploy !== false && this.d.deployOps ? (this.d.apps?.(id) ?? []) : [];
    if (apps.length) {
      store.updateTicket(id, { note: `shipped: deploying ${apps.join(', ')}` });
      runner.broadcastTicket(id);
    }
    const deploys = apps.length ? await once('deployed', () => deployApps(id, apps, r.commit, this.d.deployOps!)) : [];
    const failed = deploys.filter((d) => !d.ok);
    const known = /^land: shipped past known flakes (.+)$/m.exec(run.output)?.[1]; // #1419: a red of known flakes only let through
    const through = /^land: shipped through main's red on (.+)$/m.exec(run.output)?.[1]; // #1478: red only on a test main's tip fails too
    const formatted = /^land: format: formatted (\d+) of this ship's files in [0-9a-f]+ (\(.+\))$/m.exec(run.output); // #1885: tools/ship-format.sh, its commit's hash before the rebase
    const flakeKept = (run.output.match(/^land: refused on flakes only .*not your change: keeping its place in line/gm) ?? []).length; // #1419 part 2
    await once('noted', () =>
      runner.emit(id, 'note', {
        text: `${into ? 'Merged' : 'Shipped'} ${what}: ${strip(h.summary)}. Risk ${h.risk}: ${strip(h.reason)}.${h.go ? ` Go: ${strip(h.go)}.` : ''}${formatted ? ` The ship script formatted ${formatted[1]} of its files in a commit of its own ${formatted[2]}.` : ''}${known ? ` Shipped past known flakes ${known}.` : ''}${through ? ` Shipped through main's red on ${through}: main still needs a fix for it.` : ''}${flakeKept ? ` Kept its place in line after ${flakeKept} red${flakeKept > 1 ? 's' : ''} of flakes only.` : ''} ${where}${deploys.map((d) => ` ${d.line}`).join('')}`,
      }),
    );
    await faultPoint('ship-noted'); // a drill's kill between the shipped line and the hand-off's rename (C2)
    await once('woke', () => this.wakeBuildOwner(id, into, `${strip(h.summary)}. Risk ${h.risk}: ${strip(h.reason)}.`));
    const t = store.getTicket(id);
    if (!t || t.status === 'closed') return;
    if (r.kind === 'restart' && !h.stayOpen) {
      store.updateTicket(id, { state: 'pending-deploy', note: held ? `deployed, starved box: ${held[2]}` : 'deployed, live after the restart' });
      runner.deployPending(id);
      runner.broadcastTicket(id);
    }
    // The land shipped but an app didn't go live: the minion fixes it with its own context.
    if (failed.length) {
      if (r.kind !== 'restart') {
        store.updateTicket(id, { state: null, note: null });
        runner.broadcastTicket(id);
      }
      await once('told-deploy', () =>
        runner.send(
          id,
          from,
          `Your handed-off land went through (${what}, ${(where[0].toLowerCase() + where.slice(1)).replace(/\.$/, '')}), but the deploy after it didn't go live:\n\n${failed.map((f) => (f.detail ? `${f.line}\n${f.detail}` : f.line)).join('\n\n')}\n\nFix the cause and hand the fix off with hand_off_land, which deploys again (deploy_contraption redeploys main as it is). close_self once nothing is left.`,
        ),
      );
      return;
    }
    // Its live probe (#1741): live now runs it now, a restart keeps it for the live; a fail woke the minion, so it stays open.
    if (!into && h.probe && this.d.probe) {
      const when = r.kind === 'live' || (r.kind === 'landed' && deploys.length) ? 'live' : r.kind === 'restart' ? 'later' : 'nowhere';
      if (await once('probe', () => this.d.probe!(id, h.probe!, r.commit ?? null, when))) return;
    }
    // Someone wrote while it was in line (a person, a relay): the minion answers them before it goes.
    if (this.d.landings.wasTalked(id)) {
      if (r.kind !== 'restart' || h.stayOpen) {
        store.updateTicket(id, { state: null, note: null });
        runner.broadcastTicket(id);
      }
      // light (#951): a land that landed is a success notice; whoever wrote meanwhile keeps the minion's own effort.
      await once('told-talked', () =>
        runner.send(
          id,
          from,
          `Your handed-off land went through (${what}, ${(where[0].toLowerCase() + where.slice(1)).replace(/\.$/, '')}). Someone wrote to you while it was in line, so the server left this minion open: ${r.kind === 'restart' && !h.stayOpen ? 'it stays in pending-deploy unless you set another state' : 'close_self once nothing is left for them'}.`,
          [],
          { light: true },
        ),
      );
      return;
    }
    if (h.stayOpen && h.waitingOn) {
      // #942: never sealed, since nothing would wake it. It is woken once its work is in (after the restart, through
      // wake_when_live's waiter), once, and sets its own state from there.
      const restart = r.kind === 'restart' && !(await this.d.liveAlready(id));
      const text = (now: string) =>
        `Your handed-off land went through (${what}, ${now}). You handed it off waiting on: ${h.waitingOn}. Run your after-land steps now, then set your state for that wait: a person's test, card or confirmation leaves it null (or try); another minion's land is wake_when_live on its commit, then sealed.`;
      // true: the waiter wakes it at live; false: live already; undefined: no waiter here, so it hears now.
      const queued = restart ? await once('waiter', () => this.d.wakeWhenLive?.(id, r.commit ?? null, text('live now'))) : undefined;
      store.updateTicket(id, { state: queued ? 'outside' : null, note: `${queued ? 'shipped, wakes once live' : 'shipped'}; waiting on: ${h.waitingOn}`.slice(0, 120) });
      runner.broadcastTicket(id);
      if (!queued) await once('told-live', () => runner.send(id, from, text(r.kind !== 'restart' ? (where[0].toLowerCase() + where.slice(1)).replace(/\.$/, '') : queued === undefined && restart ? 'live after the restart' : 'live now'), [], { light: true }));
      return;
    }
    if (h.stayOpen) {
      // More pieces to do in this minion (#909): the shipped line is out, and it stays open, ready for the next one.
      store.updateTicket(id, { state: 'ready', note: r.kind === 'restart' ? 'shipped, live after the restart; open for the next piece' : 'shipped; open for the next piece' });
      runner.broadcastTicket(id);
      return;
    }
    if (r.kind === 'restart') {
      // Its restart may have gone live before this read land.sh's end: then no live report will come for it.
      if (await this.d.liveAlready(id)) runner.deployLive(id);
      return;
    }
    const kept = runner.keptOpen(id, true);
    if (kept) {
      store.updateTicket(id, { state: null, note: null });
      runner.broadcastTicket(id);
      await once('told-kept', () => runner.emit(id, 'note', { text: `It shipped, but ${kept}, so this minion stays open.` }));
      return;
    }
    const why = r.kind === 'live' ? 'Shipped and live' : 'Shipped';
    if (runner.isRunning(id) || runner.queued(id)) {
      store.updateTicket(id, { state: null, note: null });
      runner.broadcastTicket(id);
      await once('told-close', () => {
        if (!runner.closeAfterTurn(id, `${why}.`)) runner.emit(id, 'note', { text: `${why}; this minion has a turn running or queued, so it stays open.` });
      });
      return;
    }
    store.updateTicket(id, { state: null, note: into ? `merged into Build ${into.slice('build/'.length)}` : null });
    this.d.landings.settled(id);
    await runner.close(id, `${why}, so the server dismissed this minion.`);
  }
}
