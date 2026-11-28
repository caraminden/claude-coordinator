import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { MAX_KILL_RESUMES, Runner } from '../src/runner.ts';
import { lines, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// A turn killed from outside (out of memory, a container stop, a stray signal) is resumed by the server once, by
// itself, on the same person's login (RL1, #1364). Nov 20: 16 minions killed at once, 17 messages by hand to restart
// them. Cara (2026-11-20): "So if it crashes again would it stop for good? I dont want to get in restart loops":
// one resume per kill, and a second kill in a row stops for good. Resumes after a wave go one at a time, a few
// seconds apart, and wait (bounded) while the box is starved.
//
// Fake `claude -p`: logs its minion and prompt, then hangs until the test kills it ("hang" in the prompt), exits 1
// with stderr ("crash"), or ends well. A resume ends well unless the hang-again file is there.
const root = mkdtempSync(join(tmpdir(), 'kill-resume-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const fake = join(root, 'claude-fake');
const prompts = join(root, 'prompts.log');
const hangAgain = join(root, 'hang-again');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync } = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  appendFileSync(${JSON.stringify(prompts)}, process.env.TEST_MINION + ' ' + input + '\\n');
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } }));
  if (input.includes('crash')) {
    console.error('TypeError: something inside claude broke');
    console.error('    at main (cli.js:1:1)');
    process.exit(1);
  }
  const resume = input.includes('was killed');
  if (resume ? existsSync(${JSON.stringify(hangAgain)}) : input.includes('hang')) return setInterval(() => {}, 1000);
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const cara = store.createUser({ name: 'Cara', login: 'cara' });
const josh = store.createUser({ name: 'Josh', login: 'josh' });
store.addMember(project.id, cara.id);
store.addMember(project.id, josh.id);

const pushes: { ticket: number; text: string }[] = [];
/** Whose login each turn asked for, by minion, in order. */
const places: { ticket: number; person: number | null }[] = [];
let placing = 0;
let starved = false;
let pressureReads = 0;
function makeRunner() {
  const r = new Runner(
    store,
    () => {},
    (t: { id: number }) => ({ TEST_MINION: String(t.id) }),
    fake,
  );
  r.pollMs = 10;
  r.turnLine.setSize(50, 'Cara'); // its 16-turn wave all runs (#1868)
  r.resumeGapMs = 0;
  r.onTurnError = (ticket, text) => pushes.push({ ticket, text });
  r.personOf = (author) => (author === 'Josh' ? josh.id : author === 'Cara' ? cara.id : null);
  r.placeFor = (person) => {
    places.push({ ticket: placing, person });
    return { host: true };
  };
  r.killStarved = async () => {
    pressureReads++;
    return { starved, why: starved ? 'memory pressure 31%' : '' };
  };
  return r;
}
let runner = makeRunner();

function minion() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  store.setTicketDir(t.id, root, null);
  return t.id;
}
const events = (id: number, kind: string) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === kind)
    .map((e) => JSON.parse(e.data).text as string);
const promptsOf = (word: string) => lines(prompts).filter((l) => l.includes(word));
/** How many turns the minion has started, its resumes included. */
const turnsOf = (id: number) => lines(prompts).filter((l) => l.startsWith(`${id} `)).length;

/** SIGKILL a running turn's wrapper and claude (an out-of-memory kill of its process group), and wait for the server to see it. */
async function kill(id: number) {
  await until('claude to be up', () => store.listEvents(id).some((e) => e.kind === 'claude') && existsSync(join((runner as any).turns.get(id).dir, 'pid.json')), 10_000);
  const live = (runner as any).turns.get(id);
  const pids = JSON.parse(readFileSync(join(live.dir, 'pid.json'), 'utf8'));
  try {
    process.kill(pids.wrapper, 'SIGKILL');
  } catch {}
  try {
    process.kill(-pids.claude, 'SIGKILL');
  } catch {}
  await until('the server to see the kill', () => (runner as any).turns.get(id) !== live, 10_000);
}

test('one resume per kill, then a second kill in a row stops', () => {
  assert.equal(MAX_KILL_RESUMES, 1, 'Cara: a second kill in a row stops for good');
});

test('a turn whose wrapper is SIGKILLed is resumed by the server, with one chat line, no push, and its queued message', async () => {
  pushes.length = 0;
  const id = minion();
  runner.send(id, 'Cara', 'hang please');
  await until('the turn to start', () => runner.isRunning(id));
  runner.send(id, 'Cara', 'queued behind it');
  await kill(id);
  await until('the resume to finish', () => store.getTicket(id)!.status === 'idle' && !runner.isRunning(id) && promptsOf('was killed').some((l) => l.includes('queued behind it')), 15_000);
  const t = store.getTicket(id)!;
  assert.equal(t.status, 'idle', 'the resume ended well');
  assert.deepEqual(events(id, 'error'), [], 'a kill that was resumed is not an error');
  const killedNotes = events(id, 'note').filter((n) => /killed/i.test(n));
  assert.equal(killedNotes.length, 1, `one chat line about it: ${JSON.stringify(events(id, 'note'))}`);
  assert.match(killedNotes[0], /killed[\s\S]*resum/i);
  assert.equal(pushes.length, 0, 'nobody is pushed for a kill the server absorbed');
  assert.equal(promptsOf('queued behind it').length, 1, 'the queued message rode in the resume, not a turn of its own');
});

