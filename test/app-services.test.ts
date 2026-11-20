import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { after, beforeEach, test } from 'node:test';
import { AppServices, folderHolds, manifestOn, parseManifest, serviceOptions, unitFiles, type ServiceOptions } from '../src/app-services.ts';
import type { ContraptionRow } from '../src/db.ts';
import { fakeSystemd } from './helpers.ts';
import { until } from './wait.ts';

// Citadel writes and runs contraptions' user services (#266). Everything here runs against a stand-in
// systemctl and a temp unit folder: never the real ones.
const root = mkdtempSync(join(tmpdir(), 'app-services-'));
after(() => rmSync(root, { recursive: true, force: true }));
// Build steps take a slot from the real tools/citadel-heavy (#847), in a lock folder of the test's own.
const heavyDir = join(root, 'heavy');
process.env.CITADEL_HEAVY_DIR = heavyDir;
process.env.CITADEL_HEAVY_MAX_PRESSURE = '101'; // the box's own load doesn't hold these up
process.env.CITADEL_HEAVY_POLL = '0.1';
const heavyHistory = () => (existsSync(join(heavyDir, 'history')) ? readFileSync(join(heavyDir, 'history'), 'utf8') : '');

const MANIFEST = {
  start: ['/usr/bin/node', 'src/server.ts'],
  env: { VAPID_KEYS: '~/.config/mandate/vapid.json', ODD: '50% "quoted" \\ back' },
  timers: { backup: { command: ['/usr/bin/node', 'deploy/backup.ts', '${DATA_DIR}'], on_calendar: '*-*-* 03:30:00' } },
  health: '/health',
};
const row = (name: string, port: number) => ({ id: 1, name, title: name[0].toUpperCase() + name.slice(1), port } as ContraptionRow);

