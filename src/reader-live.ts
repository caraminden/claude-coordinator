// What the main thread posts to the readers' snapshot (#1590, Snapshot in src/front.ts), so the minions list, a
// minion's page and the Status page answer from reader threads with the state main would show: each minion's
// Runner.live() whenever its view is built (every broadcast of it), every minion once at the start, the running ones
// again every few seconds (what a turn last did moves with no broadcast), every open one now and then, and the Status
// page's inputs that live in memory. Only what changed is posted.
import type { Store, ContraptionRow } from './db.ts';
import type { Runner } from './runner.ts';
import type { SnapDelta } from './front.ts';
import type { StatusPage } from './status-page.ts';
import type { DiskUse } from './app-services.ts';
import { jobList } from './every.ts';
import { cores } from './host-signals.ts';

/** How often the running minions and the Status inputs are posted again, and every open minion every SWEEP_ALL of those. */
export const SWEEP_MS = 3000;
const SWEEP_ALL = 20;
/** Main reads the units' states at most this often for the readers (StatusPage.unitRows keeps its own 60 s too). */
const UNITS_MS = 60_000;

export type LiveDeps = {
  publish: (d: SnapDelta) => void;
  store: Store;
  runner: Runner;
  builds: (projectId: number) => unknown;
  ownScheme: () => number | null;
  status: StatusPage;
  /** The Status page's in-memory inputs, as server.ts gives them to its StatusPage. */
  statusInputs: { bootAt: number; commit: string; probing: boolean; lastMs: () => number | null; storms: () => unknown; desktops: () => unknown; diskUse: (row: ContraptionRow) => DiskUse | null };
  sweepMs?: number;
};

export function publishLive(d: LiveDeps) {
  const { store, runner } = d;
  const sent = new Map<number, string>();
  let batch: Record<number, unknown> | null = null;
  const flush = () => {
    if (!batch) return;
    const b = batch;
    batch = null;
    d.publish({ live: b });
  };
  const note = (id: number, live: unknown) => {
    const json = JSON.stringify(live);
    if (sent.get(id) === json) return;
    sent.set(id, json);
    // One post for a list's worth of views, before anything else runs on this thread.
    if (!batch) queueMicrotask(flush);
    (batch ??= {})[id] = live;
  };
  runner.onLive = note;
  const liveOf = (id: number) => {
    const t = store.getTicket(id);
    if (t) note(id, runner.live(t));
  };

  let lastOther = '';
  let units: { at: number; rows: unknown } | null = null;
  const others = async () => {
    const s = d.statusInputs;
    if (!units || Date.now() - units.at >= UNITS_MS) units = { at: Date.now(), rows: await d.status.unitRows(store.listContraptions()) };
    const status = {
      bootAt: s.bootAt, commit: s.commit, cores: cores(), probing: s.probing, lastMs: s.lastMs(), storms: s.storms(), desktops: s.desktops(),
      disk: Object.fromEntries(store.listContraptions().map((r) => [r.name, s.diskUse(r)])), units: units.rows, jobs: jobList(),
    };
    const projects = store.listProjects();
    const delta: SnapDelta = { status, builds: Object.fromEntries(projects.map((p) => [p.id, d.builds(p.id)])), ownScheme: d.ownScheme() };
    const json = JSON.stringify(delta);
    if (json !== lastOther) d.publish(delta);
    lastOther = json;
  };

  // Every minion once, a hundred at a time between other work, then `ready`: until then readers send these pages to main.
  const seed = async () => {
    await others();
    const ids = store.listProjects().flatMap((p) => store.listTickets(p.id).map((t) => t.id));
    for (let i = 0; i < ids.length; i++) {
      liveOf(ids[i]);
      if (i % 100 === 99) await new Promise((r) => setImmediate(r));
    }
    flush();
    d.publish({ ready: true });
  };

  let tick = 0;
  let busy = false;
  const sweep = async () => {
    if (busy) return;
    busy = true;
    try {
      await others();
      for (const id of runner.runningIds()) liveOf(id);
      if (++tick % SWEEP_ALL === 0) {
        const open = store.listProjects().flatMap((p) => store.listTickets(p.id).filter((t) => t.status !== 'closed').map((t) => t.id));
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

  const ready = seed().catch((err) => console.error(`Readers' snapshot: the first pass failed: ${(err as Error)?.stack ?? err}`));
  const timer = setInterval(() => void sweep(), d.sweepMs ?? SWEEP_MS);
  timer.unref();
  return { ready, stop: () => clearInterval(timer) };
}
