// Roll back to last green (#1016, docs/adr/0010-roll-back-to-last-green.md): the Releases card's button. A target
// whose kind can deploy a given commit goes back to its scheme's last green, and is pinned there until main has a
// newer green commit (src/last-green.ts; Cara, 2026-11-18: "Hold until the fix"). The card offers it only while what
// runs is newer than last green (Q2: "Last green only"); each kind's starter does the deploy and its own checks.
import { gitContains, type Contains, type LastGreen, type Pin } from './last-green.ts';
import { HttpError } from './http.ts';
import { CITADEL_TARGET, type TargetView } from './releases.ts';

/** What a card shows of it (TargetView.rollback). */
export interface RollbackInfo {
  /** Last green, the commit the button goes to. */
  sha: string;
  /** The button shows: what runs is newer than last green, and nothing is rolling back. */
  can: boolean;
  /** Pinned there by a roll back: what it went back from, who pressed it and when. */
  pin: Pin | null;
  /** A roll back is under way (a contraption's deploy, Citadel's deploy.sh --to). */
  running: boolean;
  /** The last roll back of this target that didn't go live, newest only, until the next one. */
  failed: { sha: string; at: number; why: string } | null;
}

/** One kind's roll back: start a deploy of `sha` (an older commit of its branch), or answer the existing build it holds
 * at (a CI package's). Throws what it refused with. */
export type Starter = (t: Omit<TargetView, 'testCopies'>, sha: string, by: string, uid: number | null) => void | Pick<Pin, 'build'> | Promise<void | Pick<Pin, 'build'>>;

export interface RollbackDeps {
  lastGreen: LastGreen;
  /** A scheme's clone, where last green and what runs are compared. */
  repoDir: (projectId: number) => string | null;
  /** By target kind: 'contraption', 'citadel-server', 'ci'. */
  starters: Record<string, Starter>;
  /**
   * The target whose roll back this one's is, by id in its scheme, or null for its own (ADR 0012, Q2 "Yes, together"):
   * an APK Citadel builds after each deploy follows its app, so its card's button is the app's.
   */
  follows?: (t: Omit<TargetView, 'testCopies'>) => string | null;
  /** Whether a target's roll back still runs (its deploy, its job). */
  running: (t: Omit<TargetView, 'testCopies'>) => boolean;
  /** Tell the target's scheme's Taskmaster. */
  tell: (projectId: number, text: string) => void;
  /** A git answer came in that changes what a card shows: read the releases again. */
  changed: () => void;
  get: <T>(key: string) => T | undefined;
  set: (key: string, value: unknown) => void;
  contains?: Contains;
  now?: () => number;
}

const FAILED = 'rollback:failed';
const keyOf = (projectId: number, target: string) => `${projectId}/${target}`;

export class Rollback {
  private d: RollbackDeps;
  /** "<dir> <green> <current>": whether green is older than what runs; absent while git hasn't answered. */
  private older = new Map<string, boolean>();
  private asking = new Set<string>();
  private starting = new Set<string>();
  constructor(d: RollbackDeps) {
    this.d = d;
  }

  private now = () => (this.d.now ?? Date.now)();
  private contains = (dir: string, a: string, b: string) => (this.d.contains ?? gitContains)(dir, a, b);
  private fails = () => this.d.get<Record<string, RollbackInfo['failed']>>(FAILED) ?? {};

  /** Green is in what runs' history and isn't it. Answers at once (a card's read): null until git has answered. */
  private isOlder(dir: string, green: string, current: string): boolean | null {
    if (green === current) return false;
    const key = `${dir} ${green} ${current}`;
    const had = this.older.get(key);
    if (had !== undefined) return had;
    if (!this.asking.has(key)) {
      this.asking.add(key);
      void this.contains(dir, green, current).then((yes) => {
        if (this.older.size > 500) this.older.clear();
        this.older.set(key, yes === true);
        this.asking.delete(key);
        this.d.changed();
      });
    }
    return null;
  }

  /** The target that rolls back for `tv` among `views` (its own, or the one it follows); null when that one isn't there. */
  private lead(tv: Omit<TargetView, 'testCopies'>, views: Omit<TargetView, 'testCopies'>[]) {
    const id = this.d.follows?.(tv);
    return !id ? tv : views.find((v) => v.target.projectId === tv.target.projectId && v.target.id === id) ?? null;
  }

  /** A target's card's roll back, or null when its kind can't, or its scheme has no last green yet. `views`: the
   * targets beside it, where one it follows is found. */
  info(of: Omit<TargetView, 'testCopies'>, views: Omit<TargetView, 'testCopies'>[] = [of]): RollbackInfo | null {
    const tv = this.lead(of, views);
    if (!tv) return null;
    const { projectId, id, kind } = tv.target;
    if (!this.d.starters[kind]) return null;
    const green = this.d.lastGreen.get(projectId);
    const dir = this.d.repoDir(projectId);
    if (!green || !dir) return null;
    const key = keyOf(projectId, id);
    const running = this.starting.has(key) || this.d.running(tv);
    const current = tv.current?.version;
    // Something else deployed over it (a land's deploy of the fix, a person's Deploy): the pin is over.
    let pin = this.d.lastGreen.pinned(projectId, id);
    if (pin && !running && current && current !== (pin.build?.sha ?? pin.sha) && current !== pin.from) {
      this.d.lastGreen.unpin(projectId, id);
      pin = null;
    }
    const can = !running && !!current && /^[0-9a-f]{40}$/.test(current) && this.isOlder(dir, green.sha, current) === true;
    return { sha: green.sha, can, pin, running, failed: this.fails()[key] ?? null };
  }

