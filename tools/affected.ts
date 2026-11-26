// The affected-tests map reader (#1112): which test files a change can break. tools/citadel-test --affected runs it.
// The map's format is the spec in the shared folder's specs/affected-tests-map.md; tools/affected-map.txt is Citadel's map.
//   node tools/affected.ts [--root <repo>] [--map <file>] [--base <ref>] [--narrow] [--paths <changed path>...]
// --narrow (#1928, what citadel-test runs by default): only the tests touched, the @samename ones and the @pinned ones the
// map's rules pick (#2037); no other rule's test, no @imports, nothing unmapped. The wide pick (no flag) is what CI, land.sh's smoke check and the burn-in read.
// Prints one line per answer on stdout, tab-separated:
//   run <test path> <why: "touched", or "map:<line> <source glob>" for each rule that picked it>
//   unmapped <changed path>        (no rule covers it and it is not a test file)
//   empty                          (nothing changed)
//   wide <n>                       (with --narrow: how many more tests the wide pick would run)
//   full                           (@fallback full and a path is unmapped: run the full suite instead)
// Exits 0, 2 on a bad map or a missing base, 3 for `full`. --paths stands in for the git diff (the tests use it).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve } from 'node:path';

export type Rule = { line: number; glob: string; re: RegExp; tests: string[] };
export type Map = { tests: RegExp[]; fallback: 'always' | 'full'; rules: Rule[]; sameName: RegExp[]; imports: RegExp[]; pinned: string[] };

// A glob over a repo path: `*` and `?` stay inside a folder name, `**` crosses folders, `**/` may be no folder at all.
export function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        re += '(?:.*/)?';
        i += 2;
      } else {
        re += '.*';
        i += 1;
      }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function parseMap(text: string): Map {
  const map: Map = { tests: [], fallback: 'always', rules: [], sameName: [], imports: [], pinned: [] };
  const fail = (n: number, why: string): never => {
    throw new Error(`map line ${n}: ${why}`);
  };
  text.split('\n').forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    // Rule lines end in text that may hold a trailing note after two spaces and a `#`; the spec has no inline comments, so none are cut.
    if (line.startsWith('@')) {
      const [name, ...vals] = line.slice(1).split(/\s+/);
      if (name === 'tests') {
        if (!vals.length) fail(n, '@tests needs a glob');
        map.tests.push(...vals.map(globRe));
      } else if (name === 'samename') {
        if (!vals.length) fail(n, '@samename needs a glob');
        map.sameName.push(...vals.map(globRe));
      } else if (name === 'imports') {
        if (!vals.length) fail(n, '@imports needs a glob');
        map.imports.push(...vals.map(globRe));
      } else if (name === 'pinned') {
        if (!vals.length) fail(n, '@pinned needs a test');
        map.pinned.push(...vals);
      } else if (name === 'fallback') {
        if (vals.length !== 1 || !['always', 'full'].includes(vals[0])) fail(n, '@fallback is "always" or "full"');
        map.fallback = vals[0] as 'always' | 'full';
      } else fail(n, `unknown directive @${name}`);
      return;
    }
    const m = line.match(/^(\S+):(?:\s+(.*))?$/);
    if (!m) return fail(n, 'a rule is "<source glob>: <test> [<test> ...]"');
    const tests = (m[2] ?? '').split(/\s+/).filter(Boolean);
    if (!tests.length) fail(n, `rule ${m[1]} names no test`);
    map.rules.push({ line: n, glob: m[1], re: globRe(m[1]), tests });
  });
  return map;
}

const git = (root: string, args: string[]) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  return r.stdout.split('\n').filter(Boolean);
};

// Everything changed from the base to HEAD, plus uncommitted and untracked work; a rename counts as both paths.
export function changedPaths(root: string, base: string): string[] {
  const names = (args: string[]) => git(root, ['diff', '--name-only', '--no-renames', ...args]);
  git(root, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  return [...new Set([...names([`${base}...HEAD`]), ...names(['HEAD']), ...git(root, ['ls-files', '--others', '--exclude-standard'])])].sort();
}

// The repo paths a test file imports directly with a relative specifier (from, import(), require()); `./x.ts` from test/ is test/x.ts.
export function directImports(root: string, file: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(root, file), 'utf8');
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g)) out.add(normalize(join(dirname(file), m[1])));
  return [...out];
}

