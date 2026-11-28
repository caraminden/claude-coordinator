// One-job runners (runner pool P2, #2269): a just-in-time config only for a machine lending CI to the scheme, handed out
// once by a one-time id, never sent to the agent; an agent's slot reports checked; a slot's leftovers taken off GitHub.
// GitHub and the agent are faked; nothing here reaches either.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Listed, noSelfUpdate, RunnerTokens } from '../src/ci-runner.ts';
import { Credentials } from '../src/credentials.ts';
import { type Machine, Store } from '../src/db.ts';
import { GithubLink } from '../src/github-link.ts';
import type { RunnerJob } from '../src/machines.ts';
import { OneTime, poolName, RunnerSlots, slotReport } from '../src/runner-slots.ts';
import { until } from './wait.ts';

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');
/** A config in GitHub's shape: base64 JSON of the runner's files, each base64 too. */
const CONFIG = b64({ '.runner': b64({ agentId: 7, agentName: 'x', poolId: 1, workFolder: '_work' }), '.credentials': b64({ scheme: 'OAuth' }), '.credentials_rsaparams': b64({ d: 'secret-ish' }) });

function world() {
  const store = new Store(':memory:');
  const creds = new Credentials(store, 'secret');
  const link = new GithubLink(store, creds, 'client', 'shh');
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const olive = store.createUser({ name: 'Olive', login: 'olive' });
  const scheme = store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras.git', cara.id);
  const other = store.createProject('Delve', 'https://github.com/caraminden/delve.git', cara.id);
  creds.put(cara.id, 'github', 'gho_cara', { login: 'caraminden', id: 1, name: null });
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const path = url.replace('https://api.github.com', '');
    calls.push({ path: `${init?.method} ${path}`, body: init?.body ? JSON.parse(String(init.body)) : {} });
    if (init?.method === 'POST' && path === '/repos/caraminden/peek-auras/actions/runners/generate-jitconfig') return Response.json({ runner: { id: 9 }, encoded_jit_config: CONFIG }, { status: 201 });
    return Response.json({ message: 'unfaked' }, { status: 500 });
  }) as typeof globalThis.fetch;
  const tokens = new RunnerTokens(store, link, true, fetch);
  const noted: string[] = [];
  tokens.onFetched = (_p, words) => noted.push(words);
  /** A machine whose CI role is `on`, lent to `lent`. */
  const pc = (name: string, owner: number, on: boolean, lent: number[]) => {
    const m = store.createMachine(name, 'x', 'Cara', owner);
    store.writeMachineRoles(m.id, (roles) => roles.map((r) => (r.role === 'ci' ? { ...r, on, projects: lent } : r)));
    return store.getMachine(m.id)!;
  };
  return { store, cara, olive, scheme, other, tokens, calls, noted, pc };
}

test('only a machine lending CI to the scheme gets a one-job config, minted as the owner with self-update off', async () => {
  const w = world();
  const desk = w.pc('desk', w.cara.id, true, [w.scheme.id]);
  const config = await w.tokens.jit(desk, w.scheme, 'pool-m1-w1-j5', ['peek-auras-ci']);
  assert.deepEqual(w.calls[0], { path: 'POST /repos/caraminden/peek-auras/actions/runners/generate-jitconfig', body: { name: 'pool-m1-w1-j5', runner_group_id: 1, labels: ['peek-auras-ci'], work_folder: '_work' } });
  const files = JSON.parse(Buffer.from(config, 'base64').toString());
  assert.equal(JSON.parse(Buffer.from(files['.runner'], 'base64').toString()).disableUpdate, true);
  assert.equal(files['.credentials_rsaparams'], JSON.parse(Buffer.from(CONFIG, 'base64').toString())['.credentials_rsaparams']);
  // Once per CI job, so no note in the Taskmaster's chat.
  assert.deepEqual(w.noted, []);

  // CI off, lent only to another scheme, or its owner not in the scheme: refused before GitHub is asked.
  await assert.rejects(w.tokens.jit(w.pc('off', w.cara.id, false, [w.scheme.id]), w.scheme, 'n', ['l']), { status: 404 });
  await assert.rejects(w.tokens.jit(w.pc('elsewhere', w.cara.id, true, [w.other.id]), w.scheme, 'n', ['l']), { status: 404 });
  await assert.rejects(w.tokens.jit(w.pc('olive-pc', w.olive.id, true, [w.scheme.id]), w.scheme, 'n', ['l']), { status: 404 });
  w.store.updateUser(w.cara.id, { disabled_at: Date.now() });
  await assert.rejects(w.tokens.jit(desk, w.scheme, 'n', ['l']), { status: 404 });
  assert.equal(w.calls.length, 1);
});

