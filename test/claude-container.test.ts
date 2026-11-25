import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { turnPlace } from '../src/access.ts';
import { ANDROID_JDK, ANDROID_SDK, androidEnv, checkoutMountsAsync, ClaudeLink, containerPath, GRADLE_PROPS, IMAGE_PATH, signInOutcome, signInUrl, TOOL_DIRS } from '../src/claude-link.ts';
import { Containers, runArgs, specHash, unitProps, type RunCmd } from '../src/containers.ts';
import { Credentials } from '../src/credentials.ts';
import { CodexLink } from '../src/codex-link.ts';
import { Store } from '../src/db.ts';
import { fallbacks } from '../src/fallbacks.ts';
import { Runner, usageKey, wrapperAlive } from '../src/runner.ts';
import { TASKMASTER_SLICE, TURN_SLICE } from '../src/turn-launch.ts';
import { jsonLines, lines, tempRoot, testPins, followed, runnerInsides } from './helpers.ts';
import { holds } from './holds.ts';
import { until } from './wait.ts';
testPins();

// Turns in a person's own Claude container (#213). A fake `podman` on PATH runs `exec` on the host,
// so the whole path runs: placeFor, the detached wrapper, its heartbeat, the stream and the finish.
const tmp = tempRoot('claude-container-');
const root = tmp.dir;
after(() => tmp.teardown()); // turns are detached: teardown ends them before deleting their folders (#271)
process.env.CLAUDE_CONFIG_DIR = join(root, 'host-claude');
// The server's own login: a container turn must never get it.
process.env.ANTHROPIC_API_KEY = 'the-servers-key';
// The host's runtime folder, which a container doesn't have (#225).
process.env.XDG_RUNTIME_DIR = '/run/user/host';
const bin = join(root, 'bin');
mkdirSync(bin);
const calls = join(root, 'podman-calls.jsonl');
// The pid of the hung fake exec, for a test that ends it by hand.
const hungPid = join(root, 'hung-exec.pid');
writeFileSync(
  join(bin, 'podman'),
  `#!${process.execPath}
const { spawn, spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
if (args[0] !== 'exec') process.exit(0);
const detached = args[1] === '-d';
const [cmd, ...rest] = args.slice(detached ? 3 : 2);
const run = cmd === 'node' ? process.execPath : cmd;
// FAKE_PODMAN_HANGS: a detached exec never returns, as podman does on a stuck lock. FAKE_PODMAN_SLOW: it starts late.
const start = () => spawn(run, rest, { detached: true, stdio: 'ignore' }).unref();
// FAKE_PODMAN_FULL: the container whose minions hold it at its memory limit, where an exec stalls (#1882).
if (detached && (process.env.FAKE_PODMAN_HANGS || process.env.FAKE_PODMAN_FULL === args[2])) {
  require('node:fs').writeFileSync(${JSON.stringify(hungPid)}, String(process.pid));
  setInterval(() => {}, 1000);
}
else if (detached) setTimeout(start, Number(process.env.FAKE_PODMAN_SLOW ?? 0));
else process.exit(spawnSync(run, rest, { stdio: 'inherit' }).status ?? 1);
`,
);
chmodSync(join(bin, 'podman'), 0o755);
// A fake `systemd-run` logs its arguments (as ['systemd-run', ...]) and runs the command after its options.
writeFileSync(
  join(bin, 'systemd-run'),
  `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(['systemd-run', ...args]) + '\\n');
// It fails saying what FAKE_SYSTEMD_RUN_FAILS holds.
if (process.env.FAKE_SYSTEMD_RUN_FAILS) {
  process.stderr.write(process.env.FAKE_SYSTEMD_RUN_FAILS + '\\n');
  process.exit(1);
}
const [cmd, ...rest] = args.slice(args.findIndex((a) => !a.startsWith('-')));
process.exit(require('node:child_process').spawnSync(cmd, rest, { stdio: 'inherit' }).status ?? 1);
`,
);
chmodSync(join(bin, 'systemd-run'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const seen = join(root, 'seen.jsonl');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  // What Codex's managed hook and citadel-codex-review find while the turn runs (#330); the turn's folder goes once it ends.
  const codex = process.env.CITADEL_CODEX_TRIPWIRE ? JSON.parse(readFileSync(process.env.CITADEL_CODEX_TRIPWIRE, 'utf8')) : null;
  const pinBin = process.env.PATH.split(':').find((d) => d.endsWith('/pin/bin'));
  const codexPinned = existsSync(pinBin + '/citadel-codex-review') && existsSync(pinBin + '/../codex-review.ts') && !!codex && existsSync(codex.script);
  appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ env: process.env, codex, codexPinned }) + '\\n');
  if (input.includes('expired')) {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}' }));
    process.exit(1);
  }
  const finish = () => {
    console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.42 } } } }));
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
    process.exit(0);
  };
  // 'hold <file>': runs until that file appears, as a long turn does.
  const hold = /hold ([^\\s"\\\\]+)/.exec(input)?.[1];
  if (hold) setInterval(() => existsSync(hold) && finish(), 20);
  else finish();
});
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const josh = store.createUser({ name: 'Josh', login: 'josh' });
const volume = join(root, 'josh-volume');
mkdirSync(join(volume, '.claude'), { recursive: true });

function runner(place: NonNullable<Runner['placeFor']>) {
  const r = new Runner(
    store,
    () => {},
    () => ({ COORDINATOR_TOKEN: 'secret' }),
    fake,
  );
  r.resumeGapMs = 10;
  r.pollMs = 10;
  r.personOf = () => josh.id;
  r.placeFor = place;
  return r;
}
const inContainer = () => ({ host: false as const, container: 'citadel-claude-test-2', configDir: join(volume, '.claude'), home: volume, turnsDir: join(root, 'run', 'turns', 'person-2'), env: { HOME: volume, CLAUDE_CONFIG_DIR: join(volume, '.claude'), DISABLE_AUTOUPDATER: '1' }, ensure: async () => {} });

function newTicket() {
  const t = store.createTicket({ project_id: project.id, title: 'T', permission_mode: 'default', created_by: 'Josh' });
  store.setTicketDir(t.id, root, null);
  return t.id;
}
/** The scheme's one Taskmaster (a scheme has one at a time). */
let made: { id: number } | undefined;
function taskmaster() {
  if (!made) {
    made = store.createTicket({ project_id: project.id, title: 'Taskmaster', permission_mode: 'default', created_by: 'Josh', kind: 'coordinator' });
    store.setTicketDir(made.id, root, null);
  }
  return made;
}
const notes = (id: number) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === 'note')
    .map((e) => JSON.parse(e.data).text as string);
const status = (id: number) => store.getTicket(id)!.status;
const errors = (id: number) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === 'error')
    .map((e) => JSON.parse(e.data).text as string);

