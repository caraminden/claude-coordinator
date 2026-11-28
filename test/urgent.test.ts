// Urgent minions (#1888): who may mark one and whose choice stands, the group's order, the server's own tags, what puts a
// waiting minion where it is in its share, and the routes. In Peek Auras, a scheme that is not Citadel's.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, test } from 'node:test';
import type { RedMark } from '../src/ci-problems.ts';
import { Store } from '../src/db.ts';
import type { HttpError } from '../src/http.ts';
import { heatOf, LinePlaces, sameAccount, waitedOn } from '../src/line-place.ts';
import { urgentRoutes } from '../src/routes/urgent.ts';
import { StartNow } from '../src/start-now.ts';
import { Urgent, type UrgentBy } from '../src/urgent.ts';
import { redFixes, UrgentFixes, type RedFix } from '../src/urgent-fixes.ts';
import type { Chain } from '../src/wake.ts';

const root = mkdtempSync(join(tmpdir(), 'urgent-'));
after(() => rmSync(root, { recursive: true, force: true }));

const JOSH: UrgentBy = { kind: 'person', by: 'Josh' };
const CARA: UrgentBy = { kind: 'person', by: 'Cara' };
const TM: UrgentBy = { kind: 'taskmaster', by: 'Peek Auras Taskmaster', reason: 'the release waits on it' };
const SERVER: UrgentBy = { kind: 'server', by: 'Citadel', reason: 'Fixing main', cause: 'red:1:7' };

let n = 0;
function world() {
  const store = new Store(join(root, `${++n}.db`));
  const peek = store.createProject('Peek Auras', null);
  const changed: number[] = [];
  const urgent = new Urgent(store, (ids) => changed.push(...ids));
  const minion = (project = peek.id, kind: 'ticket' | 'coordinator' = 'ticket') => store.createTicket({ project_id: project, kind, title: 'T', permission_mode: 'default', created_by: 'Cara' }).id;
  const ids = () => urgent.list().map((m) => m.ticket);
  return { store, peek, urgent, changed, minion, ids };
}

test('the newest press goes last, a drag keeps its spot and who marked it, and all of it is kept over a restart', () => {
  const { store, urgent, ids, changed } = world();
  for (const t of [1, 2, 3]) assert.equal(urgent.set(t, JOSH), null);
  assert.deepEqual(ids(), [1, 2, 3]);
  urgent.set(3, CARA, 1);
  assert.deepEqual(ids(), [3, 1, 2]);
  assert.equal(urgent.get(3)?.by, 'Josh', 'a drag inside the group is not a press');
  urgent.set(3, CARA, null);
  assert.deepEqual(ids(), [1, 2, 3]);
  urgent.set(4, CARA, 2);
  assert.deepEqual([ids(), urgent.get(4)?.by], [[1, 4, 2, 3], 'Cara'], 'dragged in from below');
  urgent.set(4, CARA, 4);
  assert.deepEqual(ids(), [1, 4, 2, 3], 'dropped on itself');
  urgent.set(1, CARA);
  assert.deepEqual([ids(), urgent.get(1)?.by], [[1, 4, 2, 3], 'Josh'], 'a second press moves nothing');
  assert.deepEqual(new Urgent(store, () => {}).list(), urgent.list());
  assert.ok(changed.includes(4));
});

test("a person's choice, on or off, stands against a Taskmaster's and the server's; another person's newer one wins", () => {
  const { urgent } = world();
  urgent.set(1, JOSH);
  assert.match(urgent.unset(1, TM)!, /Josh marked it Urgent/);
  assert.match(urgent.set(1, TM)!, /Josh already/);
  assert.equal(urgent.get(1)?.kind, 'person');
  assert.equal(urgent.unset(1, CARA), null);
  assert.match(urgent.set(1, TM)!, /Cara took Urgent off it/);
  assert.match(urgent.set(1, SERVER)!, /Cara took Urgent off it/);
  assert.equal(urgent.set(1, JOSH), null);

  urgent.set(2, TM);
  assert.equal(urgent.set(2, JOSH), null, "a person's press takes a Taskmaster's over");
  assert.match(urgent.unset(2, TM)!, /Josh/);
  urgent.set(5, SERVER);
  urgent.set(5, JOSH, 2);
  urgent.passed(() => true);
  assert.deepEqual([urgent.get(5)?.by, urgent.place(5)], ['Josh', 1], "a person's drag is their choice: it outlasts the server's reason");
  assert.match(urgent.unset(5, TM)!, /Josh/);
  urgent.set(3, TM);
  assert.equal(urgent.unset(3, TM), null);
  assert.equal(urgent.set(3, SERVER), 'Urgent was taken off it');
});

