import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ANDROID_JDK, ANDROID_SDK, androidEnv, ClaudeLink, containerPath, GRADLE_PROPS, IMAGE_PATH, signInOutcome, signInUrl, TOOL_DIRS } from '../src/claude-link.ts';
import { Containers, runArgs, specHash, type RunCmd } from '../src/containers.ts';
import { Credentials } from '../src/credentials.ts';
import { CodexLink } from '../src/codex-link.ts';
import { Store } from '../src/db.ts';
import { Runner, usageKey, wrapperAlive } from '../src/runner.ts';
import { TURN_SLICE } from '../src/turn-launch.ts';
import { stopTurns, testPins } from './helpers.ts';
testPins();

// Turns in a person's own Claude container (#213). A fake `podman` on PATH runs `exec` on the host,
// so the whole path runs: placeFor, the detached wrapper, its heartbeat, the stream and the finish.
const root = mkdtempSync(join(tmpdir(), 'claude-container-'));
after(async () => {
  await stopTurns(root); // turns are detached: end them before deleting their folders (#271)
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'host-claude');
// The server's own login: a container turn must never get it.
process.env.ANTHROPIC_API_KEY = 'the-servers-key';
// The host's runtime folder, which a container doesn't have (#225).
process.env.XDG_RUNTIME_DIR = '/run/user/host';
const bin = join(root, 'bin');
mkdirSync(bin);
const calls = join(root, 'podman-calls.jsonl');
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
if (detached) spawn(run, rest, { detached: true, stdio: 'ignore' }).unref();
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
if (process.env.FAKE_SYSTEMD_RUN_FAILS) process.exit(1);
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
  const pinBin = process.env.PATH.split(':')[0];
  const codexPinned = existsSync(pinBin + '/citadel-codex-review') && existsSync(pinBin + '/../codex-review.ts') && !!codex && existsSync(codex.script);
  appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ env: process.env, codex, codexPinned }) + '\\n');
  if (input.includes('expired')) {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}' }));
    process.exit(1);
  }
  console.log(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { seven_day: { utilization: 0.42 } } } }));
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
  process.exit(0);
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
  const r = new Runner(store, () => {}, () => ({ COORDINATOR_TOKEN: 'secret' }), fake);
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
async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(check(), 'timed out');
}
const notes = (id: number) => store.listEvents(id).filter((e) => e.kind === 'note').map((e) => JSON.parse(e.data).text as string);
const status = (id: number) => store.getTicket(id)!.status;

test("a linked person's turn runs in their container, on their login, and keeps its usage apart", async () => {
  const id = newTicket();
  const r = runner(inContainer);
  r.send(id, 'Josh', 'build it');
  await until(() => status(id) === 'running');
  // A server restart doesn't stop a container turn, so it doesn't hold up the idle restart.
  assert.equal(r.inContainer('citadel-claude-test-2'), 1);
  assert.equal(r.interruptible(), 0);
  await until(() => status(id) === 'idle');
  const execs = readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const start = execs.find((a) => a[0] === 'exec' && a[1] === '-d');
  assert.equal(start[2], 'citadel-claude-test-2');
  assert.match(start[4], /turn-wrapper\.ts$/);
  const env = JSON.parse(readFileSync(seen, 'utf8').trim().split('\n').at(-1)!).env;
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, join(volume, '.claude'));
  assert.equal(env.COORDINATOR_CONTAINER, '1');
  // The host's Android SDK and JDK (#379), where it has them (on perigee it does), at the same paths as on the host.
  assert.equal(env.ANDROID_HOME, androidEnv(homedir()).ANDROID_HOME);
  assert.equal(env.JAVA_HOME, androidEnv(homedir()).JAVA_HOME);
  // citadel-heavy (#325): pinned in the turn's folder, ahead of the image's tools, and its slots in the mounted projects folder.
  assert.match(env.PATH, /^[^:]*\/pin\/bin:.*:\/usr\/local\/bin:/);
  assert.match(env.CITADEL_HEAVY_DIR, /\/projects\/\.heavy$/);
  assert.match(env.CITADEL_HEAVY_WHO, / #\d+ \(josh\)$/);
  // Codex reviews (#330): the managed hook reads the turn's tripwire from a file, which never asks (no card in Codex); the reviewer is pinned beside citadel-heavy.
  const { codex, codexPinned } = JSON.parse(readFileSync(seen, 'utf8').trim().split('\n').at(-1)!);
  assert.match(codex.script, /\/pin\/tripwire\.ts$/);
  assert.equal(codex.config.ask, false);
  assert.equal(codex.config.project, store.getTicket(id)!.project_id);
  assert.ok(codexPinned, 'the tripwire, citadel-codex-review and its driver are pinned in the turn');
  // Not a typed message (#295): no person, not even empty.
  assert.ok(!('CITADEL_PERSON_ID' in env) && !('CITADEL_PERSON_LOGIN' in env));
  // The host's runtime folder isn't in the container: .NET's named mutexes need one that exists (#225).
  assert.equal(env.XDG_RUNTIME_DIR, env.TMPDIR);
  assert.ok(statSync(env.XDG_RUNTIME_DIR).isDirectory());
  assert.equal(store.getSetting<any>(usageKey(josh.id))?.weekly?.utilization, 0.42);
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
  await until(() => status(id) === 'idle');
  const env = JSON.parse(readFileSync(seen, 'utf8').trim().split('\n').at(-1)!).env;
  assert.deepEqual([env.CITADEL_PERSON_ID, env.CITADEL_PERSON_LOGIN, env.COORDINATOR_CONTAINER], [String(josh.id), 'josh', '1']);
});