test("a linked person's turn runs in their container, on their login, and keeps its usage apart", async () => {
  const id = newTicket();
  const r = runner(inContainer);
  r.send(id, 'Josh', 'build it');
  await until('the turn is followed', () => followed(r, id));
  // A server restart doesn't stop a container turn, so it doesn't hold up the idle restart.
  assert.equal(r.inContainer('citadel-claude-test-2'), 1);
  assert.equal(r.interruptible(), 0);
  await until("status(id) === 'idle'", () => status(id) === 'idle');
  const execs = jsonLines(calls);
  const start = execs.find((a) => a[0] === 'exec' && a[1] === '-d');
  assert.equal(start[2], 'citadel-claude-test-2');
  assert.match(start[4], /turn-wrapper\.mjs$/);
  const env = jsonLines(seen).at(-1).env;
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, join(volume, '.claude'));
  assert.equal(env.COORDINATOR_CONTAINER, '1');
  // The host's Android SDK and JDK (#379), where it has them (on perigee it does), at the same paths as on the host.
  assert.equal(env.ANDROID_HOME, androidEnv(homedir()).ANDROID_HOME);
  assert.equal(env.JAVA_HOME, androidEnv(homedir()).JAVA_HOME);
  // citadel-heavy (#325): pinned in the turn's folder, ahead of the image's tools, behind only the heavy-command shims (#1298), and its slots in the mounted projects folder.
  assert.match(env.PATH, /^[^:]*\/pin\/bin\/heavy:[^:]*\/pin\/bin:.*:\/usr\/local\/bin:/);
  assert.match(env.CITADEL_HEAVY_DIR, /\/projects\/\.heavy$/);
  assert.match(env.CITADEL_HEAVY_WHO, / #\d+ \(josh\)$/);
  // Codex reviews (#330): the managed hook reads the turn's tripwire from a file, which never asks (no card in Codex); the reviewer is pinned beside citadel-heavy.
  const { codex, codexPinned } = jsonLines(seen).at(-1);
  assert.match(codex.script, /\/pin\/tripwire\.ts$/);
  assert.equal(codex.config.ask, false);
  assert.equal(codex.config.project, store.getTicket(id)!.project_id);
  assert.ok(codexPinned, 'the tripwire, citadel-codex-review and its driver are pinned in the turn');
  // Not a typed message (#295): no person, not even empty.
  assert.ok(!('CITADEL_PERSON_ID' in env) && !('CITADEL_PERSON_LOGIN' in env));
  // The host's runtime folder isn't in the container: .NET's named mutexes need one that exists (#225).
  assert.equal(env.XDG_RUNTIME_DIR, env.TMPDIR);
  assert.ok(statSync(env.XDG_RUNTIME_DIR).isDirectory());
  assert.equal(store.getSetting<{ weekly?: { utilization: number } }>(usageKey(josh.id))?.weekly?.utilization, 0.42);
  assert.equal(store.getSetting('usage'), null);
  // Josh's meter shows his own plan; the server login's owner keeps the server's.
  assert.equal(r.usageOf(josh.id)?.weekly?.utilization, 0.42);
  assert.equal(r.payerOf(josh.id), josh.id);
  const owner = store.createUser({ name: 'Owner', login: 'owner', server_login: true });
  assert.equal(r.payerOf(owner.id), null);
  assert.equal(r.usageOf(owner.id), null);
  assert.equal(r.inContainer('citadel-claude-test-2'), 0);
  // A landing running on the host does: the restart would kill it.
  r.hostJobs = () => 1;
  assert.equal(r.interruptible(), 1);
});

test("a container turn answering the person's own typed message carries their id and login, as a host turn does (#295)", async () => {
  const id = newTicket();
  const r = runner(inContainer);
  r.send(id, 'Josh', 'what is on my list?', [], { typed: true });
  await until("status(id) === 'idle'", () => status(id) === 'idle');
  const env = jsonLines(seen).at(-1).env;
  assert.deepEqual([env.CITADEL_PERSON_ID, env.CITADEL_PERSON_LOGIN, env.COORDINATOR_CONTAINER], [String(josh.id), 'josh', '1']);
});

test("a container turn's exec runs in a scope of its own under the turns slice, so a restart of the server's unit doesn't kill its conmon (#258)", async () => {
  const id = newTicket();
  const r = runner(inContainer);
  r.units = true;
  r.send(id, 'Josh', 'build it');
  await until("status(id) === 'idle'", () => status(id) === 'idle');
  const execs = jsonLines(calls);
  const scope = execs.findLast((c) => c[0] === 'systemd-run');
  assert.ok(scope, 'the exec starts through systemd-run');
  assert.ok(scope.includes('--user') && scope.includes('--scope') && scope.includes('--collect') && scope.includes(`--slice=${TURN_SLICE}`), scope.join(' '));
  assert.ok(
    scope.some((a: string) => new RegExp(`^--unit=citadel-turn-[0-9a-f]{8}-${id}-\\d+$`).test(a)),
    scope.join(' '),
  );
  const cmd = scope.slice(scope.findIndex((a: string) => a === 'podman'));
  assert.deepEqual(cmd.slice(0, 4), ['podman', 'exec', '-d', 'citadel-claude-test-2']);
  // A Taskmaster's goes with the other Taskmaster turns: minions at their slice's limit would stall its exec (#1882).
  const tm = taskmaster();
  r.send(tm.id, 'Josh', 'hello');
  await until("status(tm) === 'idle'", () => status(tm.id) === 'idle' && jsonLines(calls).some((c) => c[0] === 'systemd-run' && c.some((a: string) => a.startsWith('--unit=citadel-turn-') && a.includes(`-${tm.id}-`))));
  assert.ok(
    jsonLines(calls)
      .findLast((c) => c[0] === 'systemd-run')!
      .includes(`--slice=${TASKMASTER_SLICE}`),
  );
  assert.ok(notes(id).every((n) => !/citadel-claude-test-2:/.test(n)));
});

test('a container turn still runs when systemd-run fails, with a plain podman exec (#258)', async () => {
  const id = newTicket();
  const r = runner(inContainer);
  r.units = true;
  process.env.FAKE_SYSTEMD_RUN_FAILS = '1';
  try {
    const before = lines(calls).length;
    r.send(id, 'Josh', 'build it');
    await until("status(id) === 'idle'", () => status(id) === 'idle');
    const execs = jsonLines(calls).slice(before);
    const failed = execs.findIndex((c) => c[0] === 'systemd-run');
    assert.ok(failed >= 0, 'it tried the scope first');
    assert.ok(
      execs.slice(failed + 1).some((c) => c[0] === 'exec' && c[1] === '-d' && c[2] === 'citadel-claude-test-2'),
      'then ran podman exec itself',
    );
    assert.ok(notes(id).every((n) => !/citadel-claude-test-2:/.test(n)));
  } finally {
    delete process.env.FAKE_SYSTEMD_RUN_FAILS;
  }
});

test('turns that fall back to the server, on the host or in a container, are counted and raise one alert per cause (#519)', async () => {
  const alerts: { job: string; error: string; ticketId: number }[] = [];
  fallbacks.alert = async (_cause, job, error, ticketId) => (alerts.push({ job, error, ticketId }), true);
  const count = fallbacks.count;
  // A cause no earlier test met, as alerts go once per cause for the life of the server.
  process.env.FAKE_SYSTEMD_RUN_FAILS = 'Failed to start transient scope unit: Unit citadel-turns.slice not found.';
  try {
    const host = newTicket();
    const onHost = runner(() => ({ host: true }));
    onHost.units = true;
    onHost.send(host, 'Josh', 'build it');
    await until("status(host) === 'idle'", () => status(host) === 'idle');
    assert.equal(fallbacks.count, count + 1, "the host turn ran as the server's child, and counts");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].ticketId, host);
    assert.match(alerts[0].error, /Unit citadel-turns\.slice not found/);

    const inBox = newTicket();
    const r = runner(inContainer);
    r.units = true;
    r.send(inBox, 'Josh', 'build it');
    await until("status(inBox) === 'idle'", () => status(inBox) === 'idle');
    assert.equal(fallbacks.count, count + 2, "the container turn's exec ran in the server's cgroup, and counts");
    assert.equal(alerts.length, 1, 'the same cause raises no second alert');
  } finally {
    delete process.env.FAKE_SYSTEMD_RUN_FAILS;
  }
});

