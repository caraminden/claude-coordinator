import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CiHold, type HoldState, isNight, MAIN_WAIT_MS, REPORT_MS, SETTLE_DAY_MS, SETTLE_NIGHT_MS, withoutHeld } from '../src/ci-hold.ts';

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

test('a ship joining the line stops a running proof within a minute, and tells its minion once', async () => {
  const w = world();
  w.proof();
  await w.for(10 * MIN);
  assert.deepEqual(w.posts, [], 'an empty line stops nothing');
  w.line = 1;
  await w.tick();
  assert.deepEqual(w.posts, ['cancel 1']);
  assert.equal(w.hold.isHeld(1), true, 'its cancelled end is not news');
  await w.for(5 * MIN);
  assert.equal(w.told.length, 1);
  assert.equal(w.told[0].ticket, 7);
  assert.match(w.told[0].text, /a ship is in line.*starts it again by itself.*from zero.*don't start it again/s);
});

test('the proof comes back by itself once the line has been empty for the settle time, and is left alone after', async () => {
  const w = world();
  w.proof();
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
  w.proof();
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
  w.proof({ status: 'queued' });
  await w.for(3 * 3600_000);
  assert.deepEqual(w.posts, ['cancel 1']);
  assert.equal((await w.hold.ask(OWN, 1, w.now)).go, false);
});

test('a ship whose tests run counts, whatever the line reads: its retry has the desktop to itself', async () => {
  const w = world();
  const land = w.land();
  w.proof();
  await w.tick();
  assert.deepEqual(w.posts, ['cancel 2']);
  await w.for(10 * MIN);
  assert.deepEqual(w.posts, ['cancel 2']);
  Object.assign(land, { status: 'completed', conclusion: 'success' });
  await w.for(SETTLE_DAY_MS + MIN);
  assert.deepEqual(w.posts, ['cancel 2', 'rerun 2']);
});

test("a ship's own runs are never stopped: land, check, an early run, a ship's light check", async () => {
  const w = world();
  w.line = 3;
  w.land();
  w.add('check', { file: 'tests.yml', head_branch: 'check/9' });
  w.add('early', { file: 'tests.yml', head_branch: 'early/9' });
  w.add('heavy shipabc-1-x', { file: 'citadel-heavy.yml' });
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

test("main's run waits for ships off the runner, is back first when they end, and after 30 minutes goes anyway", async () => {
  const w = world();
  w.line = 1;
  w.proof();
  w.main({ status: 'queued' });
  await w.tick();
  assert.deepEqual([...w.posts].sort(), ['cancel 1', 'cancel 2']);
  assert.equal(w.told.length, 1, 'main has no minion to tell');
  w.line = 0;
  await w.tick();
  await w.tick();
  assert.deepEqual(w.posts.slice(2), ['rerun 2'], 'no settle time for main');
  await w.for(20 * MIN);
  assert.ok(!w.posts.includes('rerun 1'), 'the proof waits for it');

  const v = world();
  v.line = 1;
  v.main({ status: 'queued' });
  await v.for(MAIN_WAIT_MS + MIN);
  assert.deepEqual(v.posts, ['cancel 1', 'rerun 1']);
  assert.equal((await v.hold.ask(OWN, 1, v.now)).go, true, 'and it is not stopped again');
  v.runs[0].status = 'in_progress';
  await v.for(10 * MIN);
  assert.equal(v.posts.length, 2);
});

test('a job that asks while a ship waits is stopped and kept; asked with the line empty it goes', async () => {
  const w = world();
  await w.for(10 * MIN);
  w.proof();
  assert.deepEqual(await w.hold.ask(OWN, 1, w.now), { go: true, why: null });
  w.line = 1;
  assert.deepEqual(await w.hold.ask(OWN, 1, w.now), { go: false, why: 'a ship is in line' });
  assert.deepEqual(w.posts, ['cancel 1']);
});

test('night: a ship still stops a proof, and the settle time is shorter', async () => {
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
  w.proof();
  w.line = 1;
  await w.for(MIN);
  w.line = 0;
  await w.for(SETTLE_NIGHT_MS + 30_000);
  assert.deepEqual(w.posts, ['cancel 1', 'rerun 1']);
});

test('a job held over 24 hours is reported once, not while it is under', async () => {
  const w = world();
  w.line = 1;
  w.proof();
  await w.tick();
  await w.tick(REPORT_MS - MIN);
  assert.equal(w.reports.length, 0);
  await w.for(10 * MIN);
  assert.equal(w.reports.length, 1);
  assert.match(w.reports[0], /flake-proof test\/x\.test\.ts.*a ship is in line/s);
  const again = world(w.now, w.settings.get('ci-hold'));
  again.runs = w.runs;
  again.line = 1;
  await again.for(5 * MIN);
  assert.equal(again.reports.length, 0, 'a restart does not say it again');
});

test('the off switch: nothing is stopped or held, and what was held comes back at once', async () => {
  const w = world();
  w.line = 1;
  w.proof();
  await w.for(MIN);
  w.off = true;
  await w.tick();
  assert.deepEqual(w.posts, ['cancel 1', 'rerun 1']);
  w.proof();
  await w.for(10 * MIN);
  assert.equal(w.posts.length, 2);
  assert.equal((await w.hold.ask(OWN, 2, w.now)).go, true);
  assert.deepEqual([w.published!.off, w.published!.why], [true, null]);
});

test('GitHub down: no ship waits on the hold, a job that asks goes ahead, and the hold picks up after', async () => {
  const w = world();
  w.proof();
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
  w.proof();
  w.line = 1;
  await w.tick();
  const b = world(w.now, w.settings.get('ci-hold'));
  b.runs = w.runs;
  await b.for(SETTLE_DAY_MS + MIN);
  assert.deepEqual(b.posts, ['rerun 1']);
});

test('a run that ended by itself before its cancel keeps its result', async () => {
  const w = world();
  const p = w.proof();
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
  w.proof();
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
  const p = w.proof();
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
  const other = w.proof();
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
  const p = w.proof();
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
  w.proof();
  const other = w.add('flake-proof test/y.test.ts', { file: 'flake-proof.yml' });
  await w.for(5_000);
  w.runs.shift();
  w.line = 0;
  await w.for(10 * MIN);
  assert.equal(other.status, 'queued');
});

test('switched off, a run being stopped gets no more cancels', async () => {
  const w = world();
  w.line = 1;
  w.proof();
  w.answer = async () => ({ status: 500 });
  await w.tick();
  w.off = true;
  await w.for(10 * MIN);
  assert.deepEqual(w.posts, ['cancel 1']);
});

test('a ship run GitHub left queued for over an hour holds nothing', async () => {
  const w = world();
  w.land({ status: 'queued', run_started_at: new Date(DAY - 61 * MIN).toISOString() });
  w.proof();
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
  const ours = w.proof();
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
