// The ship-script lane's two ways past a slow turn (#1985; Josh, 2026-11-25, picked "Skip a holder who isn't ready" and
// "Ship together if no shared files"). The lane is the `pipeline-lane` claim, in any scheme that keeps one; other claims are left alone.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_NAME } from './appname.ts';
import type { Claim } from './claims.ts';
import type { Project, Ticket } from './db.ts';
import type { Claims } from './claims.ts';
import { gitOut } from './git.ts';

export const SHIP_LANE = 'pipeline-lane';
/** How long a holder has to hand its change off before one that is ready goes first. */
export const SKIP_AFTER_MS = 10 * 60_000;

/** What a worktree's branch changes, and which of those are pipeline files (tools/pipeline-files.txt, where a repo has one); null when git can't tell. */
async function branchChanges(cwd: string): Promise<{ all: string[]; pipeline: string[] } | null> {
  // A branch that drops the list changes the list, which is in its own list; a repo without one has no pipeline files.
  const list = await readFile(join(cwd, 'tools', 'pipeline-files.txt'), 'utf8').catch((err) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
  const changed = await gitOut(['diff', '--name-only', '--no-renames', '-z', 'main...HEAD'], cwd, { trim: false });
  if (changed === null) return null;
  const paths = ['tools/pipeline-files.txt', ...list.split('\n').map((l) => l.trim())].filter((l) => l && !l.startsWith('#'));
  const all = changed.split('\0').filter(Boolean);
  return { all, pipeline: all.filter((f) => paths.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))) };
}

/** The pipeline files a worktree's branch changes; null when git can't tell. */
export async function pipelineChanges(cwd: string): Promise<string[] | null> {
  return (await branchChanges(cwd))?.pipeline ?? null;
}

/** The files both worktrees' branches change that either one's list calls a pipeline file: a branch can change its list. None once one is on main; null when git can't tell. */
export async function sharedPipelineFiles(mine: string, holder: string): Promise<string[] | null> {
  const [a, b] = await Promise.all([branchChanges(mine), branchChanges(holder)]);
  if (!a || !b) return null;
  return [...new Set([...a.pipeline, ...b.pipeline])].filter((f) => a.all.includes(f) && b.all.includes(f));
}

export interface ShipLaneDeps {
  store: { claims: Claims; listProjects(): Pick<Project, 'id'>[]; getTicket(id: number): Ticket | undefined; openCardAt(id: number): number | null };
  /** Whether a turn of it runs or is owed. */
  busy(id: number): boolean;
  /** What a minion sealed on start_after waits for, or null. */
  heldFor(id: number): string | null;
  /** Whether its handed-off ship is in line or running. */
  shipping(id: number): boolean;
  claimPassed(projectId: number, passed: { from: Claim; to: Claim }[], why: string, author: string): void;
  /** One line in its chat that wakes it, or reaches its running turn. */
  wake(id: number, text: string): void;
  /** One line it reads on its next turn. */
  leaveMail(id: number, author: string, text: string): void;
  broadcast(event: { type: 'claims'; projectId: number }): void;
}

export class ShipLane {
  private d: ShipLaneDeps;
  private running = false;
  /** The last one let in beside each scheme's holder. shortcut: a restart forgets it, so only then can one taken out of the queue mid-ship have a second let in beside it. */
  private lastIn = new Map<number, number>();
  constructor(d: ShipLaneDeps) {
    this.d = d;
  }

  /** Every scheme's lane, once a minute. */
  async sweep(now = Date.now()) {
    if (this.running) return;
    this.running = true;
    try {
      for (const p of this.d.store.listProjects()) {
        const claim = this.d.store.claims.get(p.id, SHIP_LANE);
        if (claim) await this.check(claim, now);
      }
    } finally {
      this.running = false;
    }
  }

  private async check(claim: Claim, now: number) {
    const holder = this.d.store.getTicket(claim.holder);
    // A Taskmaster's own hold is on purpose.
    if (holder?.kind !== 'ticket' || !holder.cwd) return;
    if (this.d.shipping(holder.id)) {
      if (!claim.beside) await this.letIn(claim, holder, now);
    } else if (!claim.handed && !claim.landed && !claim.keep && now - claim.since >= SKIP_AFTER_MS) {
      const next = await this.firstReady(claim);
      if (next) this.skip(claim, holder, next, now);
    }
  }

  /** The first waiting minion that said it is ready (its hand-off was held for the lane) and is still free, with pipeline files changed. */
  private async firstReady(claim: Claim): Promise<Ticket | null> {
    for (const { ticket: id } of this.d.store.claims.queue(claim.project_id, claim.name).filter((r) => r.done_at == null && r.ready)) {
      const ticket = this.d.store.getTicket(id);
      const ready = ticket && (await this.hasPipelineWork(ticket));
      // Read again: the git calls take a moment, and a turn may have started.
      if (ticket && ready && this.free(ticket.id)) return ticket;
    }
    return null;
  }

  /** Whether nothing of its is running, owed or waiting on a person. One sealed for the lane counts; one sealed on its start_after doesn't. */
  private free(id: number) {
    const t = this.d.store.getTicket(id);
    return t?.status === 'idle' && !this.d.busy(id) && !this.d.shipping(id) && !this.d.heldFor(id) && this.d.store.openCardAt(id) === null;
  }

  /** Whether it has pipeline files committed, nothing uncommitted, and isn't at work. */
  private async hasPipelineWork(t: Ticket): Promise<boolean> {
    if (t.kind !== 'ticket' || !t.cwd || !this.free(t.id)) return false;
    const dirty = await gitOut(['status', '--porcelain', '-uno'], t.cwd);
    return dirty === '' && !!(await pipelineChanges(t.cwd))?.length;
  }

  private skip(claim: Claim, holder: Ticket, next: Ticket, now: number) {
    const passed = this.d.store.claims.skip(claim, next.id, now);
    if (!passed) return;
    const min = SKIP_AFTER_MS / 60_000;
    const line = `The ${claim.name} claim went to #${next.number} ${next.title}, which is ready: you handed nothing off in ${min} min. Don't hand off until it is yours again: you are first in its queue, and are told when it is.`;
    // One at work hears it now, or it would hand off without the lane; an idle one on its next turn.
    if (this.d.busy(holder.id)) this.d.wake(holder.id, line);
    else this.d.leaveMail(holder.id, APP_NAME, line);
    this.d.claimPassed(claim.project_id, [passed], `#${holder.number}, its holder, handed nothing off in ${min} min and waits first in its queue`, `#${holder.number} ${holder.title}`);
  }

  private async letIn(claim: Claim, holder: Ticket, now: number) {
    // One taken out of the queue mid-ship is still shipping.
    const last = this.lastIn.get(claim.project_id);
    if (last !== undefined && last !== holder.id && this.d.shipping(last)) return;
    const next = await this.firstReady(claim);
    // A holder with no pipeline files changed is on main already, or ships something this can't compare: alone.
    const shared = next && (await pipelineChanges(holder.cwd!))?.length ? await sharedPipelineFiles(next.cwd!, holder.cwd!) : null;
    if (!next || shared?.length !== 0 || !this.d.shipping(holder.id)) return;
    if (!this.d.store.claims.setBeside(claim, next.id, now)) return;
    this.lastIn.set(claim.project_id, next.id);
    this.d.wake(next.id, `You may ship now, beside #${holder.number} ${holder.title}, which holds the ${claim.name} claim: you change none of the same ship-script files. Rebase onto main, then hand off (hand_off_land). If its change goes live first, the claim is yours.`);
    this.d.broadcast({ type: 'claims', projectId: claim.project_id });
  }
}
