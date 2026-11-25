import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiHold, type HoldState, heldRows, isNight, MAIN_SETTLE_MS, MAIN_WAIT_MS, REPORT_MS, SETTLE_DAY_MS, SETTLE_NIGHT_MS, SLOT_HOLD_MS, SLOT_WAIT_MS, withoutHeld } from '../src/ci-hold.ts';

// Deploys first (#1902): while a ship is in line, nothing optional runs on the CI desktop.
const OWN = 'o/citadel';
const DAY = Date.parse('2026-11-24T20:00:00Z'); // noon Pacific
const NIGHT = Date.parse('2026-11-25T08:00:00Z'); // midnight Pacific
const MIN = 60_000;

type Run = { id: number; path: string; display_title: string; head_branch: string; status: string; conclusion: string | null; run_attempt: number; run_started_at: string; html_url: string };

function world(now = DAY, saved: unknown = null) {
  const w = {
    now,
    line: 0,
    off: false,
    down: false,
    runs: [] as (Run & { repo: string })[],
    posts: [] as string[],
    told: [] as { ticket: number; text: string }[],
    reports: [] as string[],
    closed: new Set<number>(),
    refs: new Set<string>(),
    /** Ships' runs whose failed tests run again alone now. */
    retries: new Set<number>(),
    resume: true,
    since: undefined as number | undefined,
    answer: null as (() => Promise<{ status: number }>) | null,
    settings: new Map<string, unknown>(saved ? [['ci-hold', saved]] : []),
    published: null as (HoldState & { at: number }) | null,
    add(title: string, o: Partial<Run & { repo: string }> & { file: string }) {
      const r = { repo: OWN, id: w.runs.length + 1, path: `.github/workflows/${o.file}`, display_title: title, head_branch: 'ticket/7-x', status: 'in_progress', conclusion: null, run_attempt: 1, run_started_at: new Date(w.now).toISOString(), html_url: `https://gh/${w.runs.length + 1}`, ...o };
      w.runs.push(r);
      return r;
    },
    proof: (o = {}) => w.add('flake-proof test/x.test.ts', { file: 'flake-proof.yml', ...o }),
    land: (o = {}) => w.add('land', { file: 'tests.yml', head_branch: 'land/9', ...o }),
    heavy: (o = {}) => w.add(`heavy h${w.runs.length}-1-x`, { file: 'citadel-heavy.yml', ...o }),
    check: (o = {}) => w.add('check', { file: 'tests.yml', head_branch: 'check/9', ...o }),
    early: (o = {}) => w.add('early', { file: 'tests.yml', head_branch: 'early/9', ...o }),
    ask: async (r: Run) => (await w.hold.ask(OWN, r.id, w.now)).go,
    main: (o = {}) => w.add('tests', { file: 'tests.yml', head_branch: 'main', ...o }),
    hold: null as unknown as CiHold,
    async tick(ms = 15_000) {
      w.now += ms;
      await w.hold.tick(w.now);
    },
    async for(ms: number) {
      for (let t = 0; t < ms; t += 15_000) await w.tick();
    },
  };
  w.hold = new CiHold({
    own: () => OWN,
    repos: () => [OWN, 'o/peek'],
    as: () => ({}),
    line: () => w.line,
    off: () => w.off,
    ticket: () => 7,
    closed: (t) => w.closed.has(t),
    mayResume: () => w.resume,
    heldSince: () => w.since,
    tell: (ticket, text) => w.told.push({ ticket, text }),
    report: (_repo, text) => w.reports.push(text),
    store: { getSetting: <T>(k: string) => (w.settings.get(k) as T) ?? null, setSetting: (k, v) => w.settings.set(k, structuredClone(v)) },
    publish: (s) => void (w.published = s),
    log: () => {},
    get: async (path) => {
      if (w.down) throw new Error('GitHub is down');
      const ref = /git\/ref\/heads\/(.+)$/.exec(path);
      if (ref) return { status: w.refs.has(ref[1]) ? 200 : 404, etag: null, body: {} };
      const jobs = /runs\/(\d+)\/jobs/.exec(path);
      if (jobs)
        return {
          status: 200,
          etag: null,
          body: {
            jobs: [
              {
                steps: [
                  { name: 'full suite', status: 'completed' },
                  { name: 'rerun failed files alone', status: w.retries.has(Number(jobs[1])) ? 'in_progress' : 'pending' },
                ],
              },
            ],
          },
        };
      const one = /runs\/(\d+)$/.exec(path);
      if (one) {
        const r = w.runs.find((x) => x.id === Number(one[1]));
        return r ? { status: 200, etag: null, body: { ...r } } : { status: 404, etag: null, body: {} };
      }
      const [, repo, status] = /^repos\/(.+?)\/actions\/runs\?status=(\w+)/.exec(path)!;
      return { status: 200, etag: null, body: { workflow_runs: w.runs.filter((r) => r.repo === repo && r.status === status).map((r) => ({ ...r })) } };
    },
    post: async (path) => {
      const [, id, what] = /runs\/(\d+)\/([\w-]+)$/.exec(path)!;
      w.posts.push(`${what} ${id}`);
      if (w.down) throw new Error('GitHub is down');
      if (w.answer) return w.answer();
      const r = w.runs.find((x) => x.id === Number(id))!;
      if (what === 'rerun') Object.assign(r, { status: 'queued', conclusion: null, run_attempt: r.run_attempt + 1 });
      else Object.assign(r, { status: 'completed', conclusion: 'cancelled' });
      return { status: 201 };
    },
  });
  return w;
}

