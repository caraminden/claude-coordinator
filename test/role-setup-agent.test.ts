import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { elevateScript, exec, HELD, runSetup } from '../public/role-setup-agent.mjs';
import { SCRIPT_NEEDS } from '../public/role-setup.js';

// The agent's side of a role's Set up and Test (Build 7 M4): what it runs, what it writes and what it says back.
const dir = mkdtempSync(join(tmpdir(), 'role-setup-agent-'));
// timing-ok: own temp dir
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

type Said = { id: string; step?: { n: number; text: string; state: string }; admin?: { needs: string[]; pm?: string | null; script?: true }; done?: { ok: boolean; report?: string; why?: string } };
type Out = { code: number; out: string };
const TOKEN = `ccm_1_${'a'.repeat(43)}`;

/** A fake PC: `answers` says what each program prints (by "program arg"), anything missing isn't installed. */
function pc(o: { platform?: string; role: string; kind?: string; ask?: Record<string, unknown>; answers?: Record<string, Out>; config?: unknown; capture?: (file: string, window: string) => Promise<string>; busy?: boolean; root?: boolean }) {
  const home = join(dir, `pc-${n++}`);
  const configFile = join(home, 'machine-agent.json');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  if (o.config !== undefined) writeFileSync(configFile, typeof o.config === 'string' ? o.config : JSON.stringify(o.config));
  const said: Said[] = [];
  const ran: string[] = [];
  const uploads: Buffer[] = [];
  const ctx = {
    ask: { id: 'r1', role: o.role, kind: o.kind ?? 'setup', ...o.ask },
    platform: o.platform ?? 'linux',
    configFile,
    appUrl: 'http://citadel.test',
    token: TOKEN,
    home,
    root: !!o.root,
    exec: async (cmd: string, args: string[]) => {
      const line = [cmd, ...args].join(' ');
      ran.push(line);
      const key = Object.keys(o.answers ?? {}).find((k) => line.startsWith(k));
      return key ? o.answers![key] : { code: -1, out: `spawn ${cmd} ENOENT` };
    },
    capture:
      o.capture ??
      (async (file: string, window: string) => {
        writeFileSync(file, `png of ${window || 'screen'}`);
        return `${window || 'the whole screen'}, 1920x1080`;
      }),
    start: (cmd: string) => ran.push(`start ${cmd}`),
    screenBusy: () => !!o.busy,
    tmp: home,
    sleep: async () => {},
    post: async (body: Said) => void said.push(body),
    upload: async (bytes: Buffer) => void uploads.push(bytes),
  };
  const config = () => JSON.parse(readFileSync(configFile, 'utf8'));
  return { ctx, said, ran, uploads, config, run: () => runSetup(ctx), done: () => said.at(-1)!.done!, steps: () => said.filter((s) => s.step).map((s) => `${s.step!.n} ${s.step!.state} ${s.step!.text}`) };
}

const ok = (out: string): Out => ({ code: 0, out });
const GPU_OK = {
  'nvidia-smi -L': ok('GPU 0: NVIDIA GeForce RTX 4080 (UUID: GPU-1234)'),
  'podman --version': ok('podman version 4.9.3'),
  'nvidia-ctk --version': ok('NVIDIA Container Toolkit CLI version 1.17.0'),
  'nvidia-ctk cdi list': ok('INFO Found 2 CDI devices\nnvidia.com/gpu=0\nnvidia.com/gpu=all'),
  'podman run': ok('GPU 0: NVIDIA GeForce RTX 4080 (UUID: GPU-1234)'),
};

test('GPU Set up: everything there, jobs turned on with the owner keys kept, then nvidia-smi in a container', async () => {
  const p = pc({ role: 'gpu', answers: GPU_OK, config: { servers: { s: { run: ['x'] } }, screenshots: false } });
  await p.run();
  assert.deepEqual(p.done(), { ok: true, report: 'GPU 0: NVIDIA GeForce RTX 4080 in a container' });
  const c = p.config();
  assert.deepEqual(c.servers, { s: { run: ['x'] } });
  assert.equal(c.screenshots, false);
  assert.deepEqual(c.jobs, { dir: join(p.ctx.tmp, 'gpu-jobs'), folders: {}, max_disk_gb: 50, gpu: true });
  assert.ok(p.ran.some((r) => r.startsWith('podman run --rm --device nvidia.com/gpu=all --security-opt label=disable docker.io/library/ubuntu:24.04 nvidia-smi -L')));
  assert.match(p.steps().join('\n'), /The GPU: GPU 0: NVIDIA GeForce RTX 4080\n/);
});