test('a manifest is checked: what an app may set, and nothing Citadel sets', () => {
  const m = parseManifest(JSON.stringify(MANIFEST));
  assert.deepEqual(m.start, MANIFEST.start);
  assert.equal(m.workdir, '.');
  assert.equal(m.timers.backup.workdir, '.');
  assert.equal(parseManifest(JSON.stringify({ start: ['node', 'server.ts'], workdir: 'companion/' })).workdir, 'companion');
  assert.equal(m.clipboard, null, 'no clipboard unless the app asks (#1086)');
  assert.equal(parseManifest(JSON.stringify({ start: ['node'], clipboard: 'write' })).clipboard, 'write');
  for (const [bad, says] of [
    ['nope', /isn't JSON/],
    [{}, /start must be a list/],
    [{ start: ['src/server.ts'] }, /absolute path or a program name/],
    [{ start: ['node'], workdir: '../other' }, /folder inside/],
    [{ start: ['node'], workdir: '/etc' }, /folder inside/],
    [{ start: ['node'], env: { PORT: '1' } }, /can't set PORT/],
    [{ start: ['node'], env: { DATA_DIR: '/x' } }, /can't set DATA_DIR/],
    [{ start: ['node'], env: { X: 'two\nlines' } }, /one line/],
    [{ start: ['node'], timers: { 'Bad Name': { command: ['x'], on_calendar: 'daily' } } }, /short slug/],
    [{ start: ['node'], timers: { b: { command: ['x'] } } }, /on_calendar/],
    [{ start: ['node'], health: 'health' }, /health must be a path/],
    [{ start: ['node'], clipboard: 'read' }, /clipboard must be "write"/],
    [{ start: ['node'], clipboard: true }, /clipboard must be "write"/],
  ] as const) assert.throws(() => parseManifest(typeof bad === 'string' ? bad : JSON.stringify(bad)), says, JSON.stringify(bad));
});

test('the units come from the registry and the manifest, quoted so nothing is a specifier', () => {
  const files = unitFiles({ row: row('mandate', 7341), manifest: parseManifest(JSON.stringify(MANIFEST)), folder: '/h/apps/mandate', keysDir: '/h/keys/mandate', citadelUrl: 'http://127.0.0.1:8573', home: '/h' });
  assert.deepEqual([...files.keys()], ['citadel-app-mandate.service', 'citadel-app-mandate-backup.service', 'citadel-app-mandate-backup.timer']);
  const main = files.get('citadel-app-mandate.service')!;
  assert.match(main, /^# Written by Citadel for contraption mandate\./);
  assert.match(main, /^WorkingDirectory=\/h\/apps\/mandate$/m);
  assert.match(main, /^ExecStart=\/usr\/bin\/node "src\/server.ts"$/m);
  for (const env of ['PORT=7341', 'DATA_DIR=/h/.local/share/mandate', 'CITADEL_KEYS=/h/keys/mandate', 'CITADEL_URL=http://127.0.0.1:8573', 'BASE_PATH=/apps/mandate', 'VAPID_KEYS=/h/.config/mandate/vapid.json']) {
    assert.ok(main.includes(`Environment="${env}"`), env);
  }
  assert.ok(main.includes('Environment="ODD=50%% \\"quoted\\" \\\\ back"'), 'quotes, backslashes and % escaped');
  assert.ok(main.includes(`Environment="CITADEL_HEAVY=${join(import.meta.dirname, '..', 'tools', 'citadel-app-heavy')}"`), 'apps get the heavy-slot command');
  assert.match(main, /^Restart=always$/m);
  assert.match(main, /^Slice=contraptions\.slice$/m, 'the app unit runs in contraptions.slice (#1238)');
  assert.match(main, /^RestartSec=5$/m);
  assert.match(main, /^WantedBy=default.target$/m);
  const job = files.get('citadel-app-mandate-backup.service')!;
  assert.match(job, /^Type=oneshot$/m);
  assert.match(job, /^Slice=contraptions\.slice$/m, 'the job unit runs in contraptions.slice (#1238)');
  assert.match(job, /^ExecStart=\/usr\/bin\/node "deploy\/backup.ts" "\$\{DATA_DIR\}"$/m, '${VAR} left for systemd to expand');
  assert.ok(job.includes('Environment="PORT=7341"'), 'jobs get the app\'s environment');
  assert.match(files.get('citadel-app-mandate-backup.timer')!, /^OnCalendar=\*-\*-\* 03:30:00$/m);
});

test('units run with the build\'s toolchain: the app\'s .mise.toml trusted and a bare program found on mise\'s shims first', () => {
  const manifest = parseManifest(JSON.stringify({ start: ['node', 'server.ts'], timers: { tick: { command: ['/usr/bin/true'], on_calendar: 'daily' } } }));
  const files = unitFiles({ row: row('toc', 22255), manifest, folder: '/h/apps/toc', keysDir: '/h/keys/toc', citadelUrl: 'http://127.0.0.1:8573', home: '/h' });
  const search = 'ExecSearchPath=/h/.local/share/mise/shims:/h/.local/bin:/usr/local/bin:/usr/bin:/bin';
  for (const unit of ['citadel-app-toc.service', 'citadel-app-toc-tick.service']) {
    const text = files.get(unit)!;
    assert.ok(text.includes('Environment="MISE_TRUSTED_CONFIG_PATHS=/h/apps/toc"'), unit);
    assert.ok(text.split('\n').includes(search), unit);
  }
  assert.match(files.get('citadel-app-toc.service')!, /^ExecStart=node "server.ts"$/m, 'a bare name stays bare for ExecSearchPath to find');
  assert.match(files.get('citadel-app-toc-tick.service')!, /^ExecStart=\/usr\/bin\/true$/m, 'an absolute path stays as it is');
  const own = unitFiles({ row: row('toc', 22255), manifest: parseManifest(JSON.stringify({ start: ['node'], env: { MISE_TRUSTED_CONFIG_PATHS: '~/other' } })), folder: '/h/apps/toc', keysDir: '', citadelUrl: '', home: '/h' });
  assert.ok(own.get('citadel-app-toc.service')!.includes('Environment="MISE_TRUSTED_CONFIG_PATHS=/h/apps/toc:/h/other"'), 'an app\'s own trusted paths are kept');
});

test('only the live server, or a dev copy with stand-ins for both systemctl and the unit folder, touches systemd', () => {
  const rest = { keysDir: () => '', citadelUrl: () => '' };
  assert.equal(serviceOptions({}, true, false, rest).off, null);
  assert.match(serviceOptions({}, true, true, rest).off!, /boot check or a preview/);
  assert.match(serviceOptions({ CITADEL_SYSTEMCTL: '/x' }, false, false, rest).off!, /Only the live/);
  assert.equal(serviceOptions({ CITADEL_SYSTEMCTL: '/x', XDG_CONFIG_HOME: '/y' }, false, false, rest).off, null);
  assert.match(serviceOptions({ CITADEL_SYSTEMCTL: '/x', XDG_CONFIG_HOME: '/y' }, false, true, rest).off!, /boot check/);
  assert.equal(serviceOptions({ XDG_CONFIG_HOME: '/y' }, true, false, rest).unitDir, '/y/systemd/user');
});

let n = 0;
let home: string;
let unitDir: string;
let fake: ReturnType<typeof fakeSystemd>;
let services: AppServices;
const opts = (): ServiceOptions => ({
  off: null, unitDir, systemctl: fake.bin, journalctl: fake.journal, home, keysDir: (x) => join(home, 'keys', x), citadelUrl: () => 'http://127.0.0.1:8573',
  logDir: join(home, 'deploy-logs'), healthMs: 3000, installRetryMs: 150, minuteMs: 300, gitUrl: (repo) => `file://${join(root, 'remotes', repo)}.git`,
  systemdRun: fake.run, heavy: join(import.meta.dirname, '..', 'tools', 'citadel-heavy'),
});
const appFolder = (name: string, manifest: object = MANIFEST) => {
  mkdirSync(join(home, 'apps', name), { recursive: true });
  writeFileSync(join(home, 'apps', name, 'citadel-app.json'), JSON.stringify(manifest));
};
beforeEach(() => {
  home = join(root, `home${++n}`);
  unitDir = join(home, '.config', 'systemd', 'user');
  mkdirSync(unitDir, { recursive: true });
  fake = fakeSystemd(join(root, `systemd${n}`));
  services = new AppServices(opts());
});

test("disk use (#847): measured in the background with each manifest's warning line, the free disk read on demand", async () => {
  appFolder('big', { ...MANIFEST, disk_warn_gb: 0.5 });
  mkdirSync(join(home, '.local/share/big/sub'), { recursive: true });
  writeFileSync(join(home, '.local/share/big/sub/blob'), Buffer.alloc(300_000));
  appFolder('fresh');
  assert.equal(services.diskUse(row('big', 1)), null, 'nothing before the first measure');
  await services.measureDisk([row('big', 1), row('fresh', 2), row('gone', 3)]);
  const big = services.diskUse(row('big', 1))!;
  assert.ok(big.data_bytes! >= 300_000 && big.data_bytes! < 400_000, String(big.data_bytes));
  assert.equal(big.warn_gb, 0.5);
  assert.ok(Date.now() - Date.parse(big.measured_at) < 60_000);
  assert.deepEqual([services.diskUse(row('fresh', 2))!.data_bytes, services.diskUse(row('fresh', 2))!.warn_gb], [null, null], 'no DATA_DIR yet, no warning line');
  assert.equal(services.diskUse(row('gone', 3))!.warn_gb, null, 'no manifest: still measured');
  const free = await services.freeDisk();
  assert.ok(free.free_bytes > 0 && free.total_bytes >= free.free_bytes);
  assert.throws(() => parseManifest(JSON.stringify({ ...MANIFEST, disk_warn_gb: 0 })), /disk_warn_gb/);
  assert.throws(() => parseManifest(JSON.stringify({ ...MANIFEST, disk_warn_gb: '100' })), /disk_warn_gb/);
  assert.equal(parseManifest(JSON.stringify(MANIFEST)).disk_warn_gb, null);
});

test('install writes its units, reloads, enables and (re)starts them; start, stop and restart run its service', async () => {
  appFolder('mandate');
  const m = row('mandate', 7341);
  await assert.rejects(services.act(m, 'start'), /install it first/);
  const said = await services.install(m);
  assert.ok(said.some((s) => /Wrote citadel-app-mandate.service, citadel-app-mandate-backup.service, citadel-app-mandate-backup.timer/.test(s)), said.join(' '));
  assert.deepEqual(fake.calls().filter((c) => !c.includes(' show ')), [
    '--user daemon-reload',
    '--user enable citadel-app-mandate.service citadel-app-mandate-backup.timer',
    '--user restart citadel-app-mandate.service',
    '--user start citadel-app-mandate-backup.timer',
  ]);
  const s = await services.status(m);
  assert.equal(s.installed, true);
  assert.equal(s.service.active, 'active');
  assert.equal(s.service.enabled, 'enabled');
  assert.deepEqual(s.timers.map((t) => t.unit), ['citadel-app-mandate-backup.timer']);
  assert.equal(s.manifestError, null);
  assert.equal(s.health, '/health');
  assert.equal((await services.act(m, 'stop')).active, 'inactive');
  assert.equal((await services.act(m, 'restart')).active, 'active');
  assert.match(await services.logs(m, 5), /^journal --user -u citadel-app-mandate-backup.service -u citadel-app-mandate-backup.timer -u citadel-app-mandate.service -n 5 --no-pager/);
});

test("timerRuns reads each owned timer job's last run, and journalTail drops systemd's own lines", async () => {
  appFolder('mandate');
  const m = row('mandate', 7341);
  assert.deepEqual(await services.timerRuns([m]), [], 'nothing installed, nothing to read');
  await services.install(m);
  const [ok] = await services.timerRuns([m]);
  assert.deepEqual({ ...ok, app: ok.app.name }, { app: 'mandate', job: 'backup', unit: 'citadel-app-mandate-backup.service', active: 'inactive', result: 'success', status: '0', exitAt: null });
  writeFileSync(join(root, `systemd${n}`, 'citadel-app-mandate-backup.service.failed'), '');
  const [bad] = await services.timerRuns([m]);
  assert.equal(bad.active, 'failed');
  assert.equal(bad.result, 'exit-code');
  assert.equal(bad.status, '1');
  assert.equal(bad.exitAt, 1794380400_000);
  assert.ok(fake.calls().includes('--user show citadel-app-mandate-backup.service --timestamp=unix -p ActiveState -p Result -p ExecMainStatus -p ExecMainExitTimestamp'));
  assert.deepEqual(await services.journalTail('citadel-app-mandate-backup.service'), ['journal --user -u citadel-app-mandate-backup.service -n 30 --no-pager -o cat']);
});

test('install creates a missing DATA_DIR at 0700 and leaves an existing one exactly as it is', async () => {
  appFolder('fresh');
  const data = join(home, '.local/share/fresh');
  await services.install(row('fresh', 7342));
  assert.equal(statSync(data).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(data), []);

  appFolder('old');
  const old = join(home, '.local/share/old');
  mkdirSync(old, { recursive: true, mode: 0o755 });
  chmodSync(old, 0o755);
  writeFileSync(join(old, 'app.db'), 'data');
  await services.install(row('old', 7343));
  assert.equal(statSync(old).mode & 0o777, 0o755);
  assert.equal(readFileSync(join(old, 'app.db'), 'utf8'), 'data');
  assert.deepEqual(readdirSync(old), ['app.db']);

  // An install refused for another reason (here: no manifest) creates nothing; a boot check or preview never gets this far.
  await assert.rejects(services.install(row('none', 7344)), /citadel-app.json/);
  assert.equal(existsSync(join(home, '.local/share/none')), false);
  const off = new AppServices({ ...opts(), off: 'preview' });
  await assert.rejects(off.install(row('fresh2', 7345)), /preview/);
  assert.equal(existsSync(join(home, '.local/share/fresh2')), false);
});

test('a timer the manifest drops is removed; a unit Citadel didn\'t write is never rewritten or removed', async () => {
  appFolder('mandate');
  const m = row('mandate', 7341);
  await services.install(m);
  // Another contraption's unit, by name looks like one of mandate's jobs.
  const other = '# Written by Citadel for contraption mandate-old.\n[Service]\n';
  writeFileSync(join(unitDir, 'citadel-app-mandate-old.service'), other);
  appFolder('mandate', { ...MANIFEST, timers: {} });
  const said = await services.install(m);
  assert.ok(said.some((s) => /Removed citadel-app-mandate-backup.service, citadel-app-mandate-backup.timer/.test(s)), said.join(' '));
  assert.ok(!existsSync(join(unitDir, 'citadel-app-mandate-backup.timer')));
  assert.equal(readFileSync(join(unitDir, 'citadel-app-mandate-old.service'), 'utf8'), other);
  // A hand-written file under Citadel's name is left alone and stops the install, before it stops anything.
  const hand = '[Service]\nExecStart=/bin/true\nEnvironment=PORT=7341\n';
  writeFileSync(join(unitDir, 'citadel-app-mandate.service'), hand);
  writeFileSync(join(root, `systemd${n}`, 'citadel-app-mandate.service.active'), '');
  const calls = fake.calls().length;
  await assert.rejects(services.install(m, { replace: true }), /Citadel didn't write it/);
  assert.equal(readFileSync(join(unitDir, 'citadel-app-mandate.service'), 'utf8'), hand);
  assert.ok(!fake.calls().slice(calls).some((c) => /disable|stop/.test(c)), 'nothing stopped');
  assert.ok(fake.state('citadel-app-mandate.service.active'));
});

test('a second install of the same app while one runs is refused', async () => {
  appFolder('mandate');
  const m = row('mandate', 7341);
  const [a, b] = await Promise.allSettled([services.install(m), services.install(m)]);
  assert.equal(a.status, 'fulfilled');
  assert.match(String((b as PromiseRejectedResult).reason), /being installed or deployed already/);
});

test('start, stop and restart are refused while an install (or deploy) of the same app runs', async () => {
  appFolder('mandate');
  const m = row('mandate', 7341);
  await services.install(m);
  const calls = fake.calls().length;
  const [installed, stopped] = await Promise.allSettled([services.install(m), services.act(m, 'stop')]);
  assert.equal(installed.status, 'fulfilled');
  assert.match(String((stopped as PromiseRejectedResult).reason), /being installed or deployed already/);
  assert.ok(!fake.calls().slice(calls).some((c) => / stop /.test(c)), 'nothing stopped');
  assert.equal((await services.act(m, 'stop')).active, 'inactive', 'and once it is done, it goes');
});

test('a timer whose unit name is another contraption\'s is refused', async () => {
  appFolder('mandate');
  await assert.rejects(services.install(row('mandate', 7341), { all: [row('mandate-backup', 7400)] }), /share its unit name/);
  assert.ok(!existsSync(join(unitDir, 'citadel-app-mandate.service')));
});

test('a hand-installed unit is reported, and replaced (stopped and disabled, file kept) only when asked', async () => {
  appFolder('mandate');
  appFolder('peek-auras', { start: ['/usr/bin/node', 'server.ts'], workdir: 'companion' });
  const handMain = '# Mandate, by hand.\n[Service]\nWorkingDirectory=%h/apps/mandate\nExecStart=/usr/bin/node src/server.ts\nEnvironment=PORT=7341\n';
  writeFileSync(join(unitDir, 'mandate.service'), handMain);
  writeFileSync(join(unitDir, 'mandate-backup.service'), '[Service]\nType=oneshot\nWorkingDirectory=%h/apps/mandate\nExecStart=/usr/bin/node deploy/backup.ts\n');
  writeFileSync(join(unitDir, 'mandate-backup.timer'), '[Timer]\nOnCalendar=daily\n');
  // Peek's runs from a folder inside its app folder, and names its port.
  writeFileSync(join(unitDir, 'peek-auras.service'), '[Service]\nWorkingDirectory=%h/apps/peek-auras/companion\nExecStart=/usr/bin/node server.ts\nEnvironment=PORT=9142\n');
  // Neither: another folder that only starts the same, and a port in a comment.
  writeFileSync(join(unitDir, 'mandate2.service'), '# was PORT=7341\n[Service]\nWorkingDirectory=%h/apps/mandate2\n');
  for (const f of ['mandate.service.enabled', 'mandate.service.active', 'mandate-backup.timer.enabled']) writeFileSync(join(root, `systemd${n}`, f), '');

  const m = row('mandate', 7341);
  const hand = await services.handInstalled(m);
  assert.deepEqual(hand.map((u) => [u.unit, u.why]), [['mandate-backup.service', `runs from ${join(home, 'apps/mandate')}`], ['mandate-backup.timer', 'starts mandate-backup.service'], ['mandate.service', 'port 7341']]);
  assert.deepEqual((await services.handInstalled(row('peek-auras', 9142))).map((u) => u.unit), ['peek-auras.service']);
  assert.deepEqual((await services.status(m)).hand.map((u) => u.unit), ['mandate-backup.service', 'mandate-backup.timer', 'mandate.service']);

  await assert.rejects(services.install(m), /Hand-installed units run mandate already: mandate-backup.timer \(inactive, enabled; starts mandate-backup.service\); mandate.service \(active, enabled; port 7341\)/);
  assert.ok(!existsSync(join(unitDir, 'citadel-app-mandate.service')), 'nothing written');
  assert.ok(!fake.calls().some((c) => /disable|enable|start/.test(c)), 'nothing stopped');

  const said = await services.install(m, { replace: true });
  assert.match(said[0], /Stopped and disabled mandate-backup.timer, mandate.service/);
  assert.ok(fake.calls().includes('--user disable --now mandate-backup.timer mandate.service'));
  assert.ok(!fake.state('mandate.service.active') && !fake.state('mandate.service.enabled'));
  assert.equal(readFileSync(join(unitDir, 'mandate.service'), 'utf8'), handMain, 'its file stays');
  // Disabled now: reported still, but no longer in the way.
  assert.equal((await services.status(m)).hand.length, 3);
  await services.install(m);
});

test('a boot check or a preview never touches systemd', async () => {
  appFolder('mandate');
  const off = new AppServices({ ...opts(), off: 'A boot check or a preview never touches app services.' });
  const m = row('mandate', 7341);
  for (const p of [off.status(m), off.install(m, { replace: true }), off.act(m, 'restart'), off.logs(m)]) await assert.rejects(p, /boot check/);
  assert.deepEqual(fake.calls(), []);
  assert.ok(!existsSync(join(unitDir, 'citadel-app-mandate.service')));
});

test('without a manifest, status says so and install refuses', async () => {
  const m = row('mandate', 7341);
  assert.match((await services.status(m)).manifestError!, /No citadel-app.json/);
  await assert.rejects(services.install(m), /No citadel-app.json/);
});

// ---------- deploy (land 2) ----------

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();
/** A "GitHub" repo for owner/name: a bare repo under root/remotes, and a work tree to commit to it from. */
function remote(repo: string) {
  const bare = join(root, 'remotes', `${repo}.git`);
  const work = join(root, 'work', repo);
  mkdirSync(bare, { recursive: true });
  mkdirSync(work, { recursive: true });
  git(bare, 'init', '--bare', '--quiet');
  git(work, 'init', '--quiet');
  git(work, 'remote', 'add', 'origin', bare);
  return {
    /** Commit these files and push them; the new commit. */
    push(files: Record<string, string>, msg = 'change') {
      for (const [f, text] of Object.entries(files)) writeFileSync(join(work, f), text);
      git(work, 'add', '-A');
      git(work, 'commit', '--quiet', '-m', msg);
      git(work, 'push', '--quiet', 'origin', 'HEAD:main');
      return git(work, 'rev-parse', 'HEAD');
    },
  };
}
/** Something listening on a free port: the app's "service". */
async function listening(): Promise<Server & { port: number }> {
  const srv = createServer((s) => s.end());
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  return Object.assign(srv, { port: (srv.address() as any).port });
}
async function done(name: string) {
  for (;;) {
    const d = await services.lastDeploy(name);
    if (d && d.state !== 'running') return d;
    await new Promise((r) => setTimeout(r, 50));
  }
}
const appManifest = (build: string[], extra = {}) => JSON.stringify({ start: ['/usr/bin/node', 'server.ts'], build, ...extra });
let repoN = 0;

test('a first deploy clones, builds without Citadel\'s environment, installs and checks it is up', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  const head = r.push({ '.gitignore': 'out.txt\nenv.txt\n', 'citadel-app.json': appManifest(['echo built > out.txt', 'env > env.txt', 'echo to the log']) });
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    const started = services.deploy(c, 'Cara');
    assert.equal(started.state, 'running');
    assert.throws(() => services.deploy(c, 'Cara'), /being installed or deployed already/);
    const d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.equal(d.to, head);
    assert.equal(d.from, null);
    const folder = join(home, 'apps', name);
    assert.equal(git(folder, 'rev-parse', 'HEAD'), head);
    assert.equal(readFileSync(join(folder, 'out.txt'), 'utf8'), 'built\n');
    const env = readFileSync(join(folder, 'env.txt'), 'utf8');
    assert.match(env, new RegExp(`^PATH=${join(home, '.local/share/mise/shims')}:`, 'm'), 'mise\'s toolchains on PATH');
    for (const v of ['PORT', 'DATA_DIR', 'SESSION_SECRET', 'COORDINATOR_TOKEN', 'NODE_TEST_CONTEXT']) assert.doesNotMatch(env, new RegExp(`^${v}=`, 'm'), v);
    assert.match(d.tail, /to the log/);
    assert.ok(existsSync(join(unitDir, `citadel-app-${name}.service`)));
    assert.ok(fake.calls().includes(`--user restart citadel-app-${name}.service`));
    // Each step in its own unit, out of Citadel's cgroup, and in a heavy slot named for the app (#847).
    assert.equal(fake.calls().filter((x) => x.startsWith(`run --user --wait --collect --unit=citadel-build-${name}.service `)).length, 3);
    assert.equal(fake.calls().filter((x) => x.startsWith('run ') && x.includes('--slice=contraptions.slice ')).length, 3, 'each build step runs in contraptions.slice (#1238)');
    assert.equal(heavyHistory().split('\n').filter((l) => l.split('\t')[1] === `${name} deploy`).length, 1, `one hold for all three steps (#885): ${heavyHistory()}`);
    assert.match(env, /^CITADEL_HEAVY_HELD=1$/m, 'a step that calls citadel-heavy itself runs in the deploy\'s slot');
    assert.ok(!existsSync(join(home, 'deploy-logs', name, 'deploying.json')), 'its marker goes when it ends');
  } finally {
    svc.close();
  }
});

// #885: each step waited in line on its own, behind minions' suites, 15-20 min a step for seconds of work.
test("a deploy build holds one heavy slot for all its steps and goes ahead of minions' jobs waiting in line", async () => {
  const name = `app${++repoN}`;
  const order = join(root, `${name}-order`);
  const go = join(root, `${name}-go`);
  const r = remote(`cara/${name}`);
  r.push({ 'citadel-app.json': appManifest([`echo step1 >> '${order}'`, `sleep 0.3; echo step2 >> '${order}'`]) });
  writeFileSync(join(heavyDir, 'slots'), '1\n');
  const heavyJob = (who: string, script: string) => {
    // Not CITADEL_HEAVY_HELD: a suite run under citadel-heavy has it set, and a job with it runs at once, never in line.
    // CITADEL_HEAVY_HERE: the repo has a citadel-heavy workflow, so a plain job would go to its CI runners (#1160) and never take this folder's slot.
    const child = spawn(opts().heavy, ['sh', '-c', script], { env: { ...process.env, CITADEL_HEAVY_HELD: undefined, CITADEL_HEAVY_HERE: '1', CITADEL_HEAVY_WHO: who }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr!.on('data', (b) => (err += b));
    return { err: () => err, done: new Promise((ok) => child.on('close', ok)) };
  };
  const svc = await listening();
  const suite = heavyJob('suite', `touch '${order}-up'; i=0; while [ ! -e '${go}' ] && [ $i -lt 600 ]; do sleep 0.05; i=$((i + 1)); done`);
  try {
    await until('the slot held', () => existsSync(`${order}-up`));
    const minion = heavyJob('Peek #4', `echo minion >> '${order}'`);
    await until('a minion job at the head of the line', () => /are busy/.test(minion.err()));
    services.deploy({ ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow, 'Cara');
    // Only the finished wait-<pid>-<n>: citadel-heavy writes it as .tmp and moves it in place, and a .tmp seen
    // before its mv left the second look with nothing (CI, 2026-11-17).
    const deployWait = () => readdirSync(heavyDir).filter((f) => /^wait-[0-9-]+$/.test(f)).map((f) => join(heavyDir, f))
      .find((p) => { try { return readFileSync(p, 'utf8').startsWith(`${name} deploy\n`); } catch { return false; } });
    await until('the deploy waiting for the slot', () => !!deployWait());
    // A whole look at the slots with the deploy still in line: the waiting job touches its file at each one.
    const waitFile = deployWait()!;
    const seen = statSync(waitFile).mtimeMs;
    await until('the deploy to look at the slots again', () => statSync(waitFile).mtimeMs > seen, 15_000);
    writeFileSync(go, '');
    const d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    await minion.done;
    assert.equal(readFileSync(order, 'utf8'), 'step1\nstep2\nminion\n', 'the deploy went first and kept the slot between its steps');
  } finally {
    writeFileSync(go, '');
    await suite.done;
    rmSync(join(heavyDir, 'slots'), { force: true });
    svc.close();
  }
});

test('a failed build step says what killed it and quotes its last lines (#847)', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  r.push({ 'citadel-app.json': appManifest(['echo compiling; echo "out of memory, maybe" >&2; kill -KILL $$']) });
  const c = { ...row(name, 1), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
  services.deploy(c, 'Cara');
  const d = await done(name);
  assert.equal(d.state, 'failed');
  const failed = d.said.find((l) => l.startsWith('Failed: Build step failed'))!;
  assert.match(failed, /\(killed by SIGKILL\)/, d.said.join('\n'));
  assert.match(failed, /Its last lines:\n  compiling\n  out of memory, maybe/);
});

test('a deploy waits for a build an earlier deploy left running, so two never build at once (#847)', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  r.push({ 'citadel-app.json': appManifest(['true']) });
  const left = join(root, `systemd${n}`, `citadel-build-${name}.service.active`);
  writeFileSync(left, '');
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    services.deploy(c, 'Cara', [], undefined, { uid: 7 });
    await until('the deploy to say it waits', async () => (await services.lastDeploy(name))?.said.some((l) => /still running in citadel-build-/.test(l)));
    const mid = await services.lastDeploy(name);
    assert.equal(mid!.state, 'running');
    assert.ok(mid!.said.some((l) => /still running in citadel-build-.*waiting for it to end/.test(l)), mid!.said.join('\n'));
    assert.ok(!fake.calls().some((x) => x.startsWith('run ')), 'nothing built meanwhile');
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'deploy-logs', name, 'deploying.json'), 'utf8')), { by: 'Cara', uid: 7, resumed: false, log: mid!.log });
    rmSync(left);
    const d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.ok(d.said.includes('The earlier build ended: going on.'));
  } finally {
    svc.close();
  }
});

