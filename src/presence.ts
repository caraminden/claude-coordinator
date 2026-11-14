// Presence (#695, spec multi-user-taskmasters.md section 5): who has a minion open, or wrote in it in
// the last 10 minutes, so a row and a chat header can say "Josh is here". In memory only: it starts no
// turn, touches no prompt, and a restart forgets it (open tabs report again on their next heartbeat).

/** A tab reports its open chat at least this often while visible (public/presence.js). */
export const HEARTBEAT_MS = 30_000;
/** A viewer whose heartbeat is this late has gone (a sleeping laptop, a dropped phone). */
export const VIEW_TTL_MS = 75_000;
/** Writing in a chat counts as being there for this long. */
export const WROTE_MS = 10 * 60_000;

type Msg = { type: 'presence'; projectId: number; tickets: Record<number, string[]> };

export class Presence {
  /** Open streams: their person and the chat they last said they have open. */
  private streams = new Map<string, { name: string; ticketId: number | null; at: number }>();
  /** ticketId → name → when they last wrote. */
  private wrote = new Map<number, Map<string, number>>();
  /** Each scheme's last broadcast, so only changes go out. */
  private sent = new Map<number, string>();
  private d: { projectOf: (ticketId: number) => number | undefined; broadcast: (msg: Msg) => void; now?: () => number };

  constructor(d: Presence['d']) {
    this.d = d;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  open(stream: string, name: string) {
    this.streams.set(stream, { name, ticketId: null, at: this.now() });
  }

  /** The tab's stream closed: its view goes at once. */
  close(stream: string) {
    const s = this.streams.get(stream);
    this.streams.delete(stream);
    if (s?.ticketId != null) this.changed(s.ticketId);
  }

  /** A tab's heartbeat: which chat it has open (null: none, or hidden). False for a stream that isn't this person's. */
  view(stream: string, name: string, ticketId: number | null): boolean {
    const s = this.streams.get(stream);
    if (!s || s.name !== name) return false;
    const was = s.ticketId;
    s.ticketId = ticketId;
    s.at = this.now();
    if (was !== ticketId) {
      if (was != null) this.changed(was);
      if (ticketId != null) this.changed(ticketId);
    }
    return true;
  }

  /** A person wrote in a chat. */
  wroteIn(ticketId: number, name: string) {
    let m = this.wrote.get(ticketId);
    if (!m) this.wrote.set(ticketId, (m = new Map()));
    const fresh = !m.has(name);
    m.set(name, this.now());
    if (fresh) this.changed(ticketId);
  }

  /** Drop late heartbeats and old writes (server.ts runs it every 15 s). */
  sweep() {
    const now = this.now();
    for (const s of this.streams.values()) {
      if (s.ticketId != null && now - s.at > VIEW_TTL_MS) {
        const was = s.ticketId;
        s.ticketId = null;
        this.changed(was);
      }
    }
    for (const [ticketId, m] of this.wrote) {
      for (const [name, at] of m) if (now - at > WROTE_MS) m.delete(name);
      if (!m.size) this.wrote.delete(ticketId);
    }
    // Writes age out silently above, so every scheme that showed anyone is checked again.
    for (const projectId of this.sent.keys()) this.send(projectId);
  }

  /** Who is in each of a scheme's chats right now, by name, sorted. Chats with nobody are left out. */
  forScheme(projectId: number): Record<number, string[]> {
    const now = this.now();
    const by = new Map<number, Set<string>>();
    const add = (ticketId: number, name: string) => {
      if (this.d.projectOf(ticketId) !== projectId) return;
      if (!by.has(ticketId)) by.set(ticketId, new Set());
      by.get(ticketId)!.add(name);
    };
    for (const s of this.streams.values()) if (s.ticketId != null && now - s.at <= VIEW_TTL_MS) add(s.ticketId, s.name);
    for (const [ticketId, m] of this.wrote) for (const [name, at] of m) if (now - at <= WROTE_MS) add(ticketId, name);
    const out: Record<number, string[]> = {};
    for (const [id, names] of [...by].sort((a, b) => a[0] - b[0])) out[id] = [...names].sort();
    return out;
  }

  /** Every scheme with someone in it now, for a new stream's first look. */
  snapshot(): Msg[] {
    return [...this.sent.keys()].map((projectId) => ({ type: 'presence', projectId, tickets: this.forScheme(projectId) }));
  }

  private changed(ticketId: number) {
    const projectId = this.d.projectOf(ticketId);
    if (projectId !== undefined) this.send(projectId);
  }

  private send(projectId: number) {
    const tickets = this.forScheme(projectId);
    const json = JSON.stringify(tickets);
    if (json === (this.sent.get(projectId) ?? '{}')) return;
    if (json === '{}') this.sent.delete(projectId);
    else this.sent.set(projectId, json);
    this.d.broadcast({ type: 'presence', projectId, tickets });
  }
}
