// Shared-password login with HMAC-signed session cookies.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const COOKIE = 'cc_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export interface Session {
  name: string;
  exp: number;
  /** Set for a coordinator ticket calling the API through its MCP tools: that ticket's id. */
  agent?: number;
}

export const AGENT_NAME = 'Taskmaster';

/** A phone's password manager can fill the name field with the site's address; that is never a name. */
export function looksLikeUrl(name: string): boolean {
  return /^https?\W|\/|^www\./i.test(name);
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/**
 * What a thread's own token may do: read and relabel that thread, ask a question card in its chat,
 * read and propose properties and set its own, post an approval card there and read its outcome, message its project's coordinator, start its preview, and close itself. `ticketId` is the internal id the token was issued for, which is also what the
 * API paths use; the per-project number people see (#25) can differ and plays no part here.
 */
export function threadMayCall(ticketId: number, method: string, pathname: string, projectId?: number): boolean {
  const base = `/api/tickets/${ticketId}`;
  if (pathname === base) return method === 'GET' || method === 'PATCH';
  // Properties: read the scheme's registry, propose additions, and set its own (or its files').
  if (pathname === `/api/projects/${projectId}/properties`) return method === 'GET';
  if (pathname === `/api/projects/${projectId}/properties/proposals`) return method === 'POST';
  if (pathname === `${base}/properties`) return method === 'PUT';
  if (pathname === `${base}/approvals`) return method === 'GET' || method === 'POST';
  return method === 'POST' && (pathname === `${base}/questions` || pathname === `${base}/plans` || pathname === `${base}/close` || pathname === `${base}/deploy` || pathname === `${base}/coordinator` || pathname === `${base}/wake` || pathname === `${base}/preview`);
}

export class Auth {
  private failures = new Map<string, { count: number; since: number }>();
  private password: string;
  private secret: string;

  constructor(password: string, secret: string) {
    if (password.length < 12) throw new Error('COORDINATOR_PASSWORD must be at least 12 characters');
    if (secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    this.password = password;
    this.secret = secret;
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

  /** Bearer token that lets a coordinator ticket's MCP server act on the API as that ticket. */
  agentToken(ticketId: number): string {
    return `${ticketId}.${this.sign(`agent:${ticketId}`)}`;
  }

  private agentSession(req: IncomingMessage): Session | null {
    const m = (req.headers.authorization ?? '').match(/^Bearer (\d+)\.([\w-]+)$/);
    if (!m) return null;
    const expected = Buffer.from(this.sign(`agent:${m[1]}`));
    const given = Buffer.from(m[2]);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    return { name: AGENT_NAME, exp: Infinity, agent: Number(m[1]) };
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