test('a deploy a restart cut short is found once, its log saying so; one started again says it (#847)', async () => {
  const dir = join(home, 'deploy-logs', 'cut');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'x.log');
  writeFileSync(log, '== Build: cargo build\n');
  writeFileSync(join(dir, 'deploying.json'), JSON.stringify({ by: 'auto-deploy', uid: 3, resumed: false, log }));
  mkdirSync(join(home, 'deploy-logs', 'other'), { recursive: true });
  assert.deepEqual(await services.interrupted(), [{ name: 'cut', by: 'auto-deploy', uid: 3, resumed: false }]);
  assert.match(readFileSync(log, 'utf8'), /== interrupted: Citadel stopped \(a restart or a crash\) while this deploy ran/);
  assert.deepEqual(await services.interrupted(), [], 'once');

  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  r.push({ 'citadel-app.json': appManifest([]) });
  const c = { ...row(name, 1), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
  services.deploy(c, 'auto-deploy', [], undefined, { resumed: true });
  const d = await done(name);
  assert.equal(d.said[0], 'Started again: a Citadel restart cut the last deploy short.');
});

/** The real folder the app's folder points at now, and its unit's WorkingDirectory. */
const liveSlot = (name: string) => realpathSync(join(home, 'apps', name));
const unitDirOf = (name: string) => realpathSync(/^WorkingDirectory=(.*)$/m.exec(readFileSync(join(unitDir, `citadel-app-${name}.service`), 'utf8'))![1]);

