import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { ARMED_NOTE, type Armed } from '../src/armed-handoff.ts';
import { armedKey } from '../src/db-keys.ts';
import { Store } from '../src/db.ts';
import { git } from './git.ts';
import { addReview, agentToken, bootServer, releaseFake, type Booted, stopProcs, tempRoot, until } from './helpers.ts';

// #2046 (Josh, 2026-11-25, picked "Start" on #2031's "Hand off once, ship when ready"): a pipeline change from a minion
// that doesn't hold the pipeline lane is armed, not refused or started: it joins the lane's queue by itself and the
// server ships it when the lane passes to it, with no turn, through Ship It's guards (#1930). A refusal wakes it once.
const tmp = tempRoot('armed-handoff-');
const root = tmp.dir;
const fake = releaseFake(root);
const LIVE = 'land: main is now at abc1234 "#9: lane change"\ndeploy: live now: the server reloaded the front end (v2); open tabs reload when idle. No restart.\n';
const HAND_OFF = { summary: 'Lane change', risk: 'medium', risk_reason: 'ship path', learned: 'nothing' };
const LANE = 'pipeline-lane';

let srv: Booted;
let store: Store;
let projectId = 0;

before(async () => {
  mkdirSync(join(root, 'data'), { recursive: true });
  const seed = new Store(join(root, 'data', 'coordinator.db'));
  seed.setSetting('turn-pool', { size: 1, at: 0, fixed: { size: 1, by: 'test' } });
  srv = await bootServer({ root, env: { CLAUDE_BIN: fake.fake } });
  fake.setRelease('ok'); // a woken minion's turn ends at once
  store = new Store(join(srv.data, 'coordinator.db'));
});
// Its own scheme each, named for none of Citadel's: no queue or holder carries over.
let schemes = 0;
beforeEach(async () => {
  projectId = (await srv.call('/api/projects', { name: `Other scheme ${++schemes}` })).data.id;
});
after(async () => {
  await stopProcs([srv.proc]);
  await tmp.teardown();
});

/** A minion with one commit on its branch changing `file` (a pipeline file by default); land.sh ships. */
async function minion(file = 'src/pipe/x.ts') {
  const t = store.createTicket({ project_id: projectId, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(srv.data, 'projects', String(t.project_id), 'tickets', String(t.id));
  mkdirSync(join(cwd, 'tools'), { recursive: true });
  writeFileSync(join(cwd, 'tools', 'land.sh'), `if [ "$1" = --check ]; then exit 0; fi\nprintf '%b' ${JSON.stringify(LIVE)}\n`);
  writeFileSync(join(cwd, 'tools', 'pipeline-files.txt'), '# the pipeline\ntools/land.sh\nsrc/pipe/\n');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'init');
  git(cwd, 'checkout', '-q', '-b', `ticket/${t.number}-m`);
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), 'export const a = 1;\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'change');
  store.setTicketDir(t.id, cwd, `ticket/${t.number}-m`);
  addReview(store, t.id);
  const asMinion = srv.as({ token: agentToken(srv.data, t.id) });
  const handOff = (extra: object = {}) => asMinion(`/api/tickets/${t.id}/land/handoff`, { ...HAND_OFF, ...extra });
  const texts = () => store.listEvents(t.id).map((e) => String(JSON.parse(e.data).text ?? ''));
  const commit = (name: string) => {
    writeFileSync(join(cwd, name), 'x\n');
    git(cwd, 'add', name);
    git(cwd, 'commit', '-qm', name);
  };
  return { id: t.id, number: t.number, cwd, handOff, texts, commit, state: () => store.getTicket(t.id)!, asMinion };
}
type Minion = Awaited<ReturnType<typeof minion>>;

/** Someone else holds the lane: a plain minion with no worktree, which a person's dismissal passes it on from. */
function laneHeld() {
  const holder = store.createTicket({ project_id: projectId, title: 'Holder', permission_mode: 'default', created_by: 'Cara' });
  store.claims.take(projectId, LANE, holder.id, 'Cara');
  return { id: holder.id, passOn: () => srv.call(`/api/tickets/${holder.id}/status`, { status: 'closed' }) };
}

/** Its hand-off was armed: the answer says so, it waits in the lane's queue, and the list shows the wait. */
async function armed(m: Minion, extra: object = {}) {
  const r = await m.handOff(extra);
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.match(String(r.data.armed), /^Armed, not started: src\/pipe\/x\.ts is a pipeline file and you don't hold the pipeline lane\. It is number \d+ in the pipeline lane's queue/);
  assert.ok(store.claims.waiting(projectId, LANE).includes(m.id), 'in the queue');
  assert.equal(m.state().state, 'outside');
  assert.equal(m.state().note, ARMED_NOTE);
  assert.ok(
    m.texts().some((x) => x.startsWith(`${ARMED_NOTE}. You handed it off`)),
    'the chat says it',
  );
  assert.ok(store.getSetting<Armed>(armedKey(m.id)));
}

/** The lane came, the armed ship was ruled out, and the minion was woken with why, once. */
async function wokeWith(m: Minion, why: RegExp) {
  const said = await until('the wake', () => m.texts().find((x) => x.includes("Your armed hand-off didn't ship by itself")));
  assert.match(said, why);
  assert.match(said, /^You hold the pipeline-lane claim now/);
  assert.equal(store.getSetting(armedKey(m.id)) ?? null, null, 'never re-armed');
  assert.notEqual(m.state().note, ARMED_NOTE);
  assert.ok(!m.texts().some((x) => x.includes('started your armed hand-off')));
}

