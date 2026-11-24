// No test file awaits at its top level after its first test (#1732). The gate runs every file with force-exit
// (tools/suite-runner.ts, `run({ forceExit: true })`, so a leaked handle can't hang the run: #1565), and under it node
// exits a file once the tests registered so far are done. A file that runs `test('a')`, then awaits a server's listen,
// then registers nine more tests, reports 1 test and passes: test/thread-identity.test.ts did, until #1732.
// Whether a file awaits at its top level is V8's own answer (vm's SourceTextModule.hasTopLevelAwait, as in
// test/worker-tla.test.ts), so an `await` in a function or in a child script's template string (test/realtime.test.ts)
// is no alarm.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const TESTS = join(import.meta.dirname);

// For each named source: the line of its first top-level test()/describe()/it()/suite() and of the last top-level
// statement after it that awaits, or nothing. A cut at a line is a real top-level statement boundary when the text on
// both sides parses: one inside a describe(), a function or a template string doesn't.
const SCAN = `
  import { SourceTextModule } from 'node:vm';
  import { stripTypeScriptTypes } from 'node:module';
  import { readFileSync } from 'node:fs';
  const parses = (js) => { try { return new SourceTextModule(js); } catch { return null; } };
  const found = {};
  const sources = JSON.parse(readFileSync(0, 'utf8'));
  for (const [name, src] of Object.entries(sources)) {
    const lines = stripTypeScriptTypes(src).split('\\n');
    const at = (i) => lines.slice(i).join('\\n');
    const first = lines.findIndex((l, i) => /^\\s*(test|describe|it|suite)(\\.\\w+)?\\s*\\(/.test(l) && parses(lines.slice(0, i).join('\\n')) && parses(at(i)));
    if (first < 0 || !parses(at(first)).hasTopLevelAwait()) continue;
    let last = first;
    for (let j = first + 1; j < lines.length; j++) if (/\\S/.test(lines[j]) && parses(at(j))?.hasTopLevelAwait()) last = j;
    found[name] = { test: first + 1, await: last + 1 };
  }
  console.log(JSON.stringify(found));
`;

/** Each source whose top level awaits after its first test, with both lines. */
function scan(sources: Record<string, string>): Record<string, { test: number; await: number }> {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '--input-type=module', '-e', SCAN], { input: JSON.stringify(sources), encoding: 'utf8', maxBuffer: 1 << 24 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('the scan flags a top-level await after a test, and only that', () => {
  const head = "import { test } from 'node:test';\n";
  const found = scan({
    cut: `${head}test('a', () => {});\nconst port: number = await listen(server);\ntest('b', () => {});\n`,
    setupFirst: `${head}const port = await Promise.resolve(1);\ntest('a', () => {});\n`,
    inATemplate: `${head}test('a', () => {});\nconst SCRIPT = \`\nawait x;\n\`;\n`,
    inAFunction: `${head}test('a', async () => {\n  await 1;\n});\nconst f = async () => await 1;\n`,
    testInATemplate: `${head}const SCRIPT = \`\ntest('x', () => {});\n\`;\nawait Promise.resolve();\ntest('a', () => {});\n`,
    describeFirst: `${head}describe('d', () => {});\nfor await (const x of [1]) void x;\n`,
    indented: `${head}  test('a', () => {});\n  const port = await listen(server);\n`,
    nested: `${head}describe('d', () => {\n  test('a', () => {});\n});\nawait listen(server);\n`,
    microtask: `${head}test('a', () => {});\nawait Promise.resolve();\n`,
  });
  // microtask: an await on nothing that holds the file open doesn't cut it short today, but whether one does can't be
  // read from the text, and moving it above the first test costs nothing.
  assert.deepEqual(found, { cut: { test: 2, await: 3 }, describeFirst: { test: 2, await: 3 }, indented: { test: 2, await: 3 }, nested: { test: 2, await: 5 }, microtask: { test: 2, await: 3 } });
});

test('no test file awaits at its top level after its first test', () => {
  const files = readdirSync(TESTS).filter((f) => f.endsWith('.test.ts'));
  assert.ok(files.length > 100, `the scan reads the test folder: ${files.length} files`);
  const found = scan(Object.fromEntries(files.map((f) => [f, readFileSync(join(TESTS, f), 'utf8')])));
  const bad = Object.entries(found).map(([f, { test: t, await: a }]) => `test/${f}: a test at line ${t}, a top-level await at line ${a}`);
  assert.deepEqual(bad, [], "under the gate's force-exit, a file ends once the tests registered so far are done, so the tests after a top-level await never run: do the setup before the first test, or in before()");
});
