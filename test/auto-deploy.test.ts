import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AUTO_BY, AutoDeploy, QUIET_MS } from '../src/auto-deploy.ts';
import { Store } from '../src/db.ts';
import { LastGreen } from '../src/last-green.ts';
import type { Found } from '../src/release-targets.ts';
import type { SchemeReleases, TargetView } from '../src/releases.ts';

// src/auto-deploy.ts (#629): a target deploys by itself once its main has sat still for QUIET_MS, once per commit,
// unless its scheme turned that off; the card's Deploy button deploys it at once.
const root = mkdtempSync(join(tmpdir(), 'auto-deploy-'));
after(() => rmSync(root, { recursive: true, force: true }));
let dbs = 0;

function world() {
  const store = new Store(join(root, `t-${++dbs}.db`));
  let now = 1_800_000_000_000;
  const app: Found = { projectId: 3, id: 'app:peek', kind: 'contraption', name: 'App', link: '/apps/peek/', branch: 'main', contraption: 'peek' };
  const ci: Found = { projectId: 3, id: 'ci:windows:release', kind: 'ci', name: 'Windows', link: null, branch: 'main', workflow: 'w.yml', job: 'release' };
  let head = 'aaa';
  let waits = true;
  const started: string[] = [];
  const failed: string[] = [];
  let refuse: string | null = null;
  const tv = (t: Found): Omit<TargetView, 'testCopies'> => ({ target: { id: t.id, projectId: t.projectId, name: t.name, kind: t.kind, link: t.link }, current: null, next: null, line: [], recent: [] });
  const view = (): SchemeReleases[] => [{ projectId: 3, targets: [app, ci].map((t) => ({ ...tv(t), testCopies: [] })), testCopies: [] }];
  const held = new LastGreen(store);
  const auto = new AutoDeploy({
    store, targets: () => [app, ci], view, now: () => now, held,
    failed: (t, why) => failed.push(`${t.id}: ${why}`),
    deployers: {
      contraption: {
        waits: () => waits,
        head: async () => head,
        start: (t, by) => {
          if (refuse) throw new Error(refuse);
          started.push(`${t.id} by ${by} at ${head}`);
        },
      },
    },
  });
  return {
    auto, started, failed, held, app: tv(app), ci: tv(ci),
    set: (o: { head?: string; waits?: boolean; refuse?: string | null }) => {
      if (o.head !== undefined) head = o.head;
      if (o.waits !== undefined) waits = o.waits;
      if (o.refuse !== undefined) refuse = o.refuse;
    },
    pass: (ms: number) => (now += ms),
    now: () => now,
  };
}

test('a waiting target deploys once main has been still for QUIET_MS, and a landing meanwhile restarts the wait', async () => {
  const w = world();
  await w.auto.tick();
  assert.deepEqual(w.started, []);
  assert.equal(w.auto.info(w.app)?.due, w.now() + QUIET_MS, 'the card says when');
  w.pass(QUIET_MS - 1000);
  w.set({ head: 'bbb' }); // another landing: the burst goes out as one deploy
  await w.auto.tick();
  w.pass(QUIET_MS - 1000);
  await w.auto.tick();
  assert.deepEqual(w.started, []);
  w.pass(1000);
  await w.auto.tick();
  assert.deepEqual(w.started, [`app:peek by ${AUTO_BY} at bbb`]);
  assert.equal(w.auto.info(w.app)?.due, null, 'tried at this commit: no longer due');
});

test('a commit is tried once: a deploy that rolled back waits for main to move', async () => {
  const w = world();
  await w.auto.tick();
  w.pass(QUIET_MS);
  await w.auto.tick();
  w.pass(QUIET_MS);
  await w.auto.tick();
  assert.equal(w.started.length, 1, 'still waiting at the same commit, so not again');
  w.set({ head: 'ccc' });
  await w.auto.tick();
  w.pass(QUIET_MS);
  await w.auto.tick();
  assert.deepEqual(w.started.at(-1), `app:peek by ${AUTO_BY} at ccc`);
});

