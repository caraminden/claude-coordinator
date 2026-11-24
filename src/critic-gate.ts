// The critic gate (#1504): a critic a scheme has on for some kind of change runs before that change ships, not after.
// Cara, 2026-11-21, on #1504's card: "Code review can be simultaneous, but critics not". The self-review skill already
// said to run matching rubrics and was followed in 5 of 172 front-end ships, so the hand-off checks the run record.
// Every scheme's critics, from its review set's data: nothing here knows Citadel's globs.
import { gitOut } from './git.ts';
import { posix } from 'node:path';
import type { ReviewEntry, ReviewSet } from './review-set.ts';

/**
 * One changed file of a branch: its path in the repo and its lines added plus removed (0 for a binary file). `comments`
 * is true when every changed line is a comment or blank, so a critic's screenshots could show nothing.
 */
export type DiffFile = { path: string; lines: number; comments?: boolean };

// One changed line, read in its comment state: `open` says a block comment ('*/' or '-->' closes it) is
// already open from an earlier line of the same run. Returns whether the line holds only comment or
// blank, and the state after it. A line with code before or after a comment is code, and so is a lone
// closer with no opener in the run: wrapping untouched code in a new /* */ hides it, so it counts.
export function readCommentLine(line: string, open: string | null): { comment: boolean; open: string | null } {
  let t = line.trim();
  if (open) {
    const i = t.indexOf(open);
    if (i < 0) return { comment: true, open };
    t = t.slice(i + open.length).trim();
    if (!t) return { comment: true, open: null };
    open = null;
  }
  if (!t || t.startsWith('//')) return { comment: true, open: null };
  for (const [start, end] of [
    ['/*', '*/'],
    ['<!--', '-->'],
  ]) {
    if (!t.startsWith(start)) continue;
    const j = t.indexOf(end, start.length);
    if (j < 0) return { comment: true, open: end };
    return { comment: !t.slice(j + end.length).trim(), open: null };
  }
  // A block comment's middle line ("* text") edited alone, but not CSS's universal selector.
  return { comment: /^\*(\s|$)/.test(t) && !/[{};=()]/.test(t), open: null };
}

/** Whether a changed line holds only a comment or blank, read alone. */
export function isCommentLine(line: string): boolean {
  const r = readCommentLine(line, null);
  return r.comment && !r.open;
}

// The files in a `git diff -U0` patch whose every changed line is a comment or blank. Each hunk's removed
// and added lines are read as two runs, by the hunk header's counts (so a "--- x" content line is never a
// header); a run that leaves a block comment open is code, since it opens or closes one around untouched lines.
export function commentOnlyFiles(patch: string): Set<string> {
  const code = new Map<string, boolean>();
  let file: string | null = null;
  const lines = patch.split('\n');
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    if (l.startsWith('diff --git ')) {
      file = null;
      continue;
    }
    if (l.startsWith('+++ ')) {
      file = l === '+++ /dev/null' ? null : l.slice(6);
      if (file) code.set(file, code.get(file) ?? false);
      continue;
    }
    const h = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(l);
    if (!h || !file) continue;
    let left = Number(h[1] ?? 1) + Number(h[2] ?? 1);
    const open: Record<string, string | null> = { '-': null, '+': null };
    for (; left > 0 && k + 1 < lines.length; left--) {
      const c = lines[++k];
      if (c.startsWith('\\')) {
        left++;
        continue;
      } // "\ No newline at end of file"
      const side = c[0] === '-' ? '-' : '+';
      const r = readCommentLine(c.slice(1), open[side]);
      open[side] = r.open;
      if (!r.comment) code.set(file, true);
    }
    if (open['-'] || open['+']) code.set(file, true);
  }
  return new Set([...code].filter(([, c]) => !c).map(([f]) => f));
}

/** What a critic with no run on record would judge in this change: its files and their lines. */
export type Missing = { slug: string; name: string; block: boolean; files: string[]; lines: number };

/**
 * The files a branch changed since it left the first of `bases` that resolves, with their lines; null when none
 * resolves or git fails, so a check that can't run never holds a ship.
 */
