// Mail that waits for a minion instead of starting a turn, and what lets it go: sealing and unsealing, sleep, a start card,
// the cold hold's cap, the loop guard's "continue", and striking a wrong message. The relay that decides to hold one is
// src/minion-relay.ts; the queue it waits in is src/minion-queue.ts.
// Moved out of runner.ts (#1840): it takes what it needs from the Runner as `HeldMailDeps`.
import { AGENT_NAME } from './auth.ts';
import { msgSettings } from './msg-settings.ts';
import { type Relay, clip, loopKey, MINION_PAIRS, minionPairKey, pairKey, type LoopState } from './minion-relay.ts';
import type { EventRow, Project, Store, TicketFields } from './db.ts';
import type { Lanes } from './lanes.ts';
import type { ClaudeEvent, ContentBlock } from './claude-events.ts';
import { startHoldKey, START_HOLD_PREFIX, startNote } from './minion-budget.ts';
import type { MinionQueue } from './minion-queue.ts';
import { sleepKey, type Sleep } from './needs.ts';
import type { QueuedMessage } from './turn-messages.ts';

/** How many of a thread's newest replies and messages strike_text searches for the quote (#622). */
const STRIKE_SEARCH = 500;

/** A stored event's data as `strike` reads it: a Claude event, or a note or message with its `text`. */
type StruckData = Partial<ClaudeEvent> & { text?: string; strikes?: { text: string; reason: string; at: number }[] };

/** What held mail needs from the Runner. */
export interface HeldMailDeps {
  store: Store;
  queue: MinionQueue;
  relays: Relay;
  lanes: Lanes;
  now: () => number;
  noTurns: () => boolean;
  /** Why a minion is held back from starting (held-starts.ts), or null. */
  heldFor: (ticketId: number) => string | null;
  emit: (ticketId: number, kind: string, data: unknown) => EventRow;
  broadcastTicket: (ticketId: number) => void;
  isRunning: (ticketId: number) => boolean;
  dropDisabled: (ticketId: number) => number;
  refused: (ticketId: number, person: number | null) => boolean;
  turnPerson: (ticket: TicketFields, project: Project, waiting: { msgs: QueuedMessage[]; held: QueuedMessage[] }) => number | null;
  next: (ticketId: number, now?: boolean) => void;
  send: (ticketId: number, author: string, text: string, images?: [], extra?: { from?: number; hold?: boolean; quick?: boolean; asker?: number | null }, steer?: boolean) => unknown;
}

export class HeldMail {
  private d: HeldMailDeps;
  constructor(d: HeldMailDeps) {
    this.d = d;
  }

  /**
   * Held (#718): on hold on purpose (state sealed), waiting on start_after, or on its start card (#1757, which isn't sealed
   * but runs nothing until a person answers), and not dismissed. A message to it is held.
   */
  parked(t: TicketFields): boolean {
    return t.kind !== 'coordinator' && t.status !== 'closed' && (t.state === 'parked' || !!this.d.heldFor(t.id) || !!this.startHold(t.id));
  }

  /** Its start card's estimate while it waits on one (#1674), for the list: { usd }, or null. */
  startHold(ticketId: number): { usd: number } | null {
    const hold = this.d.store.getSetting<{ usd: number }>(startHoldKey(ticketId));
    return hold ? { usd: hold.usd } : null;
  }

  /**
   * A person OK'd a held start (#1757): its first turn starts with their go, then its held brief and anything left for it.
   * The caller has deleted the hold.
   */
  startHeld(ticketId: number, author: string, how: string) {
    this.d.dropDisabled(ticketId);
    this.d.send(ticketId, author, `${how} Your brief, and anything left for you while you waited, follow.`);
    this.d.broadcastTicket(ticketId);
  }

