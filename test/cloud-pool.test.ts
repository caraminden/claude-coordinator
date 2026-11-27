// The cloud as one more place in the worker pool (#2153, src/cloud-pool.ts): its rules, and the line (src/turn-line.ts)
// putting a turn it may take there first, on a fake host and a mocked clock.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { CLOUD, CLOUD_OFF, CLOUD_PLACE, CLOUD_SWITCH, CloudPool, cloudSpend, cloudPrompt, handoffBrief, markRefusal, newMark, staysHome, startBlock, type StartIn } from '../src/cloud-pool.ts';
import { TurnLine, type LineHost } from '../src/turn-line.ts';

/** A settings store; the admin switch is on (`on`), as the rules below are what the cloud does while it is. */
const settings = (on = true) => {
  const saved = new Map<string, string>(on ? [[CLOUD_SWITCH, 'true']] : []);
  return {
    saved,
    getSetting: <T>(k: string): T | null => (saved.has(k) ? (JSON.parse(saved.get(k)!) as T) : null),
    setSetting: (k: string, v: unknown) => void saved.set(k, JSON.stringify(v)),
    deleteSetting: (k: string) => void saved.delete(k),
  };
};

const NOW = Date.UTC(2026, 10, 26, 20, 0);
const ok: StartIn = { mark: null, go: true, github: true, type: 'research', ran: false };

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
});

test('a job with a step over 110 minutes is refused for the cloud, and so is a kind not on the allow list', () => {
  assert.equal(markRefusal('research', 110), null);
  assert.match(markRefusal('research', 111) ?? '', /a step over 110 minutes is refused/);
  assert.match(markRefusal('feature', 5) ?? '', /must be one of research, ideation, sweep/);
  assert.match(markRefusal('sweep', 0) ?? '', /positive number/);
  const pool = new CloudPool(settings());
  assert.match(pool.setMark(1, { kind: 'sweep', minutes: 140, by: 'x' }) ?? '', /refused/);
  assert.equal(pool.mark(1), null, 'a refused mark is not kept');
  assert.equal(startBlock({ ...ok, mark: { kind: 'sweep', minutes: 140, by: 'x', at: NOW } })?.includes('refused'), true, 'a mark saved before the cap still stops');
});