test("a container turn's exec runs in a scope of its own under the turns slice, so a restart of the server's unit doesn't kill its conmon (#258)", async () => {
  const id = newTicket();
  const r = runner(inContainer);
  r.units = true;
  r.send(id, 'Josh', 'build it');
  await until(() => status(id) === 'idle');
  const execs = readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const scope = execs.findLast((c) => c[0] === 'systemd-run');
  assert.ok(scope, 'the exec starts through systemd-run');
  assert.ok(scope.includes('--user') && scope.includes('--scope') && scope.includes('--collect') && scope.includes(`--slice=${TURN_SLICE}`), scope.join(' '));
  assert.ok(scope.some((a: string) => new RegExp(`^--unit=citadel-turn-[0-9a-f]{8}-${id}-\\d+$`).test(a)), scope.join(' '));
  const cmd = scope.slice(scope.findIndex((a: string) => a === 'podman'));
  assert.deepEqual(cmd.slice(0, 4), ['podman', 'exec', '-d', 'citadel-claude-test-2']);
  assert.ok(notes(id).every((n) => !/citadel-claude-test-2:/.test(n)));
});

test("a container turn still runs when systemd-run fails, with a plain podman exec (#258)", async () => {
  const id = newTicket();
  const r = runner(inContainer);
  r.units = true;
  process.env.FAKE_SYSTEMD_RUN_FAILS = '1';
  try {
    const before = readFileSync(calls, 'utf8').trim().split('\n').length;
    r.send(id, 'Josh', 'build it');
    await until(() => status(id) === 'idle');
    const execs = readFileSync(calls, 'utf8').trim().split('\n').slice(before).map((l) => JSON.parse(l));
    const failed = execs.findIndex((c) => c[0] === 'systemd-run');
    assert.ok(failed >= 0, 'it tried the scope first');
    assert.ok(execs.slice(failed + 1).some((c) => c[0] === 'exec' && c[1] === '-d' && c[2] === 'citadel-claude-test-2'), 'then ran podman exec itself');
    assert.ok(notes(id).every((n) => !/citadel-claude-test-2:/.test(n)));
  } finally {
    delete process.env.FAKE_SYSTEMD_RUN_FAILS;
  }
});

test("a person who can't run turns gets the reason as a note and no turn", async () => {
  const id = newTicket();
  const r = runner(() => ({ refused: 'Turns for Josh start once they link their Claude account' }));
  r.send(id, 'Josh', 'build it');
  await until(() => notes(id).some((n) => /link their Claude account/.test(n)));
  assert.notEqual(status(id), 'running');
});

