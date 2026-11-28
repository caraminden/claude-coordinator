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

test("an agent's slot report is checked field by field, names one of its own slot's runners, and a job's name is kept short and printable", () => {
  const m = { id: 4 } as Machine;
  const r = slotReport(m, { scheme: 2, slot: 3, os: 'linux', event: 'took', runner: 'pool-m4-l3-j77', job: `build\u0007\n${'x'.repeat(300)}`, code: 'no' }, 99);
  assert.deepEqual({ ...r, job: r.job?.slice(0, 7) }, { machineId: 4, scheme: 2, slot: 3, os: 'linux', event: 'took', runner: 'pool-m4-l3-j77', job: 'build  ', at: 99 });
  assert.equal(r.job?.length, 200);
  const ok = { scheme: 2, slot: 3, os: 'windows', event: 'ended', runner: 'pool-m4-w3-a1b2c3' };
  slotReport(m, ok);
  // Another machine's, another slot's or OS's runner, a standing runner, or none: a report can only end its own.
  const others = [{ runner: 'pool-m5-w3-a1b2c3' }, { runner: 'pool-m4-w2-a1b2c3' }, { runner: 'pool-m4-l3-a1b2c3' }, { runner: 'DESK-peek-auras' }, { runner: undefined }, { runner: 'pool-m4-w3-' }];
  for (const bad of [{ scheme: 0 }, { slot: 17 }, { slot: 1.5 }, { os: 'mac' }, { event: 'exploded' }, ...others]) {
    assert.throws(() => slotReport(m, { ...ok, ...bad }), { status: 400 }, JSON.stringify(bad));
  }
});

/** RunnerSlots over a faked GitHub list and a faked agent. */
function slots() {
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
      if (w.listFails > 0) {
        w.listFails--;
        throw new Error('GitHub is away');
      }
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
      return { ok: w.agentOk, output: w.agentOk ? 'started' : 'refused' };
    },
  };
  const rs = new RunnerSlots(store, tokens, relay, 0);
  const w = { store, project, machine, listed, removed, sent, rs, lists: 0, listFails: 0, agentOk: true, afterList: () => {} };
  return w;
}

test('a start mints for the slot, sends the agent only the one-time id, and the launcher swaps it for the config', async () => {
  const w = slots();
  const r = await w.rs.start(w.project, w.machine, { os: 'windows', slot: 2, labels: ['peek-auras-ci'], job: 555 });
  assert.equal(r.name, `pool-m${w.machine.id}-w2-j555`);
  assert.equal(w.sent.length, 1);
  const job = w.sent[0];
  assert.ok(job.op === 'start');
  assert.deepEqual(Object.keys(job).sort(), ['name', 'once', 'op', 'scheme', 'slot']);
  assert.equal(job.name, r.name);
  assert.ok(!JSON.stringify(job).includes('THE-CONFIG'), 'the config never goes to the agent');
  assert.equal(w.rs.once.take(job.once), 'THE-CONFIG');
  assert.equal(w.rs.once.take(job.once), null);
  // A desktop job needs a person's session, which only Windows has (P6).
  for (const bad of [{ slot: 0 }, { slot: 17 }, { labels: [] }, { labels: ['a b'] }, { job: -1 }, { labels: ['peek-auras-desktop'] }]) {
    await assert.rejects(w.rs.start(w.project, w.machine, { os: 'linux', slot: 1, labels: ['x'], ...bad }), { status: 400 }, JSON.stringify(bad));
  }
});

test("a desktop job's start asks the Windows agent for the signed-in session, and a plain one never does (P6)", async () => {
  const w = slots();
  await w.rs.start(w.project, w.machine, { os: 'windows', slot: 1, labels: ['self-hosted', 'Peek-Auras-desktop'], job: 7 });
  await w.rs.start(w.project, w.machine, { os: 'windows', slot: 2, labels: ['self-hosted', 'peek-auras-ci'], job: 8 });
  assert.deepEqual(
    w.sent.map((j) => j.op === 'start' && [j.slot, j.session]),
    [
      [1, true],
      [2, undefined],
    ],
  );
});

