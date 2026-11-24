#!/usr/bin/env node
// test-habits: the four test habits a monthly audit keeps finding regrown, flagged in one branch's diff at review time
// (the pre-ship reviewer's Tests lens runs it; kit/skills/self-review/references/lenses.md). Cheap: git and a read of the
// test folder, no test runs. Every hit is a suspect the reviewer confirms by reading both sides, never a blocker.
//
//   node test-habits.ts [--base main] [--max-lines 60] [--words 4] [--files a.test.ts ...]
//
// It reads only the lines the branch adds (git diff <merge-base>...HEAD) to test files, and flags:
//   seam      a new test file named for a fix (-replay, -regression, -repro, a bug number), or a new short one, whose
//             seam (its name, the source modules it imports, the rare strings it sends) an existing test file already
//             drives (no such file found: no line, since there is nothing to name);
//   prose     an assert that matches a regex or a substring of 4+ words (a sentence of prompt, copy or tool text);
//   sleep     a fixed sleep or idle of 100 ms or more (setTimeout into a promise, sleep, delay, time.sleep...);
//   harness   a new copy of a harness: a function whose lines mostly repeat one in another test file or a shared
//             helper, an inline fake executable (a #! script), or a browser global stubbed by hand.
// Each line names the existing file to put the case in, or the shared helper to use or extend.
// --files treats those files as wholly new (no git), for checking a file by hand.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, normalize, relative } from 'node:path';

export type Added = Map<string, { isNew: boolean; lines: Map<number, string> }>;
export type Hit = { file: string; line: number; kind: 'seam' | 'prose' | 'sleep' | 'harness'; text: string };

const TEST_DIR = /(^|\/)(tests?|__tests__|spec|specs)\//;
const TEST_NAME = /(\.(test|spec)\.[cm]?[jt]sx?$)|(_test\.(go|py|rb|[cm]?[jt]s)$)|((^|\/)test_[^/]+\.py$)|(_spec\.rb$)|(Tests?\.(cs|java|kt|swift)$)/;
const CODE = /\.([cm]?[jt]sx?|py|go|rs|rb|cs|java|kt|swift|php)$/;
/** A file that is a test. */
export const isTest = (p: string): boolean => CODE.test(p) && (TEST_NAME.test(p) || (TEST_DIR.test(p) && /(^|\/)test_|[._-]test\.|\.spec\./.test(basename(p))));
/** A shared test helper: code under a test folder that isn't itself a test (helpers.ts, conftest.py, fixtures). */
export const isHelper = (p: string): boolean => CODE.test(p) && TEST_DIR.test(p) && !isTest(p) && !/(^|\/)fixtures?\//.test(p);
/** Named for one fix rather than a behaviour. */
const FIX_NAME = /[-_.](replay|regression|repro|bug|fix|issue)(?=[-_.])|[-_.]\d{3,}(?=[-_.])/i;

/** The added lines of each changed file in a `git diff -U0`. */
export function parseDiff(diff: string): Added {
  const out: Added = new Map();
  let file = '';
  let isNew = false;
  let n = 0;
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) {
      file = '';
      isNew = false;
    } else if (row.startsWith('new file mode')) isNew = true;
    else if (row.startsWith('+++ ')) {
      file = row === '+++ /dev/null' ? '' : row.slice(4).replace(/^b\//, '');
      if (file) out.set(file, { isNew, lines: new Map() });
    } else if (row.startsWith('@@')) n = Number(/\+(\d+)/.exec(row)?.[1] ?? 0);
    else if (file && row.startsWith('+')) out.get(file)!.lines.set(n++, row.slice(1));
    else if (file && row.startsWith(' ')) n++;
  }
  return out;
}

