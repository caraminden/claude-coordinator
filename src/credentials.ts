// People's linked accounts (a GitHub token now; #177's runner pairing secret later), kept in the
// credentials table encrypted with AES-256-GCM under a key derived from SESSION_SECRET. A copy of the
// database (a backup, a boot check, a preview with its own secret) can't open them. Rotating
// SESSION_SECRET can't either: every link then reads as failed and needs linking again.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Store } from './db.ts';

export type CredentialKind = 'github' | 'claude_runner';

export interface Credential<M> {
  /** null when it couldn't be decrypted (SESSION_SECRET changed): treat it as needing linking again. */
  secret: string | null;
  meta: M;
  failed: boolean;
  created_at: number;
  updated_at: number;
}

/** A key for seal and unseal, derived from SESSION_SECRET for one purpose. */
export const sealKey = (sessionSecret: string, purpose: string): Buffer => Buffer.from(hkdfSync('sha256', sessionSecret, '', purpose, 32));

/** AES-256-GCM under `key`, bound to `aad`: a sealed value copied to another row (another aad) doesn't open. */
export function seal(key: Buffer, aad: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const body = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')}`;
}

/** What seal sealed, or null when it doesn't open (another key or aad: SESSION_SECRET changed, or a copied row). */
export function unseal(key: Buffer, aad: string, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed.replace(/^v1:/, ''), 'base64url');
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export class Credentials {
  private store: Store;
  private key: Buffer;

  constructor(store: Store, sessionSecret: string) {
    this.store = store;
    this.key = sealKey(sessionSecret, 'citadel credentials v1');
  }

  put(userId: number, kind: CredentialKind, secret: string, meta: object) {
    // Bound to its row: a secret copied onto another person's row doesn't open.
    this.store.putCredential(userId, kind, seal(this.key, `${userId}:${kind}`, secret), meta);
  }

  get<M = Record<string, unknown>>(userId: number, kind: CredentialKind): Credential<M> | null {
    const row = this.store.getCredential(userId, kind);
    if (!row) return null;
    const secret = unseal(this.key, `${userId}:${kind}`, row.secret);
    return { secret, meta: JSON.parse(row.meta) as M, failed: secret === null || row.failed_at !== null, created_at: row.created_at, updated_at: row.updated_at };
  }

  fail(userId: number, kind: CredentialKind) {
    this.store.failCredential(userId, kind);
  }

  remove(userId: number, kind: CredentialKind) {
    this.store.deleteCredential(userId, kind);
  }
}
