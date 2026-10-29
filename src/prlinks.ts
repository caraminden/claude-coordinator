// Which minion owns each pull request, so a PR link in chat can open that minion instead of GitHub.
// A PR belongs to the minion whose branch is its head branch; one gh call lists a repo's PRs.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project, Ticket } from './db.ts';

const run = promisify(execFile);

// PRs are listed at most this often per repo; a new one shows up on the next look.
const TTL_MS = 5 * 60_000;

/** "owner/name" (lowercase) of a GitHub repo URL, https or git@; null for anything else. */
export function repoSlug(repoUrl: string | null): string | null {
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(repoUrl ?? '');
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

export interface Owner { id: number; number: number; title: string }

/** PR number → the minion whose branch it was opened from. */
export function owners(prs: { number: number; headRefName: string }[], tickets: Ticket[]): Record<number, Owner> {
  const byBranch = new Map(tickets.filter((t) => t.kind === 'ticket' && t.branch).map((t) => [t.branch!, t]));
  const out: Record<number, Owner> = {};
  for (const pr of prs) {
    const t = byBranch.get(pr.headRefName);
    if (t) out[pr.number] = { id: t.id, number: t.number, title: t.title };
  }
  return out;
}

async function listPrs(slug: string): Promise<{ number: number; headRefName: string }[] | null> {
  try {
    const { stdout } = await run('gh', ['pr', 'list', '--repo', slug, '--state', 'all', '--limit', '1000', '--json', 'number,headRefName'], { timeout: 20_000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

export interface RepoPrs { projectId: number; scheme: string; repo: string; prs: Record<number, Owner> }

const cache = new Map<string, { at: number; prs: Promise<{ number: number; headRefName: string }[] | null> }>();

/** Each GitHub-backed scheme's PRs that a minion owns. A failed gh call counts as no PRs until the next look. */
export async function prOwners(projects: Project[], ticketsOf: (projectId: number) => Ticket[]): Promise<RepoPrs[]> {
  const out: RepoPrs[] = [];
  for (const p of projects) {
    const repo = repoSlug(p.repo_url);
    if (!repo) continue;
    let hit = cache.get(repo);
    if (!hit || Date.now() - hit.at > TTL_MS) cache.set(repo, (hit = { at: Date.now(), prs: listPrs(repo) }));
    out.push({ projectId: p.id, scheme: p.name, repo, prs: owners((await hit.prs) ?? [], ticketsOf(p.id)) });
  }
  return out;
}
