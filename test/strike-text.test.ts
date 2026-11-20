import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { writeOffThread } from '../src/db-writer.ts';
import { Store } from '../src/db.ts';
import { afterAllWrites, writes } from '../src/http.ts';
import { Runner } from '../src/runner.ts';
import { noteStrike, struckSource } from '../public/strike.js';
import { stopTurns, testPins } from './helpers.ts';
testPins();

// strike_text: a thread proven wrong strikes its own words, in its replies or in the messages it
// sent another thread. A stand-in `claude -p` ends every turn at once.
const root = mkdtempSync(join(tmpdir(), 'strike-text-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
writeFileSync(fake, `#!${process.execPath}
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
chmodSync(fake, 0o755);

const reply = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

test('strikes the newest reply or relayed message holding the words, with a note in both chats', () => {
  const store = new Store(join(root, 'runner.db'));
  const project = store.createProject('P', null);
  const coordinator = store.createTicket({ project_id: project.id, kind: 'coordinator', title: 'Coordinator', permission_mode: 'default', created_by: 'Taskmaster' });
  const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  for (const t of [coordinator, minion]) store.setTicketDir(t.id, root, null);
  const runner = new Runner(store, () => {}, () => ({}), fake);
  runner.now = () => 5;

  const old = store.addEvent(minion.id, 'claude', reply('#12 is **not** merged yet.'));
  runner.relay(minion.id, coordinator.id, '#1 M', 'Heads up: #12 is **not** merged yet.');
  // The Taskmaster's message to the minion is the Taskmaster's words, not the minion's.
  runner.relay(minion.id, minion.id, 'Taskmaster', 'It is merged: #12 is **not** merged yet is wrong.');

  assert.deepEqual(runner.strike(minion.id, '#12 is **not** merged yet', 'git log main shows it.'), { ticketId: coordinator.id });
  const relayed = store.listEvents(coordinator.id).find((e) => e.kind === 'user_message')!;
  assert.deepEqual(JSON.parse(relayed.data).strikes, [{ text: '#12 is **not** merged yet', reason: 'git log main shows it.', at: 5 }]);
  assert.equal(JSON.parse(store.listEvents(minion.id).find((e) => e.id === old.id)!.data).strikes, undefined);
  // The chat showing the message redraws it; both chats get the note.
  assert.deepEqual(store.listEvents(coordinator.id).filter((e) => e.kind === 'strike').map((e) => JSON.parse(e.data).event), [relayed.id]);
  // The note in the minion's own chat says which chat shows the message; the one beside it needn't.
  const note = (id: number) => JSON.parse(store.listEvents(id).find((e) => e.kind === 'note')!.data);
  assert.deepEqual(note(coordinator.id).strike, { quote: '#12 is not merged yet', reason: 'git log main shows it.', chat: null });
  assert.deepEqual(note(minion.id).strike, { quote: '#12 is not merged yet', reason: 'git log main shows it.', chat: { project: project.id, number: null } });
  assert.equal(note(minion.id).text, 'Struck through as wrong in the Taskmaster\'s chat: "#12 is not merged yet". git log main shows it.');

  // Once that one is struck, the same words again are refused; words only in an older reply strike that.
  assert.throws(() => runner.strike(minion.id, '#12 is **not** merged yet', 'again'), /already/);
  store.addEvent(minion.id, 'claude', reply('Also, the deploy failed.'));
  assert.deepEqual(runner.strike(minion.id, 'the deploy failed', 'It went live at 10:02.'), { ticketId: minion.id });
  assert.throws(() => runner.strike(minion.id, 'never said this', 'x'), /Quote it exactly/);
  // The Taskmaster strikes its own message in the minion's chat.
  assert.deepEqual(runner.strike(coordinator.id, 'It is merged', 'It was reverted.'), { ticketId: minion.id });
  assert.deepEqual(JSON.parse(store.listEvents(coordinator.id).filter((e) => e.kind === 'note').at(-1)!.data).strike.chat, { project: project.id, number: minion.number });
  runner.detachAll();
});

test('searches only the newest 500 replies, counting replies with text, not tool calls (#622)', () => {
  const store = new Store(join(root, 'cap.db'));
  const project = store.createProject('P', null);
  const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(minion.id, root, null);
  const runner = new Runner(store, () => {}, () => ({}), fake);
  store.addEvent(minion.id, 'claude', reply('The old wrong claim.'));
  store.addEvent(minion.id, 'claude', reply('The newer wrong claim.'));
  // Tool calls and results show no words, so 600 of them don't push either claim out of reach.
  for (let i = 0; i < 600; i++) store.addEvent(minion.id, 'claude', { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
  for (let i = 0; i < 499; i++) store.addEvent(minion.id, 'claude', reply(`Step ${i}.`));
  assert.deepEqual(runner.strike(minion.id, 'newer wrong claim', 'x'), { ticketId: minion.id });
  // 501 replies back is past the search.
  assert.throws(() => runner.strike(minion.id, 'old wrong claim', 'x'), /None of your newest 500 replies/);
  runner.detachAll();
});

test('on a stalled disk, two strikes on one message sent at once both stick, and a sent message comes back as written (#1285)', async () => {
  const store = new Store(join(root, 'stalled.db'));
  const project = store.createProject('P', null);
  const minion = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(minion.id, root, null);
  const runner = new Runner(store, () => {}, () => ({}), fake);
  const said = store.addEvent(minion.id, 'claude', reply('The deploy failed. And #12 is not merged.'));
  const w = writeOffThread(store, { delayMs: 300 })!;
  try {
    // D2a: what send wrote, not a re-read, which the stalled write would leave on the message before it.
    store.addEvent(minion.id, 'user_message', { author: 'Cara', text: 'earlier' });
    const sent = runner.send(minion.id, 'Cara', '@Josh look', [], { typed: true }, false);
    assert.equal(JSON.parse(sent.event.data).text, '@Josh look');
    assert.equal(sent.event.kind, 'user_message');
    // D2b: as the strike route does, each in a request of its own; the second reads after the first has landed.
    const strike = (quote: string) => writes.request.run({ seq: 0 }, () => afterAllWrites(() => runner.strike(minion.id, quote, 'wrong')));
    await Promise.all([strike('The deploy failed.'), strike('#12 is not merged.')]);
    assert.ok(w.drain(10_000));
    const data = JSON.parse(store.listEvents(minion.id).find((e) => e.id === said.id)!.data);
    assert.deepEqual(data.strikes.map((s: { text: string }) => s.text).sort(), ['#12 is not merged.', 'The deploy failed.']);
  } finally {
    runner.detachAll();
    await w.stop();
  }
});

test('struck words render as ~~strikethrough~~ line by line, keeping list and quote markers', () => {
  assert.equal(struckSource('a b c', [{ text: 'b' }]), 'a ~~b~~ c');
  assert.equal(struckSource('x\n- one\n- two\ny', [{ text: 'one\n- two' }]), 'x\n- ~~one~~\n- ~~two~~\ny');
  assert.equal(struckSource('> quoted claim', [{ text: '> quoted claim' }]), '> ~~quoted claim~~');
  assert.equal(struckSource('same same', [{ text: 'same' }]), '~~same~~ same');
  assert.equal(struckSource('untouched', undefined), 'untouched');
  assert.equal(struckSource('gone', [{ text: 'missing' }]), 'gone');
});

test('a strike note is read from its payload, or from the text of a note written before it had one', () => {
  assert.deepEqual(noteStrike({ text: 'x', strike: { quote: 'q', reason: 'r', chat: null } }), { quote: 'q', reason: 'r', chat: null });
  assert.deepEqual(noteStrike({ text: 'Struck through as wrong: "it is merged". It was "reverted". Then fixed.' }), { quote: 'it is merged', reason: 'It was "reverted". Then fixed.' });
  assert.equal(noteStrike({ text: 'Stopped by user.' }), null);
});
