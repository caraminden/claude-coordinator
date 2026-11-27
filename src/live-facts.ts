// Live facts (#1113): one minion's state, open cards, what it is sealed on, branch and head, its newest CI run and
// whether its change is live, read in one call (the live_facts tool), so a Taskmaster or minion checks before it
// states them instead of answering from memory (Citadel-wide rule "Verify live state"). 26 replies were struck in the
// week to 2026-11-19, most of them a Taskmaster stating another minion's, CI's or a deploy's state from memory.
// liveFacts() is the query and factsText() its words: the Taskmaster's handoff fallback reuses both.
import { cardText, type CardLink } from './card-links.ts';
import { ghGet, type GhGet } from './gh-api.ts';
import { schemeGithub } from './github-link.ts';
import type { Store, Ticket } from './db.ts';
import type { Runner } from './runner.ts';
import type { App } from './http.ts';
import { pacific } from './pacific.ts';
import { stateWord } from './needs.ts';
import { repoSlug } from './prlinks.ts';
import type { GithubEnv } from './scheme-repo.ts';
import { workerWaitText } from './worker-wait.ts';
import { thrown } from './thrown.ts';

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
  /** running, idle, closed… and the label state (ready, sealed…), as the minions list shows them. */
  status: string;
  state: string | null;
  note: string | null;
  /** What wakes it by itself while sealed (a chain, wake_when_live, runners back), or null. */
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

/** The fields of a GitHub Actions run read here. */
interface GhRun {
  name?: string;
  path?: string;
  head_branch?: string | null;
  head_sha?: string;
  status?: string | null;
  conclusion?: string | null;
  html_url?: string;
  run_started_at?: string;
  created_at: string;
}

/** The newest run on any of `branches` in `slug`, or null. */
export async function newestRun(get: GhGet, slug: string, as: GithubEnv, branches: string[], tip: string | null): Promise<CiRun | null> {
  const found = await Promise.all(
    branches.map(async (b) => {
      const r = await get(`/repos/${slug}/actions/runs?branch=${encodeURIComponent(b)}&per_page=1`, null, as);
      if (r.status !== 200) throw new Error(`GitHub answered ${r.status}`);
      return (r.body as { workflow_runs?: GhRun[] } | null)?.workflow_runs?.[0] ?? null;
    }),
  );
  const run = found.filter((r) => r !== null).sort((a, b) => Date.parse(b.run_started_at ?? b.created_at) - Date.parse(a.run_started_at ?? a.created_at))[0];
  if (!run) return null;
  return {
    workflow: String(run.name ?? run.path ?? 'CI'),
    branch: String(run.head_branch ?? ''),
    sha: String(run.head_sha ?? '').slice(0, 8),
    status: String(run.status ?? ''),
    conclusion: run.conclusion ?? null,
    url: String(run.html_url ?? ''),
    at: Date.parse(run.run_started_at ?? run.created_at),
    // A land run (or a ship's own check, #1567, or a pre-ship run, #2210) is on the branch rebased onto main, so its commit never matches the head: say so rather than guess.
    onHead: /^(land|check|pre)\//.test(String(run.head_branch ?? '')) ? null : !!tip && String(run.head_sha ?? '').startsWith(tip),
  };
}

/** What the database and the runner already know of one minion, no branch or GitHub read: liveFacts' first half and the handoff sheet's lines. */
export function storedFacts(store: Store, runner: Pick<Runner, 'view'>, t: Ticket): Omit<Facts, 'head' | 'branchRead' | 'pr' | 'ci'> {
  const v = runner.view(t);
  return {
    number: t.number ?? 0,
    title: t.title,
    scheme: store.getProject(t.project_id)?.name ?? '',
    status: v.worker_wait ? workerWaitText(v.worker_wait) : v.server_work?.kind === 'job' ? `${t.status}, ${v.server_work.text}` : t.status,
    state: t.state ?? null,
    note: t.note ?? null,
    parkedOn: v.wakes_on ?? v.parked_for ?? null,
    cards: v.open_cards ?? [],
    waiting: v.wait ? v.wait.text : null,
    branch: t.branch ?? null,
    ship: v.ship ? { stage: v.ship.stage, text: v.ship.text } : null,
  };
}

/** One minion's live facts, read now: its branch is looked at afresh and GitHub asked for its newest run. */
export async function liveFacts(app: App, ticketId: number, get: GhGet = ghGet): Promise<Facts> {
  const { store } = app;
  const status = await app.ticketBranch(ticketId).catch(() => null);
  const t = store.getTicket(ticketId);
  if (!t) throw new Error(`No minion ${ticketId}`);
  const project = store.getProject(t.project_id);
  const slug = repoSlug(project?.repo_url ?? null);
  let ci: Facts['ci'] = null;
  if (t.branch && slug && project?.repo_dir) {
    try {
      ci = await newestRun(get, slug, schemeGithub(store, app.github, project.repo_dir, app.dataDir), [t.branch, `land/${t.branch}`, `check/${t.branch}`, `early/${t.branch}`, `pre/${t.branch}`], status?.tip.slice(0, 8) ?? null);
    } catch (err) {
      ci = {
        error: String(thrown(err).message ?? err)
          .split('\n')[0]
          .slice(0, 120),
      };
    }
  } else if (t.branch) ci = { error: 'its scheme has no GitHub repo' };
  return {
    ...storedFacts(store, app.runner, t),
    head: status?.tip.slice(0, 8) ?? null,
    branchRead: !!status,
    pr: status?.pr ? { number: status.pr.number, state: status.pr.state, url: status.pr.url } : null,
    ci,
  };
}

