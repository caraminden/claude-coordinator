// CI health's red-on-main judge (CiHealth.outsideRuns, src/ci-health.ts) over each scheme's real runs on its main: every
// 15 minutes and at each run's end, the real code sees the runs as they stood then (gh reads them once, read-only) and the
// minions as they were, and the Taskmaster wakes and the hour-late rings it would send are set beside the real ones.
// It runs the real method with CiHealth's own GitHub reads stubbed out, so nothing is re-run, dismissed or sent.
import { execFile } from 'node:child_process';
import { CiHealth } from '../../src/ci-health.ts';
import type { Project } from '../../src/db.ts';
import { repoSlug } from '../../src/prlinks.ts';
import { minionsAsOf, replayStore } from './store.ts';
import type { Act, ReplayCtx, ReplayResult } from './types.ts';

const STEP_MS = 15 * 60_000;
/** Runs from this long before the window too: the red streak a window starts inside of. */
const LEAD_MS = 8 * 86_400_000;
const RED = /run (\d+) failed on/;
const RING = /^[^\n]*?: CI: \S+ failed on \S+ \(run (\d+)/;

/** A GitHub answer as read here: one run, a page of runs or the repo. */
type GhReply = Run & { workflow_runs: Run[]; default_branch?: string };

type Run = { id: number; workflow_id: number; created_at: string; updated_at?: string; run_started_at?: string; run_attempt?: number; status: string; conclusion: string | null; [k: string]: unknown };

function gh(path: string): Promise<GhReply | null> {
  return new Promise((done) => execFile('gh', ['api', path], { timeout: 60_000, maxBuffer: 64 << 20 }, (err, out) => done(err ? null : JSON.parse(out))));
}

/** Every run on `branch` created since `from`, oldest first; null when gh can't read the repo. */
async function runsOn(slug: string, branch: string, from: number): Promise<Run[] | null> {
  const all: Run[] = [];
  for (let page = 1; page <= 10; page++) {
    const got = await gh(`repos/${slug}/actions/runs?branch=${encodeURIComponent(branch)}&per_page=100&page=${page}&created=>=${new Date(from).toISOString().slice(0, 10)}`);
    if (!got) return page === 1 ? null : all;
    all.push(...got.workflow_runs);
    if (got.workflow_runs.length < 100) break;
  }
  return all.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
}

/** A run as it stood at `t`: running, its first attempt's end, a re-run running, or as it is now. */
function asAt(r: Run, first: Run | undefined, t: number): Run {
  const running = { ...r, status: 'in_progress', conclusion: null };
  if (first) {
    if (t < Date.parse(first.updated_at ?? first.created_at)) return running;
    if (t < Date.parse(r.run_started_at ?? r.created_at)) return { ...r, ...first, id: r.id };
  }
  return t < Date.parse(r.updated_at ?? r.created_at) ? running : r;
}

export async function replay(ctx: ReplayCtx): Promise<ReplayResult> {
  const start = ctx.now - ctx.days * 86_400_000;
  const store = replayStore(ctx.db, ['settings']);
  let now = start;
  minionsAsOf(store, () => now);
  // Chat that names a run counts only once it was written.
  const naming = store.minionsNaming.bind(store);
  store.minionsNaming = (pid, needles, after, atMost = Infinity) => naming(pid, needles, after, Math.min(atMost, store.eventIdAt(now)));
  const projects = store.listProjects().filter((p) => repoSlug(p.repo_url) && (ctx.scheme == null || p.id === ctx.scheme));
  const unread: string[] = [];
  const hits: Act[] = [];
  let warm = true;
  for (const p of projects) {
    const slug = repoSlug(p.repo_url)!;
    const repo = await gh(`repos/${slug}`);
    const branch: string = repo?.default_branch ?? 'main';
    const runs = repo && (await runsOn(slug, branch, start - LEAD_MS));
    if (!runs) {
      unread.push(p.name);
      continue;
    }
    // A re-run shows only its last attempt: read the first, so a red that a re-run later cleared is red when it was.
    const firsts = new Map<number, Run>();
    for (const r of runs.filter((r) => (r.run_attempt ?? 1) > 1 && Date.parse(r.updated_at ?? r.created_at) > start)) {
      const a = await gh(`repos/${slug}/actions/runs/${r.id}/attempts/1`);
      if (a) firsts.set(r.id, a);
    }
    const ci = new CiHealth(store, {
      // Every GitHub read answers empty: no dispatched runs, and a red's text has no job details.
      get: async () => ({ status: 200, etag: null, body: { workflow_runs: [], jobs: [], artifacts: [] } }),
      tell: (_p: Project, text: string, wake: boolean) => {
        const run = RED.exec(text)?.[1];
        if (wake && run && !warm) hits.push({ at: now, key: `red:${run}`, text: text.split('\n')[0].slice(0, 200) });
        return true;
      },
    } as never);
    // Re-runs and dismissals act on GitHub and minions: never in a replay. The run lists are the replay's own.
    Object.assign(ci, { rerun: async () => {}, dismissFix: () => {} });
    const rung = new Set<number>();
    const ends = runs.flatMap((r) => [r.updated_at, firsts.get(r.id)?.updated_at].flatMap((x) => (x ? [Date.parse(x)] : []))).filter((t) => t > start && t <= ctx.now);
    const times = [...new Set([...ends, ...Array.from({ length: Math.floor((ctx.now - start) / STEP_MS) + 1 }, (_, i) => start + i * STEP_MS)])].sort((a, b) => a - b);
    warm = true;
    for (const t of times) {
      now = t;
      const onMain = new Map<number, Run[]>();
      for (const r of runs) {
        if (Date.parse(r.created_at) > t) break;
        onMain.set(r.workflow_id, [asAt(r, firsts.get(r.id), t), ...(onMain.get(r.workflow_id) ?? [])].slice(0, 50));
      }
      const problems = await (ci as unknown as { outsideRuns(...a: unknown[]): Promise<{ key: string; quiet?: boolean; title: string }[]> }).outsideRuns(p, slug, branch, onMain, {}, t);
      for (const x of problems) {
        const run = Number(/\(run (\d+)/.exec(x.title)?.[1]);
        if (x.quiet || rung.has(run)) continue;
        rung.add(run);
        if (!warm) hits.push({ at: t, key: `ring:${run}`, text: `${p.name}: ${x.title}`.slice(0, 200) });
      }
      warm = false;
    }
  }
  const ids = new Set(projects.map((p) => p.id));
  const real = (
    store.db
      .prepare(`SELECT e.created_at AS at, e.data, t.project_id FROM events e JOIN tickets t ON t.id = e.ticket_id
      WHERE e.id >= ? AND e.kind = 'user_message' AND e.data LIKE '{"author":"Citadel","text":"%' AND (e.data LIKE '%went red: %' OR e.data LIKE '%: CI: %')`)
      .all(store.eventIdAt(start)) as { at: number; data: string; project_id: number }[]
  )
    .filter((r) => ids.has(r.project_id) && r.at >= start)
    .flatMap((r) => {
      const text = String(JSON.parse(r.data).text);
      const red = RED.exec(text)?.[1];
      const ring = RING.exec(text)?.[1];
      if (/went red: /.test(text.split('\n')[0]) && red) return [{ at: r.at, key: `red:${red}`, text: text.split('\n')[0].slice(0, 200) }];
      return ring ? [{ at: r.at, key: `ring:${ring}`, text: text.split('\n')[0].slice(0, 200) }] : [];
    });
  return {
    inputs: `${projects.length - unread.length} schemes' runs on main (gh, read-only) and their minions' chats`,
    hits,
    real,
    limits: [
      ...(unread.length ? [`gh couldn't read ${unread.join(', ')}`] : []),
      "Citadel's own re-runs after a fix ships (#1074) aren't made, so a red stays red until the next green run or a re-run a person made",
      "dispatched runs (citadel-heavy, flake-proof) aren't replayed: the replay reads only main's run list",
      "a re-run's middle attempts aren't read, only its first and last",
      `checks every ${STEP_MS / 60_000} minutes and at each run's end, not every poll`,
    ],
  };
}
