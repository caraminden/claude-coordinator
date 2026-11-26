// Claims (#921): a single-holder duty kept as a row, not a note in a Taskmaster's memory. The pipeline lane
// ("one minion at a time changes the land and deploy pipeline") is the first; any duty a scheme invents later
// uses the same three tools (claim, release, list_claims). Live state any Taskmaster in the scheme reads and
// takes, the Overlord's job once a scheme has one (specs/per-person-taskmasters-overlord.md).
import type { DatabaseSync } from 'node:sqlite';
import { HttpError } from './http.ts';

export const CLAIMS_SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  holder INTEGER NOT NULL,
  taken_by TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  since INTEGER NOT NULL,
  landed TEXT NOT NULL DEFAULT '',
  keep INTEGER NOT NULL DEFAULT 0,
  handed INTEGER NOT NULL DEFAULT 0,
  beside INTEGER NOT NULL DEFAULT 0,
  beside_since INTEGER NOT NULL DEFAULT 0,
  beside_handed INTEGER NOT NULL DEFAULT 0,
  beside_landed TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (project_id, name)
);
CREATE INDEX IF NOT EXISTS claims_holder ON claims(holder);
-- A claim's queue (#1334): the minions waiting for it, in order (pos), and those that held it this run (done_at
-- set), kept for the page's "N of M done" until the claim is free with nobody waiting.
CREATE TABLE IF NOT EXISTS claim_queue (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  ticket INTEGER NOT NULL,
  pos INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  done_at INTEGER,
  how TEXT,
  ready INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, name, ticket)
);
-- Each holder's time with a claim once it ends (#1334): the page's time estimate is their median.
CREATE TABLE IF NOT EXISTS claim_spans (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  holder INTEGER NOT NULL,
  since INTEGER NOT NULL,
  until INTEGER NOT NULL,
  how TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS claim_spans_name ON claim_spans(project_id, name, until);
`;

export interface Claim {
  project_id: number;
  /** A short slug, e.g. "pipeline-lane". */
  name: string;
  /** The ticket that holds it: a minion, or the Taskmaster that took it for itself. */
  holder: number;
  /** Who took it: the Taskmaster's turn person, or the person on the page. */
  taken_by: string;
  note: string;
  since: number;
  /** The commits its holder shipped while holding it that aren't live yet (#1985), with spaces between. */
  landed: string;
  /** 1: the holder's next live leaves it with the holder, who has another piece to ship (#1985). */
  keep: number;
  /** 1: its holder has handed a ship off while holding it, so it isn't skipped for being slow (#1985). */
  handed: number;
  /** The waiting minion shipping beside the holder (#1985), since when, whether it handed off, and what it shipped that isn't live yet; 0 for none. */
  beside: number;
  beside_since: number;
  beside_handed: number;
  beside_landed: string;
}

/** A queue row: waiting while done_at is null, else a past holder of this run. */
export interface QueueRow {
  ticket: number;
  pos: number;
  added_by: string;
  added_at: number;
  done_at: number | null;
  /** How a past holder's time ended; null while waiting. */
  how: SpanEnd | null;
  /** 1: it tried to hand its ship off and only the lane held it back (#1985). */
  ready: number;
}

/** How a holder's time ended: its ship went live (or it shipped and was dismissed), it was released, or it was dismissed without shipping. */
export type SpanEnd = 'live' | 'released' | 'dismissed';

/** Spans the estimate needs before it shows (the brief: hidden when history is thin), and how many recent ones it reads. */
export const ESTIMATE_MIN = 3;
const ESTIMATE_OF = 10;

/** "pipeline-lane", "release-train": lowercase words joined by hyphens, so two Taskmasters can't spell one duty two ways. */
export function claimName(raw: unknown): string {
  const name = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 40) throw new HttpError(400, 'A claim name is lowercase words joined by hyphens, at most 40 characters, e.g. pipeline-lane');
  return name;
}

export class Claims {
  private db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    // One commit, not one per table: a new database's setup is counted (test/db-setup.test.ts).
    db.exec(`BEGIN; ${CLAIMS_SCHEMA} COMMIT;`);
    // Here, not in MIGRATIONS (src/db.ts), which run before this table exists in a new database.
    const cols = (db.prepare('PRAGMA table_info(claims)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('landed')) db.exec("ALTER TABLE claims ADD COLUMN landed TEXT NOT NULL DEFAULT ''");
    if (!cols.includes('keep')) db.exec('ALTER TABLE claims ADD COLUMN keep INTEGER NOT NULL DEFAULT 0');
    // 1 for a claim held when this arrives: whether its holder handed off before wasn't recorded. take() sets its own.
    if (!cols.includes('handed')) db.exec('ALTER TABLE claims ADD COLUMN handed INTEGER NOT NULL DEFAULT 1');
    if (!cols.includes('beside'))
      db.exec("BEGIN; ALTER TABLE claims ADD COLUMN beside INTEGER NOT NULL DEFAULT 0; ALTER TABLE claims ADD COLUMN beside_since INTEGER NOT NULL DEFAULT 0; ALTER TABLE claims ADD COLUMN beside_handed INTEGER NOT NULL DEFAULT 0; ALTER TABLE claims ADD COLUMN beside_landed TEXT NOT NULL DEFAULT ''; COMMIT");
    const queued = (db.prepare('PRAGMA table_info(claim_queue)').all() as { name: string }[]).map((c) => c.name);
    if (!queued.includes('ready')) db.exec('ALTER TABLE claim_queue ADD COLUMN ready INTEGER NOT NULL DEFAULT 0');
  }

  list(projectId: number): Claim[] {
    return this.db.prepare('SELECT * FROM claims WHERE project_id = ? ORDER BY since, name').all(projectId) as unknown as Claim[];
  }

  /** Who waits for each held claim, and who holds it, in every scheme. */
  queued(): { ticket: number; holder: number }[] {
    return this.db.prepare('SELECT q.ticket, c.holder FROM claim_queue q JOIN claims c ON c.project_id = q.project_id AND c.name = q.name WHERE q.done_at IS NULL').all() as { ticket: number; holder: number }[];
  }

  get(projectId: number, name: string): Claim | undefined {
    return this.db.prepare('SELECT * FROM claims WHERE project_id = ? AND name = ?').get(projectId, name) as unknown as Claim | undefined;
  }

  /**
   * Take `name` for `holder`. Refused while another ticket holds it (the caller sees who); taking one
   * the same holder already has only updates its note, and `keep` when given. A new holder leaves the queue. Returns the row.
   */
  take(projectId: number, name: string, holder: number, takenBy: string, note = '', now = Date.now(), keep?: boolean): { claim: Claim; held?: Claim } {
    const held = this.get(projectId, name);
    if (held && held.holder !== holder) return { claim: held, held };
    if (held) this.db.prepare('UPDATE claims SET note = ? WHERE project_id = ? AND name = ?').run(note, projectId, name);
    else {
      this.db.prepare('INSERT INTO claims (project_id, name, holder, taken_by, note, since, handed) VALUES (?, ?, ?, ?, ?, ?, 0)').run(projectId, name, holder, takenBy, note, now);
      this.db.prepare('DELETE FROM claim_queue WHERE project_id = ? AND name = ? AND ticket = ? AND done_at IS NULL').run(projectId, name, holder);
    }
    if (keep !== undefined) this.db.prepare('UPDATE claims SET keep = ? WHERE project_id = ? AND name = ?').run(keep ? 1 : 0, projectId, name);
    return { claim: this.get(projectId, name)! };
  }

  /** `name`'s queue: this run's past holders by when they finished, then the waiting in order. */
  queue(projectId: number, name: string): QueueRow[] {
    return this.db.prepare('SELECT ticket, pos, added_by, added_at, done_at, how, ready FROM claim_queue WHERE project_id = ? AND name = ? ORDER BY done_at IS NULL, done_at, pos').all(projectId, name) as unknown as QueueRow[];
  }

  /** The tickets waiting for `name`, in order. */
  waiting(projectId: number, name: string): number[] {
    return this.queue(projectId, name)
      .filter((r) => r.done_at == null)
      .map((r) => r.ticket);
  }

  /**
   * Make `tickets` the waiting order for `name` (an empty list empties it). The holder is left out; one already
   * waiting keeps who added it and when. Past holders stay as they are.
   */
  setQueue(projectId: number, name: string, tickets: number[], by: string, now = Date.now()): void {
    const holder = this.get(projectId, name)?.holder;
    const order = [...new Set(tickets)].filter((t) => t !== holder);
    const had = new Map(
      this.queue(projectId, name)
        .filter((r) => r.done_at == null)
        .map((r) => [r.ticket, r]),
    );
    this.db.exec('BEGIN');
    try {
      this.db.prepare('DELETE FROM claim_queue WHERE project_id = ? AND name = ? AND done_at IS NULL').run(projectId, name);
      // A past holder queued again waits again.
      const drop = this.db.prepare('DELETE FROM claim_queue WHERE project_id = ? AND name = ? AND ticket = ?');
      const add = this.db.prepare('INSERT INTO claim_queue (project_id, name, ticket, pos, added_by, added_at, ready) VALUES (?, ?, ?, ?, ?, ?, ?)');
      order.forEach((t, pos) => {
        drop.run(projectId, name, t);
        add.run(projectId, name, t, pos, had.get(t)?.added_by ?? by, had.get(t)?.added_at ?? now, had.get(t)?.ready ?? 0);
      });
      this.dropBeside();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * End the holder's time with `name` (`how`) and give it to the one shipping beside it, else to the first waiting ticket,
   * which becomes the holder from `now`. With nobody waiting the claim is free and its run's rows go. What happened, or undefined when nobody held it.
   */
  passOn(projectId: number, name: string, how: SpanEnd, now = Date.now()): { from: Claim; to?: Claim } | undefined {
    const from = this.get(projectId, name);
    if (!from) return undefined;
    const next = from.beside || this.waiting(projectId, name)[0];
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO claim_spans (project_id, name, holder, since, until, how) VALUES (?, ?, ?, ?, ?, ?)').run(projectId, name, from.holder, from.since, now, how);
      if (next == null) {
        this.db.prepare('DELETE FROM claims WHERE project_id = ? AND name = ?').run(projectId, name);
        this.db.prepare('DELETE FROM claim_queue WHERE project_id = ? AND name = ?').run(projectId, name);
      } else {
        // One shipping beside it brings what it has shipped.
        this.move(projectId, name, next, now, from.beside ? from.beside_landed : '', from.beside_handed);
        this.db.prepare('DELETE FROM claim_queue WHERE project_id = ? AND name = ? AND ticket IN (?, ?)').run(projectId, name, next, from.holder);
        this.db.prepare('INSERT INTO claim_queue (project_id, name, ticket, pos, added_by, added_at, done_at, how) VALUES (?, ?, ?, -1, ?, ?, ?, ?)').run(projectId, name, from.holder, from.taken_by, from.since, now, how);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { from, ...(next != null && { to: this.get(projectId, name)! }) };
  }

  /** `name` is `holder`'s from `now`, with `landed` shipped and nothing else of the last holder's. */
  private move(projectId: number, name: string, holder: number, now: number, landed = '', handed = 0) {
    this.db.prepare("UPDATE claims SET holder = ?, note = '', since = ?, landed = ?, keep = 0, handed = ?, beside = 0, beside_since = 0, beside_handed = 0, beside_landed = '' WHERE project_id = ? AND name = ?").run(holder, now, landed, handed, projectId, name);
  }

  /** A claim's beside place goes with its ticket's place in the queue. */
  private dropBeside() {
    this.db.prepare("UPDATE claims SET beside = 0, beside_since = 0, beside_handed = 0, beside_landed = '' WHERE beside != 0 AND beside NOT IN (SELECT ticket FROM claim_queue q WHERE q.project_id = claims.project_id AND q.name = claims.name AND q.done_at IS NULL)").run();
  }

  /** `ticket`, waiting for `name`, could hand its ship off now but for the lane. False when it doesn't wait for it. */
  setReady(projectId: number, name: string, ticket: number): boolean {
    return !!this.db.prepare('UPDATE claim_queue SET ready = 1 WHERE project_id = ? AND name = ? AND ticket = ? AND done_at IS NULL').run(projectId, name, ticket).changes;
  }

  /** `holder` handed a ship off, its claim's or beside it: its claims aren't skipped past it. */
  handedOff(holder: number): void {
    this.db.prepare('UPDATE claims SET handed = 1 WHERE holder = ?').run(holder);
    this.db.prepare('UPDATE claims SET beside_handed = 1 WHERE beside = ?').run(holder);
  }

  /** The hand-off of `ticket`, let in beside a holder, was refused: it is told when the claim is its own. */
  besideRefused(ticket: number): void {
    this.db.prepare('UPDATE claims SET beside_handed = 0 WHERE beside = ?').run(ticket);
  }

  /**
   * Pass the holder `seen` over for `next`, a waiting ticket (#1985): `next` holds it, and the old holder waits first. No
   * span: its time isn't over. Undefined when it moved, was kept or handed off meanwhile, or `next` left the queue.
   */
  skip(seen: Claim, next: number, now = Date.now()): { from: Claim; to: Claim } | undefined {
    const c = this.get(seen.project_id, seen.name);
    if (!c || c.holder !== seen.holder || c.since !== seen.since || c.handed || c.landed || c.keep) return undefined;
    if (!this.waiting(c.project_id, c.name).includes(next)) return undefined;
    this.db.exec('BEGIN');
    try {
      this.move(c.project_id, c.name, next, now);
      this.db.prepare('UPDATE claim_queue SET pos = pos + 1 WHERE project_id = ? AND name = ? AND done_at IS NULL').run(c.project_id, c.name);
      this.db.prepare('DELETE FROM claim_queue WHERE project_id = ? AND name = ? AND ticket IN (?, ?)').run(c.project_id, c.name, next, c.holder);
      this.db.prepare('INSERT INTO claim_queue (project_id, name, ticket, pos, added_by, added_at) VALUES (?, ?, ?, 0, ?, ?)').run(c.project_id, c.name, c.holder, c.taken_by, c.since);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return { from: c, to: this.get(c.project_id, c.name)! };
  }

  /** `ticket`, waiting for `seen`, may ship beside its holder (#1985). False when one already does, or it moved or left the queue. */
  setBeside(seen: Claim, ticket: number, now = Date.now()): boolean {
    if (!this.waiting(seen.project_id, seen.name).includes(ticket)) return false;
    return !!this.db.prepare('UPDATE claims SET beside = ?, beside_since = ? WHERE project_id = ? AND name = ? AND holder = ? AND since = ? AND beside = 0').run(ticket, now, seen.project_id, seen.name, seen.holder, seen.since).changes;
  }

  /** The claim `ticket` may ship beside the holder of, if any. */
  besideOf(projectId: number, ticket: number): Claim | undefined {
    return this.db.prepare('SELECT * FROM claims WHERE project_id = ? AND beside = ?').get(projectId, ticket) as unknown as Claim | undefined;
  }

  /** `holder` shipped `commit`: kept on each claim it holds or ships beside the holder of, until that is live (holderLive) or the claim moves. */
  shipped(holder: number, commit: string): void {
    // Once per commit: a hand-off picked up again after a restart reports its ship again.
    for (const [who, what] of [
      ['holder', 'landed'],
      ['beside', 'beside_landed'],
    ])
      this.db.prepare(`UPDATE claims SET ${what} = trim(${what} || ' ' || ?1) WHERE ${who} = ?2 AND instr(' ' || ${what} || ' ', ' ' || ?1 || ' ') = 0`).run(commit, holder);
  }

  /** The claims whose holder, or the one beside it, shipped something not seen live yet, in every scheme. */
  shippedClaims(): Claim[] {
    return this.db.prepare("SELECT * FROM claims WHERE landed != '' OR beside_landed != '' ORDER BY project_id, name").all() as unknown as Claim[];
  }

  /**
   * The commits `live` of the claim as it was `seen` are live (#1985): it passes on, its holder open or not. A kept one
   * stays through the first of them, once. Undefined when it stayed, or moved since it was seen.
   */
  holderLive(seen: Claim, live: string[], now = Date.now()): { from: Claim; to?: Claim } | undefined {
    const c = this.get(seen.project_id, seen.name);
    if (!c || c.holder !== seen.holder || c.since !== seen.since) return undefined;
    const ships = c.landed.split(' ').filter(Boolean);
    const left = ships.filter((l) => !live.includes(l));
    const went = ships.length - left.length;
    if (!went) return undefined;
    if (!c.keep || went > 1) return this.passOn(c.project_id, c.name, 'live', now);
    this.db.prepare('UPDATE claims SET landed = ?, keep = 0 WHERE project_id = ? AND name = ?').run(left.join(' '), c.project_id, c.name);
    return undefined;
  }

  /**
   * The one beside the holder of `seen` shipped, and the commits `live` are live: its turn is over, its time from when it
   * was let in. False when nothing of its was live, or it isn't beside it now.
   */
  besideLive(seen: Claim, live: string[], now = Date.now()): boolean {
    const c = this.get(seen.project_id, seen.name);
    if (!c?.beside || c.beside !== seen.beside || !c.beside_landed.split(' ').some((l) => live.includes(l))) return false;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO claim_spans (project_id, name, holder, since, until, how) VALUES (?, ?, ?, ?, ?, ?)').run(c.project_id, c.name, c.beside, c.beside_since, now, 'live');
      this.db.prepare('UPDATE claim_queue SET pos = -1, done_at = ?, how = ? WHERE project_id = ? AND name = ? AND ticket = ?').run(now, 'live', c.project_id, c.name, c.beside);
      this.dropBeside();
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return true;
  }

  /** Free `name`, whoever holds it (every member decides alike), passing it to the first waiting. The row it was, or undefined if nobody held it. */
  release(projectId: number, name: string, now = Date.now()): Claim | undefined {
    return this.passOn(projectId, name, 'released', now)?.from;
  }

  /**
   * `ticket` was dismissed or deleted: it leaves every queue it waits in, and each claim it holds passes on as `how`.
   * What passed, per claim.
   */
  releaseHeldBy(holder: number, how: SpanEnd = 'dismissed', now = Date.now()): { from: Claim; to?: Claim }[] {
    this.db.prepare('DELETE FROM claim_queue WHERE ticket = ? AND done_at IS NULL').run(holder);
    this.dropBeside();
    const rows = this.db.prepare('SELECT * FROM claims WHERE holder = ? ORDER BY name').all(holder) as unknown as Claim[];
    return rows.flatMap((c) => this.passOn(c.project_id, c.name, how, now) ?? []);
  }

  /**
   * The median time a holder kept `name`, over its last few finished holders, or null with fewer than ESTIMATE_MIN:
   * the page hides its estimate then. Dismissed holders don't count: they say nothing about how long the work takes.
   */
  estimate(projectId: number, name: string): { median: number; of: number } | null {
    const spans = (this.db.prepare("SELECT until - since AS ms FROM claim_spans WHERE project_id = ? AND name = ? AND how != 'dismissed' ORDER BY until DESC LIMIT ?").all(projectId, name, ESTIMATE_OF) as { ms: number }[]).map((r) => r.ms).sort((a, b) => a - b);
    if (spans.length < ESTIMATE_MIN) return null;
    const mid = spans.length >> 1;
    return { median: spans.length % 2 ? spans[mid] : (spans[mid - 1] + spans[mid]) / 2, of: spans.length };
  }
}
