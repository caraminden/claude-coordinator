// The agent's side of a role's Set up and self-test (Build 7 M4, src/role-setup.ts). machine-agent.mjs downloads this
// file from the app at each press and runs one ask: { id, role, kind: 'setup' | 'test', caps? }. Each step's line goes
// back as it runs; what needs an administrator goes back as fixed words (public/role-setup.js ADMIN_NEEDS), never as a
// command. Node only, no other file: it runs on the owner's PC beside machine-agent.mjs.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * A program's exit code and output (never throws); `onLine` hears each line as it comes, `timeout` ms ends it.
 * @param {string} command @param {string[]} args
 * @param {{ timeout?: number, env?: Record<string, string>, onLine?: (line: string) => void }} [opts]
 * @returns {Promise<{ code: number, out: string }>}
 */
export function exec(command, args, { timeout = 60_000, env, onLine } = {}) {
  return new Promise((done) => {
    let out = '';
    let rest = '';
    let p;
    try {
      p = spawn(command, args, { env: env ? { ...process.env, ...env } : process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return done({ code: -1, out: err.message });
    }
    const timer = setTimeout(() => p.kill(), timeout);
    const take = (d) => {
      const text = d.toString();
      out = (out + text).slice(-20_000);
      if (!onLine) return;
      const lines = (rest + text).split(/\r?\n/);
      rest = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) onLine(l.trim());
    };
    p.stdout.on('data', take);
    p.stderr.on('data', take);
    p.on('error', (err) => (clearTimeout(timer), done({ code: -1, out: err.message })));
    p.on('close', (code) => (clearTimeout(timer), done({ code: code ?? -1, out: out.trim() })));
  });
}

const first = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) ?? '';

/** machine-agent.json as an object, its own keys kept; null with why when it can't be read. */
function readConfig(file) {
  if (!file) return { raw: null, why: 'This agent runs with no --config file: connect it again with Connect a computer.' };
  if (!existsSync(file)) return { raw: {} };
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { raw: null, why: `${file} isn't a JSON object: fix it, then press Set up again.` };
    return { raw };
  } catch (err) {
    return { raw: null, why: `${file} isn't valid JSON (${err.message}): fix it, then press Set up again.` };
  }
}

/**
 * Runs one ask and reports it through ctx: { ask, platform, configFile, appUrl, token, post(body), upload(bytes),
 * exec, capture(file, window), start(command), screenBusy(), tmp, sleep(ms) }. Resolves once its end is posted.
 */
export async function runSetup(ctx) {
  const { ask } = ctx;
  const say = (n, text, state) => ctx.post({ id: ask.id, step: { n, text: String(text).slice(0, 500), state } });
  const end = (ok, extra = {}) => ctx.post({ id: ask.id, done: { ok, ...extra } });
  try {
    if (ask.role === 'screen') return await screen(ctx, say, end);
    if (ask.role === 'gpu') return await gpu(ctx, say, end);
    if (ask.role === 'turns') return await turns(ctx, say, end);
    if (ask.role === 'builds') return await builds(ctx, say, end);
    return await end(false, { why: `This agent can't set up "${ask.role}"` });
  } catch (err) {
    return end(false, { why: `The agent's step failed: ${err.message}` });
  }
}

// ---------- Windows screen: screenshots on, then a whole-screen shot and Notepad's window ----------