test('noSelfUpdate passes a config of another shape through unchanged', () => {
  for (const odd of ['not base64 json', b64({ other: 1 }), b64({ '.runner': b64([1, 2]) }), b64({ '.runner': 'bm90IGpzb24=' })]) assert.equal(noSelfUpdate(odd), odd);
});

test('a one-time id hands its config out once, to the first who holds it, and lapses', async () => {
  const once = new OneTime();
  const id = once.put('CFG');
  assert.match(id, /^[0-9a-f]{48}$/);
  assert.equal(once.take(id.toUpperCase()), null);
  assert.equal(once.take({ id }), null);
  assert.equal(once.take(id), 'CFG');
  assert.equal(once.take(id), null);
  const lapsing = once.put('CFG', 1);
  await until('the id lapsed', () => once.size === 0);
  assert.equal(once.take(lapsing), null);
});

test("an agent's slot report is checked field by field, and a job's name is kept short and printable", () => {
  const m = { id: 4 } as Machine;
  const r = slotReport(m, { scheme: 2, slot: 3, os: 'linux', event: 'took', job: `build\u0007\n${'x'.repeat(300)}`, code: 'no' }, 99);
  assert.deepEqual({ ...r, job: r.job?.slice(0, 7) }, { machineId: 4, scheme: 2, slot: 3, os: 'linux', event: 'took', job: 'build  ', at: 99 });
  assert.equal(r.job?.length, 200);
  for (const bad of [{ scheme: 0 }, { slot: 17 }, { slot: 1.5 }, { os: 'mac' }, { event: 'exploded' }]) {
    assert.throws(() => slotReport(m, { scheme: 2, slot: 3, os: 'windows', event: 'ended', ...bad }), { status: 400 }, JSON.stringify(bad));
  }
});

/** RunnerSlots over a faked GitHub list and a faked agent. */
function slots(agentOk = true) {
  const store = new Store(':memory:');
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const project = store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras.git', cara.id);
  const desk = store.createMachine('desk', 'x', 'Cara', cara.id);
  store.writeMachineRoles(desk.id, (roles) => roles.map((r) => (r.role === 'ci' ? { ...r, on: true, projects: [project.id] } : r)));
  const machine = store.getMachine(desk.id)!;
  const listed: Listed[] = [];
  const removed: number[] = [];
  const sent: RunnerJob[] = [];
  let nextId = 100;
  const tokens = {
    jit: async (_m: Machine, _p: unknown, name: string) => {
      listed.push({ id: nextId++, name, status: 'offline', busy: false, labels: [] });
      return 'THE-CONFIG';
    },
    listed: async () => {
      const now = listed.map((x) => ({ ...x }));
      w.afterList();
      return now;
    },
    removeById: async (_p: unknown, id: number) => {
      const at = listed.findIndex((x) => x.id === id);
      if (at >= 0 && listed[at].busy) throw new Error('busy');
      removed.push(id);
      if (at >= 0) listed.splice(at, 1);
      return at >= 0;
    },
  };
  const relay = {
    runnerJob: async (_id: number, job: RunnerJob) => {
      sent.push(job);
      return { ok: agentOk, output: agentOk ? 'started' : 'refused' };
    },
  };
  const rs = new RunnerSlots(store, tokens, relay, 0);
  const w = { store, project, machine, listed, removed, sent, rs, lists: 0, afterList: () => {} };
  return w;
}

