// The app's half of a lent machine (src/machines.ts MachineRelay), with the agent's and the proxies' streams faked:
// what each side is told when the other goes away.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, mock, test } from 'node:test';
import { Store } from '../src/db.ts';
import { cleanLend, MachineRelay } from '../src/machines.ts';

/** An event stream: what the app writes to it, parsed, and whether it was ended. */
function stream() {
  const res = new EventEmitter() as EventEmitter & ServerResponse & { sent: any[]; ended: boolean };
  res.sent = [];
  res.ended = false;
  Object.assign(res, {
    writableLength: 0,
    writeHead() {},
    write(chunk: string) {
      if (res.ended) throw new Error('write after end');
      for (const line of String(chunk).split('\n')) if (line.startsWith('data: ')) res.sent.push(JSON.parse(line.slice(6)));
      return true;
    },
    end() {
      if (res.ended) return;
      res.ended = true;
      res.emit('close');
    },
  });
  return res;
}

const relays: { relay: MachineRelay; store: Store }[] = [];
afterEach(() => {
  for (const { relay, store } of relays.splice(0)) for (const m of store.listMachines()) relay.disconnect(m.id);
});

function world() {
  const store = new Store(':memory:');
  const relay = new MachineRelay(store, () => {});
  relays.push({ relay, store });
  const box = store.createMachine('box', 'x', 'Cara');
  return { store, relay, box };
}

test('when a machine\'s MCP server exits, its proxy is told so before its stream ends, so it does not reconnect', () => {
  const { relay, box } = world();
  relay.connectAgent(box, stream(), { host: 'h', command: 'fake-mcp' });
  const proxy = stream();
  assert.equal(relay.openSession(box.id, { ticketId: 1, projectId: 1 }, 'mcp', '#1', proxy), true);
  const session = proxy.sent[0].session;
  assert.equal(relay.fromAgent(box, session, { closed: true }), true);
  assert.equal(proxy.ended, true);
  assert.deepEqual(proxy.sent.at(-1), { closed: true });
});

test('when the agent goes away, its proxies\' streams just end: they reconnect once it is back', () => {
  const { relay, box } = world();
  relay.connectAgent(box, stream(), { host: 'h', command: 'fake-mcp' });
  const proxy = stream();
  relay.openSession(box.id, { ticketId: 1, projectId: 1 }, 'mcp', '#1', proxy);
  relay.disconnect(box.id);
  assert.equal(proxy.ended, true);
  assert.deepEqual(proxy.sent.map((m) => Object.keys(m)), [['session']]);
});

test('an agent that beats and then goes quiet (a laptop asleep) is dropped within a couple of minutes; one that never beats is kept', () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  try {
    const { relay, store, box } = world();
    const old = store.createMachine('old', 'y', 'Cara');
    relay.connectAgent(box, stream(), { host: 'h', command: 'fake-mcp' });
    relay.connectAgent(old, stream(), { host: 'h', command: 'fake-mcp' });
    assert.equal(relay.beat(box), true);
    for (let i = 0; i < 4; i++) {
      mock.timers.tick(20_000);
      relay.beat(box);
    }
    assert.equal(relay.isOnline(box.id), true, 'beating: online');
    mock.timers.tick(2 * 60_000);
    assert.equal(relay.isOnline(box.id), false, 'no beat for two minutes: offline');
    assert.equal(relay.isOnline(old.id), true, 'an agent from before beats is never dropped for missing them');
    assert.equal(relay.beat(box), false, 'a beat from a dropped agent says so');
  } finally {
    mock.timers.reset();
  }
});

test('a second agent with the same token takes over, and the first is told so before its stream ends', () => {
  const { relay, box } = world();
  const first = stream();
  relay.connectAgent(box, first, { host: 'laptop', command: 'fake-mcp' });
  relay.connectAgent(box, stream(), { host: 'desktop', command: 'fake-mcp' });
  assert.equal(first.ended, true);
  assert.deepEqual(first.sent.at(-1), { replaced: true, by: 'desktop' });
  assert.equal(relay.isOnline(box.id), true);
});

test('the GPU jobs switch (#1175): off, run-gpu is refused before it reaches the machine and a running one is stopped', async () => {
  const { relay, box } = world();
  const agent = stream();
  relay.connectAgent(box, agent, { host: 'h', command: '', managed: true });
  relay.setInfo(box, { v: 2, workspaces: [{ name: 'w', tasks: [{ name: 'run-gpu', run: ['gpu.ps1'] }, { name: 'run', run: ['run.ps1'] }] }] });
  relay.setLend(box.id, { server: null, workspaces: ['w'] });
  const proxy = stream();
  assert.equal(relay.openSession(box.id, { ticketId: 1, projectId: 1 }, 'ws', '#1', proxy), true);
  const session = proxy.sent[0].session;
  const task = (id: number, name: string) => relay.fromSession(session, { ticketId: 1, projectId: 1 }, { jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'run_task', arguments: { workspace: 'w', task: name } } });
  const reached = (id: number) => agent.sent.some((m) => m.session === session && m.message?.id === id);

  // On: it goes through, and the machine's answer that it outlasted the wait names the job.
  task(5, 'run-gpu');
  assert.ok(reached(5));
  relay.fromAgent(box, session, { message: { jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: 'run-gpu in w is still running after 50 s (job ab12cd34). Call job with id "ab12cd34" to wait for it.' }] } } });
  assert.equal(proxy.sent.at(-1).message.id, 5, 'the answer still reaches the turn');

  // Off: Citadel opens a session of its own and stops that job.
  const seen = agent.sent.length;
  relay.setLend(box.id, { server: null, workspaces: ['w'], gpu_off: true });
  const init = agent.sent.slice(seen).find((m) => m.message?.method === 'initialize');
  assert.equal(init.who, 'the GPU jobs switch on the Machines page');
  relay.fromAgent(box, init.session, { message: { jsonrpc: '2.0', id: init.message.id, result: {} } });
  await new Promise((r) => setImmediate(r));
  const stop = agent.sent.find((m) => m.session === init.session && m.message?.method === 'tools/call');
  assert.deepEqual(stop.message.params, { name: 'stop_job', arguments: { id: 'ab12cd34' } });

  // While off, run-gpu is answered with an error at once; other tasks go on.
  task(6, 'run-gpu');
  assert.equal(reached(6), false);
  const refusal = proxy.sent.at(-1).message;
  assert.equal(refusal.id, 6);
  assert.equal(refusal.result.isError, true);
  assert.match(refusal.result.content[0].text, /GPU jobs are switched off for box/);
  task(7, 'run');
  assert.ok(reached(7));

  // A job that outlasts its call's wait after the switch went off is stopped once its id comes back.
  relay.setLend(box.id, { server: null, workspaces: ['w'] });
  task(8, 'run-gpu');
  relay.setLend(box.id, { server: null, workspaces: ['w'], gpu_off: true });
  const late = agent.sent.length;
  relay.fromAgent(box, session, { message: { jsonrpc: '2.0', id: 8, result: { content: [{ type: 'text', text: 'run-gpu in w is still running after 50 s (job 99ff0011).' }] } } });
  assert.ok(agent.sent.slice(late).some((m) => m.message?.method === 'initialize' && m.who === 'the GPU jobs switch on the Machines page'));
});

test('a lend keeps gpu_off only when it is true', () => {
  assert.deepEqual(cleanLend({ server: null, workspaces: [], gpu_off: true }), { server: null, workspaces: [], gpu_off: true });
  assert.deepEqual(cleanLend({ server: null, workspaces: [], gpu_off: 'yes' }), { server: null, workspaces: [] });
});