export type Answer = { run: { test: string; why: string[] }[]; unmapped: string[]; empty: boolean; full: boolean };

export function affected(map: Map, changed: string[], tracked: string[], root: string, narrow = false): Answer {
  const picked = new Map<string, string[]>();
  const add = (test: string, why: string) => {
    const w = picked.get(test) ?? [];
    if (!w.includes(why)) w.push(why);
    picked.set(test, w);
  };
  const unmapped: string[] = [];
  let imports: globalThis.Map<string, string[]> | undefined;
  for (const p of changed) {
    const isTest = map.tests.some((re) => re.test(p));
    if (isTest && existsSync(join(root, p))) add(p, 'touched');
    let covered = isTest;
    for (const r of map.rules) {
      if (!r.re.test(p)) continue;
      if (r.glob !== '**') covered = true;
      for (const t of narrow ? r.tests.filter((t) => map.pinned.includes(t)) : r.tests) {
        const hits = /[*?]/.test(t) ? tracked.filter((f) => globRe(t).test(f)) : [t];
        for (const h of hits) add(h, `map:${r.line} ${r.glob}`);
      }
    }
    // @samename: a changed source file runs the tracked test files named after it (src/x.ts, public/x.js -> test/x.test.ts, x.test.js).
    if (!isTest && map.sameName.some((re) => re.test(p))) {
      const stem = p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
      for (const t of tracked) {
        if (!map.tests.some((re) => re.test(t))) continue;
        const b = t.slice(t.lastIndexOf('/') + 1);
        if (b === `${stem}.test.ts` || b === `${stem}.test.js`) {
          add(t, `name ${p}`);
          covered = true;
        }
      }
    }
    // @imports: a changed source file also runs every tracked test file that imports it directly (#1809).
    if (!narrow && !isTest && map.imports.some((re) => re.test(p))) {
      imports ??= new Map(tracked.filter((t) => map.tests.some((re) => re.test(t))).map((t) => [t, directImports(root, t)]));
      for (const [t, deps] of imports)
        if (deps.includes(p)) {
          add(t, `imports ${p}`);
          covered = true;
        }
    }
    if (!covered && !narrow) unmapped.push(p);
  }
  const run = [...picked].sort(([a], [b]) => a.localeCompare(b)).map(([test, why]) => ({ test, why }));
  return { run, unmapped, empty: changed.length === 0, full: map.fallback === 'full' && unmapped.length > 0 };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let root = resolve(import.meta.dirname, '..'),
    mapFile = '',
    base = 'main',
    narrow = false;
  let paths: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = resolve(argv[++i]);
    else if (argv[i] === '--map') mapFile = argv[++i];
    else if (argv[i] === '--base') base = argv[++i];
    else if (argv[i] === '--narrow') narrow = true;
    else if (argv[i] === '--paths') {
      paths = argv.slice(i + 1);
      break;
    } else {
      console.error(`affected: unknown argument ${argv[i]}`);
      process.exit(2);
    }
  }
  try {
    mapFile ||= [join(root, 'tools', 'affected-map.txt'), join(root, 'affected-map.txt')].find(existsSync) ?? '';
    if (!mapFile) throw new Error('no tools/affected-map.txt (or affected-map.txt) in the repo');
    const map = parseMap(readFileSync(mapFile, 'utf8'));
    const changed = paths ?? changedPaths(root, base);
    const tracked = git(root, ['ls-files']);
    const a = affected(map, changed, tracked, root, narrow);
    if (a.empty) console.log('empty');
    for (const r of a.run) console.log(`run\t${r.test}\t${r.why.join(', ')}`);
    if (narrow) console.log(`wide\t${affected(map, changed, tracked, root).run.filter((r) => !a.run.some((n) => n.test === r.test)).length}`);
    for (const u of a.unmapped) console.log(`unmapped\t${u}`);
    if (a.full) {
      console.log('full');
      process.exit(3);
    }
  } catch (e) {
    console.error(`affected: ${(e as Error).message}`);
    process.exit(2);
  }
}
