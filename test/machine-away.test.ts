import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tempRoot, until } from './helpers.ts';
import { awayLine, awayNote, awayPrompt, MachineCopies, nextMark, UNINSTALL, wireCopies } from '../src/machine-away.ts';
import { pacificStamp } from '../src/pacific.ts';
import { dropRemoved } from '../src/routes/machines.ts';
import { AWAY_MS, awayTick, heardAt, liveOn, machineAway, MachineTurn, machineLink, placeTurn, placedAt, syncTurns, type MachineLaunch } from '../src/machine-turn.ts';
import { outcome } from '../src/turn-outcome.ts';
import { GRACE_MS } from '../src/worktree-sweep.ts';

// When a worker machine sleeps, reboots or drops off (Build 7 T6, spec worker-machines.md section 6): its turns are
// "away", never killed; past AWAY_MS they end here and carry on at perigee; what the machine holds of each minion is
// recorded, sent home aside when it returns, and cleared once its minion has closed or the machine is removed.
const tmp = tempRoot('machine-away-');
after(() => tmp.teardown());
const hooks = { ...machineAway };
const link = { ...machineLink };
after(() => {
  Object.assign(machineAway, hooks);
  Object.assign(machineLink, link);
});

const launch = (ticket: number): MachineLaunch => ({ wrapper: ['node', 'w.mjs'], cwd: `/wt/${ticket}/repo`, home: '/home/x', roots: ['/data'], state: { ticket, config: { here: '/c', there: '/h/c' } } });
let n = 0;
async function placed(machine: number, ticket = 1) {
  const dir = join(tmp.dir, `turn-${++n}`);
  mkdirSync(dir, { recursive: true });
  await placeTurn(dir, { id: machine, name: `box-${machine}` }, launch(ticket));
  return dir;
}
const exit = (dir: string) => (existsSync(join(dir, 'exit.json')) ? JSON.parse(readFileSync(join(dir, 'exit.json'), 'utf8')) : null);
const offline = (...ids: number[]) => {
  machineLink.online = (id) => !ids.includes(id);
};

/** A store with only what the copies record reads. */
function copiesOf(tickets: Record<number, { status: string; closed_at?: number }> = {}) {
  const settings = new Map<string, unknown>();
  const notes: string[] = [];
  let now = 1_000_000;
  const store = {
    getSetting: <T>(k: string) => settings.get(k) as T | undefined,
    setSetting: (k: string, v: unknown) => void settings.set(k, structuredClone(v)),
    deleteSetting: (k: string) => void settings.delete(k),
    getTicket: (id: number) => tickets[id],
  };
  const copies = new MachineCopies({ store: store as never, note: (id, text) => notes.push(`#${id} ${text}`), now: () => now });
  return { copies, notes, settings, later: (ms: number) => (now += ms) };
}

test('a machine away 10 minutes has its turns ended here, with its last checkpoint; a stall of this server is not counted', async () => {
  const t0 = Date.now();
  await awayTick(t0);
  const dir = await placed(11);
  writeFileSync(join(dir, 'checkpoint'), String(t0 - 60_000));
  await syncTurns(11, { turns: [{ dir, alive: true }] });
  offline(11);
  for (let at = t0; at <= t0 + AWAY_MS - 30_000; at += 30_000) await awayTick(at);
  assert.equal(exit(dir), null, 'under 10 minutes it is away, still running');
  assert.deepEqual(await liveOn(11), [dir]);
  await awayTick(t0 + AWAY_MS + 1000);
  await until('the away end', () => !!exit(dir));
  const end = exit(dir);
  assert.equal(end.code, null);
  assert.deepEqual({ ...end.away, since: 0 }, { name: 'box-11', since: 0, checkpoint: t0 - 60_000, home: true });
  assert.ok(Math.abs(end.away.since - t0) < 5000, 'away since its last sync');
  assert.deepEqual(await liveOn(11), []);

  // This server stalled (or slept) for 19 minutes: no machine could reach it, so the clock starts again when it wakes.
  const other = await placed(12);
  await syncTurns(12, { turns: [{ dir: other, alive: true }] });
  offline(12);
  const woke = t0 + 30 * 60_000;
  await awayTick(woke);
  for (let at = woke; at <= woke + AWAY_MS - 30_000; at += 30_000) await awayTick(at);
  assert.equal(exit(other), null, "the stall isn't the machine's absence");
  await awayTick(woke + AWAY_MS + 1000);
  await until('the away end after the stall', () => !!exit(other));
});

