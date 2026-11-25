#!/usr/bin/env node
/**
 * Type check as a ratchet (from the Citadel kit's scheme-setup templates; Citadel #1789). Copy it to tools/typecheck.ts
 * and set the config block below to this repo. It runs tsc (no emit) and counts, per file, two things:
 *  - errors: tsc's errors in that file;
 *  - escapes: the ways round the checker, an explicit `any` in a type or a `@ts-ignore`, `@ts-expect-error` or
 *    `@ts-nocheck` comment (Cara, 2026-11-24: "make sure citadel and the rest of our typescript schemes don't cheat
 *    and use 'any'"). In a JavaScript file of SCRIPTS the `any` is one in a JSDoc type.
 * The baseline file holds each file's counts as of the last lowering. The check fails when a file's count goes above
 * its baseline, or a file not in the baseline has any; a count below it passes, and `--update` lowers the baseline to
 * match. Nothing here ever raises a count, except `--update --moved` after moving code, and only when no total rose.
 * Needs Node 22.18+ (it runs as TypeScript and uses module.stripTypeScriptTypes) and typescript in node_modules; with
 * no tsconfig it counts escapes only.
 *
 *   node tools/typecheck.ts            what went up, what went down (exit 1 when anything went up: the gate)
 *   node tools/typecheck.ts --init     write the first baseline (once)
 *   node tools/typecheck.ts --update   lower the baseline to today's counts (refuses while anything went up)
 *   node tools/typecheck.ts --update --moved   after moving or splitting code: take today's counts file by file,
 *                                      refused if the repo's total errors or escapes went up
 *   node tools/typecheck.ts <file>...  tsc's errors and the escapes in those files
 */
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as nodeModule from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

// --- config: set these to this repo (everything below is the kit's, the same in every scheme) ---
export const ROOT = join(import.meta.dirname, '..');
export const BASELINE = join(ROOT, 'typecheck-baseline.json');
/** The tsconfigs tsc checks, from ROOT; `[]` counts escapes only, with no tsc. A listed one that isn't there is an error. */
export const PROJECTS = ['tsconfig.json'];
/** Git pathspecs of the JavaScript whose escapes count too (a front end a listed tsconfig checks with checkJs); `[]` for none. */
export const SCRIPTS: string[] = [];
// --- end of config ---

const run = promisify(execFile);

/**
 * Waits for a place under the box's shared limit on heavy test runs, the one citadel-test uses (tools/test-gate.ts, #1928), so
 * type checks started together in one container don't each take ~1 GB at once (#2033). The place is held until this process
 * exits. With no tools/test-gate.ts in the repo, on CI, inside a heavy job, with CITADEL_TEST_FILES=0 or no flock, it doesn't wait.
 */
async function waitForRoom(): Promise<void> {
  const gate = join(ROOT, 'tools', 'test-gate.ts');
  if (!PROJECTS.length || !existsSync(gate) || process.env.CITADEL_TEST_FILES === '0' || process.env.RUNNER_TEMP || process.env.GITHUB_ACTIONS || process.env.CITADEL_HEAVY_HELD) return;
  if (spawnSync('flock', ['--version'], { stdio: 'ignore' }).status !== 0) return;
  const dir = mkdtempSync(join(tmpdir(), 'typecheck-gate-'));
  const note = join(dir, 'note');
  process.env.CITADEL_TEST_GATE_NOTE = note;
  let said = false;
  const say = () => {
    if (said || !existsSync(note)) return;
    said = true;
    console.error(
      `typecheck: ${readFileSync(note, 'utf8')
        .trim()
        .replace(/test files/, 'heavy runs')}`,
    );
  };
  const watch = setInterval(say, 200);
  try {
    await import(gate);
  } catch {
    // Any trouble with the gate lets the check run.
  } finally {
    clearInterval(watch);
    say();
    rmSync(dir, { recursive: true, force: true });
  }
}

