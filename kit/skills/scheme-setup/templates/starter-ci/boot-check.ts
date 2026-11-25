// Boot check: build the app, start it the way Citadel does, and get its health page (Citadel's starter CI, #1782).
// From the kit's scheme-setup/templates/starter-ci/; copy to tools/boot-check.ts unchanged. Node 24+, no packages.
//
//   node tools/boot-check.ts [folder]      folder: the one holding citadel-app.json (default: the repo root)
//   node tools/boot-check.ts --no-build    start what is already built
//
// citadel-app.json says how to build, start and reach the app, so a scheme fills nothing in here. The app gets an empty
// DATA_DIR, a HOME of its own, a throwaway identity key and a Citadel address nothing answers on: it must come up on a
// fresh database while Citadel is away, and can touch no real data. Exit 0: it answered twice. Exit 1: it didn't, and
// its last output is printed.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

interface Manifest {
  start: string[];
  build?: string[];
  build_timeout?: number;
  workdir?: string;
  env?: Record<string, string>;
  health?: string | null;
}

const HEALTH_MS = Number(process.env.BOOT_CHECK_MS) || 60_000;
const args = process.argv.slice(2);
const app = resolve(args.find((a) => !a.startsWith('--')) ?? '.');

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const gone = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null;

function fail(why: string): never {
  console.error(`boot check: FAILED: ${why}`);
  process.exit(1);
}

function freePort(): Promise<number> {
  return new Promise((done, bad) => {
    const s = createServer();
    s.once('error', bad);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => done(port));
    });
  });
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const c = connect(port, '127.0.0.1');
    c.setTimeout(3000, () => (c.destroy(), done(false)));
    c.once('connect', () => (c.destroy(), done(true)));
    c.once('error', () => done(false));
  });
}

/** One look at the app: what it answered, and whether that counts as up. */
async function look(port: number, health: string | null): Promise<{ up: boolean; saw: string }> {
  if (!health) {
    const up = await portOpen(port);
    return { up, saw: up ? `port ${port} open` : `port ${port} closed` };
  }
  try {
    // No redirect followed: the health path itself has to answer 2xx, as at a deploy.
    const r = await fetch(`http://127.0.0.1:${port}${health}`, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
    await r.body?.cancel();
    return { up: r.ok, saw: `${health} answered ${r.status}` };
  } catch {
    return { up: false, saw: `${health} didn't answer` };
  }
}

/** Ask the app to stop, then make it. True when it stopped by itself. */
async function stop(p: ChildProcess): Promise<boolean> {
  if (p.pid === undefined) return true;
  // The whole group: an app started through a wrapper leaves its child behind otherwise.
  const signal = (s: NodeJS.Signals) => {
    try {
      process.kill(-(p.pid ?? 0), s);
    } catch {
      // already gone
    }
  };
  signal('SIGTERM');
  const until = Date.now() + 10_000;
  while (!gone(p) && Date.now() < until) await sleep(100);
  const clean = gone(p);
  signal('SIGKILL');
  return clean;
}

let manifest: Manifest;
try {
  manifest = JSON.parse(readFileSync(join(app, 'citadel-app.json'), 'utf8')) as Manifest;
} catch (err) {
  fail(`can't read ${join(app, 'citadel-app.json')}: ${err instanceof Error ? err.message : String(err)}`);
}
const command = manifest.start?.[0];
if (!command) fail('citadel-app.json has no start command');
const health = manifest.health ?? null;
// Citadel serves the app under /apps/<name>; the health path carries that name when it has the prefix.
const name = /^\/apps\/([^/]+)/.exec(health ?? '')?.[1] ?? basename(app);

if (!args.includes('--no-build')) {
  for (const step of manifest.build ?? []) {
    console.log(`boot check: $ ${step}`);
    const r = spawnSync('bash', ['-c', step], { cwd: app, stdio: 'inherit', timeout: (manifest.build_timeout ?? 20) * 60_000 });
    if (r.status !== 0) fail(`the build step "${step}" ${r.error ? `didn't finish: ${r.error.message}` : `exited ${r.status ?? r.signal}`}`);
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'boot-check-'));
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }));
const keys = join(scratch, 'keys');
const home = join(scratch, 'home');
const data = join(scratch, 'data');
for (const d of [keys, home, data]) mkdirSync(d);
writeFileSync(join(keys, 'identity.pub'), generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
writeFileSync(join(keys, 'contraption.key'), 'boot-check\n');

const port = await freePort();
const own = Object.entries(manifest.env ?? {}).map(([k, v]) => [k, v.replace(/^~(?=\/|$)/, home)]);
// Only these: nothing else of the runner's environment (its tokens) reaches the app.
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  LANG: process.env.LANG ?? 'C.UTF-8',
  // Where a toolchain the app starts through lives, now that HOME is an empty folder.
  ...Object.fromEntries(['LD_LIBRARY_PATH', 'MISE_DATA_DIR', 'RUSTUP_HOME', 'CARGO_HOME'].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))),
  ...Object.fromEntries(own),
  HOME: home,
  TMPDIR: scratch,
  PORT: String(port),
  DATA_DIR: data,
  CITADEL_KEYS: keys,
  CITADEL_URL: 'http://127.0.0.1:9',
  BASE_PATH: `/apps/${name}`,
};
// "node" and "/usr/bin/node" both mean the Node this job set up.
const program = basename(command) === 'node' ? process.execPath : command;

let out = '';
const child = spawn(program, manifest.start.slice(1), { cwd: join(app, manifest.workdir ?? '.'), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
const keep = (b: Buffer) => {
  out = (out + b.toString()).slice(-20_000);
};
child.stdout.on('data', keep);
child.stderr.on('data', keep);
let startError = '';
child.once('error', (err) => {
  startError = err.message;
});
// A cancelled job (or Ctrl-C) takes the app with it.
for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, () => void stop(child).then(() => process.exit(1)));

console.log(`boot check: starting ${name} on port ${port}`);
const started = Date.now();
let answers = 0;
let saw = 'nothing yet';
while (answers < 2 && !gone(child) && !startError && Date.now() - started < HEALTH_MS) {
  const seen = await look(port, health);
  saw = seen.saw;
  answers = seen.up ? answers + 1 : 0;
  // Twice, a moment apart, as Citadel's deploy asks: one answer can come just before a crash.
  if (answers < 2) await sleep(seen.up ? 2000 : 250);
}
const secs = ((Date.now() - started) / 1000).toFixed(1);
const died = gone(child);
const how = child.signalCode ?? child.exitCode;
const clean = died || startError ? true : await stop(child);

if (answers < 2) {
  const tail = out.trimEnd().split('\n').slice(-60).join('\n');
  console.error(tail ? `--- the app's last output ---\n${tail}\n---` : '(the app printed nothing)');
  fail(startError ? `it didn't start: ${startError}` : died ? `it exited (${how}) after ${secs}s; last seen: ${saw}` : `not up after ${secs}s: ${saw}`);
}
if (!clean) console.log('boot check: note: it ignored SIGTERM for 10s and was killed');
console.log(`boot check: passed: ${saw}, twice, ${secs}s after the start`);
process.exit(0);
