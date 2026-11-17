// Mandate alerts wake the Taskmaster they're about (#869). Cara, 2026-11-17: "When we get these CI or other alerts sent to
// my Mandate, there should be some callback to the relevant taskmaster so it can explain to me what happened without me
// asking." Her picks the same day: alarm items only (quiet ones don't count), the alert's link opens that Taskmaster's
// chat, a new problem inside an open alert is news but rewording and clearing aren't, and 2-9 AM Pacific holds the wake
// until 9. A wake reloads a Taskmaster's whole context, so it's one per alert (not per person who got it), and a burst
// is one wake per scheme. Scheme 0 is Citadel-wide (CI health, timers with no home scheme): the server sends it to the
// scheme whose repo the live checkout is.
import type { Store } from './db.ts';

/** How long a scheme's batch waits for more alerts after its newest one. */
export const BATCH_MS = 60_000;
/** The longest a batch waits while alerts keep coming. */
export const MAX_WAIT_MS = 5 * 60_000;
const KEY = 'alert-wakes';

/** A problem inside an alert: CI health's one alert holds several. `facts`: what the Taskmaster needs that the title lacks. */
export interface AlertPart { id: string; title: string; facts?: string }
export interface Raised {
  /** Who the Mandate item is from: a scheme, or id 0 for Citadel-wide senders. */
  from: { id: number; name: string };
  key: string;
  title: string;
  link: string;
  /** Who got it. */
  person: string;
  /** Its problems; the alert itself is the one problem when left out. */
  parts?: AlertPart[];
}
interface Queued { sender: string; title: string; link: string; to: string[]; parts: AlertPart[] | null }
interface Batch { first: number; last: number; alerts: Record<string, Queued> }
interface State {
  /** Alert (`<from id>:<key>`) → the problem ids in it the Taskmaster has heard of, or will in the batch waiting. */
  told: Record<string, string[]>;
  /** Scheme id → its alerts waiting to go out. */
  batches: Record<string, Batch>;
}

export interface AlertWakeDeps {
  /** Wake the scheme's Taskmaster (0: the Citadel scheme's); false when there's none to wake. */
  wake: (scheme: number, text: string) => boolean;
}

/** When the overnight hold that `t` falls in ends (9:00 AM Pacific), or null outside 2-9 AM Pacific. */
export function quietUntil(t: number): number | null {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(t).map((x) => [x.type, x.value]));
  const h = Number(p.hour);
  if (h < 2 || h >= 9) return null;
  return t - (((h * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000 + (t % 1000)) + 9 * 3600_000;
}

const names = (to: string[]) => (to.length > 1 ? `${to.slice(0, -1).join(', ')} and ${to.at(-1)}` : to[0]);

export class AlertWakes {
  private store: Store;
  private deps: AlertWakeDeps;
  constructor(store: Store, deps: AlertWakeDeps) {
    this.store = store;
    this.deps = deps;
  }

  private load(): State {
    return this.store.getSetting<State>(KEY) ?? { told: {}, batches: {} };
  }

  /** An alarm item Mandate took for one person: queues the news in it, if any, for its scheme's next wake. */
  raise(a: Raised, now = Date.now()) {
    const s = this.load();
    const id = `${a.from.id}:${a.key}`;
    const parts = a.parts ?? [{ id: a.key, title: a.title }];
    const told = new Set(s.told[id] ?? []);
    const fresh = parts.filter((p) => !told.has(p.id));
    // What it holds now: a problem that left (or returns later, as news again) stops counting as heard.
    s.told[id] = parts.map((p) => p.id);
    const batch = s.batches[a.from.id];
    const queued = batch?.alerts[id];
    if (queued?.parts) queued.parts = queued.parts.filter((p) => parts.some((x) => x.id === p.id));
    if (fresh.length || queued) {
      const b = (s.batches[a.from.id] ??= { first: now, last: now, alerts: {} });
      const q = (b.alerts[id] ??= { sender: a.from.name, title: a.title, link: a.link, to: [], parts: a.parts ? [] : null });
      Object.assign(q, { title: a.title, link: a.link });
      if (!q.to.includes(a.person)) q.to.push(a.person);
      if (q.parts) q.parts.push(...fresh.filter((p) => !q.parts!.some((x) => x.id === p.id)));
      if (fresh.length) b.last = now;
      if (q.parts && !q.parts.length) this.drop(s, a.from.id, id);
    }
    this.store.setSetting(KEY, s);
  }

  /** The alert's item was cleared: nothing to wake anyone for, and the next time it opens is news. */
  clear(from: { id: number }, key: string) {
    const s = this.load();
    const id = `${from.id}:${key}`;
    if (!s.told[id] && !s.batches[from.id]?.alerts[id]) return;
    delete s.told[id];
    this.drop(s, from.id, id);
    this.store.setSetting(KEY, s);
  }

  private drop(s: State, scheme: number, id: string) {
    const b = s.batches[scheme];
    if (!b) return;
    delete b.alerts[id];
    if (!Object.keys(b.alerts).length) delete s.batches[scheme];
  }

  /** Sends each batch whose burst is over, unless it's 2-9 AM Pacific. */
  tick(now = Date.now()) {
    if (quietUntil(now) !== null) return;
    const s = this.load();
    const due = Object.entries(s.batches).filter(([, b]) => now - b.last >= BATCH_MS || now - b.first >= MAX_WAIT_MS);
    if (!due.length) return;
    // Saved first, so a send that throws can't wake anyone twice.
    for (const [scheme] of due) delete s.batches[scheme];
    this.store.setSetting(KEY, s);
    for (const [scheme, b] of due) {
      const held = quietUntil(b.first) !== null || quietUntil(Math.min(b.last + BATCH_MS, b.first + MAX_WAIT_MS)) !== null;
      try {
        if (!this.deps.wake(Number(scheme), wakeText(b, held))) console.log(`Alert wakes: scheme ${scheme} has no Taskmaster; ${Object.keys(b.alerts).length} alert(s) not explained`);
      } catch (err) {
        console.error(`Alert wakes: waking scheme ${scheme}'s Taskmaster failed:`, err);
      }
    }
  }
}

function wakeText(b: Batch, held: boolean): string {
  const alerts = Object.values(b.alerts);
  const lines = alerts.map((q) => {
    const news = q.parts?.length ? `\n  New in it: ${q.parts.map((p) => `${p.title}${p.facts ? ` (${p.facts})` : ''}`).join('; ')}` : '';
    return `- "${q.title}" from ${q.sender}, to ${names(q.to)}; its link: ${q.link}${news}`;
  });
  return `${alerts.length === 1 ? 'A Mandate alert' : `${alerts.length} Mandate alerts`} went out${held ? ', held overnight (2-9 AM Pacific) before reaching you' : ''}:\n${lines.join('\n')}\n\nExplain it to them here now, in a short reply nobody asked for: what happened, whether lands or minions' work are blocked, and what they have to do (or that nothing is needed). Look it up first where these facts don't settle it (\`ci-failures <run id>\`, \`gh run view <run id> --log-failed\`, the server's journal). Their alert opens this chat. You hear once per new problem in an alert, never when it clears.`;
}