export type Counts = { errors: number; escapes: number };
export type Table = Record<string, Counts>;
export type TscError = { file: string; line: number; col: number; code: string; text: string };

/** tsc's errors over every project, one per diagnostic (its follow-on lines folded into the text), paths from `root`. */
export async function tscErrors(root = ROOT, projects = PROJECTS): Promise<TscError[]> {
  const out: TscError[] = [];
  for (const p of projects.map((p) => join(root, p))) {
    if (!existsSync(p)) throw new Error(`${p} is in PROJECTS but isn't there: fix the config block (\`[]\` counts escapes only)`);
    const tsc = tscPath(root, p);
    // tsc exits 2 when it found errors; anything else on stderr with no parsed error is tsc itself failing.
    // --extendedDiagnostics: its "Check time" line is there only when tsc got as far as checking types.
    const stdout = await run(process.execPath, [tsc, '-p', p, '--noEmit', '--pretty', 'false', '--extendedDiagnostics'], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).then(
      (r) => r.stdout,
      (e: { stdout?: string; stderr?: string; message: string }) => {
        if (e.stdout && /error TS\d+/.test(e.stdout)) {
          if (/^Check time:/m.test(e.stdout) && !/(?:^|: )error TS1800[23]:/m.test(e.stdout)) return e.stdout;
          // After a syntax error, or one in the config, tsc skips every file's types, and TS18002 and TS18003 are
          // a config with no files at all: those zeros would pass as clean.
          // shortcut: made for TypeScript 7. Before 5.9 a skipped run prints the line too, and before 7 a cached run of an
          // `incremental` config prints none and is refused; pass `--incremental false` here if a repo needs that.
          const why = parseTsc(e.stdout, root).map((x) => (x.line ? `  ${x.file}(${x.line},${x.col}) ${x.code} ${x.text}` : `  ${x.text}`));
          throw new Error(`tsc stopped before it checked any types, so no count can be trusted: fix these first\n${why.slice(0, 40).join('\n')}`);
        }
        throw new Error(`tsc failed to run: ${e.stderr || e.message}`);
      },
    );
    out.push(...parseTsc(stdout, root));
  }
  return out;
}

function tscPath(root: string, project: string): string {
  const tsc = [root, dirname(project), ROOT].map((d) => join(d, 'node_modules', 'typescript', 'bin', 'tsc')).find((t) => existsSync(t));
  if (!tsc) throw new Error('typescript is not installed in node_modules: run `npm ci` (the type check needs it as a devDependency)');
  return tsc;
}

/** The files tsc reads over every project, paths from `root`. */
export async function tscFiles(root = ROOT, projects = PROJECTS): Promise<Set<string>> {
  const out = new Set<string>();
  for (const p of projects.map((p) => join(root, p))) {
    const { stdout } = await run(process.execPath, [tscPath(root, p), '-p', p, '--listFilesOnly'], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    for (const f of stdout.split('\n').filter(Boolean)) out.add(relative(root, resolve(root, f)));
  }
  return out;
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

/** Node's own type stripping, minus its one-time "experimental" warning. Throws on code it can't parse (JSX). */
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
const TEXT = /\/\*[\s\S]*?\*\/|\/\/.*|'(?:\\(?:\r\n|[\s\S])|[^'\\\n])*'|"(?:\\(?:\r\n|[\s\S])|[^"\\\n])*"/y;
const WORD = /(?<![\w$])any(?![\w$])/g;

/** Code with comments and string literals blanked to spaces, so positions stay put. Template `${}` holes are kept. */
function blankText(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\(?:\r\n|[\s\S])|[^'\\\n])*'|"(?:\\(?:\r\n|[\s\S])|[^"\\\n])*"|`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`/g, (m) => {
    if (m[0] !== '`') return m.replace(/[^\n]/g, ' ');
    return m.replace(/\$\{([^}]*)\}|[^\n]/g, (part, hole: string | undefined) => (hole === undefined ? ' ' : `  ${hole} `));
  });
}