test("a person who can't run turns gets the reason as a note and no turn", async () => {
  const id = newTicket();
  const r = runner(() => ({ refused: 'Turns for Josh start once they link their Claude account' }));
  r.send(id, 'Josh', 'build it');
  await until('notes(id).some((n) => /link their Claude account/.test(n))', () => notes(id).some((n) => /link their Claude account/.test(n)));
  assert.notEqual(status(id), 'running');
});

test('a sign-in Anthropic refuses mid-turn marks the link expired and says so', async () => {
  const id = newTicket();
  const r = runner(inContainer);
  const expired: number[] = [];
  r.onAuthFailure = (p) => expired.push(p);
  r.send(id, 'Josh', 'expired');
  await until('notes(id).some((n) => /sign-in expired/.test(n))', () => notes(id).some((n) => /sign-in expired/.test(n)));
  assert.deepEqual(expired, [josh.id]);
});

test('a container turn whose heartbeat stops counts as gone, whatever its pid says', () => {
  const dir = join(root, 'stale');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'container'), 'citadel-claude-test-2');
  assert.equal(wrapperAlive(dir), null);
  writeFileSync(join(dir, 'beat'), '');
  assert.equal(wrapperAlive(dir), true);
  utimesSync(join(dir, 'beat'), new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  assert.equal(wrapperAlive(dir), false);
});

// #1255: a container at its MemoryHigh stalls every process in it, the wrapper's heartbeat too, for a minute or more.
// The runner took the stale heartbeat for a dead turn and deleted the folder (pin/tripwire.ts with it) under a claude that ran on.
test('a container turn frozen past its heartbeat keeps running and keeps its pin folder while its wrapper lives', async () => {
  const id = newTicket();
  const r = runner(inContainer);
  const release = join(root, 'release-frozen');
  r.send(id, 'Josh', `hold ${release}`);
  const turn = () => store.getSetting<{ dir?: string }>(`turn:${id}`)?.dir;
  await until('the wrapper has said its pid', () => !!turn() && existsSync(join(turn()!, 'pid.json')));
  const dir = turn()!;
  const { wrapper } = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8'));
  process.kill(wrapper, 'SIGSTOP');
  try {
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(dir, 'beat'), old, old);
    assert.equal(wrapperAlive(dir), true, 'its wrapper process is there, only stalled');
    // The gone check runs every 20th poll tick: wait out three of them.
    const ticks = () => (r as unknown as { turns: Map<number, { ticks: number }> }).turns.get(id)?.ticks ?? 0;
    const from = ticks();
    await until('three gone checks have run', () => ticks() >= from + 60 || status(id) !== 'running');
    assert.equal(status(id), 'running');
    assert.ok(existsSync(join(dir, 'pin', 'tripwire.ts')), 'the pin folder stays under a running turn');
    assert.ok(!errors(id).some((e) => /killed before it finished/.test(e)));
  } finally {
    process.kill(wrapper, 'SIGCONT');
  }
  writeFileSync(release, '');
  await until('the turn ends', () => status(id) !== 'running');
  assert.ok(!existsSync(dir), 'its folder goes once it has ended');
});

test('a container turn whose wrapper process is gone and whose heartbeat stopped counts as gone', async () => {
  const id = newTicket();
  const r = runner(inContainer);
  r.killStarved = async () => ({ starved: false, why: '' });
  r.send(id, 'Josh', `hold ${join(root, 'never')}`);
  const turn = () => store.getSetting<{ dir?: string }>(`turn:${id}`)?.dir;
  await until('the wrapper has said its pid', () => !!turn() && existsSync(join(turn()!, 'pid.json')));
  const dir = turn()!;
  const { wrapper, claude } = JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8'));
  // The wrapper first, as a killed container ends both with no last word: killed second, a wrapper scheduled between the kills recorded claude's SIGKILL in exit.json, and the turn read as killed by a signal, not as its container gone (#1471).
  process.kill(wrapper, 'SIGKILL');
  process.kill(claude, 'SIGKILL');
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(dir, 'beat'), old, old);
  await until('the turn is cut off', () => status(id) !== 'running');
  assert.ok(
    notes(id).some((e) => /killed before it finished[\s\S]*its container was killed/.test(e)),
    'named as killed',
  );
  // A first kill is resumed by the server (#1364); the resume's prompt has no hold, so it ends well.
  await until('the resume ends', () => status(id) === 'idle' && !r.isRunning(id) && !r.killWait(id));
  assert.deepEqual(errors(id), []);
});

test('podman run arguments: keep-id, host network, a :U volume, binds at their own path, the spec label', () => {
  const spec = {
    name: 'citadel-claude-1',
    image: 'localhost/citadel-claude:abc',
    mounts: [
      { src: 'citadel-claude-1', dst: '/home/u', volume: true },
      { src: '/data/projects', dst: '/data/projects' },
      { src: '/opt/claude', dst: '/opt/claude', ro: true },
    ],
    env: { HOME: '/home/u' },
    memory: { high: '10G', max: '12G', swap: '4G' },
  };
  const args = runArgs(spec);
  // The memory caps sit on the systemd unit: podman's --memory never reached a cgroup with a memory controller (#1214).
  assert.ok(!args.includes('--memory') && !args.includes('--cpus'));
  assert.deepEqual(unitProps(spec), ['-p', 'MemoryHigh=10G', '-p', 'MemoryMax=12G', '-p', 'MemorySwapMax=4G']);
  assert.notEqual(specHash(spec), specHash({ ...spec, memory: { ...spec.memory, max: '14G' } }), 'a new cap restarts the container once idle');
  // Podman's own default is 2048 tasks, which every turn of the person shares: on 2026-11-24 it was reached and five claudes aborted (#1848).
  assert.deepEqual(
    args.filter((x) => x.startsWith('--pids-limit')),
    ['--pids-limit=32768'],
  );
  // A slice of its own is in the hash; without one the hash is as before, so people's running containers are kept (#1882).
  assert.notEqual(specHash(spec), specHash({ ...spec, slice: 'citadel-taskmasters.slice' }));
  assert.ok(runArgs({ ...spec, chown: false }).includes('citadel-claude-1:/home/u'));
  // The limit is in the hash (without it this spec's is 58d8a50d7a94), so a container started before it restarts once idle.
  assert.equal(specHash(spec), '3851a80c72b8');
  for (const a of ['--userns=keep-id', '--network=host', '--init', '--rm']) assert.ok(args.includes(a), a);
  assert.ok(!args.some((a) => /--pid=host|--privileged/.test(a)));
  assert.ok(args.includes('citadel-claude-1:/home/u:U'));
  assert.ok(args.includes('type=bind,src=/opt/claude,dst=/opt/claude,ro'));
  assert.ok(args.includes(`citadel.spec=${specHash(spec)}`));
  assert.deepEqual(args.slice(-3), ['localhost/citadel-claude:abc', 'sleep', 'infinity']);
});

