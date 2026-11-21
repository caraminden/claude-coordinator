import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { tempRoot } from './helpers.ts';
import { scriptEnv } from './script-env.ts';
import { until } from './wait.ts';

// tools/heavy-unit (#1298): a heavy command runs in a scope of its own in citadel-heavy.slice, so memory running out
// kills that command and never the turn that ran it.
const unitTool = join(import.meta.dirname, '..', 'tools', 'heavy-unit');
const tmp = tempRoot('heavy-unit-');
const root = tmp.dir;
after(() => tmp.teardown());
const inContainer = existsSync('/run/.containerenv') || existsSync('/.dockerenv');
// Grows until something stops it: a few MB of node, then 10 MB a step, to 1 GB at most, so a box that doesn't enforce
// the test's 96M (no memory controller for the user's units) fails the test instead of filling up.
const ALLOC = `node -e 'const a=[];for(let i=0;i<100;i++)a.push(Buffer.alloc(1e7,1))'`;

test('without units it runs the command in place, first in line for the OOM killer, with its status', () => {
  const r = spawnSync(unitTool, ['sh', '-c', 'cat /proc/self/oom_score_adj; echo out; exit 7'], { env: scriptEnv({ CITADEL_HEAVY_UNIT: '0' }), encoding: 'utf8' });
  assert.equal(r.status, 7);
  assert.equal(r.stdout, '1000\nout\n');
});

test('when systemd-run cannot start the unit, it says so and runs the command in place', { skip: inContainer && 'a container runs in place before it asks systemd-run' }, async () => {
  const bin = join(root, 'bin');
  const run = join(root, 'run');
  spawnSync('mkdir', ['-p', bin, run]);
  const calls = join(root, 'calls');
  writeFileSync(join(bin, 'systemd-run'), `#!/bin/sh\necho "$@" >>'${calls}'\necho "Failed to connect to bus" >&2\nexit 1\n`);
  chmodSync(join(bin, 'systemd-run'), 0o755);
  // heavy-unit asks only for a user bus socket to exist before it calls systemd-run.
  const bus = createServer().listen(join(run, 'bus'));
  try {
    const r = spawnSync(unitTool, ['--what', 'a check', 'sh', '-c', 'echo ran; exit 3'], { env: scriptEnv({ PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: run, CITADEL_HEAVY_SLICE: 'citadel-heavy-test.slice' }), encoding: 'utf8' });
    assert.equal(r.status, 3);
    assert.equal(r.stdout, 'ran\n');
    assert.match(r.stderr, /could not start its own unit in citadel-heavy-test\.slice \(systemd-run exited 1\), so it runs here/);
    const args = readFileSync(calls, 'utf8');
    assert.match(args, /--user --scope .*--slice=citadel-heavy-test\.slice .*--description=heavy: a check/);
  } finally {
    bus.close();
  }
});

test('the shipped slice throttles its heavy commands before it kills one', () => {
  const slice = readFileSync(join(import.meta.dirname, '..', 'deploy', 'citadel-heavy.slice'), 'utf8');
  const size = (key: string) => {
    const m = slice.match(new RegExp(`^${key}=(\\d+)G$`, 'm'));
    assert.ok(m, `${key} in deploy/citadel-heavy.slice`);
    return Number(m[1]);
  };
  assert.ok(size('MemoryHigh') < size('MemoryMax'));
});

