import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { LastGreen, type Contains } from '../src/last-green.ts';
import type { TargetView } from '../src/releases.ts';
import { Rollback } from '../src/rollback.ts';

// src/rollback.ts (#1016): the Releases card's Roll back to last green. Offered only while what runs is newer than
// last green; pressing it starts the kind's deploy of last green and pins the target; a deploy that didn't go live
// lets go of the pin and says why.
const root = mkdtempSync(join(tmpdir(), 'rollback-'));
after(() => rmSync(root, { recursive: true, force: true }));
let dbs = 0;

const sha = (c: string) => c.repeat(40);
const A = sha('a'), B = sha('b'), X = sha('e');
const order = [A, B];
const contains: Contains = async (_dir, ancestor, commit) => order.includes(ancestor) && order.includes(commit) && order.indexOf(ancestor) <= order.indexOf(commit);

function world(kind = 'contraption', follows?: (t: Omit<TargetView, 'testCopies'>) => string | null) {
  const store = new Store(join(root, `t-${++dbs}.db`));
  const lastGreen = new LastGreen(store, contains);
  const started: string[] = [];
  const told: string[] = [];
  let changed = 0;
  let refuse: string | null = null;
  const rb = new Rollback({
    lastGreen, repoDir: () => '/repo', contains, follows,
    starters: {
      [kind]: (t, to, by) => {
        if (refuse) throw new Error(refuse);
        started.push(`${t.target.id} to ${to.slice(0, 1)} by ${by}`);
      },
    },
    running: () => false, tell: (_p, text) => told.push(text), changed: () => changed++,
    get: (k) => store.getSetting(k) ?? undefined, set: (k, v) => store.setSetting(k, v),
  });
  const tv = (current: string | null): Omit<TargetView, 'testCopies'> => ({
    target: { id: 'app:peek', projectId: 3, name: 'Peek', kind, link: null },
    current: current ? { version: current, number: 2, link: null, changes: [], started: null, live: null, outcome: 'live', stages: {} } : null,
    next: null, line: [], recent: [],
  });
  return { store, lastGreen, rb, started, told, tv, changed: () => changed, refuse: (r: string | null) => (refuse = r) };
}

test('the button shows only once git says what runs is newer than last green', async () => {
  const w = world();
  assert.equal(w.rb.info(w.tv(B)), null, 'no last green yet');
  w.store.setSetting('last-green:3', { sha: A, at: 1 });
  assert.equal(w.rb.info(w.tv(B))?.can, false, 'git has not answered yet');
  await new Promise((r) => setImmediate(r));
  assert.equal(w.changed(), 1, 'its answer reads the cards again');
  assert.deepEqual(w.rb.info(w.tv(B)), { sha: A, can: true, pin: null, running: false, failed: null });
  assert.equal(w.rb.info(w.tv(A))?.can, false, 'it runs last green');
  w.rb.info(w.tv(X));
  await new Promise((r) => setImmediate(r));
  assert.equal(w.rb.info(w.tv(X))?.can, false, 'what runs is off main');
  assert.equal(world('ci').rb.info(w.tv(B)), null, 'a kind with no starter');
});

