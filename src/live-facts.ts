// Live facts (#1113): one minion's state, open cards, what it is parked on, branch and head, its newest CI run and
// whether its change is live, read in one call (the live_facts tool), so a Taskmaster or minion checks before it
// states them instead of answering from memory (Citadel-wide rule "Verify live state"). 26 replies were struck in the
// week to 2026-11-19, most of them a Taskmaster stating another minion's, CI's or a deploy's state from memory.
// liveFacts() is the query and factsText() its words: the Taskmaster's handoff fallback reuses both.
import { cardText, type CardLink } from './card-links.ts';
import { ghGet, type GhGet } from './gh-api.ts';
import { schemeGithub } from './github-link.ts';
import type { App } from './http.ts';
import { pacific } from './pacific.ts';
import { repoSlug } from './prlinks.ts';
import type { GithubEnv } from './scheme-repo.ts';

/** A minion's newest GitHub Actions run, on its branch (a PR's) or on land/<branch> (tools/land.sh's CI gate). */
export interface CiRun {
  workflow: string;
  branch: string;
  /** Short. */
  sha: string;
  /** queued, in_progress or completed. */
  status: string;
  /** success, failure, cancelled, skipped…; null until it completes. */
  conclusion: string | null;
  url: string;
  /** When it started, ms. */
  at: number;
  /** The run is on the branch's newest commit (true), an older one (false), or can't tell (null: a land/ run is on the branch rebased onto main). */
  onHead: boolean | null;
}

export interface Facts {
  number: number;
  title: string;
  scheme: string;
  /** running, idle, closed… and the label state (ready, parked…), as the minions list shows them. */
  status: string;
  state: string | null;
  note: string | null;
  /** What wakes it by itself while parked (a chain, wake_when_live, runners back), or null. */
  parkedOn: string | null;
  cards: CardLink[];
  /** What it waits on right now (the land line, its landing, a heavy slot, a PR's CI run), in words. */
  waiting: string | null;
  branch: string | null;
  /** The branch's newest commit, short. */
  head: string | null;
  /** Where its change is: on its branch, in a build, on main, deploying, live, a failed deploy. */
  ship: { stage: string; text: string } | null;
  /** Its branch could be read just now. */
  branchRead: boolean;
  pr: { number: number; state: string; url: string } | null;
  /** Its newest CI run, null when none was found, or why it couldn't be read. */
  ci: CiRun | null | { error: string };
}

/** The newest run on any of `branches` in `slug`, or null. */
export async function newestRun(get: GhGet, slug: string, as: GithubEnv, branches: string[], tip: string | null): Promise<CiRun | null> {
  const found = await Promise.all(branches.map(async (b) => {
    const r = await get(`/repos/${slug}/actions/runs?branch=${encodeURIComponent(b)}&per_page=1`, null, as);
    if (r.status !== 200) throw new Error(`GitHub answered ${r.status}`);
    return r.body?.workflow_runs?.[0] ?? null;
  }));
  const run = found.filter(Boolean).sort((a, b) => Date.parse(b.run_started_at ?? b.created_at) - Date.parse(a.run_started_at ?? a.created_at))[0];
  if (!run) return null;
  return {
    workflow: String(run.name ?? run.path ?? 'CI'),
    branch: String(run.head_branch ?? ''),
    sha: String(run.head_sha ?? '').slice(0, 8),
    status: String(run.status ?? ''),
    conclusion: run.conclusion ?? null,
    url: String(run.html_url ?? ''),
    at: Date.parse(run.run_started_at ?? run.created_at),
    // A land run is on the branch rebased onto main, so its commit never matches the head: say so rather than guess.
    onHead: String(run.head_branch ?? '').startsWith('land/') ? null : !!tip && String(run.head_sha ?? '').startsWith(tip),
  };
}

/** One minion's live facts, read now: its branch is looked at afresh and GitHub asked for its newest run. */
export async function liveFacts(app: App, ticketId: number, get: GhGet = ghGet): Promise<Facts> {
  const { store, runner } = app;
  const status = await app.ticketBranch(ticketId).catch(() => null);
  const t = store.getTicket(ticketId);
  if (!t) throw new Error(`No minion ${ticketId}`);
  const v = runner.view(t);
  const project = store.getProject(t.project_id);
  const slug = repoSlug(project?.repo_url ?? null);
  let ci: Facts['ci'] = null;
  if (t.branch && slug && project?.repo_dir) {
    try {
      ci = await newestRun(get, slug, schemeGithub(store, app.github, project.repo_dir, app.dataDir), [t.branch, `land/${t.branch}`], status?.tip.slice(0, 8) ?? null);
    } catch (err: any) {
      ci = { error: String(err?.message ?? err).split('\n')[0].slice(0, 120) };
    }
  } else if (t.branch) ci = { error: 'its scheme has no GitHub repo' };
  return {
    number: t.number ?? 0,
    title: t.title,
    scheme: project?.name ?? '',
    status: t.status,
    state: t.state ?? null,
    note: t.note ?? null,
    parkedOn: v.wakes_on ?? v.parked_for ?? null,
    cards: v.open_cards ?? [],
    waiting: v.wait ? v.wait.text : null,
    branch: t.branch ?? null,
    head: status?.tip.slice(0, 8) ?? null,
    ship: v.ship ? { stage: v.ship.stage, text: v.ship.text } : null,
    branchRead: !!status,
    pr: status?.pr ? { number: status.pr.number, state: status.pr.state, url: status.pr.url } : null,
    ci,
  };
}

const ciText = (ci: Facts['ci']): string => {
  if (!ci) return 'none found on its branch or land/ branch';
  if ('error' in ci) return `couldn't read (${ci.error})`;
  const result = ci.status === 'completed' ? ci.conclusion ?? 'done' : ci.status.replace('_', ' ');
  return `${ci.workflow} on ${ci.branch} @ ${ci.sha}: ${result}, started ${pacific(ci.at)}${ci.onHead === null ? ' (a ship run: the branch rebased onto main, so it may predate a newer commit)' : ci.onHead ? '' : ' (an older commit than its head)'} ${ci.url}`;
};

/** The facts as a few short lines, for the live_facts tool. */
export function factsText(f: Facts): string {
  return [
    `#${f.number} ${f.title} (scheme ${f.scheme})`,
    `status: ${f.status}${f.state ? `, ${f.state}` : ''}${f.note ? ` · note: ${f.note}` : ''}`,
    f.parkedOn ? `parked on: ${f.parkedOn}` : f.state === 'parked' ? 'parked on: nothing wakes it by itself (only a message or Unpark)' : '',
    f.cards.length ? f.cards.map((c) => `waiting on people: ${cardText(c)}`).join('\n') : 'cards waiting on people: none',
    f.waiting ? `waiting now: ${f.waiting}` : '',
    f.branch ? `branch: ${f.branch}${f.head ? ` @ ${f.head}` : ''}` : 'branch: none',
    `change: ${f.ship ? f.ship.text : !f.branch ? 'none: it has no branch' : f.branchRead ? 'nothing committed on its branch' : "couldn't read its branch"}`,
    f.pr ? `PR #${f.pr.number}: ${f.pr.state.toLowerCase()} ${f.pr.url}` : '',
    f.branch ? `newest CI run: ${ciText(f.ci)}` : '',
  ].filter(Boolean).join('\n');
}
