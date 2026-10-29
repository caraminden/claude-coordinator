// Shared-password login with HMAC-signed session cookies.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { APP_NAME } from './appname.ts';
import { GITHUB_NAME } from './github.ts';

const COOKIE = 'cc_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
/** How long an HTML page's frame can keep loading its sibling files: through a workday. */
const FILE_TOKEN_HOURS = 12;

export interface Session {
  name: string;
  exp: number;
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

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

export class Auth {
  private failures = new Map<string, { count: number; since: number }>();
  private password: string;
  private secret: string;
  private nonces: NonceStore;

  constructor(password: string, secret: string, nonces: NonceStore = NO_NONCES) {
    if (password.length < 12) throw new Error('COORDINATOR_PASSWORD must be at least 12 characters');
    if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    this.password = password;
    this.secret = secret;
    this.nonces = nonces;
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

  checkPassword(client: string, attempt: string): boolean {
    const ok = timingSafeEqual(sha256(attempt), sha256(this.password));
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

  private prune() {
    const cutoff = Date.now() - FAILURE_WINDOW_MS;
    for (const [client, f] of this.failures) if (f.since < cutoff) this.failures.delete(client);
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issueCookie(name: string, secure: boolean): string {
    const session: Session = { name, exp: Date.now() + SESSION_DAYS * 86400_000 };
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    const value = `${payload}.${this.sign(payload)}`;
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`;
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
    const header = req.headers.cookie ?? '';
    const match = header.split(/;\s*/).find((c) => c.startsWith(`${COOKIE}=`));
    if (!match) return null;
    const [payload, sig] = match.slice(COOKIE.length + 1).split('.');
    if (!payload || !sig) return null;
    const expected = Buffer.from(this.sign(payload));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const s = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session;
      return s.exp > Date.now() && typeof s.name === 'string' && !looksLikeUrl(s.name) ? s : null;
    } catch {
      return null;
    }
  }
}