test('a ship or a close takes it off and forgets who took it off', () => {
  const { urgent, ids } = world();
  urgent.set(1, JOSH);
  urgent.done(1);
  assert.deepEqual(ids(), []);
  assert.equal(urgent.set(1, TM), null, "its next work is anyone's to mark");
  urgent.unset(1, JOSH);
  urgent.done(1);
  assert.equal(urgent.set(1, TM), null);
});

test('the server marks two at most, people as many as they like, and its marks go with their cause', () => {
  const { urgent, ids } = world();
  for (const t of [1, 2, 3, 4]) urgent.set(t, JOSH);
  assert.equal(urgent.set(5, SERVER), null);
  assert.equal(urgent.set(6, { ...SERVER, cause: 'deploy:x' }), null);
  assert.match(urgent.set(7, SERVER)!, /2 already/);
  urgent.set(6, JOSH);
  assert.equal(urgent.set(7, SERVER), null, 'one a person took over no longer counts');
  urgent.passed(() => true);
  assert.deepEqual(ids(), [1, 2, 3, 4, 6]);
});

/** The server's tags over a world whose reds and chains the test sets. */
function fixes() {
  const w = world();
  const reds: RedFix[] = [];
  const chains: Chain[] = [];
  const f = new UrgentFixes({ store: w.store, urgent: w.urgent, from: 'Citadel', reds: () => reds, chains: () => chains });
  const red = (ticket: number, key = `${w.peek.id}:7`, run = '100') => ({ key, ticket, run, what: 'tests.yml is red' });
  const chain = (ticket: number, leader: number, held = false) => ({ ticket, after: leader, when: 'live', message: '', from: '', base: null, held }) as Chain;
  return { ...w, reds, chains, f, red, chain };
}

test('a red main tags its fix with the reason and the follow-up behind it; green takes the fix off, the follow-up stays', () => {
  const { f, reds, chains, red, chain, minion, urgent, ids, store } = fixes();
  const [fix, next, third, held] = [minion(), minion(), minion(), minion()];
  f.tick();
  assert.deepEqual(ids(), [], 'nothing red');
  reds.push(red(fix));
  chains.push(chain(held, fix, true), chain(next, fix), chain(third, next));
  f.tick();
  assert.deepEqual(ids(), [fix, next], 'two at most, and a held chain is none of them');
  assert.deepEqual([urgent.view(fix)?.kind, urgent.view(fix)?.reason], ['server', 'Fixing main: tests.yml is red']);
  assert.equal(urgent.view(next)?.reason, `Starts after #${store.getTicket(fix)!.number}, which is fixing main`);
  reds.length = 0;
  chains.splice(1, 1); // it started
  f.tick();
  assert.deepEqual(ids(), [next]);
});

test('a fix that shipped is not tagged again while its re-run goes, but is when a newer run is red', () => {
  const { f, reds, red, minion, urgent, ids } = fixes();
  const fix = minion();
  reds.push(red(fix));
  f.tick();
  urgent.done(fix);
  f.tick();
  assert.deepEqual(ids(), []);
  reds[0] = red(fix, reds[0].key, '101');
  f.tick();
  assert.deepEqual(ids(), [fix]);
});

test('a fix past the two is tagged once a place is free; a closed one and a Taskmaster never are', () => {
  const { f, reds, red, minion, peek, store, urgent, ids } = fixes();
  const [a, b, c, shut] = [minion(), minion(), minion(), minion()];
  store.updateTicket(shut, { status: 'closed' });
  reds.push(red(shut, 'p:1'), red(minion(peek.id, 'coordinator'), 'p:2'), red(a, 'p:3'), red(b, 'p:4'), red(c, 'p:5'));
  f.tick();
  assert.deepEqual(ids(), [a, b]);
  urgent.done(a);
  f.tick();
  assert.deepEqual(ids(), [b, c]);
});

test("Urgent taken off a red's fix by a person stays off, and a chain held or re-pointed loses its tag", () => {
  const { f, reds, chains, red, chain, minion, urgent, ids } = fixes();
  const [fix, next] = [minion(), minion()];
  reds.push(red(fix));
  chains.push(chain(next, fix));
  f.tick();
  urgent.unset(fix, JOSH);
  chains[0] = chain(next, fix, true);
  f.tick();
  assert.deepEqual(ids(), []);
});

