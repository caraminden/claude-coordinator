// One durable queue per minion (#1378, docs/adr/0024-runner-seams.md): every message for a minion waits in one
// settings row, `minion-queue:<id>`, from the moment it is put until its turn is durably done. It replaces the
// in-memory queue and the copies that used to carry it across restarts and waits (`waiting:`, `resume-owed:`'s
// queued, `turn:`'s queued and steered, the limit, network and kill waits' queued, `mail:` and `cold:`).
// Waits keep only their counters and timers; the messages they hold back stay here.
import type { AwayEnd } from './machine-turn.ts';
import type { QueuedMessage } from './runner.ts';

export const queueKey = (ticketId: number) => `minion-queue:${ticketId}`;
export const QUEUE_PREFIX = 'minion-queue:';

/** A resume a restart must still start (a cut-off turn's, or an account switch's, #779): its count and how it resumes. */
export type OwedResume = {
  resumes: number;
  limitTries?: number;
  onAccount?: true;
  /** A pause stopped it (#1868): its resume says so. */
  paused?: true;
  /** Its machine was away too long (Build 7 T6): it carries on at perigee, from that machine's last checkpoint. */
  away?: AwayEnd;
  killTries?: number;
  switchTries?: number;
  /** What the cut-off turn set and its resume reads (Runner's TurnState from, parkedAs, status, #1452), so a restart before the resume keeps them. */
  carry?: { from?: number; parkedAs?: { state: string | null; note: string | null }; status?: Record<string, unknown> };
};

/** A steer appended to a running turn's steer.jsonl, with where it ends there; those past steer.sent never reached claude. */
export type Steer = { end: number; msg: QueuedMessage };

export interface QueueRecord {
  /** Messages waiting for the minion's next turn, in order. */
  msgs?: QueuedMessage[];
  /** Held mail (#405, #413, #718): waits for the next turn something else starts, or a release (unseal, cold cap). */
  held?: QueuedMessage[];
  /** When the first mail held for a cold session was held (#413), for the cap. */
  coldAt?: number;
  /** The batch a turn took: it stays here until that turn is durably done, so a restart can give it back. */
  taken?: QueuedMessage[];
  /** Messages steered into the running turn; at its end the unsent ones go back to msgs. */
  steered?: Steer[];
  /** A resume a restart owes this minion. */
  owed?: OwedResume;
}

type SettingsStore = {
  getSetting<T>(key: string): T | null;
  setSetting(key: string, value: unknown): void;
  deleteSetting(key: string): void;
};

/**
 * The one queue. Every change is one write of the whole record, so a restart (or a crash) between two changes finds
 * each message in exactly one place. Every read goes to the store (no cache to go stale).
 */
export class MinionQueue {
  private store: SettingsStore;
  constructor(store: SettingsStore) {
    this.store = store;
  }

  /** The minion's record, read-only; an empty one when nothing waits. */
  get(id: number): Readonly<QueueRecord> {
    return this.store.getSetting<QueueRecord>(queueKey(id)) ?? {};
  }

  private save(id: number, next: QueueRecord) {
    const r: QueueRecord = {};
    if (next.msgs?.length) r.msgs = next.msgs;
    if (next.held?.length) r.held = next.held;
    if (next.held?.length && next.coldAt) r.coldAt = next.coldAt;
    if (next.taken?.length) r.taken = next.taken;
    if (next.steered?.length) r.steered = next.steered;
    if (next.owed) r.owed = next.owed;
    if (Object.keys(r).length) this.store.setSetting(queueKey(id), r);
    else this.store.deleteSetting(queueKey(id));
  }

  private edit(id: number, change: (r: QueueRecord) => void) {
    const r = this.get(id) as QueueRecord;
    change(r);
    this.save(id, r);
  }

  /** Messages waiting for the next turn (not held mail). */
  msgs(id: number): QueuedMessage[] {
    return [...(this.get(id).msgs ?? [])];
  }

  size(id: number): number {
    return this.get(id).msgs?.length ?? 0;
  }

