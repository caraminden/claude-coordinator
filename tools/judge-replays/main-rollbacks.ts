// The main-rollbacks judge (src/main-rollback.ts, #2077) over each scheme's real repo: its main reflog from the window's
// start, with the minions as they were at each reset (closed ones closed later read as open) and each branch where its
// reflog had it a minute after. Nothing is sent: the replay's tell only records. The judge never acted before #2077, so `real` is empty.
import { MainRollbacks, reflog, rollbackMarkKey } from '../../src/main-rollback.ts';
import { gitOut } from '../../src/git.ts';
import { minionsAsOf, replayStore } from './store.ts';
import type { Act, ReplayCtx, ReplayResult } from './types.ts';

export async function replay(ctx: ReplayCtx): Promise<ReplayResult> {
  const start = ctx.now - ctx.days * 86_400_000;
  const store = replayStore(ctx.db, ['settings']);
  let now = ctx.now;
  minionsAsOf(store, () => now);
  const projects = store.listProjects().filter((p) => p.repo_dir && (ctx.scheme == null || p.id === ctx.scheme));
  const hits: Act[] = [];
  let resets = 0;
  for (const p of projects) {
    const repo = p.repo_dir!;
    const name = (await gitOut(['rev-parse', '-q', '--verify', 'refs/heads/main'], repo)) ? 'main' : 'master';
    // The mark at the newest entry before the window: the sweep reads every move since, as it would have live.
    const before = await gitOut(['reflog', 'show', '--date=unix', '--format=%H %gd', `--until=${Math.floor(start / 1000)}`, '-n', '1', `refs/heads/${name}`, '--'], repo);
    const m = before && /^([0-9a-f]{40,}) \S*@\{(\d+)\}$/.exec(before);
    if (!m) continue;
    store.setSetting(rollbackMarkKey(p.id), { at: Number(m[2]), sha: m[1] });
    let at = 0;
    const sweeper = new MainRollbacks({
      store,
      before: (r) => void ((at = r.at * 1000), (now = at)),
      // Where the branch stood a sweep after the reset: its newest reflog entry by then.
      tipAt: async (repo, branch, r) => (await reflog(repo, `refs/heads/${branch}`))?.find((e) => e.at <= r.at + 60)?.sha ?? null,
      tell: (id, text) => {
        const t = store.getTicket(id);
        hits.push({ at, key: `${p.id}:${at}:${t?.number ?? id}`, text: `${p.name} #${t?.number ?? '?'}: ${text.split('\n')[0]}` });
      },
    });
    resets += (await sweeper.scheme(p.id, repo)).length;
  }
  return {
    inputs: `${resets} resets of main that dropped commits in ${projects.length} schemes over ${ctx.days} days`,
    hits,
    real: [],
    limits: ["each branch is read from its reflog as it stood a minute after the reset; a branch deleted since (a dismissed minion's) is not seen", 'main is read as it is now, so a dropped commit shipped again since counts as back on main'],
  };
}
