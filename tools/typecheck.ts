#!/usr/bin/env node
/**
 * Citadel's type check as a ratchet (#1789). Nothing checked Citadel's types until then: Node strips them and runs.
 * This runs tsc (tsconfig.json, strict, no emit) and counts, per file, two things:
 *  - errors: tsc's errors in that file;
 *  - escapes: the ways round the checker, an explicit `any` in a type or a `@ts-ignore`, `@ts-expect-error` or
 *    `@ts-nocheck` comment (Cara, 2026-11-24: "make sure citadel ... don't cheat and use 'any'").
 * test/typecheck-baseline.json holds each file's counts as of the last lowering. test/typecheck.test.ts fails when a
 * file's count goes above its baseline or a file not in the baseline has any; a count below it passes, and
 * `--update` lowers the baseline to match. Nothing here ever raises a count.
 *
 *   node tools/typecheck.ts            what went up, what went down (exit 1 when anything went up)
 *   node tools/typecheck.ts --update   lower the baseline to today's counts (refuses while anything went up)
 *   node tools/typecheck.ts --update --moved   after moving or splitting code: take today's counts file by file,
 *                                      refused if the repo's total errors or escapes went up
 *   node tools/typecheck.ts <file>...  tsc's errors and the escapes in those files
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as nodeModule from 'node:module';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const ROOT = join(import.meta.dirname, '..');
export const BASELINE = join(ROOT, 'test', 'typecheck-baseline.json');
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

export type Counts = { errors: number; escapes: number };
export type Table = Record<string, Counts>;
export type TscError = { file: string; line: number; col: number; code: string; text: string };

/** tsc's errors, one per diagnostic (its follow-on lines folded into the text). Paths are relative to `root`. */
export async function tscErrors(root = ROOT): Promise<TscError[]> {
  if (!existsSync(TSC)) throw new Error('typescript is not installed in node_modules: run `npm ci` (a devDependency since #1789)');
  // tsc exits 2 when it found errors; anything else on stderr with no parsed error is tsc itself failing.
  const out = await run(process.execPath, [TSC, '-p', join(root, 'tsconfig.json'), '--pretty', 'false'], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .then((r) => r.stdout, (e: { stdout?: string; stderr?: string; message: string }) => {
      if (e.stdout && /error TS\d+/.test(e.stdout)) return e.stdout;
      throw new Error(`tsc failed to run: ${e.stderr || e.message}`);
    });
  return parseTsc(out, root);
}

/** Parse `--pretty false` output: `file(line,col): error TSnnnn: text`, with indented continuation lines. */
export function parseTsc(out: string, root = ROOT): TscError[] {
  const errors: TscError[] = [];
  for (const line of out.split('\n')) {
    const m = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/.exec(line);
    if (m) {
      const file = m[1]!.startsWith('/') ? relative(root, m[1]!) : m[1]!;
      errors.push({ file, line: Number(m[2]), col: Number(m[3]), code: m[4]!, text: m[5]! });
    } else if (line.startsWith(' ') && errors.length) {
      errors[errors.length - 1]!.text += '\n' + line;
    } else if (/error TS\d+/.test(line)) {
      errors.push({ file: '(global)', line: 0, col: 0, code: /TS\d+/.exec(line)![0], text: line });
    }
  }
  return errors;
}

type Strip = (code: string, opts: { mode: 'strip' }) => string;
const strip = (nodeModule as unknown as { stripTypeScriptTypes?: Strip }).stripTypeScriptTypes;
let warned = false;

/** Node's own type stripping, minus its one-time "experimental" warning. */
function stripTypes(code: string): string {
  if (!strip) throw new Error(`node ${process.version} has no module.stripTypeScriptTypes, which the escape count needs`);
  if (warned) return strip(code, { mode: 'strip' });
  const emit = process.emitWarning;
  process.emitWarning = (() => {}) as typeof process.emitWarning;
  try {
    return strip(code, { mode: 'strip' });
  } finally {
    process.emitWarning = emit;
    warned = true;
  }
}

const DIRECTIVE = /^[ \t]*(?:\/\/|\/\*+)[ \t]*@ts-(?:ignore|expect-error|nocheck)\b/gm;

/**
 * How many ways round the checker one TypeScript file takes: each `any` in a type, and each `@ts-ignore`,
 * `@ts-expect-error` or `@ts-nocheck` comment at the start of a line.
 * Types are found by Node's own stripper, which blanks every type in place: an `any` the stripper blanked was a type,
 * one it kept is a value, a property or text in a comment or string. A `.d.ts` is all types, so there every `any`
 * outside a comment counts.
 */
export function escapes(code: string, file = 'x.ts'): number {
  const directives = code.match(DIRECTIVE)?.length ?? 0;
  const word = /(?<![\w$])any(?![\w$])/g;
  if (/\.d\.[cm]?ts$/.test(file)) {
    const bare = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    return directives + (bare.match(word)?.length ?? 0);
  }
  const stripped = stripTypes(code);
  let anys = 0;
  for (const m of code.matchAll(word)) if (stripped.slice(m.index, m.index + 3) !== 'any') anys++;
  return directives + anys;
}

/** The TypeScript files git tracks, the escape count's files: every one, kit templates and public's .d.ts included. */
export async function tsFiles(root = ROOT): Promise<string[]> {
  const { stdout } = await run('git', ['ls-files', '-z', '--', '*.ts', '*.mts', '*.cts'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return stdout.split('\0').filter(Boolean).filter((f) => existsSync(join(root, f)));
}

/** Today's counts: every file with an error or an escape, and nothing else. */
export async function measure(root = ROOT): Promise<{ table: Table; errors: TscError[] }> {
  const [errors, files] = await Promise.all([tscErrors(root), tsFiles(root)]);
  const table: Table = {};
  const row = (f: string) => (table[f] ??= { errors: 0, escapes: 0 });
  for (const e of errors) row(e.file).errors++;
  for (const f of files) {
    const n = escapes(readFileSync(join(root, f), 'utf8'), f);
    if (n) row(f).escapes += n;
  }
  return { table: sorted(table), errors };
}

export type Change = { file: string; kind: keyof Counts; was: number; now: number };

/** Each count that differs from the baseline: up (refused) or down (welcome, `--update` records it). */
export function compare(baseline: Table, now: Table): { up: Change[]; down: Change[] } {
  const up: Change[] = [];
  const down: Change[] = [];
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(now)])) {
    for (const kind of ['errors', 'escapes'] as const) {
      const was = baseline[file]?.[kind] ?? 0;
      const n = now[file]?.[kind] ?? 0;
      if (n > was) up.push({ file, kind, was, now: n });
      else if (n < was) down.push({ file, kind, was, now: n });
    }
  }
  return { up, down };
}

