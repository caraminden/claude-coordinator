// The server boots from server.ts, src/ and public/ alone: tests and previews copy only those three (test/deploy.test.ts),
// so a static import that reaches kit/ or tools/ stops every copy from booting, and only the full suite saw it
// (Build 6 retro, #1136's generator import). Load such a module on use, with `await import(...)`, as make-app.ts does.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const repo = resolve(import.meta.dirname, '..');
const BOOTS_FROM = /^(server\.ts$|src\/|public\/)/;

/** server.ts and every .ts under src/. */
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

/** The relative specifiers of a file's static imports and re-exports (a dynamic `import(...)` is not one). */
export function staticImports(text: string): string[] {
  return [...text.matchAll(/^\s*(?:import|export)\b(?!\s+type\b)[^;'"`(=]*?(?:from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm)].map((m) => m[1]);
}

test('staticImports reads multi-line, bare and re-export forms, and skips a dynamic import', () => {
  const text = "import {\n  a,\n  b,\n} from '../kit/x.ts';\nimport './side.ts';\nexport { c } from './c.ts';\nimport type { T } from '../kit/t.ts';\n  const m = await import('../kit/y.ts');\nexport async function f(a: number) {\n  return import('../kit/z.ts');\n}\n";
  assert.deepEqual(staticImports(text), ['../kit/x.ts', './side.ts', './c.ts']);
});

test('server.ts and src/ import statically only from server.ts, src/ and public/', () => {
  const outside: string[] = [];
  for (const file of sources()) {
    for (const spec of staticImports(readFileSync(file, 'utf8'))) {
      const to = relative(repo, resolve(dirname(file), spec));
      if (!BOOTS_FROM.test(to)) outside.push(`${relative(repo, file)} imports ${to}`);
    }
  }
  assert.deepEqual(outside, [], 'load these on use with await import(...), so a copy of the server with only server.ts, src/ and public/ still boots');
});