test('a deploy builds beside the running app: until its restart the app\'s folder still holds the old commit (#801)', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  const folder = join(home, 'apps', name);
  const seen = join(root, `seen-${name}`);
  r.push({ 'version.txt': 'old\n', 'citadel-app.json': appManifest([]) });
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    services.deploy(c, 'Cara');
    assert.equal((await done(name)).state, 'deployed');
    const first = liveSlot(name);
    assert.equal(unitDirOf(name), first, 'the unit runs from the real folder, not the link');
    // The new commit's build reads the folder the running app reads from.
    r.push({ 'version.txt': 'new\n', 'citadel-app.json': appManifest([`cat ${folder}/version.txt > ${seen}`]) });
    services.deploy(c, 'Cara');
    const d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.equal(readFileSync(seen, 'utf8'), 'old\n', 'the running app saw none of the new commit during the build');
    assert.equal(readFileSync(join(folder, 'version.txt'), 'utf8'), 'new\n', 'and its folder is the new commit once deployed');
    assert.notEqual(liveSlot(name), first);
    assert.equal(unitDirOf(name), liveSlot(name));
    assert.equal(readFileSync(join(first, 'version.txt'), 'utf8'), 'old\n', 'the old build is kept for a roll back');
  } finally {
    svc.close();
  }
});

test('deploys take turns between the two slots, and refuse local changes in the idle one, naming them (#801)', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  r.push({ 'citadel-app.json': appManifest([]) });
  const slots = join(home, 'apps', `.${name}`);
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    const live: string[] = [];
    for (let i = 0; i < 3; i++) {
      r.push({ [`f${i}.txt`]: 'x' });
      services.deploy(c, 'Cara');
      assert.equal((await done(name)).state, 'deployed');
      live.push(liveSlot(name));
    }
    assert.deepEqual(live, [join(slots, 'a'), join(slots, 'b'), join(slots, 'a')].map((p) => realpathSync(p)));
    writeFileSync(join(slots, 'b', 'stray.txt'), 'someone\'s work');
    const head = git(join(slots, 'b'), 'rev-parse', 'HEAD');
    r.push({ 'later.txt': 'x' });
    services.deploy(c, 'Cara');
    const d = await done(name);
    assert.equal(d.state, 'failed');
    assert.match(d.said.join('\n'), /has local changes, so nothing was built[\s\S]*stray\.txt/);
    assert.equal(git(join(slots, 'b'), 'rev-parse', 'HEAD'), head, 'the idle slot untouched');
    assert.equal(readFileSync(join(slots, 'b', 'stray.txt'), 'utf8'), 'someone\'s work');
    assert.equal(liveSlot(name), live[2]);
  } finally {
    svc.close();
  }
});

test('a deploy whose build fails changes nothing: the old build keeps running, never restarted (#801)', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  const good = r.push({ '.gitignore': 'out.txt\n', 'citadel-app.json': appManifest(['echo good > out.txt']) });
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    services.deploy(c, 'Cara');
    assert.equal((await done(name)).state, 'deployed');
    const unit = readFileSync(join(unitDir, `citadel-app-${name}.service`), 'utf8');
    const bad = r.push({ 'citadel-app.json': appManifest(['echo bad > out.txt', 'exit 3']) });
    services.deploy(c, '#12');
    const d = await done(name);
    assert.equal(d.state, 'failed', d.said.join('\n'));
    assert.deepEqual([d.from, d.to, d.by], [good, bad, '#12']);
    assert.ok(d.said.some((l) => /Build step failed \(exit 3\): exit 3/.test(l)));
    assert.ok(d.said.includes(`Nothing changed: ${good.slice(0, 9)} still runs.`), d.said.join('\n'));
    const folder = join(home, 'apps', name);
    assert.equal(git(folder, 'rev-parse', 'HEAD'), good);
    assert.equal(readFileSync(join(folder, 'out.txt'), 'utf8'), 'good\n');
    assert.equal(readFileSync(join(unitDir, `citadel-app-${name}.service`), 'utf8'), unit);
    assert.equal(fake.calls().filter((x) => x === `--user restart citadel-app-${name}.service`).length, 1, 'restarted on its first deploy only');
  } finally {
    svc.close();
  }
});

test('an unhealthy deploy rolls back by pointing at the old slot again, with no rebuild (#801)', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  const builds = join(root, `builds-${name}`);
  r.push({ 'citadel-app.json': appManifest([`echo built >> ${builds}`]) });
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    services.deploy(c, 'Cara');
    assert.equal((await done(name)).state, 'deployed');
    const old = liveSlot(name);
    r.push({ 'citadel-app.json': appManifest([`echo built >> ${builds}`], { health: '/nope' }) });
    services.deploy(c, 'Cara');
    const d = await done(name);
    assert.equal(d.state, 'rolled back', d.said.join('\n'));
    assert.equal(liveSlot(name), old);
    assert.equal(unitDirOf(name), old);
    assert.equal(readFileSync(builds, 'utf8'), 'built\nbuilt\n', 'the old commit wasn\'t built again');
  } finally {
    svc.close();
  }
});

