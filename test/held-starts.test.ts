import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.ts';
import { HeldStarts, HOLD_MAX_MS } from '../src/held-starts.ts';
import { ScheduledRuns } from '../src/schedules.ts';

const reading = (starved: boolean) => ({ cpu: starved ? 63 : 5, mem: 0, starved, why: starved ? 'CPU pressure 63%' : '' });

function setup(initial = true) {
  const store = new Store(':memory:');
  const project = store.createProject('One', null);
  let starved = initial, t = 1_700_000_000_000;
  const sent: { id: number; text: string }[] = [];
  const notes: string[] = [];
  const runner = { emit: (_i: number, _k: string, d: any) => { notes.push(d.text); }, send: (id: number, _a: string, text: string) => { sent.push({ id, text }); return {} as any; } };
  const held = new HeldStarts({ store, runner: runner as any, read: async () => reading(starved), now: () => t });
  return { store, project, held, sent, notes, runner, set: (v: boolean) => { starved = v; }, tick: (ms: number) => { t += ms; } };
}
const mkTicket = (s: ReturnType<typeof setup>) => s.store.createTicket({ project_id: s.project.id, title: 'A run', permission_mode: 'bypass', created_by: 'Citadel' } as any);

test('starved: the brief is held and the minion parked; cleared: the tick sends it once', async () => {
  const s = setup();
  const id = mkTicket(s).id;
  const send = () => s.runner.send(id, 'Citadel', 'brief');
  assert.equal(await s.held.start({ ticket: id, from: 'Citadel', message: 'brief', opts: {} }, send), true);
  assert.equal(s.sent.length, 0);
  assert.equal(s.store.getTicket(id)?.state, 'parked');
  assert.match(s.store.getTicket(id)?.note ?? '', /^Waiting for the box \(CPU 63%\), starts by /);
  await s.held.tick(); assert.equal(s.sent.length, 0); // still starved, not 10 minutes yet
  s.set(false); s.tick(1000);
  await s.held.tick(); await s.held.tick();
  assert.deepEqual(s.sent.map((x) => x.text), ['brief']); // once only
  assert.equal(s.store.getTicket(id)?.state, null);
});

test('not starved: sent at once, nothing held', async () => {
  const s = setup(false);
  const id = mkTicket(s).id;
  assert.equal(await s.held.start({ ticket: id, from: 'Citadel', message: 'b', opts: {} }, () => s.runner.send(id, 'Citadel', 'b')), false);
  assert.equal(s.sent.length, 1); assert.equal(s.held.has(id), false);
});

test('sent after 10 minutes even while starved', async () => {
  const s = setup();
  const id = mkTicket(s).id;
  await s.held.start({ ticket: id, from: 'Citadel', message: 'b', opts: {} }, () => {});
  s.tick(HOLD_MAX_MS - 1); await s.held.tick(); assert.equal(s.sent.length, 0);
  s.tick(1); await s.held.tick(); assert.equal(s.sent.length, 1);
});

test('Unpark (release) sends at once with no pressure check, and only once', async () => {
  const s = setup();
  const id = mkTicket(s).id;
  await s.held.start({ ticket: id, from: 'Citadel', message: 'b', opts: {} }, () => {});
  assert.match(s.held.wakesOn(id) ?? '', /^the box has room, or by /);
  assert.equal(s.held.release(id, 'Cara unparked it'), true);
  assert.equal(s.held.release(id, 'again'), false);
  assert.equal(s.sent.length, 1);
});

test('a restart mid-hold: a new HeldStarts on the same store sends it once', async () => {
  const s = setup();
  const id = mkTicket(s).id;
  await s.held.start({ ticket: id, from: 'Citadel', message: 'b', opts: {} }, () => {});
  const again = new HeldStarts({ store: s.store, runner: s.runner as any, read: async () => reading(false) });
  await again.tick(); await again.tick(); await s.held.tick();
  assert.equal(s.sent.length, 1);
});

test('a schedule run held for the box says how long in its log, and still sends its brief', async () => {
  const s = setup();
  const sch = s.store.schedules.create({ project_id: s.project.id, name: 'Nightly', cron: '0 3 * * *', brief: 'go', type: 'chore', created_by: 'Cara' }, 1000);
  const runs = new ScheduledRuns({
    store: s.store, held: s.held, runner: s.runner as any, broadcast: () => {}, by: 'Citadel', dataDir: '/tmp',
    newMinion: async (p, m, by) => { const t: any = s.store.createTicket({ project_id: p.id, title: m.title, permission_mode: 'bypass', created_by: by } as any); return { id: t.id, number: t.number }; },
  });
  await runs.run(s.store.schedules.get(sch.id)!);
  assert.equal(s.sent.length, 0);
  s.set(false); s.tick(4 * 60_000); await s.held.tick();
  assert.equal(s.sent.length, 1);
  assert.match(s.store.schedules.get(sch.id)!.last_skip ?? '', /^Held 4 min for the box/);
});

test('a person, a Taskmaster, a follow-on and a wake never read the pressure', async () => {
  // The reader is only given to HeldStarts, which only ScheduledRuns and the flake fixer call, and by server.ts to the
  // runner's line of kill resumes (#1364), which holds only those; runner.send has no gate.
  const { readFileSync } = await import('node:fs');
  const runner = readFileSync(new URL('../src/runner.ts', import.meta.url), 'utf8');
  const wake = readFileSync(new URL('../src/wake.ts', import.meta.url), 'utf8');
  assert.ok(!/pressure/.test(runner) && !/pressure|held-starts/.test(wake));
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  assert.equal(server.match(/heldStarts\.start\(/g)?.length, 1); // the flake fixer's; the schedule's is in schedules.ts
});
