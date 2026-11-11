import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { bridge, editorConnected, ensureEditor, idleCheck, idleVerdict, needsEditor, settings } from '../deploy/perigee-godot/godot-on-demand.mjs';

// deploy/perigee-godot/godot-on-demand.mjs (#505): the Godot editor starts on the first tool call and stops
// after 2 hours unused. Against a stub systemctl, a fake activity file and a fake clock.
const root = mkdtempSync(join(tmpdir(), 'perigee-godot-'));
after(() => rmSync(root, { recursive: true, force: true }));
const H = 3600_000;
const NOW = Date.parse('2026-11-10T12:00:00Z');

/** A stub systemctl that logs its arguments and answers `show` with the given unit state. */
function stub(name: string, unit: { ActiveState: string; FreezerState?: string; since?: number }) {
  const dir = mkdtempSync(join(root, `${name}-`));
  const calls = join(dir, 'calls');
  writeFileSync(join(dir, 'show'), `ActiveState=${unit.ActiveState}\nFreezerState=${unit.FreezerState ?? 'running'}\nInactiveExitTimestamp=${unit.since ? `@${Math.floor(unit.since / 1000)}` : ''}\n`);
  writeFileSync(join(dir, 'systemctl'), `#!/bin/sh\necho "$*" >>'${calls}'\ncase "$*" in *' show '*) cat '${dir}/show' ;; esac\n`);
  chmodSync(join(dir, 'systemctl'), 0o755);
  const cfg = settings({ GODOT_SYSTEMCTL: join(dir, 'systemctl'), GODOT_ACTIVITY: join(dir, 'last-call') });
  const used = (at: number) => (writeFileSync(cfg.activity, ''), utimesSync(cfg.activity, new Date(at), new Date(at)));
  const log = () => { try { return readFileSync(calls, 'utf8').trim().split('\n').map((l) => l.replace(/^--user /, '')); } catch { return []; } };
  return { cfg, used, log };
}

test('defaults: the perigee-godot unit, 2 hours idle, ws port 9500', () => {
  const cfg = settings({});
  assert.equal(cfg.unit, 'perigee-godot.service');
  assert.equal(cfg.idleS, 7200);
  assert.equal(cfg.wsPort, 9500);
});

test('idleVerdict: stops only an active, unfrozen unit with neither a call nor its start in the last 2 hours', () => {
  const v = (unit: object, last: number) => idleVerdict({ now: NOW, unit: { state: 'active', frozen: false, since: NOW - 10 * H, ...unit }, last, idleS: 7200 }).stop;
  assert.equal(v({}, NOW - 2 * H - 1000), true);
  assert.equal(v({}, NOW - 2 * H + 60_000), false, 'a call 119 minutes ago keeps it');
  assert.equal(v({}, 0), true, 'never called and up for 10 hours');
  assert.equal(v({ since: NOW - 30 * 60_000 }, 0), false, 'started 30 minutes ago, by hand or for a call');
  assert.equal(v({ frozen: true }, 0), false, 'a person froze it');
  assert.equal(v({ state: 'inactive' }, 0), false);
  assert.equal(v({ state: 'activating' }, 0), false);
});

test('idle-check stops the unit after 2 hours unused, and leaves a used or frozen one alone', () => {
  const idle = stub('idle', { ActiveState: 'active', since: NOW - 3 * H });
  idle.used(NOW - 2 * H - 5 * 60_000);
  assert.equal(idleCheck(idle.cfg, NOW).stop, true);
  assert.deepEqual(idle.log().filter((l) => !l.startsWith('show')), ['stop perigee-godot.service']);

  const busy = stub('busy', { ActiveState: 'active', since: NOW - 3 * H });
  busy.used(NOW - 90 * 60_000);
  assert.equal(idleCheck(busy.cfg, NOW).stop, false);
  assert.deepEqual(busy.log().filter((l) => !l.startsWith('show')), []);

  const frozen = stub('frozen', { ActiveState: 'active', FreezerState: 'frozen', since: NOW - 14 * 24 * H });
  assert.equal(idleCheck(frozen.cfg, NOW).stop, false);
  assert.deepEqual(frozen.log().filter((l) => !l.startsWith('show')), []);
});

test('needsEditor: tool calls wait for the editor, the handshake and listings do not', () => {
  assert.equal(needsEditor({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'scene_get' } }), true);
  assert.equal(needsEditor({ jsonrpc: '2.0', id: 4, method: 'resources/read' }), true);
  assert.equal(needsEditor({ jsonrpc: '2.0', id: 0, method: 'initialize' }), false);
  assert.equal(needsEditor({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), false);
  assert.equal(needsEditor({ jsonrpc: '2.0', method: 'notifications/initialized' }), false);
  assert.equal(needsEditor({ jsonrpc: '2.0', id: 1, result: {} }), false, 'a reply to the server');
  assert.equal(needsEditor(null), false);
});

