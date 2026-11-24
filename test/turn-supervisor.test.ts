import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Store } from '../src/db.ts';
import { Runner } from '../src/runner.ts';
import { fallbacks } from '../src/fallbacks.ts';
import { claimSpec } from '../src/turn-run.mjs';
import { readSupervisor } from '../src/supervisor-client.ts';
import { lines, tempRoot, testPins, followed } from './helpers.ts';
import { until } from './wait.ts';
testPins(); // the turn files the runner and its supervisor run from

// The shared turn supervisor (#1343, src/turn-supervisor.mjs) runs host turns' claude in place of a node wrapper per
// turn. These run it through the runner with a stand-in systemd-run on PATH (CI runners have no user systemd): a
// --scope runs its command in place, as the real one does, and a unit runs its command in the background. The fake
// claude is steer.test.ts's: it reads stdin line by line, replies once `release` is in its folder, and exits at the
// end of its input once it has replied.
const tmp = tempRoot('supervisor-');
const root = tmp.dir;
after(() => tmp.teardown()); // ends the supervisor's and turns' processes, which name folders under root, then deletes them
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
process.env.CITADEL_SUPERVISOR_RETRY_MS = '100';
process.env.CITADEL_SUPERVISOR_ADOPT_MS = '200';

const bin = join(root, 'bin');
mkdirSync(bin);
writeFileSync(
  join(bin, 'systemd-run'),
  `#!/bin/sh
echo "$*" >> "${bin}/calls"
case "$*" in *turn-wrapper.mjs*) date +%s%3N >> "${bin}/unit-at";; esac
scope= expand=1
while [ $# -gt 0 ]; do case $1 in
  --) shift; break;;
  --scope) scope=1;;
  --expand-environment=no) expand=;;
  -p|-E) shift;;
  -*) ;;
  *) break;;
esac; shift; done
# The real one turns a command's \$\$ into \$ unless told not to. hang-scope: a scope slow to start, failing once it goes.
if [ -n "$scope" ]; then
  [ -f "${bin}/hang-scope" ] && : > "${bin}/scope-hanging"
  while [ -f "${bin}/hang-scope" ]; do sleep 0.05; [ -f "${bin}/hang-scope" ] || exit 1; done
  [ -f "${bin}/no-scope" ] || [ -n "$expand" ] && { echo "no scopes here" >&2; exit 1; }; exec "$@"; fi
setsid "$@" </dev/null >/dev/null 2>&1 &
`,
);
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
// cmd: a command the turn runs, started late enough (2 s on) to count as one (quiet.ts checkProcess).
let cmd = null;
if (existsSync('cmd')) setTimeout(() => {
  cmd = require('node:child_process').spawn('/bin/sh', ['-c', 'while :; do sleep 0.2; done'], { stdio: 'ignore' });
  writeFileSync('cmd.started', '');
}, 2500);
process.on('exit', () => cmd && cmd.kill());
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
  const r = new Runner(
    store,
    () => {},
    () => ({}),
    fake,
  );
  r.pollMs = 10;
  r.units = true;
  r.supervisor = true;
  return r;
}
const spec = (r: Runner) => (r as any).supervisorSpec();

function newTicket() {
  const t = store.createTicket({ project_id: project.id, kind: 'ticket', title: 'T', permission_mode: 'default', created_by: 'Cara' });
  const dir = join(root, `t${t.id}`);
  mkdirSync(dir);
  store.setTicketDir(t.id, dir, null);
  return { id: t.id, dir };
}
const seen = (dir: string) => lines(join(dir, 'seen.txt'));
const turnDir = (r: Runner, id: number): string => (r as any).turns.get(id).dir;
const pidJson = (dir: string) => JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8'));
const texts = (id: number) =>
  store
    .listEvents(id)
    .filter((e) => e.kind === 'claude')
    .map((e) => e.data);

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
  assert.equal(p.wrapper, p.claude, "the scope's shell is the turn's process group, as claude was in the wrapper");
  const mine = calls().slice(before);
  const unit = (r as any).turns.get(t.id).unit;
  assert.ok(
    mine.some((c) => c.includes('--scope') && c.includes(`--unit=${unit}`)),
    mine.join('\n'),
  );
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
  assert.ok(
    texts(t.id).some((d) => d.includes('"type":"result"')),
    "the first turn's reply is recorded",
  );
  await until('the next turn has ended', () => !r.isRunning(t.id));
  rmSync(join(t.dir, 'release'), { force: true });
});

/** When the runner last ran systemd-run for a wrapper unit, in ms: the fallback tests time the runner's choice, not node's start. */
const unitAt = () => Number(readFileSync(join(bin, 'unit-at'), 'utf8').trim().split('\n').at(-1));

/** Point the runner's supervisor.json at a stand-in that seems to run, at `port`, for the length of `fn`. */
async function standIn(r: Runner, port: number, fn: () => Promise<void>) {
  const s = spec(r);
  mkdirSync(s.dir, { recursive: true });
  const stray = tmp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)', 'turn-supervisor'], { stdio: 'ignore' });
  const saved = existsSync(join(s.dir, 'supervisor.json')) ? readFileSync(join(s.dir, 'supervisor.json'), 'utf8') : null;
  writeFileSync(join(s.dir, 'supervisor.json'), JSON.stringify({ pid: stray.pid, port, key: 'k', version: s.version }));
  try {
    await fn();
  } finally {
    if (saved) writeFileSync(join(s.dir, 'supervisor.json'), saved);
    else rmSync(join(s.dir, 'supervisor.json'), { force: true });
  }
}

