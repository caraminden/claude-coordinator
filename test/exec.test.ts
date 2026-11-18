import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { execResult, runLogged } from '../src/exec.ts';

test('execResult: exit code, output, stderr and the failure message', async () => {
  assert.deepEqual(await execResult('sh', ['-c', 'echo hi']), { code: 0, out: 'hi\n', err: '', fail: '' });
  const bad = await execResult('sh', ['-c', 'echo no >&2; exit 3']);
  assert.equal(bad.code, 3);
  assert.equal(bad.err, 'no\n');
  assert.match(bad.fail, /Command failed/);
  assert.equal((await execResult('/no/such/bin', [])).code, 1);
});

test('runLogged: logs output, returns the exit code, 124 on timeout, 127 when it will not start', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'exec-')), 'log');
  assert.equal(await runLogged(['sh', '-c', 'echo out; exit 5'], '/', process.env, log, 5000), 5);
  assert.equal(readFileSync(log, 'utf8'), 'out\n');
  assert.equal(await runLogged(['sleep', '30'], '/', process.env, log, 100), 124);
  assert.equal(await runLogged(['/no/such/bin'], '/', process.env, log, 5000), 127);
  assert.match(readFileSync(log, 'utf8'), /== stopped: it ran past 0\.1 s/, 'a timeout says so in the log');
});

test('runLogged: a command killed by a signal returns 128 + its number and the log names the signal', async () => {
  const log = join(mkdtempSync(join(tmpdir(), 'exec-')), 'log');
  assert.equal(await runLogged(['sh', '-c', 'kill -TERM $$'], '/', process.env, log, 5000), 143);
  assert.match(readFileSync(log, 'utf8'), /== killed by SIGTERM/);
  assert.equal(await runLogged(['sh', '-c', 'kill -KILL $$'], '/', process.env, log, 5000), 137);
  assert.match(readFileSync(log, 'utf8'), /== killed by SIGKILL/);
});
