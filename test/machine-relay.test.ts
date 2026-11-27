// The app's half of a lent machine (src/machines.ts MachineRelay), with the agent's and the proxies' streams faked:
// what each side is told when the other goes away.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { after, afterEach, mock, test } from 'node:test';
import { cleanShips, LinuxSqueeze } from '../public/runner-agent.mjs';
import { shipsOn } from '../src/ci-ships.ts';
import { Store } from '../src/db.ts';
import { cleanLend, MachineRelay } from '../src/machines.ts';
import { tempRoot } from './helpers.ts';

const scratch = tempRoot('machine-relay-');
after(() => scratch.teardown());

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

test("when a machine's MCP server exits, its proxy is told so before its stream ends, so it does not reconnect", () => {
  const { relay, box } = world();
  relay.connectAgent(box, stream(), { host: 'h', command: 'fake-mcp' });
  const proxy = stream();
  assert.equal(relay.openSession(box.id, { ticketId: 1, projectId: 1 }, 'mcp', '#1', proxy), true);
  const session = proxy.sent[0].session;
  assert.equal(relay.fromAgent(box, session, { closed: true }), true);
  assert.equal(proxy.ended, true);
  assert.deepEqual(proxy.sent.at(-1), { closed: true });
});

test("when the agent goes away, its proxies' streams just end: they reconnect once it is back", () => {
  const { relay, box } = world();
  relay.connectAgent(box, stream(), { host: 'h', command: 'fake-mcp' });
  const proxy = stream();
  relay.openSession(box.id, { ticketId: 1, projectId: 1 }, 'mcp', '#1', proxy);
  relay.disconnect(box.id);
  assert.equal(proxy.ended, true);
  assert.deepEqual(
    proxy.sent.map((m) => Object.keys(m)),
    [['session']],
  );
});

test('a managed machine names the MCP server it lends, to a starting turn and on the session it opens (2MA6)', () => {
  const { relay, store, box } = world();
  relay.connectAgent(box, stream(), { host: 'h', command: '', managed: true });
  relay.setInfo(store.getMachine(box.id)!, { v: 2, found: [{ name: 'blender' }, { name: 'godot-ai' }] });
  const opened = () => {
    const proxy = stream();
    assert.equal(relay.openSession(box.id, { ticketId: 1, projectId: 1 }, 'mcp', '#1', proxy), true);
    return [relay.online()[0].lent, proxy.sent[0].lent];
  };
  relay.setLend(box.id, { server: 'blender', workspaces: [] });
  assert.deepEqual(opened(), ['blender', 'blender']);
  relay.setLend(box.id, { server: 'godot-ai', workspaces: [] });
  assert.deepEqual(opened(), ['godot-ai', 'godot-ai']);
});

