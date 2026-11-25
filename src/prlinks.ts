// Which minion owns each pull request, so a PR link in chat can open that minion instead of GitHub.
// A PR belongs to the minion whose branch is its head branch, or failing that minion N of a
// "ticket/N-…" head (a minion that pushed from a second branch). One gh call lists a repo's PRs,
// and one its issues, so a "#N" that is no minion can still link the PR or issue on GitHub.
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

export interface Owner {
  id: number;
  number: number;
  title: string;
}

/** PR number → the minion whose branch it was opened from. */
export function owners(prs: { number: number; headRefName: string }[], tickets: Ticket[]): Record<number, Owner> {
  const minions = tickets.filter((t) => t.kind === 'ticket');
  const byBranch = new Map(minions.filter((t) => t.branch).map((t) => [t.branch!, t]));
  const byNumber = new Map(minions.map((t) => [t.number, t]));
  const out: Record<number, Owner> = {};
  for (const pr of prs) {
    const n = /^ticket\/(\d+)-/.exec(pr.headRefName)?.[1];
    const t = byBranch.get(pr.headRefName) ?? (n ? byNumber.get(Number(n)) : undefined);
    if (t) out[pr.number] = { id: t.id, number: t.number!, title: t.title };
  }
  return out;
}

/** A repo's PRs or issues (`kind`), newest 1000; null if gh fails. */
async function list<T>(kind: 'pr' | 'issue', slug: string, fields: string): Promise<T[] | null> {
  try {
    const { stdout } = await run('gh', [kind, 'list', '--repo', slug, '--state', 'all', '--limit', '1000', '--json', fields], { timeout: 20_000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** `prs`: the PRs a minion owns; `pulls` and `issues`: every PR and issue number in the repo. */
export interface RepoPrs {
  projectId: number;
  scheme: string;
  repo: string;
  prs: Record<number, Owner>;
  pulls: number[];
  issues: number[];
}

type Listed = { prs: { number: number; headRefName: string }[] | null; issues: { number: number }[] | null };
// `value` is the last good lists, `fetching` the one ask in flight for the repo.
const cache = new Map<string, { at: number; value?: Listed; fetching?: Promise<Listed> }>();

/** Asks GitHub for a repo; a failed call keeps the last good list. */
function refresh(repo: string, now: number): Promise<Listed> {
  const hit = cache.get(repo) ?? { at: now };
  cache.set(repo, hit);
  hit.fetching ??= Promise.all([list<{ number: number; headRefName: string }>('pr', repo, 'number,headRefName'), list<{ number: number }>('issue', repo, 'number')])
    .then(([prs, issues]) => {
      hit.value = { prs: prs ?? hit.value?.prs ?? null, issues: issues ?? hit.value?.issues ?? null };
      hit.at = now;
      return hit.value;
    })
    .finally(() => {
      hit.fetching = undefined;
    });
  return hit.fetching;
}

/** A repo's lists: the saved copy at once (a stale one re-asked behind it), or the first ask's answer when there is none. */
function lists(repo: string, now: number): Promise<Listed> {
  const hit = cache.get(repo);
  if (!hit?.value) return hit?.fetching ?? refresh(repo, now);
  if (now - hit.at > TTL_MS) void refresh(repo, now);
  return Promise.resolve(hit.value);
}

/** Each GitHub-backed scheme's PRs and issues, and which PRs a minion owns. Every repo is asked at once; a stale copy answers while GitHub is re-asked. */
export async function prOwners(projects: Project[], ticketsOf: (projectId: number) => Ticket[], now: () => number = Date.now): Promise<RepoPrs[]> {
  const asked = projects.flatMap((p) => {
    const repo = repoSlug(p.repo_url);
    return repo ? [{ p, repo, got: lists(repo, now()) }] : [];
  });
  return Promise.all(
    asked.map(async ({ p, repo, got }) => {
      const { prs, issues } = await got;
      return { projectId: p.id, scheme: p.name, repo, prs: owners(prs ?? [], ticketsOf(p.id)), pulls: (prs ?? []).map((x) => x.number), issues: (issues ?? []).map((x) => x.number) };
    }),
  );
}
