// CI runners join schemes by themselves (#2064): a scheme that needs a runner gets one on a PC lending it CI, with no one
// asking; an unticked scheme's runners come off; only when no PC lends CI while jobs wait do its members get a card.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askedIn, BUSY_MS, CiAuto, type CiAutoDeps, noMachineCard, osOfLabel, RETRY_MS, type Os } from '../src/ci-auto.ts';
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
  const settled: { ticket: number; question: string; line: string }[] = [];
  const taskmaster = store.createTicket({ project_id: delve.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Claude' });
  const deps: CiAutoDeps = {
    store,
    runnerMachines: (os) => store.listMachines().filter((m) => online.get(os)!.has(m.id)),
    reposOn: (id, os) => samples.get(`${id}:${os}`) ?? new Set(),
    queuedLabels: () => queued,
    start: async (p, ask: RunnerAsk) => void started.push(`${ask.op} ${p.name} ${ask.os} ${ask.host}`),
    room: (id) => room.get(id) ?? null,
    card: (p, os, could) => {
      cards.push(`${p.name} ${os}: ${could.map((m) => m.name).join(', ')}`);
      store.addEvent(taskmaster.id, 'question', { id: `q${cards.length}`, questions: [noMachineCard(store, p, os, could)] });
    },
    settle: (card, line) => {
      settled.push({ ...card, line });
      const e = store.openCardsOf(card.ticket).find((q) => JSON.parse(q.data).id === card.question)!;
      store.setEventData(e.id, { ...JSON.parse(e.data), settled: { at: now, by: 'Citadel' } });
    },
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
    settled,
    taskmaster,
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

test('an open no-machine card is withdrawn once a PC lends the scheme CI, and on nothing less (#2220)', async () => {
  const w = world();
  const other = w.store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras.git', w.cara.id);
  const pc = w.pc('cara-desktop', w.cara.id, [other.id]);
  w.up(pc);
  w.queued.set('caraminden/delve', new Set(['delve-ci-linux']));
  await w.auto.pass();
  assert.equal(w.cards.length, 1);
  // ShipWatch's read goes empty (a restart, a cancelled job), or a leftover runner shows that remove() takes off: still true.
  w.queued.clear();
  w.samples.set(`${pc.id}:linux`, new Set(['caraminden/delve']));
  await w.auto.pass();
  assert.equal(w.settled.length, 0);
  // Someone ticks Delve there: nothing is left to ask, so the card goes before anyone answers it.
  w.store.writeMachineRoles(pc.id, (roles) => roles.map((r) => (r.role === 'ci' ? { ...r, projects: [other.id, w.delve.id] } : r)));
  await w.auto.pass();
  await w.auto.pass();
  assert.deepEqual(
    w.settled.map((s) => [s.ticket, s.question]),
    [[w.taskmaster.id, 'q1']],
  );
  assert.match(w.settled[0].line, /cara-desktop/);
  // Unticked again with jobs waiting: a new card at once, not after the week's wait.
  w.store.writeMachineRoles(pc.id, (roles) => roles.map((r) => (r.role === 'ci' ? { ...r, projects: [other.id] } : r)));
  w.samples.clear();
  w.queued.set('caraminden/delve', new Set(['delve-ci-linux']));
  await w.auto.pass();
  assert.equal(w.cards.length, 2);
});

test("the card comes down from a chat that isn't the scheme's Taskmaster any more, and other cards there stay (#2220)", async () => {
  const w = world();
  w.pc('cara-desktop', w.cara.id, [w.delve.id]);
  const old = w.store.createTicket({ project_id: w.delve.id, title: 'was the Taskmaster', permission_mode: 'default', created_by: 'Claude' });
  w.store.addEvent(old.id, 'question', { id: 'ci', questions: [noMachineCard(w.store, w.delve, 'linux', [])] });
  // The scheme was renamed since: the card still carries the old name.
  w.store.addEvent(old.id, 'question', { id: 'renamed', questions: [noMachineCard(w.store, { ...w.delve, name: 'Old Name' }, 'linux', [])] });
  w.store.addEvent(old.id, 'question', { id: 'mine', questions: [{ header: 'CI runners', question: 'Add a second runner?', options: [] }] });
  await w.auto.pass();
  assert.deepEqual(
    w.settled.map((s) => [s.ticket, s.question]),
    [
      [old.id, 'ci'],
      [old.id, 'renamed'],
    ],
  );
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

test("unticking a scheme on a PC's row takes its runners off there, a CI runner host's row as Build 10 H6's boot step leaves it too", async () => {
  const w = world();
  const row = w.pc('josh-desktop', w.josh.id, []);
  const host = w.pc('cara-desktop-ci-runners', w.cara.id, [], { runner_agent: true });
  w.up(row);
  w.up(host);
  w.samples.set(`${row.id}:linux`, new Set(['caraminden/delve', 'someone/not-a-scheme']));
  w.samples.set(`${host.id}:linux`, new Set(['caraminden/delve']));
  await w.auto.pass();
  assert.deepEqual(w.started.sort(), ['remove Delve linux cara-desktop-ci-runners', 'remove Delve linux josh-desktop']);
  await w.auto.pass();
  assert.equal(w.started.length, 2, 'once each, not each pass');
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
