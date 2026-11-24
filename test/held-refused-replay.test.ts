// #1059 (8e163a06): Deliver now (Runner.releaseMail) for a cold minion whose person's Claude login is refused delivers
// nothing and keeps the mail and its cold time, so the hold cap still fires later.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { transcriptPath } from '../src/sessions.ts';
import { stopTurns, testPins, until } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'held-refused-'));
after(async () => {
  await stopTurns(root);
  await until('every session save to end', async () => ![...Array(500).keys()].some((id) => (runner as any).lanes.busy(id)));
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
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

test('Deliver now on cold mail whose Claude login is refused returns 0 and keeps the mail and its cold time', async () => {
  const project = store.createProject('Refused', null);
  const t = store.createTicket({ project_id: project.id, title: 'M', permission_mode: 'default', created_by: 'Cara', kind: 'ticket' });
  const cwd = join(root, `t${t.id}`);
  mkdirSync(cwd, { recursive: true });
  store.setTicketDir(t.id, cwd, null);
  store.updateTicket(t.id, { session_id: `s${t.id}`, status: 'idle' });
  const file = transcriptPath(process.env.CLAUDE_CONFIG_DIR!, cwd, `s${t.id}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '{}\n');
  store.recordTurn(t.id, { session_id: `s${t.id}`, ended_at: NOW - 20 * 60_000, session_cost_usd: 0 });
  // Mail held cold before #1603 dropped the cold hold, as relay() left it then.
  (runner as any).relays.mail(t.id, 'Taskmaster', 'hold this', undefined, true, 'ask');
  const queue = (runner as any).queue;
  const coldAt = queue.get(t.id).coldAt;
  assert.ok(coldAt, 'the mail is held cold');

  runner.placeFor = () => ({ refused: 'No Claude login for this turn.' });
  assert.equal(runner.releaseMail(store.getTicket(t.id)!, store.getProject(project.id)!, 'Cara'), 0, 'refused: nothing delivered');
  assert.equal(queue.get(t.id).coldAt, coldAt, 'the cold time stays, so the hold cap still fires');
  assert.equal(queue.heldMail(t.id).length, 1, 'the mail is still held');
  assert.equal(runner.isRunning(t.id), false);

  runner.placeFor = undefined;
  assert.equal(runner.releaseMail(store.getTicket(t.id)!, store.getProject(project.id)!, 'Cara'), 1, 'once the login works it goes');
  await until('the delivered turn', async () => !runner.isRunning(t.id) && !(runner as any).lanes.busy(t.id));
});
