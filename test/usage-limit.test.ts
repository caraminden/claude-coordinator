import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { MAX_LIMIT_RESUMES, parseResetTime, Runner } from '../src/runner.ts';
import { stopTurns, testPins } from './helpers.ts';
testPins();

// A failed turn says why. A usage limit is a wait: the minion is `limited`, resumes by itself after the
// reset (spaced from the others, capped, held messages included, across a restart), and nobody gets
// pushed. An account error needs a person: blocked, one push. Fake `claude -p` as in pending-deploy.test.ts:
// it ends with the release file's words as its result (an error unless they are "ok"), and logs its prompt.
const root = mkdtempSync(join(tmpdir(), 'usage-limit-'));
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
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [], usage: { input_tokens: 5, cache_read_input_tokens: 120000, cache_creation_input_tokens: 2000 } } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: result !== 'ok', result }));
  process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const pushes: { ticket: number; text: string }[] = [];
function makeRunner() {
  const r = new Runner(store, () => {}, () => ({}), fake);
  r.onTurnError = (ticket, text) => pushes.push({ ticket, text });
  r.limitDelayMs = 0;
  r.limitGapMs = 0;
  return r;
}
let runner = makeRunner();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 250 && !cond(); i++) await sleep(20);
  assert.ok(cond(), `timed out waiting for ${what}`);
}

function minion(state: any = null) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle', state, note: 'before' });
  return t.id;
}

/** Run one turn of `id` that ends with `result`. */
async function turn(id: number, result: string, text = 'go') {
  writeFileSync(release, result);
  runner.send(id, 'Cara', text);
  await until(() => !runner.isRunning(id), 'the turn to end');
  return store.getTicket(id)!;
}

const events = (id: number, kind: string) => store.listEvents(id).filter((e) => e.kind === kind).map((e) => JSON.parse(e.data).text as string);
const turnsRun = () => (existsSync(prompts) ? readFileSync(prompts, 'utf8').split('\n').filter(Boolean).length : 0);

const LIMIT = "You've hit your 5-hour limit · resets 3:30pm (America/Los_Angeles)";
const IDENTITY = 'API Error: 400 Identity verification is required to continue.';

test('the reset time comes from Claude\'s words, in the zone they name', () => {
  const now = Date.parse('2026-10-29T10:00:00Z'); // 3am in Los Angeles (PDT, UTC-7)
  assert.equal(parseResetTime(LIMIT, now), Date.parse('2026-10-29T22:30:00Z'));
  // Already past today: tomorrow's.
  assert.equal(parseResetTime("You've hit your session limit · resets 2am (America/Los_Angeles)", now), Date.parse('2026-10-30T09:00:00Z'));
  assert.equal(parseResetTime('resets 12:15am (UTC)', now), Date.parse('2026-10-30T00:15:00Z'));
  assert.equal(parseResetTime("You've hit your weekly limit · resets Nov 2, 9am", now), null);
  assert.equal(parseResetTime('resets 3pm (Not/AZone)', now), null);
});

test('a usage limit waits quietly: limited, no error, no push, the resume time on the minion', async () => {
  const resetsAt = Date.now() + 2 * 60 * 60 * 1000;
  store.setSetting('usage', { session: { utilization: 1, resetsAt, status: 'rejected' }, weekly: null, updatedAt: Date.now() });
  const id = minion();
  const t = await turn(id, LIMIT);
  assert.equal(t.status, 'error');
  assert.equal(t.state, 'limited');
  assert.match(t.note!, /^Usage limit, resumes \d{1,2}:\d\d[ap]m$/);
  assert.equal(runner.view(t).limit_resume_at, resetsAt, 'the reset from the rate-limit event beats the words');
  assert.deepEqual(events(id, 'error'), []);
  assert.match(events(id, 'note').at(-1)!, /hit your 5-hour limit[\s\S]*resumes by itself at/);
  assert.equal(pushes.length, 0);
  // Stop ends the wait.
  assert.equal(runner.stop(id), true);
  assert.equal(runner.view(store.getTicket(id)!).limit_resume_at, null);
  store.deleteSetting('usage');
});

