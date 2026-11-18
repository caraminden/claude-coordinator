import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { accountUsageKey } from '../src/account-pick.ts';
import { Store } from '../src/db.ts';
import { MAX_LIMIT_RESUMES, nextLimitResume, Runner } from '../src/runner.ts';
import { clockTime, parseResetTime } from '../src/pacific.ts';
import { lines, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
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
  const result = process.env.FAKE_RESULT ?? readFileSync(${JSON.stringify(release)}, 'utf8');
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
  r.limitProvenGapMs = 0;
  return r;
}
let runner = makeRunner();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function minion(state: any = null) {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle', state, note: 'before' });
  return t.id;
}

/** Run one turn of `id` that ends with `result`. */
async function turn(id: number, result: string, text = 'go') {
  setRelease(result);
  runner.send(id, 'Cara', text);
  await until('the turn to end', () => !runner.isRunning(id));
  return store.getTicket(id)!;
}

const events = (id: number, kind: string) => store.listEvents(id).filter((e) => e.kind === kind).map((e) => JSON.parse(e.data).text as string);
/** Sets the release file whole: a fake polling for it would otherwise read it between create and write, empty. */
const setRelease = (words: string) => {
  writeFileSync(`${release}.tmp`, words);
  renameSync(`${release}.tmp`, release);
};
const turnsRun = () => lines(prompts).length;

// Two hours from now: a fixed time came round once a day, and a run in the minute before it saw no wait to speak of (#564).
const LIMIT = `You've hit your 5-hour limit · resets ${new Date(Date.now() + 2 * 60 * 60 * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' }).replace(' ', '').toLowerCase()} (America/Los_Angeles)`;
const IDENTITY = 'API Error: 400 Identity verification is required to continue.';

test('the reset time comes from Claude\'s words, in the zone they name', () => {
  const now = Date.parse('2026-10-29T10:00:00Z'); // 3am in Los Angeles (PDT, UTC-7)
  assert.equal(parseResetTime("You've hit your 5-hour limit · resets 3:30pm (America/Los_Angeles)", now), Date.parse('2026-10-29T22:30:00Z'));
  // Already past today: tomorrow's.
  assert.equal(parseResetTime("You've hit your session limit · resets 2am (America/Los_Angeles)", now), Date.parse('2026-10-30T09:00:00Z'));
  assert.equal(parseResetTime('resets 12:15am (UTC)', now), Date.parse('2026-10-30T00:15:00Z'));
  assert.equal(parseResetTime("You've hit your weekly limit · resets Nov 2, 9am", now), null);
  assert.equal(parseResetTime('resets 3pm (Not/AZone)', now), null);
});

test('the resume time says its day when it is not today, and its date a week or so out (#468 S12-9)', () => {
  const now = Date.parse('2026-10-29T10:00:00Z'); // Thursday 3am in Los Angeles
  const LA = 'America/Los_Angeles';
  assert.equal(clockTime(Date.parse('2026-10-29T22:30:00Z'), LA, now), '3:30pm');
  assert.equal(clockTime(Date.parse('2026-10-30T09:00:00Z'), LA, now), 'Fri 2:00am');
  // A weekly limit: days off.
  assert.equal(clockTime(Date.parse('2026-11-01T23:03:00Z'), LA, now), 'Sun 3:03pm'); // PST by then
  // Seven days on is Thursday again: the date too, so it can't read as today.
  assert.equal(clockTime(Date.parse('2026-11-05T19:00:00Z'), LA, now), 'Thu, Nov 5 11:00am');
});

