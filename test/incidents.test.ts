import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { ALIVE_KEY, ciEntries, DOWN_MS, group, Incidents, journalEntries, loadEntries, QUIET_MS, readCiRuns, readDeploys, RED_COUNT, redTrigger, render, stallTrigger, STATE_KEY, step, STILL_MS, stopsTrigger, type CiRun, type IncidentState, type InLine, type RedJob, type Sources } from '../src/incidents.ts';
import { stopEvent } from '../src/sd-watchdog.ts';
import { git, makeRepo } from './git.ts';

// Incident timelines (#1145): one timeline per incident, from what is already recorded, and one ask to the Taskmaster.
const root = mkdtempSync(join(tmpdir(), 'incidents-'));
after(() => rmSync(root, { recursive: true, force: true }));
const MIN = 60_000;
const T0 = Date.parse('2026-11-17T09:44:00Z'); // Nov 17 01:44 PST, the clock storm's first red
let dbs = 0;

const clockRun = (i: number, at: number): CiRun => ({ id: 1000 + i, workflow: 'tests', branch: `land/ticket/${860 + i}-x`, conclusion: 'failure', created: at - 12_000, updated: at, url: `https://github.com/o/r/actions/runs/${1000 + i}`, failed: "test › the runner's clock", runner: 'DESKTOP-linux-2' });

function setup(bootAt = T0 - 60 * MIN) {
  const store = new Store(join(root, `t-${++dbs}.db`));
  const clock = { now: bootAt };
  const told: string[] = [];
  const files: { name: string; text: string }[] = [];
  let line: InLine[] = [];
  let jobs: RedJob[] = [];
  let ci: CiRun[] = [];
  let crash = false;
  const sources: Sources = {
    deploys: async () => [{ at: T0 - 20 * MIN, sha: 'abcdef1234567890', subject: '#866: kit upload zone', how: 'pull -q --ff-only' }],
    ci: async (from, to) => ci.filter((r) => r.updated >= from && r.updated <= to),
    journal: async () => journalEntries(`${(T0 - 5 * MIN) / 1000}.000000 perigee node[42]: Land of #866 fell back to perigee`),
    dbPath: '/data/coordinator.db',
  };
  const make = () =>
    new Incidents({
      store,
      sources,
      bootAt,
      now: () => clock.now,
      line: () => line,
      jobs: () => jobs,
      write: (name, text) => {
        if (crash) throw new Error('the server stopped mid-write');
        files.push({ name, text });
        return `/shared/reports/${name}`;
      },
      tell: (text) => (told.push(text), true),
    });
  return { store, clock, told, files, make, setLine: (l: InLine[]) => (line = l), setJobs: (j: RedJob[]) => (jobs = j), setCi: (c: CiRun[]) => (ci = c), setCrash: (c: boolean) => (crash = c) };
}

