// A person's saved views, and push: browsers' Web Push subscriptions and phones' FCM tokens (#1313: src/db.ts by area).
import type { PushSubscriptionRow, SavedView, Store } from '../db.ts';

export const pushQueries = {
  listViews(this: Store, projectId: number, owner: string): SavedView[] {
    const rows = this.db.prepare('SELECT * FROM person_views WHERE project_id = ? AND owner = ? ORDER BY name COLLATE NOCASE').all(projectId, owner) as any[];
    return rows.map((r) => ({ ...r, picks: JSON.parse(r.picks) }));
  },

  /** Save the picks under a name; saving under a name this person already has replaces that view. */
  saveView(this: Store, projectId: number, owner: string, name: string, picks: SavedView['picks']) {
    this.db
      .prepare('INSERT INTO person_views (project_id, owner, name, picks, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project_id, owner, name) DO UPDATE SET picks = excluded.picks, created_at = excluded.created_at')
      .run(projectId, owner, name, JSON.stringify(picks), Date.now());
  },

  deleteView(this: Store, projectId: number, owner: string, id: number): boolean {
    return this.db.prepare('DELETE FROM person_views WHERE project_id = ? AND owner = ? AND id = ?').run(projectId, owner, id).changes > 0;
  },

  /** A phone's FCM token for a person and contraption (#1138); a token seen before moves here and is fresh again. */
  savePushDevice(this: Store, contraptionId: number, userId: number, token: string, platform: string) {
    const now = Date.now();
    this.db.prepare(`INSERT INTO contraption_push_devices (token, contraption_id, user_id, platform, created_at, seen_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET contraption_id = excluded.contraption_id, user_id = excluded.user_id, platform = excluded.platform, seen_at = excluded.seen_at`)
      .run(token, contraptionId, userId, platform, now, now);
  },

  /** Forget a phone: a dead token, or (with userId) a person's own phone signing out. */
  deletePushDevice(this: Store, token: string, userId: number | null = null) {
    this.db.prepare('DELETE FROM contraption_push_devices WHERE token = ? AND (? IS NULL OR user_id = ?)').run(token, userId, userId);
  },

  /** The tokens of these people's phones for a contraption. */
  pushDevices(this: Store, contraptionId: number, userIds: number[]): string[] {
    if (!userIds.length) return [];
    return (this.db.prepare(`SELECT token FROM contraption_push_devices WHERE contraption_id = ? AND user_id IN (${userIds.map(() => '?').join(', ')}) ORDER BY id`)
      .all(contraptionId, ...userIds) as { token: string }[]).map((r) => r.token);
  },

  listPushSubscriptions(this: Store): PushSubscriptionRow[] {
    return this.db.prepare('SELECT * FROM push_subscriptions ORDER BY id').all() as unknown as PushSubscriptionRow[];
  },

  getPushSubscription(this: Store, endpoint: string): PushSubscriptionRow | undefined {
    return this.db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as unknown as PushSubscriptionRow | undefined;
  },

  /** Save a browser's subscription for `name`; a browser someone else signed in on before becomes theirs. */
  savePushSubscription(this: Store, name: string, endpoint: string, p256dh: string, auth: string): PushSubscriptionRow {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (name, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth,
           muted = CASE WHEN name = excluded.name THEN muted ELSE '[]' END,
           only_pinned = CASE WHEN name = excluded.name THEN only_pinned ELSE 0 END,
           everything = CASE WHEN name = excluded.name THEN everything ELSE '[]' END, name = excluded.name`,
      )
      .run(name, endpoint, p256dh, auth, Date.now());
    return this.getPushSubscription(endpoint)!;
  },

  setPushMuted(this: Store, endpoint: string, muted: number[]) {
    this.db.prepare('UPDATE push_subscriptions SET muted = ? WHERE endpoint = ?').run(JSON.stringify(muted), endpoint);
  },

  setPushEverything(this: Store, endpoint: string, projectIds: number[]) {
    this.db.prepare('UPDATE push_subscriptions SET everything = ? WHERE endpoint = ?').run(JSON.stringify(projectIds), endpoint);
  },

  setPushOnlyPinned(this: Store, endpoint: string, onlyPinned: boolean) {
    this.db.prepare('UPDATE push_subscriptions SET only_pinned = ? WHERE endpoint = ?').run(onlyPinned ? 1 : 0, endpoint);
  },

  deletePushSubscription(this: Store, endpoint: string) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  },
};