test('a usage limit waits quietly: limited, no error, no push, the resume time on the minion', async () => {
  const resetsAt = Date.now() + 2 * 60 * 60 * 1000;
  store.setSetting('usage', { session: { utilization: 1, resetsAt, status: 'rejected' }, weekly: null, updatedAt: Date.now() });
  const id = minion();
  const t = await turn(id, LIMIT);
  assert.equal(t.status, 'error');
  assert.equal(t.state, 'limited');
  // Two hours out: tomorrow's weekday too when this runs after 10pm.
  assert.match(t.note!, /^Usage limit, resumes (?:[A-Z][a-z]{2} )?\d{1,2}:\d\d[ap]m$/);
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
  setRelease('ok');
  runner.send(id, 'Cara', 'also do this');
  assert.equal(runner.isRunning(id), false, 'held, not run into the limit');
  assert.match(events(id, 'note').at(-1)!, /^Held for the resume at/);
  assert.equal(runner.view(store.getTicket(id)!).queued, 1);
  await until('the resume to run', () => turnsRun() === before + 2 && !runner.isRunning(id));
  const prompt = lines(prompts).at(-1)!;
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
    setRelease('ok');
    // A relay (no person of its own) waits for the payer's reset; a person's own message would try now (#477).
    runner.send(id, 'Relay', 'more from a relay');
    assert.equal(runner.isRunning(id), false, 'the relay waits for the reset');
    const before = turnsRun();
    runner.send(id, 'Josh', 'carry on, josh');
    await until("Josh's turn", () => turnsRun() === before + 1 && !runner.isRunning(id));
    t = store.getTicket(id)!;
    assert.equal(t.person_id, josh.id);
    assert.equal(t.state, null);
    assert.equal(runner.view(t).limit_resume_at, null);
    assert.deepEqual(runner.view(t).payer, { id: josh.id, name: 'Josh' });
    const prompt = lines(prompts).at(-1)!;
    assert.ok(prompt.indexOf('carry on, josh') < prompt.indexOf('more from a relay'), "Josh's message leads, so the turn is his");
  } finally {
    runner.personOf = undefined;
  }
});

test("a person's own message tries now, whatever reset time Claude gave: a reset may have come early (#477)", async () => {
  runner.personOf = (author) => (author === 'Cara' ? 1 : null);
  try {
    const id = minion();
    await turn(id, LIMIT);
    assert.equal(store.getTicket(id)!.state, 'limited');
    const before = turnsRun();
    setRelease('ok');
    runner.send(id, 'Cara', 'I reset it');
    await until('the turn to run now', () => turnsRun() === before + 1 && !runner.isRunning(id));
    const t = store.getTicket(id)!;
    assert.equal(t.status, 'idle');
    assert.equal(t.state, null);
    assert.equal(runner.limitWait(id), null);
  } finally {
    runner.personOf = undefined;
  }
});

test('a turn on the same plan getting through resumes every minion waiting on its limit, those that gave up too (#477)', async () => {
  runner.limitFallbackMs = 50;
  const gaveUp = minion();
  await turn(gaveUp, "You've hit your session limit");
  await until('it to give up', () => store.getTicket(gaveUp)!.note?.startsWith('Usage limit: gave up') ?? false);
  runner.limitFallbackMs = 60 * 60 * 1000;
  const [a, b] = [minion(), minion()];
  await turn(a, LIMIT);
  await turn(b, LIMIT);
  assert.ok(runner.limitWait(a)!.at > Date.now() + 60_000, 'waiting for the stated reset');
  const before = turnsRun();
  // The account works again: one turn gets through, and the waits end now rather than at the stated time.
  await turn(minion(), 'ok');
  await until('the waiting minions to resume', () => turnsRun() === before + 4 && [a, b, gaveUp].every((id) => !runner.isRunning(id)));
  for (const id of [a, b, gaveUp]) {
    const t = store.getTicket(id)!;
    assert.equal(t.status, 'idle');
    assert.equal(t.state, null);
    assert.equal(runner.limitWait(id), null);
    assert.ok(events(id, 'note').includes('Resumed after the usage limit reset'));
  }
  pushes.length = 0;
});

