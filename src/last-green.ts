// Last green and the rollback hold (#1016, docs/adr/0010-roll-back-to-last-green.md). Each scheme's last green is the
// newest commit on its default branch where the newest run of every workflow on that commit passed; CI health reads
// every scheme's runs every 5 minutes and hands them here. It only ever moves forward. A Releases card's "Roll back to
// last green" deploys it and pins the target there (Cara, 2026-11-18: "Hold until the fix"): auto-deploy leaves a
// pinned target alone until main has a newer green commit than the one that was rolled back, or a person deploys it.
import { execFile } from 'node:child_process';
import type { Store } from './db.ts';

/** A workflow run as GitHub lists it: as much of src/ci-health.ts's Run as this reads. */
export interface GreenRun {
  head_sha: string;
  workflow_id: number;
  status: string;
  conclusion: string | null;
  created_at: string;
  /** Its workflow file, as ci_quiet lists it. */
  file: string;
}

/** A scheme's last green commit, and when Citadel first saw it green (ms). */
export interface Green {
  sha: string;
  at: number;
}

/** A target held at a rolled-back commit until the fix: `sha` what it went back to, `from` what ran before. */
export interface Pin {
  sha: string;
  from: string;
  at: number;
  by: string;
}

const PASSED = new Set(['success', 'skipped', 'neutral']);

/**
 * The commits these runs show green, newest first: every workflow's newest run on it completed and passed (a rerun's
 * verdict replaces the first one's), none still running, and at least one ran. Quiet workflows (a scheme's ci_quiet)
 * don't count either way.
 */
export function greenShas(runs: GreenRun[], quiet: Set<string> = new Set()): string[] {
  const newest = new Map<string, Map<number, GreenRun>>();
  for (const r of runs) {
    if (!r.head_sha || quiet.has(r.file)) continue;
    const byWorkflow = newest.get(r.head_sha) ?? newest.set(r.head_sha, new Map()).get(r.head_sha)!;
    const had = byWorkflow.get(r.workflow_id);
    if (!had || Date.parse(r.created_at) > Date.parse(had.created_at)) byWorkflow.set(r.workflow_id, r);
  }
  const green: { sha: string; at: number }[] = [];
  for (const [sha, byWorkflow] of newest) {
    const list = [...byWorkflow.values()];
    if (list.every((r) => r.status === 'completed' && PASSED.has(r.conclusion ?? '')) && list.some((r) => r.conclusion === 'success')) {
      green.push({ sha, at: Math.max(...list.map((r) => Date.parse(r.created_at))) });
    }
  }
  return green.sort((a, b) => b.at - a.at).map((g) => g.sha);
}

/** `git merge-base --is-ancestor a b` in `dir`: true, false, or null when git can't tell (a commit it doesn't have). */
export type Contains = (dir: string, ancestor: string, commit: string) => Promise<boolean | null>;

export const gitContains: Contains = (dir, ancestor, commit) => new Promise((done) => {
  execFile('git', ['merge-base', '--is-ancestor', ancestor, commit], { cwd: dir, timeout: 15_000 }, (err) => {
    done(!err ? true : (err as { code?: unknown }).code === 1 ? false : null);
  });
});

const GREEN = (projectId: number) => `last-green:${projectId}`;
const PINS = 'last-green:pins';
const keyOf = (projectId: number, target: string) => `${projectId}/${target}`;

export class LastGreen {
  private store: Store;
  private contains: Contains;
  private now: () => number;
  constructor(store: Store, contains: Contains = gitContains, now: () => number = Date.now) {
    this.store = store;
    this.contains = contains;
    this.now = now;
  }

  /** A scheme's last green, or null when CI hasn't shown one since this was built. */
  get(projectId: number): Green | null {
    return this.store.getSetting<Green>(GREEN(projectId)) ?? null;
  }

  /**
   * Take a scheme's newest runs: its newest green commit that its default branch (`ref`, in `repoDir`) holds becomes
   * last green when it is newer than the one kept (the kept one is in its history, or main no longer has it).
   * Then lets go of each of its pins that main has passed with a newer green commit.
   */
  async note(projectId: number, repoDir: string, ref: string, runs: GreenRun[], quiet?: Set<string>): Promise<Green | null> {
    const had = this.get(projectId);
    for (const sha of greenShas(runs, quiet)) {
      if (sha === had?.sha) break;
      if ((await this.contains(repoDir, sha, ref)) !== true) continue;
      // Older than the kept one (a late run on an earlier commit): last green never goes back.
      if (had && (await this.contains(repoDir, had.sha, sha)) !== true && (await this.contains(repoDir, had.sha, ref)) !== false) break;
      this.store.setSetting<Green>(GREEN(projectId), { sha, at: this.now() });
      break;
    }
    const green = this.get(projectId);
    if (green) await this.release(projectId, repoDir, green.sha);
    return green;
  }

  /** Every pin, by "<projectId>/<target>". */
  pins(): Record<string, Pin> {
    return this.store.getSetting<Record<string, Pin>>(PINS) ?? {};
  }

  pinned(projectId: number, target: string): Pin | null {
    return this.pins()[keyOf(projectId, target)] ?? null;
  }

  pin(projectId: number, target: string, pin: Omit<Pin, 'at'>) {
    this.store.setSetting(PINS, { ...this.pins(), [keyOf(projectId, target)]: { ...pin, at: this.now() } });
  }

  /** Let go of a target's pin (a person's deploy, a newer green commit); true when it had one. */
  unpin(projectId: number, target: string): boolean {
    const all = this.pins();
    const key = keyOf(projectId, target);
    if (!all[key]) return false;
    delete all[key];
    this.store.setSetting(PINS, all);
    return true;
  }

  /** A scheme's pins that `green` is newer than: it holds what was rolled back from, and is neither commit. */
  private async release(projectId: number, repoDir: string, green: string) {
    for (const [key, pin] of Object.entries(this.pins())) {
      if (!key.startsWith(`${projectId}/`) || green === pin.sha || green === pin.from) continue;
      if ((await this.contains(repoDir, pin.from, green)) === true) this.unpin(projectId, key.slice(key.indexOf('/') + 1));
    }
  }
}