test('a new red takes the place of a follow-up, never of another fix', () => {
  const { f, reds, chains, red, chain, minion, ids } = fixes();
  const [fix, next, fix2, fix3] = [minion(), minion(), minion(), minion()];
  reds.push(red(fix));
  chains.push(chain(next, fix));
  f.tick();
  assert.deepEqual(ids(), [fix, next]);
  reds.push(red(fix2, 'p:2'), red(fix3, 'p:3'));
  f.tick();
  f.tick();
  assert.deepEqual(ids(), [fix, fix2]);
});

test("of a failed restart's reports only the tip's minion is tagged; one past the two gets a place once there is one", () => {
  const { f, minion, urgent, ids } = fixes();
  const [tip, older, gaveUp] = [minion(), minion(), minion()];
  f.deployReported('Citadel', older, false, 'Deploy of abc1234 failed: rolled back. This restart was for your def5678 and the newer commits up to abc1234.');
  f.deployReported('Citadel', gaveUp, false, 'Gave up waiting for the turns to end');
  assert.deepEqual(ids(), []);
  f.deployReported('Citadel', tip, false, 'Deploy of abc1234 failed: rolled back');
  assert.equal(urgent.view(tip)?.reason, 'Its deploy of Citadel failed');
  const [b, c] = [minion(), minion()];
  f.deployEnded('delve', b, false, 'x');
  f.deployEnded('peek', c, false, 'x');
  assert.deepEqual(ids(), [tip, b]);
  f.deployReported('Citadel', older, true, 'Live');
  f.tick();
  assert.deepEqual(ids(), [b, c]);
  f.deployEnded('delve', tip, false, 'x');
  assert.deepEqual(ids(), [c, tip], "a newer failure of the same app's takes the older one's place");
});

test("the reds read are each scheme's red workflows and, in fast mode, the change a red is pinned on", () => {
  const { store, peek, minion } = world();
  const [a, b, shut] = [minion(), minion(), minion()];
  store.updateTicket(shut, { status: 'closed' });
  const num = (id: number) => store.getTicket(id)!.number;
  store.setSetting(`ci-health:red:${peek.id}`, { 7: { run: 99, runs: [99, 101], file: 'tests.yml' }, 8: { run: 5 } });
  const fixTicket = (_: unknown, m: RedMark) => (m.run === 99 ? store.getTicket(a)! : null);
  const fast = () => [b, shut].map((id) => ({ ids: ['x.test.ts'], sha: `s${id}`, n: num(id), at: 3 }));
  const key = `${peek.id}:7`;
  assert.deepEqual(redFixes(store, fixTicket, fast), [{ key, run: '101', what: 'tests.yml is red', ticket: a }], 'no fix minion, or not in fast mode: nothing');
  store.setProjectSettings(peek.id, { land_mode: 'fast' });
  assert.deepEqual(redFixes(store, fixTicket, fast).slice(1), [{ key: `${peek.id}:s${b}`, run: '3', what: 'x.test.ts is red', ticket: b }]);
  // #2244: a red behind a quick train, in the quick scheme whatever its land mode, puts its culprit first too.
  store.setProjectSettings(peek.id, { land_mode: 'off' });
  assert.deepEqual(redFixes(store, fixTicket, fast, (id) => id === peek.id).slice(1), [{ key: `${peek.id}:s${b}`, run: '3', what: 'x.test.ts is red', ticket: b }]);
  assert.deepEqual(redFixes(store, fixTicket, fast, () => false).slice(1), [], 'not the quick scheme: nothing');
});

test('a failed deploy tags the minion that ran it, and the next good one takes it off', () => {
  const { f, minion, urgent, ids } = fixes();
  const m = minion();
  f.deployEnded('delve', null, false, 'x');
  f.deployEnded('delve', m, false, 'Its deploy of delve was rolled back');
  assert.equal(urgent.view(m)?.reason, 'Its deploy of delve was rolled back');
  f.tick();
  f.deployEnded('peek', m, true, '');
  assert.deepEqual(ids(), [m], "another app's deploy says nothing of this one");
  f.deployEnded('delve', null, true, '');
  assert.deepEqual(ids(), []);
});