test('with its jobs block broken, a machine still hears of a job it lists, and of no other (2MA10)', () => {
  const { relay, store, box } = world();
  const agent = stream();
  relay.connectAgent(box, agent, { host: 'h', command: '', managed: true });
  relay.setInfo(store.getMachine(box.id)!, { v: 2, known_jobs: [{ id: 5, state: 'running' }] });
  assert.equal(relay.sendJob(box.id, { type: 'job.stop', id: 5 }), true);
  assert.deepEqual(agent.sent.at(-1), { job: { type: 'job.stop', id: 5 } });
  assert.equal(relay.sendJob(box.id, { type: 'job.stop', id: 6 }), false);
  relay.setInfo(store.getMachine(box.id)!, { v: 2 });
  assert.equal(relay.sendJob(box.id, { type: 'job.stop', id: 5 }), false, 'it named none: Citadel ends the job itself');
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
  const { relay, box, store } = world();
  const scheme = store.createProject('scheme', null, null); // id 1, the session's: its GPU jobs role lends it run-gpu (M1)
  store.setMachineProjects(box.id, [scheme.id]);
  const agent = stream();
  relay.connectAgent(box, agent, { host: 'h', command: '', managed: true });
  relay.setInfo(box, {
    v: 2,
    workspaces: [
      {
        name: 'w',
        tasks: [
          { name: 'run-gpu', run: ['gpu.ps1'] },
          { name: 'run', run: ['run.ps1'] },
        ],
      },
    ],
  });
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
  // GPU jobs on again but lent to no scheme of this session's (M1): refused the same way.
  relay.setLend(box.id, { server: null, workspaces: ['w'] });
  store.setMachineRole(box.id, 'gpu', { projects: [] });
  task(8, 'run-gpu');
  assert.equal(reached(8), false);
  assert.match(proxy.sent.at(-1).message.result.content[0].text, /not lent to this scheme/);
  relay.setLend(box.id, { server: null, workspaces: ['w'], gpu_off: true });

  // A job that outlasts its call's wait after the switch went off is stopped once its id comes back.
  relay.setLend(box.id, { server: null, workspaces: ['w'] });
  task(8, 'run-gpu');
  relay.setLend(box.id, { server: null, workspaces: ['w'], gpu_off: true });
  const late = agent.sent.length;
  relay.fromAgent(box, session, { message: { jsonrpc: '2.0', id: 8, result: { content: [{ type: 'text', text: 'run-gpu in w is still running after 50 s (job 99ff0011).' }] } } });
  assert.ok(agent.sent.slice(late).some((m) => m.message?.method === 'initialize' && m.who === 'the GPU jobs switch on the Machines page'));

  // So is one still waiting in the screen's line (#1422): the switch is checked before it joins, and stops it there too.
  relay.setLend(box.id, { server: null, workspaces: ['w'] });
  task(9, 'run-gpu');
  relay.setLend(box.id, { server: null, workspaces: ['w'], gpu_off: true });
  const queued = agent.sent.length;
  relay.fromAgent(box, session, { message: { jsonrpc: '2.0', id: 9, result: { content: [{ type: 'text', text: 'run-gpu in w is waiting in line for the screen (job 77aa0011), 50 s so far: desktop CI job for GitHub Actions has the screen; it is next, 1 in line.' }] } } });
  const stopper = agent.sent.slice(queued).find((m) => m.message?.method === 'initialize' && m.who === 'the GPU jobs switch on the Machines page');
  relay.fromAgent(box, stopper.session, { message: { jsonrpc: '2.0', id: stopper.message.id, result: {} } });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(agent.sent.find((m) => m.session === stopper.session && m.message?.method === 'tools/call').message.params, { name: 'stop_job', arguments: { id: '77aa0011' } });
});

test("a test box's beats carry who has its screen and who waits (#1422), cut to size, to the Machines page", () => {
  const { relay, box } = world();
  relay.connectAgent(box, stream(), { host: 'h', command: 'fake-mcp' });
  assert.equal(relay.view(box).screen, null, 'nothing said yet');
  const changes: number[] = [];
  Object.assign(relay, { onChange: () => changes.push(1) });
  relay.beat(box, { holder: { what: 'desktop CI job build, run 1', who: 'GitHub Actions (caraminden/peek-auras)', since: 5 }, line: [{ what: 'task run in peek', who: 'Peek Auras #777 (Cara)', since: 6 }, ...Array(60).fill({ what: 'x'.repeat(300), who: 'y', since: 7 })] });
  const screen = relay.view(box).screen!;
  assert.equal(screen.holder!.who, 'GitHub Actions (caraminden/peek-auras)');
  assert.equal(screen.line[0].who, 'Peek Auras #777 (Cara)');
  assert.equal(screen.line.length, 50);
  assert.equal(screen.line[1].what.length, 200);
  relay.beat(box, { holder: { what: 'desktop CI job build, run 1', who: 'GitHub Actions (caraminden/peek-auras)', since: 5 }, line: screen.line });
  assert.equal(changes.length, 1, 'an unchanged screen redraws nothing');
  relay.beat(box, { holder: 'x', line: [5, null] });
  assert.deepEqual(relay.view(box).screen, { holder: null, line: [] });
  relay.beat(box);
  assert.equal(relay.view(box).screen, null, 'a beat that says nothing (an older agent) clears it');
});

