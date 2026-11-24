import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AUTO_BY, AutoDeploy, MAX_WAIT_MS } from '../src/auto-deploy.ts';
import { Store } from '../src/db.ts';
import { LastGreen } from '../src/last-green.ts';
import type { Found } from '../src/release-targets.ts';
import type { SchemeReleases, TargetView } from '../src/releases.ts';

// src/auto-deploy.ts (#629, #1736): a target deploys by itself on the tick after its head moved, unless a ship is waiting
// or landing in its scheme (then up to MAX_WAIT_MS from the first move), once per commit, unless its scheme turned
// that off; the card's Deploy button deploys it at once.
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
  let shipping = false;
  const tv = (t: Found): Omit<TargetView, 'testCopies'> => ({ target: { id: t.id, projectId: t.projectId, name: t.name, kind: t.kind, link: t.link }, current: null, next: null, line: [], recent: [] });
  const view = (): SchemeReleases[] => [{ projectId: 3, targets: [app, ci].map((t) => ({ ...tv(t), testCopies: [] })), testCopies: [] }];
  const held = new LastGreen(store);
  const auto = new AutoDeploy({
    store,
    targets: () => [app, ci],
    view,
    now: () => now,
    held,
    shipping: () => shipping,
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
    auto,
    started,
    failed,
    held,
    app: tv(app),
    ci: tv(ci),
    set: (o: { head?: string; waits?: boolean; refuse?: string | null; shipping?: boolean }) => {
      if (o.shipping !== undefined) shipping = o.shipping;
      if (o.head !== undefined) head = o.head;
      if (o.waits !== undefined) waits = o.waits;
      if (o.refuse !== undefined) refuse = o.refuse;
    },
    pass: (ms: number) => (now += ms),
    now: () => now,
  };
}

test('a waiting target deploys on the tick after its head moved when nothing ships in its scheme (a)', async () => {
  const w = world();
  await w.auto.tick(); // sees the head: one tick of grace, so a deploy a landing starts itself goes first
  assert.deepEqual(w.started, []);
  assert.equal(w.auto.info(w.app)?.due, w.now(), 'the card says now');
  assert.equal(w.auto.info(w.app)?.more, false);
  await w.auto.tick();
  assert.deepEqual(w.started, [`app:peek by ${AUTO_BY} at aaa`]);
  assert.equal(w.auto.info(w.app)?.due, null, 'tried at this commit: no longer due');
});

test('with a ship waiting or landing in its scheme it waits, until the ship is gone (b)', async () => {
  const w = world();
  w.set({ shipping: true });
  await w.auto.tick();
  const first = w.now();
  w.pass(60_000);
  await w.auto.tick();
  w.set({ head: 'bbb' }); // the ship landed: main moved, another is still behind it
  await w.auto.tick();
  w.pass(60_000);
  await w.auto.tick();
  assert.deepEqual(w.started, []);
  assert.deepEqual(w.auto.info(w.app), { can: true, auto: true, due: first + MAX_WAIT_MS, more: true });
  w.set({ shipping: false });
  await w.auto.tick();
  assert.deepEqual(w.started, [`app:peek by ${AUTO_BY} at bbb`]);
});

test('it deploys anyway MAX_WAIT_MS after the head first moved, however many ships moved it since (c)', async () => {
  const w = world();
  w.set({ shipping: true });
  await w.auto.tick();
  for (const h of ['b', 'c', 'd']) {
    w.pass(MAX_WAIT_MS / 4 - 1000);
    w.set({ head: h });
    await w.auto.tick();
  }
  assert.deepEqual(w.started, []);
  w.pass(MAX_WAIT_MS / 4 + 3000);
  await w.auto.tick();
  assert.deepEqual(w.started, [`app:peek by ${AUTO_BY} at d`]);
  // The next commit starts a fresh cap rather than inheriting the spent one.
  w.set({ head: 'e' });
  await w.auto.tick();
  await w.auto.tick();
  assert.equal(w.started.length, 1);
  assert.equal(w.auto.info(w.app)?.due, w.now() + MAX_WAIT_MS);
});

