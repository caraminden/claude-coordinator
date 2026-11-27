import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { containerArgs, DEPS_SH, turnEnvHere, Worker, workerConfig } from '../public/machine-worker.mjs';
import { tempRoot } from './helpers.ts';
import { until } from './wait.ts';

// A worker container from Citadel's worker image boots systemd, so a turn there has /run/user/<uid> and systemd-run as
// on perigee (#2249); one whose systemd won't come up runs as before, with TMPDIR as its runtime folder.
const tmp = tempRoot('worker-systemd-');
after(() => tmp.teardown());
const uid = String(process.getuid?.() ?? 0);
const home = '/home/worker';
const launch = { home, roots: ['/r'], wrapper: [], cwd: null };

test('a container that boots systemd runs init as root and keeps its home volume as it is; a plain one does not', () => {
  const cfg = workerConfig({ root: '/w', image: 'img' });
  const sd = containerArgs(cfg, launch, [], cfg.container, true);
  const plain = containerArgs(cfg, launch, [], cfg.container, false);
  assert.deepEqual(sd.slice(sd.indexOf('--systemd=always'), sd.indexOf('--systemd=always') + 3), ['--systemd=always', '--user', '0:0']);
  assert.ok(sd.includes(`citadel-worker-home:${home}`), 'no :U: it would hand the volume to root');
  assert.deepEqual(sd.slice(-2), ['img', '/sbin/init']);
  assert.ok(plain.includes('--init') && !plain.includes('--systemd=always'));
  assert.ok(plain.includes(`citadel-worker-home:${home}:U`));
  assert.deepEqual(plain.slice(-3), ['img', 'sleep', 'infinity']);
  const label = (a: string[]) => a[a.indexOf('--label') + 1];
  assert.notEqual(label(sd), label(plain), 'switching mode replaces the container');
});

test("a turn's runtime folder is its user manager's with systemd, its TMPDIR without, and the image's env rides along", () => {
  const env = { PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright' };
  assert.deepEqual(turnEnvHere({ TMPDIR: '/t', XDG_RUNTIME_DIR: '/run/user/1002' }, { systemd: true, env }, '1000'), { ...env, XDG_RUNTIME_DIR: '/run/user/1000' });
  assert.deepEqual(turnEnvHere({ TMPDIR: '/t', XDG_RUNTIME_DIR: '/run/user/1002' }, { systemd: false, env: {} }, '1000'), { XDG_RUNTIME_DIR: '/t' });
});

type Call = string[];
/** A fake podman: the image's label, a container that runs once started, and a systemd that says `boot()` when asked. */
function fakeWorker(o: { label?: string; boot?: () => Promise<string>; runFails?: (args: Call) => boolean } = {}) {
  const calls: Call[] = [];
  let running: string | null = null;
  const w = new Worker({
    config: { root: join(tmp.dir, `w${Math.random()}`), image: 'img' },
    appUrl: 'http://127.0.0.1:9',
    token: 't',
    run: async (_cmd: string, args: Call) => {
      calls.push(args);
      const sh = args.at(-1) ?? '';
      if (args[0] === 'image') return { code: 0, out: `${o.label ?? '1'}\n`, err: '' };
      if (args[0] === 'container') return running ? { code: 0, out: `true ${running}\n`, err: '' } : { code: 1, out: '', err: 'no such container' };
      if (args[0] === 'run') {
        if (o.runFails?.(args)) return { code: 125, out: '', err: 'Error: crun: cannot boot systemd' };
        running = args[args.indexOf('--label') + 1].split('=')[1];
        return { code: 0, out: 'id\n', err: '' };
      }
      if (args[0] === 'rm') {
        running = null;
        return { code: 0, out: '', err: '' };
      }
      if (args[0] === 'exec' && args.includes('0:0') && sh.includes('is-system-running')) return { code: 0, out: `${o.boot ? await o.boot() : 'running'}\n`, err: '' };
      if (args[0] === 'exec' && sh.includes('turn-env.json')) {
        const sd = args.includes('--systemd=always') || calls.some((c) => c[0] === 'run' && c.includes('--systemd=always') && !o.runFails?.(c));
        return { code: 0, out: `{"PLAYWRIGHT_BROWSERS_PATH":"/opt/ms-playwright","PATH":"/evil","lower":"x"}\n${sd && running ? 'systemd\n' : ''}`, err: '' };
      }
      if (args.includes('--version')) return { code: 0, out: '2.0.0 (Claude Code)\n', err: '' };
      return { code: 0, out: '', err: '' };
    },
    log: () => {},
  });
  return { w, calls, runs: () => calls.filter((c) => c[0] === 'run') };
}

/** fitSpec on a turn whose spec carries perigee's env, as the server sends it. */
function fitted(w: Worker) {
  const local = join(tmp.dir, `t${Math.random()}`);
  mkdirSync(local, { recursive: true });
  writeFileSync(join(local, 'spec.json'), JSON.stringify({ env: { TMPDIR: '/r/tmp', XDG_RUNTIME_DIR: '/run/user/1002', PATH: '/p' } }));
  w.fitSpec({ local, launch: { ...launch, account: 1 } } as never);
  return JSON.parse(readFileSync(join(local, 'spec.json'), 'utf8')).env;
}

test("Citadel's worker image boots systemd, makes the user's manager, and a turn there gets its runtime folder and the image's env", async () => {
  const { w, calls } = fakeWorker();
  await w.ensureContainer(launch);
  const run = calls.find((c) => c[0] === 'run')!;
  assert.ok(run.includes('--systemd=always'));
  assert.ok(
    calls.some((c) => c.includes('0:0') && c.includes('enable-linger') && c.includes(uid)),
    'linger starts the user manager',
  );
  assert.deepEqual(w.boxes.get('citadel-worker'), { systemd: true, env: { PLAYWRIGHT_BROWSERS_PATH: '/opt/ms-playwright' } }, 'PATH and bad names from the image are dropped');
  // Every exec of the turn's runs as this computer's user, not the container's root.
  for (const c of calls.filter((c) => c[0] === 'exec' && !c.includes('0:0'))) assert.equal(c[c.indexOf('--user') + 1], `${uid}:${process.getgid?.() ?? 0}`);
  const env = fitted(w);
  assert.equal(env.XDG_RUNTIME_DIR, `/run/user/${uid}`);
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, '/opt/ms-playwright');
  assert.equal(env.PATH, '/p');
});

