// The server has one thread: a blocking file or process call in server.ts or src/ holds every request, every
// stream and every timer until it returns (#1463; the stall reports of Nov 20 to 25 found readdir, stat, exists and
// process starts in the stall stacks, each time on a new path). This check reads every file server.ts imports,
// finds each blocking call (`readFileSync(`, `execFileSync(`, any `*Sync(`) and the function it sits in, and fails
// on one that test/sync-calls.json doesn't class (#2111):
//
//   boot  runs only before the server listens (module load, a constructor, startup recovery), or never on the
//         server's thread at all (a worker, a child process).
//   proc  no disk in it: reads of /proc, /sys and cgroup files (kernel memory, kept on the thread on purpose,
//         #1980), crypto and zlib.
//   rare  disk or a process, on an action a person or minion takes now and then (a new scheme, a build, a preview).
//   owed  disk or a process on a path that runs often once the server listens: a timer, a poller, a turn's start or
//         end, a common request. Each names its handoff or reason. This is the list of what is left to move.
//
// A new call is written the async way (node:fs/promises, promisify(execFile), the readers in src/off-thread-*.ts
// and src/heavy-folder.ts); test/off-thread-fs.test.ts traps a path to prove it. Only `boot` and `proc` take new
// entries: the totals of `rare` and `owed` below only go down. A file server.ts never imports (a tool, a worker's
// own file) isn't read at all. `UPDATE_SYNC_CALLS=1` rewrites the counts from the code, keeps each class, drops
// functions that have no call left, and adds new ones as "unclassed" for you to class.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { test } from 'node:test';

const repo = join(import.meta.dirname, '..');
const allowFile = join(import.meta.dirname, 'sync-calls.json');

/** A blocking call: any lower-case name ending Sync, called. `new DatabaseSync(` and other classes start upper-case. */
const CALL = /\b[a-z]\w*Sync\(/g;

/**
 * The file with its comments blanked: a scan that knows strings, template literals and regex literals, so a `/*` or
 * `//` inside one (a route path, a URL, a glob) starts no comment. Strings stay in, so a call named in one counts.
 */
export function code(text: string): string {
  let out = '';
  let i = 0;
  let last = ''; // the last code character that isn't a space: whether a `/` starts a regex or divides
  while (i < text.length) {
    const c = text[i],
      n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === "'" || c === '"' || c === '`' || (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last)))) {
      // A string ends at its quote (a plain one also at the line's end); a regex also skips its [classes].
      let j = i + 1,
        inClass = false;
      for (; j < text.length; j++) {
        const d = text[j];
        if (d === '\\') {
          j++;
          continue;
        }
        if (d === '\n' && c !== '`') break;
        if (c === '/' && d === '[') inClass = true;
        else if (c === '/' && d === ']') inClass = false;
        else if (d === c && !inClass) {
          j++;
          break;
        }
      }
      out += text.slice(i, j);
      last = c;
      i = j;
    } else {
      out += c;
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out;
}

/** The blocking calls in a file's code, comments left out. */
export function syncCalls(text: string): string[] {
  return code(text).match(CALL) ?? [];
}

/** The most `rare` and `owed` calls there may be. Lower them when you move calls off the thread; never raise them. */
const RARE_MOST = 250;
const OWED_MOST = 6;

type Class = 'boot' | 'proc' | 'rare' | 'owed';
/** file → function → [class, calls, why (owed: the handoff or reason; others: what triggers it)]. */
type Allow = Record<string, Record<string, [Class | 'unclassed', number, string?]>>;

const IMPORT = /\b(?:import|export)\s+(?!type\b)[^;'"`]*?from\s+['"](\.[^'"]+)['"]|\bimport\(\s*['"`](\.[^'"`$]+)['"`]\s*\)|\bimport\s+['"](\.[^'"]+)['"]/g;

/** The relative files a file's code imports: `from`, a bare import and `import()` of a plain string or template. An `import()` of a computed path can't be followed. */
export const importsOf = (text: string): string[] => [...code(text).matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3]);

