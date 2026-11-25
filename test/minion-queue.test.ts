import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MinionQueue, migrateQueues, queueKey } from '../src/minion-queue.ts';
import type { QueuedMessage } from '../src/runner.ts';

// The one queue (#1378) over a plain map, the settings table's shape.
function mapStore(init: Record<string, unknown> = {}) {
  const m = new Map<string, string>(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    m,
    getSetting: <T>(k: string) => (m.has(k) ? (JSON.parse(m.get(k)!) as T) : null),
    setSetting: (k: string, v: unknown) => void m.set(k, JSON.stringify(v)),
    deleteSetting: (k: string) => void m.delete(k),
    settingsWithPrefix: <T>(p: string) =>
      [...m.keys()]
        .filter((k) => k.startsWith(p))
        .sort()
        .map((key) => ({ key, value: JSON.parse(m.get(key)!) as T })),
  };
}
const msg = (text: string, id?: number): QueuedMessage => ({ author: 'Cara', text, images: [], ...(id ? { id } : {}) });
const texts = (l: QueuedMessage[] | undefined) => (l ?? []).map((m) => m.text);

test('a taken batch stays in the record until its turn is done; a start that bails gives it back, ahead of what came since', () => {
  const s = mapStore();
  const q = new MinionQueue(s);
  q.put(1, msg('a'));
  q.hold(1, msg('mail'), 5);
  assert.deepEqual(texts(q.take(1)), ['a', 'mail'], 'queued first, then held mail');
  assert.deepEqual(texts(s.getSetting<any>(queueKey(1)).taken), ['a', 'mail'], 'durable while the turn runs');
  assert.equal(s.getSetting<any>(queueKey(1)).coldAt, undefined, 'the cold hold ends with the take');
  q.put(1, msg('b'));
  q.giveBack(1);
  assert.deepEqual(texts(q.msgs(1)), ['a', 'mail', 'b']);
  q.take(1);
  q.giveBack(1, true);
  assert.deepEqual([texts(q.msgs(1)), texts(q.heldMail(1))], [[], ['a', 'mail', 'b']], 'as held mail, it starts no turn');
  q.take(1);
  q.done(1);
  assert.equal(s.m.size, 0, 'an empty record is deleted');
});

test("a resume's take keeps the cut-off turn's batch beside its own, and returns only what is new", () => {
  const q = new MinionQueue(mapStore());
  q.put(1, msg('cut off'));
  q.take(1);
  q.owe(1, { resumes: 1 });
  q.put(1, msg('since'));
  assert.deepEqual(texts(q.take(1)), ['since']);
  assert.deepEqual(texts(q.get(1).taken), ['cut off', 'since']);
  assert.deepEqual(q.owed(1), { resumes: 1 }, 'the debt stays until its turn is saved (launchTurn pays it)');
});

test('steers: the unsent ones join the queue at the turn end; a stop drops queue, steers and debt but keeps held mail', () => {
  const s = mapStore();
  const q = new MinionQueue(s);
  q.steered(1, { end: 10, msg: msg('sent') });
  q.steered(1, { end: 20, msg: msg('late') });
  q.endSteers(1, [msg('late')]);
  assert.deepEqual([texts(q.msgs(1)), q.steers(1)], [['late'], []]);
  q.hold(1, msg('parked'));
  q.owe(1, { resumes: 2 });
  q.steered(1, { end: 30, msg: msg('x') });
  assert.deepEqual(texts(q.drop(1)), ['late']);
  assert.deepEqual(q.get(1), { held: [msg('parked')] });
});

test('remove takes back one queued message; refuse drops the queue but keeps held mail; clear empties all and says what was left', () => {
  const s = mapStore();
  const q = new MinionQueue(s);
  q.put(1, msg('a', 11));
  q.put(1, msg('b', 12));
  assert.equal(q.remove(1, 11), true);
  assert.equal(q.remove(1, 11), false);
  q.hold(1, msg('old mail'));
  q.put(1, msg('c'));
  assert.deepEqual(texts(q.clear(1, true)), ['b', 'c'], "a boot keeps a closed minion's held mail");
  assert.deepEqual(q.get(1), { held: [msg('old mail')] });
  q.put(1, msg('d'));
  q.refuse(1);
  assert.deepEqual([texts(q.msgs(1)), texts(q.heldMail(1))], [[], ['old mail']]);
  assert.deepEqual(texts(q.clear(1)), ['old mail']);
  assert.equal(s.m.size, 0);
});