test("GPU Set up keeps an owner's own jobs block, turning only the GPU on; Test writes nothing", async () => {
  const own = { dir: '/srv/jobs', folders: { data: '/srv/data' }, max_disk_gb: 500, max_limit_h: 12 };
  const p = pc({ role: 'gpu', answers: GPU_OK, config: { jobs: own } });
  await p.run();
  assert.deepEqual(p.config().jobs, { ...own, gpu: true });
  const t = pc({ role: 'gpu', kind: 'test', answers: GPU_OK, config: { jobs: own } });
  await t.run();
  assert.equal(t.done().ok, true);
  assert.deepEqual(t.config().jobs, own);
});

test('GPU with pieces missing names them as fixed words and the package manager, never a command', async () => {
  const p = pc({ role: 'gpu', answers: { 'nvidia-smi -L': GPU_OK['nvidia-smi -L'], 'apt-get --version': ok('apt 2.7') }, config: {} });
  await p.run();
  const admin = p.said.find((s) => s.admin)!.admin;
  assert.deepEqual(admin, { needs: ['podman', 'nvidia-toolkit', 'cdi'], pm: 'apt' });
  assert.equal(p.done().ok, false);
  assert.ok(!p.ran.some((r) => r.startsWith('podman run')), 'no container is tried');
  assert.deepEqual(p.config(), {}, 'nothing written before the pieces are there');
});

test('GPU with no NVIDIA card, or on Windows, ends with why and asks for nothing', async () => {
  const none = pc({ role: 'gpu', answers: {} });
  await none.run();
  assert.match(none.done().why!, /No NVIDIA GPU/);
  assert.ok(!none.said.some((s) => s.admin));
  const win = pc({ role: 'gpu', platform: 'win32' });
  await win.run();
  assert.match(win.done().why!, /inside WSL/);
  assert.deepEqual(win.ran, []);
});

test('Windows screen Set up: screenshots on with a lock beside the config, a whole-screen shot, Notepad seen and closed', async () => {
  const p = pc({ role: 'screen', platform: 'win32', config: { workspaces: {} }, answers: { 'powershell.exe -NoProfile -NonInteractive -Command': ok('closed 1') } });
  await p.run();
  assert.deepEqual(p.done(), { ok: true, report: 'Screenshot 1920x1080; Notepad opened and closed' });
  assert.deepEqual(p.config(), { workspaces: {}, screenshots: true, screen_lock: join(p.ctx.tmp, 'screen.lock') });
  assert.ok(p.ran.includes('start notepad.exe'));
  // Only the Notepad it started: those started since the test began.
  assert.match(p.ran.at(-1)!, /StartTime -ge \$s/);
  assert.deepEqual(p.uploads.map(String), ['png of screen', 'png of Notepad']);
});

test('the screen test waits for a minion that has the screen, and says a locked screen plainly', async () => {
  const busy = pc({ role: 'screen', kind: 'test', platform: 'win32', busy: true });
  await busy.run();
  assert.match(busy.done().why!, /has the screen/);
  const locked = pc({ role: 'screen', kind: 'test', platform: 'win32', capture: async () => Promise.reject(new Error('BitBlt (a locked or disconnected screen refuses this)')) });
  await locked.run();
  assert.match(locked.done().why!, /signed in with its screen unlocked/);
  assert.deepEqual(locked.uploads, []);
});