// The real thing, where this runs with a user systemd (perigee, a desktop): a fake turn is a transient service in a
// slice under citadel-turns.slice, with the OOMPolicy=stop every service has, as a real turn's unit.
const uid = process.getuid?.() ?? 0;
const memoryDelegated = (() => {
  try {
    return readFileSync(`/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/cgroup.subtree_control`, 'utf8').split(/\s+/).includes('memory');
  } catch {
    return false;
  }
})();
const userSystemd = !inContainer && memoryDelegated && spawnSync('systemd-run', ['--user', '--scope', '--quiet', 'true']).status === 0;
const tag = `hu${process.pid}`;
const turnSlice = `citadel-turns-${tag}.slice`;
const heavySlice = `citadel-heavy-${tag}.slice`;
const units: string[] = [];
const systemctl = (...a: string[]) => spawnSync('systemctl', ['--user', ...a], { encoding: 'utf8' });
after(() => {
  if (!userSystemd) return;
  // One at a time: systemctl stops none of a list when one of them (a turn already stopped) is gone.
  for (const u of [...units.map((u) => `${u}.service`), turnSlice, heavySlice]) {
    systemctl('stop', u);
    systemctl('reset-failed', u);
  }
});
/** Start a fake turn running `script` in `dir`, with heavy-unit's knobs pointed at this test's slices. */
function fakeTurn(name: string, dir: string, script: string, props: string[] = []) {
  const unit = `${tag}-${name}`;
  units.push(unit);
  // From a file: systemd would expand each $ in a unit's command line.
  writeFileSync(join(dir, 'turn.sh'), script);
  const env = { ...scriptEnv(), CITADEL_HEAVY_SLICE: heavySlice, CITADEL_HEAVY_UNIT_PROPS: 'MemoryMax=96M MemorySwapMax=0', HU: unitTool };
  const r = spawnSync('systemd-run', ['--user', '--quiet', `--unit=${unit}`, `--slice=${turnSlice}`, `--working-directory=${dir}`, ...props.flatMap((p) => ['-p', p]),
    ...['PATH', 'XDG_RUNTIME_DIR', 'HOME', 'CITADEL_HEAVY_SLICE', 'CITADEL_HEAVY_UNIT_PROPS', 'HU'].map((k) => `--setenv=${k}=${env[k] ?? ''}`), 'bash', join(dir, 'turn.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return `${unit}.service`;
}
const active = (unit: string) => systemctl('is-active', unit).stdout.trim();

test('a heavy command killed for memory leaves its turn alive, with a message the model can act on', { skip: !userSystemd && 'no user systemd with a memory controller here', timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(root, 'oom-'));
  const turn = fakeTurn('oom', dir, `"$HU" --what 'a big test' ${ALLOC} 2>err; echo $? >code; sleep 120`);
  await until('the heavy command to end', () => existsSync(join(dir, 'code')));
  assert.equal(readFileSync(join(dir, 'code'), 'utf8').trim(), '137');
  assert.match(readFileSync(join(dir, 'err'), 'utf8'), /killed for memory: `a big test` ran out of room in citadel-heavy-hu\d+\.slice .*your turn is fine\. Retry it/);
  assert.equal(active(turn), 'active');
});

test('without its own unit, the same command takes its whole turn down (what #1298 fixes)', { skip: !userSystemd && 'no user systemd with a memory controller here', timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(root, 'inplace-'));
  const turn = fakeTurn('inplace', dir, `CITADEL_HEAVY_UNIT=0 "$HU" ${ALLOC}; echo $? >code; sleep 120`, ['MemoryMax=96M', 'MemorySwapMax=0']);
  await until('the turn to stop', () => active(turn) !== 'active');
  assert.equal(systemctl('show', '-p', 'Result', '--value', turn).stdout.trim(), 'oom-kill');
});

test('--exec becomes the command, so the caller can stop it by the pid it started', { skip: !userSystemd && 'no user systemd with a memory controller here', timeout: 30_000 }, async () => {
  const child = tmp.spawn(unitTool, ['--exec', 'sh', '-c', 'echo $$; cat /proc/self/cgroup; exec sleep 300'], { env: scriptEnv({ CITADEL_HEAVY_SLICE: heavySlice }) });
  let out = '';
  child.stdout!.on('data', (b) => (out += b));
  try {
    await until('the command to start', () => out.includes('.scope'));
    const [pid, cgroup] = out.split('\n');
    assert.equal(Number(pid), child.pid);
    assert.match(cgroup, new RegExp(`/${heavySlice}/citadel-heavy-\\d+-\\d+\\.scope$`));
  } finally {
    child.kill();
  }
  assert.equal(await new Promise((r) => child.on('close', (_c, sig) => r(sig))), 'SIGTERM');
});

test("a TERM to heavy-unit stops its command too, so a script's `kill $!` doesn't leave a dev server running", { skip: !userSystemd && 'no user systemd with a memory controller here', timeout: 30_000 }, async () => {
  const child = tmp.spawn(unitTool, ['sh', '-c', 'echo $$; cat /proc/self/cgroup; exec sleep 300'], { env: scriptEnv({ CITADEL_HEAVY_SLICE: heavySlice }) });
  let out = '';
  child.stdout!.on('data', (b) => (out += b));
  const closed = new Promise((r) => child.on('close', (code) => r(code)));
  await until('the command to start', () => out.includes('.scope'));
  const pid = Number(out.split('\n')[0]);
  assert.notEqual(pid, child.pid, 'a command of its own, not heavy-unit');
  await until('sh to become sleep', () => readFileSync(`/proc/${pid}/comm`, 'utf8') === 'sleep\n'); // sh ignores QUIT itself while it runs
  const ignored = BigInt(`0x${readFileSync(`/proc/${pid}/status`, 'utf8').match(/^SigIgn:\s*(\w+)/m)![1]}`);
  assert.equal(ignored & 0b110n, 0n, 'Ctrl-C and Ctrl-\\ still reach it, though it runs in the background of heavy-unit');
  child.kill('SIGTERM');
  assert.equal(await closed, 143);
  await until('the command to stop', () => !existsSync(`/proc/${pid}`));
});

test('a heavy command stops when its turn ends', { skip: !userSystemd && 'no user systemd with a memory controller here', timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(root, 'bind-'));
  // Its $$ also checks that systemd-run hands the command each $ as it is.
  const turn = fakeTurn('bind', dir, `"$HU" sh -c 'echo $$ >pid; exec sleep 300'`);
  await until('the heavy command to start', () => existsSync(join(dir, 'pid')) && readFileSync(join(dir, 'pid'), 'utf8').endsWith('\n'));
  const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
  assert.match(readFileSync(`/proc/${pid}/cgroup`, 'utf8'), new RegExp(`/${heavySlice}/citadel-heavy-\\d+-\\d+\\.scope`));
  systemctl('stop', turn);
  await until('the heavy command to stop with its turn', () => !existsSync(`/proc/${pid}`));
});

