// Schema and ADR numbers handed out at ship time (#1221). tools/land.sh runs it; nothing else needs to.
//
//   merge <ours|theirs> <base> <ours> <theirs>
//     The git merge driver for src/db.ts in land.sh's own merge-tree, rebase and merge (core.attributesFile:
//     tools/ship-numbers.attributes; since #1418 through the kit core's land_merge hook in land.local.sh, whose MERGES
//     rules then append MIGRATIONS lines; `take` below runs it alone, and git's merge for the other files listed there).
//     The first word names the side that is main (or the build a feeder goes into):
//     its SCHEMA_HISTORY numbers stay. The other side's new lines go after them, renumbered from its newest + 1, and
//     the schema_version checks that side added in this file move with them. The rest of the file merges as git
//     would. A tail that isn't a plain append on the moving side (a base line edited or dropped, or a new line the
//     other side has too) merges as git would, so it conflicts and land.sh names the number to take.
//     shortcut: a check moves only on a line that says schema_version and only in src/db.ts, not a test that sets
//     schema_version to the old number; widen it if a renumbered check ever misses.
//   baseline <ours|theirs> <base> <ours> <theirs>
//     The merge for test/typecheck-baseline.json (#2141, through land.local.sh's land_merge hook): a side that only
//     lowered counts or dropped rows takes main's copy, which land.sh measures again on the rebased tree (typecheck.ts
//     --update), so two ships lowering neighbouring rows never conflict. A side that raised one (--update --moved)
//     merges as git would, as before.
//   take <ref>
//     git merge <ref> with the driver above, <ref> kept: how a build minion takes main in by hand (src/prompts.ts).
//   adr <onto> [<name>]
//     After the rebase or merge: each docs/adr/NNNN-*.md this branch adds whose number <onto> already has gets the next
//     free number. Links to its file name are rewritten everywhere; "ADR NNNN" only on lines this branch added. Prints
//     one line per rename ("ADR 0016 → 0020: main took 0016", <name> in place of <onto>) and stages what it changed; land.sh commits it.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 << 20 });

const OPEN = 'export const SCHEMA_HISTORY = [';
const CLOSE = '] as const;';
type History = { lines: string[]; start: number; end: number; entries: { n: number; desc: string }[] };
function history(text: string): History | null {
  const lines = text.split('\n');
  const start = lines.indexOf(OPEN);
  const end = start < 0 ? -1 : lines.indexOf(CLOSE, start);
  if (end < 0) return null;
  const entries = [];
  for (const line of lines.slice(start + 1, end)) {
    const m = /^  \[(\d+), (.+)\],$/.exec(line);
    if (!m) return null;
    entries.push({ n: Number(m[1]), desc: m[2] });
  }
  return { lines, start, end, entries };
}

