// A VM is a capability of its computer (Build 10 H4, #2188): the test box is a VM on Cara's desktop, shown only on the
// desktop's card, its owner the desktop's, its tools still named after itself.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { test } from 'node:test';
import { Store } from '../src/db.ts';
import { MachineRelay, vmsFound } from '../src/machines.ts';
import { machineText, type MachineInfo } from '../src/mcp-text.ts';

/** A stream the relay writes to and the test hangs up. */
function res() {
  const r = new EventEmitter() as EventEmitter & ServerResponse;
  Object.assign(r, { writeHead() {}, write: () => true, end: () => r.emit('close') });
  return r;
}

function setup() {
  const store = new Store(':memory:');
  const relay = new MachineRelay(store, () => {});
  const cara = store.createUser({ name: 'Cara', login: 'cara' });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const peek = store.createProject('Peek Auras', null, cara.id);
  const desk = store.createMachine('cara-desktop', 'x', 'Cara', cara.id);
  const box = store.createMachine('citadel-test-box', 'y', 'Cara', cara.id);
  store.setMachineRole(box.id, 'tools', { on: true, projects: [peek.id], caps: { ticks: { server: null, workspaces: ['peek-auras'] } } });
  return { store, relay, cara, josh, peek, desk, box };
}

test('a VM never shows as a machine of its own: only inside its host, which names it; its own tools stay online under its name', () => {
  const { store, relay, desk, box } = setup();
  assert.ok(store.linkMachineVm(box.id, desk.id));
  const vmAgent = res();
  relay.connectAgent(store.getMachine(box.id)!, vmAgent, { host: 'CITADEL-TEST-BOX', command: '', managed: true });
  try {
    relay.setInfo(store.getMachine(box.id)!, { v: 2, found: [], workspaces: [{ name: 'peek-auras', path: 'C:\\work\\peek-auras', tasks: [{ name: 'run' }] }], report: { os: 'windows', host: 'CITADEL-TEST-BOX' } });
    const list = relay.list();
    assert.deepEqual(
      list.map((m) => m.name),
      ['cara-desktop'],
      'the page, its stream and GET /api/machines list computers only',
    );
    const host = list[0];
    assert.deepEqual(
      host.vms.map((v) => [v.name, v.vm_of, v.online]),
      [['citadel-test-box', desk.id, true]],
    );
    assert.deepEqual(
      host.vms[0].workspaces.map((w) => w.name),
      ['peek-auras'],
      "the VM's workspaces are on the host's card",
    );
    // Turns still get the VM's own tools, under its own name (mcp__citadel-test-box-ws__*).
    assert.deepEqual(
      relay.online().map((m) => [m.name, m.servers]),
      [['citadel-test-box', ['ws']]],
    );
  } finally {
    relay.disconnect(box.id);
  }
});

test("a VM takes its host's owner, is never its own host or a VM on a VM, and a deleted host leaves it a machine again", () => {
  const { store, relay, josh, desk, box } = setup();
  const joshs = store.createMachine('josh-desktop', 'z', 'Josh', josh.id);
  store.linkMachineVm(box.id, joshs.id);
  assert.equal(store.getMachine(box.id)!.owner_id, josh.id, "linked to Josh's computer, it is Josh's");
  assert.equal(store.linkMachineVm(desk.id, desk.id), false, 'not its own host');
  assert.equal(store.linkMachineVm(desk.id, box.id), false, 'not a VM on a VM');
  assert.equal(store.linkMachineVm(joshs.id, desk.id), false, 'a host with a VM is not a VM');
  store.deleteMachine(joshs.id);
  assert.equal(store.getMachine(box.id)!.vm_of, null);
  assert.deepEqual(
    relay
      .list()
      .map((m) => m.name)
      .sort(),
    ['cara-desktop', 'citadel-test-box'],
  );
});

test("the host's agent finding a Hyper-V VM links its owner's machine of that name, and only that", () => {
  const { store, relay, josh, desk, box } = setup();
  const other = store.createMachine('dragonbox', 'w', 'Josh', josh.id);
  const agent = res();
  relay.connectAgent(desk, agent, { host: 'DESKTOP-G248IJ8', command: '', managed: true });
  try {
    relay.setInfo(store.getMachine(desk.id)!, { v: 2, found: [], workspaces: [], report: { os: 'windows', host: 'DESKTOP-G248IJ8', hyperv: { present: true, vms: ['Citadel-Test-Box', 'dragonbox', 'nothing-here'] } } });
    assert.equal(store.getMachine(box.id)!.vm_of, desk.id, "Cara's test box, named like the VM (any case), is a VM on her desktop now");
    assert.equal(store.getMachine(other.id)!.vm_of, null, "Josh's dragonbox shares a name with a VM there but isn't Cara's");
    assert.deepEqual(
      relay.list().map((m) => m.name),
      ['cara-desktop', 'dragonbox'],
    );
  } finally {
    relay.disconnect(desk.id);
  }
  // A VM list it can't read (no Hyper-V Administrators) links nothing; a VM is never a host.
  assert.equal(vmsFound(store, store.getMachine(box.id)!, ['cara-desktop']), false);
});

test("a Taskmaster's list names a VM with its computer, and links its host's card", () => {
  const text = machineText({
    name: 'citadel-test-box',
    vm_on: 'cara-desktop',
    status: 'ready',
    reason: 'ready',
    owner_id: 1,
    owner_name: 'Cara',
    project_names: ['Peek Auras'],
    workspaces: [],
    online: true,
    connected_at: Date.now(),
    sessions: 0,
    last_seen_at: null,
    managed: true,
    found: [],
    servers: ['ws'],
    workspace_tools: true,
    minions_get_it: true,
    problems: [],
    page: '#/p/1/machines/cara-desktop',
  } as MachineInfo);
  assert.match(text, /^citadel-test-box \(a VM on cara-desktop\): /);
  assert.match(text, /\[cara-desktop's card on the Machines page\]\(#\/p\/1\/machines\/cara-desktop\)/);
});
