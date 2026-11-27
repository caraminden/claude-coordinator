// The burn-in at the ship door (#1443, tools/burn-in.sh; Cara, 2026-11-21, "Go" on #1429's choices page): tests.yml burns
// in a ship's new and changed tests before its full suite. land.sh hands it the ship's base as land-base/<branch>, reads
// a red burn-in as the ship's own (never a flake, a cut-off or a known flake: no fresh run), waits the burn-in's time
// more at its CI limit, and says loudly that a fallback to perigee burns nothing in.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git, seen, setup, quietProc } from './land-fixture.ts';

const landLog = (shared: string) => readFileSync(join(shared, 'retro-log', readdirSync(join(shared, 'retro-log'))[0], 'land.md'), 'utf8');
const pushes = (c: ReturnType<typeof ci>) =>
  c
    .calls()
    .split('\n')
    .filter((l) => l.includes('/actions/runners ')).length;
const ref = (r: ReturnType<typeof setup>, name: string) => {
  try {
    return git(join(r.dir, 'hub.git'), 'rev-parse', '-q', '--verify', name);
  } catch {
    return '';
  }
};

test("a red burn-in refuses the ship as its own red: no fresh run, even when its log quotes a known flake's line", () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'test/real.test.ts', 'racy\n');
  const main = git(r.source, 'rev-parse', 'main');
  const shared = join(r.dir, 'shared');
  seen(shared, ['test/slow.test.ts'], 'ticket/8-another'); // a known flake, if the log were read for flakes
  const res = c.run({ FAKE_CI: 'red', FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn', COORDINATOR_SHARED_DIR: shared });
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stderr, /land: a new or changed test failed its burn-in in CI \(https:\/\/ci\/\d+\): test\/real\.test\.ts: failed in 3 of 10 copies at once, so it never reached the full suite and main is untouched\. A file that fails when run as copies at once is racy/);
  assert.match(res.stderr, /This is the ship's own red, never a known flake/);
  assert.match(res.stderr, /not ok 1 - the red test's output/, "the failing copy's output, on its stderr");
  assert.doesNotMatch(res.stderr, /running CI once more|only known flakes|shipped past|CI FALLBACK|setup step|land: flake:/);
  assert.equal(pushes(c), 1, 'one run, no fresh one');
  assert.match(landLog(shared), /· burn-in red · ticket\/1-x · test\/real\.test\.ts: failed in 3 of 10 copies at once · https:\/\/ci\/\d+$/m);
  assert.equal(git(r.source, 'rev-parse', 'main'), main);
  assert.equal(c.localRuns(), 0, 'never on perigee');
});

// #2141: a file red in every copy ran once alone on CI; the refusal says which case it is.
for (const [alone, said, not] of [
  ['failed', /test\/real\.test\.ts failed in every copy, and run once by itself on CI it fails alone too: a plain red or a CI-only environment fault \(a temp path, git identity, a missing tool\), not a race\. Read its output above and fix that, then run this again/, /racy/],
  ['passed', /failed in 10 of 10 copies at once, so it never reached the full suite and main is untouched\. A file that fails when run as copies at once is racy \(its output is above\): fix the race/, /plain red/],
  ['unrun', /test\/real\.test\.ts failed in every copy and CI had no time left to run it alone, so it may be a plain red or a race: run it alone with citadel-test/, /racy/],
] as const) {
  test(`a burn-in red in every copy that ${alone} alone is refused as ${alone === 'failed' ? 'a plain red, not a race' : alone === 'passed' ? 'a race' : 'either'}`, () => {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'test/real.test.ts', 'red\n');
    const res = c.run({ FAKE_CI: 'red', FAKE_STEP: 'burn in new and changed tests', FAKE_LOG: 'burn', FAKE_BURN_ALONE: alone });
    assert.equal(res.status, 1, res.stderr);
    assert.match(res.stderr, said);
    assert.doesNotMatch(
      res.stderr
        .split('\n')
        .filter((l) => l.startsWith('land: a new or changed test'))
        .join('\n'),
      not,
    );
  });
}

test("the run gets the ship's base as land-base/<branch> beside land/<branch>, and both go when the ship is done", async () => {
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const main = git(r.source, 'rev-parse', 'main');
  const gate = join(r.dir, 'ci-gate');
  let base = '';
  const res = await c.runAsync({ FAKE_CI: 'green', FAKE_CI_GATE: gate }, () => {
    if (existsSync(gate) || !ref(r, 'refs/heads/land/ticket/1-x')) return;
    base = ref(r, 'refs/heads/land-base/ticket/1-x');
    writeFileSync(gate, '');
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(base, main, 'pushed with the run, at main before the ship');
  assert.equal(ref(r, 'refs/heads/land/ticket/1-x'), '');
  assert.equal(ref(r, 'refs/heads/land-base/ticket/1-x'), '', 'the scratch base goes too');
});

const procAt = (r: ReturnType<typeof setup>) => {
  const proc = quietProc(join(r.dir, 'proc'));
  return { LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(r.dir, 'heavy') };
};

test("at CI's limit a run that burned tests in waits the burn-in's time more, once, then falls back with the burn-in skipped line", async () => {
  // Completed in 3 s: it waits 3 s more and passes; still burning in: CI_BURN more (here 2 s), then the fallback.
  const r = setup();
  const c = ci(r);
  r.commit(r.wt, 'b.txt', 'mine\n');
  const gate = join(r.dir, 'ci-gate');
  const told = (s: string) => /burn-in of new and changed tests took/.test(s) && !existsSync(gate) && writeFileSync(gate, '');
  let res = await c.runAsync({ FAKE_CI: 'green', FAKE_CI_GATE: gate, FAKE_BURN: 'completed\t2026-11-21T10:00:00.000Z\t2026-11-21T10:00:03Z', LAND_CI_TIMEOUT: '1', ...procAt(r) }, told);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stderr, /CI's burn-in of new and changed tests took 3s before its full suite, so this waits that much more \(https:\/\/ci\/\d+\)/);
  assert.match(res.stderr, /CI passed/);
  assert.doesNotMatch(res.stderr, /CI FALLBACK|BURN-IN SKIPPED/);

  const r2 = setup();
  const c2 = ci(r2);
  r2.commit(r2.wt, 'b.txt', 'mine\n');
  res = c2.run({ FAKE_CI: 'running', FAKE_BURN: 'in_progress\t2026-11-21T10:00:00Z\t-', LAND_CI_TIMEOUT: '1', LAND_CI_BURN: '2', ...procAt(r2) });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr.match(/burn-in of new and changed tests took 2s/g)?.length, 1, res.stderr);
  assert.match(res.stderr, /CI FALLBACK: CI didn't finish/);
  assert.match(res.stderr, /^land: BURN-IN SKIPPED: new and changed tests were not run as 10 copies at once, since that runs only on CI, never on perigee \(#1443\)$/m);
  assert.equal(c2.localRuns(), 1);
});

test('a run whose burn-in step skipped or never ran gets no more time at the limit', () => {
  for (const burn of ['completed\t2026-11-21T10:00:00Z\t2026-11-21T10:00:00Z', 'queued\t-\t-', '']) {
    const r = setup();
    const c = ci(r);
    r.commit(r.wt, 'b.txt', 'mine\n');
    const res = c.run({ FAKE_CI: 'running', FAKE_BURN: burn, LAND_CI_TIMEOUT: '1', ...procAt(r) });
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stderr, /burn-in of new and changed tests took/, JSON.stringify(burn));
    assert.match(res.stderr, /CI FALLBACK: CI didn't finish within 1s/);
  }
});
