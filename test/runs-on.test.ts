import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { CLEAR, KEEP, RUN_HERE, RunsOn, UNSEEN_MS } from '../src/runs-on.ts';
import { bootServer, fakeClaude, lines, ok, tempRoot, type Booted } from './helpers.ts';
import { until } from './wait.ts';

// "Runs on" (Build 7 T4). Cara, 2026-11-25, for a minion that needs one machine: "Add it to Build 7 now".
const root = tempRoot('runs-on-');
let srv: Booted | undefined;
after(async () => {
  await srv?.stop();
  await root.teardown();
});

const store = new Store(join(root.dir, 'unit.db'));
const T = Date.UTC(2026, 10, 25, 20);
function marks() {
  const s = { now: T, asked: [] as { id: number; why: string }[], settled: [] as string[], changed: [] as number[] };
  const build = () =>
    new RunsOn({
      store,
      ask: (id, card) => {
        s.asked.push({ id, why: card.question });
        return `card${s.asked.length}`;
      },
      settle: (_id, card) => void s.settled.push(card),
      changed: (id) => void s.changed.push(id),
      now: () => s.now,
    });
  return { s, build, on: build() };
}
const desk = { machine: 3, name: 'desk' };
const never = { why: 'it is not lent to this scheme', never: true as const };

test('nothing saved is anywhere, and a mark holds across a restart until it is cleared', () => {
  const { on, build, s } = marks();
  assert.deepEqual([on.needs(1), on.view(1)], [null, null]);
  on.set(1, desk, 'Josh');
  on.set(2, { machine: null, name: 'perigee' }, 'Cara');
  const later = build();
  assert.deepEqual([later.needs(1), later.needs(2)], [3, 0]);
  assert.deepEqual(later.view(1), { on: 'desk', machine: 3, by: 'Josh', at: T });
  later.set(1, null, 'Josh');
  later.set(2, null, 'Josh');
  assert.deepEqual([build().needs(1), build().needs(2)], [null, null]);
  assert.deepEqual(s.changed, [1, 2, 1, 2]);
});

test('one card where it can never run, a day after it went away, or a day into its wait; not for a wait that can end', () => {
  const { on, s } = marks();
  on.set(10, desk, 'Josh');
  on.stuck(10, T, { why: 'busy: 1 of 1 worker' });
  on.stuck(10, T, { why: 'away since today', since: T - UNSEEN_MS + 1 });
  assert.equal(s.asked.length, 0);
  on.stuck(10, T, { why: 'away since yesterday', since: T - UNSEEN_MS });
  assert.equal(s.asked.length, 1);
  on.stuck(10, T, never);
  assert.equal(s.asked.length, 1, 'asked already');
  on.set(11, desk, 'Josh');
  on.stuck(11, T, never);
  assert.match(s.asked[1].why, /marked to run only on desk.*it is not lent to this scheme/);
  on.set(12, desk, 'Josh');
  on.stuck(12, T - UNSEEN_MS, { why: 'busy: 1 of 1 worker' });
  assert.equal(s.asked.length, 3, 'a whole day in line');
  for (const id of [10, 11, 12]) on.set(id, null, 'Josh');
  assert.deepEqual(s.settled, ['card1', 'card2', 'card3'], 'a changed mark takes its card back');
});

test('Run this turn at perigee is for one turn; Keep waiting asks again in a day; Clear is anywhere', () => {
  const { on, s } = marks();
  on.set(20, desk, 'Josh');
  on.stuck(20, T, never);
  assert.equal(on.answer(20, 'something of their own'), false);
  assert.equal(on.answer(20, RUN_HERE), true);
  assert.equal(on.needs(20), 0);
  on.stuck(20, T, never);
  assert.equal(s.asked.length, 1, 'not asked while its turn is on its way');
  on.over(20);
  assert.equal(on.needs(20), 3, 'the next one waits for it again');
  on.stuck(20, T, never);
  assert.equal(on.answer(20, KEEP), true);
  s.now += UNSEEN_MS - 1;
  on.stuck(20, T, never);
  assert.equal(s.asked.length, 2);
  s.now += 1;
  on.stuck(20, T, never);
  assert.equal(s.asked.length, 3);
  assert.equal(on.answer(20, CLEAR), true);
  assert.deepEqual([on.needs(20), on.view(20)], [null, null]);
});

test("a mark follows its machine's new name", () => {
  const { on, build } = marks();
  on.set(40, desk, 'Josh');
  on.set(41, { machine: 4, name: 'desk' }, 'Josh');
  on.renamed(3, 'desk', 'desk-2');
  const later = build();
  assert.deepEqual([later.view(40)?.on, later.view(41)?.on], ['desk-2', 'desk']);
});

