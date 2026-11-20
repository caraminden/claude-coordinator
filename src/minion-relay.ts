// Messages between minions and Taskmasters (relay, relayMinion, relayTaskmaster), held mail and the loop guard
// that counts them. Moved out of runner.ts: it takes what it needs from the Runner as `RelayDeps`.
import { AGENT_NAME } from './auth.ts';
import type { Approvals } from './approvals.ts';
import type { Store, Ticket } from './db.ts';
import { hideTokens } from './hide-tokens.ts';
import { loopText, msgSettings, MSG_DEFAULTS, neverHold, type MsgSettings } from './msg-settings.ts';
import { pacific } from './pacific.ts';
import { asData } from './quote.ts';
import type { QueuedMessage } from './runner.ts';

/** Held mail (#405): message_taskmaster's wake: false messages, waiting for the receiving Taskmaster's next turn. */
export const mailKey = (ticketId: number) => `mail:${ticketId}`;
/** Cold hold (#413): when the first machine message held for a cold session was held, for the cap. */
export const coldKey = (ticketId: number) => `cold:${ticketId}`;

/** Taskmaster↔minion messages (both ways) one minion may exchange per LOOP_WINDOW_MS before the next waits for a person. */
/** The defaults (#1059): each scheme's own count and window are its message settings. */
export const LOOP_LIMIT = MSG_DEFAULTS.loopLimit;
export const LOOP_WINDOW_MS = MSG_DEFAULTS.loopMin * 60_000;

/** A loop guard's count and held messages (a minion's under `loop:<minion id>`, two Taskmasters' under pairKey), in the settings table so they outlive a restart. */
export interface LoopState {
  /** When each recent message went through. */
  sent: number[];
  /** Messages waiting for a person to continue, oldest first. */
  /** `asker` as it was when held (#255): the sender may since have started a turn for someone else. */
  held: { to: number; author: string; text: string; from?: number; asker?: number | null; mail?: true; at?: number }[];
}

/**
 * The chats with messages the loop guard holds (#1067), for the Needs-you list and the minion row's badge: a minion's own
 * loop under the minion, a pair's (two minions', or two Taskmasters' each in its own scheme) under both.
 * `at` is when the first was held; `text` the first one's start.
 */
export function loopHolds(store: Store): Map<number, { n: number; at: number; text: string }> {
  const out = new Map<number, { n: number; at: number; text: string }>();
  for (const key of store.settingKeys('loop:')) {
    const loop = store.getSetting<LoopState>(key);
    if (!loop?.held.length) continue;
    // A pair's loop (two Taskmasters, or two minions) is held for both: either chat's Continue lets it all through.
    const ids = key.split(':').map(Number).filter(Number.isInteger);
    const first = loop.held[0];
    for (const id of ids) {
      const was = out.get(id);
      out.set(id, { n: (was?.n ?? 0) + loop.held.length, at: Math.min(was?.at ?? Infinity, first.at ?? loop.sent.at(-1) ?? 0), text: was?.text ?? clip(first.text) });
    }
  }
  return out;
}

export const loopKey = (minionId: number) => `loop:${minionId}`;
/** Two schemes' Taskmasters share one loop, stored the same way whichever wrote first. */
export const pairKey = (a: number, b: number) => `loop:taskmasters:${Math.min(a, b)}:${Math.max(a, b)}`;
/** Two minions messaging each other directly (#783) share one loop, apart from each one's loop with its Taskmaster. */
export const MINION_PAIRS = 'loop:minions:';
export const minionPairKey = (a: number, b: number) => `${MINION_PAIRS}${Math.min(a, b)}:${Math.max(a, b)}`;
export const clip = (text: string) => (text.length > 140 ? text.slice(0, 140) + '…' : text);

