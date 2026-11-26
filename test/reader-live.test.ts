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
