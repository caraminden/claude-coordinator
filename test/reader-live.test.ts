// What main tells the readers about a minion's live state (src/reader-live.ts). A change is counted for the front
// thread (`coming`) in the same run of the thread that made it, before its batch is posted in a microtask: a response
// written in between let the person's next request reach a reader that still had the state before their click, so a
// sealed minion's page showed no wake right after the wake was set (#1963, test/parked-hold.test.ts in a crowd).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SnapDelta } from '../src/front.ts';
import { publishLive, type LiveDeps } from '../src/reader-live.ts';

test('a changed live state is announced at once, and published once, counted, for the whole batch', async () => {
  const log: string[] = [];
  const runner = { onLive: (_id: number, _live: unknown) => {}, runningIds: () => [], turnLine: { waiting: () => [] } };
  const none = () => [];
  const live = publishLive({
    publish: (d: SnapDelta, counted?: boolean) => void (d.live && log.push(`publish ${Object.keys(d.live).join(',')}${counted ? ' counted' : ''}`)),
    coming: () => void log.push('coming'),
    store: { listProjects: none, listContraptions: none, listTickets: none },
    runner,
    builds: none,
    cabals: () => [],
    ownScheme: () => null,
    previews: false,
    status: { unitRows: async () => [] },
    ships: () => ({ queue: [], releases: [] }),
    statusInputs: { bootAt: 0, commit: '', probing: false, lastMs: () => null, readerMs: () => null, storms: none, easing: none, desktops: none, diskUse: () => null },
    sweepMs: 3_600_000,
  } as unknown as LiveDeps);
  try {
    await live.ready;
    runner.onLive(7, { wakes_on: 'the fix goes live' });
    assert.deepEqual(log, ['coming'], 'counted before anything else can run on this thread: a response, then the next request');
    runner.onLive(8, { wakes_on: null });
    runner.onLive(7, { wakes_on: 'the fix goes live' });
    assert.deepEqual(log, ['coming'], 'one count for the batch');
    await Promise.resolve();
    assert.deepEqual(log, ['coming', 'publish 7,8 counted']);
    runner.onLive(7, { wakes_on: 'the fix goes live' });
    await Promise.resolve();
    assert.equal(log.length, 2, 'the same state again is no change');
  } finally {
    live.stop();
  }
});

// #2119: a warm handover's new server starts its readers from the old server's snapshot, so they answer from its first
// request, not after its own pass over every minion (3-15 s on the live box).
test('a handed-over snapshot is posted whole and ready at once, and the first pass then posts only what changed', async () => {
  const posts: SnapDelta[] = [];
  const tickets = [{ id: 1 }, { id: 2 }];
  const runner = { onLive: (_id: number, _live: unknown) => {}, runningIds: () => [], turnLine: { waiting: () => [] }, live: (t: { id: number }) => ({ n: t.id === 2 ? 'new' : 'same' }) };
  const none = () => [];
  const deps = (handed: string | null) =>
    ({
      handed,
      publish: (d: SnapDelta) => void posts.push(d),
      coming: () => {},
      store: { listProjects: () => [{ id: 1 }], listContraptions: none, listTickets: () => tickets, getTicket: (id: number) => tickets.find((t) => t.id === id) },
      runner,
      builds: none,
      cabals: () => [],
      ownScheme: () => 5,
      previews: false,
      status: { unitRows: async () => [] },
      ships: () => ({ queue: null, releases: [] }),
      statusInputs: { bootAt: 9, commit: 'new', probing: false, lastMs: () => null, readerMs: () => null, storms: none, easing: none, desktops: none, diskUse: () => null },
      sweepMs: 3_600_000,
    }) as unknown as LiveDeps;
  // The old server's side: what it would hand over once its own first pass is done.
  const old = publishLive(deps(null));
  assert.equal(old.dump(), null, 'nothing to hand over before its first pass');
  try {
    await old.ready;
    const dump = JSON.parse(old.dump()!);
    assert.deepEqual(dump.live, { 1: { n: 'same' }, 2: { n: 'new' } });
    assert.equal(dump.other.ownScheme, 5);
  } finally {
    old.stop();
  }
  posts.length = 0;
  const handed = JSON.stringify({ live: { 1: { n: 'same' }, 2: { n: 'old' } }, other: { status: { bootAt: 1, commit: 'old' }, ownScheme: 5, builds: { 1: ['b'] } } });
  const live = publishLive(deps(handed));
  try {
    // Before anything async: the old views, its build headers, and ready, but not its Status inputs (its boot time and commit).
    assert.deepEqual(posts, [{ ownScheme: 5, builds: { 1: ['b'] }, live: { 1: { n: 'same' }, 2: { n: 'old' } }, ready: true }]);
    await live.ready;
    const later = posts.slice(1);
    assert.deepEqual(
      later.flatMap((d) => (d.live ? [d.live] : [])),
      [{ 2: { n: 'new' } }],
      'only the view that differs from the handed one',
    );
    assert.equal(later.find((d) => d.status)?.status?.commit, 'new', "this server's own Status inputs");
  } finally {
    live.stop();
  }
});

test("a handed-over snapshot that doesn't read leaves the server to build its own", async () => {
  const posts: SnapDelta[] = [];
  const none = () => [];
  const runner = { onLive: () => {}, runningIds: () => [], turnLine: { waiting: () => [] }, live: () => ({ n: 1 }) };
  const live = publishLive({
    handed: '{"live":',
    publish: (d: SnapDelta) => void posts.push(d),
    coming: () => {},
    store: { listProjects: () => [{ id: 1 }], listContraptions: none, listTickets: () => [{ id: 1 }], getTicket: () => ({ id: 1 }) },
    runner,
    builds: none,
    cabals: () => [],
    ownScheme: () => null,
    previews: false,
    status: { unitRows: async () => [] },
    ships: () => ({ queue: null, releases: [] }),
    statusInputs: { bootAt: 0, commit: '', probing: false, lastMs: () => null, readerMs: () => null, storms: none, easing: none, desktops: none, diskUse: () => null },
    sweepMs: 3_600_000,
  } as unknown as LiveDeps);
  try {
    assert.equal(posts.length, 0, 'nothing posted, and not ready, until its own pass');
    await live.ready;
    assert.deepEqual(
      posts.flatMap((d) => (d.live ? [d.live] : [])),
      [{ 1: { n: 1 } }],
    );
    assert.ok(posts.at(-1)?.ready);
  } finally {
    live.stop();
  }
});
