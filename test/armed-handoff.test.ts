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

test('one taken out of the queue while armed is disarmed and woken, not stranded', async () => {
  laneHeld();
  const m = await minion();
  await armed(m);
  assert.equal((await srv.call(`/api/projects/${projectId}/claims/${LANE}/queue`, { queue: [] }, 'PUT')).status, 200);
  await until('the wake', () => m.texts().some((x) => x.includes("took you out of the pipeline lane's queue, so your armed hand-off won't ship by itself")));
  assert.equal(store.getSetting(armedKey(m.id)) ?? null, null);
  assert.notEqual(m.state().note, ARMED_NOTE);
});

test('a dismissed minion leaves no armed hand-off', async () => {
  laneHeld();
  const m = await minion();
  await armed(m);
  await srv.call(`/api/tickets/${m.id}/status`, { status: 'closed' });
  assert.equal(store.getSetting(armedKey(m.id)) ?? null, null);
});

// #2089: two more triggers. `when: "proof"` ships once the flake proof on the armed commit goes green; `when: {live}` once
// another minion's work or a commit is live, as wake_when_live checks it. Same guards, and once only.
const PROOF_NOTE = 'armed: ships when the proof is green';

/** A finished flake-proof run on `sha`, as CI health tells the minion that dispatched it (the server's dispatched-run wake). */
const proofRun = (m: Minion, sha: string, conclusion: string) => srv.call('/api/test/dispatched-run', { ticket: m.id, text: `flake-proof run ${conclusion}`, fyi: conclusion === 'success', run: { id: Date.now(), path: '.github/workflows/flake-proof.yml', head_sha: sha, conclusion, status: 'completed' } });
const head = (m: Minion) => git(m.cwd, 'rev-parse', 'HEAD').trim();
/** Turns this minion ran (the fake's count is every minion's, and another test's woken one may still be finishing). */
const ownTurns = (m: Minion) => store.listEvents(m.id).filter((e) => e.kind === 'claude').length;

async function armedFor(m: Minion, when: unknown, note: string) {
  const r = await m.handOff({ when });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.match(String(r.data.armed), /^Armed, not started/);
  assert.equal(m.state().state, 'outside');
  assert.equal(m.state().note, note);
  assert.ok(
    m.texts().some((x) => x.startsWith(`${note}. You handed it off`)),
    'the chat says it',
  );
  assert.ok(store.getSetting<Armed>(armedKey(m.id)));
}

/** The trigger came, the armed ship was ruled out, and the minion was woken with why, once. */
async function proofWoke(m: Minion, why: RegExp) {
  const said = await until('the wake', () => m.texts().find((x) => x.includes("Your armed hand-off didn't ship by itself")));
  assert.match(said, why);
  assert.equal(store.getSetting(armedKey(m.id)) ?? null, null, 'never re-armed');
  assert.notEqual(m.state().note, PROOF_NOTE);
}

test('when: "proof" waits for a green flake proof on its commit, then ships with no turn', async () => {
  const m = await minion('src/a.ts');
  const turns = ownTurns(m);
  await armedFor(m, 'proof', PROOF_NOTE);
  assert.ok(!m.texts().some((x) => x.startsWith('Shipped')), 'nothing shipped yet');
  await proofRun(m, head(m), 'success');
  await until('it ships and closes', () => m.state().status === 'closed');
  assert.ok(m.texts().some((x) => /^The flake proof on \w{7} went green, so Citadel started your armed hand-off with no turn\.$/.test(x)));
  assert.equal(ownTurns(m), turns, 'no turn');
});

test("a proof on an older commit doesn't count: it is a chat note, and the armed one still ships on its own commit's green", async () => {
  const m = await minion('src/a.ts');
  const old = head(m);
  m.commit('more.txt');
  await armedFor(m, 'proof', PROOF_NOTE);
  const turns = ownTurns(m);
  await proofRun(m, old, 'success');
  assert.ok(m.texts().some((x) => x.includes('so it changes nothing there')));
  assert.ok(store.getSetting<Armed>(armedKey(m.id)), 'still armed');
  assert.equal(ownTurns(m), turns, 'no turn for it');
  await proofRun(m, head(m), 'success');
  await until('it ships and closes', () => m.state().status === 'closed');
});

