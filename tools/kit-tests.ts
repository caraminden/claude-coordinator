// The test files a kit-lane land runs (#753, tools/lanes): tools/run-tests.sh runs only these when a change touches
// kit/ and light paths alone. Worked out from the code each time, never a kept list, so a new test that reads the kit
// is in it at once:
//   - a test file that names kit/ in its code (comments don't count), or
//   - one that imports, itself or through a non-test helper under test/, a file in src/ or server.ts that names it.
// 148 of 253 test files on 2026-11-15, most through test/helpers.ts.
// shortcut: imports are followed one step into src/, not through it (205 of 253 test files reach a kit-reading module
// that way). Follow them all if a kit land ever breaks main.
// Prints one path per line, from the repo root (the current directory).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const code = (f: string) => readFileSync(f, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');
const namesKit = (f: string) => /['"`/]kit['"`/]|\bkit\//.test(code(f));
const imports = (f: string) =>
  [...code(f).matchAll(/(?:from|import\()\s*['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => normalize(join(dirname(f), m[1])));

const sources = [...(existsSync('src') ? readdirSync('src') : []).map((f) => `src/${f}`), 'server.ts'].filter((f) => /\.(ts|js|mjs)$/.test(f) && existsSync(f));
const kitSources = new Set(sources.filter(namesKit));
const seen = new Map<string, boolean>();
const reaches = (f: string): boolean => {
  if (seen.has(f)) return seen.get(f)!;
  seen.set(f, false); // a cycle among helpers adds nothing
  const yes = existsSync(f) && (namesKit(f) || imports(f).some((g) => kitSources.has(g) || (g.startsWith('test/') && !/\.test\./.test(g) && reaches(g))));
  seen.set(f, yes);
  return yes;
};
for (const f of readdirSync('test').filter((f) => /\.test\.(ts|js|mjs|cjs|mts|cts)$/.test(f)).sort()) {
  if (reaches(`test/${f}`)) console.log(`test/${f}`);
}
