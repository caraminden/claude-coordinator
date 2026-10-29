// Wakes a ticket when something happens on its GitHub pull request: CI finishes, someone reviews or
// comments, or the PR is merged or closed. Polls with one GraphQL call per ticket through the gh CLI.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store, Ticket } from './db.ts';
import { asData } from './quote.ts';

const run = promisify(execFile);

/** The name GitHub messages are sent under; also reserved as a sign-in name. */
export const GITHUB_NAME = 'GitHub';

// An open PR is looked at this often, backing off while nothing changes; tickets without one (they
// get one during a turn, and every turn's end looks again) and merged or closed PRs rarely.
const OPEN_MS = 2 * 60_000;
const MAX_OPEN_MS = 15 * 60_000;
const NO_PR_MS = 30 * 60_000;
const RATE_LIMITED_MS = 15 * 60_000;
const TICK_MS = 15_000;
// The account's own comments this close to one of the ticket's turns count as the turn's
// (GitHub's clock and ours differ a little, and the turn's last event lands after its last command).
const TURN_MARGIN_MS = 30_000;
const EXCERPT = 200;
// Only people with a say in the repo are forwarded word for word; anyone can comment on a public PR.
const INSIDERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface Check {
  name: string;
  status: 'pending' | 'passed' | 'failed';
  url: string | null;
}

/** Something said on the PR: a conversation comment, a review, or a comment on a line of code. */
export interface Remark {
  key: string;
  kind: 'comment' | 'review' | 'line';
  author: string;
  bot: boolean;
  /** GitHub's authorAssociation: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, … */
  association: string;
  body: string;
  /** Reviews only: APPROVED, CHANGES_REQUESTED, COMMENTED or DISMISSED. */
  state?: string;
  path?: string;
  url: string;
  createdAt: number;
}

/** What one poll saw of a PR. */
export interface PrSnapshot {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headSha: string;
  /** When it was merged or closed, and by whom. */
  closedAt: number | null;
  closedBy: string | null;
  checks: Check[];
  remarks: Remark[];
}

/** The ticket's turns as time spans; `end` is Infinity for a turn still going. */
export type Span = [start: number, end: number];

export interface Decision {
  /** Lines to send the ticket, one per event; empty when nothing new happened. */
  messages: string[];
  /** Keys to record as handled, whether sent or skipped. */
  handled: string[];
}

const ts = (s: string | null | undefined) => (s ? Date.parse(s) : null);
const short = (sha: string) => sha.slice(0, 7);

function excerpt(body: string): string {
  const one = body.replace(/\s+/g, ' ').trim();
  return one.length > EXCERPT ? `${one.slice(0, EXCERPT - 1)}…` : one;
}

function during(spans: Span[], at: number): boolean {
  return spans.some(([start, end]) => at >= start - TURN_MARGIN_MS && at <= end + TURN_MARGIN_MS);
}

/** Where the checks on a head commit stand: failed as soon as any check fails, passed once all finish. */
export function verdict(checks: Check[]): 'pending' | 'passed' | 'failed' | null {
  if (!checks.length) return null;
  if (checks.some((c) => c.status === 'failed')) return 'failed';
  return checks.some((c) => c.status === 'pending') ? 'pending' : 'passed';
}

/**
 * What to tell a ticket about its PR. `seen` holds the keys already handled for this PR; on the
 * first look (`baseline`) everything already there is recorded without being sent. The gh account
 * is the one the ticket's own turns use, so that account's remarks, merges and closes made during
 * one of the ticket's turns (`spans`) are its own doing and are skipped. Bots are skipped too, so a
 * bot that answers every push can't keep a ticket busy. Remarks from outside the repo are only a
 * link, and what insiders wrote is quoted as data.
 */
