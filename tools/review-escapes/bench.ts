#!/usr/bin/env node
// The reviewer's benchmark record (#1738): what the pre-ship reviewer is made of (its text, its lenses, its pinned model, its
// lessons), the hash of that at the last benchmark run, and that run's scores on the two sets (tools/review-escapes/run.ts:
// real escapes and planted bugs). test/reviewer-benchmark.test.ts goes red when the hash moves; this records the new run.
//   node tools/review-escapes/bench.ts status                     what changed since the last record (lessons from the live database, read-only)
//   node tools/review-escapes/bench.ts record <out dir> <out dir> [--additions <file>] [--results <path>]
//       one run.ts --out dir per pass (each has summary.json); writes test/reviewer-benchmark.json and says when planted caught 2 fewer
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Tally } from './run.ts';

export const ROOT = join(import.meta.dirname, '..', '..');
export const RECORD = join(ROOT, 'test', 'reviewer-benchmark.json');
/** Lessons that arrive between runs before they count as a change (Cara, 2026-11-23: 3 new ones). */
export const NEW_LESSONS = 3;
/** Planted bugs named, fewer than at the last record by this many or more: the change is high risk (as prompt-eval's "Drop needs a go"). */
export const DROP = 2;

/** The text a review is made of, by part: the reviewer's definition (its model and effort are in its frontmatter), self-review's brief and model rule, the lenses, and the audit skill the reviewer follows. */
const PARTS: Record<string, (root: string) => string> = {
  reviewer: (r) => read(r, 'kit/agents/reviewer.md'),
  'self-review §2': (r) => read(r, 'kit/skills/self-review/SKILL.md').match(/^## 2\. [\s\S]*?(?=^## 3\. )/m)?.[0] ?? '',
  lenses: (r) => read(r, 'kit/skills/self-review/references/lenses.md'),
  'ponytail-review': (r) => read(r, 'kit/skills/ponytail-review/SKILL.md'),
};
const read = (root: string, file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), 'utf8') : '');
// Trailing spaces and runs of blank lines don't change what a reviewer reads.
const norm = (t: string) =>
  t
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const h = (t: string) => createHash('sha256').update(norm(t)).digest('hex').slice(0, 16);

/** The reviewer's hash and each part's, from the files under `root`. */
export function benchHash(root = ROOT): { hash: string; parts: Record<string, string> } {
  const parts = Object.fromEntries(Object.entries(PARTS).map(([k, f]) => [k, h(f(root))]));
  return { hash: h(Object.values(parts).join('\n')), parts };
}

/** The kinds in a scheme's pre-ship-review additions file ("- <kind>: refuted N times, ..."). */
export const lessonKinds = (additions: string): string[] => [...additions.matchAll(/^- (.+?): refuted \d+ times?\b/gm)].map((m) => m[1]);
/** Lessons now that the last record didn't have: a removed lesson isn't a change, a new one is. */
export const newLessons = (recorded: string[], now: string[]): string[] => now.filter((k) => !recorded.includes(k));

type PassScores = { named: number[]; of: number; casesNamed: number[]; controlsWith: number[]; controls: number; findings: number[] };
export type BenchRecord = { hash: string; parts: Record<string, string>; at: string; model: string; lessons: string[]; passes: number; planted: PassScores; escapes: PassScores; cost: number; results: string; drop?: string };

export const readRecord = (): BenchRecord | null => (existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, 'utf8')) : null);
export const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

/** Why the last record is out of date, one line each; empty when it isn't. `lessons` is the lessons now when they are known. */
export function staleReasons(rec: BenchRecord | null, root = ROOT, lessons?: string[]): string[] {
  if (!rec) return ['no benchmark has been recorded'];
  const now = benchHash(root);
  const out: string[] = [];
  if (now.hash !== rec.hash)
    out.push(
      `the reviewer changed since the run of ${rec.at}: ${
        Object.keys(now.parts)
          .filter((k) => now.parts[k] !== rec.parts[k])
          .join(', ') || 'its parts'
      }`,
    );
  const fresh = lessons ? newLessons(rec.lessons, lessons) : [];
  if (fresh.length >= NEW_LESSONS) out.push(`${fresh.length} lessons were added since ${rec.at} (${fresh.join('; ')})`);
  return out;
}