/** What the relay needs from the Runner. `now` and `personOf` are read at each call: tests and the server set them after construction. */
export interface RelayDeps {
  store: Store;
  approvals: Approvals;
  emit: (ticketId: number, kind: string, data: unknown) => { id: number };
  now: () => number;
  isRunning: (ticketId: number) => boolean;
  send: (ticketId: number, author: string, text: string, images: [], extra: { from?: number; hold?: boolean; need?: string; asker?: number | null }, steer: boolean) => unknown;
  personOf: () => ((author: string, from?: number) => number | null) | undefined;
  broadcastTicket: (ticketId: number) => void;
  cold: (ticketId: number) => boolean;
  parked: (t: Ticket) => boolean;
}

/** The "Paused: …" note for the first held message, "Also held: …" for the rest. */
function heldNote(held: number, paused: string, what: string): string {
  return held === 1 ? `Paused: ${paused}, so ${what} is held until a person continues.` : `Also held: ${what}.`;
}

export class Relay {
  private d: RelayDeps;
  constructor(d: RelayDeps) {
    this.d = d;
  }

  /**
   * A message between a minion and its Taskmaster, either way (`to` is the receiving ticket). Up to
   * LOOP_LIMIT per LOOP_WINDOW_MS go through; after that each is held, with a note in both chats asking
   * a person to continue, until continueLoop. Returns whether it was held: true by the loop guard,
   * 'cold' as mail for a cold receiver (#413), which `urgent` overrides.
   */
  /** The message settings of the scheme a ticket belongs to. */
  settings(ticketId: number): MsgSettings {
    const t = this.d.store.getTicket(ticketId);
    return msgSettings(t && this.d.store.getProject(t.project_id));
  }

  relay(minionId: number, to: number, author: string, text: string, urgent = false, wake = true, need?: string, sender?: number): boolean | 'cold' | 'mail' | 'parked' {
    const minion = this.d.store.getTicket(minionId)!;
    const from = to === minionId ? sender ?? this.d.store.ownerCoordinator(minion)?.id : minionId;
    const cfg = this.settings(minionId);
    const { held, cold, parked, woke } = this.guard(loopKey(minionId), cfg.loopLimit, cfg.loopMin * 60_000, to, author, text, to === minionId, from, !wake, urgent, need);
    if (!held) return parked ? 'parked' : cold ? 'cold' : !wake && !woke ? 'mail' : false;
    const what = `${to === minionId ? `the ${AGENT_NAME}'s message to #${minion.number}` : `#${minion.number}'s message to the ${AGENT_NAME}`} ("${clip(text)}")`;
    const note = heldNote(held, `#${minion.number} and the ${AGENT_NAME} have exchanged ${cfg.loopLimit} messages in the last ${cfg.loopMin} minutes`, what);
    for (const id of this.loopChats(minion)) this.d.emit(id, 'loop_paused', { minion: minionId, text: note });
    return true;
  }

  /**
   * A message from one minion to another in its scheme (message_minion, #783): the same wake rules as
   * relay (busy: after its turn; parked: held; cold: mail unless urgent), never steering a running turn.
   * Each pair shares one count, both ways, apart from the Taskmaster's; a person's Continue in either
   * chat releases it. The caller refuses a dismissed receiver: this would reopen it.
   */
  relayMinion(from: number, to: number, author: string, text: string, urgent = false, wake = true, unparked = false): boolean | 'cold' | 'mail' | 'parked' {
    const cfg = this.settings(from);
    const { held, cold, parked } = this.guard(minionPairKey(from, to), cfg.loopLimit, cfg.loopMin * 60_000, to, author, text, false, from, !wake, urgent);
    if (!held) {
      this.copyToTaskmaster(to, author, text, unparked, from);
      return parked ? 'parked' : cold ? 'cold' : !wake ? 'mail' : false;
    }
    const [a, b] = [from, to].map((id) => `#${this.d.store.getTicket(id)!.number}`);
    const note = heldNote(held, `${a} and ${b} have exchanged ${cfg.loopLimit} messages in the last ${cfg.loopMin} minutes`, `${a}'s message to ${b} ("${clip(text)}")`);
    for (const id of [from, to]) this.d.emit(id, 'loop_paused', { minion: id, text: note });
    return true;
  }

