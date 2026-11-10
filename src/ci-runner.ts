// Self-hosted CI runners for every scheme (#320; Josh, 2026-11-05: "we should set up a single CI setup that
// all schemes can use"). GitHub refuses hosted Actions jobs on the caraminden account, so each scheme's repo
// gets its own runner instance on Cara's desktop, installed by tools/ci-runner/add-runner.ps1. That script
// needs a runner registration token, which only a repo admin can mint, so Citadel mints it with the scheme
// owner's linked GitHub login and hands back just the token: it lasts about an hour and is never stored.
// The caller is a machine's agent key (the Machines page), the same credential that PC already uses.
import { adminOwned } from './access.ts';
import type { Machine, Project, Store } from './db.ts';
import type { GithubLink } from './github-link.ts';
import type { MachineRelay } from './machines.ts';
import { HttpError } from './http.ts';
import { repoSlug } from './prlinks.ts';

const API = 'https://api.github.com';
const GITHUB_WAIT_MS = 10_000;

type Fetch = typeof fetch;

/** What the installer gets: the token, when it runs out, and the names its runner takes. Never the owner's login or token. */
export interface RunnerToken {
  scheme: string;
  /** owner/name of the scheme's repo, for config.cmd --url. */
  repo: string;
  /** The runner's label, `<scheme-slug>-ci`, which the workflows' runs-on picks. */
  label: string;
  /** Null when the caller asked for the names only (`mint: false`), so a re-run can check before minting. */
  token: string | null;
  expires_at: string | null;
}

/** A scheme's runner label: its name in lowercase with dashes, then -ci ("Peek Auras" → peek-auras-ci, "Delve" → delve-ci); '' when its name has no a-z or 0-9. */
export function runnerLabel(schemeName: string): string {
  const slug = schemeName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `${slug}-ci` : '';
}

/** The scheme a caller names: its id, its name (any case) or its label's slug. Throws a 409 when that names more than one. */
export function findScheme(store: Store, ref: unknown): Project | undefined {
  if (typeof ref === 'number' || (typeof ref === 'string' && /^\d+$/.test(ref))) return store.getProject(Number(ref));
  if (typeof ref !== 'string' || !ref.trim()) return undefined;
  const want = ref.trim().toLowerCase();
  const label = `${want.replace(/-ci$/, '')}-ci`;
  const found = store.listProjects().filter((p) => p.name.toLowerCase() === want || runnerLabel(p.name) === label);
  if (found.length > 1) throw new HttpError(409, `"${ref}" names more than one scheme (${found.map((p) => `${p.name}, id ${p.id}`).join('; ')}); pass its id instead.`);
  return found[0];
}

/**
 * Whether this machine's key may fetch a runner token for the scheme. A person's own machine: if its owner is
 * in the scheme (an admin is in all of them), whatever its own list of schemes says. An ownerless one: if the
 * scheme is on its list, or, for a CI runner host from before #438 that was never given a list (machines.scoped 0,
 * which nothing else reads now), if an admin owns the scheme, so `ci_runners` keeps working for a new scheme.
 * The token lets a PC run the repo's CI jobs, which a member can already do by pushing a workflow.
 */
export function mayFetch(store: Store, machine: Machine, project: Project): boolean {
  if (machine.owner_id === null) return machine.scoped ? store.machineGranted(machine.id, project.id) : adminOwned(store, project);
  const owner = store.getUser(machine.owner_id);
  return !!owner && !owner.disabled_at && store.canSee({ uid: owner.id, admin: !!owner.admin }, project.id);
}

export class RunnerTokens {
  private store: Store;
  private link: GithubLink;
  private fetch: Fetch;
  /** False in a boot check or preview: they run on a copy of the data and must not reach GitHub. */
  private live: boolean;
  /** Told after each token handed out, for a note in the scheme Taskmaster's chat (or a runner job's, when one asked for it). */
  onFetched: (project: Project, words: string, machine: Machine) => void = () => {};