test("held mail: the cold clock runs from the first one, a release puts it behind what is queued, a disabled person's goes with its clock", () => {
  const s = mapStore();
  const q = new MinionQueue(s);
  q.hold(1, msg('first mail'), 5);
  q.hold(1, msg('second mail'), 9);
  assert.equal(q.get(1).coldAt, 5, 'later mail never puts the cap off');
  q.put(1, msg('queued'));
  assert.equal(q.release(1), 2);
  assert.deepEqual(q.get(1), { msgs: [msg('queued'), msg('first mail'), msg('second mail')] });
  q.take(1);
  q.done(1);
  q.put(1, { ...msg('theirs'), author: 'Gone' });
  q.hold(1, { ...msg('their mail'), author: 'Gone' }, 5);
  assert.deepEqual(texts(q.dropWhere(1, (m) => m.author === 'Gone')), ['theirs', 'their mail']);
  assert.equal(s.m.size, 0, 'nothing of theirs is left to run later, nor a clock for mail that is gone');
});

test('migration folds every old store into one record each, keeps each message once, and leaves the rest of the rows alone', () => {
  const late = { end: 9, msg: msg('steered') };
  const s = mapStore({
    'waiting:1': [msg('q1', 1), msg('q2', 2)],
    'resume-owed:1': { resumes: 1, killTries: 1, queued: [msg('q1', 1), msg('q2', 2)] },
    'mail:1': [msg('mail', 3)],
    'cold:1': 77,
    'turn:2': { resumes: 0, dir: '/x', queued: [msg('t', 4)], steered: [late] },
    'turn:3': { resumes: 0, dir: '/y' },
    'net-resumes': [{ ticket: 2, tries: 1, queued: [msg('net', 5)] }],
    'limit-resumes': [
      { ticket: 4, at: 1, tries: 1, queued: [msg('limit', 6)] },
      { ticket: 5, at: 1, tries: 1 },
    ],
    'mail:7': [msg('closed minion', 7)],
    'context:1': 1000,
  });
  assert.equal(migrateQueues(s), 4);
  assert.deepEqual(s.getSetting(queueKey(1)), { msgs: [msg('q1', 1), msg('q2', 2)], held: [msg('mail', 3)], coldAt: 77, owed: { resumes: 1, killTries: 1 } });
  assert.deepEqual(s.getSetting(queueKey(2)), { msgs: [msg('net', 5), msg('t', 4)], steered: [late] }, "a network wait's messages had left the queue: they go first");
  assert.deepEqual(s.getSetting(queueKey(4)), { msgs: [msg('limit', 6)] });
  assert.deepEqual(s.getSetting(queueKey(7)), { held: [msg('closed minion', 7)] });
  assert.deepEqual(s.getSetting('turn:2'), { resumes: 0, dir: '/x' });
  assert.deepEqual(s.getSetting('turn:3'), { resumes: 0, dir: '/y' }, 'untouched');
  assert.deepEqual(s.getSetting('net-resumes'), [{ ticket: 2, tries: 1 }]);
  assert.deepEqual(s.getSetting('limit-resumes'), [
    { ticket: 4, at: 1, tries: 1 },
    { ticket: 5, at: 1, tries: 1 },
  ]);
  for (const k of ['waiting:1', 'resume-owed:1', 'mail:1', 'cold:1', 'mail:7']) assert.equal(s.getSetting(k), null, k);
  assert.equal(s.getSetting('context:1'), 1000);
  const after = JSON.stringify([...s.m]);
  assert.equal(migrateQueues(s), 0, 'the second boot finds nothing to move');
  assert.equal(JSON.stringify([...s.m]), after);
});

test('a migration cut off after its new rows were written runs again without doubling a message', () => {
  const s = mapStore({ 'waiting:1': [msg('a', 1)], 'mail:1': [msg('m', 2)] });
  const del = s.deleteSetting;
  s.deleteSetting = () => {
    throw new Error('cut');
  };
  assert.throws(() => migrateQueues(s));
  s.deleteSetting = del;
  migrateQueues(s);
  assert.deepEqual(s.getSetting(queueKey(1)), { msgs: [msg('a', 1)], held: [msg('m', 2)] });
  assert.equal(s.m.size, 1);
});