test('back within 10 minutes it is running, and a turn there is not ended; a restarted machine ends it here', async () => {
  const t0 = Date.now() + 60 * 60_000;
  await awayTick(t0);
  const dir = await placed(13);
  await syncTurns(13, { turns: [{ dir, alive: true }] });
  offline(13);
  const turn = new MachineTurn(dir, placedAt(dir)!);
  assert.deepEqual({ ...turn.away(), since: 0 }, { name: 'box-13', since: 0 });
  // The minions list's working line for it.
  assert.equal(awayLine(turn), `Machine away: box-13, since ${pacificStamp(turn.away()!.since!)}`);
  await awayTick(t0 + 5 * 60_000 - 1000);
  for (let at = t0 + 5 * 60_000; at <= t0 + 2 * AWAY_MS; at += 30_000) {
    if (at === t0 + 5 * 60_000) offline();
    await awayTick(at);
  }
  assert.equal(exit(dir), null, 'online again: its turn carries on there');
  assert.equal(turn.away(), null);
  assert.equal(awayLine(turn), null, 'no away line once it is back');
  const old = new Date(Date.now() - 120_000);
  utimesSync(join(dir, 'beat'), old, old);
  assert.equal(turn.alive(), true, 'just back, its beat is stale until its first sync names the turn');
  // Back, but its agent says the turn's process is gone and the machine booted since: it ends as away, not home.
  await syncTurns(13, { turns: [{ dir, alive: false, lost: true }] });
  assert.equal(exit(dir).away.home, false);
});

test('a minion marked for that machine waits for it (its card after a day), and never comes home by itself', async () => {
  const { copies } = copiesOf();
  const stuck: unknown[] = [];
  wireCopies(copies, { needs: (t) => (t === 21 ? 14 : null), stuck: (...a) => void stuck.push(a) });
  try {
    const marked = await placed(14, 21);
    const free = await placed(14, 22);
    await syncTurns(14, {
      turns: [
        { dir: marked, alive: true },
        { dir: free, alive: true },
      ],
    });
    offline(14);
    const t0 = Date.now() + 2 * 3600_000;
    await awayTick(t0);
    for (let at = t0; at <= t0 + AWAY_MS + 30_000; at += 30_000) await awayTick(at);
    await until('the free one ends', () => !!exit(free));
    assert.equal(exit(marked), null);
    assert.equal(stuck.length > 0, true);
    assert.deepEqual((stuck[0] as unknown[]).slice(0, 1), [21]);
    assert.deepEqual((stuck[0] as [number, number, { why: string }])[2].why, 'box-14 is away');
    // The copy of the one that ended is marked to come home; the waiting one's is not.
    const all = copies.all(14);
    assert.ok(all[free].away);
    assert.equal(all[marked].away, undefined);
  } finally {
    Object.assign(machineAway, hooks);
  }
});

test("an away turn's ending is the away kind: no retry cap, carried on at perigee from its checkpoint", () => {
  const away = { name: 'box-1', since: Date.UTC(2026, 10, 25, 20, 0), checkpoint: Date.UTC(2026, 10, 25, 19, 58), home: true };
  const turn = { retries: { restart: 40 } } as Parameters<typeof outcome>[0]['turn'];
  const out = outcome({ turn, exit: { code: null, signal: null, away }, stderr: [], closing: false, ran: { unit: false, container: false } });
  assert.equal(out.kind, 'away');
  assert.deepEqual(out.retry, { via: 'restart', retries: { restart: 40 } });
  // The chat line names the machine, when it went away, the checkpoint's time and where newer work comes home.
  const note = awayNote(away);
  for (const part of ['box-1', pacificStamp(away.since), pacificStamp(away.checkpoint), 'perigee', 'refs/citadel/away/']) assert.ok(note.includes(part), `${part} in: ${note}`);
  const prompt = awayPrompt(away);
  for (const part of ['box-1', pacificStamp(away.checkpoint), 'perigee', 'refs/citadel/away/']) assert.ok(prompt.includes(part), `${part} in: ${prompt}`);
  const restarted = awayPrompt({ ...away, home: false, checkpoint: null });
  assert.ok(!restarted.includes('perigee') && !restarted.includes(pacificStamp(away.checkpoint)), 'a restart there carries on from the turn start, not perigee');
});

test('the copies record: an away copy is rescued when the agent holds no turn for it, then stays as the minion copy', () => {
  const { copies, notes } = copiesOf({ 5: { status: 'open' } });
  const at = { id: 3, name: 'box-3', ...launch(5) };
  copies.placed(3, '/t/a', at);
  copies.left(3, '/t/a');
  assert.deepEqual(copies.held(3, '/t/a'), { rescue: true });
  assert.deepEqual(copies.clears(3, new Set(['/t/a'])), [], 'its turn still held there: told by its own reply, not cleared');
  const [c] = copies.clears(3, new Set());
  assert.equal(c.mode, 'rescue');
  assert.deepEqual(c.launch.sync, { at: '/t/.sync', key: '/wt/5' });
  // A newer turn of the same minion there does not drop a copy whose work is still to come home.
  copies.placed(3, '/t/b', at);
  assert.deepEqual(Object.keys(copies.all(3)).sort(), ['/t/a', '/t/b']);
  copies.rescued(3, '/t/a', 'no route');
  assert.match(notes[0], /could not send home .*no route/);
  assert.deepEqual(Object.keys(copies.all(3)), ['/t/b'], 'the newer copy is the minion copy now');
  assert.equal(copies.held(3, '/t/a'), null);
});

