import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ClaudeLink, signInOutcome, signInUrl } from '../src/claude-link.ts';
import { Containers, runArgs, specHash, type RunCmd } from '../src/containers.ts';
import { Credentials } from '../src/credentials.ts';
import { Store } from '../src/db.ts';
import { Runner, usageKey, wrapperAlive } from '../src/runner.ts';

// Turns in a person's own Claude container (#213). A fake `podman` on PATH runs `exec` on the host,
// so the whole path runs: placeFor, the detached wrapper, its heartbeat, the stream and the finish.
const root = mkdtempSync(join(tmpdir(), 'claude-container-'));
after(() => rmSync(root, { recursive: true, force: true }));
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
process.env.PATH = `${bin}:${process.env.PATH}`;

const seen = join(root, 'seen.jsonl');
const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync } = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).once('line', (input) => {
  appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ env: process.env }) + '\\n');
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
const inContainer = () => ({ host: false as const, container: 'citadel-claude-test-2', configDir: join(volume, '.claude'), turnsDir: join(root, 'run', 'turns', 'person-2'), env: { HOME: volume, CLAUDE_CONFIG_DIR: join(volume, '.claude'), DISABLE_AUTOUPDATER: '1' }, ensure: async () => {} });

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
  // The container runs an old spec: a starting turn that's its only one restarts it; with another turn there, it waits.
  link.busy = () => 2;
  await link.ensure(josh.id, true);
  assert.equal(log.filter((c) => c[0] === 'systemd-run').length, 1);
  link.busy = () => 1;
  await link.ensure(josh.id, true);
  assert.equal(log.filter((c) => c[0] === 'systemd-run').length, 2);
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