test('pending-deploy outlasts a limit', async () => {
  const id = minion('pending-deploy');
  assert.equal((await turn(id, LIMIT)).state, 'pending-deploy');
  runner.stop(id);
});

test('waiting minions resume a gap apart', async () => {
  runner.limitGapMs = 30_000;
  const [a, b] = [minion(), minion()];
  await turn(a, LIMIT);
  await turn(b, LIMIT);
  const at = (id: number) => runner.view(store.getTicket(id)!).limit_resume_at!;
  assert.equal(at(b) - at(a), 30_000);
  runner.stop(a);
  runner.stop(b);
  runner.limitGapMs = 0;
});

test('an account error blocks, says it needs a person, and pushes once for everyone', async () => {
  const [a, b] = [minion(), minion()];
  const ta = await turn(a, IDENTITY);
  const tb = await turn(b, IDENTITY);
  for (const t of [ta, tb]) {
    assert.equal(t.status, 'error');
    assert.equal(t.state, 'blocked');
    assert.equal(t.note, 'Needs a person: Identity verification is required to contin…');
    assert.equal(runner.view(t).limit_resume_at, null, 'never retried');
  }
  assert.match(events(b, 'error').at(-1)!, /^API Error: 400 Identity verification[\s\S]*needs a person/);
  assert.deepEqual(pushes, [{ ticket: a, text: IDENTITY }]);
  pushes.length = 0;
});

test('any other failure shows its own words, in the chat, the note and the push', async () => {
  const id = minion('ready');
  const t = await turn(id, 'API Error: 529 Overloaded');
  assert.equal(t.status, 'error');
  assert.equal(t.note, 'API Error: 529 Overloaded');
  assert.equal(events(id, 'error').at(-1), 'API Error: 529 Overloaded\n(claude ended without finishing)');
  assert.equal(pushes.at(-1)?.text, 'API Error: 529 Overloaded\n(claude ended without finishing)');
  pushes.length = 0;
});

test('after the reset it resumes, with the messages held while it waited', async () => {
  runner.limitFallbackMs = 600; // the words say no time
  const id = minion();
  const before = turnsRun();
  await turn(id, "You've hit your session limit");
  assert.equal(store.getTicket(id)!.state, 'limited');
  writeFileSync(release, 'ok');
  runner.send(id, 'Cara', 'also do this');
  assert.equal(runner.isRunning(id), false, 'held, not run into the limit');
  assert.match(events(id, 'note').at(-1)!, /^Held for the resume at/);
  assert.equal(runner.view(store.getTicket(id)!).queued, 1);
  await until(() => turnsRun() === before + 2 && !runner.isRunning(id), 'the resume to run');
  const prompt = readFileSync(prompts, 'utf8').trim().split('\n').at(-1)!;
  assert.match(prompt, /usage limit, which has now reset/);
  assert.match(prompt, /also do this/);
  const t = store.getTicket(id)!;
  assert.equal(t.status, 'idle');
  assert.equal(t.state, null);
  assert.equal(runner.view(t).limit_resume_at, null);
  assert.ok(events(id, 'note').includes('Resumed after the usage limit reset'));
  runner.limitFallbackMs = 60 * 60 * 1000;
});

