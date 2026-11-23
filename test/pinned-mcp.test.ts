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
      await (await import('./src/pin-spares.ts')).fillPinSpares();
      const spares = process.env.DATA_DIR + '/run/turns/.pin-spares';
      console.log(JSON.stringify({ dir: pins.MCP_DIR, same: turnPins() === pins, tripwire: existsSync(pins.TRIPWIRE), run: readdirSync(process.env.DATA_DIR + '/run'), spares: readdirSync(spares + '/' + readdirSync(spares)[0]).length }));`));
    assert.equal(made.same, true);
    assert.equal(made.tripwire, true);
    assert.deepEqual(made.run.sort(), [made.dir.split('/').pop(), 'turns']);
    assert.equal(made.spares, 9);
    assert.ok(made.dir.startsWith(join(scratch, 'data', 'run', 'mcp-')));
    assert.deepEqual(readdirSync(join(scratch, 'data', 'run')), ['turns'], 'the copies go when their process does');
    assert.deepEqual(readdirSync(join(scratch, 'data', 'run', 'turns', '.pin-spares')), [], 'and their spares with them');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('a re-pin makes a new folder and spares for new turns, keeps the old one for running turns, and both go at exit (#1416)', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'pins-repin-'));
  try {
    const made = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { existsSync, readdirSync } from 'node:fs';
      const { pinTurnFiles, turnPins } = await import('./src/turn-launch.ts');
      const { fillPinSpares } = await import('./src/pin-spares.ts');
      const first = pinTurnFiles(process.env.DATA_DIR);
      await fillPinSpares();
      const second = pinTurnFiles(process.env.DATA_DIR);
      await fillPinSpares();
      const spares = process.env.DATA_DIR + '/run/turns/.pin-spares';
      console.log(JSON.stringify({ first: first.MCP_DIR, second: second.MCP_DIR, now: turnPins().MCP_DIR, kept: existsSync(first.TRIPWIRE), spares: readdirSync(spares).sort() }));`],
      { cwd: join(import.meta.dirname, '..'), env: { ...process.env, HOME: scratch, DATA_DIR: join(scratch, 'data') }, encoding: 'utf8' }));
    assert.notEqual(made.second, made.first);
    assert.equal(made.now, made.second, 'turns that start now take the new pins');
    assert.equal(made.kept, true, 'the old pins stay for turns already running');
    assert.match(made.second, /mcp-\d+\.1$/);
    assert.equal(made.spares.length, 1, 'the old pins\' spares go at once: nothing can take them');
    assert.deepEqual(readdirSync(join(scratch, 'data', 'run')), ['turns'], 'every pin folder goes when its process does');
  } finally {
    rmSync(scratch, { recursive: true, force: true }); // timing-ok: own temp dir
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

// #1414: even linked, a turn's copy was ~370 calls on the loop at its start, 3 to 10.8 s held with a cold disk cache.
test('a turn start takes a spare copy made off the loop: one rename, links for a host turn, bytes for a container turn', async () => {
  const { copyPinned } = await import('../src/turn-launch.ts');
  const { fillPinSpares, readySpares, SPARES } = await import('../src/pin-spares.ts');
  const { chmodSync, mkdirSync, statSync, writeFileSync } = await import('node:fs');
  const pins = testPins();
  const early = join(pins.dataDir, 'run', 'turns', '4-1', 'pin');
  mkdirSync(dirname(early), { recursive: true });
  copyPinned(pins.MCP_DIR, early, true); // before any spares: copied on the loop, and later fills still work
  assert.equal(statSync(join(early, pins.TRIPWIRE.split('/').pop()!)).ino, statSync(pins.TRIPWIRE).ino);
  await fillPinSpares();
  assert.equal(readySpares('link').length, SPARES.link);
  assert.equal(readySpares('copy').length, SPARES.copy);
  const turns = join(pins.dataDir, 'run', 'turns');
  const [hostSpare] = readySpares('link'), [boxSpare] = readySpares('copy');
  for (const spare of [hostSpare, boxSpare]) {
    assert.ok(spare.startsWith(join(turns, '.pin-spares') + '/'), 'beside the turns, on their filesystem');
    assert.doesNotMatch(spare, /person-\d+/, 'outside every container mount');
  }
  const made = { host: statSync(hostSpare).ino, box: statSync(boxSpare).ino };
  const host = join(turns, '5-1', 'pin'), box = join(turns, 'person-7', '5-2', 'pin');
  mkdirSync(dirname(host), { recursive: true });
  mkdirSync(dirname(box), { recursive: true });
  copyPinned(pins.MCP_DIR, host, true);
  copyPinned(pins.MCP_DIR, box, false);
  assert.equal(statSync(host).ino, made.host, 'the spare itself, moved: nothing copied on the loop');
  assert.equal(statSync(box).ino, made.box);
  const name = pins.TRIPWIRE.split('/').pop()!;
  assert.equal(statSync(join(host, name)).ino, statSync(pins.TRIPWIRE).ino, 'a host turn links');
  assert.notEqual(statSync(join(box, name)).ino, statSync(pins.TRIPWIRE).ino, 'a container turn never gets a link');
  chmodSync(join(box, name), 0o644);
  writeFileSync(join(box, name), 'tampered');
  assert.notEqual(readFileSync(pins.TRIPWIRE, 'utf8'), 'tampered', "a container turn can't change the server's tripwire");
  assert.notEqual(readFileSync(join(host, name), 'utf8'), 'tampered', "nor another turn's");
  await fillPinSpares();
  assert.equal(readySpares('link').length, SPARES.link, 'made again behind it');
  assert.ok(!readySpares('link').includes(hostSpare));
});

test('the pinned files are read-only, so a write through a turn\'s linked copy fails instead of reaching the server\'s', async () => {
  const { statSync } = await import('node:fs');
  const pins = testPins();
  assert.equal(statSync(pins.TRIPWIRE).mode & 0o222, 0);
});