test("a turn getting through says nothing of another model's limit: a minion on that model stays given up, or waits out its time (C7)", async () => {
  runner.limitFallbackMs = 50;
  const gaveUp = minion();
  store.updateTicket(gaveUp, { model: 'opus' });
  await turn(gaveUp, "You've hit your Opus limit");
  await until('it to give up', () => store.getTicket(gaveUp)!.note?.startsWith('Usage limit: gave up') ?? false);
  runner.limitFallbackMs = 60 * 60 * 1000;
  const waiting = minion();
  store.updateTicket(waiting, { model: 'opus' });
  await turn(waiting, LIMIT);
  const at = runner.limitWait(waiting)!.at;
  const before = turnsRun();
  pushes.length = 0;
  // A turn on the plan's default model gets through: Opus's cap is its own, and reviving these would only fail them again, with a push each round.
  await turn(minion(), 'ok');
  await sleep(200);
  assert.equal(turnsRun(), before + 1, 'no Opus minion ran');
  assert.equal(runner.limitWait(gaveUp), null);
  assert.match(store.getTicket(gaveUp)!.note ?? '', /^Usage limit: gave up/);
  assert.equal(runner.limitWait(waiting)?.at, at, 'still waiting for its own reset');
  assert.deepEqual(pushes, []);
  // An Opus turn getting through is the proof they wait for.
  const opus = minion();
  store.updateTicket(opus, { model: 'opus' });
  await turn(opus, 'ok');
  await until('the Opus minions to resume', () => turnsRun() === before + 4 && [waiting, gaveUp].every((id) => !runner.isRunning(id) && !runner.limitWait(id)));
  for (const id of [waiting, gaveUp]) assert.equal(store.getTicket(id)!.state, null);
  pushes.length = 0;
});

test("a Claude turn getting through leaves a minion whose next turn runs on Codex waiting: Codex's limit is its own (#477)", async () => {
  const id = minion();
  await turn(id, LIMIT);
  // Picked Codex since: its resume would run on Codex, whatever Claude's plan does.
  store.updateTicket(id, { model: 'gpt-6-astra' });
  const at = runner.limitWait(id)!.at;
  await turn(minion(), 'ok');
  await sleep(100);
  assert.equal(runner.limitWait(id)?.at, at, 'still waiting for its own reset');
  runner.stop(id);
});

test("a rate-limit event saying the plan works again ends the waits mid-turn, without waiting for the turn's end (#477)", async () => {
  store.setSetting('usage', { session: { utilization: 1, resetsAt: Date.now() + 2 * 60 * 60 * 1000, status: 'rejected' }, weekly: null, updatedAt: Date.now() });
  const id = minion();
  await turn(id, LIMIT);
  assert.ok(runner.limitWait(id)!.at > Date.now() + 60_000);
  const before = turnsRun();
  setRelease('ok');
  // Still limited: nothing moves.
  (runner as any).updateUsage({ unifiedWindows: { five_hour: { utilization: 1, status: 'rejected' } } });
  assert.ok(runner.limitWait(id)!.at > Date.now() + 60_000);
  (runner as any).updateUsage({ unifiedWindows: { five_hour: { utilization: 0.02, status: 'allowed' } } });
  await until('the resume', () => turnsRun() === before + 1 && !runner.isRunning(id));
  assert.equal(store.getTicket(id)!.state, null);
  store.deleteSetting('usage');
});

