import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { Landings, NO_CODE } from '../src/land.ts';
import { until } from './helpers.ts';

// The land tool's landings run in units of their own (#508), so a restart neither waits for them nor kills
// them, and the next server reports how they went. A fake systemd-run logs its arguments and starts the
// command after its options in a session of its own, outliving the Landings that started it.
const root = mkdtempSync(join(tmpdir(), 'land-units-'));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, 'bin');
mkdirSync(bin);
const calls = join(root, 'calls');
writeFileSync(join(bin, 'systemd-run'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >>${JSON.stringify(calls)}
[ -e ${JSON.stringify(join(root, 'fail'))} ] && { echo 'Failed to connect to bus' >&2; exit 1; }
while [ "\${1#--}" != "$1" ]; do shift; done
setsid "$@" </dev/null >/dev/null 2>&1 &
`);
chmodSync(join(bin, 'systemd-run'), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
// As the user manager gives every unit: land.sh must not see it, only the env the server hands it.
process.env.INVOCATION_ID = "from-the-unit";

let n = 0;
/** A minion worktree whose land.sh waits for `go`, prints its token and exits 3. */
function setup() {
  const dir = join(root, String(++n));
  const cwd = join(dir, 'wt');
  mkdirSync(join(cwd, 'tools'), { recursive: true });
  const go = join(dir, 'go');
  writeFileSync(join(cwd, 'tools', 'land.sh'), `echo "token:$COORDINATOR_TOKEN in $PWD"
while [ ! -e ${JSON.stringify(go)} ]; do sleep 0.05; done
echo "the user manager's env stays out: \${INVOCATION_ID:-none}"
exit 3
`);
  // A token with quotes and a $ goes through the env file as it is.
  const env = { PATH: process.env.PATH!, COORDINATOR_TOKEN: `7.s'g "$HOME"`, 'NOT-A-NAME': 'x' };
  return { data: join(dir, 'data'), cwd, env, go: () => writeFileSync(go, '') };
}

test("a landing in a unit doesn't count as interruptible, outlives the Landings that started it, and the next one reports it", async () => {
  const s = setup();
  const before = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
  const first = new Landings(s.data, () => true);
  assert.deepEqual(first.start(1, s.cwd, s.env), { output: '', code: null });
  await until('land.sh starts', () => first.get(1)!.output.includes('token:'));
  assert.equal(first.running(), 0, 'a restart would leave it running, so it does not hold one up');
  const call = readFileSync(calls, 'utf8').slice(before.length);
  assert.match(call, /--user --collect --quiet --unit=citadel-land-[0-9a-f]{8}-1-\d+ --slice=citadel-turns\.slice/);
  assert.doesNotMatch(call, /7\.s/, "the token stays off the command line, where anyone on the box could read it");
  assert.equal(existsSync(join(s.data, 'run', 'landings', '1', 'env')), false, 'the env file with the token is gone once read');

  // The server restarts: a fresh Landings on the same data dir finds it still running, then its result.
  const next = new Landings(s.data, () => true);
  assert.equal(next.get(1)!.code, null);
  assert.equal(next.start(1, s.cwd, s.env).code, null, 'a second land call while it runs joins it');
  s.go();
  const done = await until('land.sh ends', () => { const r = next.get(1)!; return r.code === null ? null : r; });
  assert.equal(done.code, 3);
  assert.match(done.output, new RegExp(`token:7\\.s'g "\\$HOME" in ${s.cwd}`));
  assert.match(done.output, /env stays out: none/);
  assert.equal(next.running(), 0);
});

test('when systemd-run fails, the landing runs as the server\'s child and counts until it ends', async () => {
  const s = setup();
  writeFileSync(join(root, 'fail'), '');
  try {
    const l = new Landings(s.data, () => true);
    l.start(2, s.cwd, s.env);
    await until('it falls back to a child', () => l.running() === 1);
    s.go();
    await until('it ends', () => l.running() === 0);
    assert.equal(l.get(2)!.code, 3);
  } finally {
    rmSync(join(root, 'fail'));
  }
});

test('a landing a restart cut off reads as ended without a code, not as running forever', async () => {
  const s = setup();
  const l = new Landings(s.data); // no units: the server's child
  l.start(3, s.cwd, s.env);
  assert.equal(l.running(), 1);
  await until('land.sh starts', () => l.get(3)!.output.includes('token:'));
  process.kill(Number(readFileSync(join(s.data, 'run', 'landings', '3', 'pid'), 'utf8')), 'SIGKILL');
  s.go(); // so the orphaned land.sh ends too
  await until('the child is gone', () => l.running() === 0);
  const next = new Landings(s.data);
  const r = next.get(3)!;
  assert.equal(r.code, 1);
  assert.ok(r.output.endsWith(NO_CODE), r.output);
  assert.equal(next.get(4), null, 'a minion that never landed has nothing');
});