test('a lend keeps gpu_off only when it is true', () => {
  assert.deepEqual(cleanLend({ server: null, workspaces: [], gpu_off: true }), { server: null, workspaces: [], gpu_off: true });
  assert.deepEqual(cleanLend({ server: null, workspaces: [], gpu_off: 'yes' }), { server: null, workspaces: [] });
});

test('a machine is testing a ship while one runs on its PC, its WSL distro included (Build 7 T4)', () => {
  const { store, relay } = world();
  const ids = ['pc', 'PC-Ubuntu-24', 'laptop'].map((host, i) => {
    const m = store.createMachine(`m${i}`, `h${i}`, 'Cara');
    relay.connectAgent(m, stream(), { host, command: 'worker' });
    return m.id;
  });
  relay.sendShips((host) => (host.toLowerCase() === 'pc' ? [{ repo: 'a/b', runner: 'PC' }] : []));
  assert.deepEqual(
    [...ids, 999].map((id) => relay.shipsThere(id)),
    [true, true, false, false],
  );
});

test('ships (#1268) go to every runner agent at each look, and to one that connects while a ship runs, never to a lent machine', () => {
  const { store, relay, box } = world();
  const win = store.createMachine('win-runners', 'y', 'Cara');
  const wsl = store.createMachine('wsl-runners', 'z', 'Cara');
  const lent = stream();
  const windows = stream();
  relay.connectAgent(box, lent, { host: 'h', command: 'fake-mcp' });
  relay.connectAgent(win, windows, { host: 'pc', command: 'citadel runner agent', runners: true, os: 'windows' });
  const ships = [{ repo: 'caraminden/peek-auras', runner: 'DESKTOP-G248IJ8' }];
  relay.sendShips(() => ships);
  const linux = stream();
  relay.connectAgent(wsl, linux, { host: 'wsl', command: 'citadel runner agent', runners: true, os: 'linux' });
  relay.sendShips(() => []);
  assert.deepEqual(
    windows.sent.filter((m) => m.ships),
    [{ ships }, { ships: [] }],
  );
  assert.deepEqual(
    linux.sent.filter((m) => m.ships),
    [{ ships }, { ships: [] }],
  );
  assert.ok(!lent.sent.some((m) => m.ships));
});