test('a start takes back a card still open', () => {
  const { on, s } = marks();
  on.set(30, desk, 'Josh');
  on.stuck(30, T, never);
  on.over(30);
  assert.deepEqual(s.settled, ['card1']);
  on.over(30);
  assert.equal(s.settled.length, 1);
});

test('a marked minion waits for its machine with perigee free, shows blocked, and asks its owner when it can never run there', async () => {
  const log = join(root.dir, 'heard.log');
  srv = await bootServer({ root: root.dir, env: { CLAUDE_BIN: fakeClaude(root.dir, { log: { path: log } }) } });
  const call = async (path: string, body?: unknown, method?: string) => ok(await srv!.call(path, body, method));
  const project = await call('/api/projects', { name: 'P' });
  const { machine } = await call('/api/machines', { name: 'w1', mine: true });
  const runsOn = (id: number, on: unknown) => srv!.call(`/api/tickets/${id}/runs-on`, { on }, 'PUT');
  const make = (runs_on: string) => srv!.call(`/api/projects/${project.id}/tickets`, { message: `on ${runs_on}`, runs_on });
  assert.match((await make('w1')).data.error, /w1.*Minion turns off/, 'its switch is off');
  assert.match((await make('nowhere')).data.error, /anywhere, perigee or w1/);
  await call(`/api/machines/${machine.id}`, { lend: { server: null, workspaces: [], worker: true } }, 'PATCH');
  assert.match((await make('w1')).data.error, /not lent to this scheme/);
  await call(`/api/machines/${machine.id}`, { projects: [project.id] }, 'PATCH');

  const t = ok(await make('w1'));
  const view = async () => (await call(`/api/tickets/${t.id}`)).ticket;
  const waits = await view();
  assert.deepEqual([waits.state, waits.note, waits.worker_wait.machine, waits.runs_on.on], ['blocked', 'Waiting for w1: it has not connected yet', { name: 'w1', why: 'it has not connected yet' }, 'w1']);
  assert.notEqual(waits.status, 'running');
  // One with no mark goes ahead of it, at perigee.
  const free = ok(await make('anywhere'));
  await until('the unmarked one to run', () => lines(log).length === 1);
  assert.equal((await call(`/api/tickets/${free.id}`)).ticket.runs_on, null);

  // The owner takes it off the scheme: it can never run there, so the card.
  await call(`/api/machines/${machine.id}`, { projects: [] }, 'PATCH');
  const cards = async () => (await call(`/api/tickets/${t.id}/events?after=0`)).filter((e: { kind: string }) => e.kind === 'question').map((e: { data: string | object }) => (typeof e.data === 'string' ? JSON.parse(e.data) : e.data));
  const [card] = await until('its card', async () => ((await cards()).length ? await cards() : null));
  assert.match(card.questions[0].question, /only on w1.*not lent to this scheme/);
  assert.deepEqual(
    card.questions[0].options.map((o: { label: string }) => o.label),
    [RUN_HERE, KEEP, CLEAR],
  );
  assert.equal(card.to, 'Cara', 'to its owner');
  const answer = (pick: string) => call(`/api/tickets/${t.id}/answer`, { questionId: card.id, answers: [{ selected: [pick], other: '' }] });
  await answer(RUN_HERE);
  await until('its turn to run at perigee', () => lines(log).length === 2);
  await until('that turn to end', async () => !(await view()).turn_live && !(await view()).queued);
  assert.equal((await view()).runs_on.on, 'w1', 'the mark stays');

  // The next waits again, until the mark is cleared from its menu.
  await call(`/api/tickets/${t.id}/messages`, { text: 'again' });
  await until('it to wait again', async () => (await view()).worker_wait?.machine);
  assert.equal((await view()).worker_wait.machine.never, true);
  assert.equal((await runsOn(t.id, 'w1')).status, 403, 'not lent: not to be picked');
  // Words added to a pick reach the minion as well; a stop takes the open card back.
  const again = (await until('its next card', async () => ((await cards()).length > 1 ? await cards() : null)))[1];
  ok(await srv!.call(`/api/tickets/${t.id}/answer`, { questionId: again.id, answers: [{ selected: [KEEP], other: 'use the small dataset' }] }));
  await until('the words to be queued', async () => (await view()).queued === 2);
  ok(await runsOn(t.id, 'anywhere'));
  await until('it to run at perigee', () => lines(log).length === 3);
  assert.match(JSON.stringify(lines(log)[2]), /small dataset/);
  const menu = await call(`/api/tickets/${t.id}/runs-on`);
  assert.deepEqual(menu, { runs_on: null, machines: [{ id: machine.id, name: 'w1', why: 'it is not lent to this scheme' }] });
  ok(await runsOn(t.id, 'perigee'));
  assert.equal((await view()).runs_on.on, 'perigee');
});