test('pressing it deploys last green, pins the target and tells the Taskmaster; a refused start leaves no pin', async () => {
  const w = world();
  w.store.setSetting('last-green:3', { sha: A, at: 1 });
  await assert.rejects(w.rb.rollBack(w.tv(A), 'Cara', 1), /isn't newer than last green/);
  w.refuse('its migrations changed');
  await assert.rejects(w.rb.rollBack(w.tv(B), 'Cara', 1), /its migrations changed/);
  assert.equal(w.lastGreen.pinned(3, 'app:peek'), null);
  w.refuse(null);
  assert.equal(await w.rb.rollBack(w.tv(B), 'Cara', 1), A);
  assert.deepEqual(w.started, ['app:peek to a by Cara']);
  assert.deepEqual({ ...w.lastGreen.pinned(3, 'app:peek'), at: 0 }, { sha: A, from: B, by: 'Cara', at: 0 });
  assert.match(w.told[0], /^Cara rolled Peek back to last green aaaaaaaaa from bbbbbbbbb/);
});

test("a roll back that didn't go live lets go of its pin and shows why, until the next one", async () => {
  const w = world();
  w.store.setSetting('last-green:3', { sha: A, at: 1 });
  await w.rb.rollBack(w.tv(B), 'Cara', 1);
  w.rb.failed(3, 'app:peek', B, 'not this one'); // a deploy of another commit
  assert.ok(w.lastGreen.pinned(3, 'app:peek'));
  w.rb.failed(3, 'app:peek', A, 'its health check failed');
  assert.equal(w.lastGreen.pinned(3, 'app:peek'), null);
  assert.equal(w.rb.info(w.tv(B))?.failed?.why, 'its health check failed');
  assert.match(w.told.at(-1)!, /didn't go live, so it runs bbbbbbbbb as before: its health check failed/);
  await w.rb.rollBack(w.tv(B), 'Cara', 1);
  assert.equal(w.rb.info(w.tv(B))?.failed, null);
});

test('a deploy of anything else (the fix, a person\'s Deploy) ends the pin', async () => {
  const w = world();
  w.store.setSetting('last-green:3', { sha: A, at: 1 });
  await w.rb.rollBack(w.tv(B), 'Cara', 1);
  assert.ok(w.rb.info(w.tv(A))?.pin, 'it runs last green: pinned');
  assert.ok(w.rb.info(w.tv(B))?.pin, 'back where it was, until failed() says why: still pinned');
  assert.equal(w.rb.info(w.tv(X))?.pin, null, 'it runs a third commit');
  assert.equal(w.lastGreen.pinned(3, 'app:peek'), null);
});

test('an app\'s roll back refused before it picked a commit (its migrations changed) lets go of its pin too', async () => {
  const w = world();
  w.store.setSetting('last-green:3', { sha: A, at: 1 });
  await w.rb.rollBack(w.tv(B), 'Cara', 1);
  w.rb.deployEnded(3, 'app:peek', true, A, 'Deployed');
  assert.ok(w.lastGreen.pinned(3, 'app:peek'), 'it went live: pinned');
  w.rb.deployEnded(3, 'app:peek', false, null, 'Failed: Its migrations changed since aaaaaaa');
  assert.equal(w.lastGreen.pinned(3, 'app:peek'), null);
  assert.match(w.rb.info(w.tv(B))?.failed?.why ?? '', /migrations changed/);
});

test("an APK Citadel builds after each deploy rolls back with its app: its card's button is the app's, pin and all", async () => {
  const w = world('contraption', (t) => (t.target.kind === 'apk' ? 'app:peek' : null));
  w.store.setSetting('last-green:3', { sha: A, at: 1 });
  const apk: Omit<TargetView, 'testCopies'> = { ...w.tv(null), target: { id: 'apk:peek', projectId: 3, name: 'Android', kind: 'apk', link: null }, current: { ...w.tv(B).current!, version: '1.0' } };
  const views = [w.tv(B), apk];
  assert.equal(w.rb.info(apk), null, 'without its app beside it, no button');
  w.rb.info(apk, views);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(w.rb.info(apk, views), { sha: A, can: true, pin: null, running: false, failed: null }, 'the app runs B, so it can');
  await assert.rejects(w.rb.rollBack(apk, 'Cara', 1), /rolls back with its app/);
  assert.equal(await w.rb.rollBack(apk, 'Cara', 1, views), A);
  assert.deepEqual(w.started, ['app:peek to a by Cara'], "the app's deploy, nothing of its own");
  assert.equal(w.lastGreen.pinned(3, 'app:peek')?.sha, A);
  assert.equal(w.lastGreen.pinned(3, 'apk:peek'), null, 'one pin, the app\'s');
  assert.match(w.told[0], /rolled Peek back to last green aaaaaaaaa from bbbbbbbbb .*from its Android card: its APK build follows the app/);
  assert.equal(w.rb.info(apk, [w.tv(A), apk])?.pin?.sha, A, 'its card shows the app\'s pin');
});
