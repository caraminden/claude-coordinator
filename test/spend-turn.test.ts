import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Approvals } from '../src/approvals.ts';
import { Store } from '../src/db.ts';
import { inboxItems } from '../src/inbox.ts';
import { Runner } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// The spend alert on a real turn's stream (#723): a fake `claude -p` streams Opus messages of $10 each (2.5M input
// tokens), `before` of them, then waits for the go file and streams `after` more before its result. Each message
// comes as two events with the usage repeated, as claude sends a message's blocks.
const root = mkdtempSync(join(tmpdir(), 'spend-turn-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
const script = join(root, 'script.json');
const go = join(root, 'go');
writeFileSync(
  fake,
  `#!${process.execPath}
const { existsSync, readFileSync } = require('node:fs');
const { before, after } = JSON.parse(readFileSync(${JSON.stringify(script)}, 'utf8'));
let n = 0;
const say = (count) => {
  for (let i = 0; i < count; i++, n++) for (const block of [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hi' }]) {
    console.log(JSON.stringify({ type: 'assistant', parent_tool_use_id: null, message: { id: 'msg_' + n, model: 'claude-opus-5-5', usage: { input_tokens: 2500000, output_tokens: 1 }, content: [block] } }));
  }
};
say(before);
const wait = setInterval(() => {
  if (!existsSync(${JSON.stringify(go)})) return;
  clearInterval(wait);
  say(after);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const approvals = new Approvals((ticketId, kind, data) => store.addEvent(ticketId, kind, data));
const runner = new Runner(store, () => {}, () => ({}), fake);
const pushes: { ticket: number; text: string; eventId: number }[] = [];
runner.onSpendAlert = (ticket, text, eventId) => pushes.push({ ticket, text, eventId });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function minion() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle' });
  return t.id;
}
const cards = (id: number, kind = 'spend') => store.listEvents(id).filter((e) => e.kind === kind).map((e) => ({ id: e.id, ...JSON.parse(e.data) }));

test('a turn posts one card and one push per stage it passes', async () => {
  rmSync(go, { force: true });
  writeFileSync(script, JSON.stringify({ before: 11, after: 0 }));
  writeFileSync(go, '');
  const id = minion();
  runner.send(id, 'Cara', 'go');
  await until('the turn to end', () => !runner.isRunning(id));
  const got = cards(id);
  assert.deepEqual(got.map((c) => [c.stage, c.usd]), [[25, 30], [50, 50], [100, 100]]);
  assert.match(got[0].text, /^This turn has used about \$30 in 1 min\.$/);
  assert.deepEqual(pushes.filter((p) => p.ticket === id).map((p) => p.eventId), got.map((c) => c.id));
});

test('Keep going mutes the rest of its own turn only, and the next turn alerts again', async () => {
  rmSync(go, { force: true });
  writeFileSync(script, JSON.stringify({ before: 3, after: 8 }));
  const id = minion();
  runner.send(id, 'Cara', 'go');
  await until('the $25 card', () => cards(id).length === 1);
  const started = runner.turnStartedAt(id)!;
  // The list row's badge and the Needs-you item (#723) show the open alert until Keep going.
  const alert = runner.view(store.getTicket(id)!).spend_alert;
  assert.deepEqual([alert?.stage, alert?.usd, alert?.event], [25, 30, cards(id)[0].id]);
  assert.match(alert!.href, new RegExp(`${cards(id)[0].id}`));
  assert.deepEqual(inboxItems(store, approvals, project.id, 'Cara').filter((i) => i.kind === 'spend').map((i) => [i.ticketId, i.eventId]), [[id, cards(id)[0].id]]);
  assert.equal(runner.muteSpend(id, 'Josh', started - 1), false); // an earlier turn's card
  assert.equal(runner.muteSpend(id, 'Josh', started), true);
  assert.deepEqual(cards(id, 'spend_muted').map((c) => c.by), ['Josh']);
  assert.equal(runner.view(store.getTicket(id)!).spend_alert, null);
  assert.deepEqual(inboxItems(store, approvals, project.id, 'Cara').filter((i) => i.kind === 'spend'), []);
  writeFileSync(go, '');
  await until('the turn to end', () => !runner.isRunning(id));
  assert.equal(cards(id).length, 1);
  assert.equal(runner.muteSpend(id, 'Josh', started), false); // no turn running

  writeFileSync(script, JSON.stringify({ before: 3, after: 0 }));
  runner.send(id, 'Cara', 'again'); // it waits its turn on the minion's lane, so isRunning isn't true at once
  await until('the second turn\'s $25 card', () => cards(id).length === 2);
  assert.equal(cards(id)[1].usd, 30);
  await until('the second turn to end', () => !runner.isRunning(id) && existsSync(go));
  assert.equal(runner.view(store.getTicket(id)!).spend_alert, null); // the turn's end clears it
});
