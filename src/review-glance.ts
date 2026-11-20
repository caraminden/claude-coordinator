// The Reviewers page at a glance (#1094): what a scheme's headline and the every-scheme table read. Where this month's
// changes fall that no critic of the scheme's own watches, how many closed minions a judge ran on, and the last run.
import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { fromFile, type ReviewEntry } from './review-set.ts';

const git = promisify(execFile);
const DAY = 86_400_000;
export const COVERAGE_DAYS = 30;

/** Tests and docs are left out of the hint: nobody wants a critic on them, so they'd crowd out the real gaps. */
export const isTestOrDoc = (p: string) => /(^|\/)(tests?|__tests__|specs?|docs?)\//.test(p) || /\.(test|spec)\.[^./]+$/.test(p) || /\.md$/i.test(p);

/** A folder a gap is named by: two levels deep where the path has them ("app/server"), else the top one. */
export const folderOf = (p: string) => {
  const parts = p.split('/');
  return parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length === 2 ? parts[0] : '(top)';
};

/** The critics of a scheme's own that watch a diff: on, written for the scheme (not the kit's, not a repo agent file), with diff globs. */
export const ownGlobs = (entries: ReviewEntry[]) => entries.filter((e) => e.enabled && !fromFile(e) && e.triggers.diff?.length).flatMap((e) => e.triggers.diff!);

export interface Coverage { changes: number; watched: number; gaps: { folder: string; changes: number }[] }

/** Each changed path (once per commit it changed in), less tests and docs, against the globs. Gaps: the unwatched folders, biggest first. */
export function coverage(paths: string[], globs: string[]): Coverage {
  const gaps = new Map<string, number>();
  let changes = 0, watched = 0;
  for (const p of paths) {
    if (isTestOrDoc(p)) continue;
    changes++;
    if (globs.some((g) => posix.matchesGlob(p, g))) watched++;
    else gaps.set(folderOf(p), (gaps.get(folderOf(p)) ?? 0) + 1);
  }
  return { changes, watched, gaps: [...gaps].map(([folder, n]) => ({ folder, changes: n })).sort((a, b) => b.changes - a.changes) };
}

// shortcut: one git log per repo every 10 minutes, kept in memory; a busy page reads the cached list.
const cache = new Map<string, { at: number; paths: Promise<string[] | null> }>();
/** The paths the repo's last 30 days of commits changed, or null with no repo or no git history. */
export function changedPaths(repoDir: string | null | undefined, now = Date.now()): Promise<string[] | null> {
  if (!repoDir) return Promise.resolve(null);
  const hit = cache.get(repoDir);
  if (hit && now - hit.at < 10 * 60_000) return hit.paths;
  const paths = git('git', ['-C', repoDir, 'log', `--since=${COVERAGE_DAYS}.days`, '--no-merges', '--format=', '--name-only'], { maxBuffer: 64 << 20 })
    .then(({ stdout }) => stdout.split('\n').filter(Boolean))
    .catch(() => null);
  cache.set(repoDir, { at: now, paths });
  return paths;
}

/** Minions closed in the last week and how many of them a judge recorded a run on; the scheme's last recorded run. */
export function judged(db: DatabaseSync, projectId: number, now = Date.now()): { closed: number; judged: number; last: number | null } {
  const w = db.prepare(`SELECT count(*) AS closed, coalesce(sum(EXISTS (SELECT 1 FROM review_runs r WHERE r.ticket_id = t.id)), 0) AS judged
    FROM tickets t WHERE t.project_id = ? AND t.kind != 'coordinator' AND t.status = 'closed' AND t.closed_at >= ?`).get(projectId, now - 7 * DAY) as { closed: number; judged: number };
  const l = db.prepare('SELECT max(r.at) AS at FROM review_runs r JOIN review_entries e ON e.id = r.entry_id WHERE e.project_id = ?').get(projectId) as { at: number | null };
  return { closed: w.closed, judged: w.judged, last: l.at };
}

/** The headline's numbers for one scheme. Coverage is null with no repo or history to read. */
export async function glance(db: DatabaseSync, projectId: number, repoDir: string | null, entries: ReviewEntry[]) {
  const paths = await changedPaths(repoDir);
  const cov = paths ? coverage(paths, ownGlobs(entries)) : null;
  return { ...judged(db, projectId), coverage: cov && { ...cov, gaps: cov.gaps.slice(0, 5) }, days: COVERAGE_DAYS };
}