test("ClaudeLink: never mounts a login, a key or the database; turns go where the person's link says", async () => {
  const log: string[][] = [];
  const fakeRun: RunCmd = async (cmd, args) => {
    log.push([cmd, ...args]);
    if (args[0] === 'container' && args[1] === 'inspect') return { code: 0, stdout: 'true deadbeef', stderr: '' };
    if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: join(root, 'josh-vol-ensure') + '\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const creds = new Credentials(store, 'x'.repeat(40));
  const link = new ClaudeLink(store, creds, join(root, 'data'), fake, new Containers(fakeRun), 'citadel-claude-t-');
  const spec = await link.spec(josh.id);
  const home = process.env.HOME!;
  for (const m of spec.mounts) {
    for (const bad of ['.ssh', '.config/gh', '.config/claude-coordinator', '.claude/.credentials.json', 'coordinator.db', 'state.db']) assert.ok(!m.src.includes(bad), `${m.src} mounts ${bad}`);
    assert.ok(m.volume || m.src === m.dst || m.dst === '/etc/codex' || (m.src === '/dev/null' && m.ro), `${m.src} sits at its own path`);
  }
  assert.ok(!spec.mounts.some((m) => !m.volume && m.src === join(home, '.claude')), "the server's own Claude folder stays out");
  // Codex's hook comes from the code the server runs, not the image's copy, so a long-running container gets a deployed fix (#748).
  const hook = join(import.meta.dirname, '..', 'deploy', 'claude-container', 'codex');
  assert.deepEqual(
    spec.mounts.filter((m) => m.dst === '/etc/codex'),
    [{ src: hook, dst: '/etc/codex', ro: true }],
  );
  assert.ok(existsSync(join(hook, 'citadel-hook.mjs')));
  // The code the server runs is readable, never writable (#621).
  const checkout = join(import.meta.dirname, '..');
  // A test tree with devDependencies installed (fast-check's node_modules, #1657) has too many ignored files to cover, so it isn't mounted: the spec follows checkoutMountsAsync.
  const covered = await checkoutMountsAsync(checkout);
  assert.deepEqual(
    spec.mounts.filter((m) => m.src === checkout),
    covered ? [{ src: checkout, dst: checkout, ro: true }] : [],
  );
  // Files git ignores there can hold secrets: each is covered, read-only, and a checkout git can't list isn't mounted.
  const live = mkdtempSync(join(root, 'live-'));
  execFileSync('git', ['init', '-q', live]);
  writeFileSync(join(live, '.gitignore'), '.env\n*.db\n');
  writeFileSync(join(live, '.env'), 'TOKEN=x');
  writeFileSync(join(live, 'c.db'), '');
  writeFileSync(join(live, 'code.ts'), '');
  assert.deepEqual(await checkoutMountsAsync(live), [
    { src: live, dst: live, ro: true },
    { src: '/dev/null', dst: join(live, '.env'), ro: true },
    { src: '/dev/null', dst: join(live, 'c.db'), ro: true },
  ]);
  assert.equal(await checkoutMountsAsync(join(root, 'not-a-repo')), null);
  assert.equal(link.place(josh.id), null);
  assert.equal(link.linked(josh.id), null);
  // A fresh server has no run/turns yet; podman refuses a bind mount whose folder is missing.
  // Two turns starting at once share one start.
  await Promise.all([link.ensure(josh.id, true), link.ensure(josh.id, true)]);
  assert.equal(log.filter((c) => c[0] === 'systemd-run').length, 1);
  assert.ok(existsSync(join(root, 'data', 'run', 'turns')) && existsSync(join(root, 'data', 'projects')));
  // ...and podman would make mount points inside HOME as root, leaving ~/.claude unwritable.
  const inHome = spec.mounts.filter((m) => !m.volume && m.dst.startsWith(home + '/'));
  assert.ok(inHome.length > 0);
  for (const m of inHome) assert.ok(existsSync(join(root, 'josh-vol-ensure', m.dst.slice(home.length + 1))), m.dst);
  assert.ok(log.some((c) => c[0] === 'systemd-run' && c.includes(`--unit=citadel-claude-t-${josh.id}`)));
  // One turn running out of memory loses only its own process, not the container and every turn in it.
  assert.ok(log.some((c) => c[0] === 'systemd-run' && c.includes('OOMPolicy=continue')));
  // ...and past its cap only its own unit's processes are OOM-killed, on the unit before podman's own arguments (#1214).
  const unit = log.find((c) => c[0] === 'systemd-run')!;
  for (const p of ['MemoryHigh=12G', 'MemoryMax=14G', 'MemorySwapMax=4G']) assert.ok(unit.indexOf(p) > 0 && unit.indexOf(p) < unit.indexOf('podman'), p);
  // The container runs an old spec: a starting turn that's its only one restarts it; with another turn there, it waits.
  link.busy = () => 2;
  await link.ensure(josh.id, true);
  assert.equal(log.filter((c) => c[0] === 'systemd-run').length, 1);
  link.busy = () => 1;
  await link.ensure(josh.id, true);
  assert.equal(log.filter((c) => c[0] === 'systemd-run').length, 2);
  // A server shutting down has let go of its turns, so busy() reads 0 while they still run: it never replaces the container.
  link.close();
  link.busy = () => 0;
  await link.ensure(josh.id, true);
  assert.equal(log.filter((c) => c[0] === 'systemd-run').length, 2);
  link.busy = () => 1;
  // Unlinking under running turns is refused rather than stopping the container under them.
  await assert.rejects(link.unlink(josh.id), /Turns are running/);
  link.busy = () => 0;
  creds.put(josh.id, 'claude_runner', link.name(josh.id), { container: link.name(josh.id), home: volume, linkedAt: 1 });
  const place = link.place(josh.id);
  assert.ok(place && !place.host && place.container === 'citadel-claude-t-' + josh.id && place.configDir === join(volume, '.claude'));
  link.expire(josh.id);
  assert.equal(link.place(josh.id), null);
  assert.equal(link.linked(josh.id), 'expired');
  await link.unlink(josh.id);
  assert.equal(link.linked(josh.id), null);
  assert.ok(log.some((c) => c.join(' ').includes(`volume rm -f citadel-claude-t-${josh.id}`)));
  const cara = store.createUser({ name: 'Cara2', login: 'cara2', admin: true, server_login: true });
  assert.deepEqual(link.place(cara.id), { host: true });
});

test("the server login gets a Codex-only container (#341): its Codex turns go there with the host's Claude folder, its Claude turns stay on the host, and unlinking Claude leaves it", async () => {
  const log: string[][] = [];
  const vol = join(root, 'server-login-vol');
  const fakeRun: RunCmd = async (cmd, args) => {
    log.push([cmd, ...args]);
    if (args[0] === 'container' && args[1] === 'inspect') return { code: 0, stdout: 'true deadbeef', stderr: '' };
    if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: vol + '\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), join(root, 'data'), fake, new Containers(fakeRun), 'citadel-claude-sl-');
  const owner = store.createUser({ name: 'Owner341', login: 'owner341', admin: true, server_login: true });
  const codex = new CodexLink(link, new Containers(fakeRun));
  assert.equal(link.codexPlace(owner.id), null, 'no container until its Codex sign-in makes one');
  assert.equal(codex.status(owner.id).state, 'not linked', 'so Settings offers the sign-in');
  assert.equal(codex.status(josh.id).state, 'no container', 'anyone else still needs their Claude linked');
  await link.ensure(owner.id);
  const place = link.codexPlace(owner.id);
  assert.ok(place && !place.host);
  assert.equal(place.container, `citadel-claude-sl-${owner.id}`);
  assert.equal(place.home, vol);
  assert.equal(place.configDir, join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME!, '.claude')), "the host's Claude folder, where its sessions are");
  assert.equal(place.turnsDir, link.turnsDir(owner.id));
  assert.deepEqual(link.place(owner.id), { host: true }, 'its Claude turns stay on the host');
  assert.equal(link.codexPlace(josh.id), null, 'only for the server login');
  mkdirSync(join(vol, '.codex'), { recursive: true });
  writeFileSync(join(vol, '.codex', 'auth.json'), '{}');
  assert.equal(codex.status(owner.id).state, 'linked');
  await link.unlink(owner.id);
  assert.ok(!log.some((c) => c.join(' ').includes('volume rm')), 'it has no Claude link, so its volume stays');
});

