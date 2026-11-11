// The down-alert watchdog (#302): tools/watchdog.ts runs this every 5 minutes from a user timer
// (deploy/citadel-watchdog.timer). It checks Citadel's unit and /api/health, and each contraption's
// enabled citadel-app-<name>.service and its health path (or port). Once one has been down for the
// threshold it web-pushes every admin, and a contraption's home-scheme owner (see recipients), straight from here, since Citadel (and Mandate) may be the thing
// that's down, and again when it's back. It reads the database read-only and never restarts anything:
// that's systemd's job (Restart=always).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { MANIFEST, parseManifest, unitName } from './app-services.ts';
import type { PushMessage } from './push.ts';

/** Something to watch: a unit, and how to ask it whether it answers. */
export interface Target {
  key: string;
  title: string;
  unit: string;
  /** An http URL that must answer 2xx, or a port that must take a connection. */
  probe: { url: string } | { port: number };
  /** Contraptions are only watched while their unit is enabled; Citadel always. */
  always: boolean;
}

/** What one check found: null when it's up, or why it isn't, in a few words. */
export type Finding = string | null;

export interface Entry {
  title: string;
  /** When a check first found it down. */
  since: number;
  why: string;
  /** Whether the down push went out. */
  alerted: boolean;
  /** When an alerted one was found up again (or stopped being watched), until the all-clear goes out. */
  upAt?: number;
  /** How long it was down, once known. */
  upWhy?: string;
}

export type WatchState = Record<string, Entry>;

// Timers fire a few seconds late or early; without this a 10-minute threshold could slip to the 15-minute check.
const SLACK_MS = 60_000;

const mins = (ms: number) => `${Math.max(1, Math.round(ms / 60_000))} min`;

/**
 * Fold one round of findings (key → Finding, for every target watched now) into the state. Returns the
 * state to save if the push goes out (`sent`), the one to save if it doesn't (`unsent`, so the next run
 * tries again), and the push for someone who hears about the keys in `only` (everything when null), or
 * null when there's nothing new to tell them.
 */
export function step(prev: WatchState, found: Map<string, { title: string; finding: Finding }>, now: number, thresholdMs: number): { messageFor: (only: Set<string> | null) => PushMessage | null; sent: WatchState; unsent: WatchState } {
  const unsent: WatchState = {};
  for (const [key, { title, finding }] of found) {
    const was = prev[key];
    if (finding) unsent[key] = { ...(was ?? { since: now, alerted: false }), title, why: finding, upAt: undefined, upWhy: undefined };
    else if (was?.alerted) unsent[key] = { ...was, title, upAt: was.upAt ?? now, upWhy: was.upWhy ?? 'back up' };
  }
  // One that was alerted and isn't watched any more (its unit disabled, the contraption removed) gets an all-clear too.
  for (const [key, was] of Object.entries(prev)) {
    if (!found.has(key) && was.alerted) unsent[key] = { ...was, upAt: was.upAt ?? now, upWhy: was.upWhy ?? 'no longer watched' };
  }
  const entries = Object.entries(unsent);
  const fresh = entries.filter(([, e]) => !e.upAt && !e.alerted && now - e.since >= thresholdMs - SLACK_MS);
  const back = entries.filter(([, e]) => e.upAt);
  const sent: WatchState = Object.fromEntries(entries.filter(([, e]) => !e.upAt).map(([k, e]) => [k, fresh.some(([f]) => f === k) ? { ...e, alerted: true } : e]));
  const messageFor = (only: Set<string> | null): PushMessage | null => {
    const theirs = <T>(list: [string, T][]) => (only ? list.filter(([k]) => only.has(k)) : list);
    const [newDown, newBack] = [theirs(fresh), theirs(back)];
    if (!newDown.length && !newBack.length) return null;
    const down = theirs(Object.entries(sent)).filter(([, e]) => e.alerted).map(([, e]) => e);
    const parts: string[] = [];
    if (down.length) parts.push(`Down: ${down.map((e) => `${e.title} ${mins(now - e.since)} (${e.why})`).join(', ')}.`);
    if (newBack.length) parts.push(`${down.length ? 'Back' : 'All back'}: ${newBack.map(([, e]) => `${e.title} (${e.upWhy} after ${mins(e.upAt! - e.since)})`).join(', ')}.`);
    const title = newDown.length ? `${newDown.map(([, e]) => e.title).join(', ')} down` : `${newBack.map(([, e]) => e.title).join(', ')} back up`;
    // An all-clear replaces the down push without ringing: Web Push can't take a notification away without showing one.
    return { title, body: parts.join(' '), tag: 'citadel-watchdog', url: '/c/', ...(newDown.length ? {} : { silent: true }) };
  };
  return { messageFor, sent, unsent };
}

