// server.ts's settings (src/config.ts, #1790): what an empty environment gives, and the settings that depend on others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readConfig } from '../src/config.ts';

test('an empty environment gives every default', () => {
  assert.deepEqual(readConfig({}), {
    host: '127.0.0.1',
    port: 8573,
    appsDomain: null,
    machinesUrl: null,
    dataDir: join(homedir(), '.local/share/claude-coordinator'),
    contraptionsDir: null,
    preview: false,
    bootCheck: false,
    idleExitMs: 0,
    noCowDb: false,
    dbWriteDelayMs: 0,
    password: '',
    sessionSecret: '',
    adminName: 'Cara',
    githubClientId: '',
    githubClientSecret: '',
    githubApp: { clientId: '', clientSecret: '', slug: '' },
    claudeBin: 'claude',
    turnUnits: false,
    turnPool: false,
    turnSupervisor: false,
    ghHelper: true,
    embedModel: 'Qwen3-Embedding-0.6B-Q8_0',
    embedUrl: 'http://127.0.0.1:21434',
    memorySchemes: undefined,
    memoryEveryMs: 60_000,
    pushSubject: undefined,
    fcmApi: undefined,
    cacheDir: join(homedir(), '.cache'),
    uploadFloor: null,
    workerForce: null,
    staticBackfillMs: 20_000,
    staticBackfillEveryMs: 900_000,
    deployLive: false,
    heldSocket: false,
    front: true,
    testSettled: false,
    readerAnswerMs: undefined,
    readerStuckMs: undefined,
    readerSweepMs: undefined,
    readerBootWait: undefined,
  });
});

test('under systemd the turn settings are on; 0 turns one off, and the supervisor follows the units', () => {
  const turns = (env: NodeJS.ProcessEnv) => {
    const c = readConfig(env);
    return [c.turnUnits, c.turnPool, c.turnSupervisor];
  };
  assert.deepEqual(turns({ INVOCATION_ID: 'x' }), [true, true, true]);
  assert.deepEqual(turns({ INVOCATION_ID: 'x', TURN_UNITS: '0' }), [false, true, false]);
  assert.deepEqual(turns({ INVOCATION_ID: 'x', TURN_POOL: '0', TURN_SUPERVISOR: '0' }), [true, false, false]);
  assert.deepEqual(turns({ TURN_UNITS: '1' }), [true, false, true]);
});

test('a preview is a boot check too, and only a preview exits when idle', () => {
  assert.equal(readConfig({ PREVIEW: '1' }).bootCheck, true);
  assert.equal(readConfig({ BOOT_CHECK: '1' }).preview, false);
  assert.equal(readConfig({ PREVIEW: '1', IDLE_EXIT_MS: '500' }).idleExitMs, 500);
  assert.equal(readConfig({ IDLE_EXIT_MS: '500' }).idleExitMs, 0);
});

test('a held socket is for this process only', () => {
  assert.equal(readConfig({ LISTEN_FDS: '1', LISTEN_PID: String(process.pid) }).heldSocket, true);
  assert.equal(readConfig({ LISTEN_FDS: '1', LISTEN_PID: '1' }).heldSocket, false);
});

test('values are trimmed, split and capped', () => {
  const c = readConfig({ APPS_DOMAIN: ' Apps.Example ', CITADEL_MEMORY_SCHEMES: '1,2', CITADEL_DB_WRITE_DELAY_MS: '99999', UPLOAD_FLOOR_GB: '2', MACHINES_URL: 'http://host:1' });
  assert.equal(c.appsDomain, 'apps.example');
  assert.deepEqual(c.memorySchemes, [1, 2]);
  assert.equal(c.dbWriteDelayMs, 1000);
  assert.equal(c.uploadFloor, 2 * 1024 ** 3);
  assert.equal(c.machinesUrl?.port, '1');
});
