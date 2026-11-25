// Dismissing a minion and what comes before and after: what keeps it open, a close_self's wait for its turn's end, a live
// deploy's dismissal, the queue and rows a dismissed one leaves, its claims passing on, and a reopen's worktree.
// Moved out of runner.ts (#1840): it takes what it needs from the Runner as `ClosingDeps`.
import { clip } from './minion-relay.ts';
import { askerKey, pagePlanKey, planKey, type EventRow, type Project, type Store, type Ticket } from './db.ts';
import { APP_NAME } from './appname.ts';
import type { Claim } from './claims.ts';
import type { Approvals } from './approvals.ts';
import { cardText, type CardLink } from './card-links.ts';
import type { Lanes } from './lanes.ts';
import type { DismissedCleanup } from './dismissed-cleanup.ts';
import { thrown } from './thrown.ts';
import { clearTmpDirLater } from './turn-tmp.ts';
import { size } from './build-output.ts';
import { keepaliveKey } from './keepalive.ts';
import { startHoldKey } from './minion-budget.ts';
import type { MinionQueue } from './minion-queue.ts';
import type { Resumes } from './resumes.ts';
import type { LinePlaces } from './line-place.ts';
import type { TurnLine } from './turn-line.ts';
import type { Urgent } from './urgent.ts';
import { contextKey, windowKey, shippedKey, closeCancelledKey, turnKey, talkedKey, commandsKey } from './turn-keys.ts';
import type { Broadcast, TurnState } from './runner.ts';

/** What closing a minion needs from the Runner. */
export interface ClosingDeps {
  store: Store;
  queue: MinionQueue;
  lanes: Lanes;
  turnLine: TurnLine;
  urgent: Urgent;
  places: LinePlaces;
  resumes: Resumes;
  approvals: Pick<Approvals, 'waiting'>;
  turns: ReadonlyMap<number, unknown>;
  /** Minions to dismiss once their running turn ends, → why. */
  closing: Map<number, string | null>;
  deployedMidTurn: Set<number>;
  emit: (ticketId: number, kind: string, data: unknown) => EventRow;
  broadcast: Broadcast;
  broadcastTicket: (ticketId: number) => void;
  setStatus: (ticketId: number, status: Ticket['status']) => void;
  saveTurn: (ticketId: number, patch: Partial<TurnState>) => void;
  isRunning: (ticketId: number) => boolean;
  queued: (ticketId: number) => number;
  heldFor: (ticketId: number) => string | null;
  send: (ticketId: number, author: string, text: string, images?: [], extra?: { hold?: boolean }, steer?: boolean) => unknown;
  leaveMail: (to: number, author: string, text: string) => void;
  dropCard: (ticketId: number, reason: string) => unknown;
  forgetMaps: (ticketId: number) => void;
  tmpRoot: (projectId: number) => string;
  onClose: (ticketId: number) => Promise<void> | void;
  endStartNow: (ticketId: number) => void;
  clearBuild: DismissedCleanup['clearBuild'];
  restoreDir: (ticket: Ticket, project: Project) => void;
  cardLinks: (ticket: Ticket) => CardLink[];
  ciHold: (ticketId: number) => string | null | undefined;
  probeHold: (ticketId: number) => boolean | undefined;
}

export class Closing {
  private d: ClosingDeps;
  constructor(d: ClosingDeps) {
    this.d = d;
  }

  /**
   * A claim holder's work shipped (#1334, the land's `landed` hook): when it is dismissed, its claims pass on as shipped,
   * which the time estimate counts, not as an unshipped dismissal. A setting, so a restart before it goes live keeps it.
   */
  holderShipped(ticketId: number) {
    const t = this.d.store.getTicket(ticketId);
    if (t && this.d.store.claims.list(t.project_id).some((c) => c.holder === ticketId)) this.d.store.setSetting(shippedKey(ticketId), true);
  }

