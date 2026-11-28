// Message settings (#1059) and held mail in the chat (#1067): a scheme's own loop-guard and cold numbers change behaviour
// inside their bounds, a chat's view says what is held and Continue / Deliver now send it, a never-hold kind wakes its
// reader, and no number is typed into tool text.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Approvals } from '../src/approvals.ts';
import { inboxItems } from '../src/inbox.ts';
import { cleanMsgSettings, cleanNeverHold, heldToolText, MSG_BOUNDS, MSG_COLUMNS, MSG_DEFAULTS, msgEnv, msgFromEnv, msgSettings, NEVER_HOLD_KINDS, neverHold } from '../src/msg-settings.ts';
import { Runner } from '../src/runner.ts';
import { loopKey, minionPairKey } from '../src/minion-relay.ts';
import { NEVER_HOLD_KINDS as CLIENT_KINDS } from '../public/heldmsg.js';
import { transcriptPath } from '../src/sessions.ts';
import { fakeClaude, stopTurns, testPins, until } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'held-list-'));
after(async () => {
  await stopTurns(root);
  await until('every session save to end', async () => ![...Array(500).keys()].some((id) => (runner as any).lanes.busy(id)));
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = fakeClaude(root);

const NOW = Date.UTC(2026, 10, 8, 14, 5);
const store = new Store(join(root, 'test.db'));
const runner = new Runner(
  store,
  () => {},
  () => ({}),
  fake,
);
runner.now = () => NOW;

let n = 0;
/** A scheme with `msg` settings, its Taskmaster and one minion idle `idleMs` (a session it can resume). */
function scheme(msg: Record<string, number>, idleMs = 0) {
  const project = store.createProject(`Held${++n}`, null);
  store.setProjectSettings(project.id, msg);
  const mk = (kind: 'coordinator' | 'ticket', idle: number) => {
    const t = store.createTicket({ project_id: project.id, title: kind === 'coordinator' ? 'Taskmaster' : `M${n}`, permission_mode: 'default', created_by: 'Cara', kind });
    const cwd = join(root, `t${t.id}`);
    mkdirSync(cwd, { recursive: true });
    store.setTicketDir(t.id, cwd, null);
    store.updateTicket(t.id, { session_id: `s${t.id}`, status: 'idle' });
    const file = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, cwd, `s${t.id}`);
    mkdirSync(dirname(file!), { recursive: true });
    writeFileSync(file!, '{}\n');
    store.recordTurn(t.id, { session_id: `s${t.id}`, ended_at: NOW - idle, session_cost_usd: 0 });
    return store.getTicket(t.id)!;
  };
  return { project: store.getProject(project.id)!, tm: mk('coordinator', 0), minion: mk('ticket', idleMs) };
}

test('the defaults are what the constants were, and a scheme with none set reads them', () => {
  assert.deepEqual(MSG_DEFAULTS, { loopLimit: 6, loopMin: 10, coldMin: 55, holdH: 3 });
  const { project } = scheme({});
  assert.deepEqual(msgSettings(project), MSG_DEFAULTS);
  assert.equal(msgEnv(msgSettings(project)), undefined, 'the defaults add no env var, so the prompt hash stays put');
});

test('the bounds: each edge saves, one past refuses, and out-of-range stored values read as the default', () => {
  for (const [k, [lo, hi]] of Object.entries(MSG_BOUNDS)) {
    const col = MSG_COLUMNS[k as keyof typeof MSG_COLUMNS];
    for (const v of [lo, hi]) assert.deepEqual(cleanMsgSettings({ [col]: v }), { [col]: v });
    for (const v of [lo - 1, hi + 1, 1.5, '5', null, NaN]) assert.throws(() => cleanMsgSettings({ [col]: v }), /whole number/, `${col}=${String(v)}`);
    assert.equal(msgSettings({ [col]: hi + 1 })[k as keyof typeof MSG_BOUNDS], MSG_DEFAULTS[k as keyof typeof MSG_BOUNDS]);
  }
  assert.equal(MSG_BOUNDS.coldMin[1], 55, 'cold stays at or under 55 minutes: the prompt cache lapses past an hour');
  const client = readFileSync(new URL('../public/minion-rules.js', import.meta.url), 'utf8');
  const cols = Object.values(MSG_COLUMNS);
  const bounds = Object.entries(MSG_BOUNDS)
    .map(([k, b]) => `${MSG_COLUMNS[k as keyof typeof MSG_COLUMNS]}: [${b.join(', ')}]`)
    .join(', ');
  const defaults = Object.entries(MSG_DEFAULTS)
    .map(([k, v]) => `${MSG_COLUMNS[k as keyof typeof MSG_COLUMNS]}: ${v}`)
    .join(', ');
  assert.ok(client.includes(`{ ${bounds} }`) && client.includes(`{ ${defaults} }`) && cols.length === 4, "public/minion-rules.js's copy of the bounds and defaults matches");
});

test('the settings reach the tool text through the turn env, and no number is typed into it', () => {
  const s = { loopLimit: 4, loopMin: 20, coldMin: 30, holdH: 8 };
  assert.deepEqual(msgFromEnv(msgEnv(s)), s);
  assert.deepEqual(msgFromEnv(undefined), MSG_DEFAULTS);
  assert.match(heldToolText(s, 'x'), /\(4 messages in 20 minutes\)/);
});

test("a scheme's own loop count and window hold the next message; the chat's row, card and Needs you show it until Continue", () => {
  const { tm, minion } = scheme({ msg_loop_limit: 3, msg_loop_min: 5 });
  for (let i = 0; i < 3; i++) assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', `go ${i}`, false, false), 'mail');
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', 'one too many'), true, 'the fourth is held at a count of 3');
  const hold = runner.view(store.getTicket(minion.id)!).loop_hold;
  assert.deepEqual(hold, { n: 1, at: NOW, text: 'one too many' });
  const loops = inboxItems(store, new Approvals(() => {}), minion.project_id, 'Cara').filter((i) => i.kind === 'loop');
  assert.deepEqual(
    loops.map((i) => [i.ticketId, i.at]),
    [[minion.id, NOW]],
    'one Needs-you item, in the chat whose Continue sends it',
  );
  assert.equal(runner.continueLoop(minion.id, 'Cara'), 1);
  assert.equal(runner.view(store.getTicket(minion.id)!).loop_hold, null);
  assert.equal(inboxItems(store, new Approvals(() => {}), minion.project_id, 'Cara').filter((i) => i.kind === 'loop').length, 0);
  assert.ok(tm.id);
});

test("a message the loop guard held doesn't reopen a minion dismissed since, when someone writes in another chat", () => {
  const { minion } = scheme({});
  store.setSetting(loopKey(minion.id), { sent: [NOW], held: [{ to: minion.id, author: 'Taskmaster', text: 'late word', from: minion.id, at: NOW }] });
  store.updateTicket(minion.id, { status: 'closed' });
  assert.equal(runner.continueLoops([minion.id], 'Cara'), 1);
  assert.equal(store.getTicket(minion.id)!.status, 'closed', 'still dismissed');
  assert.equal(runner.isRunning(minion.id), false);
});

test("two minions' held loop shows in both chats, so dismissing the receiver leaves it with the sender", () => {
  const { minion: a } = scheme({});
  const b = store.createTicket({ project_id: a.project_id, title: 'B', permission_mode: 'default', created_by: 'Cara' });
  store.setSetting(minionPairKey(a.id, b.id), { sent: [NOW], held: [{ to: b.id, author: 'A', text: 'over to you', from: a.id, at: NOW }] });
  assert.deepEqual(
    [a.id, b.id].map((id) => runner.view(store.getTicket(id)!).loop_hold),
    [
      { n: 1, at: NOW, text: 'over to you' },
      { n: 1, at: NOW, text: 'over to you' },
    ],
  );
  store.updateTicket(b.id, { status: 'closed' });
  const loops = () => inboxItems(store, new Approvals(() => {}), a.project_id, 'Cara').filter((i) => i.kind === 'loop' && [a.id, b.id].includes(i.ticketId));
  assert.deepEqual(
    loops().map((i) => i.ticketId),
    [a.id],
    'the open sender still lists it in Needs you',
  );
  assert.equal(runner.continueLoop(a.id, 'Cara'), 1, "the sender's Continue lets it through");
  assert.equal(loops().length, 0);
});

test("the chat's card lists mail held cold before #1603 until Deliver now sends it", async () => {
  const { project, minion } = scheme({}, 20 * 60_000);
  (runner as any).relays.mail(minion.id, 'Taskmaster', `rebase onto main with ghp_${'a'.repeat(36)}`, undefined, true, 'ask');
  const held = runner.view(store.getTicket(minion.id)!).held_mail!;
  assert.equal(held.until, NOW + 3 * 3_600_000, 'cold mail goes by the hold cap at the latest');
  assert.deepEqual(
    held.items.map((i) => [i.author, i.need, i.note, i.parked, i.text]),
    [['Taskmaster', 'ask', false, false, 'rebase onto main with [GitHub token hidden]']],
    "the card shows the chat's copy, its token hidden",
  );
  assert.equal(runner.releaseMail(store.getTicket(minion.id)!, project, 'Cara'), 1);
  await until('the delivered turn', async () => !runner.isRunning(minion.id) && !runner.view(store.getTicket(minion.id)!).held_mail);
});

test('never hold (#1067): a kind the scheme never holds wakes its reader, even a fyi or wake: false; other kinds still wait', async () => {
  assert.throws(() => cleanNeverHold('fyi'), /list/);
  assert.throws(() => cleanNeverHold(['fyi', 'shout']), /must be a list of/);
  assert.equal(cleanNeverHold(['note', 'fyi', 'fyi']), 'fyi,note');
  assert.deepEqual([...neverHold({ msg_never_hold: 'fyi,bogus' })], ['fyi'], 'an unknown stored kind is ignored');
  const { project, minion } = scheme({}, 20 * 60_000);
  store.setProjectSettings(project.id, { msg_never_hold: 'decision,note' });
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', 'held still', false, false, 'ask'), 'mail', 'ask is not on the list, so wake: false mail waits');
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', 'pick one', false, false, 'decision'), false, 'a decision wakes it though it was sent with wake: false');
  await until('the woken turn', async () => !runner.isRunning(minion.id));
  const tm = scheme({}).tm;
  store.setProjectSettings(tm.project_id, { msg_never_hold: 'note' });
  runner.leaveMail(tm.id, 'Citadel', 'a red scheduled run');
  assert.equal(runner.view(store.getTicket(tm.id)!).held_mail, null, "Citadel's notes are sent, not held");
  await until('the note turn', async () => !runner.isRunning(tm.id));
  const plain = scheme({});
  runner.leaveMail(plain.tm.id, 'Citadel', 'a red scheduled run');
  assert.deepEqual(
    runner.view(store.getTicket(plain.tm.id)!).held_mail!.items.map((i) => [i.note, i.text]),
    [[true, 'a red scheduled run']],
    'by default a note is held, marked as one',
  );
  assert.deepEqual(CLIENT_KINDS, NEVER_HOLD_KINDS, "public/heldmsg.js's copy of the kinds matches");
});
