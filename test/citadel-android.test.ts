import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

// tools/citadel-android (#381): the screen lock and its lease, against a stub adb and a throwaway lock folder.
const helper = join(import.meta.dirname, '..', 'tools', 'citadel-android');
const root = mkdtempSync(join(tmpdir(), 'android-'));
const sdk = join(root, 'sdk');
const calls = join(sdk, 'calls');
// Stands in for a booted emulator; `emu kill` makes it go away (and ends the stub emulator, if one runs).
const adb = `#!/bin/sh
echo "$*" >>'${calls}'
# A client that finds no server starts one, which lives on with whatever descriptors it inherited.
[ -n "\${ADB_STUB_SERVER:-}" ] && { sleep 30 </dev/null >/dev/null 2>&1 & echo $! >>'${sdk}/server.pids'; }
[ "$1" = -s ] && shift 2
case "$*" in
  'shell getprop sys.boot_completed') echo 1 ;;
  get-state) [ -e '${sdk}/killed' ] && exit 1; echo device ;;
  # A real stop saves the quick-boot snapshot first, which takes seconds.
  'emu kill') touch '${sdk}/killed'; [ -e '${sdk}/emu.pid' ] && { sleep 1; kill "$(cat '${sdk}/emu.pid')"; } ;;
  'exec-out screencap -p') printf PNG ;;
  'install -r -t '*bad.apk) echo 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]'; exit 1 ;;
esac
`;
mkdirSync(join(sdk, 'platform-tools'), { recursive: true });
writeFileSync(join(sdk, 'platform-tools', 'adb'), adb);
chmodSync(join(sdk, 'platform-tools', 'adb'), 0o755);
mkdirSync(join(sdk, 'emulator'));
writeFileSync(join(sdk, 'emulator', 'emulator'), `#!/bin/sh\necho $$ >'${sdk}/emu.pid'\nexec sleep 60\n`);
chmodSync(join(sdk, 'emulator', 'emulator'), 0o755);
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