export function decide(pr: PrSnapshot, seen: Set<string>, opts: { baseline: boolean; self: string | null; spans: Span[] }): Decision {
  const messages: string[] = [];
  const handled: string[] = [];
  const own = (login: string | null, at: number | null) =>
    at !== null && (opts.self === null || login?.toLowerCase() === opts.self.toLowerCase()) && during(opts.spans, at);
  const consider = (key: string, message: () => string | null) => {
    if (seen.has(key)) return;
    handled.push(key);
    seen.add(key);
    const text = opts.baseline ? null : message();
    if (text) messages.push(text);
  };
  if (opts.baseline) handled.push('baseline');

  const result = pr.state === 'OPEN' ? verdict(pr.checks) : null;
  if (result === 'failed' || result === 'passed') {
    consider(`ci:${pr.headSha}:${result}`, () => {
      if (result === 'passed') return `CI passed on ${short(pr.headSha)} in PR #${pr.number} (${pr.checks.length} check${pr.checks.length === 1 ? '' : 's'}).`;
      const failed = pr.checks.filter((c) => c.status === 'failed');
      const pending = pr.checks.filter((c) => c.status === 'pending').length;
      const head = `CI failed on ${short(pr.headSha)} in PR #${pr.number}${pending ? ` (${pending} still running)` : ''} — `;
      return failed.length === 1
        ? `${head}${failed[0].name}: ${failed[0].url ?? pr.url}`
        : `${head}${failed.length} checks:\n${failed.map((c) => `- ${c.name}: ${c.url ?? pr.url}`).join('\n')}`;
    });
  }

  for (const r of [...pr.remarks].sort((a, b) => a.createdAt - b.createdAt)) {
    consider(r.key, () => {
      if (r.bot || own(r.author, r.createdAt)) return null;
      // A review with no text of its own is just the wrapper of line comments, which come separately.
      const silent = r.kind === 'review' && r.state !== 'APPROVED' && r.state !== 'CHANGES_REQUESTED' && !r.body.trim();
      if (silent) return null;
      if (!INSIDERS.has(r.association)) return `Someone outside the repo commented on PR #${pr.number}: ${r.url}`;
      const said = r.body.trim() ? `:\n${asData('GitHub', excerpt(r.body))}` : '';
      if (r.kind === 'line') return `${r.author} commented on ${r.path ?? 'the code'} in PR #${pr.number} ${r.url}${said}`;
      if (r.kind === 'comment') return `${r.author} commented on PR #${pr.number} ${r.url}${said}`;
      if (r.state === 'APPROVED') return `${r.author} approved PR #${pr.number} ${r.url}${said}`;
      if (r.state === 'CHANGES_REQUESTED') return `${r.author} requested changes on PR #${pr.number} ${r.url}${said}`;
      return `${r.author} reviewed PR #${pr.number} ${r.url}${said}`;
    });
  }

  if (pr.state !== 'OPEN') {
    consider(`state:${pr.state}:${pr.closedAt ?? ''}`, () => {
      if (own(pr.closedBy, pr.closedAt)) return null;
      const by = pr.closedBy ? ` by ${pr.closedBy}` : '';
      return pr.state === 'MERGED' ? `PR #${pr.number} was merged${by}.` : `PR #${pr.number} was closed${by} without merging.`;
    });
  }
  return { messages, handled };
}

/** Turn spans from a ticket's start and end markers, oldest first. A start with no end yet runs to `openEnd`. */
export function turnSpans(marks: { at: number; start: boolean }[], openEnd: number): Span[] {
  const spans: Span[] = [];
  let start: number | null = null;
  for (const m of marks) {
    if (m.start) {
      // A turn cut off without an end marker lasted until the next one began.
      if (start !== null) spans.push([start, m.at]);
      start = m.at;
    } else if (start !== null) {
      spans.push([start, m.at]);
      start = null;
    }
  }
  if (start !== null) spans.push([start, openEnd]);
  return spans;
}