test('a deploy moves an app\'s plain folder into its first slot, keeping its ignored files and leaving DATA_DIR alone (#801)', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  const first = r.push({ '.gitignore': 'node_modules/\n', 'citadel-app.json': appManifest([]) });
  const folder = join(home, 'apps', name);
  mkdirSync(join(home, 'apps'), { recursive: true });
  git(join(home, 'apps'), 'clone', '--quiet', `file://${join(root, 'remotes', 'cara', name)}.git`, name);
  mkdirSync(join(folder, 'node_modules'));
  writeFileSync(join(folder, 'node_modules', 'x'), 'cache');
  const data = join(home, '.local/share', name);
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'db'), 'state');
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    // On another branch it is refused before anything moves.
    services.deploy({ ...c, branch: 'release' }, 'Cara');
    assert.match((await done(name)).said.join('\n'), /is on main, not release/);
    assert.ok(!lstatSync(folder).isSymbolicLink());
    const next = r.push({ 'n.txt': 'x' });
    services.deploy(c, 'Cara');
    const d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.deepEqual([d.from, d.to], [first, next]);
    const slots = join(home, 'apps', `.${name}`);
    assert.ok(lstatSync(folder).isSymbolicLink());
    assert.equal(liveSlot(name), realpathSync(join(slots, 'b')));
    assert.equal(git(join(slots, 'a'), 'rev-parse', 'HEAD'), first, 'the old folder, as it was');
    assert.equal(readFileSync(join(slots, 'a', 'node_modules', 'x'), 'utf8'), 'cache', 'its ignored files stay with it');
    assert.equal(readFileSync(join(data, 'db'), 'utf8'), 'state');
  } finally {
    svc.close();
  }
});

test('a deploy picks up where one stopped before linking the folder: a failed first deploy, a move cut short, an empty slots folder (#801)', async () => {
  const svc = await listening();
  try {
    // A first deploy whose build fails leaves its clone in the first slot and no link; the next deploy carries on from it.
    const name = `app${++repoN}`;
    const r = remote(`cara/${name}`);
    r.push({ 'citadel-app.json': appManifest(['exit 3']) });
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    services.deploy(c, 'Cara');
    assert.equal((await done(name)).state, 'failed');
    const fixed = r.push({ 'citadel-app.json': appManifest([]) });
    services.deploy(c, 'Cara');
    let d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.equal(git(join(home, 'apps', name), 'rev-parse', 'HEAD'), fixed);

    // A move into the first slot cut short before its link (Citadel stopped between the two): linked again, then deployed.
    const moved = `app${++repoN}`;
    const m = remote(`cara/${moved}`);
    const first = m.push({ 'citadel-app.json': appManifest([]) });
    const slots = join(home, 'apps', `.${moved}`);
    mkdirSync(slots, { recursive: true });
    git(slots, 'clone', '--quiet', `file://${join(root, 'remotes', 'cara', moved)}.git`, 'a');
    const mc = { ...row(moved, svc.port), repo: `cara/${moved}`, branch: null, folder: null } as ContraptionRow;
    const next = m.push({ 'n.txt': 'x' });
    services.deploy(mc, 'Cara');
    d = await done(moved);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.deepEqual([d.from, d.to], [first, next]);
    assert.match(d.said.join('\n'), /Linked .* again: an earlier deploy stopped before linking it/);
    assert.equal(liveSlot(moved), realpathSync(join(slots, 'b')));

    // Stopped after making the slots folder, before moving into it: the plain folder still moves.
    const empty = `app${++repoN}`;
    const e = remote(`cara/${empty}`);
    e.push({ 'citadel-app.json': appManifest([]) });
    mkdirSync(join(home, 'apps', `.${empty}`));
    git(join(home, 'apps'), 'clone', '--quiet', `file://${join(root, 'remotes', 'cara', empty)}.git`, empty);
    services.deploy({ ...row(empty, svc.port), repo: `cara/${empty}`, branch: null, folder: null } as ContraptionRow, 'Cara');
    d = await done(empty);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.ok(lstatSync(join(home, 'apps', empty)).isSymbolicLink());
  } finally {
    svc.close();
  }
});

/** A stand-in for ContraptionTurns.drain: records when it ran and was released, against systemctl's restarts so far. */
function drainSpy(said: string | null, ms = 200) {
  const seen: string[] = [];
  const restarts = () => fake.calls().filter((x) => / (restart|stop) /.test(` ${x} `)).length;
  services.drain = async () => {
    seen.push(`drain at ${restarts()} restarts`);
    await new Promise((r) => setTimeout(r, ms));
    seen.push(`drained at ${restarts()} restarts`);
    return { said, release: () => seen.push(`released at ${restarts()} restarts`) };
  };
  return seen;
}

test('a deploy waits for its contraption\'s turns before restarting it, says so, and lets held turns go once it is healthy (#319)', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  r.push({ 'citadel-app.json': appManifest([]) });
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    const seen = drainSpy('Waited 0 s for 2 running turns to end.');
    services.deploy(c, 'Cara');
    const d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.deepEqual(seen, ['drain at 0 restarts', 'drained at 0 restarts', 'released at 1 restarts']);
    const at = (re: RegExp) => d.said.findIndex((l) => re.test(l));
    assert.ok(at(/^Waited 0 s for 2 running turns to end\.$/) >= 0, d.said.join('\n'));
    assert.ok(at(/^Waited/) < at(/^Enabled and \(re\)started/) && at(/^Enabled/) < at(/^Healthy/));
    // Released after the health check: the line saying it came first.
    assert.match(readFileSync(d.log, 'utf8'), /Healthy[^]*Deployed/);
  } finally {
    svc.close();
  }
});

test('a deploy that rolls back drains again before its second restart, and releases both holds (#319)', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  r.push({ 'citadel-app.json': appManifest([]) });
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    services.deploy(c, 'Cara');
    assert.equal((await done(name)).state, 'deployed');
    r.push({ 'citadel-app.json': appManifest([], { health: '/nope' }) });
    const seen = drainSpy(null, 10);
    services.deploy(c, 'Cara');
    const d = await done(name);
    assert.equal(d.state, 'rolled back', d.said.join('\n'));
    assert.deepEqual(seen.filter((x) => !x.startsWith('drained')), ['drain at 1 restarts', 'drain at 2 restarts', 'released at 3 restarts', 'released at 3 restarts']);
    assert.ok(!d.said.some((l) => /^Waited/.test(l)), 'nothing to say with no turns running');
  } finally {
    svc.close();
  }
});

test('stop and restart drain the contraption\'s turns first and say how long they waited; start doesn\'t (#319)', async () => {
  appFolder('mandate');
  const m = row('mandate', 7341);
  await services.install(m);
  const seen = drainSpy('Waited 1 s for 1 running turn to end.', 10);
  const restarted = await services.act(m, 'restart');
  assert.equal(restarted.waited, 'Waited 1 s for 1 running turn to end.');
  assert.deepEqual(seen, ['drain at 1 restarts', 'drained at 1 restarts', 'released at 2 restarts']);
  assert.equal((await services.act(m, 'stop')).active, 'inactive');
  assert.equal(seen.length, 6);
  assert.equal((await services.act(m, 'start')).waited, null);
  assert.equal(seen.length, 6, 'start cuts nothing, so it doesn\'t wait');
});

