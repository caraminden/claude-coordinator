// Runners awake (Build 7 M6b): the runner agent keeps awake the runners Citadel's balancer plans for its PC, and sleeps
// the rest, so GitHub hands a job to a PC with room. The pick is pure; systemctl, the runner units and Windows' process
// list are faked here, and keep-runners.ps1's half runs in pwsh with Stop-Service and Start-Service faked.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanPlan, PLAN_HOLD_MS, pickAwake, RunnerWake } from '../public/runner-agent.mjs';
import { cleanSample } from '../src/ci-load.ts';
import { Store } from '../src/db.ts';
import { balance, runnerOrder, runnerShares, runnersFor } from '../src/machine-balancer.ts';
import { MachineRelay } from '../src/machines.ts';

type R = { key: string; repo: string; name: string; busy: boolean; ship: boolean; awake: boolean };
const runner = (key: string, repo: string, more: Partial<R> = {}): R => ({ key, repo, name: key, busy: false, ship: false, awake: true, ...more });
const picked = (runners: R[], runners_: number, queued: Record<string, number> = {}) => [...pickAwake(runners, { runners: runners_, queued })].sort();

test("a ship plus 2 queued CI jobs on a 24-thread PC: the ship's runner and the plan's 4 stay up, the queued repo's first", () => {
  const plan = balance({ threads: 24, caps: { workers: null, runners: null, turnThreads: null, ciThreads: null }, ship: true, ciWaiting: 2, running: 0, heavy: [], now: 0 });
  // 24 threads less the ship's 6 leaves 18: 4 runners of 4 threads.
  assert.equal(plan.runners, 4);
  const runners = [runner('ship', 'citadel', { ship: true, busy: true }), runner('c2', 'citadel'), runner('c3', 'citadel'), runner('t1', 'twi'), runner('t2', 'twi'), runner('t3', 'twi'), runner('p1', 'peek'), runner('p2', 'peek')];
  const awake = picked(runners, plan.runners, { twi: 2 });
  assert.equal(awake.length, 5, awake.join());
  assert.ok(awake.includes('ship'));
  assert.ok(awake.includes('t1') && awake.includes('t2'), "twi's two queued jobs each get a runner");
  // The other two of the four: one for each other repo, so neither has nothing up for its next job.
  assert.ok(awake.includes('c2') && awake.includes('p1'), awake.join());
});

test('a busy runner counts toward the plan and is never put to sleep; a plan of none leaves only busy and ship runners', () => {
  const runners = [runner('a1', 'a', { busy: true }), runner('a2', 'a'), runner('b1', 'b', { busy: true }), runner('b2', 'b'), runner('s', 'a', { ship: true })];
  assert.deepEqual(picked(runners, 3), ['a1', 'a2', 'b1', 's']);
  assert.deepEqual(picked(runners, 0), ['a1', 'b1', 's']);
  assert.deepEqual(picked(runners, 1), ['a1', 'b1', 's'], 'two busy already pass a plan of one: nothing idle wakes');
});

test('a steady plan moves nothing: runners already up are kept before ones asleep', () => {
  const runners = [runner('a1', 'a', { awake: false }), runner('a2', 'a'), runner('b1', 'b', { awake: false }), runner('b2', 'b')];
  assert.deepEqual(picked(runners, 2), ['a2', 'b2']);
});

test("queued jobs share the plan among repos, the one with most waiting first; a repo with no runner here doesn't take room", () => {
  const runners = [runner('a1', 'a'), runner('a2', 'a'), runner('a3', 'a'), runner('b1', 'b'), runner('b2', 'b')];
  assert.deepEqual(picked(runners, 3, { a: 5, b: 1, gone: 9 }), ['a1', 'a2', 'b1']);
  assert.deepEqual(picked(runners, 1, { b: 1 }), ['b1']);
});

test("Citadel's plan is checked: a count from 0, queued jobs by repo kept to whole numbers, anything else is no plan", () => {
  assert.deepEqual(cleanPlan({ runners: 2, queued: { 'Cara/Repo': 3, bad: -1, worse: 'x' } }), { runners: 2, queued: { 'cara/repo': 3 } });
  assert.deepEqual(cleanPlan({ runners: 0 }), { runners: 0, queued: {} });
  for (const bad of [null, {}, { runners: -1 }, { runners: 1.5 }, { runners: '2' }]) assert.equal(cleanPlan(bad), null, JSON.stringify(bad));
});

