import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { testPins } from './helpers.ts';

const { MACHINE_MCP_SERVER, MCP_SERVER } = testPins();

// Turns run copies of the MCP servers from the data dir; a local import that isn't copied
// with them makes every session's MCP server die on start (CONNECTION_CLOSED).

test('the pinned mcp.ts starts from its pinned dir and answers initialize', async () => {
  const child = spawn(process.execPath, [MCP_SERVER], {
    cwd: dirname(MCP_SERVER),
    env: { ...process.env, COORDINATOR_ROLE: 'thread', COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const reply = new Promise<any>((resolve, reject) => {
    createInterface({ input: child.stdout }).once('line', (line) => resolve(JSON.parse(line)));
    child.once('exit', (code) => reject(new Error(`mcp.ts exited (${code}): ${stderr}`)));
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n');
  try {
    const msg = await reply;
    assert.equal(msg.id, 1);
    assert.equal(msg.result.serverInfo.name, 'coordinator');
  } finally {
    child.kill();
  }
});

test('every local import of a pinned server is pinned beside it', () => {
  const pinned = new Set(readdirSync(dirname(MCP_SERVER)));
  for (const server of [MCP_SERVER, MACHINE_MCP_SERVER]) {
    for (const [, file] of readFileSync(server, 'utf8').matchAll(/from '\.\/([^']+)'/g)) {
      assert.ok(pinned.has(file), `${server} imports ./${file}, which runner.ts doesn't pin`);
    }
    // The pins sit flat in one folder, so an import up and out of src/ (../public/x.js) can't be pinned (#1043).
    for (const [, file] of readFileSync(server, 'utf8').matchAll(/from '(\.\.\/[^']+)'/g)) assert.fail(`${server} imports ${file}, outside the pinned folder`);
  }
});

test('importing the runner writes nothing; the pins are made by one call and swept when the process exits', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pins-import-'));
  try {
    const run = (code: string) => execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, HOME: scratch, DATA_DIR: join(scratch, 'data') }, encoding: 'utf8' });
    const before = run(`
      const { turnPins, tripwireHooks } = await import('./src/turn-launch.ts');
      await import('./src/runner.ts');
      const said = (f) => { try { f(); return 'no error'; } catch (e) { return e.message; } };
      console.log(JSON.stringify([said(turnPins), said(() => tripwireHooks(1, '/c'))]));`);
    for (const said of JSON.parse(before)) assert.match(said, /pinTurnFiles/, 'a launch without pins fails by name, not with a missing tripwire');
    assert.deepEqual(readdirSync(scratch), [], 'no data dir, no run folder, nothing under HOME');
    const made = JSON.parse(run(`
      import { existsSync, readdirSync } from 'node:fs';
      const { pinTurnFiles, turnPins } = await import('./src/turn-launch.ts');
      const pins = pinTurnFiles(process.env.DATA_DIR);
      console.log(JSON.stringify({ dir: pins.MCP_DIR, same: turnPins() === pins, tripwire: existsSync(pins.TRIPWIRE), run: readdirSync(process.env.DATA_DIR + '/run') }));`));
    assert.equal(made.same, true);
    assert.equal(made.tripwire, true);
    assert.equal(made.run.length, 1);
    assert.ok(made.dir.startsWith(join(scratch, 'data', 'run', 'mcp-')));
    assert.deepEqual(readdirSync(join(scratch, 'data', 'run')), [], 'the copies go when their process does');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a turn\'s pin copy links the files instead of copying their bytes, so a launch is not a 7 s stall', async () => {
  const { copyPinned } = await import('../src/turn-launch.ts');
  const { mkdirSync, mkdtempSync: mk, statSync, writeFileSync } = await import('node:fs');
  const d = mk(join(tmpdir(), 'pincopy-'));
  try {
    mkdirSync(join(d, 'src', 'sub'), { recursive: true });
    writeFileSync(join(d, 'src', 'sub', 'a.txt'), 'hello');
    copyPinned(join(d, 'src'), join(d, 'dst'));
    assert.equal(readFileSync(join(d, 'dst', 'sub', 'a.txt'), 'utf8'), 'hello');
    assert.equal(statSync(join(d, 'dst', 'sub', 'a.txt')).ino, statSync(join(d, 'src', 'sub', 'a.txt')).ino);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