test('a start mints for the slot, sends the agent only the one-time id, and the launcher swaps it for the config', async () => {
  const w = slots();
  const r = await w.rs.start(w.project, w.machine, { os: 'windows', slot: 2, labels: ['peek-auras-ci'], job: 555 });
  assert.equal(r.name, `pool-m${w.machine.id}-w2-j555`);
  assert.equal(w.sent.length, 1);
  const job = w.sent[0];
  assert.ok(job.op === 'start');
  assert.deepEqual(Object.keys(job).sort(), ['once', 'op', 'scheme', 'slot']);
  assert.ok(!JSON.stringify(job).includes('THE-CONFIG'), 'the config never goes to the agent');
  assert.equal(w.rs.once.take(job.once), 'THE-CONFIG');
  assert.equal(w.rs.once.take(job.once), null);
  for (const bad of [{ slot: 0 }, { slot: 17 }, { labels: [] }, { labels: ['a b'] }, { job: -1 }]) {
    await assert.rejects(w.rs.start(w.project, w.machine, { os: 'linux', slot: 1, labels: ['x'], ...bad }), { status: 400 }, JSON.stringify(bad));
  }
});

test('a start the agent refuses drops its id and takes the runner it minted off GitHub', async () => {
  const w = slots(false);
  const r = await w.rs.start(w.project, w.machine, { os: 'linux', slot: 1, labels: ['x'] });
  assert.equal(r.ok, false);
  const job = w.sent[0];
  assert.ok(job.op === 'start');
  assert.equal(w.rs.once.take(job.once), null);
  await until('the minted runner is gone', () => w.listed.length === 0);
  assert.equal(w.removed.length, 1);
});

test("an end takes off only that slot's idle runners minted before it, and waits out one GitHub still calls busy", async () => {
  const w = slots();
  await w.rs.start(w.project, w.machine, { os: 'windows', slot: 1, labels: ['x'] });
  await w.rs.start(w.project, w.machine, { os: 'windows', slot: 2, labels: ['x'] });
  await w.rs.start(w.project, w.machine, { os: 'linux', slot: 1, labels: ['x'] });
  // Another machine's runner and a standing runner share the repo: never touched.
  w.listed.push({ id: 1, name: poolName(w.machine.id + 1, 'windows', 1, 7), status: 'online', busy: false, labels: [] }, { id: 2, name: 'DESK-peek-auras', status: 'online', busy: false, labels: [] });
  const slot1 = w.listed[0];
  slot1.busy = true;
  // GitHub sees the killed runner go only on its next look.
  w.afterList = () => {
    w.lists++;
    slot1.busy = false;
  };
  assert.equal(await w.rs.cleanUp(w.project, w.machine.id, 'windows', 1, Date.now() + 1), 1);
  assert.equal(w.lists, 2);
  const prefixes = w.listed.map((x) => x.name.replace(/[^-]+$/, ''));
  assert.deepEqual(prefixes, [`pool-m${w.machine.id}-w2-`, `pool-m${w.machine.id}-l1-`, `pool-m${w.machine.id + 1}-w1-`, 'DESK-peek-']);

  // A runner minted after the end it cleans up for stays: it is the slot's next one.
  await w.rs.start(w.project, w.machine, { os: 'linux', slot: 1, labels: ['x'] });
  assert.equal(await w.rs.cleanUp(w.project, w.machine.id, 'linux', 1, Date.now() - 60_000), 0);
});

test("an agent's ended report cleans up the slot; one for a scheme that's gone is refused", async () => {
  const w = slots();
  const seen: string[] = [];
  w.rs.onReport = (r) => seen.push(`${r.event}${r.code ?? ''}`);
  await w.rs.start(w.project, w.machine, { os: 'windows', slot: 3, labels: ['x'] });
  w.rs.report(w.machine, { scheme: w.project.id, slot: 3, os: 'windows', event: 'took', job: 'test' });
  assert.equal(w.listed.length, 1);
  w.rs.report(w.machine, { scheme: w.project.id, slot: 3, os: 'windows', event: 'ended', code: 0 });
  await until('the ended runner is gone', () => w.listed.length === 0);
  assert.deepEqual(seen, ['took', 'ended0']);
  assert.throws(() => w.rs.report(w.machine, { scheme: 999, slot: 3, os: 'windows', event: 'ended' }), { status: 404 });
  // A machine that hosts no CI can't make Citadel list a scheme's runners.
  const laptop = w.store.createMachine('laptop', 'x', 'Cara', w.store.getProject(w.project.id)!.owner_id!);
  assert.throws(() => w.rs.report(laptop, { scheme: w.project.id, slot: 3, os: 'windows', event: 'ended' }), { status: 404 });
});
