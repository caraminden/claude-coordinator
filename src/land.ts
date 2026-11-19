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
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HostJobs } from './host-job.ts';

export interface Landing {
  /** The tail of what land.sh printed so far. */
  output: string;
  /** Its exit code once it ended, null while it runs. */
  code: number | null;
}

const MAX_OUTPUT = 64 * 1024;
/** Finished landings' folders older than this go when a server starts. */
const KEEP_MS = 14 * 24 * 3600_000;
/** Said when the wrapper ended without writing a code: its unit was stopped, or a restart cut off a child. */
export const NO_CODE = '\n[land.sh ended without an exit code: it was stopped, or a restart cut it off. Check `git log main`.]';

const HANDOFF = 'handoff.json';

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
  /** With stayOpen: what it waits on next. It is never parked (#942): once its work is live it is woken with the shipped line, for its after-land steps. */
  waitingOn?: string;
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
    if (full || list.length) throw new Error('full and files go with into: build/<n>');
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
    throw new Error('this minion\'s worktree is missing');
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
    execFile('bash', ['tools/land.sh', '--check', ...args], { cwd, env, timeout, maxBuffer: MAX_OUTPUT }, (err: any, _out, stderr) => {
      done(err?.code === 3 ? String(stderr).replace(/^land: /gm, '').trim() || 'land.sh --check says it would conflict, but named nothing' : null);
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
    this.prune();
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
  handOff(ticketId: number, cwd: string, env: Record<string, string>, args: string[], h: Handoff): boolean {
    const now = this.get(ticketId);
    if ((now && now.code === null) || existsSync(join(this.dir(ticketId), HANDOFF))) return false;
    this.start(ticketId, cwd, env, args);
    writeFileSync(join(this.dir(ticketId), HANDOFF), JSON.stringify({ ...h, args }));
    return true;
  }

  /** Minions whose handed-off landing isn't reported yet. */
  handoffs(): number[] {
    try {
      return readdirSync(this.root).filter((n) => /^\d+$/.test(n) && existsSync(join(this.root, n, HANDOFF))).map(Number);
    } catch {
      return [];
    }
  }

  handoff(ticketId: number): (Handoff & { args: string[] }) | null {
    try {
      return JSON.parse(readFileSync(join(this.dir(ticketId), HANDOFF), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Reported: it no longer counts as a hand-off. */
  settled(ticketId: number) {
    try {
      renameSync(join(this.dir(ticketId), HANDOFF), join(this.dir(ticketId), 'handoff.done.json'));
    } catch {
      // Already settled.
    }
  }

  /** A message came for the minion (a person's, a relay): if its land is handed off, a clean land then leaves it open. */
  talked(ticketId: number) {
    if (existsSync(join(this.dir(ticketId), HANDOFF))) writeFileSync(join(this.dir(ticketId), 'talked'), '');
  }

  wasTalked(ticketId: number): boolean {
    return existsSync(join(this.dir(ticketId), 'talked'));
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

  /** Drop finished landings' folders from long ago. */
  private prune() {
    let names: string[];
    try {
      names = readdirSync(this.root);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        if (Date.now() - statSync(join(this.root, name, 'code')).mtimeMs > KEEP_MS) rmSync(join(this.root, name), { recursive: true, force: true });
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
  /** The commit main moved to and its subject, from land.sh's "main is now at" line. */
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
  const at = [...output.matchAll(/main is now at ([0-9a-f]{7,40}) "(.*)"/g)].pop();
  const commit = at ? { commit: at[1], subject: at[2] } : {};
  // deploy.sh's lines: "live now:" (front end reloaded, or the restart went live), "nothing to deploy: the server
  // already runs" (live already), "restart queued" / "a restart is already queued" / "not live yet" (waiting on it).
  // Only deploy.sh's own lines: a commit subject or another scheme's land.sh could say the same words.
  if (/^deploy: (live now:|nothing to deploy: the server already runs)/m.test(output)) return { kind: 'live', ...commit };
  if (/^deploy: (restart queued|a restart is already queued|not live yet)/m.test(output)) return { kind: 'restart', ...commit };
  return { kind: 'landed', ...commit };
}

/** The test files tools/always-tests.txt adds to every run: a red in one is a repo-wide snapshot or budget, not the change's own test. */
const ALWAYS_TESTS = ['access-matrix', 'prompt-budget', 'schema-compat', 'pipeline-files'];

/**
 * The kind of red a refused land is (#1013), from land.sh's own output, so the wake leads with one line saying whose
 * problem it is and what to do (a minion once called a syntax error "infra" three times). Null when nothing matches:
 * the wake then keeps its plain text. The first match wins, most specific first.
 */
export function classifyLandFailure(output: string): { kind: string; line: string } | null {
  const failedFiles = [...new Set([...output.matchAll(/✖ ([^ :]+\.test\.ts)(?::\d+)? › /gm)].map((m) => m[1]))];
  const k = (kind: string, line: string) => ({ kind, line });
  if (/(won't (rebase|merge( \S+)? in) onto?\b.*cleanly|^land: smoke: it conflicts with main|^CONFLICT \(|the (rebase onto|merging) .* failed \(see git's output)/m.test(output))
    return k('conflict', 'Kind: merge conflict. Yours: rebase onto main by hand, keep the other minions\' changes, re-test, commit, hand off again.');
  if (/a \.ts file does not parse|^land: smoke: .*SyntaxError/m.test(output))
    return k('parse', 'Kind: parse error (a .ts file does not parse, which would stop the server). Yours, not infra: the lines below name the file and line; fix it, re-test, hand off again.');
  const testsRed = /tests failed on the rebased branch/.test(output) || failedFiles.length > 0;
  if (!testsRed && /failed in its setup step|runner clock:|the runner needs fixing/.test(output))
    return k('ci', 'Kind: CI or runner problem. Not yours: nothing in your change failed. Hand off again; if it repeats, tell the Taskmaster.');
  if (/boot check/i.test(output) && /SQLITE_|database is locked|sqlite.*(crash|abort|segfault)/i.test(output))
    return k('boot-copy', 'Kind: boot-check copy failure (SQLite lock or sqlite crash on the database copy). Not yours: nothing is wrong with your change. Just hand off again.');
  // Only when every rerun-alone label is "passed alone": one "failed again alone" or "hung" makes it a real red.
  if (/: failed in the full run, passed alone/.test(output) && !/: (failed again alone|hung when rerun alone)/.test(output))
    return k('flake', 'Kind: flake (the failed files passed alone, so load, not your change). Not yours: hand off again; no code change needed.');
  const always = failedFiles.filter((f) => ALWAYS_TESTS.some((a) => f.includes(a)));
  if (always.length)
    return k('always-test', `Kind: repo-wide snapshot or budget test (${always.join(', ')}). Your change moved it: regenerate the snapshot, or trim what you added (prompt text, tools, routes), then re-test that file and hand off again.`);
  if (failedFiles.length)
    return k('own-test', `Kind: a test failed (${failedFiles.join(', ')}). Probably yours: run that file alone with citadel-test, fix the code (or the test, if it is out of date), then hand off again.`);
  return null;
}

/** land.sh's phase lines, newest first wins: the note a handed-off land shows in the minions list (#962). */
const PHASES: [RegExp, string][] = [
  [/^(deploy: |land: main is now at )/, 'deploying'],
  [/^land: (waiting for CI|only flakes failed.*running CI once more)/, 'waiting on CI'],
  [/^land: (running |CI FALLBACK)/, 'running tests'],
  [/^land: (rebasing|merging main)/, 'rebasing'],
  [/^land: smoke: /, 'smoke check'],
  [/^queue: got the deploy lock/, 'starting'],
  [/^queue: /, 'in line'],
];

export function landPhase(output: string): string {
  for (const line of output.split('\n').reverse()) for (const [re, phase] of PHASES) if (re.test(line)) return `landing: ${phase}`;
  return 'landing: starting';
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
  const sleep = ops.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = ops.now ?? Date.now;
  const holds = async (name: string, to: string | null) => !!(commit && to && (to.startsWith(commit) || (await ops.has?.(name, commit, to).catch(() => false))));
  const healthy = (name: string, to: string | null) => `Deployed ${name}${to ? ` at ${to.slice(0, 9)}` : ''}, healthy.`;
  const out: AppDeploy[] = [];
  apps: for (const name of names) {
    const until = now() + DEPLOY_WAIT_MS;
    for (let tries = 0; ; tries++) {
      while (ops.running(name) && now() < until) await sleep(3000);
      const before = await ops.last(name);
      if (before?.state === 'deployed' && (await holds(name, before.to))) {
        out.push({ name, ok: true, line: healthy(name, before.to) });
        continue apps;
      }
      try {
        await ops.start(name, ticketId);
        break;
      } catch (err: any) {
        // Another deploy started between the check and this start (auto-deploy's own, still starting): wait, then try once more.
        if (tries) {
          out.push({ name, ok: false, line: `${name}'s deploy couldn't start: ${String(err?.message ?? err).trim()}` });
          continue apps;
        }
        await sleep(3000);
      }
    }
    let d = await ops.last(name);
    while (d?.state === 'running' && now() < until) {
      await sleep(3000);
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
  landings: Pick<Landings, 'handoffs' | 'handoff' | 'get' | 'settled' | 'wasTalked' | 'log'>;
  store: { getTicket(id: number): { status: string; state: string | null; note?: string | null } | undefined | null; updateTicket(id: number, fields: { state?: string | null; note?: string | null }): unknown };
  runner: {
    emit(id: number, kind: string, data: unknown): unknown;
    send(id: number, author: string, text: string, images?: never[], extra?: { fyi?: boolean; light?: boolean }): void;
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
  /** The minion that owns build/<n> for this minion's scheme, if one is set. */
  buildOwner?(id: number, build: number): number | null;
  /** Park the minion until its scheme's CI runners are back; false when it has none to watch. */
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
    for (const id of this.d.landings.handoffs()) {
      if (this.busy.has(id)) continue;
      const run = this.d.landings.get(id);
      const h = this.d.landings.handoff(id);
      if (h && run && run.code === null) this.showLanding(id, run);
      if (!h || !run || run.code === null) continue;
      this.busy.add(id);
      try {
        await this.settle(id, run, h);
        this.d.landings.settled(id);
      } catch (err: any) {
        console.error(`Reporting minion ${id}'s land failed: ${err?.message ?? err}`);
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

  /**
   * A feeder's merge into build/<n> is the build minion's main event: it gets one message that wakes it, parked or
   * cold alike (urgent, and unparked first), so it never sits parked after its feeders are in.
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

  private async settle(id: number, run: Landing, h: Handoff & { args: string[] }) {
    const { store, runner, from } = this.d;
    const r = landResult(run.output, run.code!);
    const tail = () => `The end of its output (all of it: ${this.d.landings.log(id)}):\n\`\`\`\n${outputTail(run.output)}\n\`\`\``;
    if (r.kind === 'failed' || (r.kind === 'no-ci' && !this.d.runnersBack(id, 'Your handed-off land parked because CI gave no verdict (land.sh exit 75). Hand it off again with hand_off_land.'))) {
      store.updateTicket(id, { state: null, note: null });
      runner.broadcastTicket(id);
      const why = r.smoke ? `its smoke check refused it before it got in line, in seconds (nothing landed, and it never waited on the line or CI)` : `tools/land.sh exited ${run.code} (main only moved if its output says so)`;
      const cls = classifyLandFailure(run.output);
      runner.send(id, from, `${cls ? `${cls.line}\n\n` : ''}Your handed-off land didn't go through: ${why}. Fix the cause, re-test, and hand it off again with hand_off_land.\n\n${tail()}`);
      return;
    }
    if (r.kind === 'unpushed') {
      // It landed: the minion pushes it (its turn runs as its person's GitHub login) rather than landing it again.
      const what = r.commit ? `${r.commit} "${r.subject}"` : `the branch's new tip`;
      const apps = h.deploy !== false && this.d.deployOps ? (this.d.apps?.(id) ?? []) : [];
      store.updateTicket(id, { state: null, note: 'shipped locally; push to origin failed' });
      runner.broadcastTicket(id);
      runner.emit(id, 'note', { text: `Shipped ${what}: ${h.summary.trim().replace(/[.\s]+$/, '')}. Risk ${h.risk}. Shipped locally, not pushed to origin: the push failed.` });
      runner.send(id, from, `Your handed-off land merged, but isn't on GitHub: ${r.branch} moved locally to ${what}, and the push to origin failed: ${r.error}\n\nDon't hand it off again: nothing is left to land. Push it from your worktree with \`git push origin ${r.branch}\` (branches are shared with the main checkout; the next land retries it too). "Repository not found" or a 403 means the GitHub login can't reach the repo: tell the person, never try another login. If origin's ${r.branch} moved on its own (non-fast-forward), a person merges it first. close_self once it's pushed.${apps.length ? ` The scheme's apps (${apps.join(', ')}) weren't deployed for it: deploy_contraption once it's pushed.` : ''}\n\n${tail()}`);
      return;
    }
    if (r.kind === 'no-ci') {
      store.updateTicket(id, { state: 'parked', note: 'ship parked: waiting for CI runners' });
      runner.broadcastTicket(id);
      runner.emit(id, 'note', { text: `Shipping parked: CI gave no verdict (land.sh exit 75), most likely because the runners' machine is off. This minion is woken once the scheme's runners are back, to hand it off again.` });
      return;
    }
    const into = h.args[0] === '--into' ? h.args[1] : null;
    if (!into && r.commit) this.d.landed?.(id, r.commit);
    const what = r.commit ? `${r.commit} "${r.subject}"` : into ? `into ${into}` : 'the branch';
    const where = r.kind === 'live' ? 'Live now.' : r.kind === 'restart' ? 'Waiting for the restart.' : into ? `Merged into ${into}, not live until the build ships.` : 'Shipped.';
    const strip = (s: string) => s.trim().replace(/[.\s]+$/, '');
    // On main, the scheme's apps go out now rather than at auto-deploy's next quiet spell (#712), and the line says how.
    const apps = !into && h.deploy !== false && this.d.deployOps ? (this.d.apps?.(id) ?? []) : [];
    if (apps.length) {
      store.updateTicket(id, { note: `shipped: deploying ${apps.join(', ')}` });
      runner.broadcastTicket(id);
    }
    const deploys = apps.length ? await deployApps(id, apps, r.commit, this.d.deployOps!) : [];
    const failed = deploys.filter((d) => !d.ok);
    runner.emit(id, 'note', { text: `Shipped ${what}: ${strip(h.summary)}. Risk ${h.risk}: ${strip(h.reason)}.${h.go ? ` Go: ${strip(h.go)}.` : ''} ${where}${deploys.map((d) => ` ${d.line}`).join('')}` });
    this.wakeBuildOwner(id, into, `${strip(h.summary)}. Risk ${h.risk}: ${strip(h.reason)}.`);
    const t = store.getTicket(id);
    if (!t || t.status === 'closed') return;
    if (r.kind === 'restart' && !h.stayOpen) {
      store.updateTicket(id, { state: 'pending-deploy', note: 'deployed, live after the restart' });
      runner.deployPending(id);
      runner.broadcastTicket(id);
    }
    // The land shipped but an app didn't go live: the minion fixes it with its own context.
    if (failed.length) {
      if (r.kind !== 'restart') {
        store.updateTicket(id, { state: null, note: null });
        runner.broadcastTicket(id);
      }
      runner.send(id, from, `Your handed-off land went through (${what}, ${where.toLowerCase().replace(/\.$/, '')}), but the deploy after it didn't go live:\n\n${failed.map((f) => (f.detail ? `${f.line}\n${f.detail}` : f.line)).join('\n\n')}\n\nFix the cause and hand the fix off with hand_off_land, which deploys again (deploy_contraption redeploys main as it is). close_self once nothing is left.`);
      return;
    }
    // Someone wrote while it was in line (a person, a relay): the minion answers them before it goes.
    if (this.d.landings.wasTalked(id)) {
      if (r.kind !== 'restart' || h.stayOpen) {
        store.updateTicket(id, { state: null, note: null });
        runner.broadcastTicket(id);
      }
      // light (#951): a land that landed is a success notice; whoever wrote meanwhile keeps the minion's own effort.
      runner.send(id, from, `Your handed-off land went through (${what}, ${where.toLowerCase().replace(/\.$/, '')}). Someone wrote to you while it was in line, so the server left this minion open: ${r.kind === 'restart' && !h.stayOpen ? 'it stays in pending-deploy unless you set another state' : 'close_self once nothing is left for them'}.`, [], { light: true });
      return;
    }
    if (h.stayOpen && h.waitingOn) {
      // #942: never parked, since nothing would wake it. It is woken once its work is in (after the restart, through
      // wake_when_live's waiter), once, and sets its own state from there.
      const restart = r.kind === 'restart' && !(await this.d.liveAlready(id));
      const text = (now: string) => `Your handed-off land went through (${what}, ${now}). You handed it off waiting on: ${h.waitingOn}. Run your after-land steps now, then set your state for that wait: a person's test, card or confirmation leaves it null (or try); another minion's land is wake_when_live on its commit, then parked.`;
      // true: the waiter wakes it at live; false: live already; undefined: no waiter here, so it hears now.
      const queued = restart ? await this.d.wakeWhenLive?.(id, r.commit ?? null, text('live now')) : undefined;
      store.updateTicket(id, { state: queued ? 'outside' : null, note: `${queued ? 'shipped, wakes once live' : 'shipped'}; waiting on: ${h.waitingOn}`.slice(0, 120) });
      runner.broadcastTicket(id);
      if (!queued) runner.send(id, from, text(r.kind !== 'restart' ? where.toLowerCase().replace(/\.$/, '') : queued === undefined && restart ? 'live after the restart' : 'live now'), [], { light: true });
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
      runner.emit(id, 'note', { text: `It shipped, but ${kept}, so this minion stays open.` });
      return;
    }
    const why = r.kind === 'live' ? 'Shipped and live' : 'Shipped';
    if (runner.isRunning(id) || runner.queued(id)) {
      store.updateTicket(id, { state: null, note: null });
      runner.broadcastTicket(id);
      if (!runner.closeAfterTurn(id, `${why}.`)) runner.emit(id, 'note', { text: `${why}; this minion has a turn running or queued, so it stays open.` });
      return;
    }
    store.updateTicket(id, { state: null, note: into ? `merged into Build ${into.slice('build/'.length)}` : null });
    this.d.landings.settled(id);
    await runner.close(id, `${why}, so the server dismissed this minion.`);
  }
}
