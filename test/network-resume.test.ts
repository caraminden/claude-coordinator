import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { isNetworkFailure, MAX_NET_RESUMES, Runner } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
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
  const r = new Runner(store, () => {}, () => ({}), fake);
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
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 250 && !cond(); i++) await sleep(20);
  assert.ok(cond(), `timed out waiting for ${what}`);
}

function minion() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle', note: 'before' });
  return t.id;
}

/** Run one turn of `id` that ends with `result`. */
async function turn(id: number, result: string, text = 'go', author = 'Cara') {
  writeFileSync(release, result);
  runner.send(id, author, text);
  await until(() => !runner.isRunning(id), 'the turn to end');
  return store.getTicket(id)!;
}

const events = (id: number, kind: string) => store.listEvents(id).filter((e) => e.kind === kind).map((e) => JSON.parse(e.data).text as string);
const turnsRun = () => (existsSync(prompts) ? readFileSync(prompts, 'utf8').split('\n').filter(Boolean).length : 0);
const lastPrompt = () => readFileSync(prompts, 'utf8').trim().split('\n').at(-1)!;

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
  ]) assert.ok(isNetworkFailure(text), text);
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
    'TypeError: Cannot read properties of undefined (reading \'map\')',
  ]) assert.ok(!isNetworkFailure(text), text);
});

