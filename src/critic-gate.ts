// The critic gate (#1504): a critic a scheme has on for some kind of change runs before that change ships, not after.
// Cara, 2026-11-21, on #1504's card: "Code review can be simultaneous, but critics not". The self-review skill already
// said to run matching rubrics and was followed in 5 of 172 front-end ships, so the hand-off checks the run record.
// Every scheme's critics, from its review set's data: nothing here knows Citadel's globs.
import { execFile } from 'node:child_process';
import { posix } from 'node:path';
import type { ReviewEntry, ReviewSet } from './review-set.ts';

/** One changed file of a branch: its path in the repo and its lines added plus removed (0 for a binary file). */
export type DiffFile = { path: string; lines: number };

/** What a critic with no run on record would judge in this change: its files and their lines. */
export type Missing = { slug: string; name: string; block: boolean; files: string[]; lines: number };

/**
 * The files a branch changed since it left the first of `bases` that resolves, with their lines; null when none
 * resolves or git fails, so a check that can't run never holds a ship.
 */
export function diffFiles(cwd: string, bases: string[]): Promise<DiffFile[] | null> {
  const git = (args: string[]) => new Promise<string | null>((done) => execFile('git', args, { cwd, timeout: 15_000, maxBuffer: 8 << 20 }, (err, out) => done(err ? null : out)));
  return (async () => {
    for (const base of bases) {
      const out = await git(['diff', '--numstat', '--no-renames', `${base}...HEAD`]);
      if (out === null) continue;
      return out.split('\n').filter(Boolean).map((l) => {
        const [add, del, ...rest] = l.split('\t');
        return { path: rest.join('\t'), lines: (Number(add) || 0) + (Number(del) || 0) };
      });
    }
    return null;
  })();
}

/** The files an entry's `diff:` globs match in this change, or [] when they come to fewer lines than its `lines:`. */
export function matchedFiles(e: Pick<ReviewEntry, 'triggers'>, files: DiffFile[]): DiffFile[] {
  const globs = e.triggers.diff ?? [];
  if (!globs.length) return [];
  const hit = files.filter((f) => globs.some((g) => posix.matchesGlob(f.path, g)));
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
    return `${m.name} (\`${m.slug}\`, ${m.lines} ${m.lines === 1 ? "line" : "lines"} in ${files})`;
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
