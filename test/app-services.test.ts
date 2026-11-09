import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { after, beforeEach, test } from 'node:test';
import { AppServices, parseManifest, serviceOptions, unitFiles, type ServiceOptions } from '../src/app-services.ts';
import type { ContraptionRow } from '../src/db.ts';
import { fakeSystemd } from './helpers.ts';

// Citadel writes and runs contraptions' user services (#266). Everything here runs against a stand-in
// systemctl and a temp unit folder: never the real ones.
const root = mkdtempSync(join(tmpdir(), 'app-services-'));
after(() => rmSync(root, { recursive: true, force: true }));

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
  assert.match(main, /^Restart=always$/m);
  assert.match(main, /^RestartSec=5$/m);
  assert.match(main, /^WantedBy=default.target$/m);
  const job = files.get('citadel-app-mandate-backup.service')!;
  assert.match(job, /^Type=oneshot$/m);
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
  logDir: join(home, 'deploy-logs'), healthMs: 3000, minuteMs: 300, gitUrl: (repo) => `file://${join(root, 'remotes', repo)}.git`,
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
  } finally {
    svc.close();
  }
});

test('a deploy whose build fails rolls back to the commit before, builds it and restarts it', async () => {
  const name = `app${++repoN}`;
  const r = remote(`cara/${name}`);
  const good = r.push({ '.gitignore': 'out.txt\n', 'citadel-app.json': appManifest(['echo good > out.txt']) });
  const svc = await listening();
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    services.deploy(c, 'Cara');
    assert.equal((await done(name)).state, 'deployed');
    const bad = r.push({ 'citadel-app.json': appManifest(['echo bad > out.txt', 'exit 3']) });
    services.deploy(c, '#12');
    const d = await done(name);
    assert.equal(d.state, 'rolled back', d.said.join('\n'));
    assert.deepEqual([d.from, d.to, d.by], [good, bad, '#12']);
    assert.ok(d.said.some((l) => /Build step failed \(exit 3\): exit 3/.test(l)));
    const folder = join(home, 'apps', name);
    assert.equal(git(folder, 'rev-parse', 'HEAD'), good);
    assert.equal(readFileSync(join(folder, 'out.txt'), 'utf8'), 'good\n', 'the good commit built again');
    assert.equal(fake.calls().filter((x) => x === `--user restart citadel-app-${name}.service`).length, 2, 'restarted on its first deploy and on the roll back');
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
  r.push({ 'citadel-app.json': appManifest([]) });
  const svc = await listening();
  // In a finally: a server left listening keeps the file, and the deploy lock, running forever (#377).
  try {
    const c = { ...row(name, svc.port), repo: `cara/${name}`, branch: null, folder: null } as ContraptionRow;
    services.deploy(c, 'Cara');
    const first = await done(name);
    assert.equal(first.state, 'deployed', first.said.join('\n'));
    svc.close();
    r.push({ 'citadel-app.json': appManifest(['true']) });
    services.deploy(c, 'Cara');
    const d = await done(name);
    assert.equal(d.state, 'failed', d.said.join('\n'));
    assert.ok(d.said.some((l) => /Not healthy after/.test(l)), d.said.join('\n'));
    assert.ok(d.said.some((l) => /Rolling back failed too: Not healthy/.test(l)), d.said.join('\n'));
  } finally {
    svc.close();
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

test('a deploy refuses a folder with local changes, another origin or branch, or no repo, and changes nothing', async () => {
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

    services.deploy({ ...c, branch: 'release' }, 'Cara');
    assert.match((await done(name)).said.join('\n'), /is on main, not release/);
    services.deploy({ ...c, repo: 'cara/other' }, 'Cara');
    assert.match((await done(name)).said.join('\n'), /origin is .*, not cara\/other: refusing/);
    // A commit of its own on the folder's branch: it can only fast-forward.
    git(folder, 'commit', '--quiet', '--allow-empty', '-m', 'local');
    const local = git(folder, 'rev-parse', 'HEAD');
    services.deploy(c, 'Cara');
    d = await done(name);
    assert.match(d.said.join('\n'), /has commits cara\/.* doesn't, or git refused: it can only fast-forward, so nothing changed\. git merge/);
    assert.equal(git(folder, 'rev-parse', 'HEAD'), local);
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
