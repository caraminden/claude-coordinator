// Self-hosted CI runners for every scheme (#320; Josh, 2026-11-05: "we should set up a single CI setup that
// all schemes can use"). GitHub refuses hosted Actions jobs on the caraminden account, so each scheme's repo
// gets its own runner instance on Cara's desktop, installed by tools/ci-runner/add-runner.ps1. That script
// needs a runner registration token, which only a repo admin can mint, so Citadel mints it with the scheme
// owner's linked GitHub login and hands back just the token: it lasts about an hour and is never stored.
// The caller is a machine's agent key (the Machines page), the same credential that PC already uses.
import { lendsMachine } from './access.ts';
import type { Machine, Project, Store } from './db.ts';
import type { GithubLink } from './github-link.ts';
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
 * in the scheme (an admin is in all of them). An ownerless one: if it is lent to that scheme (lendsMachine).
 * The token lets a PC run the repo's CI jobs, which a member can already do by pushing a workflow.
 */
export function mayFetch(store: Store, machine: Machine, project: Project): boolean {
  if (machine.owner_id === null) return lendsMachine(store, machine, project);
  const owner = store.getUser(machine.owner_id);
  return !!owner && !owner.disabled_at && store.canSee({ uid: owner.id, admin: !!owner.admin }, project.id);
}

export class RunnerTokens {
  private store: Store;
  private link: GithubLink;
  private fetch: Fetch;
  /** False in a boot check or preview: they run on a copy of the data and must not reach GitHub. */
  private live: boolean;
  /** Told after each token handed out, for a note in the scheme Taskmaster's chat. */
  onFetched: (project: Project, words: string) => void = () => {};

  constructor(store: Store, link: GithubLink, live: boolean, fetch: Fetch = globalThis.fetch) {
    this.store = store;
    this.link = link;
    this.live = live;
    this.fetch = fetch;
  }

  /**
   * Mint a registration token for `schemeRef`'s repo as its owner, for `machine`'s installer; with `mint` false, only
   * the repo and label, after the same checks, asking GitHub nothing. Throws an HttpError saying why not.
   */
  async issue(machine: Machine, schemeRef: unknown, mint = true): Promise<RunnerToken> {
    if (!this.live) throw new HttpError(403, 'A boot check or preview never asks GitHub for runner tokens');
    const project = findScheme(this.store, schemeRef);
    // A scheme this machine can't act for looks the same as one that doesn't exist.
    if (!project || !mayFetch(this.store, machine, project)) throw new HttpError(404, `No scheme "${String(schemeRef ?? '')}" that machine ${machine.name} may fetch a runner token for`);
    const slug = repoSlug(project.repo_url);
    if (!slug) throw new HttpError(409, `${project.name} has no GitHub repo, so it has nothing to register a runner with; set its repo in the scheme's settings first.`);
    const owner = this.store.getUser(project.owner_id ?? -1);
    if (!this.link.configured) throw new HttpError(409, 'Citadel has no GitHub OAuth App set up, so it holds no one\'s GitHub login to ask with.');
    const ownerToken = owner ? this.link.token(owner) : null;
    if (!ownerToken) throw new HttpError(409, `${owner?.name ?? 'The scheme\'s owner'} (who owns ${project.name}) hasn't linked a working GitHub in Settings → Your account, so Citadel can't ask GitHub for a runner token for ${slug}.`);
    const label = runnerLabel(project.name);
    if (!label) throw new HttpError(409, `${project.name}'s name has no letters a-z or digits to make a runner label from; rename the scheme first.`);
    // Two schemes with one label would share runs-on, and one's jobs could run on the other's runner.
    const twin = this.store.listProjects().find((p) => p.id !== project.id && runnerLabel(p.name) === label);
    if (twin) throw new HttpError(409, `${project.name} and ${twin.name} would share the runner label ${label}; rename one first.`);
    if (!mint) return { scheme: project.name, repo: slug, label, token: null, expires_at: null };
    let r: Response;
    try {
      r = await this.fetch(`${API}/repos/${slug}/actions/runners/registration-token`, {
        method: 'POST', signal: AbortSignal.timeout(GITHUB_WAIT_MS),
        headers: { Authorization: `Bearer ${ownerToken.secret}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Citadel' },
      });
    } catch (err: any) {
      throw new HttpError(502, `Couldn't reach GitHub (${err?.message ?? err}); try again.`);
    }
    if (r.status !== 201) throw new HttpError(502, await refused(r, owner!.name, slug));
    const body = (await r.json().catch(() => ({}))) as { token?: unknown; expires_at?: unknown };
    if (typeof body.token !== 'string' || !body.token) throw new HttpError(502, `GitHub answered ${r.status} without a token`);
    const expires = typeof body.expires_at === 'string' ? body.expires_at : '';
    this.onFetched(project, `Machine ${machine.name} fetched a CI runner registration token for ${slug} (label ${label}), made with ${owner!.name}'s GitHub login${expires ? `; it runs out at ${expires}` : ''}. Citadel didn't keep it.`);
    return { scheme: project.name, repo: slug, label, token: body.token, expires_at: expires || null };
  }
}

/** Why GitHub wouldn't mint the token: a dead link, a missing scope, or a login that isn't the repo's admin. */
async function refused(r: Response, ownerName: string, slug: string): Promise<string> {
  const body = (await r.json().catch(() => null)) as { message?: string } | null;
  const said = body?.message ? `GitHub said "${body.message}" (${r.status})` : `GitHub answered ${r.status}`;
  if (r.status === 401) return `${ownerName}'s GitHub link stopped working; they link it again in Settings → Your account. (${said})`;
  const scopes = r.headers.get('x-oauth-scopes');
  if (scopes !== null && !scopes.split(/[ ,]+/).includes('repo')) return `${ownerName}'s GitHub link lacks the repo permission, which runner tokens need; they link it again in Settings → Your account. (${said})`;
  // GitHub answers 404 (or 403) when the login isn't an admin of the repo: registering runners needs admin.
  if (r.status === 403 || r.status === 404) return `${ownerName}'s GitHub login isn't an admin of ${slug} (or the repo is gone or renamed), and registering a runner needs admin on the repo. (${said})`;
  return said;
}
