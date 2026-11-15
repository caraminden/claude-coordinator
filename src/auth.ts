// Per-person logins (scrypt password hashes, one-time invite links) with HMAC-signed session
// cookies. COORDINATOR_PASSWORD still signs in an admin, as a fallback and for tools/boot-check.ts.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { promisify } from 'node:util';
import { APP_NAME } from './appname.ts';
import type { Store, User } from './db.ts';
import { GITHUB_NAME } from './github.ts';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const INVITE_DAYS = 7;

export const COOKIE = 'cc_session';
/** A contraption host's own login (<name>.<APPS_DOMAIN>, src/apps.ts): never cc_session, which stays on Citadel's hosts. */
export const APP_COOKIE = 'cc_app';
/** How long a sign-in handoff token to a contraption's host lasts; it is good for one use. */
const APP_TOKEN_MS = 60_000;
const SESSION_DAYS = 180;
/** A session older than this gets a fresh cookie on its next request, so only SESSION_DAYS unused signs someone out. */
const RENEW_DAYS = 7;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** How long an HTML page's frame can keep loading its sibling files: through a workday. */
const FILE_TOKEN_HOURS = 12;

export interface Session {
  name: string;
  exp: number;
  /** The signed-in person's user id; cookies from the shared-password days carry only the name. */
  uid?: number;
  admin?: boolean;
  /** Set for a coordinator ticket calling the API through its MCP tools: that ticket's id. */
  agent?: number;
}

export const AGENT_NAME = 'Taskmaster';

/** A thread's turn-token nonces: its current turn's and the one before. */
export interface Nonces { current: string | null; previous: string | null }
/** Where Auth keeps them. `get` returns null for a thread that is gone; a closed one's tokens only report deploys. */
export interface NonceStore {
  get(ticketId: number): (Nonces & { closed?: boolean }) | null;
  set(ticketId: number, nonces: Nonces): void;
}
const NO_NONCES: NonceStore = { get: () => ({ current: null, previous: null }), set: () => {} };

/** Message authors that aren't people (minions write as "#N title"), so nobody may log in as one. */
export const NOT_PEOPLE = [AGENT_NAME, 'Coordinator', GITHUB_NAME, APP_NAME];

/** A phone's password manager can fill the name field with the site's address; that is never a name. */
export function looksLikeUrl(name: string): boolean {
  return /^https?\W|\/|^www\./i.test(name);
}

/**
 * Every value of cookie `name`, in the order sent. A page on a contraption's host (a sibling of Citadel's) can set a cookie
 * of the same name for the whole domain, which may come first, so readers try each and keep the first that verifies.
 */
function cookies(req: IncomingMessage, name: string): string[] {
  return (req.headers.cookie ?? '').split(/;\s*/).filter((c) => c.startsWith(`${name}=`)).map((c) => c.slice(name.length + 1));
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${(await scryptAsync(password, salt, 32)).toString('base64url')}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [kind, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  return timingSafeEqual(expected, await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length));
}

// Checked for unknown logins too, so a wrong login takes as long as a wrong password.
const DUMMY_HASH = `scrypt$${'A'.repeat(22)}$${'A'.repeat(43)}`;

export function inviteHash(token: string): string {
  return sha256(token).toString('base64url');
}

export class Auth {
  private failures = new Map<string, { count: number; since: number }>();
  private password: string;
  private secret: string;
  private nonces: NonceStore;
  /** Where people are; without it (a preview's signer) a cookie is taken at its word. */
  private users?: Store;

  constructor(password: string, secret: string, nonces: NonceStore = NO_NONCES, users?: Store) {
    if (password.length < 12) throw new Error('COORDINATOR_PASSWORD must be at least 12 characters');
    if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    this.password = password;
    this.secret = secret;
    this.nonces = nonces;
    this.users = users;
  }

  /** Too many recent failures from this client? */
  limited(client: string): boolean {
    const f = this.failures.get(client);
    if (!f) return false;
    if (Date.now() - f.since > FAILURE_WINDOW_MS) {
      this.failures.delete(client);
      return false;
    }
    return f.count >= MAX_FAILURES;
  }

  private counted(client: string, ok: boolean): boolean {
    if (ok) {
      this.failures.delete(client);
    } else {
      if (this.failures.size > 10_000) this.prune();
      const f = this.failures.get(client) ?? { count: 0, since: Date.now() };
      f.count++;
      this.failures.set(client, f);
    }
    return ok;
  }

  /**
   * The person a login and password sign in, or null. COORDINATOR_PASSWORD signs in only the admin
   * the login names: it was once everyone's shared password, so an unknown login with it gets nothing.
   */
  async signIn(client: string, login: string, password: string): Promise<User | null> {
    const store = this.users!;
    const user = store.findUser('login', login.trim());
    const own = await verifyPassword(user?.password_hash ?? DUMMY_HASH, password);
    const shared = timingSafeEqual(sha256(password), sha256(this.password));
    const admin = shared && user?.admin ? user : null;
    const who = user && own ? user : admin;
    return this.counted(client, !!who && !who.disabled_at) ? who : null;
  }

