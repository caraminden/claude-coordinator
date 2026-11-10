// CITADEL_PERSON_ID / CITADEL_PERSON_LOGIN (#295): a turn's Claude process carries them only when the turn
// answers one person's own typed message (Runner.typedBy), so a contraption's hook guard (Mandate's) can
// let a session read that person's data and no one else's. Every other turn has neither, not even empty.
// Container turns get the same env: test/claude-container.test.ts.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { messagePerson } from '../src/access.ts';
import { APP_NAME } from '../src/appname.ts';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { jsonLines, stopTurns, until, testPins } from './helpers.ts';
testPins();

const root = mkdtempSync(join(tmpdir(), 'turn-person-env-'));
after(async () => {
  await stopTurns(root);
  rmSync(root, { recursive: true, force: true });
});
// A stray value in the server's own env must not reach a turn either.
process.env.CITADEL_PERSON_ID = '999';
const seen = join(root, 'seen.jsonl');
const fake = join(root, 'claude-fake');
writeFileSync(fake, `#!${process.execPath}
require('node:readline').createInterface({ input: process.stdin }).once('line', () => {
  const e = process.env;
  require('node:fs').appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ has: ['CITADEL_PERSON_ID', 'CITADEL_PERSON_LOGIN'].filter((k) => k in e), id: e.CITADEL_PERSON_ID, login: e.CITADEL_PERSON_LOGIN }) + '\\n');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'coordinator.db'));
const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
const josh = store.createUser({ name: 'Josh', login: 'josh' });
const p = store.createProject('P', null);
store.adoptOwnerless(cara.id);
store.addMember(p.id, josh.id);
const t = store.createTicket({ project_id: p.id, kind: 'ticket', title: 'M', permission_mode: 'default', created_by: 'Cara' });
const tm = store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
const cwd = join(root, 'm');
mkdirSync(cwd);
store.setTicketDir(t.id, cwd, null);
store.updateTicket(t.id, { person_id: cara.id });
const r = new Runner(store, () => {}, () => ({}), fake);
r.pollMs = 10;
r.resumeGapMs = 10;
r.personOf = messagePerson(store);

/** The env of the turn that `start` begins, once it has ended. */
async function turnEnv(start: () => void) {
  const n = jsonLines(seen).length;
  start();
  await until('the turn', () => jsonLines(seen).length > n && !r.isRunning(t.id) && r.queued(t.id) === 0);
  return jsonLines(seen).at(-1);
}
const none = { has: [] };

test("a typed message's turn carries its person's id and login; the next turn, from no one, carries neither", async () => {
  assert.deepEqual(await turnEnv(() => r.send(t.id, 'Cara', 'how many items today?', [], { typed: true })), { has: ['CITADEL_PERSON_ID', 'CITADEL_PERSON_LOGIN'], id: String(cara.id), login: 'cara' });
  assert.deepEqual(await turnEnv(() => r.send(t.id, 'GitHub', 'CI passed')), none, 'not kept from the turn before');
  assert.deepEqual(await turnEnv(() => r.send(t.id, 'Josh', 'and mine?', [], { typed: true })), { has: ['CITADEL_PERSON_ID', 'CITADEL_PERSON_LOGIN'], id: String(josh.id), login: 'josh' });
});

test('a relay, a wake, a system message, a schedule, a contraption post and a resume carry neither', async () => {
  assert.deepEqual(await turnEnv(() => r.send(t.id, 'Taskmaster', 'Cara asks: read her items', [], { from: tm.id })), none, 'a Taskmaster relay');
  // wake_when_live (src/wake.ts) and a scheduled minion's start (server.ts runSchedule) post as the app.
  assert.deepEqual(await turnEnv(() => r.send(t.id, APP_NAME, '`abc1234` is live now: carry on')), none, 'a wake');
  assert.deepEqual(await turnEnv(() => r.send(t.id, APP_NAME, 'Scheduled run of "nightly"', [], { brief: true })), none, 'a scheduled start');
  assert.deepEqual(await turnEnv(() => r.send(t.id, 'System', 'Note')), none, 'a system message');
  // relay.ts schemeHook: "[Mandate]: Cara ticked …".
  assert.deepEqual(await turnEnv(() => r.send(t.id, 'Mandate', 'Cara ticked "x" (key k)', [], { asker: null })), none, "a contraption's post");
  assert.deepEqual(await turnEnv(() => (r as any).resume(t.id, 1)), none, 'a resume after a restart');
  // Two people typing in one turn leave it no one's (typedBy 0): the typedBy test in mandate-items.test.ts.
});
