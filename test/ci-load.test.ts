// The CI desktop's load (src/ci-load.ts, #534): the rule that turns samples and GitHub's jobs into a verdict, on
// numbers shaped like DESKTOP-G248IJ8's on 2026-11-11 (Peek Auras' four runners full, two hard restarts), and the
// poller putting and clearing the quiet Mandate item.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { Job } from '../src/ci-health.ts';
import { CiLoad, KEEP_MS, TELL_AFTER_MS, cleanSample, loadJob, pcView, pools, verdict, type LoadJob, type Sample } from '../src/ci-load.ts';
import { Contraptions } from '../src/contraptions.ts';
import { Store } from '../src/db.ts';

// The verdicts' times are in the server's zone: pinned here, so the words are the same on every host.
process.env.TZ = 'UTC';
const root = mkdtempSync(join(tmpdir(), 'ci-load-'));
after(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse('2026-11-11T14:00:00Z');
const MIN = 60_000;
const PC = 'DESKTOP-G248IJ8';
const PEEK = 'caraminden/peek-auras';
const projects = [{ id: 7, name: 'Peek Auras', repo_url: 'https://github.com/caraminden/peek-auras' }];
const names = [PC, `${PC}-2`, `${PC}-3`, `${PC}-4`];

/** A Windows sample `msAgo` old: the four Peek runners sharing `cpu`, someone at the PC unless `idle_sec` says otherwise. */
function sample(msAgo: number, fields: Partial<Sample> = {}): Sample {
  const cpu = fields.cpu ?? 30;
  return {
    at: NOW - msAgo,
    host: PC,
    os: 'windows',
    cores: 32,
    cpu,
    mem_total: 192e9,
    mem_free: 150e9,
    disk_total: 2e12,
    disk_free: 1e12,
    queue: 0,
    pressure: null,
    idle_sec: 10,
    temp: null,
    hv: null,
    restarts: [],
    runners: names.map((name) => ({ name, repo: PEEK, dir: `C:\\actions-runner-peek-auras-${name}`, cpu: cpu / 5, mem: 2e9 })),
    ...fields,
  };
}
/** A sample every 30 seconds over the last 15 minutes. */
const window = (fields: Partial<Sample> = {}) => Array.from({ length: 30 }, (_, i) => sample((29 - i) * 30_000, fields));

let ids = 1;
function job(fields: Partial<LoadJob> = {}): LoadJob {
  return { repo: PEEK, name: `build ${ids++}`, status: 'completed', runner: PC, labels: 'peek-auras-ci', created: NOW - 60 * MIN, started: NOW - 60 * MIN + 2000, ended: NOW - 50 * MIN, ...fields };
}
const running = (runner: string) => job({ status: 'in_progress', runner, created: NOW - 10 * MIN, started: NOW - 10 * MIN, ended: NaN });
const queued = (msAgo: number) => job({ status: 'queued', runner: '', created: NOW - msAgo, started: NaN, ended: NaN });
const full = () => names.map(running);

/** The store's one person, made when there is none: a machine needs an owner. */
const owner = (store: Store): number => (store.listUsers()[0] ?? store.createUser({ name: 'Cara', login: 'cara', admin: true })).id;

test("a pool is a repo's runners with the same labels: its runners, who is busy, what waits, and the day's waits", () => {
  const jobs = [
    ...full(),
    queued(14 * MIN),
    queued(3 * MIN),
    job({ started: NOW - 60 * MIN + 6 * MIN }),
    job(),
    // Peek's test-box runner is another PC's (a VM), and a hosted job is nobody's.
    job({ runner: 'CITADEL-BOX-desktop', labels: 'peek-auras-desktop' }),
    job({ runner: 'GitHub Actions 12', labels: 'ubuntu-latest' }),
  ];
  const [p, ...rest] = pools(PC, jobs, window(), projects, NOW);
  assert.deepEqual(rest, []);
  assert.deepEqual({ title: p.title, project: p.project, labels: p.labels, runners: p.runners, busy: p.busy, waiting: p.waiting }, { title: 'Peek Auras', project: 7, labels: 'peek-auras-ci', runners: names, busy: 4, waiting: 2 });
  assert.equal(p.oldest_ms, 14 * MIN);
  assert.equal(p.jobs, 6);
  assert.equal(p.wait_max_ms, 6 * MIN);
  assert.equal(p.cpu, 24, 'four runners at 6% of the PC each');
  // Before the agents' update there are no samples: the runners are still found by the PC's name.
  assert.deepEqual(pools(PC, jobs, [], projects, NOW)[0].runners, names);
  // Two repos' runners can share a name (each scheme's first is the PC's): each stays in its own pool, with its own CPU.
  const VAULT = 'caraminden/vault';
  const shared = window({
    runners: [
      { name: PC, repo: PEEK, dir: 'C:\\a', cpu: 20, mem: 1 },
      { name: PC, repo: VAULT, dir: 'C:\\b', cpu: 3, mem: 1 },
    ],
  });
  const two = pools(PC, [running(PC), job({ repo: VAULT, labels: 'vault-ci' }), job({ repo: VAULT, labels: 'vault-ci', status: 'queued', runner: '', created: NOW - 5 * MIN, started: NaN, ended: NaN })], shared, projects, NOW);
  assert.deepEqual(
    two.map((x) => [x.repo, x.runners, x.busy, x.waiting, x.cpu]),
    [
      [VAULT, [PC], 0, 1, 3],
      [PEEK, [PC], 1, 0, 20],
    ],
  );
  // A runner the agent saw that has run nothing yet stands under its repo.
  const idle = sample(0, { runners: [{ name: `${PC}-linux`, repo: 'caraminden/claude-coordinator', dir: '/opt/actions-runner', cpu: 0, mem: 1 }] });
  assert.deepEqual(
    pools(PC, [], [idle], projects, NOW).map((x) => [x.title, x.runners]),
    [['caraminden/claude-coordinator', [`${PC}-linux`]]],
  );
});

test("a runner that takes two pools' jobs (a side label, #1240) is in both pools, so neither pool drops out", () => {
  const CC = 'caraminden/claude-coordinator';
  const side = `${PC}-linux-2`;
  const got = pools(
    PC,
    [job({ repo: CC, runner: `${PC}-linux`, labels: 'citadel-ci-linux' }), job({ repo: CC, runner: side, labels: 'citadel-ci-linux' }), job({ repo: CC, runner: side, labels: 'citadel-ci-linux,citadel-ci-linux-side', status: 'in_progress', created: NOW - MIN, started: NOW - MIN, ended: NaN })],
    [],
    projects,
    NOW,
  );
  assert.deepEqual(
    got.map((x) => [x.labels, x.runners, x.busy]),
    [
      ['citadel-ci-linux', [`${PC}-linux`, side], 0],
      ['citadel-ci-linux,citadel-ci-linux-side', [side], 1],
    ],
  );
});

test('the rule: fine, could do more, full, overloading, and no samples', () => {
  const v = (samples: Sample[], jobs: LoadJob[]) => verdict(samples, pools(PC, jobs, samples, projects, NOW), jobs, NOW);
  assert.match(v(window(), full()).text, /^Fine: CPU averaged 30% over the last 15 min, nothing is waiting\.$/);
  assert.equal(v(window(), [...full(), queued(MIN)]).kind, 'fine', "a job that has waited a minute isn't stuck yet");

  const more = v(window({ cpu: 35 }), [...full(), queued(14 * MIN), queued(3 * MIN)]);
  assert.equal(more.kind, 'more');
  assert.equal(more.text, 'Could do more: 2 Peek Auras jobs waited up to 14 min with all 4 of its runners busy, while the PC averaged 35% CPU. Add a runner to Peek Auras.');
  assert.equal(v(window({ cpu: 35 }), [...full().slice(1), queued(14 * MIN)]).kind, 'fine', 'a free runner is about to take it');

  const busy = v(window({ cpu: 75, idle_sec: 1e6 }), [...full(), queued(14 * MIN)]);
  assert.equal(busy.kind, 'full');
  assert.match(busy.text, /^Full: 1 job waiting and the PC averaged 75% CPU/);

  // Flat out with nobody there is good use; the same with someone at the PC is overloading.
  assert.equal(v(window({ cpu: 100, idle_sec: 3600 }), full()).kind, 'fine');
  const over = v(window({ cpu: 95 }), full());
  assert.equal(over.kind, 'over');
  assert.equal(over.text, 'Overloading: CPU was at 90% or more for 15 min of the last 15 min with someone at the PC. Peek Auras uses the most (76% of the PC): take a runner from it.');
  assert.equal(v(window({ cpu: 95, idle_sec: null }), full()).kind, 'over', "an agent that can't tell assumes someone is there");
  const some = [...window({ cpu: 95 }).slice(0, 12), ...window().slice(12)];
  assert.equal(v(some, full()).kind, 'fine', '6 of 15 minutes is a burst, not overload');
  // Hyper-V's count is the true one: the host's own leaves its guests out.
  assert.equal(v(window({ cpu: 40, hv: { total: 96, vms: { 'citadel-test-box': 800 } } }), full()).kind, 'over');
  assert.match(v(window({ queue: 40 }), full()).text, /more threads waited for a core than it has \(40 now\)/);
  assert.match(v(window({ mem_free: 10e9, runners: [] }), []).text, /^Overloading: only 5% of its memory is free\. CI isn't the cause/);

  assert.match(v([], full()).text, /^No samples yet: the runner agent on this PC needs its update/);
  assert.match(v([sample(20 * MIN)], full()).text, /^No samples since Nov 11, 05:40 PST: the PC is off/);
});

test('a hard restart with CI jobs running is "crashed under load" for a day, and never "add a runner"', () => {
  // 13:29 on 2026-11-11: the fourth build started at 13:28:59, the samples stop, and the PC is back by 13:34.
  const down = Date.parse('2026-11-11T13:29:30Z');
  const back = Date.parse('2026-11-11T13:34:00Z');
  const before = [0, 1, 2].map((i) => sample(NOW - down + i * 30_000)).reverse();
  const samples = [...before, ...window({ cpu: 35, restarts: [back] })];
  const killed = names.map((runner) => job({ runner, status: 'completed', created: down - 2 * MIN, started: down - 2 * MIN, ended: down + 11 * MIN }));
  const jobs = [...killed, ...full(), queued(14 * MIN)];
  const got = verdict(samples, pools(PC, jobs, samples, projects, NOW), jobs, NOW);
  assert.equal(got.kind, 'crash');
  assert.equal(got.text, "Crashed under load: the PC restarted without a clean shutdown at about Nov 11, 05:29 PST, with 4 CI jobs running (Peek Auras). Add no runners until that's explained.");
  // The same restart with nothing running isn't CI's: the queue rule speaks.
  const quiet = [...full(), queued(14 * MIN)];
  assert.equal(verdict(samples, pools(PC, quiet, samples, projects, NOW), quiet, NOW).kind, 'more');
  // A day on, it no longer holds.
  const later = window({ cpu: 35, restarts: [NOW - 25 * 60 * MIN] });
  assert.equal(verdict(later, pools(PC, jobs, later, projects, NOW), jobs, NOW).kind, 'more');
});

test("a PC's view: now with WSL's and the VM's shares, 24 hours in 5-minute steps, restarts, and who may see it", () => {
  const wsl: Sample = { ...sample(0, { cpu: 50, os: 'linux', cores: 16 }), runners: [{ name: `${PC}-linux`, repo: 'caraminden/claude-coordinator', dir: '/opt/r', cpu: 40, mem: 1e9 }] };
  const samples = [...window({ cpu: 40, hv: { total: 62, vms: { 'citadel-test-box': 256 } }, temp: 71.5, restarts: [NOW - 30 * MIN] }), wsl];
  const view = pcView(PC, samples, [...full(), queued(4 * MIN)], projects, NOW);
  assert.deepEqual(view.projects, [7]);
  assert.equal(view.now!.cpu, 62);
  assert.equal(view.now!.wsl, 25, 'half of 16 cores is a quarter of 32');
  assert.deepEqual(view.now!.vms, { 'citadel-test-box': 8 });
  assert.equal(view.now!.runners, 52, "four Windows runners at 8% each, and WSL's at 40% of half the cores");
  assert.equal(view.now!.temp, 71.5);
  assert.deepEqual(view.restarts, [NOW - 30 * MIN]);
  assert.equal(view.series.length, 288);
  const [t, cpu, peak, run, wait] = view.series.at(-1)!;
  assert.ok(NOW - t < 5 * MIN);
  assert.deepEqual([cpu, peak, run, wait], [62, 62, 4, 1]);
  assert.deepEqual(view.series[0].slice(1), [null, null, 0, 0], 'no samples that long ago');
  // The WSL agent alone (no Windows agent yet) is still a view.
  assert.equal(pcView(PC, [wsl], [], projects, NOW).now!.cpu, 50);
});

test("a sample is checked field by field and stamped with the server's clock", () => {
  const raw = { ...sample(0), at: 5, restarts: ['2026-11-11T13:34:00.0000000Z', 'soon', '2999-01-01T00:00:00Z'], extra: 'dropped' };
  const s = cleanSample(raw, NOW);
  assert.equal(s.at, NOW);
  assert.deepEqual(s.restarts, [Date.parse('2026-11-11T13:34:00Z')]);
  assert.equal('extra' in s, false);
  assert.equal(cleanSample({ ...raw, host: 'a\nb', queue: undefined, hv: { total: 50, vms: { box: 120 } } }, NOW).host, 'ab');
  for (const bad of [
    null,
    [],
    { ...raw, os: 'mac' },
    { ...raw, cpu: 101 },
    { ...raw, cpu: '5' },
    { ...raw, cores: 0 },
    { ...raw, host: '' },
    { ...raw, mem_free: NaN },
    { ...raw, runners: 'all' },
    { ...raw, runners: Array(65).fill(raw.runners[0]) },
    { ...raw, runners: [{ name: 'x', cpu: -1, mem: 0 }] },
    { ...raw, hv: { total: 500 } },
  ]) {
    assert.throws(() => cleanSample(bad, NOW), /must be|is required|is an object/, JSON.stringify(bad)?.slice(0, 80));
  }
});

test("GitHub's job becomes a job with times: one that never got a runner has no start", () => {
  const gh: Job = { id: 1, run_id: 1, name: 'bench', status: 'queued', conclusion: null, created_at: '2026-11-11T13:52:28Z', started_at: '2026-11-11T13:52:28Z', completed_at: null, runner_name: null, labels: ['self-hosted', 'peek-auras-ci'] };
  const j = loadJob(PEEK, gh);
  assert.deepEqual([j.labels, j.runner, Number.isNaN(j.started), Number.isNaN(j.ended)], ['peek-auras-ci', '', true, true]);
  assert.equal(loadJob(PEEK, { ...gh, status: 'in_progress', runner_name: PC }).started, Date.parse('2026-11-11T13:52:28Z'));
});

test('a verdict that holds for 30 minutes is one quiet Mandate item per admin, cleared when it ends; old samples go', async () => {
  const store = new Store(join(root, 'tell.db'));
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const project = store.createProject('Peek Auras', 'https://github.com/caraminden/peek-auras', cara.id);
  const mandate = new Contraptions(store, 's'.repeat(40), join(root, 'keys')).register({ name: 'mandate', title: 'Mandate', port: 9101, icon: '/icon.svg', home_scheme: null, open_paths: '[]', default_model: 'haiku', turn_cap: 200 });
  store.setContraptionUser(mandate.id, cara.id, true, cara.id);
  // An admin without Mandate gets nothing.
  store.createUser({ name: 'Rachel', login: 'rachel', admin: true });
  const machine = store.createMachine('desk-runners', '', 'Cara', owner(store));
  let ghJobs: Job[] = [];
  const sent: [string, string | null][] = [];
  let down = false;
  const load = new CiLoad(store, {
    jobs: () => [{ project: store.getProject(project.id)!, jobs: ghJobs }],
    hosts: () => [PC],
    mandate: async (p, u, key, title) => {
      if (!down) sent.push([`${p.name}/${u.name}/${key}`, title]);
      return !down;
    },
  });
  const iso = (t: number) => new Date(t).toISOString();
  const gh = (j: LoadJob, i: number): Job => ({ id: i, run_id: 1, name: j.name, status: j.status, conclusion: null, created_at: iso(j.created), started_at: iso(Number.isNaN(j.started) ? j.created : j.started), completed_at: null, runner_name: j.runner || null, labels: ['self-hosted', j.labels] });
  let now = NOW;
  const feed = () => {
    for (let i = 29; i >= 0; i--) load.add(machine.id, sample(0, { cpu: 35 }), now - i * 30_000);
  };
  const stuck = () => {
    ghJobs = [...names.map((runner) => job({ status: 'in_progress', runner, created: now - 10 * MIN, started: now - 10 * MIN, ended: NaN })), job({ status: 'queued', runner: '', created: now - 14 * MIN, started: NaN, ended: NaN })].map(gh);
  };

  store.addRunnerLoad(machine.id, NOW - KEEP_MS - MIN, JSON.stringify(sample(0)));
  feed();
  stuck();
  await load.tick(now);
  assert.equal(store.runnerLoadSince(0)[0].at, NOW - 29 * 30_000, 'the 14-day-old sample is gone');
  assert.equal(load.views(now)[0].verdict.kind, 'more');
  assert.deepEqual(sent, [], 'not yet: it has only just started');
  now += TELL_AFTER_MS;
  feed();
  stuck();
  await load.tick(now);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], 'Peek Auras/Cara/ciload.desktop-g248ij8');
  assert.match(sent[0][1]!, /^CI desktop DESKTOP-G248IJ8: Could do more: 1 Peek Auras job waited up to 14 min/);
  now += 5 * MIN;
  feed();
  stuck();
  await load.tick(now);
  assert.equal(sent.length, 1, 'said once while it holds');
  now += 5 * MIN;
  // Mandate is away as the verdict ends: the item is taken back on a later look, not left there.
  feed();
  ghJobs = [];
  down = true;
  await load.tick(now);
  assert.equal(sent.length, 1);
  down = false;
  now += MIN;
  feed();
  await load.tick(now);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], ['Peek Auras/Cara/ciload.desktop-g248ij8', null]);
});

