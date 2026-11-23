// Auto-deploy and the Deploy button (#629). Cara, 2026-11-12: "Yes, a few minutes after main moves, but also not
// just contraptions, mobile and desktop apps and everything else" and, for the release cards' button, "Yes, on any
// target that can deploy". A target whose kind has a Deployer deploys by itself, unless its scheme turned that off; any
// member of its scheme can deploy it at once from its card. One try per commit: a deploy that fails or rolls back isn't
// tried again by itself until main moves, so a broken commit can't redeploy on a loop.
// The wait (#1736), Cara, 2026-11-23: "maybe it would be better if we only wait if there are things in the deploy
// pipeline that are expected to come in soon?" and, on the card, "Wait only if more is coming" and "Same rule as web
// apps" (Android and desktop too, no 5-minute wait of their own): a target deploys on the tick after its head moved,
// unless a ship is waiting or landing in its scheme (shipping(); which target it touches isn't known, so any ship in
// the scheme counts); then it waits for it, at most MAX_WAIT_MS from when its head first moved.
import type { Store } from './db.ts';
import { HttpError } from './http.ts';
import type { Found, Kind } from './release-targets.ts';
import type { SchemeReleases, TargetView } from './releases.ts';
import type { LastGreen } from './last-green.ts';

/** The longest a target waits for ships still coming, counted from when its head first moved. */
export const MAX_WAIT_MS = 10 * 60_000;
/** { off: ["<projectId>/<target>", …], tried: { "<projectId>/<target>": sha } }: kept, as a Citadel restart forgets memory. */
const SETTING = 'auto-deploy';
/** Who an auto-deploy is by, as the deploy's log and the card say it. */
export const AUTO_BY = 'auto-deploy';

/** One kind of target's release step. */
export interface Deployer {
  /** Whether its next release waits on a deploy (and nothing is deploying it). */
  waits(t: Found, tv: Omit<TargetView, 'testCopies'>): boolean;
  /** The commit a deploy would ship now (its branch's head), or null when it can't tell. */
  head(t: Found): Promise<string | null>;
  /**
   * Start a deploy, by a person's name, a minion's '#N' or AUTO_BY; throws or rejects (an HttpError, a ServiceError) when it
   * can't start. May answer with a line on what it did.
   */
  start(t: Found, by: string, uid: number | null): void | string | Promise<void | string>;
}

/** What a target's card shows of its deploy: whether the button shows, auto-deploy on or off, and when it's due. */
export interface DeployInfo {
  /** A next release waits for a deploy and none is running: the Deploy button shows. */
  can: boolean;
  auto: boolean;
  /** When auto-deploy will start it (ms), or null: off, nothing waits, or this commit was tried already. */
  due: number | null;
  /** A ship is waiting or landing in its scheme, so `due` is the cap rather than the next tick. */
  more: boolean;
}

export interface AutoDeployDeps {
  store: Store;
  /** Every scheme's found targets (src/release-targets.ts). */
  targets: () => Found[];
  deployers: Partial<Record<Kind, Deployer>>;
  /** The release monitor's last read of every scheme. */
  view: () => SchemeReleases[];
  /** An auto-deploy that couldn't start: tell the target's home Taskmaster. */
  failed: (t: Found, why: string) => void;
  /** False where deploys can't run (a dev copy, a preview, a boot check): nothing deploys by itself there. */
  enabled?: () => boolean;
  /** Targets a Roll back to last green pinned (#1016): auto-deploy leaves them be, a person's deploy lets go, a minion's is refused. */
  held?: Pick<LastGreen, 'pinned' | 'unpin'>;
  /** Whether a ship is waiting in the scheme's line or landing (a hand-off running), so more may be coming. */
  shipping?: (projectId: number) => boolean;
  now?: () => number;
}

interface Saved {
  off: string[];
  tried: Record<string, string>;
}

const keyOf = (projectId: number, target: string) => `${projectId}/${target}`;

export class AutoDeploy {
  private d: AutoDeployDeps;
  /** Each waiting target's branch head, when the head was first seen waiting (`first`, the cap counts from it) and when it last moved. */
  private moved = new Map<string, { head: string; at: number; first: number }>();
  /** Targets whose start() hasn't settled (an APK downloading, say), so nothing starts them twice. */
  private starting = new Set<string>();
  /** Per scheme, whether ships were waiting or landing at the last tick. */
  private more = new Map<number, boolean>();
  constructor(d: AutoDeployDeps) {
    this.d = d;
  }

  private now = () => (this.d.now ?? Date.now)();

  private saved(): Saved {
    const s = this.d.store.getSetting<Partial<Saved>>(SETTING) ?? {};
    return { off: Array.isArray(s.off) ? s.off : [], tried: s.tried && typeof s.tried === 'object' ? s.tried : {} };
  }

  private save(s: Saved) {
    this.d.store.setSetting(SETTING, s);
  }

  private found(projectId: number, target: string): Found | undefined {
    return this.d.targets().find((t) => t.projectId === projectId && t.id === target);
  }

  /** Whether the target auto-deploys: on unless its scheme turned it off. */
  isOn(projectId: number, target: string): boolean {
    return !this.saved().off.includes(keyOf(projectId, target));
  }

  /** Turn a target's auto-deploy on or off; false when it has no release step to turn on. */
  setOn(projectId: number, target: string, on: boolean): boolean {
    const t = this.found(projectId, target);
    if (!t || !this.d.deployers[t.kind]) return false;
    const s = this.saved();
    const key = keyOf(projectId, target);
    s.off = on ? s.off.filter((k) => k !== key) : [...new Set([...s.off, key])];
    this.save(s);
    return true;
  }