test('a paused container with turns in it is never replaced, and an idle one is (#1938)', async () => {
  const log: string[][] = [];
  const vol = join(root, 'pause-vol');
  let up = 'false';
  let paused = true;
  const fakeRun: RunCmd = async (cmd, args) => {
    log.push([cmd, ...args]);
    if (cmd === 'systemd-run') [up, paused] = ['true', false];
    // podman's own words for a paused one: Running false, Paused true.
    if (args[0] === 'container' && args[1] === 'inspect') return { code: 0, stdout: `${paused && args[3].includes('.State.Paused') ? 'paused' : up} deadbeef`, stderr: '' };
    if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: vol + '\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), join(root, 'data'), fake, new Containers(fakeRun), 'citadel-claude-pause-');
  const touched = () => log.filter((c) => c[0] === 'systemd-run' || c[1] === 'stop' || c[1] === 'rm');
  link.busy = () => 25;
  await assert.rejects(link.ensure(josh.id, true), /is paused with turns in it.*podman unpause citadel-claude-pause-/);
  assert.deepEqual(touched(), []);
  link.busy = () => 1; // the starting turn alone
  await link.ensure(josh.id, true);
  assert.ok(touched().some((c) => c[0] === 'systemd-run'));
});

test("a host turn wakes the server login's stopped Codex container for its reviews, and never replaces a running one, stale or not (#398)", async () => {
  const log: string[][] = [];
  const vol = join(root, 'wake-vol');
  let running = 'true';
  const fakeRun: RunCmd = async (cmd, args) => {
    log.push([cmd, ...args]);
    if (cmd === 'systemd-run') running = 'true';
    if (args[0] === 'container' && args[1] === 'inspect') return { code: 0, stdout: `${running} deadbeef`, stderr: '' };
    if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: vol + '\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), join(root, 'data'), fake, new Containers(fakeRun), 'citadel-claude-wake-');
  const owner = store.createUser({ name: 'Owner398', login: 'owner398', admin: true, server_login: true });
  await link.wakeCodex(owner.id);
  assert.equal(log.length, 0, 'no Codex container yet: nothing to wake');
  await link.ensure(owner.id);
  log.length = 0;
  await link.wakeCodex(owner.id);
  assert.ok(!log.some((c) => c[0] === 'systemd-run' || c.includes('stop') || c.includes('rm')), `a running one is left alone, though its spec is stale: ${JSON.stringify(log)}`);
  running = 'false';
  await link.wakeCodex(owner.id);
  assert.ok(
    log.some((c) => c[0] === 'systemd-run'),
    'a stopped one is started again',
  );
  await link.wakeCodex(josh.id);
});

test("a person's container mounts their own turns' files, never another person's or the host's (#241)", async () => {
  const fakeRun: RunCmd = async (_cmd, args) => {
    if (args[0] === 'container' && args[1] === 'inspect') return { code: 0, stdout: 'true deadbeef', stderr: '' };
    if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: join(root, 'iso-vol') + '\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const creds = new Credentials(store, 'x'.repeat(40));
  // Claude Code's folder is mounted read-only, so the fake one sits apart from the data dir, as the real one does.
  const bin = join(root, 'claude-versions');
  mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), '');
  const link = new ClaudeLink(store, creds, root, join(bin, 'claude'), new Containers(fakeRun), 'citadel-claude-iso-');
  const ann = store.createUser({ name: 'Ann', login: 'ann' });
  const ben = store.createUser({ name: 'Ben', login: 'ben' });
  for (const u of [ann, ben]) creds.put(u.id, 'claude_runner', link.name(u.id), { container: link.name(u.id), home: volume, linkedAt: 1 });
  const r = runner((uid) => link.place(uid) ?? { refused: 'not linked' });
  r.personOf = (author) => (author === 'Ann' ? ann.id : ben.id);
  const a = newTicket();
  const b = newTicket();
  r.send(a, 'Ann', 'go');
  r.send(b, 'Ben', 'go');
  await until("status(a) === 'idle' && status(b) === 'idle'", () => status(a) === 'idle' && status(b) === 'idle');
  // The wrapper's folder, from each container's `podman exec -d <container> node <wrapper> <dir>`.
  const execs = jsonLines(calls);
  const dirOf = (container: string) => execs.findLast((c) => c[0] === 'exec' && c[1] === '-d' && c[2] === container).at(-1) as string;
  const annDir = dirOf(link.name(ann.id));
  const benDir = dirOf(link.name(ben.id));
  const sees = async (uid: number, path: string) => (await link.spec(uid)).mounts.some((m) => !m.volume && (path === m.src || path.startsWith(m.src + '/')));
  assert.ok((await sees(ann.id, annDir)) && (await sees(ben.id, benDir)), 'each container sees its own turns');
  assert.ok(!(await sees(ann.id, benDir)), "Ann's container can't reach Ben's turn files");
  assert.ok(!(await sees(ben.id, annDir)), "Ben's container can't reach Ann's turn files");
  // A turn on the host (the server login's) keeps its folder straight under run/turns.
  assert.ok(!(await sees(ann.id, join(r.turnsDir, `${a}-1`))), "no container reaches the host's turn files");
});

/** A linked person's ClaudeLink over a podman that logs its calls; `running` names the containers up, from any spec. */
function linkedPerson(tag: string) {
  const log: string[][] = [];
  const running = new Set<string>();
  const vol = join(root, `${tag}-vol`);
  const fakeRun: RunCmd = async (cmd, args) => {
    log.push([cmd, ...args]);
    if (args[0] === 'container' && args[1] === 'inspect') return running.has(args.at(-1)!) ? { code: 0, stdout: 'true deadbeef', stderr: '' } : { code: 1, stdout: '', stderr: 'no such container' };
    if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: vol + '\n', stderr: '' };
    if (cmd === 'systemd-run') running.add(args.find((a) => a.startsWith('--unit='))!.slice(7));
    if (cmd === 'podman' && args[0] === 'stop') running.delete(args.at(-1)!);
    return { code: 0, stdout: '', stderr: '' };
  };
  const creds = new Credentials(store, 'x'.repeat(40));
  // Claude Code's folder is mounted read-only, so the fake one sits apart from the data dir.
  const claude = join(root, `${tag}-claude`, 'claude');
  mkdirSync(join(root, `${tag}-claude`));
  writeFileSync(claude, '');
  const link = new ClaudeLink(store, creds, root, claude, new Containers(fakeRun), `citadel-claude-${tag}-`);
  const user = store.createUser({ name: tag, login: tag });
  creds.put(user.id, 'claude_runner', link.name(user.id), { container: link.name(user.id), home: vol, linkedAt: 1 });
  const starts = () => log.filter((c) => c[0] === 'systemd-run');
  return { link, log, running, starts, uid: user.id };
}

