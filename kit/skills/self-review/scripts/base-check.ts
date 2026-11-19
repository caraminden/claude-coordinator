#!/usr/bin/env node
// base-check: runs a branch's new and changed tests against the base's code, and says which pass there. A test
// that passes without the change proves nothing about it (Cara, 2026-11-16: "Check the result"). Run from the
// branch's worktree, with the branch committed:
//   node base-check.ts [--base <ref>] [--cmd '<command with {file}>'] [--timeout <seconds>]
// It diffs HEAD against the merge-base with main (or origin/main, or --base), checks the base out into a scratch
// worktree under $TMPDIR, copies in HEAD's version of every changed test file (Rust: HEAD's trailing
// #[cfg(test)] module spliced onto the base's file), runs each changed test file once there, and reports each new
// or changed test case as:
//   PASSES ON BASE  a finding: fix the test, or say why it's fine
//   red             failed on the base, or the file didn't load or build there (a new file that can't compile
//                   without the change counts as red)
//   skipped         not checked, and why: a stack it doesn't know, a missing tool, a timeout, no changed case
//                   found in a changed file. All files together stop within 540 s (inside a 600 s Bash call).
// Runners, picked per test file: node --test (the package.json test script's launcher and flags kept), vitest,
// cargo test (one crate's test target, through citadel-heavy when it is on PATH, sharing the worktree's target/
// so only workspace crates rebuild), pytest (the worktree's .venv when there is one; a module that resolves into the branch's checkout is skipped, not run),
// shell tests (tools/*-test.sh: run with bash, the exit status decides). --cmd overrides the
// runner with a shell command run through sh -c from the scratch tree's root ({file} is the file's absolute path there); its output is read with
// every parser, and with none matching, its exit status decides for the whole file.
// Exit: 0 nothing passes on the base, 1 something does, 2 a usage or setup error. Never the full suite.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Runner = 'node' | 'vitest' | 'cargo' | 'pytest' | 'sh' | 'cmd';
export type Result = { name: string; ok: boolean | 'skip' };
type Change = { status: string; path: string; old: string };
type Entry = { path: string; runner: Runner | null; why?: string; cases: string[] | null; spliced?: boolean };
type Verdict = { kind: 'flag' | 'red' | 'skipped'; label: string; detail: string };

const BUDGET = 540; // seconds for all files together
const JS_TEST = /(?:\.(?:test|spec)|[-_]test)\.[cm]?[jt]sx?$/;
const JS_DASH_TEST = /[-_]test\.[cm]?[jt]sx?$/; // also names a helper (self-test.ts): a test file only where the package's test script runs it
const SH_TEST = /(?:[-_]test|^test[-_].*)\.sh$/;
const PY_TEST = /(?:^test_.*|_test)\.py$/;
// A test file by its name in any language (math_test.rb, test_x.lua, FooTest.php), as against a helper or fixture.
const ANY_TEST = /^tests?[_.-]|[._-](?:tests?|spec)\.\w+$|Tests?\.\w+$/;
const OTHER_TEST: [RegExp, string][] = [
  [/\.cs$/, 'dotnet tests'],
  [/\.(?:kt|kts|java)$/, 'Gradle and JVM tests'],
  [/_test\.go$/, 'Go tests'],
];

/**
 * A path that belongs to the tests: a test file, or anything in a test folder (helpers, fixtures). A `-test.ts` name
 * alone isn't enough (self-test.ts is a helper): the package's test `script` has to run that folder or file, `rel` being
 * the path from the package's folder.
 */
export function isTestPath(p: string, script = '', rel = p): boolean {
  const parts = p.split('/');
  const name = parts.at(-1)!;
  if (parts.slice(0, -1).some((s) => ['test', 'tests', '__tests__', 'spec', 'testdata', 'fixtures'].includes(s))) return true;
  if (JS_DASH_TEST.test(name) && !/\.(?:test|spec)\./.test(name)) {
    const d = dirname(rel);
    return script.split(/\s+/).some((a) => a === rel || (d !== '.' && (a.replace(/\/$/, '') === d || a.startsWith(d + '/'))));
  }
  return SH_TEST.test(name) || JS_TEST.test(name) || PY_TEST.test(name) || /(?:^|\/)tests?\.rs$/.test(p) || /_test\.go$/.test(name) || /Tests?\.cs$/.test(name);
}