test('turned off, it waits for the button; the button deploys at once and counts as the commit\'s try', async () => {
  const w = world();
  assert.equal(w.auto.setOn(3, 'app:peek', false), true);
  assert.equal(w.auto.isOn(3, 'app:peek'), false);
  await w.auto.tick();
  w.pass(QUIET_MS * 3);
  await w.auto.tick();
  assert.deepEqual(w.started, []);
  assert.deepEqual(w.auto.info(w.app), { can: true, auto: false, due: null });
  await w.auto.deployNow(3, 'app:peek', 'Cara', 1);
  assert.deepEqual(w.started, ['app:peek by Cara at aaa']);
  w.auto.setOn(3, 'app:peek', true);
  await w.auto.tick();
  w.pass(QUIET_MS);
  await w.auto.tick();
  assert.equal(w.started.length, 1, 'the person\'s deploy was this commit\'s try');
});

test('nothing waiting, nothing due; a kind with no release step has no button or switch', async () => {
  const w = world();
  w.set({ waits: false });
  await w.auto.tick();
  w.pass(QUIET_MS);
  await w.auto.tick();
  assert.deepEqual(w.started, []);
  assert.deepEqual(w.auto.info(w.app), { can: false, auto: true, due: null });
  assert.equal(w.auto.info(w.ci), null);
  assert.equal(w.auto.setOn(3, 'ci:windows:release', false), false);
  await assert.rejects(w.auto.deployNow(3, 'ci:windows:release', 'Cara', 1), /no release step/);
});

test('an auto-deploy that can\'t start is told, and not retried at that commit', async () => {
  const w = world();
  w.set({ refuse: 'peek is being installed or deployed already' });
  await w.auto.tick();
  w.pass(QUIET_MS);
  await w.auto.tick();
  w.pass(QUIET_MS);
  await w.auto.tick();
  assert.deepEqual(w.failed, ['app:peek: peek is being installed or deployed already']);
});

test('a deploy still starting (an APK downloading) is not started twice, and its card hides the button meanwhile', async () => {
  const store = new Store(join(root, `t-${++dbs}.db`));
  const apk: Found = { projectId: 3, id: 'apk:release', kind: 'apk', name: 'Android', link: null, branch: 'main', workflow: 'r.yml', contraption: 'm' };
  const tv: Omit<TargetView, 'testCopies'> = { target: { id: apk.id, projectId: 3, name: apk.name, kind: 'apk', link: null }, current: null, next: null, line: [], recent: [] };
  let finish!: () => void;
  let starts = 0;
  const auto = new AutoDeploy({
    store, targets: () => [apk], view: () => [{ projectId: 3, targets: [{ ...tv, testCopies: [] }], testCopies: [] }], failed: () => {},
    deployers: { apk: { waits: () => true, head: async () => 'publish:8', start: () => (starts++, new Promise<void>((done) => (finish = done))) } },
  });
  const first = auto.deployNow(3, apk.id, 'Cara', 1);
  await assert.rejects(auto.deployNow(3, apk.id, 'Josh', 2), /being deployed already/, 'two presses at once');
  await new Promise((r) => setImmediate(r));
  assert.equal(auto.info(tv)?.can, false);
  await assert.rejects(auto.deployNow(3, apk.id, 'Josh', 2), /being deployed already/);
  finish();
  await first;
  assert.equal(starts, 1);
  assert.equal(auto.info(tv)?.can, true, 'settled: the reader decides again');
});

// Roll back to last green (#1016): a pinned target waits for the fix. Auto-deploy leaves it be, a minion's deploy is
// refused, and a person's Deploy ships main and lets go of the pin.
test('a target rolled back to last green is left alone by auto-deploy and minions, until a person deploys it', async () => {
  const w = world();
  w.held.pin(3, 'app:peek', { sha: 'aaa', from: 'bbb', by: 'Cara' });
  await w.auto.tick();
  w.pass(QUIET_MS + 1000);
  await w.auto.tick();
  assert.deepEqual(w.started, [], 'no auto-deploy while pinned');
  assert.equal(w.auto.info(w.app)?.due, null);
  assert.equal(w.auto.info(w.app)?.can, true, "the card's Deploy still shows");
  await assert.rejects(w.auto.deployNow(3, 'app:peek', '#12', null), /rolled back to last green aaa by Cara/);
  assert.deepEqual(w.started, []);
  await w.auto.deployNow(3, 'app:peek', 'Josh', null);
  assert.deepEqual(w.started, ['app:peek by Josh at aaa']);
  assert.equal(w.held.pinned(3, 'app:peek'), null, "a person's deploy let go of the pin");
});
