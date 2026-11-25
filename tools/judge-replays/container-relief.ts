// The container-relief judge (src/container-relief.ts, #1876) over the memory storms on record: each 'memory-high' event of a
// person's container is read back as one reading every RELIEF.everyMs at the storm's own average stall, and the real step()
// says when a process would have died. Real acts are the 'memory-kill' events. Nothing is killed: the replay calls step() only.
import { RELIEF, step, type Watched } from '../../src/container-relief.ts';
import { parseStorm } from '../../src/memory-storms.ts';
import { pacific } from '../../src/pacific.ts';
import { replayStore } from './store.ts';
import type { Act, ReplayCtx, ReplayResult } from './types.ts';

const CONTAINER = /^citadel-claude-\d+\.service$/;

export async function replay(ctx: ReplayCtx): Promise<ReplayResult> {
  const start = ctx.now - ctx.days * 86_400_000;
  const store = replayStore(ctx.db, []);
  const hits: Act[] = [];
  let storms = 0;
  for (const e of store.healthEventsSince(['memory-high'], start)) {
    const storm = parseStorm(e.detail);
    if (!storm || !CONTAINER.test(storm.group)) continue;
    storms++;
    // A storm recorded by a late server holds more stalled time than its span: it lasted at least that long.
    const seconds = Math.max(storm.seconds, storm.stalled);
    const avg10 = Math.min(100, (100 * storm.stalled) / seconds);
    let s: Watched | undefined;
    for (let t = e.at - RELIEF.everyMs, high = 0; t <= e.at + seconds * 1000; t += RELIEF.everyMs) {
      const out = step(s, { high: high++, avg10 }, t);
      s = out.s;
      if (!out.kill) continue;
      s.killedAt = t;
      hits.push({ at: t, key: `${storm.group}:${Math.floor(t / 60_000)}`, text: `${storm.group}: its biggest process, ${Math.round((t - e.at) / 1000)} s into the storm of ${pacific(e.at)} (${Math.round(avg10)}% stalled over ${seconds} s)` });
    }
  }
  const real = store.healthEventsSince(['memory-kill'], start).map((e) => ({ at: e.at, key: `${(JSON.parse(e.detail) as { group: string }).group}:${Math.floor(e.at / 60_000)}`, text: e.detail }));
  return {
    inputs: `${storms} container memory storms over ${ctx.days} days`,
    hits,
    real,
    limits: ['a stored storm keeps its average stall, not each reading: a spike or a calm inside it is smoothed out', "it can't know a kill would have ended the storm, so later kills in one storm are the most there could be", 'which process dies: no process list was kept before #1876'],
  };
}