  constructor(store: Store, link: GithubLink, live: boolean, fetch: Fetch = globalThis.fetch) {
    this.store = store;
    this.link = link;
    this.live = live;
    this.fetch = fetch;
  }

  /**
   * Mint a registration token (or, with kind 'remove', a removal token) for `schemeRef`'s repo as its owner, for `machine`'s
   * installer; with `mint` false, only the repo and label, after the same checks, asking GitHub nothing. Throws an HttpError saying why not.
   */
  async issue(machine: Machine, schemeRef: unknown, mint = true, kind: 'register' | 'remove' = 'register'): Promise<RunnerToken> {
    const project = findScheme(this.store, schemeRef);
    // A scheme this machine can't act for looks the same as one that doesn't exist.
    if (!project || !mayFetch(this.store, machine, project)) throw new HttpError(404, `No scheme "${String(schemeRef ?? '')}" that machine ${machine.name} may fetch a runner token for`);
    const { slug, owner, ownerToken, label, hint } = this.repoOf(project);
    if (!mint) return { scheme: project.name, repo: slug, label, token: null, expires_at: null };
    const r = await this.github(ownerToken, 'POST', `/repos/${slug}/actions/runners/${kind === 'remove' ? 'remove-token' : 'registration-token'}`);
    if (r.status !== 201) throw new HttpError(502, await refused(r, owner.name, slug, hint));
    const body = (await r.json().catch(() => ({}))) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== 'string' || !body.token) throw new HttpError(502, `GitHub answered ${r.status} without a token`);
    const expires = typeof body.expires_at === 'string' ? body.expires_at : '';
    this.onFetched(project, `Machine ${machine.name} fetched a CI runner ${kind === 'remove' ? 'removal' : 'registration'} token for ${slug} (label ${label}), made with ${owner.name}'s GitHub login${expires ? `; it runs out at ${expires}` : ''}. Citadel didn't keep it.`, machine);
    return { scheme: project.name, repo: slug, label, token: body.token, expires_at: expires || null };
  }

  /** The runners GitHub lists for a scheme's repo with its label (#328), asked with the owner's login. */
  async listed(project: Project): Promise<{ name: string; status: string; busy: boolean }[]> {
    const { slug, owner, ownerToken, label, hint } = this.repoOf(project);
    const r = await this.github(ownerToken, 'GET', `/repos/${slug}/actions/runners?per_page=100`);
    if (r.status !== 200) throw new HttpError(502, await refused(r, owner.name, slug, hint));
    const body = (await r.json().catch(() => ({}))) as { runners?: any[] };
    return (Array.isArray(body.runners) ? body.runners : [])
      .filter((x) => Array.isArray(x?.labels) && x.labels.some((l: any) => l?.name === label))
      .map((x) => ({ name: String(x.name), status: String(x.status), busy: x.busy === true }));
  }

  /** The scheme's repo, owner, owner's GitHub token and runner label; throws an HttpError saying what's missing. */
  private repoOf(project: Project) {
    if (!this.live) throw new HttpError(403, 'A boot check or preview never asks GitHub for runner tokens');
    const slug = repoSlug(project.repo_url);
    if (!slug) throw new HttpError(409, `${project.name} has no GitHub repo, so it has nothing to register a runner with; set its repo in the scheme's settings first.`);
    const owner = this.store.getUser(project.owner_id ?? -1);
    if (!this.link.configured) throw new HttpError(409, 'Citadel has no GitHub linking set up, so it holds no one\'s GitHub login to ask with.');
    const ownerToken = owner ? this.link.token(owner) : null;
    if (!owner || !ownerToken) throw new HttpError(409, `${owner?.name ?? 'The scheme\'s owner'} (who owns ${project.name}) hasn't linked a working GitHub in Settings → Your account, so Citadel can't ask GitHub for a runner token for ${slug}.`);
    const label = runnerLabel(project.name);
    if (!label) throw new HttpError(409, `${project.name}'s name has no letters a-z or digits to make a runner label from; rename the scheme first.`);
    // Two schemes with one label would share runs-on, and one's jobs could run on the other's runner.
    const twin = this.store.listProjects().find((p) => p.id !== project.id && runnerLabel(p.name) === label);
    if (twin) throw new HttpError(409, `${project.name} and ${twin.name} would share the runner label ${label}; rename one first.`);
    return { slug, owner, ownerToken: ownerToken.secret, label, hint: this.link.installHint(ownerToken.limited, slug) };
  }

  private async github(token: string, method: string, path: string): Promise<Response> {
    try {
      return await this.fetch(`${API}${path}`, {
        method, signal: AbortSignal.timeout(GITHUB_WAIT_MS),
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Citadel' },
      });
    } catch (err: any) {
      throw new HttpError(502, `Couldn't reach GitHub (${err?.message ?? err}); try again.`);
    }
  }
}

