import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { exec, runSetup } from '../public/role-setup-agent.mjs';

// The agent's side of a role's Set up and Test (Build 7 M4): what it runs, what it writes and what it says back.
const dir = mkdtempSync(join(tmpdir(), 'role-setup-agent-'));
// timing-ok: own temp dir
after(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;

type Said = { id: string; step?: { n: number; text: string; state: string }; admin?: { needs: string[]; pm: string | null }; done?: { ok: boolean; report?: string; why?: string } };
type Out = { code: number; out: string };

/** A fake PC: `answers` says what each program prints (by "program arg"), anything missing isn't installed. */
function pc(o: { platform?: string; role: string; kind?: string; answers?: Record<string, Out>; config?: unknown; capture?: (file: string, window: string) => Promise<string>; busy?: boolean }) {
  const home = join(dir, `pc-${n++}`);
  const configFile = join(home, 'machine-agent.json');
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  if (o.config !== undefined) writeFileSync(configFile, typeof o.config === 'string' ? o.config : JSON.stringify(o.config));
  const said: Said[] = [];
  const ran: string[] = [];
  const uploads: Buffer[] = [];
  const ctx = {
    ask: { id: 'r1', role: o.role, kind: o.kind ?? 'setup' },
    platform: o.platform ?? 'linux',
    configFile,
    appUrl: 'http://citadel.test',
    token: 'ccm_1_x',
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