/** "owner/name" of a GitHub remote URL (https or ssh), or null for anything else. */
export function githubRepo(remote: string): string | null {
  const m = remote.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

const QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(headRefName: $branch, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number url state headRefOid mergedAt closedAt
        mergedBy { login }
        timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { actor { login } } } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl }
          ... on StatusContext { context state targetUrl }
        } } } } } }
        comments(last: 50) { nodes { databaseId author { login __typename } authorAssociation body createdAt url } }
        reviews(last: 30) { nodes {
          databaseId author { login __typename } authorAssociation body state submittedAt createdAt url
          comments(first: 30) { nodes { databaseId author { login __typename } authorAssociation body path createdAt url } }
        } }
      }
    }
  }
}`;

const PASSED = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'STALE']);

function check(node: any): Check {
  if (node.__typename === 'StatusContext') {
    const s = node.state;
    return { name: node.context, url: node.targetUrl ?? null, status: s === 'SUCCESS' ? 'passed' : s === 'PENDING' || s === 'EXPECTED' ? 'pending' : 'failed' };
  }
  const status = node.status !== 'COMPLETED' ? 'pending' : PASSED.has(node.conclusion) ? 'passed' : 'failed';
  return { name: node.name, url: node.detailsUrl ?? null, status };
}

function remark(kind: Remark['kind'], node: any, extra: Partial<Remark> = {}): Remark {
  return {
    key: `${kind}:${node.databaseId}`,
    kind,
    author: node.author?.login ?? 'ghost',
    bot: node.author?.__typename === 'Bot',
    association: node.authorAssociation ?? 'NONE',
    body: node.body ?? '',
    url: node.url,
    createdAt: ts(node.submittedAt ?? node.createdAt) ?? 0,
    ...extra,
  };
}

/** Turn the GraphQL answer into a snapshot of the branch's newest PR (null if it has none). */
export function parseSnapshot(data: any): { pr: PrSnapshot | null; self: string | null } {
  const self = data?.viewer?.login ?? null;
  const n = data?.repository?.pullRequests?.nodes?.[0];
  if (!n) return { pr: null, self };
  const commit = n.commits?.nodes?.[0]?.commit;
  const remarks: Remark[] = (n.comments?.nodes ?? []).map((c: any) => remark('comment', c));
  for (const r of n.reviews?.nodes ?? []) {
    // A pending review is the reviewer's own draft; it shows up once submitted.
    if (r.state === 'PENDING') continue;
    remarks.push(remark('review', r, { state: r.state }));
    for (const c of r.comments?.nodes ?? []) remarks.push(remark('line', c, { path: c.path }));
  }
  return {
    self,
    pr: {
      number: n.number,
      url: n.url,
      state: n.state,
      headSha: commit?.oid ?? n.headRefOid,
      closedAt: ts(n.mergedAt ?? n.closedAt),
      closedBy: n.mergedBy?.login ?? n.timelineItems?.nodes?.[0]?.actor?.login ?? null,
      checks: (commit?.statusCheckRollup?.contexts?.nodes ?? []).map(check),
      remarks,
    },
  };
}

async function fetchSnapshot(repoDir: string, repo: string, branch: string) {
  const [owner, name] = repo.split('/');
  const { stdout } = await run('gh', [
    'api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `branch=${branch}`,
  ], { cwd: repoDir, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return parseSnapshot(JSON.parse(stdout).data);
}

async function originRepo(repoDir: string): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, timeout: 15_000 });
    return githubRepo(stdout);
  } catch {
    return null;
  }
}

interface Schedule {
  nextAt: number;
  /** How long to wait after a poll that changed nothing; doubles up to MAX_OPEN_MS. */
  wait: number;
  /** What the last poll saw, to tell whether anything changed. */
  last: string;
}

/** Polls the open PRs of a project's tickets, one gh call at a time, and sends what's new into each ticket. */
export class GithubWatcher {
  private store: Store;
  private send: (ticketId: number, text: string) => void;
  private fetch: typeof fetchSnapshot;
  private schedule = new Map<number, Schedule>();
  private repos = new Map<number, Promise<string | null>>();
  private pausedUntil = 0;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(store: Store, send: (ticketId: number, text: string) => void, fetch = fetchSnapshot) {
    this.store = store;
    this.send = send;
    this.fetch = fetch;
  }

  start() {
    this.timer ??= setInterval(() => this.tick().catch((err) => console.error('GitHub poll failed:', err)), TICK_MS);
    this.timer.unref();
  }

  /** Look at a ticket's PR soon, at the open-PR pace: its turn just ended and may have pushed or opened one. */
  poke(ticketId: number) {
    const s = this.schedule.get(ticketId);
    if (s) {
      s.nextAt = Math.min(s.nextAt, Date.now() + TICK_MS);
      s.wait = OPEN_MS;
    }
  }

  /** Tickets worth watching: open threads on a branch of a cloned repo. */
  private watched(): { ticket: Ticket; repoDir: string }[] {
    const out = [];
    for (const p of this.store.listProjects()) {
      if (!p.repo_dir) continue;
      for (const t of this.store.listTickets(p.id)) {
        if (t.kind === 'ticket' && t.status !== 'closed' && t.branch) out.push({ ticket: t, repoDir: p.repo_dir });
      }
    }
    return out;
  }

  async tick() {
    if (this.busy || Date.now() < this.pausedUntil) return;
    this.busy = true;
    try {
      const watched = this.watched();
      const ids = new Set(watched.map((w) => w.ticket.id));
      for (const id of this.schedule.keys()) if (!ids.has(id)) this.schedule.delete(id);
      for (const { ticket, repoDir } of watched) {
        const s = this.schedule.get(ticket.id);
        if (s && Date.now() < s.nextAt) continue;
        if (!this.repos.has(ticket.project_id)) this.repos.set(ticket.project_id, originRepo(repoDir));
        const repo = await this.repos.get(ticket.project_id);
        if (!repo) {
          this.schedule.set(ticket.id, { nextAt: Date.now() + NO_PR_MS, wait: OPEN_MS, last: '' });
          continue;
        }
        try {
          await this.poll(ticket, repoDir, repo);
        } catch (err: any) {
          const text = `${err.stderr ?? ''} ${err.message ?? ''}`;
          if (/rate limit/i.test(text)) {
            this.pausedUntil = Date.now() + RATE_LIMITED_MS;
            console.error('GitHub rate limit reached; pausing PR polling.');
            return;
          }
          console.error(`GitHub poll of ticket ${ticket.id} failed:`, err.message);
          this.schedule.set(ticket.id, { nextAt: Date.now() + MAX_OPEN_MS, wait: OPEN_MS, last: s?.last ?? '' });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async poll(ticket: Ticket, repoDir: string, repo: string) {
    const prev = this.schedule.get(ticket.id);
    const { pr, self } = await this.fetch(repoDir, repo, ticket.branch!);
    if (!pr) {
      this.schedule.set(ticket.id, { nextAt: Date.now() + NO_PR_MS, wait: OPEN_MS, last: '' });
      return;
    }
    // Keys are per PR, so a branch's second PR starts from its own first look.
    const prefix = `pr${pr.number}:`;
    const seen = new Set(this.store.githubSeen(ticket.id, prefix));
    const baseline = !seen.has('baseline');
    let spans: Span[] = [];
    if (!baseline) {
      // Only the account's own new remarks need the ticket's turns.
      const times = [...pr.remarks.filter((r) => !seen.has(r.key)).map((r) => r.createdAt), ...(pr.closedAt ? [pr.closedAt] : [])];
      if (times.length) {
        // A turn with no end marker is running, or was cut off in a way that left none; either way
        // the account's remarks after it are taken as its own until the next turn starts.
        spans = turnSpans(this.store.turnMarks(ticket.id, Math.min(...times) - 24 * 3600_000), Infinity);
      }
    }
    const { messages, handled } = decide(pr, seen, { baseline, self, spans });
    // Recorded before sending, so a crash in between drops a message rather than repeating it forever.
    if (handled.length) this.store.addGithubSeen(ticket.id, handled.map((k) => prefix + k), messages.length > 0);
    if (messages.length) this.send(ticket.id, messages.join('\n\n'));

    const open = pr.state === 'OPEN';
    const last = JSON.stringify([pr.state, pr.headSha, pr.checks.map((c) => c.status), pr.remarks.length]);
    const changed = !prev || prev.last !== last;
    const pending = verdict(pr.checks) === 'pending';
    const wait = !open ? NO_PR_MS : changed || pending ? OPEN_MS : Math.min((prev?.wait ?? OPEN_MS) * 2, MAX_OPEN_MS);
    this.schedule.set(ticket.id, { nextAt: Date.now() + wait, wait, last });
  }
}