test("a Taskmaster answers while its person's minions hold their container at its limit (#1882)", async () => {
  const { link, uid } = linkedPerson('room');
  const tm = taskmaster();
  const minion = newTicket();
  const r = runner((person, warm, taskmaster) => turnPlace(store, link, person, warm, taskmaster));
  r.personOf = () => uid;
  process.env.FAKE_PODMAN_FULL = link.name(uid);
  try {
    r.send(minion, 'room', 'build it');
    await until('the minion waits on its full container', () => jsonLines(calls).some((c) => c[0] === 'exec' && c[1] === '-d' && c[2] === link.name(uid)));
    const before = store.listEvents(tm.id).at(-1)?.id ?? 0;
    r.send(tm.id, 'room', 'is CI choking?');
    await until('the Taskmaster answers', () => status(tm.id) === 'idle' && store.listEvents(tm.id).some((e) => e.id > before && e.kind === 'claude' && JSON.parse(e.data).is_error === false));
    assert.equal(status(minion), 'running', 'the full container answers nobody');
    assert.deepEqual(errors(tm.id), []);
    // Its own person's login, in the same folder as ever.
    const env = jsonLines(seen).at(-1).env;
    assert.equal(env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude'));
    assert.equal(r.inContainer(link.name(uid)), 1, "the minion's turn");
  } finally {
    delete process.env.FAKE_PODMAN_FULL;
    r.stop(minion);
    process.kill(Number(readFileSync(hungPid, 'utf8')), 'SIGKILL');
  }
});

test("a Taskmaster's container waits out a sign-in's start, which chowns the volume they share (#1882)", async () => {
  const { link, starts, uid } = linkedPerson('signin');
  (link as unknown as { logins: Map<number, object> }).logins.set(uid, {});
  const name = link.name(uid);
  const inner = link as unknown as { containers: Containers };
  const start = inner.containers.start.bind(inner.containers);
  const at: string[] = [];
  let chowned = () => {};
  const chown = new Promise<void>((ok) => (chowned = ok));
  inner.containers.start = async (spec) => {
    at.push(spec.name);
    if (spec.name === name) await chown;
    await start(spec);
  };
  const main = link.ensure(uid);
  const tm = link.ensure(uid, true, true);
  await until('the sign-in starts', () => at.length > 0);
  await holds('the Taskmaster waits', () => !at.includes(`${name}-tm`), { ms: 400 });
  chowned();
  await Promise.all([main, tm]);
  assert.deepEqual(at, [name, `${name}-tm`]);
  assert.ok(starts()[0].includes(`${name}:${process.env.HOME}:U`), 'the sign-in mends the volume');
});

test("a Taskmaster's container is its person's other one: same volume and mounts, its own limit and slice, apart from a minions' container that fills, restarts or dies (#1882)", async () => {
  const { link, running, starts, uid } = linkedPerson('apart');
  const name = `citadel-claude-apart-${uid}`;
  const place = link.place(uid, undefined, true);
  const minions = link.place(uid);
  assert.ok(place && !place.host && minions && !minions.host);
  assert.deepEqual([place.container, minions.container], [`${name}-tm`, name]);
  // Same login, folders and account: only the container differs.
  assert.deepEqual({ ...place, container: 0, ensure: 0 }, { ...minions, container: 0, ensure: 0 });
  // The two start at once, each once, however many turns ask.
  await Promise.all([place.ensure(), minions.ensure(), link.ensure(uid, true, true)]);
  assert.equal(starts().length, 2);
  const unit = starts().find((c) => c.includes(`--unit=${name}-tm`))!;
  for (const p of ['--slice=citadel-taskmasters.slice', 'ManagedOOMPreference=omit', 'OOMPolicy=continue', 'MemoryHigh=3G', 'MemoryMax=4G', 'MemorySwapMax=2G']) assert.ok(unit.indexOf(p) > 0 && unit.indexOf(p) < unit.indexOf('podman'), p);
  const main = starts().find((c) => c.includes(`--unit=${name}`))!;
  assert.ok(main.includes('--slice=citadel.slice') && main.includes('MemoryHigh=12G'));
  // Neither start chowns the volume (:U walks it, and fails on a file the other container deletes meanwhile); a sign-in's does.
  for (const c of [unit, main]) assert.ok(c.includes(`${name}:${process.env.HOME}`), 'the one volume, as it is');
  assert.equal((await link.spec(uid)).chown, false);
  const signIn = link as unknown as { logins: Map<number, object> };
  signIn.logins.set(uid, {});
  assert.equal((await link.spec(uid)).chown, true);
  link.busy = (c) => (c === `${name}-tm` ? 1 : 0);
  assert.equal((await link.spec(uid)).chown, false, 'not while a Taskmaster turn writes in it');
  link.busy = () => 0;
  signIn.logins.delete(uid);
  assert.equal((await new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), root, fake, new Containers(), 'citadel-claude-new-').spec(store.createUser({ name: 'New', login: 'new' }).id)).chown, true);
  // Every mount the same but its list of sessions, which Claude Code keys by pid: one list each.
  const of = async (tm: boolean) => (await link.spec(uid, tm)).mounts.map((m) => `${m.src} ${m.dst}`);
  const [tms, minionMounts] = [await of(true), await of(false)];
  const extra = tms.filter((m) => !minionMounts.includes(m));
  assert.deepEqual(
    minionMounts.filter((m) => !tms.includes(m)),
    [],
  );
  assert.ok(extra.length > 0 && extra.every((m) => /sessions-taskmaster \S+\/sessions$/.test(m)), extra.join('\n'));
  // A changed spec replaces only the container with nothing running in it.
  link.busy = (c) => (c === name ? 20 : 0);
  await link.ensure(uid, true, true);
  await link.ensure(uid, true);
  assert.equal(starts().length, 3, "the Taskmaster's own, idle, restarted; the minions' busy one kept");
  link.busy = (c) => (c === `${name}-tm` ? 2 : 0);
  // The minions' container dies: its next start leaves the Taskmaster's turns running.
  running.delete(name);
  await link.ensure(uid, true);
  assert.ok(running.has(`${name}-tm`));
  assert.equal(starts().filter((c) => c.includes(`--unit=${name}-tm`)).length, 2);
  // Unlinking waits for a Taskmaster's turn too, then removes both.
  await assert.rejects(link.unlink(uid), /Turns are running/);
  link.busy = () => 0;
  await link.unlink(uid);
  assert.deepEqual([...running], []);
});

