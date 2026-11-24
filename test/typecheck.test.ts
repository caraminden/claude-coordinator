// The type check's ratchet (#1789): tsc over server.ts, src/, tools/, test/ and kit/ (tsconfig.json), plus a count of
// explicit `any` types and @ts-ignore-style comments in every tracked TypeScript file. A file whose count goes above
// test/typecheck-baseline.json fails the ship; lower counts pass, and `node tools/typecheck.ts --update` records them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compare, describe, escapes, lowered, measure, moved, parseTsc, readBaseline, tscErrors } from '../tools/typecheck.ts';

test('no file has more type errors or escapes than its baseline', async () => {
  const { table, errors } = await measure();
  const { up, down } = compare(readBaseline(), table);
  if (down.length) console.log(`typecheck: ${down.length} count(s) went down; record them with \`node tools/typecheck.ts --update\`:\n  ${down.map(describe).join('\n  ')}`);
  const detail = up.filter((c) => c.kind === 'errors').flatMap((c) => errors.filter((e) => e.file === c.file).map((e) => `  ${e.file}(${e.line},${e.col}) ${e.code} ${e.text.split('\n')[0]}`));
  assert.deepEqual(up.map(describe), [], [
    'A file has more type errors or escapes (an explicit `any`, or a @ts-ignore / @ts-expect-error / @ts-nocheck) than test/typecheck-baseline.json allows.',
    'Fix them with real types (`unknown` and a narrowing, not `any`); the baseline only goes down. `node tools/typecheck.ts <file>` lists a file\'s errors.',
    'Moved or split code (its old file went down as much)? `node tools/typecheck.ts --update --moved` re-files the counts when the totals did not rise.',
    ...detail.slice(0, 40),
  ].join('\n'));
});

test('an any in a type counts; an any that is a value, a property, a comment or text does not', () => {
  assert.equal(escapes('let a: any = 1;\nconst b = x as any;\nfunction f(c: any[]): Map<string, any> { return new Map(); }\n'), 4);
  assert.equal(escapes('const any = 1; const o = { any: 2 }; o.any; fc.anything(); // any here\nconst s = "any" + `any ${any}`;\n'), 0);
  assert.equal(escapes('type T = Record<string, unknown>;\nlet u: unknown;\n'), 0);
});

test('@ts-ignore, @ts-expect-error and @ts-nocheck count; a mention mid-line does not', () => {
  assert.equal(escapes('// @ts-nocheck\n  // @ts-ignore: why\nlet a = 1;\n/* @ts-expect-error */\nlet b = 2;\n'), 3);
  assert.equal(escapes('const s = "see // @ts-ignore";\n'), 0);
});

test('in a .d.ts every any outside a comment counts', () => {
  assert.equal(escapes('export const x: any;\n// any\n/** any */\nexport function f(a: any): void;\n', 'x.d.ts'), 2);
});

test('a count above its baseline is up, below is down, and a new file with errors is up', () => {
  const base = { 'a.ts': { errors: 2, escapes: 1 }, 'gone.ts': { errors: 1, escapes: 0 } };
  const now = { 'a.ts': { errors: 3, escapes: 0 }, 'new.ts': { errors: 0, escapes: 1 } };
  const { up, down } = compare(base, now);
  assert.deepEqual(up.map(describe), ['a.ts: errors 2 → 3', 'new.ts: escapes 0 → 1']);
  assert.deepEqual(down.map(describe), ['a.ts: escapes 1 → 0', 'gone.ts: errors 1 → 0']);
});

test('--update only ever lowers: a count above its baseline keeps the baseline, a new file is not added', () => {
  const base = { 'a.ts': { errors: 2, escapes: 1 }, 'gone.ts': { errors: 1, escapes: 0 } };
  const now = { 'a.ts': { errors: 5, escapes: 0 }, 'new.ts': { errors: 3, escapes: 3 } };
  assert.deepEqual(lowered(base, now), { 'a.ts': { errors: 2, escapes: 0 } });
});

test('--moved re-files counts after a split, but not when a total went up', () => {
  const base = { 'big.ts': { errors: 5, escapes: 2 } };
  assert.deepEqual(moved(base, { 'big.ts': { errors: 2, escapes: 0 }, 'part.ts': { errors: 3, escapes: 2 } }), { 'big.ts': { errors: 2, escapes: 0 }, 'part.ts': { errors: 3, escapes: 2 } });
  assert.equal(moved(base, { 'big.ts': { errors: 2, escapes: 0 }, 'part.ts': { errors: 3, escapes: 3 } }), null);
});

test('tsc runs and its errors are read per file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'typecheck-'));
  try {
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [] }, include: ['*.ts'] }));
    writeFileSync(join(dir, 'ok.ts'), 'export const n: number = 1;\n');
    writeFileSync(join(dir, 'bad.ts'), 'export const n: number = "one";\nexport function f(a) { return a; }\n');
    const errors = await tscErrors(dir);
    assert.deepEqual(errors.map((e) => `${e.file}:${e.line} ${e.code}`), ['bad.ts:1 TS2322', 'bad.ts:2 TS7006']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tsc output with follow-on lines folds them into the error before', () => {
  const out = 'src/a.ts(3,5): error TS2322: Type A is not B.\n  Property x is missing.\nerror TS5083: Cannot read file.\n';
  const errors = parseTsc(out, '/r');
  assert.deepEqual(errors.map((e) => [e.file, e.line, e.code]), [['src/a.ts', 3, 'TS2322'], ['(global)', 0, 'TS5083']]);
  assert.match(errors[0]!.text, /Property x is missing/);
});
