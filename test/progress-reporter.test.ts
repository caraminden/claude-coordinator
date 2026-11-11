// tools/progress-reporter.ts through tools/citadel-node (#545): a test run's file counts for a minion's wait. The
// counts must never change the run: not its output, not its exit status, not when they can't be written.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const node = join(import.meta.dirname, '..', 'tools', 'citadel-node');
const root = mkdtempSync(join(tmpdir(), 'progress-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

// The second of three files waits until the counts say the first is done, then keeps what it saw, and whether a
// node --test it started itself would count too (it mustn't: it would write over the run's counts).
const WATCHER = `import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
test('watch', async () => {
  const f = process.env.CITADEL_TEST_PROGRESS_TO;
  for (let i = 0; i < 200 && !(f && existsSync(f) && readFileSync(f, 'utf8').startsWith('1\\n')); i++) await new Promise((r) => setTimeout(r, 25));
  writeFileSync('seen', JSON.stringify({ counts: f && existsSync(f) ? readFileSync(f, 'utf8') : null, inherited: process.env.CITADEL_TEST_PROGRESS ?? null }));
});
`;
function suite(files: Record<string, string>) {
  const dir = join(root, String(++n));
  mkdirSync(join(dir, 't'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, 't', name), text);
  return dir;
}
const ok = "import test from 'node:test';\ntest('fine', () => {});\n";
const red = "import test from 'node:test';\ntest('red', () => { throw new Error('red'); });\n";
function run(dir: string, progress: string | undefined, args = ['--test', '--test-concurrency=1', 't/']) {
  const env = { ...process.env, CITADEL_TEST_PROGRESS: progress, CITADEL_TEST_PROGRESS_TO: undefined, NODE_TEST_CONTEXT: undefined };
  const r = spawnSync(node, args, { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout.replace(/\(\d+(\.\d+)?ms\)|duration_ms [\d.]+/g, '') };
}

test('the counts follow the run: files done, of how many, and the one running; the exit status and output are the run\'s own', () => {
  const dir = suite({ 'a.test.mjs': ok, 'b.test.mjs': WATCHER, 'c.test.mjs': red });
  const progress = join(dir, 'progress');
  const r = run(dir, progress);
  assert.equal(r.code, 1, 'the red file still fails the run');
  assert.match(r.out, /✔ fine/);
  assert.match(r.out, /✖ red/);
  const seen = JSON.parse(readFileSync(join(dir, 'seen'), 'utf8'));
  assert.equal(seen.counts, '1\n3\nt/b.test.mjs\n');
  assert.equal(seen.inherited, null, "a test's own node --test doesn't count");
  assert.equal(readFileSync(progress, 'utf8'), '3\n3\n\n');
  assert.equal(existsSync(`${progress}.tmp`), false, 'written by a rename');
  assert.deepEqual(run(dir, undefined), r, 'the same output and status without the counts');
});

test('counts that cannot be written change nothing: the run passes with the same output', () => {
  const dir = suite({ 'a.test.mjs': ok, 'b.test.mjs': ok });
  const plain = run(dir, undefined);
  assert.equal(plain.code, 0);
  assert.deepEqual(run(dir, join(dir, 'no', 'such', 'folder', 'progress')), plain);
  mkdirSync(join(dir, 'busy.tmp')); // its temp file can't be written either
  assert.deepEqual(run(dir, join(dir, 'busy')), plain);
  assert.equal(run(suite({ 'a.test.mjs': red }), join(root, 'no', 'progress')).code, 1, 'and a red run stays red');
});

test('a run whose reporters node would pair differently, or that is not a test run, is left as it is', () => {
  const dir = suite({ 'a.test.mjs': ok });
  const progress = join(dir, 'progress');
  const dot = run(dir, progress, ['--test', '--test-reporter=dot', 't/']);
  assert.equal(dot.code, 0);
  assert.equal(dot.out.trim(), '.');
  assert.equal(existsSync(progress), false);
  const script = run(dir, progress, ['-e', 'console.log(process.argv.length, process.env.CITADEL_TEST_PROGRESS ?? "unset")']);
  assert.equal(script.out, '1 unset\n');
  assert.equal(existsSync(progress), false);
});
