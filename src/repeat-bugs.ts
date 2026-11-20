/**
 * The third-fix flag (B4): a new bug minion whose brief is about the same thing as two or more bug minions from the last
 * 14 days in its scheme starts with a "diagnose first" block, one model tier up. The matching here is pure; the route
 * that makes minions reads the earlier minions and the repo's history and calls `repeats`.
 *
 * Two kinds of evidence, either enough on its own:
 * - files: a path the new brief names that an earlier minion's shipped commits changed, or that its brief named too;
 * - words: rare word pairs ("supercharged slam") both briefs share. Rare is judged against the scheme's own bug briefs,
 *   so a scheme's everyday words ("release panel", "land.sh") don't count.
 * Files that most minions touch (a store, a router) and pairs most briefs use are ignored as noise.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Project, Store } from './db.ts';
import { subjectTicket } from './deploy-watch.ts';
import { nextStep } from '../public/model-table.js';

const git = promisify(execFile);

export const REPEAT_WINDOW_MS = 14 * 86_400_000;
/** Earlier minions on the same thing that make a flag: the new one would be the third fix. */
export const REPEAT_FLAG_AT = 2;

export type BugBrief = { number: number; title: string; brief: string; at: number };
export type EarlierBug = BugBrief & { files: string[]; subjects: string[] };
export type RepeatMatch = { number: number; title: string; cited: boolean; files: string[]; words: string[]; subjects: string[] };

const STOP = new Set(`a an and are as at be been but by can could did do does done each either for from had has have he her
his how i if in into is it its it's just may me more most much my no not now of on once one only or other our out over
own same see she should so some still such than that the their them then there these they this those though through to
too under up us use used very was we were what when where which while who why will with would you your also any after
again all already back because before both down even every first get go going got here let like make made new next off
put say says said take tell them thing think try tried want way well work works yet about above across against along
among around being below between beyond during else ever few further however inside instead less many might must near
need needs never often onto per rather really since soon though toward towards until upon whether within without
cara josh alex taskmaster minion minions scheme citadel brief handoff bug bugs fix fixes fixed fixing test tests
read start shared project projects home local share claude coordinator reports report inbox uploads png jpg md ts js
sqlite3 readonly credentials flaky-tests memory plainly citadel:bug-fixing citadel:diagnosing-bugs citadel:self-review self-review land lands landed ship ships shipped pst pdt
nov november oct october 2026 run runs ran line lines file files code check checks show shows find found cause`.split(/\s+/));

const NOT_CODE = /\.(?:md|txt|log|png|jpe?g|gif|webp|mp4|webm|zip)$/i;
const PATH = /(?:[\w.@-]+\/)+[\w.@-]+\.[a-z0-9]{1,5}\b/gi;

