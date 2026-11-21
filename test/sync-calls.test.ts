// The server has one thread: a blocking file or process call in server.ts or src/ holds every request, every
// stream and every timer until it returns (#1463; the Nov 20 and 21 stall reports found readdir, stat and process
// starts in the stall stacks). This ratchet counts the blocking calls (`readFileSync(`, `execFileSync(`, any
// `*Sync(`) in each file. A file may go down; one that goes up, or a new file with any, fails here.
//
// Lower a file's number in test/sync-calls.json when you remove some (`UPDATE_SYNC_CALLS=1` rewrites the whole
// file from the code). Raise one only for code that never runs on the server's thread once it listens: boot before
// listen, a CLI under tools/, a worker thread or a child process, and say why in the commit.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const repo = join(import.meta.dirname, '..');
const allowFile = join(import.meta.dirname, 'sync-calls.json');

/** A blocking call: any lower-case name ending Sync, called. `new DatabaseSync(` and other classes start upper-case. */
const CALL = /\b[a-z]\w*Sync\(/g;
const PROCESS = /^(spawnSync|execFileSync|execSync)\($/;

/**
 * The file with its comments blanked: a scan that knows strings, template literals and regex literals, so a `/*` or
 * `//` inside one (a route path, a URL, a glob) starts no comment. Strings stay in, so a call named in one counts.
 */
export function code(text: string): string {
  let out = '';
  let i = 0;
  let last = ''; // the last code character that isn't a space: whether a `/` starts a regex or divides
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (c === "'" || c === '"' || c === '`' || (c === '/' && (last === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(last)))) {
      // A string ends at its quote (a plain one also at the line's end); a regex also skips its [classes].
      let j = i + 1, inClass = false;
      for (; j < text.length; j++) {
        const d = text[j];
        if (d === '\\') { j++; continue; }
        if (d === '\n' && c !== '`') break;
        if (c === '/' && d === '[') inClass = true;
        else if (c === '/' && d === ']') inClass = false;
        else if (d === c && !inClass) { j++; break; }
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

function sources(): string[] {
  const out = [join(repo, 'server.ts')];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (e.name.endsWith('.ts')) out.push(join(dir, e.name));
    }
  };
  walk(join(repo, 'src'));
  return out;
}

test('no new blocking file or process call in server.ts or src/ (#1463)', () => {
  const counts: Record<string, number> = {};
  const kinds: Record<string, string[]> = {};
  for (const f of sources()) {
    const calls = syncCalls(readFileSync(f, 'utf8'));
    if (!calls.length) continue;
    const rel = relative(repo, f);
    counts[rel] = calls.length;
    kinds[rel] = calls;
  }
  if (process.env.UPDATE_SYNC_CALLS) {
    const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(allowFile, `${JSON.stringify(sorted, null, 1)}\n`);
    return;
  }
  const allowed: Record<string, number> = JSON.parse(readFileSync(allowFile, 'utf8'));
  const over: string[] = [];
  for (const [file, n] of Object.entries(counts)) {
    const may = allowed[file] ?? 0;
    if (n <= may) continue;
    const procs = kinds[file].filter((c) => PROCESS.test(c)).length;
    const what = [...new Set(kinds[file])].map((c) => c.slice(0, -1)).join(', ');
    over.push(`${file}: ${n} blocking calls, ${may} allowed (${what})${procs ? `; ${procs} start a process` : ''}`);
  }
  assert.deepEqual(over, [], `${over.join('\n')}\n\nThe server has one thread, and a blocking call holds all of it. Use the async way: ` +
    "node:fs/promises (readFile, stat, readdir, rm, writeFile, mkdir) for files, and execFile through promisify(execFile) or spawn for processes. " +
    'Only code that never runs on the server\'s thread once it listens (boot before listen, a worker, a child process) may raise its number in test/sync-calls.json, with the why in the commit.');
});

test('the counter skips comments and classes, and counts each call', () => {
  assert.deepEqual(syncCalls([
    "const a = readFileSync('x'); // statSync(y) in a comment",
    '/** existsSync(z) in a doc comment',
    ' * spans lines rmSync(q) */ execFileSync(\'git\');',
    "const db = new DatabaseSync(':memory:'); const u = 'https://x.y/z'; mkdirSync(d);",
    // #1463's review: a `/*` in a string, a comment or a regex once hid the rest of a file.
    "route('/api/relay/:to/*rest', () => statSync(a)); // public/ui/*.d.ts",
    'const re = /a\\/*b/; const g = /[/*]/g; const t = `/* ${x}`; existsSync(e);',
    'rmSync(r); const half = a / 2; // writeFileSync(no)',
  ].join('\n')), ['readFileSync(', 'execFileSync(', 'mkdirSync(', 'statSync(', 'existsSync(', 'rmSync(']);
});
