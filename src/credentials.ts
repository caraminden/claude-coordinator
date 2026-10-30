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

export class Credentials {
  private store: Store;
  private key: Buffer;

  constructor(store: Store, sessionSecret: string) {
    this.store = store;
    this.key = Buffer.from(hkdfSync('sha256', sessionSecret, '', 'citadel credentials v1', 32));
  }

  put(userId: number, kind: CredentialKind, secret: string, meta: object) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    // Bound to its row: a secret copied onto another person's row doesn't open.
    c.setAAD(Buffer.from(`${userId}:${kind}`));
    const body = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
    this.store.putCredential(userId, kind, `v1:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')}`, meta);
  }

  get<M = Record<string, unknown>>(userId: number, kind: CredentialKind): Credential<M> | null {
    const row = this.store.getCredential(userId, kind);
    if (!row) return null;
    let secret: string | null = null;
    try {
      const raw = Buffer.from(row.secret.replace(/^v1:/, ''), 'base64url');
      const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      d.setAAD(Buffer.from(`${userId}:${kind}`));
      d.setAuthTag(raw.subarray(12, 28));
      secret = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch {
      secret = null;
    }
    return { secret, meta: JSON.parse(row.meta) as M, failed: secret === null || row.failed_at !== null, created_at: row.created_at, updated_at: row.updated_at };
  }

  fail(userId: number, kind: CredentialKind) {
    this.store.failCredential(userId, kind);
  }

  remove(userId: number, kind: CredentialKind) {
    this.store.deleteCredential(userId, kind);
  }
}
