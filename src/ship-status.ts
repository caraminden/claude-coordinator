// Branch and ship status: where each minion's change is, from branch to live, cached and broadcast on
// change. Moved out of server.ts (docs/adr/0002-background-jobs-out-of-server.md); importing it starts
// nothing, and server.ts owns the timers that call sweep() and poll().
import { branchStatus, shipLine, type BranchStatus, type Ship } from './branch.ts';
import type { Store } from './db.ts';
import type { Runner } from './runner.ts';
import { DEPLOY_FAILURE } from './routes/tickets.ts';
import { SCAN_DELAY_MS } from './artifact-scan.ts';

// gh calls go over the network, so a ticket's PR is looked up at most this often; git is checked every time.
export const PR_TTL_MS = 60_000;

export interface ShipDeps {
  store: Store;
  runner: Pick<Runner, 'interruptible' | 'broadcastTicket' | 'isRunning'>;
  broadcast: (msg: object) => void;
  /** The commit the server runs (LiveWaiters' head). */
  liveHead: () => string | null;
  /** The server's own checkout, which deploys move. */
  checkoutDir: string;
  /** branchStatus, or a fake in tests. */
  status?: typeof branchStatus;
  delayMs?: number;
}

export class ShipStatus {
  private cache = new Map<number, { status: BranchStatus | null; prAt: number; json: string }>();
  private timers = new Map<number, NodeJS.Timeout>();
  /** The ship line each minion's row last showed; a change re-sends the minion. */
  private shown = new Map<number, string>();
  private polling = false; // a slow git can't stack up rounds

  private d: ShipDeps;

  constructor(d: ShipDeps) {
    this.d = d;
  }

  /** Where a ticket's branch stands (null for tickets without one); broadcast when it changes. */
  branch = async (ticketId: number, maxPrAge = PR_TTL_MS): Promise<BranchStatus | null> => {
    const { store } = this.d;
    const ticket = store.getTicket(ticketId);
    const project = ticket && store.getProject(ticket.project_id);
    if (!ticket?.branch || !project?.repo_dir) return null;
    const cached = this.cache.get(ticketId);
    const prFresh = cached && Date.now() - cached.prAt < maxPrAge;
    const status = await (this.d.status ?? branchStatus)(project.repo_dir, ticket.branch, ticket.created_at, !prFresh, { head: this.d.liveHead(), checkoutDir: this.d.checkoutDir }, ticket.build, ticket.cwd);
    if (status && prFresh) status.pr = cached.status?.pr ?? null;
    const json = JSON.stringify(status);
    this.cache.set(ticketId, { status, prAt: prFresh ? cached.prAt : Date.now(), json });
    if (cached && cached.json !== json) this.d.broadcast({ type: 'branch', ticketId, status });
    this.changed(ticketId);
    return status;
  };

  /** The last deploy report that failed, while the server still runs what it ran then. */
  private deployFailure(): string | null {
    const f = this.d.store.getSetting<{ text: string; head: string | null }>(DEPLOY_FAILURE);
    return f && f.head === this.d.liveHead() ? f.text : null;
  }

  ship = (ticketId: number): Ship | null => {
    const status = this.cache.get(ticketId)?.status;
    return status ? shipLine(status, this.d.runner.interruptible(), this.deployFailure()) : null;
  };

  private changed(ticketId: number) {
    const now = JSON.stringify(this.ship(ticketId));
    if (this.shown.get(ticketId) === now) return;
    const first = !this.shown.has(ticketId);
    this.shown.set(ticketId, now);
    if (!first || now !== 'null') this.d.runner.broadcastTicket(ticketId);
  }

  /** After a turn's tool calls (commits, merges, `gh pr create`), look again shortly. */
  scheduleCheck(ticketId: number) {
    if (this.timers.has(ticketId)) return;
    this.timers.set(ticketId, setTimeout(() => {
      this.timers.delete(ticketId);
      this.branch(ticketId, this.d.runner.isRunning(ticketId) ? PR_TTL_MS : 0)
        .catch((err) => console.error(`Branch check of ticket ${ticketId} failed:`, err));
    }, this.d.delayMs ?? SCAN_DELAY_MS));
  }

  /** At startup every open minion's branch, so the list has its badges. */
  async sweep() {
    const { store } = this.d;
    for (const p of store.listProjects()) {
      for (const t of store.listTickets(p.id)) {
        if (t.kind === 'ticket' && t.branch && t.status !== 'closed') await this.branch(t.id).catch(() => {});
      }
    }
  }

  /** Deploys happen in other minions' turns, so merged work that isn't live yet is looked at again. */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const [id, { status }] of this.cache) {
        // A feeder folded into its build closes before it ships (specs/build-branches.md): its chip turns live once the build lands.
        const folded = !status?.merged && !!status?.build?.merged;
        if (!folded && this.d.store.getTicket(id)?.status === 'closed') continue;
        if (folded || (status?.deploy && !status.deploy.live)) await this.branch(id).catch(() => {});
        else this.changed(id);
      }
    } finally {
      this.polling = false;
    }
  }
}
