// CI runners join schemes by themselves (#2064): a scheme that needs a runner gets one on a PC lending it CI, with no one
// asking; an unticked scheme's runners come off; only when no PC lends CI while jobs wait do its members get a card.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askedIn, BUSY_MS, CiAuto, type CiAutoDeps, osOfLabel, RETRY_MS, type Os } from '../src/ci-auto.ts';
import { type RunnerAsk, RunnerBusy } from '../src/ci-runner.ts';
import { Store } from '../src/db.ts';

function world() {
  const store = new Store(':memory:');
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const delve = store.createProject('Delve', 'https://github.com/caraminden/delve.git', cara.id);
  store.addMember(delve.id, josh.id);
  const pc = (name: string, owner: number, lent: number[], setup: Record<string, unknown> = { runner_agent: true }, priority: number | null = null) => {
    const m = store.createMachine(name, `h-${name}`, 'Cara', owner);
    if (priority !== null) store.updateMachine(m.id, { priority });
    store.writeMachineRoles(m.id, (roles) => roles.map((r) => (r.role === 'ci' ? { ...r, on: true, projects: lent, setup } : r)));
    return store.getMachine(m.id)!;
  };
  const online = new Map<string, Set<number>>([
    ['windows', new Set()],
    ['linux', new Set()],
  ]);
  const samples = new Map<string, Set<string>>();
  const queued = new Map<string, Set<string>>();
  const room = new Map<number, number>();
  let workflows: Record<number, string[]> = {};
  let now = 1_000_000;
  const started: string[] = [];
  const cards: string[] = [];
  const deps: CiAutoDeps = {
    store,
    runnerMachines: (os) => store.listMachines().filter((m) => online.get(os)!.has(m.id)),
    reposOn: (id, os) => samples.get(`${id}:${os}`) ?? new Set(),
    queuedLabels: () => queued,
    start: async (p, ask: RunnerAsk) => void started.push(`${ask.op} ${p.name} ${ask.os} ${ask.host}`),
    room: (id) => room.get(id) ?? null,
    card: (p, os, could) => void cards.push(`${p.name} ${os}: ${could.map((m) => m.name).join(', ')}`),
    workflows: async (p) => workflows[p.id] ?? [],
    now: () => now,
    log: () => {},
  };
  const up = (m: { id: number }, os: Os = 'linux') => online.get(os)!.add(m.id);
  return {
    store,
    cara,
    josh,
    delve,
    pc,
    up,
    samples,
    queued,
    room,
    started,
    cards,
    setWorkflows: (w: Record<number, string[]>) => (workflows = w),
    tick: (ms: number) => (now += ms),
    auto: new CiAuto(deps),
  };
}

const LINUX_CI = 'jobs:\n  test:\n    runs-on: [self-hosted, delve-ci-linux]\n';

test("a scheme's labels say which runner it asks for; another scheme's or a session runner's don't count", () => {
  assert.equal(osOfLabel('Delve', 'delve-ci-linux'), 'linux');
  assert.equal(osOfLabel('Delve', 'Delve-CI'), 'windows');
  assert.equal(osOfLabel('Delve', 'delve-ci-side'), 'windows');
  assert.equal(osOfLabel('Delve', 'delve-ci-linux-long'), 'linux');
  assert.equal(osOfLabel('Delve', 'delve-desktop'), null);
  assert.equal(osOfLabel('Delve', 'delve-ci-other'), null);
  assert.deepEqual([...askedIn('Delve', [LINUX_CI])], ['linux']);
  assert.deepEqual([...askedIn('Delve', ['runs-on: delve-ci\n', 'runs-on: [self-hosted, delve-ci-linux]'])].sort(), ['linux', 'windows']);
  assert.deepEqual([...askedIn('Delve', ['runs-on: not-delve-ci-linux', 'runs-on: delve-ci-linuxx'])], []);
  assert.deepEqual([...askedIn('Peek Auras', ['runs-on: [self-hosted, peek-auras-ci-linux]'])], ['linux']);
});