/** The lessons Citadel's pre-ship review has now, from a read-only look at the live database (copied into memory: ReviewSet writes its schema); null when it can't be read. */
async function liveLessons(project: number): Promise<string[] | null> {
  try {
    const { LIVE_DB } = await import('../judge-replays/store.ts');
    const { ReviewSet } = await import('../../src/review-set.ts');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT)'); // the entries' foreign key
    const set = new ReviewSet(db);
    db.prepare('ATTACH DATABASE ? AS live').run(`file:${LIVE_DB}?mode=ro`);
    db.exec('INSERT INTO projects (id) SELECT id FROM live.projects');
    for (const t of ['review_entries', 'review_refutes']) db.exec(`INSERT INTO ${t} SELECT * FROM live.${t}`);
    return set.lessons(project).map((l) => l.kind);
  } catch {
    return null;
  }
}

function scores(summaries: Record<string, Record<string, Tally>>[], arm: string, group: string): PassScores {
  const t = summaries.map((s) => s[arm]?.[group]);
  if (t.some((x) => !x)) throw new Error(`a pass has no ${arm} results for the ${group} set: run it with --arms ${arm} and --set all`);
  const T = t as Tally[];
  return { named: T.map((x) => x.named), of: T[0].defects, casesNamed: T.map((x) => x.casesNamed), controlsWith: T.map((x) => x.controlsWith), controls: T[0].controls, findings: T.map((x) => x.findings) };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (k: string) => {
    const i = rest.indexOf(k);
    return i >= 0 ? rest.splice(i, 2)[1] : undefined;
  };
  const rec = readRecord();
  if (cmd === 'status') {
    const lessons = await liveLessons(Number(flag('--project') ?? 2));
    const why = staleReasons(rec, ROOT, lessons ?? undefined);
    if (lessons === null) console.log('(the live database could not be read: lessons not checked)');
    console.log(why.length ? `STALE: ${why.join('; ')}.\nRun the benchmark (tools/review-escapes/README.md, "When the reviewer changes") and record it.` : `Current: recorded ${rec!.at}, hash ${rec!.hash}.`);
    return;
  }
  if (cmd === 'record') {
    const additions = flag('--additions');
    const results = flag('--results') ?? '';
    const outs = rest.filter((a) => !a.startsWith('--'));
    if (outs.length < 2) throw new Error('give one run.ts --out dir per pass (two passes)');
    const sums = outs.map((o) => JSON.parse(readFileSync(join(resolve(o), 'summary.json'), 'utf8')));
    const arm = 'sonnet';
    const planted = scores(sums, arm, 'planted'),
      escapes = scores(sums, arm, 'escapes');
    const cost = sums.reduce((n, s) => n + (['planted', 'escapes'] as const).reduce((m, g) => m + s[arm][g].cost + s[arm][g].judgeCost, 0), 0);
    const now = benchHash();
    const model = read(ROOT, 'kit/agents/reviewer.md').match(/^model: (.+)$/m)?.[1] + '/' + read(ROOT, 'kit/agents/reviewer.md').match(/^effort: (.+)$/m)?.[1];
    const next: BenchRecord = { ...now, at: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' }), model, lessons: additions ? lessonKinds(readFileSync(additions, 'utf8')) : [], passes: outs.length, planted, escapes, cost: +cost.toFixed(2), results };
    const drop = rec && mean(rec.planted.named) - mean(planted.named) >= DROP;
    if (drop) next.drop = `planted bugs named fell from ${mean(rec!.planted.named)} to ${mean(planted.named)} of ${planted.of} (a drop of ${DROP} or more): the change that caused it is high risk and ships only on a member's go`;
    writeFileSync(RECORD, JSON.stringify(next, null, 1) + '\n');
    console.log(`Recorded ${next.at}, hash ${next.hash}: planted named ${planted.named.join(' and ')} of ${planted.of}, escapes named ${escapes.named.join(' and ')} of ${escapes.of}, controls with a finding ${planted.controlsWith.join(' and ')} of ${planted.controls}.`);
    if (drop) console.log(`HIGH RISK: ${next.drop}`);
    return;
  }
  console.log('usage: node tools/review-escapes/bench.ts status | record <out dir> <out dir> [--additions <file>] [--results <path>]');
}

if (import.meta.main) await main();