/** server.ts and every file it imports, directly or through another (type-only imports left out). */
function sources(): string[] {
  const seen = new Set<string>();
  const queue = [join(repo, 'server.ts')];
  while (queue.length) {
    const f = queue.pop()!;
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    for (const spec of importsOf(readFileSync(f, 'utf8'))) queue.push(resolve(dirname(f), spec));
  }
  return [...seen].filter((f) => f === join(repo, 'server.ts') || f.startsWith(join(repo, 'src') + sep)).sort();
}

const TOP = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let|var)\s+(\w+)|(?:abstract\s+)?class\s+(\w+))/;
const MEMBER = /^  (?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*(#?\w+)\s*[(<=:;]/;

/**
 * A file's blocking calls by the function each sits in: `name` for a top-level function or const, `Class.member`
 * inside a class, `(module)` at the top level. It goes by the formatter's layout (a top-level declaration starts its
 * line, a class member is indented once), which is enough to name where a call lives.
 */
export function callsByFunction(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  let top = '(module)',
    cls = '',
    member = '';
  for (const line of code(text).split('\n')) {
    const t = TOP.exec(line);
    if (t) {
      cls = t[3] ?? '';
      top = t[1] ?? t[2] ?? t[3];
      member = '';
    } else if (/^\S/.test(line) && !/^[)}\]]/.test(line)) {
      top = '(module)';
      cls = '';
    } else if (cls) {
      const m = MEMBER.exec(line);
      if (m) member = m[1];
    }
    const n = line.match(CALL)?.length ?? 0;
    if (n) {
      const who = cls ? `${cls}.${member || '(fields)'}` : top;
      out[who] = (out[who] ?? 0) + n;
    }
  }
  return out;
}

/** One function to a line, so a diff shows exactly which call was classed or moved. */
function format(allow: Allow): string {
  const files = Object.keys(allow)
    .sort()
    .map((f) => {
      const fns = Object.entries(allow[f]).map(([fn, row]) => `  ${JSON.stringify(fn)}: ${JSON.stringify(row)}`);
      return ` ${JSON.stringify(f)}: {\n${fns.join(',\n')}\n }`;
    });
  return `{\n${files.join(',\n')}\n}\n`;
}

test("every blocking call the server's thread can reach is classed, and the ones on busy paths only go down (#1463, #2111)", () => {
  const allowed: Allow = JSON.parse(readFileSync(allowFile, 'utf8'));
  const found: Record<string, Record<string, number>> = {};
  for (const f of sources()) {
    const calls = callsByFunction(readFileSync(f, 'utf8'));
    if (Object.keys(calls).length) found[relative(repo, f)] = calls;
  }
  if (process.env.UPDATE_SYNC_CALLS) {
    const next: Allow = {};
    for (const [file, fns] of Object.entries(found)) {
      next[file] = {};
      for (const [fn, n] of Object.entries(fns)) {
        const was = allowed[file]?.[fn];
        next[file][fn] = was ? ([was[0], n, ...(was[2] ? [was[2]] : [])] as Allow[string][string]) : ['unclassed', n];
      }
    }
    writeFileSync(allowFile, format(next));
    return;
  }
  const over: string[] = [];
  for (const [file, fns] of Object.entries(found))
    for (const [fn, n] of Object.entries(fns)) {
      const may = allowed[file]?.[fn];
      if (!may || may[0] === 'unclassed') over.push(`${file}: ${fn} makes ${n} blocking call${n > 1 ? 's' : ''} and has no class`);
      else if (n > may[1]) over.push(`${file}: ${fn} makes ${n} blocking calls, ${may[1]} allowed (${may[0]})`);
    }
  assert.deepEqual(
    over,
    [],
    `${over.join('\n')}\n\nThe server has one thread, and a blocking call holds all of it while the disk is busy. Use the async way: ` +
      'node:fs/promises (readFile, stat, readdir, rm, writeFile, mkdir) for files, and execFile through promisify(execFile) or spawn for processes. ' +
      "Only a call that never touches the disk on the server's thread once it listens may be added to test/sync-calls.json: class `boot` " +
      '(before listen, a worker, a child process) or `proc` (/proc, /sys, crypto, zlib), with what triggers it.',
  );
  const rows = Object.entries(allowed).flatMap(([file, fns]) => Object.entries(fns).map(([fn, row]) => ({ file, fn, row })));
  const classes: Class[] = ['boot', 'proc', 'rare', 'owed'];
  const named = (bad: typeof rows) => bad.map((r) => `${r.file}: ${r.fn}`);
  assert.deepEqual(named(rows.filter((r) => !classes.includes(r.row[0] as Class))), [], 'each entry has a class: boot, proc, rare or owed');
  assert.deepEqual(named(rows.filter((r) => !Number.isInteger(r.row[1]) || r.row[1] < 1)), [], 'each entry counts at least one call');
  assert.deepEqual(named(rows.filter((r) => r.row[0] !== 'boot' && r.row[0] !== 'proc' && !r.row[2])), [], 'a rare or owed entry says what triggers it, and an owed one names its handoff');
  // The totals count the calls in the code, not the numbers in the file: a stale or made-up row can't make room for a new call.
  const total = (c: Class) => rows.filter((r) => r.row[0] === c).reduce((a, r) => a + (found[r.file]?.[r.fn] ?? 0), 0);
  assert.ok(total('rare') <= RARE_MOST, `${total('rare')} rare calls, at most ${RARE_MOST}: a new blocking call on a path that runs after listen is written the async way, not added as rare`);
  assert.ok(total('owed') <= OWED_MOST, `${total('owed')} owed calls, at most ${OWED_MOST}: this list only goes down`);
});