test("a workflow asking for the scheme's runner gets one on each PC lending it CI, in the owner's order, with no one asking", async () => {
  const w = world();
  const a = w.pc('josh-laptop', w.josh.id, [w.delve.id], undefined, 2);
  const b = w.pc('josh-desktop', w.josh.id, [w.delve.id], undefined, 1);
  w.up(a);
  w.up(b);
  w.room.set(a.id, 8);
  w.room.set(b.id, 2);
  w.setWorkflows({ [w.delve.id]: [LINUX_CI] });
  await w.auto.pass();
  assert.deepEqual(w.started, ['add Delve linux josh-desktop'], "one job a pass, the owner's first machine first, though the other has more room");
  assert.ok(w.auto.asking.has('caraminden/delve'), 'ShipWatch reads its queued jobs from now on');
  // The next pass: the other PC, and josh-desktop isn't asked again within the retry time though its runner isn't in a sample yet.
  await w.auto.pass();
  assert.deepEqual(w.started, ['add Delve linux josh-desktop', 'add Delve linux josh-laptop']);
  // Once each PC's sample lists runners for the repo, it's served: nothing more, even after the retry time.
  w.samples.set(`${b.id}:linux`, new Set(['caraminden/delve']));
  w.samples.set(`${a.id}:linux`, new Set(['caraminden/delve']));
  w.tick(RETRY_MS + 1);
  await w.auto.pass();
  assert.equal(w.started.length, 2);
  assert.deepEqual(w.cards, []);
});

test('a PC the scheme is unticked on is never picked; with none lending, waiting jobs bring one card naming the PCs that could', async () => {
  const w = world();
  const other = w.store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras.git', w.cara.id);
  const elsewhere = w.pc('cara-desktop', w.cara.id, [other.id]);
  w.up(elsewhere);
  w.setWorkflows({ [w.delve.id]: [LINUX_CI] });
  await w.auto.pass();
  assert.deepEqual(w.started, []);
  assert.deepEqual(w.cards, [], 'no card while nothing waits');
  // Now a job waits for it, and no connected PC serves Delve: one card naming the PC that could be lent.
  w.queued.set('caraminden/delve', new Set(['delve-ci-linux']));
  await w.auto.pass();
  await w.auto.pass();
  assert.deepEqual(w.started, []);
  assert.deepEqual(w.cards, ['Delve linux: cara-desktop'], 'one card, not one a pass');
  // A PC that lends Delve CI but is asleep: the jobs wait for it, and nobody is asked again.
  w.tick(8 * 24 * 3600_000);
  const asleep = w.pc('josh-laptop', w.josh.id, [w.delve.id]);
  await w.auto.pass();
  assert.deepEqual(w.cards, ['Delve linux: cara-desktop']);
  w.store.writeMachineRoles(asleep.id, (roles) => roles.map((r) => (r.role === 'ci' ? { ...r, projects: [] } : r)));
  // Ticking Delve there: the next pass registers it there.
  w.store.writeMachineRoles(elsewhere.id, (roles) => roles.map((r) => (r.role === 'ci' ? { ...r, projects: [other.id, w.delve.id] } : r)));
  await w.auto.pass();
  assert.deepEqual(w.started, ['add Delve linux cara-desktop']);
});

