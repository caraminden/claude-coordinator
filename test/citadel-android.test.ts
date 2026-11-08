import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// tools/citadel-android (#381): the screen lock and its lease, against a stub adb and a throwaway lock folder.
const helper = join(import.meta.dirname, '..', 'tools', 'citadel-android');
const root = mkdtempSync(join(tmpdir(), 'android-'));
const sdk = join(root, 'sdk');
const calls = join(sdk, 'calls');
// Stands in for a booted emulator; `emu kill` makes it go away.
const adb = `#!/bin/sh
echo "$*" >>'${calls}'
shift 2
case "$*" in
  'shell getprop sys.boot_completed') echo 1 ;;
  get-state) [ -e '${sdk}/killed' ] && exit 1; echo device ;;
  'emu kill') touch '${sdk}/killed' ;;
  'exec-out screencap -p') printf PNG ;;
esac
`;
mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
writeFileSync(join(sdk, 'platform-tools', 'adb'), adb);
chmodSync(join(sdk, 'platform-tools', 'adb'), 0o755);
// The helper only checks that something listens where the adb server would.
const server = createServer((s) => s.end());
let env: NodeJS.ProcessEnv;
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  env = { ...process.env, ANDROID_HOME: sdk, ANDROID_ADB_SERVER_PORT: String((server.address() as AddressInfo).port), CITADEL_HEAVY_DIR: join(root, 'locks') };
});
after(() => {
  server.close();
  rmSync(root, { recursive: true, force: true });
});
const run = (who: string, ...args: string[]) => spawnSync(helper, args, { env: { ...env, CITADEL_HEAVY_WHO: who }, encoding: 'utf8' });

test('usage errors exit 2 without touching the emulator', () => {
  assert.equal(run('a').status, 2);
  assert.equal(run('a', 'offline', 'maybe').status, 2);
  assert.equal(run('a', 'install', join(root, 'missing.apk')).status, 2);
  assert.ok(!existsSync(calls));
});

test('shot saves the screen and the caller keeps the screen for its next step', () => {
  const png = join(root, 'a.png');
  const r = run('Peek #1 (josh)', 'shot', png);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(png, 'utf8'), 'PNG');
  assert.match(readFileSync(join(root, 'locks', 'android.who'), 'utf8'), /^\d+\tPeek #1 \(josh\)\n$/);
  // Its own lease never blocks it.
  assert.equal(run('Peek #1 (josh)', 'shot', png).status, 0);
});

test('another caller waits for the holder, says who it is, and goes once the holder is done', async () => {
  const png = join(root, 'b.png');
  const b = spawn(helper, ['shot', png], { env: { ...env, CITADEL_HEAVY_WHO: 'Delve #3 (cara)' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  b.stderr!.on('data', (d) => (err += d));
  const done = new Promise<number | null>((r) => b.on('close', r));
  try {
    for (let i = 0; i < 200 && !/has it/.test(err); i++) await new Promise((r) => setTimeout(r, 25));
    assert.match(err, /waiting for the screen: Peek #1 \(josh\) has it/);
    assert.ok(!existsSync(png), 'it waits');
  } finally {
    // The holder's `down` ends its lease (and stops the emulator, here the stub).
    assert.equal(run('Peek #1 (josh)', 'down').status, 0);
  }
  assert.equal(await done, 0, err);
  assert.equal(readFileSync(png, 'utf8'), 'PNG');
  assert.match(readFileSync(calls, 'utf8'), /emu kill/);
});