/**
 * Code that is all types, with comments and quoted text blanked to spaces so positions stay put. A template type's
 * `${}` holes hold types, so they are kept. Read left to right, so a `//` in text or a quote in a comment is no trap;
 * only for type code, where no regex can hold a stray quote or backtick.
 */
function blankTypeText(types: string): string {
  let out = '';
  const holes: number[] = []; // open templates, each with its hole's depth of open braces
  let inTemplate = false;
  for (let i = 0; i < types.length; ) {
    const rest = types.slice(i, i + 2);
    if (inTemplate) {
      if (rest === '${') {
        holes.push(0);
        inTemplate = false;
        out += '  ';
        i += 2;
        continue;
      }
      if (types[i] === '`') inTemplate = false;
      const n = types[i] === '\\' ? 2 : 1;
      out += types.slice(i, i + n).replace(/[^\n]/g, ' ');
      i += n;
      continue;
    }
    TEXT.lastIndex = i;
    const text = TEXT.exec(types)?.[0];
    if (text) {
      out += text.replace(/[^\n]/g, ' ');
      i += text.length;
      continue;
    }
    const c = types[i]!;
    const top = holes.length - 1;
    if (c === '`') inTemplate = true;
    else if (c === '{' && top >= 0) holes[top]!++;
    else if (c === '}' && top >= 0 && holes[top]!-- === 0) {
      holes.pop();
      inTemplate = true;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * The `any`s in type positions, read from the text alone: for what Node's stripper can't parse (a .tsx file, a .ts file
 * with an enum or namespace, or one that doesn't parse yet).
 * shortcut: a pattern, not a parser; it misses about one any in six that the stripper finds (a backtick in a regex hides
 * text from it), and reads `=> any` as a type. A file counted this way is counted this way on both sides of the ratchet.
 */
function anysByPattern(code: string): number {
  const text = blankText(code);
  let n = 0;
  for (const m of text.matchAll(WORD)) {
    const before = text.slice(Math.max(0, m.index - 80), m.index);
    const after = text.slice(m.index + 3, m.index + 6);
    if (/(?:[:<|&]|=>|\bas|\bextends|\bsatisfies|\bkeyof|\btype\s+[\w$]+\s*(?:<[^<>=]*>)?\s*=)\s*$/.test(before) || (/,\s*$/.test(before) && /^\s*[>,\]]/.test(after)) || /^\s*\[\]/.test(after)) n++;
  }
  return n;
}

/**
 * How many ways round the checker one TypeScript file takes: each `any` in a type, and each `@ts-ignore`,
 * `@ts-expect-error` or `@ts-nocheck` comment at the start of a line.
 * Types are found by Node's own stripper, which blanks every type in place: an `any` the stripper blanked was a type,
 * one it kept is a value, a property or text in a comment or string. Comments and quoted text inside what it blanked
 * don't count. A `.d.ts` is all types, so there every `any` outside a comment or quoted text counts. What the stripper can't parse (JSX) falls back to a pattern.
 */
export function escapes(code: string, file = 'x.ts'): number {
  return countEscapes(code, file).n;
}

/**
 * escapes(), saying how it counted: `types` (Node's stripper), `pattern` (the fallback), or `dts`. Two counts compared
 * must be made the same way, so `byPattern` forces the fallback for a file the stripper read on the other side.
 */
export function countEscapes(code: string, file = 'x.ts', byPattern = false): { n: number; by: 'types' | 'pattern' | 'dts' } {
  const directives = code.match(DIRECTIVE)?.length ?? 0;
  if (/\.d\.[cm]?ts$/.test(file)) {
    return { n: directives + (blankTypeText(code).match(WORD)?.length ?? 0), by: 'dts' };
  }
  let stripped: string;
  try {
    if (byPattern || file.endsWith('.tsx')) throw new Error('JSX');
    stripped = stripTypes(code);
  } catch (e) {
    if (!strip) throw e;
    return { n: directives + anysByPattern(code), by: 'pattern' };
  }
  let anys = 0;
  // Each stretch the stripper changed is read by itself, so a quote or backtick in the code it kept can't hide a type.
  for (let i = 0; i < code.length; i++) {
    const from = i;
    while (i < code.length && (code[i] !== stripped[i] || /\s/.test(code[i]!))) i++;
    if (i - from >= 3) anys += blankTypeText(code.slice(from, i)).match(WORD)?.length ?? 0;
  }
  return { n: directives + anys, by: 'types' };
}

/**
 * How many ways round the checker one JavaScript file takes: each `any` in a JSDoc type, or its older spelling `*`, and
 * each mention of `@ts-ignore`, `@ts-expect-error` or `@ts-nocheck` (tsc reads one after code, in a block comment or in
 * capitals too). Unsure, it counts: text that looks like one of these is one.
 */
export function scriptEscapes(code: string): number {
  let n = code.match(/@ts-(?:ignore|expect-error|nocheck)/gi)?.length ?? 0;
  for (const [comment] of code.matchAll(/\/\*\*[\s\S]*?\*\//g)) {
    const doc = comment
      .slice(3, -2)
      .replace(/^\*+/, '')
      .replace(/^[ \t]*\*/gm, '');
    for (let i = doc.indexOf('@'); i >= 0 && i < doc.length; ) {
      // A type is a brace group anywhere after the first tag (`@param x {any}` is read too) ...
      let end = i + 1;
      if (doc[i] === '{') {
        for (let depth = 1; end < doc.length && depth > 0; end++) {
          const quoted = /^'[^'\n]*'|^"[^"\n]*"|^`[^`]*`/.exec(doc.slice(end))?.[0];
          if (quoted) end += quoted.length - 1;
          else if (doc[end] === '{') depth++;
          else if (doc[end] === '}') depth--;
        }
        if (doc[i + 1] === '@') {
          i = end; // an inline {@link ...}
          continue;
        }
      } else {
        // ... or what follows a bare `@type` or `@this`.
        const bare = /^@(?:type|this)\s+(?![{\s])[^@]*/.exec(doc.slice(i))?.[0];
        if (!bare) {
          i++;
          continue;
        }
        end = i + bare.length;
      }
      n += blankTypeText(doc.slice(i, end)).match(/(?<![\w$])any(?![\w$])|\*/g)?.length ?? 0;
      i = end;
    }
  }
  return n;
}

const SCRIPT = /\.(?:[cm]?js|jsx)$/;

/** The TypeScript files git tracks and the JavaScript SCRIPTS names, the escape count's files. */
export async function tsFiles(root = ROOT, scripts = SCRIPTS): Promise<string[]> {
  const { stdout } = await run('git', ['ls-files', '-z', '--', '*.ts', '*.tsx', '*.mts', '*.cts', ...scripts], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
  return stdout
    .split('\0')
    .filter(Boolean)
    .filter((f) => existsSync(join(root, f)));
}

/** Today's counts: every file with an error or an escape, and nothing else. */
export async function measure(root = ROOT, projects = PROJECTS, scripts = SCRIPTS): Promise<{ table: Table; errors: TscError[] }> {
  const [errors, files] = await Promise.all([tscErrors(root, projects), tsFiles(root, scripts)]);
  const table: Table = {};
  const row = (f: string) => (table[f] ??= { errors: 0, escapes: 0 });
  for (const e of errors) row(e.file).errors++;
  for (const f of files) {
    const code = readFileSync(join(root, f), 'utf8');
    const n = SCRIPT.test(f) ? scriptEscapes(code) : escapes(code, f);
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

const total = (t: Table, k: keyof Counts) => Object.values(t).reduce((s, c) => s + c[k], 0);

/** After a move or split (a file's errors now in a new file): today's counts, or null when either total went up. */
export function moved(baseline: Table, now: Table): Table | null {
  if (total(now, 'errors') > total(baseline, 'errors') || total(now, 'escapes') > total(baseline, 'escapes')) return null;
  return sorted(Object.fromEntries(Object.entries(now).filter(([, c]) => c.errors || c.escapes)));
}

function sorted(t: Table): Table {
  return Object.fromEntries(
    Object.keys(t)
      .sort()
      .map((k) => [k, t[k]!]),
  );
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

/** The gate's failure text: what went up, and how to fix it. */
export function upMessage(up: Change[], errors: TscError[]): string {
  const detail = up.filter((c) => c.kind === 'errors').flatMap((c) => errors.filter((e) => e.file === c.file).map((e) => `  ${e.file}(${e.line},${e.col}) ${e.code} ${e.text.split('\n')[0]}`));
  return [
    `A file has more type errors or escapes (an explicit \`any\`, or a @ts-ignore / @ts-expect-error / @ts-nocheck) than ${relative(ROOT, BASELINE)} allows:`,
    ...up.map((c) => `  ${describe(c)}`),
    "Fix them with real types (`unknown` and a narrowing, not `any`); the baseline only goes down. `node tools/typecheck.ts <file>` lists a file's errors.",
    'Moved or split code (its old file went down as much)? `node tools/typecheck.ts --update --moved` re-files the counts when the totals did not rise.',
    ...detail.slice(0, 40),
  ].join('\n');
}

async function main(args: string[]) {
  await waitForRoom();
  const { table, errors } = await measure();
  const files = args.filter((a) => !a.startsWith('--'));
  if (files.length) {
    const [tracked, typed] = await Promise.all([tsFiles(), tscFiles()]);
    for (const f of files.map((f) => relative(ROOT, resolve(f)))) {
      const counted = tracked.includes(f);
      const checked = typed.has(f);
      if (!counted && !checked) {
        console.log(`${f}: not a file this check covers (a typo, not TypeScript, or not yet in git)`);
        process.exitCode = 1;
        continue;
      }
      const base = existsSync(BASELINE) ? readBaseline()[f] : undefined;
      console.log(`${f}: errors ${table[f]?.errors ?? 0} (baseline ${base?.errors ?? 0}), escapes ${table[f]?.escapes ?? 0} (baseline ${base?.escapes ?? 0})`);
      if (!checked) console.log('  not in any tsconfig of PROJECTS: its type errors are not checked');
      if (SCRIPT.test(f) && !counted) console.log('  JavaScript: its types are checked only with checkJs or @ts-check, and its escapes are not counted');
      else if (!counted) console.log('  not tracked by git: its escapes are not counted');
      for (const e of errors.filter((e) => e.file === f)) console.log(`  ${e.line}:${e.col} ${e.code} ${e.text.replace(/\n/g, '\n    ')}`);
    }
    return;
  }
  const baseline = existsSync(BASELINE) ? readBaseline() : {};
  const { up, down } = compare(baseline, table);
  console.log(`typecheck: ${total(table, 'errors')} errors, ${total(table, 'escapes')} escapes (baseline ${total(baseline, 'errors')}, ${total(baseline, 'escapes')})`);
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
      console.log("typecheck: not re-filing: the repo's total errors or escapes went up, so this is more than a move");
      process.exitCode = 1;
      return;
    }
    writeFileSync(BASELINE, formatBaseline(next));
    console.log(`typecheck: re-filed the counts in ${relative(ROOT, BASELINE)} (totals did not rise)`);
    return;
  }
  if (up.length) {
    console.log(upMessage(up, errors));
    if (args.includes('--update')) console.log('typecheck: not updating while a count is above its baseline: fix those first');
    process.exitCode = 1;
    return;
  }
  if (args.includes('--update')) {
    writeFileSync(BASELINE, formatBaseline(lowered(baseline, table)));
    console.log(`typecheck: lowered ${down.length} count(s) in ${relative(ROOT, BASELINE)}`);
  }
}

if (import.meta.main) await main(process.argv.slice(2));
