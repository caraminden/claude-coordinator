// A reader per kind of found target (#627, src/release-targets.ts finds them), each filling src/releases.ts's shape.
// read() answers from what refresh() last read (git, files, GitHub), so the 2-second poll costs nothing.
import type { DeployView } from './app-services.ts';
import type { ContraptionDeployRow, ContraptionRow, Project, Store } from './db.ts';
import { git, landedIn, type Change, type Next, type Progress, type Reader, type Release, type TargetView } from './releases.ts';
import type { Found, TargetFinder } from './release-targets.ts';
import { repoSlug } from './prlinks.ts';
import { median } from './waits.ts';

const RECENT = 5;
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** A whole next release from its lead's progress: the track's stages with their usual times, and when it should be live. */
export function nextOf(track: string[], usual: (stage: string) => number | null, lead: Progress, changes: Change[]): Next {
  const stages = track.map((name) => ({ name, usual: name === 'live' ? 0 : usual(name) }));
  const after = stages.slice(track.indexOf(lead.stage) + 1);
  const eta = lead.waitingOn || lead.usual == null || after.some((s) => s.usual == null)
    ? null : lead.since + (lead.usual + after.reduce((sum, s) => sum + s.usual!, 0)) * 1000;
  return { ...lead, stages, eta, changes };
}

/** Each stage's length in s, from when each began (ms) up to the next one, the last up to `end`. */
export function lengths(starts: Record<string, number>, end: number): Record<string, number> {
  const seen = Object.entries(starts).sort((a, b) => a[1] - b[1]);
  return Object.fromEntries(seen.map(([s, at], i) => [s, Math.max(0, Math.round(((seen[i + 1]?.[1] ?? end) - at) / 1000))]));
}

/** The median of each stage's length over the newest RECENT rows that went live. */
export function usualOf(rows: { stages: string }[]): (stage: string) => number | null {
  const all = rows.slice(0, RECENT).map((r) => JSON.parse(r.stages) as Record<string, number>);
  return (stage) => median(all.flatMap((s) => (typeof s[stage] === 'number' ? [s[stage]] : [])));
}

/** The target as served: the finder's own fields stay here. */
export const targetOf = (t: Found) => ({ id: t.id, projectId: t.projectId, name: t.name, kind: t.kind, link: t.link });

const commitLink = (slug: string | null, sha: string) => (slug ? `https://github.com/${slug}/commit/${sha}` : null);

/** A contraption's stages: main waits for someone to call deploy_contraption, then the deploy's own steps. */
export const CONTRAPTION_TRACK = ['call', 'build', 'drain', 'restart', 'live'];

interface AppState {
  /** The commit checked out in its folder. */
  deployed: string | null;
  /** Commits on the repo's branch not deployed (null: not known), the oldest's time, and the minions in them. */
  ahead: number | null;
  oldest: number | null;
  changes: { ticketId: number; number: number | null; title: string }[];
}

export interface ContraptionDeps {
  store: Store;
  finder: Pick<TargetFinder, 'list'>;
  /** Where its repo is checked out. */
  folder: (row: ContraptionRow) => string;
  /** Its deploy running now. */
  running: (name: string) => DeployView | null;
  now?: () => number;
}

/**
 * A contraption (deploy_contraption): a release is the commit checked out in its folder, recorded per deploy in
 * contraption_deploys. Its next release is its scheme's main ahead of that, which waits on a deploy call until someone
 * makes one, then follows the deploy's stages.
 */
export class ContraptionReader implements Reader {
  private d: ContraptionDeps;
  private state = new Map<string, AppState>();
  constructor(d: ContraptionDeps) {
    this.d = d;
  }

  /** The scheme whose clone has the contraption's repo, so main's commits and minions can be read there. */
  private scheme(t: Found, row: ContraptionRow): Project | null {
    const p = this.d.store.getProject(t.projectId);
    return p?.repo_dir && row.repo && repoSlug(p.repo_url) === row.repo.toLowerCase() ? p : null;
  }

