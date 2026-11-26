// Automatic use (Build 7 M5): the pooled Windows tools pick a machine with the Windows screen role and keep a minion on
// it while it can, and a GPU job with no machine named goes to an eligible machine. The picks alone, then the whole path:
// the real server, two real agents (public/machine-agent.mjs) with workspace tools, and a stand-in claude.
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { bootServer, ok, stopProcs, tempRoot, until, type Booted } from './helpers.ts';
import { machineFakes } from './machine-fakes.ts';
import { pickJobMachine, WindowsPool, type JobMachine } from '../src/machine-pick.ts';

test('the pooled Windows tools take a free screen first, then keep the minion on its machine while it is eligible, busy or not', () => {
  const pool = new WindowsPool();
  const a = { id: 1, name: 'win-a', busy: 2 };
  const b = { id: 2, name: 'win-b', busy: 0 };
  assert.deepEqual(pool.pick(10, [a, b]), { machine: b, movedFrom: null }, 'the free screen, though its id is higher');
  assert.deepEqual(pool.pick(10, [a, { ...b, busy: 3 }]), { machine: { ...b, busy: 3 }, movedFrom: null }, 'busy now (its own job, maybe), it stays');
  assert.deepEqual(pool.pick(11, [a, { ...b, busy: 3 }]), { machine: a, movedFrom: null }, 'another minion gets the shorter line');
  assert.deepEqual(pool.pick(10, [a]), { machine: a, movedFrom: 2 }, 'gone: it moves and says from where');
  assert.deepEqual(pool.pick(10, [a, b]), { machine: a, movedFrom: null }, 'back again, it stays where it moved to');
  assert.equal(pool.pick(10, []), null);
  assert.deepEqual(pool.pick(10, [b]), { machine: b, movedFrom: 1 }, 'none eligible for a while forgets nothing: the move still says where from');
});

test('a GPU job with no machine named goes online first, then to one that allows its recipe, not paused, the shortest queue', () => {
  const m = (name: string, o: Partial<JobMachine> = {}): JobMachine => ({ id: name.length, name, online: true, paused: false, allowed: false, ahead: 0, ...o });
  assert.equal(pickJobMachine([]), null);
  assert.equal(pickJobMachine([m('off', { online: false, allowed: true }), m('on', { ahead: 5 })])!.name, 'on');
  assert.equal(pickJobMachine([m('asks', { ahead: 0 }), m('allows', { allowed: true, ahead: 3 })])!.name, 'allows', 'no go card beats a shorter queue');
  assert.equal(pickJobMachine([m('paused', { paused: true }), m('open', { ahead: 2 })])!.name, 'open');
  assert.equal(pickJobMachine([m('busy', { ahead: 2 }), m('idle', { ahead: 1 })])!.name, 'idle');
  assert.equal(pickJobMachine([m('b'), m('a')])!.name, 'a', 'then by name');
  assert.equal(pickJobMachine([m('only', { online: false })])!.name, 'only', 'an offline one still queues: it runs when it is back');
});

const tmp = tempRoot('machine-pick-');
const root = tmp.dir;
const procs: ChildProcess[] = [];
let srv: Booted;
after(async () => {
  try {
    await srv?.settled();
  } finally {
    await stopProcs(procs);
    await tmp.teardown();
  }
});
const { mcpServer, fakeClaude, turns, startMachineAgent } = machineFakes(root, procs);
const call = async (path: string, body?: unknown, method = 'GET') => ok(await srv.call(path, body, method));

before(async () => {
  srv = await bootServer({ root, env: { CLAUDE_BIN: fakeClaude }, stdout: true });
  procs.push(srv.proc);
});

/** A machine whose agent offers workspace `w`, ticked, with its Windows screen role lent to these schemes. */
async function windowsMachine(name: string, schemes: number[]) {
  const dir = join(root, name);
  mkdirSync(join(dir, 'w'), { recursive: true });
  writeFileSync(join(dir, 'machine-agent.json'), JSON.stringify({ workspaces: { w: { path: join(dir, 'w'), tasks: { hi: { run: [process.execPath, '-e', 'console.log(1)'] } } } } }));
  const { machine, token } = await call('/api/machines', { name }, 'POST');
  const started = startMachineAgent({ base: srv.base, token, run: ['--config', join(dir, 'machine-agent.json'), '--', process.execPath, mcpServer] });
  await until(`${name} to report its workspace`, async () => (await call('/api/machines')).find((m: { name: string; workspaces: unknown[] }) => m.name === name && m.workspaces.length));
  await call(`/api/machines/${machine.id}`, { workspace_tools: true, lend: { server: null, workspaces: ['w'] } }, 'PATCH');
  await call(`/api/machines/${machine.id}/roles`, { role: 'screen', on: true, projects: schemes }, 'PATCH');
  return { id: machine.id as number, ...started };
}

