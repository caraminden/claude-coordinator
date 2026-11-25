// Frozen ships and checks (#1881). A ship in the line (tools/deploy-queue.sh's queue/, a scheme's <.git>/land-queue) or a
// check holding a heavy slot (tools/citadel-heavy) can sit in a cgroup somebody froze with `systemctl freeze`: its process
// stays in state S, so the line only ever said "waiting". On 2026-11-24 at 17:02:36 PST 16 ship units were frozen for 20 minutes
// and nothing said so. The line's readers (src/waits.ts) ask `frozenOf` for each process they list; what it finds shows on the
// Releases page and in the minion's wait, and `FrozenShips` records each freeze and thaw as health events and, past
// ALERT_MS, raises one Mandate item for the scheme's owner that clears when it thaws.
// What this can't see: who ran the freeze (the kernel keeps no freezer), or when, to the second: `since` is when Citadel
// first saw the cgroup frozen. Citadel's own code freezes no unit, so every freeze seen here came from outside it.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Project, Store, User } from './db.ts';
import { every, type Job } from './every.ts';
import { CGROUP_ROOT } from './host-signals.ts';
import { pacificStamp } from './pacific.ts';

/** How long a ship stays frozen before it raises an alert (Josh's brief: "over 5 minutes"). */
export const ALERT_MS = 5 * 60_000;
/** A freeze known to be on purpose waits this long before it alerts. Nothing in Citadel freezes a unit, so nothing marks one yet. */
export const ON_PURPOSE_ALERT_MS = 60 * 60_000;
/** A sighting not renewed this long means the line stopped listing it (it thawed, ended or was stopped). */
const GONE_MS = 3 * 60_000;
const POLL_MS = 60_000;
export const FROZEN_KEY = 'frozen-ships';

export interface Frozen {
  /** The cgroup's own name: `land-1881.service`. */
  unit: string;
  /** When Citadel first saw it frozen, ms. */
  since: number;
  /** The command that thaws it. */
  thaw: string;
}

// The roots are read on each call, so a test points them at a fixture (as the shell's DEPLOY_QUEUE_CGROUP does).
const procDir = () => process.env.CITADEL_PROC_DIR ?? '/proc';
const cgroupDir = () => process.env.CITADEL_CGROUP_DIR ?? CGROUP_ROOT;

/** The cgroup path in a /proc/<pid>/cgroup text (`0::/user.slice/…/x.service`), or null. */
const cgroupOf = (text: string | null) =>
  text
    ?.split('\n')
    .find((l) => l.startsWith('0::'))
    ?.slice(3) || null;
const frozenIn = (events: string | null) => /^frozen 1$/m.test(events ?? '');

/** The thaw command for a cgroup path: a unit under a user manager is thawed with --user. */
function thawFor(cg: string): string {
  return `systemctl${/\/user@\d+\.service\//.test(cg) ? ' --user' : ''} thaw ${basename(cg)}`;
}

/** The frozen cgroups the last async probe found, by process: what the sync readers use, so they read no file. */
const frozenPids = new Map<number, string>();

/** Process `pid`'s frozen cgroup as the last `frozenCgroup(pid)` found it, or null (no file is read here). */
export function frozenCached(pid: number): { cg: string } | null {
  const cg = frozenPids.get(pid);
  return cg ? { cg } : null;
}

/** Process `pid`'s frozen cgroup, or null while it isn't in one; remembered for frozenCached. */
export async function frozenCgroup(pid: number): Promise<{ cg: string } | null> {
  let cg: string | null = null;
  try {
    cg = cgroupOf(await readFile(`${procDir()}/${pid}/cgroup`, 'utf8'));
    if (cg && !frozenIn(await readFile(`${cgroupDir()}${cg}/cgroup.events`, 'utf8'))) cg = null;
  } catch {
    cg = null;
  }
  if (cg) frozenPids.set(pid, cg);
  else frozenPids.delete(pid);
  return cg ? { cg } : null;
}

/** One sighting kept: a frozen process in a line, by its cgroup and label. */
interface Seen extends Frozen {
  label: string;
  /** The last time a reader saw it frozen. */
  at: number;
  /** A freeze known to be on purpose (see ON_PURPOSE_ALERT_MS). */
  onPurpose?: boolean;
}
const seen = new Map<string, Seen>();

/** A reader saw `label`'s process frozen in `cg`: when Citadel first saw it, and the unit and the thaw command. Marks the sighting as current. */
export function noteFrozen(label: string, cg: string, now = Date.now()): Frozen {
  const key = `${cg}\n${label}`;
  const was = seen.get(key);
  const s: Seen = { label, unit: basename(cg), thaw: thawFor(cg), since: was?.since ?? now, at: now, ...(was?.onPurpose && { onPurpose: true }) };
  seen.set(key, s);
  return { unit: s.unit, since: s.since, thaw: s.thaw };
}

/** The sightings kept, for a restart to carry (the 5-minute clock must not reset). */
export const dumpFrozen = () => Object.fromEntries(seen);
export function loadFrozen(saved: Record<string, Seen> | undefined) {
  for (const [k, v] of Object.entries(saved ?? {})) if (!seen.has(k) && v?.since) seen.set(k, v);
}
export function resetFrozen() {
  seen.clear();
  frozenPids.clear();
}