const git = (root: string, args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** What the branch adds against its merge-base with `base`. */
export function addedFromGit(root: string, base: string): Added {
  const mb = git(root, ['merge-base', base, 'HEAD']).trim();
  return parseDiff(git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--find-renames', `${mb}`, 'HEAD']));
}

/** Files as if each were added whole. */
export function addedWhole(root: string, files: string[]): Added {
  const out: Added = new Map();
  for (const f of files) {
    const rel = relative(root, join(root, f));
    out.set(rel, {
      isNew: true,
      lines: new Map(
        readFileSync(join(root, rel), 'utf8')
          .split('\n')
          .map((l, i) => [i + 1, l]),
      ),
    });
  }
  return out;
}

// ---- the corpus: every test and helper file in the repo, minus the ones this branch adds ----

type Def = { file: string; line: number; name: string; lines: string[] };
type Corpus = { tests: string[]; helpers: string[]; text: Map<string, string> };

function corpus(root: string, skip: Set<string>): Corpus {
  let files: string[];
  try {
    files = git(root, ['ls-files']).split('\n').filter(Boolean);
  } catch {
    files = [];
  }
  const text = new Map<string, string>();
  const tests: string[] = [];
  const helpers: string[] = [];
  for (const f of files) {
    if (skip.has(f) || /(^|\/)(node_modules|vendor|dist|build)\//.test(f)) continue;
    const t = isTest(f);
    if (!t && !isHelper(f)) continue;
    const p = join(root, f);
    if (!existsSync(p) || statSync(p).size > 1_000_000) continue;
    text.set(f, readFileSync(p, 'utf8'));
    (t ? tests : helpers).push(f);
  }
  return { tests, helpers, text };
}

/** The repo-local modules a test file imports (resolved to repo paths), leaving out packages and shared test helpers. */
export function imports(file: string, src: string): string[] {
  return importedPaths(file, src).filter((p) => !TEST_DIR.test(p)); // a shared helper is not a seam
}

/** Every repo-local module `src` imports, as a repo path without its extension. */
function importedPaths(file: string, src: string): string[] {
  const out = new Set<string>();
  const re = /(?:\bfrom\s+|\brequire\(\s*|\bimport\(\s*|^\s*import\s+)['"]([^'"]+)['"]|^\s*from\s+(\.*[\w.]+)\s+import\b/gm;
  for (const m of src.matchAll(re)) {
    const spec = m[1] ?? m[2];
    if (!spec) continue;
    let path: string;
    if (spec.startsWith('.') && m[1]) path = normalize(join(dirname(file), spec));
    else if (m[2]) path = spec.replace(/^\.+/, '').replaceAll('.', '/');
    else continue; // a package or node: builtin
    out.add(path.replace(/\.([cm]?[jt]sx?|py)$/, ''));
  }
  return [...out];
}

/** String literals specific enough to name a seam: a route, a tool or table name, a message. */
export function literals(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/'([^'\\\n]{4,100})'|"([^"\\\n]{4,100})"|`([^`\\$\n]{4,100})`/g)) {
    const s = (m[1] ?? m[2] ?? m[3]).trim();
    if (/^[\w/@#:.-][\w\s/@#:.,'?!-]*$/.test(s) && /[a-z]{2}/i.test(s) && !/^(utf-?8|node:|\.\.?\/)/i.test(s)) out.add(s);
  }
  return [...out];
}

/** The existing test file that drives most of what `src` drives, by shared rare imports and literals. */
function seamMatch(file: string, src: string, c: Corpus): { file: string; shared: string[] } | null {
  const mine = { imp: new Set(imports(file, src)), lit: new Set(literals(src)) };
  if (!mine.imp.size && !mine.lit.size) return null;
  const df = new Map<string, number>();
  const hitsBy = new Map<string, string[]>();
  for (const t of c.tests) {
    const s = c.text.get(t)!;
    const keys = [
      ...imports(t, s)
        .filter((x) => mine.imp.has(x))
        .map((x) => `i:${x}`),
      ...literals(s)
        .filter((x) => mine.lit.has(x))
        .map((x) => `l:${x}`),
    ];
    for (const k of keys) df.set(k, (df.get(k) ?? 0) + 1);
    if (keys.length) hitsBy.set(t, keys);
  }
  let best: { file: string; score: number; shared: string[] } | null = null;
  for (const [t, keys] of hitsBy) {
    const kept = keys.filter((k) => df.get(k)! <= (k.startsWith('i:') ? 10 : 3));
    const score = kept.reduce((a, k) => a + 1 / df.get(k)!, 0);
    const stem = basename(file).replace(/\.(test|spec)\..*$|_test\..*$|^test_|\.py$/g, '');
    const bonus = `${stem}.`.replace(FIX_NAME, '').replace(/\.$/, '') === basename(t).replace(/\.(test|spec)\..*$|_test\..*$|^test_|\.py$/g, '') ? 2 : 0;
    if (kept.length < 2 && !bonus) continue;
    if (score + bonus < 1) continue;
    if (!best || score + bonus > best.score) best = { file: t, score: score + bonus, shared: kept.map((k) => k.slice(2)) };
  }
  return best && { file: best.file, shared: best.shared };
}

// ---- definitions, for copied harnesses ----

const DEF = [
  /^(\s{0,2})(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+(\w+)\s*[(<]/,
  /^(\s{0,2})(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)?\s*(?::[^=]+)?=>|\w+\s*=>|\(\s*$|\([^)]*$)/,
  /^(\s{0,2})(?:export\s+)?class\s+(\w+)/,
  /^(\s{0,4})(?:async\s+)?def\s+(\w+)\s*\(/,
  /^(\s{0})func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/,
  /^(\s{0,4})(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/,
];
const norm = (l: string) => l.trim().replace(/\s+/g, ' ');
const meaningful = (l: string) => norm(l).length > 3 && !/^(\/\/|#|\*|\/\*)/.test(norm(l));

/** Top-level functions and classes in `src` with their body lines (cut at 60). */
export function defs(file: string, src: string): Def[] {
  const rows = src.split('\n');
  const out: Def[] = [];
  for (let i = 0; i < rows.length; i++) {
    let m: RegExpExecArray | null = null;
    for (const re of DEF) if ((m = re.exec(rows[i]))) break;
    if (!m) continue;
    const indent = m[1].length;
    const body = [rows[i]];
    let j = i + 1;
    for (; j < rows.length && body.length < 60; j++) {
      const r = rows[j];
      const ind = r.length - r.trimStart().length;
      if (r.trim() === '' || ind > indent) body.push(r);
      else {
        if (/^[}\])]/.test(r.trim())) body.push(r);
        break;
      }
    }
    out.push({ file, line: i + 1, name: m[2], lines: body.filter(meaningful).map(norm) });
  }
  return out;
}

/** Existing definitions that share most of `d`'s lines. Boilerplate lines (in over 30 definitions) don't count. */
function copiesOf(d: Def, index: Map<string, Def[]>): { def: Def; same: number }[] {
  const count = new Map<Def, number>();
  const mine = new Set(d.lines);
  for (const l of mine) {
    const ds = index.get(l);
    if (!ds || ds.length > 30) continue;
    for (const x of new Set(ds)) count.set(x, (count.get(x) ?? 0) + 1);
  }
  const need = Math.max(4, Math.ceil(mine.size * 0.6));
  return [...count]
    .filter(([, n]) => n >= need)
    .map(([def, same]) => ({ def, same }))
    .sort((a, b) => b.same - a.same);
}

/** The helper most test files import: where a shared copy should go. */
function mainHelper(c: Corpus): string | null {
  const n = new Map<string, number>();
  for (const t of c.tests) {
    const s = c.text.get(t)!;
    const used = new Set(importedPaths(t, s));
    for (const h of c.helpers) if (used.has(h.replace(/\.\w+$/, ''))) n.set(h, (n.get(h) ?? 0) + 1);
  }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? c.helpers.find((h) => /helper|conftest|support/.test(h)) ?? null;
}

// ---- the line checks ----

const ASSERTS = /\b(assert\w*|expect|ok|match|doesNotMatch|toMatch|toContain|includes|search|regex|assertIn|assertRegex|assertTrue|re\.(search|match|fullmatch))\b/;
/** Words in a regex body or string: runs of letters between spaces, \s, .* and the like. */
const words = (s: string) => s.split(/\\s[+*?]?|\.\*\??|\.\+\??|\s+|\[\^?\\?s?\]/).filter((w) => /^[a-z'’]{2,}[.,:;!?]?$/i.test(w)).length;

/** A regex or substring of `min`+ words in an assert: the hit's quoted text, or null. */
export function prosePin(line: string, min = 4): string | null {
  if (!ASSERTS.test(line)) return null;
  for (const m of line.matchAll(/(?:^|[(,=:\s!])\/((?:[^/\\\n[]|\\.|\[(?:[^\]\\]|\\.)*\])+)\/[dgimsuvy]*/g)) if (words(m[1]) >= min) return `/${m[1]}/`;
  for (const m of line.matchAll(/(?:RegExp|re\.(?:search|match|fullmatch|compile)|assertRegex|toMatch|match)\(\s*(?:[^,()]+,\s*)?r?(['"`])((?:(?!\1).){4,})\1/g)) if (words(m[2]) >= min) return m[2];
  for (const m of line.matchAll(/(?:includes|toContain|assertIn|contains|in)\s*\(?\s*(['"`])((?:(?!\1).){8,})\1/g)) if (!m[2].includes('${') && words(m[2]) >= min) return m[2];
  return null;
}

/** A fixed sleep of 100 ms or more: its length in ms, or null. Timeouts that cap a wait (until(..., 5000)) don't count. */
export function fixedSleep(line: string): number | null {
  const num = (s: string) => {
    const m = /^\s*([\d_]+(?:\.\d+)?(?:e\d+)?)\s*(?:\*\s*([\d_]+))?/.exec(s);
    return m ? Number(m[1].replaceAll('_', '')) * (m[2] ? Number(m[2].replaceAll('_', '')) : 1) : null;
  };
  const ms: (number | null)[] = [];
  let m: RegExpExecArray | null;
  if ((m = /setTimeout\(\s*(?:r|res|resolve|done|ok|next)\s*,\s*([^)]+)\)/.exec(line))) ms.push(num(m[1]));
  if ((m = /await\s+(?:setTimeout|sleep|delay|pause|wait|idle)\(\s*([\d_.]+[^),]*)/.exec(line))) ms.push(num(m[1]));
  if ((m = /\b(?:waitForTimeout|Thread\.sleep|usleep\(\s*\d+\s*\)\s*;?\s*\/\/)\(\s*([^)]+)\)/.exec(line))) ms.push(num(m[1]));
  if ((m = /\b(?:time|asyncio|trio|gevent)\.sleep\(\s*([\d_.]+)/.exec(line))) ms.push((num(m[1]) ?? 0) * 1000);
  if ((m = /\btime\.Sleep\(\s*([\d_.]*)\s*\*?\s*time\.(Second|Millisecond)/.exec(line))) ms.push(Number(m[1] || 1) * (m[2] === 'Second' ? 1000 : 1));
  if ((m = /\bthread::sleep\(\s*Duration::from_(secs|millis)\(\s*([\d_]+)/.exec(line))) ms.push(Number(m[2].replaceAll('_', '')) * (m[1] === 'secs' ? 1000 : 1));
  if ((m = /\b(?:holds|idle|quiet|stays?)\(.*?\bms:\s*([\d_]+)/.exec(line)) && !/\bafter\s*:/.test(line)) ms.push(num(m[1]));
  const hit = ms.filter((x): x is number => x != null && x >= 100);
  return hit.length ? Math.max(...hit) : null;
}

const STUB = /\b(?:globalThis|global|window|self)\.(document|window|EventSource|WebSocket|localStorage|sessionStorage|navigator|location|matchMedia|requestAnimationFrame|IntersectionObserver|ResizeObserver|MutationObserver|HTMLElement|customElements)\s*=(?!=)|defineProperty\(\s*globalThis\s*,\s*['"](\w+)['"]/;

// ---- the scan ----

const WAIT_HELPER = /^(until|waitFor|waitUntil|eventually|poll\w*|retry\w*|wait_for\w*|wait_until\w*)$/;

function exportsOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)/gm)) out.push(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm))
    for (const n of m[1].split(','))
      out.push(
        n
          .trim()
          .split(/\s+as\s+/)
          .pop()!,
      );
  for (const m of src.matchAll(/^(?:async\s+)?def\s+(\w+)|^func\s+([A-Z]\w*)|^pub\s+fn\s+(\w+)/gm)) out.push(m[1] ?? m[2] ?? m[3]);
  return out.filter((n) => n && !n.startsWith('_'));
}

export function scan(root: string, added: Added, opts: { maxLines?: number; words?: number } = {}): Hit[] {
  const maxLines = opts.maxLines ?? 60;
  const tests = [...added].filter(([f, a]) => isTest(f) && a.lines.size);
  if (!tests.length) return [];
  const c = corpus(root, new Set([...added].filter(([, a]) => a.isNew).map(([f]) => f)));
  const hits: Hit[] = [];
  const helper = mainHelper(c);
  const into = helper ? `move one copy into ${helper} and use it there` : 'move one copy into a shared test helper and use it there';

  // helpers that already do a job, by what their exported functions contain
  const helperDefs = c.helpers.flatMap((h) => {
    const ex = new Set(exportsOf(c.text.get(h)!));
    return defs(h, c.text.get(h)!).filter((d) => ex.has(d.name));
  });
  const reexports = new Map<string, string>(); // name -> the helper that re-exports it (test/helpers.ts re-exports until)
  for (const h of c.helpers) for (const n of exportsOf(c.text.get(h)!)) if (!reexports.has(n) || h === helper) reexports.set(n, h);
  const named = (d: Def) => `${d.name} (${reexports.get(d.name) ?? d.file})`;
  const waitHelpers = helperDefs.filter((d) => WAIT_HELPER.test(d.name)).map(named);
  const fakeHelpers = helperDefs.filter((d) => d.lines.some((l) => /['"`]#!/.test(l))).map(named);

  const index = new Map<string, Def[]>();
  for (const f of [...c.tests, ...c.helpers]) for (const d of defs(f, c.text.get(f)!)) for (const l of new Set(d.lines)) (index.get(l) ?? index.set(l, []).get(l)!).push(d);
  const whole = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : [...added.get(f)!.lines.values()].join('\n'));
  const othersWith = (re: RegExp, not: string) => c.tests.filter((t) => t !== not && re.test(c.text.get(t)!)).length;

  for (const [file, a] of tests) {
    const src = whole(file);
    // seam: a new file named for a fix, or a short one, that an existing file already drives
    if (a.isNew) {
      const fixNamed = FIX_NAME.test(basename(file));
      const short = src.split('\n').length <= maxLines;
      if (fixNamed || short) {
        const m = seamMatch(file, src, c);
        const shared = m?.shared.length
          ? `shares ${m.shared
              .slice(0, 3)
              .map((s) => `'${s}'`)
              .join(', ')}`
          : 'same name';
        if (m) hits.push({ file, line: 1, kind: 'seam', text: `${fixNamed ? 'new file named for a fix' : `new ${src.split('\n').length}-line file`}; ${m.file} already drives the same seam (${shared}): add the case there as a row or an assert, unless this file opens a new seam` });
      }
    }
    let fake = false;
    let stub = false;
    for (const [n, line] of a.lines) {
      const p = prosePin(line, opts.words ?? 4);
      if (p) hits.push({ file, line: n, kind: 'prose', text: `assert pins ${p.length > 60 ? `${p.slice(0, 57)}...` : p}: pin what the code does (the status, the field, refused or posted), not the sentence` });
      const s = /timing-ok:/.test(`${a.lines.get(n - 1) ?? ''}\n${line}`) ? null : fixedSleep(line); // the repo's escape, on the row or the one above
      if (s != null) hits.push({ file, line: n, kind: 'sleep', text: `fixed ${s} ms wait: wait on the event${waitHelpers.length ? ` with ${waitHelpers.slice(0, 2).join(' or ')}` : ''}, or give the code a setting the test turns down` });
      if (!fake && /['"`]#!\s*\/|['"`]#!\$\{/.test(line)) {
        fake = true;
        const others = othersWith(/['"`]#!\s*\/|['"`]#!\$\{/, file);
        hits.push({ file, line: n, kind: 'harness', text: `writes a fake executable inline (${others} other test files do too): ${fakeHelpers.length ? `use or extend ${fakeHelpers.slice(0, 3).join(', ')}` : into}` });
      }
      const st = STUB.exec(line);
      if (!stub && st) {
        stub = true;
        const g = st[1] ?? st[2];
        const re = new RegExp(`\\b(?:globalThis|global|window|self)\\.${g}\\s*=(?!=)|defineProperty\\(\\s*globalThis\\s*,\\s*['"]${g}['"]`);
        const shared = c.helpers.filter((h) => re.test(c.text.get(h)!));
        hits.push({ file, line: n, kind: 'harness', text: `stubs the browser's ${g} by hand (${othersWith(re, file)} other test files do too): ${shared.length ? `use the stub in ${shared.slice(0, 2).join(', ')}` : into}` });
      }
    }
    // harness: a definition the branch adds that mostly repeats one elsewhere
    for (const d of defs(file, src)) {
      if (d.lines.length < 4 || !a.lines.has(d.line)) continue;
      const copies = copiesOf(d, index).filter((x) => x.def.file !== file);
      if (!copies.length) continue;
      const inHelper = copies.find((x) => c.helpers.includes(x.def.file));
      const top = inHelper ?? copies[0];
      const files = new Set(copies.map((x) => x.def.file));
      hits.push({
        file,
        line: d.line,
        kind: 'harness',
        text: inHelper
          ? `${d.name}() repeats ${named(inHelper.def)} (${inHelper.same} of ${new Set(d.lines).size} lines): use it, or extend it with what this one adds`
          : `${d.name}() repeats ${top.def.file}:${top.def.line} ${top.def.name}() (${top.same} of ${new Set(d.lines).size} lines)${files.size > 1 ? `, and ${files.size - 1} more test files carry a copy` : ''}: ${into}`,
      });
    }
  }
  hits.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
  // at most 3 of a kind per file: the reviewer needs the pattern, not every line of it
  const out: Hit[] = [];
  const seen = new Map<string, Hit[]>();
  for (const h of hits) (seen.get(`${h.file}\0${h.kind}`) ?? seen.set(`${h.file}\0${h.kind}`, []).get(`${h.file}\0${h.kind}`)!).push(h);
  for (const group of seen.values()) {
    out.push(...group.slice(0, 3));
    if (group.length > 3)
      out.push({
        ...group[3],
        text: `+${group.length - 3} more ${group[3].kind} suspects in this file (lines ${group
          .slice(3)
          .map((h) => h.line)
          .join(', ')})`,
      });
  }
  return out.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line);
}

function main(argv: string[]) {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      readFileSync(new URL(import.meta.url), 'utf8')
        .split('\n')
        .slice(1, 16)
        .map((l) => l.replace(/^\/\/ ?/, ''))
        .join('\n'),
    );
    return;
  }
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const fi = argv.indexOf('--files');
  const base = arg('--base') ?? 'main';
  const added =
    fi >= 0
      ? addedWhole(
          root,
          argv.slice(fi + 1).map((f) => relative(root, join(process.cwd(), f))),
        )
      : addedFromGit(root, base);
  const hits = scan(root, added, { maxLines: Number(arg('--max-lines') ?? 60), words: Number(arg('--words') ?? 4) });
  const n = [...added.keys()].filter(isTest).length;
  console.log(`test-habits: ${hits.length} suspect${hits.length === 1 ? '' : 's'} in ${n} new or changed test file${n === 1 ? '' : 's'}${fi >= 0 ? '' : ` (against ${base})`}`);
  for (const h of hits) console.log(`${h.file}:${h.line}: ${h.kind}: ${h.text}`);
}

if (import.meta.main) main(process.argv.slice(2));