test('a ship squeezes only the PC it runs on (#1934): two agents on two PCs, each told of its own ships, the other lifted', async () => {
  const { store, relay } = world();
  const ship = { repo: 'caraminden/claude-coordinator', runner: 'DESK-linux' };
  const quotas: Record<string, string[]> = {};
  /** A fake Linux agent: one runner on a ship's job name, one other; what Citadel's list makes it set. */
  const agent = (host: string) => {
    const units = mkdtempSync(join(scratch.dir, 'ships-'));
    for (const n of ['a', 'b']) writeFileSync(join(units, `citadel-runner-${n}.service`), `ExecStart=/bin/bash /opt/${n}/bin/runsvc.sh\n`);
    const runner = { a: { repo: 'caraminden/claude-coordinator', name: `${host}-linux` }, b: { repo: 'caraminden/peek-auras', name: `${host}-linux` } } as Record<string, { repo: string; name: string }>;
    const squeeze = new LinuxSqueeze({
      units,
      cores: 10,
      identity: (dir: string) => runner[dir.slice(-1)],
      procs: () => [],
      run: async ({ args }: { args: string[] }) => ((quotas[host] ??= []).push(`${args[2]} ${args[3]}`), { code: 0, output: '' }),
    });
    const out = stream();
    relay.connectAgent(store.createMachine(`${host}-runners`, host, 'Cara'), out, { host, command: 'citadel runner agent', runners: true, os: 'linux' });
    return { out, act: () => squeeze.update(cleanShips(out.sent.filter((m) => m.ships).at(-1)!.ships)) };
  };
  const desk = agent('DESK');
  const second = agent('LAPTOP');
  const pcs = new Map([
    ['desk', new Set<string>()],
    ['laptop', new Set<string>()],
  ]);
  relay.sendShips((host) => shipsOn(host, [ship], pcs));
  await desk.act();
  await second.act();
  assert.deepEqual(quotas.DESK.sort(), ['citadel-runner-a.service CPUQuota=', 'citadel-runner-b.service CPUQuota=300%']);
  assert.deepEqual(quotas.LAPTOP.sort(), ['citadel-runner-a.service CPUQuota=', 'citadel-runner-b.service CPUQuota='], "the second PC's runners keep full speed");
  // One that connects while the ship runs gets only its own PC's list too.
  const wsl = stream();
  relay.connectAgent(store.createMachine('desk-wsl', 'w', 'Cara'), wsl, { host: 'Desk', command: 'citadel runner agent', runners: true, os: 'linux' });
  const third = stream();
  relay.connectAgent(store.createMachine('third', 't', 'Cara'), third, { host: 'THIRD', command: 'citadel runner agent', runners: true, os: 'linux' });
  assert.deepEqual(
    wsl.sent.filter((m) => m.ships),
    [{ ships: [ship] }],
    "the same PC's other agent (WSL beside Windows) squeezes too",
  );
  assert.ok(!third.sent.some((m) => m.ships));
});

