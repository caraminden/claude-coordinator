// What the main thread posts to the readers' snapshot (#1590, Snapshot in src/front.ts), so the minions list, a
// minion's page and the Status page answer from reader threads with the state main would show: each minion's
// Runner.live() whenever its view is built (every broadcast of it), every minion once at the start, the running ones
// again every few seconds (what a turn last did moves with no broadcast), every open one now and then, and the Status
// page's inputs that live in memory. Only what changed is posted.
import type { Store, ContraptionRow } from './db.ts';
import type { Runner } from './runner.ts';
import type { SnapDelta, Ships, StatusSnap } from './front.ts';
import type { StatusPage } from './status-page.ts';
import type { DiskUse } from './app-services.ts';
import { jobList } from './every.ts';
import { cores } from './host-signals.ts';
import type { CabalCard } from './cabal-cards.ts';

/** How often the running minions and the Status inputs are posted again, and every open minion every SWEEP_ALL of those. */
export const SWEEP_MS = 3000;
const SWEEP_ALL = 20;
/** Main reads the units' states at most this often for the readers (StatusPage.unitRows keeps its own 60 s too). */
const UNITS_MS = 60_000;

export type LiveDeps = {
  /** `counted`: the change was announced with coming(). */
  publish: (d: SnapDelta, counted?: boolean) => void;
  /** A minion's live state changed and is published within this run of the thread. */
  coming: () => void;
  store: Store;
  runner: Runner;
  builds: (projectId: number) => unknown;
  cabals: (projectId: number) => CabalCard[];
  ownScheme: () => number | null;
  /** Whether this server makes build previews (none in a preview server). */
  previews: boolean;
  status: StatusPage;
  /** The Status page's in-memory inputs, as server.ts gives them to its StatusPage. */
  /** The ship lines' inputs (Ships in src/front.ts), for /api/ship-lines. */
  ships: () => Ships;
  statusInputs: {
    bootAt: number;
    commit: string;
    probing: boolean;
    lastMs: () => number | null;
    readerMs: () => number | null;
    storms: () => StatusSnap['storms'];
    easing: () => StatusSnap['easing'];
    desktops: () => StatusSnap['desktops'];
    asleep?: () => NonNullable<StatusSnap['asleep']>;
    diskUse: (row: ContraptionRow) => DiskUse | null;
  };
  sweepMs?: number;
  /** The old server's snapshot in a warm handover (its `dump`): readers answer from it until this one's own first pass. */
  handed?: string | null;
};

