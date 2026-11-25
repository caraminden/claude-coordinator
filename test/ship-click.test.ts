import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Auth } from '../src/auth.ts';
import { keptCards } from '../src/card-wait.ts';
import { buildOwnerKey, Store } from '../src/db.ts';
import { queueKey } from '../src/minion-queue.ts';
import { git, makeRepo } from './git.ts';
import { addReview, agentToken, bootServer, PASSWORD, releaseFake, SECRET, type Booted, stopProcs, tempRoot, until } from './helpers.ts';

// #1930 (Josh, 2026-11-25, "Yes, server ships it"): Ship It on a card whose minion prepared its hand-off ships at once
// from the server, with no turn and no worker; anything that rules that out sends the minion the answer, with why.
const tmp = tempRoot('ship-click-');
const root = tmp.dir;
const fake = releaseFake(root);
const LIVE = 'land: main is now at abc1234 "#9: usage bar"\ndeploy: live now: the server reloaded the front end (v2); open tabs reload when idle. No restart.\n';
const HAND_OFF = { summary: 'Usage bar', risk: 'high', risk_reason: 'ship path', learned: 'nothing' };
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==';
const OPTIONS = [{ label: 'Ship It', recommended: true }, { label: 'Hold' }];

let srv: Booted;
let store: Store;
let projectId = 0;

before(async () => {
  mkdirSync(join(root, 'data'), { recursive: true });
  const seed = new Store(join(root, 'data', 'coordinator.db'));
  seed.setSetting('turn-pool', { size: 1, at: 0, fixed: { size: 1, by: 'test' } });
  srv = await bootServer({ root, env: { CLAUDE_BIN: fake.fake } });
  store = new Store(join(srv.data, 'coordinator.db'));
  projectId = (await srv.call('/api/projects', { name: 'P' })).data.id;
});
after(async () => {
  await stopProcs([srv.proc]);
  await tmp.teardown();
});