test('a start the agent refuses drops its id and takes off the runner it minted, and only that one', async () => {
  const w = slots();
  // Slot 1's runner is up and waiting for its job; a second start in that slot is refused (its script: still running).
  const first = await w.rs.start(w.project, w.machine, { os: 'linux', slot: 1, labels: ['x'] });
  w.agentOk = false;
  const r = await w.rs.start(w.project, w.machine, { os: 'linux', slot: 1, labels: ['x'] });
  assert.equal(r.ok, false);
  const job = w.sent[1];
  assert.ok(job.op === 'start');
  assert.equal(w.rs.once.take(job.once), null);
  await until('the refused runner is gone', () => w.listed.length === 1);
  assert.deepEqual(
    w.listed.map((x) => x.name),
    [first.name],
  );
});

test('an end takes off only the runner it names, and waits out one GitHub still calls busy or a list that failed', async () => {
  const w = slots();
  const one = await w.rs.start(w.project, w.machine, { os: 'windows', slot: 1, labels: ['x'] });
  await w.rs.start(w.project, w.machine, { os: 'windows', slot: 2, labels: ['x'] });
  // Another machine's runner and a standing runner share the repo: never touched.
  w.listed.push({ id: 1, name: poolName(w.machine.id + 1, 'windows', 1, 7), status: 'online', busy: false, labels: [] }, { id: 2, name: 'DESK-peek-auras', status: 'online', busy: false, labels: [] });
  const slot1 = w.listed[0];
  slot1.busy = true;
  // The first list fails; GitHub sees the killed runner go only on the look after.
  w.listFails = 1;
  w.afterList = () => {
    w.lists++;
    slot1.busy = false;
  };
  assert.equal(await w.rs.cleanUp(w.project, one.name), true);
  assert.equal(w.lists, 2);
  assert.deepEqual(
    w.listed.map((x) => x.name.replace(/[^-]+$/, '')),
    [`pool-m${w.machine.id}-w2-`, `pool-m${w.machine.id + 1}-w1-`, 'DESK-peek-'],
  );
  // Gone already (a one-job runner that ran its job): nothing to do.
  assert.equal(await w.rs.cleanUp(w.project, one.name), true);
});

test("a late end report takes off only its own runner, never the slot's next one", async () => {
  const w = slots();
  const old = await w.rs.start(w.project, w.machine, { os: 'linux', slot: 1, labels: ['x'] });
  // The agent's ended report for the old runner waits in its outbox while the slot's next runner starts.
  const next = await w.rs.start(w.project, w.machine, { os: 'linux', slot: 1, labels: ['x'] });
  w.rs.report(w.machine, { scheme: w.project.id, slot: 1, os: 'linux', event: 'ended', runner: old.name });
  await until('the old runner is gone', () => !w.listed.some((x) => x.name === old.name));
  assert.deepEqual(
    w.listed.map((x) => x.name),
    [next.name],
  );
});

test("an agent's ended report cleans up its runner; one for a scheme that's gone is refused", async () => {
  const w = slots();
  const seen: string[] = [];
  w.rs.onReport = (r) => seen.push(`${r.event}${r.code ?? ''}`);
  const { name } = await w.rs.start(w.project, w.machine, { os: 'windows', slot: 3, labels: ['x'] });
  w.rs.report(w.machine, { scheme: w.project.id, slot: 3, os: 'windows', event: 'took', runner: name, job: 'test' });
  assert.equal(w.listed.length, 1);
  w.rs.report(w.machine, { scheme: w.project.id, slot: 3, os: 'windows', event: 'ended', runner: name, code: 0 });
  await until('the ended runner is gone', () => w.listed.length === 0);
  assert.deepEqual(seen, ['took', 'ended0']);
  assert.throws(() => w.rs.report(w.machine, { scheme: 999, slot: 3, os: 'windows', event: 'ended', runner: name }), { status: 404 });
  // A machine that hosts no CI can't make Citadel list a scheme's runners.
  const laptop = w.store.createMachine('laptop', 'x', 'Cara', w.store.getProject(w.project.id)!.owner_id!);
  assert.throws(() => w.rs.report(laptop, { scheme: w.project.id, slot: 3, os: 'windows', event: 'ended', runner: poolName(laptop.id, 'windows', 3) }), { status: 404 });
});