// #2241: Citadel's four Linux runners carry different labels; a job asking for one only a sleeping runner has must wake it.
const fleet = [runner('linux', 'c', { awake: true }), runner('linux-2', 'c', { awake: false }), runner('linux-3', 'c', { awake: false }), runner('linux-4', 'c', { awake: false })];
const labelled = [
  { name: 'linux', labels: ['self-hosted', 'ci-linux'] },
  { name: 'linux-2', labels: ['self-hosted', 'ci-linux', 'ci-linux-side'] },
  { name: 'linux-3', labels: ['self-hosted', 'ci-linux', 'ci-linux-side', 'ci-linux-long'] },
  { name: 'linux-4', labels: ['self-hosted', 'ci-linux-check'] },
];

test('runnerOrder: a later machine hears labelled jobs only for repos with a job still waiting', () => {
  const pcs = [
    { id: 1, owner: 1, priority: 1, runners: 2, repos: new Set(['c']) },
    { id: 2, owner: 1, priority: 2, runners: 1, repos: new Set(['c', 'only2']) },
  ];
  const want = { c: [['linux-4']] };
  const idle = runnerOrder(pcs, new Map(), want);
  assert.equal(idle.get(1)?.want?.c?.length, 1);
  assert.equal(idle.get(2)?.want, undefined, 'the first machine takes it; the second keeps its repo-only runner');
  assert.deepEqual(runnerOrder(pcs, new Map([['c', 1]]), want).get(2)?.want, want);
});

test('runnersFor: each queued job gets the runners whose labels cover all of its; a job nobody covers is left out', () => {
  const want = runnersFor(new Map([['C', [['ci-linux-check'], ['ci-linux', 'ci-linux-long'], ['nobody-has-this']]]]), new Map([['C', labelled]]));
  assert.deepEqual(want, { c: [['linux-4'], ['linux-3']] });
});

test('a job asking for a label only a sleeping runner has wakes that runner, though a repo-mate stays up (the gap before #2241)', () => {
  const plan = { runners: 1, queued: { c: 1 } };
  assert.deepEqual([...pickAwake(fleet, plan)].sort(), ['linux'], 'by repo alone the awake -linux serves the queued job');
  assert.deepEqual([...pickAwake(fleet, { ...plan, want: { c: [['linux-4']] } })].sort(), ['linux-4'], 'with labels the runner that covers the job is the one up');
  assert.deepEqual([...pickAwake(fleet, { runners: 2, queued: { c: 2 }, want: { c: [['linux-4'], ['linux-2', 'linux-3']] } })].sort(), ['linux-2', 'linux-4']);
  // Two jobs with the same label and one busy runner that has it: the busy one takes one, the other wakes a second.
  const busy = [runner('x1', 'c', { busy: true }), runner('x2', 'c', { awake: false }), runner('y', 'c', { awake: false })];
  assert.deepEqual(
    [
      ...pickAwake(busy, {
        runners: 2,
        queued: { c: 2 },
        want: {
          c: [
            ['x1', 'x2'],
            ['x1', 'x2'],
          ],
        },
      }),
    ].sort(),
    ['x1', 'x2'],
  );
  // A runner already up that covers the job is kept, and wakes nothing more.
  assert.deepEqual([...pickAwake(fleet, { runners: 1, queued: { c: 1 }, want: { c: [['linux', 'linux-2']] } })].sort(), ['linux']);
});

test("the plan's want is checked, and left off when there is none (an old Citadel's plan is as before)", () => {
  assert.deepEqual(cleanPlan({ runners: 1, want: { 'C/R': [['A-1', 7], 'x', []], bad: 3 } }), { runners: 1, queued: {}, want: { 'c/r': [['a-1']] } });
  assert.deepEqual(cleanPlan({ runners: 1, want: {} }), { runners: 1, queued: {} });
});