test('an image without the label runs as before, and its turns use their TMPDIR for runtime files', async () => {
  const { w, runs } = fakeWorker({ label: '' });
  await w.ensureContainer(launch);
  assert.ok(runs()[0].includes('--init') && !runs()[0].includes('--systemd=always'));
  assert.equal(fitted(w).XDG_RUNTIME_DIR, '/r/tmp');
});

test("a systemd that won't come up is replaced by a plain container, and the self-test passes it with a note, not a hold", async () => {
  const { w, calls, runs } = fakeWorker({ boot: async () => 'offline' });
  await w.ensureContainer(launch);
  assert.equal(runs().length, 2);
  assert.ok(runs()[1].includes('--init'), 'the second start is a plain one');
  assert.ok(
    calls.some((c) => c[0] === 'rm'),
    'the half-booted one is removed first',
  );
  assert.equal(fitted(w).XDG_RUNTIME_DIR, '/r/tmp');
  const [, ok, text] = await w.turnTools('citadel-worker');
  assert.equal(ok, true);
  assert.match(text, /systemd did not start.*as before/);
});

test('a systemd container podman refuses to start falls back the same way', async () => {
  const { w, runs } = fakeWorker({ runFails: (a) => a.includes('--systemd=always') });
  await w.ensureContainer(launch);
  assert.equal(runs().length, 2);
  assert.ok(runs()[1].includes('--init'));
  assert.equal(w.boxes.get('citadel-worker')?.systemd, false);
});

test('a second turn arriving while the container boots systemd waits until it is ready, and only one container starts', async () => {
  let release!: () => void;
  let booting = false;
  const held = new Promise<void>((r) => (release = r));
  const { w, runs } = fakeWorker({ boot: async () => ((booting = true), await held, 'running') });
  let done = 0;
  const a = w.ensureContainer(launch).then(() => done++);
  await until('systemd to be booting', () => booting);
  const b = w.ensureContainer(launch).then(() => done++);
  // The fake answers without timers: once this turn of the event loop ends, a second start that didn't wait is done.
  await new Promise((r) => setImmediate(r));
  assert.equal(done, 0, 'neither is ready while systemd boots');
  release();
  await Promise.all([a, b]);
  assert.equal(runs().length, 1);
  assert.equal(w.boxes.get('citadel-worker')?.systemd, true);
});

test("a brought worktree gets npm ci where a lockfile's ignored node_modules is missing, and says which failed", () => {
  const repo = join(tmp.dir, 'repo');
  const bin = join(tmp.dir, 'bin');
  for (const d of ['', 'has', 'bad', 'tracked']) mkdirSync(join(repo, d), { recursive: true });
  mkdirSync(bin, { recursive: true });
  const git = (...a: string[]) => assert.equal(spawnSync('git', ['-C', repo, ...a]).status, 0, a.join(' '));
  git('init', '-q');
  writeFileSync(join(repo, '.gitignore'), '/node_modules/\n/has/node_modules/\n/bad/node_modules/\n');
  for (const d of ['', 'has', 'bad', 'tracked']) writeFileSync(join(repo, d, 'package-lock.json'), '{}');
  mkdirSync(join(repo, 'has', 'node_modules'));
  git('add', '.');
  // npm ci makes node_modules, except in bad/.
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\necho "$PWD $*" >> ${join(tmp.dir, 'npm-calls')}\ncase "$PWD" in */bad) exit 1;; esac\nmkdir node_modules\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  const r = spawnSync('sh', ['-c', DEPS_SH, 'sh', repo, '30'], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'failed bad\n');
  const npm = readFileSync(join(tmp.dir, 'npm-calls'), 'utf8').trim().split('\n').sort();
  assert.deepEqual(npm, [`${repo} ci --prefer-offline --no-audit --no-fund --loglevel=error`, `${repo}/bad ci --prefer-offline --no-audit --no-fund --loglevel=error`]);
  assert.ok(existsSync(join(repo, 'node_modules')));
  assert.ok(!existsSync(join(repo, 'tracked', 'node_modules')), 'a node_modules git would track is left alone');
});
