// Wakes a ticket when something happens on its GitHub pull request: CI finishes, someone reviews or
// comments, or the PR is merged or closed. Polls with one GraphQL call per ticket through the gh CLI.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store, Ticket } from './db.ts';
import { asData } from './quote.ts';
import { asEnv, type GithubEnv } from './scheme-repo.ts';

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
const REPO_MS = 10 * 60_000;
// The account's own comments this close to one of the ticket's turns count as the turn's
// (GitHub's clock and ours differ a little, and the turn's last event lands after its last command).
const TURN_MARGIN_MS = 30_000;
// CI that never starts would leave a minion waiting forever, so it hears once per head commit when none of
// the PR's checks appeared this long after the commit was first seen (a PR that conflicts with its base gets
// no pull_request runs at all), or a check has sat queued for a runner this long.
export const NO_CHECKS_MS = 10 * 60_000;
export const STUCK_MS = 60 * 60_000;
const EXCERPT = 200;
// Only people with a say in the repo are forwarded word for word; anyone can comment on a public PR.
const INSIDERS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export interface Check {
  name: string;
  /** skipped: finished without testing anything (GitHub's SKIPPED, NEUTRAL or STALE). */
  status: 'pending' | 'passed' | 'skipped' | 'failed';
  url: string | null;
  /** An Actions job that failed without starting (no steps ran: a billing block, no runner): GitHub's reason, '' when it gave none. */
  notStarted?: string;
  /** A check run not yet started: waiting for a runner. */
  queued?: true;
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
  /** GitHub's MERGEABLE, CONFLICTING or UNKNOWN (still working it out). */
  mergeable?: string;
  baseRef?: string;
  /** The repo has Actions workflows on its default branch, so a PR with no checks is missing some. */
  hasCi?: boolean;
  /** A draft PR: a repo may run no PR CI on drafts, so no checks there is expected. */
  draft?: boolean;
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

/**
 * Where the checks on a head commit stand: failed as soon as any check fails, passed once all finish. null with no checks,
 * or when all of them skipped: nothing was tested (#558).
 */
export function verdict(checks: Check[]): 'pending' | 'passed' | 'failed' | null {
  if (checks.some((c) => c.status === 'failed')) return 'failed';
  if (checks.some((c) => c.status === 'pending')) return 'pending';
  return checks.some((c) => c.status === 'passed') ? 'passed' : null;
}

/**
 * What to tell a ticket about its PR. `seen` holds the keys already handled for this PR; on the
 * first look (`baseline`) everything already there is recorded without being sent. The accounts in
 * `self` are the ones the ticket's own turns push as (the box's gh login, and its person's linked
 * GitHub), so their remarks, merges and closes made during one of the ticket's turns (`spans`) are its
 * own doing and are skipped. Bots are skipped too, so a
 * bot that answers every push can't keep a ticket busy. Remarks from outside the repo are only a
 * link, and what insiders wrote is quoted as data.
 */
export function decide(
  pr: PrSnapshot,
  seen: Set<string>,
  opts: { baseline: boolean; self: string | string[] | null; spans: Span[]; headFor?: number; stuck?: string[] },
): Decision {
  const selves = opts.self === null ? null : [opts.self].flat().map((s) => s.toLowerCase());
  const messages: string[] = [];
  const handled: string[] = [];
  const own = (login: string | null, at: number | null) =>
    at !== null && (selves === null || selves.includes(login?.toLowerCase() ?? '')) && during(opts.spans, at);
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
      // A job that never started (#368) isn't a red test: say so, with GitHub's reason, so no one hunts a bug for it.
      const dead = failed.every((c) => c.notStarted !== undefined);
      const name = (c: Check) => (c.notStarted === undefined ? c.name : `${c.name} didn't start${c.notStarted ? ` (GitHub says: "${excerpt(c.notStarted)}")` : ''}`);
      const head = `CI ${dead ? "didn't start" : 'failed'} on ${short(pr.headSha)} in PR #${pr.number}${pending ? ` (${pending} still running)` : ''} — `;
      const tail = dead ? `\nNo step ran, so this isn't a test failure.` : '';
      return failed.length === 1
        ? `${head}${name(failed[0])}: ${failed[0].url ?? pr.url}${tail}`
        : `${head}${failed.length} checks:\n${failed.map((c) => `- ${name(c)}: ${c.url ?? pr.url}`).join('\n')}${tail}`;
    });
  }
  // GitHub works out `mergeable` when first asked, so an UNKNOWN waits for the next look rather than leave out the cause.
  // A clean draft is left alone (its key unspent, for when it's marked ready); a conflicting one still hears why (#554).
  const expectNone = pr.draft && pr.mergeable !== 'CONFLICTING';
  // Checks that all skipped (a draft's PR CI) tested nothing, so they count as none yet (#558).
  if (pr.state === 'OPEN' && result === null && pr.hasCi && pr.mergeable !== 'UNKNOWN' && !expectNone && (opts.headFor ?? 0) >= NO_CHECKS_MS) {
    consider(`nochecks:${pr.headSha}`, () => {
      const n = pr.checks.length;
      const head = n
        ? `CI hasn't tested ${short(pr.headSha)} in PR #${pr.number}: ${n === 1 ? 'its check' : `all ${n} checks`} skipped after ${NO_CHECKS_MS / 60_000} minutes`
        : `CI hasn't started on ${short(pr.headSha)} in PR #${pr.number}: no checks after ${NO_CHECKS_MS / 60_000} minutes`;
      if (pr.mergeable === 'CONFLICTING') return `${head}, because the PR conflicts with ${pr.baseRef ?? 'its base'} and GitHub runs no pull_request workflows on a conflicting PR. Rebase onto ${pr.baseRef ?? 'its base'} and push to get CI.`;
      return `${head}. If its workflows skip this change by design, nothing is wrong; otherwise look at ${pr.url}/checks`;
    });
  }
  const stuck = result === 'pending' ? pr.checks.filter((c) => opts.stuck?.includes(c.name)) : [];
  if (stuck.length) {
    consider(`stuck:${pr.headSha}`, () => {
      const names = stuck.map((c) => c.name).join(', ');
      return `CI on ${short(pr.headSha)} in PR #${pr.number} is stuck: ${stuck.length === 1 ? `${names} has` : `${stuck.length} checks (${names}) have`} waited ${STUCK_MS / 60_000} minutes for a runner. That isn't a test failure; you'll still hear when CI finishes.`;
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
    workflows: object(expression: "HEAD:.github/workflows") { __typename }
    pullRequests(headRefName: $branch, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes {
        number url state isDraft headRefOid mergedAt closedAt mergeable baseRefName
        mergedBy { login }
        timelineItems(last: 1, itemTypes: [CLOSED_EVENT]) { nodes { ... on ClosedEvent { actor { login } } } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { contexts(first: 100) { nodes {
          __typename
          ... on CheckRun { name status conclusion detailsUrl steps(first: 1) { totalCount } annotations(first: 1) { nodes { message } } }
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

const SKIPPED = new Set(['NEUTRAL', 'SKIPPED', 'STALE']);

export function check(node: any): Check {
  if (node.__typename === 'StatusContext') {
    const s = node.state;
    return { name: node.context, url: node.targetUrl ?? null, status: s === 'SUCCESS' ? 'passed' : s === 'PENDING' || s === 'EXPECTED' ? 'pending' : 'failed' };
  }
  const status = node.status !== 'COMPLETED' ? 'pending' : node.conclusion === 'SUCCESS' ? 'passed' : SKIPPED.has(node.conclusion) ? 'skipped' : 'failed';
  const out: Check = { name: node.name, url: node.detailsUrl ?? null, status };
  if (node.status === 'QUEUED') out.queued = true;
  // Only Actions jobs list steps; another app's check run has none even when it ran.
  if (node.conclusion === 'FAILURE' && node.steps?.totalCount === 0 && /\/actions\/runs\//.test(node.detailsUrl ?? '')) {
    out.notStarted = String(node.annotations?.nodes?.[0]?.message ?? '').replace(/\s+/g, ' ').trim();
  }
  return out;
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
      mergeable: n.mergeable,
      baseRef: n.baseRefName,
      hasCi: !!data.repository.workflows,
      draft: !!n.isDraft,
    },
  };
}

async function fetchSnapshot(repoDir: string, repo: string, branch: string, as?: GithubEnv) {
  const [owner, name] = repo.split('/');
  const { stdout } = await run('gh', [
    'api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `branch=${branch}`,
  ], { cwd: repoDir, env: asEnv(as), timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return parseSnapshot(JSON.parse(stdout).data);
}

/** "owner/name" of a checkout's GitHub origin, or null. */
export async function originRepo(repoDir: string): Promise<string | null> {
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
  /** The head commit, when this server first saw it, and when each of its checks was first seen queued. */
  head?: { sha: string; at: number; queued: Record<string, number>; draft?: boolean };
}

/** Polls the open PRs of a project's tickets, one gh call at a time, and sends what's new into each ticket. */
export class GithubWatcher {
  private store: Store;
  private send: (ticketId: number, text: string) => void;
  private fetch: typeof fetchSnapshot;
  private schedule = new Map<number, Schedule>();
  /** Each scheme's origin, read again after REPO_MS (scheme-repo.ts may set a new one); a failed read isn't kept. */
  private repos = new Map<number, { at: number; repo: Promise<string | null> }>();
  private pausedUntil = 0;
  private busy = false;
  private timer: NodeJS.Timeout | null = null;
  /** A ticket's PR was seen merged (or already merged at first look): its scheme's main can catch up (#208). */
  onMerged: (repoDir: string) => void = () => {};
  /** The GitHub login a scheme's PRs are read as (#321: its owner's, for a private repo); undefined is the box's. */
  as: (repoDir: string) => GithubEnv = () => undefined;
  /** What each poll saw of a minion's PR (null: none), read as `as`: its CI runs in flight become its wait (#546). */
  onPr: (ticketId: number, repo: string, as: GithubEnv, pr: PrSnapshot | null) => void = () => {};

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
        const known = this.repos.get(ticket.project_id);
        if (!known || Date.now() - known.at >= REPO_MS) this.repos.set(ticket.project_id, { at: Date.now(), repo: originRepo(repoDir) });
        const entry = this.repos.get(ticket.project_id)!;
        const repo = await entry.repo;
        if (!repo) {
          if (this.repos.get(ticket.project_id) === entry) this.repos.delete(ticket.project_id);
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
          this.schedule.set(ticket.id, { nextAt: Date.now() + MAX_OPEN_MS, wait: OPEN_MS, last: s?.last ?? '', head: s?.head });
        }
      }
    } finally {
      this.busy = false;
    }
  }

  async poll(ticket: Ticket, repoDir: string, repo: string) {
    const prev = this.schedule.get(ticket.id);
    const as = this.as(repoDir);
    const { pr, self } = await this.fetch(repoDir, repo, ticket.branch!, as);
    this.onPr(ticket.id, repo, as, pr);
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
    // With GitHub linking, the minion's turns push as its person's own account too.
    // shortcut: only the person of its latest turn, not each turn's; fine while a minion's people rarely change.
    // Read as a person's token (#321: the scheme owner's), the viewer is that person, not the minion.
    const linked = ticket.person_id ? this.store.getCredential(ticket.person_id, 'github') : null;
    const viewer = as ? [] : self ? [self] : [];
    const selves = linked ? [...viewer, (JSON.parse(linked.meta) as { login: string }).login] : as ? [] : self;
    // shortcut: these clocks live in memory, so a restart starts them again; fine for a once-per-commit nudge.
    const now = Date.now();
    const head = prev?.head?.sha === pr.headSha ? prev.head : { sha: pr.headSha, at: now, queued: {} };
    // Marked ready for review: PR CI that skips drafts only starts now, so the no-checks clock does too.
    if (head.draft && !pr.draft) head.at = now;
    head.draft = pr.draft;
    const queued: Record<string, number> = {};
    for (const c of pr.checks) if (c.queued) queued[c.name] = head.queued[c.name] ?? now;
    head.queued = queued;
    const stuck = Object.keys(queued).filter((name) => now - queued[name] >= STUCK_MS);
    const { messages, handled } = decide(pr, seen, { baseline, self: selves, spans, headFor: now - head.at, stuck });
    // Recorded before sending, so a crash in between drops a message rather than repeating it forever.
    if (handled.length) this.store.addGithubSeen(ticket.id, handled.map((k) => prefix + k), messages.length > 0);
    if (messages.length) this.send(ticket.id, messages.join('\n\n'));
    if (pr.state === 'MERGED' && handled.some((k) => k.startsWith('state:'))) this.onMerged(repoDir);

    const open = pr.state === 'OPEN';
    const last = JSON.stringify([pr.state, pr.draft, pr.headSha, pr.checks.map((c) => c.status), pr.remarks.length]);
    const changed = !prev || prev.last !== last;
    const pending = verdict(pr.checks) === 'pending';
    const wait = !open ? NO_PR_MS : changed || pending ? OPEN_MS : Math.min((prev?.wait ?? OPEN_MS) * 2, MAX_OPEN_MS);
    this.schedule.set(ticket.id, { nextAt: Date.now() + wait, wait, last, head });
  }
}