test("an event reporting one window keeps the other's last reading, without its status, until it resets; app turns record theirs too (#793)", () => {
  const week = Math.floor(Date.now() / 1000) + 3 * 86400;
  runner.recordUsage({ unifiedWindows: { seven_day: { utilization: 0.99, resetsAt: week, status: 'rejected' } } }, 7, 7, 2);
  runner.recordUsage({ unifiedWindows: { five_hour: { utilization: 0.1, status: 'allowed' } } }, 7, 7, 2);
  const u = store.getSetting<any>('usage:user:7:account:2');
  assert.deepEqual(u.weekly, { utilization: 0.99, resetsAt: week * 1000, status: null }, 'the account pick still sees the spent week');
  assert.equal(u.session.utilization, 0.1);
  // Past its reset, a kept window goes.
  store.setSetting('usage:user:7:account:2', { ...u, weekly: { ...u.weekly, resetsAt: Date.now() - 1000 } });
  runner.recordUsage({ unifiedWindows: { five_hour: { utilization: 0.2, status: 'allowed' } } }, 7, 7, 2);
  assert.equal(store.getSetting<any>('usage:user:7:account:2').weekly, null);
  store.deleteSetting('usage:user:7:account:2');
});

test(`it gives up after ${MAX_LIMIT_RESUMES} resumes in a row`, async () => {
  runner.limitFallbackMs = 50;
  const id = minion();
  const before = turnsRun();
  await turn(id, "You've hit your session limit");
  await until('it to give up', () => store.getTicket(id)!.note?.startsWith('Usage limit: gave up') ?? false);
  assert.equal(turnsRun() - before, 1 + MAX_LIMIT_RESUMES);
  const t = store.getTicket(id)!;
  assert.equal(t.state, 'limited');
  assert.equal(runner.view(t).limit_resume_at, null);
  await sleep(200);
  assert.equal(turnsRun() - before, 1 + MAX_LIMIT_RESUMES, 'no more turns');
  assert.deepEqual(pushes, [{ ticket: id, text: `Usage limit: gave up after ${MAX_LIMIT_RESUMES} resumes in a row` }], 'giving up is the one push');
  pushes.length = 0;
  runner.limitFallbackMs = 60 * 60 * 1000;
  // Gone, so the next test's turn getting through doesn't resume it (#477).
  runner.close(id, 'Cara dismissed this minion.');
});

test('the wait and its held messages outlive a restart', async () => {
  const id = minion();
  await turn(id, "You've hit your session limit");
  setRelease('ok');
  runner.send(id, 'Cara', 'held across the restart');
  const before = turnsRun();
  // A new server on the same database, once the reset time has come.
  const list = store.getSetting<any[]>('limit-resumes')!;
  store.setSetting('limit-resumes', list.map((w) => ({ ...w, at: Date.now() })));
  runner = makeRunner();
  runner.recover();
  await until('the resume after the restart', () => turnsRun() === before + 1 && !runner.isRunning(id));
  assert.match(lines(prompts).at(-1)!, /held across the restart/);
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
  await until('the turn to end', () => !r.isRunning(id));
  assert.match(store.getTicket(id)!.note!, /^Could not start claude: /);
  assert.match(pushes.at(-1)!.text, /^Could not start claude: /);
  pushes.length = 0;
});

// Several Claude accounts (#779): fakes for ClaudeLink's side. Account 2's turns end as FAKE_RESULT says.
function accountsFor(person: number, second: string) {
  const s = { inUse: 1, limited: new Map<number, number>(), cleared: [] as number[] };
  const labels = [{ n: 1, label: 'one@x' }, { n: 2, label: 'two@x' }];
  runner.personOf = (author) => (author === 'Pat' ? person : null);
  runner.placeFor = () => (s.inUse === 1 ? { host: true } : { host: true, account: 2, configDir: join(root, 'acct-2'), env: { CLAUDE_CONFIG_DIR: join(root, 'acct-2'), FAKE_RESULT: second } });
  runner.claudeAccounts = () => ({ inUse: s.inUse, accounts: labels });
  runner.onLimit = (_p, n, until) => {
    s.limited.set(n, until);
    const next = labels.find((a) => !s.limited.has(a.n)) ?? null;
    if (next) s.inUse = next.n;
    return { next, resetAt: Math.min(...s.limited.values()), limits: labels.filter((a) => s.limited.has(a.n)).map((a) => ({ ...a, until: s.limited.get(a.n)! })) };
  };
  runner.onCleared = (_p, n) => void s.cleared.push(n);
  return s;
}
const noAccounts = () => {
  runner.personOf = runner.placeFor = runner.claudeAccounts = runner.onLimit = runner.onCleared = undefined;
};