test('warm is the last 20 minutes of the hour, on the same account only', () => {
  const at = (min: number) => ({ ended_at: 1_000_000_000 - min * 60_000 });
  assert.equal(heatOf(false, at(45), 1_000_000_000), 2);
  assert.deepEqual(
    [39, 40, 59, 60].map((m) => heatOf(true, at(m), 1_000_000_000)),
    [1, 0, 0, 1],
  );
  assert.equal(heatOf(true, null, 1_000_000_000), 1);
  assert.ok(sameAccount({ payer: 3, account: null }, { payer: 3, account: 1 }));
  assert.ok(!sameAccount({ payer: 3, account: 2 }, { payer: 3, account: 1 }));
  assert.ok(!sameAccount({ payer: null, account: 1 }, { payer: 3, account: 1 }));
});

test('a refused ship and a minion others wait on go first in their share, until they no longer are', () => {
  const { store, urgent, minion, peek } = world();
  const [a, b, c] = [minion(), minion(), minion()];
  let chains: Chain[] = [];
  let now = 0;
  const places = new LinePlaces({ store, urgent, chains: () => chains, now: () => now });
  const first = (id: number) => places.place(store.getTicket(id)!, () => null).first;
  assert.deepEqual([first(a), first(b)], [false, false]);
  places.refused(a, true);
  assert.equal(new LinePlaces({ store, urgent, chains: () => chains, now: () => 0 }).place(store.getTicket(a)!, () => null).first, true, 'kept over a restart');
  places.refused(a, false);
  assert.equal(first(a), false);

  const chain = (ticket: number, leader: number, held = false) => ({ ticket, after: leader, when: 'live', message: '', from: '', base: null, held }) as Chain;
  chains = [chain(b, a), chain(a, c, true)];
  assert.deepEqual([...waitedOn(store, chains)], [a], 'a held chain waits on nobody');
  store.updateTicket(b, { status: 'closed' });
  assert.deepEqual([...waitedOn(store, chains)], [], 'nor does a closed minion');
  chains = [chain(minion(peek.id), a)];
  assert.ok(waitedOn(store, chains).has(a));
});

type Answer = { status: number; body: unknown };
/** A route's handler, as the router calls it once it has let the caller in. */
async function call(method: string, path: string, app: unknown, ctx: Record<string, unknown>, body: unknown = {}): Promise<Answer & { data: { urgent: unknown; said: string; line: Record<string, unknown>[]; lane: Record<string, unknown>[]; forced: Record<string, unknown>[] } }> {
  const route = urgentRoutes.find((r) => r.method === method && r.path === path)!;
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { headers: { 'content-type': 'application/json' } });
  const res = { status: 0, text: '', headersSent: false, setHeader() {}, writeHead: (s: number) => ((res.status = s), res), end: (b?: string) => void (res.text = b ?? '') };
  try {
    await route.handler({ req, res, app, params: {}, session: { name: 'Josh', uid: 1, admin: true }, ...ctx } as unknown as Parameters<typeof route.handler>[0]);
    return { status: res.status, body: '', data: JSON.parse(res.text) };
  } catch (err) {
    const e = err as HttpError;
    if (!e.status) throw err;
    return { status: e.status, body: e.message, data: { urgent: null, said: '', line: [], lane: [], forced: [] } };
  }
}

test("a person's route marks, drags and takes off, and refuses a closed minion, a Taskmaster and a spot that is gone", async () => {
  const { store, urgent, minion, peek, ids } = world();
  const app = { store, runner: { urgent } };
  const [a, b, c] = [minion(), minion(), minion()];
  const put = (id: number, body: unknown) => call('PUT', '/api/tickets/:ticket/urgent', app, { ticket: store.getTicket(id) }, body);
  assert.equal((await put(a, {})).status, 400);
  assert.equal((await put(a, { on: true, before: 'x' })).status, 400);
  const r = await put(a, { on: true });
  assert.deepEqual([r.status, (r.data.urgent as { by: string }).by], [200, 'Josh']);
  assert.equal((await put(b, { on: true, before: a })).status, 200);
  assert.deepEqual(ids(), [b, a]);
  assert.equal((await put(a, { on: true, before: c })).status, 409);
  assert.deepEqual(ids(), [b, a], 'a refused drag moves nothing');
  assert.equal((await put(minion(peek.id, 'coordinator'), { on: true })).status, 400);
  store.updateTicket(c, { status: 'closed' });
  assert.equal((await put(c, { on: true })).status, 409);
  assert.deepEqual((await put(b, { on: false })).data.urgent, null);
  assert.deepEqual(ids(), [a]);
});

