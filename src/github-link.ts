// People link their own GitHub through Citadel's OAuth App (Cara, 2026-10-29: "we want Oauth"), and
// each turn pushes and opens pull requests as the person it runs for (src/runner.ts turnPerson). The
// token reaches only that turn's environment, as GH_TOKEN: gh, and git through gh's credential helper,
// use it. With no OAuth App set up (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET), turns use the box's
// own gh login as before.
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Credentials } from './credentials.ts';
import type { Store, User } from './db.ts';

/** `workflow` too: without it GitHub refuses a push that touches .github/workflows. */
export const SCOPES = 'repo workflow';
const STATE_MS = 10 * 60_000;
// How often Settings asks GitHub whether a link still works (revoked on GitHub shows as needing linking again).
const CHECK_MS = 10 * 60_000;
// A slow GitHub fails the call rather than holding the account page or the link open.
const GITHUB_WAIT_MS = 10_000;

export interface GithubMeta {
  login: string;
  id: number;
  name: string | null;
}

/** What a turn gets: its env additions and one line for its prompt. */
export interface TurnGithub {
  env: Record<string, string>;
  line: string;
  login: string | null;
}

type Fetch = typeof fetch;

export class GithubLink {
  private states = new Map<string, { uid: number; projectId: number; expires: number }>();
  private checked = new Map<number, number>();
  /** A link that failed, said once on the account page. */
  private errors = new Map<number, string>();

  private store: Store;
  private creds: Credentials;
  private clientId: string;
  private clientSecret: string;
  private fetch: Fetch;

  constructor(store: Store, creds: Credentials, clientId: string, clientSecret: string, fetch: Fetch = globalThis.fetch) {
    this.store = store;
    this.creds = creds;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetch;
  }