test('views keep up with samples as they come in, and drop a deleted machine and samples over a day old (#613)', () => {
  const store = new Store(join(root, 'recent.db'));
  const load = new CiLoad(store, { jobs: () => [], hosts: () => [], mandate: async () => true });
  const desk = store.createMachine('desk', '', 'Cara', owner(store));
  const lab = store.createMachine('lab', '', 'Cara', owner(store));
  const DAY = 24 * 60 * MIN;
  load.add(desk.id, sample(0, { host: 'DESK' }), NOW - DAY + MIN);
  assert.deepEqual(
    load.views(NOW).map((v) => v.host),
    ['DESK'],
    'read from the database once',
  );
  load.add(lab.id, sample(0, { host: 'LAB' }), NOW + 1);
  assert.deepEqual(
    load.views(NOW + 1).map((v) => v.host),
    ['DESK', 'LAB'],
    'a sample after the first read shows',
  );
  store.deleteMachine(lab.id); // as DELETE /api/machines/:machine does
  load.forget(lab.id);
  assert.deepEqual(
    load.views(NOW + 2).map((v) => v.host),
    ['DESK'],
  );
  assert.deepEqual(
    load.views(NOW + 2 * MIN).map((v) => v.host),
    [],
    'over a day old',
  );
  assert.deepEqual(new CiLoad(store, { jobs: () => [], hosts: () => [], mandate: async () => true }).views(NOW + 2 * MIN), [], 'the same as a fresh read');
  store.db.close();
});