test("Notepad that never shows is closed and fails; a broken config isn't overwritten", async () => {
  const p = pc({ role: 'screen', kind: 'test', platform: 'win32', answers: { powershell: ok('closed 1') }, capture: async (file, window) => (window ? Promise.reject(new Error('no window')) : (writeFileSync(file, 'x'), 'screen, 800x600')) });
  await p.run();
  assert.match(p.done().why!, /didn't show/);
  assert.match(p.ran.at(-1)!, /CloseMainWindow/);
  const bad = pc({ role: 'screen', platform: 'win32', config: '{ "screenshots": tru' });
  await bad.run();
  assert.match(bad.done().why!, /isn't valid JSON/);
  assert.equal(readFileSync(bad.ctx.configFile, 'utf8'), '{ "screenshots": tru');
});

test('exec gives a missing program a non-zero code and hears lines as they come', async () => {
  assert.notEqual((await exec('no-such-program-citadel', [])).code, 0);
  const lines: string[] = [];
  const r = await exec(process.execPath, ['-e', 'console.log("one"); console.error("two")'], { onLine: (l: string) => lines.push(l) });
  assert.equal(r.code, 0);
  assert.deepEqual(lines.sort(), ['one', 'two']);
});

const ANDROID = `ghcr.io/caraminden/citadel-build-android@sha256:${'a'.repeat(64)}`;
const NODE = `ghcr.io/caraminden/citadel-build-node@sha256:${'b'.repeat(64)}`;
const BUILDS = { caps: { threads: 4 }, builds: { images: { android: ANDROID, node: NODE }, volumes: ['citadel-gradle', 'citadel-npm'] } };
const no: Out = { code: 1, out: '' };
const BUILDS_OK = {
  'podman --version': ok('podman version 4.9.3'),
  'podman image exists': no,
  'podman pull': ok('Copying blob sha256:1\nWriting manifest to image destination'),
  'podman image inspect': ok('2345000000'),
  'podman volume exists': no,
  'podman volume create': ok('citadel-gradle'),
  'podman run': ok('BUILD SUCCESSFUL in 1m 2s\napk 12345'),
};

test('Builds Set up on Linux pulls each image by digest, makes the volumes, then builds the hello APK under the threads cap', async () => {
  const p = pc({ role: 'builds', ask: BUILDS, answers: BUILDS_OK });
  await p.run();
  assert.deepEqual(p.done(), { ok: true, report: 'Hello-world APK built; images android 2.3 GB, node 2.3 GB' });
  assert.ok(p.ran.includes(`podman pull ${ANDROID}`) && p.ran.includes(`podman pull ${NODE}`));
  assert.ok(p.ran.includes('podman volume create citadel-gradle') && p.ran.includes('podman volume create citadel-npm'));
  assert.ok(p.ran.includes(`podman run --rm --security-opt label=disable --cpus 4 -v citadel-gradle:/cache/gradle ${ANDROID} citadel-hello-apk`));
  assert.match(p.steps().join('\n'), /ok Pulled citadel-build-android \(2\.3 GB\)\n.*\n.*ok Cache volumes ready: citadel-gradle, citadel-npm \(new\)\n.*running Building a hello-world APK.*\n.*ok Built a hello-world APK \(12 KB\)/s);
});

test("a hello APK that doesn't build fails on its own step with the build's last lines", async () => {
  const p = pc({ role: 'builds', ask: BUILDS, answers: { ...BUILDS_OK, 'podman run': { code: 1, out: 'FAILURE: Build failed with an exception.\nCould not resolve com.android.tools.build:gradle:8.13.0.' } } });
  await p.run();
  assert.equal(p.done().ok, false);
  assert.match(p.done().why!, /hello-world APK didn't build: FAILURE.*Could not resolve/);
  assert.match(p.steps().at(-1)!, /fail Building the hello-world APK$/, 'the step names it; the output is in the why, once');
});

test('Builds on Windows runs podman in citadel-workers as its worker user, and says to set up Minion turns when the distro is missing', async () => {
  const utf16 = (s: string) => s.split('').join('\0');
  const win = { 'wsl.exe --version': ok('WSL version: 2.3.26.0'), 'wsl.exe -l -q': ok(utf16('Ubuntu\r\ncitadel-workers\r\n')) };
  const via = 'wsl.exe -d citadel-workers -u citadel-worker --exec /bin/sh -c XDG_RUNTIME_DIR=/run/user/$(id -u) exec podman "$@" podman';
  const answers = Object.fromEntries([...Object.entries(win), ...Object.entries(BUILDS_OK).map(([k, v]) => [`${via} ${k.slice('podman '.length)}`, v])]);
  const p = pc({ platform: 'win32', role: 'builds', ask: BUILDS, answers });
  await p.run();
  assert.equal(p.done().ok, true, JSON.stringify(p.said));
  assert.ok(p.ran.includes(`${via} pull ${ANDROID}`));
  const missing = pc({ platform: 'win32', role: 'builds', ask: BUILDS, answers: { ...win, 'wsl.exe -l -q': ok(utf16('Ubuntu\r\n')) } });
  await missing.run();
  assert.match(missing.done().why!, /citadel-workers WSL distro.*press Set up on Minion turns/);
  assert.ok(!missing.ran.some((r) => r.includes('pull')));
  const noWsl = pc({ platform: 'win32', role: 'builds', ask: BUILDS, answers: {} });
  await noWsl.run();
  assert.deepEqual(noWsl.said.find((s) => s.admin)?.admin, { needs: ['wsl'], pm: null, script: true, at: join(noWsl.ctx.home, 'coordinator-agent', 'elevate.ps1') }, 'WSL goes in the one elevate script');
  assert.match(readFileSync(join(noWsl.ctx.home, 'coordinator-agent', 'elevate.ps1'), 'utf8'), /wsl\.exe --install --no-distribution/);
});

test('Builds with no podman on Linux asks for it as fixed words; Test pulls nothing and says to press Set up', async () => {
  const p = pc({ role: 'builds', ask: BUILDS, answers: { 'apt-get --version': ok('apt 2.7') } });
  await p.run();
  assert.deepEqual(p.said.find((s) => s.admin)?.admin, { needs: ['podman'], pm: 'apt' });
  assert.equal(p.done().ok, false);
  const t = pc({ role: 'builds', kind: 'test', ask: BUILDS, answers: BUILDS_OK });
  await t.run();
  assert.match(t.done().why!, /citadel-build-android isn't pulled on this PC: press Set up/);
  assert.ok(!t.ran.some((r) => r.includes('pull')));
  const none = pc({ role: 'builds', ask: { builds: { images: {}, volumes: [] } }, answers: BUILDS_OK });
  await none.run();
  assert.match(none.done().why!, /no Android build image/);
});

// One agent per computer (One kind of machine H2): the elevate script the agent writes, and the roles that use it.
test('CI Set up on Windows writes elevate.ps1 with the runner agent and, when Minion turns waits on it, WSL; the card gets the needs only', async () => {
  const p = pc({ platform: 'win32', role: 'ci', ask: { also: ['turns'] }, answers: {} });
  await p.run();
  assert.deepEqual(p.said.find((s) => s.admin)?.admin, { needs: ['runner', 'wsl'], pm: null, script: true, at: join(p.ctx.home, 'coordinator-agent', 'elevate.ps1') });
  assert.equal(p.done().ok, true, 'Citadel waits for the runner agent from here');
  const text = readFileSync(join(p.ctx.home, 'coordinator-agent', 'elevate.ps1'), 'utf8');
  assert.match(text, /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/, 'it stops unless elevated');
  assert.match(text, /iwr|Invoke-WebRequest "\$u\/ci-runner\/install-runner-agent\.ps1"/);
  assert.ok(text.includes(`-CitadelUrl $u -MachineToken '${TOKEN}'`));
  assert.ok(text.indexOf('install-runner-agent') < text.indexOf('wsl.exe --install'), 'WSL last: it asks for a restart');
  assert.ok(text.indexOf('winget.exe install --id Git.Git') < text.indexOf('install-runner-agent'), 'Git for Windows first, when bash.exe is missing: the runner installer refuses without it');
  assert.match(text, /\$failed \+= 'the CI runner agent'/, 'a failed runner install still lets WSL install');
  assert.match(text, /if \(\$failed\) \{[^\n]*exit 1 \}/, 'and the script ends with 1 when anything failed');
  // WSL already there: not in the script.
  const has = pc({ platform: 'win32', role: 'ci', ask: { also: ['builds'] }, answers: { 'wsl.exe --version': ok('WSL version: 2.3.26.0') } });
  await has.run();
  assert.deepEqual(has.said.find((s) => s.admin)?.admin, { needs: ['runner'], pm: null, script: true, at: join(has.ctx.home, 'coordinator-agent', 'elevate.ps1') });
});

test("Linux: CI and Minion turns write one elevate.sh, root's only, with the worker's caps; as root the agent runs it itself", async () => {
  const p = pc({ role: 'turns', ask: { also: ['ci'], caps: { workers: 4, threads: 8, memory_gb: 'lots' } } });
  await p.run();
  assert.deepEqual(p.said.find((s) => s.admin)?.admin, { needs: ['runner-linux', 'worker'], pm: null, script: true, at: join(p.ctx.home, 'coordinator-agent', 'elevate.sh') });
  assert.equal(p.done().ok, true);
  const file = join(p.ctx.home, 'coordinator-agent', 'elevate.sh');
  const text = readFileSync(file, 'utf8');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'it holds the token');
  assert.match(text, /^#!\/usr\/bin\/env bash\n/);
  assert.match(text, /\[\[ \$\(id -u\) == 0 \]\]/);
  assert.match(text, /bash "\$f" "\$u" --workers 4 --threads 8\n/, 'whole-number caps only');
  assert.match(text, /install-runner-agent\.sh/);
  const root = pc({ role: 'ci', root: true, answers: { bash: ok('elevate: done.') } });
  await root.run();
  assert.ok(root.ran.includes(`bash ${join(root.ctx.home, 'coordinator-agent', 'elevate.sh')}`));
  assert.equal(
    root.said.find((s) => s.admin),
    undefined,
    'nothing to paste',
  );
  assert.equal(root.done().ok, true);
  const broke = pc({ role: 'ci', root: true, answers: { bash: { code: 1, out: 'E: Unable to locate package nodejs' } } });
  await broke.run();
  assert.match(broke.done().why!, /install stopped: E: Unable to locate package nodejs/);
});

test("the script holds only the agent's own address and a real token; a Mac's CI ends with why", async () => {
  assert.throws(() => elevateScript({ platform: 'linux', appUrl: 'http://citadel.test', token: "x'; rm -rf / #", needs: ['worker'] }), /isn't a machine token/);
  const text = elevateScript({ platform: 'linux', appUrl: 'http://citadel.test:8574/some/path?q=1', token: TOKEN, needs: ['worker'] });
  assert.match(text, /^u='http:\/\/citadel\.test:8574'$/m);
  const bad = pc({ role: 'ci' });
  bad.ctx.token = 'ccm_nope';
  await bad.run();
  assert.match(bad.done().why!, /Could not write the administrator script/);
  const mac = pc({ platform: 'darwin', role: 'ci' });
  await mac.run();
  assert.match(mac.done().why!, /Windows or Linux/);
});

test("Linux: Builds' podman and a waiting helper are one paste, package line first; CI's Set up carries Minion turns' caps", async () => {
  assert.deepEqual([...HELD].sort(), [...SCRIPT_NEEDS].sort(), 'the fetched agent file and the page agree on what the script holds');
  // Builds pressed with CI waiting: podman's line, then the script with the runner agent.
  const b = pc({ role: 'builds', ask: { ...BUILDS, also: ['ci'] }, answers: { 'apt-get --version': ok('apt 2.7') } });
  await b.run();
  assert.deepEqual(b.said.find((s) => s.admin)?.admin, { needs: ['podman', 'runner-linux'], pm: 'apt', script: true, at: join(b.ctx.home, 'coordinator-agent', 'elevate.sh') });
  assert.equal(b.done().ok, false, 'Set up again once it ran');
  const script = readFileSync(join(b.ctx.home, 'coordinator-agent', 'elevate.sh'), 'utf8');
  assert.match(script, /install-runner-agent\.sh/);
  assert.ok(!script.includes('podman'), "podman is the card's own line, not the script's");
  // CI pressed with Builds waiting and no podman: the same paste.
  const c = pc({ role: 'ci', ask: { also: ['builds', 'turns'], turns_caps: { workers: 3 } }, answers: { 'dnf --version': ok('dnf 4') } });
  await c.run();
  assert.deepEqual(c.said.find((s) => s.admin)?.admin, { needs: ['podman', 'runner-linux', 'worker'], pm: 'dnf', script: true, at: join(c.ctx.home, 'coordinator-agent', 'elevate.sh') });
  assert.match(readFileSync(join(c.ctx.home, 'coordinator-agent', 'elevate.sh'), 'utf8'), /bash "\$f" "\$u" --workers 3\n/, "the worker gets Minion turns' caps, sent along");
  // Nothing else waiting: podman alone, as before.
  const alone = pc({ role: 'builds', ask: BUILDS, answers: { 'apt-get --version': ok('apt 2.7') } });
  await alone.run();
  assert.deepEqual(alone.said.find((s) => s.admin)?.admin, { needs: ['podman'], pm: 'apt' });
});

test("Windows: a paste it needs anyway also lets the agent list this PC's Hyper-V VMs, by its own account's SID only", async () => {
  const sid = 'S-1-5-21-1004336348-1177238915-682003330-1001';
  const locked = { 'powershell.exe -NoProfile -Command if (-not (Get-Service vmms': ok(`locked ${sid}`) };
  const p = pc({ platform: 'win32', role: 'ci', answers: locked });
  await p.run();
  assert.deepEqual(p.said.find((s) => s.admin)?.admin?.needs, ['runner', 'hyperv']);
  const text = readFileSync(join(p.ctx.home, 'coordinator-agent', 'elevate.ps1'), 'utf8');
  assert.match(text, new RegExp(`Add-LocalGroupMember -SID 'S-1-5-32-578' -Member '${sid}'`));
  assert.match(text, /\$failed \+= 'Hyper-V Administrators'/);
  // Get-VM works already, or no Hyper-V: nothing more in the paste.
  for (const out of ['ok', 'none']) {
    const q = pc({ platform: 'win32', role: 'ci', answers: { 'powershell.exe -NoProfile -Command if (-not (Get-Service vmms': ok(out) } });
    await q.run();
    assert.deepEqual(q.said.find((s) => s.admin)?.admin?.needs, ['runner']);
  }
  // Something that isn't a SID never reaches the script.
  const odd = pc({ platform: 'win32', role: 'ci', answers: { 'powershell.exe -NoProfile -Command if (-not (Get-Service vmms': ok("locked x'; rm") } });
  await odd.run();
  assert.deepEqual(odd.said.find((s) => s.admin)?.admin?.needs, ['runner']);
  assert.throws(() => elevateScript({ platform: 'win32', appUrl: 'http://citadel.test', token: TOKEN, needs: ['hyperv'], sid: "x'; rm" }), /Windows account/);
});

test("Windows tests' Set up offers the Hyper-V paste alone to a PC that needs no other, and still tests the screen", async () => {
  const sid = 'S-1-5-21-1004336348-1177238915-682003330-1001';
  const vmms = 'powershell.exe -NoProfile -Command if (-not (Get-Service vmms';
  const close = { 'powershell.exe -NoProfile -NonInteractive -Command': ok('closed 1') };
  const p = pc({ role: 'screen', platform: 'win32', config: { workspaces: {} }, answers: { [vmms]: ok(`locked ${sid}`), ...close } });
  await p.run();
  assert.deepEqual(p.said.find((s) => s.admin)?.admin?.needs, ['hyperv']);
  assert.match(readFileSync(join(p.ctx.home, 'coordinator-agent', 'elevate.ps1'), 'utf8'), new RegExp(`-Member '${sid}'`));
  assert.equal(p.done().ok, true, 'the screen is still tested');
  // Get-VM works already, no Hyper-V, or only a Test: no paste.
  for (const [out, kind] of [
    ['ok', 'setup'],
    ['none', 'setup'],
    [`locked ${sid}`, 'test'],
  ]) {
    const q = pc({ role: 'screen', kind, platform: 'win32', config: { workspaces: {} }, answers: { [vmms]: ok(out), ...close } });
    await q.run();
    assert.equal(
      q.said.find((s) => s.admin),
      undefined,
      `${out} ${kind}`,
    );
    assert.equal(q.done().ok, true);
  }
});