/** Why GitHub wouldn't mint the token: a dead link, a missing scope, or a login that isn't the repo's admin. */
async function refused(r: Response, ownerName: string, slug: string, hint = ''): Promise<string> {
  const body = (await r.json().catch(() => null)) as { message?: string } | null;
  const said = body?.message ? `GitHub said "${body.message}" (${r.status})` : `GitHub answered ${r.status}`;
  if (r.status === 401) return `${ownerName}'s GitHub link stopped working; they link it again in Settings → Your account. (${said})`;
  // A limited link (#464) is refused like a missing repo where the App isn't installed.
  if (hint && (r.status === 403 || r.status === 404)) return `${ownerName}'s GitHub login can't manage runners on ${slug}: registering one needs admin on the repo.${hint} (${said})`;
  // A limited link has no scopes to lack.
  const scopes = r.headers.get('x-oauth-scopes');
  if (!hint && scopes !== null && !scopes.split(/[ ,]+/).includes('repo')) return `${ownerName}'s GitHub link lacks the repo permission, which runner tokens need; they link it again in Settings → Your account. (${said})`;
  // GitHub answers 404 (or 403) when the login isn't an admin of the repo: registering runners needs admin.
  if (r.status === 403 || r.status === 404) return `${ownerName}'s GitHub login isn't an admin of ${slug} (or the repo is gone or renamed), and registering a runner needs admin on the repo. (${said})`;
  return said;
}

// ---------- runner jobs (#328) ----------
// Josh, 2026-11-05: "Citadel installs it itself". A CI runner agent (public/runner-agent.mjs) runs elevated on
// the desktop and does three things for a scheme: add its runners, list what's there, remove its runners. People
// and minions ask for one here. An add or remove ends in one note in the scheme Taskmaster's chat, its output
// collapsed under it; a list notes nothing (Josh, 2026-11-05: "this seems too spammy, can we consolidate these
// messages?"): it changes nothing, and the caller already has its output.

export type RunnerOp = 'add' | 'list' | 'remove';
/** GitHub runs one job per runner, and Josh picked four of them for Peek Auras' builds. */
export const MAX_RUNNERS = 4;
const IDLE_WAIT_MS = 120_000;
const IDLE_POLL_MS = 5_000;
/** The most of a job's output its note keeps; the tool's answer has all of it. */
const NOTE_LINES = 60;

/** A job as people and tools see it: what was asked, by whom, and how it ended (ok null while running). */
export interface RunnerJobView {
  op: RunnerOp;
  count: number | null;
  scheme: string;
  machine: string;
  by: string;
  started_at: number;
  finished_at: number | null;
  ok: boolean | null;
  text: string;
}

type Relay = Pick<MachineRelay, 'runnerMachines' | 'runnerJob'>;

/** A failed job's reason for its one-line note: its output's last line, cut to 160 characters. */
function why(text: string): string {
  const last = text.trim().split('\n').at(-1)!.trim();
  return last.length > 160 ? `${last.slice(0, 159)}…` : last;
}