test('a two-hour storm of red runs makes one timeline and one ask, written once it goes quiet', async () => {
  const s = setup();
  const inc = s.make();
  const runs = Array.from({ length: 36 }, (_, i) => clockRun(i, T0 + i * 3.6 * MIN));
  s.setCi([...runs, { ...clockRun(99, T0 + 133 * MIN), conclusion: 'success', failed: null, branch: 'land/ticket/900-y' }]);
  for (let t = T0 - 10 * MIN; t <= T0 + 4 * 60 * MIN; t += MIN) {
    s.clock.now = t;
    // ci-health's `recent`: a day of jobs, as it last read them.
    s.setJobs(runs.filter((r) => r.updated <= t).map((r) => ({ run_id: r.id, conclusion: 'failure', completed_at: new Date(r.updated).toISOString() })));
    await inc.tick();
  }
  assert.equal(s.files.length, 1, 'one timeline, not one per red');
  assert.equal(s.told.length, 1);
  const text = s.files[0].text;
  assert.equal(s.files[0].name, 'incident-2026-11-17-0144.md');
  assert.match(text, /a burst of red CI runs/);
  // The clock step reads as the cause of the red runs, from the first one, and the 36 reds are one counted line.
  assert.match(text, /First failed CI run: \*\*Nov 17, 01:44 PST\*\* · CI · tests failed at test › the runner's clock on DESKTOP-linux-2 \(land\/ticket\/860-x ×1, [^)]*\+32 more\)/);
  assert.match(text, /Most repeated: 36× CI: tests failed at test › the runner's clock \([^)]*\+32 more\), Nov 17, 01:44 PST to Nov 17, 03:50 PST/);
  assert.match(text, /- \*\*Nov 17, 01:24 PST\*\* · Deploy · the live checkout moved to abcdef12/);
  assert.match(text, /Journal · Land of #866 fell back to perigee/);
  const timeline = text.slice(text.indexOf('## Timeline'));
  assert.ok(timeline.indexOf('· Deploy ·') < timeline.indexOf('· Journal ·') && timeline.indexOf('· Journal ·') < timeline.indexOf('· CI · tests failed'), 'the timeline is in time order');
  assert.match(text, /- CI runs: 37 runs, 36 failed/);
  assert.match(s.told[0], /^Incident from Nov 17, 01:44 PST to Nov 17, 03:50 PST: a burst of red CI runs/);
  assert.equal(s.told[0].split('a burst of red CI runs').length, 2, 'one storm gives one reason, not one per new count');
  assert.match(s.told[0], /\/shared\/reports\/incident-2026-11-17-0144\.md/);
  assert.match(s.told[0], /start a research minion/);
  // The storm's reds still in ci-health's window don't reopen it.
  const st = s.store.getSetting<IncidentState>(STATE_KEY)!;
  assert.equal(st.open, null);
  assert.equal(st.done.length, 1);
});

test('a burst after an incident closed is a new one', async () => {
  const s = setup();
  const inc = s.make();
  const burst = (start: number) => Array.from({ length: RED_COUNT }, (_, i) => ({ run_id: start + i, conclusion: 'failure', completed_at: new Date(start + i * MIN).toISOString() }));
  const first = burst(T0),
    second = burst(T0 + 3 * 60 * MIN);
  for (let t = T0; t <= T0 + 5 * 60 * MIN; t += MIN) {
    s.clock.now = t;
    s.setJobs([...first, ...second].filter((j) => Date.parse(j.completed_at) <= t));
    await inc.tick();
  }
  assert.equal(s.files.length, 2);
});

test('the server down: a heartbeat gap at boot is an incident; a deploy restart is not', async () => {
  const s = setup(T0);
  s.store.setSetting(ALIVE_KEY, T0 - 2 * MIN);
  s.store.setSetting(STATE_KEY, { open: null, after: 0, done: [] });
  const quick = s.make();
  quick.boot();
  await quick.tick();
  assert.equal(s.store.getSetting<IncidentState>(STATE_KEY)!.open, null, 'a two-minute restart is a deploy');

  const s2 = setup(T0);
  s2.store.setSetting(ALIVE_KEY, T0 - 40 * MIN);
  s2.store.setSetting(STATE_KEY, { open: null, after: 0, done: [] });
  const inc = s2.make();
  inc.boot();
  await inc.tick();
  const open = s2.store.getSetting<IncidentState>(STATE_KEY)!.open!;
  assert.equal(open.from, T0 - 40 * MIN);
  assert.match(open.why[0], /the server was down from Nov 17, 01:04 PST to Nov 17, 01:44 PST \(no heartbeat for 40 min\)/);
  s2.clock.now = T0 + QUIET_MS;
  await inc.tick();
  assert.equal(s2.files.length, 1);
  assert.ok(DOWN_MS <= 5 * MIN);
});

test("#1135's watchdog restart, recorded as a health event, opens an incident; older ones don't", async () => {
  const s = setup(T0);
  s.store.addHealthEvent('watchdog', T0 - 60 * MIN, null, 'old restart');
  const inc = s.make();
  await inc.tick();
  assert.equal(s.store.getSetting<IncidentState>(STATE_KEY)!.open, null, 'from before the first boot with this code');
  s.store.addHealthEvent('watchdog', T0 + MIN, null, 'restarted: the loop stalled');
  s.clock.now = T0 + 2 * MIN;
  await inc.tick();
  assert.match(s.store.getSetting<IncidentState>(STATE_KEY)!.open!.why[0], /systemd's watchdog restarted the hung server/);
});

test('an incident closing across a restart keeps its timeline and its ask (B2)', async () => {
  const s = setup(T0);
  const inc = s.make();
  await inc.tick();
  s.store.addHealthEvent('watchdog', T0 + MIN, null, 'restarted');
  s.clock.now = T0 + 2 * MIN;
  await inc.tick();
  s.setCrash(true);
  s.clock.now = T0 + MIN + QUIET_MS;
  await assert.rejects(inc.tick(), /mid-write/);
  assert.ok(s.store.getSetting<IncidentState>(STATE_KEY)!.open, 'the incident stays open until its timeline is written');
  s.setCrash(false);
  s.clock.now += MIN;
  const after = s.make(); // the restart
  after.boot();
  assert.equal(await after.tick(), `/shared/reports/${s.files[0]?.name}`);
  assert.equal(s.files.length, 1);
  assert.equal(s.told.length, 1);
  const st = s.store.getSetting<IncidentState>(STATE_KEY)!;
  assert.equal(st.open, null);
  assert.equal(st.done.length, 1);
});

test('a second watchdog restart while an incident is open joins it, not a new one (B3)', async () => {
  const s = setup(T0);
  const inc = s.make();
  await inc.tick();
  s.store.addHealthEvent('watchdog', T0 + MIN, null, 'first');
  s.clock.now = T0 + 2 * MIN;
  await inc.tick();
  s.store.addHealthEvent('watchdog', T0 + 4 * MIN, null, 'second');
  s.clock.now = T0 + 5 * MIN;
  await inc.tick();
  const open = s.store.getSetting<IncidentState>(STATE_KEY)!.open!;
  assert.equal(open.last, T0 + 4 * MIN, 'the second restart widens the open incident');
  assert.equal(open.why.length, 2);
  s.clock.now = T0 + 4 * MIN + QUIET_MS;
  await inc.tick();
  s.clock.now += 40 * MIN;
  await inc.tick();
  assert.equal(s.files.length, 1, 'one incident, one timeline');
  assert.equal(s.store.getSetting<IncidentState>(STATE_KEY)!.open, null);
});

test('the ship line standing still for 15 minutes is an incident; a moving one is not', async () => {
  const s = setup(T0);
  const inc = s.make();
  s.setLine([
    { seq: 7, got: 1, label: '#866', phase: 'ci' },
    { seq: 8, got: 0, label: '#867', phase: '' },
  ]);
  for (let t = T0; t < T0 + STILL_MS; t += MIN) {
    s.clock.now = t;
    await inc.tick();
  }
  assert.equal(s.store.getSetting<IncidentState>(STATE_KEY)!.open, null);
  s.clock.now = T0 + STILL_MS;
  await inc.tick();
  s.clock.now = T0 + STILL_MS + 5 * MIN;
  await inc.tick();
  assert.equal(s.store.getSetting<IncidentState>(STATE_KEY)!.open!.why.length, 1, 'one stall, one reason');
  assert.match(s.store.getSetting<IncidentState>(STATE_KEY)!.open!.why[0], /^the ship line stood still from Nov 17, 01:44 PST \(#866, ci\)$/);

  const m = setup(T0);
  const moving = m.make();
  for (let t = T0; t <= T0 + 40 * MIN; t += MIN) {
    m.clock.now = t;
    m.setLine([{ seq: 7, got: 1, label: '#866', phase: ['rebase', 'ci', 'tests', 'deploy'][Math.floor((t - T0) / (10 * MIN))] }]);
    await moving.tick();
  }
  assert.equal(m.store.getSetting<IncidentState>(STATE_KEY)!.open, null);
});

test('step: a trigger while one is open widens it; an old sign never reopens a closed one', () => {
  let st: IncidentState = { open: null, after: 0, done: [] };
  st = step(st, [{ from: 100, last: 200, why: 'a' }], 200).state;
  st = step(
    st,
    [
      { from: 50, last: 300, why: 'b' },
      { from: 60, last: 250, why: 'a' },
    ],
    300,
  ).state;
  assert.deepEqual(st.open, { from: 50, last: 300, why: ['a', 'b'] });
  const r = step(st, [], 300 + QUIET_MS);
  assert.deepEqual(r.close, { from: 50, last: 300, why: ['a', 'b'] });
  assert.equal(r.state.after, 300);
  assert.equal(step(r.state, [{ from: 50, last: 300, why: 'a' }], 400 + QUIET_MS).state.open, null);
});

test('redTrigger: five failed runs in half an hour, counted once each, after the last incident', () => {
  const j = (run: number, min: number, conclusion = 'failure') => ({ run_id: run, conclusion, completed_at: new Date(T0 + min * MIN).toISOString() });
  const four = [j(1, 1), j(2, 2), j(3, 3), j(4, 4), j(4, 4), j(5, 5, 'success'), j(6, 6, 'cancelled')];
  assert.equal(redTrigger(four, 0, T0 + 10 * MIN), null);
  const five = [...four, j(7, 9)];
  assert.deepEqual(redTrigger(five, 0, T0 + 10 * MIN), { from: T0 + MIN, last: T0 + 9 * MIN, why: 'a burst of red CI runs (5 or more failed within 30 min)' });
  assert.equal(redTrigger(five, T0 + 2 * MIN, T0 + 10 * MIN), null, 'reds an earlier incident covered');
  assert.equal(redTrigger(five, 0, T0 + 40 * MIN), null, 'outside the half hour');
});

test('journal, load and grouping read what they should', () => {
  const lines = journalEntries(
    [
      '1763372640.500000 perigee node[42]: The event loop was held for 1.2 s: Running: 70% listTickets',
      '1763372700.000000 perigee node[42]: The event loop was held for 0.7 s: Running: 70% listTickets',
      '1763372760.000000 perigee systemd[1]: claude-coordinator.service: Main process exited, code=killed',
      'garbage',
    ].join('\n'),
  );
  assert.equal(lines.length, 3);
  assert.equal(lines[0].at, 1763372640500);
  const g = group(lines);
  assert.equal(g.length, 2, 'the two stalls are one line');
  assert.equal(g[0].n, 2);
  assert.equal(g[0].last, 1763372700000);

  const s = (at: number, d: object) => ({ machine_id: 6, at, data: JSON.stringify({ host: 'DESKTOP', cpu: 5, mem_total: 100, mem_free: 50, ...d }) });
  const load = loadEntries([s(T0, {}), s(T0 + MIN, { cpu: 95 }), s(T0 + 2 * MIN, { cpu: 97 }), s(T0 + 3 * MIN, {}), s(T0 + 20 * MIN, { restarts: [T0 + 18 * MIN, T0 - 99 * MIN] }), s(T0 + 21 * MIN, { mem_free: 2, restarts: [T0 + 18 * MIN] })], T0 - MIN, T0 + 30 * MIN);
  assert.deepEqual(
    load.map((e) => e.text),
    ["DESKTOP's CPU at 90% or more for 2 min", "DESKTOP's load agent sent nothing for 17 min", 'DESKTOP came back from a restart with no clean shutdown', 'DESKTOP had under 5% memory free'],
  );
});

test('ciEntries and render: a green and a red read plainly, and the read-more lines name the window', () => {
  const e = ciEntries([clockRun(0, T0), { ...clockRun(1, T0 + MIN), conclusion: 'success', failed: null }]);
  assert.equal(e[0].text, "tests failed at test › the runner's clock on DESKTOP-linux-2 (land/ticket/860-x)");
  assert.equal(e[1].text, 'tests passed (land/ticket/861-x)');
  const text = render({ from: T0, last: T0 + MIN, why: ['why'] }, T0 - MIN, T0 + 2 * MIN, { entries: e, read: { 'CI runs': '2 runs, 1 failed', journal: 'not read: no journal' } }, '/d/c.db');
  assert.match(text, /\[run\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/1000\)/);
  assert.match(text, /- journal: not read: no journal/);
  assert.match(text, new RegExp(`--since @${(T0 - MIN) / 1000} --until @${(T0 + 2 * MIN) / 1000}`));
});

test('a source that fails is said in the timeline; the rest still gather', async () => {
  const s = setup(T0);
  const inc = s.make();
  (inc as any).d.sources.journal = async () => {
    throw new Error('journalctl: not found');
  };
  s.store.addHealthEvent('loop-lag', T0 + MIN, 'abc', 'held 2 s');
  const file = await inc.write({ from: T0, last: T0 + 5 * MIN, why: ['test'] }, T0 + 60 * MIN);
  assert.equal(file, '/shared/reports/incident-2026-11-17-0144.md');
  assert.match(s.files[0].text, /- journal: not read: journalctl: not found/);
  assert.match(s.files[0].text, /Health · loop-lag: held 2 s/);
});

test('readCiRuns: the window as GitHub asks for it, and each failed run its failed step and runner', async () => {
  const asked: string[] = [];
  const get = async (path: string) => {
    asked.push(path);
    if (path.includes('/jobs'))
      return {
        status: 200,
        etag: null,
        body: {
          jobs: [
            {
              name: 'test',
              conclusion: 'failure',
              runner_name: 'R2',
              steps: [
                { name: 'checkout', conclusion: 'success' },
                { name: "the runner's clock", conclusion: 'failure' },
              ],
            },
          ],
        },
      };
    return {
      status: 200,
      etag: null,
      body: {
        workflow_runs: [
          { id: 5, name: 'tests', head_branch: 'land/x', conclusion: 'failure', created_at: '2026-11-17T09:43:59Z', updated_at: '2026-11-17T09:44:11Z', html_url: 'u5' },
          { id: 6, name: 'tests', head_branch: 'main', conclusion: 'success', created_at: '2026-11-17T09:40:00Z', updated_at: '2026-11-17T09:42:00Z' },
        ],
      },
    };
  };
  const runs = await readCiRuns(get, 'o/r', undefined, T0 - 30 * MIN, T0 + 30 * MIN);
  assert.equal(asked[0], 'repos/o/r/actions/runs?created=2026-11-17T09:14:00Z..2026-11-17T10:14:00Z&per_page=100&page=1');
  assert.deepEqual(
    runs.map((r) => [r.id, r.failed ?? null, r.runner ?? null]),
    [
      [6, null, null],
      [5, "test › the runner's clock", 'R2'],
    ],
  );
  await assert.rejects(
    readCiRuns(async () => ({ status: 403, etag: null, body: null }), 'o/r', undefined, 0, 1),
    /403/,
  );
});

test("readDeploys: the live checkout's reflog, oldest first, inside the window", async () => {
  const dir = join(root, 'live');
  makeRepo(dir);
  writeFileSync(join(dir, 'a'), '1');
  git(dir, 'add', 'a');
  git(dir, 'commit', '-qm', 'first');
  writeFileSync(join(dir, 'a'), '2');
  git(dir, 'commit', '-qam', '#866: second');
  const all = await readDeploys(dir, 0, Date.now() + MIN);
  assert.deepEqual(
    all.map((d) => d.subject),
    ['first', '#866: second'],
  );
  assert.equal(all[1].how, 'commit');
  assert.deepEqual(await readDeploys(dir, Date.now() + 10 * MIN, Date.now() + 20 * MIN), []);
});

// #1325: Nov 20's two incidents, replayed. Neither opened one at the time.
const pst = (hms: string) => Date.parse(`2026-11-20T${hms}-08:00`);
const stopRow = (s: ReturnType<typeof setup>, at: number, result: string, newCode = false) => {
  const e = stopEvent({ at, result, code: result === 'success' ? 'exited' : 'killed', status: result === 'success' ? '0' : 'KILL' }, newCode, at);
  s.store.addHealthEvent('stop', e.at, null, e.detail);
};
const stall = (s: ReturnType<typeof setup>, at: number, held: number, kind = 'loop-lag') => s.store.addHealthEvent(kind, at, null, `The event loop was held for ${held.toFixed(1)} s: the server answered nobody meanwhile.`);

test('replay 10:44 to 10:47 on Nov 20: systemd-oomd stopped the server 11 times, one incident', async () => {
  const s = setup(pst('10:00:00'));
  // The 11 boots the live database holds for that storm; each stop was about 3 s before its boot (Restart=always).
  for (const b of ['10:44:14', '10:44:29', '10:44:45', '10:45:01', '10:45:17', '10:45:32', '10:45:47', '10:46:03', '10:46:34', '10:47:06', '10:47:22']) stopRow(s, pst(b) - 3000, 'oom-kill');
  const inc = s.make();
  s.clock.now = pst('10:48:00');
  await inc.tick();
  const open = s.store.getSetting<IncidentState>(STATE_KEY)!.open!;
  assert.deepEqual([open.from, open.last], [pst('10:44:11'), pst('10:47:19')]);
  assert.match(open.why.join('; '), /the server stopped unplanned 3 or more times within 10 min/);
  s.clock.now = pst('10:47:19') + QUIET_MS;
  await inc.tick();
  assert.equal(s.files.length, 1);
  assert.equal(s.told.length, 1);
});

test('replay 11:10 to 11:30 on Nov 20: three ships are planned stops, but the stalls between them are one incident', async () => {
  const s = setup(pst('11:00:00'));
  for (const at of ['11:12:01', '11:17:07', '11:21:19']) stopRow(s, pst(at), 'success', true);
  // A reconstruction of the journal's stalls: 113 s of them from 11:22:23 to 11:27:23, all in the 11:21:19 boot's quiet
  // minutes, so #1295 records them as boot stalls; spaced 4 s apart with lengths cycling 0.5 to 2 s (75 of them, 93.8 s).
  for (let i = 0; i < 75; i++) stall(s, pst('11:22:23') + i * 4000, 0.5 + (i % 4) * 0.5, 'loop-lag-boot');
  const inc = s.make();
  s.clock.now = pst('11:30:00');
  await inc.tick();
  const open = s.store.getSetting<IncidentState>(STATE_KEY)!.open!;
  assert.deepEqual(open.why, ['repeated stalls: the event loop was held more than 10% of 5 min']);
  s.clock.now = open.last + QUIET_MS;
  await inc.tick();
  assert.equal(s.files.length, 1);
});

test('three unplanned stops before a long outage still open an incident at the first tick after it', async () => {
  const s = setup(pst('09:00:00'));
  for (const at of ['10:00:00', '10:03:00', '10:06:00']) stopRow(s, pst(at), 'oom-kill');
  const inc = s.make();
  s.clock.now = pst('12:30:00'); // the server was down two and a half hours; its boot wrote the stop rows with their own times
  await inc.tick();
  // Long quiet already, so it is written at once.
  assert.equal(s.files.length, 1, JSON.stringify(s.store.getSetting(STATE_KEY)));
});

test('stopsTrigger and stallTrigger: below the line, and planned stops, open nothing', () => {
  const row = (at: number, detail: string) => ({ at, detail });
  // Two unplanned stops in 10 minutes, or three spread over 25: no incident. Ships and stops by hand never count.
  assert.equal(stopsTrigger([row(0, 'out-of-memory: x'), row(5 * MIN, 'crash: x')]), null);
  assert.equal(stopsTrigger([row(0, 'crash: x'), row(12 * MIN, 'crash: x'), row(24 * MIN, 'crash: x')]), null);
  assert.equal(stopsTrigger([row(0, 'deploy: x'), row(MIN, 'by-hand: x'), row(2 * MIN, 'deploy: x'), row(3 * MIN, 'watchdog: x')]), null);
  assert.deepEqual(stopsTrigger([row(0, 'watchdog: x'), row(4 * MIN, 'unknown: x'), row(9 * MIN, 'killed: x')])?.from, 0);
  // Nov 18's worst window: 5.1 s of stalls in 5 minutes (1.7%); a deploy's boot stalls on Nov 20, 19.7 s (6.6%). 30 s exactly is 10%, not more than it.
  const held = (s: number) => `The event loop was held for ${s.toFixed(1)} s: the server answered nobody meanwhile.`;
  assert.equal(stallTrigger([row(0, held(2.0)), row(MIN, held(1.6)), row(2 * MIN, held(1.5))]), null);
  assert.equal(stallTrigger([row(0, held(9.8)), row(MIN, held(9.9)), row(2 * MIN, held(1.6)), row(3 * MIN, held(0.7))]), null);
  assert.equal(stallTrigger([row(0, held(15)), row(4 * MIN, held(15))]), null);
  assert.equal(stallTrigger([row(0, held(16)), row(6 * MIN, held(16))]), null, 'more than 5 minutes apart');
  assert.deepEqual(stallTrigger([row(0, held(0.5)), row(MIN, held(15)), row(2 * MIN, held(15))]), { from: 0, last: 2 * MIN, why: 'repeated stalls: the event loop was held more than 10% of 5 min' });
});

test('a merged CI line names every branch it hit, in the timeline, the first-failed line and the most-repeated line', () => {
  const at = (i: number) => T0 + i * MIN;
  const run = (i: number, branch: string): CiRun => ({ ...clockRun(i, at(i)), branch });
  const runs = [run(0, 'land/ticket/1356-a'), run(1, 'land/ticket/1368-b'), run(2, 'land/ticket/1356-a'), run(3, 'land/ticket/1356-a')];
  const entries = ciEntries(runs);
  const text = render({ from: at(0), last: at(3), why: ['a burst'] }, at(0), at(5), { entries, read: {} }, '/db');
  const list = '(land/ticket/1356-a ×3, land/ticket/1368-b ×1)';
  assert.match(text, new RegExp(`First failed CI run: .*failed at test › the runner's clock on DESKTOP-linux-2 ${list.replace(/[()]/g, '\\$&')} \\(×4`));
  assert.match(text, new RegExp(`Most repeated: 4× CI: tests failed at test › the runner's clock ${list.replace(/[()]/g, '\\$&')}, `));
  assert.match(text, new RegExp(`· CI · .*${list.replace(/[()]/g, '\\$&')} \\(×4, the last`));
  assert.equal(text.slice(text.indexOf('## Timeline')).match(/· CI · /g)?.length, 1, 'still one line per failing step');
  // One branch stays as it was, and a long list is capped.
  const one = render({ from: at(0), last: at(1), why: ['x'] }, at(0), at(5), { entries: ciEntries([run(0, 'b1'), run(1, 'b1')]), read: {} }, '/db');
  assert.match(one, /clock on DESKTOP-linux-2 \(b1\) \(×2/);
  const many = render({ from: at(0), last: at(6), why: ['x'] }, at(0), at(9), { entries: ciEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((b, i) => run(i, b))), read: {} }, '/db');
  assert.match(many, /\(a ×1, b ×1, c ×1, d ×1, \+2 more\)/);
});

test("a standing check's promise broken since before the window is named in the timeline (#1415)", async () => {
  const s = setup(T0);
  const inc = s.make();
  s.store.setSetting('standing-checks', {
    ranAt: T0,
    integrityAt: null,
    error: null,
    findings: [
      { check: 'shipped-live', key: 'shipped-live:9', ticket: 9, text: '#9 (Citadel) has waited 90 min for its ship to go live, and nothing has told it why not.', since: T0 - 45 * MIN },
      { check: 'turn-record', key: 'turn-record:8', ticket: 8, text: '#8 (Citadel) shows running but has no turn record.', since: T0 + MIN },
    ],
  });
  await inc.write({ from: T0, last: T0 + 5 * MIN, why: ['test'] }, T0 + 60 * MIN);
  assert.match(s.files[0].text, /standing-check \(broken since [^)]+\): shipped-live: #9 \(Citadel\) has waited 90 min/);
  // One first seen inside the window has its own health row there; it isn't named twice.
  assert.doesNotMatch(s.files[0].text, /turn-record: #8/);
});

// #1460: the readout says what happened.
test('lines that differ only in a number are counted as different tickets, not one line repeated', () => {
  const entries = Array.from({ length: 81 }, (_, i) => ({ at: T0 + i * 1000, source: 'journal' as const, text: `Ticket ${2000 + (i % 70)} re-attached`, key: 'Ticket # re-attached' }));
  const same = [0, 1, 2].map((i) => ({ at: T0 + i, source: 'journal' as const, text: 'disk is slow', key: 'disk is slow' }));
  const text = render({ from: T0, last: T0 + MIN, why: ['x'] }, T0, T0 + 2 * MIN, { entries: [...entries, ...same], read: {} }, '/db');
  assert.match(text, /81 lines like this, 70 different tickets/);
  assert.match(text, /Most repeated: 81 lines like Journal: Ticket 2000 re-attached, 70 different tickets/);
  assert.match(text, /disk is slow \(×3, the last/, 'identical lines stay a plain count');
});

test('an incident lists its five biggest stalls, with their own times and top frames, before any grouped count', () => {
  const line = (heldS: string, span: string, extra = '') => `The event loop was held for ${heldS} s (${span} PST): the server answered nobody meanwhile. Cause: unclear (x).${extra}`;
  const write = (hms: string, text: string, kind = 'loop-lag') => ({ at: pst(hms), source: 'health' as const, text: `${kind}: ${text}`, key: `${kind}: same` });
  const entries = [
    // written 14 s after it ended, with the real span inside the line
    write('02:23:32', line('13.2', '02:23:05 to 02:23:18', ' Main thread waited on: D folio_wait_bit_common ×7. Running: 60% readFileSync (src/db.ts:9); 20% (garbage collector)')),
    ...[0.6, 0.7, 0.5, 0.6, 0.6, 0.9].map((h, i) => write(`02:24:0${i}`, line(h.toFixed(1), `02:24:0${i} to 02:24:0${i}`))),
  ];
  const text = render({ from: pst('02:23:00'), last: pst('02:25:00'), why: ['x'] }, pst('02:22:00'), pst('02:26:00'), { entries, read: {} }, '/db');
  const at = text.indexOf('## Biggest stalls');
  assert.ok(at > 0 && at < text.indexOf('## Timeline'), text);
  const section = text
    .slice(at, text.indexOf('## Timeline'))
    .split('\n')
    .filter((l) => l.startsWith('- '));
  assert.equal(section.length, 5);
  assert.match(section[0], /Nov 20, 02:23 PST\*\* to 02:23 PST · 13\.2 s · unclear · waited on D folio_wait_bit_common ×7 · 60% readFileSync \(src\/db\.ts:9\); 20% \(garbage collector\)/);
  assert.match(section[0], /02:23 PST/, 'the stall started at 02:23:05, not 02:23:32 when its line was written');
});

test('a merged CI line names every runner its reds ran on, with counts', () => {
  const at = (i: number) => T0 + i * MIN;
  const run = (i: number, runner: string): CiRun => ({ ...clockRun(i, at(i)), branch: 'b1', runner });
  const runs = [run(0, 'DESKTOP-linux'), run(1, 'DESKTOP-linux-2'), run(2, 'DESKTOP-linux'), run(3, 'DESKTOP-linux')];
  const text = render({ from: at(0), last: at(3), why: ['a burst'] }, at(0), at(5), { entries: ciEntries(runs), read: {} }, '/db');
  assert.match(text, /clock on DESKTOP-linux ×3, DESKTOP-linux-2 ×1 \(b1\) \(×4/);
  // One runner stays as it was.
  const one = render({ from: at(0), last: at(1), why: ['x'] }, at(0), at(5), { entries: ciEntries([run(0, 'R'), run(1, 'R')]), read: {} }, '/db');
  assert.match(one, /clock on R \(b1\) \(×2/);
});