test('the files the server imports are found through every plain import form', () => {
  assert.deepEqual(importsOf(["import { a } from './a.ts';", "import type { T } from './types-only.ts';", "export { b } from './b.ts';", "import './c.ts';", "const d = await import('./d.ts');", 'const e = await import(`./e.ts`);', "import fs from 'node:fs'; // import('./in-a-comment.ts')"].join('\n')), [
    './a.ts',
    './b.ts',
    './c.ts',
    './d.ts',
    './e.ts',
  ]);
});

test('a call is named by the function it sits in', () => {
  assert.deepEqual(
    callsByFunction(
      [
        "const KEY = readFileSync('k');",
        'export async function load(dir: string) {',
        '  return readdirSync(dir).map((f) => statSync(f));',
        '}',
        'export class Waits {',
        '  private dir = mkdtempSync(root);',
        '  constructor() {',
        '    mkdirSync(this.dir);',
        '  }',
        '  private async poll(): Promise<void> {',
        '    for (const f of files) if (existsSync(f)) rmSync(f);',
        '  }',
        '}',
        "writeFileSync('x', '');",
        'export const tail = (p: string) => {',
        '  return readFileSync(p);',
        '};',
      ].join('\n'),
    ),
    { KEY: 1, load: 2, 'Waits.dir': 1, 'Waits.constructor': 1, 'Waits.poll': 2, '(module)': 1, tail: 1 },
  );
});

test('the counter skips comments and classes, and counts each call', () => {
  assert.deepEqual(
    syncCalls(
      [
        "const a = readFileSync('x'); // statSync(y) in a comment",
        '/** existsSync(z) in a doc comment',
        " * spans lines rmSync(q) */ execFileSync('git');",
        "const db = new DatabaseSync(':memory:'); const u = 'https://x.y/z'; mkdirSync(d);",
        // #1463's review: a `/*` in a string, a comment or a regex once hid the rest of a file.
        "route('/api/relay/:to/*rest', () => statSync(a)); // public/ui/*.d.ts",
        'const re = /a\\/*b/; const g = /[/*]/g; const t = `/* ${x}`; existsSync(e);',
        'rmSync(r); const half = a / 2; // writeFileSync(no)',
      ].join('\n'),
    ),
    ['readFileSync(', 'execFileSync(', 'mkdirSync(', 'statSync(', 'existsSync(', 'rmSync('],
  );
});