/** Lines of a Rust file from its trailing `#[cfg(test)] mod … {` to the end, or null when its tests aren't that shape. */
export function rustTestTail(text: string): number | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^#\[cfg\(test\)\]\s*$/.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && (lines[j].trim() === '' || lines[j].startsWith('#['))) j++;
    if (!/^(?:pub(?:\([\w:]+\))?\s+)?mod\s+\w+\s*\{/.test(lines[j] ?? '')) continue;
    // Everything after must sit inside the module: only its closing brace starts at column 0.
    const rest = lines.slice(j + 1).filter((l) => l.trim() !== '' && !/^\s/.test(l) && !l.startsWith('//'));
    if (rest.length === 1 && /^\}\s*$/.test(rest[0])) return i;
  }
  return null;
}

/** The base's code with HEAD's trailing test module, or null when either file's tests aren't one trailing module. */
export function spliceRust(base: string, head: string): string | null {
  const h = rustTestTail(head);
  if (h === null) return null;
  const headTail = head.split('\n').slice(h).join('\n');
  if (!/^#\[cfg\(test\)\]/m.test(base)) return base.replace(/\n*$/, '\n\n') + headTail;
  const b = rustTestTail(base);
  if (b === null) return null;
  return base.split('\n').slice(0, b).join('\n') + '\n' + headTail;
}

const CASE_RE: Record<'js' | 'rs' | 'py', RegExp> = {
  js: /^[ \t]*(?:it|test|\w+\.test)(?:\.(?:only|skip|todo|concurrent|sequential|fails))*\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/gm,
  rs: /#\[(?:[\w:]+::)?test\]\s*(?:#\[[^\]]*\]\s*)*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g,
  py: /^[ \t]*(?:async\s+)?def\s+(test\w*)\s*\(/gm,
};

function langOf(p: string): 'js' | 'rs' | 'py' | null {
  return /\.[cm]?[jt]sx?$/.test(p) ? 'js' : p.endsWith('.rs') ? 'rs' : p.endsWith('.py') ? 'py' : null;
}

/** Each test case's name and its text (to the next case), closers and whitespace at the end dropped. */
export function casesOf(text: string, lang: 'js' | 'rs' | 'py'): Map<string, string> {
  const re = new RegExp(CASE_RE[lang].source, CASE_RE[lang].flags);
  const hits = [...text.matchAll(re)];
  const out = new Map<string, string>();
  hits.forEach((m, k) => {
    const name = lang === 'js' ? m[2].replace(/\\(.)/g, '$1') : m[1];
    const body = text.slice(m.index, hits[k + 1]?.index ?? text.length).replace(/(?:\n[ \t]*[})\];,]*[ \t]*)+$/, '').trimEnd();
    out.set(name, (out.get(name) ?? '') + body);
  });
  return out;
}

/** The cases HEAD adds or changes against the base's version of the file (all of them for a new file). */
export function changedCases(base: string | null, head: string, lang: 'js' | 'rs' | 'py'): string[] {
  const before = base === null ? new Map<string, string>() : casesOf(base, lang);
  return [...casesOf(head, lang)].filter(([n, body]) => before.get(n) !== body).map(([n]) => n);
}