test('a deploy that doesn\'t come up healthy rolls back, and says so when the roll back doesn\'t either', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  r.push({ 'citadel-app.json': appManifest([], { health: '/health' }) });
  // The app keeps its port and stops answering its health path. Closing the port instead left it free for the
  // 6 s of health checks, and another test file's server that was handed it answered them (#758).
  let up = true;
  const svc = createHttpServer((_req, res) => res.writeHead(up ? 200 : 503).end());
  await new Promise<void>((ok) => svc.listen(0, '127.0.0.1', ok));
  // In a finally: a server left listening keeps the file, and the deploy lock, running forever (#377).
  try {
    const c = { ...row(name, (svc.address() as any).port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    services.deploy(c, 'Cara');
    const first = await done(name);
    assert.equal(first.state, 'deployed', first.said.join('\n'));
    up = false;
    r.push({ 'citadel-app.json': appManifest(['true'], { health: '/health' }) });
    services.deploy(c, 'Cara');
    const d = await done(name);
    assert.equal(d.state, 'failed', d.said.join('\n'));
    assert.ok(d.said.some((l) => /Not healthy after/.test(l)), d.said.join('\n'));
    assert.ok(d.said.some((l) => /Rolling back failed too: Not healthy/.test(l)), d.said.join('\n'));
  } finally {
    svc.close();
    svc.closeAllConnections();
  }
});

test("a deploy checks, as the person deploying, that the app installs as its own app, and warns when it wouldn't (#297)", async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  r.push({ 'citadel-app.json': appManifest([]) });
  const seen: (string | undefined)[] = [];
  // Its page links Citadel's manifest by a root-absolute path, the way one app could claim to be Citadel.
  const svc = createHttpServer((req, res) => {
    seen.push(req.headers['x-citadel-identity'] as string | undefined);
    res.end(req.url === `/apps/${name}/` ? '<link rel="manifest" href="/manifest.webmanifest">' : 'ok');
  });
  await new Promise<void>((ok) => svc.listen(0, '127.0.0.1', ok));
  try {
    const c = { ...row(name, (svc.address() as any).port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    services.deploy(c, 'Cara', [], () => 'v1.signed.header');
    const d = await done(name);
    assert.equal(d.state, 'deployed', 'a warning, never a failure');
    assert.ok(d.said.some((l) => /^To do: .*points outside/.test(l)), d.said.join('\n'));
    assert.ok(d.todo.some((l) => /points outside/.test(l)), 'a to-do, listed apart from the steps');
    assert.ok(seen.includes('v1.signed.header'));
    // Without an identity (no person to read its page as) it isn't checked.
    seen.length = 0;
    services.deploy(c, 'Cara');
    assert.ok(!(await done(name)).said.some((l) => /points outside/.test(l)));
    assert.ok(!seen.includes('v1.signed.header'));
  } finally {
    svc.close();
  }
});

test('an install check that cannot run is no to-do and no "no rail icon": it is retried, and only then said plainly', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  r.push({ 'citadel-app.json': appManifest([]) });
  const home = `/apps/${name}/`;
  let slow = true;
  const manifest = { id: home, start_url: home, scope: home, name: 'App', display: 'standalone', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] };
  const svc = createHttpServer((req, res) => {
    if (slow && req.url === home) return void res.writeHead(503).end('busy');
    if (req.url === home) return res.end('<link rel="manifest" href="manifest.webmanifest">');
    if (req.url === `${home}manifest.webmanifest`) return res.end(JSON.stringify(manifest));
    res.end('png');
  });
  await new Promise<void>((ok) => svc.listen(0, '127.0.0.1', ok));
  try {
    const c = { ...row(name, (svc.address() as any).port), icon: null, repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    const icons: string[] = [], todos: string[][] = [], notes: string[] = [];
    const hooks = { setIcon: (i: string) => (icons.push(i), true), todo: (t: string[]) => todos.push(t), unchecked: (l: string) => notes.push(l) };
    // Both tries fail: one plain line, no to-do, no rail icon complaint.
    services.deploy(c, 'Cara', [], () => 'v1.signed.header', hooks);
    const d = await done(name);
    assert.equal(d.state, 'deployed');
    assert.deepEqual([d.todo, todos], [[], []]);
    assert.ok(!d.said.some((l) => /^To do|rail icon/.test(l)), d.said.join('\n'));
    await until('the unchecked line', () => notes.length > 0, 5000);
    assert.deepEqual(notes, [`Couldn't check how ${name} installs: ${home} answered 503. Nothing to do unless it repeats.`]);
    // The retry gets through: the icon is filled from the manifest and nothing is said about lacking.
    notes.length = 0;
    slow = false;
    let calls = 0;
    const orig = svc.listeners('request')[0] as any;
    svc.removeAllListeners('request');
    svc.on('request', (q, s) => { if (q.url === home && calls++ === 0) return void s.writeHead(503).end('x'); orig(q, s); });
    services.deploy(c, 'Cara', [], () => 'v1.signed.header', hooks);
    await done(name);
    // The to-do hook is the last thing the retry does (after the icon and a log line), so wait for it, not the icon:
    // a poll between the two saw todos still empty under load.
    await until('the retry to finish', () => todos.length > 0, 5000);
    assert.deepEqual([icons, notes, todos], [['/icon-192.png'], [], [[]]]);
  } finally {
    svc.close();
  }
});

test('a deploy fills an empty rail icon from its manifest, and hands back what it still lacks as to-dos (#418)', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  r.push({ 'citadel-app.json': appManifest([]) });
  const home = `/apps/${name}/`;
  let manifest: object | null = null;
  const files: Record<string, string> = { [`${home}icon-192.png`]: 'png', [`${home}icon-512.png`]: 'png' };
  const svc = createHttpServer((req, res) => {
    if (req.url === home) return res.end(manifest ? '<link rel="manifest" href="manifest.webmanifest">' : '<title>shell</title>');
    if (req.url === `${home}manifest.webmanifest` && manifest) return res.end(JSON.stringify(manifest));
    if (req.url! in files) return res.end(files[req.url!]);
    res.statusCode = 404;
    res.end('no');
  });
  await new Promise<void>((ok) => svc.listen(0, '127.0.0.1', ok));
  try {
    const c = { ...row(name, (svc.address() as any).port), icon: null, repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    const icons: string[] = [];
    const todos: string[][] = [];
    const hooks = (took: boolean) => ({ setIcon: (icon: string) => (icons.push(icon), took), todo: (t: string[]) => todos.push(t) });
    // Its first shell: no manifest, no icon. It still deploys, with both as to-dos.
    services.deploy(c, 'Cara', [], () => 'v1.signed.header', hooks(true));
    let d = await done(name);
    assert.equal(d.state, 'deployed');
    assert.equal(d.todo.length, 2, d.todo.join('\n'));
    assert.match(d.todo[0], /no rail icon/);
    assert.match(d.todo[1], /no <link rel="manifest">/);
    assert.deepEqual(todos, [d.todo]);
    assert.deepEqual(icons, [], 'nothing to fill it from');
    // With an installable manifest, the empty icon is filled from it and nothing is left to do.
    manifest = { id: home, start_url: home, scope: home, name: 'App', display: 'standalone', icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }] };
    todos.length = 0;
    services.deploy(c, 'Cara', [], () => 'v1.signed.header', hooks(true));
    d = await done(name);
    assert.deepEqual([d.todo, todos, icons], [[], [[]], ['/icon-192.png']], 'checked and all done: an empty list');
    assert.ok(d.said.includes('Rail icon set to /icon-192.png, the first icon in its manifest.'), d.said.join('\n'));
    // Someone set one meanwhile (setIcon refuses): the row this deploy started from had none, so it says so.
    services.deploy(c, 'Cara', [], () => 'v1.signed.header', hooks(false));
    assert.match((await done(name)).todo.join('\n'), /no rail icon/);
    // A registered icon: nothing to fill, nothing to do.
    icons.length = 0;
    services.deploy({ ...c, icon: '/icon.svg' }, 'Cara', [], () => 'v1.signed.header', hooks(true));
    assert.deepEqual([(await done(name)).todo, icons], [[], []]);
  } finally {
    svc.close();
  }
});

test('a build past its time is stopped, and counts as failing', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  r.push({ 'citadel-app.json': appManifest(['sleep 30'], { build_timeout: 1 }) });
  const c = { ...row(name, 1), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
  const t = Date.now();
  services.deploy(c, 'Cara');
  const d = await done(name);
  assert.ok(Date.now() - t < 10_000, 'not the whole sleep');
  assert.equal(d.state, 'failed');
  assert.ok(d.said.some((l) => /ran past its 1 minutes at: sleep 30/.test(l)), d.said.join('\n'));
  assert.ok(d.said.some((l) => /Nothing to roll back to/.test(l)));
});

test('a deploy refuses a folder with local changes, another origin, a missing branch or no repo, and changes nothing', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  const first = r.push({ 'citadel-app.json': appManifest([]) });
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    assert.throws(() => services.deploy({ ...c, repo: null }, 'Cara'), /has no repo set/);
    services.deploy(c, 'Cara');
    assert.equal((await done(name)).state, 'deployed');
    const folder = join(home, 'apps', name);
    r.push({ 'later.txt': 'x' });
    writeFileSync(join(folder, 'mine.txt'), 'local work');
    services.deploy(c, 'Cara');
    let d = await done(name);
    assert.equal(d.state, 'failed');
    assert.match(d.said.join('\n'), /has local changes, so nothing was fetched[\s\S]*mine\.txt/);
    assert.equal(git(folder, 'rev-parse', 'HEAD'), first);
    rmSync(join(folder, 'mine.txt'));

    // The slots aren't on a branch: the registered one is fetched (a plain folder's own branch is checked when it moves, below).
    services.deploy({ ...c, branch: 'release' }, 'Cara');
    assert.match((await done(name)).said.join('\n'), /Fetching cara\/.* failed/);
    services.deploy({ ...c, repo: 'cara/other' }, 'Cara');
    assert.match((await done(name)).said.join('\n'), /origin is .*, not cara\/other: refusing/);
    // A commit of its own on the folder's branch: it can only fast-forward.
    git(folder, 'commit', '--quiet', '--allow-empty', '-m', 'local');
    const local = git(folder, 'rev-parse', 'HEAD');
    services.deploy(c, 'Cara');
    d = await done(name);
    assert.match(d.said.join('\n'), /has commits cara\/.*'s main doesn't: a deploy only goes forward, so nothing changed\./);
    assert.equal(git(folder, 'rev-parse', 'HEAD'), local);
  } finally {
    svc.close();
  }
});

