/**
 * Kit files sync themselves (#1100, option C of #601's spec on top of option A). Every scheme copies four of the kit's
 * scheme-setup templates: land.sh byte for byte, and guard.sh, pre-push and ponytail.md adapted to the scheme (its
 * protected branch names, ponytail's paths and "In this repo" section). When a deploy changes one, the server makes the
 * sync itself in each scheme whose copy is behind, runs that scheme's quick check on it, and posts one ship card in
 * Citadel's Taskmaster chat; its go ships every green one through that scheme's own tools/land.sh. No sync minions.
 *
 * The sync is a 3-way merge, so a scheme's own edits survive: the base is the kit version the scheme's copy came from
 * (a `Kit-Sync: <kit commit>` trailer on the last commit that touched it, which every sync writes; before the first
 * sync, the past template version closest to the copy), "theirs" the kit's template now, "ours" the scheme's copy.
 * A merge that gives back the scheme's own file is nothing to do; a conflict makes no branch and goes to that scheme's
 * Taskmaster. This file holds the git side; KitSync (below) runs the rounds.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The templates schemes copy, and where a scheme keeps its copy. */
export const KIT_FILES: readonly { template: string; path: string }[] = [
  { template: 'kit/skills/scheme-setup/templates/land.sh', path: 'tools/land.sh' },
  { template: 'kit/skills/scheme-setup/templates/guard.sh', path: 'tools/guard.sh' },
  { template: 'kit/skills/scheme-setup/templates/pre-push', path: '.githooks/pre-push' },
  { template: 'kit/skills/scheme-setup/templates/ponytail.md', path: '.claude/rules/ponytail.md' },
];

/** The trailer a sync commit carries: the kit commit its files were merged from, the next sync's exact base. */
export const TRAILER = 'Kit-Sync';

export function git(cwd: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}): string {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', input: opts.input, maxBuffer: 64 << 20, stdio: ['pipe', 'pipe', 'pipe'],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

/** The blob of `path` at `rev`, or null when it has none there. */
export function blobAt(dir: string, rev: string, path: string): string | null {
  return tryGit(dir, ['rev-parse', '--verify', '--quiet', `${rev}:${path}`])?.trim() || null;
}

/** The kit's four template blobs at `rev` (null for one it has none of), keyed by template path. */
export function templateBlobs(kitDir: string, rev: string): Record<string, string | null> {
  return Object.fromEntries(KIT_FILES.map((f) => [f.template, blobAt(kitDir, rev, f.template)]));
}

/** Every version a template has had up to `rev`, newest first: the commit that made it and its blob. */
export function templateHistory(kitDir: string, rev: string, template: string): { commit: string; blob: string }[] {
  const out = tryGit(kitDir, ['log', '--format=C %H', '--raw', '--no-abbrev', '--no-renames', rev, '--', template]) ?? '';
  const versions: { commit: string; blob: string }[] = [];
  let commit = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('C ')) commit = line.slice(2);
    else if (line.startsWith(':')) {
      // ":<old mode> <new mode> <old blob> <new blob> <status>\t<path>"; a deletion's new blob is all zeros.
      const blob = line.split(/\s+/)[3];
      if (blob && !/^0+$/.test(blob)) versions.push({ commit, blob });
    }
  }
  return versions;
}

/** How many lines two texts don't share, as multisets: a cheap distance for picking the closest past version. */
export function lineDistance(a: string, b: string): number {
  const counts = new Map<string, number>();
  for (const l of a.split('\n')) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const l of b.split('\n')) counts.set(l, (counts.get(l) ?? 0) - 1);
  let d = 0;
  for (const n of counts.values()) d += Math.abs(n);
  return d;
}

export interface Base {
  blob: string;
  /** The kit commit of that version. */
  commit: string;
  /** trailer: the last sync named it; exact: the copy is that version byte for byte; closest: the nearest past version. */
  how: 'trailer' | 'exact' | 'closest';
}

/**
 * The kit version a scheme's copy of `file` came from. `history` is templateHistory's list for its template (it is
 * read once per round, not per scheme).
 */