/** Per-case results from node --test's TAP, vitest's tap-flat, cargo test's and pytest -rA's output. */
export function parseResults(out: string): Result[] {
  const res: Result[] = [];
  for (const line of out.split('\n')) {
    let m = /^\s*(not ok|ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*| # time=.*)?$/.exec(line);
    if (m) {
      res.push({ name: m[2].replace(/\\#/g, '#').replace(/\\\\/g, '\\'), ok: m[3] ? 'skip' : m[1] === 'ok' });
      continue;
    }
    m = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/.exec(line);
    if (m) {
      res.push({ name: m[1], ok: m[2] === 'ignored' ? 'skip' : m[2] === 'ok' });
      continue;
    }
    m = /^(PASSED|FAILED|ERROR|XPASS|XFAIL) (\S+::\S+)/.exec(line);
    if (m) res.push({ name: m[2], ok: m[1] === 'XFAIL' ? 'skip' : m[1] === 'PASSED' || m[1] === 'XPASS' });
  }
  return res;
}

/** Whether a reported name is this case: equal, or its last part (vitest's " > ", cargo's and pytest's "::"). */
export function matches(reported: string, name: string): boolean {
  const r = reported.replace(/\[.*\]$/, '');
  return r === name || r.endsWith(' > ' + name) || r.endsWith('::' + name);
}

/** The line of a failed run that says why: a load or build error before any generic one. */
export function firstError(out: string): string {
  const lines = out.split('\n').map((l) => l.replace(/^#\s?/, '').trim());
  // The error's own line ("SyntaxError: …", "Error [ERR_MODULE_NOT_FOUND]: …", rustc's "error[E0425]: …"), then any.
  const pick = [/^(?:\w*Error(?: \[\w+\])?:|error\[E\d+\]|E\s+\w*Error\b)/, /Cannot find|does not provide|No module named|^error\b|\bError:/i];
  for (const re of pick) {
    const hit = lines.find((l) => re.test(l) && !/^(?:throw |at |error: 'test failed'|code: 'ERR_TEST_FAILURE')/.test(l));
    if (hit) return hit.slice(0, 200);
  }
  return (lines.filter(Boolean).at(-1) ?? '').slice(0, 200);
}

/** One file's verdicts from its run on the base. */
export function judge(entry: Pick<Entry, 'path' | 'cases'>, run: { status: number | null; out: string; timedOut: boolean; parsed: boolean }): Verdict[] {
  const { path, cases } = entry;
  if (run.timedOut) return [{ kind: 'skipped', label: path, detail: 'timed out on the base' }];
  const results = run.parsed ? parseResults(run.out) : [];
  if (cases?.length === 0) return [{ kind: 'skipped', label: path, detail: 'no new or changed case found (only shared setup or helpers changed): judge it by hand' }];
  if (cases === null) {
    if (run.status === 0 && run.parsed && results.length === 0) return [{ kind: 'skipped', label: path, detail: 'ran no tests on the base' }];
    return [run.status === 0 ? { kind: 'flag', label: path, detail: 'the whole file passed on the base' } : { kind: 'red', label: path, detail: firstError(run.out) }];
  }
  if (run.status === 0 && run.parsed && results.length === 0) return [{ kind: 'skipped', label: path, detail: 'ran no tests on the base' }];
  // A file that failed with none of its cases reported never ran them: one line, with the reason.
  if (run.status !== 0 && !cases.some((name) => results.some((r) => matches(r.name, name)))) {
    return [{ kind: 'red', label: path, detail: `didn't run on the base (${cases.length} new or changed case${cases.length === 1 ? '' : 's'}): ${firstError(run.out)}` }];
  }
  return cases.map((name): Verdict => {
    const mine = results.filter((r) => matches(r.name, name));
    const label = `${path} › ${name}`;
    if (mine.length === 0) {
      return run.status === 0
        ? { kind: 'flag', label, detail: 'not named in the output, and the whole file passed on the base' }
        : { kind: 'red', label, detail: `not named in the output, and the file failed on the base` };
    }
    if (mine.some((r) => r.ok === false)) return { kind: 'red', label, detail: '' };
    if (mine.every((r) => r.ok === 'skip')) return { kind: 'skipped', label, detail: 'skipped or todo on the base' };
    return { kind: 'flag', label, detail: '' };
  });
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

function show(root: string, rev: string, path: string): string | null {
  const r = spawnSync('git', ['show', `${rev}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout : null;
}

function nearest(root: string, from: string, names: string[]): string | null {
  for (let d = dirname(from); ; d = dirname(d)) {
    if (names.some((n) => existsSync(join(root, d, n)))) return d;
    if (d === '.' || d === '/' || d === '') return null;
  }
}

function onPath(cmd: string): string | null {
  const r = spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The node --test command the package's test script uses, for one file: its launcher and flags, our reporter. */
export function nodeCommand(script: string, file: string): string[] {
  const first = script.trim().split(/\s+/)[0] ?? '';
  const launcher = /--test\b/.test(script) && first && first !== 'node' && !first.includes('=') ? first : 'node';
  const flags = [...script.matchAll(/(?:^|\s)(--test-global-setup=\S+|--test-timeout=\d+|--experimental-[\w-]+(?:=\S+)?|--(?:import|require)(?:=|\s+)\S+)/g)].flatMap((m) => m[1].split(/\s+/));
  return [launcher, '--test', '--test-force-exit', '--test-reporter=tap', ...flags.map((f) => f.replace(/^['"]|['"]$/g, '')), file];
}

/** The test script of the package.json nearest above a path ('' when none), and the path from that package's folder. */
function pkgScript(root: string, path: string): string {
  const dir = nearest(root, path, ['package.json']);
  if (dir === null) return '';
  try {
    return JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).scripts?.test ?? '';
  } catch {
    return '';
  }
}
function pkgRel(root: string, path: string): string {
  return relative(nearest(root, path, ['package.json']) ?? '.', path);
}

/** PYTHONPATH for the base's tree: its folder (and src/), then what the caller had, minus entries inside the branch's checkout. */
export function pyPath(cwd: string, root: string, inherited: string | undefined, hasSrc: boolean): string {
  const keep = (inherited ?? '').split(':').filter((e) => e && e !== root && !e.startsWith(root + '/'));
  return [...(hasSrc ? [join(cwd, 'src')] : []), cwd, ...keep].join(':');
}

/** Modules whose probe line ("MOD name path") resolves inside the branch's checkout, not the base's tree. */
export function pyLeaks(out: string, root: string, tree: string): string[] {
  const inside = (p: string, d: string) => p === d || p.startsWith(d + '/');
  return out.split('\n').flatMap((l) => {
    const m = /^MOD (\S+) (\S+)$/.exec(l);
    return m && inside(m[2], root) && !inside(m[2], tree) ? [m[1]] : [];
  });
}

const PY_PROBE = `import sys, os, importlib.util
for d in sys.argv[1:]:
    if not os.path.isdir(d): continue
    for n in os.listdir(d):
        m = n[:-3] if n.endswith('.py') else n if os.path.isfile(os.path.join(d, n, '__init__.py')) else None
        if m and m.isidentifier() and not m.startswith('test'):
            s = importlib.util.find_spec(m)
            print('MOD', m, getattr(s, 'origin', None) or '-')
`;

function plan(root: string, base: string, changes: Change[], cmd: string | null): { entries: Entry[]; writes: Map<string, string> } {
  const entries: Entry[] = [];
  const writes = new Map<string, string>();
  for (const c of changes) {
    const head = show(root, 'HEAD', c.path);
    if (head === null) continue;
    const baseText = c.status === 'A' ? null : show(root, base, c.old);
    const lang = langOf(c.path);
    // A Rust source file holding its own tests: only its test module comes from HEAD.
    if (!isTestPath(c.path, pkgScript(root, c.path), pkgRel(root, c.path)) && c.path.endsWith('.rs') && /^#\[cfg\(test\)\]/m.test(head)) {
      const h = rustTestTail(head);
      const headTail = h === null ? null : head.split('\n').slice(h).join('\n');
      const b = baseText === null ? null : rustTestTail(baseText);
      const baseTail = baseText === null || b === null ? null : baseText.split('\n').slice(b).join('\n');
      if (headTail !== null && headTail === baseTail) continue; // only the code changed
      if (baseText === null) {
        entries.push({ path: c.path, runner: null, why: "a new source file: its tests can't run without it", cases: null });
        continue;
      }
      const spliced = spliceRust(baseText, head);
      if (spliced === null) {
        entries.push({ path: c.path, runner: null, why: "its tests aren't one trailing #[cfg(test)] module, so they can't be split from the code", cases: null });
        continue;
      }
      writes.set(c.path, spliced);
      entries.push({ path: c.path, runner: cmd ? 'cmd' : 'cargo', cases: changedCases(baseText, head, 'rs'), spliced: true });
      continue;
    }
    if (!isTestPath(c.path, pkgScript(root, c.path), pkgRel(root, c.path))) continue;
    writes.set(c.path, head);
    const name = basename(c.path);
    const other = OTHER_TEST.find(([re]) => re.test(name));
    let runner: Runner | null = null;
    let why: string | undefined;
    if (cmd && (JS_TEST.test(name) || PY_TEST.test(name) || SH_TEST.test(name) || c.path.endsWith('.rs') || other || ANY_TEST.test(name))) runner = 'cmd';
    else if (JS_TEST.test(name)) {
      const dir = nearest(root, c.path, ['package.json']);
      const script: string = dir === null ? '' : (JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')).scripts?.test ?? '');
      if (/\bjest\b/.test(script)) why = 'jest is not supported yet';
      else runner = /\bvitest\b/.test(script) ? 'vitest' : 'node';
    } else if (PY_TEST.test(name)) runner = 'pytest';
    else if (c.path.endsWith('.rs') && (/(?:^|\/)tests\/[^/]+\.rs$/.test(c.path) || /(?:^|\/)tests\/[^/]+\/main\.rs$/.test(c.path) || /(?:^|\/)src\/.*tests?\.rs$/.test(c.path))) runner = 'cargo';
    else if (other) why = `${other[1]} are not supported yet: run it on the base by hand`;
    else if (SH_TEST.test(name)) runner = 'sh';
    else if (ANY_TEST.test(name)) why = 'no runner for this kind of test file: run it on the base by hand';
    else continue; // a helper or fixture: copied in, run through the tests that use it
    entries.push({ path: c.path, runner, why, cases: lang && runner ? changedCases(baseText, head, lang) : null });
  }
  return { entries, writes };
}

/** The crate's name and the cargo target arguments that run this file's tests. */
export function cargoArgs(root: string, path: string, cases: string[] = []): string[] | string {
  const dir = nearest(root, path, ['Cargo.toml']);
  if (dir === null) return 'no Cargo.toml above it';
  const toml = readFileSync(join(root, dir, 'Cargo.toml'), 'utf8');
  const pkg = /\[package\][^[]*?\bname\s*=\s*"([^"]+)"/.exec(toml)?.[1];
  if (!pkg) return `${join(dir, 'Cargo.toml')} has no [package] name`;
  const rel = relative(dir, path).split(sep).join('/');
  let m = /^tests\/([^/]+?)(?:\.rs|\/main\.rs)$/.exec(rel);
  if (m) return ['-p', pkg, '--test', m[1]];
  m = /^src\/(.*)\.rs$/.exec(rel);
  if (!m) return `${rel} is not under tests/ or src/ of ${pkg}`;
  // The changed cases as name filters, so only they run, not the whole lib or bin target.
  if (m[1] === 'main' || m[1].startsWith('bin/')) return ['-p', pkg, '--bins', ...(cases.length ? ['--', ...cases] : [])];
  const mod = m[1].split('/').filter((s) => s !== 'mod' && s !== 'lib').join('::');
  return ['-p', pkg, '--lib', '--', ...(cases.length ? cases : mod ? [`${mod}::`] : [])];
}

function main(argv: string[]): number {
  let baseRef: string | null = null;
  let cmd: string | null = null;
  let limit = 300;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') baseRef = argv[++i];
    else if (a === '--cmd') cmd = argv[++i];
    else if (a === '--timeout') limit = Number(argv[++i]);
    else if (a === '-h' || a === '--help') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0].replace(/^#!.*\n/, '').replace(/^\/\/ ?/gm, ''));
      return 0;
    } else {
      console.error(`base-check: unknown argument ${a} (--help)`);
      return 2;
    }
  }
  if (!Number.isFinite(limit) || limit <= 0 || (cmd !== null && !cmd.includes('{file}'))) {
    console.error('base-check: --timeout takes seconds; --cmd needs {file} where the test file goes');
    return 2;
  }
  let root: string;
  try {
    root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  } catch {
    console.error('base-check: run it inside the branch\'s worktree');
    return 2;
  }
  const ref = baseRef ?? ['main', 'origin/main'].find((r) => spawnSync('git', ['rev-parse', '--verify', '-q', r], { cwd: root }).status === 0);
  if (!ref) {
    console.error('base-check: no main or origin/main here: name the base with --base <ref>');
    return 2;
  }
  const base = git(root, 'merge-base', 'HEAD', ref).trim();
  const changes: Change[] = git(root, 'diff', '--name-status', '-M', base, 'HEAD')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .filter(([s]) => !s.startsWith('D'))
    .map(([s, a, b]) => ({ status: s[0], path: b ?? a, old: a }));
  const { entries, writes } = plan(root, base, changes, cmd);
  console.log(`base-check: base ${base.slice(0, 8)} (merge-base of HEAD and ${ref})`);
  if (git(root, 'status', '--porcelain', '--untracked-files=no').trim()) console.log('base-check: uncommitted changes are not checked: it reads HEAD; commit first');
  if (entries.length === 0) {
    console.log('nothing to check: the diff changes no test files');
    return 0;
  }

  const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'base-check-'));
  const tree = join(scratch, 'tree');
  const links: string[] = [];
  const verdicts: Verdict[] = [];
  // The whole check ends inside BUDGET, so the 600 s Bash call it runs in outlives it and the scratch worktree goes.
  const deadline = Date.now() + BUDGET * 1000;
  try {
    git(root, 'worktree', 'add', '--detach', '-q', tree, base);
    for (const [p, text] of writes) {
      mkdirSync(dirname(join(tree, p)), { recursive: true });
      writeFileSync(join(tree, p), text);
    }
    for (const e of entries) {
      if (!e.runner) {
        verdicts.push({ kind: 'skipped', label: e.path, detail: e.why! });
        continue;
      }
      const left = (deadline - Date.now()) / 1000;
      if (left < 30) {
        verdicts.push({ kind: 'skipped', label: e.path, detail: `out of time: base-check stops within ${BUDGET} s` });
        continue;
      }
      const r = runOne(root, tree, e, cmd, Math.min(limit, left), links);
      if (typeof r === 'string') verdicts.push({ kind: 'skipped', label: e.path, detail: r });
      else {
        console.log(`  ran ${e.path}${e.spliced ? ' (HEAD\'s test module on the base\'s code)' : ''}: ${r.shown}`);
        verdicts.push(...judge(e, r));
      }
    }
  } finally {
    for (const l of links) if (lstatSync(l, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(l);
    spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: root });
    rmSync(scratch, { recursive: true, force: true });
    spawnSync('git', ['worktree', 'prune'], { cwd: root });
  }
  const tag = { flag: 'PASSES ON BASE', red: 'red', skipped: 'skipped' };
  for (const v of verdicts) console.log(`${tag[v.kind].padEnd(15)} ${v.label}${v.detail ? `: ${v.detail}` : ''}`);
  const n = (k: Verdict['kind']) => verdicts.filter((v) => v.kind === k).length;
  console.log(`Result: ${n('flag')} pass on the base${n('flag') ? " (findings: fix each test, or say why it's fine)" : ''}, ${n('red')} red, ${n('skipped')} skipped`);
  return n('flag') ? 1 : 0;
}

function runOne(root: string, tree: string, e: Entry, cmd: string | null, limit: number, links: string[]): { status: number | null; out: string; timedOut: boolean; parsed: boolean; shown: string } | string {
  let cwd = tree;
  let argv: string[];
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // set inside a node --test run, it makes a nested node --test talk to a parent that isn't there
  if (e.runner === 'cmd') {
    // From the tree's root, so a `cd app && …` works; {file} is absolute, so it still points at the file after that cd.
    argv = ['sh', '-c', cmd!.replaceAll('{file}', `'${join(tree, e.path).replace(/'/g, `'\\''`)}'`)];
  } else if (e.runner === 'node' || e.runner === 'vitest') {
    const dir = nearest(root, e.path, ['package.json']) ?? '.';
    cwd = join(tree, dir);
    // The base's tree has no installed packages: borrow the worktree's, from the package's folder up.
    for (let d = dir; ; d = dirname(d)) {
      const from = join(root, d, 'node_modules');
      const to = join(tree, d, 'node_modules');
      if (existsSync(from) && !existsSync(to)) {
        symlinkSync(from, to);
        links.push(to);
      }
      if (d === '.' || d === '') break;
    }
    const file = relative(dir, e.path);
    if (e.runner === 'vitest') {
      const bin = join(cwd, 'node_modules', '.bin', 'vitest');
      argv = existsSync(bin) ? [bin, 'run', '--reporter=tap-flat', file] : ['npx', '--no-install', 'vitest', 'run', '--reporter=tap-flat', file];
    } else {
      const pkg = join(root, dir, 'package.json');
      argv = nodeCommand(existsSync(pkg) ? (JSON.parse(readFileSync(pkg, 'utf8')).scripts?.test ?? '') : '', file);
    }
  } else if (e.runner === 'pytest') {
    const dir = nearest(root, e.path, ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini']) ?? '.';
    cwd = join(tree, dir);
    const venv = [join(root, dir, '.venv/bin/python'), join(root, '.venv/bin/python')].find(existsSync);
    env.PYTHONPATH = pyPath(cwd, root, process.env.PYTHONPATH, existsSync(join(cwd, 'src')));
    argv = [venv ?? 'python3', '-m', 'pytest', '-rA', '-q', '-p', 'no:cacheprovider', relative(dir, e.path)];
    if (spawnSync(argv[0], ['-c', 'import pytest'], { cwd }).status !== 0) return `pytest isn't installed for ${argv[0]}`;
    // A shared venv can hold the branch's own package (an editable install): then the run would test the branch, not the base.
    const probe = spawnSync(argv[0], ['-c', PY_PROBE, cwd, join(cwd, 'src')], { cwd, env, encoding: 'utf8' });
    const leaks = pyLeaks(probe.stdout ?? '', root, tree);
    if (leaks.length) return `python imports ${leaks.join(', ')} from the branch's checkout (a shared venv), not the base: run it on the base by hand`;
  } else if (e.runner === 'sh') {
    argv = ['bash', e.path];
  } else {
    const cargo = onPath('cargo') ?? [join(homedir(), '.cargo/bin/cargo')].find(existsSync);
    if (!cargo) return "cargo isn't installed here";
    const args = cargoArgs(tree, e.path, e.cases ?? []);
    if (typeof args === 'string') return args;
    // Share the worktree's target/: only the workspace's own crates rebuild, not every dependency.
    env.CARGO_TARGET_DIR ??= join(root, 'target');
    const heavy = onPath('citadel-heavy');
    argv = [...(heavy ? [heavy] : []), cargo, 'test', ...args];
  }
  const r = spawnSync(argv[0], argv.slice(1), { cwd, env, encoding: 'utf8', timeout: limit * 1000, killSignal: 'SIGKILL', maxBuffer: 64 << 20 });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') return `${argv[0]} isn't installed here`;
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const parsed = (e.runner !== 'cmd' && e.runner !== 'sh') || parseResults(out).length > 0;
  return { status: r.status, out, timedOut, parsed, shown: argv.map((a) => (a.startsWith(root) ? relative(root, a) || '.' : a)).join(' ') };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exit(main(process.argv.slice(2)));