// #1016: Roll back to last green deploys an older commit of the branch through the same two slots and health check,
// and refuses one off the branch, or past a change to a path its manifest lists under migrations.
test('a roll back deploys an older commit of its branch, but not one off it or past its migrations', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    const first = r.push({ 'citadel-app.json': appManifest([], { migrations: ['db/'] }) });
    services.deploy(c, 'Cara', [], undefined, { to: first });
    assert.match((await done(name)).said.join('\n'), /has never been deployed, so there is nothing to roll back/);
    services.deploy(c, 'Cara');
    assert.equal((await done(name)).state, 'deployed');
    const green = r.push({ 'app.txt': 'green' });
    services.deploy(c, 'Cara');
    await done(name);
    r.push({ 'app.txt': 'broken' });
    services.deploy(c, 'Cara');
    await done(name);

    services.deploy(c, 'Cara', [], undefined, { to: green });
    const d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.equal(d.to, green);
    assert.equal(readFileSync(join(liveSlot(name), 'app.txt'), 'utf8'), 'green');

    // A commit its branch doesn't hold.
    const work = join(root, 'work', `cara/${name}`);
    git(work, 'commit', '--quiet', '--allow-empty', '-m', 'off the branch');
    git(work, 'push', '--quiet', 'origin', 'HEAD:side');
    services.deploy(c, 'Cara', [], undefined, { to: git(work, 'rev-parse', 'HEAD') });
    assert.match((await done(name)).said.join('\n'), /isn't on cara\/.*'s main, so nothing changed/);

    // Its data's shape moved on after first: refused, and green still runs. That deploy snapshotted its data (#1137),
    // which would let the roll back go; with no snapshot to bring back (a person cleared them), it's refused.
    mkdirSync(join(work, 'db'), { recursive: true });
    git(work, 'reset', '--quiet', '--hard', 'HEAD~1');
    r.push({ 'db/0002.sql': 'alter' });
    services.deploy(c, 'Cara');
    assert.match((await done(name)).said.join('\n'), /Snapshotted its data/);
    rmSync(join(home, '.local/share', `.${name}.snapshots`), { recursive: true, force: true });
    services.deploy(c, 'Cara', [], undefined, { to: first });
    const refused = await done(name);
    assert.equal(refused.state, 'failed');
    assert.match(refused.said.join('\n'), /Its migrations changed since .* \(db\/0002\.sql\), and no snapshot of its data matches that code, so going back could leave its data/);
    assert.notEqual(git(liveSlot(name), 'rev-parse', 'HEAD'), first);
  } finally {
    svc.close();
  }
});

test('an app in a folder of its repo (#1136) reads its manifest, builds and runs there, and counts only its own migrations', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  const work = join(root, 'work', `cara/${name}`);
  mkdirSync(join(work, 'apps/notes/migrations'), { recursive: true });
  mkdirSync(join(work, 'migrations'), { recursive: true });
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null, subdir: 'apps/notes' } as ContraptionRow;
    r.push({
      'README.md': 'the scheme\'s own repo', '.gitignore': 'out.txt\n',
      'apps/notes/citadel-app.json': appManifest(['pwd > out.txt'], { migrations: ['migrations'] }), 'apps/notes/migrations/0001.sql': 'a',
    });
    services.deploy(c, 'Cara');
    const d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.equal(realpathSync(readFileSync(join(liveSlot(name), 'apps/notes/out.txt'), 'utf8').trim()), join(liveSlot(name), 'apps/notes'), 'the build ran in its folder');
    assert.equal(unitDirOf(name), join(liveSlot(name), 'apps/notes'), 'its service runs there');
    assert.equal((await services.status(c)).manifestError, null);

    // The repo's own migrations folder isn't the app's: no snapshot.
    r.push({ 'migrations/0001.sql': 'the scheme\'s, not the app\'s' });
    services.deploy(c, 'Cara');
    assert.doesNotMatch((await done(name)).said.join('\n'), /Snapshotted its data/);
    r.push({ 'apps/notes/migrations/0002.sql': 'b' });
    services.deploy(c, 'Cara');
    assert.match((await done(name)).said.join('\n'), /Snapshotted its data/);
  } finally {
    svc.close();
  }
});

// #1137: a fixture app whose migration runs when it starts, as a real one's does. A stand-in systemctl runs the live
// slot's migrate.sh against its DATA_DIR on start, and its /health fails while its data holds "GARBLED".
async function migratingApp() {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  const data = join(home, '.local/share', name);
  const wrapper = join(root, `systemctl-${name}`);
  writeFileSync(wrapper, `#!/bin/sh
"${fake.bin}" "$@" || exit $?
case "$2" in start|restart) [ "$3" = "citadel-app-${name}.service" ] || exit 0
  wd=$(sed -n 's/^WorkingDirectory=//p' "${unitDir}/$3")
  [ -f "$wd/migrate.sh" ] && cd "${data}" && sh "$wd/migrate.sh";; esac
exit 0
`);
  chmodSync(wrapper, 0o755);
  services = new AppServices({ ...opts(), systemctl: wrapper });
  const svc = createHttpServer((req, res) => {
    const db = existsSync(join(data, 'db.txt')) ? readFileSync(join(data, 'db.txt'), 'utf8') : '';
    res.writeHead(req.url === '/health' && !db.includes('GARBLED') ? 200 : 500).end();
  });
  await new Promise<void>((ok) => svc.listen(0, '127.0.0.1', ok));
  const c = { ...row(name, (svc.address() as any).port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
  const manifest = appManifest([], { health: '/health', migrations: ['migrate.sh'] });
  const db = () => readFileSync(join(data, 'db.txt'), 'utf8');
  const snaps = join(home, '.local/share', `.${name}.snapshots`);
  const snapshots = () => (existsSync(snaps) ? readdirSync(snaps).sort() : []);
  return { name, r, c, svc, data, db, manifest, snapshots };
}

test('a deploy whose migration breaks its data rolls back to the old code and the old data in one step (#1137)', async () => {
  const { name, r, c, svc, data, db, manifest, snapshots } = await migratingApp();
  try {
    const v1 = r.push({ 'citadel-app.json': manifest, 'migrate.sh': '[ -f db.txt ] || echo "v1: alice" > db.txt\n' });
    services.deploy(c, 'Cara');
    assert.equal((await done(name)).state, 'deployed');
    writeFileSync(join(data, 'db.txt'), 'v1: alice, bob\n'); // what its people wrote since
    assert.deepEqual(snapshots(), [], 'a first deploy takes none');

    // A change outside its migrations: no snapshot.
    r.push({ 'app.txt': 'copy change' });
    services.deploy(c, 'Cara');
    let d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.doesNotMatch(d.said.join('\n'), /[Ss]napshot/);
    assert.deepEqual(snapshots(), []);

    // v2's migration garbles the data, and v2 fails its health check.
    r.push({ 'migrate.sh': 'echo GARBLED > db.txt\n' });
    services.deploy(c, 'Cara');
    d = await done(name);
    const said = d.said.join('\n');
    assert.equal(d.state, 'rolled back', said);
    assert.match(said, /Snapshotted its data \(.*\) as .*\.snapshots/);
    assert.match(said, /Restored its data from the snapshot taken .* at /);
    assert.equal(git(liveSlot(name), 'rev-parse', 'HEAD').length, 40);
    assert.match(readFileSync(join(liveSlot(name), 'migrate.sh'), 'utf8'), /v1: alice/, 'the old code runs');
    assert.equal(db(), 'v1: alice, bob\n', 'and the old data, what its people wrote included');
    // Nothing deleted: the snapshot, and the garbled data kept beside it.
    const kept = snapshots();
    assert.equal(kept.length, 2, kept.join(' '));
    assert.ok(kept.some((s) => readFileSync(join(home, '.local/share', `.${name}.snapshots`, s, 'data', 'db.txt'), 'utf8') === 'GARBLED\n'));
    assert.notEqual(v1, d.to);
  } finally {
    svc.close();
  }
});

test('a roll back past a migration brings back the snapshot its code reads, and keeps the newer data; with none it is refused (#1137)', async () => {
  const { name, r, c, svc, data, db, manifest, snapshots } = await migratingApp();
  try {
    const v1 = r.push({ 'citadel-app.json': manifest, 'migrate.sh': '[ -f db.txt ] || echo "v1: alice" > db.txt\n' });
    services.deploy(c, 'Cara');
    await done(name);
    // v2's migration loses a row but stays healthy: only a person notices.
    const v2 = r.push({ 'migrate.sh': 'grep -q v2 db.txt || echo "v2:" > db.txt\n' });
    services.deploy(c, 'Cara');
    let d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.match(d.said.join('\n'), /Deployed .*; its data was snapshotted first/);
    assert.equal(db(), 'v2:\n');
    writeFileSync(join(data, 'db.txt'), 'v2: carol\n');

    // A bad snapshot (a person edited it): v1 fails its health check on it, and that roll back's own roll back puts v2's
    // code and data back. The data v1 failed on is kept, marked failed, so the next roll back passes it by.
    const snapDir = join(home, '.local/share', `.${name}.snapshots`);
    const [first] = snapshots();
    writeFileSync(join(snapDir, first, 'data', 'db.txt'), 'GARBLED\n');
    services.deploy(c, 'Cara', [], undefined, { to: v1 });
    d = await done(name);
    assert.equal(d.state, 'rolled back', d.said.join('\n'));
    assert.equal(git(liveSlot(name), 'rev-parse', 'HEAD'), v2);
    assert.equal(db(), 'v2: carol\n', "v2's data is back with its code");
    assert.ok(snapshots().some((s) => JSON.parse(readFileSync(join(snapDir, s, 'snapshot.json'), 'utf8')).failed === true));
    writeFileSync(join(snapDir, first, 'data', 'db.txt'), 'v1: alice\n');

    services.deploy(c, 'Cara', [], undefined, { to: v1 });
    d = await done(name);
    const said = d.said.join('\n');
    assert.equal(d.state, 'deployed', said);
    assert.equal(d.to, v1);
    assert.match(said, /Its migrations changed since .* \(migrate\.sh\): its data goes back too/);
    assert.match(said, /Kept the data it had/);
    assert.equal(db(), 'v1: alice\n');
    const kept = snapshots().map((s) => readFileSync(join(home, '.local/share', `.${name}.snapshots`, s, 'data', 'db.txt'), 'utf8'));
    assert.ok(kept.includes('v2: carol\n'), 'what v2 wrote is kept, not deleted');

    // Its snapshots gone (a person cleared them): the old refusal stands, and nothing changed.
    const v3 = r.push({ 'migrate.sh': 'echo "v3:" > db.txt\n' });
    services.deploy(c, 'Cara');
    await done(name);
    rmSync(join(home, '.local/share', `.${name}.snapshots`), { recursive: true, force: true });
    services.deploy(c, 'Cara', [], undefined, { to: v1 });
    d = await done(name);
    assert.equal(d.state, 'failed');
    assert.match(d.said.join('\n'), /no snapshot of its data matches that code/);
    assert.equal(git(liveSlot(name), 'rev-parse', 'HEAD'), v3);
  } finally {
    svc.close();
  }
});

test('snapshots keep the newest few within a size cap, never the ones a step just took or restored (#1137)', async () => {
  const { takeSnapshot, prune, listSnapshots } = await import('../src/app-snapshots.ts');
  const data = join(home, 'data');
  const snaps = join(home, 'snaps');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'f'), Buffer.alloc(1000));
  const cap = { keep: 2, maxBytes: 2500 };
  for (let i = 1; i <= 3; i++) await takeSnapshot(data, snaps, { commit: `c${i}`.padEnd(40, '0'), why: 'test' }, cap, i * 1000);
  assert.deepEqual((await listSnapshots(snaps)).map((s) => s.commit.slice(0, 2)), ['c3', 'c2'], 'the oldest past the count goes');
  writeFileSync(join(data, 'f'), Buffer.alloc(2000));
  const { said } = await takeSnapshot(data, snaps, { commit: 'c4'.padEnd(40, '0'), why: 'test' }, cap, 4000);
  assert.deepEqual((await listSnapshots(snaps)).map((s) => s.commit.slice(0, 2)), ['c4'], 'past the size cap too (2000 + 1000 > 2500), but the new one stays');
  assert.match(said.join('\n'), /Removed 2 older snapshots past the cap .*c3.*c20+\. Kept: .*c4/);
  assert.deepEqual(await prune(snaps, []), [], 'under the default cap nothing goes');
  const big = await takeSnapshot(data, snaps, { commit: 'c5'.padEnd(40, '0'), why: 'test' }, { keep: 2, maxBytes: 100 }, 5000);
  assert.equal(big.snap, null);
  assert.match(big.said[0], /over the .* cap/);
  writeFileSync(join(snaps, 'stray.part'), 'x');
  assert.equal((await listSnapshots(snaps)).length, 1, 'a .part is no snapshot');

  // Past the cap, an older snapshot of a commit that has a newer one goes before an older commit's only one: a roll back
  // only ever picks the newest of a commit, so repeated tries of one deploy can't push out the snapshot an older commit needs.
  const dup = join(home, 'snaps-dup');
  const wide = { keep: 3, maxBytes: 1e9 };
  for (const [c, t] of [['d1', 1000], ['d2', 2000], ['d2', 3000]] as const) await takeSnapshot(data, dup, { commit: c.padEnd(40, '0'), why: 'test' }, wide, t);
  await takeSnapshot(data, dup, { commit: 'd3'.padEnd(40, '0'), why: 'test' }, wide, 4000);
  assert.deepEqual((await listSnapshots(dup)).map((s) => `${s.commit.slice(0, 2)}@${s.taken_at}`), ['d3@4000', 'd2@3000', 'd1@1000']);
});