test('a red proof wakes the minion with the run, and the armed hand-off is dropped', async () => {
  const m = await minion('src/a.ts');
  await armedFor(m, 'proof', PROOF_NOTE);
  await proofRun(m, head(m), 'failure');
  const said = await until('the wake', () => m.texts().find((x) => x.startsWith('flake-proof run failure')));
  assert.match(said, /Your armed hand-off is off: the proof wasn't green/);
  assert.equal(store.getSetting(armedKey(m.id)) ?? null, null);
  assert.notEqual(m.state().note, PROOF_NOTE);
});

test('a branch that moved after it was armed does not ship on a green proof: the minion is woken with why', async () => {
  const m = await minion('src/a.ts');
  await armedFor(m, 'proof', PROOF_NOTE);
  const sha = head(m);
  m.commit('more.txt');
  await proofRun(m, sha, 'success');
  await proofWoke(m, /your branch moved since you armed it/);
});

test("anyone's message after it was armed stops a proof ship: the minion is woken with why", async () => {
  const m = await minion('src/a.ts');
  await armedFor(m, 'proof', PROOF_NOTE);
  store.addEvent(m.id, 'user_message', { author: 'Taskmaster', text: 'hold that' });
  await proofRun(m, head(m), 'success');
  await proofWoke(m, /Taskmaster wrote to you after you armed it/);
});

test('a pipeline change armed on its proof goes to the lane once the proof is green, and ships when the lane passes to it', async () => {
  const lane = laneHeld();
  const m = await minion();
  await armedFor(m, 'proof', PROOF_NOTE);
  assert.ok(!store.claims.waiting(projectId, LANE).includes(m.id), 'not queued before its proof');
  await proofRun(m, head(m), 'success');
  await until('it joins the lane', () => store.claims.waiting(projectId, LANE).includes(m.id));
  assert.equal(m.state().note, ARMED_NOTE);
  await lane.passOn();
  await until('it ships and closes', () => m.state().status === 'closed');
});

test('when: {live: "#N"} ships with no turn once that minion\'s work is live', async () => {
  const leader = store.createTicket({ project_id: projectId, title: 'Leader', permission_mode: 'default', created_by: 'Cara' });
  const m = await minion('src/a.ts');
  const turns = ownTurns(m);
  await armedFor(m, { live: `#${leader.number}` }, `armed: ships when #${leader.number} is live`);
  await srv.call(`/api/tickets/${leader.id}/status`, { status: 'closed' });
  await until('it ships and closes', () => m.state().status === 'closed');
  assert.ok(m.texts().includes(`#${leader.number}'s work is live, so Citadel started your armed hand-off with no turn.`));
  assert.equal(ownTurns(m), turns, 'no turn');
});

test("when: {live} on what's live already ships at once; an unknown minion or commit is refused", async () => {
  const gone = store.createTicket({ project_id: projectId, title: 'Gone', permission_mode: 'default', created_by: 'Cara' });
  store.updateTicket(gone.id, { status: 'closed' });
  const m = await minion('src/a.ts');
  assert.equal((await m.handOff({ when: { live: '#99999' } })).status, 404);
  assert.equal((await m.handOff({ when: { live: 'abcdef1234' } })).status, 400);
  assert.equal((await m.handOff({ when: { live: `#${m.number}` } })).status, 400, 'not its own');
  assert.equal((await m.handOff({ when: 'soon' })).status, 400);
  const r = await m.handOff({ when: { live: `#${gone.number}` } });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(r.data.armed, undefined);
  await until('it ships', () => m.state().status === 'closed');
});

test("someone's message after a live-armed hand-off stops it: the minion is woken with why", async () => {
  const leader = store.createTicket({ project_id: projectId, title: 'Leader', permission_mode: 'default', created_by: 'Cara' });
  const m = await minion('src/a.ts');
  await armedFor(m, { live: `#${leader.number}` }, `armed: ships when #${leader.number} is live`);
  store.addEvent(m.id, 'user_message', { author: 'Taskmaster', text: 'hold that' });
  await srv.call(`/api/tickets/${leader.id}/status`, { status: 'closed' });
  await proofWoke(m, /Taskmaster wrote to you after you armed it/);
});