/** Runs git on the texts, written to files in a scratch folder: `args` gets their paths. */
function onTexts(texts: string[], args: (paths: string[]) => string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ship-numbers-'));
  try {
    const paths = texts.map((t, i) => (writeFileSync(join(dir, String(i)), t), join(dir, String(i))));
    return spawnSync('git', args(paths), { encoding: 'utf8', maxBuffer: 64 << 20 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
/** git's own three-way merge of the files' texts into `out`: 0 when clean. With LAND_MERGE_DIFF3=1 (the kit's land.sh,
 *  when the path has append, sum or count rules too) clashes keep its markers: diff3, size 31, the side that is main first. */
function mergeFile(mainSide: string, out: string, base: string, ours: string, theirs: string): number {
  const r = onTexts([base, ours, theirs], ([o, a, b]) =>
    process.env.LAND_MERGE_DIFF3 === '1' ? ['merge-file', '-p', '--diff3', '--marker-size=31', '-L', 'main', '-L', 'base', '-L', 'branch', ...(mainSide === 'theirs' ? [b, o, a] : [a, o, b])] : ['merge-file', '-p', '-L', 'ours', '-L', 'base', '-L', 'theirs', a, o, b],
  );
  if (r.status === null || r.status < 0 || r.status > 127) return 2;
  writeFileSync(out, r.stdout);
  return r.status === 0 ? 0 : 1;
}
/** The indexes of the lines `to` adds over `from`, by git's diff: by place, so a line main added too still counts. */
function addedLines(from: string, to: string): Set<number> {
  const out = new Set<number>();
  for (const m of onTexts([from, to], ([a, b]) => ['diff', '--no-index', '--no-color', '-U0', a, b]).stdout.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)) {
    for (let i = 0; i < Number(m[2] ?? 1); i++) out.add(Number(m[1]) - 1 + i);
  }
  return out;
}

function merge(mainSide: string, basePath: string, oursPath: string, theirsPath: string): number {
  const [O, A, B] = [basePath, oursPath, theirsPath].map((p) => readFileSync(p, 'utf8'));
  const plain = () => mergeFile(mainSide, oursPath, O, A, B);
  const [o, a, b] = [O, A, B].map(history);
  if (!o || !a || !b) return plain();
  const [keep, move] = mainSide === 'theirs' ? [b, a] : [a, b];
  const moveText = mainSide === 'theirs' ? A : B;
  // The moving side only appended: the base's lines are its first lines, numbers and all.
  if (move.entries.length < o.entries.length || o.entries.some((e, i) => move.entries[i].n !== e.n || move.entries[i].desc !== e.desc)) return plain();
  const kept = new Map(keep.entries.map((e) => [e.desc, e.n]));
  if (o.entries.some((e) => !kept.has(e.desc))) return plain();
  const added = move.entries.slice(o.entries.length);
  if (added.some((e) => kept.has(e.desc))) return plain();
  const last = keep.entries.at(-1)?.n ?? 0;
  const to = new Map<number, number>();
  o.entries.forEach((e) => kept.get(e.desc) !== e.n && to.set(e.n, kept.get(e.desc)!)); // a line an earlier commit of this rebase moved
  added.forEach((e, i) => to.set(e.n, last + 1 + i));
  const merged = [...keep.entries, ...added.map((e, i) => ({ n: last + 1 + i, desc: e.desc }))].map((e) => `  [${e.n}, ${e.desc}],`);
  const withHistory = (h: History) => [...h.lines.slice(0, h.start + 1), ...merged, ...h.lines.slice(h.end)];
  // Lines the moving side added over the base that check schema_version get the new numbers.
  const mine = addedLines(O, moveText);
  const moved = withHistory({ ...move, lines: move.lines.map((l, i) => (!mine.has(i) || !l.includes('schema_version') ? l : l.replace(/\b\d+\b/g, (d) => String(to.get(Number(d)) ?? d)))) });
  const [ours, theirs] = mainSide === 'theirs' ? [moved, withHistory(keep)] : [withHistory(keep), moved];
  return mergeFile(mainSide, oursPath, O, ours.join('\n'), theirs.join('\n'));
}

type Rows = Record<string, [number, number]>;
/** Whether <branch>'s baseline text raises no count over <base>'s (an unreadable one counts as raising). */
function onlyLowers(base: string, branch: string): boolean {
  try {
    const o = JSON.parse(base) as Rows;
    const b = JSON.parse(branch) as Rows;
    return Object.entries(b).every(([f, c]) => c[0] <= (o[f]?.[0] ?? 0) && c[1] <= (o[f]?.[1] ?? 0));
  } catch {
    return false;
  }
}
function baseline(mainSide: string, basePath: string, oursPath: string, theirsPath: string): number {
  const [O, A, B] = [basePath, oursPath, theirsPath].map((p) => readFileSync(p, 'utf8'));
  const [main, branch] = mainSide === 'theirs' ? [B, A] : [A, B];
  if (!onlyLowers(O, branch)) return mergeFile(mainSide, oursPath, O, A, B);
  writeFileSync(oursPath, main);
  return 0;
}

function adr(onto: string, name = onto.replace(/^refs\/heads\//, '')): void {
  const list = (ref: string) => git('ls-tree', '--name-only', `${ref}:docs/adr/`).split('\n').filter(Boolean);
  let ontoFiles: string[];
  try {
    ontoFiles = list(onto);
  } catch {
    return; // no docs/adr there
  }
  const mine = list('HEAD').filter((f) => !ontoFiles.includes(f));
  const num = (f: string) => /^(\d{4})-/.exec(f)?.[1];
  const taken = new Set(ontoFiles.map(num).filter(Boolean));
  const clashing = mine.filter((f) => taken.has(num(f))).sort();
  if (!clashing.length) return;
  let next = Math.max(...[...ontoFiles, ...list('HEAD')].map((f) => Number(num(f) ?? 0))) + 1;
  // The lines this branch added, by file, as they read before any rewrite here.
  const addedLines = new Map<string, Set<string>>();
  let file = '';
  for (const line of git('-c', 'core.quotePath=false', 'diff', '-U0', '--no-renames', '--no-color', onto, 'HEAD').split('\n')) {
    if (line.startsWith('+++ '))
      file = line.startsWith('+++ b/') ? line.slice(6).replace(/\t$/, '') : ''; // git ends a name with a space in a tab
    else if (line.startsWith('+') && file) (addedLines.get(file) ?? addedLines.set(file, new Set()).get(file)!).add(line.slice(1));
  }
  const renames: [string, string, string, string][] = []; // old number, new number, old name, new name
  for (const f of clashing) {
    const n = num(f)!;
    const m = String(next++).padStart(4, '0');
    renames.push([n, m, f, m + f.slice(4)]);
  }
  // "ADR NNNN" on the branch's own added lines (not one that links <onto>'s ADR of that number: that mention is its),
  // then links to the old file names anywhere.
  const touched = new Set<string>();
  for (const [path, lines] of addedLines) {
    const text = readFileSync(path, 'utf8');
    const out = text
      .split('\n')
      .map((l) => {
        if (!lines.has(l)) return l;
        for (const [n, m] of renames) if (!ontoFiles.some((f) => num(f) === n && l.includes(f))) l = l.replace(new RegExp(`\\bADR([- ])${n}\\b`, 'g'), `ADR$1${m}`);
        return l;
      })
      .join('\n');
    if (out !== text) writeFileSync(path, out), touched.add(path);
  }
  for (const [, , from, to] of renames) {
    const hits = spawnSync('git', ['grep', '-lzF', from], { encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
    for (const path of hits) writeFileSync(path, readFileSync(path, 'utf8').split(from).join(to)), touched.add(path);
    renameSync(join('docs/adr', from), join('docs/adr', to));
    touched.add(join('docs/adr', from)).add(join('docs/adr', to));
  }
  git('add', '-A', '--', ...touched); // only these: an untracked file in the worktree stays out of the commit
  for (const [n, m] of renames) console.log(`ADR ${n} → ${m}: ${name} took ${n}`);
}

function take(ref: string): number {
  const me = import.meta.filename;
  const driver = `'${process.execPath}' --no-warnings '${me}' merge theirs %O %A %B`;
  const attrs = join(dirname(me), 'ship-numbers.attributes');
  return spawnSync('git', ['-c', `core.attributesFile=${attrs}`, '-c', `merge.citadel-numbers.driver=${driver}`, 'merge', '--no-edit', ref], { stdio: 'inherit' }).status ?? 1;
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'merge' && args.length === 4) process.exit(merge(args[0], args[1], args[2], args[3]));
else if (cmd === 'baseline' && args.length === 4) process.exit(baseline(args[0], args[1], args[2], args[3]));
else if (cmd === 'take' && args.length === 1) process.exit(take(args[0]));
else if (cmd === 'adr' && (args.length === 1 || args.length === 2)) adr(args[0], args[1]);
else {
  console.error('usage: ship-numbers.ts merge|baseline <ours|theirs> <base> <ours> <theirs> | take <ref> | adr <onto> [<name>]');
  process.exit(2);
}