/** Citadel, then every contraption, from the database. */
export function targets(db: DatabaseSync, home: string, citadelPort = 8573): Target[] {
  const rows = db.prepare('SELECT name, title, port, folder FROM contraptions ORDER BY name').all() as { name: string; title: string; port: number; folder: string | null }[];
  return [
    { key: 'citadel', title: 'Citadel', unit: 'claude-coordinator.service', probe: { url: `http://127.0.0.1:${citadelPort}/api/health` }, always: true },
    ...rows.map((r): Target => {
      const folder = r.folder ? (r.folder.startsWith('~/') ? join(home, r.folder.slice(2)) : r.folder) : join(home, 'apps', r.name);
      let health: string | null = null;
      try {
        health = parseManifest(readFileSync(join(folder, MANIFEST), 'utf8')).health;
      } catch {} // no manifest or a broken one: an open port has to do
      return { key: `app:${r.name}`, title: r.title || r.name, unit: `${unitName(r.name)}.service`, probe: health ? { url: `http://127.0.0.1:${r.port}${health}` } : { port: r.port }, always: false };
    }),
  ];
}

export interface Recipient {
  name: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The target keys this device hears about; null for everything. */
  only: Set<string> | null;
}

/**
 * Who hears (Josh on #302, 2026-11-04): every admin's devices, about everything ("Every admin"); and a
 * contraption's owner, the owner of its home scheme, about that contraption, while they have Mandate on
 * and a Citadel push subscription ("if they have mandate and alerts on"). Devices go by user name, as
 * push_subscriptions keeps them.
 */
export function recipients(db: DatabaseSync): Recipient[] {
  const admins = db.prepare(`SELECT name, endpoint, p256dh, auth FROM push_subscriptions
    WHERE name COLLATE NOCASE IN (SELECT name FROM users WHERE admin = 1 AND disabled_at IS NULL) ORDER BY id`).all() as any[];
  const owners = db.prepare(`SELECT s.name, s.endpoint, s.p256dh, s.auth, 'app:' || c.name AS key FROM contraptions c
    JOIN projects p ON p.id = c.home_scheme JOIN users u ON u.id = p.owner_id
    JOIN push_subscriptions s ON s.name = u.name COLLATE NOCASE
    WHERE u.admin = 0 AND u.disabled_at IS NULL AND EXISTS (SELECT 1 FROM contraption_users cu
      JOIN contraptions m ON m.id = cu.contraption_id WHERE m.name = 'mandate' AND cu.user_id = u.id)
    ORDER BY s.id, c.name`).all() as any[];
  const out: Recipient[] = admins.map((s) => ({ ...s, only: null }));
  const byDevice = new Map<string, Recipient>();
  for (const { key, ...s } of owners) {
    const r = byDevice.get(s.endpoint) ?? (out.push({ ...s, only: new Set() }), out.at(-1)!);
    byDevice.set(s.endpoint, r);
    r.only!.add(key);
  }
  return out;
}

export interface UnitState {
  active: string;
  enabled: string;
}

export function unitState(unit: string, systemctl = 'systemctl'): Promise<UnitState> {
  return new Promise((ok, fail) => execFile(systemctl, ['--user', 'show', unit, '-p', 'ActiveState', '-p', 'UnitFileState'], { timeout: 15_000 }, (err, out) => {
    if (err) return fail(new Error(`systemctl show ${unit}: ${err.message}`));
    const v = Object.fromEntries(String(out).split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)));
    ok({ active: v.ActiveState ?? 'unknown', enabled: v.UnitFileState ?? '' });
  }));
}

/** Null when it answers within `ms`, else why not. */
export async function answer(probe: Target['probe'], ms = 5000): Promise<Finding> {
  if ('url' in probe) {
    const path = new URL(probe.url).pathname;
    try {
      const res = await fetch(probe.url, { signal: AbortSignal.timeout(ms) });
      await res.body?.cancel();
      return res.ok ? null : `${path} answered ${res.status}`;
    } catch (err: any) {
      return err?.name === 'TimeoutError' ? `${path} not answering` : `${path} refused`;
    }
  }
  return new Promise((ok) => {
    const sock = connect({ host: '127.0.0.1', port: probe.port, timeout: ms });
    const done = (why: Finding) => (sock.destroy(), ok(why));
    sock.once('connect', () => done(null)).once('timeout', () => done(`port ${probe.port} not answering`)).once('error', () => done(`port ${probe.port} closed`));
  });
}

/** Check every target: its unit first (a stopped one isn't worth a probe), then whether it answers. Contraptions whose unit isn't enabled are left out. */
export async function check(list: Target[], deps = { unitState, answer }): Promise<Map<string, { title: string; finding: Finding }>> {
  const found = new Map<string, { title: string; finding: Finding }>();
  await Promise.all(list.map(async (t) => {
    // A wedged user bus mustn't silence the rest: without a unit state, whether it answers decides.
    const u = await deps.unitState(t.unit).catch((err: Error) => (console.error(err.message), null));
    if (u && !t.always && u.enabled !== 'enabled') return;
    const finding = u && u.active !== 'active' ? u.active : await deps.answer(t.probe);
    found.set(t.key, { title: t.title, finding });
  }));
  return found;
}