/** Linux runner units in a scratch folder, systemctl a recorder answering is-active from `up`. */
function linux() {
  const dir = mkdtempSync(join(tmpdir(), 'runner-wake-'));
  const unit = (repo: string, n: string) => writeFileSync(join(dir, `citadel-runner-o-${repo}${n}.service`), `[Service]\nExecStart=/bin/bash /opt/r/${repo}${n}/bin/runsvc.sh\n`);
  for (const repo of ['citadel', 'twi']) for (const n of ['', '-2']) unit(repo, n);
  const up = new Map<string, boolean>(['citadel', 'citadel-2', 'twi', 'twi-2'].map((u) => [`citadel-runner-o-${u}.service`, true]));
  const calls: string[] = [];
  let clock = 0;
  let working: string[] = [];
  const wake = new RunnerWake({
    os: 'linux',
    dir,
    units: dir,
    now: () => clock,
    identity: (d: string) => ({ name: d.split('/').at(-1)!, repo: `o/${d.split('/').at(-1)!.replace(/-2$/, '')}` }),
    procs: () => working.map((d, i) => ({ pid: i, ppid: 1, path: `/opt/r/${d}/bin/Runner.Worker`, cpu: 0, mem: 0, reaped: 0 })),
    run: async ({ args }: { args: string[] }) => {
      if (args[0] === 'is-active') {
        const lines = args.slice(1).map((u) => (up.get(u) ? 'active' : 'inactive'));
        return { code: lines.every((l) => l === 'active') ? 0 : 3, output: lines.join('\n') };
      }
      calls.push(`${args[0]} ${args[1]}`);
      up.set(args[1], args[0] === 'start');
      onCall();
      return { code: 0, output: '' };
    },
  });
  let onCall = () => {};
  return { wake, dir, calls, up, tick: (ms: number) => (clock += ms), work: (d: string[]) => (working = d), after: (f: () => void) => (onCall = f) };
}

test('Linux: the plan stops idle units past its count and starts them again when it grows or stops coming', async () => {
  const { wake, dir, calls, tick, work } = linux();
  try {
    work(['twi']);
    await wake.update({ runners: 2, queued: { 'o/twi': 1 } });
    assert.ok(wake.held());
    // twi runs a job (1 of 2), and twi's queued job takes twi-2: both citadel units sleep.
    assert.deepEqual(calls.sort(), ['stop citadel-runner-o-citadel-2.service', 'stop citadel-runner-o-citadel.service']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'slept.json'), 'utf8')), ['citadel-runner-o-citadel-2.service', 'citadel-runner-o-citadel.service']);
    calls.length = 0;
    await wake.update({ runners: 2, queued: { 'o/twi': 1 } });
    assert.deepEqual(calls, [], 'the same plan every 10 seconds moves nothing');
    await wake.update({ runners: 3, queued: {} });
    assert.deepEqual(calls, ['start citadel-runner-o-citadel.service']);
    calls.length = 0;
    tick(PLAN_HOLD_MS);
    await wake.tick();
    assert.ok(!wake.held());
    assert.deepEqual(calls, ['start citadel-runner-o-citadel-2.service'], 'a plan that stops coming wakes what it put to sleep');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'slept.json'), 'utf8')), []);
  } finally {
    // timing-ok: own temp dir
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux: a busy or ship runner is never stopped, and a unit someone else stopped is never started', async () => {
  const { wake, dir, calls, up, work } = linux();
  try {
    up.set('citadel-runner-o-twi-2.service', false);
    work(['citadel', 'twi']);
    wake.ships = [{ repo: 'o/citadel', runner: 'citadel-2' }];
    await wake.update({ runners: 0, queued: { 'o/twi': 4 } });
    assert.deepEqual(calls, [], 'citadel and twi run jobs, citadel-2 is on the ship: none sleeps');
    work([]);
    await wake.update({ runners: 0, queued: {} });
    assert.deepEqual(calls.sort(), ['stop citadel-runner-o-citadel.service', 'stop citadel-runner-o-twi.service'], 'done with their jobs, they sleep at the next look');
    calls.length = 0;
    await wake.update({ runners: 9, queued: {} });
    assert.deepEqual(calls.sort(), ['start citadel-runner-o-citadel.service', 'start citadel-runner-o-twi.service'], 'twi-2 was stopped by someone else: it stays down');
  } finally {
    // timing-ok: own temp dir
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Linux: a runner GitHub hands a job while the ones before it stop is looked at again, and kept up', async () => {
  const { wake, dir, calls, work, after } = linux();
  try {
    // The first stop takes a while; meanwhile twi takes a job.
    after(() => work(['twi']));
    await wake.update({ runners: 0, queued: {} });
    assert.ok(!calls.includes('stop citadel-runner-o-twi.service'), calls.join(', '));
    assert.ok(calls.includes('stop citadel-runner-o-twi-2.service'));
  } finally {
    // timing-ok: own temp dir
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows: the runners to sleep go to asleep.json for keep-runners.ps1, with the plan's expiry; no plan names none", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-wake-'));
  try {
    // keep-runners.ps1 put c:\actions-runner-b to sleep earlier: it counts as one of ours, though it isn't up.
    writeFileSync(join(dir, 'slept.json'), JSON.stringify(['c:\\actions-runner-b']));
    const roots = ['C:\\actions-runner-a', 'C:\\actions-runner-a-2', 'C:\\actions-runner-b', 'C:\\actions-runner-c'];
    const wake = new RunnerWake({
      os: 'windows',
      dir,
      now: () => 1000,
      roots: () => roots,
      identity: (d: string) => ({ name: d.slice(3), repo: `o/${d.slice(18).replace(/-2$/, '')}` }),
      // c is down and not ours: someone stopped it.
      windowsProcs: () => [{ path: 'C:\\actions-runner-a\\bin\\Runner.Listener.exe' }, { path: 'C:\\actions-runner-a\\bin\\Runner.Worker.exe' }, { path: 'C:\\actions-runner-a-2\\bin\\Runner.Listener.exe' }],
    });
    await wake.update({ runners: 1, queued: {} });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'asleep.json'), 'utf8')), { until: 1000 + PLAN_HOLD_MS, dirs: ['C:\\actions-runner-a-2', 'C:\\actions-runner-b'] });
    await wake.update({ runners: 2, queued: { 'o/b': 1 } });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'asleep.json'), 'utf8')).dirs, ['C:\\actions-runner-a-2'], "b's queued job wakes b");
    wake.plan = null;
    await wake.next();
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'asleep.json'), 'utf8')), { until: 0, dirs: [] });
  } finally {
    // timing-ok: own temp dir
    rmSync(dir, { recursive: true, force: true });
  }
});