test("the Taskmaster's route needs a reason and a minion of its own scheme, and never moves what a person chose", async () => {
  const { store, urgent, minion, peek, ids } = world();
  const app = { store, runner: { urgent } };
  const other = store.createProject('Delve', null);
  const [a, b] = [minion(), minion()];
  const num = (id: number) => store.getTicket(id)!.number;
  const post = (body: unknown, project: unknown = peek) => call('POST', '/api/projects/:project/urgent', app, { project }, body);
  assert.equal((await post({ minion: num(a) })).status, 400);
  assert.equal((await post({ minion: num(a), reason: 'x' }, other)).status, 404);
  const r = await post({ minion: `#${num(a)}`, reason: 'the release waits on it' });
  assert.match(r.data.said, /is Urgent: 1 of 1/);
  assert.deepEqual([urgent.view(a)?.by, urgent.view(a)?.reason], ['Peek Auras Taskmaster', 'the release waits on it']);
  assert.equal((await post({ minion: num(a), on: false })).status, 200, 'no reason needed to take one off');
  urgent.set(b, JOSH);
  const refused = await post({ minion: num(b), on: false });
  assert.deepEqual([refused.status, /Josh marked it Urgent/.test(String(refused.body))], [409, true]);
  assert.deepEqual(ids(), [b]);
});

test("the line shows a person only their schemes' minions, with the rest as places held", async () => {
  const { store, urgent, minion, peek } = world();
  const cara = store.createUser({ name: 'Cara', login: 'cara' });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  store.addMember(peek.id, josh.id);
  const hers = store.createProject('Hers', null);
  store.addMember(hers.id, cara.id);
  const [a, b] = [minion(), minion(hers.id)];
  urgent.set(b, { ...TM, reason: 'private' });
  const startNow = new StartNow({ store, over: () => false, changed: () => {}, now: () => 5 });
  startNow.press(a, josh.id, 'Josh');
  startNow.press(b, cara.id, 'A private person');
  const waiting = [b, a].map((ticket) => ({ ticket, person: cara.id, rank: 1, since: 5, heat: 0 as const, ...(ticket === b ? { urgent: 0 } : {}) }));
  const app = { store, runner: { urgent, startNow, isRunning: () => false, turnLine: { has: () => true, line: () => waiting, heldBy: () => null, laneTurns: () => [b, a].map((ticket) => ({ ticket, person: cara.id, since: 5, moved: ticket === a })) } } };
  const { data } = await call('GET', '/api/line', app, { session: { name: 'Josh', uid: josh.id, admin: false } });
  assert.deepEqual(
    data.line.map((w) => [w.ticket, w.urgent, w.warm]),
    [
      [null, true, true],
      [a, false, true],
    ],
  );
  assert.deepEqual(data.lane, [
    { ticket: null, person: 'Cara', since: 5, moved: false },
    { ticket: a, project: peek.id, number: store.getTicket(a)!.number, title: store.getTicket(a)!.title, person: 'Cara', since: 5, moved: true },
  ]);
  assert.deepEqual(
    data.forced.map((h) => [h.ticket, h.by]),
    [
      [a, 'Josh'],
      [null, undefined],
    ],
  );
  assert.ok(!/private|Peek Auras Taskmaster/.test(JSON.stringify(data)), 'neither the reason nor whose Taskmaster');
});

test("mark_urgent is on the Taskmaster tool list and not on a minion's", () => {
  const tools = (role: string): string[] => {
    const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n';
    const r = spawnSync(process.execPath, ['src/mcp.ts'], { input, encoding: 'utf8', env: { ...process.env, COORDINATOR_ROLE: role, COORDINATOR_PROJECT: '1', COORDINATOR_TICKET: '1', COORDINATOR_APP_INSTRUCTIONS: '', TMPDIR: root } });
    return JSON.parse(r.stdout.split('\n')[0]).result.tools.map((t: { name: string }) => t.name);
  };
  assert.ok(tools('coordinator').includes('mark_urgent'));
  assert.ok(!tools('thread').includes('mark_urgent'));
});

