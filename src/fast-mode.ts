// Fast mode, testing behind (#1017, docs/adr/0011-fast-mode.md). In a scheme whose land mode is fast, low and
// medium lands go live on the smoke check alone (the kit's land.sh, LAND_FAST), and this runs the full check and CI
// on main behind them: `tools/land.sh --verify` in a worktree of its own, outside the deploy lock, one run per
// scheme, always on main's newest head (Cara, 2026-11-18: "One run, newest main"). A red that covers several lands
// is pinned on its culprit by verifying the range's commits oldest first. The culprit's minion is reopened with the
// failure ("Reopen that minion"); after 30 minutes unfixed, the scheme's Taskmaster gets it. Each failing id is kept
// in the scheme's known-red ledger until it passes on main: later lands and runs that fail only on those ids blame
// nobody, and land.sh lets them through (LAND_KNOWN_RED).
// The quick scheme (#2244, quick train piece 4; tools/land/behind.sh): Citadel's own lands are never fast, but a quick train
// ships on its quick check alone and owes the full suite one verdict on its top. land.sh lists those in its state folder's
// quick-behind file; the run behind starts once the line is empty (else the next full train's own run counts, and land.sh
// marks its red there), and a red is pinned on [the quick train's base, each of its ships' tops]: a red on the base was
// main's before it (the Taskmaster's), and a file that passes alone everywhere blames nobody. The file holds nothing while
// the gap train is off, so nothing runs and nothing is written.
import { execFile } from 'node:child_process';
import { access, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { moveAside, type HostJobs } from './host-job.ts';
import { thrown } from './thrown.ts';

const run = promisify(execFile);

/** One entry of a scheme's known-red ledger: ids failing on main since `sha`, which `ticket`'s minion owns. */
export interface KnownRed {
  ids: string[];
  /** The culprit commit (the run's commit when the range was too long to pin). */
  sha: string;
  /** The culprit's minion (ticket id) and its #N, or null when none could be found: the Taskmaster has it from the start. */
  ticket: number | null;
  n?: number;
  at: number;
  /** The Taskmaster was told (at the start, or after the 30 minutes). */
  escalated?: boolean;
}

interface Pinning {
  /** Main's head the red run was on, where the run moves on to once the culprit is found. */
  head: string;
  /** The range's commits before `head`, oldest first, and which of them is next. */
  shas: string[];
  next: number;
  /** The run on `shas[next]` gave no verdict once and is being run again; a second goes to the Taskmaster unpinned. */
  retried?: boolean;
  /** The ids no ledger entry had and no commit is blamed for yet: the first commit failing on one is its culprit. */
  ids: string[];
  /** When the red was seen (the 30 minutes start then), and its run's output, for the ids left on `head`. */
  at?: number;
  output?: string;
  /** The quick scheme's pin: shas are [the quick train's base, its ships' tops]; `owners` each top's #N. */
  quick?: QuickRun;
}

/** A quick train's line in land.sh's quick-behind file: the full train's top it went on, and each ship's top with its #N. */
interface QuickRun {
  base: string;
  owners: Record<string, number | null>;
}

export interface FastState {
  /** The newest commit of main the suite has a verdict on (green, or red only on known ids, or pinned). */
  verified?: string;
  /** The commit the suite last gave no verdict on (CI never answered, land.sh crashed): not retried until main moves. */
  stuck?: string;
  /** The quick scheme's: when `stuck` gave no verdict; that quick top is run again QUICK_WAIT_MS later. */
  stuckAt?: number;
  /** What runs now. */
  running?: { sha: string; at: number; stale?: boolean; quick?: QuickRun; recheck?: number };
  pin?: Pinning;
  reds: KnownRed[];
  /** A landing's commit on main, to the minion that landed it (newest 200). */
  landed: Record<string, number>;
  /** The quick scheme: the quick tops with a verdict (newest 50). */
  done?: string[];
}

export interface FastModeDeps {
  /** The schemes in fast mode, with their clones; `quick`, for a scheme whose land.sh ships quick trains, its land state folder (cc-deploy). */
  schemes: () => { id: number; repo: string; quick?: string }[];
  get: (key: string) => FastState | undefined;
  set: (key: string, value: FastState) => void;
  jobs: Pick<HostJobs, 'start' | 'look'>;
  /** A scheme's folder for the run: its worktree and its job. */
  dir: (projectId: number) => string;
  /** The run's environment: as a landing's, for the minion that landed the head (or the Taskmaster). */
  env: (projectId: number, ticketId: number | null) => Record<string, string>;
  /** A minion's ticket id by its #N in the scheme, for a culprit commit's "#N" when no landing recorded it; and back. */
  ticketOf: (projectId: number, n: number) => number | null;
  numberOf: (ticketId: number) => number | null;
  /** Message a minion, reopening it if it closed. */
  tell: (ticketId: number, text: string) => void;
  /** Tell the scheme's Taskmaster (wakes it). */
  taskmaster: (projectId: number, text: string) => void;
  /** Main's head went green: last green for the roll back (src/last-green.ts). */
  green: (projectId: number, sha: string) => void;
  /** A verify run's output, for the flakes it names (#1063). */
  flakes?: (projectId: number, sha: string, output: string) => void;
  now?: () => number;
  git?: (cwd: string, ...args: string[]) => Promise<string>;
}

const key = (projectId: number) => `fast-mode:${projectId}`;
/** A red left unfixed this long goes to the Taskmaster (the handoff's 30 minutes). */
export const ESCALATE_MS = 30 * 60_000;
/** The most commits a red's range is pinned through; a longer one goes to the Taskmaster unpinned. */
export const PIN_MAX = 8;
/** A quick top waits this long for the next full train's run to count before it gets one of its own, the line busy or not. */
export const QUICK_WAIT_MS = 30 * 60_000;
// shortcut: every scheme's branch is main, as land.sh's BRANCH default; read land.local.sh's BRANCH if one moves.
const BRANCH = 'main';
/** The ids land.sh --verify gives a failure it can't name: a red only on one of these says nothing of the other ids. */
const UNNAMED = ['the check', 'CI'];

/** What --verify printed: green, red with its failing ids, or no verdict. */
export function verifyResult(output: string): { verdict: 'green' } | { verdict: 'red'; ids: string[] } | { verdict: 'none' } {
  if (/^verify: green$/m.test(output)) return { verdict: 'green' };
  if (/^verify: red$/m.test(output)) return { verdict: 'red', ids: [...new Set([...output.matchAll(/^verify: failing (.+)$/gm)].map((m) => m[1]))] };
  return { verdict: 'none' };
}

/** The last 40 lines of a run's output, without its verify: lines. */
const tailOf = (output: string) =>
  output
    .trim()
    .split('\n')
    .filter((l) => !/^verify: /.test(l))
    .slice(-40)
    .join('\n');

export class FastMode {
  /** The pass that runs now; a tick meanwhile asks it to go round again, and waits for it. */
  private busy: Promise<void> | null = null;
  private again = false;
  /** Each scheme's failure as last said: a failure that repeats is said once, not every 30 s. */
  private said = new Map<number, string>();
  /** The schemes reset since their pass began: that pass tells nobody and doesn't write its old state back. */
  private resetMidPass = new Set<number>();
  private readonly d: FastModeDeps;
  private readonly now: () => number;
  private readonly git: (cwd: string, ...args: string[]) => Promise<string>;

  constructor(d: FastModeDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.git = d.git ?? (async (cwd, ...args) => (await run('git', args, { cwd, maxBuffer: 4 << 20 })).stdout.trim());
  }

  private state(projectId: number): FastState {
    return { reds: [], landed: {}, ...this.d.get(key(projectId)) };
  }

  /** The known-red ledger as land.sh's LAND_KNOWN_RED reads it: "id<TAB>who" lines, who as land.sh prints it after
   * "known red, ". Ids still being pinned count too: main fails on them whoever lands next. */
  knownRed(projectId: number): string {
    const s = this.state(projectId);
    const who = (e: KnownRed) => (e.n ? `#${e.n} is fixing it` : 'the Taskmaster has it');
    return [...s.reds.flatMap((e) => e.ids.map((id) => `${id}\t${who(e)}`)), ...(s.pin?.ids ?? []).map((id) => `${id}\tCitadel is finding whose change broke it`)].join('\n');
  }

  /** What the Test health tab shows (#1063): the run's state, what is known red and when each red reaches the Taskmaster. */
  view(projectId: number) {
    const s = this.state(projectId);
    return {
      state: s.running ? 'running' : s.pin ? 'pinning' : s.stuck && s.stuck !== s.verified ? 'stuck' : s.verified ? 'verified' : 'idle',
      verified: s.verified ?? null,
      stuck: s.stuck ?? null,
      running: s.running ? { sha: s.running.sha, at: s.running.at } : null,
      pin: s.pin ? { ids: s.pin.ids, at: s.pin.at ?? null } : null,
      reds: s.reds.map((e) => ({ ids: e.ids, sha: e.sha, n: e.n ?? null, at: e.at, escalated: !!e.escalated, escalateAt: e.at + ESCALATE_MS })),
    };
  }

  /** Fast mode was turned on: start from main's head as it is now, with no ledger from an earlier spell. A run still
   * going (fast, off and fast again) is kept so its job isn't started twice, but its result is dropped: it may have been
   * a pinning run that checked only a few ids. */
  reset(projectId: number) {
    this.resetMidPass.add(projectId);
    const { running } = this.state(projectId);
    this.d.set(key(projectId), { reds: [], landed: {}, ...(running ? { running: { ...running, stale: true } } : {}) });
  }

  /** A clean land on main (src/land.ts): who landed `commit`, and a run now if nothing runs. */
  landed(projectId: number, ticketId: number, commit: string): Promise<void> {
    const s = this.state(projectId);
    if (this.quickDir(projectId) !== undefined) {
      // The quick scheme: a culprit's ship is kept for a recheck, its red's files run alone on it (quickNext), as a ship
      // through main's red may not have fixed them. Nobody else's landing is kept: a quick train's tops are in land.sh's line.
      if (s.reds.some((e) => e.ticket === ticketId)) this.d.set(key(projectId), { ...s, landed: { ...s.landed, [commit]: ticketId } });
      return this.tick();
    }
    s.landed[commit] = ticketId;
    const keys = Object.keys(s.landed);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete s.landed[k];
    this.d.set(key(projectId), s);
    return this.tick();
  }

  /** Whether the scheme is the quick scheme: its ships tell landed(), whatever its land mode. */
  quick(projectId: number): boolean {
    return this.quickDir(projectId) !== undefined;
  }

  private quickDir(projectId: number): string | undefined {
    return this.d.schemes().find((p) => p.id === projectId)?.quick;
  }

  /** Every ~30 s and on each land: read finished runs, escalate old reds, start the next run. */
  tick(): Promise<void> {
    if (this.busy) {
      this.again = true;
      return this.busy;
    }
    return (this.busy = this.loop().finally(() => (this.busy = null)));
  }

  private async loop() {
    do {
      this.again = false;
      for (const p of this.d.schemes()) {
        try {
          await this.step(p.id, p.repo, p.quick);
          if (this.said.delete(p.id)) console.log(`Fast mode for scheme ${p.id} works again.`);
        } catch (err) {
          const msg = String(thrown(err).stderr || thrown(err).message || err).trim();
          if (this.said.get(p.id) !== msg) console.error(`Fast mode for scheme ${p.id} failed: ${msg}`);
          this.said.set(p.id, msg);
        }
      }
    } while (this.again);
  }

  private async step(projectId: number, repo: string, quick?: string) {
    const s = this.state(projectId);
    // The quick scheme with nothing owed, going or red: nothing runs and nothing is written (the gap train off, most often).
    if (quick !== undefined && !s.running && !s.pin && !s.reds.length && !(await this.owedLines(quick)).length) return;
    const jobDir = join(this.d.dir(projectId), 'job');
    this.resetMidPass.delete(projectId);
    // land() writes `landed` while this awaits git: save with the newest map, not the one read here. A reset meanwhile
    // wins: only the run this pass leaves going is kept, its result dropped, so its job isn't started twice.
    const save = () => {
      const { running: _, ...now } = this.state(projectId);
      if (this.resetMidPass.has(projectId)) return this.d.set(key(projectId), { ...now, ...(s.running ? { running: { ...s.running, stale: true } } : {}) });
      this.d.set(key(projectId), { ...s, landed: now.landed });
    };
    if (s.running) {
      const job = await this.d.jobs.look(jobDir, 20_000);
      if (job && job.code === null) {
        this.escalate(projectId, s);
        return save();
      }
      const { sha, stale, quick: q, recheck } = s.running;
      delete s.running;
      if (!stale && job) this.d.flakes?.(projectId, sha, job.output);
      if (!stale && recheck !== undefined) this.readRecheck(projectId, s, recheck, job ? verifyResult(job.output) : { verdict: 'none' });
      else if (!stale) await this.read(projectId, repo, s, sha, job ? verifyResult(job.output) : { verdict: 'none' }, job?.output ?? '', q);
    }
    this.escalate(projectId, s);
    // Saved before more git: a throw from here on mustn't leave the finished run in `running`, read (and told) again (2R3).
    save();
    if (quick !== undefined) {
      await this.quickNext(projectId, repo, quick, s);
      return save();
    }
    const next = s.pin ? s.pin.shas[s.pin.next] : await this.git(repo, 'rev-parse', `refs/heads/${BRANCH}`);
    if (next && (s.pin || (next !== s.verified && next !== s.stuck))) await this.start(projectId, repo, s, next);
    save();
  }

  private async start(projectId: number, repo: string, s: FastState, sha: string, quick?: QuickRun, recheck?: { ticket: number; ids: string[] }) {
    const wt = join(this.d.dir(projectId), 'wt');
    await mkdir(this.d.dir(projectId), { recursive: true, mode: 0o700 });
    const linked = () =>
      access(join(wt, '.git')).then(
        () => true,
        () => false,
      );
    // Its own detached worktree, kept between runs so what the check installs (node_modules, a venv) stays.
    // A folder whose .git file points at an entry the repo no longer has (a prune that couldn't see the folder, as a
    // container turn can't) is no worktree: start it over, losing only what the check installed in it.
    if (
      (await linked()) &&
      !(await this.git(wt, 'rev-parse', '--git-dir').then(
        () => true,
        () => false,
      ))
    ) {
      moveAside(wt); // off the server's thread (a worktree with its installs is big), and never left half deleted by a restart (#1734)
      console.log(`Fast mode for scheme ${projectId}: its worktree had lost its git link; rebuilding it.`);
    }
    if (!(await linked())) {
      await this.git(repo, 'worktree', 'prune');
      // Locked, so no `git worktree prune` from anywhere else drops it again.
      await this.git(repo, 'worktree', 'add', '-q', '--detach', '--lock', '--reason', 'Citadel fast mode', wt, sha);
    } else await this.git(wt, 'checkout', '-q', '-f', '--detach', sha);
    // A pinning run checks only the ids it is pinning (land.sh reruns just their files when it can).
    const q = quick ?? s.pin?.quick;
    const n = q?.owners[sha];
    const who = q ? (n ? this.d.ticketOf(projectId, n) : null) : this.owner(s, sha);
    const ids = s.pin ? s.pin.ids : (recheck?.ids ?? []);
    const env = { ...this.d.env(projectId, recheck ? recheck.ticket : who), LAND_KNOWN_RED: '', LAND_FAST: '', LAND_VERIFY_IDS: ids.join('\n'), ...(q ? { LAND_VERIFY_BASE: q.base } : {}) };
    this.d.jobs.start({ dir: join(this.d.dir(projectId), 'job'), cwd: wt, argv: ['bash', 'tools/land.sh', '--verify'], env, unit: `citadel-fast-verify-${projectId}-${Date.now()}`, description: `tools/land.sh --verify ${sha.slice(0, 9)} (fast mode)`, ticketId: 0 });
    s.running = { sha, at: this.now(), ...(quick ? { quick } : {}), ...(recheck ? { recheck: recheck.ticket } : {}) };
  }

  /** land.sh's quick-behind lines: "<epoch> <base> <top> <ship top>:<#N, or -> ... [red=<file>,...]" (tools/land/behind.sh). */
  private async owedLines(dir: string) {
    const text = await readFile(join(dir, 'quick-behind'), 'utf8').catch(() => '');
    return text
      .split('\n')
      .map((l) => l.trim().split(/\s+/))
      .filter((w) => w.length >= 4 && /^\d+$/.test(w[0]) && /^[0-9a-f]{40}$/.test(w[1]) && /^[0-9a-f]{40}$/.test(w[2]))
      .map((w) => {
        const red = w.find((x) => x.startsWith('red='));
        const ships = w.slice(3).filter((x) => /^[0-9a-f]{40}:(\d+|-)$/.test(x));
        const owners: Record<string, number | null> = {};
        for (const x of ships) owners[x.slice(0, 40)] = x.endsWith(':-') ? null : Number(x.slice(41));
        return { at: Number(w[0]) * 1000, base: w[1], top: w[2], tops: ships.map((x) => x.slice(0, 40)), owners, red: red ? red.slice(4).split(',').filter(Boolean) : null };
      });
  }

  /** The quick scheme's next run: the pin's next commit, else the oldest quick top on main still owed a verdict. */
  private async quickNext(projectId: number, repo: string, dir: string, s: FastState) {
    if (s.running) return;
    if (s.pin) return this.start(projectId, repo, s, s.pin.shas[s.pin.next]);
    // A culprit shipped: its red's files run alone on that ship's commit, and only those that pass there leave the ledger.
    for (const [commit, ticket] of Object.entries(s.landed)) {
      const ids = s.reds.filter((e) => e.ticket === ticket).flatMap((e) => e.ids);
      if (ids.length) return this.start(projectId, repo, s, commit, undefined, { ticket, ids });
    }
    const main = await this.git(repo, 'rev-parse', `refs/heads/${BRANCH}`);
    for (const l of await this.owedLines(dir)) {
      if (s.done?.includes(l.top)) continue;
      if (!l.red && s.stuck === l.top && this.now() - (s.stuckAt ?? 0) < QUICK_WAIT_MS) continue; // no verdict: again later
      const onMain = await this.git(repo, 'merge-base', '--is-ancestor', l.top, main).then(
        () => true,
        () => false,
      );
      if (!onMain) continue; // rolled back: nothing of it is live to verify
      const quick: QuickRun = { base: l.base, owners: l.owners };
      if (l.red) {
        // The next full train's run was red on these, and they fail alone on main's tip, this top: pinned with no run of its own.
        this.markDone(s, l.top);
        const known = new Set(s.reds.flatMap((e) => e.ids));
        const fresh = l.red.filter((id) => !known.has(id));
        if (!fresh.length) continue;
        s.pin = { head: l.top, shas: [l.base, ...l.tops], next: 0, ids: fresh, at: this.now(), output: `${fresh.join(', ')} failed in the next full train's CI run and alone on ${l.top.slice(0, 12)}, the quick train's top.`, quick };
        return this.start(projectId, repo, s, l.base);
      }
      // The next full train's own run counts: while ships wait in line, one will run CI over this top (QUICK_WAIT_MS at most).
      if (this.now() - l.at < QUICK_WAIT_MS && (await this.lineBusy(dir))) return;
      return this.start(projectId, repo, s, l.top, quick);
    }
  }

  private markDone(s: FastState, top: string) {
    s.done = [...(s.done ?? []).filter((t) => t !== top), top].slice(-50);
  }

  /** Whether a ship waits or lands in the deploy line (tools/deploy-queue.sh's <state>/queue/<ticket> files). */
  private async lineBusy(dir: string) {
    return (await readdir(join(dir, 'queue')).catch(() => [] as string[])).some((f) => /^\d+$/.test(f));
  }

  /** The minion that landed `sha`: the landing whose commit is `sha` or the nearest after it on main. */
  /** Landings may be recorded by a short sha (land.sh's "landed" line), so a prefix of at least 7 matches. */
  private owner(s: FastState, sha: string, after: string[] = []): number | null {
    const keys = Object.keys(s.landed).filter((k) => k.length >= 7);
    for (const c of [sha, ...after]) {
      const k = s.landed[c] != null ? c : keys.find((k) => c.startsWith(k) || k.startsWith(c));
      if (k) return s.landed[k];
    }
    return null;
  }

  private async read(projectId: number, repo: string, s: FastState, sha: string, r: ReturnType<typeof verifyResult>, output: string, quick?: QuickRun) {
    if (s.pin) {
      // Each id is blamed on the first commit failing it; the rest go on to the next commit, and what's left at the
      // end is the head's own commit's (the quick scheme's: nobody's, as its head is run too).
      const pin = s.pin;
      const q = pin.quick;
      const hit = r.verdict === 'red' ? pin.ids.filter((id) => r.ids.includes(id)) : [];
      if (hit.length) {
        pin.ids = pin.ids.filter((id) => !hit.includes(id));
        if (q && sha === q.base) await this.open(projectId, repo, s, sha, hit, output, `on ${sha.slice(0, 12)}, the full train's top the quick train went on, so it was main's red before the quick train and no ship of it is to blame`, pin.at, q);
        else await this.open(projectId, repo, s, sha, hit, output, undefined, pin.at, q);
      }
      // No verdict, or red on a failure it couldn't name (which may have kept the rest from running): the ids left
      // neither passed nor failed on this commit, so they are run again once, then the pin stops rather than blame a
      // later commit's minion.
      if (pin.ids.length && (r.verdict === 'none' || (r.verdict === 'red' && r.ids.some((id) => UNNAMED.includes(id))))) {
        if (!pin.retried) {
          pin.retried = true;
          return;
        }
        delete s.pin;
        if (!q) s.verified = pin.head;
        return this.open(projectId, repo, s, pin.head, pin.ids, pin.output ?? '', `on ${pin.head.slice(0, 12)}; pinning it on ${sha.slice(0, 12)} gave no verdict twice, so no culprit was found`, pin.at, q);
      }
      if (pin.ids.length && pin.next + 1 < pin.shas.length) {
        pin.next++;
        delete pin.retried;
        return;
      }
      delete s.pin;
      if (q) {
        // Passed alone on the base and every ship's top, the quick top too: a flake, which blames nobody (the spec).
        if (pin.ids.length) console.log(`Quick train behind ${pin.head.slice(0, 12)} in scheme ${projectId}: ${pin.ids.join(', ')} passed alone on every ship, so nobody is blamed.`);
        return;
      }
      s.verified = pin.head;
      if (pin.ids.length) await this.open(projectId, repo, s, pin.head, pin.ids, pin.output ?? '', undefined, pin.at);
      return;
    }
    if (quick) return this.readQuick(projectId, repo, s, sha, r, output, quick);
    if (r.verdict === 'none') {
      s.stuck = sha;
      return;
    }
    const failing = r.verdict === 'red' ? r.ids : [];
    // Each id that passes now leaves the ledger; an entry with none left is fixed.
    for (const e of s.reds) e.ids = e.ids.filter((id) => failing.includes(id));
    s.reds = s.reds.filter((e) => e.ids.length);
    const known = new Set(s.reds.flatMap((e) => e.ids));
    const fresh = failing.filter((id) => !known.has(id));
    const from = s.verified;
    s.verified = sha;
    if (r.verdict === 'green') {
      this.d.green(projectId, sha);
      return;
    }
    if (!fresh.length) return; // red only on known ids: blame nobody
    // The first run since fast mode went on: main was red before any fast land, so no minion's land is to blame.
    if (!from) return this.open(projectId, repo, s, sha, fresh, output, `on ${sha.slice(0, 12)}, the first run since fast mode went on, so it was red before any fast ship`);
    const range = (await this.git(repo, 'rev-list', '--reverse', '--first-parent', `${from}..${sha}`).catch(() => '')).split('\n').filter(Boolean);
    if (range.length <= 1) return this.open(projectId, repo, s, sha, fresh, output);
    if (range.length - 1 > PIN_MAX) return this.open(projectId, repo, s, sha, fresh, output, `on ${sha.slice(0, 12)}, after ${range.length} ships: more than ${PIN_MAX} to pin the culprit`);
    s.verified = from;
    s.pin = { head: sha, shas: range.slice(0, -1), next: 0, ids: fresh, at: this.now(), output: tailOf(output) };
  }

  /** The quick scheme's full run on a quick top: the ledger as for a fast run; a new red pinned on the quick train's base
   * and each of its ships' tops. */
  private async readQuick(projectId: number, repo: string, s: FastState, sha: string, r: ReturnType<typeof verifyResult>, output: string, quick: QuickRun) {
    if (r.verdict === 'none') {
      // Still owed: run again QUICK_WAIT_MS later, until it has a verdict or a full ship lands green over it (its line goes).
      console.log(`Quick train behind ${sha.slice(0, 12)} in scheme ${projectId}: its full run gave no verdict; it runs again in ${QUICK_WAIT_MS / 60_000} minutes.`);
      s.stuck = sha;
      s.stuckAt = this.now();
      return;
    }
    this.markDone(s, sha);
    const failing = r.verdict === 'red' ? r.ids : [];
    for (const e of s.reds) e.ids = e.ids.filter((id) => failing.includes(id));
    s.reds = s.reds.filter((e) => e.ids.length);
    if (r.verdict === 'green') return this.d.green(projectId, sha);
    const known = new Set(s.reds.flatMap((e) => e.ids));
    const fresh = failing.filter((id) => !known.has(id));
    if (!fresh.length) return; // red only on known ids: blame nobody
    const named = fresh.filter((id) => !UNNAMED.includes(id));
    if (!named.length) return this.open(projectId, repo, s, sha, fresh, output, `on ${sha.slice(0, 12)}, a quick train's top, with no test file to name`, undefined, quick);
    const tops = Object.keys(quick.owners);
    s.pin = { head: sha, shas: [quick.base, ...(tops.includes(sha) ? tops : [...tops, sha])], next: 0, ids: named, at: this.now(), output: tailOf(output), quick };
  }

  /** A culprit's recheck: its ids that passed alone on its ship's commit leave the ledger; no verdict keeps them all
   * (shortcut: not run again; its next ship rechecks, and the Taskmaster has it after 30 minutes meanwhile). */
  private readRecheck(projectId: number, s: FastState, ticket: number, r: ReturnType<typeof verifyResult>) {
    // Off the store too: save() keeps the stored landings (land() may write one meanwhile), so this one must go there.
    const drop = (m: Record<string, number>) => Object.fromEntries(Object.entries(m).filter(([, t]) => t !== ticket));
    s.landed = drop(s.landed);
    this.d.set(key(projectId), { ...this.state(projectId), landed: drop(this.state(projectId).landed) });
    if (r.verdict === 'none' || (r.verdict === 'red' && r.ids.some((id) => UNNAMED.includes(id)))) return;
    const failing = r.verdict === 'red' ? r.ids : [];
    for (const e of s.reds) if (e.ticket === ticket) e.ids = e.ids.filter((id) => failing.includes(id));
    s.reds = s.reds.filter((e) => e.ids.length);
  }

  /** A new red: its ledger entry, and its culprit's minion told (the Taskmaster when there is none, or it wasn't pinned). */
  /** `unpinned`: why no commit could be blamed (the Taskmaster gets it at once). */
  /** `quick`: a quick train's red, its owners by ship top. */
  private async open(projectId: number, repo: string, s: FastState, sha: string, ids: string[], output: string, unpinned?: string, at = this.now(), quick?: QuickRun) {
    const pinned = !unpinned;
    let ticket: number | null = null;
    if (pinned && quick) {
      const n = quick.owners[sha];
      ticket = n ? this.d.ticketOf(projectId, n) : null;
    } else if (pinned) {
      const after = (await this.git(repo, 'rev-list', '--reverse', '--first-parent', '--ancestry-path', `${sha}..refs/heads/${BRANCH}`).catch(() => '')).split('\n').filter(Boolean);
      ticket = this.owner(s, sha, after);
    }
    if (pinned && ticket == null) {
      const n = Number(/#(\d+)/.exec(await this.git(repo, 'log', '-1', '--format=%s', sha).catch(() => ''))?.[1]);
      ticket = n ? this.d.ticketOf(projectId, n) : null;
    }
    if (this.resetMidPass.has(projectId)) return; // reset while this looked: its ledger is gone, so nobody is told
    const n = ticket != null ? this.d.numberOf(ticket) : null;
    const entry: KnownRed = { ids, sha, ticket, ...(n ? { n } : {}), at };
    s.reds.push(entry);
    const list = ids.map((id) => `- ${id}`).join('\n');
    const tail = tailOf(output);
    const behind = quick ? 'a quick train' : 'fast-mode ships';
    const what = `The full suite went red on ${BRANCH} behind ${behind}, ${unpinned ?? `on ${sha.slice(0, 12)}, the first ${quick ? "ship's top" : 'commit'} it fails on`}. New failing ${quick ? 'test files' : 'ids'}:\n${list}`;
    if (ticket != null) {
      this.d.tell(
        ticket,
        quick
          ? `${what}\n\nIt's yours to fix: each file failed alone, twice, on your ship's top and passed on the ship before it. Your fix goes first: Citadel tags you urgent, which puts it at the front of the line. Meanwhile ships that fail only on it go through main's red. Fix it on your branch and hand it off with hand_off_land; once it ships, Citadel runs each file alone on it, and a pass there clears it. If you're sure it isn't yours, tell the Taskmaster why with message_coordinator. Unfixed in 30 minutes, the Taskmaster gets it.${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''}`
          : `${what}\n\nIt's yours to fix: your change is the culprit. Each id is in the scheme's known-red ledger, so other ships that fail only on it go through and say you're fixing it; it clears once it passes on ${BRANCH}. Fix it on your branch and hand it off with hand_off_land. If nobody has fixed it in 30 minutes, the Taskmaster gets it.${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''}`,
      );
      return;
    }
    entry.escalated = true;
    this.d.taskmaster(
      projectId,
      `${what}\n\n${pinned ? 'No minion could be found for that commit' : 'No one minion can be blamed'}, so it's yours: start a fix, or reopen whoever broke it. Each id is a known red until it passes on ${BRANCH}; until then lands that fail only on it go through.${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''}`,
    );
  }

  private escalate(projectId: number, s: FastState) {
    if (this.resetMidPass.has(projectId)) return;
    for (const e of s.reds) {
      if (e.escalated || this.now() - e.at < ESCALATE_MS) continue;
      e.escalated = true;
      this.d.taskmaster(projectId, `A ${this.quick(projectId) ? 'red behind a quick train' : 'fast-mode red'} on ${BRANCH} has gone 30 minutes unfixed: ${e.ids.join(', ')}, from ${e.sha.slice(0, 12)}${e.n ? `, given to #${e.n}` : ''}. Take it on: chase that minion, or start a fix.`);
    }
  }
}