test('a second kill in a row stops with the error and one push, and is not resumed again', async () => {
  pushes.length = 0;
  writeFileSync(hangAgain, '');
  try {
    const id = minion();
    runner.send(id, 'Cara', 'hang twice');
    await until('the turn to start', () => runner.isRunning(id));
    await kill(id);
    await until('the resume to start', () => runner.isRunning(id) && turnsOf(id) === 2, 15_000);
    await kill(id);
    await until('the minion to fail', () => store.getTicket(id)!.status === 'error' && !runner.isRunning(id), 10_000);
    // Give a wrong second resume the time it would take to start.
    // timing-ok: waits to show nothing happens (no third turn starts); a slow box only makes it wait longer
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(turnsOf(id), 2, 'the turn and its one resume, no third');
    const errors = events(id, 'error');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^The turn's process was killed before it finished/);
    assert.match(errors[0], /already resumed once after a kill/);
    assert.equal(pushes.filter((p) => p.ticket === id).length, 1, 'one push');
    assert.equal(runner.killWait(id), null);
  } finally {
    rmSync(hangAgain, { force: true });
  }
});

test("a person's Stop is never resumed", async () => {
  const id = minion();
  runner.send(id, 'Cara', 'hang until stopped');
  await until('claude to be up', () => store.listEvents(id).some((e) => e.kind === 'claude'), 10_000);
  runner.stop(id);
  await until('the turn to stop', () => !runner.isRunning(id), 10_000);
  // timing-ok: waits to show nothing happens (a Stop is not resumed); a slow box only makes it wait longer
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(turnsOf(id), 1);
  assert.equal(runner.killWait(id), null);
  assert.equal(store.getTicket(id)!.status, 'idle');
});

test('"claude exited with code 1" is no kill: it waits for a failed turn\'s one retry (#2258), and its error keeps the last lines of its stderr', async () => {
  pushes.length = 0;
  const id = minion();
  runner.send(id, 'Cara', 'crash now');
  await until('the turn to fail', () => store.getTicket(id)!.status === 'error' && !runner.isRunning(id) && !!runner.failWait(id), 10_000);
  assert.equal(runner.killWait(id), null, 'not a kill resume');
  assert.equal(turnsOf(id), 1);
  const errors = events(id, 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /TypeError: something inside claude broke\n {4}at main \(cli\.js:1:1\)\n\(claude exited with code 1\)\nCitadel retries it by itself once/);
  assert.equal(pushes.length, 1);
  assert.equal(runner.stop(id), true, 'a stop ends the wait');
  assert.equal(runner.failWait(id), null);
});

test("the resume runs on the killed turn's person, not the scheme owner or the minion's maker", async () => {
  const id = minion();
  places.length = 0;
  placing = id;
  runner.send(id, 'Josh', 'hang for josh');
  await until('the turn to start', () => runner.isRunning(id));
  await kill(id);
  await until('the resume to finish', () => store.getTicket(id)!.status === 'idle' && !runner.isRunning(id) && turnsOf(id) === 2, 15_000);
  const persons = [...new Set(places.filter((p) => p.ticket === id).map((p) => p.person))];
  assert.deepEqual(persons, [josh.id], "both the turn and its resume ran on Josh's login");
  placing = 0;
});