async function screen(ctx, say, end) {
  if (ctx.platform !== 'win32') return end(false, { why: 'The Windows screen role needs this agent on Windows itself.' });
  let n = 0;
  if (ctx.ask.kind === 'setup') {
    const { raw, why } = readConfig(ctx.configFile);
    if (!raw) return say(n, why, 'fail').then(() => end(false, { why }));
    if (raw.screenshots === true && raw.screen_lock !== undefined) await say(n++, 'Screenshots were already on in machine-agent.json', 'ok');
    else {
      // The lock is the one a test box's CI desktop jobs take too (tools/win-test-box): one screen, one at a time.
      writeFileSync(ctx.configFile, `${JSON.stringify({ ...raw, screenshots: true, screen_lock: raw.screen_lock ?? join(dirname(ctx.configFile), 'screen.lock') }, null, 2)}\n`);
      await say(n++, 'Turned screenshots on in machine-agent.json', 'ok');
    }
  }
  if (ctx.screenBusy()) {
    const why = 'A minion has the screen right now: press Test once its job ends.';
    return say(n, why, 'fail').then(() => end(false, { why }));
  }
  await say(n, 'A screenshot of the whole screen', 'running');
  const whole = join(ctx.tmp, `citadel-setup-${ctx.ask.id}-screen.png`);
  let took;
  try {
    took = await ctx.capture(whole, '');
  } catch (err) {
    rmSync(whole, { force: true });
    const why = `The screenshot failed: ${err.message}. The PC must be signed in with its screen unlocked.`;
    return say(n, why, 'fail').then(() => end(false, { why }));
  }
  await ctx.upload(readFileSync(whole));
  rmSync(whole, { force: true });
  await say(n++, `A screenshot of the whole screen: ${took}`, 'ok');
  // Notepad starts, its window is seen on the screen, and only the Notepad it started is closed.
  await say(n, 'Notepad opens and shows', 'running');
  const since = new Date().toISOString();
  ctx.start('notepad.exe');
  const win = join(ctx.tmp, `citadel-setup-${ctx.ask.id}-notepad.png`);
  let seen = null;
  for (let i = 0; i < 20 && !seen; i++) {
    await ctx.sleep(500);
    seen = await ctx.capture(win, 'Notepad').catch(() => null);
  }
  const shot = seen && readFileSync(win);
  // Both shots leave the PC's temp folder once sent.
  rmSync(win, { force: true });
  if (!seen) {
    await closeNotepad(ctx, since);
    const why = "Notepad started, but its window didn't show on the screen in 10 s.";
    return say(n, why, 'fail').then(() => end(false, { why }));
  }
  await ctx.upload(shot);
  await say(n++, `Notepad opens and shows: ${seen}`, 'ok');
  await say(n, 'Notepad closes', 'running');
  const closed = await closeNotepad(ctx, since);
  await say(n, closed ? 'Notepad closes' : "Notepad didn't close: close it yourself", closed ? 'ok' : 'fail');
  return end(closed, closed ? { report: `Screenshot ${took.split(', ').at(-1)}; Notepad opened and closed` } : { why: "The Notepad it opened didn't close." });
}

/** Closes the Notepads started since `since` (never the owner's own, open before): asked first, then ended. */
async function closeNotepad(ctx, since) {
  const ps = `$s=[datetime]'${since}'; $p=@(Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -ge $s }); foreach($x in $p){ [void]$x.CloseMainWindow() }; Start-Sleep 2; foreach($x in $p){ if(-not $x.HasExited){ Stop-Process -Id $x.Id -Force } }; 'closed ' + $p.Count`;
  const r = await ctx.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 30_000 });
  return r.code === 0 && /closed [1-9]/.test(r.out);
}

// ---------- GPU: the card, podman, NVIDIA's toolkit and its device list, then nvidia-smi in a container ----------

export const GPU_IMAGE = 'docker.io/library/ubuntu:24.04';

