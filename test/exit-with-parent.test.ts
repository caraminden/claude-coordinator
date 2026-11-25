import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { exitWithParent } from '../src/exit-with-parent.ts';
import { bootServer, listeningPort, TEST_ZONE, PASSWORD, procsUnder, REPO, SECRET, tempRoot, until } from './helpers.ts';

// A server a test started goes when the test's process does (#1546), and so does what it started.
const tmp = tempRoot('exit-with-parent-');
after(() => tmp.teardown());

const alive = (pid: number) => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};
const pidFrom = async (file: string) => {
  await until(`${file} to be written`, async () => existsSync(file));
  return Number(readFileSync(file, 'utf8'));
};
const gone = (dir: string, what: string) => until(what, async () => procsUnder([dir]).size === 0);

// A stand-in for a test run: it boots the server (on the same env as bootServer) and a stand-in supervisor, then waits to be killed.
const standIn = (root: string, data: string, pidFile: string) => `
    const { spawn } = require('node:child_process');
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, CITADEL_EXIT_WITH_PARENT: '1', PORT: '0', DATA_DIR: ${JSON.stringify(data)}, CLAUDE_BIN: '/bin/false', CLAUDE_CONFIG_DIR: ${JSON.stringify(join(root, 'claude'))}, COORDINATOR_PASSWORD: ${JSON.stringify(PASSWORD)}, SESSION_SECRET: ${JSON.stringify(SECRET)} };
    const server = spawn(process.execPath, [${JSON.stringify(join(REPO, 'server.ts'))}], { stdio: ['ignore', 'inherit', 'ignore'], env: { ...env, CITADEL_HOST_SIGNALS: 'fixed', CITADEL_ZONE: ${JSON.stringify(TEST_ZONE)} } });
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(server.pid));
    // Detached, in a group of its own, as a supervisor in its unit is.
    spawn('sh', ['-c', 'sleep 300; :', 'supervisor', ${JSON.stringify(join(data, 'turns/.supervisor/v1'))}], { stdio: 'ignore', detached: true }).unref();
    setInterval(() => {}, 1000);
  `;

test('a test file that boots a server and hangs, ended by --test-force-exit, leaves no server behind', async () => {
  const root = tmp.path('hang');
  const file = tmp.path('hang.test.ts');
  writeFileSync(
    file,
    `import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { bootServer } from ${JSON.stringify(join(REPO, 'test/helpers.ts'))};
test('boots, then hangs', async () => {
  const s = await bootServer({ root: ${JSON.stringify(root)} });
  writeFileSync(${JSON.stringify(tmp.path('hang.pid'))}, String(s.proc.pid));
  await new Promise(() => {});
});
`,
  );
  spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-timeout=10000', file], { timeout: 60_000, stdio: 'ignore', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const pid = await pidFrom(tmp.path('hang.pid'));
  await until('the hung test file’s server to exit', async () => !alive(pid));
});

test('a test process killed from outside leaves no server and no turn supervisor behind', async () => {
  const root = tmp.path('killed');
  const data = join(root, 'data');
  mkdirSync(join(data, 'turns/.supervisor/v1'), { recursive: true });
  const parent = tmp.spawn(process.execPath, ['-e', standIn(root, data, tmp.path('killed.pid'))], { stdio: ['ignore', 'pipe', 'ignore'] });
  await listeningPort(parent);
  const pid = await pidFrom(tmp.path('killed.pid'));
  await until('the stand-in supervisor to run', async () => procsUnder([root]).size >= 1);
  parent.kill('SIGKILL');
  await until('the server to go with the killed parent', async () => !alive(pid));
  await gone(root, 'the supervisor to go with it');
});

