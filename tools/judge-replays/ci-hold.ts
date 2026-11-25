// Deploys first (CiHold, src/ci-hold.ts) over Citadel's real CI runs: the real code looks every 15 s at the runs as they
// stood (gh reads them once, read-only), its cancels and re-runs land on a copy in memory, and each stop it would make is a
// hit. It throws if it would stop a ship's run or own check, or leave a stopped run un-started at the end of a quiet spell.
import { execFile, execFileSync } from 'node:child_process';
import { CiHold, HOLD_POLL_MS, kindOf } from '../../src/ci-hold.ts';
import { repoSlug } from '../../src/prlinks.ts';
import type { Act, ReplayCtx, ReplayResult } from './types.ts';

interface Run {
  id: number;
  path: string;
  display_title: string;
  head_branch: string | null;
  created_at: string;
  run_started_at: string;
  updated_at: string;
}
/** A run in the replay: when it runs, how long it takes, and where it stands. */
interface Sim {
  run: Run;
  from: number;
  ms: number;
  attempt: number;
  cancelled: boolean;
}

const gh = (path: string) => new Promise<Run[]>((done, fail) => execFile('gh', ['api', path], { timeout: 60_000, maxBuffer: 64 << 20 }, (err, out) => (err ? fail(err) : done(JSON.parse(out).workflow_runs))));

export async function replay(ctx: ReplayCtx): Promise<ReplayResult> {
  const start = ctx.now - ctx.days * 86_400_000;
  const slug = repoSlug(execFileSync('git', ['-C', ctx.repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim())?.toLowerCase();
  if (!slug) throw new Error('this clone has no GitHub origin');
  const sims: Sim[] = [];
  for (const file of ['tests.yml', 'flake-proof.yml', 'citadel-heavy.yml'])
    for (let page = 1; page <= 10; page++) {
      const runs = await gh(`repos/${slug}/actions/workflows/${file}/runs?per_page=100&page=${page}&created=>=${new Date(start).toISOString().slice(0, 10)}`);
      for (const run of runs) {
        const from = Date.parse(run.created_at);
        if (from >= start) sims.push({ run, from, ms: Math.max(0, Date.parse(run.updated_at) - Date.parse(run.run_started_at)), attempt: 1, cancelled: false });
      }
      if (runs.length < 100) break;
    }
  let now = start;
  const active = (s: Sim) => !s.cancelled && s.from <= now && now < s.from + s.ms;
  const shown = (s: Sim) => ({ ...s.run, status: active(s) ? 'in_progress' : 'completed', conclusion: active(s) ? null : s.cancelled ? 'cancelled' : 'success', run_attempt: s.attempt, run_started_at: new Date(s.from).toISOString() });
  const byId = new Map(sims.map((s) => [s.run.id, s]));
  const hits: Act[] = [];
  const held = new Map<number, number>();
  const waits: number[] = [];
  const settings = new Map<string, unknown>();
  const hold = new CiHold({
    own: () => slug,
    repos: () => [],
    as: () => ({}),
    line: () => 0,
    off: () => false,
    ticket: () => null,
    closed: () => false,
    tell: () => {},
    report: (_repo, text) => void hits.push({ at: now, key: `report ${now}`, text }),
    store: { getSetting: <T>(k: string) => (settings.get(k) as T) ?? null, setSetting: (k, v) => void settings.set(k, v) },
    get: async (path) => {
      const one = /runs\/(\d+)$/.exec(path);
      const sim = one && byId.get(Number(one[1]));
      const body = sim ? shown(sim) : { workflow_runs: path.includes('status=in_progress') ? sims.filter(active).map(shown) : [] };
      return { status: 200, etag: null, body };
    },
    post: async (path) => {
      const [, id, what] = /runs\/(\d+)\/(.+)$/.exec(path) ?? [];
      const sim = byId.get(Number(id));
      if (!sim) throw new Error(`a post for a run the replay doesn't know: ${path}`);
      if (what === 'rerun') {
        Object.assign(sim, { from: now, cancelled: false, attempt: sim.attempt + 1 });
        waits.push(now - (held.get(sim.run.id) ?? now));
      } else {
        const kind = kindOf(sim.run, true);
        if (kind === 'ship' || kind === null) throw new Error(`it would stop ${kind ?? 'a run it leaves alone'}: ${sim.run.display_title} (${sim.run.head_branch})`);
        sim.cancelled = true;
        held.set(sim.run.id, now);
        hits.push({ at: now, key: `stop ${id} ${sim.attempt}`, text: `stops ${kind} "${sim.run.display_title}" on ${sim.run.head_branch}, ${Math.round((now - sim.from) / 60_000)} min in` });
      }
      return { status: 201 };
    },
  });
  for (; now <= ctx.now; now += HOLD_POLL_MS) await hold.tick(now);
  // Quiet from here: whatever is still held must come back. Two proofs of one file go one after the other, after a back-off of up to 40 min.
  for (const end = now + 3 * 3600_000; now < end; now += HOLD_POLL_MS) await hold.tick(now);
  const stuck = hold.state(now).held.filter((h) => h.phase !== 'resumed');
  if (stuck.length) throw new Error(`still held after 3 hours with nothing running: ${stuck.map((h) => h.what).join(', ')}`);
  const sorted = waits.sort((a, b) => a - b);
  const min = (ms: number | undefined) => Math.round((ms ?? 0) / 60_000);
  return {
    inputs: `${sims.length} CI runs of ${slug} (gh, read-only); ${held.size} runs held, waits median ${min(sorted[sorted.length >> 1])} min, longest ${min(sorted.at(-1))} min`,
    hits,
    real: [],
    limits: ["the ship line's history isn't kept, so only a ship's CI run counts as a ship here: the live hold also counts ships in line, so it holds more", 'a re-run is taken to last as long as the first one did', 'other schemes are left out'],
  };
}