test('a turn that hits its account\'s limit carries on at once with the next ready account, not as a limit resume (#779)', async () => {
  const pat = store.createUser({ name: 'Pat', login: 'pat779' });
  const s = accountsFor(pat.id, 'ok');
  try {
    const id = minion();
    const before = turnsRun();
    setRelease(LIMIT);
    runner.send(id, 'Pat', 'go');
    await until('the turn on account 2', () => turnsRun() === before + 2 && !runner.isRunning(id));
    const t = store.getTicket(id)!;
    assert.equal(t.status, 'idle');
    assert.equal(t.state, null, 'never limited: it carried on');
    assert.equal(s.inUse, 2);
    assert.ok(s.limited.get(1)! > Date.now(), 'account 1 marked until its reset');
    assert.match(events(id, 'note').join('\n'), /hit your 5-hour limit[^\n]*\nCarrying on with two@x \(account 2\): this turn picks up where it stopped\./);
    assert.match(lines(prompts).at(-1)!, /usage limit/i, 'the resume tells Claude why it stopped');
    assert.deepEqual(s.cleared, [2], 'the turn that got through clears its own account');
    assert.deepEqual(events(id, 'error'), []);
    assert.equal(pushes.length, 0);
  } finally {
    noAccounts();
  }
});

test('a minion\'s turn names its session to the account pick once it has one, and says where it ran (#793)', async () => {
  const pat = store.findUser('name', 'Pat')!;
  accountsFor(pat.id, 'ok');
  const asked: (string | undefined)[] = [];
  const ran: [number, string, number][] = [];
  const place = runner.placeFor!;
  runner.placeFor = (person, warm) => (asked.push(warm), place(person, warm));
  runner.onRan = (person, key, n) => void ran.push([person, key, n]);
  try {
    const id = minion();
    setRelease('ok');
    for (const text of ['go', 'again']) {
      const before = turnsRun();
      runner.send(id, 'Pat', text);
      await until('the turn', () => turnsRun() === before + 1 && !runner.isRunning(id));
      // The fake claude reports no session: the second turn resumes this one.
      store.updateTicket(id, { session_id: 'sess-793' });
    }
    assert.equal(asked[0], undefined, 'no session yet: it goes where new work goes');
    assert.equal(asked.at(-1), `ticket:${id}`);
    assert.deepEqual(ran.at(-1), [pat.id, `ticket:${id}`, 1]);
  } finally {
    noAccounts();
    runner.onRan = undefined;
  }
});

test('when every account is limited, the turn waits for the first of them to reset (#779)', async () => {
  const pat = store.findUser('name', 'Pat')!;
  runner.limitFallbackMs = 60 * 60 * 1000;
  const s = accountsFor(pat.id, LIMIT);
  try {
    const id = minion();
    const before = turnsRun();
    setRelease(LIMIT);
    runner.send(id, 'Pat', 'go');
    await until('both accounts to hit their limits', () => turnsRun() === before + 2 && !runner.isRunning(id) && store.getTicket(id)!.state === 'limited');
    assert.equal(s.limited.size, 2);
    assert.equal(runner.view(store.getTicket(id)!).limit_resume_at, Math.min(...s.limited.values()));
    assert.match(events(id, 'note').at(-1)!, /This account \(\w+@x\) is out until [^\n]*\. \w+@x is out until [^\n]*\. This minion carries on at/);
    assert.equal(runner.stop(id), true);
  } finally {
    noAccounts();
  }
});

const WEEKLY = `You've hit your weekly limit · resets ${new Date(Date.now() + 5 * 86_400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles' })}, 12am (America/Los_Angeles)`;

