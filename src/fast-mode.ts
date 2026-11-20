// Fast mode, testing behind (#1017, docs/adr/0011-fast-mode.md). In a scheme whose land mode is fast, low and
// medium lands go live on the smoke check alone (the kit's land.sh, LAND_FAST), and this runs the full check and CI
// on main behind them: `tools/land.sh --verify` in a worktree of its own, outside the deploy lock, one run per
// scheme, always on main's newest head (Cara, 2026-11-18: "One run, newest main"). A red that covers several lands
// is pinned on its culprit by verifying the range's commits oldest first. The culprit's minion is reopened with the
// failure ("Reopen that minion"); after 30 minutes unfixed, the scheme's Taskmaster gets it. Each failing id is kept
// in the scheme's known-red ledger until it passes on main: later lands and runs that fail only on those ids blame
// nobody, and land.sh lets them through (LAND_KNOWN_RED).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { HostJobs } from './host-job.ts';

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
  /** The ids no ledger entry had and no commit is blamed for yet: the first commit failing on one is its culprit. */
  ids: string[];
  /** When the red was seen (the 30 minutes start then), and its run's output, for the ids left on `head`. */
  at?: number;
  output?: string;
}

export interface FastState {
  /** The newest commit of main the suite has a verdict on (green, or red only on known ids, or pinned). */
  verified?: string;
  /** The commit the suite last gave no verdict on (CI never answered, land.sh crashed): not retried until main moves. */
  stuck?: string;
  /** What runs now. */
  running?: { sha: string; at: number; stale?: boolean };
  pin?: Pinning;
  reds: KnownRed[];
  /** A landing's commit on main, to the minion that landed it (newest 200). */
  landed: Record<string, number>;
}

export interface FastModeDeps {
  /** The schemes in fast mode, with their clones. */
  schemes: () => { id: number; repo: string }[];
  get: (key: string) => FastState | undefined;
  set: (key: string, value: FastState) => void;
  jobs: Pick<HostJobs, 'start' | 'state'>;
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
// shortcut: every scheme's branch is main, as land.sh's BRANCH default; read land.local.sh's BRANCH if one moves.
const BRANCH = 'main';

/** What --verify printed: green, red with its failing ids, or no verdict. */
export function verifyResult(output: string): { verdict: 'green' } | { verdict: 'red'; ids: string[] } | { verdict: 'none' } {
  if (/^verify: green$/m.test(output)) return { verdict: 'green' };
  if (/^verify: red$/m.test(output)) return { verdict: 'red', ids: [...new Set([...output.matchAll(/^verify: failing (.+)$/gm)].map((m) => m[1]))] };
  return { verdict: 'none' };
}

/** The last 40 lines of a run's output, without its verify: lines. */
const tailOf = (output: string) => output.trim().split('\n').filter((l) => !/^verify: /.test(l)).slice(-40).join('\n');

export class FastMode {
  /** The pass that runs now; a tick meanwhile asks it to go round again, and waits for it. */
  private busy: Promise<void> | null = null;
  private again = false;
  /** Each scheme's failure as last said: a failure that repeats is said once, not every 30 s. */
  private said = new Map<number, string>();
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
    return [
      ...s.reds.flatMap((e) => e.ids.map((id) => `${id}\t${who(e)}`)),
      ...(s.pin?.ids ?? []).map((id) => `${id}\tCitadel is finding whose change broke it`),
    ].join('\n');
  }

  /** What the Test health tab shows (#1063): the run's state, what is known red and when each red reaches the Taskmaster. */
  view(projectId: number) {
    const s = this.state(projectId);
    return {
      state: s.running ? 'running' : s.pin ? 'pinning' : s.stuck && s.stuck !== s.verified ? 'stuck' : s.verified ? 'verified' : 'idle',
      verified: s.verified ?? null, stuck: s.stuck ?? null, running: s.running ? { sha: s.running.sha, at: s.running.at } : null,
      pin: s.pin ? { ids: s.pin.ids, at: s.pin.at ?? null } : null,
      reds: s.reds.map((e) => ({ ids: e.ids, sha: e.sha, n: e.n ?? null, at: e.at, escalated: !!e.escalated, escalateAt: e.at + ESCALATE_MS })),
    };
  }