test('a pipeline hand-off without the lane joins the end of its queue, and ships with no turn when the lane passes to it', async () => {
  const lane = laneHeld();
  const ahead = store.createTicket({ project_id: projectId, title: 'Ahead', permission_mode: 'default', created_by: 'Cara' });
  store.claims.setQueue(projectId, LANE, [ahead.id], 'Cara');
  const m = await minion();
  const turns = fake.turnsRun();
  await armed(m);
  assert.deepEqual(store.claims.waiting(projectId, LANE), [ahead.id, m.id], 'at the end, behind who was there');
  assert.ok(!m.texts().some((x) => x.startsWith('Shipped')), 'nothing shipped yet');
  // The Taskmaster still orders the lane.
  assert.equal((await srv.call(`/api/projects/${projectId}/claims/${LANE}/queue`, { queue: [m.id, ahead.id] }, 'PUT')).status, 200);
  await lane.passOn();
  await until('it ships and closes', () => m.state().status === 'closed');
  assert.ok(m.texts().includes('The pipeline lane is yours, so Citadel started your armed hand-off with no turn.'));
  assert.ok(!m.texts().some((x) => x.startsWith('You hold the pipeline-lane claim now')), 'no wake to hand off again');
  assert.match(m.texts().find((x) => x.startsWith('Shipped abc1234'))!, /Risk medium: ship path\./);
  assert.equal(fake.turnsRun(), turns, 'no turn');
});

test('a branch that moved after it was armed does not ship: the lane wakes the minion with why', async () => {
  const lane = laneHeld();
  const m = await minion();
  await armed(m);
  m.commit('more.txt');
  await lane.passOn();
  await wokeWith(m, /your branch moved since you armed it/);
});

test('a person who wrote after it was armed stops it: the lane wakes the minion with why', async () => {
  const lane = laneHeld();
  const m = await minion();
  await armed(m);
  const turns = fake.turnsRun();
  await srv.call(`/api/tickets/${m.id}/messages`, { text: 'hold on, one more thing' });
  await until('its turn ends', () => fake.turnsRun() > turns && m.state().status === 'idle');
  await lane.passOn();
  await wokeWith(m, /a person wrote to you after you armed it/);
});

test("anyone's message after it was armed stops it, a Taskmaster's too: the lane wakes the minion with why", async () => {
  const lane = laneHeld();
  const m = await minion();
  await armed(m);
  // As message_minion or a Taskmaster's message lands; the turn it would start isn't what this is about.
  store.addEvent(m.id, 'user_message', { author: 'Taskmaster', text: 'hold that', from: lane.id });
  await lane.passOn();
  await wokeWith(m, /Taskmaster wrote to you after you armed it/);
});

test('a sealed minion is woken, not shipped, when the lane comes', async () => {
  const lane = laneHeld();
  const m = await minion();
  await armed(m);
  store.updateTicket(m.id, { state: 'parked' });
  await lane.passOn();
  await wokeWith(m, /you were sealed/);
});

test('a free lane is taken and the pipeline change ships at once', async () => {
  const m = await minion();
  const r = await m.handOff();
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.armed, undefined);
  assert.equal(store.claims.get(projectId, LANE)?.holder, m.id);
  await until('it ships', () => m.state().status === 'closed');
});

test('what needs no lane ships at once: a change outside the pipeline, and an outage fix', async () => {
  laneHeld();
  const plain = await minion('src/a.ts');
  const r = await plain.handOff();
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.armed, undefined);
  const outage = await minion();
  const o = await outage.handOff({ outage: true });
  assert.equal(o.data.armed, undefined, JSON.stringify(o.data));
  assert.ok(!store.claims.waiting(projectId, LANE).includes(outage.id));
  await until('both ship', () => plain.state().status === 'closed' && outage.state().status === 'closed');
});

test("another claim given to a minion with an armed hand-off doesn't fire it or wake it", async () => {
  laneHeld();
  const m = await minion();
  await armed(m);
  const turns = fake.turnsRun();
  const r = await srv.call(`/api/projects/${projectId}/claims`, { name: 'other-claim', minion: m.number });
  assert.ok(r.status < 300, JSON.stringify(r.data));
  assert.ok(store.getSetting(armedKey(m.id)), 'still armed');
  assert.ok(!m.texts().some((x) => x.startsWith('You hold the other-claim claim now')), 'no wake');
  assert.equal(fake.turnsRun(), turns);
});

test('a Taskmaster giving the lane straight to an armed minion ships it', async () => {
  laneHeld();
  const m = await minion();
  await armed(m);
  // Taken out of the line, and the lane freed: then given to it by name.
  assert.equal((await srv.call(`/api/projects/${projectId}/claims/${LANE}/queue`, { queue: [] }, 'PUT')).status, 200);
  store.claims.release(projectId, LANE);
  assert.equal(store.claims.get(projectId, LANE), undefined);
  const r = await srv.call(`/api/projects/${projectId}/claims`, { name: LANE, minion: m.number });
  assert.ok(r.status < 300, JSON.stringify(r.data));
  await until('it ships', () => m.state().status === 'closed' || m.texts().some((x) => x.includes("didn't ship by itself")));
  assert.equal(m.state().status, 'closed', String(m.texts().at(-1)));
  assert.ok(m.texts().includes('The pipeline lane is yours, so Citadel started your armed hand-off with no turn.'));
});

test('a dismissed minion leaves no armed hand-off', async () => {
  laneHeld();
  const m = await minion();
  await armed(m);
  await srv.call(`/api/tickets/${m.id}/status`, { status: 'closed' });
  assert.equal(store.getSetting(armedKey(m.id)) ?? null, null);
});