test("its scope gets a TMPDIR on disk when the caller's is perigee's RAM-backed /tmp, and removes it when the command ends", { skip: inContainer && 'a container runs in place before it asks systemd-run' }, async () => {
  const bin = join(root, 'bin-tmp');
  const run = join(root, 'run-tmp');
  spawnSync('mkdir', ['-p', bin, run]);
  // A stand-in for systemd-run that runs what follows `--`, so the command's own environment is what is tested.
  writeFileSync(join(bin, 'systemd-run'), '#!/bin/sh\nwhile [ "$1" != -- ]; do shift; done; shift; exec "$@"\n');
  chmodSync(join(bin, 'systemd-run'), 0o755);
  const bus = createServer().listen(join(run, 'bus'));
  try {
    const disk = join(root, 'heavy-tmp');
    const onDisk = join(homedir(), '.cache'); // not under tmpdir(): CI has none set, so that is /tmp
    const r = spawnSync(unitTool, ['sh', '-c', 'echo "$TMPDIR"; touch "$TMPDIR/scratch"'], { env: scriptEnv({ PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: run, TMPDIR: '/tmp', CITADEL_HEAVY_TMP: disk, CITADEL_HEAVY_SLICE: 'citadel-heavy-test.slice' }), encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const seen = r.stdout.trim();
    assert.match(seen, new RegExp(`^${disk}/heavy-\\d+$`));
    assert.equal(existsSync(seen), false, 'its folder is gone once the command ended');
    // A TMPDIR already on disk stays the caller's.
    const kept = spawnSync(unitTool, ['sh', '-c', 'echo "$TMPDIR"'], { env: scriptEnv({ PATH: `${bin}:${process.env.PATH}`, XDG_RUNTIME_DIR: run, TMPDIR: onDisk, CITADEL_HEAVY_TMP: disk, CITADEL_HEAVY_SLICE: 'citadel-heavy-test.slice' }), encoding: 'utf8' });
    assert.equal(kept.stdout.trim(), onDisk);
  } finally {
    bus.close();
  }
});
