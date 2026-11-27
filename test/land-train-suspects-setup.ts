// Shared setup of land-train-suspects.test.ts and its parts (#2208): the file is split so no one test file sets the suite's length.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { line, shared, shipped } from './land-train-fixture.ts';
import { type setup } from './land-fixture.ts';

export type Line = Awaited<ReturnType<typeof line>>;

export type Done = { status: number | null; stderr: string }[];

export const IMPORT = 'import'; // spelled out, test/pipeline-files.test.ts would follow the fixture's imports as this file's own

// A change perigee can't fail alone: main's test/<name>.test.ts imports <name><n>.ts once it exists, ship n adds it, and
// CI's red is the fake's. So the files name ship n, and its run alone here passes.
export const guess = (name: string, n: number): { change: [string, string] } => ({ change: [`${name}${n}.ts`, `export const x = ${n};\n`] });

export const tests =
  (...names: string[]) =>
  (r: ReturnType<typeof setup>) =>
    names.forEach((name) => r.commit(r.source, `test/${name}.test.ts`, `import { existsSync } from 'node:fs';\n${[2, 3, 4, 5, 6, 7, 8].map((n) => `if (existsSync(new URL('../${name}${n}.ts', import.meta.url))) await ${IMPORT}('../${name}${n}.ts');`).join('\n')}\n`));

export const ships = (n: number, some: Record<number, object>) => Array.from({ length: n }, (_, i) => some[i + 1] ?? {});

export const env =
  (real: string, more: Record<string, string> = {}) =>
  (d: string) => ({ FAKE_REAL: real, ...shared(d), ...more });

export const real = (name: string, ...paths: string[]) => paths.map((p) => `test/${name}.test.ts=${p}`).join(' ');

export const back = (done: Done, ...ns: number[]) => done.forEach((d, i) => assert.equal(d.status, ns.includes(i + 1) ? 1 : 0, `ship ${i + 1}: ${d.stderr}`));

export const taken = (d: Done[number]) => [...d.stderr.matchAll(/waiting behind it \(([^)]*)\)/g)].map((m) => m[1].replace(/ticket\/|-x/g, ''));

export const retro = (l: Line) => {
  const dir = join(l.r.dir, 'shared/retro-log');
  return readdirSync(dir)
    .map((d) => readFileSync(join(dir, d, 'land.md'), 'utf8'))
    .join('');
};

// CI's runs, but for the early ones of a next train (#1568) that a red train dropped.
export const runs = (l: Line, done: Done) => l.runs() - done.flatMap((d) => d.stderr.match(/^land: early next train: dropped the early CI run /gm) ?? []).length;

// The line is as it was found: no verdict, ticket, split or hand-over left.
export function clean(l: Line) {
  l.done();
  for (const f of ['split', 'pull']) assert.equal(existsSync(join(l.state, f)), false, `no ${f} file is left`);
}

// A ship pulled on a guess is never refused for it (#2098): back in line, it ships alone, and the fake's CI, red on its
// change, refuses it with that run of its own.
export const guessed = (d: Done[number], files: string, then: 'refused' | 'shipped' = 'refused') => {
  assert.match(
    d.stderr,
    new RegExp(
      `back in line to ship alone: ticket/\\d+-x's ship train was red in ${files.replaceAll('.', '\\.')}, which ticket/\\d+-x changed or which imports what it changed\\. It was pulled off the train on that guess: run alone on perigee it did not stay red with ticket/\\d+-x by itself on main\\. The train without it passed, but no ship pulled for it failed it by itself on main, so that proves nothing, and its own CI run decides`,
    ),
  );
  if (then === 'refused') assert.match(d.stderr, /land: tests failed on the rebased branch in CI \(https:\/\/ci\/\d+\)/, 'refused by its own run alone');
  else assert.equal(d.status, 0, d.stderr);
  assert.doesNotMatch(d.stderr.slice(d.stderr.indexOf('back in line to ship alone')), /ship train: \S+ takes/, 'it took no riders after');
};

export const proven = (d: Done[number], file: string) => assert.match(d.stderr, new RegExp(`in ${file.replaceAll('.', '\\.')}, and run alone on perigee it passed on main and failed with .*, so it is the cause`));

// Refuse only on proof (#2098; Josh, 2026-11-26, "Have we not analyzed the guessing at all?"): of the first 10 ships
// refused because the train passed without them, 6 were innocent, 3 of those on flaky tests. Here CI fails test/real once
// (the fake's one-off red, logged as a real failure) with ship 3, which test/real imports, on the train.
export const once = (d: string) => ({ FAKE_FLAKY_PATH: 'real3.ts', ...shared(d) });

export const verdicts = (l: Line) =>
  retro(l)
    .split('\n')
    .filter((x) => x.includes('ship train verdict'));