async function gpu(ctx, say, end) {
  if (ctx.platform === 'win32' || ctx.platform === 'darwin') return end(false, { why: `GPU jobs run from an agent in Linux or WSL, and this one runs on ${ctx.platform === 'win32' ? 'Windows' : 'macOS'}: run Connect a computer's Linux command inside WSL to lend its GPU.` });
  let n = 0;
  const smi = await ctx.exec('nvidia-smi', ['-L'], { timeout: 30_000 });
  if (smi.code !== 0) {
    const why = 'No NVIDIA GPU answered (nvidia-smi): GPU jobs need an NVIDIA card with its driver installed.';
    return say(n, why, 'fail').then(() => end(false, { why }));
  }
  const card = first(smi.out).replace(/\s*\(UUID:.*\)$/, '');
  await say(n++, `The GPU: ${card}`, 'ok');
  const needs = [];
  const podman = await ctx.exec('podman', ['--version']);
  await say(n++, podman.code === 0 ? first(podman.out) : 'podman is not installed', podman.code === 0 ? 'ok' : 'fail');
  if (podman.code !== 0) needs.push('podman');
  const ctk = await ctx.exec('nvidia-ctk', ['--version']);
  await say(n++, ctk.code === 0 ? `NVIDIA's container toolkit: ${first(ctk.out)}` : "NVIDIA's container toolkit is not installed", ctk.code === 0 ? 'ok' : 'fail');
  if (ctk.code !== 0) needs.push('nvidia-toolkit');
  const cdi = ctk.code === 0 ? await ctx.exec('nvidia-ctk', ['cdi', 'list']) : { code: 1, out: '' };
  const listed = cdi.code === 0 && /nvidia\.com\/gpu=all/.test(cdi.out);
  await say(n++, listed ? 'Containers can find the GPU (nvidia.com/gpu=all)' : "Containers can't find the GPU yet: its device list (CDI) isn't written", listed ? 'ok' : 'fail');
  if (!listed) needs.push('cdi');
  if (needs.length) {
    const pm = (await ctx.exec('apt-get', ['--version'])).code === 0 ? 'apt' : (await ctx.exec('dnf', ['--version'])).code === 0 ? 'dnf' : null;
    await ctx.post({ id: ctx.ask.id, admin: { needs, pm } });
    return end(false, { why: 'Run the administrator command on the card on this PC, then press Set up again.' });
  }
  if (ctx.ask.kind === 'setup') {
    const { raw, why } = readConfig(ctx.configFile);
    if (!raw) return say(n, why, 'fail').then(() => end(false, { why }));
    const jobs = raw.jobs && typeof raw.jobs === 'object' ? raw.jobs : null;
    if (jobs?.gpu === true) await say(n++, 'GPU jobs were already on in machine-agent.json', 'ok');
    else {
      const dir = join(dirname(ctx.configFile), 'gpu-jobs');
      if (!jobs) mkdirSync(dir, { recursive: true });
      // A jobs block of the owner's own keeps its folders and caps: only gpu turns on.
      writeFileSync(ctx.configFile, `${JSON.stringify({ ...raw, jobs: jobs ? { ...jobs, gpu: true } : { dir, folders: {}, max_disk_gb: 50, gpu: true } }, null, 2)}\n`);
      await say(n++, jobs ? 'Turned the GPU on for jobs in machine-agent.json' : `Turned GPU jobs on in machine-agent.json (jobs folder ${dir}, at most 50 GB)`, 'ok');
    }
  }
  await say(n, `nvidia-smi in a container (${GPU_IMAGE}; the first pull takes a few minutes)`, 'running');
  const run = await ctx.exec('podman', ['run', '--rm', '--device', 'nvidia.com/gpu=all', '--security-opt', 'label=disable', GPU_IMAGE, 'nvidia-smi', '-L'], { timeout: 10 * 60_000 });
  if (run.code !== 0) {
    const why = `nvidia-smi didn't run in a container: ${run.out.split(/\r?\n/).slice(-3).join(' ').slice(0, 300)}`;
    return say(n, why, 'fail').then(() => end(false, { why }));
  }
  const inside = first(run.out).replace(/\s*\(UUID:.*\)$/, '');
  await say(n, `nvidia-smi in a container: ${inside}`, 'ok');
  return end(true, { report: `${inside} in a container` });
}

// ---------- Builds: podman, Citadel's build images by digest, their cache volumes, then a hello-world APK ----------

/** The WSL distro Minion turns' install makes (tools/worker/install-worker.ps1), and its user, whose rootless podman builds use on Windows. */
export const BUILDS_DISTRO = 'citadel-workers';
const BUILDS_USER = 'citadel-worker';
/** How often a long pull or build says it's still going, so the app (QUIET_MS) doesn't take it for gone. */
const BEAT_MS = 60_000;

/** A program run with a line on the card at most once a second, and a beat each minute while it says nothing. */
async function watched(run, say, n, label, timeout) {
  const started = Date.now();
  let last = 0;
  let line = '';
  const beat = setInterval(() => say(n, `${label}: ${Math.round((Date.now() - started) / 60_000)} min so far${line ? `, ${line}` : ''}`, 'running'), BEAT_MS);
  try {
    return await run({
      timeout,
      onLine: (l) => {
        line = l.slice(0, 200);
        if (Date.now() - last < 1000) return;
        last = Date.now();
        say(n, `${label}: ${line}`, 'running');
      },
    });
  } finally {
    clearInterval(beat);
  }
}

const tail = (out) =>
  String(out ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-3)
    .join(' ')
    .slice(0, 300);
const gb = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);