  heldMail(id: number): QueuedMessage[] {
    return [...(this.get(id).held ?? [])];
  }

  /** What take would take, left where it is. */
  peek(id: number): QueuedMessage[] {
    const r = this.get(id);
    return [...(r.msgs ?? []), ...(r.held ?? [])];
  }

  /** Queue a message for the next turn; `first` puts it ahead of the rest (another plan's run, #591). */
  put(id: number, msg: QueuedMessage, first = false) {
    this.putAll(id, [msg], first);
  }

  putAll(id: number, msgs: QueuedMessage[], first = false) {
    if (!msgs.length) return;
    this.edit(id, (r) => {
      r.msgs = first ? [...msgs, ...(r.msgs ?? [])] : [...(r.msgs ?? []), ...msgs];
    });
  }

  /**
   * A turn takes everything waiting (queued, then held mail): it moves into `taken`, beside any batch a cut-off turn
   * still holds (its resume carries on with it), and the cold hold ends with it. An owed resume ends once its turn is
   * saved (Runner.launchTurn), so a crash before that still owes it.
   */
  take(id: number): QueuedMessage[] {
    const r = this.get(id);
    const batch = [...(r.msgs ?? []), ...(r.held ?? [])];
    if (!batch.length && !r.owed && !r.coldAt) return [];
    this.edit(id, (r) => {
      r.taken = [...(r.taken ?? []), ...batch];
      delete r.msgs;
      delete r.held;
      delete r.coldAt;
    });
    return batch;
  }

  /** Whether a message waits that wakes the minion, which unseals it: not held mail, nor a cut-off turn's batch to run again. */
  wakes(id: number): boolean {
    return this.msgs(id).some((m) => !m.rerun);
  }

  /**
   * A turn that never started gives its batch back, ahead of whatever came since; `held` makes it held mail, which starts
   * no turn, and `rerun` marks a batch whose turn did start, but was cut off before claude had it.
   */
  giveBack(id: number, held = false, rerun = false): QueuedMessage[] {
    const taken = this.get(id).taken ?? [];
    if (!taken.length) return [];
    this.edit(id, (r) => {
      if (held) r.held = [...taken, ...(r.held ?? [])];
      else r.msgs = [...(rerun ? taken.map((m) => ({ ...m, rerun: true as const })) : taken), ...(r.msgs ?? [])];
      delete r.taken;
    });
    return taken;
  }

  /** The turn is durably done (its session saved): its batch and steers are in its transcript now. */
  done(id: number) {
    const r = this.get(id);
    if (r.taken || r.steered)
      this.edit(id, (r) => {
        delete r.taken;
        delete r.steered;
      });
  }

  /** The cold cap's clock stops; the mail stays held. */
  warm(id: number) {
    if (this.get(id).coldAt)
      this.edit(id, (r) => {
        delete r.coldAt;
      });
  }

  /** Hold a message as mail for the next turn; `cold` starts the cold cap's clock (#413) at `now`. */
  hold(id: number, msg: QueuedMessage, coldAt?: number) {
    this.edit(id, (r) => {
      r.held = [...(r.held ?? []), msg];
      if (coldAt && !r.coldAt) r.coldAt = coldAt;
    });
  }

  /** Move held mail into the queue (an unseal, the cold cap): how many moved. */
  release(id: number): number {
    const r = this.get(id);
    const n = r.held?.length ?? 0;
    if (n || r.coldAt)
      this.edit(id, (r) => {
        r.msgs = [...(r.msgs ?? []), ...(r.held ?? [])];
        delete r.held;
        delete r.coldAt;
      });
    return n;
  }

  owed(id: number): OwedResume | undefined {
    return this.get(id).owed;
  }

  owe(id: number, owed: OwedResume | null) {
    if (!owed && !this.get(id).owed) return;
    this.edit(id, (r) => {
      if (owed) r.owed = owed;
      else delete r.owed;
    });
  }