/** The repo code paths a text names (src/db.ts, crates/app/src/well.rs): not absolute paths, URLs, docs or pictures. */
export function namedPaths(text: string): string[] {
  const clean = text.replace(/https?:\/\/\S+/g, ' ').replace(/(?:^|[\s(`'"])(?:~|\/)[^\s`'")]*/g, ' ');
  return [...new Set([...clean.matchAll(PATH)].map((m) => m[0].replace(/^\.\//, '')).filter((p) => !NOT_CODE.test(p)))];
}

/** Content words in order, paths and URLs dropped. */
function words(text: string): string[] {
  const clean = text.toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/(?:^|\s)\S*\/\S*/g, ' ');
  return (clean.match(/[a-z][a-z0-9'_-]*[a-z0-9]/g) ?? []).filter((w) => w.length > 2 && !STOP.has(w));
}

/** Pairs of neighbouring content words, sorted inside the pair so "slam supercharged" meets "supercharged slam". */
export function pairs(text: string): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  for (let i = 1; i < w.length; i++) if (w[i] !== w[i - 1]) out.add([w[i - 1], w[i]].sort().join(' '));
  return out;
}

/** Ids a brief quotes (a chat id, a commit): one word of 7 or more characters with two letters or more and a digit inside it or two (bg3cyvmfzbrq, 433b326f; not sqlite3). */
export function ids(text: string): Set<string> {
  const clean = text.replace(/https?:\/\/\S+/g, ' ').replace(/(?:^|\s)\S*\/\S*/g, ' ');
  return new Set((clean.match(/\b[a-z0-9_]{7,}\b/gi) ?? []).filter((w) => /\d.*\d|\d[a-z]/i.test(w) && /[a-z].*[a-z]/i.test(w) && !/^\d{4}-?\d\d/.test(w)).map((w) => `#id ${w.toLowerCase()}`));
}

function termsOf(b: BugBrief): Set<string> {
  return new Set([...pairs(`${b.title}\n${b.brief}`), ...ids(b.brief)]);
}

/** How many briefs use each word pair, id, word ("#w slam") and path ("#f src/db.ts"): the rarity `repeats` judges by. */
export function termCounts(pool: BugBrief[]): Map<string, number> {
  const df = new Map<string, number>([['#briefs', pool.length]]);
  const add = (t: string) => df.set(t, (df.get(t) ?? 0) + 1);
  for (const b of pool) {
    for (const t of termsOf(b)) add(t);
    for (const w of new Set(words(`${b.title}\n${b.brief}`))) add(`#w ${w}`);
    for (const f of namedPaths(b.brief)) add(`#f ${f}`);
  }
  return df;
}

/** Same file, by repo path or by the tail of one ("well.rs" in a brief, crates/app/src/well.rs in a commit). */
function sameFile(named: string, changed: string): boolean {
  return named === changed || changed.endsWith(`/${named}`) || named.endsWith(`/${changed}`);
}

/** A word pair or id in more briefs than this is everyday wording, not the thing a bug is about. */
export const RARE = 4;
/** A file more minions changed than this in the window is a hub (a store, a router), not evidence. */
export const HUB = 6;
/** Minions started this close together are parts of one plan, not one fix after another. */
/** The brief naming an earlier minion's #N is one piece of evidence: it often names a source ("found by #468's sweep"), not a fix that failed. */
export const W_CITE = 1;
export const SIBLINGS_MS = 3_600_000;

/**
 * Earlier bug minions about the same thing as `now`. `df` is termCounts over every bug brief of the window; `hubs`
 * the files too many minions changed. An earlier minion matches on two pieces of evidence: a file the new brief names
 * that it changed or named, a rare word pair, or an id (which counts as two). A flag also needs two of the matches to share a rare term or
 * a file between themselves, so two unrelated half-matches don't make a chain.
 */
export function repeats(now: BugBrief, earlier: EarlierBug[], ctx: { df: Map<string, number>; hubs: Set<string> }): RepeatMatch[] {
  const count = (t: string) => ctx.df.get(t) ?? 0;
  // A pair of everyday words ("phone widths", "end turn") is rare as a pair but says nothing: one of its words must be rare too.
  const rareWord = Math.max(RARE, Math.ceil(count('#briefs') * 0.02));
  const rare = (t: string) => count(t) <= RARE && (t.startsWith('#id ') || t.split(' ').some((w) => count(`#w ${w}`) <= rareWord));
  const mine = termsOf(now);
  const named = namedPaths(now.brief).filter((f) => count(`#f ${f}`) <= RARE && !ctx.hubs.has(f));
  // "#488 and #490 didn't hold": the brief naming an earlier minion of its own scheme ("Citadel #1086" and "PR #89" are elsewhere).
  const cited = new Set([...now.brief.matchAll(/(?<![A-Z][\w-]* )#(\d+)\b/g)].map((m) => Number(m[1])));
  const found: (RepeatMatch & { terms: Set<string>; own: string[] })[] = [];
  for (const e of earlier) {
    if (e.number === now.number || now.at - e.at < SIBLINGS_MS) continue;
    const theirs = new Set([...termsOf(e)].filter(rare));
    const own = [...new Set([...e.files, ...namedPaths(e.brief)])].filter((f) => !ctx.hubs.has(f));
    const shared = [...mine].filter((t) => theirs.has(t));
    const files = named.filter((n) => own.some((f) => sameFile(n, f)));
    const weight = (cited.has(e.number) ? W_CITE : 0) + files.length + shared.reduce((w, t) => w + (t.startsWith('#id ') ? 2 : 1), 0);
    if (weight >= 2) found.push({ number: e.number, title: e.title, cited: cited.has(e.number), files, words: shared.map((t) => t.replace(/^#id /, '')), subjects: e.subjects, terms: theirs, own });
  }
  const linked = found.filter((a) => found.some((b) => a !== b && ([...a.terms].some((t) => b.terms.has(t)) || a.own.some((f) => b.own.includes(f)))));
  return linked.map(({ terms: _t, own: _o, ...m }) => m);
}

/** The block a flagged brief starts with. */
export function flagBlock(matches: RepeatMatch[]): string {
  const lines = matches.map((m) => {
    const why = [m.cited && 'named in this brief', m.files.length && `same files: ${m.files.join(', ')}`, m.words.length && `same words: "${m.words.slice(0, 3).join('", "')}"`].filter(Boolean).join('; ');
    const did = m.subjects.length ? ` What it shipped: ${m.subjects.slice(0, 3).map((s) => `"${s}"`).join('; ')}${m.subjects.length > 3 ? ` and ${m.subjects.length - 3} more` : ''}.` : ' Nothing shipped from it yet.';
    return `- #${m.number} "${m.title}" (${why}).${did}`;
  });
  return [
    `${FLAG_HEAD} ${matches.length} bug minions in the last 14 days look like they were about this same thing, so the earlier fixes may not have held:`,
    ...lines,
    'Before you change any code, run `citadel:diagnosing-bugs`: rebuild the failure from the evidence, check why each earlier fix didn\'t hold, and find the cause they missed. The match is by files and wording, so it can be wrong: if these minions are about something else, say so in one line and carry on with `citadel:bug-fixing`.',
  ].join('\n');
}

/** A brief's own words, its first 1,000 characters: a flagged brief's block (other minions' titles and numbers) is left out. */
export function ownBrief(text: string): string {
  const cut = text.startsWith(FLAG_HEAD) ? text.indexOf(FLAG_RULE) : -1;
  return (cut < 0 ? text : text.slice(cut + FLAG_RULE.length)).slice(0, 1000);
}
const FLAG_HEAD = '**Third fix: diagnose first.**';
export const FLAG_RULE = '\n\n---\n\n';

type Commit = { n: string; s: string; files: string[] };

/** The repo's commits of the window, newest first, each with the minion its subject names (subjectTicket) and its files. */
async function recentCommits(repoDir: string | null, now: number): Promise<Commit[]> {
  if (!repoDir) return [];
  const out = await git('git', ['-C', repoDir, '-c', 'core.quotePath=false', 'log', 'HEAD', `--since=${new Date(now - REPEAT_WINDOW_MS).toISOString()}`, '--no-merges', '--format=%x01%s', '--name-only'], { timeout: 10_000, maxBuffer: 64 << 20 })
    .then((r) => r.stdout).catch(() => '');
  return out.split('\x01').slice(1).map((chunk) => {
    const [s, ...files] = chunk.split('\n');
    return { n: subjectTicket(s), s, files: files.filter(Boolean) };
  });
}

/**
 * The third-fix check for a new bug minion of `project`, before it exists: the earlier bug minions of the scheme from
 * the last 14 days that look like fixes for the same thing, or [] below the flag. Rarity is judged against every scheme's
 * bug briefs of the last 28 days, so one scheme's quiet fortnight doesn't make its everyday words look rare.
 */
export async function findRepeats(store: Store, project: Project, now: { title: string; brief: string; at: number }): Promise<RepeatMatch[]> {
  const pool = store.bugBriefs(now.at - 2 * REPEAT_WINDOW_MS).map((b) => ({ ...b, brief: ownBrief(b.brief) }));
  const mine = pool.filter((b) => b.project_id === project.id && b.at >= now.at - REPEAT_WINDOW_MS);
  if (mine.length < REPEAT_FLAG_AT) return [];
  const commits = await recentCommits(project.repo_dir, now.at);
  const byMinion = new Map<string, Set<string>>();
  for (const c of commits) for (const f of c.files) (byMinion.get(f) ?? byMinion.set(f, new Set()).get(f)!).add(c.n || c.s);
  const hubs = new Set([...byMinion].filter(([, who]) => who.size > HUB).map(([f]) => f));
  const earlier = mine.map((b) => {
    const own = commits.filter((c) => c.n === String(b.number));
    return { ...b, files: [...new Set(own.flatMap((c) => c.files))], subjects: own.map((c) => c.s).reverse() };
  });
  const found = repeats({ number: 0, ...now }, earlier, { df: termCounts([...pool, { number: 0, ...now }]), hubs });
  return found.length >= REPEAT_FLAG_AT ? found : [];
}

/**
 * The tier a flagged minion starts on: one step up the model table from its type's pick. A pick that already differs
 * from the table's (a person's, or the Taskmaster's own call) is kept, so a flag never stacks on a step-up.
 */
export function steppedTier(pick: { model: string; effort: string }, table: { model: string; effort: string }, fable: boolean): { model: string; effort: string } | null {
  if (pick.model !== table.model || pick.effort !== table.effort) return null;
  return nextStep(pick.model, pick.effort, fable);
}

/** The Taskmaster's note on a flagged start. */
export function flagNote(matches: RepeatMatch[], tier: { from: string; to: string } | null): string {
  const list = matches.map((m) => `#${m.number}`).join(', ');
  return `Third-fix flag: ${list} look like earlier fixes for the same thing, so its brief starts with a "diagnose first" block (citadel:diagnosing-bugs). ${tier ? `It starts one tier up, on ${tier.to} instead of ${tier.from}; if the match is wrong, update_ticket it back.` : 'Its tier is as picked; step it up with update_ticket if the first turn stalls.'}`;
}