/** The baseline lowered to today's counts, never raised: a count above its baseline keeps the baseline's. */
export function lowered(baseline: Table, now: Table): Table {
  const out: Table = {};
  for (const [file, was] of Object.entries(baseline)) {
    const n = now[file] ?? { errors: 0, escapes: 0 };
    const c = { errors: Math.min(was.errors, n.errors), escapes: Math.min(was.escapes, n.escapes) };
    if (c.errors || c.escapes) out[file] = c;
  }
  return sorted(out);
}

/** After a move or split (a file's errors now in a new file): today's counts, or null when either total went up. */
export function moved(baseline: Table, now: Table): Table | null {
  const total = (t: Table, k: keyof Counts) => Object.values(t).reduce((s, c) => s + c[k], 0);
  if (total(now, 'errors') > total(baseline, 'errors') || total(now, 'escapes') > total(baseline, 'escapes')) return null;
  return sorted(Object.fromEntries(Object.entries(now).filter(([, c]) => c.errors || c.escapes)));
}

function sorted(t: Table): Table {
  return Object.fromEntries(Object.keys(t).sort().map((k) => [k, t[k]!]));
}

export function readBaseline(path = BASELINE): Table {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, [number, number]>;
  return Object.fromEntries(Object.entries(raw).map(([f, [errors, escapes]]) => [f, { errors, escapes }]));
}

/** One file per line, `"path": [errors, escapes]`, so two minions lowering different files rarely conflict. */
export function formatBaseline(t: Table): string {
  const lines = Object.entries(sorted(t)).map(([f, c]) => `  ${JSON.stringify(f)}: [${c.errors}, ${c.escapes}]`);
  return `{\n${lines.join(',\n')}\n}\n`;
}

export function describe(c: Change): string {
  return `${c.file}: ${c.kind} ${c.was} → ${c.now}`;
}

async function main(args: string[]) {
  const { table, errors } = await measure();
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length) {
    for (const f of files.map((f) => relative(ROOT, join(process.cwd(), f)))) {
      const base = existsSync(BASELINE) ? readBaseline()[f] : undefined;
      console.log(`${f}: errors ${table[f]?.errors ?? 0} (baseline ${base?.errors ?? 0}), escapes ${table[f]?.escapes ?? 0} (baseline ${base?.escapes ?? 0})`);
      for (const e of errors.filter((e) => e.file === f)) console.log(`  ${e.line}:${e.col} ${e.code} ${e.text.replace(/\n/g, '\n    ')}`);
    }
    return;
  }
  const baseline = existsSync(BASELINE) ? readBaseline() : {};
  const { up, down } = compare(baseline, table);
  const total = (t: Table, k: keyof Counts) => Object.values(t).reduce((s, c) => s + c[k], 0);
  console.log(`typecheck: ${total(table, 'errors')} errors, ${total(table, 'escapes')} escapes (baseline ${total(baseline, 'errors')}, ${total(baseline, 'escapes')})`);
  for (const c of up) console.log(`  UP    ${describe(c)}`);
  for (const c of down) console.log(`  down  ${describe(c)}`);
  if (args.includes('--init')) {
    // The first baseline only: from then on --update can only lower it.
    if (existsSync(BASELINE)) throw new Error(`${relative(ROOT, BASELINE)} exists: --init only writes the first one`);
    writeFileSync(BASELINE, formatBaseline(table));
    console.log(`wrote ${relative(ROOT, BASELINE)}`);
    return;
  }
  if (args.includes('--update') && args.includes('--moved')) {
    const next = moved(baseline, table);
    if (!next) {
      console.log('typecheck: not re-filing: the repo\'s total errors or escapes went up, so this is more than a move');
      process.exitCode = 1;
      return;
    }
    writeFileSync(BASELINE, formatBaseline(next));
    console.log(`typecheck: re-filed the counts in ${relative(ROOT, BASELINE)} (totals did not rise)`);
    return;
  }
  if (args.includes('--update')) {
    if (up.length) {
      console.log('typecheck: not updating while a count is above its baseline: fix those first (`node tools/typecheck.ts <file>` lists them)');
      process.exitCode = 1;
      return;
    }
    writeFileSync(BASELINE, formatBaseline(lowered(baseline, table)));
    console.log(`typecheck: lowered ${down.length} count(s) in ${relative(ROOT, BASELINE)}`);
    return;
  }
  if (up.length) process.exitCode = 1;
}

if (import.meta.main) await main(process.argv.slice(2));