test('16 turns killed at once resume one at a time, a few seconds apart, and none starts while the box is starved (bounded)', async () => {
  runner = makeRunner();
  runner.resumeGapMs = 120;
  runner.killHoldMaxMs = 600_000; // far off until the test brings it in, so a slow box can't reach it first
  // When the line starts each resume's turn: the fakes' own log lines bunch up on a busy box.
  const startedAt = new Map<number, number>();
  const startTurn = (runner as any).startTurn;
  (runner as any).startTurn = function (...args: any[]) {
    if (args[7]) startedAt.set(args[1].id, Date.now());
    return startTurn.apply(this, args);
  };
  const ids = Array.from({ length: 16 }, () => minion());
  for (const id of ids) runner.send(id, 'Cara', `hang wave ${id}`);
  const up = (id: number) => store.listEvents(id).some((e) => e.kind === 'claude') && existsSync(join((runner as any).turns.get(id).dir, 'pid.json'));
  await until('all 16 claudes to be up', () => ids.every((id) => runner.isRunning(id) && up(id)), 30_000);
  starved = true;
  pressureReads = 0;
  // The Nov 20 shape: every wrapper and claude killed together.
  const pids = ids.map((id) => JSON.parse(readFileSync(join((runner as any).turns.get(id).dir, 'pid.json'), 'utf8')));
  for (const p of pids) {
    try {
      process.kill(p.wrapper, 'SIGKILL');
    } catch {}
    try {
      process.kill(-p.claude, 'SIGKILL');
    } catch {}
  }
  await until('the server to see all 16 kills', () => ids.every((id) => !runner.isRunning(id)), 15_000);
  assert.ok(
    ids.every((id) => runner.killWait(id)),
    'each waits to resume',
  );
  // Starved: nothing starts while the hold lasts, though the pressure is read round after round.
  const readsBefore = pressureReads;
  await until('the pressure to be read several times', () => pressureReads >= readsBefore + 4);
  assert.equal(ids.filter((id) => turnsOf(id) > 1).length, 0, 'none resumed while starved');
  // The bound: one starts, starved or not, once the line has held killHoldMaxMs.
  runner.killHoldMaxMs = 0;
  await until('one resume past the bound', () => ids.some((id) => turnsOf(id) > 1));
  assert.equal(starved, true, 'it started with the box still starved');
  // Pressure falls: the rest go one at a time, a gap apart.
  starved = false;
  await until('all 16 resumes', () => ids.every((id) => turnsOf(id) > 1), 20_000);
  const started = ids.map((id) => startedAt.get(id)!).sort((x, y) => x - y);
  const gaps = started.slice(1).map((t, i) => t - started[i]);
  assert.ok(gaps.filter((g) => g < 60).length <= 1, `resumes a gap apart, not at once: ${gaps.join(', ')}`);
  await until('the resumes to end', () => ids.every((id) => !runner.isRunning(id) && store.getTicket(id)!.status === 'idle'), 20_000);
});

test('a kill wait outlives a restart: the next server resumes it', async () => {
  runner = makeRunner();
  runner.resumeGapMs = 0;
  starved = true;
  runner.killHoldMaxMs = 60_000;
  const id = minion();
  runner.send(id, 'Cara', 'hang across a restart');
  await until('the turn to start', () => runner.isRunning(id));
  await kill(id);
  assert.ok(runner.killWait(id), 'held while starved');
  runner.detachAll();
  starved = false;
  runner = makeRunner();
  runner.resumeGapMs = 0;
  runner.recover();
  await until('the resume to finish', () => turnsOf(id) === 2 && !runner.isRunning(id) && store.getTicket(id)!.status === 'idle', 15_000);
  assert.equal(runner.killWait(id), null);
});

test('a message during the kill wait starts its turn now, which takes the wait', async () => {
  runner = makeRunner();
  runner.resumeGapMs = 0;
  starved = true;
  runner.killHoldMaxMs = 60_000;
  const id = minion();
  runner.send(id, 'Cara', 'hang then a message');
  await until('the turn to start', () => runner.isRunning(id));
  await kill(id);
  assert.ok(runner.killWait(id));
  runner.send(id, 'Cara', 'carry on');
  await until('that turn to finish', () => promptsOf('carry on').length === 1 && !runner.isRunning(id) && store.getTicket(id)!.status === 'idle', 15_000);
  assert.equal(runner.killWait(id), null, 'the wait went with that turn');
  starved = false;
  // timing-ok: waits to show nothing happens (no resume on top of the message's turn); a slow box only makes it wait longer
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(turnsOf(id), 2, "the turn and the message's turn, no resume on top of it");
  runner.detachAll();
});

test("a kill wait's held message counts as queued, and a resume that fails to start errors without stalling the line", async () => {
  runner = makeRunner();
  starved = true;
  runner.killHoldMaxMs = 60_000;
  pushes.length = 0;
  const a = minion();
  const b = minion();
  runner.send(a, 'Cara', 'hang a');
  runner.send(b, 'Cara', 'hang b');
  await until('both turns to start', () => runner.isRunning(a) && runner.isRunning(b));
  runner.send(a, 'Cara', 'held for a');
  await kill(a);
  await kill(b);
  const view = runner.view(store.getTicket(a)!);
  assert.equal(view.queued, 1, 'the held message shows as queued while it waits');
  const refused = (runner as any).refused;
  // Once: a start that always throws would loop on any queued message, the lane's own known case (next()).
  (runner as any).refused = function (id: number, person: number | null) {
    if (id === a) {
      (runner as any).refused = refused;
      throw new Error('boom');
    }
    return refused.call(this, id, person);
  };
  starved = false;
  await until('b to resume and finish', () => turnsOf(b) === 2 && !runner.isRunning(b) && store.getTicket(b)!.status === 'idle', 15_000);
  await until("a's held message to run as its own turn", () => turnsOf(a) === 2 && !runner.isRunning(a) && store.getTicket(a)!.status === 'idle', 15_000);
  assert.equal(runner.killWait(a), null, "a's wait ended");
  assert.match(events(a, 'error').join('\n'), /failed to start[\s\S]*queued behind it run next/);
  assert.equal(pushes.filter((p) => p.ticket === a).length, 1, 'one push for a');
  const second = lines(prompts).filter((l) => l.startsWith(`${a} `))[1];
  assert.match(second, /held for a/);
  assert.doesNotMatch(second, /was killed/, 'not a resume: the message its own turn');
  runner.detachAll();
});
