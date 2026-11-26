// One row per PC (Build 7 M2b): the real CI runner agent connects to its PC's row with that row's token, beside the
// machine agent, and a PC that is two rows (one an old runner host's) becomes one when its owner merges them.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { lendsRole } from '../src/access.ts';
import { mayFetch } from '../src/ci-runner.ts';
import { Store } from '../src/db.ts';
import { MERGES_KEY, mergedCi, pickKept } from '../src/machine-merge.ts';
import { pausedRoles, setPaused } from '../src/machine-pause.ts';
import { MachineRelay, storedCheck } from '../src/machines.ts';
import { bootServer, stopProcs, until } from './helpers.ts';

type Row = { id: number; name: string; online: boolean; runners: boolean; runner_agents: { os: string; host: string }[]; same_pc: { id: number; name: string }[]; merging: { from: number; into: number; os: string[] } | null; status: string; reason: string };

/** An agent's event stream held open with `token`: what it was sent, and a way to hang up. */
async function stream(base: string, token: string, query: string) {
  const ac = new AbortController();
  const sent: Record<string, unknown>[] = [];
  const res = await fetch(`${base}/api/machines/connect?${query}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' }, signal: ac.signal });
  assert.equal(res.status, 200);
  (async () => {
    let buf = '';
    for await (const chunk of res.body!) {
      buf += Buffer.from(chunk).toString();
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (line.startsWith('data: ')) sent.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch(() => {});
  return { sent, close: () => ac.abort() };
}

/** A stream the relay writes to and the test hangs up. */
function res() {
  const r = new EventEmitter() as EventEmitter & ServerResponse;
  Object.assign(r, { writeHead() {}, write: () => true, end: () => r.emit('close') });
  return r;
}

test("a PC row's CI role goes on at the runner agent's first connection, lent to every scheme its owner is in, and, switched off, stays off and lends no runner token", () => {
  const store = new Store(':memory:');
  const relay = new MachineRelay(store, () => {});
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const vault = store.createProject('Vault', null, josh.id);
  const den = store.createProject('Den', null, josh.id);
  const pc = store.createMachine('desk', 'x', 'Josh', josh.id);
  store.setMachineRole(pc.id, 'tools', { projects: [vault.id] });
  const ci = () => store.machineRoles(pc.id).find((r) => r.role === 'ci')!;
  const first = res();
  relay.connectAgent(pc, first, { host: 'DESK', command: 'citadel runner agent', runners: true, os: 'windows' });
  try {
    assert.deepEqual([ci().on, ci().projects], [true, [vault.id, den.id]]);
    assert.equal(mayFetch(store, store.getMachine(pc.id)!, vault), true);
    assert.equal(lendsRole(store, store.getMachine(pc.id)!, 'tools', vault, [josh.id]), true, 'its other roles keep working');
    store.setMachineRole(pc.id, 'ci', { on: false });
    first.end();
    relay.connectAgent(pc, res(), { host: 'DESK', command: 'citadel runner agent', runners: true, os: 'windows' });
    assert.equal(ci().on, false);
    assert.equal(mayFetch(store, store.getMachine(pc.id)!, vault), false);
  } finally {
    relay.disconnect(pc.id);
  }
});

test("a paused PC's runner agent joining keeps its CI role off: Resume brings it back with the rest", () => {
  const store = new Store(':memory:');
  const relay = new MachineRelay(store, () => {});
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const vault = store.createProject('Vault', null, josh.id);
  const pc = store.createMachine('desk', 'x', 'Josh', josh.id);
  store.setMachineRole(pc.id, 'tools', { projects: [vault.id] });
  setPaused(store, pc.id, ['tools']);
  store.setMachineRole(pc.id, 'tools', { on: false });
  relay.connectAgent(pc, res(), { host: 'DESK', command: 'citadel runner agent', runners: true, os: 'windows' });
  try {
    const ci = store.machineRoles(pc.id).find((r) => r.role === 'ci')!;
    assert.deepEqual([ci.on, ci.setup?.runner_agent, pausedRoles(store, pc.id)], [false, true, ['tools', 'ci']]);
    assert.equal(mayFetch(store, store.getMachine(pc.id)!, vault), false);
  } finally {
    relay.disconnect(pc.id);
  }
});

test('a PC row whose machine agent is gone is offline, though its runner agent is connected', () => {
  const store = new Store(':memory:');
  const relay = new MachineRelay(store, () => {});
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const pc = store.createMachine('desk', 'x', 'Josh', josh.id);
  store.updateMachine(pc.id, { report: JSON.stringify({ host: 'DESK', os: 'windows', threads: 8 }) });
  relay.connectAgent(pc, res(), { host: 'DESK', command: 'citadel runner agent', runners: true, os: 'windows' });
  try {
    const v = relay.view(store.getMachine(pc.id)!);
    assert.deepEqual([v.online, v.runners, v.runner_agents.map((r) => r.os)], [false, false, ['windows']]);
    assert.notEqual(v.status, 'ready', v.reason);
  } finally {
    relay.disconnect(pc.id);
  }
});

test("a merge waiting on a PC row lends no scheme more CI: the runner agent connecting there doesn't switch its CI on for the row's own schemes", () => {
  const store = new Store(':memory:');
  const relay = new MachineRelay(store, () => {});
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const a = store.createProject('A', null, josh.id);
  const c = store.createProject('C', null, josh.id);
  const pc = store.createMachine('desk', 'x', 'Josh', josh.id);
  store.setMachineRole(pc.id, 'tools', { projects: [a.id] });
  const old = store.createMachine('desk-ci-runners', 'y', 'Josh', josh.id);
  store.setMachineRole(old.id, 'ci', { on: true, projects: [c.id] });
  store.setSetting(MERGES_KEY, [{ from: old.id, into: pc.id, os: ['windows'], by: 'Josh', at: 1 }]);
  relay.connectAgent(pc, res(), { host: 'DESK', command: 'citadel runner agent', runners: true, os: 'windows' });
  try {
    assert.equal(store.machineRoles(pc.id).find((r) => r.role === 'ci')!.on, false);
    assert.deepEqual(mergedCi(store, store.getMachine(old.id)!, store.getMachine(pc.id)!), [c.id]);
  } finally {
    relay.disconnect(pc.id);
  }
});

test("a runner host flag an older release wrote on a PC row (a rollback) changes none of its roles, and its machine agent's next connection clears it", () => {
  const store = new Store(':memory:');
  const relay = new MachineRelay(store, () => {});
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const vault = store.createProject('Vault', null, josh.id);
  const pc = store.createMachine('desk', 'x', 'Josh', josh.id);
  store.setMachineRole(pc.id, 'tools', { projects: [vault.id] });
  relay.connectAgent(pc, res(), { host: 'DESK', command: 'citadel runner agent', runners: true, os: 'windows' });
  relay.disconnect(pc.id);
  const roles = store.machineRoles(pc.id);
  // What the release before M2b writes when this runner agent connects on the PC row's token.
  store.updateMachine(pc.id, { last_check: JSON.stringify({ at: 1, results: [], runners: true }) });
  assert.deepEqual(store.machineRoles(pc.id), roles);
  relay.connectAgent(store.getMachine(pc.id)!, res(), { host: 'DESK', command: 'citadel machine agent' });
  try {
    assert.equal(storedCheck(store.getMachine(pc.id)!)?.runners, undefined);
    assert.equal(lendsRole(store, store.getMachine(pc.id)!, 'tools', vault, [josh.id]), true);
  } finally {
    relay.disconnect(pc.id);
  }
});

test('the kept row is the PC row, not the runner host row; of two runner host rows, the older', () => {
  const runnerRow = (m: { id: number; r: boolean }) => m.r;
  assert.deepEqual(pickKept({ id: 9, r: false }, { id: 6, r: true }, runnerRow), { into: { id: 9, r: false }, from: { id: 6, r: true } });
  assert.deepEqual(pickKept({ id: 9, r: true }, { id: 6, r: true }, runnerRow), { into: { id: 6, r: true }, from: { id: 9, r: true } });
});

test('end to end: the runner agent joins the PC row beside its agent, and two rows that are one PC merge into one', async () => {
  const srv = await bootServer();
  const streams: { close(): void }[] = [];
  let agent: ReturnType<typeof spawn> | undefined;
  const rows = async () => (await srv.call('/api/machines')).data as Row[];
  const row = async (id: number) => (await rows()).find((m) => m.id === id);
  try {
    // A scheme that isn't Citadel's, and the PC's row with its machine agent connected and reporting this hostname.
    const project = (await srv.call('/api/projects', { name: 'Vault' })).data;
    const pc = (await srv.call('/api/machines', { name: 'desk' })).data;
    assert.equal((await srv.call(`/api/machines/${pc.machine.id}`, { projects: [project.id] }, 'PATCH')).status, 200);
    const machineAgent = await stream(srv.base, pc.token, `host=${encodeURIComponent(hostname())}&v=2`);
    streams.push(machineAgent);
    const info = await fetch(`${srv.base}/api/machines/info`, { method: 'POST', headers: { Authorization: `Bearer ${pc.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ v: 2, found: [], workspaces: [], report: { host: hostname(), os: 'linux', threads: 8 } }) });
    assert.equal(info.status, 202);

    // The real runner agent, with the same token (a stand-in PowerShell answers its scripts).
    const ps = join(srv.root, 'win', 'System32', 'WindowsPowerShell', 'v1.0');
    mkdirSync(ps, { recursive: true });
    writeFileSync(join(ps, 'powershell.exe'), `#!/bin/sh\ncase "$*" in *sample-load.ps1*) exit 1;; *keep-runners.ps1*) exit 0;; esac\necho "fake ps: $*"\n`);
    chmodSync(join(ps, 'powershell.exe'), 0o755);
    const tokenFile = join(srv.root, 'machine-token');
    writeFileSync(tokenFile, `${pc.token}\n`);
    const installed = join(srv.root, 'agent');
    mkdirSync(installed);
    copyFileSync(join(import.meta.dirname, '..', 'public', 'runner-agent.mjs'), join(installed, 'runner-agent.mjs'));
    writeFileSync(join(installed, 'keep-runners.ps1'), '');
    agent = spawn(process.execPath, [join(installed, 'runner-agent.mjs'), srv.base, '--token-file', tokenFile, '--os', 'windows', '--sample-ms', '60000', '--log', join(srv.root, 'agent.log')], { env: { ...process.env, SystemRoot: join(srv.root, 'win') }, stdio: 'ignore' });
    const both = await until('the runner agent to connect beside the machine agent', async () => {
      const m = await row(pc.machine.id);
      return m?.runner_agents.length ? m : null;
    });
    // One row: not a runner host's, its agent still connected, the runner agent beside it.
    assert.deepEqual([both.runners, both.online, both.runner_agents.map((r) => r.os)], [false, true, ['windows']]);
    assert.ok(!machineAgent.sent.some((m) => m.replaced), 'the runner agent did not replace the machine agent');
    // Its CI role went on, lent where the machine is; its tools stay lent too.
    const roles = (await srv.call(`/api/machines/${pc.machine.id}/roles`)).data;
    const ci = roles.roles.find((r: { role: string }) => r.role === 'ci');
    assert.deepEqual([ci.on, ci.projects], [true, [project.id]]);
    const tools = roles.roles.find((r: { role: string }) => r.role === 'tools');
    assert.equal(tools.on, true);
    // A member's list reaches the runner agent on that row.
    assert.equal((await srv.call(`/api/projects/${project.id}/ci-runners`, { op: 'list' })).status, 202);
    const { job } = (await srv.call(`/api/projects/${project.id}/ci-runners?wait=20`)).data;
    assert.equal(job.ok, true, job.text);
    assert.match(job.text, /fake ps: .*list-runners\.ps1/);

    // An old runner host row on the same PC (its own token, a Linux runner agent there) keeps working until merged.
    const old = (await srv.call('/api/machines', { name: 'desk-ci-runners', runners: true })).data;
    assert.equal((await srv.call(`/api/machines/${old.machine.id}`, { projects: [project.id] }, 'PATCH')).status, 200);
    const oldRunner = await stream(srv.base, old.token, `host=${encodeURIComponent(hostname())}&kind=runners&os=linux`);
    streams.push(oldRunner);
    const seen = await until('both rows to name each other', async () => {
      const [a, b] = [await row(pc.machine.id), await row(old.machine.id)];
      return a?.same_pc.length && b?.same_pc.length ? { a, b } : null;
    });
    assert.deepEqual([seen.a.same_pc.map((m) => m.id), seen.b.same_pc.map((m) => m.id), seen.b.runners], [[old.machine.id], [pc.machine.id], true]);

    // The merge keeps the PC's row and shows the line for the Linux runner agent with its token; nothing moves yet.
    const merged = await srv.call(`/api/machines/${old.machine.id}/merge`, { with: pc.machine.id }, 'POST');
    assert.equal(merged.status, 201, JSON.stringify(merged.data));
    assert.deepEqual([merged.data.into.id, merged.data.from.id, merged.data.os, merged.data.token], [pc.machine.id, old.machine.id, ['linux'], pc.token]);
    assert.ok(await row(old.machine.id), 'the old row stays until its runner agent connects to the kept one');
    const waiting = (await row(pc.machine.id))!.merging!;
    assert.deepEqual([waiting.from, waiting.into, waiting.os], [old.machine.id, pc.machine.id, ['linux']]);

    // The Linux runner agent reinstalled with the kept row's token: the old row goes, and its token with it.
    const moved = await stream(srv.base, pc.token, `host=${encodeURIComponent(hostname())}&kind=runners&os=linux`);
    streams.push(moved);
    await until('the old row to go', async () => !(await row(old.machine.id)));
    const kept = (await row(pc.machine.id))!;
    assert.deepEqual([kept.runner_agents.map((r) => r.os).sort(), kept.merging, kept.same_pc], [['linux', 'windows'], null, []]);
    assert.equal((await fetch(`${srv.base}/api/machines/connect?kind=runners`, { headers: { Authorization: `Bearer ${old.token}` } })).status, 401);
    // Both runner agents still act for the scheme, from one row.
    assert.equal((await srv.call(`/api/projects/${project.id}/ci-runners`, { op: 'list' })).status, 202);
    assert.equal((await srv.call(`/api/projects/${project.id}/ci-runners?wait=20`)).data.job.ok, true);
    assert.ok(!machineAgent.sent.some((m) => m.replaced));

    // An Update replaces only the machine agent: it keeps the token the runner agents on that row hold.
    const { code } = (await srv.call(`/api/machines/${pc.machine.id}/join`, {}, 'POST')).data;
    const joined = await fetch(`${srv.base}/api/machines/join`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, report: { host: hostname(), os: 'linux', threads: 8 } }) });
    assert.equal(joined.status, 201);
    assert.equal(((await joined.json()) as { token: string }).token, pc.token);
    // A new token cuts them off too, and says which ones, so the page shows their lines.
    const fresh = await srv.call(`/api/machines/${pc.machine.id}/token`, {}, 'POST');
    assert.deepEqual(fresh.data.runner_os.sort(), ['linux', 'windows']);
  } finally {
    for (const s of streams) s.close();
    if (agent) await stopProcs([agent]);
    await srv.stop();
  }
});