test('editorConnected: an established connection on the ws port, from /proc/net/tcp', async () => {
  const file = join(root, 'tcp');
  const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  writeFileSync(file, `${head}   0: 0100007F:251C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1002        0 1 1\n`);
  assert.equal(editorConnected(9500, [file]), false, 'listening only');
  writeFileSync(file, `${head}   0: 0100007F:251C 00000000:0000 0A 0\n   1: 0100007F:251C 0100007F:9C40 01 0\n`);
  assert.equal(editorConnected(9500, [file]), true);
  assert.equal(editorConnected(9501, [file]), false);

  // And the real thing: a server on a free port, then a client dialling in.
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  assert.equal(editorConnected(port), false);
  const client: Socket = await new Promise((r) => { const c = createConnection(port, '127.0.0.1', () => r(c)); });
  assert.equal(editorConnected(port), true);
  client.destroy();
  await new Promise((r) => server.close(r));
});

/** A fake clock that moves on as ensureEditor sleeps. */
function clock(start: number) {
  let t = start;
  return { now: () => t, tick: (ms: number) => (t += ms) };
}

test('ensureEditor starts a stopped unit and waits until the editor connects', async () => {
  const s = stub('start', { ActiveState: 'inactive' });
  const c = clock(NOW);
  let polls = 0;
  const lines: string[] = [];
  // Connects on the 40th poll: 20 s in at 500 ms a poll.
  const got = await ensureEditor(s.cfg, (l: string) => lines.push(l), { now: c.now, poll: 0, connected: () => (c.tick(500), ++polls > 41) });
  assert.equal(got, 'ready');
  assert.deepEqual(s.log().filter((l) => !l.startsWith('show')), ['start --no-block perigee-godot.service']);
  assert.match(lines.at(-1)!, /connected 2\d s after/);
});

test('ensureEditor gives up after the ready limit and passes the call on', async () => {
  const s = stub('slow', { ActiveState: 'inactive' });
  const c = clock(NOW);
  const got = await ensureEditor(s.cfg, () => {}, { now: c.now, poll: 0, connected: () => (c.tick(1000), false) });
  assert.equal(got, 'timeout');
  assert.ok(c.now() - NOW <= 182_000, 'waited no longer than GODOT_READY_S');
});

test('ensureEditor neither starts nor waits on a frozen unit, or on one up long ago that never connected', async () => {
  const frozen = stub('frozen2', { ActiveState: 'active', FreezerState: 'frozen', since: NOW - 3 * H });
  assert.equal(await ensureEditor(frozen.cfg, () => {}, { now: () => NOW, connected: () => false }), 'frozen');
  assert.deepEqual(frozen.log().filter((l) => !l.startsWith('show')), []);
  const stale = stub('stale', { ActiveState: 'active', since: NOW - 3 * H });
  assert.equal(await ensureEditor(stale.cfg, () => {}, { now: () => NOW, connected: () => false }), 'not-connected');
  assert.deepEqual(stale.log().filter((l) => !l.startsWith('show')), []);
  // Already connected: not even a systemctl call.
  const up = stub('up', { ActiveState: 'active', since: NOW - 3 * H });
  assert.equal(await ensureEditor(up.cfg, () => {}, { connected: () => true }), 'ready');
  assert.deepEqual(up.log(), []);
});

// A stand-in for `godot-ai attach`: answers each request, a tools/call after 300 ms.
const fakeMcp = [process.execPath, '-e', `
require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  setTimeout(() => console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { method: m.method } })), m.method === 'tools/call' ? 300 : 0);
});`];

test('bridge: the handshake goes straight through, a tool call waits for the editor, and order holds', async () => {
  const s = stub('bridge', { ActiveState: 'inactive' });
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: string[] = [];
  output.on('data', (d) => replies.push(...String(d).trim().split('\n')));
  let release!: () => void;
  const editorUp = new Promise<void>((r) => (release = r));
  const child = bridge(fakeMcp, s.cfg, { input, output, log: () => {}, ensure: () => editorUp, keepEveryMs: 50 });
  const send = (m: object) => input.write(`${JSON.stringify(m)}\n`);
  const seen = (id: number) => replies.some((r) => JSON.parse(r).id === id);
  const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(ok()); };

  s.used(NOW - 3 * H);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  await until(() => seen(1));
  assert.ok(statSync(s.cfg.activity).mtimeMs > Date.now() - 10_000, 'the handshake counts as use');

  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'scene_get' } });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(seen(2) || seen(3), false, 'held behind the editor, the listing too, to keep the order');
  release();
  // While the tool call runs (300 ms), the keep-alive stamps the file again even after it is set back.
  await new Promise((r) => setTimeout(r, 60));
  s.used(NOW - 3 * H);
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(statSync(s.cfg.activity).mtimeMs > Date.now() - 10_000, 'a call in flight is use');
  await until(() => seen(2) && seen(3));
  assert.deepEqual(replies.map((r) => JSON.parse(r).id), [1, 3, 2], 'the listing answered first only because the server is quicker at it');

  input.end();
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 0, 'closing stdin ends the MCP server too');
});