  steers(id: number): Steer[] {
    return [...(this.get(id).steered ?? [])];
  }

  steered(id: number, steer: Steer) {
    this.edit(id, (r) => {
      r.steered = [...(r.steered ?? []), steer];
    });
  }

  /** A steer's text is in the turn's steer file, which is `end` bytes long with it. */
  steerEnd(id: number, msgId: number, end: number) {
    if (!this.get(id).steered?.some((s) => s.msg.id === msgId)) return; // its turn ended first
    this.edit(id, (r) => {
      r.steered = r.steered?.map((s) => (s.msg.id === msgId ? { ...s, end } : s));
    });
  }

  /** A turn's end: its steers' fate is decided, and the unsent ones (`unsent`) join the queue for the next turn. */
  endSteers(id: number, unsent: QueuedMessage[]) {
    const r = this.get(id);
    if (!r.steered && !unsent.length) return;
    this.edit(id, (r) => {
      delete r.steered;
      if (unsent.length) r.msgs = [...(r.msgs ?? []), ...unsent];
    });
  }

  /** A stop drops what waits for the next turn, the running turn's steers and the owed resume, on purpose; held mail stays for the next turn. */
  drop(id: number): QueuedMessage[] {
    const r = this.get(id);
    const gone = r.msgs ?? [];
    if (gone.length || r.owed || r.steered)
      this.edit(id, (r) => {
        delete r.msgs;
        delete r.owed;
        delete r.steered;
      });
    return gone;
  }

  /** A refused start drops what waits for the next turn, as send() refuses a message; held mail stays (#468 S03-6). */
  refuse(id: number) {
    if (this.get(id).msgs)
      this.edit(id, (r) => {
        delete r.msgs;
      });
  }

  /** Take the queued and held messages `gone` picks out of the queue (a disabled person's, #1509): what went. */
  dropWhere(id: number, gone: (m: QueuedMessage) => boolean): QueuedMessage[] {
    const r = this.get(id);
    const out = [...(r.msgs ?? []), ...(r.held ?? [])].filter(gone);
    if (out.length)
      this.edit(id, (r) => {
        r.msgs = r.msgs?.filter((m) => !gone(m));
        r.held = r.held?.filter((m) => !gone(m));
      });
    return out;
  }

  /** Take back one queued message (its user_message event id): whether it was waiting. */
  remove(id: number, eventId: number): boolean {
    if (!this.get(id).msgs?.some((m) => m.id === eventId)) return false;
    this.edit(id, (r) => {
      r.msgs = r.msgs!.filter((m) => m.id !== eventId);
    });
    return true;
  }

  /** A closed minion's queue goes: what was still waiting in it (queued, and held unless `keepHeld`), for the chat line that says so. */
  clear(id: number, keepHeld = false): QueuedMessage[] {
    const r = this.get(id);
    const left = [...(r.msgs ?? []), ...(keepHeld ? [] : (r.held ?? []))];
    if (Object.keys(r).length) this.save(id, keepHeld && r.held?.length ? { held: r.held } : {});
    return left;
  }
}

type MigrateStore = SettingsStore & { settingsWithPrefix<T>(prefix: string): { key: string; value: T }[] };

/**
 * Folds the old per-minion message stores into each minion's one queue, once, on the first boot after #1378: saved
 * queues and waits are moved, never dropped. The old rows were often copies of each other (a resume saved its queue
 * as `waiting:` and in `resume-owed:`), so a message is kept once. The new row is written before the old ones go, so
 * a crash between the two only runs this again. How many minions it moved.
 */
