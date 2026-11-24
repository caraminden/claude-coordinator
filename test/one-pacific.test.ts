// A guard: src/pacific.ts (server) and public/base.js (front end) are the two homes of Pacific date formats. A file that
// spells the zone out again grows a copy with its own look; call the home's variant, or name a new one there.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');
const ZONE = /America\/Los_Angeles/;
// A deliberate use says why on its own row: `// pacific-ok: <why>`.
const OK = /\/\/\s*pacific-ok:\s*\S/;
const HOMES = new Set(['src/pacific.ts', 'public/base.js']);

/** "file:line" for each row that spells the zone out without a `pacific-ok` reason. */
export function pacificCopies(file: string, text: string): string[] {
  return text.split('\n').flatMap((row, i) => (ZONE.test(row) && !OK.test(row) ? [`${file}:${i + 1}`] : []));
}

const walk = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(ts|js)$/.test(e.name) ? [join(dir, e.name)] : []));

test('no source file spells out America/Los_Angeles outside the two homes', () => {
  const hits = [...walk('src'), ...walk('public'), 'server.ts'].filter((f) => !HOMES.has(f)).flatMap((f) => pacificCopies(f, readFileSync(join(root, f), 'utf8')));
  assert.deepEqual(hits, [], `${hits.join(', ')}: Pacific formats live in src/pacific.ts (server) and public/base.js (front end). Import a variant, or add one there; a deliberate use says \`// pacific-ok: <why>\`.`);
});

test('the guard flags a literal and leaves marked rows alone', () => {
  assert.deepEqual(pacificCopies('a.ts', "x({ timeZone: 'America/Los_Angeles' });\nok();\ny('America/Los_Angeles'); // pacific-ok: prose"), ['a.ts:1']);
  assert.deepEqual(pacificCopies('a.ts', 'y("America/Los_Angeles"); // pacific-ok:'), ['a.ts:1']);
});

test('both homes still exist', () => {
  for (const f of HOMES) assert.ok(ZONE.test(readFileSync(join(root, f), 'utf8')), relative(root, join(root, f)));
});
