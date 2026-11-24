#!/usr/bin/env node
// test-overlap: which pairs of test files run mostly the same source lines. Step 3b of the kit's audit method
// (kit/skills/test-quality/references/audit-method.md). Overlap only makes a pair a suspect: a unit test and an
// end-to-end test can run the same lines and check different things, so a Grunt reads each pair side by side.
//
//   node test-overlap.ts [--out <dir>] [--jobs N] [--top N] [--min 0.8] [--min-lines 30] [--rescore] [test files...]
//
// For node:test repos. With no files it takes every *.test.{ts,js,mjs} under the folder the package.json test
// script names last (default test/). Each file runs ALONE under node's built-in coverage, with the test script's
// own launcher and flags (its global setup and timeout), and its lcov goes to <out>/cov/. A finished file is kept,
// so a rerun resumes. Writes <out>/pairs.tsv (ranked) and prints the top pairs.
// Heavy: one process per test file. Run it under `citadel-heavy`, only inside an audit, never in CI or a ship.
// Scores: each covered line weighs 1/(test files covering it), and lines over a quarter of the files run
// (imports, setup) are ignored. containment = weighted |A∩B| / min(|A|,|B|) (a small file inside a big one scores 1.0, which
// Jaccard hides); jaccard = weighted |A∩B| / |A∪B|. Ranked by containment, then jaccard, then shared lines.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

export type Covered = Map<string, Set<string>>; // test file -> set of "source:line" keys it ran
export type Pair = { a: string; b: string; containment: number; jaccard: number; shared: number; top: string[] };

/** The source lines an lcov report says ran at least once, as "file:line" keys. */
export function parseLcov(text: string): Set<string> {
  const lines = new Set<string>();
  let sf = '';
  for (const row of text.split('\n')) {
    if (row.startsWith('SF:')) sf = row.slice(3).trim();
    else if (row.startsWith('DA:')) {
      const [n, hits] = row.slice(3).split(',');
      if (Number(hits) > 0) lines.add(`${sf}:${n}`);
    }
  }
  return lines;
}

/** Ranked pairs whose covered lines mostly overlap. Pairs under minLines (unweighted) on either side are skipped: a
 * test that runs a handful of lines sits "inside" everything. Lines that more than a quarter of the files run (load
 * and setup code) are left out altogether, which also keeps the pair count down. */
export function scorePairs(covered: Covered, opts: { min?: number; minLines?: number } = {}): Pair[] {
  const min = opts.min ?? 0.6;
  const minLines = opts.minLines ?? 30;
  const names = [...covered.keys()].filter((n) => covered.get(n)!.size >= minLines);
  const byLine = new Map<string, number[]>(); // line -> indexes of the files running it
  names.forEach((n, i) => {
    for (const k of covered.get(n)!) (byLine.get(k) ?? byLine.set(k, []).get(k)!).push(i);
  });
  const cap = Math.max(4, names.length / 4);
  const weight = new Array<number>(names.length).fill(0);
  const inter = new Map<number, number>(); // i * n + j -> weighted shared lines
  const shared = new Map<number, number>();
  const perFile = new Map<number, Map<string, number>>();
  for (const [k, idx] of byLine) {
    if (idx.length > cap) continue;
    const w = 1 / idx.length;
    for (const i of idx) weight[i] += w;
    if (idx.length < 2) continue;
    const f = k.slice(0, k.lastIndexOf(':'));
    for (let x = 0; x < idx.length; x++) {
      for (let y = x + 1; y < idx.length; y++) {
        const pk = idx[x] * names.length + idx[y];
        inter.set(pk, (inter.get(pk) ?? 0) + w);
        shared.set(pk, (shared.get(pk) ?? 0) + 1);
        const m = perFile.get(pk) ?? perFile.set(pk, new Map()).get(pk)!;
        m.set(f, (m.get(f) ?? 0) + w);
      }
    }
  }
  const pairs: Pair[] = [];
  for (const [pk, v] of inter) {
    const i = Math.floor(pk / names.length);
    const j = pk % names.length;
    const containment = v / Math.min(weight[i], weight[j]);
    if (containment < min) continue;
    const top = [...perFile.get(pk)!]
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3)
      .map(([f]) => f);
    pairs.push({ a: names[i], b: names[j], containment, jaccard: v / (weight[i] + weight[j] - v), shared: shared.get(pk)!, top });
  }
  return pairs.sort((x, y) => y.containment - x.containment || y.jaccard - x.jaccard || y.shared - x.shared);
}