  /** A target's deploy as its card shows it, or null when its kind has no release step Citadel can start. */
  info(tv: Omit<TargetView, 'testCopies'>): DeployInfo | null {
    const t = this.found(tv.target.projectId, tv.target.id);
    const deployer = t && this.d.deployers[t.kind];
    if (!t || !deployer) return null;
    const key = keyOf(t.projectId, t.id);
    const can = deployer.waits(t, tv) && !this.starting.has(key);
    const auto = this.isOn(tv.target.projectId, tv.target.id);
    const m = this.moved.get(key);
    const more = !!this.more.get(t.projectId); // as the last tick read it: info() runs on every poll, shipping() reads files
    const due = can && auto && m && this.saved().tried[key] !== m.head && !this.d.held?.pinned(t.projectId, t.id) ? (more ? m.first + MAX_WAIT_MS : m.at) : null;
    return { can, auto, due, more };
  }

  /** Deploy a target now (the card's button, publish_release), as a person or a minion. Throws what the deploy refused with; answers what start said. */
  async deployNow(projectId: number, target: string, by: string, uid: number | null): Promise<string | undefined> {
    const t = this.found(projectId, target);
    const deployer = t && this.d.deployers[t.kind];
    if (!t || !deployer) throw new HttpError(404, `${target} has no release step Citadel can start`);
    const key = keyOf(projectId, target);
    if (this.starting.has(key)) throw new HttpError(409, `${t.name} is being deployed already`);
    // A minion's deploy (by "#N", the land's deploy of its scheme's apps too) waits for the fix; a person's is the override.
    const pin = this.holding(projectId, target, t.name, by.startsWith('#'));
    // Held from here, before the first await, so two presses at once start one deploy.
    this.starting.add(key);
    try {
      const head = await deployer.head(t);
      // A person's deploy counts as this commit's try: if it rolls back, auto-deploy waits for main to move.
      if (head) this.mark(key, head);
      const said = (await deployer.start(t, by, uid)) ?? undefined;
      if (pin) this.d.held!.unpin(projectId, target);
      return said;
    } finally {
      this.starting.delete(key);
    }
  }

  /** A rolled-back target's pin (src/last-green.ts): an agent's deploy is refused until the fix; a person's goes ahead and, once started, lets go of it (unhold). */
  holding(projectId: number, target: string, name: string, agent: boolean) {
    const pin = this.d.held?.pinned(projectId, target) ?? null;
    if (pin && agent) throw new HttpError(409, `${name} was rolled back to last green ${pin.sha.slice(0, 9)} by ${pin.by}, and stays there until main has a newer commit that passes the full suite, then auto-deploy ships it. A person's Deploy on its Releases card ships main now.`);
    return pin;
  }

  unhold(projectId: number, target: string) {
    this.d.held?.unpin(projectId, target);
  }

  /** A scheme's Android target whose feed is contraption `name`'s, if it has one Citadel can release (publish_release). */
  apkOf(projectId: number, name: string): Found | undefined {
    return this.d.targets().find((t) => t.projectId === projectId && t.kind === 'apk' && t.contraption === name && !!this.d.deployers.apk);
  }

  /** The commit auto-deploy or the button last started a deploy for, or null. */
  triedAt(projectId: number, target: string): string | null {
    return this.saved().tried[keyOf(projectId, target)] ?? null;
  }

  private mark(key: string, head: string) {
    const s = this.saved();
    s.tried[key] = head;
    this.save(s);
  }

  /**
   * Note each waiting target's head, and start the deploys that are due: on, waiting, seen at this head on an earlier
   * tick, nothing shipping in its scheme or MAX_WAIT_MS since its head first moved, and not tried at that head yet. Called after each read of the release monitor's slow parts.
   */
  async tick() {
    if (this.d.enabled && !this.d.enabled()) return;
    const now = this.now();
    const waiting = new Set<string>();
    const shipping = new Map<number, boolean>();
    const all = this.d.targets();
    for (const s of this.d.view()) {
      for (const tv of s.targets) {
        const t = all.find((x) => x.projectId === tv.target.projectId && x.id === tv.target.id);
        const deployer = t && this.d.deployers[t.kind];
        if (!t || !deployer || !deployer.waits(t, tv)) continue;
        const key = keyOf(t.projectId, t.id);
        const head = await deployer.head(t);
        if (!head) continue;
        waiting.add(key);
        const m = this.moved.get(key);
        if (!shipping.has(t.projectId)) shipping.set(t.projectId, !!this.d.shipping?.(t.projectId));
        if (!m || m.head !== head) {
          // A head that was tried (failed, rolled back, pinned) spent its cap: the next one's counts from its own move.
          this.moved.set(key, { head, at: now, first: m && this.saved().tried[key] !== m.head ? m.first : now });
          continue;
        }
        if ((shipping.get(t.projectId) && now - m.first < MAX_WAIT_MS) || !this.isOn(t.projectId, t.id) || this.saved().tried[key] === head || this.starting.has(key) || this.d.held?.pinned(t.projectId, t.id)) continue;
        this.mark(key, head);
        this.moved.delete(key); // the next head starts a fresh cap
        waiting.delete(key);
        // Not awaited: a slow start (an APK downloading) mustn't hold up the other targets' checks.
        this.starting.add(key);
        void (async () => deployer.start(t, AUTO_BY, null))()
          .catch((err: any) => this.d.failed(t, err?.message ?? String(err)))
          .finally(() => this.starting.delete(key));
      }
    }
    this.more = shipping;
    for (const key of this.moved.keys()) if (!waiting.has(key)) this.moved.delete(key);
  }
}