test('a queued job with a label no runner has gets one even with no workflow file read; a failed add waits longer, a busy agent only a few minutes', async () => {
  const w = world();
  const m = w.pc('josh-desktop', w.josh.id, [w.delve.id]);
  w.up(m, 'windows');
  w.queued.set('caraminden/delve', new Set(['delve-ci', 'windows-latest']));
  const failing = new CiAuto({
    ...(w.auto as unknown as { d: CiAutoDeps }).d,
    start: async () => {
      w.started.push('tried');
      throw new Error('busy');
    },
  });
  await failing.pass();
  w.tick(RETRY_MS + 1);
  await failing.pass();
  assert.deepEqual(w.started, ['tried'], 'a failure backs off past the ordinary retry');
  await w.auto.pass();
  assert.deepEqual(w.started, ['tried', 'add Delve windows josh-desktop']);
  // Another scheme's job holds the agent (409): tried again within minutes, not hours.
  const peek = w.store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras.git', w.cara.id);
  w.store.addMember(peek.id, w.josh.id);
  w.store.writeMachineRoles(m.id, (roles) => roles.map((r) => (r.role === 'ci' ? { ...r, projects: [w.delve.id, peek.id] } : r)));
  w.queued.set('caraminden/peek-auras', new Set(['peek-auras-ci']));
  let busy = true;
  const shared = new CiAuto({
    ...(w.auto as unknown as { d: CiAutoDeps }).d,
    start: async (p, ask) => {
      if (busy) throw new RunnerBusy("The runner agent on josh-desktop is busy with another scheme's job");
      w.started.push(`${ask.op} ${p.name} ${ask.os} ${ask.host}`);
    },
  });
  w.samples.set(`${m.id}:windows`, new Set(['caraminden/delve']));
  await shared.pass();
  busy = false;
  w.tick(BUSY_MS + 1);
  await shared.pass();
  assert.deepEqual(w.started.at(-1), 'add Peek Auras windows josh-desktop');
});

test("unticking a scheme on a PC's own row takes its runners off there; a CI runner host from before keeps what people added", async () => {
  const w = world();
  const row = w.pc('josh-desktop', w.josh.id, []);
  const host = w.pc('cara-desktop-ci-runners', w.cara.id, [], { runner_host: true });
  w.up(row);
  w.up(host);
  w.samples.set(`${row.id}:linux`, new Set(['caraminden/delve', 'someone/not-a-scheme']));
  w.samples.set(`${host.id}:linux`, new Set(['caraminden/delve']));
  await w.auto.pass();
  assert.deepEqual(w.started, ['remove Delve linux josh-desktop']);
  await w.auto.pass();
  assert.equal(w.started.length, 1, 'once, not each pass');
});

test("a scheme someone joins or makes later is lent their PCs' CI; one they unticked stays unticked", () => {
  const w = world();
  const m = w.pc('josh-desktop', w.josh.id, [w.delve.id]);
  const off = w.store.createMachine('josh-laptop', 'h', 'Josh', w.josh.id);
  const later = w.store.createProject('Later', null, w.cara.id);
  w.store.addMember(later.id, w.josh.id);
  const own = w.store.createProject('Josh Own', null, w.josh.id);
  const ci = (id: number) => w.store.machineRoles(id).find((r) => r.role === 'ci')!;
  assert.deepEqual(ci(m.id).projects, [w.delve.id, later.id, own.id]);
  // An admin sees every scheme, so their CI PC, lent to all they saw when it connected, gets a scheme someone else makes too.
  const admins = w.pc('cara-desktop', w.cara.id, [w.delve.id, later.id, own.id]);
  const another = w.store.createProject('Another', null, w.josh.id);
  assert.deepEqual(ci(admins.id).projects, [w.delve.id, later.id, own.id, another.id]);
  assert.deepEqual(ci(off.id).projects, [], 'a PC with CI off is left alone');
  w.store.writeMachineRoles(m.id, (roles) => roles.map((r) => (r.role === 'ci' ? { ...r, projects: [w.delve.id] } : r)));
  w.store.addMember(later.id, w.josh.id);
  assert.deepEqual(ci(m.id).projects, [w.delve.id], 'joining again (already in) adds nothing back');
});

test('the no-machine card names the PCs members could ask, by whose they are, and what picking does', async () => {
  const { noMachineCard } = await import('../src/ci-auto.ts');
  const w = world();
  const m = w.pc('josh-desktop', w.josh.id, []);
  const q = noMachineCard(w.store, w.delve, 'linux', [m]);
  assert.match(q.question, /Delve's CI jobs are waiting for a Linux runner.*josh-desktop \(Josh's\)/);
  assert.deepEqual(
    q.options!.map((o) => o.label),
    ['Ask Josh to lend josh-desktop', 'Leave the jobs waiting'],
  );
  assert.deepEqual(
    noMachineCard(w.store, w.delve, 'windows', []).options!.map((o) => o.label),
    ["I'll connect a computer", 'Leave the jobs waiting'],
  );
});