const ciText = (ci: Facts['ci']): string => {
  if (!ci) return 'none found on its branch or land/ branch';
  if ('error' in ci) return `couldn't read (${ci.error})`;
  const result = ci.status === 'completed' ? (ci.conclusion ?? 'done') : ci.status.replace('_', ' ');
  return `${ci.workflow} on ${ci.branch} @ ${ci.sha}: ${result}, started ${pacific(ci.at)}${ci.onHead === null ? ' (a ship run: the branch rebased onto main, so it may predate a newer commit)' : ci.onHead ? '' : ' (an older commit than its head)'} ${ci.url}`;
};

/** The facts as a few short lines, for the live_facts tool. */
export function factsText(f: Facts): string {
  return [
    `#${f.number} ${f.title} (scheme ${f.scheme})`,
    `status: ${f.status}${f.state ? `, ${stateWord(f.state)}` : ''}${f.note ? ` · note: ${f.note}` : ''}`,
    f.parkedOn ? `sealed on: ${f.parkedOn}` : f.state === 'parked' ? 'sealed on: nothing wakes it by itself (only a message or Unseal)' : '',
    f.cards.length ? f.cards.map((c) => `waiting on people: ${cardText(c)}`).join('\n') : 'cards waiting on people: none',
    f.waiting ? `waiting now: ${f.waiting}` : '',
    f.branch ? `branch: ${f.branch}${f.head ? ` @ ${f.head}` : ''}` : 'branch: none',
    `change: ${f.ship ? f.ship.text : !f.branch ? 'none: it has no branch' : f.branchRead ? 'nothing committed on its branch' : "couldn't read its branch"}`,
    f.pr ? `PR #${f.pr.number}: ${f.pr.state.toLowerCase()} ${f.pr.url}` : '',
    f.branch ? `newest CI run: ${ciText(f.ci)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** How the sheet opens when the handoff came back: the prose is the Taskmaster's, the sheet the database's. */
export const SHEET_CHECK = 'Facts sheet built by the server at hand-off from the database: check the handoff above against it, and trust the sheet where they differ.';
/** How the sheet opens when the handoff turn failed, so it is all the new session has. */
export const SHEET_FAILED = "No handoff came back (the handoff turn failed), so this facts sheet was built by the server from the database: check before relying on anything else, and rely on memory and the minions' own records for the rest.";

const SHEET_PEOPLE = 6;
const SHEET_MINIONS = 40;
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A Taskmaster's facts sheet for its fresh session, straight from the database (G6): its scheme's open cards and who
 * they wait on, seals and what wakes each, minions in flight with state and note, ships in progress, and the last few
 * messages from people. Same facts as live_facts (storedFacts), no GitHub read: it runs as a turn ends.
 */
export function handoffSheet(store: Store, runner: Pick<Runner, 'view'>, taskmaster: Ticket): string {
  const mine = store.listTickets(taskmaster.project_id).filter((t) => t.id !== taskmaster.id && t.kind !== 'coordinator' && t.status !== 'closed');
  const rows = mine.map((t) => ({ t, f: storedFacts(store, runner, t) }));
  const line = ({ f }: { f: ReturnType<typeof storedFacts> }) => `- #${f.number} ${cut(f.title, 80)}: ${f.status}${f.state ? `, ${stateWord(f.state)}` : ''}${f.note ? ` · ${cut(f.note, 100)}` : ''}`;
  const cards = rows.flatMap(({ f }) => f.cards.map((c) => `- #${f.number}: ${cardText(c)}`)).slice(0, SHEET_MINIONS);
  const parks = rows.filter(({ f }) => f.state === 'parked').map((r) => `${line(r)} (${r.f.parkedOn ? `wakes on: ${r.f.parkedOn}` : 'nothing wakes it by itself'})`);
  const flight = rows
    .filter(({ f }) => f.status === 'running' || f.status.startsWith('waiting') || (f.state && f.state !== 'parked'))
    .slice(0, SHEET_MINIONS)
    .map(line);
  const ships = rows.filter(({ f }) => f.ship).map(({ f }) => `- #${f.number}: ${f.ship!.text}`);
  const people = store
    .eventsBefore(taskmaster.id, Number.MAX_SAFE_INTEGER, 80)
    .filter((e) => e.kind === 'user_message')
    .map((e) => {
      try {
        return JSON.parse(e.data);
      } catch {
        return null;
      }
    })
    .filter((d) => d && typeof d.text === 'string' && d.author && !d.from && !d.mail && !d.brief && !/^(system|citadel|mandate|#)/i.test(d.author))
    .slice(0, SHEET_PEOPLE)
    .reverse()
    .map((d) => `- ${d.author}: ${cut(d.text.replace(/\s+/g, ' '), 300)}`);
  const part = (head: string, items: string[], none: string) => `${head}\n${items.length ? items.join('\n') : none}`;
  return [part('Open cards waiting on people:', cards, 'none'), part('Sealed minions:', parks, 'none'), part('Minions in flight:', flight, 'none'), part('Ships in progress:', ships, 'none'), part('Last messages from people (newest last):', people, 'none')].join('\n\n');
}
