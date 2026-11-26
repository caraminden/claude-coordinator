// The post-deploy watch (src/deploy-watch.ts) over the real deploys of the window: each release of the Citadel server
// goes live at its real time, the checks run when they came due, and the alerts it would send now are set beside the
// "Post-deploy watch:" mails the Taskmaster really got. The watch only ever watches the server it runs in.
import { DeployWatch, gitCommits, gitFiles } from '../../src/deploy-watch.ts';
import { replayStore } from './store.ts';
import type { Act, ReplayCtx, ReplayResult } from './types.ts';

const DEPLOY = /\(deploy ([0-9a-f]{8})\)/;
const WOKE = /Woke ((?:#\d+(?:, )?)+)\./;

export async function replay(ctx: ReplayCtx): Promise<ReplayResult> {
  const start = ctx.now - ctx.days * 86_400_000;
  const store = replayStore(ctx.db, ['settings']);
  const deploys = store.db.prepare("SELECT project_id, version, live_at FROM releases WHERE target = 'citadel-server' AND live_at IS NOT NULL AND live_at <= ? ORDER BY live_at").all(ctx.now) as { project_id: number; version: string; live_at: number }[];
  const before = deploys.filter((d) => d.live_at < start).at(-1);
  const inWindow = deploys.filter((d) => d.live_at >= start);
  const schemeId = ctx.scheme ?? inWindow[0]?.project_id ?? before?.project_id;
  const scheme = schemeId != null ? (store.getProject(schemeId) ?? null) : null;
  let now = before?.live_at ?? start;
  const hits: Act[] = [];
  const watch = new DeployWatch({
    store,
    dbPath: ctx.db,
    head: () => null,
    scheme: () => scheme,
    now: () => now,
    bootAt: 0,
    commits: gitCommits(ctx.repo),
    files: gitFiles(ctx.repo),
    wake: () => {},
    note: () => {},
    mail: (_tm, text) => hits.push({ at: now, key: DEPLOY.exec(text)?.[1] ?? '?', text }),
  });
  if (before) watch.live(before.version);
  // Every moment something happens: a deploy goes live, or one of its checks or holds (#2049) comes due (capped at now).
  const times = [...new Set(inWindow.flatMap((d) => [d.live_at, ...[20, 40, 60, 80, 1440, 1460].map((m) => Math.min(d.live_at + m * 60_000, ctx.now))]))].sort((a, b) => a - b);
  const live = new Map(inWindow.map((d) => [d.live_at, d.version]));
  for (const t of times) {
    now = t;
    const v = live.get(t);
    if (v) watch.live(v);
    await watch.tick();
  }
  const real = (store.db.prepare('SELECT created_at, data FROM events WHERE id >= ? AND kind = \'user_message\' AND data LIKE \'{"author":"Citadel","text":"Post-deploy watch: after %\' ORDER BY id').all(store.eventIdAt(start)) as { created_at: number; data: string }[]).map((r) => {
    const text = String(JSON.parse(r.data).text);
    return { at: r.created_at, key: DEPLOY.exec(text)?.[1] ?? '?', text };
  });
  return {
    inputs: `${inWindow.length} deploys of the Citadel server, health_events and turns from the database`,
    hits: hits.map((h) => ({ ...h, text: short(h.text) })),
    real: real.map((r) => ({ ...r, text: short(r.text) })),
    limits: ['health_events are kept 8 days (and only exist from Nov 17), so a window older than that reads as quiet', "a check due after now hasn't run yet, in the replay as in life"],
  };
}

/** The mail without its boilerplate: when, what got worse, and who it woke. */
function short(text: string) {
  const what = text.replace(/^Post-deploy watch: after [^,]+, [^,]+ \(deploy [0-9a-f]{8}\), /, '').replace(/ \([^)]*after vs before\).*$/s, '');
  return `${what}; woke ${WOKE.exec(text)?.[1] ?? 'no one'}`;
}
