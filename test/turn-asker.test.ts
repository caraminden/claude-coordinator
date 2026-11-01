import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { messagePerson } from '../src/access.ts';
import { Auth } from '../src/auth.ts';
import { askerKey, Store } from '../src/db.ts';
import { GLOBAL_OWNER } from '../src/properties.ts';
import { Runner } from '../src/runner.ts';
import { bootServer, PASSWORD, SECRET } from './helpers.ts';

// Admin-only tools and routes look at who asked for a Taskmaster's turn, not whom it runs as (#255).
// A non-member's relay to Citadel runs as Citadel's owner (#211), an admin, but the non-member asked
// for it, so it gets no admin tools and reaches no more schemes than they could.
const root = mkdtempSync(join(tmpdir(), 'turn-asker-'));
const data = join(root, 'data');
mkdirSync(data, { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');

// Replies once `release` is in its folder, and exits at the end of its input.
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { existsSync } = require('node:fs');
let replied = false;
let closed = false;
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', () => {});
rl.on('close', () => (closed = true));
setInterval(() => {
  if (!replied && existsSync('release')) {
    replied = true;
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  }
  if (replied && closed) process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(data, 'coordinator.db'));
const Cara = store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
const Josh = store.createUser({ name: 'Josh', login: 'josh' });
const Rachel = store.createUser({ name: 'Rachel', login: 'rachel' });
const Delve = store.createProject('Delve', null);
const Citadel = store.createProject('Citadel', null);
assert.equal(Citadel.id, GLOBAL_OWNER, 'the second scheme stands in for Citadel');
const Obsidian = store.createProject('Obsidian', null, Rachel.id);
store.adoptOwnerless(Cara.id);
store.addMember(Citadel.id, Josh.id);

/** A Taskmaster with a folder of its own, where its fake claude runs. */
function taskmaster(p: { id: number }, person: number) {
  const t = store.createTicket({ project_id: p.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
  const dir = join(root, `t${t.id}`);
  mkdirSync(dir);
  store.setTicketDir(t.id, dir, null);
  store.updateTicket(t.id, { person_id: person });
  return { id: t.id, dir };
}
const CitadelTM = taskmaster(Citadel, Cara.id);
const DelveTM = taskmaster(Delve, Cara.id);
const ObsidianTM = taskmaster(Obsidian, Rachel.id);

async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), 'timed out');
}

test("a non-member's relay runs as Citadel's owner but is the non-member's ask, and that carries on", async () => {
  const r = new Runner(store, () => {}, () => ({}), fake);
  r.pollMs = 10;
  r.personOf = messagePerson(store);
  const release = (on: boolean) => {
    for (const t of [CitadelTM, DelveTM]) on ? writeFileSync(join(t.dir, 'release'), '') : rmSync(join(t.dir, 'release'), { force: true });
  };
  const turn = async (to: number, author: string, from?: number) => {
    r.send(to, author, 'please', [], from ? { from } : {});
    await until(() => !r.isRunning(to) && r.queued(to) === 0);
  };
  const relayAuthor = 'Taskmaster of Obsidian, for Rachel, not a Citadel member';
  release(true);

  await turn(CitadelTM.id, relayAuthor, ObsidianTM.id);
  assert.equal(store.getTicket(CitadelTM.id)!.person_id, Cara.id, 'it runs as the owner, as #211 has it');
  assert.equal(store.turnAsker(CitadelTM.id), Rachel.id, 'but Rachel asked for it');
  // A GitHub ping or a server notice is no one's ask: whoever asked last still stands.
  await turn(CitadelTM.id, 'GitHub');
  assert.equal(store.turnAsker(CitadelTM.id), Rachel.id);
  // A relay from a turn Rachel asked for is still Rachel's ask, wherever it goes.
  await turn(DelveTM.id, 'Taskmaster of Citadel', CitadelTM.id);
  assert.equal(store.turnAsker(DelveTM.id), Rachel.id);
  assert.equal(store.getTicket(DelveTM.id)!.person_id, Cara.id, "Rachel isn't in Delve, so it runs as its owner");

  // Cara's own message is hers, and so is the GitHub ping after it.
  await turn(CitadelTM.id, 'Cara');
  assert.equal(store.turnAsker(CitadelTM.id), Cara.id);
  await turn(CitadelTM.id, 'GitHub');
  assert.equal(store.turnAsker(CitadelTM.id), Cara.id);

  // Mid-turn on Rachel's ask, Cara's message waits for a turn of its own rather than steer into it.
  release(false);
  r.send(CitadelTM.id, relayAuthor, 'and another', [], { from: ObsidianTM.id });
  await until(() => r.isRunning(CitadelTM.id));
  r.send(CitadelTM.id, 'Cara', 'stop that', [], {}, true);
  assert.equal(r.queued(CitadelTM.id), 1, 'queued, not steered');
  // Cara's message and Rachel's relay in one turn: Rachel's ask rides along, so it counts as hers.
  r.send(CitadelTM.id, relayAuthor, 'one more', [], { from: ObsidianTM.id });
  assert.equal(r.queued(CitadelTM.id), 2);
  release(true);
  await until(() => !r.isRunning(CitadelTM.id) && r.queued(CitadelTM.id) === 0);
  assert.equal(store.turnAsker(CitadelTM.id), Rachel.id);
});

test("a contraption's ask is its person's, and a held relay keeps the asker it had when held", async () => {
  const r = new Runner(store, () => {}, () => ({}), fake);
  r.pollMs = 10;
  r.personOf = messagePerson(store);
  const turn = async (to: number, author: string, extra: object = {}) => {
    r.send(to, author, 'please', [], extra);
    await until(() => !r.isRunning(to) && r.queued(to) === 0);
  };
  writeFileSync(join(CitadelTM.dir, 'release'), '');
  await turn(CitadelTM.id, 'Cara');
  await turn(CitadelTM.id, 'Contraption Mandate, for Josh, a Citadel member', { asker: Josh.id });
  assert.equal(store.turnAsker(CitadelTM.id), Josh.id);

  // Rachel's relays trip the loop guard, and the last waits for a person.
  const relayAuthor = 'Taskmaster of Obsidian, for Rachel, not a Citadel member';
  let held = false;
  for (let i = 0; i < 10 && !held; i++) {
    held = r.relayTaskmaster(ObsidianTM.id, CitadelTM.id, relayAuthor, `ask ${i}`).held;
    await until(() => !r.isRunning(CitadelTM.id) && r.queued(CitadelTM.id) === 0);
  }
  assert.ok(held, 'the loop guard held one');
  await turn(CitadelTM.id, 'Cara');
  // Cara then writes in Obsidian's Taskmaster chat: its turn is hers, and that continues the held relay.
  store.setSetting(askerKey(ObsidianTM.id), Cara.id);
  r.continueLoop(ObsidianTM.id, 'Cara');
  await until(() => !r.isRunning(CitadelTM.id) && r.queued(CitadelTM.id) === 0 && store.turnAsker(CitadelTM.id) !== Cara.id);
  assert.equal(store.turnAsker(CitadelTM.id), Rachel.id, 'still Rachel\'s ask');
  store.deleteSetting(askerKey(ObsidianTM.id));
});

test('admin-only routes refuse a Taskmaster turn a non-admin asked for, even one run as an admin', async () => {
  const tokens = new Auth(PASSWORD, SECRET);
  const srv = await bootServer({ root });
  after(() => srv.proc.kill());
  const as = async (method: string, path: string, body?: object) => {
    const res = await fetch(srv.base + path, {
      method, headers: { Authorization: `Bearer ${tokens.agentToken(CitadelTM.id)}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  const askedBy = (who: { id: number }) => store.setSetting(askerKey(CitadelTM.id), who.id);
  const admin = [
    ['GET', '/api/contraptions'],
    ['PUT', '/api/app/instructions', { text: 'Be nice.' }],
    ['PATCH', `/api/projects/${Citadel.id}`, { plugin_dirs: ['tools/mods/sneaky'] }],
  ] as const;
  // Every turn runs as Cara here; only who asked changes.
  store.updateTicket(CitadelTM.id, { person_id: Cara.id });

  for (const [who, name] of [[Rachel, 'Rachel'], [Josh, 'Josh']] as const) {
    askedBy(who);
    for (const [method, path, body] of admin) {
      const r = await as(method, path, body);
      assert.equal(r.status, 403, `${method} ${path} for ${name}`);
      assert.match(r.body.error, new RegExp(`^Only a turn a Citadel admin asked for may do this, and this one is ${name}'s ask\\. Ask a Citadel admin to send the request in this chat\\.$`));
    }
    // Rachel isn't in Delve: her ask reaches Citadel's schemes no further than she could.
    if (who === Rachel) assert.equal((await as('POST', '/api/taskmaster', { scheme: 'Delve', text: 'hi' })).status, 404);
  }
  // A minion made on Josh's ask is Josh's ask too, so its messages back can't stand in for Cara's.
  const made = await as('POST', `/api/projects/${Citadel.id}/tickets`, { message: 'look into it', properties: { type: 'bug' } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(store.turnAsker(made.body.id), Josh.id);
  assert.equal(store.appInstructions().text, '');
  assert.equal(store.getProject(Citadel.id)!.plugin_dirs ?? '', '');

  // Cara asked: unchanged.
  askedBy(Cara);
  for (const [method, path, body] of admin) assert.equal((await as(method, path, body)).status, 200, `${method} ${path} for Cara`);
  assert.equal(store.appInstructions().text, 'Be nice.');
  assert.equal((await as('POST', '/api/taskmaster', { scheme: 'Delve', text: 'hi' })).status, 202);
});