const script = join(import.meta.dirname, '..', 'tools', 'ci-runner', 'keep-runners.ps1');
const skip = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).error ? 'no pwsh on PATH' : false;

test('keep-runners.ps1 stops the idle services asleep.json names, wakes the ones it stopped once they leave it, and leaves the rest', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-wake-'));
  try {
    const run = (asleep: object, services: string, extra = '', flags = '') => {
      writeFileSync(join(dir, 'asleep.json'), JSON.stringify(asleep));
      const file = join(dir, 'run.ps1');
      writeFileSync(
        file,
        `$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$t = $null; $e = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$t, [ref]$e)
foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) { . ([scriptblock]::Create($f.Extent.Text)) }
$asleepFile = '${join(dir, 'asleep.json')}'
$sleptFile = '${join(dir, 'slept.json')}'
$calls = New-Object System.Collections.Generic.List[string]
function Stop-Service([string]$Name) { $calls.Add("stop $Name") }
function Start-Service([string]$Name) { $calls.Add("start $Name") }
$working = @()
function Test-RunnerWorking($dir) { $working -contains $dir }
${extra}
$svc = { param($n, $state) [pscustomobject]@{ Name = "actions.runner.o-$n.pc"; State = $state; PathName = "\`"C:\\actions-runner-$n\\bin\\RunnerService.exe\`"" } }
Set-Asleep @(${services}) @{ 'c:\\actions-runner-busy' = $true } ${flags} | Out-Null
ConvertTo-Json -Compress -InputObject @($calls)`,
      );
      const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', file], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return JSON.parse(r.stdout.trim().split('\n').at(-1)!) as string[];
    };
    const later = Date.now() + 60_000;
    const all = (a: string, b: string) => `(& $svc 'a' '${a}'), (& $svc 'b' '${b}'), (& $svc 'busy' 'Running'), (& $svc 'other' 'Stopped')`;
    assert.deepEqual(run({ until: later, dirs: ['C:\\actions-runner-a', 'C:\\actions-runner-busy', 'C:\\actions-runner-other'] }, all('Running', 'Running')), ['stop actions.runner.o-a.pc']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'slept.json'), 'utf8')), ['c:\\actions-runner-a'], 'busy runs a job and other was already stopped: only a is ours');
    assert.deepEqual(run({ until: later, dirs: ['C:\\actions-runner-a'] }, all('Stopped', 'Running')), [], 'asleep already: nothing to do');
    assert.deepEqual(run({ until: Date.now() - 1, dirs: ['C:\\actions-runner-a'] }, all('Stopped', 'Running')), ['start actions.runner.o-a.pc'], 'an expired plan wakes it');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'slept.json'), 'utf8')), []);
    assert.deepEqual(run({ until: 0, dirs: [] }, all('Running', 'Running')), [], 'other, stopped by someone, stays stopped');
    // Windows PowerShell 5.1 (what runs it) pipes a JSON array on as one object: two asleep still wake as two.
    const like51 = 'function ConvertFrom-Json { process { , (Microsoft.PowerShell.Utility\\ConvertFrom-Json -InputObject $_ -NoEnumerate) } }';
    const ab = { until: later, dirs: ['C:\\actions-runner-a', 'C:\\actions-runner-b'] };
    assert.deepEqual(run(ab, all('Running', 'Running'), like51).sort(), ['stop actions.runner.o-a.pc', 'stop actions.runner.o-b.pc']);
    assert.deepEqual(run({ until: 0, dirs: [] }, all('Stopped', 'Stopped'), like51).sort(), ['start actions.runner.o-a.pc', 'start actions.runner.o-b.pc']);
    // One that took a job since the sweep looked is asked again right before its stop, and left up.
    assert.deepEqual(run(ab, all('Running', 'Running'), "$working = @('c:\\actions-runner-b')"), ['stop actions.runner.o-a.pc']);
    // The agent is gone: every one it put to sleep wakes, though the plan it left hasn't run out.
    assert.deepEqual(run(ab, all('Stopped', 'Running'), '', '-WakeAll'), ['start actions.runner.o-a.pc']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'slept.json'), 'utf8')), []);
  } finally {
    // timing-ok: own temp dir
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the server splits a PC's runners between its Windows and Linux agents by the jobs waiting for each one's repos", () => {
  const agents: { key: string; repos: Set<string>; cap?: number | null }[] = [
    { key: 'windows', repos: new Set(['o/peek']) },
    { key: 'linux', repos: new Set(['o/citadel', 'o/twi']) },
  ];
  const split = (n: number, q: [string, number][], list: typeof agents = agents) => {
    const part = runnerOrder([{ id: 1, owner: 1, priority: null, runners: n, repos: new Set(list.flatMap((a) => [...a.repos])) }], new Map(q)).get(1)!;
    return runnerShares(part.runners, list, part.queued);
  };
  const share = (n: number, q: [string, number][], list: typeof agents = agents) => Object.fromEntries([...split(n, q, list)].map(([k, v]) => [k, v.runners]));
  assert.deepEqual(share(4, []), { windows: 2, linux: 2 }, 'nothing waits: an even split');
  // Weights 1+1 and 1+3: 4 runners split 1.33 and 2.67.
  assert.deepEqual(
    share(4, [
      ['O/Citadel', 2],
      ['o/twi', 1],
      ['o/peek', 1],
      ['o/elsewhere', 5],
    ]),
    { windows: 1, linux: 3 },
  );
  assert.deepEqual(share(5, [['o/citadel', 6]]), { windows: 1, linux: 4 }, 'an agent with nothing waiting keeps a part: its runners may all be asleep');
  assert.deepEqual(share(1, [['o/peek', 1]]), { windows: 1, linux: 0 });
  assert.deepEqual(share(3, []), { windows: 1, linux: 2 }, 'an odd one goes by key when the parts tie');
  assert.deepEqual(
    split(2, [
      ['O/Peek', 1],
      ['o/none', 0],
    ]).get('linux'),
    { runners: 1, queued: { 'o/peek': 1 } },
    'each hears every repo waiting',
  );
  // An agent that says how many runners it can wake gets no more; the rest go to the other.
  const capped = [
    { key: 'windows', repos: new Set(['o/peek']), cap: 1 },
    { key: 'linux', repos: new Set(['o/citadel', 'o/twi']), cap: 5 },
  ];
  assert.deepEqual(share(6, [], capped), { windows: 1, linux: 5 }, 'one Windows runner and five in WSL: all six up, none asleep for the even split');
  assert.deepEqual(share(9, [], capped), { windows: 1, linux: 5 }, 'more than both have: each keeps all of its own');
  assert.deepEqual(share(2, [], [capped[0], { ...capped[1], cap: null }]), { windows: 1, linux: 1 }, "an older agent that doesn't say is not capped");
});