export function pickBase(kitDir: string, history: { commit: string; blob: string }[], schemeDir: string, rev: string, file: { template: string; path: string }): Base | null {
  // The newest commit touching the file that carries one: an edit of the scheme's own after a sync keeps that base.
  const trailer = (tryGit(schemeDir, ['log', '-n', '500', `--format=%(trailers:key=${TRAILER},valueonly,separator=%x20)`, rev, '--', file.path]) ?? '')
    .split('\n').map((l) => l.trim()).find(Boolean)?.split(/\s+/)[0];
  if (trailer && /^[0-9a-f]{7,64}$/.test(trailer)) {
    const blob = blobAt(kitDir, trailer, file.template);
    if (blob) return { blob, commit: tryGit(kitDir, ['rev-parse', trailer])?.trim() ?? trailer, how: 'trailer' };
  }
  const own = blobAt(schemeDir, rev, file.path);
  if (!own || !history.length) return null;
  const exact = history.find((v) => v.blob === own);
  if (exact) return { ...exact, how: 'exact' };
  const ours = git(schemeDir, ['cat-file', 'blob', own]);
  let best: { commit: string; blob: string; d: number } | null = null;
  const seen = new Set<string>();
  for (const v of history) {
    if (seen.has(v.blob)) continue;
    seen.add(v.blob);
    const d = lineDistance(ours, git(kitDir, ['cat-file', 'blob', v.blob]));
    // Newest first, so a tie goes to the older version: a kit change it can't place then shows as a conflict
    // rather than being taken as already in.
    if (!best || d <= best.d) best = { ...v, d };
  }
  return best && { commit: best.commit, blob: best.blob, how: 'closest' };
}

/** `git merge-file -p ours base theirs`: the merged text, and whether any hunk conflicted. */
export function merge3(ours: string, base: string, theirs: string): { text: string; conflict: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'kit-sync-'));
  try {
    for (const [name, text] of [['ours', ours], ['base', base], ['theirs', theirs]] as const) writeFileSync(join(dir, name), text);
    try {
      return { text: execFileSync('git', ['merge-file', '-p', '-L', 'scheme', '-L', 'kit base', '-L', 'kit', 'ours', 'base', 'theirs'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] }), conflict: false };
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      // A positive status is the number of conflicts, with the merged text (markers and all) on stdout.
      if (typeof e.status === 'number' && e.status > 0 && typeof e.stdout === 'string') return { text: e.stdout, conflict: true };
      throw err;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type FileStatus = 'same' | 'merged' | 'conflict' | 'missing';
export interface FileSync {
  path: string;
  status: FileStatus;
  /** The new text, for a merged file. */
  text?: string;
  base?: Base['how'];
}

/**
 * What the sync of one scheme would change, without touching it: each kit file the scheme has, merged from its base to
 * the kit's template at `kitRev`. `histories` maps each template to templateHistory's list at `kitRev`.
 */
export function planScheme(kitDir: string, kitRev: string, histories: Record<string, { commit: string; blob: string }[]>, schemeDir: string, rev = 'HEAD'): FileSync[] {
  return KIT_FILES.map((file) => {
    const own = blobAt(schemeDir, rev, file.path);
    const kit = blobAt(kitDir, kitRev, file.template);
    if (!own || !kit) return { path: file.path, status: 'missing' as const };
    if (own === kit) return { path: file.path, status: 'same' as const };
    const theirs = git(kitDir, ['cat-file', 'blob', kit]);
    const ours = git(schemeDir, ['cat-file', 'blob', own]);
    const base = pickBase(kitDir, histories[file.template] ?? [], schemeDir, rev, file);
    // With no base at all (a template with no history), the copy is taken as the base: nothing comes in.
    const baseText = base ? git(kitDir, ['cat-file', 'blob', base.blob]) : ours;
    const merged = merge3(ours, baseText, theirs);
    if (merged.conflict) return { path: file.path, status: 'conflict' as const, base: base?.how };
    if (merged.text === ours) return { path: file.path, status: 'same' as const, base: base?.how };
    return { path: file.path, status: 'merged' as const, text: merged.text, base: base?.how };
  });
}

/** The scheme repos a round looks at: <projects>/<n>/repo with git, leaving out any repo holding the templates (Citadel's). */
export function schemeRepos(projectsDir: string, ids: number[]): { project: number; dir: string }[] {
  return ids
    .map((project) => ({ project, dir: join(projectsDir, String(project), 'repo') }))
    .filter(({ dir }) => tryGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== null && !blobAt(dir, 'HEAD', KIT_FILES[0].template));
}
