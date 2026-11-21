import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Store } from '../src/db.ts';
import { Lanes } from '../src/lanes.ts';
import { Runner } from '../src/runner.ts';
import { projectSlug, saveSession } from '../src/sessions.ts';
import { lines, tempRoot, testPins } from './helpers.ts';
import { until } from './wait.ts';
testPins();

// #259: every step of a minion's turn lifecycle runs on one serial lane per minion, and cleanups
// delete only what they can show is stale. Each test holds one step open and starts the next, as #250
// did. The fake `claude -p` keeps its transcript under CLAUDE_CONFIG_DIR like the real one, waits for
// the `go` file before it answers, deletes the config-dir file named in `rm` if there is one, and ends
// with the `result` file's words (an error unless "ok").
const tmp = tempRoot('minion-lane-');
const root = tmp.dir;
after(() => tmp.teardown()); // ends the detached turns before deleting their folders (#271)
const config = join(root, 'claude');
process.env.CLAUDE_CONFIG_DIR = config;
const go = join(root, 'go');
const result = join(root, 'result');
const rm = join(root, 'rm');
const prompts = join(root, 'prompts.log');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const at = args.indexOf('--resume');
const id = at >= 0 ? args[at + 1] : 'sess-' + process.pid;
let input = '';
process.stdin.on('data', (d) => (input += d));
const wait = setInterval(() => {
  if (!input.includes('\\n') || !existsSync(${JSON.stringify(go)})) return;
  clearInterval(wait);
  appendFileSync(${JSON.stringify(prompts)}, input);
  const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, id + '.jsonl'), JSON.stringify({ turn: Date.now() }) + '\\n');
  if (existsSync(${JSON.stringify(rm)})) rmSync(join(process.env.CLAUDE_CONFIG_DIR, readFileSync(${JSON.stringify(rm)}, 'utf8')), { force: true });
  const words = existsSync(${JSON.stringify(result)}) ? readFileSync(${JSON.stringify(result)}, 'utf8') : 'ok';
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: words !== 'ok', result: words, session_id: id }));
  process.exit(0);
}, 10);
`,
);
chmodSync(fake, 0o755);

const data = join(root, 'data');
mkdirSync(data);
const store = new Store(join(data, 'test.db'));
const repo = join(root, 'repo');
mkdirSync(repo);
const project = store.createProject('Test', null);
store.setProjectRepoDir(project.id, repo);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const turnsRun = () => lines(prompts).length;

/** A gate a test opens by hand: `wait` resolves once `open()` is called. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

function makeRunner() {
  const r = new Runner(store, () => {}, () => ({}), fake);
  r.pollMs = 10;
  r.resumeGapMs = 10;
  r.limitDelayMs = 0;
  r.limitGapMs = 0;
  r.limitProvenGapMs = 0;
  return r;
}

/** A runner whose end-of-turn session saves wait for `held` before they start. */
function heldSaves(r: Runner) {
  const held = gate();
  let saves = 0;
  r.saveSession = async (...args) => {
    saves++;
    await held.wait;
    return saveSession(...args);
  };
  return { ...held, saves: () => saves };
}

let n = 0;
function minion() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const cwd = join(root, `wt-${++n}`);
  mkdirSync(cwd);
  store.setTicketDir(t.id, cwd, null);
  return { id: t.id, cwd };
}

function reset() {
  for (const f of [go, result, rm, prompts]) rmSync(f, { force: true });
}

test('a lane runs one step at a time per minion, different minions side by side, and a step on an idle lane starts at once', async () => {
  const lanes = new Lanes();
  const log: string[] = [];
  const first = gate();
  const idle: number[] = [];
  lanes.onIdle = (id) => idle.push(id);
  lanes.run(1, 'first', async () => {
    log.push('1a start');
    await first.wait;
    log.push('1a end');
  });
  assert.deepEqual(log, ['1a start'], 'an idle lane starts its step before run() returns');
  lanes.run(1, 'second', () => void log.push('1b'));
  lanes.run(2, 'other', () => void log.push('2a'));
  assert.deepEqual(log, ['1a start', '2a'], "another minion's lane doesn't wait");
  assert.ok(lanes.busy(1));
  await sleep(10);
  assert.deepEqual(log, ['1a start', '2a'], 'the second step waits for the first');
  first.open();
  await until('lane 1 to drain', () => !lanes.busy(1));
  assert.deepEqual(log, ['1a start', '2a', '1a end', '1b']);
  assert.deepEqual(idle.sort(), [1, 2], 'each lane says once when it has drained');
  // A step that throws doesn't stall the lane.
  lanes.run(3, 'broken', async () => {
    throw new Error('boom');
  });
  lanes.run(3, 'after', () => void log.push('3b'));
  await until('lane 3 to drain', () => !lanes.busy(3));
  assert.equal(log.at(-1), '3b');
});

test('a step that runs another step on its idle lane at once keeps the lane busy until both have ended (#1464)', async () => {
  const lanes = new Lanes();
  const idle: number[] = [];
  lanes.onIdle = (id) => idle.push(id);
  const inner = gate();
  const log: string[] = [];
  // As the outbox does: its step on the minion's lane sends a message, and the send starts the turn's step at once.
  await lanes.run(1, 'outer', () => void lanes.run(1, 'inner', async () => {
    log.push('inner start');
    await inner.wait;
    log.push('inner end');
  }));
  assert.deepEqual(log, ['inner start']);
  assert.ok(lanes.busy(1), 'the inner step still holds the lane after the outer one ends');
  assert.deepEqual(idle, [], 'the lane is not idle while the inner step runs');
  lanes.run(1, 'later', () => void log.push('later'));
  assert.deepEqual(log, ['inner start'], 'a later step waits for the inner one');
  inner.open();
  await until('lane 1 to drain', () => !lanes.busy(1));
  assert.deepEqual(log, ['inner start', 'inner end', 'later']);
  assert.deepEqual(idle, [1], 'the lane says once that it has drained');
});

const turnDirs = (r: Runner, id: number) => readdirSync(r.turnsDir).filter((n) => n.startsWith(`${id}-`));

test("a turn started from inside another lane step (the outbox's) holds the lane, so the outbox's retry can't start a second turn beside it (#1464)", async () => {
  reset();
  const r = makeRunner();
  const { id } = minion();
  // #1284, Nov 20: the outbox's wake started a turn from its step on the minion's lane, the step ended, and the lane
  // went idle with the turn still running; the wake's retry six minutes later started a second turn on the session.
  await r.onLane(id, 'outbox', () => void r.send(id, 'System', 'wake one'));
  assert.ok(r.isRunning(id), 'the wake starts a turn');
  let retriedBeside: boolean | null = null;
  const retry = r.onLane(id, 'outbox', () => {
    retriedBeside = r.isRunning(id);
    r.send(id, 'System', 'wake two');
  });
  assert.equal(retriedBeside, null, "the retry's step waits behind the live turn");
  assert.equal(turnDirs(r, id).length, 1, 'one turn runs');
  writeFileSync(go, '');
  await retry;
  assert.equal(retriedBeside, false, "the retry's step ran once the first turn had ended");
  await until('both wakes to have run, one turn after the other', () => turnsRun() === 2 && !r.isRunning(id) && !(r as any).lanes.busy(id));
  const [first, second] = lines(prompts);
  assert.match(first, /wake one/);
  assert.doesNotMatch(first, /wake two/);
  assert.match(second, /wake two/);
});

test("a minion whose turn still runs unfollowed (its wrapper is alive in its folder) starts no second turn until that one ends (#1464)", async () => {
  reset();
  const r = makeRunner();
  r.strayPollMs = 20;
  const { id } = minion();
  // A turn this server doesn't follow, as #1284's first turn after the second replaced it: its wrapper's arguments name its folder.
  const dir = join(r.turnsDir, `${id}-1`);
  mkdirSync(dir, { recursive: true });
  const stray = tmp.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', dir], { stdio: 'ignore' });
  writeFileSync(join(dir, 'pid.json'), JSON.stringify({ wrapper: stray.pid }));
  writeFileSync(go, '');
  try {
    r.send(id, 'Cara', 'hello');
    assert.equal(r.isRunning(id), false, 'no turn starts beside the live one');
    // Its wrapper may never exit: the lane stays free for a dismissal or a sweep, and still no turn starts.
    await until('the lane to be free again', () => !(r as any).lanes.busy(id));
    assert.equal(r.isRunning(id), false, 'still no turn beside the live one');
    assert.deepEqual(turnDirs(r, id), [`${id}-1`]);
  } finally {
    stray.kill();
  }
  await until('the message to run once the stray turn has ended', () => turnsRun() === 1 && !r.isRunning(id));
  assert.match(lines(prompts)[0], /hello/);
});

test("a usage-limit resume that comes due while the last turn's session is still saving waits for the save", async () => {
  reset();
  const r = makeRunner();
  r.limitFallbackMs = 30; // the words give no time: it comes due almost at once
  const save = heldSaves(r);
  const { id } = minion();
  writeFileSync(result, "You've hit your session limit");
  writeFileSync(go, '');
  r.send(id, 'Cara', 'go');
  await until('the limited turn to end and start saving', () => save.saves() === 1);
  assert.equal(store.getTicket(id)!.state, 'limited');
  writeFileSync(result, 'ok');
  await sleep(200);
  assert.equal(turnsRun(), 1, 'no resume while the save is still under way');
  assert.equal(r.isRunning(id), false);
  save.open();
  await until('the resume to run once the save is in', () => turnsRun() === 2 && !r.isRunning(id));
  assert.match(lines(prompts).join('\n'), /usage limit, which has now reset/);
});

test("the boot sweep's session save holds the minion's next turn until it is done", async () => {
  reset();
  const r = makeRunner();
  const { id, cwd } = minion();
  const held = gate();
  r.saveSession = async (...args) => {
    await held.wait;
    return saveSession(...args);
  };
  store.updateTicket(id, { session_id: 'swept' });
  mkdirSync(join(config, 'projects', projectSlug(cwd)), { recursive: true });
  writeFileSync(join(config, 'projects', projectSlug(cwd), 'swept.jsonl'), '{}\n');
  const swept = r.saveIdleSession(id, config);
  assert.ok(swept, 'an idle minion is swept');
  writeFileSync(go, '');
  r.send(id, 'Cara', 'hello');
  assert.equal(r.isRunning(id), false, 'the turn waits for the sweep');
  held.open();
  await swept;
  await until('the turn to run after the sweep', () => turnsRun() === 1 && !r.isRunning(id));
});

test("an older copy of a session file never replaces the database's newer one (the boot sweep on a stale login)", async () => {
  const { id, cwd } = minion();
  store.updateTicket(id, { session_id: 'fork' });
  const path = join('projects', projectSlug(cwd), 'fork.jsonl');
  // Josh's container turns wrote the newer transcript to the database; the host's login still has an old one.
  const newer = 'turn 1\nturn 2 (Josh)\n';
  store.putClaudeState({ path, project_id: project.id, ticket_id: id, size: newer.length, mtime: Date.now(), data: gzipSync(newer) });
  const hostDir = join(root, 'stale-host');
  mkdirSync(join(hostDir, 'projects', projectSlug(cwd)), { recursive: true });
  writeFileSync(join(hostDir, path), 'turn 1\n');
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(hostDir, path), old, old);
  await saveSession(store, store.getTicket(id)!, store.getProject(project.id)!, hostDir, null);
  assert.equal(gunzipSync(store.getClaudeState(path, true)!.data!).toString(), newer);
});

test("a memory note another login saved during this turn isn't pruned by this turn's save; one the turn deleted is", async () => {
  reset();
  const r = makeRunner();
  const { id } = minion();
  const memory = join('projects', projectSlug(repo), 'memory');
  const put = (name: string, text: string) => store.putClaudeState({ path: join(memory, name), project_id: project.id, ticket_id: null, size: text.length, mtime: Date.now(), data: gzipSync(text) });
  put('old.md', 'restored at the turn start, then deleted by it');
  writeFileSync(rm, join(memory, 'old.md'));
  r.send(id, 'Cara', 'go');
  await until('the turn to start', () => r.isRunning(id));
  assert.ok(existsSync(join(config, memory, 'old.md')), 'restored before the turn');
  // Another minion, on another person's Claude login, saves a new note while this turn runs.
  put('theirs.md', 'from another login');
  writeFileSync(go, '');
  await until('the turn to end', () => !r.isRunning(id));
  await until('the note this turn deleted to be pruned', () => !store.getClaudeState(join(memory, 'old.md')));
  assert.ok(store.getClaudeState(join(memory, 'theirs.md')), "the other login's note is kept: this config dir never had it");
});

for (const when of ['during the turn', 'during the save']) {
  test(`a restart during the end-of-turn save redoes the save at boot, and a message sent ${when} still runs`, async () => {
    reset();
    const r1 = makeRunner();
    const save = heldSaves(r1);
    const { id, cwd } = minion();
    r1.send(id, 'Cara', 'one');
    // The turn may first restore the earlier test's memory note off the event loop (#612): a message sent then rides along.
    await until('the turn to start', () => r1.isRunning(id));
    if (when === 'during the turn') r1.send(id, 'Cara', `two, ${when}`);
    writeFileSync(go, '');
    await until('the turn to end and start saving', () => save.saves() === 1);
    const session = store.getTicket(id)!.session_id!;
    if (when === 'during the save') r1.send(id, 'Cara', `two, ${when}`);
    assert.equal(r1.isRunning(id), false, 'waits for the save');
    // The server restarts before the save finishes.
    r1.detachAll();
    const r2 = makeRunner();
    r2.recover();
    await until('the queued message to run after the restart', () => turnsRun() === 2 && !r2.isRunning(id));
    assert.match(lines(prompts).at(-1)!, new RegExp(`two, ${when}`));
    assert.ok(store.getClaudeState(join('projects', projectSlug(cwd), `${session}.jsonl`)), 'the save was redone');
  });
}

test("a dismissal's cleanup waits for the last turn's save, and a turn's end that throws still frees the lane", async () => {
  reset();
  const r = makeRunner();
  const save = heldSaves(r);
  const { id } = minion();
  writeFileSync(go, '');
  r.send(id, 'Cara', 'one');
  await until('the turn to end and start saving', () => save.saves() === 1);
  const tmp = join(r.tmpRoot(project.id), String(id));
  assert.ok(existsSync(tmp));
  const closed = r.close(id, 'Dismissed.');
  await sleep(50);
  assert.ok(existsSync(tmp), 'the temp folder stays until the save is in');
  save.open();
  await closed;
  assert.ok(!existsSync(tmp));
  // Something after the turn's exit fails (a callback, a store write): the next message still runs.
  let thrown = false;
  r.onTurnEnd = () => {
    if (thrown) return;
    thrown = true;
    throw new Error('onTurnEnd broke');
  };
  r.send(id, 'Cara', 'two');
  await until('the turn whose end throws to end', () => thrown && !r.isRunning(id));
  r.send(id, 'Cara', 'three');
  await until('the next message to run', () => turnsRun() === 3 && !r.isRunning(id));
});

test("a restart's sweep keeps a turn folder whose wrapper hasn't started yet, and removes one that never will", () => {
  const r = makeRunner();
  const starting = join(r.turnsDir, '999-1');
  const dead = join(r.turnsDir, '999-2');
  for (const d of [starting, dead]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'spec.json'), '{}');
  }
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(dead, old, old);
  r.recover();
  assert.ok(existsSync(starting), 'no pid.json yet is no proof it is gone');
  assert.ok(!existsSync(dead));
});

test("a restart's sweep removes only turn folders, never a running Codex review's or anything else it didn't make (C5)", () => {
  const r = makeRunner();
  const person = join(r.turnsDir, 'person-3');
  // codex-review.ts makes review-* beside a person's turn folders; it has no pid.json and its mtime stops moving.
  const review = join(person, 'review-Ab12Cd');
  const ultra = join(person, 'ultrareview-9');
  const other = join(r.turnsDir, 'not-a-turn');
  const dead = join(person, '999-3');
  const old = new Date(Date.now() - 5 * 60_000);
  for (const d of [review, ultra, other, dead]) {
    mkdirSync(d, { recursive: true });
    utimesSync(d, old, old);
  }
  r.recover();
  assert.ok(existsSync(review), 'a Codex review may still be running');
  assert.ok(existsSync(ultra));
  assert.ok(existsSync(other));
  assert.ok(!existsSync(dead), "a container turn's dead folder still goes");
});
