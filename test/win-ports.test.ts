// tools/ci-runner/win-ports.sh (#1763): the suite's before/after count of Windows listening ports held by wslrelay,
// read from the file keep-wsl-up.ps1's task writes into the CI distro. A rise still there a write later is red;
// anything it can't read (no file, a stale one, no fresh write) passes with a note, since a false red blocks every ship.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const script = join(import.meta.dirname, '..', 'tools', 'ci-runner', 'win-ports.sh');
const scratch = mkdtempSync(join(tmpdir(), 'win-ports-'));
after(() => rmSync(scratch, { recursive: true, force: true })); // timing-ok: own temp dir
let n = 0;

function setup(relay?: number) {
  const dir = join(scratch, String(n++));
  mkdirSync(dir);
  const file = join(dir, 'count');
  if (relay !== undefined) writeFileSync(file, `wslrelay=${relay},listen=40\r\n`);
  return { file, state: join(dir, 'state') };
}

function run(cmd: string, file: string, state: string) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn('bash', [script, cmd, state], { env: { ...process.env, CITADEL_WIN_PORTS: file, WIN_PORTS_TICK: '1' } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

// Writes each count in turn as the PC's task does (a rename, so each is a new file), 1.5 s apart, then stops.
async function writer(file: string, counts: number[]) {
  const p = spawn('bash', ['-c', 'sleep 0.3; for v; do echo "wslrelay=$v,listen=40" > "$F.tmp" && mv -f "$F.tmp" "$F"; sleep 1.5; done', 'w', ...counts.map(String)], { env: { ...process.env, F: file } });
  const done = new Promise((r) => p.on('close', r));
  return async () => { p.kill(); await done; };
}

test('no count file: says so, keeps nothing, and after checks nothing', async () => {
  const { file, state } = setup();
  const b = await run('before', file, state);
  assert.equal(b.code, 0);
  assert.match(b.out, /no Windows port count on this runner/);
  assert.equal(existsSync(state), false);
  assert.deepEqual(await run('after', file, state), { code: 0, out: '' });
});

test('a stale count file is a warning, not a red', async () => {
  const { file, state } = setup(0);
  utimesSync(file, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const b = await run('before', file, state);
  assert.equal(b.code, 0);
  assert.match(b.out, /::warning::.*isn't writing it/);
  assert.equal(existsSync(state), false);
});

test('a count that stays put passes', async () => {
  const { file, state } = setup(3);
  assert.equal((await run('before', file, state)).code, 0);
  const stop = await writer(file, [3, 3, 3]);
  const a = await run('after', file, state);
  await stop();
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /holds 3 listening ports on Windows after the suite \(3 before\)/);
});

test('a rise still there a write later goes red, naming the counts', async () => {
  const { file, state } = setup(0);
  assert.equal((await run('before', file, state)).code, 0);
  const stop = await writer(file, [7, 7, 7]);
  const a = await run('after', file, state);
  await stop();
  assert.equal(a.code, 1, a.out);
  assert.match(a.out, /::error::wslrelay holds 7 listening ports on Windows, up from 0 before the suite/);
});

test('a rise gone by the next write passes', async () => {
  const { file, state } = setup(0);
  assert.equal((await run('before', file, state)).code, 0);
  const stop = await writer(file, [4, 0, 0]);
  const a = await run('after', file, state);
  await stop();
  assert.equal(a.code, 0, a.out);
});

test('no fresh write after the suite is a warning, not a red', async () => {
  const { file, state } = setup(0);
  assert.equal((await run('before', file, state)).code, 0);
  writeFileSync(file, 'wslrelay=9,listen=40\n'); // the same file, not a new write
  const a = await run('after', file, state);
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /::warning::win-ports: no fresh count/);
});