  get configured(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  /** GitHub's authorize page for this person; `projectId` is the scheme whose Settings they come back to. */
  authorizeUrl(uid: number, projectId: number, redirectUri: string): string {
    const now = Date.now();
    for (const [k, v] of this.states) if (v.expires < now) this.states.delete(k);
    const state = randomBytes(24).toString('base64url');
    this.states.set(state, { uid, projectId, expires: now + STATE_MS });
    const q = new URLSearchParams({ client_id: this.clientId, redirect_uri: redirectUri, scope: SCOPES, state, allow_signup: 'false' });
    return `https://github.com/login/oauth/authorize?${q}`;
  }

  /**
   * GitHub sent the person back: check the state was made for them, swap the code for a token, and
   * keep it with who it is. Returns the scheme to go back to; a failure is kept for the account page.
   */
  async finish(uid: number, params: URLSearchParams, redirectUri: string): Promise<number | null> {
    const state = params.get('state') ?? '';
    const s = this.states.get(state);
    if (!s || s.uid !== uid || s.expires < Date.now()) {
      this.errors.set(uid, 'That GitHub sign-in had expired or was for someone else. Try Link GitHub again.');
      return s?.uid === uid ? s.projectId : null;
    }
    this.states.delete(state);
    try {
      if (params.get('error')) throw new Error(params.get('error') === 'access_denied' ? 'You cancelled on GitHub.' : `GitHub said: ${params.get('error_description') ?? params.get('error')}`);
      const r = await this.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST', signal: AbortSignal.timeout(GITHUB_WAIT_MS),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: this.clientId, client_secret: this.clientSecret, code: params.get('code') ?? '', redirect_uri: redirectUri }),
      });
      const body = (await r.json()) as { access_token?: string; scope?: string; error_description?: string };
      if (!body.access_token) throw new Error(`GitHub didn't give a token: ${body.error_description ?? r.status}`);
      const granted = (body.scope ?? '').split(/[ ,]+/);
      if (!granted.includes('repo')) throw new Error('GitHub gave a token without the repo permission, so it couldn\'t push.');
      const me = await this.user(body.access_token);
      if (!me) throw new Error('GitHub didn\'t accept the new token.');
      this.creds.put(uid, 'github', body.access_token, me);
      this.checked.set(uid, Date.now());
      this.errors.delete(uid);
    } catch (err: any) {
      this.errors.set(uid, err.message);
    }
    return s.projectId;
  }

  /** The token's own account, or null when GitHub refuses it (401: revoked). Throws when GitHub can't be reached. */
  private async user(token: string): Promise<GithubMeta | null> {
    const r = await this.fetch('https://api.github.com/user', { signal: AbortSignal.timeout(GITHUB_WAIT_MS), headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Citadel' } });
    if (r.status === 401) return null;
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    const u = (await r.json()) as { login: string; id: number; name: string | null };
    return { login: u.login, id: u.id, name: u.name };
  }

  /** The account page's view of this person's link, checking it with GitHub now and then. */
  async status(uid: number) {
    const error = this.errors.get(uid) ?? null;
    this.errors.delete(uid);
    const c = this.creds.get<GithubMeta>(uid, 'github');
    if (c?.secret && !c.failed && Date.now() - (this.checked.get(uid) ?? 0) > CHECK_MS) {
      try {
        if (!(await this.user(c.secret))) this.creds.fail(uid, 'github');
        this.checked.set(uid, Date.now());
      } catch {
        // GitHub unreachable: say nothing either way.
      }
    }
    const now = this.creds.get<GithubMeta>(uid, 'github');
    return {
      configured: this.configured,
      error,
      link: now ? { login: now.meta.login, name: now.meta.name, email: noreplyEmail(now.meta), failed: now.failed, linked_at: now.updated_at } : null,
    };
  }

  /** Revoke the grant on GitHub (best effort: it may be gone already) and forget the token. */
  async unlink(uid: number) {
    const c = this.creds.get<GithubMeta>(uid, 'github');
    if (c?.secret && this.configured) {
      await this.fetch(`https://api.github.com/applications/${this.clientId}/grant`, {
        method: 'DELETE', signal: AbortSignal.timeout(GITHUB_WAIT_MS),
        headers: { Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Citadel' },
        body: JSON.stringify({ access_token: c.secret }),
      }).catch(() => {});
    }
    this.creds.remove(uid, 'github');
  }

  /** A person's working token and its account, or null: not linked, the link failed, they're disabled, or no OAuth App. */
  token(person: User): { secret: string; login: string } | null {
    if (!this.configured || person.disabled_at) return null;
    const c = this.creds.get<GithubMeta>(person.id, 'github');
    return c?.secret && !c.failed ? { secret: c.secret, login: c.meta.login } : null;
  }

  /** A person's GitHub login as People shows it, without decrypting anything. */
  login(uid: number): { login: string; failed: boolean } | null {
    const row = this.store.getCredential(uid, 'github');
    return row ? { login: (JSON.parse(row.meta) as GithubMeta).login, failed: row.failed_at !== null } : null;
  }

  /**
   * What a turn run for `person` gets, or null with no OAuth App set up (the box's gh login, as before).
   * Its gh config folder is an empty one in the turn's folder, so an unlinked turn can't fall back to
   * the box's login; git's prompt is off, so a push without a login fails rather than waits.
   */
  forTurn(person: User | null, turnDir: string): TurnGithub | null {
    if (!this.configured) return null;
    const env = noLogin(turnDir);
    const who = person?.name ?? 'Nobody';
    // A disabled person's link isn't used: their minions' turns can't push until someone else's message runs one.
    const c = person && !person.disabled_at ? this.creds.get<GithubMeta>(person.id, 'github') : null;
    if (c?.secret && !c.failed) {
      const name = c.meta.name || c.meta.login;
      Object.assign(env, { GH_TOKEN: c.secret, ...gitIdentity(name, noreplyEmail(c.meta)) });
      return { env, login: c.meta.login, line: `GitHub: this turn runs for ${who}, so its pushes and pull requests go out as @${c.meta.login} and its commits are theirs.` };
    }
    Object.assign(env, gitIdentity(who, `${person?.login ?? 'nobody'}@citadel.invalid`));
    const why = c ? `${who}'s GitHub link stopped working` : `${who} hasn't linked GitHub`;
    return {
      env, login: null,
      line: `GitHub: this turn runs for ${who}, and ${why}, so it can't push or open pull requests. Commit on your branch, and tell them they can link GitHub in Settings → Your account. Never push from another account or login to get round it.`,
    };
  }
}

/**
 * gh and git env for work the server does for a non-admin `person` (#195: making or cloning their
 * scheme's repo): their own token when linked, otherwise no login at all, never the box's.
 */
export function personGithub(link: GithubLink, person: User, dir: string): { env: Record<string, string>; login: string | null } {
  const c = link.token(person);
  return c ? { env: { ...noLogin(dir), GH_TOKEN: c.secret }, login: c.login } : { env: noLogin(dir), login: null };
}

/** An empty gh config folder in `dir`, so gh and git's gh credential helper can't fall back to the box's login; no prompts. */
function noLogin(dir: string): Record<string, string> {
  const ghDir = join(dir, 'gh');
  mkdirSync(ghDir, { recursive: true, mode: 0o700 });
  return { GH_CONFIG_DIR: ghDir, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
}

/** GitHub's private address for a person, which links commits to their profile without showing their email. */
export const noreplyEmail = (m: GithubMeta) => `${m.id}+${m.login}@users.noreply.github.com`;

const gitIdentity = (name: string, email: string) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