  async refresh() {
    const next = new Map<string, AppState>();
    for (const t of this.d.finder.list('contraption')) {
      const row = this.d.store.getContraption(t.contraption!);
      if (!row) continue;
      const deployed = (await git(['rev-parse', 'HEAD'], this.d.folder(row)))?.trim() || null;
      const s: AppState = { deployed, ahead: null, oldest: null, changes: [] };
      const p = this.scheme(t, row);
      const main = p && (await git(['rev-parse', '--verify', '--quiet', `${row.branch ?? t.branch}^{commit}`], p.repo_dir!))?.trim();
      if (p && deployed && main) {
        const landed = deployed === main ? { commits: new Map(), tickets: [] } : await landedIn(this.d.store, p, deployed, main);
        if (landed) {
          s.ahead = landed.commits.size;
          s.oldest = landed.commits.size ? Math.min(...landed.commits.values()) : null;
          s.changes = landed.tickets.map((x) => ({ ticketId: x.id, number: x.number, title: x.title }));
        }
      }
      next.set(t.id, s);
    }
    this.state = next;
  }

  /** A finished deploy's row: its stage lengths, and the minions whose work it took live. */
  async record(view: DeployView) {
    const { store } = this.d;
    const row = store.getContraption(view.name);
    const t = this.d.finder.list('contraption').find((x) => x.contraption === view.name);
    const p = row && t ? this.scheme(t, row) : null;
    const landed = p && view.from && view.to && view.from !== view.to ? await landedIn(store, p, view.from, view.to) : null;
    const end = view.finished_at ?? (this.d.now ?? Date.now)();
    store.addContraptionDeploy({
      name: view.name, from_sha: view.from, to_sha: view.to, by: view.by, started_at: view.started_at, finished_at: end, outcome: view.state,
      stages: JSON.stringify(lengths(view.stages, end)), changes: JSON.stringify((landed?.tickets ?? []).map((x) => ({ ticketId: x.id, number: x.number, title: x.title }))),
    });
  }

  read(): Omit<TargetView, 'testCopies'>[] {
    const out: Omit<TargetView, 'testCopies'>[] = [];
    for (const t of this.d.finder.list('contraption')) {
      const row = this.d.store.getContraption(t.contraption!);
      if (!row) continue;
      const s = this.state.get(t.id);
      const rows = this.d.store.listContraptionDeploys(row.name, RECENT + 1);
      const live = rows.filter((r) => r.outcome === 'deployed');
      const usual = usualOf(live);
      const slug = row.repo;
      const release = (r: ContraptionDeployRow): Release => ({
        version: r.to_sha ?? r.from_sha ?? '', link: r.to_sha ? commitLink(slug, r.to_sha) : null, changes: JSON.parse(r.changes),
        started: r.started_at, live: r.outcome === 'deployed' ? r.finished_at : null, outcome: r.outcome === 'deployed' ? 'live' : r.outcome, stages: JSON.parse(r.stages),
      });
      const version = s?.deployed ?? live[0]?.to_sha ?? null;
      const mine = rows.find((r) => r.outcome === 'deployed' && r.to_sha === version);
      const current: Release | null = mine ? release(mine)
        : version ? { version, link: commitLink(slug, version), changes: [], started: null, live: null, outcome: 'live', stages: {} } : null;
      const recent = rows.filter((r) => r !== mine).slice(0, RECENT).map(release);

      let lead: Progress | null = null;
      const run = this.d.running(row.name);
      if (run) {
        const [stage, since] = Object.entries(run.stages).sort((a, b) => b[1] - a[1])[0] ?? ['build', run.started_at];
        lead = { stage, since, usual: usual(stage), waitingOn: null, text: run.said.at(-1) ?? 'deploying' };
      } else if (s?.ahead) {
        const text = `main is ${plural(s.ahead, 'commit')} ahead, waiting for a deploy call`;
        lead = { stage: 'call', since: s.oldest ?? (this.d.now ?? Date.now)(), usual: null, waitingOn: text, text };
      }
      const changes: Change[] = lead ? (s?.changes ?? []).map((c) => ({ ...c, ...lead })) : [];
      out.push({ target: targetOf(t), current, next: lead ? nextOf(CONTRAPTION_TRACK, usual, lead, changes) : null, line: [], recent });
    }
    return out;
  }
}
