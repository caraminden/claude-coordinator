// tools/ci-progress.ts (#1368): CI's test steps send run-tests.sh's progress file on to Citadel's POST /api/ci-tests,
// with a run token asked for with the store's audience, and nothing it meets can fail the step.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { countsBody } from '../tools/ci-progress.ts';
import { testCounts } from '../src/waits.ts';
import { until } from './wait.ts';

const dir = mkdtempSync(join(tmpdir(), 'ci-progress-'));
after(() => rmSync(dir, { recursive: true, force: true })); // timing-ok: own temp dir

test("the body is the progress file's lines, as Citadel's route takes them", () => {
  assert.equal(countsBody(''), null, 'no counts yet');
  assert.equal(countsBody('3\n0\n\n'), null, 'no files');
  assert.equal(countsBody('9\n3\n\n'), null, 'more done than there are');
  const suite = countsBody('96\n212\ntest/runner.test.ts\ntest/a.test.ts\ttest/b.test.ts\n')!;
  assert.deepEqual(suite, { done: 96, total: 212, file: 'test/runner.test.ts', failed: ['test/a.test.ts', 'test/b.test.ts'], phase: 'suite' });
  assert.deepEqual(countsBody('1\n2\ntest/b.test.ts\ntest/a.test.ts\ttest/b.test.ts\nrerun\n')!.phase, 'rerun');
  assert.deepEqual(countsBody('3\n3\n\n')!, { done: 3, total: 3, file: '', failed: [], phase: 'suite' }, "the reporter's lines from before #1368 too");
  const many = countsBody(`1\n2\n\n${Array.from({ length: 30 }, (_, i) => `test/${'x'.repeat(300)}${i}.test.ts`).join('\t')}\n`)!;
  assert.equal(many.failed.length, 20);
  for (const b of [suite, many]) assert.ok(testCounts(b.done, b.total, b.file, b.failed, b.phase), 'the route takes it');
});

test('it asks GitHub for a run token for the store and posts the counts with it, again while they last; a refusal never stops it', async () => {
  const got: { auth: string; body: { phase?: string } }[] = [];
  const asks: string[] = [];
  let refuse = 1;
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      if (req.url!.startsWith('/token')) {
        asks.push(`${req.url} ${req.headers.authorization}`);
        return res.end(JSON.stringify({ value: `run-token-${asks.length}` }));
      }
      if (refuse-- > 0) {
        res.statusCode = 503;
        return res.end('busy');
      }
      got.push({ auth: String(req.headers.authorization), body: JSON.parse(text) });
      res.statusCode = 202;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const file = join(dir, 'tests.progress');
  writeFileSync(file, '96\n212\ntest/runner.test.ts\ntest/a.test.ts\n');
  const env = { ...process.env, ACTIONS_ID_TOKEN_REQUEST_URL: `${url}/token?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ask-token', CITADEL_STORE_URL: url, CI_PROGRESS_EVERY: '0.02', RUNNER_ENVIRONMENT: 'self-hosted' };
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'tools', 'ci-progress.ts'), file], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  try {
    await until(
      'two posts',
      () => got.length >= 2,
      undefined,
      () => stderr,
    );
    assert.equal(asks[0], '/token?x=1&audience=citadel-ci-store Bearer ask-token');
    assert.equal(got[0].auth, 'Bearer run-token-1');
    assert.deepEqual(got[0].body, { done: 96, total: 212, file: 'test/runner.test.ts', failed: ['test/a.test.ts'], phase: 'suite' });
    assert.match(stderr, /ci-progress: Citadel at \S+ refused the counts \(HTTP 503\): busy; the tests go on/);
    writeFileSync(file, '0\n1\ntest/a.test.ts\ntest/a.test.ts\nrerun\n');
    await until(
      "the reruns' counts",
      () => got.some((g) => g.body.phase === 'rerun'),
      undefined,
      () => stderr,
    );
    assert.equal(asks.length, 1, 'one token while it lasts');
  } finally {
    child.kill();
    server.close();
  }
});

test("stopped once the tests end, it sends the run's last counts on its way out, though run-tests.sh has removed the file", async () => {
  const got: unknown[] = [];
  const server = createServer((req, res) => {
    let text = '';
    req.on('data', (c) => (text += c));
    req.on('end', () => {
      if (req.url!.startsWith('/token')) return res.end(JSON.stringify({ value: 'run-token' }));
      got.push(JSON.parse(text));
      res.statusCode = 202;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const file = join(dir, 'last.progress');
  writeFileSync(file, '5\n5\n\ntest/a.test.ts\n');
  const env = { ...process.env, ACTIONS_ID_TOKEN_REQUEST_URL: `${url}/token?x=1`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'ask-token', CITADEL_STORE_URL: url, CI_PROGRESS_EVERY: '0.05', RUNNER_ENVIRONMENT: 'self-hosted' };
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'tools', 'ci-progress.ts'), file], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (c) => (stderr += c));
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  try {
    await until(
      'the counts sent',
      () => got.length > 0,
      undefined,
      () => stderr,
    );
    rmSync(file); // run-tests.sh removes it as the suite ends, then the step stops the sender
    const before = got.length;
    child.kill('SIGTERM');
    assert.deepEqual(await exited, { code: 0, signal: null }, `it ends by itself once the last counts are sent: ${stderr}`);
    assert.ok(got.length > before, 'a last send after it was told to stop');
    assert.deepEqual(got.at(-1), { done: 5, total: 5, file: '', failed: ['test/a.test.ts'], phase: 'suite' });
  } finally {
    child.kill();
    server.close();
  }
});

test('with no run token, or on a GitHub-hosted runner, it sends nothing and ends at once with no error', async () => {
  for (const extra of [{ ACTIONS_ID_TOKEN_REQUEST_URL: '' }, { ACTIONS_ID_TOKEN_REQUEST_URL: 'http://x/', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 't', RUNNER_ENVIRONMENT: 'github-hosted' }]) {
    const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'tools', 'ci-progress.ts'), join(dir, 'none')], { env: { ...process.env, ACTIONS_ID_TOKEN_REQUEST_TOKEN: '', ...extra }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    const code = await new Promise((r) => child.once('exit', r));
    assert.equal(code, 0, stderr);
    if (!extra.RUNNER_ENVIRONMENT) assert.match(stderr, /no run token .*id-token: write/);
    else assert.equal(stderr, '');
  }
});
