// Urgent tags the server sets by itself (#1888): the minion fixing a red main, the one that starts after it, and the one
// whose deploy failed. At most two at a time (src/urgent.ts), each with its reason, and a person's choice wins. A CI alert, a
// "bug" label or a red nobody is fixing tags nothing.
import type { RedMark } from './ci-problems.ts';
import type { Project, Store, Ticket } from './db.ts';
import { SERVER_FULL, type Urgent, type UrgentBy } from './urgent.ts';
import type { Chain } from './wake.ts';

/** A red main with a minion on it: `key` names the red for as long as it lasts, `run` its newest failure. */
export interface RedFix {
  key: string;
  ticket: number;
  run: string;
  /** What is red, for the reason: "tests.yml is red on main". */
  what: string;
}

/** Each scheme's red workflows with the open minion CI health names as the fix, and a fast-mode red's: the minion whose change it was pinned on.
 * `quick`: a scheme whose reds behind a quick train are pinned the same way (#2244), whatever its land mode. */
export function redFixes(store: Pick<Store, 'listProjects' | 'getSetting' | 'getTicketByNumber'>, fixTicket: (p: Project, mark: RedMark) => Ticket | null, fast: (projectId: number) => { ids: string[]; sha: string; n: number | null; at: number }[], quick: (projectId: number) => boolean = () => false): RedFix[] {
  const open = (t: Ticket | null | undefined, rest: Omit<RedFix, 'ticket'>) => (t && t.status !== 'closed' ? [{ ...rest, ticket: t.id }] : []);
  return store
    .listProjects()
    .flatMap((p) => [
      ...Object.entries(store.getSetting<Record<string, RedMark>>(`ci-health:red:${p.id}`) ?? {}).flatMap(([workflow, mark]) => open(fixTicket(p, mark), { key: `${p.id}:${workflow}`, run: String(mark.runs?.at(-1) ?? mark.run), what: `${mark.file ?? 'a workflow'} is red` })),
      ...(p.land_mode === 'fast' || quick(p.id) ? fast(p.id) : []).flatMap((r) => open(r.n === null ? null : store.getTicketByNumber(p.id, r.n), { key: `${p.id}:${r.sha}`, run: String(r.at), what: `${r.ids[0] ?? 'the suite'} is red` })),
    ]);
}

export interface UrgentFixesDeps {
  store: Pick<Store, 'getTicket' | 'getSetting' | 'setSetting'>;
  urgent: Urgent;
  from: string;
  reds: () => RedFix[];
  chains: () => Chain[];
}

/** Red → the fix tagged for it and the newest failure then, so one that shipped isn't tagged again while its re-run goes. */
const TAGGED = 'urgent-reds';
const red = (key: string) => `red:${key}`;

export class UrgentFixes {
  private d: UrgentFixesDeps;
  /** A failed deploy whose minion found no place: tried again until a good deploy. shortcut: in memory, so a restart forgets it. */
  private unplaced = new Map<string, { ticket: number; reason: string }>();

  constructor(d: UrgentFixesDeps) {
    this.d = d;
  }

  tick() {
    const { store, urgent } = this.d;
    const reds = this.d.reds();
    const all = this.d.chains();
    const chains = all.filter((c) => !c.held);
    // Its red is green again or another minion has it now; or its chain was held or set behind another before it started.
    urgent.passed((m) => {
      if (m.cause?.startsWith('red:')) return !reds.some((r) => red(r.key) === m.cause && r.ticket === m.ticket);
      const c = m.cause?.startsWith('after:') && all.find((o) => o.ticket === m.ticket);
      return !!c && (!!c.held || `after:${c.after}` !== m.cause);
    });
    for (const [cause, w] of this.unplaced) if (this.tag(w.ticket, cause, w.reason)) this.unplaced.delete(cause);
    const was = store.getSetting<Record<string, { ticket: number; run: string }>>(TAGGED) ?? {};
    const tagged: typeof was = {};
    for (const r of reds) {
      const again = was[r.key]?.ticket === r.ticket && was[r.key].run === r.run && !urgent.get(r.ticket);
      if (again || this.tag(r.ticket, red(r.key), `Fixing main: ${r.what}`, true)) tagged[r.key] = { ticket: r.ticket, run: r.run };
    }
    if (JSON.stringify(tagged) !== JSON.stringify(was)) store.setSetting(TAGGED, tagged);
    for (const r of reds) if (tagged[r.key]) this.followers(r.ticket, chains, new Set([r.ticket]));
  }

  /** The minions chained behind a fix, the nearest first: tagged until they ship, since the red clears as they start. */
  private followers(lead: number, chains: Chain[], seen: Set<number>) {
    const n = this.d.store.getTicket(lead)?.number;
    const behind = chains.filter((c) => c.after === lead && !seen.has(c.ticket));
    for (const c of behind) {
      seen.add(c.ticket);
      this.tag(c.ticket, `after:${lead}`, `Starts after #${n}, which is fixing main`);
    }
    for (const c of behind) this.followers(c.ticket, chains, seen);
  }

  /** Whether it is Urgent now, by this or anyone. `over`: a follow-up gives up its place for it when both are taken. */
  private tag(ticketId: number, cause: string, reason: string, over = false): boolean {
    const t = this.d.store.getTicket(ticketId);
    if (!t || t.status === 'closed' || t.kind === 'coordinator') return false;
    const how: UrgentBy = { kind: 'server', by: this.d.from, reason, cause };
    const { urgent } = this.d;
    if (urgent.get(ticketId)) return true;
    const why = urgent.set(ticketId, how);
    const last = over && why === SERVER_FULL && urgent.list().findLast((m) => m.kind === 'server' && m.cause?.startsWith('after:'));
    if (!last) return why === null;
    urgent.passed((m) => m.ticket === last.ticket);
    return urgent.set(ticketId, how) === null;
  }

  /** A deploy ended: one that failed or rolled back tags the minion that ran it (null: nobody's) in place of an earlier failure's; the next good one takes it off. */
  deployEnded(name: string, ticketId: number | null, ok: boolean, reason: string) {
    const cause = `deploy:${name}`;
    if (!ok && ticketId === null) return;
    this.unplaced.delete(cause);
    this.d.urgent.passed((m) => m.cause === cause && (ok || m.ticket !== ticketId));
    if (!ok && ticketId !== null && !this.tag(ticketId, cause, reason)) this.unplaced.set(cause, { ticket: ticketId, reason });
  }

  /**
   * tools/deploy.sh's report of this app's own restart, to each minion in it. Only one that restarted and didn't come up
   * tags, not one that gave up before; and of its minions the one whose commit is the tip, not those "and the newer commits" passed.
   */
  deployReported(app: string, ticketId: number, ok: boolean, text: string) {
    if (ok || (/^Deploy of \S+ failed/.test(text) && !/ This restart was for your \S+ and the newer commits/.test(text))) this.deployEnded(app, ticketId, ok, `Its deploy of ${app} failed`);
  }
}