test("someone on another plan carries on through the payer's limit, on their own plan; the payer's own messages wait (#219)", async () => {
  store.createUser({ name: 'Cara', login: 'cara', admin: true, server_login: true });
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  runner.personOf = (author) => store.findUser('name', author)?.id ?? null;
  try {
    const id = minion();
    await turn(id, LIMIT);
    let t = store.getTicket(id)!;
    assert.equal(t.state, 'limited');
    assert.deepEqual(runner.view(t).payer, { id: null, name: 'Cara' });
    assert.equal(runner.view(t).context_tokens, 122005);
    writeFileSync(release, 'ok');
    runner.send(id, 'Cara', 'more from cara');
    assert.equal(runner.isRunning(id), false, "Cara's own message waits for her reset");
    const before = turnsRun();
    runner.send(id, 'Josh', 'carry on, josh');
    await until(() => turnsRun() === before + 1 && !runner.isRunning(id), "Josh's turn");
    t = store.getTicket(id)!;
    assert.equal(t.person_id, josh.id);
    assert.equal(t.state, null);
    assert.equal(runner.view(t).limit_resume_at, null);
    assert.deepEqual(runner.view(t).payer, { id: josh.id, name: 'Josh' });
    const prompt = readFileSync(prompts, 'utf8').trim().split('\n').at(-1)!;
    assert.ok(prompt.indexOf('carry on, josh') < prompt.indexOf('more from cara'), "Josh's message leads, so the turn is his");
  } finally {
    runner.personOf = undefined;
  }
});

test(`it gives up after ${MAX_LIMIT_RESUMES} resumes in a row`, async () => {
  runner.limitFallbackMs = 50;
  const id = minion();
  const before = turnsRun();
  await turn(id, "You've hit your session limit");
  await until(() => store.getTicket(id)!.note?.startsWith('Usage limit: gave up') ?? false, 'it to give up');
  assert.equal(turnsRun() - before, 1 + MAX_LIMIT_RESUMES);
  const t = store.getTicket(id)!;
  assert.equal(t.state, 'limited');
  assert.equal(runner.view(t).limit_resume_at, null);
  await sleep(200);
  assert.equal(turnsRun() - before, 1 + MAX_LIMIT_RESUMES, 'no more turns');
  assert.deepEqual(pushes, [{ ticket: id, text: `Usage limit: gave up after ${MAX_LIMIT_RESUMES} resumes in a row` }], 'giving up is the one push');
  pushes.length = 0;
  runner.limitFallbackMs = 60 * 60 * 1000;
});

test('the wait and its held messages outlive a restart', async () => {
  const id = minion();
  await turn(id, "You've hit your session limit");
  writeFileSync(release, 'ok');
  runner.send(id, 'Cara', 'held across the restart');
  const before = turnsRun();
  // A new server on the same database, once the reset time has come.
  const list = store.getSetting<any[]>('limit-resumes')!;
  store.setSetting('limit-resumes', list.map((w) => ({ ...w, at: Date.now() })));
  runner = makeRunner();
  runner.recover();
  await until(() => turnsRun() === before + 1 && !runner.isRunning(id), 'the resume after the restart');
  assert.match(readFileSync(prompts, 'utf8').trim().split('\n').at(-1)!, /held across the restart/);
  assert.equal(store.getSetting('limit-resumes'), null);
});

test('dismissing ends the wait; a held message can be taken back', async () => {
  const id = minion();
  await turn(id, "You've hit your session limit");
  runner.send(id, 'Cara', 'never mind');
  const held = store.listEvents(id).filter((e) => e.kind === 'user_message').at(-1)!.id;
  assert.equal(runner.unqueue(id, held, 'Cara'), true);
  assert.deepEqual(store.getSetting<any[]>('limit-resumes')!.find((w) => w.ticket === id).queued, []);
  runner.close(id, 'Cara dismissed this minion.');
  assert.equal(runner.limitWait(id), null);
  assert.equal(store.getTicket(id)!.status, 'closed');
});

test('a turn whose claude never starts says why', async () => {
  const r = new Runner(store, () => {}, () => ({}), join(root, 'no-such-claude'));
  r.onTurnError = (ticket, text) => pushes.push({ ticket, text });
  const id = minion();
  r.send(id, 'Cara', 'go');
  await until(() => !r.isRunning(id), 'the turn to end');
  assert.match(store.getTicket(id)!.note!, /^Could not start claude: /);
  assert.match(pushes.at(-1)!.text, /^Could not start claude: /);
  pushes.length = 0;
});