/** Open the pooled tools' session as this minion's turn: which machine it got, and the one it left. */
async function pooled(token: string) {
  const stream = new AbortController();
  const r = await fetch(`${srv.base}/api/machines/windows/session?server=ws`, { headers: { Authorization: `Bearer ${token}` }, signal: stream.signal });
  const got = { status: r.status, machine: r.headers.get('x-citadel-machine'), from: r.headers.get('x-citadel-moved-from'), text: r.ok ? '' : await r.text() };
  stream.abort();
  return got;
}

test('two Windows machines: a minion sticks to one and moves when it goes away; a scheme not ticked sees neither', async () => {
  const lent = await call('/api/projects', { name: 'Lent' }, 'POST');
  const other = await call('/api/projects', { name: 'Other' }, 'POST');
  const a = await windowsMachine('win-a', [lent.id]);
  await windowsMachine('win-b', [lent.id]);

  // The lent scheme's turn gets the pooled tools, which reach a machine; not the machines' own (their Tools role isn't lent).
  let before = turns().length;
  const minion = await call(`/api/projects/${lent.id}/tickets`, { message: 'windows please' }, 'POST');
  let turn = (await until('a turn', () => turns().length > before && turns())).at(-1);
  assert.equal(turn.error, undefined);
  assert.deepEqual(Object.keys(turn.results), ['windows']);
  assert.ok(turn.results.windows.tools.includes('run_task'), JSON.stringify(turn.results.windows));
  assert.match(turn.message, /use mcp__windows first/);
  const token = turn.token as string;

  // Both screens free: the lower id, and the same one every time after.
  assert.deepEqual(await pooled(token), { status: 200, machine: 'win-a', from: null, text: '' });
  assert.deepEqual(await pooled(token), { status: 200, machine: 'win-a', from: null, text: '' });

  // win-a goes away: the next session moves to win-b and says from where; then it stays there.
  a.agent.kill();
  await until('win-a offline', async () => !(await call('/api/machines')).find((m: { name: string; online: boolean }) => m.name === 'win-a').online);
  assert.deepEqual(await pooled(token), { status: 200, machine: 'win-b', from: 'win-a', text: '' });
  assert.deepEqual(await pooled(token), { status: 200, machine: 'win-b', from: null, text: '' });

  // The other scheme isn't ticked: its turn gets no Windows tools at all, and can't open the pooled ones by hand.
  before = turns().length;
  await call(`/api/projects/${other.id}/tickets`, { message: 'windows too?' }, 'POST');
  turn = (await until('a turn', () => turns().length > before && turns())).at(-1);
  assert.deepEqual(Object.keys(turn.results), []);
  assert.doesNotMatch(turn.message, /mcp__windows/);
  const refused = await pooled(turn.token);
  assert.equal(refused.status, 503);
  assert.match(refused.text, /No Windows machine lent to Other/);
  assert.ok(minion);
});

test('a GPU job with no machine named goes to a machine whose GPU jobs role is lent to the scheme; another scheme is refused', async () => {
  const lent = await call('/api/projects', { name: 'Gpu' }, 'POST');
  const other = await call('/api/projects', { name: 'NoGpu' }, 'POST');
  const dir = join(root, 'gpu-a');
  mkdirSync(join(dir, 'jobs'), { recursive: true });
  writeFileSync(join(dir, 'machine-agent.json'), JSON.stringify({ jobs: { dir: join(dir, 'jobs'), folders: {}, max_disk_gb: 10, gpu: true } }));
  const { machine, token } = await call('/api/machines', { name: 'gpu-a' }, 'POST');
  startMachineAgent({ base: srv.base, token, run: ['--config', join(dir, 'machine-agent.json'), '--', process.execPath, mcpServer] });
  await until('gpu-a online', async () => (await call('/api/machines')).find((m: { name: string; online: boolean }) => m.name === 'gpu-a' && m.online));
  await call(`/api/machines/${machine.id}/roles`, { role: 'gpu', on: true, projects: [lent.id] }, 'PATCH');

  const kind = { name: 'k', image: `docker.io/x/y@sha256:${'a'.repeat(64)}`, command: ['run'], max_limit_h: 1 };
  const queue = async (project: { id: number }) => {
    const before = turns().length;
    const t = await call(`/api/projects/${project.id}/tickets`, { message: 'a job' }, 'POST');
    const { token } = (await until('a turn', () => turns().length > before && turns())).at(-1);
    return fetch(`${srv.base}/api/tickets/${t.ticket?.id ?? t.id}/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }) });
  };
  const queued = await until('the agent reported its jobs block', async () => {
    const r = await queue(lent);
    return r.status === 201 ? ((await r.json()) as { machine: string }) : null;
  });
  assert.equal(queued.machine, 'gpu-a');
  const refused = await queue(other);
  assert.equal(refused.status, 404);
  assert.match(await refused.text(), /No machine runs GPU jobs for NoGpu/);
});
