import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { isNetworkFailure, MAX_NET_RESUMES, Runner } from '../src/runner.ts';
import { holds, lines, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// A turn that died because the network or the API was unreachable waits for one server-wide probe to
// see the API again, then resumes by itself (with the messages queued behind it), at most
// MAX_NET_RESUMES times in a row, across a restart (#366). The probe is a fake the test switches on;
// its waits are milliseconds. Fake `claude -p` as in usage-limit.test.ts: it ends with the release
// file's words as its result (an error unless they are "ok"), and logs its prompt.
const root = mkdtempSync(join(tmpdir(), 'network-resume-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
const release = join(root, 'release');
const prompts = join(root, 'prompts.log');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
let input = '';
process.stdin.on('data', (d) => (input += d));
const wait = setInterval(() => {
  if (!input.includes('\\n') || !existsSync(${JSON.stringify(release)})) return;
  clearInterval(wait);
  appendFileSync(${JSON.stringify(prompts)}, input);
  const result = readFileSync(${JSON.stringify(release)}, 'utf8');
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: result !== 'ok', result }));
  process.exit(result === 'ok' ? 0 : 1);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const pushes: { ticket: number; text: string }[] = [];
/** Whether the fake probe finds the API, each probe's wait before it ran, and a gate that holds probes open while set. */
let up = false;
const probes: number[] = [];
let gate: Promise<void> | null = null;
function makeRunner() {
  const r = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  r.onTurnError = (ticket, text) => pushes.push({ ticket, text });
  r.netProbeMs = 20;
  r.netProbeMaxMs = 80;
  r.resumeGapMs = 0;
  r.netProbe = async () => {
    probes.push(r.netDelay ?? r.netProbeMs);
    await gate;
    return up;
  };
  return r;
}
let runner = makeRunner();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function minion() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle', note: 'before' });
  return t.id;
}

/** Run one turn of `id` that ends with `result`. */
async function turn(id: number, result: string, text = 'go', author = 'Cara') {
  setRelease(result);
  runner.send(id, author, text);
  await until('the turn to end', () => !runner.isRunning(id));
  return store.getTicket(id)!;
}

const events = (id: number, kind: string) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === kind)
    .map((e) => JSON.parse(e.data).text as string);
/** Sets the release file whole: a fake polling for it would otherwise read it between create and write, empty. */
const setRelease = (words: string) => {
  writeFileSync(`${release}.tmp`, words);
  renameSync(`${release}.tmp`, release);
};
const turnsRun = () => lines(prompts).length;
const lastPrompt = () => lines(prompts).at(-1)!;

const OUTAGE = "API Error: Can't reach the API server — check your internet or DNS (EAI_AGAIN)";

test('network failures are told apart from every other failure', () => {
  for (const text of [
    OUTAGE,
    'API Error: Can’t reach the API server — check your internet or DNS (ENOTFOUND)',
    'API Error: Connection error.',
    'API Error: Request timed out.',
    'connect ECONNREFUSED 160.79.104.10:443',
    'read ECONNRESET',
    'connect ETIMEDOUT 160.79.104.10:443',
    'Codex: stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)',
    'Codex: failed to lookup address information: Temporary failure in name resolution',
  ])
    assert.ok(isNetworkFailure(text), text);
  for (const text of [
    "You've hit your 5-hour limit · resets 3:30pm (America/Los_Angeles)",
    'API Error: 400 Identity verification is required to continue.',
    'API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
    'API Error: 529 Overloaded',
    'API Error: 500 Internal server error',
    'Codex: stream disconnected before completion: unexpected status 401 Unauthorized',
    'API Error: 502 upstream connect error ECONNRESET',
    'Killed by SIGTERM (exit 143) from outside Citadel.',
    'Blocked by the tripwire: git push to main from a minion worktree',
    "TypeError: Cannot read properties of undefined (reading 'map')",
  ])
    assert.ok(!isNetworkFailure(text), text);
});