async function builds(ctx, say, end) {
  if (ctx.platform === 'darwin') return end(false, { why: 'Builds need Linux, or Windows with WSL.' });
  const given = ctx.ask.builds && typeof ctx.ask.builds === 'object' ? ctx.ask.builds : {};
  const images = Object.entries(given.images && typeof given.images === 'object' ? given.images : {}).filter(([k, v]) => /^[a-z]+$/.test(k) && typeof v === 'string' && /^[a-z0-9][a-z0-9._/:-]{0,250}@sha256:[a-f0-9]{64}$/.test(v));
  const volumes = (Array.isArray(given.volumes) ? given.volumes : []).filter((v) => typeof v === 'string' && /^citadel-[a-z]+$/.test(v));
  if (!images.some(([k]) => k === 'android')) return end(false, { why: "Citadel sent no Android build image to pull: it isn't published yet." });
  const win = ctx.platform === 'win32';
  // On Windows, podman in the distro as its worker user, in that user's session (lingering), as its worker runs it.
  const podman = (args, opts) => (win ? ctx.exec('wsl.exe', ['-d', BUILDS_DISTRO, '-u', BUILDS_USER, '--exec', '/bin/sh', '-c', 'XDG_RUNTIME_DIR=/run/user/$(id -u) exec podman "$@"', 'podman', ...args], opts) : ctx.exec('podman', args, opts));
  let n = 0;
  if (win) {
    // As the worker's installer asks: WSL 2 answers --version; the old inbox stub doesn't.
    if ((await ctx.exec('wsl.exe', ['--version'], { timeout: 30_000 })).code !== 0) {
      await say(n, "WSL 2 isn't installed on this PC", 'fail');
      await ctx.post({ id: ctx.ask.id, admin: { needs: ['wsl'] } });
      return end(false, { why: 'Run the administrator command on the card, restart the PC, then press Set up again.' });
    }
    const wsl = await ctx.exec('wsl.exe', ['-l', '-q'], { timeout: 30_000 });
    // wsl.exe prints UTF-16.
    const distros = wsl.out
      .replace(/\0/g, '')
      .split(/\r?\n/)
      .map((l) => l.trim());
    if (!distros.includes(BUILDS_DISTRO)) {
      const why = `Builds run in the ${BUILDS_DISTRO} WSL distro, which isn't on this PC yet: press Set up on Minion turns, which makes it with podman, then press this Set up again.`;
      return say(n, `No ${BUILDS_DISTRO} WSL distro here`, 'fail').then(() => end(false, { why }));
    }
    await say(n++, `The ${BUILDS_DISTRO} WSL distro is here`, 'ok');
  }
  const version = await podman(['--version'], { timeout: 60_000 });
  if (version.code !== 0) {
    await say(n, win ? `podman doesn't answer in ${BUILDS_DISTRO}: ${tail(version.out) || 'no output'}` : 'podman is not installed', 'fail');
    if (win) return end(false, { why: `podman in ${BUILDS_DISTRO} is missing or broken: press Set up on Minion turns to put it back, then press this Set up again.` });
    const pm = (await ctx.exec('apt-get', ['--version'])).code === 0 ? 'apt' : (await ctx.exec('dnf', ['--version'])).code === 0 ? 'dnf' : null;
    await ctx.post({ id: ctx.ask.id, admin: { needs: ['podman'], pm } });
    return end(false, { why: 'Run the administrator command on the card on this PC, then press Set up again.' });
  }
  await say(n++, `${first(version.out)}${win ? ` in ${BUILDS_DISTRO}` : ''}`, 'ok');
  const sizes = [];
  for (const [kind, image] of images) {
    const name = `citadel-build-${kind}`;
    const have = (await podman(['image', 'exists', image])).code === 0;
    if (!have && ctx.ask.kind === 'test') {
      const why = `${name} isn't pulled on this PC: press Set up.`;
      return say(n, why, 'fail').then(() => end(false, { why }));
    }
    if (!have) {
      await say(n, `Pulling ${name}`, 'running');
      const pull = await watched((o) => podman(['pull', image], o), say, n, `Pulling ${name}`, 60 * 60_000);
      if (pull.code !== 0) {
        const why = `${name} didn't pull: ${tail(pull.out) || 'it stopped'}`;
        return say(n, why, 'fail').then(() => end(false, { why }));
      }
    }
    const size = await podman(['image', 'inspect', '--format', '{{.Size}}', image]);
    const mb = Math.round(Number(first(size.out)) / 1e6);
    if (Number.isFinite(mb) && mb > 0) sizes.push(`${kind} ${gb(mb)}`);
    await say(n++, `${have ? 'Already pulled' : 'Pulled'} ${name}${Number.isFinite(mb) && mb > 0 ? ` (${gb(mb)})` : ''}`, 'ok');
  }
  const made = [];
  for (const v of volumes) {
    if ((await podman(['volume', 'exists', v])).code === 0) continue;
    if (ctx.ask.kind === 'test') {
      const why = `The cache volume ${v} isn't on this PC: press Set up.`;
      return say(n, why, 'fail').then(() => end(false, { why }));
    }
    const r = await podman(['volume', 'create', v]);
    if (r.code !== 0) {
      const why = `Could not make the cache volume ${v}: ${tail(r.out) || 'it failed'}`;
      return say(n, why, 'fail').then(() => end(false, { why }));
    }
    made.push(v);
  }
  if (volumes.length) await say(n++, `Cache volumes ${volumes.join(', ')}${made.length ? ` (made ${made.join(', ')})` : ' (already there)'}`, 'ok');
  const android = images.find(([k]) => k === 'android')[1];
  const threads = Number.isInteger(ctx.ask.caps?.threads) && ctx.ask.caps.threads > 0 ? ['--cpus', String(ctx.ask.caps.threads)] : [];
  const label = 'Building a hello-world APK in citadel-build-android (the first build fetches Gradle’s plugins into citadel-gradle)';
  await say(n, label, 'running');
  const apk = await watched((o) => podman(['run', '--rm', '--security-opt', 'label=disable', ...threads, '-v', 'citadel-gradle:/cache/gradle', android, 'citadel-hello-apk'], o), say, n, 'Building the hello-world APK', 30 * 60_000);
  const bytes = Number(apk.out.match(/^apk (\d+)$/m)?.[1]);
  if (apk.code !== 0 || !bytes) {
    const why = `The hello-world APK didn't build: ${tail(apk.out) || 'it stopped'}`;
    return say(n, why, 'fail').then(() => end(false, { why }));
  }
  await say(n, `Built a hello-world APK (${Math.max(1, Math.round(bytes / 1000))} KB) in citadel-build-android`, 'ok');
  return end(true, { report: `Hello-world APK built${sizes.length ? `; images ${sizes.join(', ')}` : ''}` });
}