  /**
   * Minions created sealed on their start card before #1757 move out of the seal, once at boot (it finds none after):
   * state cleared, their note the new one. One chained on start_after stays sealed on its chain. Returns how many moved.
   */
  unsealStartHolds(): number {
    let moved = 0;
    for (const { key, value } of this.d.store.settingsWithPrefix<{ usd: number }>(START_HOLD_PREFIX)) {
      const t = this.d.store.getTicket(Number(key.slice(START_HOLD_PREFIX.length)));
      // Only #1674's own seal (its note): a seal a person set later, for another reason, stays.
      if (!t || t.status === 'closed' || t.state !== 'parked' || this.d.heldFor(t.id) || !/^waits for its start card/.test(t.note ?? '')) continue;
      this.d.store.updateTicket(t.id, { state: null, note: startNote(value.usd) });
      moved++;
    }
    if (moved) console.log(`start cards: ${moved} minion${moved === 1 ? '' : 's'} waiting on a start card moved out of sealed (#1757)`);
    return moved;
  }

  /** Messages held for this minion's next turn (#718's sealed ones and held mail). */
  heldCount(ticketId: number): number {
    return this.d.queue.get(ticketId).held?.length ?? 0;
  }

  /**
   * Put a minion to sleep or wake it (#1636), as `by` (a person's name): nothing else changes, and it needs no turn. False
   * for a Taskmaster, a dismissed minion, or one already that way.
   */
  sleep(ticketId: number, by: string, asleep: boolean): boolean {
    const t = this.d.store.getTicket(ticketId);
    if (!t || t.kind === 'coordinator' || t.status === 'closed' || !!this.d.store.getSetting(sleepKey(ticketId)) === asleep) return false;
    if (asleep) this.d.store.setSetting(sleepKey(ticketId), { at: this.d.now(), by } satisfies Sleep);
    else this.d.store.deleteSetting(sleepKey(ticketId));
    this.d.emit(ticketId, 'note', { text: asleep ? `${by} put this minion to sleep.` : `${by} woke this minion.` });
    this.d.broadcastTicket(ticketId);
    return true;
  }

  /**
   * Unseal a minion in state sealed (#718): the state clears now, and unless `quiet` (a message wakes it instead) a
   * turn starts that reads what was held for it, with a message from `author` (a person's name runs it as them, as a
   * card's answer does). A chained minion starts with its brief instead (routes/tickets.ts unparkTicket). False when
   * it isn't in state sealed.
   */
  unpark(ticketId: number, by: string, author: string, quiet = false): boolean {
    const t = this.d.store.getTicket(ticketId);
    if (!t || t.kind === 'coordinator' || t.status === 'closed' || t.state !== 'parked') return false;
    this.d.emit(ticketId, 'note', { text: `${by} unsealed this minion.` });
    if (!quiet && !this.d.isRunning(ticketId)) {
      this.d.dropDisabled(ticketId); // so the count below says only what follows (#1509)
      const n = this.heldCount(ticketId);
      const held = n ? `${n === 1 ? 'The message' : `The ${n} messages`} left for you while you were sealed ${n === 1 ? 'follows' : 'follow'}.` : 'Nothing was left for you while you were sealed.';
      // Queued before the state clears (#1378): a crash between the two leaves a turn to start, not held mail nothing releases.
      this.d.send(ticketId, author, `${author === by ? 'Unsealed' : `${by} unsealed`} you. ${held} Pick up where you left off.`, [], { quick: false });
    }
    this.d.store.updateTicket(ticketId, { state: null });
    this.d.broadcastTicket(ticketId);
    return true;
  }

  /**
   * Mail held for a cold session wakes it once the first has waited COLD_HOLD_MAX_MS, or at once if the
   * session went fresh meanwhile (nothing left to re-read), but never a dismissed minion. A person's
   * message takes it sooner. Run every minute.
   */
  coldSweep(now = this.d.now()) {
    if (this.d.noTurns()) return;
    for (const p of this.d.store.listProjects()) {
      for (const t of this.d.store.listTickets(p.id)) {
        const since = this.d.queue.get(t.id).coldAt;
        if (!since || (t.session_id && now - since < msgSettings(p).holdH * 3_600_000)) continue;
        // A sealed minion's mail waits for its unseal or wake, however long (#718).
        if (this.parked(t)) continue;
        if (this.d.isRunning(t.id) || this.d.lanes.busy(t.id)) continue;
        this.releaseMail(t, p);
      }
    }
  }