test("create_ticket lets a research minion go unless cloud: false or its brief names the shared folder; a schedule's never goes", () => {
  const gh = 'https://github.com/caraminden/claude-coordinator';
  const dir = '/data/projects/2/shared/project';
  assert.deepEqual(newMark(gh, undefined, 'research', 'compare X and Y', dir), { go: true });
  assert.deepEqual(newMark(gh, undefined, 'ideation', 'ideas for Z', dir), { go: true });
  assert.equal(newMark(gh, undefined, 'research', `read ${dir}/a.md`, dir), null, 'a brief naming the shared folder stays home');
  assert.equal(newMark(gh, false, 'research', 'compare', dir), null);
  assert.equal(newMark(gh, undefined, 'feature', 'compare', dir), null);
  assert.deepEqual(newMark(gh, { kind: 'sweep', minutes: 20 }, 'chore', `read ${dir}/a.md`, dir), { kind: 'sweep', minutes: 20 }, "a mark is its sender's word on the shared folder");
  assert.match(String(newMark(gh, { kind: 'sweep', minutes: 20 }, 'chore', 'run ./gradlew test', dir)), /Android/, 'but an Android sweep is refused (#2154)');
  assert.match(String(newMark(null, { kind: 'sweep', minutes: 20 }, 'chore', 'x', dir)), /isn't on GitHub/);
  assert.deepEqual([cloudSpend({ cloud_cost_usd: 0.4 }), cloudSpend({ total_cost_usd: 3 }), cloudSpend({ cloud_cost_usd: -1 }), cloudSpend({ cloud_cost_usd: '1' })], [0.4, null, null, null]);
  const pool = new CloudPool(settings());
  const asks = { type: 'research', ran: false, repoUrl: gh };
  assert.equal(pool.may(1, 'research'), false, 'made elsewhere (a schedule, a trigger): home');
  assert.match(pool.takes(1, asks) ?? '', /kept at perigee/);
  pool.made(1, { go: true }, 'Cara');
  assert.equal(pool.may(1, 'research'), true);
  assert.equal(pool.may(1, 'feature'), false, 'retyped since: home');
  assert.equal(pool.takes(1, asks), null);
  assert.match(pool.takes(1, { ...asks, repoUrl: null }) ?? '', /isn't on GitHub/);
  pool.made(3, { kind: 'sweep', minutes: 20 }, 'Cara');
  assert.equal(pool.may(3, 'chore'), true);
});

test('with the admin switch off (its default), no new cloud session starts: not a research minion, a marked one nor a sweep; on, as before', () => {
  const gh = 'https://github.com/a/b';
  const asks = (type: string) => ({ type, ran: false, repoUrl: gh });
  const store = settings(false);
  const pool = new CloudPool(store);
  assert.equal(pool.on(), false, 'off until an admin turns it on (Cara, 2026-11-26: "Lets turn off cloud sessions")');
  pool.made(1, { go: true }, 'Cara');
  pool.made(2, { kind: 'research', minutes: 20 }, 'Cara');
  pool.made(3, { kind: 'sweep', minutes: 20 }, 'Cara');
  for (const [id, type] of [
    [1, 'research'],
    [2, 'research'],
    [3, 'chore'],
  ] as const) {
    assert.equal(pool.may(id, type), false, `#${id} may not`);
    assert.equal(pool.takes(id, asks(type)), CLOUD_OFF, `#${id} stays home`);
  }
  assert.ok(pool.mark(2) && pool.mark(3), 'its mark is kept for when the switch is on again');
  store.setSetting(CLOUD_SWITCH, true);
  for (const [id, type] of [
    [1, 'research'],
    [2, 'research'],
    [3, 'chore'],
  ] as const) {
    assert.equal(pool.may(id, type), true);
    assert.equal(pool.takes(id, asks(type)), null);
  }
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
  pool.heard(5, 2, 1, { session: 'session_01otherxyz', gone: true }, NOW + 2);
  assert.equal(pool.session(5)?.session, 'session_01abcdefgh', "another session's gone leaves this one");
  pool.heard(5, 2, 1, { session: 'session_01abcdefgh', gone: true }, NOW + 2);
  assert.equal(pool.session(5), null, 'a session the driver gave up on is forgotten: its next turn runs at perigee');
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
  const sized = pool.job(t, [{ author: 'Josh', text: 'B' }], 'claude', null, NOW, { model: 'opus', effort: 'high' });
  assert.deepEqual([sized.model, sized.effort, sized.cost, first.cost], ['opus', 'high', CLOUD.costUsd.followUp, CLOUD.costUsd.start]);
});

test('a brief stays home when it needs the shared folder, by path or by name, or builds Android', () => {
  const dir = '/home/x/.local/share/claude-coordinator/projects/2/shared/project';
  assert.equal(staysHome(`Read ${dir}/specs/a.md`, dir), true);
  assert.equal(staysHome('Write the report to shared/project/reports/x.md', dir), true);
  assert.equal(staysHome('Put it in the shared folder', dir), true);
  assert.equal(staysHome('Build the APK with ./gradlew assembleRelease', dir), true);
  for (const b of ['Build the app: npx cap build android', 'Run the Android instrumented tests on the emulator', 'run assembleDebug', 'Read the files in the shared dir', 'Read the reports in the shared project folder']) assert.equal(staysHome(b, dir), true, b);
  for (const b of ['Build the Android app.', 'Run the Android tests', 'Use list_tickets to see what ran', 'Count rows in coordinator.db with sqlite3', 'Then close_self']) assert.equal(staysHome(b, dir), true, b);
  assert.equal(staysHome('Compare Android push libraries and their prices', dir), false);
  assert.equal(staysHome('Compare X and Y on the web', dir), false);
});

test("a card's research start carries its handoff's text and goes to the cloud; one whose handoff needs the shared folder stays home", () => {
  const dir = '/home/x/.local/share/claude-coordinator/projects/2/shared/project';
  const pointer = `Start from the handoff ${dir}/handoffs/a.md`;
  const plain = '# Handoff\n\n## Goal\nCompare X and Y.\n';
  const research = handoffBrief(pointer, plain, 'research', dir);
  assert.ok(research.startsWith(pointer), 'the path stays first: the duplicate check, ideas and the tidy read it there');
  assert.ok(research.endsWith(plain), "the session can't open the shared folder, so the text comes along");
  assert.deepEqual(newMark('https://github.com/a/b', undefined, 'research', research, dir), { go: true }, 'the same rule as a create_ticket start');
  assert.equal(handoffBrief(pointer, plain, 'feature', dir), pointer, 'a feature runs at perigee: only the pointer');
  const needs = handoffBrief(pointer, `${plain}Read ${dir}/specs/s.md first.\n`, 'research', dir);
  assert.equal(needs, pointer, 'a handoff that reads the shared folder stays home');
  assert.equal(newMark('https://github.com/a/b', undefined, 'research', needs, dir), null);
  assert.equal(newMark('https://github.com/a/b', undefined, 'research', `${pointer}\n\nAlso read the shared folder`, dir), null, 'a typed brief naming the shared folder still stays home');
});

test('the first message names the branch, the time and what the session lacks; a follow-up only how to answer', () => {
  const first = cloudPrompt({ ticket: 9, branch: 'cloud/t9-a', minutes: 15, first: true, messages: '[Josh]: compare X and Y' });
  assert.match(first, /minion #9's cloud session/);
  assert.match(first, /timeout of up to 110 minutes[^\n]*Never end your turn while a command still runs/);
  assert.match(first, /"job": "cloud\/t9-a"/, 'a result names its job, so one left by another is never read');
  assert.match(first, /longest step should take about 15 minutes/);
  assert.match(first, /\[Josh\]: compare X and Y/);
  assert.match(first, /git push origin HEAD:refs\/heads\/cloud\/t9-a/);
  assert.match(first, /"recommended": true/, 'the questions route refuses a card with no recommended option');
  const next = cloudPrompt({ ticket: 9, branch: 'cloud/t9-a', minutes: 15, first: false, messages: '[Josh]: A' });
  assert.match(next, /^\[Josh\]: A\n/);
  assert.doesNotMatch(next, /minion #9/);
  for (const p of [first, next]) assert.match(p, /Never use AskUserQuestion[^\n]*stop/, 'a question asked in the session is stranded on claude.ai: it goes in the card');
});

/** A line over `size` perigee workers and the cloud, which has no cap: the ones it may take (`marked`) go there first, bound ones only there. */
function line(t: TestContext, size = 1) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const store: LineHost['store'] = { ...settings(), addHealthEvent: () => {} };
  store.setSetting('turn-pool', { size, at: 0, fixed: { size, by: 'cara' } });
  const marked = new Set<number>();
  const bound = new Set<number>();
  const started: string[] = [];
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
    cloud: { bound: (id) => bound.has(id), takes: (id) => (marked.has(id) ? null : 'not marked cloud-ok') },
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
    async end(id: number) {
      steps.get(id)!();
      for (let i = 0; i < 5; i++) await Promise.resolve();
      t.mock.timers.tick(1);
    },
  };
}

test('every turn the cloud may take goes there, though perigee has room, with no cap of ours; the rest wait for perigee', (t) => {
  const x = line(t);
  x.marked.add(1).add(2).add(4);
  assert.equal(x.run(1), true);
  assert.equal(x.l.placeOf(1), CLOUD_PLACE, 'the cloud first');
  assert.equal(x.run(2), true);
  assert.equal(x.l.placeOf(2), CLOUD_PLACE, 'and the next: no cap on sessions at once (Josh, "we shouldnt be adding any limits")');
  assert.equal(x.run(3), true);
  assert.equal(x.l.placeOf(3), 0, 'one the cloud may not take runs at perigee');
  assert.equal(x.run(5), false, 'perigee is full');
  assert.equal(x.run(4), true);
  assert.equal(x.l.placeOf(4), CLOUD_PLACE, 'perigee full is nothing to the cloud');
});

test('a minion whose session is in the cloud runs there and nowhere else', (t) => {
  const x = line(t, 2);
  x.bound.add(2).add(3);
  assert.equal(x.run(2), true);
  assert.equal(x.l.placeOf(2), CLOUD_PLACE, 'bound: the cloud though perigee has room');
  assert.equal(x.run(3), true);
  assert.equal(x.l.placeOf(3), CLOUD_PLACE);
  assert.equal(x.run(5), true, 'an ordinary one takes a free perigee worker');
  assert.equal(x.l.placeOf(5), 0);
});

test('a waiting turn the cloud comes to take goes there the next time the line moves', async (t) => {
  const x = line(t);
  x.run(1);
  assert.equal(x.run(3), false, 'perigee is full and the cloud does not take it yet');
  x.marked.add(3);
  x.run(4);
  await x.end(1);
  assert.equal(x.l.placeOf(3), CLOUD_PLACE);
});

test('with no cloud host the line is as before', (t) => {
  const x = line(t);
  const l = new TurnLine({ ...x.host, cloud: undefined });
  assert.equal(l.enter(1), true);
  assert.equal(l.enter(2), false);
});