test('weekly on one account and 5-hour on another: the note says which account is out until when, and why it waits (#819)', async () => {
  const pat = store.findUser('name', 'Pat')!;
  runner.limitFallbackMs = 60 * 60 * 1000;
  const week = Date.now() + 5 * 86_400_000;
  // Account 2's own usage state, as Claude's rate-limit events leave it: the week is spent.
  store.setSetting(accountUsageKey((runner as any).payerOf(pat.id), 2), { session: null, weekly: { utilization: 1, resetsAt: week, status: 'rejected' }, updatedAt: Date.now() });
  const s = accountsFor(pat.id, WEEKLY);
  try {
    const id = minion();
    const before = turnsRun();
    setRelease(LIMIT); // account 1: 5-hour; account 2 then hits its weekly limit
    runner.send(id, 'Pat', 'go');
    await until('both accounts to hit their limits', () => turnsRun() === before + 2 && !runner.isRunning(id) && store.getTicket(id)!.state === 'limited');
    const note = events(id, 'note').at(-1)!;
    assert.match(note, /This account \(two@x\) is out until [^\n]*\(weekly\)\./);
    // The 5-hour reset is two hours off, so from 10pm Pacific it falls tomorrow and the clock carries a weekday ("Tue 12:00am").
    assert.match(note, /one@x is out until (?:[A-Z][a-z]{2} )?\d{1,2}:\d{2}[ap]m\./);
    assert.match(note, /carries on at (?:[A-Z][a-z]{2} )?\d{1,2}:\d{2}[ap]m, when one@x's limit resets/);
    assert.doesNotMatch(note, /Every linked Claude account is limited now\. It resumes/);
    const v = runner.view(store.getTicket(id)!);
    assert.equal(v.limit_resume_at! < week, true, 'waits for the 5-hour account, not the week');
    assert.deepEqual(v.limit_accounts!.map((a: any) => [a.label, !!a.here]), [['one@x', false], ['two@x', true]]);
    assert.equal(v.limit_accounts!.find((a: any) => a.here)!.kind, 'weekly');
    assert.equal(runner.stop(id), true);
  } finally {
    noAccounts();
  }
});

test('the limit note says the time in Pacific, whatever zone Claude named', async () => {
  const resetsAt = Date.now() + 2 * 60 * 60 * 1000;
  store.setSetting('usage', { session: { utilization: 1, resetsAt, status: 'rejected' }, weekly: null, updatedAt: Date.now() });
  const id = minion();
  const t = await turn(id, "You've hit your 5-hour limit · resets 9:00am (Asia/Tokyo)");
  const LA = 'America/Los_Angeles';
  assert.equal(t.note, `Usage limit, resumes ${clockTime(resetsAt, LA)}`);
  assert.ok(events(id, 'note').at(-1)!.includes(`resumes by itself at ${clockTime(resetsAt, LA)}`));
  runner.stop(id);
  store.deleteSetting('usage');
});

test('the resume gap: 30 s for unproven waits, 5 s for ones a turn getting through released, and neither holds back the other', () => {
  const now = 1_000_000;
  const gaps = { gap: 30_000, provenGap: 5_000 };
  const unproven = [{ ticket: 1, at: now, tries: 1 }];
  const proven = [{ ticket: 2, at: now, tries: 1, proven: true as const }];
  assert.equal(nextLimitResume(unproven, now - 1_000, gaps.gap, gaps.provenGap)!.due, now + 29_000);
  assert.equal(nextLimitResume(proven, now - 1_000, gaps.gap, gaps.provenGap)!.due, now + 4_000);
  // Both due together: the proven one goes at its own 5 s, not behind the other's 30 s.
  const both = nextLimitResume([...unproven, ...proven], now - 1_000, gaps.gap, gaps.provenGap)!;
  assert.deepEqual([both.wait.ticket, both.due], [2, now + 4_000]);
  assert.equal(nextLimitResume([], 0, 30_000, 5_000), null);
});