test("runners awake follow the owner's order: a later machine keeps up only what the earlier ones can't take", () => {
  const pc = (id: number, priority: number | null, runners: number, repos: string[], owner = 1) => ({ id, owner, priority, runners, repos: new Set(repos) });
  const plan = (pcs: ReturnType<typeof pc>[], q: [string, number][] = []) => Object.fromEntries([...runnerOrder(pcs, new Map(q))].map(([id, s]) => [id, [s.runners, s.queued]]));
  const desk = pc(1, 1, 4, ['o/citadel', 'o/twi']);
  // Machine 2 has room for 4, but machine 1 has room: only a runner for o/peek, which machine 1 has none for.
  assert.deepEqual(plan([desk, pc(2, 2, 4, ['o/citadel', 'o/peek'])]), { 1: [4, {}], 2: [1, { 'o/peek': 1 }] });
  // Jobs waiting: machine 1 had no idle runner for them, so machine 2 wakes one for each, up to its plan.
  assert.deepEqual(plan([desk, pc(2, 2, 4, ['o/citadel', 'o/peek'])], [['O/Citadel', 2]]), { 1: [4, { 'o/citadel': 2 }], 2: [3, { 'o/citadel': 2, 'o/peek': 1 }] });
  assert.deepEqual(plan([desk, pc(2, 2, 2, ['o/citadel', 'o/peek'])], [['o/citadel', 5]])[2], [2, { 'o/citadel': 5, 'o/peek': 1 }]);
  // Machine 1 has no room: machine 2 keeps its whole plan.
  assert.deepEqual(plan([{ ...desk, runners: 0 }, pc(2, 2, 4, ['o/citadel'])])[2], [4, {}]);
  // No order stands after every one with an order; same order, or none at all, keeps the whole plan; another owner's is their own.
  assert.deepEqual(plan([desk, pc(2, null, 4, ['o/citadel'])])[2], [0, {}]);
  assert.deepEqual(plan([desk, pc(2, 1, 4, ['o/citadel'])])[2], [4, {}]);
  assert.deepEqual(plan([pc(1, null, 4, ['o/citadel']), pc(2, null, 4, ['o/citadel'])])[2], [4, {}]);
  assert.deepEqual(plan([desk, pc(2, 2, 4, ['o/citadel'], 7)])[2], [4, {}]);
});

