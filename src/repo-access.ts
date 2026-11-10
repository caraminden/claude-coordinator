// Scheme members get push access to the scheme's GitHub repo (#310; Josh's pick, 2026-11-04: "Auto-invite
// as collaborator"). The server invites a member's linked GitHub login as a collaborator with the scheme
// owner's own token, and accepts the invite with the member's token. Neither token goes into a turn: turns
// still run as their own person's login (src/github-link.ts forTurn). What Citadel did is kept in
// repo_collaborators, so leaving undoes only Citadel's own invites, never a collaborator from before.
import type { RepoCollaborator, Store, User } from './db.ts';
import type { GithubLink } from './github-link.ts';
import { repoSlug } from './prlinks.ts';

const API = 'https://api.github.com';
const GITHUB_WAIT_MS = 10_000;

type Fetch = typeof fetch;

/** What the Members page shows for a member: the row's state, its repo and any error. */
export type MemberGithub = Pick<RepoCollaborator, 'state' | 'slug' | 'error'> | null;

export class RepoAccess {
  private store: Store;
  private link: GithubLink;
  private fetch: Fetch;
  /** False in a boot check or preview: they run on a copy of the data and must not change GitHub. */
  private live: boolean;

  constructor(store: Store, link: GithubLink, live: boolean, fetch: Fetch = globalThis.fetch) {
    this.store = store;
    this.link = link;
    this.live = live;
    this.fetch = fetch;
  }

  private get on() {
    return this.live && this.link.configured;
  }

