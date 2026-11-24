import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildOwnerKey, Store, type Ticket } from '../src/db.ts';
import { CHAIN_FLOOR, doneKey, EFFORT_KEY, effortFor, EffortRetros, effortsDue, NAMED_FLOOR, QUIET_MS, TRIES } from '../src/effort-retros.ts';

const H = 3_600_000;
const NOW = 1_800_000_000_000;
let n = 0;
const t = (over: Partial<Ticket> = {}): Ticket => ({ id: ++n, number: n, title: `T${n}`, kind: 'ticket', status: 'closed', closed_at: NOW - 7 * H, updated_at: NOW - 7 * H, created_at: NOW - 48 * H, build: null, person_id: null, ...over }) as Ticket;
const due = (tickets: Ticket[], name: string, since: (n: string) => number | undefined = () => undefined, now = NOW, major = (_b: number) => true) => effortsDue(tickets, new Map(tickets.map((x) => [x.id, name])), since, now, major);

test('a named effort retros at 3 closed minions, an unnamed chain only at 4 (#1751)', () => {
  assert.equal(NAMED_FLOOR, 3);
  assert.equal(CHAIN_FLOOR, 4);
  assert.deepEqual(due([t(), t()], 'CI speed-up'), []);
  assert.deepEqual(
    due([t(), t(), t()], 'CI speed-up').map((v) => [v.name, v.act, v.members.length]),
    [['CI speed-up', 'start', 3]],
  );
  assert.deepEqual(due([t(), t(), t()], 'chain from #12'), []);
  assert.deepEqual(
    due([t(), t(), t(), t()], 'chain from #12').map((v) => v.act),
    ['start'],
  );
  // The Taskmaster's own row never counts toward the floor.
  assert.deepEqual(due([t(), t(), t({ kind: 'coordinator' } as Partial<Ticket>)], 'CI speed-up'), []);
});

test('an effort waits until every minion has closed and stayed closed for the quiet stretch (#1751)', () => {
  assert.deepEqual(due([t(), t(), t({ status: 'idle', closed_at: null })], 'X'), [], 'one still open');
  const recent = NOW - QUIET_MS + H;
  assert.deepEqual(due([t(), t(), t({ closed_at: recent, updated_at: recent })], 'X'), [], 'last closed under 6 hours ago');
  assert.equal(due([t(), t(), t()], 'X', () => NOW - 20 * H).length, 0, 'one retro per effort');
});

test('a name reused for a later goal gets its own retro: only minions made after the last verdict count (#1751)', () => {
  const cut = NOW - 30 * H;
  const old = [t({ created_at: NOW - 60 * H }), t({ created_at: NOW - 60 * H }), t({ created_at: NOW - 60 * H })];
  const fresh = () => t({ created_at: NOW - 20 * H });
  assert.deepEqual(
    due([...old, fresh(), fresh()], 'CI speed-up', () => cut),
    [],
    'two new ones are under the floor',
  );
  const [v] = due([...old, fresh(), fresh(), fresh()], 'CI speed-up', () => cut);
  assert.equal(v.members.length, 3, "the old effort's minions are not in the new retro");
});

test('an effort that is mostly one major build is skipped: the build retro covers it (#1751)', () => {
  const [v] = due([t({ build: 4 }), t({ build: 4 }), t()], 'Build-ish');
  assert.equal(v.act, 'skip');
  assert.match(v.why, /Build 4/);
  // Half or fewer in one build is still its own effort.
  assert.equal(due([t({ build: 4 }), t({ build: 5 }), t(), t()], 'Mixed')[0].act, 'start');
  // A build number with no build minion (Delve's "found in" build on a bug) has no build retro to cover it.
  assert.equal(due([t({ build: 4 }), t({ build: 4 }), t()], 'Bugs from Build 4', undefined, NOW, () => false)[0].act, 'start');
});

test("a new minion joins its leader's effort, else its parent's; an unnamed chain is named after its leader (#1751)", () => {
  assert.deepEqual(effortFor('Given', { number: 3, effort: 'Lead' }, 'Parent'), { name: 'Given', stampLeader: false });
  assert.deepEqual(effortFor(null, { number: 3, effort: 'Lead' }, 'Parent'), { name: 'Lead', stampLeader: false });
  assert.deepEqual(effortFor(null, { number: 3, effort: null }, 'Parent'), { name: 'Parent', stampLeader: false });
  assert.deepEqual(effortFor(null, { number: 3, effort: null }, null), { name: 'chain from #3', stampLeader: true });
  assert.deepEqual(effortFor(null, null, null), { name: null, stampLeader: false });
});

