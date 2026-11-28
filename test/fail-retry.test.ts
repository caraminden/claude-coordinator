import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { lines, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// A turn that fails for any other reason (#2258; Cara, 2026-11-27, "Retry once, then alert") is retried once by the
// server a little later, and a second failure in a row wakes the owner's Taskmaster once (onRetryFailed). Peek Auras'
// Build 2 Overseer sat in error for about 5 hours after one such turn. Fake `claude -p` as in network-resume.test.ts:
// it ends with the release file's words as its result (an error unless they are "ok"), and logs its prompt.
const root = mkdtempSync(join(tmpdir(), 'fail-retry-'));
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
const project = store.createProject('Other scheme', null);
const pushes: { ticket: number; text: string }[] = [];
const alerts: { ticket: number; text: string }[] = [];
function makeRunner(retryMs = 20) {
  const r = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  r.onTurnError = (ticket, text) => pushes.push({ ticket, text });
  r.onRetryFailed = (ticket, text) => alerts.push({ ticket, text });
  r.failRetryMs = retryMs;
  r.resumeGapMs = 0;
  return r;
}
let runner = makeRunner();

function minion() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  store.updateTicket(t.id, { status: 'idle' });
  return t.id;
}
const setRelease = (words: string) => {
  writeFileSync(`${release}.tmp`, words);
  renameSync(`${release}.tmp`, release);
};
const turnsRun = () => lines(prompts).length;
const lastPrompt = () => lines(prompts).at(-1)!;
const events = (id: number, kind: string) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === kind)
    .map((e) => JSON.parse(e.data).text as string);
const BOOM = 'API Error: 500 Internal server error';

test('a failed turn is retried once, telling the minion why, and nobody is pushed when the retry works', async () => {
  const id = minion();
  setRelease(BOOM);
  const before = turnsRun();
  runner.send(id, 'Cara', 'go');
  await until('the failed turn', () => turnsRun() === before + 1 && !runner.isRunning(id));
  assert.ok(runner.failWait(id), 'it waits for its retry');
  assert.equal(store.getTicket(id)!.note, 'Failed: retries by itself shortly');
  setRelease('ok');
  await until('the retry', () => turnsRun() === before + 2 && !runner.isRunning(id) && store.getTicket(id)!.status === 'idle');
  assert.match(lastPrompt(), /Your last turn failed[\s\S]*API Error: 500 Internal server error[\s\S]*check the state of your work/);
  assert.equal(runner.failWait(id), null);
  assert.equal(store.getTicket(id)!.note, null);
  assert.deepEqual(pushes.filter((p) => p.ticket === id), []);
  assert.deepEqual(alerts.filter((a) => a.ticket === id), []);
});

test("a second failure in a row stops, stays in error and wakes the owner's Taskmaster once", async () => {
  const id = minion();
  setRelease(BOOM);
  const before = turnsRun();
  runner.send(id, 'Cara', 'go');
  await until('the failed retry', () => turnsRun() === before + 2 && !runner.isRunning(id) && alerts.some((a) => a.ticket === id));
  const t = store.getTicket(id)!;
  assert.equal(t.status, 'error');
  assert.equal(t.note, 'Failed twice: its Taskmaster was told');
  assert.equal(runner.failWait(id), null);
  const mine = alerts.filter((a) => a.ticket === id);
  assert.equal(mine.length, 1);
  assert.match(mine[0].text, /API Error: 500 Internal server error/);
  assert.match(mine[0].text, /retried once/);
  assert.match(events(id, 'error').at(-1)!, /retried once[\s\S]*Taskmaster/);
  assert.equal(pushes.filter((p) => p.ticket === id).length, 1, 'people are pushed on the second failure');
  // Nothing more by itself: the next turn is a person's, and it works.
  setRelease('ok');
  runner.send(id, 'Cara', 'carry on');
  await until('the next turn', () => turnsRun() === before + 3 && !runner.isRunning(id));
  assert.equal(alerts.filter((a) => a.ticket === id).length, 1);
  assert.equal(store.getTicket(id)!.status, 'idle');
});

test("a person's message during the wait takes the retry's place", async () => {
  runner.detachAll();
  runner = makeRunner(60_000);
  const id = minion();
  setRelease(BOOM);
  const before = turnsRun();
  runner.send(id, 'Cara', 'go');
  await until('the failed turn', () => turnsRun() === before + 1 && !runner.isRunning(id) && !!runner.failWait(id));
  setRelease('ok');
  runner.send(id, 'Cara', 'try again');
  await until("the person's turn", () => turnsRun() === before + 2 && !runner.isRunning(id));
  assert.doesNotMatch(lastPrompt(), /Your last turn failed/);
  assert.equal(runner.failWait(id), null);
  assert.equal(store.getSetting('fail-resumes'), null);
});

test('a stop during the wait ends it', async () => {
  const id = minion();
  setRelease(BOOM);
  const before = turnsRun();
  runner.send(id, 'Cara', 'go');
  await until('the failed turn', () => turnsRun() === before + 1 && !runner.isRunning(id) && !!runner.failWait(id));
  assert.equal(runner.stop(id), true);
  assert.equal(runner.failWait(id), null);
  assert.equal(store.getTicket(id)!.note, 'Failed: stopped, send a message to carry on');
});

test('the wait outlives a restart', async () => {
  const id = minion();
  setRelease(BOOM);
  const before = turnsRun();
  runner.send(id, 'Cara', 'go');
  await until('the failed turn', () => turnsRun() === before + 1 && !runner.isRunning(id) && !!runner.failWait(id));
  // A new server on the same database, with a short wait this time.
  runner.detachAll();
  runner = makeRunner();
  setRelease('ok');
  runner.recover();
  await until('the retry after the restart', () => turnsRun() === before + 2 && !runner.isRunning(id) && store.getTicket(id)!.status === 'idle');
  assert.match(lastPrompt(), /Your last turn failed/);
  assert.equal(store.getSetting('fail-resumes'), null);
});