  /**
   * Queue a ticket's held mail as a turn: the cold hold's cap ran out, or `by` (a person) asked from the Held list (#1059).
   * Never a dismissed minion's, nor while its Claude can't run a turn (#468 S03-6). Returns how many messages went.
   */
  releaseMail(t: TicketFields, p: Project, by = ''): number {
    let mail = this.d.queue.heldMail(t.id);
    // A dismissed minion isn't reopened by the cap: its mail waits for a person's message, or its dismissal's cleanup notes it.
    if (!mail.length || t.status === 'closed') {
      this.d.queue.warm(t.id);
      return 0;
    }
    if (this.startHold(t.id)) return 0; // only its start card's answer starts it (#1757)
    // A disabled person's held mail never runs, on their login or anyone else's (#1270 C3, #1509).
    if (this.d.dropDisabled(t.id)) mail = this.d.queue.heldMail(t.id);
    if (!mail.length) return 0;
    if (this.d.refused(t.id, this.d.turnPerson(t, p, { msgs: [], held: mail }))) return 0; // keeps the cold time, so the cap still fires
    const hours = msgSettings(p).holdH;
    const text = by ? `${by} delivered the held mail, so it runs now.` : t.session_id ? `Held mail has waited ${hours} hours, so it runs now.` : 'Held mail runs now: the session is fresh, so waking it is cheap.';
    this.d.emit(t.id, 'note', { text });
    this.d.queue.release(t.id);
    this.d.next(t.id, true);
    return mail.length;
  }