// ---------- Minion turns on Windows: the worker's own installer, in the owner's normal PowerShell ----------

async function turns(ctx, say, end) {
  if (ctx.platform !== 'win32') return end(false, { why: "On Linux the card shows the worker's install command to run as root." });
  await say(0, 'Downloading the worker installer', 'running');
  const res = await fetch(new URL('/worker-setup/install-worker.ps1', ctx.appUrl)).catch((err) => ({ ok: false, status: err.message }));
  if (!res.ok) {
    const why = `Could not download the worker installer (${res.status}).`;
    return say(0, why, 'fail').then(() => end(false, { why }));
  }
  const file = join(ctx.tmp, 'citadel-install-worker.ps1');
  writeFileSync(file, await res.text());
  await say(0, 'Downloaded the worker installer', 'ok');
  await say(1, 'Installing the worker (the citadel-workers distro, podman, the worker)', 'running');
  const caps = ctx.ask.caps && typeof ctx.ask.caps === 'object' ? ctx.ask.caps : {};
  const flags = { workers: '-Workers', threads: '-Threads', memory_gb: '-MemoryGB', disk_gb: '-DiskGB' };
  const args = Object.entries(flags).flatMap(([k, f]) => (Number.isInteger(caps[k]) && caps[k] > 0 ? [f, String(caps[k])] : []));
  // Its newest line shows on the card, at most one a second.
  let last = 0;
  const r = await ctx.exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, '-Url', new URL(ctx.appUrl).origin, ...args], {
    timeout: 45 * 60_000,
    env: { CC_MACHINE_TOKEN: ctx.token },
    onLine: (line) => {
      if (Date.now() - last < 1000) return;
      last = Date.now();
      say(1, `Installing the worker: ${line}`, 'running');
    },
  });
  if (/WSL 2 isn't installed/.test(r.out)) {
    await say(1, "WSL 2 isn't installed on this PC", 'fail');
    await ctx.post({ id: ctx.ask.id, admin: { needs: ['wsl'] } });
    return end(false, { why: 'Run the administrator command on the card, restart the PC, then press Set up again.' });
  }
  if (r.code !== 0) {
    const why = (r.out.match(/install-worker: (.*)/)?.[1] ?? r.out.split(/\r?\n/).at(-1) ?? 'it stopped').slice(0, 400);
    return say(1, `The worker's installer stopped: ${why}`, 'fail').then(() => end(false, { why }));
  }
  await say(1, 'Installed the worker', 'ok');
  return end(true);
}