  /**
   * The scheme's Taskmaster sees each message between its minions in its chat (#783), as a row of its own kind
   * that the chat groups (#924). It is never queued as held mail: the Taskmaster reads a minion with read_ticket.
   */
  copyToTaskmaster(to: number, author: string, text: string, unparked = false, from?: number) {
    const target = this.d.store.getTicket(to)!;
    const coordinator = this.d.store.ownerCoordinator(target);
    const line = text.replace(/\s+/g, ' ');
    const sender = from ? this.d.store.getTicket(from)?.number : Number(/^#(\d+)/.exec(author)?.[1]) || undefined;
    if (coordinator) this.d.emit(coordinator.id, 'minion_copy', { author, from: sender ?? null, to: target.number, text: line.length > 200 ? line.slice(0, 200) + '…' : line, ...(unparked ? { unparked: true } : {}) });
  }

  /**
   * A message from one scheme's Taskmaster to another's (message_taskmaster). Each pair shares one
   * count, both ways: TASKMASTER_LOOP_LIMIT per TASKMASTER_LOOP_WINDOW_MS go through, which stops a
   * runaway exchange within a few turns but not work spread out over an hour. Past that each is held,
   * with a note in both chats, until a person continues in either. `left` is how many more may go now.
   */
  relayTaskmaster(from: number, to: number, author: string, text: string, wake = true, attached = '', urgent = false, need?: string): { held: boolean; left: number; cold?: true; woke?: true } {
    // The sender's scheme sets the pair's count, window and cold time (#1059); the Taskmaster defaults are the same numbers.
    const cfg = this.settings(from);
    const { held, left, cold, woke } = this.guard(pairKey(from, to), cfg.loopLimit, cfg.loopMin * 60_000, to, author, asData(author, text) + attached, false, from, !wake, urgent, need);
    if (held) {
      const [a, b] = [from, to].map((id) => this.d.store.getProject(this.d.store.getTicket(id)!.project_id)!.name);
      const note = heldNote(held, `the ${AGENT_NAME}s of ${a} and ${b} have exchanged ${loopText(cfg)}`, `${a}'s message to ${b} ("${clip(text)}")`);
      // Each chat's note names its own Taskmaster, whose Continue releases all its held exchanges.
      for (const id of [from, to]) this.d.emit(id, 'loop_paused', { minion: id, text: note });
    }
    return { held: held > 0, left, ...(cold ? { cold: true as const } : {}), ...(woke ? { woke: true as const } : {}) };
  }

  /** Held mail from the app itself (#678: a red scheduled run for a Taskmaster): no loop guard, no turn started. */
  leaveMail(to: number, author: string, text: string) {
    // A scheme that never holds Citadel's notes (#1067) gets it as a message that wakes it, like any other: parked still holds it.
    if (this.neverHolds(to, 'note')) this.d.send(to, author, text, [], { hold: true }, false);
    else this.mail(to, author, text, undefined, false, undefined, true);
  }

  /** Whether the receiver's scheme never holds mail of this kind (#1067): a need, or `note` for Citadel's own notes. */
  neverHolds(to: number, kind: string | undefined): boolean {
    const t = kind ? this.d.store.getTicket(to) : null;
    return !!t && neverHold(this.d.store.getProject(t.project_id)).has(kind!);
  }

  /** The chats a loop-guard note shows in: the minion's and its Taskmaster's. */
  loopChats(minion: Ticket): number[] {
    const coordinator = this.d.store.ownerCoordinator(minion);
    return coordinator ? [minion.id, coordinator.id] : [minion.id];
  }

  /**
   * Held mail (#405): shown in the receiving chat now, but no turn starts and none is steered. It joins
   * the receiver's next turn, whoever wakes it, after that turn's own messages, labelled with its sender
   * and time. It carries no person, so it never decides whose turn that is.
   */
  mail(to: number, author: string, text: string, from?: number, cold = false, need?: string, note = false) {
    const { store } = this.d;
    // `note` marks Citadel's own (leaveMail), so the chat's held-mail card can offer "never hold notes" (#1067).
    const row = this.d.emit(to, 'user_message', { author, text: hideTokens(text), mail: true, ...(need ? { need } : {}), ...(cold ? { cold: true } : {}), ...(from ? { from } : {}), ...(note ? { note: true } : {}) });
    if (cold && !store.getSetting<number>(coldKey(to))) store.setSetting(coldKey(to), this.d.now());
    const sent = pacific(this.d.now());
    const list = store.getSetting<QueuedMessage[]>(mailKey(to)) ?? [];
    // Cold mail is a relay delayed (#413), so it keeps its sender's person, as the relay would have; asked-for mail carries none.
    list.push({ author: `Held mail from ${author}, sent ${sent}`, text, images: [], id: row.id, ...(cold ? { cold: true as const } : {}), ...(cold && from ? { from } : {}), asker: cold ? this.d.personOf()?.(author, from) ?? null : null });
    store.setSetting(mailKey(to), list);
    // A Taskmaster's relay that quotes a person's go hands it over when sent, as held mail too (#939).
    const ticket = store.getTicket(to);
    if (ticket && from) this.d.approvals.said(ticket.project_id, { id: ticket.id, number: ticket.number, branch: ticket.branch }, { author, text, from });
    this.d.broadcastTicket(to); // held_ids now lists it, so its bubble reads "Not sent yet" (#910)
  }

  /** Count a message against the loop at `key`: send it (steering a running turn with `steer`; as held mail with `mail`), or hold it once `limit` went in `windowMs` (or one is held already). `held` is how many wait now (0 if it went), `left` how many more may go. */
  private guard(key: string, limit: number, windowMs: number, to: number, author: string, text: string, steer: boolean, from?: number, mail = false, urgent = false, need?: string): { held: number; left: number; cold: boolean; parked?: true; woke?: true } {
    const { store } = this.d;
    // A kind the receiver's scheme never holds (#1067) wakes it, as wake: true would, cold or not; `woke` says so when it was asked to wait.
    const keep = this.neverHolds(to, need);
    const woke = keep && mail ? { woke: true as const } : {};
    if (keep) mail = false;
    const loop = store.getSetting<LoopState>(key) ?? { sent: [], held: [] };
    const now = this.d.now();
    loop.sent = loop.sent.filter((t) => now - t < windowMs);
    // A parked receiver holds it whatever (#718), urgent too: only an unpark wakes it. It wakes nothing, so it
    // isn't counted: notes left for a parked minion never pause the loop.
    const receiver = store.getTicket(to);
    if (!mail && !this.d.isRunning(to) && receiver && this.d.parked(receiver)) {
      this.d.send(to, author, text, [], { from, hold: true, ...(need ? { need } : {}) }, steer);
      return { held: 0, left: limit - loop.sent.length, cold: false, parked: true };
    }
    if (!loop.held.length && loop.sent.length < limit) {
      loop.sent.push(now);
      store.setSetting(key, loop);
      // Every message through here is machine-made, so a cold receiver gets it as mail unless it's urgent (#413).
      const cold = !mail && !urgent && !keep && this.d.cold(to);
      if (mail || cold) this.mail(to, author, text, from, cold, need);
      else this.d.send(to, author, text, [], { from, hold: true, ...(need ? { need } : {}) }, steer);
      return { held: 0, left: limit - loop.sent.length, cold, ...woke };
    }
    loop.held.push({ to, author, text, from, asker: this.d.personOf()?.(author, from) ?? null, ...(mail ? { mail: true as const } : {}), at: now });
    store.setSetting(key, loop);
    // Both rows show the hold's badge, and the Needs-you list counts it (#1067).
    for (const id of new Set([to, from ?? to])) this.d.broadcastTicket(id);
    return { held: loop.held.length, left: 0, cold: false };
  }
}