export function migrateQueues(store: MigrateStore): number {
  const found = new Map<number, { front: QueuedMessage[]; msgs: QueuedMessage[]; held: QueuedMessage[]; coldAt?: number; steered?: Steer[]; owed?: OwedResume; keys: string[] }>();
  const of = (id: number) => {
    let f = found.get(id);
    if (!f) found.set(id, (f = { front: [], msgs: [], held: [], keys: [] }));
    return f;
  };
  const idOf = (key: string) => Number(key.slice(key.indexOf(':') + 1));
  const ok = (id: number) => Number.isInteger(id) && id > 0;
  for (const { key, value } of store.settingsWithPrefix<QueuedMessage[]>('waiting:')) {
    if (!ok(idOf(key))) continue;
    const f = of(idOf(key));
    f.msgs.push(...(Array.isArray(value) ? value : []));
    f.keys.push(key);
  }
  for (const { key, value } of store.settingsWithPrefix<OwedResume & { queued?: QueuedMessage[] }>('resume-owed:')) {
    if (!ok(idOf(key))) continue;
    const f = of(idOf(key));
    const { queued, ...owed } = value;
    f.msgs.push(...(queued ?? []));
    f.owed = owed;
    f.keys.push(key);
  }
  for (const { key, value } of store.settingsWithPrefix<QueuedMessage[]>('mail:')) {
    if (!ok(idOf(key))) continue;
    const f = of(idOf(key));
    f.held.push(...(Array.isArray(value) ? value : []));
    f.keys.push(key);
  }
  for (const { key, value } of store.settingsWithPrefix<number>('cold:')) {
    if (!ok(idOf(key))) continue;
    const f = of(idOf(key));
    if (typeof value === 'number') f.coldAt = value;
    f.keys.push(key);
  }
  // A running turn's record keeps everything else; only its queued and steered move.
  const turns: { key: string; value: Record<string, unknown> }[] = [];
  for (const t of store.settingsWithPrefix<Record<string, unknown> & { queued?: QueuedMessage[]; steered?: Steer[] }>('turn:')) {
    const { key, value } = t;
    if (!ok(idOf(key)) || !value || (!('queued' in value) && !('steered' in value))) continue;
    const f = of(idOf(key));
    f.msgs.push(...(value.queued ?? []));
    if (value.steered?.length) f.steered = value.steered;
    turns.push(t);
  }
  // The waits: a network or kill wait's messages had left the queue (they go first); a limit wait's were a copy of it.
  const waits: [string, boolean][] = [
    ['net-resumes', true],
    ['kill-resumes', true],
    ['limit-resumes', false],
  ];
  const lists = new Map<string, { ticket: number; queued?: QueuedMessage[] }[]>();
  for (const [name, front] of waits) {
    const list = store.getSetting<{ ticket: number; queued?: QueuedMessage[] }[]>(name);
    if (!list?.some((w) => w.queued)) continue;
    lists.set(name, list);
    for (const w of list) if (w.queued?.length) (front ? of(w.ticket).front : of(w.ticket).msgs).push(...w.queued);
  }
  if (!found.size && !lists.size) return 0;
  const once = (list: QueuedMessage[], seen = new Set<string>()) =>
    list.filter((m) => {
      const k = JSON.stringify(m);
      return !seen.has(k) && !!seen.add(k);
    });
  for (const [id, f] of found) {
    const now = store.getSetting<QueueRecord>(queueKey(id)) ?? {};
    const r: QueueRecord = { ...now };
    const seen = new Set<string>();
    const msgs = once([...(now.msgs ?? []), ...f.front, ...f.msgs], seen);
    const held = once([...(now.held ?? []), ...f.held], seen);
    if (msgs.length) r.msgs = msgs;
    if (held.length) r.held = held;
    if (f.coldAt && held.length && !r.coldAt) r.coldAt = f.coldAt;
    if (f.steered && !r.steered) r.steered = f.steered;
    if (f.owed && !r.owed) r.owed = f.owed;
    if (Object.keys(r).length) store.setSetting(queueKey(id), r);
  }
  for (const f of found.values()) for (const key of f.keys) store.deleteSetting(key);
  for (const { key, value } of turns) {
    const { queued: _q, steered: _s, ...rest } = value;
    store.setSetting(key, rest);
  }
  for (const [name, list] of lists)
    store.setSetting(
      name,
      list.map(({ queued: _q, ...w }) => w),
    );
  return found.size;
}
