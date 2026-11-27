// Pre-ship runs (#2210; Cara, 2026-11-27, on #2198's card: "3. Run any minion that is waiting for a "Ship it" through the
// full suite on github so its bugs can be found before we try to ship", and "if they give us 20, take 20"). Every TICK_MS:
//  - A minion waiting for a person's go to ship (an open ship card, or a "Ship it" reply button) has its branch, squashed
//    onto main, pushed to pre/<branch> (main beside it as pre-base/<branch>, the burn-in's base). The scheme's workflows that
//    run on a pre/** push are the run: Citadel's tests.yml runs its 20 shards on GitHub's runners.
//  - Every scheme whose repo is public on GitHub, whose GitHub runners setting isn't never, and whose main has a workflow
//    naming pre/** (none, nothing is pushed). A private repo gets none: GitHub's runners cost Actions minutes there.
//  - Newest only: a new commit, between turns, is pushed over the last and the older run cancelled. A go no longer waiting
//    stops the run (it goes again if the go comes back on the same commit); a closed minion's branches go.
//  - Each result goes to the minion's chat once: a green as held mail, a red (or a branch that won't go onto main) wakes it.
//  - A ship's run comes first: while one is going, nothing starts, running ones are cancelled, and once it has ended the
//    ones cancelled for it run again. A ship is going when the scheme's repo has a land/** run not yet completed (every
//    scheme), or, for Citadel's own ships at once, when a landing that wrote <state>/pre-yield.<its pid> just before
//    pushing its run to GitHub (tools/land/ci.sh's ci_gate) still runs: the server's watch on <state> runs a round then.
//    land.sh leaves its mark (its size budget); the next round here deletes it.
// A green doesn't count toward the ship: by the go main has nearly always moved, and land.sh rebases and runs its own commit.
import { execFile } from 'node:child_process';
import { readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { cardWhat } from './card-links.ts';
import type { Store } from './db.ts';
import type { EventRow, Project, Ticket } from './db-rows.ts';
import type { GhGet } from './gh-api.ts';
import { repoSlug } from './prlinks.ts';
import type { GithubEnv } from './scheme-repo.ts';
import { asEnv } from './scheme-repo.ts';

export const TICK_MS = 30_000;
/** How long a repo's visibility is taken as read. */
const VISIBLE_MS = 3600_000;
/** A push no workflow run shows up for in this long ran nothing. */
const LOST_MS = 10 * 60_000;
const KEY = 'pre-ship:runs';
const TRIES = 5;

export interface PreRun {
  ticket: number;
  project: number;
  branch: string;
  head: string;
  main: string;
  /** The squashed commit pushed to pre/<branch>; '' when the branch didn't go onto main. */
  commit: string;
  at: number;
  /** Its result went to the minion (or it never ran). */
  told?: boolean;
  /** Cancelled for a ship's run: runs again once the ship's mark is gone. */
  yielded?: boolean;
  /** Stopped because the go stopped waiting: runs again if it comes back on the same commit. */
  stopped?: boolean;
  /** Failed tries of a rerun, a cancel for a stop or deleting the branches: given up at TRIES. */
  tries?: number;
}

interface GhRun {
  id: number;
  name?: string;
  head_branch?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
}

export interface Git {
  (dir: string, args: string[], as?: GithubEnv): Promise<{ code: number; out: string }>;
}

export interface PreShipDeps {
  store: Pick<Store, 'getSetting' | 'setSetting' | 'openCardsOf'> & {
    listProjects(): Scheme[];
    listTickets(project: number): Minion[];
    getTicket(id: number): Minion | undefined;
  };
  as: (p: Scheme) => GithubEnv;
  get: GhGet;
  post: (path: string, as: GithubEnv) => Promise<{ status: number }>;
  git: Git;
  /** A message to the minion's chat: `fyi` is held mail, else it wakes the minion. */
  send: (ticket: number, text: string, fyi: boolean) => void;
  /** Whether a ship's run on GitHub is going (a landing's pre-yield mark). */
  yielding: () => Promise<boolean>;
  now?: () => number;
}

/** What this reads of a scheme and a minion. */
export type Scheme = Pick<Project, 'id' | 'name' | 'repo_url' | 'repo_dir' | 'gh_runners'>;
export type Minion = Pick<Ticket, 'id' | 'status' | 'branch' | 'replies'>;

const SHIP_REPLY = /^(ship|land|merge) it\b/i;

/** Whether a minion waits for a person's go to ship: an open ship card, or a "Ship it" reply button. */
export function waitsForGo(t: Pick<Ticket, 'status' | 'branch' | 'replies'>, cards: EventRow[]): boolean {
  if (t.status === 'closed' || !t.branch) return false;
  if (cards.some((c) => c.kind === 'question' && cardWhat('question', parse(c.data)) === 'ship')) return true;
  const replies = parse(t.replies);
  return Array.isArray(replies) && replies.some((r) => typeof r === 'string' && SHIP_REPLY.test(r.trim()));
}

function parse(s: string | null): unknown {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

const short = (sha: string) => sha.slice(0, 9);

export class PreShip {
  private busy = false;
  private again = false;
  private visible = new Map<string, { public: boolean; at: number }>();
  private d: PreShipDeps;
  constructor(d: PreShipDeps) {
    this.d = d;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** One round; asked during one, another follows it (a ship's mark must not wait for the next tick). */
  async tick(): Promise<void> {
    if (this.busy) return void (this.again = true);
    this.busy = true;
    try {
      do {
        this.again = false;
        await this.round();
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }

  private async round() {
    const { store } = this.d;
    const runs = store.getSetting<Record<string, PreRun>>(KEY) ?? {};
    const marked = await this.d.yielding();
    const shipping = new Map<number, Promise<boolean>>();
    const yielding = (p: Scheme) => marked || (shipping.get(p.id) ?? shipping.set(p.id, this.shipping(p)).get(p.id)!);
    const projects = new Map(store.listProjects().map((p) => [p.id, p]));
    const waiting = new Set<number>();
    for (const p of projects.values()) {
      if (!repoSlug(p.repo_url) || !p.repo_dir || p.gh_runners === 'never') continue;
      const ts = store.listTickets(p.id).filter((t) => waitsForGo(t, store.openCardsOf(t.id)));
      if (!ts.length) continue;
      const ok = await this.eligible(p);
      if (!ok) {
        // GitHub didn't answer: leave its runs be, start none.
        if (ok === null) for (const t of ts) waiting.add(t.id);
        continue;
      }
      for (const t of ts) {
        waiting.add(t.id);
        // Between turns only: in one the branch is still moving.
        if (t.status === 'running') continue;
        const head = await this.rev(p.repo_dir, `refs/heads/${t.branch}`);
        if (!head) continue;
        const r = runs[t.id];
        if (r && r.head === head) {
          // Back on the same commit: what the stop cancelled runs again (follow).
          if (r.stopped) [r.stopped, r.yielded] = [false, true];
          continue;
        }
        if (r && !r.told) await this.cancel(p, r);
        delete runs[t.id];
        if (await yielding(p)) continue;
        const fresh = await this.start(p, t, head);
        if (fresh) runs[t.id] = fresh;
      }
    }
    for (const [id, r] of Object.entries(runs)) {
      const p = projects.get(r.project);
      const t = store.getTicket(r.ticket);
      if (!p || !t || t.status === 'closed') {
        // Deleting the branch doesn't stop its run: cancel it first.
        if (!p || !r.commit || ((await this.cancel(p, r)) && (await this.unpush(p, r))) || (r.tries = (r.tries ?? 0) + 1) >= TRIES) delete runs[id];
        continue;
      }
      if (r.told || r.stopped) continue;
      if (!waiting.has(r.ticket)) {
        // A cancel GitHub refused is asked again next round, up to TRIES times.
        if ((await this.cancel(p, r)) || (r.tries = (r.tries ?? 0) + 1) >= TRIES) [r.stopped, r.tries] = [true, 0];
      } else if (await yielding(p)) {
        r.yielded = true;
        await this.cancel(p, r);
      } else await this.follow(p, r);
    }
    store.setSetting(KEY, runs);
  }

  /** A public repo with a workflow on main that runs on pre/** pushes; null when GitHub didn't say and it never has. */
  private async eligible(p: Scheme): Promise<boolean | null> {
    const slug = repoSlug(p.repo_url)!;
    const main = await this.mainOf(p.repo_dir!);
    if ((await this.d.git(p.repo_dir!, ['grep', '-q', '-F', 'pre/**', main, '--', '.github/workflows'])).code !== 0) return false;
    const v = this.visible.get(slug);
    if (v && this.now() - v.at <= VISIBLE_MS) return v.public;
    const a = await this.d.get(`repos/${slug}`, null, this.d.as(p)).catch(() => null);
    // Unread, the last answer holds (a blip mustn't cancel runs); never read, nothing starts: a private run costs minutes.
    if (a?.status !== 200) return v?.public ?? null;
    const now = { public: (a.body as { private?: unknown } | null)?.private === false, at: this.now() };
    this.visible.set(slug, now);
    return now.public;
  }

  /** Whether a ship's run (land/**) is going in the scheme's repo; unread counts as not. */
  private async shipping(p: Scheme): Promise<boolean> {
    const a = await this.d.get(`repos/${repoSlug(p.repo_url)}/actions/runs?per_page=50`, null, this.d.as(p)).catch(() => null);
    const list = (a?.body as { workflow_runs?: GhRun[] } | null)?.workflow_runs;
    return Array.isArray(list) && list.some((x) => x.status !== 'completed' && /^land\//.test(x.head_branch ?? ''));
  }

  /** Delete a run's two branches on GitHub; true once they're gone. */
  private async unpush(p: Scheme, r: PreRun): Promise<boolean> {
    const done = await this.d.git(p.repo_dir!, ['push', '--quiet', 'origin', `:refs/heads/pre/${r.branch}`, `:refs/heads/pre-base/${r.branch}`], this.d.as(p));
    return done.code === 0 || /remote ref does not exist/.test(done.out);
  }

  private async mainOf(dir: string): Promise<string> {
    const head = (await this.d.git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).out.trim();
    return head.startsWith('origin/') ? head.slice('origin/'.length) : 'main';
  }

  private async rev(dir: string, ref: string): Promise<string | null> {
    const r = await this.d.git(dir, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
    return r.code === 0 && /^[0-9a-f]{40}$/.test(r.out.trim()) ? r.out.trim() : null;
  }

  /** Squash the branch onto main and push it; null when there's nothing to run. */
  private async start(p: Scheme, t: Minion, head: string): Promise<PreRun | null> {
    const dir = p.repo_dir!;
    const name = await this.mainOf(dir);
    const main = await this.rev(dir, `refs/heads/${name}`);
    if (!main || (await this.d.git(dir, ['merge-base', '--is-ancestor', head, main])).code === 0) return null;
    const r: PreRun = { ticket: t.id, project: p.id, branch: t.branch!, head, main, commit: '', at: this.now() };
    const merged = await this.d.git(dir, ['merge-tree', '--write-tree', '--name-only', '--no-messages', main, head]);
    const [tree, ...files] = merged.out.trim().split('\n');
    if (merged.code === 1) {
      r.told = true;
      this.d.send(
        t.id,
        `Pre-ship check: your branch at ${short(head)} doesn't go onto ${name} (${short(main)}) cleanly, so the full suite didn't run. Conflicts in: ${files.slice(0, 10).join(', ')}${files.length > 10 ? `, ${files.length - 10} more` : ''}. Rebase onto ${name} before the ship go comes; the new commit gets a fresh run.`,
        false,
      );
      return r;
    }
    if (merged.code !== 0 || !/^[0-9a-f]{40}$/.test(tree ?? '')) return null;
    const made = await this.d.git(dir, ['-c', 'user.name=Citadel', '-c', 'user.email=citadel@localhost', 'commit-tree', tree!, '-p', main, '-m', `pre-ship check of ${t.branch} at ${head} on ${name} ${main}`]);
    r.commit = made.out.trim();
    if (made.code !== 0 || !/^[0-9a-f]{40}$/.test(r.commit)) return null;
    const pushed = await this.d.git(dir, ['push', '--quiet', '--atomic', 'origin', `+${r.commit}:refs/heads/pre/${t.branch}`, `+${main}:refs/heads/pre-base/${t.branch}`], this.d.as(p));
    if (pushed.code !== 0) {
      // shortcut: not tried again until a new commit; retry a few times if GitHub blips lose runs.
      console.error(`Pre-ship: pushing pre/${t.branch} to ${p.name}'s GitHub failed: ${pushed.out.slice(0, 300)}`);
      return { ...r, commit: '', told: true };
    }
    return r;
  }

  /** The runs of the pushed commit on pre/<branch>, or null when GitHub didn't answer. */
  private async listed(p: Scheme, r: PreRun): Promise<GhRun[] | null> {
    const a = await this.d.get(`repos/${repoSlug(p.repo_url)}/actions/runs?head_sha=${r.commit}&per_page=20`, null, this.d.as(p)).catch(() => null);
    const list = (a?.body as { workflow_runs?: GhRun[] } | null)?.workflow_runs;
    return a?.status === 200 && Array.isArray(list) ? list.filter((x) => x.head_branch === `pre/${r.branch}`) : null;
  }

  /** POST to each run the path `to` gives it (none: skip); true when every POST went through. */
  private async each(p: Scheme, r: PreRun, to: (run: GhRun) => string | null): Promise<boolean> {
    if (!r.commit) return true;
    const list = await this.listed(p, r);
    let ok = !!list;
    for (const run of list ?? []) {
      const path = to(run);
      if (!path) continue;
      const a = await this.d.post(`repos/${repoSlug(p.repo_url)}/${path}`, this.d.as(p)).catch(() => null);
      ok &&= !!a && a.status >= 200 && a.status < 300;
    }
    return ok;
  }

  private cancel(p: Scheme, r: PreRun) {
    return this.each(p, r, (run) => (run.status !== 'completed' ? `actions/runs/${run.id}/cancel` : null));
  }

  private async follow(p: Scheme, r: PreRun) {
    const list = await this.listed(p, r);
    if (!list) return;
    if (!list.length) {
      if (this.now() - r.at > LOST_MS) {
        r.told = true;
        console.error(`Pre-ship: no workflow ran on pre/${r.branch} in ${p.name}'s repo`);
      }
      return;
    }
    if (list.some((x) => x.status !== 'completed')) return;
    if (r.yielded && list.some((x) => x.conclusion === 'cancelled')) {
      // A rerun GitHub refused is asked again next round, up to TRIES times.
      if ((await this.each(p, r, (run) => (run.conclusion === 'cancelled' ? `actions/runs/${run.id}/rerun` : null))) || (r.tries = (r.tries ?? 0) + 1) >= TRIES) {
        [r.yielded, r.tries] = [false, 0];
        r.at = this.now();
      }
      return;
    }
    r.told = true;
    const slug = repoSlug(p.repo_url)!;
    const what = `the full suite on GitHub, your branch at ${short(r.head)} squashed onto main at ${short(r.main)}`;
    const red = list.filter((x) => !['success', 'skipped', 'neutral', 'cancelled'].includes(x.conclusion ?? ''));
    if (!red.length && list.some((x) => x.conclusion === 'cancelled')) {
      this.d.send(r.ticket, `Pre-ship check cancelled, and not run again: ${what}. ${list.map((x) => x.html_url).join(' ')}`, true);
      return;
    }
    if (!red.length) {
      this.d.send(r.ticket, `Pre-ship check passed: ${what}. ${list.map((x) => x.html_url).join(' ')}`, true);
      return;
    }
    const lines: string[] = [];
    for (const x of red) {
      const jobs = await this.d.get(`repos/${slug}/actions/runs/${x.id}/jobs?per_page=100`, null, this.d.as(p)).catch(() => null);
      const failed = ((jobs?.body as { jobs?: { name?: string; conclusion?: string | null }[] } | null)?.jobs ?? []).filter((j) => j.conclusion === 'failure').map((j) => j.name);
      lines.push(`- ${x.name ?? 'a run'} ${x.conclusion}${failed.length ? ` in ${failed.slice(0, 8).join(', ')}${failed.length > 8 ? `, ${failed.length - 8} more` : ''}` : ''}: ${x.html_url} (\`ci-failures ${x.id} -R ${slug}\` prints its failing tests)`);
    }
    this.d.send(r.ticket, `Pre-ship check failed: ${what}.\n${lines.join('\n')}\nFix what's yours before the ship go comes; a new commit gets a fresh run. If it's a flake or main's own red, say so in your reply so the person giving the go knows.`, false);
  }
}

/** git in `dir`, as `as` on GitHub; never throws. */
export const git: Git = (dir, args, as) =>
  new Promise((resolve) => execFile('git', args, { cwd: dir, env: asEnv(as), timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: err && !stdout ? String(stderr) : String(stdout) })));

/** Whether a landing that wrote a pre-yield mark in `state` still runs; the marks of ended ones go. */
export async function yieldingIn(state: string): Promise<boolean> {
  let live = false;
  for (const f of await readdir(state).catch(() => [] as string[])) {
    const pid = Number(/^pre-yield\.(\d+)$/.exec(f)?.[1]);
    if (!pid) continue;
    try {
      process.kill(pid, 0);
      live = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EPERM') live = true;
      else await unlink(join(state, f)).catch(() => {});
    }
  }
  return live;
}
