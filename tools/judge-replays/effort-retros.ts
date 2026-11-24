// The effort-retros judge (src/effort-retros.ts, #1751) over each scheme's real efforts: every hour of the window, the real
// effortsDue sees the minions as they were then (closed ones closed later read as open), and the retros it would start
// are set beside the real ones, the effort-retro:* settings rows. Nothing is started: the replay calls effortsDue only.
import { effortsDue, EFFORT_KEY } from '../../src/effort-retros.ts';
import type { Ticket } from '../../src/db.ts';
import { Registry } from '../../src/properties.ts';
import { minionsAsOf, replayStore } from './store.ts';
import type { Act, ReplayCtx, ReplayResult } from './types.ts';

const STEP_MS = 3_600_000;

export async function replay(ctx: ReplayCtx): Promise<ReplayResult> {
  const start = ctx.now - ctx.days * 86_400_000;
  const store = replayStore(ctx.db, ['settings'], { settings: "key LIKE 'effort-retro:%'" });
  let now = start;
  minionsAsOf(store, () => now);
  // The registry's constructor writes its schema: a read-only replay takes its reads only.
  const props = Object.assign(Object.create(Registry.prototype), { db: (store as unknown as { db: unknown }).db }) as Registry;
  const projects = store.listProjects().filter((p) => ctx.scheme == null || p.id === ctx.scheme);
  const hits: Act[] = [];
  const real: Act[] = [];
  let efforts = 0;
  for (const p of projects) {
    const rows = props.minionsWith(p.id, EFFORT_KEY);
    const effortOf = new Map(rows.map((r) => [r.id, r.value]));
    efforts += new Set(effortOf.values()).size;
    const done = new Set<string>();
    for (now = start; now <= ctx.now; now += STEP_MS) {
      const tickets = rows.map((r) => store.getTicket(r.id)).filter((t): t is Ticket => !!t);
      for (const v of effortsDue(tickets, effortOf, (name) => done.has(name), now)) {
        done.add(v.name);
        hits.push({ at: now, key: `${p.id}:${v.name}`, text: `${p.name} "${v.name}": ${v.act === 'skip' ? 'no retro' : 'start a retro'}, ${v.why}` });
      }
    }
    for (const r of store.settingsWithPrefix<{ act: string; why: string; at?: number }>(`effort-retro:${p.id}:`)) {
      const name = r.key.slice(`effort-retro:${p.id}:`.length);
      if ((r.value.at ?? 0) >= start) real.push({ at: r.value.at ?? 0, key: `${p.id}:${name}`, text: `${p.name} "${name}": ${r.value.act}, ${r.value.why}` });
    }
  }
  return {
    inputs: `${efforts} named or chained efforts in ${projects.length} schemes, checked hourly over ${ctx.days} days`,
    hits,
    real,
    limits: [
      'effortName is read as it is now: a name changed during the window reads as the new one',
      'A real act marked "would" was log-only; one marked "skip" was a build retro skip, also a hit here',
    ],
  };
}
