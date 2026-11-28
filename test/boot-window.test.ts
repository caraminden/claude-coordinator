// The front thread listens before the main thread's module has finished running: its top-level await for the cabal
// warm-up (#2203) let requests in while the request handler's own state was still uninitialised. Each one threw
// "Cannot access 'passingOn' before initialization" and was never answered, so a page whose events stream landed in a
// deploy's handover sat on "Reconnecting…" (#2260).
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { bootServer, tempRoot } from './helpers.ts';

const tmp = tempRoot('boot-window-');
after(() => tmp.teardown());

test('a request that comes in while the boot still awaits the warm-up is answered (#2260)', { timeout: 90_000 }, async () => {
  const log = tmp.path('server.log');
  const release = tmp.path('warmed');
  // bootServer signs in, a POST the main thread answers, as soon as the port listens: here while the warm-up still holds.
  // Unanswered, it never returns, and the test's timeout is the red.
  const srv = await bootServer({ root: tmp.dir, log, env: { TURN_UNITS: '0', CITADEL_TEST_WARM_WAIT: release } });
  try {
    const text = readFileSync(log, 'utf8');
    assert.match(text, /Main test hook: warming slowly/);
    assert.doesNotMatch(text, /Main test hook: warmed/, 'the sign-in was answered inside the window');
    const health = await fetch(`${srv.base}/api/health`, { signal: AbortSignal.timeout(30_000) });
    assert.equal(health.status, 200);
    assert.doesNotMatch(readFileSync(log, 'utf8'), /before initialization/);
  } finally {
    writeFileSync(release, '');
    await srv.stop();
  }
});