test('an outage waits for the probe, backing off, then resumes with the messages queued behind the dead turn', async () => {
  up = false;
  probes.length = 0;
  const id = minion();
  const before = turnsRun();
  rmSync(release, { force: true });
  runner.send(id, 'Cara', 'go');
  await until(() => runner.isRunning(id), 'the turn to start');
  runner.send(id, 'Cara', 'queued behind it');
  writeFileSync(release, OUTAGE);
  await until(() => !runner.isRunning(id), 'the turn to die');
  let t = store.getTicket(id)!;
  assert.equal(t.status, 'error');
  assert.equal(t.note, 'Network outage: resumes once it is back');
  assert.deepEqual(events(id, 'error'), [], 'a wait, not an error');
  assert.match(events(id, 'note').at(-1)!, /EAI_AGAIN[\s\S]*resumes by itself once it's back/);
  assert.equal(pushes.length, 0, 'an outage pushes nobody');
  assert.equal(runner.netWait(id)?.tries, 1);
  // The probe backs off, doubling up to the cap, and no turn starts while it fails.
  await until(() => probes.length >= 4, 'four failed probes');
  assert.deepEqual(probes.slice(0, 4), [20, 40, 80, 80]);
  await sleep(100);
  assert.equal(turnsRun(), before + 1, 'the queued message did not start a turn into the outage');
  writeFileSync(release, 'ok');
  up = true;
  await until(() => turnsRun() === before + 2 && !runner.isRunning(id), 'the resume');
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
  await sleep(150);
  assert.equal(probes.length, 1, 'one loop: the second wait started no probe of its own while the first was under way');
  const before = turnsRun();
  writeFileSync(release, 'ok');
  up = true;
  gate = null;
  open();
  await until(() => turnsRun() === before + 2 && !runner.isRunning(a) && !runner.isRunning(b), 'both resumes');
  assert.equal(store.getSetting('net-resumes'), null);
});

test('other failures never wait on the network', async () => {
  const id = minion();
  const t = await turn(id, 'API Error: 529 Overloaded');
  assert.equal(t.note, 'API Error: 529 Overloaded');
  assert.equal(runner.netWait(id), null);
  pushes.length = 0;
});

test("a turn that ends well clears the failure note a failed turn left, and only that note (#428)", async () => {
  const id = minion();
  // Back to back, a turn waits for the last one's save: wait until it has run, not just until nothing runs.
  const turn = async (id: number, result: string, text = 'go') => {
    const before = turnsRun();
    writeFileSync(release, result);
    runner.send(id, 'Cara', text);
    await until(() => turnsRun() > before && !runner.isRunning(id), 'the turn to run');
    return store.getTicket(id)!;
  };
  assert.equal((await turn(id, 'ok')).note, 'before', "a note the agent set stays through a turn that doesn't touch it");
  assert.equal((await turn(id, 'API Error: 529 Overloaded')).note, 'API Error: 529 Overloaded');
  assert.equal((await turn(id, 'ok', 'again')).note, null, 'the next good turn clears it');
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
  writeFileSync(release, 'ok');
  runner.send(tm.id, 'Cara', 'hi');
  await until(() => turnsRun() > before && !runner.isRunning(tm.id), 'the turn to run');
  assert.equal(store.getTicket(tm.id)!.note, null);
});

test(`it stops retrying after ${MAX_NET_RESUMES} network resumes in a row`, async () => {
  up = true;
  const id = minion();
  const before = turnsRun();
  await turn(id, OUTAGE);
  await until(() => store.getTicket(id)!.note?.startsWith('Network: stopped retrying') ?? false, 'it to stop retrying');
  assert.equal(turnsRun() - before, 1 + MAX_NET_RESUMES);
  assert.equal(store.getTicket(id)!.note, `Network: stopped retrying after ${MAX_NET_RESUMES} resumes`);
  assert.match(events(id, 'error').at(-1)!, /EAI_AGAIN[\s\S]*resumed 3 times in a row after a network outage, so it stopped retrying/);
  assert.equal(pushes.length, 1, 'giving up pushes, as any failure does');
  await sleep(200);
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
  await until(() => runner.isRunning(id), 'the turn to start');
  runner.send(id, 'Cara', 'held one');
  writeFileSync(release, OUTAGE);
  await until(() => !runner.isRunning(id), 'the turn to die');
  assert.ok(runner.netWait(id));
  const before = turnsRun();
  writeFileSync(release, 'ok');
  runner.send(id, 'Cara', 'are you there?');
  await until(() => turnsRun() === before + 1 && !runner.isRunning(id), "the person's turn");
  assert.match(lastPrompt(), /held one[\s\S]*are you there\?/);
  assert.doesNotMatch(lastPrompt(), /network or the model's API was unreachable/, 'their turn, not a resume');
  assert.equal(runner.netWait(id), null);
  up = true;
  await sleep(150);
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
  await sleep(200);
  assert.equal(turnsRun(), before, 'neither resumed');
  writeFileSync(release, 'ok');
  runner.send(a, 'Cara', 'carry on');
  await until(() => turnsRun() > before && !runner.isRunning(a), 'the turn after the stop');
  assert.equal(store.getTicket(a)!.note, null, "the stop's note goes with the next good turn");
});

test('the wait and its held messages outlive a restart while the network is still down', async () => {
  up = false;
  const id = minion();
  rmSync(release, { force: true });
  runner.send(id, 'Cara', 'go');
  await until(() => runner.isRunning(id), 'the turn to start');
  runner.send(id, 'Cara', 'held across the restart');
  writeFileSync(release, OUTAGE);
  await until(() => !runner.isRunning(id), 'the turn to die');
  const before = turnsRun();
  // A new server on the same database; the old one's probe stops with it.
  runner.detachAll();
  runner = makeRunner();
  runner.recover();
  probes.length = 0;
  await until(() => probes.length >= 1, 'the new server to probe');
  assert.equal(turnsRun(), before);
  writeFileSync(release, 'ok');
  up = true;
  await until(() => turnsRun() === before + 1 && !runner.isRunning(id), 'the resume after the restart');
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
    writeFileSync(release, 'ok');
    up = true;
    await until(() => turnsRun() === before + 1 && !runner.isRunning(id), 'the resume');
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
    await sleep(150);
    assert.equal(turnsRun(), before, 'the resume waits for the save');
    assert.ok(runner.netWait(id), 'and the wait is still saved for the next server');
  } finally {
    runner.saveSession = save;
    finish();
  }
  writeFileSync(release, 'ok');
  await until(() => !runner.isRunning(id) && runner.netWait(id) === null && events(id, 'note').includes('Resumed after a network outage'), 'the resume after the save');
});