test('samples wait in memory and are written together, with nothing lost to a read, a restart or a deleted machine (#791)', () => {
  const store = new Store(join(root, 'buffer.db'));
  const quiet = { jobs: () => [], hosts: () => [], mandate: async () => true };
  const load = new CiLoad(store, quiet);
  const desk = store.createMachine('desk', '', 'Cara', owner(store));
  const lab = store.createMachine('lab', '', 'Cara', owner(store));
  const saved = () => store.runnerLoadSince(0).map((r) => [r.machine_id, r.at]);
  const changes = () => Number((store.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
  const before = changes();
  load.add(desk.id, sample(0, { host: 'DESK' }), NOW);
  load.add(lab.id, sample(0, { host: 'LAB' }), NOW + 1);
  assert.equal(changes(), before, 'adding a sample writes nothing');
  assert.deepEqual(saved(), []);
  assert.throws(() => load.add(desk.id, null, NOW), 'a bad sample is still refused as it arrives');
  // The first read loads from the database: the waiting samples are written first, so it sees them.
  assert.deepEqual(
    load.views(NOW + 1).map((v) => v.host),
    ['DESK', 'LAB'],
  );
  assert.deepEqual(saved(), [
    [desk.id, NOW],
    [lab.id, NOW + 1],
  ]);
  load.add(desk.id, sample(0, { host: 'DESK' }), NOW + 2);
  load.add(lab.id, sample(0, { host: 'LAB' }), NOW + 3);
  assert.equal(load.views(NOW + 3).length, 2, 'a waiting sample already shows');
  assert.equal(saved().length, 2);
  // A deleted machine's waiting samples go with it, and one that slipped through is dropped, not an error.
  store.deleteMachine(lab.id);
  load.forget(lab.id);
  load.flush();
  assert.deepEqual(saved(), [
    [desk.id, NOW],
    [desk.id, NOW + 2],
  ]);
  store.addRunnerLoads([
    { machine: lab.id, at: NOW + 4, data: '{}' },
    { machine: desk.id, at: NOW + 5, data: JSON.stringify(sample(0, { host: 'DESK' })) },
  ]);
  assert.deepEqual(saved().at(-1), [desk.id, NOW + 5]);
  assert.equal(saved().length, 3);
  // Stopping (the server's SIGTERM) writes what is left, so the next server reads it.
  load.add(desk.id, sample(0, { host: 'DESK' }), NOW + 6);
  load.stop();
  assert.equal(saved().length, 4);
  assert.deepEqual(
    new CiLoad(store, quiet).views(NOW + 6).map((v) => v.host),
    ['DESK'],
  );
  store.db.close();
});

test("each PC's own runners come from its agents' newest samples; a PC connected with none yet is there, and a stale sample isn't (#1934)", () => {
  const store = new Store(join(root, 'pcs.db'));
  const load = new CiLoad(store, { jobs: () => [], hosts: () => ['LAPTOP', 'Desk'], mandate: async () => true });
  const win = store.createMachine('win', '', 'Cara', owner(store));
  const wsl = store.createMachine('wsl', '', 'Cara', owner(store));
  const use = (name: string, repo: string) => ({ name, repo, dir: '', cpu: 0, mem: 0 });
  load.add(win.id, sample(0, { host: 'DESK', runners: [use('DESK', 'c/Peek'), use('who', '')] }), NOW);
  load.add(wsl.id, sample(0, { host: 'desk', os: 'linux', runners: [use('DESK-linux', 'c/citadel')] }), NOW);
  assert.deepEqual(
    load.runnersByPc(NOW + MIN),
    new Map([
      ['laptop', new Set()],
      ['desk', new Set(['c/peek/desk', 'c/citadel/desk-linux'])],
    ]),
    'the Windows and WSL agents of one PC are one PC',
  );
  assert.deepEqual(load.runnersByPc(NOW + 11 * MIN).get('desk'), new Set());
});

test("a PC's standing runners: running and asleep ones, never the runner pool's one-job runners (Build 11 P3)", () => {
  const store = new Store(join(root, 'standing.db'));
  const load = new CiLoad(store, { jobs: () => [], hosts: () => [], mandate: async () => true });
  const desk = store.createMachine('desk', '', 'Cara', owner(store));
  const use = (name: string, repo: string, dir: string) => ({ name, repo, dir, cpu: 1, mem: 1 });
  load.add(
    desk.id,
    sample(0, {
      runners: [use('DESK-2', 'caraminden/peek-auras', 'C:\\actions-runners\\peek-2'), use('pool-m1-w1-j55', 'caraminden/theory-of-crafting', 'C:\\citadel-pool\\theory-of-crafting\\slot-1'), use('', 'caraminden/delve', 'C:\\citadel-pool\\delve\\slot-2')],
      wakeable: ['CaraMinden/Mandate'],
    }),
    NOW,
  );
  assert.deepEqual([...load.standingOn(desk.id, 'windows', NOW)].sort(), ['caraminden/mandate', 'caraminden/peek-auras']);
  assert.ok(load.reposOn(desk.id, 'windows', NOW).has('caraminden/theory-of-crafting'), 'reposOn still lists every running runner');
  assert.deepEqual([...load.standingOn(desk.id, 'windows', NOW + 10 * MIN)], [], 'a sample over 10 minutes old says nothing');
});
