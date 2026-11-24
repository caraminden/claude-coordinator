// A guard for a flaky-test family: a test reads a JSON-lines file that a fake process (a fake claude,
// podman, codex...) is still appending to, and parses a half-written last line or an empty file.
// `jsonLines` and `lines` in test/helpers.ts drop an unterminated last line and give [] for a missing or
// empty file; this test fails on a test that reads such a file raw.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const dir = import.meta.dirname;
const SPLIT = /\.split\(\s*(?:['"`]\\n['"`]|\/\\r\?\\n\/)\s*\)/;
const PARSE = /JSON\.parse/;
const READ = /\breadFileSync\b/;
const OK = /\/\/\s*raw-read-ok:\s*\S/;

/** Where a test file reads a file and splits it into lines and parses them in one statement: "file:line" each. */
export function rawReads(file: string, text: string): string[] {
  const rows = text.split('\n');
  const found: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (/^\s*(\/\/|$)/.test(rows[i])) continue; // a comment or a blank line starts nothing
    // The statement that starts here: this line on to the one that ends it (at most six lines).
    let end = i;
    while (end < rows.length - 1 && end < i + 5 && !/[;{}]\s*(\/\/.*)?$/.test(rows[end])) end++;
    const statement = rows.slice(i, end + 1).join('\n');
    if (!SPLIT.test(statement) || !PARSE.test(statement) || !READ.test(statement)) continue;
    if (rows.slice(i, end + 1).some((r) => OK.test(r))) continue;
    found.push(`${file}:${i + 1}`);
    i = end; // one report per statement
  }
  return found;
}

test('no test parses a JSON-lines file it read raw: use jsonLines from test/helpers.ts', () => {
  const hits = readdirSync(dir)
    .filter((f) => /\.test\.(ts|js)$/.test(f) && f !== 'raw-log-read.test.ts')
    .flatMap((f) => rawReads(f, readFileSync(join(dir, f), 'utf8')));
  assert.deepEqual(hits, [], `${hits.join(', ')}: a fake process may still be writing that file, so the read can see a half-written last line or nothing. Read it with jsonLines (or lines) from test/helpers.ts; for a file the test itself wrote, add "// raw-read-ok: <reason>" to the line.`);
});

test('the guard sees raw reads in the shapes the tests use, and lets annotated ones through', () => {
  const raw = [
    "const a = readFileSync(log, 'utf8').trim().split('\\n').map((l) => JSON.parse(l));",
    "const b = readFileSync(log, 'utf8').split('\\n').map(JSON.parse);",
    "const c = JSON.parse(readFileSync(log, 'utf8').trim().split('\\n').at(-1)!);",
    "const d = readFileSync(log, 'utf8')",
    '  .trim()',
    "  .split('\\n')",
    '  .map((l) => JSON.parse(l));',
  ];
  assert.deepEqual(rawReads('x.test.ts', raw.join('\n')), ['x.test.ts:1', 'x.test.ts:2', 'x.test.ts:3', 'x.test.ts:4']);
  assert.deepEqual(rawReads('x.test.ts', raw[0] + ' // raw-read-ok: the test wrote it'), []);
  assert.deepEqual(rawReads('x.test.ts', 'const e = jsonLines(log);\nconst f = lines(log).length;'), []);
});