/** The test script's launcher and the flags worth keeping, as base-check.ts does for one node --test file. */
export function nodeArgs(script: string): { launcher: string; flags: string[] } {
  const first = script.trim().split(/\s+/)[0] ?? '';
  const launcher = /--test\b/.test(script) && first && first !== 'node' && !first.includes('=') ? first : 'node';
  const flags = [...script.matchAll(/(?:^|\s)(--test-global-setup=\S+|--test-timeout=\d+|--experimental-[\w-]+(?:=\S+)?|--(?:import|require)(?:=|\s+)\S+)/g)].flatMap((m) => m[1].split(/\s+/));
  return { launcher, flags: flags.map((f) => f.replace(/^['"]|['"]$/g, '')) };
}

function findTests(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...findTests(p));
    else if (/\.test\.(ts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out.sort();
}

function runOne(cmd: string[], cwd: string, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd, stdio: 'ignore', detached: true }); // own process group, so a timeout reaches the test's children
    const t = setTimeout(() => process.kill(-p.pid!, 'SIGKILL'), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve(code);
    });
    p.on('error', () => {
      clearTimeout(t);
      resolve(null);
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string, d: string): string => {
    const i = args.indexOf(name);
    return i < 0 ? d : args.splice(i, 2)[1];
  };
  const rescore = args.includes('--rescore');
  if (rescore) args.splice(args.indexOf('--rescore'), 1);
  const out = opt('--out', join(process.env.TMPDIR ?? '/tmp', 'test-overlap'));
  const jobs = Number(opt('--jobs', '4'));
  const top = Number(opt('--top', '20'));
  const min = Number(opt('--min', '0.8'));
  const minLines = Number(opt('--min-lines', '30'));
  const root = process.cwd();
  let script = '';
  try {
    script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts?.test ?? '';
  } catch {
    /* no package.json: defaults */
  }
  const dirName = (script.trim().split(/\s+/).pop() ?? '').replace(/\/$/, '');
  const dir = [dirName, 'test', 'tests', 'spec', '__tests__', '.'].find((d) => d && existsSync(join(root, d))) ?? '.'; // `node --test` alone names no folder
  const files = args.length ? args : findTests(join(root, dir)).map((f) => relative(root, f));
  const cov = join(out, 'cov');
  mkdirSync(cov, { recursive: true });
  const { launcher, flags } = nodeArgs(script);
  const key = (f: string): string => f.replaceAll('/', '__');
  const started = Date.now();
  const failed: string[] = [];
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < files.length && !rescore) {
      const f = files[next++];
      const dest = join(cov, `${key(f)}.lcov`);
      if (!existsSync(dest)) {
        const cmd = [launcher, '--test', ...flags, '--experimental-test-coverage', `--test-coverage-exclude=${dir === '.' ? '**/*.test.*' : `${dir}/**`}`, '--test-coverage-exclude=**/node_modules/**', '--test-reporter=lcov', `--test-reporter-destination=${dest}`, f];
        const code = await runOne(cmd, root, 300_000);
        if (code !== 0) failed.push(`${f} (exit ${code})`);
        if (code === null) rmSync(dest, { force: true }); // killed or never started: a partial report must not be kept and reused
      }
      done++;
      if (done % 25 === 0) console.error(`${done}/${files.length} files, ${Math.round((Date.now() - started) / 1000)} s`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  const covered: Covered = new Map();
  for (const f of files) {
    const p = join(cov, `${key(f)}.lcov`);
    if (existsSync(p)) covered.set(f, parseLcov(readFileSync(p, 'utf8')));
  }
  const pairs = scorePairs(covered, { min, minLines });
  const rows = pairs.map((p) => [p.containment.toFixed(2), p.jaccard.toFixed(2), p.shared, p.a, p.b, p.top.join(',')].join('\t'));
  writeFileSync(join(out, 'pairs.tsv'), ['containment\tjaccard\tshared_lines\tfile_a\tfile_b\ttop_shared_sources', ...rows].join('\n') + '\n');
  console.log(`${covered.size}/${files.length} files measured in ${Math.round((Date.now() - started) / 1000)} s; ${pairs.length} pairs at containment >= ${min}; list: ${join(out, 'pairs.tsv')}`);
  if (failed.length) console.log(`red or timed out (their coverage may be partial): ${failed.length}, e.g. ${failed.slice(0, 3).join('; ')}`);
  for (const r of rows.slice(0, top)) console.log(r);
}

if (process.argv[1] && basename(process.argv[1]) === 'test-overlap.ts') await main();