test('the tick starts one retro minion in a scheme that is not Citadel, and records a build skip once (#1751)', async () => {
  const store = new Store(':memory:');
  const peek = store.createProject('Peek', null);
  const other = store.createProject('Quiet', null);
  const mk = (p: number, effort: string, build?: number) => {
    const x = store.createTicket({ project_id: p, title: `${effort} part`, permission_mode: 'default', created_by: 'Cara' });
    store.props.set('minion', x.id, p, { [EFFORT_KEY]: effort, assigned: 'Cara' }, 'test');
    if (build) store.updateTicket(x.id, { build });
    store.updateTicket(x.id, { status: 'closed' });
    return x;
  };
  for (let i = 0; i < 3; i++) mk(peek.id, 'Overlay rewrite');
  for (let i = 0; i < 3; i++) mk(other.id, 'Build work', 2);
  store.setSetting(buildOwnerKey(other.id, 2), 999); // Build 2 has its own build minion, whose retro covers it
  mk(other.id, 'Too small');
  const made: { project: number; title: string; props: Record<string, string> }[] = [];
  const sent: { id: number; text: string }[] = [];
  const retros = new EffortRetros({
    store,
    by: 'Citadel',
    now: () => Date.now() + QUIET_MS + H,
    newMinion: async (project, m) => {
      made.push({ project: project.id, title: m.title, props: m.props });
      const x = store.createTicket({ project_id: project.id, title: m.title, permission_mode: 'default', created_by: 'Citadel' });
      return { id: x.id, number: x.number! };
    },
    runner: {
      emit: () => {},
      send: (id: number, _by: string, text: string) => {
        sent.push({ id, text });
      },
    } as any,
    note: () => {},
    mode: 'act',
  });
  const said = await retros.tick();
  assert.deepEqual(
    made.map((m) => [m.project, m.title, m.props.type, m.props.assigned]),
    [[peek.id, 'Retro: Overlay rewrite', 'research', 'Cara']],
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /citadel:retro/);
  assert.match(sent[0].text, /"Overlay rewrite" in Peek/);
  assert.ok(store.getSetting<{ at?: number }>(doneKey(peek.id, 'Overlay rewrite'))?.at, 'a start keeps its time, for the replay');
  assert.equal(store.getSetting<{ act: string }>(doneKey(other.id, 'Build work'))?.act, 'skip');
  assert.equal(store.getSetting(doneKey(other.id, 'Too small')), null);
  assert.equal(said.length, 2);
  // A second tick starts nothing more.
  assert.deepEqual(await retros.tick(), []);
  assert.equal(made.length, 1);
});

test('log-only notes the retro it would start, and acting later starts it after all (#1751)', async () => {
  const store = new Store(':memory:');
  const peek = store.createProject('Peek', null);
  for (let i = 0; i < 3; i++) {
    const x = store.createTicket({ project_id: peek.id, title: 'part', permission_mode: 'default', created_by: 'Cara' });
    store.props.set('minion', x.id, peek.id, { [EFFORT_KEY]: 'Overlay rewrite' }, 'test');
    store.updateTicket(x.id, { status: 'closed' });
  }
  const made: string[] = [];
  const notes: string[] = [];
  const deps = {
    store,
    by: 'Citadel',
    now: () => Date.now() + QUIET_MS + H,
    newMinion: async (project: any, m: { title: string }) => {
      made.push(m.title);
      const x = store.createTicket({ project_id: project.id, title: m.title, permission_mode: 'default', created_by: 'Citadel' });
      return { id: x.id, number: x.number! };
    },
    runner: { emit: () => {}, send: () => {} } as any,
    note: (line: string) => {
      notes.push(line);
    },
  };
  await new EffortRetros({ ...deps, mode: 'log-only' }).tick();
  assert.deepEqual(made, []);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /would · effort-retros · start a retro · Peek · Overlay rewrite/);
  assert.equal(store.getSetting<{ act: string }>(doneKey(peek.id, 'Overlay rewrite'))?.act, 'would');
  await new EffortRetros({ ...deps, mode: 'log-only' }).tick();
  assert.equal(notes.length, 1, 'noted once');
  await new EffortRetros({ ...deps, mode: 'act' }).tick();
  assert.deepEqual(made, ['Retro: Overlay rewrite']);
});

test('a start that fails is tried again on later ticks, three times in all (#1751)', async () => {
  const store = new Store(':memory:');
  const peek = store.createProject('Peek', null);
  for (let i = 0; i < 3; i++) {
    const x = store.createTicket({ project_id: peek.id, title: 'part', permission_mode: 'default', created_by: 'Cara' });
    store.props.set('minion', x.id, peek.id, { [EFFORT_KEY]: 'Overlay rewrite' }, 'test');
    store.updateTicket(x.id, { status: 'closed' });
  }
  let fails = 0;
  let made = 0;
  const retros = new EffortRetros({
    store,
    by: 'Citadel',
    now: () => Date.now() + QUIET_MS + H,
    newMinion: async (project, m) => {
      if (fails-- > 0) throw new Error('no worktree');
      made++;
      const x = store.createTicket({ project_id: project.id, title: m.title, permission_mode: 'default', created_by: 'Citadel' });
      return { id: x.id, number: x.number! };
    },
    runner: { emit: () => {}, send: () => {} } as any,
    note: () => {},
    mode: 'act',
  });
  const errors = console.error;
  console.error = () => {};
  try {
    fails = 1;
    await retros.tick();
    assert.equal(store.getSetting<{ act: string }>(doneKey(peek.id, 'Overlay rewrite'))?.act, 'failed');
    await retros.tick();
    assert.equal(made, 1, 'the next tick starts it');
    // One that keeps failing stops after TRIES.
    store.deleteSetting(doneKey(peek.id, 'Overlay rewrite'));
    made = 0;
    fails = 99;
    for (let i = 0; i < TRIES + 2; i++) await retros.tick();
    assert.equal(fails, 99 - TRIES);
    assert.equal(made, 0);
  } finally {
    console.error = errors;
  }
});