  /** The button: deploy last green now and pin the target there. Throws (an HttpError) when it can't. */
  async rollBack(of: Omit<TargetView, 'testCopies'>, by: string, uid: number | null, views: Omit<TargetView, 'testCopies'>[] = [of]): Promise<string> {
    const tv = this.lead(of, views);
    if (!tv) throw new HttpError(404, `${of.target.name} rolls back with its app, which isn't on the Releases page`);
    const { projectId, id, name, kind } = tv.target;
    const start = this.d.starters[kind];
    if (!start) throw new HttpError(404, `${name} can't roll back: only an app and Citadel's server can deploy an older commit`);
    const green = this.d.lastGreen.get(projectId);
    if (!green) throw new HttpError(409, `No commit on main has passed the full suite since Citadel started watching, so there's no last green to go back to.`);
    const key = keyOf(projectId, id);
    if (this.starting.has(key) || this.d.running(tv)) throw new HttpError(409, `${name} is deploying already: roll back once that has ended.`);
    const dir = this.d.repoDir(projectId);
    const from = tv.current?.version ?? '';
    if (!dir || !/^[0-9a-f]{40}$/.test(from) || (await this.contains(dir, green.sha, from)) !== true || from === green.sha) {
      throw new HttpError(409, `${name} runs ${from.slice(0, 7) || 'nothing Citadel can name'}, which isn't newer than last green ${green.sha.slice(0, 7)}: nothing to roll back.`);
    }
    // Pinned before it starts: a deploy that ends at once (or a restart of this server) still finds its pin.
    const had = this.d.lastGreen.pinned(projectId, id);
    this.d.lastGreen.pin(projectId, id, { sha: green.sha, from, by });
    this.starting.add(key);
    try {
      const held = await start(tv, green.sha, by, uid);
      if (held?.build) this.d.lastGreen.pin(projectId, id, { sha: green.sha, from, by, build: held.build });
    } catch (err) {
      if (had) this.d.lastGreen.pin(projectId, id, had);
      else this.d.lastGreen.unpin(projectId, id);
      throw err;
    } finally {
      this.starting.delete(key);
    }
    const fails = this.fails();
    if (fails[key]) {
      delete fails[key];
      this.d.set(FAILED, fails);
    }
    const holds = kind === CITADEL_TARGET
      ? `Until a fix deploys, tools/land.sh refuses lands that touch none of the files ${from.slice(0, 9)} changed; land the fix with LAND_FIX=1 (the land tool's fix: true) if it touches none of them either.`
      : kind === 'ci' ? `Its card shows last green's build as current and Citadel's CI store lists it as pinned (GET /api/projects/${projectId}/ci-files/pins), so an app whose updater reads the pins hands it out. It stays there until main has a newer commit that passes the full suite. Land the fix for what broke.`
      : `It stays there until main has a newer commit that passes the full suite (then auto-deploy ships it), or a person presses Deploy on its card; a minion's or Taskmaster's deploy of it is refused meanwhile. Land the fix for what broke.`;
    const also = of === tv ? '' : ` (from its ${of.target.name} card: its APK build follows the app, numbered one past the published one)`;
    this.d.tell(projectId, `${by} rolled ${name} back to last green ${green.sha.slice(0, 9)} from ${from.slice(0, 9)} on the Releases page${also}. ${holds}`);
    return green.sha;
  }

  /**
   * An app's deploy ended. While a target is pinned only its roll back's deploy runs (the rest are refused, or let go
   * of the pin first), so one that didn't go live is the roll back's, refused before it picked a commit too
   * (migrations changed, never deployed: `to` still null).
   */
  deployEnded(projectId: number, target: string, live: boolean, to: string | null, why: string) {
    const pin = this.d.lastGreen.pinned(projectId, target);
    if (!live && pin && (to ?? pin.sha) === pin.sha) this.failed(projectId, target, pin.sha, why);
  }

  /** A roll back's deploy of `sha` ended without going live: it went back to what ran, so let go of the pin and say why. */
  failed(projectId: number, target: string, sha: string, why: string) {
    const pin = this.d.lastGreen.pinned(projectId, target);
    if (pin?.sha !== sha) return;
    this.d.lastGreen.unpin(projectId, target);
    this.d.set(FAILED, { ...this.fails(), [keyOf(projectId, target)]: { sha, at: this.now(), why } });
    this.d.tell(projectId, `The roll back of ${target} to ${sha.slice(0, 9)} didn't go live, so it runs ${pin.from.slice(0, 9)} as before: ${why}`);
  }
}