test('an outage waits for the probe, backing off, then resumes with the messages queued behind the dead turn', async () => {
  up = false;
  probes.length = 0;
  const id = minion();
  const before = turnsRun();
  rmSync(release, { force: true });
  runner.send(id, 'Cara', 'go');
  await until('the turn to start', () => runner.isRunning(id));
  runner.send(id, 'Cara', 'queued behind it');
  setRelease(OUTAGE);
  await until('the turn to die', () => !runner.isRunning(id));
  let t = store.getTicket(id)!;
  assert.equal(t.status, 'error');
  assert.equal(t.note, 'Network outage: resumes once it is back');
  assert.deepEqual(events(id, 'error'), [], 'a wait, not an error');
  assert.match(events(id, 'note').at(-1)!, /EAI_AGAIN[\s\S]*resumes by itself once it's back/);
  assert.equal(pushes.length, 0, 'an outage pushes nobody');
  assert.equal(runner.netWait(id)?.tries, 1);
  // The probe backs off, doubling up to the cap, and no turn starts while it fails.
  await until('four failed probes', () => probes.length >= 4);
  assert.deepEqual(probes.slice(0, 4), [20, 40, 80, 80]);
  await holds('the queued message starts no turn into the outage', () => turnsRun() === before + 1, { ms: 100 });
  assert.equal(turnsRun(), before + 1, 'the queued message did not start a turn into the outage');
  setRelease('ok');
  up = true;
  await until('the resume', () => turnsRun() === before + 2 && !runner.isRunning(id));
  assert.match(lastPrompt(), /network or the model's API was unreachable[\s\S]*check the state of your work \(git first/);
  assert.match(lastPrompt(), /queued behind it/);
  assert.ok(events(id, 'note').includes('Resumed after a network outage'));
  t = store.getTicket(id)!;
  assert.equal(t.status, 'idle');
  assert.equal(t.note, null, 'the wait note goes with the wait');
  assert.equal(runner.netWait(id), null);
  assert.equal(store.getSetting('net-resumes'), null);
});

test('one probe serves every waiting thread, and each resumes', async () => {
  up = false;
  probes.length = 0;
  let open!: () => void;
  gate = new Promise((r) => (open = r));
  const [a, b] = [minion(), minion()];
  await turn(a, OUTAGE);
  await turn(b, OUTAGE);
  await until('the first probe', () => probes.length >= 1);
  await holds('the second wait starts no probe of its own', () => probes.length === 1, { ms: 150 });
  assert.equal(probes.length, 1, 'one loop: the second wait started no probe of its own while the first was under way');
  const before = turnsRun();
  setRelease('ok');
  up = true;
  gate = null;
  open();
  await until('both resumes', () => turnsRun() === before + 2 && !runner.isRunning(a) && !runner.isRunning(b));
  assert.equal(store.getSetting('net-resumes'), null);
});

test('other failures never wait on the network', async () => {
  const id = minion();
  const t = await turn(id, 'API Error: 529 Overloaded');
  // A failed turn's one retry instead (#2258): fail-retry.test.ts.
  assert.equal(t.note, 'Failed: retries by itself shortly');
  assert.equal(runner.netWait(id), null);
  assert.ok(runner.failWait(id));
  runner.stop(id);
  pushes.length = 0;
});

test('a turn that ends well clears the failure note a failed turn left, and only that note (#428)', async () => {
  const id = minion();
  // Back to back, a turn waits for the last one's save: wait until it has run, not just until nothing runs.
  const turn = async (id: number, result: string, text = 'go') => {
    const before = turnsRun();
    setRelease(result);
    runner.send(id, 'Cara', text);
    await until('the turn to run', () => turnsRun() > before && !runner.isRunning(id));
    return store.getTicket(id)!;
  };
  assert.equal((await turn(id, 'ok')).note, 'before', "a note the agent set stays through a turn that doesn't touch it");
  // A failed turn waits for its one retry (#2258); a person's message runs first, in its place.
  assert.equal((await turn(id, 'API Error: 529 Overloaded')).note, 'Failed: retries by itself shortly');
  assert.equal((await turn(id, 'ok', 'again')).note, null, 'the next good turn clears it');
  assert.equal(runner.failWait(id), null);
  // A note set after the failure (the agent's set_thread_status, a person's update_ticket) is not the server's to clear.
  await turn(id, 'API Error: 529 Overloaded');
  store.updateTicket(id, { note: 'waiting on Josh' });
  assert.equal((await turn(id, 'ok', 'again')).note, 'waiting on Josh');
  // An account error blocks with a note; the next good turn clears both.
  assert.equal((await turn(id, 'API Error: 403 This organization has been disabled.')).state, 'blocked');
  const t = await turn(id, 'ok', 'fixed it');
  assert.deepEqual([t.state, t.note], [null, null]);
  pushes.length = 0;
});

test("a Taskmaster's note only ever says how its last turn failed, so its next turn clears it, however it got there (#428)", async () => {
  const tm = store.createTicket({ project_id: project.id, kind: 'coordinator', title: 'Taskmaster', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(tm.id, root, null);
  // A note left from before the fix, with nothing remembering the server wrote it.
  store.updateTicket(tm.id, { status: 'idle', note: 'Could not start claude: citadel-claude-2: Error: container …' });
  const before = turnsRun();
  setRelease('ok');
  runner.send(tm.id, 'Cara', 'hi');
  await until('the turn to run', () => turnsRun() > before && !runner.isRunning(tm.id));
  assert.equal(store.getTicket(tm.id)!.note, null);
});

test(`it stops retrying after ${MAX_NET_RESUMES} network resumes in a row`, async () => {
  up = true;
  const id = minion();
  const before = turnsRun();
  await turn(id, OUTAGE);
  await until('it to stop retrying', () => store.getTicket(id)!.note?.startsWith('Network: stopped retrying') ?? false);
  assert.equal(turnsRun() - before, 1 + MAX_NET_RESUMES);
  assert.equal(store.getTicket(id)!.note, `Network: stopped retrying after ${MAX_NET_RESUMES} resumes`);
  assert.match(events(id, 'error').at(-1)!, /EAI_AGAIN[\s\S]*resumed 3 times in a row after a network outage, so it stopped retrying/);
  assert.equal(pushes.length, 1, 'giving up pushes, as any failure does');
  await holds('no more turns', () => turnsRun() - before === 1 + MAX_NET_RESUMES, { ms: 200 });
  assert.equal(turnsRun() - before, 1 + MAX_NET_RESUMES, 'no more turns');
  assert.equal(runner.netWait(id), null);
  // A person's message starts the count over.
  pushes.length = 0;
  up = false;
  await turn(id, OUTAGE, 'try again');
  assert.equal(runner.netWait(id)?.tries, 1);
  runner.stop(id);
});

test("a person's message that arrives first wins, and takes the held messages with it", async () => {
  up = false;
  const id = minion();
  rmSync(release, { force: true });
  runner.send(id, 'Cara', 'go');
  await until('the turn to start', () => runner.isRunning(id));
  runner.send(id, 'Cara', 'held one');
  setRelease(OUTAGE);
  await until('the turn to die', () => !runner.isRunning(id));
  assert.ok(runner.netWait(id));
  const before = turnsRun();
  setRelease('ok');
  runner.send(id, 'Cara', 'are you there?');
  await until("the person's turn", () => turnsRun() === before + 1 && !runner.isRunning(id));
  assert.match(lastPrompt(), /held one[\s\S]*are you there\?/);
  assert.doesNotMatch(lastPrompt(), /network or the model's API was unreachable/, 'their turn, not a resume');
  assert.equal(runner.netWait(id), null);
  up = true;
  await holds('no resume after it', () => turnsRun() === before + 1, { ms: 150 });
  assert.equal(turnsRun(), before + 1, 'no resume after it');
});

test('a stop or a dismissal ends the wait', async () => {
  up = false;
  const [a, b] = [minion(), minion()];
  await turn(a, OUTAGE);
  await turn(b, OUTAGE);
  assert.equal(runner.stop(a), true);
  assert.equal(store.getTicket(a)!.note, 'Network outage: stopped, send a message to carry on');
  runner.close(b, 'Cara dismissed this minion.');
  assert.equal(runner.netWait(a), null);
  assert.equal(runner.netWait(b), null);
  const before = turnsRun();
  up = true;
  await holds('neither resumed', () => turnsRun() === before, { ms: 200 });
  assert.equal(turnsRun(), before, 'neither resumed');
  setRelease('ok');
  runner.send(a, 'Cara', 'carry on');
  await until('the turn after the stop', () => turnsRun() > before && !runner.isRunning(a));
  assert.equal(store.getTicket(a)!.note, null, "the stop's note goes with the next good turn");
});

test('the wait and its held messages outlive a restart while the network is still down', async () => {
  up = false;
  const id = minion();
  rmSync(release, { force: true });
  runner.send(id, 'Cara', 'go');
  await until('the turn to start', () => runner.isRunning(id));
  runner.send(id, 'Cara', 'held across the restart');
  setRelease(OUTAGE);
  await until('the turn to die', () => !runner.isRunning(id));
  const before = turnsRun();
  // A new server on the same database; the old one's probe stops with it.
  runner.detachAll();
  runner = makeRunner();
  runner.recover();
  probes.length = 0;
  await until('the new server to probe', () => probes.length >= 1);
  assert.equal(turnsRun(), before);
  setRelease('ok');
  up = true;
  await until('the resume after the restart', () => turnsRun() === before + 1 && !runner.isRunning(id));
  assert.match(lastPrompt(), /network or the model's API was unreachable[\s\S]*held across the restart/);
  assert.equal(store.getSetting('net-resumes'), null);
});

test("a resume keeps the dead turn's asker, and with it their machines", async () => {
  up = false;
  const josh = store.createUser({ name: 'Josh', login: 'josh-net' });
  runner.personOf = (author) => store.findUser('name', author)?.id ?? null;
  const seen: number[][] = [];
  runner.machines = (_p, askers) => (seen.push(askers), []);
  try {
    const id = minion();
    await turn(id, OUTAGE, 'go', 'Josh');
    assert.deepEqual(seen.at(-1), [josh.id]);
    const before = turnsRun();
    setRelease('ok');
    up = true;
    await until('the resume', () => turnsRun() === before + 1 && !runner.isRunning(id));
    assert.deepEqual(seen.at(-1), [josh.id], 'the resume answers the same person');
  } finally {
    runner.personOf = undefined;
    runner.machines = () => [];
  }
});

test("the wait stays saved until the resume's turn starts, so a restart during the last turn's save still resumes", async () => {
  up = false;
  const id = minion();
  // The turn's save hangs, as a slow one would: the resume waits for it on the minion's lane.
  let finish!: () => void;
  const saving = new Promise<void>((r) => (finish = r));
  const save = runner.saveSession;
  runner.saveSession = async () => saving;
  try {
    await turn(id, OUTAGE);
    const before = turnsRun();
    up = true;
    await holds('the resume waits for the save', () => turnsRun() === before, { ms: 150 });
    assert.equal(turnsRun(), before, 'the resume waits for the save');
    assert.ok(runner.netWait(id), 'and the wait is still saved for the next server');
  } finally {
    runner.saveSession = save;
    finish();
  }
  setRelease('ok');
  await until('the resume after the save', () => !runner.isRunning(id) && runner.netWait(id) === null && events(id, 'note').includes('Resumed after a network outage'));
});

test('a message held by the network wait shows as queued and can be taken back (#468 S03-9)', async () => {
  up = false;
  const id = minion();
  rmSync(release, { force: true });
  runner.send(id, 'Cara', 'go');
  await until('the turn to start', () => runner.isRunning(id));
  runner.send(id, 'Cara', 'never mind this');
  const msg = store
    .listEvents(id)
    .filter((e) => e.kind === 'user_message')
    .at(-1)!;
  writeFileSync(release, OUTAGE);
  await until('the turn to die', () => !runner.isRunning(id));
  assert.deepEqual(
    runner.queue.msgs(id).map((m) => m.id),
    [msg.id],
    'it waits in the queue, for the resume',
  );
  const shown = runner.view(store.getTicket(id)!);
  assert.deepEqual([shown.queued, shown.queued_ids], [1, [msg.id]]);
  assert.equal(runner.unqueue(id, msg.id, 'Cara'), true);
  assert.deepEqual(runner.queue.msgs(id), [], 'gone from the saved queue too');
  assert.equal(runner.view(store.getTicket(id)!).queued, 0);
  const before = turnsRun();
  writeFileSync(release, 'ok');
  up = true;
  await until('the resume', () => turnsRun() === before + 1 && !runner.isRunning(id));
  assert.doesNotMatch(lastPrompt(), /never mind this/);
});

test("a resume whose Claude can't start keeps the held messages for the next turn (#468 S03-6)", async () => {
  up = false;
  const id = minion();
  rmSync(release, { force: true });
  runner.send(id, 'Cara', 'go');
  await until('the turn to start', () => runner.isRunning(id));
  runner.send(id, 'Cara', 'held through it all');
  setRelease(OUTAGE);
  await until('the turn to die', () => !runner.isRunning(id));
  assert.ok(runner.netWait(id));
  runner.placeFor = () => ({ refused: 'No Claude login for this turn.' });
  const before = turnsRun();
  try {
    setRelease('ok');
    up = true;
    await until('the refused resume', () => events(id, 'note').includes('No Claude login for this turn.'));
    assert.equal(turnsRun(), before);
  } finally {
    runner.placeFor = undefined;
  }
  runner.send(id, 'Cara', 'now?');
  await until("the person's turn", () => turnsRun() === before + 1 && !runner.isRunning(id));
  assert.match(lastPrompt(), /held through it all[\s\S]*now\?/);
});
