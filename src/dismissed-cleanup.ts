// What removes a dismissed minion's folders, and puts one back: its build output, its worktree once GRACE_MS old, leftover Grunt
// worktrees, and a reopen's restore. The rules are in src/worktree-sweep.ts and src/build-output.ts; this runs them.
// Moved out of runner.ts (#1840): it takes what it needs from the Runner as `CleanupDeps`.
import { dropMachineRefs } from './machine-sync.ts';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { EventRow, Project, Store, Ticket } from './db.ts';
import type { Lanes } from './lanes.ts';
import { projectDir, recoverTicketDir, restoreTicketDir } from './workspace.ts';
import { thrown } from './thrown.ts';
import { clearBuildOutput, size, ticketWorktree } from './build-output.ts';
import { clearTrash, GRACE_MS, GRUNT_AGE_MS, isGrunt, madeAt, ownCheckout, removeWorktree, saveWork, savedRef, worktrees, type Worktree } from './worktree-sweep.ts';
import { pacificDay } from './pacific.ts';

/** What the cleanup needs from the Runner. */
export interface CleanupDeps {
  store: Store;
  dataDir: string;
  /** The running turns, by minion. */
  turns: ReadonlyMap<number, { startedAt: number }>;
  lanes: Lanes;
  emit: (ticketId: number, kind: string, data: unknown) => EventRow;
}

export class DismissedCleanup {
  private d: CleanupDeps;
  constructor(d: CleanupDeps) {
    this.d = d;
  }

  /**
   * Remove a dismissed minion's build output (src/build-output.ts), if its worktree is where a minion's
   * belongs and is a git checkout: never a Taskmaster's (it works in the scheme's main checkout), nor a
   * preview's (its copied rows point at the live worktrees). Null when there is nothing to look at.
   */
  clearBuild(ticket: Ticket) {
    const dir = ticketWorktree(this.d.dataDir, ticket.project_id, ticket.id);
    if (ticket.kind === 'coordinator' || resolve(ticket.cwd) !== dir || !existsSync(join(dir, '.git'))) return Promise.resolve(null);
    return clearBuildOutput(dir);
  }

  private sweepingBuild = false;

  /**
   * Clear the build output of minions dismissed before #336, or whose clearing failed: at boot and
   * daily (server.ts). One worktree at a time, each on its lane so a reopen waits for it, and only on
   * proof the minion is dismissed and idle, as the temp sweep (#259). Returns what it freed.
   */
  async sweepBuildOutput(): Promise<{ worktrees: number; bytes: number }> {
    const freed = { worktrees: 0, bytes: 0 };
    if (this.sweepingBuild) return freed;
    this.sweepingBuild = true;
    try {
      for (const p of this.d.store.listProjects()) {
        for (const t of this.d.store.listTickets(p.id)) {
          if (t.status !== 'closed' || this.d.turns.has(t.id) || this.d.lanes.busy(t.id)) continue;
          await this.d.lanes.run(t.id, 'build output sweep', async () => {
            const now = this.d.store.getTicket(t.id);
            if (now?.status !== 'closed' || this.d.turns.has(t.id)) return;
            const r = await this.clearBuild(now);
            if (r?.dirs) {
              freed.worktrees++;
              freed.bytes += r.bytes;
            }
          });
        }
      }
    } finally {
      this.sweepingBuild = false;
    }
    if (freed.worktrees) console.log(`Cleared ${size(freed.bytes)} of build output from ${freed.worktrees} dismissed minion${freed.worktrees === 1 ? "'s worktree" : "s' worktrees"}.`);
    return freed;
  }

  /** Recreate a minion's worktree from its branch if the sweep removed it, with the work it saved (#660). */
  restoreDir(ticket: Ticket, project: Project) {
    if (ticket.kind === 'ticket' && !ticket.cwd) {
      try {
        const { cwd, branch } = recoverTicketDir(this.d.dataDir, project.id, project.repo_dir, ticket.id, ticket.number, ticket.title, ticket.build);
        this.d.store.setTicketDir(ticket.id, cwd, branch);
        // The caller's copy too: the turn about to start runs in it.
        Object.assign(ticket, { cwd, branch });
        this.d.emit(ticket.id, 'note', { text: `This minion had no worktree on record (its creation was cut off, #899), so it now uses ${cwd}${branch ? ` on branch ${branch}` : ''}.` });
      } catch (err) {
        this.d.emit(ticket.id, 'note', { text: `This minion has no worktree on record and Citadel could not make one: ${thrown(err).message}` });
      }
      return;
    }
    try {
      const note = restoreTicketDir(ticket.cwd, project.repo_dir, ticket.branch, savedRef(String(ticket.id)));
      if (note) this.d.emit(ticket.id, 'note', { text: note });
    } catch (err) {
      this.d.emit(ticket.id, 'note', { text: `Could not recreate the worktree: ${thrown(err).message}` });
    }
  }