// tools/run-tests.sh's limit (`timeout`) and a cancelled job's TERM reach the whole group: the server takes it for a restart
// and left its turns running, for a next server that never came (#1900).
test('a test process and its server stopped together by one TERM leave no turn supervisor behind', async () => {
  const root = tmp.path('termed');
  const data = join(root, 'data');
  mkdirSync(join(data, 'turns/.supervisor/v1'), { recursive: true });
  const parent = tmp.spawn(process.execPath, ['-e', standIn(root, data, tmp.path('termed.pid'))], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  await listeningPort(parent);
  const pid = await pidFrom(tmp.path('termed.pid'));
  await until('the stand-in supervisor to run', async () => procsUnder([root]).size >= 1);
  process.kill(-parent.pid!, 'SIGTERM');
  await until('the server to go', async () => !alive(pid));
  await gone(root, 'the supervisor to go with it');
});

test('leaving stops what names the data folder when the test is gone, and nothing while it lives (a test restarting its server)', async () => {
  const data = tmp.path('leave');
  mkdirSync(data, { recursive: true });
  const supervisor = () => tmp.spawn('sh', ['-c', 'sleep 300; :', 'supervisor', join(data, 'v1')], { stdio: 'ignore', detached: true });
  const exits = () => assert.fail('the check never runs here');
  const dead = spawnSync('true').pid;
  const first = supervisor();
  await exitWithParent(data, () => {}, process.ppid, { CITADEL_EXIT_WITH_PARENT: String(process.pid) }, exits)();
  assert.equal(procsUnder([data]).size, 1, 'left for the next server');
  await exitWithParent(data, () => {}, process.ppid, { CITADEL_EXIT_WITH_PARENT: String(dead) }, exits)();
  await gone(data, 'the supervisor of a dead test to go');
  assert.equal(first.exitCode ?? first.signalCode, 'SIGKILL');
});

// A cancelled job's test file is killed while its server is still booting: by the time the server looks, its parent is
// already init, so it never saw the parent change (a mutation job's server, left for hours, #1900).
test('a server that comes up after its test is dead exits', async () => {
  const root = tmp.path('late');
  mkdirSync(root, { recursive: true });
  const file = tmp.path('late.ts');
  writeFileSync(
    file,
    `import { tempRoot, PASSWORD, SECRET } from ${JSON.stringify(join(REPO, 'test/helpers.ts'))};
import { rmSync, writeFileSync } from 'node:fs';
const t = tempRoot('late-inner-');
rmSync(t.dir, { recursive: true }); // timing-ok: empty, and this process is about to be killed
const env = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PORT: '0', DATA_DIR: ${JSON.stringify(join(root, 'data'))}, CLAUDE_BIN: '/bin/false', CLAUDE_CONFIG_DIR: ${JSON.stringify(join(root, 'claude'))}, COORDINATOR_PASSWORD: PASSWORD, SESSION_SECRET: SECRET };
const p = t.spawn('sh', ['-c', 'while kill -0 ' + process.pid + ' 2>/dev/null; do sleep 0.05; done; exec "$0" "$@" >"$OUT" 2>&1', process.execPath, ${JSON.stringify(join(REPO, 'server.ts'))}], { stdio: 'ignore', detached: true, env: { ...env, OUT: ${JSON.stringify(tmp.path('late.out'))}, CITADEL_HOST_SIGNALS: 'fixed', CITADEL_ZONE: ${JSON.stringify(TEST_ZONE)} } });
writeFileSync(${JSON.stringify(tmp.path('late.pid'))}, String(p.pid));
process.kill(process.pid, 'SIGKILL');
`,
  );
  spawnSync(process.execPath, [file], { timeout: 30_000, stdio: 'ignore' });
  const pid = await pidFrom(tmp.path('late.pid'));
  try {
    await until('the server to start', async () => existsSync(tmp.path('late.out'))); // the shell execs it once its test is dead
    await until('the server to notice its test is gone', async () => !alive(pid));
    assert.doesNotMatch(readFileSync(tmp.path('late.out'), 'utf8'), /Error/, 'it exited by itself');
  } finally {
    if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});

test('a server that never reports its port is stopped when bootServer gives up', async () => {
  const root = tmp.path('noport');
  mkdirSync(root, { recursive: true });
  const script = join(root, 'silent-server.mjs');
  writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  await assert.rejects(bootServer({ root, script, portMs: 300 }), /did not say which port/);
  await gone(root, 'the silent server to be stopped');
});