test("a container turn has the host's tools: the image installs what schemes' scripts call, host toolchains are mounted, the image's own win (#247)", async () => {
  // Tools Delve's, Peek Auras' and Mandate's scripts and the kit call, by the image package that brings each.
  const containerfile = readFileSync(join(import.meta.dirname, '..', 'deploy', 'claude-container', 'Containerfile'), 'utf8');
  const apt = containerfile
    .match(/apt-get install -y --no-install-recommends ([^&]+)/)![1]
    .split(/[\s\\]+/)
    .filter(Boolean);
  for (const pkg of ['graphviz', 'xvfb', 'xauth', 'ffmpeg', 'chromium', 'sqlite3', 'socat', 'jq', 'ripgrep', 'python3']) assert.ok(apt.includes(pkg), `the image installs ${pkg}`);
  assert.match(containerfile, /bin\/gh \/usr\/local\/bin\/gh/);
  // Host toolchains sit in the person's home, read-only: dotnet, Godot, mise and rustup's rust, Playwright's Chromium.
  const home = mkdtempSync(join(root, 'tools-home-'));
  for (const d of [...TOOL_DIRS, '.cargo/registry', '.ssh']) mkdirSync(join(home, d), { recursive: true });
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const creds = new Credentials(store, 'x'.repeat(40));
    const link = new ClaudeLink(store, creds, join(root, 'data'), fake, new Containers(async () => ({ code: 0, stdout: '', stderr: '' })), 'citadel-claude-tools-');
    const mounts = (await link.spec(josh.id)).mounts;
    for (const d of ['.dotnet', '.local/bin', '.local/share/mise', '.local/godot', '.local/share/godot/export_templates', '.cargo/bin', '.rustup', '.cache/ms-playwright', '.local/share/android-sdk']) {
      assert.ok(
        mounts.some((m) => m.src === join(home, d) && m.dst === join(home, d) && m.ro),
        `${d} is mounted read-only`,
      );
    }
    // The crate cache and the rest of the home stay the person's own.
    assert.ok(!mounts.some((m) => !m.volume && (m.src === join(home, '.cargo') || m.src === join(home, '.ssh') || m.src === home)));
    // The host's dot and xvfb-run in ~/.local/bin start a podman image: in a container the image's own come first.
    creds.put(josh.id, 'claude_runner', link.name(josh.id), { container: link.name(josh.id), home: volume, linkedAt: 1 });
    const place = link.place(josh.id);
    assert.ok(place && !place.host);
    assert.equal(place.env.PATH, containerPath(process.env.PATH));
    creds.remove(josh.id, 'claude_runner');
  } finally {
    process.env.HOME = saved;
  }
  assert.equal(containerPath('/h/.dotnet:/h/.local/bin:/usr/local/bin:/usr/bin:/bin'), '/usr/local/bin:/usr/bin:/bin:/h/.dotnet:/h/.local/bin');
  assert.equal(containerPath(''), IMAGE_PATH.join(':'));
});

test("the host's Android toolchain (#379): turns get ANDROID_HOME and JAVA_HOME only once it's installed, and a container's ~/.gradle gets the host's no-daemon defaults", async () => {
  const home = mkdtempSync(join(root, 'android-home-'));
  assert.deepEqual(androidEnv(home, '/usr/bin'), {}, 'nothing installed: nothing set');
  mkdirSync(join(home, ANDROID_SDK), { recursive: true });
  assert.deepEqual(androidEnv(home, '/usr/bin'), {}, 'an SDK with no JDK builds nothing');
  mkdirSync(join(home, ANDROID_JDK, 'bin'), { recursive: true });
  const sdk = join(home, ANDROID_SDK);
  assert.deepEqual(androidEnv(home, '/usr/bin'), { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, JAVA_HOME: join(home, ANDROID_JDK), PATH: `/usr/bin:${join(home, ANDROID_JDK, 'bin')}` });
  mkdirSync(join(home, '.gradle'));
  writeFileSync(join(home, GRADLE_PROPS), 'org.gradle.daemon=false\n');
  const vol = join(root, 'android-vol');
  const fakeRun: RunCmd = async (_cmd, args) => {
    if (args[0] === 'container' && args[1] === 'inspect') return { code: 0, stdout: 'true deadbeef', stderr: '' };
    if (args[0] === 'volume' && args[1] === 'inspect') return { code: 0, stdout: vol + '\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), join(root, 'data'), fake, new Containers(fakeRun), 'citadel-claude-android-');
    assert.ok(
      (await link.spec(josh.id)).mounts.some((m) => m.src === sdk && m.dst === sdk && m.ro),
      'the SDK is mounted read-only',
    );
    await link.ensure(josh.id);
    assert.equal(readFileSync(join(vol, GRADLE_PROPS), 'utf8'), 'org.gradle.daemon=false\n');
  } finally {
    process.env.HOME = saved;
  }
});

test("Godot's export templates are mounted only where the host has them, and the rest of its data folder stays the person's own (#290)", async () => {
  const home = mkdtempSync(join(root, 'godot-home-'));
  mkdirSync(join(home, '.local/share/godot/app_userdata'), { recursive: true });
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), join(root, 'data'), fake, new Containers(async () => ({ code: 0, stdout: '', stderr: '' })), 'citadel-claude-godot-');
    const godot = (mounts: { src: string }[]) => mounts.filter((m) => m.src.startsWith(join(home, '.local/share/godot')));
    assert.deepEqual(godot((await link.spec(josh.id)).mounts), [], 'no templates on the host: nothing mounted');
    const templates = join(home, '.local/share/godot/export_templates');
    mkdirSync(join(templates, '4.7.2.stable.mono'), { recursive: true });
    assert.deepEqual(godot((await link.spec(josh.id)).mounts), [{ src: templates, dst: templates, ro: true }]);
  } finally {
    process.env.HOME = saved;
  }
});

test("a restart sweeps container turns' dead folders in each person's folder, and keeps live ones", () => {
  const person = join(root, 'run', 'turns', 'person-9');
  const turn = (name: string, beatAgo: number) => {
    mkdirSync(join(person, name), { recursive: true });
    writeFileSync(join(person, name, 'container'), 'citadel-claude-test-9');
    writeFileSync(join(person, name, 'beat'), '');
    const t = new Date(Date.now() - beatAgo);
    utimesSync(join(person, name, 'beat'), t, t);
  };
  turn('8-1', 60_000);
  turn('8-2', 0);
  // Frozen with its container at MemoryHigh (#1255): a stale heartbeat, but its wrapper process is still there.
  turn('8-3', 60_000);
  const frozen = tmp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', join(person, '8-3', 'pin', 'turn-wrapper.mjs'), join(person, '8-3')], { stdio: 'ignore' });
  // One started before #1343, whose wrapper was still turn-wrapper.ts.
  turn('8-4', 60_000);
  const older = tmp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', join(person, '8-4', 'pin', 'turn-wrapper.ts'), join(person, '8-4')], { stdio: 'ignore' });
  try {
    runner(inContainer).recover();
  } finally {
    frozen.kill('SIGKILL');
    older.kill('SIGKILL');
  }
  assert.ok(!existsSync(join(person, '8-1')), 'a dead turn goes');
  assert.ok(existsSync(join(person, '8-2')), 'a running one stays');
  assert.ok(existsSync(join(person, '8-3')), 'a stalled one stays');
  assert.ok(existsSync(join(person, '8-4')), 'a stalled one from before the wrapper was plain JS stays');
  assert.ok(existsSync(person), "the person's folder stays mounted");
});

test('a podman exec that never returns fails the turn after its time limit, not never (C6)', async () => {
  const id = newTicket();
  const r = runner(inContainer);
  r.containerStartMs = 300;
  process.env.FAKE_PODMAN_HANGS = '1';
  try {
    r.send(id, 'Josh', 'build it');
    await until("status(id) === 'error'", () => status(id) === 'error');
  } finally {
    delete process.env.FAKE_PODMAN_HANGS;
  }
  assert.match(errors(id)[0], /^Could not start claude: citadel-claude-test-2: podman did not return within 0\.3 s/);
  assert.equal(r.isRunning(id), false);
});

