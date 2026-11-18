import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createConnection, createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import { bridge, editorConnected, ensureEditor, idleCheck, idleVerdict, needsEditor, settings } from '../deploy/perigee-godot/godot-on-demand.mjs';
import { until } from './wait.ts';

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
  writeFileSync(join(dir, 'systemctl'), `#!/bin/sh\necho "$*" >>'${calls}'\ncase "$*" in *' show '*) cat '${dir}/show' ;; *' stop '*) touch '${dir}/stopping'; sleep 0.3 ;; esac\n`);
  chmodSync(join(dir, 'systemctl'), 0o755);
  const cfg = settings({ GODOT_SYSTEMCTL: join(dir, 'systemctl'), GODOT_ACTIVITY: join(dir, 'last-call') });
  const used = (at: number) => (writeFileSync(cfg.activity, ''), utimesSync(cfg.activity, new Date(at), new Date(at)));
  const log = () => { try { return readFileSync(calls, 'utf8').trim().split('\n').map((l) => l.replace(/^--user /, '')); } catch { return []; } };
  return { cfg, used, log, dir };
}

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

  // Just installed, up for two weeks, never stamped: the first check starts the clock instead.
  const fresh = stub('fresh', { ActiveState: 'active', since: NOW - 14 * 24 * H });
  assert.equal(idleCheck(fresh.cfg, NOW).stop, false);
  assert.equal(statSync(fresh.cfg.activity).mtimeMs, NOW);
  assert.equal(idleCheck(fresh.cfg, NOW + 2 * H + 60_000).stop, true, 'and stops it 2 hours on');
});

