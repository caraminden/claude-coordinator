// Each open build's standing for its header in the minions list (build branches, specs/build-branches.md):
// how many feeders are merged in and how many are still open, and how far build/<n> is behind main. All
// git facts, read in the scheme's checkout, cached per scheme and broadcast when they change. A scheme
// with no build/<n> branch has none, so the list shows its builds as before.
import { emptyBranch } from './branch.ts';
import { buildOwnerKey, type Store } from './db.ts';
import { gitOut } from './git.ts';

export interface BuildSummary {
  build: number;
  /** Feeders whose work build/<n> has: a git fact, so dismissed ones count too. */
  merged: number;
  /** Feeders still open whose work isn't in it yet. */
  open: number;
  /** Commits on main that build/<n> doesn't have. */
  behind: number;
  /** The build minion's id, when create_ticket named one. */
  owner: number | null;
}

const git = gitOut;

/** Every build branch in the repo: local build/<n>, else origin's, keyed by n. */
async function buildRefs(repoDir: string): Promise<Map<number, string>> {
  const out = await git(['for-each-ref', '--format=%(refname)', 'refs/heads/build/', 'refs/remotes/origin/build/'], repoDir);
  const refs = new Map<number, string>();
  for (const ref of (out ?? '').split('\n')) {
    const m = ref.match(/^refs\/(heads|remotes\/origin)\/build\/(\d+)$/);
    if (!m) continue;
    const n = Number(m[2]);
    if (!refs.has(n) || m[1] === 'heads') refs.set(n, ref);
  }
  return refs;
}

/** The builds with a branch in a scheme, sorted by number; [] without a repo or a build branch. */
export async function buildSummaries(store: Store, projectId: number): Promise<BuildSummary[]> {
  const repoDir = store.getProject(projectId)?.repo_dir;
  if (!repoDir) return [];
  const refs = await buildRefs(repoDir);
  if (!refs.size) return [];
  const origin = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoDir);
  const main = origin?.replace(/^origin\//, '') || 'main';
  const tickets = store.listTickets(projectId).filter((t) => t.kind === 'ticket' && t.build && refs.has(t.build));
  const out: BuildSummary[] = [];
  for (const [n, ref] of [...refs].sort(([a], [b]) => a - b)) {
    const owner = store.getSetting<number>(buildOwnerKey(projectId, n));
    let merged = 0;
    let open = 0;
    for (const t of tickets) {
      if (t.build !== n || t.id === owner) continue;
      const folded = !!t.branch && (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}`], repoDir)) !== null && !(await emptyBranch(repoDir, t.branch, t.created_at)) && (await git(['merge-base', '--is-ancestor', `refs/heads/${t.branch}`, ref], repoDir)) !== null;
      if (folded) merged++;
      else if (t.status !== 'closed') open++;
    }
    const behind = Number(await git(['rev-list', '--count', `${ref}..${main}`], repoDir)) || 0;
    out.push({ build: n, merged, open, behind, owner: owner ?? null });
  }
  return out;
}

/** The summaries per scheme, read again by server.ts's poll (so a header can trail a land by one poll), broadcast on change. */
export class Builds {
  private cache = new Map<number, { list: BuildSummary[]; json: string }>();
  private running = new Map<number, Promise<void>>();
  private d: { store: Store; broadcast: (msg: object) => void };

  constructor(d: { store: Store; broadcast: (msg: object) => void }) {
    this.d = d;
  }

  /** The last summaries read for a scheme, for its page load. */
  get(projectId: number): BuildSummary[] {
    return this.cache.get(projectId)?.list ?? [];
  }

  /** Read a scheme's builds again; one read per scheme at a time, and a call meanwhile joins it. */
  refresh(projectId: number): Promise<void> {
    const busy = this.running.get(projectId);
    if (busy) return busy;
    const next = (async () => {
      const list = await buildSummaries(this.d.store, projectId);
      const json = JSON.stringify(list);
      const was = this.cache.get(projectId)?.json ?? '[]';
      this.cache.set(projectId, { list, json });
      if (json !== was) this.d.broadcast({ type: 'builds', projectId, builds: list });
    })().finally(() => this.running.delete(projectId));
    this.running.set(projectId, next);
    return next;
  }

  /** Every scheme with a repo: main moves under a build with every land. */
  async poll() {
    for (const p of this.d.store.listProjects()) if (p.repo_dir) await this.refresh(p.id).catch(() => {});
  }
}
