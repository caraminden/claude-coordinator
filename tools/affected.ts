// The affected-tests map reader (#1112): which test files a change can break. tools/citadel-test --affected runs it.
// The map's format is the spec in the shared folder's specs/affected-tests-map.md; tools/affected-map.txt is Citadel's map.
//   node tools/affected.ts [--root <repo>] [--map <file>] [--base <ref>] [--paths <changed path>...]
// Prints one line per answer on stdout, tab-separated:
//   run <test path> <why: "touched", or "map:<line> <source glob>" for each rule that picked it>
//   unmapped <changed path>        (no rule covers it and it is not a test file)
//   empty                          (nothing changed)
//   full                           (@fallback full and a path is unmapped: run the full suite instead)
// Exits 0, 2 on a bad map or a missing base, 3 for `full`. --paths stands in for the git diff (the tests use it).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type Rule = { line: number; glob: string; re: RegExp; tests: string[] };
export type Map = { tests: RegExp[]; fallback: 'always' | 'full'; rules: Rule[] };

// A glob over a repo path: `*` and `?` stay inside a folder name, `**` crosses folders, `**/` may be no folder at all.
export function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function parseMap(text: string): Map {
  const map: Map = { tests: [], fallback: 'always', rules: [] };
  const fail = (n: number, why: string): never => { throw new Error(`map line ${n}: ${why}`); };
  text.split('\n').forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    // Rule lines end in text that may hold a trailing note after two spaces and a `#`; the spec has no inline comments, so none are cut.
    if (line.startsWith('@')) {
      const [name, ...vals] = line.slice(1).split(/\s+/);
      if (name === 'tests') { if (!vals.length) fail(n, '@tests needs a glob'); map.tests.push(...vals.map(globRe)); }
      else if (name === 'fallback') { if (vals.length !== 1 || !['always', 'full'].includes(vals[0])) fail(n, '@fallback is "always" or "full"'); map.fallback = vals[0] as 'always' | 'full'; }
      else fail(n, `unknown directive @${name}`);
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

export type Answer = { run: { test: string; why: string[] }[]; unmapped: string[]; empty: boolean; full: boolean };

export function affected(map: Map, changed: string[], tracked: string[], root: string): Answer {
  const picked = new Map<string, string[]>();
  const add = (test: string, why: string) => { const w = picked.get(test) ?? []; if (!w.includes(why)) w.push(why); picked.set(test, w); };
  const unmapped: string[] = [];
  for (const p of changed) {
    const isTest = map.tests.some((re) => re.test(p));
    if (isTest && existsSync(join(root, p))) add(p, 'touched');
    let covered = isTest;
    for (const r of map.rules) {
      if (!r.re.test(p)) continue;
      if (r.glob !== '**') covered = true;
      for (const t of r.tests) {
        const hits = /[*?]/.test(t) ? tracked.filter((f) => globRe(t).test(f)) : [t];
        for (const h of hits) add(h, `map:${r.line} ${r.glob}`);
      }
    }
    if (!covered) unmapped.push(p);
  }
  const run = [...picked].sort(([a], [b]) => a.localeCompare(b)).map(([test, why]) => ({ test, why }));
  return { run, unmapped, empty: changed.length === 0, full: map.fallback === 'full' && unmapped.length > 0 };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let root = resolve(import.meta.dirname, '..'), mapFile = '', base = 'main';
  let paths: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = resolve(argv[++i]);
    else if (argv[i] === '--map') mapFile = argv[++i];
    else if (argv[i] === '--base') base = argv[++i];
    else if (argv[i] === '--paths') { paths = argv.slice(i + 1); break; }
    else { console.error(`affected: unknown argument ${argv[i]}`); process.exit(2); }
  }
  try {
    mapFile ||= [join(root, 'tools', 'affected-map.txt'), join(root, 'affected-map.txt')].find(existsSync) ?? '';
    if (!mapFile) throw new Error('no tools/affected-map.txt (or affected-map.txt) in the repo');
    const map = parseMap(readFileSync(mapFile, 'utf8'));
    const changed = paths ?? changedPaths(root, base);
    const a = affected(map, changed, git(root, ['ls-files']), root);
    if (a.empty) console.log('empty');
    for (const r of a.run) console.log(`run\t${r.test}\t${r.why.join(', ')}`);
    for (const u of a.unmapped) console.log(`unmapped\t${u}`);
    if (a.full) { console.log('full'); process.exit(3); }
  } catch (e) {
    console.error(`affected: ${(e as Error).message}`);
    process.exit(2);
  }
}