/** "frozen since Nov 24, 5:02 PM PST": the text that replaces "waiting" in the line. */
export const frozenWords = (f: Frozen) => `frozen since ${pacificStamp(f.since)} (first seen by Citadel); thaw it with: ${f.thaw}`;
/** The same, short, for a chip. */
export const frozenChip = (f: Frozen) => `frozen since ${pacificStamp(f.since).replace(/^\w+ \d+, /, '')}`;

type Sender = Pick<Project, 'id' | 'name'>;

export interface FrozenDeps {
  /** Put (with `title`) or clear (null) a person's Mandate alert item; true once Mandate has it settled. */
  mandate: (from: Sender, person: User, key: string, title: string | null, link?: string) => Promise<boolean>;
  /** The scheme a line label's minion belongs to (waits.ts's labelTicket), or null. */
  schemeOf: (label: string) => Sender | null;
  /** The scheme a label with no minion goes to: the one this server runs. */
  fallback: () => Sender | null;
  /** Read every line and the heavy folder afresh (the async readers probe each process), so a freeze or a thaw is noticed with no page open. */
  scan?: () => Promise<void>;
  now?: () => number;
}

/** What a freeze has done so far, by sighting key: kept in settings so a restart doesn't repeat a record or reset the clock. */
interface State {
  recorded: boolean;
  from?: Sender;
  mandateKey?: string;
  users: number[];
}

/**
 * Records each frozen ship's freeze and thaw as health events ('ship-frozen', 'ship-thawed': the unit, the label, when
 * Citadel first saw it, and how long it lasted) and raises one Mandate item for the scheme owner past ALERT_MS, cleared
 * once it thaws or its ship is gone. Reads only what the line's readers have already noted; it freezes and thaws nothing.
 */
export class FrozenShips {
  private store: Store;
  private d: FrozenDeps;
  private state: Record<string, State>;
  private busy = false;
  private timer: Job | null = null;

  constructor(store: Store, d: FrozenDeps) {
    this.store = store;
    this.d = d;
    const saved = store.getSetting<{ seen?: Record<string, Seen>; state?: Record<string, State> }>(FROZEN_KEY);
    loadFrozen(saved?.seen);
    this.state = saved?.state ?? {};
  }

  start() {
    this.timer ??= every('frozen ships', POLL_MS, () => this.tick());
  }

  stop() {
    this.timer?.stop();
    this.timer = null;
  }

  private sender(label: string): Sender | null {
    return this.d.schemeOf(label) ?? this.d.fallback();
  }

  /** The scheme's owner, if their Mandate is on: the person a freeze in that scheme's line is for. */
  private owner(from: Sender): User | null {
    const o = this.store.getProject(from.id)?.owner_id;
    const u = o == null ? null : this.store.getUser(o);
    return u && !u.disabled_at && this.store.contraptionEnabled('mandate', u.id) ? u : null;
  }

  async tick(now = (this.d.now ?? Date.now)()) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.d.scan?.().catch((err) => console.warn(`Looking for frozen ships failed: ${err.message}`));
      for (const [key, s] of [...seen]) {
        const st = (this.state[key] ??= { recorded: false, users: [] });
        if (now - s.at > GONE_MS) {
          await this.thawed(key, s, st, now);
          continue;
        }
        if (!st.recorded) {
          this.store.addHealthEvent('ship-frozen', now, null, `${s.label}: ${s.unit} frozen since ${pacificStamp(s.since)} (first seen by Citadel; who froze it isn't recorded anywhere). Thaw: ${s.thaw}`);
          st.recorded = true;
        }
        if (now - s.since >= (s.onPurpose ? ON_PURPOSE_ALERT_MS : ALERT_MS)) await this.alert(key, s, st);
      }
      this.store.setSetting(FROZEN_KEY, { seen: dumpFrozen(), state: this.state });
    } finally {
      this.busy = false;
    }
  }

  /** One item per freeze, for the scheme's owner; a person Mandate didn't answer for is tried again next round. */
  private async alert(key: string, s: Seen, st: State) {
    const from = (st.from ??= this.sender(s.label) ?? undefined);
    if (!from) return;
    st.mandateKey ??= `frozen.${s.unit}`.replace(/[^A-Za-z0-9._:-]+/g, '_').slice(0, 128);
    const owner = this.owner(from);
    if (!owner || st.users.includes(owner.id)) return;
    const title = `${s.label} is frozen: ${s.unit} since ${pacificStamp(s.since)} (first seen by Citadel). It waits until someone thaws it: ${s.thaw}`;
    if (await this.d.mandate(from, owner, st.mandateKey, title.slice(0, 500), `/c/#/p/${from.id}`)) st.users.push(owner.id);
  }

  /** Its ship left the line or thawed: the record, the alert cleared, the sighting dropped. */
  private async thawed(key: string, s: Seen, st: State, now: number) {
    if (st.from && st.mandateKey) {
      for (const uid of st.users) {
        const u = this.store.getUser(uid);
        if (u && !(await this.d.mandate(st.from, u, st.mandateKey, null))) return; // Mandate didn't answer: try again next round
      }
    }
    if (st.recorded) this.store.addHealthEvent('ship-thawed', now, null, `${s.label}: ${s.unit} thawed (or left the line) after ${Math.round((s.at - s.since) / 60_000)} min frozen, since ${pacificStamp(s.since)}`);
    seen.delete(key);
    delete this.state[key];
  }
}
