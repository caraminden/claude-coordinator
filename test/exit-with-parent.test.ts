import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
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
  // A stand-in for a test run: it boots the server (on the same env as bootServer) and a stand-in supervisor, then waits to be killed.
  const parent = tmp.spawn(
    process.execPath,
    [
      '-e',
      `
    const { spawn } = require('node:child_process');
    const TEST_ZONE = ${JSON.stringify(TEST_ZONE)};
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, CITADEL_EXIT_WITH_PARENT: '1', CITADEL_HOST_SIGNALS: 'fixed', PORT: '0', DATA_DIR: ${JSON.stringify(data)}, CLAUDE_BIN: '/bin/false', CLAUDE_CONFIG_DIR: ${JSON.stringify(join(root, 'claude'))}, COORDINATOR_PASSWORD: ${JSON.stringify(PASSWORD)}, SESSION_SECRET: ${JSON.stringify(SECRET)} };
    const server = spawn(process.execPath, [${JSON.stringify(join(REPO, 'server.ts'))}], { stdio: ['ignore', 'inherit', 'ignore'], env: { ...env, CITADEL_HOST_SIGNALS: 'fixed', CITADEL_ZONE: TEST_ZONE } });
    require('node:fs').writeFileSync(${JSON.stringify(tmp.path('killed.pid'))}, String(server.pid));
    // Detached, in a group of its own, as a supervisor in its unit is.
    spawn('sh', ['-c', 'sleep 300; :', 'supervisor', ${JSON.stringify(join(data, 'turns/.supervisor/v1'))}], { stdio: 'ignore', detached: true }).unref();
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  await listeningPort(parent);
  const pid = await pidFrom(tmp.path('killed.pid'));
  await until('the stand-in supervisor to run', async () => procsUnder([root]).size >= 1);
  parent.kill('SIGKILL');
  await until('the server to go with the killed parent', async () => !alive(pid));
  await gone(root, 'the supervisor to go with it');
});

test('a server that never reports its port is stopped when bootServer gives up', async () => {
  const root = tmp.path('noport');
  mkdirSync(root, { recursive: true });
  const script = join(root, 'silent-server.mjs');
  writeFileSync(script, 'setInterval(() => {}, 1000);\n');
  await assert.rejects(bootServer({ root, script, portMs: 300 }), /did not say which port/);
  await gone(root, 'the silent server to be stopped');
});