/** A minion with one commit on its branch, and a ship card; land.sh ships, or fails while `fail` is in the worktree. */
async function minion(opts: { file?: string; handOff?: object | null; kind?: string; project?: number } = {}) {
  const t = store.createTicket({ project_id: opts.project ?? projectId, title: 'M', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(srv.data, 'projects', String(t.project_id), 'tickets', String(t.id));
  mkdirSync(join(cwd, 'tools'), { recursive: true });
  writeFileSync(
    join(cwd, 'tools', 'land.sh'),
    `if [ "$1" = --check ]; then [ ! -e moves ] || git -c user.name=t -c user.email=t@t commit -q --allow-empty -m meanwhile; [ -e conflict ] || exit 0; echo "land: it would conflict; conflicted files: a.txt" >&2; exit 3; fi\n[ -e fail ] && { echo "land: the tests failed on x"; exit 1; }\nprintf '%b' ${JSON.stringify(LIVE)}\n`,
  );
  writeFileSync(join(cwd, 'tools', 'pipeline-files.txt'), '# the pipeline\ntools/land.sh\nsrc/pipe/\n');
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'init');
  git(cwd, 'checkout', '-q', '-b', `ticket/${t.number}-m`);
  const file = join(cwd, opts.file ?? 'src/a.ts');
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, 'export const a = 1;\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'change');
  store.setTicketDir(t.id, cwd, `ticket/${t.number}-m`);
  addReview(store, t.id);
  const asMinion = srv.as({ token: agentToken(srv.data, t.id) });
  const post = (handOff: unknown, extra: object = {}) => asMinion(`/api/tickets/${t.id}/questions`, { kind: 'ship', questions: [{ question: 'Ship this high-risk change?', options: OPTIONS }], ...(handOff === null ? {} : { hand_off: handOff }), ...extra });
  const card = async (extra: object = {}) => {
    const r = await post(opts.handOff === undefined ? HAND_OFF : opts.handOff, extra);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal((await asMinion(`/api/tickets/${t.id}`)).status, 200, "the turn's own token still works");
    return r.data.id as string;
  };
  const press = (questionId: string, answer: object = {}, extra: object = {}) => srv.call(`/api/tickets/${t.id}/answer`, { questionId, answers: [{ selected: ['Ship It'], other: '', ...answer }], ...extra });
  const texts = () => store.listEvents(t.id).map((e) => String(JSON.parse(e.data).text ?? ''));
  const commit = (name: string) => {
    writeFileSync(join(cwd, name), 'x\n');
    git(cwd, 'add', name);
    git(cwd, 'commit', '-qm', name);
  };
  return { id: t.id, cwd, card, press, post, texts, commit, state: () => store.getTicket(t.id)! };
}
type Minion = Awaited<ReturnType<typeof minion>>;

/** The answer reached the minion as an ordinary one, saying why, and nothing shipped. */
async function fellBack(m: Minion, card: string, why: RegExp | null, answer: object = {}, extra: object = {}, waits = true) {
  const r = await m.press(card, answer, extra);
  assert.equal(r.status, 202, JSON.stringify(r.data));
  const said = await until('the answer', () => m.texts().find((x) => x.startsWith('My answers to your question card')));
  if (why) assert.match(said, why);
  else assert.doesNotMatch(said, /by itself/);
  assert.notEqual(m.state().state, 'outside', 'not landing');
  assert.ok(!m.texts().some((x) => x.includes('pressed Ship It')));
  if (waits) assert.ok(store.getSetting<{ msgs?: unknown[] }>(queueKey(m.id))?.msgs?.length, 'it waits for a worker as any answer does');
}

test('a minion a person wrote to after the card gets the answer, though its turn has ended', async () => {
  const m = await minion();
  const card = await m.card();
  fake.setRelease('ok');
  await srv.call(`/api/tickets/${m.id}/messages`, { text: 'looks good so far' });
  await until('its turn ends', () => fake.turnsRun() === 1 && m.state().status === 'idle');
  fake.setRelease(null);
  await fellBack(m, card, /a person wrote to you after the card/, {}, {}, false);
});

test('a minion whose turn runs gets the answer after it, and its worker stays taken for the tests below', async () => {
  const m = await minion();
  const card = await m.card();
  fake.setRelease('ok');
  await until('every turn ended', () => fake.turnsRun() === 2);
  fake.setRelease(null);
  await srv.call(`/api/tickets/${m.id}/messages`, { text: 'one more thing' });
  await until('it runs', () => m.state().status === 'running');
  await fellBack(m, card, /your turn was running or about to/);
});

test('Ship It ships at once with no turn while the one worker is busy, and the minion closes with its go named', async () => {
  const m = await minion({ handOff: { ...HAND_OFF, risk: 'low' } });
  const card = await m.card();
  const r = await m.press(card);
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(m.state().state, 'outside', 'it shows as landing in the answer itself');
  assert.match(String(m.state().note), /^landing: /);
  assert.ok(m.texts().includes('Cara pressed Ship It, so Citadel started this ship with no turn.'));
  assert.equal((await m.press(card)).status, 409, 'a second press is refused as answered');
  await until('it closes', () => m.state().status === 'closed');
  const line = m.texts().find((x) => x.startsWith('Shipped abc1234'))!;
  assert.match(line, /Risk low: ship path\. Go: Cara, [A-Z][a-z]{2} \d+, \d+:\d\d [AP]M \S+, by Ship It \(the server shipped it with no turn\)\./, 'who and when, even at a risk that needs no go');
  assert.ok(!m.texts().some((x) => /Dismissed before/.test(x)), 'its held note was not a message left unread');
  assert.equal(fake.turnsRun(), 2, 'no turn but the two above');
});

test('a ship that fails wakes the minion with the output, and its answer', async () => {
  const m = await minion();
  const card = await m.card();
  writeFileSync(join(m.cwd, 'fail'), '');
  assert.equal((await m.press(card)).status, 202);
  const woke = await until('the wake', () => m.texts().find((x) => x.includes("Your handed-off land didn't go through")));
  assert.match(woke, /the tests failed on x/);
  const q = store.getSetting<{ msgs: { text: string }[]; held: { text: string }[] }>(queueKey(m.id))!;
  assert.equal(q.msgs.length, 1, 'one turn, the failure');
  assert.match(q.held[0].text, /^Cara answered your ship card: Ship It\. .*hand it off with go "Cara, .*"\.$/, 'and that turn reads the go it has');
});

test("another member's press ships as theirs, and a failure wakes the minion on their login", async () => {
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  store.addMember(projectId, josh.id);
  const m = await minion();
  const card = await m.card();
  writeFileSync(join(m.cwd, 'fail'), '');
  const cookie = new Auth(PASSWORD, SECRET).issueCookie(josh, false).split(';')[0];
  const r = await srv.as({ cookie })(`/api/tickets/${m.id}/answer`, { questionId: card, answers: [{ selected: ['Ship It'], other: '' }] });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  assert.equal(m.state().person_id, josh.id);
  await until('the wake', () => m.texts().find((x) => x.includes("Your handed-off land didn't go through")));
});

test('two answers at once, one with a picture: one counts, the other is refused', async () => {
  const m = await minion();
  const card = await m.card();
  const both = await Promise.all([m.press(card, {}, { images: [{ mediaType: 'image/png', data: PNG }] }), m.press(card)]);
  assert.deepEqual(both.map((x) => x.status).sort(), [202, 409], JSON.stringify(both.map((x) => x.data)));
  assert.equal(m.texts().filter((x) => x.startsWith('My answers to your question card')).length, 1);
});

test('what rules the server out sends the answer to the minion with why', async () => {
  const none = await minion({ handOff: null });
  await fellBack(none, await none.card(), /Citadel didn't ship it by itself: the card had no hand-off prepared/);

  const moved = await minion();
  const movedCard = await moved.card();
  moved.commit('more.txt');
  await fellBack(moved, movedCard, /your branch moved since the card/);

  const dirty = await minion();
  const dirtyCard = await dirty.card();
  writeFileSync(join(dirty.cwd, 'src', 'a.ts'), 'edited\n');
  await fellBack(dirty, dirtyCard, /uncommitted changes.*src\/a\.ts/);

  const clash = await minion();
  const clashCard = await clash.card();
  writeFileSync(join(clash.cwd, 'conflict'), '');
  await fellBack(clash, clashCard, /it would conflict; conflicted files: a\.txt/);

  const meanwhile = await minion();
  const meanwhileCard = await meanwhile.card();
  writeFileSync(join(meanwhile.cwd, 'moves'), '');
  await fellBack(meanwhile, meanwhileCard, /your branch moved since the card/);

  const pic = await minion();
  await fellBack(pic, await pic.card(), /words or files added/, {}, { images: [{ mediaType: 'image/png', data: PNG }] });

  const hold = await minion();
  await fellBack(hold, await hold.card(), /the pick wasn't Ship It/, { selected: ['Hold'] });
  const words = await minion();
  await fellBack(words, await words.card(), /words or files added/, { other: 'then rename it' });

  const sealed = await minion();
  const sealedCard = await sealed.card();
  store.updateTicket(sealed.id, { state: 'parked' });
  await fellBack(sealed, sealedCard, /you were sealed/);

  // Its turn's process ended on an approval card (#1916): the turn is still half done.
  const held = await minion();
  const heldCard = await held.card();
  keptCards(store).put({ ticket: held.id, id: 'c1', call: { tool: 'Bash', input: {}, cwd: held.cwd, tripwire: null, pr: null }, person: null, at: Date.now() });
  await fellBack(held, heldCard, /your turn was running or about to/);

  const owner = await minion();
  const ownerCard = await owner.card();
  store.setSetting(buildOwnerKey(projectId, 7), owner.id);
  store.updateTicket(owner.id, { build: 7 });
  await fellBack(owner, ownerCard, null);

  const feeder = await minion({ handOff: null });
  const repo = makeRepo(join(root, 'repo'));
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(repo, 'branch', 'build/8');
  store.setProjectRepoDir(projectId, repo);
  store.updateTicket(feeder.id, { build: 8 });
  const merge = { question: 'Merge this high-risk change into Build 8?', options: [{ label: 'Merge', recommended: true }, { label: 'Hold' }] };
  assert.match(String((await feeder.post(HAND_OFF)).data.error), /not a build's card/);
  await fellBack(feeder, await feeder.card({ questions: [merge] }), null, { selected: ['Merge'] });
});

test('one let in beside the lane holder hands off unless they came to share a pipeline file (#1985)', async () => {
  const holder = await minion({ file: 'src/pipe/a.ts' });
  const beside = await minion({ file: 'src/pipe/b.ts' });
  store.claims.take(projectId, 'pipeline-lane', holder.id, 'Cara');
  store.claims.setQueue(projectId, 'pipeline-lane', [beside.id], 'Cara');
  store.claims.setBeside(store.claims.get(projectId, 'pipeline-lane')!, beside.id);
  const card = await beside.card();
  beside.commit('src/pipe/a.ts');
  assert.match(String((await beside.post(HAND_OFF)).data.error), /both change src\/pipe\/a\.ts/);
  git(beside.cwd, 'reset', '-q', '--hard', 'HEAD~1');
  const r = await beside.press(card);
  assert.equal(r.status, 202, JSON.stringify(r.data));
  await until('its ship to start', () => beside.texts().some((t) => /started this ship with no turn/.test(t)));
  assert.equal(store.claims.get(projectId, 'pipeline-lane')!.handed, 0, "the holder hasn't handed off");
  store.claims.releaseHeldBy(beside.id);
  store.claims.release(projectId, 'pipeline-lane');
});

test("a waiting minion's hand-off is held for the lane and marks it ready; another change of its ships (#1985)", async () => {
  const holder = await minion({ file: 'src/pipe/a.ts' });
  const waiting = await minion({ file: 'src/pipe/b.ts' });
  const plain = await minion({ file: 'src/plain.ts' });
  store.claims.take(projectId, 'pipeline-lane', holder.id, 'Cara');
  store.claims.setQueue(projectId, 'pipeline-lane', [waiting.id, plain.id], 'Cara');
  const handOff = (id: number) => srv.as({ token: agentToken(srv.data, id) })(`/api/tickets/${id}/land/handoff`, { ...HAND_OFF, go: 'Cara, 1:00 PM PST' });
  const r = await handOff(waiting.id);
  assert.equal(r.status, 409);
  assert.match(String(r.data.error), /holds the pipeline lane\. You are marked ready/);
  const ready = () => store.claims.queue(projectId, 'pipeline-lane').map((q) => [q.ticket, q.ready]);
  assert.deepEqual(ready(), [
    [waiting.id, 1],
    [plain.id, 0],
  ]);
  store.claims.setQueue(projectId, 'pipeline-lane', [plain.id, waiting.id], 'Cara');
  assert.deepEqual(
    ready(),
    [
      [plain.id, 0],
      [waiting.id, 1],
    ],
    'a new order keeps it',
  );
  const ok = await handOff(plain.id);
  assert.ok(ok.status < 300, JSON.stringify(ok.data));
  store.claims.releaseHeldBy(waiting.id);
  store.claims.releaseHeldBy(plain.id);
  store.claims.release(projectId, 'pipeline-lane');
});

test('a pipeline change ships from the click only for the lane holder', async () => {
  const out = await minion({ file: 'src/pipe/deep/x.ts' });
  await fellBack(out, await out.card(), /src\/pipe\/deep\/x\.ts is a pipeline file and you don't hold the pipeline lane/);
  const other = await minion({ file: 'tools/pipeline-files.txt' });
  store.claims.take(projectId, 'pipeline-lane', out.id, 'Cara');
  await fellBack(other, await other.card(), /tools\/pipeline-files\.txt is a pipeline file/);

  const dropped = await minion({ file: 'src/pipe/deep/x.ts' });
  git(dropped.cwd, 'rm', '-q', 'tools/pipeline-files.txt');
  git(dropped.cwd, 'commit', '-qm', 'no list');
  await fellBack(dropped, await dropped.card(), /is a pipeline file/);

  const holder = await minion({ file: 'src/pipe/deep/x.ts' });
  store.claims.release(projectId, 'pipeline-lane');
  store.claims.take(projectId, 'pipeline-lane', holder.id, 'Cara');
  assert.equal((await holder.press(await holder.card())).status, 202);
  assert.equal(holder.state().state, 'outside');
  await until('it ships', () => holder.state().status === 'closed');
});

test('a hand_off the ship would refuse is refused with the card, and so is one it has no place on', async () => {
  const m = await minion();
  const why = async (handOff: unknown, extra: object = {}) => {
    const r = await m.post(handOff, extra);
    assert.ok(r.status >= 400, `refused: ${JSON.stringify(r.data)}`);
    return String(r.data.error);
  };
  assert.match(await why({ ...HAND_OFF, risk: undefined }), /Card not posted, since the ship it prepares would be refused: Risk/);
  assert.match(await why({ ...HAND_OFF, go: 'Cara' }), /takes no go/);
  assert.match(await why({ ...HAND_OFF, into: 'build/2' }), /takes no into/);
  assert.match(await why('ship'), /hand_off is an object/);
  assert.match(await why(HAND_OFF, { kind: undefined, questions: [{ question: 'A plain one?', options: OPTIONS }] }), /kind ship/);
  assert.match(await why(HAND_OFF, { questions: [{ question: 'Go?', options: [{ label: 'Yes', recommended: true }, { label: 'No' }] }] }), /labelled "Ship It"/);
  writeFileSync(join(m.cwd, 'src', 'a.ts'), 'edited\n');
  assert.match(await why(HAND_OFF), /uncommitted changes/);
  git(m.cwd, 'checkout', '--', 'src/a.ts');
  writeFileSync(join(m.cwd, 'conflict'), '');
  assert.match(await why(HAND_OFF), /it would conflict/);
  assert.match(await why(HAND_OFF), /it would conflict/, "a late refusal leaves the turn's token working, to post again");
  assert.equal(store.eventsOfKinds(m.id, ['question']).length, 0, 'no card went out');

  const prs = (await srv.call('/api/projects', { name: 'PRs' })).data.id;
  store.setProjectSettings(prs, { ship_path: 'pr-auto' } as never);
  const pr = await minion({ project: prs, handOff: null });
  assert.match(String((await pr.post(HAND_OFF)).data.error), /not a build's card or a pull request/);
  await fellBack(pr, await pr.card(), null);
});