  private sweepingWorktrees = false;

  /**
   * Remove dismissed minions' worktrees once their latest dismissal is GRACE_MS old, and Grunt worktrees no
   * running turn can be using (src/worktree-sweep.ts), in every scheme: at boot and daily, with the build
   * output sweep. Branches stay; work not on them is saved to a ref first. Each removal is a note in the
   * minion's chat, and each scheme's Taskmaster gets one note listing them. Returns what it did per scheme.
   */
  async sweepWorktrees(now = Date.now()): Promise<Map<number, { removed: string[]; kept: string[]; bytes: number }>> {
    const done = new Map<number, { removed: string[]; kept: string[]; bytes: number }>();
    if (this.sweepingWorktrees) return done;
    this.sweepingWorktrees = true;
    try {
      for (const p of this.d.store.listProjects()) {
        // Only a repo in this data folder: a dev copy's rows point at the live repos, whose turns it can't see.
        if (!p.repo_dir || resolve(p.repo_dir) !== join(projectDir(this.d.dataDir, p.id), 'repo') || !existsSync(p.repo_dir)) continue;
        const log = { removed: [] as string[], kept: [] as string[], bytes: 0 };
        const keep = (what: string, why: string) => {
          const key = `worktree-kept:${what}`;
          if (this.d.store.getSetting<string>(key) !== why) log.kept.push(`${what} (${why})`);
          this.d.store.setSetting(key, why);
        };
        const removed = (what: string, bytes: number, extra = '') => {
          this.d.store.deleteSetting(`worktree-kept:${what}`);
          log.removed.push(`${what}, ${size(bytes)}${extra}`);
          log.bytes += bytes;
        };
        // What a removal that failed or was cut short left behind.
        for (const parent of [join(projectDir(this.d.dataDir, p.id), 'tickets'), join(p.repo_dir, '.claude', 'worktrees')]) {
          const trash = await clearTrash(parent).catch((err) => ({ bytes: 0, stuck: [`${parent}: ${err.message}`] }));
          if (trash.bytes) removed(`folders earlier removals left in ${relative(projectDir(this.d.dataDir, p.id), parent)}`, trash.bytes);
          for (const stuck of trash.stuck) keep(relative(projectDir(this.d.dataDir, p.id), stuck.slice(0, stuck.indexOf(': '))), `can't delete: ${stuck.slice(stuck.indexOf(': ') + 2)}`);
        }
        const listed = await worktrees(p.repo_dir).catch(() => null);
        if (!listed) continue;
        await this.sweepGrunts(p, now, listed.filter(isGrunt), keep, removed);
        for (const t of this.d.store.listTickets(p.id)) {
          if (t.kind === 'coordinator' || t.status !== 'closed' || !t.branch || t.updated_at > now - GRACE_MS || this.d.turns.has(t.id) || this.d.lanes.busy(t.id)) continue;
          const dir = ticketWorktree(this.d.dataDir, p.id, t.id);
          if (resolve(t.cwd) !== dir || !existsSync(dir)) continue;
          await this.d.lanes.run(t.id, 'worktree sweep', async () => {
            const now2 = this.d.store.getTicket(t.id);
            // updated_at only moves on: a reopen and a new dismissal restart the clock.
            if (now2?.status !== 'closed' || this.d.turns.has(t.id) || now2.updated_at > now - GRACE_MS) return;
            const what = `#${t.number} (${relative(projectDir(this.d.dataDir, p.id), dir)})`;
            if (listed.find((w) => w.path === dir)?.locked) return keep(what, 'locked');
            try {
              // Half a folder, its .git gone: a removal by the first version of this sweep that failed or was cut short.
              if (!existsSync(join(dir, '.git'))) return removed(what, await removeWorktree(p.repo_dir!, dir), ', left half-removed earlier');
              if (!(await ownCheckout(dir))) return;
              const ref = savedRef(String(t.id));
              const s = await saveWork(dir, ref, t.branch, `Citadel: #${t.number}'s work not on its branch, saved before its worktree was removed`);
              if ('kept' in s) return keep(what, s.kept);
              const bytes = await removeWorktree(p.repo_dir!, dir);
              await dropMachineRefs(p, t.id, t.branch!).catch(() => 0); // its machine turns' marks (Build 7 T6)
              removed(what, bytes, s.saved ? `, its uncommitted work saved in ${ref}` : '');
              this.d.emit(t.id, 'note', { text: `Removed this dismissed minion's worktree (${size(bytes)}). Its branch ${t.branch} stays, and a reopen brings the folder back${s.saved ? ` with its uncommitted work, saved meanwhile in ${ref}` : ''}.` });
            } catch (err) {
              keep(
                what,
                `could not remove: ${
                  String(thrown(err).stderr || thrown(err).message)
                    .trim()
                    .split('\n')[0]
                }`,
              );
            }
          });
        }
        if (!log.removed.length && !log.kept.length) continue;
        done.set(p.id, log);
        const text = [
          log.removed.length ? `Removed ${log.removed.length} worktree${log.removed.length === 1 ? '' : 's'} of dismissed minions and leftover Grunts, ${size(log.bytes)} freed (branches kept; a reopen brings a minion's back):` : '',
          ...log.removed.map((r) => `- ${r}`),
          log.kept.length ? 'Kept:' : '',
          ...log.kept.map((k) => `- ${k}`),
        ]
          .filter(Boolean)
          .join('\n');
        console.log(`${p.name}: ${text}`);
        this.dailyCleanupNote(p.id, now, log);
      }
    } finally {
      this.sweepingWorktrees = false;
    }
    return done;
  }