  /**
   * strike_text: thread `by` was proven wrong, so `quote` (its own words, verbatim) is struck through
   * where it shows: in the newest of its replies, or of its messages to another thread, that contains
   * it. A note with the reason goes in that chat, and in `by`'s own if that's another one.
   */
  strike(by: number, quote: string, reason: string): { ticketId: number } {
    const texts = (e: EventRow, data: StruckData): string[] => (e.kind === 'claude' ? (data.type === 'assistant' ? ((data.message?.content ?? []) as ContentBlock[]).filter((b) => b.type === 'text').map((b) => b.text!) : []) : [data.text ?? '']);
    let e: EventRow | undefined;
    let data!: StruckData;
    // Find it first: leaving the loop closes the read before anything is written.
    for (const w of this.d.store.wordsBy(by, STRIKE_SEARCH)) {
      data = JSON.parse(w.data);
      if (texts(w, data).some((t) => t.includes(quote))) {
        e = w;
        break;
      }
    }
    if (!e) throw new Error(`None of your newest ${STRIKE_SEARCH} replies or messages contains that text. Quote it exactly as you wrote it, Markdown and all, from a single message.`);
    const strikes: { text: string; reason: string; at: number }[] = data.strikes ?? [];
    if (strikes.some((s) => s.text === quote)) throw new Error('That text is struck through already');
    strikes.push({ text: quote, reason, at: this.d.now() });
    this.d.store.setEventData(e.id, { ...data, strikes });
    this.d.emit(e.ticket_id, 'strike', { event: e.id, strikes });
    // `strike` lets the chat draw the quote struck through; `chat` (another chat's note only) is where the message shows.
    const where = this.d.store.getTicket(e.ticket_id)!;
    const words = clip(quote.replace(/[*`~]/g, ''));
    for (const id of new Set([e.ticket_id, by])) {
      const chat = id === e.ticket_id ? null : { project: where.project_id, number: where.number };
      const place = chat ? ` in ${where.number == null ? `the ${AGENT_NAME}'s chat` : `#${where.number}`}` : '';
      this.d.emit(id, 'note', { text: `Struck through as wrong${place}: "${words}". ${reason}`, strike: { quote: words, reason, chat } });
    }
    return { ticketId: e.ticket_id };
  }

  /**
   * continueLoop for each of `ticketIds` that has loop state (a person writing to a Taskmaster continues every minion of
   * its scheme): one read of the loop keys, not one continueLoop per minion, which held the server 0.7 s a message (#1029).
   */
  continueLoops(ticketIds: number[], by: string): number {
    // loop:<minion>, loop:taskmasters:<a>:<b> and loop:minions:<a>:<b> each name the chats whose loops they hold.
    const named = new Set(this.d.store.settingKeys('loop:').flatMap((key) => key.split(':').slice(1).map(Number)));
    let total = 0;
    for (const id of ticketIds) if (named.has(id)) total += this.continueLoop(id, by);
    return total;
  }

  /**
   * A person continued a minion paused by the loop guard, or wrote into its chat or its Taskmaster's:
   * the held messages go through in order and its count starts again. For a Taskmaster, the same for
   * each of its exchanges with other schemes' Taskmasters. Returns how many were held.
   */
  continueLoop(ticketId: number, by: string): number {
    const ticket = this.d.store.getTicket(ticketId);
    if (!ticket) return 0;
    const loops: { key: string; chats: () => number[]; pair?: true }[] =
      ticket.kind === 'coordinator'
        ? this.d.store
            .listProjects()
            .flatMap((p) => this.d.store.listCoordinators(p.id))
            .filter((c) => c && c.id !== ticketId)
            .map((c) => ({ key: pairKey(ticketId, c!.id), chats: () => [ticketId, c!.id] }))
        : // Its Taskmaster only once there's a loop to lift: looking it up for every minion cost 0.2 ms each (#1029).
          [
            { key: loopKey(ticketId), chats: () => this.d.relays.loopChats(ticket) },
            // Its direct exchanges with the scheme's other minions (#783).
            ...this.d.store
              .settingKeys(MINION_PAIRS)
              .map((key) => key.slice(MINION_PAIRS.length).split(':').map(Number))
              .filter((ids) => ids.includes(ticketId))
              .map(([a, b]) => ({ key: minionPairKey(a, b), chats: () => [ticketId, a === ticketId ? b : a], pair: true as const })),
          ];
    let total = 0;
    for (const { key, chats, pair } of loops) {
      const loop = this.d.store.getSetting<LoopState>(key);
      if (!loop) continue;
      this.d.store.deleteSetting(key);
      const n = loop.held.length;
      if (!n) continue;
      const text = `${by} continued, so ${n === 1 ? 'the held message' : `the ${n} held messages`} went through.`;
      // A minion's note is keyed by the minion in both chats; a Taskmasters' or two minions' note by each chat's own.
      for (const id of chats()) this.d.emit(id, 'loop_continued', { minion: ticket.kind === 'coordinator' || pair ? id : ticketId, by, text });
      // The rows' loop badges go (#1067): a chat that gets a held message is broadcast by its send; the rest that showed one, here.
      for (const id of pair || ticket.kind === 'coordinator' ? chats() : [ticketId]) if (!loop.held.some((m) => m.to === id)) this.d.broadcastTicket(id);
      // Only the Taskmaster's messages to its minion steer; Taskmasters' and minions' to each other queue.
      for (const m of loop.held) {
        if (pair) this.d.relays.copyToTaskmaster(m.to, m.author, m.text);
        // A minion dismissed since never reopens for another minion's message (#783): it waits as mail.
        if (m.mail || this.d.store.getTicket(m.to)?.status === 'closed') this.d.relays.mail(m.to, m.author, m.text, m.from);
        else if (pair) this.d.send(m.to, m.author, m.text, [], { from: m.from, hold: true, ...(m.asker !== undefined ? { asker: m.asker } : {}) }, false);
        else this.d.send(m.to, m.author, m.text, [], { from: m.from, hold: true, ...(m.asker !== undefined ? { asker: m.asker } : {}) }, ticket.kind !== 'coordinator' && m.to === ticketId);
      }
      total += n;
    }
    return total;
  }
}
