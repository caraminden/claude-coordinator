import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { bootServer, REPO, tempRoot, until } from './helpers.ts';

// A test server's turn supervisor runs in a systemd unit of its own (src/supervisor-client.ts), so nothing a test's
// teardown or #1546's exit-with-parent kills by pid ends its unit for good: SIGKILLed, Restart=on-failure brought it
// back, and once the test's folder was deleted it ran on forever (#1758: 83 such units held 1.4 GB of swap). These run
// the real thing, so they need this account's systemd (CI's runners have none).
const systemd = !!process.env.XDG_RUNTIME_DIR && existsSync(join(process.env.XDG_RUNTIME_DIR, 'bus')) && spawnSync('systemd-run', ['--version']).status === 0;
const skip = systemd ? false : 'no user systemd here';

const tmp = tempRoot('supervisor-leftovers-');
const units = new Set<string>();
after(async () => {
  // A unit a failed run left behind is stopped here, so the test never leaks what it tests for.
  for (const u of units) spawnSync('systemctl', ['--user', 'stop', u], { stdio: 'ignore' });
  await tmp.teardown();
});

const ON = { TURN_UNITS: '1', TURN_SUPERVISOR: '1' };

/** The supervisor the server on `data` started: its pid and its unit, once it runs. */
async function supervisorOf(data: string) {
  return until('the turn supervisor to run in its unit', () => {
    const root = join(data, 'run/turns/.supervisor');
    for (const v of existsSync(root) ? readdirSync(root) : []) {
      try {
        const { pid } = JSON.parse(readFileSync(join(root, v, 'supervisor.json'), 'utf8'));
        const unit = /\/(citadel-supervisor-[^/]+\.service)$/m.exec(readFileSync(`/proc/${pid}/cgroup`, 'utf8'))?.[1];
        if (unit) {
          units.add(unit);
          return { pid: pid as number, unit };
        }
      } catch {} // not written yet, or not running yet
    }
    return null;
  }, 60_000);
}

/** Gone, or exited and waiting for whichever process it was re-parented to to reap it. */
function exited(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')')).startsWith(') Z');
  } catch {
    return true;
  }
}
const state = (unit: string) => execFileSync('systemctl', ['--user', 'show', '-p', 'ActiveState', '--value', unit], { encoding: 'utf8' }).trim();
// A clean exit only: a KILLed one waiting out its restart reads `activating`, and one that failed to restart `failed`.
const down = (s: string) => s === 'inactive';

/** The unit stops for good: one waiting out Restart=on-failure's delay reads `activating`, not down. */
async function goesAway(unit: string, what: string) {
  await until(what, () => down(state(unit)), 30_000, () => `${unit} is ${state(unit)}`);
}

test('a test process killed with SIGKILL leaves no supervisor unit behind', { skip }, async () => {
  const root = tmp.path('killed');
  const out = tmp.path('killed.json');
  const file = tmp.path('killed.test.ts');
  writeFileSync(file, `import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { bootServer } from ${JSON.stringify(join(REPO, 'test/helpers.ts'))};
test('boots, then waits to be killed', async () => {
  const s = await bootServer({ root: ${JSON.stringify(root)}, env: ${JSON.stringify(ON)} });
  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ server: s.proc.pid }));
  await new Promise(() => {});
});
`);
  // Run directly, not under --test, whose runner would put the file in a child of its own: this process is the test's.
  const run = tmp.spawn(process.execPath, [file], { stdio: 'ignore', env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  await until('the killed test’s server to boot', () => existsSync(out), 60_000);
  const { server } = JSON.parse(readFileSync(out, 'utf8'));
  const sup = await supervisorOf(join(root, 'data'));
  run.kill('SIGKILL');
  // The orphaned server stops what names its folder and exits (#1546).
  await until('the orphaned server to exit', () => exited(server), 30_000);
  // Its folder still there: a KILL that systemd restarts from it fails this, where a deleted folder would hide it.
  await goesAway(sup.unit, 'the killed test’s supervisor unit to stop');
});

test('a supervisor whose folder is deleted under it stops its own unit', { skip }, async () => {
  const root = tmp.path('deleted');
  const s = await bootServer({ root, env: ON });
  const sup = await supervisorOf(join(root, 'data'));
  // The server dies without a teardown (a timeout's kill of the test's scope), leaving the supervisor running; then the folder goes.
  s.proc.kill('SIGKILL');
  await until('the server to exit', () => s.proc.exitCode !== null || s.proc.signalCode !== null);
  rmSync(root, { recursive: true, force: true }); // timing-ok: the folder going is the case under test
  await goesAway(sup.unit, 'the supervisor to notice its folder is gone and exit');
});