test('a sign-in Anthropic refuses mid-turn marks the link expired and says so', async () => {
  const id = newTicket();
  const r = runner(inContainer);
  const expired: number[] = [];
  r.onAuthFailure = (p) => expired.push(p);
  r.send(id, 'Josh', 'expired');
  await until(() => notes(id).some((n) => /sign-in expired/.test(n)));
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

test('podman run arguments: keep-id, host network, a :U volume, binds at their own path, the spec label', () => {
  const spec = { name: 'citadel-claude-1', image: 'localhost/citadel-claude:abc', mounts: [{ src: 'citadel-claude-1', dst: '/home/u', volume: true }, { src: '/data/projects', dst: '/data/projects' }, { src: '/opt/claude', dst: '/opt/claude', ro: true }], env: { HOME: '/home/u' }, memory: '6g', cpus: 4 };
  const args = runArgs(spec);
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
  const spec = link.spec(josh.id);
  const home = process.env.HOME!;
  for (const m of spec.mounts) {
    for (const bad of ['.ssh', '.config/gh', '.config/claude-coordinator', '.claude/.credentials.json', 'coordinator.db', 'state.db']) assert.ok(!m.src.includes(bad), `${m.src} mounts ${bad}`);
    assert.ok(m.volume || m.src === m.dst, `${m.src} sits at its own path`);
  }
  assert.ok(!spec.mounts.some((m) => !m.volume && m.src === join(home, '.claude')), "the server's own Claude folder stays out");
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
  assert.ok(log.some((c) => c[0] === 'systemd-run'), 'a stopped one is started again');
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
  await until(() => status(a) === 'idle' && status(b) === 'idle');
  // The wrapper's folder, from each container's `podman exec -d <container> node <wrapper> <dir>`.
  const execs = readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const dirOf = (container: string) => execs.findLast((c) => c[0] === 'exec' && c[1] === '-d' && c[2] === container).at(-1) as string;
  const annDir = dirOf(link.name(ann.id));
  const benDir = dirOf(link.name(ben.id));
  const sees = (uid: number, path: string) => link.spec(uid).mounts.some((m) => !m.volume && (path === m.src || path.startsWith(m.src + '/')));
  assert.ok(sees(ann.id, annDir) && sees(ben.id, benDir), 'each container sees its own turns');
  assert.ok(!sees(ann.id, benDir), "Ann's container can't reach Ben's turn files");
  assert.ok(!sees(ben.id, annDir), "Ben's container can't reach Ann's turn files");
  // A turn on the host (the server login's) keeps its folder straight under run/turns.
  assert.ok(!sees(ann.id, join(r.turnsDir, `${a}-1`)), "no container reaches the host's turn files");
});

test("a container turn has the host's tools: the image installs what schemes' scripts call, host toolchains are mounted, the image's own win (#247)", () => {
  // Tools Delve's, Peek Auras' and Mandate's scripts and the kit call, by the image package that brings each.
  const containerfile = readFileSync(join(import.meta.dirname, '..', 'deploy', 'claude-container', 'Containerfile'), 'utf8');
  const apt = containerfile.match(/apt-get install -y --no-install-recommends ([^&]+)/)![1].split(/[\s\\]+/).filter(Boolean);
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
    const mounts = link.spec(josh.id).mounts;
    for (const d of ['.dotnet', '.local/bin', '.local/share/mise', '.local/godot', '.local/share/godot/export_templates', '.cargo/bin', '.rustup', '.cache/ms-playwright', '.local/share/android-sdk']) {
      assert.ok(mounts.some((m) => m.src === join(home, d) && m.dst === join(home, d) && m.ro), `${d} is mounted read-only`);
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
    assert.ok(link.spec(josh.id).mounts.some((m) => m.src === sdk && m.dst === sdk && m.ro), 'the SDK is mounted read-only');
    await link.ensure(josh.id);
    assert.equal(readFileSync(join(vol, GRADLE_PROPS), 'utf8'), 'org.gradle.daemon=false\n');
  } finally {
    process.env.HOME = saved;
  }
});

test("Godot's export templates are mounted only where the host has them, and the rest of its data folder stays the person's own (#290)", () => {
  const home = mkdtempSync(join(root, 'godot-home-'));
  mkdirSync(join(home, '.local/share/godot/app_userdata'), { recursive: true });
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const link = new ClaudeLink(store, new Credentials(store, 'x'.repeat(40)), join(root, 'data'), fake, new Containers(async () => ({ code: 0, stdout: '', stderr: '' })), 'citadel-claude-godot-');
    const godot = (mounts: { src: string }[]) => mounts.filter((m) => m.src.startsWith(join(home, '.local/share/godot')));
    assert.deepEqual(godot(link.spec(josh.id).mounts), [], 'no templates on the host: nothing mounted');
    const templates = join(home, '.local/share/godot/export_templates');
    mkdirSync(join(templates, '4.7.2.stable.mono'), { recursive: true });
    assert.deepEqual(godot(link.spec(josh.id).mounts), [{ src: templates, dst: templates, ro: true }]);
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
  runner(inContainer).recover();
  assert.ok(!existsSync(join(person, '8-1')), 'a dead turn goes');
  assert.ok(existsSync(join(person, '8-2')), 'a running one stays');
  assert.ok(existsSync(person), "the person's folder stays mounted");
});

test("the sign-in link is read from the terminal's output", () => {
  assert.equal(signInUrl('Browser didn\'t open? Use the url below:\nhttps://claude.ai/oauth/authorize?code=true&client_id=x&state=y\n\nPaste code here'), 'https://claude.ai/oauth/authorize?code=true&client_id=x&state=y');
  assert.equal(signInUrl('Opening browser…'), null);
});

test("a failed sign-in says Claude's own last words, without the link or the pasted code", () => {
  const out = 'Opening browser to sign in...\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&' + 'x'.repeat(400) + '\nPaste code here if prompted > abc#def\n\nLogin failed: Request failed with status code 400\n';
  const said = signInOutcome(out, 'abc#def');
  assert.equal(said, 'Paste code here if prompted > [code] Login failed: Request failed with status code 400');
});
