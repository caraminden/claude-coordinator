// People link their own GitHub through Citadel's OAuth App (Cara, 2026-10-29: "we want Oauth"), and
// each turn pushes and opens pull requests as the person it runs for (src/runner.ts turnPerson). The
// token reaches only that turn's environment, as GH_TOKEN: gh, and git through gh's credential helper,
// use it. With neither the OAuth App (GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET) nor the GitHub App below
// set up, turns use the box's own gh login as before.
//
// Two ways to link, side by side (#464; Josh, 2026-11-10: "Lets do both?... I want alex to be able to do what
// he is comfortable with"): the OAuth App's full-access link, and a limited one through Citadel's GitHub App
// (GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET, GITHUB_APP_SLUG), whose token reaches only repos where the
// repo's owner installed the App and the person has access. A person has one link; linking again replaces it.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Credentials } from './credentials.ts';
import type { Store, User } from './db.ts';
import { thrown } from './thrown.ts';

/** `workflow` too: without it GitHub refuses a push that touches .github/workflows. */
export const SCOPES = 'repo workflow';
const STATE_MS = 10 * 60_000;
// How often Settings asks GitHub whether a link still works (revoked on GitHub shows as needing linking again).
const CHECK_MS = 10 * 60_000;
// A slow GitHub fails the call rather than holding the account page or the link open.
const GITHUB_WAIT_MS = 10_000;
/** The last limited link refused for the App's expiring tokens, kept for the admins' People page (#670). */
const REFUSED = 'github_link_refused';

export interface GithubMeta {
  login: string;
  id: number;
  name: string | null;
  /** True for a limited link, made through the GitHub App; absent for the OAuth App's full access. */
  app?: boolean;
}

/** Citadel's GitHub App, for limited links: its client id and secret, and its URL name (for the install page). */
export interface GithubApp {
  clientId: string;
  clientSecret: string;
  slug: string;
}

interface Client {
  id: string;
  secret: string;
}

/** What a turn gets: its env additions and one line for its prompt. */
export interface TurnGithub {
  env: Record<string, string>;
  line: string;
  login: string | null;
}

type Fetch = typeof fetch;

