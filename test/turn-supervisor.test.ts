import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { claimSpec } from '../src/turn-run.mjs';
import { handTurn, readSupervisor, supervisorSpec } from '../src/supervisor-client.ts';
import { lines, stopProcs, stopTurns, testPins } from './helpers.ts';
import { until } from './wait.ts';
const pins = testPins();

// The shared turn supervisor (#1343, src/turn-supervisor.mjs) runs host turns' claude in place of a node wrapper per
// turn. These run it through the runner with a stand-in systemd-run on PATH (CI runners have no user systemd): a
// --scope runs its command in place, as the real one does, and a unit runs its command in the background. The fake
// claude is steer.test.ts's: it reads stdin line by line, replies once `release` is in its folder, and exits at the
// end of its input once it has replied.
const root = mkdtempSync(join(tmpdir(), 'supervisor-'));
const procs: ChildProcess[] = [];
const servers: Server[] = [];
after(async () => {
  await stopProcs(procs);
  for (const s of servers) s.close();
  await stopTurns(root); // the supervisor's and turns' processes name folders under root
  rmSync(root, { recursive: true, force: true });
});
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
process.env.CITADEL_SUPERVISOR_RETRY_MS = '100';
process.env.CITADEL_SUPERVISOR_ADOPT_MS = '200';