/** The ask from a route body: an op, and for add a count of 1 to MAX_RUNNERS (default 1). Throws a 400 otherwise. */
export function runnerAsk(body: { op?: unknown; count?: unknown }): { op: RunnerOp; count: number | null } {
  if (body.op !== 'add' && body.op !== 'list' && body.op !== 'remove') throw new HttpError(400, 'op must be add, list or remove');
  if (body.op !== 'add') {
    if (body.count !== undefined && body.count !== null) throw new HttpError(400, 'count goes with add only');
    return { op: body.op, count: null };
  }
  const count = body.count ?? 1;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_RUNNERS) throw new HttpError(400, `count must be a whole number from 1 to ${MAX_RUNNERS}`);
  return { op: 'add', count: count as number };
}

export class RunnerJobs {
  private store: Store;
  private tokens: RunnerTokens;
  private relay: Relay;
  private idleWaitMs: number;
  private pollMs: number;
  /** The running or last job of each scheme, by scheme id. */
  private jobs = new Map<number, { view: RunnerJobView; done: Promise<void> }>();
  /** Machines with a job out: an agent runs one at a time. */
  private busy = new Set<number>();
  /** Told each add's or remove's outcome, for the scheme Taskmaster's chat: one line, and the output to show under it. */
  onNote: (project: Project, words: string, detail: string) => void = () => {};
  /** Token notes a running job's scripts caused, by scheme id, with the job's machine: they go under its note, not beside it. */
  private tokenNotes = new Map<number, { machineId: number; lines: string[] }>();

  constructor(store: Store, tokens: RunnerTokens, relay: Relay, idleWaitMs = IDLE_WAIT_MS, pollMs = IDLE_POLL_MS) {
    this.store = store;
    this.tokens = tokens;
    this.relay = relay;
    this.idleWaitMs = idleWaitMs;
    this.pollMs = pollMs;
  }

  /**
   * Start a job for `project`, asked by person `askerId`, who must be a member (an admin is in every scheme). It runs in the
   * background: wait() follows it. Throws an HttpError when it can't start, before anything reaches the PC.
   */
  async start(project: Project, askerId: number | null, ask: { op: RunnerOp; count: number | null }): Promise<RunnerJobView> {
    const asker = askerId === null ? undefined : this.store.getUser(askerId);
    if (!asker || asker.disabled_at || !this.store.canSee({ uid: asker.id, admin: !!asker.admin }, project.id)) {
      throw new HttpError(403, `Only ${project.name}'s members can change its CI runners, and this ask isn't from one.`);
    }
    const running = this.jobs.get(project.id);
    if (running && running.view.ok === null) throw new HttpError(409, `${project.name} already has a runner job running (${running.view.op}, asked by ${running.view.by}); wait for it.`);
    const machines = this.relay.runnerMachines().filter((m) => mayFetch(this.store, m, project));
    if (!machines.length) throw new HttpError(409, `No CI runner agent that may act for ${project.name} is online. Cara installs it once on her desktop (tools/ci-runner/README.md, "Install the runner agent"); if it is installed, that PC is off or asleep, or an admin hasn't added ${project.name} to it under Settings → Machines.`);
    const machine = machines.find((m) => !this.busy.has(m.id));
    if (!machine) throw new HttpError(409, `The runner agent on ${machines[0].name} is busy with another scheme's job; try again in a few minutes.`);
    // The same checks the PC's scripts meet (a repo, the owner's GitHub link, a label), so a missing one fails here.
    const names = ask.op === 'list' ? null : await this.tokens.issue(machine, project.id, false);
    const view: RunnerJobView = { op: ask.op, count: ask.count, scheme: project.name, machine: machine.name, by: asker.name, started_at: Date.now(), finished_at: null, ok: null, text: '' };
    this.busy.add(machine.id);
    this.tokenNotes.set(project.id, { machineId: machine.id, lines: [] });
    const done = this.run(project, machine, ask, names?.label ?? '', view)
      .catch((err) => Object.assign(view, { ok: false, text: `Citadel failed while following the job: ${err?.message ?? err}`, finished_at: Date.now() }))
      .then(() => this.note(project, view))
      .catch((err) => console.error(`Couldn't note ${project.name}'s runner job:`, err))
      .finally(() => { this.busy.delete(machine.id); this.tokenNotes.delete(project.id); }) as Promise<void>;
    this.jobs.set(project.id, { view, done });
    return { ...view };
  }