/** The App's URL name from what was configured: a bare slug, or a pasted URL or path like github.com/apps/<slug>. */
export function appSlug(raw: string): string {
  let v = (raw ?? '').trim();
  try {
    v = decodeURIComponent(v);
  } catch {
    /* keep as typed */
  }
  const m = /(?:^|\/)apps\/([^/?#\s]+)/.exec(v);
  return (
    m
      ? m[1]
      : (v
          .replace(/[?#].*$/, '')
          .replace(/\/+$/, '')
          .split('/')
          .pop() ?? '')
  ).trim();
}

export class GithubLink {
  /** States already brought back, until they expire: each works once (per server; GitHub's code is single-use anyway). */
  private used = new Map<string, number>();
  private checked = new Map<number, number>();
  /** A link that failed, said once on the account page. */
  private errors = new Map<number, string>();

  private store: Store;
  private creds: Credentials;
  private clientId: string;
  private clientSecret: string;
  private fetch: Fetch;
  private app: GithubApp;

  constructor(store: Store, creds: Credentials, clientId: string, clientSecret: string, fetch: Fetch = globalThis.fetch, app: GithubApp = { clientId: '', clientSecret: '', slug: '' }) {
    this.store = store;
    this.creds = creds;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetch;
    // GITHUB_APP_SLUG is the name in the App's URL, but people paste the whole URL (or a percent-encoded one): keep the last name in it.
    this.app = { ...app, slug: appSlug(app.slug) };
  }

  /** Whether people link their own GitHub here at all, either way. */
  get configured(): boolean {
    return this.full || this.limited;
  }

  /** The OAuth App is set up: full-access links. */
  get full(): boolean {
    return !!(this.clientId && this.clientSecret);
  }

  /** The GitHub App is set up: limited links. */
  get limited(): boolean {
    return !!(this.app.clientId && this.app.clientSecret);
  }

  /** Where a repo's owner installs Citadel's GitHub App, or null when its URL name isn't set. */
  get installUrl(): string | null {
    return this.app.slug ? `https://github.com/apps/${encodeURIComponent(this.app.slug)}/installations/new` : null;
  }

  /** The GitHub App's settings page, where its owner changes "Expire user authorization tokens" (an App an organization owns has its own). */
  get settingsUrl(): string | null {
    return this.app.slug ? `https://github.com/settings/apps/${encodeURIComponent(this.app.slug)}` : null;
  }

  /** The last limited link refused because the App hands out expiring tokens, for the admins; null since one worked. */
  refused(): { name: string; at: number; fix: string; settings_url: string | null } | null {
    const r = this.store.getSetting<{ uid: number; name: string; at: number }>(REFUSED);
    if (!r) return null;
    return {
      name: r.name,
      at: r.at,
      settings_url: this.settingsUrl,
      fix: 'Citadel\'s GitHub App hands out user tokens that expire after 8 hours, which Citadel refuses (a refresh would cut off the person\'s other running turns). On the App\'s settings page on GitHub, open Optional features and untick "Expire user authorization tokens" (README, "A limited GitHub link"), then ask them to link again.',
    };
  }

  /** The client a link of this kind was made with, or null when that kind isn't set up (any more). */
  private client(limited: boolean): Client | null {
    if (limited) return this.limited ? { id: this.app.clientId, secret: this.app.clientSecret } : null;
    return this.full ? { id: this.clientId, secret: this.clientSecret } : null;
  }

  /** For an error about `slug` from a limited link: that the App may not be installed there, and where to install it. */
  installHint(limited: boolean | undefined, slug: string): string {
    if (!limited) return '';
    return ` Their GitHub link is the limited kind, which reaches ${slug} only once its owner has installed Citadel's GitHub App on it${this.installUrl ? `: ${this.installUrl}` : ''}.`;
  }

  /** GitHub's authorize page for this person; `projectId` is the scheme whose Settings they come back to. */
  authorizeUrl(uid: number, projectId: number, redirectUri: string, limited = false): string {
    // The state carries who asked, for which scheme and kind, signed, rather than living in memory: a deploy restart
    // while the person is on GitHub's page used to fail their link as expired (#479).
    const body = Buffer.from(JSON.stringify({ u: uid, p: projectId, l: limited ? 1 : 0, e: Date.now() + STATE_MS, n: randomBytes(12).toString('base64url') })).toString('base64url');
    const state = `${body}.${this.sign(body, limited) ?? ''}`;
    // A GitHub App takes no scope: what its token can do is the App's own permissions, where it is installed.
    const q = new URLSearchParams({ client_id: this.client(limited)?.id ?? '', redirect_uri: redirectUri, ...(limited ? {} : { scope: SCOPES }), state, allow_signup: 'false' });
    return `https://github.com/login/oauth/authorize?${q}`;
  }

  /**
   * GitHub sent the person back: check the state was made for them, swap the code for a token, and
   * keep it with who it is. Returns the scheme to go back to; a failure is kept for the account page.
   */
  async finish(uid: number, params: URLSearchParams, redirectUri: string): Promise<number | null> {
    const state = params.get('state') ?? '';
    const now = Date.now();
    for (const [k, expires] of this.used) if (expires < now) this.used.delete(k);
    const s = this.used.has(state) ? null : this.opened(state);
    if (s === 'unset') {
      this.errors.set(uid, "That way of linking GitHub isn't set up on this server.");
      return null;
    }
    if (!s || s.uid !== uid || s.expires < now) {
      this.errors.set(uid, 'That GitHub sign-in had expired or was for someone else. Try Link GitHub again.');
      return s?.uid === uid ? s.projectId : null;
    }
    this.used.set(state, s.expires);
    try {
      if (params.get('error')) throw new Error(params.get('error') === 'access_denied' ? 'You cancelled on GitHub.' : `GitHub said: ${params.get('error_description') ?? params.get('error')}`);
      // Signed with this kind's client secret, so the kind is still set up.
      const client = this.client(s.limited)!;
      const r = await this.fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        signal: AbortSignal.timeout(GITHUB_WAIT_MS),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: client.id, client_secret: client.secret, code: params.get('code') ?? '', redirect_uri: redirectUri }),
      });
      const body = (await r.json()) as { access_token?: string; scope?: string; error_description?: string; expires_in?: number; refresh_token?: string };
      if (!body.access_token) throw new Error(`GitHub didn't give a token: ${body.error_description ?? r.status}`);
      // Citadel doesn't refresh tokens (a refresh kills the token a person's other turns hold): better no link than one that dies in 8 hours.
      if (body.expires_in || body.refresh_token) {
        // The person can't change the App, so they're told it isn't on them; the admins get the fix on Settings → People.
        if (s.limited) this.store.setSetting(REFUSED, { uid, name: this.store.getUser(uid)?.name ?? `person ${uid}`, at: Date.now() });
        console.error(`github link: refused an expiring token for person ${uid}; untick "Expire user authorization tokens" on the GitHub App`);
        throw new Error("GitHub gave Citadel a link that would stop working after 8 hours, so Citadel didn't keep it. That's nothing you did: it's one setting on Citadel's GitHub App that only an admin can change, and they can see this on their People page. Link GitHub again once they have.");
      }
      const granted = (body.scope ?? '').split(/[ ,]+/);
      if (!s.limited && !granted.includes('repo')) throw new Error("GitHub gave a token without the repo permission, so it couldn't push.");
      const me = await this.user(body.access_token);
      if (!me) throw new Error("GitHub didn't accept the new token.");
      // A link of the other kind is replaced: revoke it on GitHub. Never one of the same kind, whose grant the new token shares.
      const old = this.creds.get<GithubMeta>(uid, 'github');
      if (old?.secret && !!old.meta.app !== s.limited) await this.revoke(old.secret, !!old.meta.app);
      this.creds.put(uid, 'github', body.access_token, s.limited ? { ...me, app: true } : me);
      this.checked.set(uid, Date.now());
      this.errors.delete(uid);
      // A limited link that works means the App's expiring tokens were turned off.
      if (s.limited) this.store.deleteSetting(REFUSED);
    } catch (err) {
      this.errors.set(uid, thrown(err).message ?? String(err));
    }
    return s.projectId;
  }

  /** A state's signature: an HMAC keyed from the client secret of its kind, or null when that kind isn't set up. */
  private sign(body: string, limited: boolean): string | null {
    const client = this.client(limited);
    return client ? createHmac('sha256', `citadel github link state\0${client.secret}`).update(body).digest('base64url') : null;
  }

  /**
   * What a state GitHub brought back stands for; null when it isn't one this server's secrets signed, and 'unset' when
   * its kind of link has been taken off the server since (nothing to check it with).
   */
  private opened(state: string): { uid: number; projectId: number; expires: number; limited: boolean } | 'unset' | null {
    // Exactly body.sig: a state with more parts would pass as a new one past `used`.
    const [body, sig, ...more] = state.split('.');
    if (sig === undefined || more.length) return null;
    let v: { u?: unknown; p?: unknown; l?: unknown; e?: unknown };
    try {
      v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!v || typeof v !== 'object' || !Number.isSafeInteger(v.u) || !Number.isSafeInteger(v.p) || !Number.isSafeInteger(v.e) || (v.l !== 0 && v.l !== 1)) return null;
    const want = this.sign(body, v.l === 1);
    if (!want) return 'unset';
    const [w, g] = [Buffer.from(want), Buffer.from(sig)];
    if (w.length !== g.length || !timingSafeEqual(w, g)) return null;
    return { uid: v.u as number, projectId: v.p as number, expires: v.e as number, limited: v.l === 1 };
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
      full: this.full,
      limited: this.limited,
      install_url: this.installUrl,
      link: now
        ? {
            login: now.meta.login,
            name: now.meta.name,
            email: noreplyEmail(now.meta),
            failed: now.failed,
            linked_at: now.updated_at,
            limited: !!now.meta.app,
            reach: now.meta.app && now.secret && !now.failed ? await this.reach(now.secret) : null,
          }
        : null,
    };
  }

  /**
   * The repos a limited link can reach, as GitHub says now: where the App is installed and the person has
   * access. Null when GitHub can't say.
   */
  private async reach(token: string): Promise<string[] | null> {
    const get = async (path: string) => {
      const r = await this.fetch(`https://api.github.com${path}`, { signal: AbortSignal.timeout(GITHUB_WAIT_MS), headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Citadel' } });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      return (await r.json()) as { installations?: { id: number }[]; repositories?: { full_name: string }[] };
    };
    try {
      const repos: string[] = [];
      // shortcut: the first 100 installs and 100 repos of each, page through them if a list ever looks cut short.
      for (const i of (await get('/user/installations?per_page=100')).installations ?? []) {
        for (const r of (await get(`/user/installations/${Number(i.id)}/repositories?per_page=100`)).repositories ?? []) repos.push(String(r.full_name));
      }
      return repos.sort();
    } catch {
      return null;
    }
  }

  /** Revoke a token's grant on GitHub with the client that made it; best effort, it may be gone already. */
  private async revoke(token: string, limited: boolean) {
    const client = this.client(limited);
    if (!client) return;
    await this.fetch(`https://api.github.com/applications/${client.id}/grant`, {
      method: 'DELETE',
      signal: AbortSignal.timeout(GITHUB_WAIT_MS),
      headers: { Authorization: `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Citadel' },
      body: JSON.stringify({ access_token: token }),
    }).catch(() => {});
  }

  /** Revoke the grant on GitHub (best effort: it may be gone already) and forget the token. */
  async unlink(uid: number) {
    const c = this.creds.get<GithubMeta>(uid, 'github');
    if (c?.secret) await this.revoke(c.secret, !!c.meta.app);
    this.creds.remove(uid, 'github');
  }

  /** A person's working token and its account, or null: not linked, the link failed, they're disabled, or linking isn't set up. */
  token(person: User): { secret: string; login: string; limited: boolean } | null {
    if (!this.configured || person.disabled_at) return null;
    const c = this.creds.get<GithubMeta>(person.id, 'github');
    return c?.secret && !c.failed ? { secret: c.secret, login: c.meta.login, limited: !!c.meta.app } : null;
  }

  /** A person's GitHub login as People shows it, without decrypting anything. */
  login(uid: number): { login: string; failed: boolean } | null {
    const row = this.store.getCredential(uid, 'github');
    return row ? { login: (JSON.parse(row.meta) as GithubMeta).login, failed: row.failed_at !== null } : null;
  }

  /**
   * What a turn run for `person` gets, or null with linking not set up either way (the box's gh login, as before).
   * Its gh config folder is an empty one in the turn's folder, so an unlinked turn can't fall back to
   * the box's login; git's prompt is off, so a push without a login fails rather than waits.
   * `later`: the caller makes that folder itself, off the thread (a turn launch, #1808).
   */
  forTurn(person: User | null, turnDir: string, later = false): TurnGithub | null {
    if (!this.configured) return null;
    const env = noLogin(turnDir, !later);
    const who = person?.name ?? 'Nobody';
    // A disabled person's link isn't used: their minions' turns can't push until someone else's message runs one.
    const c = person && !person.disabled_at ? this.creds.get<GithubMeta>(person.id, 'github') : null;
    if (c?.secret && !c.failed) {
      const name = c.meta.name || c.meta.login;
      Object.assign(env, { GH_TOKEN: c.secret, ...gitIdentity(name, noreplyEmail(c.meta)) });
      // A limited link's refusals look like a missing repo, so the turn is told what they mean.
      const limited = c.meta.app ? ` Their link is the limited kind: it reaches a repo only once the repo's owner has installed Citadel's GitHub App on it${this.installUrl ? ` (${this.installUrl})` : ''}. If GitHub refuses a push or says a repo they can see doesn't exist, tell them that; never try another login.` : '';
      return { env, login: c.meta.login, line: `GitHub: this turn runs for ${who}, so its pushes and pull requests go out as @${c.meta.login} and its commits are theirs.${limited}` };
    }
    Object.assign(env, gitIdentity(who, `${person?.login ?? 'nobody'}@citadel.invalid`));
    const why = c ? `${who}'s GitHub link stopped working` : `${who} hasn't linked GitHub`;
    return {
      env,
      login: null,
      line: `GitHub: this turn runs for ${who}, and ${why}, so it can't push or open pull requests. Commit on your branch, and tell them they can link GitHub in Settings → Your account. Never push from another account or login to get round it.`,
    };
  }
}

/**
 * What a turn placed on a connected machine is told of GitHub (#2318). Its env goes without the person's token (machineEnv,
 * by design): gh and git push there use whatever login is signed in in that worker's home, which only the worker reports.
 * `login` is null: Citadel's link isn't what pushes there, so the chat's push notes don't name it.
 */
export function onWorker(github: TurnGithub, machine: string, signedIn: boolean | null, who: string): TurnGithub {
  if (signedIn)
    return {
      ...github,
      login: null,
      line: `GitHub: this turn runs for ${who} on ${machine}, so gh and git push use the GitHub login signed in there, not the one linked in Citadel. Citadel sees only that a sign-in is there: if \`gh auth status\` shows none or it is refused, the turn can't push, open pull requests or dispatch workflows; say so in your reply, and never push from another account or login to get round it.`,
    };
  const there = signedIn === false ? `no GitHub login is signed in on ${machine}` : `Citadel can't tell whether a GitHub login is signed in on ${machine}`;
  return {
    ...github,
    login: null,
    line: `GitHub: this turn runs for ${who} on ${machine}, and ${there}, so it can't push, open pull requests, dispatch workflows or read CI logs unless \`gh auth status\` shows a login. Commit on your branch: hand_off_land still ships it, as the server pushes. If this turn needs GitHub itself (a flake proof, a pull request, a CI log), say so in your reply: ${who} can sign in to GitHub on ${machine} (its Sign-ins there, on the Machines page) or set this minion to run on perigee. Never push from another account or login to get round it.`,
  };
}

/**
 * gh and git env for work the server does for a non-admin `person` (#195: making or cloning their
 * scheme's repo): their own token when linked, otherwise no login at all, never the box's.
 */
export function personGithub(link: GithubLink, person: User, dir: string): { env: Record<string, string>; login: string | null } {
  const c = link.token(person);
  return c ? { env: { ...noLogin(dir), GH_TOKEN: c.secret }, login: c.login } : { env: noLogin(dir), login: null };
}

/**
 * The GitHub login the server reads a scheme's repo as (#321: PR state, merges, fetches): its owner's
 * when linked, since a private repo may let no one else in; otherwise undefined, the box's login.
 */
export function schemeGithub(store: Store, link: GithubLink, repoDir: string, dataDir: string): Record<string, string> | undefined {
  const p = store.listProjects().find((x) => x.repo_dir === repoDir);
  const owner = p?.owner_id != null ? store.getUser(p.owner_id) : null;
  return owner && link.token(owner) ? personGithub(link, owner, join(dataDir, 'people', String(owner.id))).env : undefined;
}

const madeGh = new Set<string>();

/** An empty gh config folder in `dir`, so gh and git's gh credential helper can't fall back to the box's login; no prompts. */
function noLogin(dir: string, make = true): Record<string, string> {
  const ghDir = join(dir, 'gh');
  // Off the thread, once a folder: gh reads a config folder that isn't there yet as an empty one, so nothing waits on it.
  if (make && !madeGh.has(ghDir)) {
    madeGh.add(ghDir);
    mkdir(ghDir, { recursive: true, mode: 0o700 }).catch(() => madeGh.delete(ghDir));
  }
  return { GH_CONFIG_DIR: ghDir, GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
}

/** GitHub's private address for a person, which links commits to their profile without showing their email. */
export const noreplyEmail = (m: GithubMeta) => `${m.id}+${m.login}@users.noreply.github.com`;

const gitIdentity = (name: string, email: string) => ({ GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