test("a closed minion's copy is cleared once it is 3 days closed; one with what can't come home stays, and says why", () => {
  const { copies, notes, later } = copiesOf({ 6: { status: 'closed', closed_at: 1_000_000 }, 7: { status: 'open' } });
  copies.placed(3, '/t/c', { id: 3, name: 'box-3', ...launch(6) });
  copies.placed(3, '/t/d', { id: 3, name: 'box-3', ...launch(7) });
  assert.deepEqual(copies.clears(3, new Set()), []);
  later(GRACE_MS);
  const clears = copies.clears(3, new Set());
  assert.deepEqual(
    clears.map((c) => [c.dir, c.all, c.mode]),
    [['/t/c', false, undefined]],
  );
  copies.cleared(3, '/t/c', 'repo/.env');
  assert.match(notes[0], /box-3 keeps its copy of this minion: repo\/\.env can't come home/);
  assert.deepEqual(copies.clears(3, new Set()), [], 'kept: not asked again');
  copies.cleared(3, '/t/c', 'repo/.env');
  assert.equal(notes.length, 1, 'said once');
  assert.deepEqual(copies.staying(3), [{ ticket: 6, why: 'repo/.env' }]);
});

test('removing a machine clears every copy there with what they share, then its record goes', () => {
  const { copies, settings } = copiesOf({ 8: { status: 'open' } });
  copies.placed(4, '/t/e', { id: 4, name: 'box-4', ...launch(8) });
  copies.placed(4, '/t/f', { id: 4, name: 'box-4', ...launch(9) });
  copies.remove(4);
  assert.equal(copies.removing(4), true);
  assert.deepEqual(copies.removals(), [4]);
  assert.deepEqual(
    copies.clears(4, new Set(['/t/f'])).map((c) => [c.dir, c.all]),
    [['/t/e', true]],
    'a turn still running there is cleared after it',
  );
  copies.cleared(4, '/t/e', null);
  assert.deepEqual(Object.keys(copies.all(4)), ['/t/f']);
  copies.forget(4);
  assert.deepEqual([...settings.keys()], []);
  assert.match(UNINSTALL.powershell, /wsl --unregister citadel-workers/);
  assert.equal(UNINSTALL.bash, 'sudo citadel-worker remove');
});

test('a machine being removed goes once its copies are cleared or kept, or after 10 minutes silent counted from a stall too', async () => {
  const { copies } = copiesOf({ 8: { status: 'open' } });
  const dropped: number[] = [];
  const app = {
    machineCopies: copies,
    store: { getMachine: (id: number) => ({ id, name: `box-${id}` }), deleteMachine: (id: number) => void dropped.push(id) },
    jobs: { drop() {} },
    runner: { turnLine: { forget() {} } },
    ciLoad: { forget() {} },
    machines: { disconnect() {}, list: () => [] },
    broadcast() {},
  } as never;
  const real = Date.now;
  const far = real() + 10 * 3600_000;
  let clock = far - 30 * 60_000;
  Date.now = () => clock;
  try {
    await syncTurns(32, { turns: [] });
    // This server stalls for 30 minutes: the machine's silence is counted from when it woke, not from its last sync.
    clock = far;
    await awayTick(far);
    assert.equal(heardAt(32), far);
    copies.placed(31, '/t/g', { id: 31, name: 'box-31', ...launch(8) });
    copies.left(31, '/t/g');
    copies.placed(32, '/t/h', { id: 32, name: 'box-32', ...launch(8) });
    copies.remove(31);
    copies.remove(32);
    await syncTurns(31, { turns: [] });
    await dropRemoved(app);
    assert.deepEqual(dropped, [], 'work still to come home, and a copy still there: both wait');
    copies.cleared(31, '/t/g', null);
    await dropRemoved(app);
    assert.deepEqual(dropped, [], 'rescued, it is the minion copy: still to clear');
    copies.cleared(31, '/t/g', 'repo/.env');
    await dropRemoved(app);
    assert.deepEqual(dropped, [31], "kept for what can't come home: its uninstall deletes it");
    clock = far + AWAY_MS;
    await dropRemoved(app);
    assert.deepEqual(dropped, [31, 32], 'silent 10 minutes since this server woke');
    assert.deepEqual(copies.removals(), []);
  } finally {
    Date.now = real;
  }
});

test('a turn owed after its machine was away runs here once if its minion is unmarked; a marked one keeps its machine', () => {
  const away = { name: 'box-1', since: 1, checkpoint: null, home: true };
  assert.equal(
    nextMark(null, away, () => false),
    0,
    'unmarked: carries on at perigee',
  );
  assert.equal(
    nextMark(null, { ...away, home: false }, () => false),
    null,
    'a restart there: anywhere',
  );
  assert.equal(
    nextMark(null, undefined, () => false),
    null,
  );
  assert.equal(
    nextMark(14, away, () => false),
    14,
    'marked for that machine: waits for it, or gets its card',
  );
  assert.equal(
    nextMark(14, away, () => true),
    0,
    'a fresh step still runs here',
  );
  assert.equal(
    nextMark(0, away, () => true),
    0,
  );
});
