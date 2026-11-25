// Start now (#1957): who holds a worker of its own for a minion, for how long, two each, and the route. In Peek Auras, a
// scheme that is not Citadel's. That a held minion's turns skip the line: test/turn-line-steps.test.ts, test/turn-line.test.ts.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import type { HttpError } from '../src/http.ts';
import { urgentRoutes } from '../src/routes/urgent.ts';
import { HOLD, StartNow } from '../src/start-now.ts';

const root = mkdtempSync(join(tmpdir(), 'start-now-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

let n = 0;
function world() {
  const store = new Store(join(root, `${++n}.db`));
  const peek = store.createProject('Peek Auras', null);
  const clock = { now: 1_000_000_000 };
  const changed: number[] = [];
  const over = new Set<number>();
  const make = () => new StartNow({ store, over: (id) => over.has(id), changed: (ids) => void changed.push(...ids), now: () => clock.now });
  const minion = (kind: 'ticket' | 'coordinator' = 'ticket') => store.createTicket({ project_id: peek.id, kind, title: 'T', permission_mode: 'default', created_by: 'Cara' }).id;
  return { store, peek, clock, changed, over, make, hold: make(), minion };
}
const JOSH = 1;
const CARA = 2;
const press = (h: StartNow, id: number, user = JOSH) => h.press(id, user, user === JOSH ? 'Josh' : 'Cara');
const held = (h: StartNow) => h.list().map((x) => x.ticket);

test("a hold lasts 30 minutes from its own person's last word; nobody else's counts", () => {
  const { hold, clock, changed } = world();
  assert.equal(press(hold, 7), null);
  clock.now += HOLD.idleMs - 1;
  hold.touch(7, CARA);
  hold.touch(7, null);
  hold.touch(7, JOSH);
  clock.now += HOLD.idleMs - 1;
  hold.touch(7, CARA);
  assert.equal(hold.view(7)?.by, 'Josh');
  clock.now += 1;
  assert.deepEqual([hold.get(7), held(hold)], [null, []]);
  hold.touch(7, JOSH);
  assert.equal(hold.get(7), null, 'a word after it ended brings nothing back');
  changed.length = 0;
  hold.sweep();
  hold.sweep();
  assert.deepEqual(changed, [7], 'its page hears once');
});

test('a hold outlives a restart with its clock, and one whose time passed while Citadel was down is gone', () => {
  const { hold, clock, make, store } = world();
  press(hold, 7);
  clock.now += 10 * 60_000;
  press(hold, 8);
  clock.now += 20 * 60_000 - 1;
  assert.deepEqual(held(make()), [7, 8]);
  clock.now += 1;
  const again = make();
  again.sweep();
  assert.deepEqual([held(again), store.getSetting<unknown[]>('start-now')?.length], [[8], 1]);
  assert.equal(again.view(8)?.until, clock.now + 10 * 60_000);
  again.clear();
  assert.deepEqual([held(again), held(make())], [[], []], 'a boot check keeps none');
});

test('two each, counting who pressed; a third names them, and one let go, closed or run out makes room', () => {
  const { hold, over, clock } = world();
  press(hold, 1);
  press(hold, 2);
  const refused = press(hold, 3);
  assert.deepEqual(refused && 'full' in refused && refused.full.map((h) => h.ticket), [1, 2]);
  assert.equal(press(hold, 4, CARA), null, "Cara's are her own");
  assert.equal(press(hold, 1), null, 'again on one of theirs is no third');
  hold.end(1);
  assert.equal(press(hold, 3), null);
  over.add(2);
  assert.equal(press(hold, 5), null);
  clock.now += HOLD.idleMs;
  assert.equal(press(hold, 6), null);
  assert.deepEqual(held(hold), [6]);
});

test("one person's hold refuses another's, until it ends", () => {
  const { hold, clock } = world();
  press(hold, 1);
  const r = press(hold, 1, CARA);
  assert.equal(r && 'theirs' in r && r.theirs.by, 'Josh');
  assert.equal(hold.get(1)?.user, JOSH);
  clock.now += HOLD.idleMs;
  assert.equal(press(hold, 1, CARA), null);
  assert.equal(hold.get(1)?.by, 'Cara');
});

/** The route's handler, as the router calls it once it has let the caller in. */
async function put(app: unknown, ticket: unknown, body: unknown, session: object = { name: 'Josh', uid: JOSH, admin: true }) {
  const route = urgentRoutes.find((r) => r.path === '/api/tickets/:ticket/start-now')!;
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: { 'content-type': 'application/json' } });
  const res = { status: 0, text: '', headersSent: false, setHeader() {}, writeHead: (s: number) => ((res.status = s), res), end: (b?: string) => void (res.text = b ?? '') };
  try {
    await route.handler({ req, res, app, params: {}, session, ticket } as unknown as Parameters<typeof route.handler>[0]);
    return { status: res.status, ...JSON.parse(res.text) };
  } catch (err) {
    const e = err as HttpError;
    if (!e.status) throw err;
    return { status: e.status, error: e.message };
  }
}