/** A test box lending workspace w to a minion's turn, with Citadel following its jobs (#1425): what each side was told. */
function followed() {
  const { store, relay, box } = world();
  const owner = store.createProject('Peek', null, null);
  const minion = store.createTicket({ project_id: owner.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setMachineProjects(box.id, [owner.id]);
  const agent = stream();
  relay.connectAgent(box, agent, { host: 'h', command: '', managed: true });
  relay.setInfo(box, { v: 2, workspaces: [{ name: 'w', tasks: [{ name: 'run', run: ['run.ps1'] }] }] });
  relay.setLend(box.id, { server: null, workspaces: ['w'] });
  const wakes: { id: number; text: string }[] = [];
  relay.watchBoxes((id, text) => wakes.push({ id, text }));
  const holder = { ticketId: minion.id, projectId: owner.id };
  const proxy = stream();
  relay.openSession(box.id, holder, 'ws', '#1', proxy);
  const session = proxy.sent[0].session;
  const say = (s: string, id: number, text: string) => relay.fromAgent(box, s, { message: { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } } });
  /** The minion calls a tool and the box answers. */
  const minionCalls = (id: number, name: string, args: object, text: string) => {
    relay.fromSession(session, holder, { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
    say(session, id, text);
    return proxy.sent.at(-1).message.result.content[0].text as string;
  };
  /** Citadel's own sessions on the box, by who opened them. */
  const opened = (who: RegExp) => agent.sent.filter((m) => m.message?.method === 'initialize' && who.test(m.who));
  /** The box answers Citadel's session's last call, then lets it make its next. */
  const answer = async (s: string, text: string | null) => {
    const last = agent.sent.filter((m) => m.session === s && m.message?.id).at(-1).message;
    if (text === null) relay.fromAgent(box, s, { message: { jsonrpc: '2.0', id: last.id, result: {} } });
    else say(s, last.id, text);
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    return agent.sent.filter((m) => m.session === s && m.message?.id).at(-1).message;
  };
  return { store, relay, box, owner, minion, agent, proxy, wakes, minionCalls, opened, answer };
}

const QUEUED = 'run in w is waiting in line for the screen (job ab12cd34), 50 s so far: desktop CI job for GitHub Actions has the screen; it is next, 1 in line. Nothing has started yet.';
const RUNNING = 'run in w is still running after 3 s (job ab12cd34). Call job with id "ab12cd34" to wait for it.';
const ENDED = 'run in w FAILED (exit 2) after 40 s. Job ab12cd34; full log on that computer: C:\\jobs\\ab12cd34.log\n--- last 2 lines ---\nassert failed\nsee above';

test("a minion whose job waits for the test box's screen can end its turn (#1425): Citadel keeps asking after it and messages its chat when it starts and when it ends", async () => {
  const { store, relay, minion, wakes, minionCalls, opened, answer } = followed();
  const reply = minionCalls(5, 'run_task', { workspace: 'w', task: 'run' }, QUEUED);
  assert.match(reply, /^run in w is waiting in line.*\n\nCitadel is following job ab12cd34 for you.*you can end your turn now/s, 'the turn is told it can stop');
  assert.deepEqual(
    relay.boxWatches().map((w) => [w.job, w.ticket, w.what]),
    [['ab12cd34', minion.id, 'run in w']],
  );
  assert.equal(store.getSetting<unknown[]>('box-watches')!.length, 1, 'kept for a restart');

  const [init] = opened(/^Citadel, following job ab12cd34 for Peek #1$/);
  let call = await answer(init.session, null);
  assert.deepEqual(call.params, { name: 'job', arguments: { id: 'ab12cd34', wait: 10, lines: 40 } }, 'calling job keeps its place in line');
  call = await answer(init.session, QUEUED);
  assert.deepEqual(call.params.arguments.wait, 10);
  assert.equal(wakes.length, 0, 'still waiting: nothing said');

  call = await answer(init.session, RUNNING);
  assert.equal(call.params.arguments.wait, 50, 'running: it waits as long as the box allows');
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].id, minion.id);
  assert.match(wakes[0].text, /^Your job ab12cd34 on box \(run in w\) has the screen now and is running\./);
  await answer(init.session, RUNNING);
  assert.equal(wakes.length, 1, 'its start is told once');

  await answer(init.session, ENDED);
  assert.equal(wakes.length, 2);
  assert.match(wakes[1].text, /^Your job ab12cd34 on box \(run in w\) has ended\. Its report:\n> run in w FAILED \(exit 2\)[^]*> assert failed\n> see above\n\(Quoted from box/);
  assert.deepEqual(relay.boxWatches(), []);
  assert.deepEqual(store.getSetting('box-watches'), []);
});

test("a minion whose turn is stopped, or that is closed, takes its waiting job out of the screen's line (#1425)", async () => {
  for (const how of ['stopped', 'closed'] as const) {
    const { store, relay, minion, wakes, minionCalls, opened, answer } = followed();
    minionCalls(5, 'run_task', { workspace: 'w', task: 'run' }, QUEUED);
    const [init] = opened(/^Citadel, following/);
    await answer(init.session, null);
    if (how === 'stopped') relay.minionStopped(minion.id);
    else {
      store.updateTicket(minion.id, { status: 'closed' });
      await answer(init.session, QUEUED);
    }
    const [stopper] = opened(how === 'stopped' ? /^Citadel, for Peek #1 \(its turn was stopped\)$/ : /^Citadel, for Peek #1 \(it was closed\)$/);
    assert.ok(stopper, how);
    assert.deepEqual((await answer(stopper.session, null)).params, { name: 'stop_job', arguments: { id: 'ab12cd34' } });
    assert.deepEqual(relay.boxWatches(), []);
    assert.equal(wakes.length, 0, `${how}: nothing to tell it`);
  }
});

test('a job the minion saw start or end itself is not told again; one the box forgot is (#1425)', async () => {
  const { relay, wakes, minionCalls, opened, answer } = followed();
  minionCalls(5, 'run_task', { workspace: 'w', task: 'run' }, QUEUED);
  const [init] = opened(/^Citadel, following/);
  await answer(init.session, null);
  assert.doesNotMatch(minionCalls(6, 'job', { id: 'ab12cd34' }, QUEUED), /Citadel is following/, 'said once, when it queued');
  minionCalls(6, 'job', { id: 'ab12cd34' }, RUNNING);
  await answer(init.session, RUNNING);
  assert.equal(wakes.length, 0, 'it saw the start');
  minionCalls(7, 'job', { id: 'ab12cd34' }, ENDED);
  assert.deepEqual(relay.boxWatches(), [], 'it saw the end');
  assert.equal(wakes.length, 0);

  minionCalls(8, 'run_task', { workspace: 'w', task: 'run' }, QUEUED.replaceAll('ab12cd34', 'cd34ef56'));
  const [again] = opened(/^Citadel, following job cd34ef56/);
  await answer(again.session, null);
  await answer(again.session, 'No job cd34ef56 here. Jobs are forgotten when the agent restarts; their logs stay in C:\\jobs.');
  assert.match(wakes[0].text, /^Your job cd34ef56 on box \(run in w\) is gone: the box's agent restarted and forgot it, so whether it ran is unknown/);
  assert.deepEqual(relay.boxWatches(), []);
});

test('a restart carries on following the jobs it was following (#1425)', async () => {
  const { store, relay, box, minion, minionCalls } = followed();
  minionCalls(5, 'run_task', { workspace: 'w', task: 'run' }, QUEUED);
  relay.minionStopped(-1); // someone else's stop changes nothing
  assert.equal(relay.boxWatches().length, 1);
  const next = new MachineRelay(store, () => {});
  relays.push({ relay: next, store });
  const agent = stream();
  next.connectAgent(box, agent, { host: 'h', command: '', managed: true });
  next.setInfo(box, { v: 2, workspaces: [{ name: 'w', tasks: [{ name: 'run', run: ['run.ps1'] }] }] });
  next.setLend(box.id, { server: null, workspaces: ['w'] });
  next.watchBoxes(() => {});
  assert.deepEqual(
    next.boxWatches().map((w) => [w.job, w.ticket]),
    [['ab12cd34', minion.id]],
  );
  assert.ok(agent.sent.some((m) => m.message?.method === 'initialize' && /^Citadel, following job ab12cd34/.test(m.who)));
  relay.minionStopped(minion.id);
  next.minionStopped(minion.id);
});

test("a job still in line when Citadel's 12 hours of following run out leaves the line, and its minion is told nothing ran (#1819)", async () => {
  for (const started of [false, true]) {
    const { store, relay, box, minion, minionCalls } = followed();
    minionCalls(5, 'run_task', { workspace: 'w', task: 'run' }, QUEUED);
    const old = relay.boxWatches().map((w) => ({ ...w, since: Date.now() - 13 * 3_600_000, ...(started ? { started: true } : {}) }));
    relay.minionStopped(-1);
    store.setSetting('box-watches', old);
    const next = new MachineRelay(store, () => {});
    relays.push({ relay: next, store });
    const agent = stream();
    next.connectAgent(box, agent, { host: 'h', command: '', managed: true });
    next.setInfo(box, { v: 2, workspaces: [{ name: 'w', tasks: [{ name: 'run', run: ['run.ps1'] }] }] });
    next.setLend(box.id, { server: null, workspaces: ['w'] });
    const wakes: { id: number; text: string }[] = [];
    next.watchBoxes((id, text) => wakes.push({ id, text }));
    const init = agent.sent.find((m) => m.message?.method === 'initialize' && /^Citadel, following job ab12cd34/.test(m.who));
    next.fromAgent(box, init.session, { message: { jsonrpc: '2.0', id: init.message.id, result: {} } });
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
    assert.ok(!agent.sent.some((m) => m.session === init.session && m.message?.params?.name === 'job'), 'not asked after again');
    assert.deepEqual(next.boxWatches(), [], 'no longer followed');
    assert.deepEqual(store.getSetting('box-watches'), []);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].id, minion.id);
    const stopper = agent.sent.filter((m) => m.message?.method === 'initialize' && /^Citadel, for Peek #1 \(it waited 12 hours in line\)$/.test(m.who));
    if (started) {
      assert.match(wakes[0].text, /^Citadel stopped following your job ab12cd34 on box \(run in w\) after 12 hours\. Call job/);
      assert.equal(stopper.length, 0, 'a running job is left to its own 30 minute limit');
    } else {
      assert.match(wakes[0].text, /^Your job ab12cd34 on box \(run in w\) waited 12 hours in line for the screen without getting it, so Citadel took it out of the line: nothing was started\. Run run_task again/);
      assert.equal(stopper.length, 1, 'it leaves the line now');
      next.fromAgent(box, stopper[0].session, { message: { jsonrpc: '2.0', id: stopper[0].message.id, result: {} } });
      for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
      assert.deepEqual(
        agent.sent.filter((m) => m.session === stopper[0].session && m.message?.params?.name).map((m) => m.message.params),
        [{ name: 'stop_job', arguments: { id: 'ab12cd34' } }],
      );
    }
    relay.minionStopped(minion.id);
    next.minionStopped(minion.id);
  }
});

test("a followed job ends on its report's head, not on box words its own output quotes; a box no longer lent to the scheme takes its job out of the line (#1425)", async () => {
  const { relay, wakes, minionCalls, opened, answer } = followed();
  minionCalls(5, 'run_task', { workspace: 'w', task: 'run' }, QUEUED);
  const [init] = opened(/^Citadel, following/);
  await answer(init.session, null);
  await answer(init.session, `${RUNNING}\n--- latest output ---\nlog: x. Job ab12cd34; full log on that computer: C:\\y`);
  assert.equal(relay.boxWatches().length, 1, 'its output quoting an end is no end');
  assert.match(wakes[0].text, /has the screen now/);
  await answer(init.session, `${ENDED}\nrun in w is waiting in line for the screen (job ab12cd34), 1 s so far`);
  assert.deepEqual(relay.boxWatches(), [], 'its tail quoting a wait is no wait');
  assert.match(wakes[1].text, /has ended\. Its report/);

  const next = followed();
  next.minionCalls(5, 'run_task', { workspace: 'w', task: 'run' }, QUEUED);
  const [watch] = next.opened(/^Citadel, following/);
  await next.answer(watch.session, null);
  next.store.setMachineProjects(next.box.id, []);
  await next.answer(watch.session, QUEUED);
  const [stopper] = next.opened(/^Citadel, for Peek #1 \(the box is no longer lent to its scheme\)$/);
  assert.deepEqual((await next.answer(stopper.session, null)).params, { name: 'stop_job', arguments: { id: 'ab12cd34' } });
  assert.match(next.wakes[0].text, /no longer lent to this scheme, so the job left the line/);
  assert.equal(next.relay.minionStopped(next.minion.id), 0, 'nothing left to stop');
});

test("gpuFound (One kind of machine H2): a workspace's run-gpu task counts as a GPU, as the card's check does", () => {
  const { relay, box } = world();
  assert.equal(relay.gpuFound(box), false, 'no agent, no jobs block');
  relay.connectAgent(box, stream(), { host: 'h', command: '', managed: true });
  relay.setInfo(box, { v: 2, workspaces: [{ name: 'w', tasks: [{ name: 'run', run: ['run.ps1'] }] }] });
  assert.equal(relay.gpuFound(box), false);
  relay.setInfo(box, { v: 2, workspaces: [{ name: 'w', tasks: [{ name: 'run-gpu', run: ['gpu.ps1'] }] }] });
  assert.equal(relay.gpuFound(box), true);
});