test('an Android target follows the same rule (d)', async () => {
  const store = new Store(join(root, `t-${++dbs}.db`));
  const apk: Found = { projectId: 3, id: 'apk:release', kind: 'apk', name: 'Android', link: null, branch: 'main', workflow: 'r.yml', contraption: 'm' };
  const tv: Omit<TargetView, 'testCopies'> = { target: { id: apk.id, projectId: 3, name: apk.name, kind: 'apk', link: null }, current: null, next: null, line: [], recent: [] };
  let now = 1_800_000_000_000,
    shipping = true;
  const started: string[] = [];
  const auto = new AutoDeploy({
    store,
    targets: () => [apk],
    view: () => [{ projectId: 3, targets: [{ ...tv, testCopies: [] }], testCopies: [] }],
    failed: () => {},
    now: () => now,
    shipping: () => shipping,
    deployers: { apk: { waits: () => true, head: async () => 'publish:8', start: () => void started.push('apk') } },
  });
  await auto.tick();
  now += MAX_WAIT_MS - 1000;
  await auto.tick();
  assert.deepEqual(started, [], 'a ship is coming');
  shipping = false;
  await auto.tick();
  assert.deepEqual(started, ['apk'], 'nothing coming: at once');
});

test("turned off, it waits for the button; the button deploys at once and counts as the commit's try", async () => {
  const w = world();
  assert.equal(w.auto.setOn(3, 'app:peek', false), true);
  assert.equal(w.auto.isOn(3, 'app:peek'), false);
  await w.auto.tick();
  w.pass(MAX_WAIT_MS * 3);
  await w.auto.tick();
  assert.deepEqual(w.started, []);
  assert.deepEqual(w.auto.info(w.app), { can: true, auto: false, due: null, more: false });
  await w.auto.deployNow(3, 'app:peek', 'Cara', 1);
  assert.deepEqual(w.started, ['app:peek by Cara at aaa']);
  w.auto.setOn(3, 'app:peek', true);
  await w.auto.tick();
  w.pass(60_000);
  await w.auto.tick();
  assert.equal(w.started.length, 1, "the person's deploy was this commit's try");
});

test('nothing waiting, nothing due; a kind with no release step has no button or switch', async () => {
  const w = world();
  w.set({ waits: false });
  await w.auto.tick();
  w.pass(60_000);
  await w.auto.tick();
  assert.deepEqual(w.started, []);
  assert.deepEqual(w.auto.info(w.app), { can: false, auto: true, due: null, more: false });
  assert.equal(w.auto.info(w.ci), null);
  assert.equal(w.auto.setOn(3, 'ci:windows:release', false), false);
  await assert.rejects(w.auto.deployNow(3, 'ci:windows:release', 'Cara', 1), /no release step/);
});

test("an auto-deploy that can't start is told, and not retried at that commit", async () => {
  const w = world();
  w.set({ refuse: 'peek is being installed or deployed already' });
  await w.auto.tick();
  w.pass(60_000);
  await w.auto.tick();
  w.pass(60_000);
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
    store,
    targets: () => [apk],
    view: () => [{ projectId: 3, targets: [{ ...tv, testCopies: [] }], testCopies: [] }],
    failed: () => {},
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
  w.pass(60_000 + 1000);
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

test('a tried head spends its cap: the next ship moving a failed target waits afresh while another is in line (#1736)', async () => {
  const w = world();
  await w.auto.tick();
  await w.auto.tick(); // deployed at aaa, which then rolled back
  w.set({ shipping: true });
  w.pass(MAX_WAIT_MS * 2);
  w.set({ head: 'bbb' });
  await w.auto.tick();
  await w.auto.tick();
  assert.equal(w.started.length, 1, 'ship bbb landed with another behind it: waits');
  assert.equal(w.auto.info(w.app)?.due, w.now() + MAX_WAIT_MS);
});