test('only people press it', () => assert.deepEqual(urgentRoutes.find((r) => r.path === '/api/tickets/:ticket/start-now')!.who, ['person']));

test('the route starts a waiting minion, refuses one that is not, and names the two a person holds', async () => {
  const { store, hold, minion } = world();
  const waits = new Set<number>();
  const forced: number[] = [];
  const app = { store, runner: { startNow: hold, turnLine: { has: (id: number) => waits.has(id), force: (id: number) => void forced.push(id) } } };
  const [a, b, c, idle, shut, tm] = [minion(), minion(), minion(), minion(), minion(), minion('coordinator')];
  for (const id of [a, b, c, shut]) waits.add(id);
  store.updateTicket(shut, { status: 'closed' });
  const t = (id: number) => store.getTicket(id);
  assert.equal((await put(app, t(a), {})).status, 400);
  assert.equal((await put(app, t(tm), { on: true })).status, 400);
  assert.equal((await put(app, t(shut), { on: true })).status, 409);
  assert.match((await put(app, t(idle), { on: true })).error, /isn't waiting/);
  assert.equal((await put(app, t(a), { on: true }, { name: 'Josh' })).status, 403, 'a cookie with no person in it');
  assert.deepEqual([forced, held(hold)], [[], []], 'no refusal held or started anything');
  const r = await put(app, t(a), { on: true });
  assert.deepEqual([r.status, r.start_now.by, forced], [200, 'Josh', [a]]);
  waits.delete(a);
  assert.equal((await put(app, t(a), { on: true })).status, 200, 'a second press of the same person, once it runs');
  assert.match((await put(app, t(a), { on: true }, { name: 'Cara', uid: CARA })).error, /waiting/);
  waits.add(a);
  assert.match((await put(app, t(a), { on: true }, { name: 'Cara', uid: CARA })).error, /^Josh gave it/);
  // Two presses at once on the last free hold.
  const both = await Promise.all([put(app, t(b), { on: true }), put(app, t(c), { on: true })]);
  assert.deepEqual(both.map((x) => x.status).sort(), [200, 409]);
  const full = both.find((x) => x.status === 409)!;
  assert.deepEqual(
    full.holds.map((m: { ticket: number }) => m.ticket),
    held(hold),
  );
  assert.match(full.error, new RegExp(`#${t(a)!.number} and #`));
  const away = held(hold)[0];
  const spare = minion();
  waits.add(spare);
  const blind = { ...app, store: Object.assign(Object.create(store), { canSee: (_: unknown, p: number) => p !== 99, getTicket: (id: number) => (id === away ? { ...store.getTicket(id)!, project_id: 99 } : store.getTicket(id)) }) };
  assert.equal((await put(blind, t(spare), { on: true })).status, 200, 'one in a scheme they left neither counts nor shows');
  assert.ok(!held(hold).includes(away));
  hold.end(spare);
  assert.equal(hold.press(away, JOSH, 'Josh'), null);
  const off = await put(app, t(a), { on: false }, { name: 'Cara', uid: CARA });
  assert.deepEqual([off.status, off.start_now, held(hold).includes(a)], [200, null, false], "anyone's to release");
});
