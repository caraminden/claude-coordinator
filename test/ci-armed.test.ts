import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { armedKey, armForCi, ciFinished, registerCiArmed, type Armed } from '../src/ci-armed.ts';
import { Outbox, type OutboxRunner } from '../src/outbox.ts';
import { Store } from '../src/db.ts';
import { GithubWatcher, type Check, type PrSnapshot } from '../src/github.ts';
import { git } from './git.ts';

// Armed for CI (#715): a card or a Taskmaster message goes out when CI passes on the pushed commit, with no turn.
const root = mkdtempSync(join(tmpdir(), 'ci-armed-'));
after(() => rmSync(root, { recursive: true, force: true }));

const check = (name: string, status: Check['status']): Check => ({ name, status, url: `https://ci/${name}` });
const pr = (headSha: string, fields: Partial<PrSnapshot> = {}): PrSnapshot => ({ number: 12, url: 'https://github.com/o/r/pull/12', state: 'OPEN', headSha, closedAt: null, closedBy: null, checks: [check('build', 'passed')], remarks: [], ...fields });
const card = { questions: [{ question: 'Merge PR #12?', multiSelect: false, options: [{ label: 'Merge it', recommended: true }, { label: 'Wait' }] }], kind: 'merge' as const };

/** A minion on a branch in a repo whose CI runs on pull requests (`prCi`), with a fake runner that records what it's told. */
function setup(name: string, prCi = true) {
  const dir = join(root, name);
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), prCi ? 'on:\n  pull_request:\n  push:\n' : 'on:\n  push:\n    branches: ["land/**"]\n');
  git(dir, 'init', '-q', '-b', 'ticket/1-t');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'one');
  const sha = git(dir, 'rev-parse', 'HEAD');
  const store = new Store(join(root, `${name}.db`));
  const project = store.createProject('P', null);
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, dir, 'ticket/1-t');
  const ticket = store.getTicket(t.id)!;
  const log = { events: [] as [string, any][], relays: [] as string[], wakes: [] as boolean[], notified: [] as any[], running: false, held: false as boolean | 'mail' };
  const runner = {
    emit: (_id: number, kind: string, data: any) => (log.events.push([kind, data]), { id: log.events.length }),
    broadcastTicket: () => {},
    isRunning: () => log.running,
    queued: () => 0,
    relay: (_from: number, _to: number, _author: string, text: string, _urgent: boolean, wake: boolean) => (log.held === true ? true : (log.relays.push(text), log.wakes.push(wake), log.held)),
  };
  const outbox = new Outbox(store, { send: () => ({ event: { id: 1 } }), holds: () => false, onLane: (_i: number, _w: string, step: () => unknown) => Promise.resolve().then(step), leaveMail: () => {} } as unknown as OutboxRunner, { author: 'Citadel' });
  const app = { store, runner, outbox, dataDir: join(root, `${name}-data`), notify: (_id: number, n: any) => log.notified.push(n) } as any;
  registerCiArmed(() => app, store, outbox);
  const armedRow = () => store.listDeliveries({ kind: 'ci_armed', to: ticket.id, states: ['waiting'] })[0];
  return { dir, sha, store, ticket, app, log, outbox, armedRow };
}
const boot = (s: { outbox: Outbox }) => s.outbox.boot();
/** CI finished: the watcher's call, then the outbox's send. */
async function finish(s: ReturnType<typeof setup>, ...args: [any, 'passed' | 'failed']) {
  await s.outbox.boot(); // nothing is sent before boot
  const got = await ciFinished(s.app, s.ticket, ...args);
  await s.outbox.poke({ type: 'tick' });
  return got;
}

