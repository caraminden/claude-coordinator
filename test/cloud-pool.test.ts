// The cloud as one more place in the worker pool (#2153, src/cloud-pool.ts): its rules, and the line (src/turn-line.ts)
// putting a turn it may take there first, on a fake host and a mocked clock.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CLOUD, CLOUD_PLACE, CloudPool, cloudPrompt, markRefusal, newMark, startBlock, type StartIn } from '../src/cloud-pool.ts';
import { pacificDay } from '../src/pacific.ts';
import { TurnLine, type LineHost } from '../src/turn-line.ts';

const settings = () => {
  const saved = new Map<string, string>();
  return {
    saved,
    getSetting: <T>(k: string): T | null => (saved.has(k) ? (JSON.parse(saved.get(k)!) as T) : null),
    setSetting: (k: string, v: unknown) => void saved.set(k, JSON.stringify(v)),
    deleteSetting: (k: string) => void saved.delete(k),
  };
};

const NOW = Date.UTC(2026, 10, 26, 20, 0);
const ok: StartIn = { mark: null, go: true, github: true, type: 'research', ran: false, usage: null, runsToday: 0, now: NOW };

test('a research or ideation minion create_ticket let go may start in the cloud with no mark; each rule that stops it says why', () => {
  assert.equal(startBlock(ok), null);
  assert.equal(startBlock({ ...ok, type: 'ideation' }), null);
  assert.match(startBlock({ ...ok, type: 'feature' }) ?? '', /not a research or ideation minion, nor marked/);
  assert.match(startBlock({ ...ok, go: false }) ?? '', /kept at perigee/);
  assert.match(startBlock({ ...ok, github: false }) ?? '', /isn't on GitHub/);
  const marked = { ...ok, mark: { kind: 'research' as const, minutes: 10, by: 'Taskmaster', at: NOW } };
  assert.equal(startBlock(marked), null);
  assert.equal(startBlock({ ...ok, ran: true }), 'it has run here before');
  assert.match(startBlock({ ...marked, type: 'feature' }) ?? '', /marked research but its type is feature/);
  assert.equal(startBlock({ ...marked, mark: { ...marked.mark, kind: 'sweep' }, type: 'chore' }), null, 'a marked test sweep may be of any type');
  assert.match(startBlock({ ...ok, runsToday: CLOUD.dailyRuns }) ?? '', /10 cloud sessions today/);
  assert.equal(startBlock({ ...ok, runsToday: CLOUD.dailyRuns - 1 }), null);
});

test('weekly use at 85% stops new cloud sessions; a week past its reset counts as empty', () => {
  const week = (utilization: number, resetsAt: number) => ({ weekly: { utilization, resetsAt, status: null }, session: null, updatedAt: NOW });
  assert.match(startBlock({ ...ok, usage: week(0.85, NOW + 3600_000) }) ?? '', /weekly plan use at 85%/);
  assert.equal(startBlock({ ...ok, usage: week(0.84, NOW + 3600_000) }), null);
  assert.equal(startBlock({ ...ok, usage: week(0.99, NOW - 1) }), null);
});

test('a job with a step over 25 minutes is refused for the cloud, and so is a kind not on the allow list', () => {
  assert.equal(markRefusal('research', 25), null);
  assert.match(markRefusal('research', 26) ?? '', /a step over 25 minutes is refused/);
  assert.match(markRefusal('feature', 5) ?? '', /must be one of research, ideation, sweep/);
  assert.match(markRefusal('sweep', 0) ?? '', /positive number/);
  const pool = new CloudPool(settings());
  assert.match(pool.setMark(1, { kind: 'sweep', minutes: 40, by: 'x' }) ?? '', /refused/);
  assert.equal(pool.mark(1), null, 'a refused mark is not kept');
  assert.equal(startBlock({ ...ok, mark: { kind: 'sweep', minutes: 40, by: 'x', at: NOW } })?.includes('refused'), true, 'a mark saved before the cap still stops');
});

test("create_ticket lets a research minion go unless cloud: false or its brief names the shared folder; a schedule's never goes", () => {
  const gh = 'https://github.com/caraminden/claude-coordinator';
  assert.deepEqual(newMark(gh, undefined, 'research', false), { go: true });
  assert.deepEqual(newMark(gh, undefined, 'ideation', false), { go: true });
  assert.equal(newMark(gh, undefined, 'research', true), null, 'a brief naming the shared folder stays home');
  assert.equal(newMark(gh, false, 'research', false), null);
  assert.equal(newMark(gh, undefined, 'feature', false), null);
  assert.deepEqual(newMark(gh, { kind: 'sweep', minutes: 20 }, 'chore', true), { kind: 'sweep', minutes: 20 });
  assert.match(String(newMark(null, { kind: 'sweep', minutes: 20 }, 'chore', false)), /isn't on GitHub/);
  const pool = new CloudPool(settings());
  const asks = { type: 'research', ran: false, usage: null, repoUrl: gh };
  assert.equal(pool.may(1, 'research'), false, 'made elsewhere (a schedule, a trigger): home');
  assert.match(pool.takes(1, 2, asks, NOW) ?? '', /kept at perigee/);
  pool.made(1, { go: true }, 'Cara');
  assert.equal(pool.may(1, 'research'), true);
  assert.equal(pool.may(1, 'feature'), false, 'retyped since: home');
  assert.equal(pool.takes(1, 2, asks, NOW), null);
  assert.match(pool.takes(1, 2, { ...asks, repoUrl: null }, NOW) ?? '', /isn't on GitHub/);
  pool.made(3, { kind: 'sweep', minutes: 20 }, 'Cara');
  assert.equal(pool.may(3, 'chore'), true);
});

test('runs count per person per Pacific day', () => {
  const pool = new CloudPool(settings());
  // 23:30 PST on Nov 26 is Nov 27 in UTC, still Nov 26 here.
  const late = Date.UTC(2026, 10, 27, 7, 30);
  assert.equal(pacificDay(late), '2026-11-26');
  pool.counted(2, late);
  pool.counted(2, late);
  assert.equal(pool.runsToday(2, late), 2);
  assert.equal(pool.runsToday(3, late), 0);
  assert.equal(pool.runsToday(2, late + 3600_000), 0, 'a new day in Pacific time starts again');
});

test("the driver's word of its session is kept on the minion with its person and account, and only when it looks like one", () => {
  const pool = new CloudPool(settings());
  const sha = 'a'.repeat(40);
  pool.heard(5, 2, 1, { session: 'session_01; rm -rf', branch: 'cloud/t5-x' }, NOW);
  pool.heard(5, 2, 1, { session: 'session_01abcdefgh', branch: '../main' }, NOW);
  assert.equal(pool.session(5), null);
  pool.heard(5, 2, 2, { session: 'session_01abcdefgh', url: 'https://claude.ai/code/session_01abcdefgh', branch: 'cloud/t5-x' }, NOW);
  pool.heard(5, 3, 1, { session: 'session_01abcdefgh', branch: 'cloud/t5-y', sha }, NOW + 1);
  assert.deepEqual(pool.session(5), { session: 'session_01abcdefgh', url: 'https://claude.ai/code/session_01abcdefgh', branch: 'cloud/t5-y', person: 2, account: 2, sha, at: NOW });
  assert.equal(pool.runsToday(2, NOW), 0, 'a start is counted when the line sends it, not when its id is heard');
});

test('each turn of a session gets a branch of its own, and names the last one so a late answer is read as late', () => {
  const pool = new CloudPool(settings());
  const t = { id: 5, number: 41, cwd: '/w' };
  const first = pool.job(t, [{ author: 'Josh', text: 'compare' }], 'claude', null, NOW);
  assert.equal(first.session, null);
  assert.equal(first.last, null);
  assert.match(first.text, /minion #41's cloud session/);
  pool.heard(5, 2, 1, { session: 'session_01abcdefgh', branch: first.branch, sha: 'b'.repeat(40) }, NOW);
  const next = pool.job(t, [{ author: 'Josh', text: 'A' }], 'claude', null, NOW + 60_000);
  assert.notEqual(next.branch, first.branch);
  assert.equal(next.last, first.branch);
  assert.equal(next.session, 'session_01abcdefgh');
  assert.match(next.text, new RegExp(`HEAD:refs/heads/${next.branch}`));
});

test('the first message names the branch, the time and what the session lacks; a follow-up only how to answer', () => {
  const first = cloudPrompt({ ticket: 9, branch: 'cloud/t9-a', minutes: 15, first: true, messages: '[Josh]: compare X and Y' });
  assert.match(first, /minion #9's cloud session/);
  assert.match(first, /keep it under 25 minutes/);
  assert.match(first, /longest step should take about 15 minutes/);
  assert.match(first, /\[Josh\]: compare X and Y/);
  assert.match(first, /git push origin HEAD:refs\/heads\/cloud\/t9-a/);
  assert.match(first, /"recommended": true/, 'the questions route refuses a card with no recommended option');
  const next = cloudPrompt({ ticket: 9, branch: 'cloud/t9-a', minutes: 15, first: false, messages: '[Josh]: A' });
  assert.match(next, /^\[Josh\]: A\n/);
  assert.doesNotMatch(next, /minion #9/);
});

/** A line over `size` perigee workers and a cloud of `cloud` sessions: the ones it may take (`marked`) go there first, bound ones only there. */
function line(t: TestContext, size = 1, cloud = 1) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const store: LineHost['store'] = { ...settings(), addHealthEvent: () => {} };
  store.setSetting('turn-pool', { size, at: 0, fixed: { size, by: 'cara' } });
  const marked = new Set<number>();
  const bound = new Set<number>();
  const started: string[] = [];
  const sent: number[] = [];
  const steps = new Map<number, () => void>();
  let l!: TurnLine;
  const run = (id: number) => {
    if (!l.enter(id)) return false;
    void l.hold(id, () => new Promise<void>((r) => steps.set(id, r)));
    return true;
  };
  const host: LineHost = {
    store,
    exempt: () => false,
    busy: () => false,
    asks: () => ({ person: 1, rank: 0 }),
    forced: () => null,
    start: (e) => {
      started.push(String(e.ticket));
      run(e.ticket);
    },
    pauseTurn: () => {},
    changed: () => {},
    carded: () => [],
    cloud: { bound: (id) => bound.has(id), takes: (id) => (marked.has(id) ? null : 'not marked cloud-ok'), started: (id) => sent.push(id), size: () => cloud },
    gapMs: 0,
    detached: false,
  };
  l = new TurnLine(host);
  return {
    l,
    host,
    run,
    marked,
    bound,
    started,
    sent,
    async end(id: number) {
      steps.get(id)!();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      t.mock.timers.tick(1);
    },
  };
}

test('a turn the cloud may take goes there first, though perigee has room; perigee takes it once the cloud is full', (t) => {
  const x = line(t);
  x.marked.add(1).add(2);
  assert.equal(x.run(1), true);
  assert.equal(x.l.placeOf(1), CLOUD_PLACE, 'the cloud first while it has room');
  assert.equal(x.run(2), true);
  assert.equal(x.l.placeOf(2), 0, 'the cloud is full: perigee, as usual');
  assert.equal(x.run(3), false, 'one the cloud may not take waits for perigee');
  x.marked.add(4);
  assert.equal(x.run(4), false, 'both are full');
  assert.deepEqual(x.sent, [1], 'the start told the host, to count it');
});

test('a waiting turn the cloud may take runs at perigee when perigee frees first', async (t) => {
  const x = line(t, 1, 1);
  x.marked.add(1).add(3);
  x.run(1);
  x.run(2);
  assert.equal(x.run(3), false);
  await x.end(2);
  assert.deepEqual(x.started, ['3']);
  assert.equal(x.l.placeOf(3), 0);
  assert.deepEqual(x.sent, [1]);
});

test('Start now on a minion bound to its cloud session waits for the cloud, never perigee', async (t) => {
  const x = line(t, 2, 1);
  x.bound.add(1).add(2);
  x.run(1);
  assert.equal(x.run(2), false);
  x.l.force(2);
  assert.deepEqual(x.started, [], 'not started at perigee, though a worker is free there');
  await x.end(1);
  assert.deepEqual(x.started, ['2']);
  assert.equal(x.l.placeOf(2), CLOUD_PLACE);
});

test('a minion whose session is in the cloud runs there and nowhere else, waiting while the cloud is full', async (t) => {
  const x = line(t, 2);
  x.bound.add(2);
  assert.equal(x.run(2), true);
  assert.equal(x.l.placeOf(2), CLOUD_PLACE, 'bound: the cloud though perigee has room');
  x.bound.add(3);
  assert.equal(x.run(3), false, 'never perigee, though a worker is free there');
  assert.match(x.l.wait(3)?.machine?.why ?? '', /busy: 1 of 1 cloud sessions/);
  assert.equal(x.run(5), true, 'an ordinary one takes the free perigee worker');
  await x.end(2);
  assert.deepEqual(x.started, ['3']);
  assert.equal(x.l.placeOf(3), CLOUD_PLACE);
});

test('a marked turn waiting while perigee is full is started in the cloud when a cloud session frees', async (t) => {
  const x = line(t, 1, 1);
  x.marked.add(2).add(3);
  x.run(1);
  x.run(2);
  assert.equal(x.l.placeOf(2), CLOUD_PLACE);
  assert.equal(x.run(3), false);
  await x.end(2);
  assert.deepEqual(x.started, ['3']);
  assert.equal(x.l.placeOf(3), CLOUD_PLACE);
});

test('with no cloud host the line is as before', (t) => {
  const x = line(t);
  const l = new TurnLine({ ...x.host, cloud: undefined });
  assert.equal(l.enter(1), true);
  assert.equal(l.enter(2), false);
});
