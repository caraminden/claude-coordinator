import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// tools/citadel-heavy (#325): the host-wide slots for heavy builds, on a throwaway lock folder.
const heavy = join(import.meta.dirname, '..', 'tools', 'citadel-heavy');
const root = mkdtempSync(join(tmpdir(), 'heavy-'));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
function folder(slots?: number) {
  const dir = join(root, `locks-${n++}`);
  return { dir, env: { ...process.env, CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_DIR: dir, CITADEL_HEAVY_SLOTS: slots === undefined ? undefined : String(slots) } };
}
type Job = { child: ChildProcess; err: () => string; done: Promise<number | null> };
function job(env: NodeJS.ProcessEnv, who: string, script: string): Job {
  // Its own process group, so a test can kill the wrapper and its command together, as a crash would.
  const child = spawn(heavy, ['sh', '-c', script], { env: { ...env, CITADEL_HEAVY_WHO: who }, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = '';
  child.stderr!.on('data', (b) => (err += b));
  return { child, err: () => err, done: new Promise((r) => child.on('close', (code) => r(code))) };
}
async function until(what: string, check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(check(), `timed out waiting for ${what}`);
}
const touch = (f: string) => `touch '${f}'`;
// Bounded, so a failed assertion can't leave a job holding its slot (and the test file) open for good.
const waitFor = (f: string) => `i=0; while [ ! -e '${f}' ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i + 1)); done`;

test('it runs the command with its stdin and exit status', () => {
  const { env } = folder();
  assert.equal(spawnSync(heavy, ['cat'], { env, input: 'hi', encoding: 'utf8' }).stdout, 'hi');
  assert.equal(spawnSync(heavy, ['sh', '-c', 'exit 7'], { env }).status, 7);
  assert.equal(spawnSync(heavy, [], { env }).status, 2);
});

test('with 2 slots a third job waits in line, says whose jobs hold them, and starts once one ends', async () => {
  const { env } = folder(2);
  const go = join(root, 'go-1');
  const a = job(env, 'Peek #1 (josh)', `${touch(join(root, 'a-up'))}; ${waitFor(go)}`);
  const b = job(env, 'Peek #2 (cara)', `${touch(join(root, 'b-up'))}; ${waitFor(go)}`);
  await until('two jobs running', () => existsSync(join(root, 'a-up')) && existsSync(join(root, 'b-up')));
  const c = job(env, 'Delve #3', touch(join(root, 'c-up')));
  try {
    await until('the third to say whose jobs it waits on', () => /waiting/.test(c.err()) && /slot 2: /.test(c.err()));
    assert.ok(!existsSync(join(root, 'c-up')), 'the third job waits');
    assert.match(c.err(), /Peek #1 \(josh\): sh -c/);
    assert.match(c.err(), /Peek #2 \(cara\): sh -c/);
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await a.done, 0);
  assert.equal(await b.done, 0);
  assert.equal(await c.done, 0);
  assert.ok(existsSync(join(root, 'c-up')));
});

test('a job killed mid-run frees its slot, and a daemon it leaves behind keeps none', async () => {
  const { dir, env } = folder(1);
  const a = job(env, 'crasher', `${touch(join(root, 'crash-up'))}; sleep 30`);
  await until('the job running', () => existsSync(join(root, 'crash-up')));
  process.kill(-a.child.pid!, 'SIGKILL');
  await a.done;
  assert.equal(spawnSync(heavy, ['true'], { env, timeout: 10_000 }).status, 0, 'the next job gets the slot');
  // A build that starts a server in the background (sccache, say) and exits.
  const pidFile = join(root, 'daemon-pid');
  assert.equal(spawnSync(heavy, ['sh', '-c', `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'`], { env, timeout: 10_000 }).status, 0);
  try {
    assert.equal(spawnSync(heavy, ['true'], { env, timeout: 10_000 }).status, 0, 'the daemon holds no slot');
  } finally {
    process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
  }
  assert.ok(!existsSync(join(dir, 'slot-0.who')), 'a finished job takes its holder line with it');
});

test('the slots file tunes how many run at once, and a nested call runs in the outer slot', async () => {
  const { dir, env } = folder(5);
  spawnSync(heavy, ['true'], { env });
  writeFileSync(join(dir, 'slots'), '1\n');
  const go = join(root, 'go-2');
  const a = job(env, 'first', `${touch(join(root, 'n-up'))}; ${waitFor(go)}`);
  await until('the first job running', () => existsSync(join(root, 'n-up')));
  const b = job(env, 'second', 'true');
  try {
    await until('the second to wait on the one slot', () => /all heavy slots \(1\) are busy/.test(b.err()));
  } finally {
    writeFileSync(go, '');
  }
  assert.equal(await a.done, 0);
  assert.equal(await b.done, 0);
  // With the one slot held by the outer call, the inner one would wait forever if it queued.
  const nested = spawnSync(heavy, [heavy, 'echo', 'inner'], { env, encoding: 'utf8', timeout: 10_000 });
  assert.equal(nested.stdout, 'inner\n');
});

test('without a usable lock folder it warns and runs anyway', () => {
  const blocker = join(root, 'a-file');
  writeFileSync(blocker, '');
  const r = spawnSync(heavy, ['echo', 'ran'], { env: { ...process.env, CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_DIR: join(blocker, 'locks') }, encoding: 'utf8' });
  assert.equal(r.stdout, 'ran\n');
  assert.match(r.stderr, /without waiting for a slot/);
});