test('Stop ends a container turn whose claude has not started, and never will (C6)', async () => {
  const id = newTicket();
  const r = runner(inContainer);
  // The exec's own give-up (execFile's timer) is far past this test's end: when the turn ends, the stop ended it.
  r.containerStartMs = 600_000;
  process.env.FAKE_PODMAN_HANGS = '1';
  const dir = () => (r as any).turns.get(id)?.dir as string | undefined;
  // The earlier hang test leaves its pid file behind; clear it so the wait below sees this turn's exec.
  rmSync(hungPid, { force: true });
  try {
    r.send(id, 'Josh', 'build it');
    await until('the turn is followed', () => followed(r, id));
    const turnDir = dir()!;
    assert.ok(!existsSync(join(turnDir, 'pid.json')));
    await until('the exec is hanging', () => existsSync(hungPid));
    assert.equal(r.stop(id), true);
    await until('!r.isRunning(id)', () => !r.isRunning(id));
    // The give-up ends a turn as an error saying podman did not return; a stop ends it idle and says nothing.
    assert.equal(status(id), 'idle');
    assert.deepEqual(errors(id), []);
    // The exec ends later (killed here, as its give-up would), its turn's folder long gone: nothing is written, said or thrown.
    const pid = Number(readFileSync(hungPid, 'utf8'));
    assert.ok(pid > 0);
    process.kill(pid, 'SIGKILL');
    await until('the exec is gone', () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    });
    await holds('nothing is written, said or thrown', () => !existsSync(turnDir) && errors(id).length === 0, { ms: 300 });
    assert.ok(!existsSync(turnDir));
    assert.deepEqual(errors(id), []);
  } finally {
    delete process.env.FAKE_PODMAN_HANGS;
  }
});

test('a turn stopped while its container starts never reaches podman exec (C6)', async () => {
  const id = newTicket();
  let ready!: () => void;
  const r = runner(() => ({ ...inContainer(), ensure: () => new Promise<void>((res) => (ready = res)) }));
  r.send(id, 'Josh', 'build it');
  await until('the turn is followed', () => followed(r, id));
  const before = jsonLines(calls).length;
  r.stop(id);
  await until('!r.isRunning(id)', () => !r.isRunning(id));
  ready();
  await holds('the stopped turn never reaches podman exec', () => jsonLines(calls).slice(before).length === 0, { ms: 200 });
  assert.deepEqual(jsonLines(calls).slice(before), []);
  assert.equal(status(id), 'idle');
});

test("a container turn's claude that starts just after the stop is still signalled and followed to its end (C6, #468 S03-2)", async () => {
  const id = newTicket();
  // A claude that runs until it is told to stop.
  const patient = join(root, 'claude-patient');
  writeFileSync(patient, `#!${process.execPath}\nprocess.on('SIGINT', () => process.exit(130));\nsetInterval(() => {}, 1000);\n`);
  chmodSync(patient, 0o755);
  const r = new Runner(
    store,
    () => {},
    () => ({ COORDINATOR_TOKEN: 'secret' }),
    patient,
  );
  r.personOf = () => josh.id;
  r.placeFor = inContainer;
  r.pollMs = 3_600_000; // polled by hand below, to put the stop between the exec and claude's start
  process.env.FAKE_PODMAN_SLOW = '300';
  try {
    r.send(id, 'Josh', 'build it');
    await until('the turn to be followed', () => followed(r, id));
    const turnDir = runnerInsides(r).turns.get(id)!.dir;
    await until('jsonLines(calls).some((c) => c.includes(turnDir))', () => jsonLines(calls).some((c) => c.includes(turnDir))); // podman exec is under way
    r.stop(id);
    assert.ok(!existsSync(join(turnDir, 'pid.json')));
    assert.ok(existsSync(join(turnDir, 'exit.json')), 'the stop ends the turn at its next poll');
    await until("existsSync(join(turnDir, 'pid.json'))", () => existsSync(join(turnDir, 'pid.json')));
    const before = jsonLines(calls).length;
    (r as any).poll(id);
    assert.equal(r.isRunning(id), true, 'its claude runs, so the turn is not cut loose');
    await until('jsonLines(calls).length > before', () => jsonLines(calls).length > before);
    assert.match(jsonLines(calls)[before].join(' '), /^exec citadel-claude-test-2 sh -c kill -INT/); // SIGINT first, so claude records its result (AG-04)
    await until('{ (r as any).poll(id); return !r.isRunning(id); }', () => {
      (r as any).poll(id);
      return !r.isRunning(id);
    });
    assert.equal(status(id), 'idle');
    assert.deepEqual(errors(id), []);
  } finally {
    delete process.env.FAKE_PODMAN_SLOW;
  }
});

test("the sign-in link is read from the terminal's output", () => {
  assert.equal(signInUrl("Browser didn't open? Use the url below:\nhttps://claude.ai/oauth/authorize?code=true&client_id=x&state=y\n\nPaste code here"), 'https://claude.ai/oauth/authorize?code=true&client_id=x&state=y');
  assert.equal(signInUrl('Opening browser…'), null);
});

test("a failed sign-in says Claude's own last words, without the link or the pasted code", () => {
  const out = "Opening browser to sign in...\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&" + 'x'.repeat(400) + '\nPaste code here if prompted > abc#def\n\nLogin failed: Request failed with status code 400\n';
  const said = signInOutcome(out, 'abc#def');
  assert.equal(said, 'Paste code here if prompted > [code] Login failed: Request failed with status code 400');
});

test('a relayed message is checked against the person its turn would run for, so refuseTurn gets the sending thread (#468 S02-2)', () => {
  const id = newTicket();
  const r = runner(inContainer);
  const seenFrom: (number | undefined)[] = [];
  r.refuseTurn = (_t, _a, from) => (seenFrom.push(from), 'held');
  r.send(id, 'Taskmaster', 'relayed', [], { from: 77 });
  r.send(id, 'GitHub', 'CI passed');
  assert.deepEqual(seenFrom, [77, undefined]);
  assert.ok(notes(id).includes('held'));
});

test('ClaudeLink: starting a container turn never runs a blocking process spawn on the main thread', async () => {
  const cp = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const dataRoot = mkdtempSync(join(root, 'nospawn-'));
  const fakeRun: RunCmd = async (_c, args) => (args[0] === 'container' ? { code: 0, stdout: 'true deadbeef', stderr: '' } : { code: 0, stdout: join(dataRoot, 'vol') + '\n', stderr: '' });
  const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), join(dataRoot, 'data'), fake, new Containers(fakeRun), 'citadel-claude-t-');
  const real = cp.execFileSync;
  const sync: string[] = [];
  const spy = (...a: Parameters<typeof real>) => (sync.push(String(a[0])), real(...a));
  Object.assign(cp, { execFileSync: spy });
  syncBuiltinESMExports();
  try {
    await link.ensure(josh.id, true);
  } finally {
    Object.assign(cp, { execFileSync: real });
    syncBuiltinESMExports();
  }
  assert.deepEqual(sync, []);
});

test('checkoutMountsAsync: covers what git ignores right now, and a file ignored later is covered on the next read', async () => {
  const live = mkdtempSync(join(root, 'live-'));
  execFileSync('git', ['init', '-q', live]);
  writeFileSync(join(live, '.gitignore'), '.env\n*.db\n');
  writeFileSync(join(live, 'code.ts'), '');
  assert.deepEqual(await checkoutMountsAsync(live), [{ src: live, dst: live, ro: true }]);
  writeFileSync(join(live, '.env'), 'TOKEN=x');
  assert.deepEqual(await checkoutMountsAsync(live), [
    { src: live, dst: live, ro: true },
    { src: '/dev/null', dst: join(live, '.env'), ro: true },
  ]);
  assert.equal(await checkoutMountsAsync(join(live, 'nope')), null);
  for (let i = 0; i < 51; i++) writeFileSync(join(live, `f${i}.db`), '');
  assert.equal(await checkoutMountsAsync(live), null, 'over MAX_MASKED nothing is mounted');
});