test('arming holds a card on HEAD, says to push, and a second arm on the same commit adds to it', async () => {
  const { sha, ticket, app, log, armedRow } = setup('arm');
  const said = await armForCi(app, ticket, { card });
  assert.match(said!, new RegExp(`CI passes on ${sha.slice(0, 7)}`));
  assert.match(said!, /push it/, 'origin has no copy of HEAD yet');
  await armForCi(app, ticket, { coordinator: { text: 'ready to merge', urgent: false } });
  const armed = armedRow().payload as Armed;
  assert.equal(armed.sha, sha);
  assert.equal(armedRow().when_arg, sha);
  assert.deepEqual(armed.card, card);
  assert.equal(armed.coordinator!.text, 'ready to merge');
  assert.equal(log.events.length, 0, 'nothing posted yet');
});

test('arming is refused where PRs run no CI, or CI already failed on HEAD; CI already green means post now', async () => {
  const none = setup('nopr', false);
  await assert.rejects(armForCi(none.app, none.ticket, { card }), /doesn't run on pull requests/);
  const red = setup('red');
  red.store.addGithubSeen(red.ticket.id, [`pr12:ci:${red.sha}:failed`], true);
  await assert.rejects(armForCi(red.app, red.ticket, { card }), /already failed/);
  const green = setup('green');
  green.store.addGithubSeen(green.ticket.id, [`pr12:ci:${green.sha}:passed`], true);
  assert.equal(await armForCi(green.app, green.ticket, { card }), null);
  green.store.addGithubSeen(green.ticket.id, [`pr12:ci:${green.sha}:failed`], true);
  assert.equal(await armForCi(green.app, green.ticket, { card }), null, 'a green re-run after a red one counts as green');
  assert.equal(green.armedRow(), undefined, 'nothing armed: the caller posts it');
});

test('CI passing on the armed commit posts the card and tells the Taskmaster, with no turn, once', async () => {
  const s = setup('fire');
  const { sha, store, ticket, app, log } = s;
  await armForCi(app, ticket, { card, coordinator: { text: 'PR #12 is green', urgent: false } });
  const got = await finish(s, pr(sha), 'passed');
  assert.equal(got!.fired, true);
  assert.match(got!.note, /armed card and Taskmaster message is going out/);
  assert.equal(log.events.filter(([k]) => k === 'question').length, 1, 'once');
  const question = log.events.find(([k]) => k === 'question')![1];
  assert.deepEqual(question.questions, card.questions);
  assert.equal(question.kind, 'merge');
  assert.deepEqual(log.relays, ['PR #12 is green']);
  assert.equal(store.getTicket(ticket.id)!.state, null, "a card is people's turn");
  assert.match(store.getTicket(ticket.id)!.note!, /CI passed on \w{7}: card posted/);
  assert.deepEqual(
    log.notified.filter((n) => n.kind === 'state'),
    [],
    'the card is the ping: no state ping, the state being null',
  );
  assert.equal(await finish(s, pr(sha), 'passed'), null, 'used up');
  assert.equal(log.events.filter(([k]) => k === 'question').length, 1, 'still once');
});

test('a message alone leaves the minion ready for a person, and pings them with the note it just wrote', async () => {
  const s = setup('msg');
  const { sha, store, ticket, app, log } = s;
  await armForCi(app, ticket, { coordinator: { text: 'ready to merge', urgent: false } });
  assert.equal((await finish(s, pr(sha), 'passed'))!.fired, true);
  const row = store.getTicket(ticket.id)!;
  assert.equal(row.state, 'ready');
  // The ping carries what was written, not a read-back of the row, which a loaded box answers from before the write (#1634).
  assert.deepEqual(log.notified, [{ kind: 'state', state: 'ready', note: row.note }]);
});

test('CI failing, CI on another head or a running turn drops what was armed and says so', async () => {
  for (const [name, head, result, running, why] of [
    ['fail', null, 'failed', false, /CI failed/],
    ['moved', 'f00dfeed', 'passed', false, /head is now f00dfee/],
    ['busy', null, 'passed', true, /a turn was running/],
  ] as const) {
    const s = setup(name);
    s.log.running = running;
    await armForCi(s.app, s.ticket, { card });
    const got = await finish(s, pr(head ?? s.sha), result);
    assert.equal(got!.fired, false, name);
    assert.match(got!.note, why);
    assert.equal(s.log.events.filter(([k]) => k === 'question').length, 0, `${name}: no card`);
    assert.equal(s.armedRow(), undefined, `${name}: dropped`);
  }
});

test('the watcher sends a fired CI line as held mail and wakes for the rest; a dropped one wakes with the note', async () => {
  const { sha, store, ticket } = setup('watch');
  let snapshot = pr(sha, { checks: [check('build', 'pending')] });
  const sent: { text: string; fyi: boolean; quiet?: boolean }[] = [];
  const w = new GithubWatcher(
    store,
    (_id, text, fyi, quiet) => sent.push({ text, fyi, quiet }),
    async () => ({ pr: snapshot, self: 'cara' }),
  );
  let answer: { fired: boolean; note: string } | null = { fired: true, note: 'The card you armed is posted.' };
  w.onCi = async () => answer;
  await w.poll(ticket, root, 'o/r'); // the first look
  snapshot = pr(sha, { remarks: [{ key: 'comment:1', kind: 'comment', author: 'josh', bot: false, association: 'COLLABORATOR', body: 'nice', url: 'https://x/1', createdAt: Date.now() }] });
  await w.poll(ticket, root, 'o/r');
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /^CI passed on .*\nThe card you armed is posted\.$/);
  assert.equal(sent[0].quiet, true, 'held mail, no turn');
  assert.match(sent[1].text, /josh commented/);
  assert.notEqual(sent[1].quiet, true);

  answer = { fired: false, note: "The card you armed wasn't sent: CI failed." };
  snapshot = pr('beef', { checks: [check('build', 'passed')] });
  await w.poll(ticket, root, 'o/r');
  assert.match(sent[2].text, /^CI passed on beef.*\nThe card you armed wasn't sent/);
  assert.equal(sent[2].quiet, false);
  assert.equal(sent[2].fyi, false, 'it needs action now');
});

test('a fired arm on the first look at a PR still lands as held mail', async () => {
  const { sha, store, ticket } = setup('base');
  const sent: { text: string; quiet?: boolean }[] = [];
  const w = new GithubWatcher(
    store,
    (_id, text, _fyi, quiet) => sent.push({ text, quiet }),
    async () => ({ pr: pr(sha), self: 'cara' }),
  );
  w.onCi = async () => ({ fired: true, note: 'The card you armed is posted.' });
  await w.poll(ticket, root, 'o/r');
  assert.deepEqual(sent, [{ text: 'The card you armed is posted.', quiet: true }]);
});

test('an armed held-mail message stays held mail when it goes out', async () => {
  const s = setup('quietmsg');
  const { sha, ticket, app, log } = s;
  await armForCi(app, ticket, { coordinator: { text: 'landed, nothing to do', urgent: false, wake: false } });
  assert.equal((await finish(s, pr(sha), 'passed'))!.fired, true);
  assert.deepEqual(log.wakes, [false]);
});

test('a message the loop guard holds counts as sent (the guard keeps it): no retry, no second card', async () => {
  const s = setup('heldmsg');
  const { sha, store, ticket, app, log } = s;
  log.held = true;
  await armForCi(app, ticket, { card, coordinator: { text: 'PR #12 is green', urgent: false } });
  await finish(s, pr(sha), 'passed');
  assert.equal(store.listDeliveries({ kind: 'ci_armed' })[0].state, 'sent');
  assert.equal(log.events.filter(([k]) => k === 'question').length, 1, 'the card went out once');
  assert.equal(store.getTicket(ticket.id)!.state, null, "a card is people's turn");
});

test("a message that throws is retried without posting the card again, and the minion isn't marked ready", async () => {
  const s = setup('throwmsg');
  const { sha, store, ticket, app, log } = s;
  let fail = true;
  const relay = app.runner.relay;
  app.runner.relay = (...a: any[]) => {
    if (fail) throw new Error('boom');
    return relay(...a);
  };
  await armForCi(app, ticket, { card, coordinator: { text: 'm', urgent: false } });
  await finish(s, pr(sha), 'passed');
  const [row] = store.listDeliveries({ kind: 'ci_armed' });
  assert.equal(row.state, 'waiting');
  assert.equal(log.events.filter(([k]) => k === 'question').length, 1);
  fail = false;
  store.updateDelivery(row.id, { due: Date.now() - 1 }, ['waiting']);
  await s.outbox.poke({ type: 'tick' });
  assert.equal(store.getDelivery(row.id)!.state, 'sent');
  assert.equal(log.events.filter(([k]) => k === 'question').length, 1, 'still once');
  assert.equal(store.getTicket(ticket.id)!.state, null, 'a card is out: not ready');
});

test('a re-arm on a new commit while a send is being retried is a new wait', async () => {
  const s = setup('rearmmet');
  await armForCi(s.app, s.ticket, { card });
  const [row] = s.store.listDeliveries({ kind: 'ci_armed' });
  s.store.updateDelivery(row.id, { met_at: Date.now(), due: Date.now() + 60000 }, ['waiting']);
  git(s.dir, 'commit', '-q', '--allow-empty', '-m', 'two');
  await armForCi(s.app, s.ticket, { card });
  assert.equal(s.store.getDelivery(row.id)!.state, 'dropped');
  assert.equal(s.armedRow().met_at, null);
});

test('a second arm on a new commit replaces the first', async () => {
  const s = setup('rearm');
  await armForCi(s.app, s.ticket, { card });
  git(s.dir, 'commit', '-q', '--allow-empty', '-m', 'two');
  await armForCi(s.app, s.ticket, { coordinator: { text: 'm', urgent: false } });
  const rows = s.store.listDeliveries({ kind: 'ci_armed' });
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].when_arg, s.sha);
  assert.equal(rows[0].payload.card, undefined);
});