  /** Open a fresh one-time set-password link for a person, replacing any earlier one. Returns its token. */
  newInvite(userId: number): string {
    const token = randomBytes(24).toString('base64url');
    this.users!.updateUser(userId, { invite_hash: inviteHash(token), invite_expires: Date.now() + INVITE_DAYS * 86400_000 });
    return token;
  }

  /** The person an open, unexpired invite token belongs to, or null (counted as a failure). */
  inviteUser(client: string, token: string): User | null {
    if (!/^[\w-]{32}$/.test(token)) return null; // not one of ours: no lookup, and not worth counting
    const user = this.users!.findUser('invite_hash', inviteHash(token));
    return this.counted(client, !!user && !user.disabled_at && (user.invite_expires ?? 0) > Date.now()) ? user! : null;
  }

  private prune() {
    const cutoff = Date.now() - FAILURE_WINDOW_MS;
    for (const [client, f] of this.failures) if (f.since < cutoff) this.failures.delete(client);
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issueCookie(user: { id: number; name: string }, secure: boolean): string {
    const session: Session = { name: user.name, uid: user.id, exp: Date.now() + SESSION_DAYS * 86400_000 };
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    const value = `${payload}.${this.sign(payload)}`;
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
  }

  /** A fresh cookie for a signed-in person whose session is over RENEW_DAYS old, else null. */
  renewal(session: Session | null, secure: boolean): string | null {
    // Without the people table (a preview's signer) nobody is renewed; agents carry no cookie.
    if (!this.users || !session || session.agent !== undefined || session.uid === undefined) return null;
    const old = session.exp - Date.now() < (SESSION_DAYS - RENEW_DAYS) * 86400_000;
    return old ? this.issueCookie({ id: session.uid, name: session.name }, secure) : null;
  }

  clearCookie(): string {
    return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  /**
   * Bearer token that lets a thread's MCP servers act on the API as that thread. With a nonce it lives
   * as long as the nonce does; without one it is the old kind, good only until the thread's first turn
   * token (tests mint those, and turns started before the nonces still hold one).
   */
  agentToken(ticketId: number, nonce?: string): string {
    return nonce ? `${ticketId}.${nonce}.${this.sign(`agent:${ticketId}:${nonce}`)}` : `${ticketId}.${this.sign(`agent:${ticketId}`)}`;
  }

  /**
   * A token for a thread's new turn. It works until the thread's next turn starts, even while the
   * thread sits idle; after that, or once the thread is dismissed, it only posts its deploy report.
   */
  turnToken(ticketId: number): string {
    const nonce = randomBytes(16).toString('base64url');
    this.nonces.set(ticketId, { current: nonce, previous: this.nonces.get(ticketId)?.current ?? null });
    return this.agentToken(ticketId, nonce);
  }

  /**
   * A token for an HTML page's sibling files, which its sandboxed frame loads without cookies: it
   * reads the servable files of one folder (`scope`, see routes/files.ts) until it expires.
   */
  fileToken(scope: string, now = Date.now()): string {
    const exp = Math.floor((now + FILE_TOKEN_HOURS * 3600_000) / 1000).toString(36);
    return `${scope}.${exp}.${this.sign(`files:${scope}:${exp}`)}`;
  }

  /** The scope a file token reads, or null if it is forged or has expired. */
  fileScope(token: string, now = Date.now()): string | null {
    const m = /^([a-z0-9-]+)\.([a-z0-9]+)\.([\w-]+)$/.exec(token);
    if (!m) return null;
    const [, scope, exp, sig] = m;
    const expected = Buffer.from(this.sign(`files:${scope}:${exp}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return parseInt(exp, 36) * 1000 > now ? scope : null;
  }

  /** A signed `prefix:` payload's object, or null if forged or not JSON. The prefix keeps one kind from passing as another. */
  private unseal(prefix: string, value: string): Record<string, unknown> | null {
    const [payload, sig] = value.split('.');
    if (!payload || !sig) return null;
    const expected = Buffer.from(this.sign(`${prefix}:${payload}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const o = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return o && typeof o === 'object' ? o : null;
    } catch {
      return null;
    }
  }

  private seal(prefix: string, o: object): string {
    const payload = Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${payload}.${this.sign(`${prefix}:${payload}`)}`;
  }

  /** Spent handoff tokens' nonces, until they expire. A restart forgets them, which still leaves at most APP_TOKEN_MS. */
  private spent = new Map<string, number>();

  /** A one-time token that signs `uid` in on contraption `app`'s own host for the next minute (src/apps.ts, /_citadel/enter). */
  appToken(app: string, uid: number, now = Date.now()): string {
    return this.seal('app-enter', { a: app, u: uid, n: randomBytes(12).toString('base64url'), e: now + APP_TOKEN_MS });
  }

  /** The user id an unspent, unexpired handoff token for `app` names (spending it), or null. */
  redeemAppToken(token: string, app: string, now = Date.now()): number | null {
    const t = this.unseal('app-enter', token);
    if (!t || t.a !== app || typeof t.u !== 'number' || typeof t.n !== 'string' || typeof t.e !== 'number' || t.e <= now) return null;
    for (const [n, e] of this.spent) if (e <= now) this.spent.delete(n);
    if (this.spent.has(t.n)) return null;
    this.spent.set(t.n, t.e);
    return t.u;
  }

  /**
   * The cookie that keeps a person signed in on contraption `app`'s host. Over HTTPS it is SameSite=None and
   * Partitioned (CHIPS), so it works in Citadel's frame from either Citadel host, the cross-site one included;
   * src/apps.ts refuses cross-origin writes in its place. Over plain HTTP (a dev copy) browsers refuse None, so Lax.
   */
  issueAppCookie(app: string, user: { id: number }, secure: boolean): string {
    const value = this.seal('app', { a: app, u: user.id, e: Date.now() + SESSION_DAYS * 86400_000 });
    return `${APP_COOKIE}=${value}; Path=/; HttpOnly; Max-Age=${SESSION_DAYS * 86400}; ${secure ? 'SameSite=None; Secure; Partitioned' : 'SameSite=Lax'}`;
  }

  /** The person contraption `app`'s host cookie signs in, read from their row as session() does, or null. */
  appSession(req: IncomingMessage, app: string): Session | null {
    for (const value of cookies(req, APP_COOKIE)) {
      const s = this.appSessionFrom(value, app);
      if (s) return s;
    }
    return null;
  }

  private appSessionFrom(value: string, app: string): Session | null {
    const s = this.unseal('app', value);
    if (!s || s.a !== app || typeof s.u !== 'number' || typeof s.e !== 'number' || s.e <= Date.now() || !this.users) return null;
    const user = this.users.getUser(s.u);
    return user && !user.disabled_at ? { name: user.name, uid: user.id, admin: this.users.isAdmin(user), exp: s.e } : null;
  }

  /** A fresh host cookie for a contraption session over RENEW_DAYS old, else null (as renewal). */
  appRenewal(app: string, session: Session | null, secure: boolean): string | null {
    if (!session || session.uid === undefined) return null;
    return session.exp - Date.now() < (SESSION_DAYS - RENEW_DAYS) * 86400_000 ? this.issueAppCookie(app, { id: session.uid }, secure) : null;
  }

  private agentSession(req: IncomingMessage): Session | null {
    const m = (req.headers.authorization ?? '').match(/^Bearer (\d+)\.(?:([\w-]+)\.)?([\w-]+)$/);
    if (!m) return null;
    const [, id, nonce, sig] = m;
    const expected = Buffer.from(this.sign(nonce === undefined ? `agent:${id}` : `agent:${id}:${nonce}`));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const ticketId = Number(id);
    const known = this.nonces.get(ticketId);
    if (!known) return null;
    // tools/deploy.sh posts its report after the idle restart with the turn's token, and a new turn may have begun by then.
    const report = req.method === 'POST' && (req.url ?? '').split('?')[0] === `/api/tickets/${ticketId}/deploy`;
    const fresh = nonce === undefined ? known.current === null : nonce === known.current;
    const live = report ? fresh || nonce === known.previous : fresh && !known.closed;
    return live ? { name: AGENT_NAME, exp: Infinity, agent: ticketId } : null;
  }

  session(req: IncomingMessage): Session | null {
    if (req.headers.authorization) return this.agentSession(req);
    for (const value of cookies(req, COOKIE)) {
      const s = this.sessionFrom(value);
      if (s) return s;
    }
    return null;
  }

  private sessionFrom(value: string): Session | null {
    const [payload, sig] = value.split('.');
    if (!payload || !sig) return null;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    let s: Session;
    try {
      s = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session;
    } catch {
      return null;
    }
    if (!(s.exp > Date.now()) || typeof s.name !== 'string' || looksLikeUrl(s.name)) return null;
    if (!this.users) return { name: s.name, uid: s.uid, exp: s.exp };
    // Name and rights come from the person's row, so a rename, a demotion or disabling them takes at once;
    // a cookie from the shared-password days names its person.
    const user = typeof s.uid === 'number' ? this.users.getUser(s.uid) : this.users.findUser('name', s.name);
    return user && !user.disabled_at ? { name: user.name, uid: user.id, admin: this.users.isAdmin(user), exp: s.exp } : null;
  }
}