const bin = join(root, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'systemd-run'), `#!/bin/sh
echo "$*" >> "${bin}/calls"
scope= expand=1
while [ $# -gt 0 ]; do case $1 in
  --) shift; break;;
  --scope) scope=1;;
  --expand-environment=no) expand=;;
  -p|-E) shift;;
  -*) ;;
  *) break;;
esac; shift; done
# The real one turns a command's \$\$ into \$ unless told not to.
if [ -n "$scope" ]; then [ -f "${bin}/no-scope" ] || [ -n "$expand" ] && { echo "no scopes here" >&2; exit 1; }; exec "$@"; fi
setsid "$@" </dev/null >/dev/null 2>&1 &
`);
writeFileSync(join(bin, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> "${bin}/calls"\n`);
for (const f of ['systemd-run', 'systemctl']) chmodSync(join(bin, f), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
const calls = () => lines(join(bin, 'calls'));

const fake = join(root, 'claude-fake');
writeFileSync(
  fake,
  `#!${process.execPath}
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
let replied = false;
let closed = false;
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (l) => {
  const text = JSON.parse(l).message.content.find((b) => !b.text.startsWith('[System]: You are a minion working on #')).text;
  appendFileSync('seen.txt', text + '\\n');
  console.log(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'got ' + text }] } }));
});
rl.on('close', () => { closed = true; appendFileSync('closed.txt', 'x\\n'); });
setInterval(() => {
  if (!replied && existsSync('release')) {
    replied = true;
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' }));
    writeFileSync('replied', '');
  }
  if (replied && closed && !existsSync('hold')) process.exit(0);
}, 20);
`,
);
chmodSync(fake, 0o755);

const store = new Store(join(root, 'test.db'));
const project = store.createProject('Test', null);
const turnsDir = join(root, 'run', 'turns');

function server() {
  const r = new Runner(store, () => {}, () => ({}), fake);
  r.pollMs = 10;
  r.units = true;
  r.supervisor = true;
  return r;
}
const spec = (r: Runner) => (r as any).supervisorSpec();

function newTicket() {
  const t = store.createTicket({ project_id: project.id, kind: 'thread', title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const dir = join(root, `t${t.id}`);
  mkdirSync(dir);
  store.setTicketDir(t.id, dir, null);
  return { id: t.id, dir };
}
const seen = (dir: string) => lines(join(dir, 'seen.txt'));
const turnDir = (r: Runner, id: number): string => (r as any).turns.get(id).dir;
const pidJson = (dir: string) => JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8'));
const texts = (id: number) => store.listEvents(id).filter((e) => e.kind === 'claude').map((e) => e.data);

/** Start a turn and wait until claude has its first message; resolves with the turn's folder. */
async function started(r: Runner, t: { id: number; dir: string }, text = 'build it') {
  const before = seen(t.dir).length;
  r.send(t.id, 'Cara', text);
  await until('claude has the message', () => seen(t.dir).length === before + 1);
  const dir = turnDir(r, t.id);
  await until('pid.json', () => existsSync(join(dir, 'pid.json')));
  return dir;
}

async function finished(r: Runner, t: { id: number; dir: string }) {
  writeFileSync(join(t.dir, 'release'), '');
  await until('the turn has ended', () => !r.isRunning(t.id));
  rmSync(join(t.dir, 'release'), { force: true });
}

/** A runner with its supervisor up: the first turn starts it (and runs in its wrapper meanwhile). */
async function withSupervisor() {
  const r = server();
  if (!readSupervisor(spec(r).dir)) {
    const t = newTicket();
    const dir = await started(r, t);
    assert.equal(pidJson(dir).supervisor, undefined, 'none ran yet: the first turn has its wrapper');
    await until('the supervisor is up', () => !!readSupervisor(spec(r).dir));
    await finished(r, t);
  }
  return r;
}

test('a host turn runs in the shared supervisor, in a scope of its own named as its unit, with no wrapper of its own', async () => {
  const r = await withSupervisor();
  const t = newTicket();
  const before = calls().length;
  const dir = await started(r, t);
  const sup = readSupervisor(spec(r).dir)!;
  const p = pidJson(dir);
  assert.equal(p.supervisor, sup.pid);
  assert.equal(p.wrapper, p.claude, 'the scope\'s shell is the turn\'s process group, as claude was in the wrapper');
  const mine = calls().slice(before);
  const unit = (r as any).turns.get(t.id).unit;
  assert.ok(mine.some((c) => c.includes('--scope') && c.includes(`--unit=${unit}`)), mine.join('\n'));
  assert.ok(!mine.some((c) => c.includes('turn-wrapper.mjs')), 'no wrapper unit started');
  assert.doesNotMatch(readFileSync(join(dir, 'stderr.log'), 'utf8'), /own memory group/, 'it ran in its scope');
  assert.ok(Number.isInteger(p.wrapper), JSON.stringify(p));
  await finished(r, t);
  assert.ok(texts(t.id).some((d) => d.includes('got [Cara]: build it')));
  assert.ok(texts(t.id).some((d) => d.includes('"type":"result"') && d.includes('"is_error":false')));
});

test('a supervisor killed mid-turn: the turn finishes and its reply is recorded, a steer sent in the gap starts the next turn, and a new supervisor adopts the turn', async () => {
  const r = await withSupervisor();
  const t = newTicket();
  const dir = await started(r, t);
  const old = readSupervisor(spec(r).dir)!;
  assert.equal(pidJson(dir).supervisor, old.pid);
  process.kill(old.pid, 'SIGKILL');
  // Claude's stdin went with it: it still runs the turn it is on.
  await until('claude saw its input close', () => existsSync(join(t.dir, 'closed.txt')));
  r.send(t.id, 'Cara', 'in the gap', [], {}, true);
  // The runner starts another, which adopts the turn left running.
  await until('a new supervisor adopted the turn', () => {
    const s = readSupervisor(spec(r).dir);
    return !!s && s.pid !== old.pid && pidJson(dir).supervisor === s.pid;
  });
  assert.ok(existsSync(join(dir, `adopted.${old.pid}`)));
  rmSync(join(t.dir, 'closed.txt'));
  writeFileSync(join(t.dir, 'release'), '');
  await until('the steer starts the next turn', () => seen(t.dir).length === 2);
  assert.equal(seen(t.dir)[1], '[Cara]: in the gap');
  assert.ok(texts(t.id).some((d) => d.includes('"type":"result"')), 'the first turn\'s reply is recorded');
  await until('the next turn has ended', () => !r.isRunning(t.id));
  rmSync(join(t.dir, 'release'), { force: true });
});

test('a turn the supervisor can\'t take starts in its wrapper at once', async () => {
  const r = server();
  const s = spec(r);
  mkdirSync(s.dir, { recursive: true });
  // A supervisor that seems to run, at a port nothing listens on.
  const stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', 'turn-supervisor'], { stdio: 'ignore' });
  procs.push(stray);
  const port = await new Promise<number>((res) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const p = (probe.address() as { port: number }).port;
      probe.close(() => res(p));
    });
  });
  const saved = existsSync(join(s.dir, 'supervisor.json')) ? readFileSync(join(s.dir, 'supervisor.json'), 'utf8') : null;
  writeFileSync(join(s.dir, 'supervisor.json'), JSON.stringify({ pid: stray.pid, port, key: 'k', version: s.version }));
  try {
    const t = newTicket();
    const t0 = Date.now();
    const dir = await started(r, t);
    assert.ok(Date.now() - t0 < 1_500, `started in ${Date.now() - t0} ms`);
    assert.equal(pidJson(dir).supervisor, undefined, 'its wrapper runs it');
    await finished(r, t);
  } finally {
    if (saved) writeFileSync(join(s.dir, 'supervisor.json'), saved);
    else rmSync(join(s.dir, 'supervisor.json'), { force: true });
  }
});

test('a supervisor that doesn\'t answer in time: the runner starts the wrapper, and the spec\'s claim lets only one run the turn', async () => {
  const dir = join(turnsDir, '99-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ command: 'true', args: [], cwd: root, env: {} }));
  const s = supervisorSpec(join(root, 'hung'), 'test', pins);
  mkdirSync(s.dir, { recursive: true });
  const stray = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', 'turn-supervisor'], { stdio: 'ignore' });
  procs.push(stray);
  const hung = createServer(() => {}); // takes the request and never answers
  servers.push(hung);
  const port = await new Promise<number>((res) => hung.listen(0, '127.0.0.1', () => res((hung.address() as { port: number }).port)));
  writeFileSync(join(s.dir, 'supervisor.json'), JSON.stringify({ pid: stray.pid, port, key: 'k', version: s.version }));
  const t0 = Date.now();
  assert.equal(await handTurn(s, dir, [], 300), false);
  assert.ok(Date.now() - t0 < 1_000);
  // Whoever renames spec.json first runs the turn; the other finds it gone.
  assert.equal(claimSpec(dir)?.command, 'true');
  assert.equal(claimSpec(dir), null);
  assert.ok(!existsSync(join(dir, 'spec.json')), 'the claimed spec (it holds the turn\'s token) is gone');
});

test('a scope that won\'t start: the turn runs in the supervisor\'s group instead, and says so', async () => {
  const r = await withSupervisor();
  writeFileSync(join(bin, 'no-scope'), '');
  try {
    const t = newTicket();
    const dir = await started(r, t);
    assert.equal(pidJson(dir).supervisor, readSupervisor(spec(r).dir)!.pid);
    assert.match(readFileSync(join(dir, 'stderr.log'), 'utf8'), /own memory group didn't start \(systemd-run exited 1\)/);
    await finished(r, t);
    assert.ok(texts(t.id).some((d) => d.includes('"type":"result"')));
  } finally {
    rmSync(join(bin, 'no-scope'));
  }
});

test('Stop ends a supervisor turn: its scope by name, and claude by its process group', async () => {
  const r = await withSupervisor();
  const t = newTicket();
  const dir = await started(r, t);
  const unit = (r as any).turns.get(t.id).unit;
  const { claude } = pidJson(dir);
  assert.equal(r.stop(t.id), true);
  await until('the turn has ended', () => !r.isRunning(t.id));
  assert.throws(() => process.kill(claude, 0), 'claude is gone');
  assert.equal(store.getTicket(t.id)!.status, 'idle');
  // A stop with no pid to signal, or a kill, goes by the unit's name: a pattern, which matches a wrapper's
  // .service or a supervisor turn's .scope and is no error when it matches neither.
  (r as any).signal({ unit, dir }, 'SIGKILL');
  await until('stopped by pattern', () => calls().includes(`systemctl --user stop ${unit}.*`));
});