test('boot moves an old ci-armed key into the table in one step, and none is dropped', async () => {
  const s = setup('migrate');
  s.store.setSetting(armedKey(s.ticket.id), { sha: s.sha, at: 1, card } satisfies Armed);
  s.store.setSetting('ci-armed:99999', { sha: 'abc', at: 1, card } satisfies Armed);
  await boot(s);
  assert.equal(s.store.getSetting(armedKey(s.ticket.id)), null);
  assert.equal(s.armedRow().when_arg, s.sha);
  assert.deepEqual(s.armedRow().payload.card, card);
  assert.equal(s.store.listDeliveries({ kind: 'ci_armed' }).length, 2);
});

test('boot reconciles: CI that passed while the server was down posts the card; red CI drops the row', async () => {
  const ok = setup('bootok');
  await armForCi(ok.app, ok.ticket, { card });
  ok.store.addGithubSeen(ok.ticket.id, [`pr12:ci:${ok.sha}:passed`], true);
  await boot(ok);
  assert.equal(ok.log.events.filter(([k]) => k === 'question').length, 1);
  const red = setup('bootred');
  await armForCi(red.app, red.ticket, { card });
  red.store.addGithubSeen(red.ticket.id, [`pr12:ci:${red.sha}:failed`], true);
  await boot(red);
  assert.equal(red.log.events.length, 0);
  assert.equal(red.store.listDeliveries({ kind: 'ci_armed' })[0].state, 'dropped');
});

test("a dismissed minion's armed row is held for 3 days", async () => {
  const s = setup('dismissed');
  await armForCi(s.app, s.ticket, { card });
  await boot(s);
  s.store.updateTicket(s.ticket.id, { status: 'closed' });
  await s.outbox.poke({ type: 'closed' });
  assert.equal(s.store.listDeliveries({ kind: 'ci_armed' })[0].state, 'held');
  assert.match(s.store.listDeliveries({ kind: 'ci_armed' })[0].payload.note, /armed card for CI/);
});