  /**
   * One cleanup note per scheme per Pacific day on its Overlord chat (#1055): the day's removed and kept add up in a
   * setting (so a restart keeps them), and the day's note is rewritten in place. The headline is one line; the list
   * sits in the note's collapsed detail.
   */
  private dailyCleanupNote(projectId: number, now: number, log: { removed: string[]; kept: string[]; bytes: number }) {
    const coordinator = this.d.store.getOverlord(projectId);
    if (!coordinator) return;
    const day = pacificDay(now);
    const key = `worktree-cleanup-note:${projectId}`;
    const saved = this.d.store.getSetting<{ day: string; event: number; removed: string[]; kept: string[]; bytes: number }>(key);
    const total = saved && saved.day === day ? saved : { day, event: 0, removed: [], kept: [], bytes: 0 };
    total.removed.push(...log.removed);
    total.kept.push(...log.kept.filter((k) => !total.kept.includes(k)));
    total.bytes += log.bytes;
    const n = total.removed.length;
    const text = `${n ? `Cleaned up ${n} worktree${n === 1 ? '' : 's'} today, ${size(total.bytes)} freed` : 'No worktrees removed today'}${total.kept.length ? ` · ${total.kept.length} kept` : ''}`;
    const detail = [n ? "Removed (branches kept; a reopen brings a minion's back):" : '', ...total.removed.map((r) => `- ${r}`), total.kept.length ? 'Kept:' : '', ...total.kept.map((k) => `- ${k}`)].filter(Boolean).join('\n');
    const existing = total.event ? this.d.store.getEvent(total.event) : undefined;
    if (existing) {
      this.d.store.setEventData(existing.id, { ...JSON.parse(existing.data), text, detail });
      this.d.emit(coordinator.id, 'note_edit', { event: existing.id, text, detail, everyone: true });
    } else total.event = this.d.emit(coordinator.id, 'note', { text, detail, everyone: true }).id;
    this.d.store.setSetting(key, total);
  }

  /**
   * The scheme's Grunt worktrees that no turn can be using: made over GRUNT_AGE_MS ago, and every turn of the
   * scheme running now started after it was made (a Grunt lives inside its turn's claude process).
   */
  private async sweepGrunts(p: Project, now: number, grunts: Worktree[], keep: (what: string, why: string) => void, removed: (what: string, bytes: number, extra?: string) => void) {
    const top = projectDir(this.d.dataDir, p.id) + '/';
    for (const g of grunts) {
      if (!g.path.startsWith(top)) continue;
      const made = await madeAt(g.path);
      if (made === null || made > now - GRUNT_AGE_MS) continue;
      const inUse = [...this.d.turns].some(([id, turn]) => this.d.store.getTicket(id)?.project_id === p.id && turn.startedAt <= made);
      if (inUse) continue;
      const name = g.path.slice(g.path.lastIndexOf('/') + 1);
      const what = `Grunt ${name} (${relative(projectDir(this.d.dataDir, p.id), g.path)})`;
      if (g.locked) {
        keep(what, 'locked');
        continue;
      }
      try {
        const ref = savedRef(`grunt/${name}`);
        const s = await saveWork(g.path, ref, g.branch, `Citadel: Grunt ${name}'s work not on its branch, saved before its worktree was removed`);
        if ('kept' in s) {
          keep(what, s.kept);
          continue;
        }
        removed(what, await removeWorktree(p.repo_dir!, g.path), s.saved ? `, its uncommitted work saved in ${ref}` : '');
      } catch (err) {
        keep(
          what,
          `could not remove: ${
            String(thrown(err).stderr || thrown(err).message)
              .trim()
              .split('\n')[0]
          }`,
        );
      }
    }
  }
}