// #915: a member's private repo is out of the box's login's reach; only their own GitHub link gets in.
test("a deploy clones and fetches with its home scheme owner's GitHub link, which never reaches the build, .git/config or the log", async () => {
  const name = `app${++repoN}`;
  const r = remote(`alex/${name}`);
  r.push({ '.gitignore': 'env.txt\n', 'citadel-app.json': appManifest(['env > env.txt']) });
  const token = `ghu_${'T'.repeat(36)}`;
  // The "GitHub" URL leads nowhere; only the owner's env (standing in for their token) is let through to the repo.
  const hidden = `file://${join(root, 'private')}/`;
  services = new AppServices({ ...opts(), gitUrl: (repo) => `${hidden}${repo}.git` });
  const c = { ...row(name, 1), repo: `alex/${name}`, branch: null, folder: null, home_scheme: 9 } as ContraptionRow;
  const asked: (number | null)[] = [];
  const owner = { GH_TOKEN: token, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${join(root, 'remotes')}/.insteadOf`, GIT_CONFIG_VALUE_0: hidden };
  services.githubAs = (x) => (asked.push(x.home_scheme), owner);
  const svc = await listening();
  try {
    services.deploy({ ...c, port: svc.port }, 'Alex');
    let d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    r.push({ 'later.txt': 'x' });
    services.deploy({ ...c, port: svc.port }, 'Alex');
    d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.equal(d.to, git(join(root, 'work', `alex/${name}`), 'rev-parse', 'HEAD'), 'the fetch went through too');
    assert.deepEqual(asked, [9, 9], 'asked for the home scheme owner\'s link on each deploy');
    const slots = join(home, 'apps', `.${name}`);
    const env = readFileSync(join(liveSlot(name), 'env.txt'), 'utf8');
    assert.doesNotMatch(env, /GH_TOKEN|GIT_CONFIG_/, 'the build never sees the owner\'s login');
    for (const slot of ['a', 'b']) assert.ok(!git(join(slots, slot), 'config', '--list', '--show-origin').includes(token), `${slot}'s git config`);
    assert.ok(!readFileSync(join(slots, 'a', '.git', 'config'), 'utf8').includes(token));
    for (const f of readdirSync(join(home, 'deploy-logs', name))) assert.ok(!readFileSync(join(home, 'deploy-logs', name, f), 'utf8').includes(token), f);

    // Without the owner's link it's the box's login, which can't see the repo: "Repository not found".
    services.githubAs = () => undefined;
    r.push({ 'more.txt': 'x' });
    services.deploy({ ...c, port: svc.port }, 'Alex');
    assert.match((await done(name)).said.join('\n'), /Fetching alex\/.* failed/);
  } finally {
    svc.close();
  }
});

test("a deploy whose owner's link can't reach the repo tries again with the box's login, and says so (#915)", async () => {
  const name = `app${++repoN}`;
  remote(`cara/${name}`).push({ 'citadel-app.json': appManifest([]) });
  // A limited link where the App isn't installed: GitHub answers "not found".
  services.githubAs = () => ({ GH_TOKEN: `ghu_${'U'.repeat(36)}`, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${join(root, 'nowhere')}/.insteadOf`, GIT_CONFIG_VALUE_0: `file://${join(root, 'remotes')}/` });
  const svc = await listening();
  try {
    services.deploy({ ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow, 'Cara');
    const d = await done(name);
    assert.equal(d.state, 'deployed', d.said.join('\n'));
    assert.match(d.said.join('\n'), /home scheme owner's GitHub link couldn't reach cara\/app\d+: trying Citadel's own login/);
  } finally {
    svc.close();
  }
});

test('a deploy won\'t run over a hand-installed unit until an admin replaces it', async () => {
  const name = `app${++repoN}`;
  remote(`cara/${name}`).push({ 'citadel-app.json': appManifest([]) });
  writeFileSync(join(unitDir, `${name}.service`), `[Service]\nWorkingDirectory=%h/apps/${name}\n`);
  writeFileSync(join(root, `systemd${n}`, `${name}.service.enabled`), '');
  services.deploy({ ...row(name, 1), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow, 'Cara');
  const d = await done(name);
  assert.equal(d.state, 'failed');
  assert.match(d.said.join('\n'), new RegExp(`Hand-installed units run ${name}: ${name}.service. An admin installs it once with replace`));
  assert.ok(!existsSync(join(home, 'apps', name)), 'nothing cloned');
});

test("a folder app (#1136): a ship that changes nothing in its folder holds its deploy, and it deploys only once its manifest is on main", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'folder-app-'));
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'README.md'), 'x');
    git('add', '-A');
    git('commit', '-qm', 'start');
    assert.equal(manifestOn(dir, 'apps/notes'), false, 'registered before its folder ships: not deployed yet');
    mkdirSync(join(dir, 'apps', 'notes'), { recursive: true });
    writeFileSync(join(dir, 'apps', 'notes', 'citadel-app.json'), '{}');
    git('add', '-A');
    git('commit', '-qm', 'the app');
    assert.equal(manifestOn(dir, 'apps/notes'), true);
    const deployed = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'README.md'), 'y');
    git('commit', '-qam', 'outside the folder');
    assert.equal(await folderHolds(dir, 'apps/notes', git('rev-parse', 'HEAD'), deployed), true);
    writeFileSync(join(dir, 'apps', 'notes', 'server.ts'), '');
    git('add', '-A');
    git('commit', '-qm', 'inside the folder');
    assert.equal(await folderHolds(dir, 'apps/notes', git('rev-parse', 'HEAD'), deployed), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
