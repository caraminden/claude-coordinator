// Idle receivers (#1603, which dropped #413's cold hold): a machine message (minion↔Taskmaster, Taskmaster↔Taskmaster,
// minion↔minion) meant to wake its receiver wakes it however long it has been idle. Mail held before the change
// still rides the next turn, and the sweep still wakes it after COLD_HOLD_MAX_MS.
// A stand-in `claude -p` writes each turn's prompt to prompts.jsonl and ends.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { COLD_HOLD_MAX_MS, Runner } from '../src/runner.ts';
import { transcriptPath } from '../src/sessions.ts';
import { jsonLines, withoutTurnNote, lines, stopTurns, until, holds, testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'cold-mail-'));
after(async () => {
  await stopTurns(root);
  await until('every session save to end', async () => ![...Array(500).keys()].some((id) => (runner as any).lanes.busy(id)));
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

const prompts = join(root, 'prompts.jsonl');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  require('node:fs').appendFileSync(${JSON.stringify(prompts)}, input + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`,
);
chmodSync(fake, 0o755);

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
/** A ticket whose last turn ended `idleMs` ago, on a session this login can resume (none with idleMs null). */
function ticket(kind: 'coordinator' | 'ticket', idleMs: number | null, projectId?: number) {
  const project = projectId ?? store.createProject(`P${++n}`, null).id;
  const t = store.createTicket({ project_id: project, title: kind === 'coordinator' ? 'Taskmaster' : `M${n}`, permission_mode: 'default', created_by: 'Cara', kind });
  const cwd = join(root, `t${t.id}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  if (idleMs !== null) {
    store.updateTicket(t.id, { session_id: `s${t.id}`, status: 'idle' });
    const file = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, cwd, `s${t.id}`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '{}\n');
    store.recordTurn(t.id, { session_id: `s${t.id}`, ended_at: NOW - idleMs, session_cost_usd: 0 });
  }
  return store.getTicket(t.id)!;
}

const lastMessage = (id: number) =>
  JSON.parse(
    store
      .listEvents(id)
      .filter((e) => e.kind === 'user_message')
      .at(-1)!.data,
  );
const promptCount = () => lines(prompts).length;
const lastPrompt = () => withoutTurnNote(jsonLines(prompts).at(-1).message.content).map((c: any) => c.text);
/** Mail held cold before #1603, as relay() left it then: the sweep's clock starts now. */
const coldMail = (to: number, author: string, text: string, from?: number) => (runner as any).relays.mail(to, author, text, from, true);
async function idle(id: number) {
  // The lane ends with the turn's session save, whose worker thread writes under root (#758): wait for it too.
  await until('the turn and its session save to end', async () => !runner.isRunning(id) && !(runner as any).lanes.busy(id));
}

test("a minion's message to a Taskmaster idle for hours wakes it at once: no cold hold (#1603)", async () => {
  const tm = ticket('coordinator', 2 * 3_600_000);
  const minion = ticket('ticket', 0, tm.project_id);
  const before = promptCount();
  assert.equal(runner.relay(minion.id, tm.id, `#${minion.number} M`, 'please start #9 from its handoff'), false);
  const shown = lastMessage(tm.id);
  assert.equal(shown.mail, undefined);
  assert.equal(shown.cold, undefined);
  await until('the turn', async () => promptCount() > before);
  assert.deepEqual(lastPrompt(), [`[#${minion.number} M]: please start #9 from its handoff`]);
  await idle(tm.id);
  assert.equal(store.getSetting<any>(`minion-queue:${tm.id}`)?.coldAt ?? null, null, 'no cap clock: nothing was held');
});

test("mail held cold before #1603 rides along with the next person's message and clears its cap", async () => {
  const tm = ticket('coordinator', 2 * 3_600_000);
  const minion = ticket('ticket', 0, tm.project_id);
  coldMail(tm.id, `#${minion.number} M`, 'please start #9 from its handoff', minion.id);
  assert.equal(runner.isRunning(tm.id), false);
  assert.equal(store.getSetting<any>(`minion-queue:${tm.id}`)?.coldAt ?? null, NOW);

  const before = promptCount();
  runner.send(tm.id, 'Cara', 'anything new?');
  await until('the turn', async () => promptCount() > before);
  assert.deepEqual(lastPrompt(), ['[Cara]: anything new?', `[Held mail from #${minion.number} M, sent Nov 8, 06:05 PST]: please start #9 from its handoff`]);
  await idle(tm.id);
  assert.equal(store.getSetting<any>(`minion-queue:${tm.id}`)?.coldAt ?? null, null, 'delivered: the cap has nothing left to wake');
});

test("a minion's wake: false message to a Taskmaster, warm or idle, starts no turn and rides along with its next one", async () => {
  for (const idleMs of [0, 2 * 3_600_000]) {
    const tm = ticket('coordinator', idleMs);
    const minion = ticket('ticket', 0, tm.project_id);
    assert.equal(runner.relay(minion.id, tm.id, `#${minion.number} M`, '#9 landed, nothing for you', false, false), 'mail');
    assert.equal(lastMessage(tm.id).mail, true);
    assert.equal(runner.isRunning(tm.id), false, 'a status note must not wake it');
    assert.equal(runner.queued(tm.id), 0);
    assert.equal(store.getSetting<any>(`minion-queue:${tm.id}`)?.coldAt ?? null, null, 'not cold mail: no cap wakes it');

    const before = promptCount();
    runner.send(tm.id, 'Cara', 'anything new?');
    await until('the turn', async () => promptCount() > before);
    assert.deepEqual(lastPrompt(), ['[Cara]: anything new?', `[Held mail from #${minion.number} M, sent Nov 8, 06:05 PST]: #9 landed, nothing for you`]);
    await idle(tm.id);
  }
});

test("the Taskmaster's message to a minion idle 90 minutes wakes it, urgent or not", async () => {
  const tm = ticket('coordinator', 0);
  const minion = ticket('ticket', 90 * 60_000, tm.project_id);
  const before = promptCount();
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', 'Cara says merge it'), false);
  await until('the turn', async () => promptCount() > before);
  assert.deepEqual(lastPrompt(), ['[Taskmaster]: Cara says merge it']);
  await idle(minion.id);
});

// Cara, 2026-11-14: "normal cards in your own minions should initiate a response from that minion" (#702).
test("a card's answer, addressed (#687) or not, wakes an idle asker at once: never held mail", async () => {
  const cold = ticket('coordinator', 2 * 3_600_000);
  const before = promptCount();
  // As routes/tickets.ts deliverAnswer hands every answer, plan verdict and notes verdict back.
  runner.send(cold.id, 'Joshua', 'My answers to your question card: 3 slots', [], { answer: { questionId: 'q1', answers: [{ selected: ['3 slots'], other: '' }] } });
  const shown = lastMessage(cold.id);
  assert.deepEqual([shown.author, shown.mail, shown.cold, shown.answer.questionId], ['Joshua', undefined, undefined, 'q1']);
  assert.equal(store.getSetting<any>(`minion-queue:${cold.id}`)?.held ?? null, null, 'nothing waits in held mail');
  await until('the turn', async () => promptCount() > before);
  assert.deepEqual(lastPrompt(), ['[Joshua]: My answers to your question card: 3 slots']);
  await idle(cold.id);
});

test('a warm session gets machine messages at once, as before', async () => {
  const tm = ticket('coordinator', 0);
  const minion = ticket('ticket', 20 * 60_000, tm.project_id);
  const before = promptCount();
  assert.equal(runner.relay(minion.id, minion.id, 'Taskmaster', 'rebase onto main'), false);
  assert.equal(lastMessage(minion.id).mail, undefined);
  await until('the turn', async () => promptCount() > before);
  await idle(minion.id);
});

test("another scheme's Taskmaster idle for hours: a waking message wakes it, wake: false stays plain news with no cap", async () => {
  const a = ticket('coordinator', 0);
  const b = ticket('coordinator', 4 * 3_600_000);
  const before = promptCount();
  assert.deepEqual(runner.relayTaskmaster(a.id, b.id, 'Taskmaster of P', 'please look at #4'), { held: false, left: 5 });
  await until('the turn', async () => promptCount() > before);
  await idle(b.id);

  const c = ticket('coordinator', 4 * 3_600_000);
  assert.deepEqual(runner.relayTaskmaster(a.id, c.id, 'Taskmaster of P', '#388 is live', false), { held: false, left: 5 });
  assert.equal(lastMessage(c.id).mail, true);
  assert.equal(lastMessage(c.id).cold, undefined);
  assert.equal(runner.isRunning(c.id), false);
  assert.equal(store.getSetting<any>(`minion-queue:${c.id}`)?.coldAt ?? null, null, 'asked-for held mail waits for a turn, however long');
  store.deleteSetting(`minion-queue:${c.id}`);
});

test('the sweep wakes a cold session once its held mail has waited COLD_HOLD_MAX_MS, not before', async () => {
  const tm = ticket('coordinator', 2 * 3_600_000);
  const minion = ticket('ticket', 0, tm.project_id);
  coldMail(tm.id, `#${minion.number} M`, 'my PR is up', minion.id);
  const before = promptCount();
  runner.coldSweep(NOW + COLD_HOLD_MAX_MS - 60_000);
  assert.equal(runner.isRunning(tm.id), false);
  assert.ok(store.getSetting<any>(`minion-queue:${tm.id}`)?.held ?? null);

  runner.coldSweep(NOW + COLD_HOLD_MAX_MS);
  await until('the turn', async () => promptCount() > before);
  assert.deepEqual(lastPrompt(), [`[Held mail from #${minion.number} M, sent Nov 8, 06:05 PST]: my PR is up`]);
  assert.ok(store.listEvents(tm.id).some((e) => e.kind === 'note' && JSON.parse(e.data).text.includes('waited 3 hours')));
  await idle(tm.id);
  assert.equal(store.getSetting<any>(`minion-queue:${tm.id}`)?.coldAt ?? null, null);
  assert.equal(store.getSetting<any>(`minion-queue:${tm.id}`)?.held ?? null, null);
});

test('the sweep delivers held mail at once to a session that went fresh meanwhile', async () => {
  const tm = ticket('coordinator', 2 * 3_600_000);
  const minion = ticket('ticket', 0, tm.project_id);
  coldMail(tm.id, `#${minion.number} M`, 'done', minion.id);
  store.updateTicket(tm.id, { session_id: null });
  const before = promptCount();
  runner.coldSweep(NOW + 60_000);
  await until('the turn', async () => promptCount() > before);
  await idle(tm.id);
});

test('a minion dismissed after its mail was held is not reopened by the cap', async () => {
  const tm = ticket('coordinator', 0);
  const minion = ticket('ticket', 2 * 3_600_000, tm.project_id);
  coldMail(minion.id, 'Taskmaster', '#12 shipped, FYI');
  store.updateTicket(minion.id, { status: 'closed' });
  const before = promptCount();
  runner.coldSweep(NOW + COLD_HOLD_MAX_MS);
  await holds('the cap must not reopen a dismissed minion', () => promptCount() === before && !runner.isRunning(minion.id), { ms: 300 });
  assert.equal(promptCount(), before, 'the cap must not reopen a dismissed minion');
  assert.equal(runner.isRunning(minion.id), false);
  assert.ok(store.getSetting<any>(`minion-queue:${minion.id}`)?.held ?? null, 'its mail waits for a person');
  assert.equal(store.getSetting<any>(`minion-queue:${minion.id}`)?.coldAt ?? null, null);
});

test("cold mail keeps its sender's person, so a turn the cap starts runs as the relay would have", () => {
  const tm = ticket('coordinator', 2 * 3_600_000);
  const minion = ticket('ticket', 0, tm.project_id);
  const seen: [string, number | undefined][] = [];
  runner.personOf = (author, from) => (seen.push([author, from]), from === minion.id ? 42 : null);
  try {
    coldMail(tm.id, `#${minion.number} M`, 'my PR is up', minion.id);
    const [held] = (store.getSetting<any>(`minion-queue:${tm.id}`)?.held ?? null)!;
    assert.equal(held.from, minion.id);
    assert.equal(held.asker, 42);
  } finally {
    runner.personOf = undefined;
    store.deleteSetting(`minion-queue:${tm.id}`);
  }
});

test("held mail outlives a turn whose Claude can't start, and rides along with the next one that can (#468 S03-6)", async () => {
  const tm = ticket('coordinator', 2 * 3_600_000);
  const minion = ticket('ticket', 0, tm.project_id);
  coldMail(tm.id, `#${minion.number} M`, 'please start #9', minion.id);
  const before = promptCount();
  runner.placeFor = () => ({ refused: "Cara's Claude sign-in expired, so this message waits here." });
  try {
    runner.send(tm.id, 'Cara', 'first try');
    assert.equal(runner.isRunning(tm.id), false);
    assert.ok(store.getSetting<any>(`minion-queue:${tm.id}`)?.held ?? null, 'the held mail stays held');
    // The sweep's cap meets the same refusal: the mail still waits.
    runner.coldSweep(NOW + COLD_HOLD_MAX_MS);
    assert.equal(runner.isRunning(tm.id), false);
    assert.ok(store.getSetting<any>(`minion-queue:${tm.id}`)?.held ?? null, 'the sweep keeps it held too');
  } finally {
    runner.placeFor = undefined;
  }
  runner.send(tm.id, 'Cara', 'second try');
  await until('the turn', async () => promptCount() > before);
  // The refused message itself is dropped, as the refusal note says; kept, it would make every later batch hers (#1378 review).
  assert.deepEqual(lastPrompt(), ['[Cara]: second try', `[Held mail from #${minion.number} M, sent Nov 8, 06:05 PST]: please start #9`]);
  await idle(tm.id);
});

// Minions message each other directly (#783): an idle one wakes like any other (#1603); wake: false stays held mail.
test("a minion's message to an idle minion wakes it, the wake: false one along", async () => {
  const tm = ticket('coordinator', 0);
  const sender = ticket('ticket', 0, tm.project_id);
  const cold = ticket('ticket', 90 * 60_000, tm.project_id);
  assert.equal(runner.relayMinion(sender.id, cold.id, `#${sender.number} M`, 'FYI: I renamed foo()', false, false), 'mail');
  assert.equal(lastMessage(cold.id).mail, true);
  assert.equal(runner.isRunning(cold.id), false, 'news it need not act on waits');

  const before = promptCount();
  assert.equal(runner.relayMinion(sender.id, cold.id, `#${sender.number} M`, 'Blocked: which port does your server use?'), false);
  await until('the turn', async () => promptCount() > before);
  assert.deepEqual(lastPrompt(), [`[#${sender.number} M]: Blocked: which port does your server use?`, `[Held mail from #${sender.number} M, sent Nov 8, 06:05 PST]: FYI: I renamed foo()`]);
  await idle(cold.id);
  assert.equal(store.getSetting(`loop:${cold.id}`), null, "not counted on the receiver's loop with its Taskmaster");
});
