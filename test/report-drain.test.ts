// A test file's whole report reaches the run before --test-force-exit ends the file (#1959). Node waits for its reporter
// to unpipe, then calls process.exit(), which drops whatever the pipe hasn't taken yet: the last tests of a file went
// uncounted, and a red only the report carries (a throwing top-level after(), which node exits 0 for) ended the run
// green, at the gate too. tools/citadel-node.cjs, which every runner goes through, makes that exit wait.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tempRoot } from './helpers.ts';
import { scriptEnv } from './script-env.ts';
import { until } from './wait.ts';

const TOOLS = join(import.meta.dirname, '..', 'tools');
const scratch = tempRoot('report-drain-');
after(() => scratch.teardown());

const N = 4000;
const file = (name: string, tail: string) => {
  const dir = join(scratch.dir, name, 'test');
  mkdirSync(dir, { recursive: true });
  // The report of thousands of tests is far more than a pipe holds, so it is still going out when the tests are done.
  writeFileSync(join(dir, 'a.test.mjs'), `import test, { after } from 'node:test';\nconst pad = 'x'.repeat(300);\nfor (let i = 0; i < ${N}; i++) test('t' + i + pad, () => {});\n${tail}\n`);
  return join(scratch.dir, name);
};
const cases = {
  after: file('after', "after(() => { throw new Error('teardown broke'); });"),
  skip: file('skip', "test('LASTSKIP', { skip: true }, () => {});"),
  red: file('red', "test('LASTRED', () => { throw new Error('real red'); });"),
  handle: file('handle', 'setInterval(() => {}, 1000);'),
};
const env = scriptEnv({ NODE_TEST_CONTEXT: undefined, CITADEL_TEST_PROGRESS_TO: undefined, CITADEL_TEST_PROGRESS: undefined, CITADEL_TEST_TIMES: undefined, CITADEL_TEST_FILES: '0' });
const read = (cwd: string, f: string) => readFileSync(join(cwd, f), 'utf8');
type Ran = { code: number; out: string };
const ran = (cmd: string, args: string[], cwd: string, more: Record<string, string> = {}) => new Promise<Ran>((res) => execFile(cmd, args, { cwd, env: { ...env, ...more }, maxBuffer: 1 << 26, timeout: 50_000, killSignal: 'SIGKILL' }, (e, out, err) => res({ code: e ? Number(e.code ?? 1) : 0, out: out + err })));

const runners: Record<string, (cwd: string) => Promise<Ran>> = {
  'suite-runner.ts (the gate)': (cwd) => ran(join(TOOLS, 'citadel-node'), [join(TOOLS, 'suite-runner.ts'), '--concurrency', '1', '--timeout', '60000', '--', 'test/'], cwd),
  'plain --test --test-force-exit': (cwd) => ran(join(TOOLS, 'citadel-node'), ['--test', '--test-force-exit', '--test-reporter=spec', 'test/a.test.mjs'], cwd),
  'plain with the progress reporter': (cwd) => ran(join(TOOLS, 'citadel-node'), ['--test', '--test-force-exit', '--test-reporter=spec', '--test-reporter-destination=stdout', 'test/a.test.mjs'], cwd, { CITADEL_TEST_PROGRESS: join(cwd, 'progress') }),
  // Its spec output, with the counts, goes to a log in its TMPDIR.
  'citadel-test': async (cwd) => {
    const tmp = join(cwd, 'tmp');
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(cwd, 'none.txt'), '');
    const r = await ran(join(TOOLS, 'citadel-test'), [join(cwd, 'test', 'a.test.mjs')], join(TOOLS, '..'), { TMPDIR: tmp, CITADEL_TEST_ALWAYS: join(cwd, 'none.txt') });
    return { code: r.code, out: r.out + read(tmp, 'citadel-test.log') };
  },
};
const count = (r: Ran, what: string) => Number(r.out.match(new RegExp(`^ℹ ${what} (\\d+)$`, 'm'))?.[1]);