test("a turn the supervisor can't take starts in its wrapper at once", async () => {
  const r = server();
  // Nothing answers on the port: it resets every connection.
  const port = await tmp.down();
  await standIn(r, port, async () => {
    const t = newTicket();
    const t0 = Date.now();
    const dir = await started(r, t);
    assert.ok(unitAt() >= t0 && unitAt() - t0 < 1_000, `its wrapper unit started ${unitAt() - t0} ms after the message`);
    assert.equal(pidJson(dir).supervisor, undefined, 'its wrapper runs it');
    await finished(r, t);
  });
});

test("a supervisor that doesn't answer in time: the runner starts the wrapper, and the spec's claim lets only one run the turn", async () => {
  const r = server();
  const hung = createServer(() => {}); // takes the request and never answers
  const port = await tmp.serve(hung);
  await standIn(r, port, async () => {
    const t = newTicket();
    const t0 = Date.now();
    const dir = await started(r, t);
    // The hand-off waits 500 ms for an answer.
    assert.ok(unitAt() >= t0 && unitAt() - t0 < 1_500, `its wrapper unit started ${unitAt() - t0} ms after the message: the wait for an answer is short`);
    assert.equal(pidJson(dir).supervisor, undefined, 'its wrapper runs it');
    await finished(r, t);
  });
  // Whoever renames spec.json first runs the turn; the other finds it gone.
  const dir = join(turnsDir, '99-1');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'spec.json'), JSON.stringify({ command: 'true', args: [], cwd: root, env: {} }));
  assert.equal(claimSpec(dir)?.command, 'true');
  assert.equal(claimSpec(dir), null);
  assert.ok(!existsSync(join(dir, 'spec.json')) && !existsSync(join(dir, `spec.json.${process.pid}`)), "the claimed spec (it holds the turn's token) is gone");
});

test("a scope that won't start: the supervisor gives the turn back and it runs in its wrapper unit", async () => {
  const r = await withSupervisor();
  writeFileSync(join(bin, 'no-scope'), '');
  const count = fallbacks.count;
  try {
    const t = newTicket();
    const before = calls().length;
    const dir = await started(r, t);
    assert.equal(pidJson(dir).supervisor, undefined, "not in the supervisor's group: its own wrapper unit runs it");
    assert.ok(
      calls()
        .slice(before)
        .some((c) => c.includes('turn-wrapper.mjs')),
      'a wrapper unit started',
    );
    assert.match(readFileSync(join(dir, 'stderr.log'), 'utf8'), /own memory group didn't start \(systemd-run exited 1\); the server starts it in a unit of its own/);
    assert.equal(fallbacks.count, count, "no fallback: the wrapper unit has the turn's slice and limits");
    assert.ok(!existsSync(join(dir, 'handback')));
    await finished(r, t);
    assert.ok(texts(t.id).some((d) => d.includes('"type":"result"')));
  } finally {
    rmSync(join(bin, 'no-scope'));
  }
});

test('a supervisor that dies after taking a turn and before starting it: the runner starts the turn in its wrapper', async () => {
  const r = await withSupervisor();
  const sup = readSupervisor(spec(r).dir)!;
  writeFileSync(join(bin, 'hang-scope'), '');
  try {
    const t = newTicket();
    r.send(t.id, 'Cara', 'build it');
    await until('the turn is followed', () => followed(r, t.id));
    const dir = turnDir(r, t.id);
    await until('the supervisor took the turn', () => existsSync(join(dir, `spec.json.${sup.pid}`)));
    // Killed only once its systemd-run runs: killed before spawning it, nothing would start the turn, and the runner rightly restarts it at once.
    await until('its systemd-run is starting the scope', () => existsSync(join(bin, 'scope-hanging')));
    process.kill(sup.pid, 'SIGKILL');
    // Its systemd-run, still starting the scope, names the folder: nothing is restarted while it might yet run the turn.
    const ticks = (r as any).turns.get(t.id).ticks;
    await until('the runner has looked a few times', () => (r as any).turns.get(t.id).ticks > ticks + 5);
    assert.ok(existsSync(join(dir, `spec.json.${sup.pid}`)), 'left alone while its scope may still start');
    rmSync(join(bin, 'hang-scope')); // the scope fails, with no supervisor to give the turn back
    await until('claude has the message', () => seen(t.dir).length === 1);
    await until('pid.json', () => existsSync(join(dir, 'pid.json')));
    assert.equal(pidJson(dir).supervisor, undefined, 'its wrapper runs it');
    await finished(r, t);
    assert.ok(texts(t.id).some((d) => d.includes('"type":"result"')));
  } finally {
    rmSync(join(bin, 'hang-scope'), { force: true });
    rmSync(join(bin, 'scope-hanging'), { force: true });
  }
});

test('"Is this still going?" on a supervisor turn names the command claude runs, under the turn\'s shell', async () => {
  const r = await withSupervisor();
  const t = newTicket();
  writeFileSync(join(t.dir, 'cmd'), '');
  try {
    const dir = await started(r, t);
    assert.ok(pidJson(dir).supervisor);
    await until('the command runs', () => existsSync(join(t.dir, 'cmd.started')));
    const check = await r.checkTurn(t.id);
    assert.match(check?.text ?? '', /while :; do sleep/, JSON.stringify(check));
    await finished(r, t);
  } finally {
    rmSync(join(t.dir, 'cmd'), { force: true });
  }
});

test('the runner starts its supervisor when it starts, before any turn', async () => {
  const r = server();
  (r as any).turnsDir = join(root, 'warm');
  mkdirSync(join(root, 'warm'));
  assert.equal(readSupervisor(spec(r).dir), null);
  r.recover();
  await until('the supervisor is up', () => !!readSupervisor(spec(r).dir));
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
