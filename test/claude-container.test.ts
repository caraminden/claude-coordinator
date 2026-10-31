import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
const inContainer = () => ({ host: false as const, container: 'citadel-claude-test-2', configDir: join(volume, '.claude'), env: { HOME: volume, CLAUDE_CONFIG_DIR: join(volume, '.claude'), DISABLE_AUTOUPDATER: '1' }, ensure: async () => {} });

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
  await until(() => status(id) === 'idle');
  const execs = readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const start = execs.find((a) => a[0] === 'exec' && a[1] === '-d');
  assert.equal(start[2], 'citadel-claude-test-2');
  assert.match(start[4], /turn-wrapper\.ts$/);
  const env = JSON.parse(readFileSync(seen, 'utf8').trim().split('\n').at(-1)!).env;
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CONFIG_DIR, join(volume, '.claude'));
  assert.equal(env.COORDINATOR_CONTAINER, '1');
  assert.equal(store.getSetting<any>(usageKey(josh.id))?.weekly?.utilization, 0.42);
  assert.equal(store.getSetting('usage'), null);
  assert.ok(r.inContainer('citadel-claude-test-2') === false);
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
  await link.ensure(josh.id);
  assert.ok(existsSync(join(root, 'data', 'run', 'turns')) && existsSync(join(root, 'data', 'projects')));
  // ...and podman would make mount points inside HOME as root, leaving ~/.claude unwritable.
  const inHome = spec.mounts.filter((m) => !m.volume && m.dst.startsWith(home + '/'));
  assert.ok(inHome.length > 0);
  for (const m of inHome) assert.ok(existsSync(join(root, 'josh-vol-ensure', m.dst.slice(home.length + 1))), m.dst);
  assert.ok(log.some((c) => c[0] === 'systemd-run' && c.includes(`--unit=citadel-claude-t-${josh.id}`)));
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

test("the sign-in link is read from the terminal's output", () => {
  assert.equal(signInUrl('Browser didn\'t open? Use the url below:\nhttps://claude.ai/oauth/authorize?code=true&client_id=x&state=y\n\nPaste code here'), 'https://claude.ai/oauth/authorize?code=true&client_id=x&state=y');
  assert.equal(signInUrl('Opening browser…'), null);
});

test("a failed sign-in says Claude's own last words, without the link or the pasted code", () => {
  const out = 'Opening browser to sign in...\nIf the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&' + 'x'.repeat(400) + '\nPaste code here if prompted > abc#def\n\nLogin failed: Request failed with status code 400\n';
  const said = signInOutcome(out, 'abc#def');
  assert.equal(said, 'Paste code here if prompted > [code] Login failed: Request failed with status code 400');
});