  private async run(project: Project, machine: Machine, ask: { op: RunnerOp; count: number | null }, label: string, view: RunnerJobView) {
    const job = ask.op === 'add' ? { op: 'add' as const, scheme: project.id, count: ask.count! } : ask.op === 'remove' ? { op: 'remove' as const, scheme: project.id } : { op: 'list' as const };
    const r = await this.relay.runnerJob(machine.id, job);
    let text = r.output.trim() || '(it printed nothing)';
    let ok = r.ok;
    if (ok && ask.op === 'add') {
      const idle = await this.waitIdle(project, ask.count!);
      ok = idle.ok;
      text += `\n\nOn GitHub (label ${label}): ${idle.text}`;
    }
    Object.assign(view, { ok, text, finished_at: Date.now() });
  }

  /**
   * Take a token note when `machine` is running a job for `project` (its scripts fetch the tokens), so it goes under
   * that job's note instead of beside it; false when no job of theirs is running, and the caller notes it as before.
   */
  absorb(project: Project, machine: Machine, words: string): boolean {
    const held = this.tokenNotes.get(project.id);
    if (!held || held.machineId !== machine.id) return false;
    held.lines.push(words);
    return true;
  }

  /** An add's or remove's one note, when it ends however it ends: who, what, where, how it went; the output goes under it. */
  private note(project: Project, view: RunnerJobView) {
    if (view.op === 'list') return;
    const what = view.op === 'add' ? `${view.count} CI runner${view.count === 1 ? '' : 's'} for ${project.name}` : `${project.name}'s CI runners`;
    const words = view.ok
      ? `✓ ${view.by} ${view.op === 'add' ? 'added' : 'removed'} ${what} on ${view.machine}`
      : `✗ ${view.by} tried to ${view.op} ${what} on ${view.machine}, and it failed: ${why(view.text)}`;
    const lines = view.text.split('\n');
    const kept = lines.length > NOTE_LINES ? [`(${lines.length - NOTE_LINES} earlier lines left out)`, ...lines.slice(-NOTE_LINES)] : lines;
    this.onNote(project, words, [...(this.tokenNotes.get(project.id)?.lines ?? []), ...kept].join('\n'));
  }

  /** Wait until GitHub shows at least `count` of the scheme's runners online and not busy, up to idleWaitMs. */
  private async waitIdle(project: Project, count: number): Promise<{ ok: boolean; text: string }> {
    const end = Date.now() + this.idleWaitMs;
    let last = '';
    for (;;) {
      try {
        const runners = await this.tokens.listed(project);
        const idle = runners.filter((x) => x.status === 'online' && !x.busy).length;
        last = runners.length ? runners.map((x) => `${x.name} ${x.status !== 'online' ? x.status : x.busy ? 'Active' : 'Idle'}`).join(', ') : 'none listed yet';
        if (idle >= count) return { ok: true, text: last };
      } catch (err: any) {
        last = `couldn't ask GitHub: ${err.message}`;
      }
      if (Date.now() >= end) return { ok: false, text: `${last}; fewer than ${count} Idle after ${Math.round(this.idleWaitMs / 1000)}s` };
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  /** The scheme's running or last job, waiting up to `waitMs` for a running one to end; null if it has had none since the server started. */
  async wait(projectId: number, waitMs: number): Promise<RunnerJobView | null> {
    const job = this.jobs.get(projectId);
    if (!job) return null;
    if (job.view.ok === null && waitMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([job.done, new Promise((r) => { timer = setTimeout(r, waitMs); })]);
      clearTimeout(timer);
    }
    return { ...job.view };
  }
}
