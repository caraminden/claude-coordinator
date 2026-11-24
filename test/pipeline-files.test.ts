import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';

// tools/pipeline-files.txt (#581): a land that touches none of its paths leaves out the test files it lists, so each
// of those must be unable to break from anything else: no import from outside test/ (src/, public/, a tools/ module),
// directly or through its fixtures, and every fixture and tools/ file it uses is on the list, so changing one runs it.
const repo = resolve(import.meta.dirname, '..');
const entries = readFileSync(join(repo, 'tools', 'pipeline-files.txt'), 'utf8')
  .split('\n')
  .map((l) => l.replace(/\s*#.*/, '').trim())
  .filter(Boolean);
const gated = entries.filter((e) => /^test\/.*\.test\./.test(e));
// run-tests.sh counts a change to the list itself as a pipeline change.
const listed = (path: string) => path === 'tools/pipeline-files.txt' || entries.some((e) => e === path || (e.endsWith('/') && path.startsWith(e)));
// import … from '…', import '…', import('…'), require('…'): a string after `from` elsewhere (a regex, a message) is not one.
const IMPORT = /^(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]|\b(?:import|require)\(\s*['"]([^'"]+)['"]/gm;
const specs = (src: string) => [...src.matchAll(IMPORT)].map((m) => m[1] ?? m[2] ?? m[3]);
const testFiles = new Set(readdirSync(join(repo, 'test')));
const toolFiles = new Set(readdirSync(join(repo, 'tools')).filter((f) => statSync(join(repo, 'tools', f)).isFile()));

test('the list names files that exist, and some test files', () => {
  for (const e of entries) assert.ok(existsSync(join(repo, e)), `${e} is on tools/pipeline-files.txt but not in the repo`);
  assert.ok(gated.length > 0);
});

test('a listed test file imports nothing from outside test/, and its fixtures and the tools/ files it names are listed', () => {
  const seen = new Set<string>();
  const walk = (file: string, from: string) => {
    const rel = relative(repo, file);
    if (seen.has(rel)) return;
    seen.add(rel);
    assert.ok(rel.startsWith('test/') && !rel.includes('..'), `${from} imports ${rel}: outside test/, so a product change could break it`);
    assert.ok(listed(rel), `${from} imports ${rel}, which is not on tools/pipeline-files.txt: a change to it would not run ${from}`);
    const src = readFileSync(file, 'utf8');
    for (const spec of specs(src)) {
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('.'), `${rel} imports the package ${spec}: the repo has none, so it is from outside test/`);
      walk(resolve(dirname(file), spec), rel);
    }
    // A tools/ file the test copies or runs is named by its file name ('land.sh', join(tools, 'run-tests.sh')); so is a
    // test/ module it loads some other way (join(import.meta.dirname, 'leak-guard.ts') as a run's global setup).
    // A systemd name given as a fixture's DEPLOY_SERVICE or DEPLOY_UNIT ('citadel-test') is not tools/citadel-test (#641).
    for (const [, name] of src.matchAll(/(?<!_(?:SERVICE|UNIT):\s*)['"`]([\w.-]+)['"`]/g)) {
      if (toolFiles.has(name)) assert.ok(listed(`tools/${name}`), `${rel} names tools/${name}, which is not on tools/pipeline-files.txt`);
      if (testFiles.has(name) && /\.[cm]?[jt]s$/.test(name)) walk(join(repo, 'test', name), rel);
    }
  };
  for (const f of gated) walk(join(repo, f), f);
});

test('the import check finds every kind of import, and not a string after `from` in a regex', () => {
  const src = "import assert from 'node:assert';\nimport {\n  x,\n} from '../src/db.ts';\nimport '../src/side.ts';\nconst y = await import('../public/app.js');\nassert.match(e, /from \"$X\"/);\n";
  assert.deepEqual(specs(src), ['node:assert', '../src/db.ts', '../src/side.ts', '../public/app.js']);
});

test("node --test test/ runs exactly run-tests.sh's test/*.test.* glob, so leaving files out drops no other", () => {
  // node's default patterns (checked on node 26): *.test.*, *-test.*, *_test.*, test-*.*, test.*, in any folder.
  const nodeRuns = /(^|\/)(test|test-[^/]*|[^/]*[._-]test)\.[cm]?[jt]s$/;
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [relative(repo, join(dir, d.name))]));
  const odd = walk(join(repo, 'test')).filter((f) => nodeRuns.test(f.slice('test/'.length)) && !/^test\/[^/]+\.test\.[cm]?[jt]s$/.test(f));
  assert.deepEqual(odd, [], "node runs these but run-tests.sh's product tier would not: name them test/<name>.test.ts, or widen its glob");
});
