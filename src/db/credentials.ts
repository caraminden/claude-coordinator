// People's and schemes' credentials and secrets (encrypted), and the OpenRouter calls made on them (#1313: src/db.ts by area).
import type { CredentialRow, OpenrouterCallKind, SecretRow } from '../db-rows.ts';
import type { Store } from '../db.ts';

export const credentialQueries = {
  getCredential(this: Store, userId: number, kind: string): CredentialRow | undefined {
    return this.db.prepare('SELECT * FROM credentials WHERE user_id = ? AND kind = ?').get(userId, kind) as CredentialRow | undefined;
  },

  listCredentials(this: Store, kind: string): CredentialRow[] {
    return this.db.prepare('SELECT * FROM credentials WHERE kind = ?').all(kind) as unknown as CredentialRow[];
  },

  putCredential(this: Store, userId: number, kind: string, secret: string, meta: object) {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO credentials (user_id, kind, secret, meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, kind) DO UPDATE SET secret = excluded.secret, meta = excluded.meta, updated_at = excluded.updated_at, failed_at = NULL`)
      .run(userId, kind, secret, JSON.stringify(meta), now, now);
  },

  getSecret(this: Store, scope: string, ownerId: number, name: string): SecretRow | undefined {
    return this.db.prepare('SELECT * FROM stored_secrets WHERE scope = ? AND owner_id = ? AND name = ?').get(scope, ownerId, name) as SecretRow | undefined;
  },

  /** One owner's secrets, by name. */
  listSecrets(this: Store, scope: string, ownerId: number): SecretRow[] {
    return this.db.prepare('SELECT * FROM stored_secrets WHERE scope = ? AND owner_id = ? ORDER BY name').all(scope, ownerId) as unknown as SecretRow[];
  },

  putSecret(this: Store, scope: string, ownerId: number, name: string, value: string, by: number | null) {
    const now = Date.now();
    this.db
      .prepare(`INSERT INTO stored_secrets (scope, owner_id, name, value, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, owner_id, name) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
      .run(scope, ownerId, name, value, by, now, now);
  },

  deleteSecret(this: Store, scope: string, ownerId: number, name: string): boolean {
    return this.db.prepare('DELETE FROM stored_secrets WHERE scope = ? AND owner_id = ? AND name = ?').run(scope, ownerId, name).changes > 0;
  },

  /** The account refused it (revoked, or it can't be decrypted): kept, so Settings can say "link again". */
  failCredential(this: Store, userId: number, kind: string) {
    this.db.prepare('UPDATE credentials SET failed_at = ? WHERE user_id = ? AND kind = ? AND failed_at IS NULL').run(Date.now(), userId, kind);
  },

  deleteCredential(this: Store, userId: number, kind: string) {
    this.db.prepare('DELETE FROM credentials WHERE user_id = ? AND kind = ?').run(userId, kind);
  },

  /** What a person's OpenRouter calls since `since` count against their cap: real costs, and estimates where it isn't known. */
  openrouterSpent(this: Store, userId: number, since: number): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(CASE status WHEN 'ok' THEN cost_usd WHEN 'failed' THEN 0 ELSE estimate_usd END), 0) AS spent
      FROM openrouter_calls WHERE user_id = ? AND created_at >= ?`)
      .get(userId, since) as { spent: number };
    return row.spent;
  },

  addOpenrouterCall(this: Store, c: { user_id: number; ticket_id: number | null; project_id: number | null; model: string; kind: OpenrouterCallKind; estimate_usd: number }): number {
    return Number(
      this.db
        .prepare(`INSERT INTO openrouter_calls (user_id, ticket_id, project_id, model, kind, estimate_usd, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
        .run(c.user_id, c.ticket_id, c.project_id, c.model, c.kind, c.estimate_usd, Date.now()).lastInsertRowid,
    );
  },

  finishOpenrouterCall(this: Store, id: number, status: 'ok' | 'failed' | 'unknown', cost: number | null) {
    this.db.prepare('UPDATE openrouter_calls SET status = ?, cost_usd = ?, finished_at = ? WHERE id = ?').run(status, cost, Date.now(), id);
  },

  setOpenrouterCallPath(this: Store, id: number, path: string) {
    this.db.prepare('UPDATE openrouter_calls SET path = ? WHERE id = ?').run(path, id);
  },

  /** At boot, calls still pending died with the last server: they may have been billed, so they count at their estimate. */
  sweepOpenrouterCalls(this: Store) {
    this.db.prepare(`UPDATE openrouter_calls SET status = 'unknown', finished_at = ? WHERE status = 'pending'`).run(Date.now());
  },
};