test('install says what a signature mismatch means and still fails', () => {
  const apk = join(root, 'bad.apk');
  writeFileSync(apk, 'x');
  const r = run('Peek #1 (josh)', 'install', apk);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /INSTALL_FAILED_UPDATE_INCOMPATIBLE/);
  assert.match(r.stderr, /signed with another key.*only if it is yours/);
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

test('an adb server a step starts does not keep the screen locked after the step', () => {
  const locks = join(root, 'stray-server');
  const pids = join(sdk, 'server.pids');
  for (const f of [join(sdk, 'killed'), pids]) rmSync(f, { force: true });
  try {
    // down is where it happened (#496): its wait for the emulator to go ran adb after the service, and its server, had gone.
    const r = spawnSync(helper, ['down'], { env: { ...env, CITADEL_HEAVY_DIR: locks, CITADEL_HEAVY_WHO: 'a', ADB_STUB_SERVER: '1' }, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(existsSync(pids), 'the stub started a server');
    assert.equal(spawnSync('flock', ['-n', join(locks, 'android.lock'), 'true']).status, 0, 'the screen is free');
  } finally {
    for (const pid of existsSync(pids) ? readFileSync(pids, 'utf8').trim().split('\n').map(Number) : []) if (alive(pid)) process.kill(pid);
  }
});

// serve, the service's main process, with a 1-second idle time and its own lock folder.
function serve(locks: string) {
  for (const f of [join(sdk, 'emu.pid'), join(sdk, 'killed'), calls]) rmSync(f, { force: true });
  const child = spawn(helper, ['serve'], { env: { ...env, CITADEL_HEAVY_DIR: locks, CITADEL_ANDROID_IDLE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (d) => (out += d));
  return { child, out: () => out, done: new Promise<number | null>((r) => child.on('close', r)) };
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function emulatorPid() {
  for (let i = 0; i < 200 && !existsSync(join(sdk, 'emu.pid')); i++) await new Promise((r) => setTimeout(r, 25));
  return Number(readFileSync(join(sdk, 'emu.pid'), 'utf8'));
}

test('serve stops the emulator once nobody has used it for the idle time, and ends with it', async () => {
  const locks = join(root, 'serve-1');
  const s = serve(locks);
  const pid = await emulatorPid();
  try {
    for (let i = 0; i < 200 && !/emu kill/.test(existsSync(calls) ? readFileSync(calls, 'utf8') : ''); i++) await new Promise((r) => setTimeout(r, 10));
    // While it stops, the screen stays taken: a step arriving now waits instead of meeting a dying emulator.
    assert.equal(spawnSync('flock', ['-n', join(locks, 'android.lock'), 'true']).status, 1);
    assert.equal(await s.done, 0);
    assert.match(s.out(), /unused for \d+s; stopping/);
    assert.ok(!alive(pid), 'the emulator is gone');
  } finally {
    if (alive(pid)) process.kill(pid);
  }
});

test('serve waits for a step that holds the screen before it stops the emulator', async () => {
  const locks = join(root, 'serve-2');
  mkdirSync(locks, { recursive: true });
  const held = join(root, 'held');
  // A step in progress: the screen's flock, held for 3 seconds.
  const step: ChildProcess = spawn('flock', [join(locks, 'android.lock'), 'sh', '-c', `touch '${held}'; sleep 3`], { stdio: 'ignore' });
  const stepDone = new Promise((r) => step.on('close', r));
  for (let i = 0; i < 200 && !existsSync(held); i++) await new Promise((r) => setTimeout(r, 25));
  const s = serve(locks);
  const pid = await emulatorPid();
  try {
    await new Promise((r) => setTimeout(r, 2000));
    assert.ok(alive(pid), 'still up while the step runs');
    await stepDone;
    assert.equal(await s.done, 0);
    assert.ok(!alive(pid));
  } finally {
    if (alive(pid)) process.kill(pid);
  }
});

// Console steps (#442): the turn's side checks its words, serve checks them again and talks to the console.
test('sms refuses a bad sender or text without touching the emulator', () => {
  rmSync(calls, { force: true });
  for (const [from, text] of [['abc', 'hi'], ['+', 'hi'], ['12;reboot', 'hi'], ['1'.repeat(21), 'hi'], ['555', ''], ['555', 'hi\r\nkill'], ['555', 'tab\there'], ['555', 'x'.repeat(501)]]) {
    const r = run('a', 'sms', from, text);
    assert.equal(r.status, 2, `${from} ${JSON.stringify(text)}: ${r.stderr}`);
  }
  assert.equal(run('a', 'sms', '555').status, 2);
  assert.ok(!existsSync(calls));
});

test('sms goes through serve to the console with the host token, and serve refuses a forged request', async () => {
  const locks = join(root, 'serve-sms');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.emulator_console_auth_token'), 'sekrit\n');
  // A stub console: banner, then OK to each line, KO to a command before auth.
  const got: string[] = [];
  const consoleServer = createServer((s) => {
    let authed = false;
    let buf = '';
    s.write('Android Console: Authentication required\r\nOK\r\n');
    s.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        got.push(line);
        if (line === 'quit') s.end();
        else if (line === 'auth sekrit') { authed = true; s.write('OK\r\n'); }
        else s.write(authed ? 'OK\r\n' : 'KO: unknown command\r\n');
      }
    });
  });
  await new Promise<void>((r) => consoleServer.listen(0, '127.0.0.1', r));
  const port = String((consoleServer.address() as AddressInfo).port);
  for (const f of [join(sdk, 'emu.pid'), join(sdk, 'killed'), calls]) rmSync(f, { force: true });
  const s = spawn(helper, ['serve'], { env: { ...env, HOME: home, CITADEL_HEAVY_DIR: locks, CITADEL_ANDROID_IDLE: '60', CITADEL_ANDROID_CONSOLE_PORT: port }, stdio: 'ignore' });
  const done = new Promise((r) => s.on('close', r));
  const pid = await emulatorPid();
  try {
    // Not spawnSync: the stub console answers from this process.
    const c = spawn(helper, ['sms', '+15551234567', 'Your code is 1234 \\ 50% off!'], { env: { ...env, CITADEL_HEAVY_DIR: locks, CITADEL_HEAVY_WHO: 'a' }, stdio: ['ignore', 'ignore', 'pipe'] });
    const r = { stderr: '', status: null as number | null };
    c.stderr!.on('data', (d) => (r.stderr += d));
    r.status = await new Promise((res) => c.on('close', res));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /sent a text from \+15551234567/);
    assert.doesNotMatch(r.stderr, /sekrit/);
    assert.deepEqual(got, ['auth sekrit', 'sms send +15551234567 Your code is 1234 \\ 50% off!', 'quit']);

    // Anything running as this account can write a request; serve checks it again and the console never sees it.
    got.length = 0;
    writeFileSync(join(locks, 'android.req.forged'), 'sms\n555\nhi\rkill\n');
    for (let i = 0; i < 200 && !existsSync(join(locks, 'android.out.forged')); i++) await new Promise((r) => setTimeout(r, 25));
    assert.match(readFileSync(join(locks, 'android.out.forged'), 'utf8'), /^KO: .*control character/);
    writeFileSync(join(locks, 'android.req.other'), 'kill\n\n\n');
    for (let i = 0; i < 200 && !existsSync(join(locks, 'android.out.other')); i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(readFileSync(join(locks, 'android.out.other'), 'utf8'), 'KO: unknown step\n');

    // serve can read what turns can't: a request that links to the token (or a hard link to it) is refused
    // without repeating it, and a link planted where the answer goes is replaced, not written through.
    const answer = async (id: string) => {
      // A planted link already "exists": wait for the plain file serve leaves in its place.
      const isAnswer = () => { try { return lstatSync(join(locks, `android.out.${id}`)).isFile(); } catch { return false; } };
      for (let i = 0; i < 200 && !isAnswer(); i++) await new Promise((r) => setTimeout(r, 25));
      return readFileSync(join(locks, `android.out.${id}`), 'utf8');
    };
    symlinkSync(join(home, '.emulator_console_auth_token'), join(locks, 'android.req.link'));
    linkSync(join(home, '.emulator_console_auth_token'), join(locks, 'android.req.hard'));
    const victim = join(root, 'victim');
    writeFileSync(victim, 'keep me\n');
    symlinkSync(victim, join(locks, 'android.out.planted'));
    writeFileSync(join(locks, 'android.req.planted'), 'kill\n\n\n');
    assert.equal(await answer('link'), 'KO: refused: a request must be a plain file\n');
    assert.equal(await answer('hard'), 'KO: refused: a request must be a plain file\n');
    assert.equal(await answer('planted'), 'KO: unknown step\n');
    assert.equal(readFileSync(victim, 'utf8'), 'keep me\n');
    assert.equal(readFileSync(join(home, '.emulator_console_auth_token'), 'utf8'), 'sekrit\n');
    assert.deepEqual(got, []);
  } finally {
    s.kill('SIGTERM');
    await done;
    if (alive(pid)) process.kill(pid);
    consoleServer.close();
  }
});