test('idle-check run as the timer runs it holds the stop lock while it stops the editor', async () => {
  const s = stub('locked', { ActiveState: 'active', since: Date.now() - 3 * H });
  s.used(Date.now() - 3 * H);
  const script = join(import.meta.dirname, '..', 'deploy', 'perigee-godot', 'godot-on-demand.mjs');
  const run = spawn(process.execPath, [script, 'idle-check'], { stdio: 'ignore', env: { ...process.env, GODOT_SYSTEMCTL: s.cfg.systemctl, GODOT_ACTIVITY: s.cfg.activity, GODOT_STOP_LOCKED: '' } });
  after(() => run.exitCode === null && run.kill());
  await until("existsSync(join(s.dir, 'stopping'))", () => existsSync(join(s.dir, 'stopping')));
  const probe = spawn('flock', ['-n', '-s', join(s.dir, 'stop.lock'), 'true']);
  assert.equal(await new Promise((r) => probe.on('exit', r)), 1, 'a call would wait for this stop');
  assert.equal(await new Promise((r) => run.on('exit', r)), 0);
  assert.deepEqual(s.log().filter((l) => !l.startsWith('show')), ['stop perigee-godot.service']);
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
  const got = await ensureEditor(s.cfg, (l: string) => lines.push(l), { now: c.now, poll: 0, settle: 0, connected: () => (c.tick(500), ++polls > 41) });
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

test('a call that lands while idle-check is stopping the editor waits for the stop, then starts it again', async () => {
  const s = stub('race', { ActiveState: 'active', since: NOW - 3 * H });
  const held = join(s.dir, 'held');
  const stopped = join(s.dir, 'stopped');
  // Stands in for idle-check under its lock: it has decided, and the stop takes a moment.
  const idle = spawn('flock', ['-x', join(s.dir, 'stop.lock'), 'sh', '-c', `touch '${held}'; sleep 0.3; printf 'ActiveState=inactive\\nFreezerState=running\\n' >'${s.dir}/show'; touch '${stopped}'`], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !existsSync(held); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(existsSync(held));
  const c = clock(NOW);
  // Connected until the stop lands; after that, only once something has started the unit again.
  const connected = () => (existsSync(stopped) ? (c.tick(500), s.log().includes('start --no-block perigee-godot.service')) : true);
  assert.equal(await ensureEditor(s.cfg, () => {}, { now: c.now, poll: 0, settle: 0, connected }), 'ready');
  assert.ok(s.log().includes('start --no-block perigee-godot.service'), 'it started the editor the stop took away');
  await new Promise((r) => idle.exitCode === null ? idle.on('exit', r) : r(null));
});

// A stand-in for `godot-ai attach`: answers each request at once, a tools/call only once it hears test/release.
const fakeMcp = [process.execPath, '-e', `
const held = [];
const reply = (m) => console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { method: m.method, params: m.params } }));
let buf = '';
process.stdin.setEncoding('utf8').on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (m.method === 'test/release') held.splice(0).forEach(reply);
    else if (m.method === 'tools/call') held.push(m);
    else if (m.id !== undefined) reply(m);
  }
});`];

/** A bridge over fakeMcp, with the editor's readiness held until ready() is called. */
function fakeBridge(s: ReturnType<typeof stub>, keepEveryMs = 20, stampGapMs = 5_000) {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: any[] = [];
  let pendingOut = '';
  output.setEncoding('utf8').on('data', (d) => {
    pendingOut += d;
    let i;
    while ((i = pendingOut.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(pendingOut.slice(0, i)));
      pendingOut = pendingOut.slice(i + 1);
    }
  });
  let ready!: () => void;
  const editorUp = new Promise<void>((r) => (ready = r));
  const child = bridge(fakeMcp, s.cfg, { input, output, log: () => {}, ensure: () => editorUp, keepEveryMs, stampGapMs });
  // A failed assertion mustn't leave the fake running and the run hanging.
  after(() => child.exitCode === null && child.kill());
  const send = (m: object) => input.write(`${JSON.stringify(m)}\n`);
  const seen = (id: number) => replies.some((r) => r.id === id);
  const fresh = () => statSync(s.cfg.activity).mtimeMs > Date.now() - 10_000;
  const close = async () => {
    input.end();
    return new Promise((r) => child.on('exit', r));
  };
  return { send, seen, replies, ready, fresh, close };
}

test('bridge: the handshake goes straight through, a tool call waits for the editor, and order holds', async () => {
  const s = stub('bridge', { ActiveState: 'inactive' });
  const b = fakeBridge(s);
  s.used(NOW - 3 * H);
  b.send({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  await until('b.seen(1)', () => b.seen(1));
  // Every turn in a lent scheme opens a session: its handshake isn't use, or the editor never goes idle (#615).
  assert.equal(b.fresh(), false, 'the handshake does not count as use');
  b.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
  await until('b.seen(4)', () => b.seen(4));
  assert.equal(b.fresh(), false, 'nor does a ping');

  // U+2028 in the arguments, as script text can hold: JSON leaves it raw, and the line must stay whole.
  b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'script_patch', arguments: { text: 'a\u2028b\u2029c' } } });
  b.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.seen(3), false, 'the listing waits behind the held call, to keep the order');
  assert.ok(b.fresh(), 'a tool call counts as use');
  b.ready();
  await until('b.seen(3)', () => b.seen(3));
  assert.equal(b.seen(2), false);

  // The call is in flight (the fake holds it): the keep-alive stamps the file again after it is set back.
  s.used(NOW - 3 * H);
  await until('b.fresh', b.fresh);
  b.send({ jsonrpc: '2.0', method: 'test/release' });
  await until('b.seen(2)', () => b.seen(2));
  assert.equal(b.replies.find((r) => r.id === 2).result.params.arguments.text, 'a\u2028b\u2029c');
  // Answered: nothing in flight, so nothing stamps it any more.
  await new Promise((r) => setTimeout(r, 30));
  s.used(NOW - 3 * H);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.fresh(), false);
  assert.equal(await b.close(), 0, 'closing stdin ends the MCP server too');
});

test('bridge: a call the client cancelled stops keeping the editor up', async () => {
  const s = stub('cancel', { ActiveState: 'active' });
  const b = fakeBridge(s);
  b.ready();
  b.send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'project_run' } });
  s.used(NOW - 3 * H);
  await until('b.fresh', b.fresh);
  b.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
  await new Promise((r) => setTimeout(r, 30));
  s.used(NOW - 3 * H);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(b.fresh(), false);
  assert.equal(await b.close(), 0);
});

test('bridge: a tool call and its answer each count as use, with no keep-alive to cover them', async () => {
  const s = stub('stamps', { ActiveState: 'active' });
  const b = fakeBridge(s, 3600_000, 300);
  b.ready();
  s.used(NOW - 3 * H);
  b.send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'editor_state' } });
  await until('b.fresh', b.fresh);
  // Past the stamp throttle (300 ms here, 5 s live), as an answer after a long call is.
  await new Promise((r) => setTimeout(r, 400));
  s.used(NOW - 3 * H);
  b.send({ jsonrpc: '2.0', method: 'test/release' });
  await until('b.seen(8)', () => b.seen(8));
  assert.ok(b.fresh(), 'the answer counts as use');
  assert.equal(await b.close(), 0);
});