export function diffFiles(cwd: string, bases: string[]): Promise<DiffFile[] | null> {
  const git = (args: string[]) => gitOut(args, cwd, { trim: false, maxBuffer: 8 << 20 });
  return (async () => {
    for (const base of bases) {
      const out = await git(['diff', '--numstat', '--no-renames', `${base}...HEAD`]);
      if (out === null) continue;
      const patch = await git(['diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', `${base}...HEAD`]);
      const quiet = patch === null ? new Set<string>() : commentOnlyFiles(patch);
      return out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [add, del, ...rest] = l.split('\t');
          const path = rest.join('\t');
          return { path, lines: (Number(add) || 0) + (Number(del) || 0), ...(quiet.has(path) ? { comments: true } : {}) };
        });
    }
    return null;
  })();
}

/** The files an entry's `diff:` globs match in this change, or [] when they come to fewer lines than its `lines:`. */
export function matchedFiles(e: Pick<ReviewEntry, 'triggers'>, files: DiffFile[]): DiffFile[] {
  const globs = e.triggers.diff ?? [];
  if (!globs.length) return [];
  // A comment-only file asks no critic (Cara, 2026-11-24, on #1795's card: "Skip comment-only edits").
  const hit = files.filter((f) => !f.comments && globs.some((g) => posix.matchesGlob(f.path, g)));
  const lines = hit.reduce((n, f) => n + f.lines, 0);
  return hit.length && lines >= (e.triggers.lines ?? 0) ? hit : [];
}

/**
 * The critics this change needs a run of first: on, off trial, with `diff:` globs this change matches, and no run of
 * theirs recorded by this minion. A critic on trial only advises until it's calibrated, so it isn't required.
 */
export function missingCritics(entries: ReviewEntry[], ran: Set<number>, files: DiffFile[]): Missing[] {
  const out: Missing[] = [];
  for (const e of entries) {
    if (e.kind !== 'critic' || !e.enabled || e.trial || ran.has(e.id)) continue;
    const hit = matchedFiles(e, files);
    if (hit.length) out.push({ slug: e.slug, name: e.name, block: e.gate === 'block', files: hit.map((f) => f.path), lines: hit.reduce((n, f) => n + f.lines, 0) });
  }
  return out;
}

/** The hand-off's refusal: which critic, what it matched, and the one thing to do. */
export function missingText(missing: Missing[]): string {
  const one = (m: Missing) => {
    const files = m.files.length > 3 ? `${m.files.slice(0, 3).join(', ')} and ${m.files.length - 3} more` : m.files.join(', ');
    return `${m.name} (\`${m.slug}\`, ${m.lines} ${m.lines === 1 ? 'line' : 'lines'} in ${files})`;
  };
  const slugs = missing.map((m) => m.slug);
  const block = missing.filter((m) => m.block).map((m) => m.slug);
  return `Not handed off: this change matches ${missing.map(one).join(' and ')}, and ${missing.length > 1 ? 'they have' : 'it has'} no run on record from you. A critic runs before the ship, not alongside it (Cara, 2026-11-21: "Code review can be simultaneous, but critics not"). Run the \`citadel:critique\` skill with ${slugs.length > 1 ? 'the rubrics' : 'the rubric'} ${slugs.map((s) => `\`${s}\``).join(', ')} from your turn's review-set folder, record each round with \`review_set\` (slug, \`run: {round, verdict}\`), then hand it off again.${block.length ? ` ${block.map((s) => `\`${s}\``).join(', ')} ${block.length > 1 ? 'block' : 'blocks'}, so ${block.length > 1 ? 'they need' : 'it needs'} a pass: a fail or ask holds the ship until a person's go.` : ' Any verdict lets it ship; fix its blockers or list them under Not fixed.'}`;
}

/**
 * A ship hand-off's refusal for its critics, or null: land.sh's args (landArgs) pick the base. Not a build's own ship (its
 * feeders ran theirs) or its take-in of main (`--full`), nor a rolled-back deploy's fix (`fix`), which can't wait on a critic.
 */
export async function criticRefusal(reviews: ReviewSet, ticket: { id: number; project_id: number; cwd: string }, args: string[], fix: boolean): Promise<string | null> {
  if (args[0] === '--build' || args.includes('--full') || fix) return null;
  const files = await diffFiles(ticket.cwd, args[0] === '--into' ? [args[1], `origin/${args[1]}`, 'main'] : ['main', 'origin/HEAD', 'origin/main']);
  const missing = files ? missingCritics(reviews.list(ticket.project_id), reviews.ranOn(ticket.project_id, ticket.id), files) : [];
  return missing.length ? missingText(missing) : null;
}