test("a Taskmaster places a mark ahead of another Taskmaster's or the server's, never past a person's, and it is kept over a restart", async () => {
  const { store, urgent, minion, peek, ids } = world();
  const app = { store, runner: { urgent } };
  const other = store.createProject('Delve', null);
  for (let i = 0; i < 40; i++) minion(other.id);
  const [a, b, c, d, e, f] = [minion(), minion(), minion(), minion(), minion(other.id), minion()];
  const num = (id: number) => store.getTicket(id)!.number;
  const post = (body: unknown) => call('POST', '/api/projects/:project/urgent', app, { project: peek }, body);
  const reason = 'it unblocks the release';
  urgent.set(a, SERVER);
  urgent.set(b, { ...TM, by: 'Delve Taskmaster' });
  // Ahead of the server's, and of another Taskmaster's: both its own kind of mark.
  let r = await post({ minion: num(c), reason, before: num(a) });
  assert.match(r.data.said, /1 of 3 in the group/);
  r = await post({ minion: num(d), reason, before: num(b) });
  assert.deepEqual(ids(), [c, a, d, b]);
  assert.match(r.data.said, /3 of 4 in the group/);
  assert.equal(urgent.get(d)?.reason, reason);
  // An existing mark moves up too.
  await post({ minion: num(d), reason, before: num(c) });
  assert.deepEqual(ids(), [d, c, a, b]);
  // A person's press: nothing goes ahead of it, and 'first' stops right behind it.
  urgent.set(f, JOSH, d);
  assert.deepEqual(ids(), [f, d, c, a, b]);
  const refused = await post({ minion: num(c), reason, before: num(f) });
  assert.deepEqual([refused.status, /ahead of a minion Josh marked or placed/.test(String(refused.body))], [409, true]);
  assert.deepEqual(ids(), [f, d, c, a, b]);
  await post({ minion: num(a), reason, first: true });
  assert.deepEqual(ids(), [f, a, d, c, b]);
  // A person's drag makes the mark theirs, so it is passed by no one either.
  urgent.set(c, CARA, null);
  assert.equal((await post({ minion: num(a), reason, before: num(c) })).status, 200, 'a is above c, moving down is no pass');
  assert.equal((await post({ minion: num(d), reason, before: num(f) })).status, 409);
  // The minion itself: a person's mark or a person's take-off.
  assert.equal((await post({ minion: num(c), reason, before: num(a) })).status, 409);
  const g = minion();
  urgent.set(g, JOSH);
  urgent.unset(g, JOSH);
  assert.match(String((await post({ minion: num(g), reason, first: true })).body), /took Urgent off it/);
  // A target that left the group, another scheme's, and a wrong shape.
  assert.equal((await post({ minion: 900, reason, first: true })).status, 404);
  const gone = minion();
  assert.equal((await post({ minion: num(gone), reason, before: 901 })).status, 404);
  const idle = minion();
  assert.equal((await post({ minion: num(idle), reason, before: num(idle) })).status, 409, 'a target not in the group is refused, not placed elsewhere');
  const idsBefore = ids();
  assert.equal((await post({ minion: num(idle), reason, before: num(a), first: true })).status, 400);
  assert.equal((await post({ minion: num(idle), on: false, first: true })).status, 400);
  assert.equal((await post({ minion: num(idle), before: num(a) })).status, 400, 'a reason is always needed');
  assert.equal((await post({ minion: num(e), reason, first: true })).status, 404, "another scheme's minion is not this one's to mark");
  assert.deepEqual(
    ids().filter((x) => !idsBefore.includes(x)),
    [],
  );
  // Kept over a restart.
  const again = new Urgent(store, () => {});
  assert.deepEqual(
    again.list().map((m) => m.ticket),
    ids(),
  );
});

test('first among the ones it may pass is the very front when no person has marked anything', () => {
  const { urgent, ids } = world();
  urgent.set(1, SERVER);
  urgent.set(2, TM);
  assert.equal(urgent.put(3, TM, 'first'), null);
  assert.deepEqual(ids(), [3, 1, 2]);
  assert.equal(urgent.put(9, TM, 77), 'that minion is not Urgent any more');
});

test("a mark saved without a kind that is a Taskmaster's still counts as the saved kind: nothing is migrated", () => {
  const { store, urgent } = world();
  store.setSetting('urgent', { on: [{ ticket: 5, kind: 'person', by: 'Josh', at: 1 }], off: [] });
  const again = new Urgent(store, () => {});
  assert.equal(again.put(6, TM, 5), 'that would put it ahead of a minion Josh marked or placed');
  assert.equal(again.put(5, TM, 'first'), 'Josh already marked it Urgent');
});
