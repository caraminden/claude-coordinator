import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { releaseFake, stopTurns, tempRoot, testPins, until } from './helpers.ts';
testPins();

// #306 (d7a8c26e): a turn gets the machines of its one asker, not of every sender in its batch: a message
// that rides along in a turn someone else asked for must not bring its sender's own machines.
const tmp = tempRoot('own-machines-replay-');
after(async () => {
  await stopTurns(tmp.dir);
  await tmp.teardown();
});
const { fake, setRelease, turnsRun } = releaseFake(tmp.dir);
const store = new Store(join(tmp.dir, 'test.db'));
const project = store.createProject('Test', null);
const [eve, josh, dana] = ['Eve', 'Josh', 'Dana'].map((name) => store.createUser({ name, login: name.toLowerCase() }));
for (const u of [eve, josh, dana]) store.addMember(project.id, u.id);

test("a batch with Josh asking and Dana's ride-along message gets Josh's machines only", async () => {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Eve' });
  const cwd = join(tmp.dir, 'wt');
  mkdirSync(cwd);
  store.setTicketDir(t.id, cwd, null);
  const asked: number[][] = [];
  const r = new Runner(
    store,
    () => {},
    () => ({ COORDINATOR_TOKEN: 'secret' }),
    fake,
  );
  r.pollMs = 10;
  r.personOf = (author) => [eve, josh, dana].find((u) => u.name === author)?.id ?? null;
  r.machines = (_project, askers) => (asked.push(askers), []);
  setRelease(null);
  r.send(t.id, 'Eve', 'first');
  await until('the first turn to start', () => asked.length === 1);
  // Held behind Eve's turn, both wait for the next one, which answers them together.
  r.send(t.id, 'Josh', 'from josh');
  r.send(t.id, 'Dana', 'from dana');
  setRelease('ok');
  await until('the second turn to start', () => asked.length === 2);
  // turnsRun counts prompts, written as a turn starts: wait for the Runner to wrap the second one up too, or it writes
  // into the temp folder after teardown (#1763).
  await until('both turns to end', () => turnsRun() === 2 && !r.isRunning(t.id) && store.getTicket(t.id)!.status !== 'running');
  assert.deepEqual(asked[0], [eve.id]);
  assert.deepEqual(asked[1], [josh.id], "one asker's machines, not Dana's with them");
});