  /** Fast mode was turned on: start from main's head as it is now, with no ledger from an earlier spell. A run still
   * going (fast, off and fast again) is kept so its job isn't started twice, but its result is dropped: it may have been
   * a pinning run that checked only a few ids. */
  reset(projectId: number) {
    const { running } = this.state(projectId);
    this.d.set(key(projectId), { reds: [], landed: {}, ...(running ? { running: { ...running, stale: true } } : {}) });
  }

  /** A clean land on main (src/land.ts): who landed `commit`, and a run now if nothing runs. */
  landed(projectId: number, ticketId: number, commit: string): Promise<void> {
    const s = this.state(projectId);
    s.landed[commit] = ticketId;
    const keys = Object.keys(s.landed);
    for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete s.landed[k];
    this.d.set(key(projectId), s);
    return this.tick();
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
          await this.step(p.id, p.repo);
          if (this.said.delete(p.id)) console.log(`Fast mode for scheme ${p.id} works again.`);
        } catch (err: any) {
          const msg = String(err?.stderr || err?.message || err).trim();
          if (this.said.get(p.id) !== msg) console.error(`Fast mode for scheme ${p.id} failed: ${msg}`);
          this.said.set(p.id, msg);
        }
      }
    } while (this.again);
  }

  private async step(projectId: number, repo: string) {
    const s = this.state(projectId);
    const jobDir = join(this.d.dir(projectId), 'job');
    // land() writes `landed` while this awaits git: save with the newest map, not the one read here.
    const save = () => this.d.set(key(projectId), { ...s, landed: this.state(projectId).landed });
    if (s.running) {
      const job = this.d.jobs.state(jobDir, 20_000);
      if (job && job.code === null) {
        this.escalate(projectId, s);
        return save();
      }
      const { sha, stale } = s.running;
      delete s.running;
      if (!stale && job) this.d.flakes?.(projectId, sha, job.output);
      if (!stale) await this.read(projectId, repo, s, sha, job ? verifyResult(job.output) : { verdict: 'none' }, job?.output ?? '');
    }
    this.escalate(projectId, s);
    const next = s.pin ? s.pin.shas[s.pin.next] : await this.git(repo, 'rev-parse', `refs/heads/${BRANCH}`);
    if (next && (s.pin || (next !== s.verified && next !== s.stuck))) await this.start(projectId, repo, s, next);
    save();
  }

  private async start(projectId: number, repo: string, s: FastState, sha: string) {
    const wt = join(this.d.dir(projectId), 'wt');
    mkdirSync(this.d.dir(projectId), { recursive: true, mode: 0o700 });
    // Its own detached worktree, kept between runs so what the check installs (node_modules, a venv) stays.
    // A folder whose .git file points at an entry the repo no longer has (a prune that couldn't see the folder, as a
    // container turn can't) is no worktree: start it over, losing only what the check installed in it.
    if (existsSync(join(wt, '.git')) && !(await this.git(wt, 'rev-parse', '--git-dir').then(() => true, () => false))) {
      rmSync(wt, { recursive: true, force: true });
      console.log(`Fast mode for scheme ${projectId}: its worktree had lost its git link; rebuilding it.`);
    }
    if (!existsSync(join(wt, '.git'))) {
      await this.git(repo, 'worktree', 'prune');
      // Locked, so no `git worktree prune` from anywhere else drops it again.
      await this.git(repo, 'worktree', 'add', '-q', '--detach', '--lock', '--reason', 'Citadel fast mode', wt, sha);
    } else await this.git(wt, 'checkout', '-q', '-f', '--detach', sha);
    // A pinning run checks only the ids it is pinning (land.sh reruns just their files when it can).
    const env = { ...this.d.env(projectId, this.owner(s, sha)), LAND_KNOWN_RED: '', LAND_FAST: '', LAND_VERIFY_IDS: s.pin ? s.pin.ids.join('\n') : '' };
    this.d.jobs.start({ dir: join(this.d.dir(projectId), 'job'), cwd: wt, argv: ['bash', 'tools/land.sh', '--verify'], env, unit: `citadel-fast-verify-${projectId}-${Date.now()}`, description: `tools/land.sh --verify ${sha.slice(0, 9)} (fast mode)`, ticketId: 0 });
    s.running = { sha, at: this.now() };
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

  private async read(projectId: number, repo: string, s: FastState, sha: string, r: ReturnType<typeof verifyResult>, output: string) {
    if (s.pin) {
      // Each id is blamed on the first commit failing it; the rest go on to the next commit, and what's left at the
      // end is the head's own commit's.
      const pin = s.pin;
      const hit = r.verdict === 'red' ? pin.ids.filter((id) => r.ids.includes(id)) : [];
      if (hit.length) {
        pin.ids = pin.ids.filter((id) => !hit.includes(id));
        await this.open(projectId, repo, s, sha, hit, output, undefined, pin.at);
      }
      if (pin.ids.length && pin.next + 1 < pin.shas.length) {
        pin.next++;
        return;
      }
      delete s.pin;
      s.verified = pin.head;
      if (pin.ids.length) await this.open(projectId, repo, s, pin.head, pin.ids, pin.output ?? '', undefined, pin.at);
      return;
    }
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

  /** A new red: its ledger entry, and its culprit's minion told (the Taskmaster when there is none, or it wasn't pinned). */
  /** `unpinned`: why no commit could be blamed (the Taskmaster gets it at once). */
  private async open(projectId: number, repo: string, s: FastState, sha: string, ids: string[], output: string, unpinned?: string, at = this.now()) {
    const pinned = !unpinned;
    const after = (await this.git(repo, 'rev-list', '--reverse', '--first-parent', '--ancestry-path', `${sha}..refs/heads/${BRANCH}`).catch(() => '')).split('\n').filter(Boolean);
    let ticket = pinned ? this.owner(s, sha, after) : null;
    if (pinned && ticket == null) {
      const n = Number(/#(\d+)/.exec(await this.git(repo, 'log', '-1', '--format=%s', sha).catch(() => ''))?.[1]);
      ticket = n ? this.d.ticketOf(projectId, n) : null;
    }
    const n = ticket != null ? this.d.numberOf(ticket) : null;
    const entry: KnownRed = { ids, sha, ticket, ...(n ? { n } : {}), at };
    s.reds.push(entry);
    const list = ids.map((id) => `- ${id}`).join('\n');
    const tail = tailOf(output);
    const what = `The full suite went red on ${BRANCH} behind fast-mode ships, ${unpinned ?? `on ${sha.slice(0, 12)}, the first commit it fails on`}. New failing ids:\n${list}`;
    if (ticket != null) {
      this.d.tell(ticket, `${what}\n\nIt's yours to fix: your change is the culprit. Each id is in the scheme's known-red ledger, so other ships that fail only on it go through and say you're fixing it; it clears once it passes on ${BRANCH}. Fix it on your branch and hand it off with hand_off_land. If nobody has fixed it in 30 minutes, the Taskmaster gets it.${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''}`);
      return;
    }
    entry.escalated = true;
    this.d.taskmaster(projectId, `${what}\n\n${pinned ? 'No minion could be found for that commit' : 'No one minion can be blamed'}, so it's yours: start a fix, or reopen whoever broke it. Each id is a known red until it passes on ${BRANCH}; until then lands that fail only on it go through.${tail ? `\n\n\`\`\`\n${tail}\n\`\`\`` : ''}`);
  }

  private escalate(projectId: number, s: FastState) {
    for (const e of s.reds) {
      if (e.escalated || this.now() - e.at < ESCALATE_MS) continue;
      e.escalated = true;
      this.d.taskmaster(projectId, `A fast-mode red on ${BRANCH} has gone 30 minutes unfixed: ${e.ids.join(', ')}, from ${e.sha.slice(0, 12)}${e.n ? `, given to #${e.n}` : ''}. Take it on: chase that minion, or start a fix.`);
    }
  }
}
