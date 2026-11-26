import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { pausedRoles } from '../src/machine-pause.ts';
import { dropMachine, patchRoles, pauseMachine } from '../src/routes/machines.ts';
import { containerArgs, workerConfig } from '../public/machine-worker.mjs';
import { pageCaps, WorkerAgent } from '../public/worker-agent.mjs';
import { WorkerJoin } from '../src/worker-join.ts';

// The role cards on a machine's row (Build 7 M3, specs/machine-connections.md section 7): Pause all and its one click
// back, and the caps its owner sets on the page reaching the worker, which holds the lower of those and its own.
const dir = mkdtempSync(join(tmpdir(), 'machine-role-cards-'));
// timing-ok: own temp dir
after(() => rmSync(dir, { recursive: true, force: true }));

function setup() {
  const s = new Store(join(dir, `cards-${Math.random().toString(36).slice(2)}.db`));
  const cara = s.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = s.createUser({ name: 'Josh', login: 'josh' });
  const dana = s.createUser({ name: 'Dana', login: 'dana' });
  const mine = s.createProject('josh-scheme', null, josh.id);
  const m = s.createMachine('josh-pc', '', 'Josh', josh.id);
  const app = {
    store: s,
    machines: { rolesChanged: () => {}, endSessionsWhere: () => {}, list: () => [], view: () => ({}), disconnect: () => {} },
    runner: { turnLine: { pump: () => {}, forget: () => {} } },
    ciLoad: { forget: () => {} },
    jobs: { drop: () => {} },
    broadcast: () => {},
  } as unknown as Parameters<typeof patchRoles>[0];
  const as = (u: { id: number; admin?: number | boolean }) => ({ uid: u.id, admin: !!u.admin }) as Parameters<typeof patchRoles>[1];
  const on = () =>
    s
      .machineRoles(m.id)
      .filter((r) => r.on)
      .map((r) => r.role);
  return { s, app, as, m, cara, josh, dana, mine, on };
}

test('Pause all switches every role that is on off, and Resume puts back those same roles with their schemes', async () => {
  const { s, app, as, m, josh, dana, mine, on } = setup();
  await patchRoles(app, as(josh), m, { role: 'turns', on: true });
  const was = on();
  assert.deepEqual(was, ['tools', 'turns', 'gpu']);
  await assert.rejects(pauseMachine(app, as(dana), m, { pause: true }), /No such machine/);
  await assert.rejects(pauseMachine(app, as(josh), m, { pause: 'yes' }), /pause must be true or false/);
  await pauseMachine(app, as(josh), m, { pause: true });
  assert.deepEqual(on(), []);
  assert.deepEqual(pausedRoles(s, m.id), was);
  await assert.rejects(pauseMachine(app, as(josh), m, { pause: true }), /Nothing is switched on/);
  // One switched back by hand is back already: Resume brings the rest.
  await patchRoles(app, as(josh), m, { role: 'gpu', on: true });
  assert.deepEqual(pausedRoles(s, m.id), ['tools', 'turns']);
  const res = await pauseMachine(app, as(josh), m, { pause: false });
  assert.deepEqual(res.errors, []);
  assert.deepEqual(on(), was);
  assert.equal(pausedRoles(s, m.id), null);
  // Their schemes stayed through the pause.
  assert.deepEqual(s.machineRoles(m.id).find((r) => r.role === 'turns')?.projects, [mine.id]);
});

test("Resume by an admin brings back what it may; Minion turns, its owner's alone, stays off and says why", async () => {
  const { s, app, as, m, cara, josh, on } = setup();
  await patchRoles(app, as(josh), m, { role: 'turns', on: true });
  await pauseMachine(app, as(cara), m, { pause: true });
  const res = await pauseMachine(app, as(cara), m, { pause: false });
  assert.deepEqual(on(), ['tools', 'gpu']);
  assert.match(res.errors.join(), /Minion turns: Only its owner can switch Minion turns on/);
  assert.equal(pausedRoles(s, m.id), null);
});

test('a removed machine takes its Pause all with it, so a new PC given the same id has nothing to Resume', async () => {
  const { s, app, as, m, josh } = setup();
  await patchRoles(app, as(josh), m, { role: 'turns', on: true });
  await pauseMachine(app, as(josh), m, { pause: true });
  assert.ok(pausedRoles(s, m.id));
  await dropMachine(app, m);
  assert.equal(pausedRoles(s, m.id), null);
});

test("the page's caps reach the worker: it holds the lower of them and its own, and puts threads and memory on its containers", async () => {
  assert.deepEqual(pageCaps({ workers: 2, threads: -1, memory_gb: 'x', disk_gb: 40, runners: 3 }), { workers: 2, disk_gb: 40 });
  assert.deepEqual(pageCaps(null), {});
  class FakeWorker {
    cfg: Record<string, unknown>;
    constructor(o: { config: Record<string, unknown> }) {
      this.cfg = { ...o.config };
    }
    call() {}
  }
  const agent = new WorkerAgent({ config: { root: '/w', workers: 6, threads: 8, memory_gb: 24, disk_gb: 60 }, appUrl: 'http://x', token: 't', Worker: FakeWorker as never, run: async () => ({ code: 0, out: '', err: '' }), exit: () => {} });
  agent.wait = false;
  agent.image = { state: 'ready', text: '' };
  agent.fit();
  assert.equal(agent.worker.cfg.max, 6);
  assert.equal(agent.worker.cfg.limits, null, 'with no page caps nothing goes on the container');
  agent.page = pageCaps({ workers: 2, threads: 4, disk_gb: 100 });
  agent.fit();
  assert.equal(agent.worker.cfg.max, 2);
  assert.deepEqual(agent.worker.cfg.limits, { threads: 4, memory_gb: 24 });
  assert.equal(agent.held().disk_gb, 60, 'a page cap above its own is held at its own');
  agent.disk = 61;
  assert.equal(agent.full(), true);
  agent.page = pageCaps({ disk_gb: 70 });
  assert.equal(agent.full(), true, 'the PC keeps its own disk cap');
  agent.page = pageCaps({ workers: 0 });
  agent.disk = 1;
  agent.fit();
  assert.equal(agent.worker.cfg.max, 0, 'workers 0 starts nothing there');

  const cfg = workerConfig({ root: '/w', image: 'img' });
  const launch = { home: '/home/x', roots: [] };
  const plain = containerArgs(cfg, launch);
  assert.equal(plain.includes('--cpus'), false);
  cfg.limits = { threads: 4, memory_gb: 16 };
  const held = containerArgs(cfg, launch);
  assert.deepEqual(held.slice(held.indexOf('--cpus'), held.indexOf('--cpus') + 4), ['--cpus', '4', '--memory', '16g']);
  // Another spec: an idle container is replaced with the new limits.
  const spec = (a: string[]) => a[a.indexOf('--label') + 1];
  assert.notEqual(spec(held), spec(plain));
});

test("a worker's sync reply carries the Minion turns caps its owner set on the page, and no others", async () => {
  const { s, app, as, m, josh } = setup();
  const join = new WorkerJoin({ store: s, lends: () => true, info: () => null, ships: () => false, claude: async () => null, changed: () => {}, now: Date.now });
  assert.deepEqual(join.pageCaps(m.id), {});
  await patchRoles(app, as(josh), m, { role: 'turns', caps: { workers: 2, disk_gb: 40 } });
  await patchRoles(app, as(josh), m, { role: 'ci', caps: { runners: 3 } });
  assert.deepEqual(join.pageCaps(m.id), { workers: 2, disk_gb: 40 });
});