test('a ship joining the line stops a running heavy job within a minute, and tells its minion once', async () => {
  const w = world();
  w.heavy();
  await w.for(10 * MIN);
  assert.deepEqual(w.posts, [], 'an empty line stops nothing');
  w.line = 1;
  await w.tick();
  assert.deepEqual(w.posts, ['cancel 1']);
  assert.equal(w.hold.isHeld(1), true, 'its cancelled end is not news');
  await w.for(5 * MIN);
  assert.equal(w.told.length, 1);
  assert.equal(w.told[0].ticket, 7);
  assert.match(w.told[0].text, /a ship is in line.*starts it again by itself from the start.*don't start it again/s);
});

test('a stopped job comes back by itself once the line has been empty for the settle time, and is left alone after', async () => {
  const w = world();
  w.heavy();
  w.line = 2;
  await w.for(2 * MIN);
  w.line = 0;
  await w.for(SETTLE_DAY_MS - MIN);
  assert.ok(!w.posts.includes('rerun 1'), 'the line only just emptied');
  await w.for(2 * MIN);
  assert.deepEqual(w.posts, ['cancel 1', 'rerun 1']);
  assert.equal(w.hold.isHeld(1), false);
  Object.assign(w.runs[0], { status: 'in_progress' });
  await w.for(5 * MIN);
  Object.assign(w.runs[0], { status: 'completed', conclusion: 'failure' });
  await w.for(3 * MIN);
  assert.deepEqual(w.posts, ['cancel 1', 'rerun 1']);
  assert.deepEqual(w.settings.get('ci-hold'), [], 'done with');
});

test('a run stopped again after it came back waits for twice the quiet, so short gaps do not start and stop it all day', async () => {
  const w = world();
  w.heavy();
  w.line = 1;
  await w.for(MIN);
  w.line = 0;
  await w.for(SETTLE_DAY_MS + MIN);
  w.line = 1;
  await w.for(MIN);
  assert.deepEqual(w.posts, ['cancel 1', 'rerun 1', 'cancel 1']);
  w.line = 0;
  await w.for(2 * SETTLE_DAY_MS - MIN);
  assert.equal(w.posts.length, 3, 'the same gap does not bring it back');
  await w.for(2 * MIN);
  assert.equal(w.posts[3], 'rerun 1');
});

test('an optional job is not started through a line that outlasts the old 15 and 30 minute give-ups', async () => {
  const w = world();
  w.line = 1;
  w.heavy({ status: 'queued' });
  await w.for(3 * 3600_000);
  assert.deepEqual(w.posts, ['cancel 1']);
  assert.equal((await w.hold.ask(OWN, 1, w.now)).go, false);
});

test('a ship whose tests run counts, whatever the line reads: its retry has the desktop to itself', async () => {
  const w = world();
  const land = w.land();
  w.heavy();
  await w.tick();
  assert.deepEqual(w.posts, ['cancel 2']);
  await w.for(10 * MIN);
  assert.deepEqual(w.posts, ['cancel 2']);
  Object.assign(land, { status: 'completed', conclusion: 'success' });
  await w.for(SETTLE_DAY_MS + MIN);
  assert.deepEqual(w.posts, ['cancel 2', 'rerun 2']);
});

test("a ship's run in line is never stopped, nor a release build", async () => {
  const w = world();
  w.line = 3;
  w.land();
  w.add('desktop', { file: 'desktop.yml', head_branch: 'main' });
  await w.for(60 * MIN);
  assert.deepEqual(w.posts, []);
  for (const r of w.runs) assert.equal((await w.hold.ask(OWN, r.id, w.now)).go, true, r.display_title);
});

test('heavy jobs and a suite started by hand are held too; another scheme only has its heavy jobs held', async () => {
  const w = world();
  w.line = 1;
  w.add('heavy abc-1-x', { file: 'citadel-heavy.yml' });
  w.add('tests', { file: 'tests.yml' });
  w.add('heavy abd-1-x', { file: 'citadel-heavy.yml', repo: 'o/peek' });
  w.add('tests', { file: 'tests.yml', repo: 'o/peek' });
  await w.tick();
  assert.deepEqual(w.posts, ['cancel 1', 'cancel 2', 'cancel 3']);
});

test("main's queued run starts before anything optional, and a running optional job yields to it", async () => {
  const w = world();
  w.proof();
  await w.for(10 * MIN);
  const main = w.main({ status: 'queued' });
  await w.tick();
  assert.deepEqual(w.posts, ['cancel 1'], 'the proof is stopped, main is not');
  assert.equal((await w.hold.ask(OWN, main.id, w.now)).go, true);
  Object.assign(main, { status: 'in_progress' });
  await w.for(8 * MIN);
  assert.deepEqual(w.posts, ['cancel 1']);
  Object.assign(main, { status: 'completed', conclusion: 'success' });
  await w.for(SETTLE_DAY_MS + MIN);
  assert.deepEqual(w.posts, ['cancel 1', 'rerun 1']);
});

test("main's run waits for ships off the runner, is back first when they end, and after 4 hours goes anyway", async () => {
  const w = world();
  w.line = 1;
  w.heavy();
  w.main({ status: 'queued' });
  await w.tick();
  assert.deepEqual([...w.posts].sort(), ['cancel 1', 'cancel 2']);
  assert.equal(w.told.length, 1, 'main has no minion to tell');
  w.line = 0;
  await w.tick();
  assert.deepEqual(w.posts.slice(2), [], 'the gap is a moment old: the next ship may be a minute off');
  await w.for(MAIN_SETTLE_MS);
  assert.deepEqual(w.posts.slice(2), ['rerun 2'], 'two quiet minutes are enough for main');

  const u = world();
  u.line = 1;
  u.main({ status: 'queued' });
  await u.tick();
  u.line = 0;
  await u.tick();
  u.down = true;
  await u.for(5 * MIN);
  u.down = false;
  await u.tick();
  assert.deepEqual(u.posts, ['cancel 1'], 'a ship may have come and gone while GitHub could not be read');
  await u.for(MAIN_SETTLE_MS + MIN);
  assert.deepEqual(u.posts, ['cancel 1', 'rerun 1']);
  await w.for(20 * MIN);
  assert.ok(!w.posts.includes('rerun 1'), 'the proof waits for it');

  const v = world();
  v.line = 1;
  v.main({ status: 'queued' });
  await v.for(4 * 60 * MIN - 2 * MIN);
  assert.deepEqual(v.posts, ['cancel 1'], 'no 30 minutes: it waits for a gap');
  await v.for(3 * MIN);
  assert.deepEqual(v.posts, ['cancel 1', 'rerun 1']);
  assert.equal((await v.hold.ask(OWN, 1, v.now)).go, true, 'and it is not stopped again');
  v.runs[0].status = 'in_progress';
  await v.for(10 * MIN);
  assert.equal(v.posts.length, 2);
});

test('a job that asks while a ship waits is stopped and kept; asked with the line empty it goes', async () => {
  const w = world();
  await w.for(10 * MIN);
  w.heavy();
  assert.deepEqual(await w.hold.ask(OWN, 1, w.now), { go: true, why: null });
  w.line = 1;
  assert.deepEqual(await w.hold.ask(OWN, 1, w.now), { go: false, why: 'a ship is in line' });
  assert.deepEqual(w.posts, ['cancel 1']);
});

test('night: a ship still stops optional work, and the settle time is shorter', async () => {
  assert.equal(isNight(NIGHT), true);
  assert.equal(isNight(DAY), false);
  for (const [at, night] of [
    ['2026-11-25T06:59:00Z', false],
    ['2026-11-25T07:00:00Z', true],
    ['2026-11-25T13:59:00Z', true],
    ['2026-11-25T14:00:00Z', false],
  ] as const)
    assert.equal(isNight(Date.parse(at)), night, at);
  const w = world(NIGHT);
  w.heavy();
  w.line = 1;
  await w.for(MIN);
  w.line = 0;
  await w.for(SETTLE_NIGHT_MS + 30_000);
  assert.deepEqual(w.posts, ['cancel 1', 'rerun 1']);
});

test('a job held over 24 hours is reported once, not while it is under', async () => {
  const w = world();
  w.line = 1;
  w.heavy();
  await w.tick();
  await w.tick(REPORT_MS - MIN);
  assert.equal(w.reports.length, 0);
  await w.for(10 * MIN);
  assert.equal(w.reports.length, 1);
  assert.match(w.reports[0], /heavy h0-1-x.*a ship is in line.*once the line is empty/s);
  const again = world(w.now, w.settings.get('ci-hold'));
  again.runs = w.runs;
  again.line = 1;
  await again.for(5 * MIN);
  assert.equal(again.reports.length, 0, 'a restart does not say it again');
});

test('the off switch: nothing is stopped or held, and what was held comes back at once', async () => {
  const w = world();
  w.line = 1;
  w.heavy();
  await w.for(MIN);
  w.off = true;
  await w.tick();
  assert.deepEqual(w.posts, ['cancel 1', 'rerun 1']);
  w.heavy();
  await w.for(10 * MIN);
  assert.equal(w.posts.length, 2);
  assert.equal((await w.hold.ask(OWN, 2, w.now)).go, true);
  assert.deepEqual([w.published!.off, w.published!.why], [true, null]);
});

test('GitHub down: no ship waits on the hold, a job that asks goes ahead, and the hold picks up after', async () => {
  const w = world();
  w.heavy();
  await w.for(10 * MIN);
  w.down = true;
  w.line = 1;
  assert.equal((await w.hold.ask(OWN, 1, w.now)).go, true);
  await w.for(3 * MIN);
  assert.deepEqual(w.posts, []);
  assert.equal(w.published!.at, w.now, 'and what citadel-heavy reads stays fresh');
  w.down = false;
  await w.tick();
  assert.deepEqual(w.posts, ['cancel 1']);
});

test('a stop survives a restart: the new server starts the run again', async () => {
  const w = world();
  w.heavy();
  w.line = 1;
  await w.tick();
  const b = world(w.now, w.settings.get('ci-hold'));
  b.runs = w.runs;
  await b.for(SETTLE_DAY_MS + MIN);
  assert.deepEqual(b.posts, ['rerun 1']);
});

test('a run that ended by itself before its cancel keeps its result', async () => {
  const w = world();
  const p = w.heavy();
  await w.for(MIN);
  w.line = 1;
  w.answer = async () => {
    Object.assign(p, { status: 'completed', conclusion: 'failure' });
    return { status: 409 };
  };
  await w.for(MIN);
  w.answer = null;
  w.line = 0;
  await w.for(10 * MIN);
  assert.deepEqual(w.posts, ['cancel 1'], 'never started again');
  assert.equal(w.hold.isHeld(1), false);
});

test("a closed minion's job is not started again, and a long job only when it may", async () => {
  const w = world();
  w.line = 1;
  w.heavy();
  await w.for(MIN);
  w.closed.add(7);
  w.line = 0;
  await w.for(10 * MIN);
  assert.deepEqual(w.posts, ['cancel 1']);

  const v = world();
  v.line = 1;
  v.add('heavy abc-1-x', { file: 'citadel-heavy.yml' });
  await v.for(MIN);
  v.line = 0;
  v.resume = false;
  await v.for(20 * MIN);
  assert.deepEqual(v.posts, ['cancel 1']);
  v.resume = true;
  await v.tick();
  assert.deepEqual(v.posts, ['cancel 1', 'rerun 1']);
});

test('GitHub refusing the rerun for an hour hands it back to its minion, a blip of a few minutes does not', async () => {
  const w = world();
  w.line = 1;
  const p = w.heavy();
  await w.for(MIN);
  w.line = 0;
  w.answer = async () => ({ status: 503 });
  await w.for(30 * MIN);
  assert.equal(w.told.length, 1, 'not given up');
  w.answer = null;
  await w.for(2 * MIN);
  assert.equal(p.status, 'queued', 'back once GitHub takes it');
  Object.assign(p, { status: 'completed', conclusion: 'success' });
  await w.for(5 * MIN);
  const other = w.heavy();
  w.line = 1;
  await w.for(MIN);
  w.line = 0;
  w.answer = async () => ({ status: 403 });
  await w.for(80 * MIN);
  assert.equal(other.conclusion, 'cancelled');
  assert.match(w.told.at(-1)!.text, /Start it again yourself/);
  assert.deepEqual(w.settings.get('ci-hold'), []);
});

test("main's run that can't come back is told to the Taskmaster", async () => {
  const w = world();
  w.line = 1;
  w.main({ status: 'queued' });
  await w.for(MIN);
  w.line = 0;
  w.answer = async () => ({ status: 404 });
  await w.for(10 * MIN);
  assert.equal(w.reports.length, 1);
  assert.match(w.reports[0], /refused to start a main's full run/);
});

test('the hold is published before its cancel is sent, when a job asks between two looks too', async () => {
  const w = world();
  const p = w.heavy();
  await w.tick();
  w.line = 1;
  const seen: boolean[] = [];
  w.answer = async () => {
    seen.push(!!w.published?.held.some((h) => h.run === p.id));
    return { status: 202 };
  };
  await w.hold.ask(OWN, p.id, w.now + 1000);
  assert.deepEqual(seen, [true]);
});

test('three held suites come back one at a time: they share a concurrency group, where a new waiting run cancels the last', async () => {
  const w = world();
  w.line = 1;
  const suites = [1, 2, 3].map(() => w.add('tests', { file: 'tests.yml' }));
  await w.for(MIN);
  w.line = 0;
  await w.for(20 * MIN);
  assert.deepEqual(
    suites.map((s) => s.status),
    ['queued', 'completed', 'completed'],
  );
  Object.assign(suites[0], { status: 'completed', conclusion: 'success' });
  await w.for(3 * MIN);
  assert.equal(suites[1].status, 'queued');
  assert.equal(suites[2].conclusion, 'cancelled');
  assert.equal((w.settings.get('ci-hold') as unknown[]).length, 2, 'the third is still held, not dropped');
});

test("main's run goes before a suite held beside it, and an hour-old queued main run holds nothing", async () => {
  const w = world();
  w.line = 1;
  const suite = w.add('tests', { file: 'tests.yml' });
  const main = w.main({ status: 'queued' });
  await w.for(MIN);
  w.line = 0;
  await w.for(10 * MIN);
  assert.equal(main.status, 'queued');
  assert.equal(suite.conclusion, 'cancelled');
  const x = world();
  x.main({ status: 'queued', run_started_at: new Date(DAY - 61 * MIN).toISOString() });
  x.proof();
  await x.for(10 * MIN);
  assert.deepEqual(x.posts, []);
});

test('a held run deleted on GitHub keeps no other from coming back', async () => {
  const w = world();
  w.line = 1;
  w.heavy();
  const other = w.heavy();
  await w.for(5_000);
  w.runs.shift();
  w.line = 0;
  await w.for(10 * MIN);
  assert.equal(other.status, 'queued');
});

test('switched off, a run being stopped gets no more cancels', async () => {
  const w = world();
  w.line = 1;
  w.heavy();
  w.answer = async () => ({ status: 500 });
  await w.tick();
  w.off = true;
  await w.for(10 * MIN);
  assert.deepEqual(w.posts, ['cancel 1']);
});

test('a ship run GitHub left queued for over an hour holds nothing', async () => {
  const w = world();
  w.land({ status: 'queued', run_started_at: new Date(DAY - 61 * MIN).toISOString() });
  w.heavy();
  await w.for(10 * MIN);
  assert.deepEqual(w.posts, []);
});

test("another scheme's job dispatched at its cap by the queue is not held for four hours more", async () => {
  const w = world();
  w.since = w.now - 4 * 60 * MIN;
  w.add('heavy abc-1-x', { file: 'citadel-heavy.yml', repo: 'o/peek' });
  w.line = 1;
  await w.for(10 * MIN);
  assert.deepEqual(w.posts, []);
  assert.deepEqual(await w.hold.ask('o/peek', 1, w.now), { go: true, why: null });
});

test("another scheme's heavy job goes ahead after four hours of a line that never empties, and Citadel's own does not", async () => {
  const w = world();
  const peek = w.add('heavy abc-1-x', { file: 'citadel-heavy.yml', repo: 'o/peek' });
  const ours = w.heavy();
  w.line = 1;
  await w.for(3 * 60 * MIN);
  assert.equal(peek.conclusion, 'cancelled');
  assert.equal(w.hold.why('o/Peek', w.now - 60 * MIN, w.now), 'a ship is in line');
  await w.for(65 * MIN);
  assert.equal(peek.status, 'queued', 'a hung line holds another scheme for four hours, no longer');
  await w.for(30 * MIN);
  assert.equal(peek.status, 'queued', 'and it is not stopped again');
  assert.equal(ours.conclusion, 'cancelled');
  assert.equal(w.hold.why('o/peek', w.now - 241 * MIN, w.now), null);
  assert.equal(w.hold.why(OWN, w.now - 241 * MIN, w.now), 'a ship is in line');
  assert.equal(w.hold.why('o/elsewhere', undefined, w.now), null, 'a repo with no runner there is never held');
});

test("CI health never reads a held run's cancel as a red, and reads everything else", async () => {
  const body = { total_count: 2, workflow_runs: [{ id: 1 }, { id: 2 }] };
  const get = withoutHeld(
    async () => ({ status: 200, etag: 'e', body }),
    (run) => run === 1,
  );
  assert.deepEqual(await get('runs', null, undefined as never), { status: 200, etag: 'e', body: { total_count: 2, workflow_runs: [{ id: 2 }] } });
  const jobs = { status: 200, etag: 'e', body: { jobs: [] } };
  assert.equal(
    await withoutHeld(
      async () => jobs,
      () => true,
    )('jobs', null, undefined as never),
    jobs,
  );
});

// One job at a time (#1906; Josh, 2026-11-24, picked "One Citadel job, one Peek build").
const end = (r: Run, conclusion = 'success') => Object.assign(r, { status: 'completed', conclusion });

test('two heavy Citadel jobs queued together run one after the other, the second by itself', async () => {
  const w = world();
  await w.for(10 * MIN);
  const [a, b] = [w.heavy(), w.proof()];
  assert.deepEqual([await w.ask(a), await w.ask(b)], [true, false]);
  assert.equal(w.told.length, 1);
  assert.match(w.told[0].text, /is waiting: a heavy job is running \(heavy h0-1-x\), and Citadel runs one job at a time.*starts it again by itself/s);
  assert.doesNotMatch(w.told[0].text, /ships go first/);
  await w.for(30 * MIN);
  assert.deepEqual(w.posts, ['cancel 2'], 'the first is left alone, the second waits for all of it');
  end(a);
  await w.for(3 * MIN);
  assert.deepEqual(w.posts, ['cancel 2', 'rerun 2'], 'no settle time between two jobs');
  b.status = 'in_progress';
  assert.equal(await w.ask(b), true);
  const c = w.heavy();
  assert.equal(await w.ask(c), false, 'the one that came back holds the desktop');
});

test('three jobs run one after another, each let in when it asks again', async () => {
  const w = world();
  await w.for(10 * MIN);
  const [a, b, c] = [w.heavy(), w.heavy(), w.heavy()];
  assert.deepEqual([await w.ask(a), await w.ask(b), await w.ask(c)], [true, false, false]);
  await w.for(2 * MIN);
  for (const [done, next] of [
    [a, b],
    [b, c],
  ]) {
    end(done);
    await w.for(3 * MIN);
    assert.equal(w.posts.at(-1), `rerun ${next.id}`);
    next.status = 'in_progress';
    assert.equal(await w.ask(next), true, 'the one longer held is not in its way');
    await w.for(5 * MIN);
  }
  assert.deepEqual(w.posts, ['cancel 2', 'cancel 3', 'rerun 2', 'rerun 3']);
});

test('a restart stops none of the jobs that were let in beside one that ran past four hours', async () => {
  const w = world();
  await w.for(10 * MIN);
  const a = w.heavy();
  assert.equal(await w.ask(a), true);
  await w.for(SLOT_HOLD_MS + 5 * MIN);
  const b = w.proof();
  assert.equal(await w.ask(b), true);
  await w.for(20 * MIN);
  const v = world(w.now, w.settings.get('ci-hold') ?? null);
  v.runs = w.runs;
  await v.for(20 * MIN);
  assert.deepEqual([...w.posts, ...v.posts], []);
  assert.equal(await v.ask(v.proof()), false, 'the young one holds the desktop');
});

test('jobs let in while GitHub was unreadable run on when it is back', async () => {
  const w = world();
  await w.for(10 * MIN);
  w.down = true;
  const [a, b] = [w.heavy(), w.proof()];
  assert.deepEqual([await w.ask(a), await w.ask(b)], [true, true]);
  await w.for(5 * MIN);
  w.down = false;
  await w.for(20 * MIN);
  assert.deepEqual(w.posts, []);
  assert.equal(await w.ask(w.heavy()), false);
});

test('a job that waited goes before one that only just asks', async () => {
  const w = world();
  await w.for(10 * MIN);
  const [a, b] = [w.heavy(), w.proof()];
  assert.deepEqual([await w.ask(a), await w.ask(b)], [true, false]);
  await w.for(5 * MIN);
  end(a);
  await w.for(2 * MIN);
  const c = w.heavy();
  assert.equal(await w.ask(c), false);
  assert.equal(b.status, 'queued');
});

test("another scheme's heavy job neither waits for Citadel's nor holds it up", async () => {
  const w = world();
  await w.for(10 * MIN);
  const a = w.heavy();
  assert.equal(await w.ask(a), true);
  const peek = w.heavy({ repo: 'o/peek' });
  assert.equal((await w.hold.ask('o/peek', peek.id, w.now)).go, true);
  assert.equal(w.hold.why('o/peek', undefined, w.now), null);
  assert.match(w.hold.why(OWN, undefined, w.now) ?? '', /a heavy job is running/);
  await w.for(10 * MIN);
  assert.deepEqual(w.posts, []);
});

test('two jobs on runners whose workflows ask nothing: all but one are stopped', async () => {
  const w = world();
  await w.tick(); // past a restart's first look, which takes what runs as let in
  w.check({ head_branch: 'check/1' });
  w.early();
  await w.for(5 * MIN);
  assert.deepEqual(w.posts, ['cancel 2']);
});

test('a run GitHub leaves queued for over an hour holds up no check', async () => {
  const w = world();
  await w.for(10 * MIN);
  const lost = w.heavy({ status: 'queued' });
  await w.tick();
  const early = w.early({ head_branch: 'early/1' });
  assert.equal(await w.ask(early), false);
  lost.run_started_at = new Date(w.now - 61 * MIN).toISOString();
  await w.tick();
  const next = w.check({ head_branch: 'check/2' });
  assert.equal(await w.ask(next), true);
});

test("main's full run held for hours still goes before optional work in the first gap", async () => {
  const w = world();
  w.line = 1;
  const heavy = w.heavy();
  const main = w.main({ status: 'queued' });
  await w.for(3 * 60 * MIN);
  const check = w.check({ head_branch: 'check/2' });
  assert.equal(await w.ask(check), true, 'meanwhile a ship checks itself');
  await w.tick();
  end(check);
  w.line = 0;
  assert.match(w.hold.why(OWN, undefined, w.now)!, /main's full test run goes first/);
  await w.tick();
  await w.for(2 * MIN);
  assert.ok(w.posts.includes(`rerun ${main.id}`));
  assert.ok(!w.posts.includes(`rerun ${heavy.id}`));
});

test("main's full run that ships held for 4 hours runs beside a ship's tests", async () => {
  const w = world();
  await w.for(10 * MIN);
  w.land({ id: 50 });
  await w.tick();
  const main = w.main();
  assert.equal(await w.ask(main), false);
  // The ships that keep it waiting: each a run of its own, none of an hour.
  const ships = async (ms: number) => {
    for (let t = 0; t < ms; t += 10 * MIN) {
      w.runs.find((r) => r.id === 50)!.run_started_at = new Date(w.now).toISOString();
      await w.for(10 * MIN);
    }
  };
  await ships(MAIN_WAIT_MS - 10 * MIN);
  assert.ok(!w.posts.includes(`rerun ${main.id}`));
  await ships(20 * MIN);
  assert.ok(w.posts.includes(`rerun ${main.id}`));
  main.status = 'in_progress';
  assert.equal(await w.ask(main), true);
  await w.for(10 * MIN);
  assert.equal(main.status, 'in_progress', 'and is not stopped again');
});

test("a ship's run stops whatever runs within a minute: a check, an early run, main's", async () => {
  for (const kind of ['check', 'early', 'main'] as const) {
    const w = world();
    await w.for(10 * MIN);
    const low = w[kind]();
    if (kind !== 'main') w.refs.add(low.head_branch);
    assert.equal(await w.ask(low), true, kind);
    await w.tick();
    const land = w.land({ status: 'queued' });
    await w.tick();
    await w.tick();
    assert.deepEqual(w.posts, ['cancel 1'], kind);
    assert.equal(w.told.length, 0, 'no mail about a check');
    await w.for(3 * MIN);
    end(land);
    await w.for(3 * MIN);
    assert.deepEqual(w.posts, ['cancel 1', 'rerun 1'], `${kind} comes back by itself`);
  }
});

test('a check or early run whose branch is gone is let go, and a light check never comes back', async () => {
  for (const add of [(w: ReturnType<typeof world>) => w.check(), (w: ReturnType<typeof world>) => w.early(), (w: ReturnType<typeof world>) => w.add('heavy ship1-1-x', { file: 'citadel-heavy.yml', head_branch: 'main' })]) {
    const w = world();
    w.refs.add('main');
    await w.for(10 * MIN);
    const low = add(w);
    assert.equal(await w.ask(low), true);
    const land = w.land();
    await w.for(2 * MIN);
    end(land);
    await w.for(10 * MIN);
    assert.deepEqual(w.posts, ['cancel 1']);
    assert.deepEqual(w.settings.get('ci-hold'), []);
  }
});

test('a check or early run starts only on an idle desktop: not beside a run, nor with one queued; ships in line with no run are no bar', async () => {
  const w = world();
  w.line = 2;
  await w.for(10 * MIN);
  assert.equal(await w.ask(w.check()), true, 'a ship deploying uses no desktop');
  const v = world();
  v.land();
  await v.tick();
  assert.equal(await v.ask(v.check()), false);
  const u = world();
  await u.for(10 * MIN);
  u.heavy({ status: 'queued' });
  await u.tick();
  assert.equal(await u.ask(u.check()), false, 'one is queued');
  const t = world();
  await t.for(10 * MIN);
  const heavy = t.heavy();
  assert.equal(await t.ask(heavy), true);
  assert.equal(await t.ask(t.check()), false, 'one is running, and is not stopped for a check');
  assert.deepEqual(t.posts, ['cancel 2']);
});

test("main's run waits for a check that runs, and goes before an optional job that waits", async () => {
  const w = world();
  await w.for(10 * MIN);
  const check = w.check();
  assert.equal(await w.ask(check), true);
  const [proof, main] = [w.proof(), w.main()];
  assert.equal(await w.ask(proof), false);
  assert.equal(await w.ask(main), false);
  await w.for(2 * MIN);
  end(check);
  await w.for(2 * MIN);
  assert.deepEqual(w.posts, ['cancel 2', 'cancel 3', 'rerun 3'], 'main first');
  Object.assign(main, { status: 'in_progress' });
  await w.for(5 * MIN);
  end(main);
  await w.for(SETTLE_DAY_MS + 2 * MIN);
  assert.equal(w.posts.at(-1), 'rerun 2');
});

test('a job behind another that never ends goes after four hours, and is not stopped for it again', async () => {
  const w = world();
  await w.for(10 * MIN);
  const [a, b] = [w.heavy(), w.proof()];
  assert.deepEqual([await w.ask(a), await w.ask(b)], [true, false]);
  await w.for(SLOT_HOLD_MS - 5 * MIN);
  assert.ok(!w.posts.includes('rerun 2'));
  await w.for(10 * MIN);
  assert.equal(w.posts.at(-1), 'rerun 2');
  b.status = 'in_progress';
  assert.equal(await w.ask(b), true);
  await w.for(10 * MIN);
  assert.equal(w.posts.at(-1), 'rerun 2');
  assert.equal(a.status, 'in_progress', 'the long one is left to end');
  assert.equal(w.hold.why(OWN, w.now - SLOT_WAIT_MS, w.now), null, 'one not dispatched yet waits a day at most');
});

test('a job that waited a day behind others goes beside them', async () => {
  const w = world();
  await w.for(10 * MIN);
  const [a, b] = [w.heavy(), w.heavy()];
  assert.deepEqual([await w.ask(a), await w.ask(b)], [true, false]);
  const saved = (w.settings.get('ci-hold') as Record<string, unknown>[]).map((h) => ({ ...h, behind: w.now - SLOT_WAIT_MS }));
  const v = world(w.now, saved);
  v.runs = w.runs;
  await v.for(SETTLE_DAY_MS + 2 * MIN);
  assert.equal(v.posts.at(-1), 'rerun 2');
  b.status = 'in_progress';
  await v.for(10 * MIN);
  assert.deepEqual(v.posts, ['rerun 2'], 'and is not stopped again');
});

test('the one-job wait fails open and turns off: GitHub unread, hold-off', async () => {
  const w = world();
  await w.for(10 * MIN);
  const [a, b] = [w.heavy(), w.proof()];
  assert.equal(await w.ask(a), true);
  w.down = true;
  await w.for(3 * MIN);
  assert.equal(await w.ask(b), true);
  w.down = false;
  w.off = true;
  await w.tick();
  const c = w.heavy();
  assert.equal(await w.ask(c), true);
  assert.equal(w.hold.why(OWN, undefined, w.now), null);
  assert.deepEqual(w.posts, []);
});

test('a job started again that no runner takes gives its place up, and one that ended frees it', async () => {
  const w = world();
  await w.for(10 * MIN);
  const [a, b] = [w.heavy(), w.heavy()];
  assert.deepEqual([await w.ask(a), await w.ask(b)], [true, false]);
  end(a);
  await w.for(2 * MIN);
  assert.equal(w.posts.at(-1), 'rerun 2');
  const c = w.add('heavy other-1-x', { file: 'citadel-heavy.yml' });
  assert.equal(await w.ask(c), false, 'the one started again has the place');
  await w.for(12 * MIN);
  assert.equal(w.posts.at(-1), 'rerun 3', 'ten minutes with no runner');
});

test('a restart keeps one job at a time, and jobs the old server held come back', async () => {
  const w = world();
  await w.for(10 * MIN);
  const [a, b] = [w.heavy(), w.heavy()];
  assert.deepEqual([await w.ask(a), await w.ask(b)], [true, false]);
  // As #1902 saved it: no branch, no behind.
  const saved = (w.settings.get('ci-hold') as Record<string, unknown>[]).map(({ behind: _b, ...h }) => h);
  const v = world(w.now, saved);
  v.runs = w.runs;
  await v.for(5 * MIN);
  assert.equal(await v.ask(v.add('heavy c-1-x', { file: 'citadel-heavy.yml' })), false, 'the running one is found again');
  assert.deepEqual(v.posts, ['cancel 3']);
  end(a);
  await v.for(SETTLE_DAY_MS + 2 * MIN);
  assert.equal(v.posts.at(-1), 'rerun 2');
});

test('the CI page has what runs and what it keeps waiting', async () => {
  const w = world();
  await w.for(10 * MIN);
  const a = w.heavy();
  assert.equal(await w.ask(a), true);
  const rows = (sees = true) => heldRows(w.hold.state(w.now), { getTicket: () => ({ number: 7, project_id: 2 }), getProject: () => undefined } as never, () => sees);
  await w.tick();
  assert.match(rows().busy ?? '', /a heavy job is running/);
  assert.equal(rows(false).busy, 'another Citadel job is running', 'without its name for someone who does not see its scheme');
  assert.deepEqual(rows(false).running, []);
  w.land();
  await w.tick();
  assert.deepEqual(
    rows().running.map((r) => r.kind),
    ['heavy', 'ship'],
  );
});

test('what else gives way to ships is told of one in line, and of none with the hold off', async () => {
  const w = world();
  w.line = 1;
  await w.tick();
  assert.equal(w.hold.shipNow(w.now), 'a ship is in line');
  w.off = true;
  await w.tick();
  assert.equal(w.hold.shipNow(w.now), null);
});

// One flake proof beside ships (Josh, 2026-11-25, picked "Let them run, one at a time").
const proofs = (w: ReturnType<typeof world>, n: number) => Array.from({ length: n }, (_, i) => w.add(`flake-proof test/${i}.test.ts`, { file: 'flake-proof.yml' }));
const onNow = (runs: Run[]) => runs.filter((r) => r.status !== 'completed').length;

test('a proof starts and runs on beside a ship, and one that joins does not stop it', async () => {
  const w = world();
  w.line = 1;
  const land = w.land();
  const p = w.proof();
  assert.equal(await w.ask(p), true, 'asked with a ship testing');
  await w.for(20 * MIN);
  end(land);
  w.line = 0;
  await w.for(2 * MIN);
  w.line = 3;
  w.land();
  await w.for(20 * MIN);
  assert.deepEqual(w.posts, []);
  assert.deepEqual(w.told, []);
});

test('a second proof is held, told why, and starts when the first ends, oldest first, ships in line or not', async () => {
  const w = world();
  w.line = 1;
  w.land();
  const all = proofs(w, 4);
  await w.tick();
  for (const [i, p] of all.entries()) assert.equal(await w.ask(p), i === 0);
  assert.match(w.told[0].text, /another flake proof is running \(flake-proof test\/0\.test\.ts\), and they run one at a time.*counted from zero.*once that has ended/s);
  assert.doesNotMatch(w.told[0].text, /ships go first/);
  for (const [i, p] of all.entries()) {
    for (let t = 0; t < 6 * MIN; t += 15_000) {
      await w.tick();
      assert.ok(onNow(all) <= 1, 'never two');
      if (p.status === 'queued') {
        p.status = 'in_progress';
        assert.equal(await w.ask(p), true);
      }
    }
    assert.equal(p.status, 'in_progress', `proof ${i}`);
    const left = w.hold.state(w.now).held.filter((h) => h.phase === 'held');
    assert.ok(
      left.every((h) => h.why.includes(`test/${i}.test.ts`)),
      'what is held says which one it waits for',
    );
    end(p);
  }
  assert.deepEqual(w.posts, ['cancel 3', 'cancel 4', 'cancel 5', 'rerun 3', 'rerun 4', 'rerun 5']);
});

test('a heavy job still waits for ships, and for a proof with none in line; it goes before the next proof', async () => {
  const w = world();
  await w.for(10 * MIN);
  w.line = 1;
  const [a, b] = proofs(w, 2);
  const h = w.heavy();
  assert.deepEqual([await w.ask(a), await w.ask(b), await w.ask(h)], [true, false, false]);
  assert.match(w.hold.why(OWN, undefined, w.now) ?? '', /a ship is in line/);
  w.line = 0;
  await w.for(SETTLE_DAY_MS + 2 * MIN);
  assert.equal(h.status, 'completed', 'not beside a proof');
  assert.match(w.hold.why(OWN, undefined, w.now) ?? '', /a flake proof is running/);
  end(a);
  await w.for(2 * MIN);
  assert.equal(h.status, 'queued');
  assert.equal(b.status, 'completed', 'the proof waits for it');
  h.status = 'in_progress';
  assert.equal(await w.ask(h), true);
  w.line = 1;
  await w.for(2 * MIN);
  assert.equal(h.status, 'completed', 'a ship stops the heavy job');
  assert.equal(b.status, 'queued', 'and the proof has the time beside it');
});

test("a proof holds up no ship: not its run, its own check nor the early next train's run", async () => {
  const w = world();
  w.line = 2;
  const [a, b] = proofs(w, 2);
  assert.equal(await w.ask(a), true);
  b.status = 'queued'; // waits for a runner
  await w.tick();
  const check = w.check();
  assert.equal(await w.ask(check), true);
  await w.for(5 * MIN);
  end(check);
  await w.for(2 * MIN);
  const early = w.early();
  assert.equal(await w.ask(early), true);
  w.land();
  await w.for(5 * MIN);
  assert.deepEqual(w.posts, ['cancel 4'], "only the early run, for the ship's");
});

test("no proof starts while a ship's failed tests run again alone; one that runs goes on", async () => {
  const w = world();
  w.line = 1;
  const land = w.land();
  const a = w.proof();
  await w.tick();
  w.retries.add(land.id);
  assert.equal(await w.ask(a), false);
  assert.match(w.told[0].text, /a ship's failed tests are running again alone/);
  await w.for(3 * MIN);
  assert.deepEqual(w.posts, ['cancel 2']);
  w.retries.clear();
  await w.for(2 * MIN);
  assert.equal(a.status, 'queued');
  a.status = 'in_progress';
  assert.equal(await w.ask(a), true);
  w.retries.add(land.id);
  const n = w.posts.length;
  await w.for(3 * MIN);
  assert.equal(w.posts.length, n, 'left running');
});

test('a retry GitHub does not tell holds no proof', async () => {
  const w = world();
  w.land();
  await w.tick();
  w.down = true;
  const p = w.proof();
  assert.equal(await w.ask(p), true);
});

test('proofs held before the change come back one by one, ships in line all day', async () => {
  const row = (run: number) => ({
    repo: OWN,
    run,
    kind: 'proof',
    what: `flake-proof test/${run - 1}.test.ts`,
    url: `https://gh/${run}`,
    ticket: 7,
    since: DAY - 5 * 3600_000 + run,
    why: run % 2 ? 'a ship is in line' : 'a flake proof is running (flake-proof test/z.test.ts), and Citadel runs one job at a time on the CI desktop',
    phase: 'held',
    at: DAY - 3600_000,
    attempt: 2,
    stops: 2,
    misses: 0,
    behind: DAY - 2 * SLOT_WAIT_MS,
  });
  const w = world(DAY, [1, 2, 3].map(row));
  const all = proofs(w, 3);
  for (const p of all) Object.assign(p, { status: 'completed', conclusion: 'cancelled', run_attempt: 2 });
  w.line = 2;
  w.land();
  for (const p of all) {
    await w.for(MIN);
    assert.equal(p.status, 'queued');
    p.status = 'in_progress';
    assert.equal(await w.ask(p), true);
    await w.for(5 * MIN);
    assert.equal(onNow(all), 1);
    end(p);
    await w.tick();
  }
  assert.deepEqual(w.posts, ['rerun 1', 'rerun 2', 'rerun 3']);
});

test("main's run stops a proof once it may start, not while it waits for ships itself", async () => {
  const w = world();
  w.line = 1;
  const p = w.proof();
  await w.tick();
  assert.equal(await w.ask(p), true);
  const main = w.main();
  assert.equal(await w.ask(main), false);
  await w.for(5 * MIN);
  assert.deepEqual(w.posts, ['cancel 2']);
  w.line = 0;
  await w.tick();
  w.line = 1;
  await w.for(5 * MIN);
  assert.deepEqual(w.posts, ['cancel 2'], 'a momentary gap starts no main, so it stops no proof');
  w.line = 0;
  await w.for(MAIN_SETTLE_MS + 2 * MIN);
  assert.deepEqual(w.posts, ['cancel 2', 'cancel 1', 'rerun 2']);
  assert.match(w.told[0].text, /main's full test run goes first.*counted from zero/s);
  assert.doesNotMatch(w.told[0].text, /ships go first/);
  main.status = 'in_progress';
  assert.equal(await w.ask(main), true);
  await w.for(5 * MIN);
  end(main);
  await w.for(2 * MIN);
  assert.equal(w.posts.at(-1), 'rerun 1', 'back without the settle time');
});

test('a proof that waits for a runner keeps its turn, through a restart too', async () => {
  const w = world();
  w.line = 1;
  const all = proofs(w, 3);
  await w.tick();
  for (const p of all) await w.ask(p);
  end(all[0]);
  await w.for(30 * MIN);
  assert.equal(all[1].status, 'queued');
  assert.equal(onNow(all), 1, 'no other is started behind a busy runner');
  const v = world(w.now, w.settings.get('ci-hold'));
  v.line = 1;
  v.runs = w.runs;
  await v.for(30 * MIN);
  assert.deepEqual(v.posts, []);
  all[1].status = 'in_progress';
  assert.equal(await v.ask(all[1]), true);
  assert.equal(await v.ask(v.proof()), false);
});

test('a proof held for a day is reported as waiting for its turn, not for ships', async () => {
  const w = world();
  w.line = 1;
  const [a, b] = proofs(w, 2);
  await w.tick();
  assert.deepEqual([await w.ask(a), await w.ask(b)], [true, false]);
  Object.assign(w.hold.state(w.now).held[0], { since: w.now - REPORT_MS });
  await w.tick();
  assert.match(w.reports[0], /one at a time/);
  assert.doesNotMatch(w.reports[0], /line is empty/);
});