  private async api(method: string, path: string, token: string, body?: unknown): Promise<Response> {
    return this.fetch(`${API}${path}`, {
      method, signal: AbortSignal.timeout(GITHUB_WAIT_MS),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Citadel', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  /** The Members page's line for `userId` in `projectId`; null when there's nothing to say. */
  view(projectId: number, userId: number): MemberGithub {
    const r = this.store.getRepoCollaborator(projectId, userId);
    return r ? { state: r.state, slug: r.slug, error: r.error } : null;
  }

  /**
   * Give a member push access to their scheme's repo: invite their linked login with the owner's token,
   * then accept with theirs. Safe to call again: it settles to what GitHub says now. Never throws; a
   * failure is kept on the row for the Members page.
   */
  async sync(projectId: number, userId: number): Promise<void> {
    if (!this.on) return;
    const project = this.store.getProject(projectId);
    const slug = repoSlug(project?.repo_url ?? null);
    const member = this.store.getUser(userId);
    if (!project || !slug || !member || project.owner_id === userId) return;
    if (!this.store.listMembers(projectId).some((m) => m.id === userId)) return;
    const prev = this.store.getRepoCollaborator(projectId, userId);
    // shortcut: a scheme pointed at a different repo starts over there and forgets the old one, whose collaborator stays on GitHub; track both if repos ever move.
    if ((prev?.state === 'added' || prev?.state === 'existing') && prev.slug === slug && !prev.error) return;
    const put = (state: RepoCollaborator['state'], fields: Partial<Pick<RepoCollaborator, 'login' | 'invitation_id' | 'error'>> = {}) =>
      this.store.putRepoCollaborator({ project_id: projectId, user_id: userId, slug, login: null, invitation_id: null, error: null, state, ...fields });
    const login = this.link.login(userId)?.login;
    if (!login) return put('waiting');
    const owner = this.store.getUser(project.owner_id ?? -1);
    const ownerToken = owner ? this.link.token(owner) : null;
    if (!ownerToken) {
      return put('failed', { login, error: `${owner?.name ?? 'The scheme\'s owner'} hasn't linked a working GitHub in Settings → Your account, so Citadel can't invite @${login} to ${slug}.` });
    }
    const hint = this.link.installHint(ownerToken.limited, slug);
    const repoOwner = slug.split('/')[0];
    if (login.toLowerCase() === repoOwner || login.toLowerCase() === ownerToken.login.toLowerCase()) return put('existing', { login });
    // Set once GitHub has made the invite, so a failure after it still remembers the invite as Citadel's.
    let invited: number | null = prev?.state === 'invited' ? prev.invitation_id : null;
    try {
      const check = await this.api('GET', `/repos/${slug}/collaborators/${login}`, ownerToken.secret);
      // Already in: a collaborator Citadel invited earlier who has since accepted stays Citadel's, and so does
      // one Citadel added to the scheme's previous repo, which a GitHub transfer carries over (#456).
      const ours = prev?.slug === slug ? prev.state === 'invited' : prev?.state === 'added' || prev?.state === 'invited';
      if (check.status === 204) return put(ours ? 'added' : 'existing', { login });
      if (check.status !== 404) return put('failed', { login, error: await explain(check, ownerToken.login, login, slug, hint) });
      const invite = await this.api('PUT', `/repos/${slug}/collaborators/${login}`, ownerToken.secret, { permission: 'push' });
      if (invite.status === 204) return put('added', { login });
      if (invite.status !== 201) return put('failed', { login, error: await explain(invite, ownerToken.login, login, slug, hint) });
      const id = invited = Number(((await invite.json().catch(() => ({}))) as { id?: number }).id) || null;
      const memberToken = this.link.token(member);
      if (!id || !memberToken || memberToken.login.toLowerCase() !== login.toLowerCase()) return put('invited', { login, invitation_id: id });
      const accept = await this.api('PATCH', `/user/repository_invitations/${id}`, memberToken.secret);
      if (accept.status === 204) return put('added', { login, invitation_id: id });
      return put('invited', { login, invitation_id: id, error: `Citadel couldn't accept the invite for @${login}: ${await githubSays(accept)}` });
    } catch (err: any) {
      return put(invited !== null || prev?.state === 'invited' ? 'invited' : 'failed', { login, invitation_id: invited, error: `Couldn't reach GitHub (${err?.message ?? err}); Citadel tries again at its next restart.` });
    }
  }

  /** Every scheme `userId` is in: after they link GitHub (they get invited), or link as an owner (their members do). */
  async syncPerson(userId: number): Promise<void> {
    if (!this.on) return;
    for (const p of this.store.listProjects()) {
      const members = this.store.listMembers(p.id);
      if (p.owner_id === userId) for (const m of members) if (!m.owner) await this.sync(p.id, m.id);
      if (members.some((m) => m.id === userId && !m.owner)) await this.sync(p.id, userId);
    }
  }

  /**
   * Take a person off a scheme's repo, but only if Citadel put them there. Returns an error to show
   * when GitHub refused; the row stays then, so the next sweep tries again.
   */
  async remove(projectId: number, userId: number): Promise<string | null> {
    const r = this.store.getRepoCollaborator(projectId, userId);
    if (!r) return null;
    if (r.state !== 'added' && r.state !== 'invited') {
      this.store.deleteRepoCollaborator(projectId, userId);
      return null;
    }
    if (!this.on) return null;
    const project = this.store.getProject(projectId);
    const owner = this.store.getUser(project?.owner_id ?? -1);
    const ownerToken = owner ? this.link.token(owner) : null;
    const fail = (error: string) => {
      this.store.putRepoCollaborator({ ...r, error });
      return error;
    };
    if (!ownerToken) return fail(`@${r.login} is still a collaborator on ${r.slug}: ${owner?.name ?? 'the scheme\'s owner'} hasn't linked a working GitHub, so Citadel couldn't take them off. They can remove @${r.login} on GitHub.`);
    try {
      // A pending invite and an accepted one are separate things on GitHub; 404 on either means it's gone already.
      if (r.invitation_id) {
        const inv = await this.api('DELETE', `/repos/${r.slug}/invitations/${r.invitation_id}`, ownerToken.secret);
        if (inv.status !== 204 && inv.status !== 404) return fail(`Couldn't withdraw @${r.login}'s invite to ${r.slug}: ${await explain(inv, ownerToken.login, r.login!, r.slug, this.link.installHint(ownerToken.limited, r.slug))}`);
      }
      const del = await this.api('DELETE', `/repos/${r.slug}/collaborators/${r.login}`, ownerToken.secret);
      if (del.status !== 204 && del.status !== 404) return fail(`Couldn't take @${r.login} off ${r.slug}: ${await explain(del, ownerToken.login, r.login!, r.slug, this.link.installHint(ownerToken.limited, r.slug))}`);
    } catch (err: any) {
      return fail(`Couldn't reach GitHub to take @${r.login} off ${r.slug} (${err?.message ?? err}); Citadel tries again at its next restart.`);
    }
    this.store.deleteRepoCollaborator(projectId, userId);
    return null;
  }

  /**
   * The boot sweep: invite every member who isn't settled yet (the people already in schemes when this
   * shipped, and anything that failed), and take off Citadel's collaborators who have left since.
   */
  async sweep(): Promise<void> {
    if (!this.on) return;
    const kept = new Set<string>();
    for (const p of this.store.listProjects()) {
      const slug = repoSlug(p.repo_url);
      const github = !!slug;
      for (const m of this.store.listMembers(p.id)) {
        // Still a member even if the scheme's repo went: only leaving takes anyone off GitHub.
        kept.add(`${p.id}:${m.id}`);
        if (m.owner || !github) continue;
        const r = this.store.getRepoCollaborator(p.id, m.id);
        // A row naming another repo is from before the scheme's repo moved (#456): sync starts over on the new one.
        if (!r || r.state === 'failed' || r.state === 'waiting' || r.state === 'invited' || r.error || r.slug !== slug) await this.sync(p.id, m.id);
      }
    }
    await this.tidy(kept);
  }

  /** Undo Citadel's invites for people no longer in a scheme (left, removed from Citadel, or the scheme deleted). */
  async tidy(kept?: Set<string>): Promise<void> {
    const members = kept ?? new Set(this.store.listProjects().flatMap((p) => this.store.listMembers(p.id).map((m) => `${p.id}:${m.id}`)));
    for (const r of this.store.listRepoCollaborators()) {
      if (members.has(`${r.project_id}:${r.user_id}`)) continue;
      // shortcut: a deleted scheme has no owner to act for, so its rows just go; its collaborators stay on GitHub.
      if (!this.store.getProject(r.project_id)) this.store.deleteRepoCollaborator(r.project_id, r.user_id);
      else await this.remove(r.project_id, r.user_id);
    }
  }
}

/** GitHub's own message from an error answer, or its status. */
async function githubSays(r: Response): Promise<string> {
  const body = (await r.json().catch(() => null)) as { message?: string; errors?: { message?: string }[] } | null;
  const words = [body?.message, ...(body?.errors ?? []).map((e) => e.message)].filter(Boolean).join(': ');
  return words ? `GitHub said "${words}" (${r.status})` : `GitHub answered ${r.status}`;
}

/** Why the owner's token couldn't invite or remove: a dead link, a missing scope, a repo that isn't theirs, an org rule. */
async function explain(r: Response, ownerLogin: string, login: string, slug: string, hint = ''): Promise<string> {
  const said = await githubSays(r);
  // A limited link (#464) is refused like a missing repo where the App isn't installed: say so before guessing further.
  if (hint && (r.status === 403 || r.status === 404)) return `@${ownerLogin} can't manage collaborators on ${slug}.${hint} (${said})`;
  if (r.status === 401) return `@${ownerLogin}'s GitHub link stopped working; they link it again in Settings → Your account. (${said})`;
  const scopes = r.headers.get('x-oauth-scopes');
  if (scopes !== null && !scopes.split(/[ ,]+/).includes('repo')) return `@${ownerLogin}'s GitHub link lacks the repo permission, which inviting collaborators needs; they link it again in Settings → Your account. (${said})`;
  const repoOwner = slug.split('/')[0];
  const notTheirs = repoOwner !== ownerLogin.toLowerCase();
  if (r.status === 403 && notTheirs) return `${slug} belongs to ${repoOwner}, which doesn't let @${ownerLogin} add outside collaborators; an admin of ${repoOwner} adds @${login} instead. (${said})`;
  if (r.status === 404) return `@${ownerLogin} can't manage collaborators on ${slug}: it's gone, renamed, or not theirs to share${notTheirs ? ` (it belongs to ${repoOwner})` : ''}. (${said})`;
  return said;
}
