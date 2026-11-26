// Main went back (#2077, the front-end review wave retro's fix 1): a reset that takes commits off a scheme's main
// (a rolled-back restart in land.sh or deploy-queue.sh, the kit's land.sh, a person by hand) leaves every minion cut
// from those commits building on work that is no longer on main. This reads each scheme's main reflog, and for each
// move that drops commits tells every open minion whose branch still holds them, once, with the rebase that takes
// them out. Whatever resets main keeps doing it; this only reads. Importing it starts nothing: server.ts owns the timer.
import type { Store } from './db.ts';
import { gitOut } from './git.ts';
import { pacificStamp } from './pacific.ts';

/** How often each scheme's main reflog is read. */
export const ROLLBACK_EVERY_MS = 60_000;
/** The newest main reflog entries read per sweep; a server down longer than this many moves of main misses the older ones. */
const REFLOG_DEPTH = 500;
/** The dropped commits a message names; past this it says how many more. */
const LIST_MAX = 8;

/** The newest main reflog entry a sweep has read, per scheme. Moved before the minions are told, so two sweeps never tell twice. */
export const rollbackMarkKey = (projectId: number) => `main_rollback_seen:${projectId}`;
type Mark = { at: number; sha: string };
/** A reflog entry: the value the ref was set to, and when (unix seconds). */
type Entry = { sha: string; at: number };

export type Rollback = { from: string; to: string; at: number; dropped: Set<string> };

export interface RollbackDeps {
  store: Pick<Store, 'listProjects' | 'listTickets' | 'getSetting' | 'setSetting'>;
  /** Tell minion `ticketId` (server.ts: steered into a running turn, held for a sealed one, else a turn). */
  tell: (ticketId: number, text: string) => void;
}

const git = (repo: string, ...args: string[]) => gitOut(args, repo);

/** `ref`'s reflog, newest first; null when git can't read it. */
async function reflog(repo: string, ref: string, depth?: number): Promise<Entry[] | null> {
  const out = await git(repo, 'reflog', 'show', '--date=unix', '--format=%H %gd', ...(depth ? ['-n', String(depth)] : []), ref, '--');
  if (out == null) return null;
  const entries: Entry[] = [];
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40,}) \S*@\{(\d+)\}$/.exec(line);
    if (m) entries.push({ sha: m[1], at: Number(m[2]) });
  }
  return entries;
}

export class MainRollbacks {
  private d: RollbackDeps;
  private running = false; // a slow git can't stack up sweeps

  constructor(d: RollbackDeps) {
    this.d = d;
  }

  /** Every scheme with a repo; one scheme's git failing doesn't stop the others. */
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const p of this.d.store.listProjects()) {
        if (!p.repo_dir) continue;
        await this.scheme(p.id, p.repo_dir).catch((err) => console.error(`Main roll-back check of scheme ${p.id} failed:`, err));
      }
    } finally {
      this.running = false;
    }
  }

  /** The moves of `repo`'s main since the last sweep, oldest first; each one that dropped commits is told to the minions holding them. */
  async scheme(projectId: number, repo: string): Promise<Rollback[]> {
    const name = (await git(repo, 'rev-parse', '-q', '--verify', 'refs/heads/main')) ? 'main' : 'master';
    const log = await reflog(repo, `refs/heads/${name}`, REFLOG_DEPTH);
    if (!log?.length) return [];
    const { store } = this.d;
    const key = rollbackMarkKey(projectId);
    const mark = store.getSetting<Mark>(key);
    const newest = log[0];
    // The first sweep of a scheme only sets the mark: resets from before this ran are old news.
    if (!mark) {
      store.setSetting(key, { at: newest.at, sha: newest.sha });
      return [];
    }
    let seen = log.findIndex((e) => e.at < mark.at || (e.at === mark.at && e.sha === mark.sha));
    if (seen === -1) seen = log.length;
    if (seen === 0) return [];
    store.setSetting(key, { at: newest.at, sha: newest.sha });
    const found: Rollback[] = [];
    for (let i = seen - 1; i >= 0; i--) {
      const to = log[i].sha;
      const from = log[i + 1]?.sha;
      if (!from || from === to) continue;
      if ((await git(repo, 'merge-base', '--is-ancestor', from, to)) != null) continue; // a fast-forward
      // What came off main and isn't back on it since (a reship lands new commits; a re-merge of the same ones counts as back).
      const out = await git(repo, 'rev-list', from, `^${to}`, `^${newest.sha}`);
      if (!out) continue;
      const r = { from, to, at: log[i].at, dropped: new Set(out.split('\n').filter(Boolean)) };
      found.push(r);
      await this.tellHolders(projectId, repo, name, log, r);
    }
    return found;
  }

  /**
   * Each open minion whose branch shares a dropped commit with the old tip, except a minion whose own ship it was: its
   * branch held those commits before main did (land.sh rebases it, then moves main onto it), or held a ship train's
   * middle commit that was never main's tip. The shipper is told by its own land; a rebase off them would drop its work.
   */
  private async tellHolders(projectId: number, repo: string, name: string, log: Entry[], r: Rollback) {
    // When main first held each dropped commit it was set to: its tips over the window.
    const mainAt = new Map<string, number>();
    for (const e of log) if (r.dropped.has(e.sha)) mainAt.set(e.sha, e.at); // newest first: the last write is the earliest
    let list: string | null = null;
    for (const t of this.d.store.listTickets(projectId)) {
      if (t.kind !== 'ticket' || t.status === 'closed' || !t.branch) continue;
      const tip = await git(repo, 'rev-parse', '-q', '--verify', `refs/heads/${t.branch}^{commit}`);
      if (!tip) continue;
      const base = await git(repo, 'merge-base', tip, r.from);
      if (!base || !r.dropped.has(base)) continue;
      const first = (await reflog(repo, `refs/heads/${t.branch}`))?.findLast((e) => r.dropped.has(e.sha));
      if (first && (!mainAt.has(first.sha) || first.at <= mainAt.get(first.sha)!)) continue; // its own ship
      const held = (await git(repo, 'rev-list', '--count', base, `^${r.to}`, `^${log[0].sha}`)) ?? '?';
      list ??= await this.listDropped(repo, r);
      this.d.tell(t.id, rollbackText(name, t.branch, r, list, held));
    }
  }

  private async listDropped(repo: string, r: Rollback): Promise<string> {
    const lines = ((await git(repo, 'log', '--no-walk=sorted', '--format=%h %s', ...[...r.dropped].slice(0, 200))) ?? '').split('\n').filter(Boolean);
    const shown = lines.slice(0, LIST_MAX).map((l) => `- ${l}`);
    if (r.dropped.size > shown.length) shown.push(`- and ${r.dropped.size - shown.length} more`);
    return shown.join('\n');
  }
}

/** The message a minion holding dropped commits gets. */
export function rollbackText(name: string, branch: string, r: Rollback, list: string, held: string): string {
  const n = r.dropped.size;
  const old = r.from.slice(0, 12);
  return [
    `${name} went back: at ${pacificStamp(r.at * 1000)} it was reset from ${old} to ${r.to.slice(0, 12)}, which took ${n} commit${n === 1 ? '' : 's'} off it:`,
    list,
    `Your branch ${branch} was cut from them and still holds ${held} of them, so your ship would carry them back onto ${name}. Before you build further, commit any work in progress and take them out in your worktree with:`,
    `git rebase --onto ${name} ${old}`,
    `That replays only the commits your branch made after ${old} onto ${name}. Then re-run your tests. If one of those commits is your own work, keep it and rebase past the others instead.`,
  ].join('\n');
}