  /** A dismissed minion's claims (#921) pass to the next in each one's queue, or free themselves (#1334: claimPassed). */
  private freeClaims(ticketId: number) {
    const minion = this.d.store.getTicket(ticketId);
    const shipped = !!this.d.store.getSetting(shippedKey(ticketId));
    if (shipped) this.d.store.deleteSetting(shippedKey(ticketId));
    const passed = this.d.store.claims.releaseHeldBy(ticketId, shipped ? 'live' : 'dismissed');
    if (minion) this.claimPassed(minion.project_id, passed, `#${minion.number}, its holder, ${shipped ? 'shipped and was dismissed' : 'was dismissed'}`, `#${minion.number} ${minion.title}`);
  }

  /**
   * Claims that changed hands (#1334). The new holder hears it in one chat line, which wakes it, sealed or not. One wake
   * when a chain or wake_when_live fires for it at the same go-live (Cara, 2026-11-20, "Separate, one wake"): a chained
   * minion still holding its brief gets the line as held mail, read with its brief when its chain starts it, and one
   * already running (just started by its chain or wake) takes it mid-turn. Whoever keeps the scheme's claims hears it as
   * held mail. A scheme's page redraws either way.
   */
  claimPassed(projectId: number, passed: ({ from: Claim; to?: Claim } | { from?: undefined; to: Claim })[], why: string, author: string) {
    if (!passed.length) return;
    const keeper = this.d.store.getOverlord(projectId);
    for (const { from, to } of passed) {
      const next = to && this.d.store.getTicket(to.holder);
      if (next && next.status !== 'closed') {
        const line = `You hold the ${to!.name} claim now: ${why}. It passes to the next in its queue when you are dismissed.`;
        if (this.d.heldFor(next.id)) this.d.send(next.id, APP_NAME, line, [], { hold: true });
        else {
          if (next.state === 'parked') this.d.store.updateTicket(next.id, { state: null });
          this.d.send(next.id, APP_NAME, line, [], {}, this.d.isRunning(next.id));
        }
      }
      if (keeper && keeper.id !== to?.holder) {
        this.d.leaveMail(keeper.id, author, `(nothing to do unless something waits on it) ${(from ?? to)!.name} ${next ? `passed to #${next.number} ${next.title}, next in its queue` : 'is free'}: ${why}.`);
      }
    }
    this.d.broadcast({ type: 'claims', projectId });
  }

  /**
   * Close a ticket that is not running. Its worktree and branch are kept. Its temp folder, preview and
   * build output (#336) go on its lane, after its last turn's save; resolves once they are gone.
   */
  close(ticketId: number, text: string): Promise<void> {
    // A wait's messages stay in the queue: dropQueue below names them.
    this.d.resumes.cancelLimitWait(ticketId);
    this.d.resumes.cancelNetWait(ticketId);
    this.d.resumes.cancelKillWait(ticketId);
    this.d.dropCard(ticketId, 'The minion was dismissed while this waited.');
    this.d.store.deleteSetting(closeCancelledKey(ticketId));
    // Nor wait on its start card (#1674): a person's reopen is its start.
    this.d.store.deleteSetting(startHoldKey(ticketId));
    // A reopened minion shouldn't offer the go-ahead it had when dismissed.
    if (this.d.store.getTicket(ticketId)?.replies) this.d.store.updateTicket(ticketId, { replies: null });
    this.d.setStatus(ticketId, 'closed');
    this.d.emit(ticketId, 'note', { text });
    // At once, not on the lane: a closed minion holds nothing for a next turn, and next() must find nothing to start.
    this.dropQueue(ticketId);
    this.freeClaims(ticketId);
    this.d.forgetMaps(ticketId);
    // A split scheme's Taskmasters read it in their next turn's digest (#919's noteDigest).
    const gone = this.d.store.getTicket(ticketId);
    if (gone && gone.kind !== 'coordinator' && this.d.store.isSplit(gone.project_id)) this.d.store.noteDigest(gone.project_id, 0, `#${gone.number} ${gone.title} was dismissed`);
    return this.d.lanes.run(ticketId, 'dismissal cleanup', async () => {
      const ticket = this.d.store.getTicket(ticketId);
      // Reopened while this waited (the status route): its temp folder is in use again.
      if (ticket?.status === 'closed') {
        try {
          await clearTmpDirLater(this.d.tmpRoot(ticket.project_id), ticketId);
        } catch (err) {
          console.error(`Ticket ${ticketId}: could not clear its temp folder: ${thrown(err).message}`);
        }
      }
      await this.d.onClose(ticketId);
      // Read again: it may have been reopened while its preview stopped.
      const still = this.d.store.getTicket(ticketId);
      if (still?.status === 'closed') {
        this.closedRows(ticketId);
        await this.d.clearBuild(still).then(
          (r) => r?.dirs && console.log(`Ticket ${ticketId}: cleared ${size(r.bytes)} of build output on dismissal.`),
          (err) => console.error(`Ticket ${ticketId}: could not clear its build output: ${err.message}`),
        );
      }
    });
  }

  /**
   * A dismissed minion's queue and the per-minion rows nothing else deletes (#1378). What still waited in the queue,
   * held mail included, is named in a chat line (no-action notices aside): each already has its own message in the chat, marked unread.
   */
  closedCleanup(ticketId: number, keepHeld = false) {
    this.dropQueue(ticketId, keepHeld);
    this.closedRows(ticketId);
  }

  private dropQueue(ticketId: number, keepHeld = false) {
    this.d.turnLine.leave(ticketId);
    this.d.urgent.done(ticketId);
    this.d.endStartNow(ticketId);
    this.d.places.refused(ticketId, false);
    // A no-action notice (its own PR merged, #619) was never meant to be read before a close: it isn't named.
    const left = this.d.queue.clear(ticketId, keepHeld).filter((m) => !m.fyi);
    if (left.length) {
      const what = left.map((m) => clip(`${m.author}: ${m.text}`)).join('; ');
      this.d.emit(ticketId, 'note', { text: `Dismissed before ${left.length === 1 ? 'this message was' : `these ${left.length} messages were`} read: ${what}` });
    }
  }

  private closedRows(ticketId: number) {
    // Not its budget marks: each is once ever per minion, so a reopen isn't asked and its Taskmaster woken again (2R1).
    for (const key of [contextKey(ticketId), windowKey(ticketId), commandsKey(ticketId), planKey(ticketId), pagePlanKey(ticketId), keepaliveKey(ticketId), askerKey(ticketId)]) this.d.store.deleteSetting(key);
  }

  /** A reopened minion gets its worktree back now, not at its next turn, so its files and preview are there (#660). */
  reopened(ticketId: number): Promise<void> {
    return this.d.lanes.run(ticketId, 'worktree restore', () => {
      const ticket = this.d.store.getTicket(ticketId);
      const project = ticket && this.d.store.getProject(ticket.project_id);
      if (ticket && ticket.status !== 'closed' && project) this.d.restoreDir(ticket, project);
    });
  }

  /**
   * A deploy this minion queued is live (tools/deploy.sh reported ok). A minion waiting on it in state
   * pending-deploy is dismissed, unless something is still open: a question card, a failed last turn,
   * or a person who wrote to it since it went into pending-deploy.
   * Mid-turn or with messages queued (approval cards only exist mid-turn), it waits for the last of
   * those turns to end. Returns whether it was dismissed.
   */
  deployLive(ticketId: number): boolean {
    if (this.d.isRunning(ticketId) || this.d.queued(ticketId) || this.d.turnLine.has(ticketId)) {
      this.d.deployedMidTurn.add(ticketId);
      if (this.d.turns.has(ticketId)) this.d.saveTurn(ticketId, { deployed: true });
      return false;
    }
    const t = this.d.store.getTicket(ticketId);
    // shortcut: also takes the interim "outside" + "pending deploy" note, for minions that deployed before this state existed; drop it once none are left.
    const pending = t?.state === 'pending-deploy' || (t?.state === 'outside' && /pending deploy/i.test(t.note ?? ''));
    if (!t || t.status === 'closed' || t.status === 'error' || !pending) return false;
    if (this.d.store.getSetting(talkedKey(ticketId))) {
      this.d.store.deleteSetting(talkedKey(ticketId));
      this.d.store.updateTicket(ticketId, { state: null });
      this.d.broadcastTicket(ticketId);
      this.d.emit(ticketId, 'note', { text: 'The deploy is live, but someone wrote to this minion after it deployed, so it stays open.' });
      return false;
    }
    if (this.d.store.openCards(t.project_id).some((e) => e.ticket_id === ticketId && e.kind === 'question')) {
      this.d.emit(ticketId, 'note', { text: 'The deploy is live, but a question card is still open, so this minion stays open.' });
      return false;
    }
    const held = this.d.ciHold(ticketId);
    if (held) {
      this.d.store.updateTicket(ticketId, { state: 'outside', note: 'live; waiting on the CI re-run on main' });
      this.d.broadcastTicket(ticketId);
      this.d.emit(ticketId, 'note', { text: `The deploy is live, but ${held}, so this minion stays open.` });
      return false;
    }
    // #1741: a live probe still to run holds the dismissal; LiveProbes dismisses it on a pass, or wakes it on a fail.
    if (this.d.probeHold(ticketId)) return false;
    this.d.store.updateTicket(ticketId, { state: null });
    this.close(ticketId, 'The deploy is live, so it dismissed this minion.');
    return true;
  }

  /** A person wrote to this minion (a message, a comment or a card answer). */
  personWrote(ticketId: number) {
    if (this.d.store.getTicket(ticketId)?.state === 'pending-deploy') this.d.store.setSetting(talkedKey(ticketId), true);
  }

  /** The minion went into pending-deploy: a new deploy to wait on, so earlier talk no longer counts. */
  deployPending(ticketId: number) {
    this.d.store.deleteSetting(talkedKey(ticketId));
  }

  /**
   * Why close_self must leave this minion open for people, or null: a question, plan or approval card still
   * waiting on them, or a state (try, ready, complete) that tells them something is theirs to do. The deploy's
   * own dismissal (deployLive) has its own checks. `atCall`, for close_self's own answer: the card
   * reason carries the card's link, and ready doesn't count, since a finished minion sets it by habit
   * before close_self (closeAfterTurn clears it, #480). At the turn end it does count: a ready set
   * after close_self is the minion changing its mind.
   */
  keptOpen(ticketId: number, atCall = false): string | null {
    if (this.d.store.openCardAt(ticketId) !== null || this.d.approvals.waiting(ticketId)) {
      const card = atCall && this.d.cardLinks(this.d.store.getTicket(ticketId)!)[0];
      return card ? `${card.kind === 'approval' ? 'an' : 'a'} ${cardText(card)} is still waiting on people` : 'a question, plan or approval card is still waiting on people';
    }
    const state = this.d.store.getTicket(ticketId)?.state;
    if (state === 'try' || (state === 'ready' && !atCall)) return `its state is ${state}, which tells people something is waiting for them`;
    // Complete is finished work kept open on purpose (#547): a report to read, or a person's close.
    if (state === 'complete') return 'its state is complete: it closes once a member has seen it';
    // Its running turn's own close_self closes after it; a turn still waiting is work nobody has done.
    if (!(atCall && this.d.isRunning(ticketId)) && this.d.turnLine.has(ticketId)) return 'a turn of its own waits for a worker';
    return this.d.ciHold(ticketId) ?? null;
  }

  /**
   * #1074: the red this minion fixed is green again, so dismiss it as its live deploy would have: after a running
   * turn, and not past a card or a state that keeps it open for people.
   */
  ciGreen(ticketId: number, text: string) {
    const t = this.d.store.getTicket(ticketId);
    if (!t || t.status === 'closed') return;
    if (this.d.isRunning(ticketId) || this.d.queued(ticketId) || this.d.turnLine.has(ticketId)) {
      if (!this.closeAfterTurn(ticketId, text)) this.d.emit(ticketId, 'note', { text: `${text.replace(/,? so it dismissed this fix minion\.?$/, '.')} It stays open for the work still under way.` });
      return;
    }
    const kept = this.keptOpen(ticketId);
    if (kept) {
      if (t.state === 'outside') this.d.store.updateTicket(ticketId, { state: null, note: null });
      this.d.broadcastTicket(ticketId);
      this.d.emit(ticketId, 'note', { text: `${text.replace(/,? so it dismissed this fix minion\.?$/, '.')} It stays open: ${kept}.` });
      return;
    }
    this.d.store.updateTicket(ticketId, { state: null });
    void this.close(ticketId, text);
  }

  /**
   * Close a running ticket once its current turn finishes cleanly. A turn that fails or is
   * stopped, or a message that arrives during it, leaves the ticket open instead. A state ready
   * is cleared here (keptOpen's atCall).
   */
  closeAfterTurn(ticketId: number, reason: string | null): boolean {
    if (!this.d.isRunning(ticketId) || this.keptOpen(ticketId, true)) return false;
    if (this.d.store.getTicket(ticketId)?.state === 'ready') this.d.store.updateTicket(ticketId, { state: null });
    this.d.closing.set(ticketId, reason);
    if (this.d.turns.has(ticketId)) this.d.saveTurn(ticketId, { closing: reason });
    this.d.broadcastTicket(ticketId);
    return true;
  }

  /**
   * Close a finished minion once a member has read it (#811): its state is complete, no turn is running or queued,
   * no card waits, and `name` had it open at its latest update (seen_at is at least updated_at, the sidebar's own
   * isSeen). Called when they leave it, so nobody is closed out from under their reading. Try, ready and by-hand
   * work are never complete, so they stay open. A message to the closed minion reopens it as before.
   */
  closeIfSeen(ticketId: number, name: string): boolean {
    const t = this.d.store.getTicket(ticketId);
    if (!t || t.state !== 'complete' || t.status === 'closed' || t.status === 'running' || this.d.isRunning(ticketId)) return false;
    if (this.d.queue.size(ticketId) || this.d.turnLine.has(ticketId) || this.d.store.openCardAt(ticketId) !== null || this.d.approvals.waiting(ticketId)) return false;
    if (this.d.store.seenAt(name, ticketId) < t.updated_at) return false;
    void this.close(ticketId, `Closed: ${name} saw its result`);
    return true;
  }

  /**
   * A state set after close_self that keeps the minion open (complete, try, ready) cancels the pending close
   * there and then (#604), so the view and the state tool's reply stop promising a dismissal the turn end
   * would refuse. Returns why it was cancelled, or null when nothing was. `byOther`: a person (not the
   * minion's own state call, whose reply says so) set it, so the next turn is told (#619).
   */
  closeCancelled(ticketId: number, byOther = false): string | null {
    if (!this.d.closing.has(ticketId)) return null;
    const kept = this.keptOpen(ticketId);
    if (!kept?.startsWith('its state')) return null;
    this.d.closing.delete(ticketId);
    const { closing: _, ...turn } = this.d.store.getSetting<TurnState>(turnKey(ticketId)) ?? {};
    this.d.store.setSetting(turnKey(ticketId), turn);
    this.d.emit(ticketId, 'note', { text: `Claude's close_self was cancelled: ${kept}, so it stays open.` });
    if (byOther) this.d.store.setSetting(closeCancelledKey(ticketId), kept);
    this.d.broadcastTicket(ticketId);
    return kept;
  }
}