export function publishLive(d: LiveDeps) {
  const { store, runner } = d;
  const sent = new Map<number, string>();
  let batch: Record<number, unknown> | null = null;
  const flush = () => {
    if (!batch) return;
    const b = batch;
    batch = null;
    d.publish({ live: b }, true);
  };
  const note = (id: number, live: unknown) => {
    const json = JSON.stringify(live);
    if (sent.get(id) === json) return;
    sent.set(id, json);
    // One post for a list's worth of views, before anything else runs on this thread.
    // Told now that a change is on its way (#1963): a response written before the microtask runs let the person's
    // next request reach a reader that didn't have it yet.
    if (!batch) {
      d.coming();
      queueMicrotask(flush);
    }
    (batch ??= {})[id] = live;
  };
  runner.onLive = note;
  const liveOf = (id: number) => {
    const t = store.getTicket(id);
    if (t) note(id, runner.live(t));
  };

  let lastOther = '';
  let units: { at: number; rows: StatusSnap['units'] } | null = null;
  const others = async () => {
    const s = d.statusInputs;
    if (!units || Date.now() - units.at >= UNITS_MS) units = { at: Date.now(), rows: await d.status.unitRows(store.listContraptions()) };
    const status: StatusSnap = {
      bootAt: s.bootAt,
      commit: s.commit,
      cores: cores(),
      probing: s.probing,
      lastMs: s.lastMs(),
      readerMs: s.readerMs(),
      storms: s.storms(),
      easing: s.easing(),
      desktops: s.desktops(),
      asleep: s.asleep?.() ?? [],
      disk: Object.fromEntries(store.listContraptions().map((r) => [r.name, s.diskUse(r)])),
      units: units.rows,
      jobs: jobList(),
    };
    const projects = store.listProjects();
    const delta: SnapDelta = { status, ships: d.ships(), builds: Object.fromEntries(projects.map((p) => [p.id, d.builds(p.id)])), cabals: Object.fromEntries(projects.map((p) => [p.id, d.cabals(p.id)])), ownScheme: d.ownScheme(), previews: d.previews };
    const json = JSON.stringify(delta);
    if (json !== lastOther) d.publish(delta);
    lastOther = json;
  };

  // The old server's views, posted whole and `ready` at once (#2119): the first pass below then posts only what differs.
  // Its Status inputs aren't taken (its boot time and commit); readers send the Status page to main until others() runs.
  let handedOver: number | null = null;
  if (d.handed) {
    try {
      const h = JSON.parse(d.handed) as { live: Record<number, unknown>; other: SnapDelta | null };
      for (const [id, live] of Object.entries(h.live)) sent.set(Number(id), JSON.stringify(live));
      const { status: _theirs, ...other } = h.other ?? {};
      d.publish({ ...other, live: h.live, ready: true });
      handedOver = sent.size;
    } catch (err) {
      sent.clear();
      console.error(`Readers' snapshot: the one handed over didn't read; building this server's own: ${(err as Error)?.message ?? err}`);
    }
  }

  // Every minion once, fifty at a time between other work, then `ready`: until then readers send these pages to main.
  let seeded = false;
  const seed = async () => {
    const start = performance.now();
    await others();
    const ids = store.listProjects().flatMap((p) => store.listTickets(p.id).map((t) => t.id));
    // The longest stretch it held the main thread, which is what people's other requests wait behind.
    let longest = 0,
      from = performance.now();
    for (let i = 0; i < ids.length; i++) {
      liveOf(ids[i]);
      if (i % 50 === 49) {
        longest = Math.max(longest, performance.now() - from);
        await new Promise((r) => setImmediate(r));
        from = performance.now();
      }
    }
    flush();
    longest = Math.max(longest, performance.now() - from);
    d.publish({ ready: true });
    seeded = true;
    console.log(`Readers' snapshot: ${ids.length} minions in ${Math.round(performance.now() - start)} ms, at most ${Math.round(longest)} ms at a time${handedOver === null ? '' : `, after ${handedOver} handed over`}`);
  };

  let tick = 0;
  let busy = false;
  const sweep = async () => {
    if (busy) return;
    busy = true;
    try {
      // A first pass that failed is tried again, or these pages would stay on main until a restart.
      if (!seeded) return await seed();
      await others();
      for (const id of [...runner.runningIds(), ...runner.turnLine.waiting()]) liveOf(id);
      if (++tick % SWEEP_ALL === 0) {
        const open = store.listProjects().flatMap((p) =>
          store
            .listTickets(p.id)
            .filter((t) => t.status !== 'closed')
            .map((t) => t.id),
        );
        for (let i = 0; i < open.length; i++) {
          liveOf(open[i]);
          if (i % 50 === 49) await new Promise((r) => setImmediate(r));
        }
      }
    } catch (err) {
      console.error(`Readers' snapshot: ${(err as Error)?.stack ?? err}`);
    } finally {
      busy = false;
    }
  };

  // Under the sweep's own flag, so a slow first pass isn't started twice.
  busy = true;
  const ready = seed()
    .catch((err) => console.error(`Readers' snapshot: the first pass failed (tried again on the next sweep): ${(err as Error)?.stack ?? err}`))
    .finally(() => (busy = false));
  const timer = setInterval(() => void sweep(), d.sweepMs ?? SWEEP_MS);
  timer.unref();
  return {
    ready,
    stop: () => clearInterval(timer),
    /** What readers have now, for a warm handover's new server (standby's `handed`); null before the first pass. */
    dump: () => (seeded ? `{"live":{${[...sent].map(([id, json]) => `"${id}":${json}`).join(',')}},"other":${lastOther || 'null'}}` : null),
  };
}