test('the relay sends each runner agent its part, and a row whose runner agent is from before offers its update line', () => {
  const store = new Store(':memory:');
  const relay = new MachineRelay(store, () => {});
  relay.agentUrl = 'http://perigee:8574';
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const pc = store.createMachine('desk', 'x', 'Josh', josh.id);
  const stream = () => {
    const sent: string[] = [];
    const r = new EventEmitter() as EventEmitter & ServerResponse;
    Object.assign(r, { writeHead() {}, write: (d: string) => (sent.push(d), true), end: () => r.emit('close') });
    return { r, sent };
  };
  const win = stream();
  const wsl = stream();
  // As the connect route does: the new agent says plans=1, the one from before says nothing.
  relay.runnerPlans.set(`${pc.id}:windows`, true);
  relay.connectAgent(pc, win.r, { host: 'DESK', command: 'citadel runner agent', runners: true, os: 'windows' });
  relay.runnerPlans.set(`${pc.id}:linux`, false);
  relay.connectAgent(pc, wsl.r, { host: 'DESK', command: 'citadel runner agent', runners: true, os: 'linux' });
  try {
    relay.sendRunnerPlan(pc.id, 'windows', { runners: 2, queued: { 'o/peek': 1 } });
    assert.deepEqual(
      win.sent.filter((d) => d.includes('"plan"')),
      [`data: ${JSON.stringify({ plan: { runners: 2, queued: { 'o/peek': 1 } } })}\n\n`],
    );
    assert.ok(!wsl.sent.some((d) => d.includes('"plan"')));
    assert.deepEqual(relay.view(store.getMachine(pc.id)!).runner_update, { os: ['linux'], url: 'http://perigee:8574' });
    relay.runnerPlans.set(`${pc.id}:linux`, true);
    assert.equal(relay.view(store.getMachine(pc.id)!).runner_update, null);
  } finally {
    win.r.end();
    wsl.r.end();
  }
});

test("an agent's samples say which runners it can wake; anything but a short list of repo names is refused", () => {
  const body = (wakeable: unknown) => ({ os: 'linux', host: 'desk', cores: 8, cpu: 10, mem_total: 1, mem_free: 1, runners: [], wakeable });
  assert.deepEqual(cleanSample(body(['O/Citadel', 'o/citadel', 'o/twi']), 1).wakeable, ['o/citadel', 'o/citadel', 'o/twi']);
  assert.equal('wakeable' in cleanSample({ ...body(null), wakeable: undefined }, 1), false, 'an older agent says nothing');
  for (const bad of ['o/x', [1, 2], [''], Array(65).fill('o/x')]) assert.throws(() => cleanSample(body(bad), 1), /wakeable must be/);
});