for (const [name, go] of Object.entries(runners)) {
  test(`${name}: a throwing top-level after() turns the run red`, async () => {
    const r = await go(cases.after);
    assert.equal(r.code, 1, r.out.slice(-600));
    assert.match(r.out, /teardown broke/);
    assert.equal(count(r, 'pass'), N);
  });
  test(`${name}: a skipped last test is counted`, async () => {
    const r = await go(cases.skip);
    assert.equal(r.code, 0);
    assert.equal(count(r, 'skipped'), 1);
    assert.equal(count(r, 'pass'), N);
  });
  test(`${name}: a failing last test is red by name`, async () => {
    const r = await go(cases.red);
    assert.equal(r.code, 1);
    assert.match(r.out, /LASTRED/);
    assert.equal(count(r, 'fail'), 1);
    assert.equal(count(r, 'pass'), N);
  });
  test(`${name}: an open handle still cannot keep the run going`, async () => {
    const r = await go(cases.handle);
    assert.equal(r.code, 0, r.out.slice(-600));
    assert.equal(count(r, 'pass'), N);
  });
}

// The race on its own, without a loaded box. A file's report is already going into a full pipe when its tests end, as when
// the runner is too busy to read: dd fills the pipe first, the file's report all waits behind that, and the reader starts
// only once told to.
// timeout 1: a newer dd (uutils, on GitHub's hosted image) waits for the reader on a full pipe instead of failing, so the file never started.
const PIPE = '{ timeout 1 dd if=/dev/zero bs=4096 count=512 oflag=nonblock 2>/dev/null; "$@"; echo $? >code; } | { until [ -e go ]; do sleep 0.05; done; tr -d "\\0" >out; }';
const fullPipe = (cwd: string, more: Record<string, string | undefined> = {}, flags = ['--test-force-exit']) =>
  scratch.spawn('bash', ['-c', PIPE, 'sh', join(TOOLS, 'citadel-node'), ...flags, join(cwd, 'test', 'a.test.mjs')], { cwd, env: { ...env, NODE_TEST_CONTEXT: 'child-v8', ...more }, stdio: ['ignore', 'ignore', 'pipe'] });
const small = (name: string) => {
  const cwd = join(scratch.dir, name);
  mkdirSync(join(cwd, 'test'), { recursive: true });
  writeFileSync(join(cwd, 'test', 'a.test.mjs'), "import test, { after } from 'node:test';\nimport { writeFileSync } from 'node:fs';\ntest('LASTONE', () => {});\nafter(() => writeFileSync('done', ''));\n");
  return cwd;
};

test('a file whose runner is slow to read stays until its whole report is read', async () => {
  const cwd = small('slow');
  const p = fullPipe(cwd);
  const closed = new Promise((r) => p.on('close', r));
  await until('the file is done', () => existsSync(join(cwd, 'done')), 120_000);
  // Long enough for an exit that doesn't wait: other processes start and end.
  for (let i = 0; i < 5; i++) await ran(process.execPath, ['-e', ''], cwd);
  const early = existsSync(join(cwd, 'code'));
  writeFileSync(join(cwd, 'go'), '');
  await closed;
  assert.match(read(cwd, 'out'), /LASTONE/);
  assert.match(read(cwd, 'out'), /test:summary/, 'the last thing a file reports');
  assert.equal(early, false, 'it exited with its report unread');
  assert.equal(read(cwd, 'code'), '0\n');
});

for (const [what, more, flags] of [
  ['file', {}, undefined],
  ['whole run', { NODE_TEST_CONTEXT: undefined }, ['--test', '--test-force-exit', '--test-reporter=spec']],
] as const)
  test(`a report nobody reads ends the ${what} at the limit, red`, async () => {
    const cwd = small(`unread ${what}`);
    const p = fullPipe(cwd, { CITADEL_TEST_DRAIN_LIMIT: '1', ...more }, flags && [...flags]);
    let err = '';
    p.stderr!.on('data', (b) => (err += b));
    const closed = new Promise((r) => p.on('close', r));
    await until('the file gave up', () => existsSync(join(cwd, 'code')), 120_000);
    writeFileSync(join(cwd, 'go'), '');
    await closed;
    assert.equal(read(cwd, 'code'), '1\n');
    assert.match(err, /nobody read .*a\.test\.mjs's report/);
  });
