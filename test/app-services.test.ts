import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.match(main, /^Restart=on-failure$/m);
  assert.match(main, /^RestartSec=5$/m);
  assert.match(main, /^WantedBy=default.target$/m);
  const job = files.get('citadel-app-mandate-backup.service')!;
  assert.match(job, /^Type=oneshot$/m);
  assert.match(job, /^ExecStart=\/usr\/bin\/node "deploy\/backup.ts" "\$\{DATA_DIR\}"$/m, '${VAR} left for systemd to expand');
  assert.ok(job.includes('Environment="PORT=7341"'), 'jobs get the app\'s environment');
  assert.match(files.get('citadel-app-mandate-backup.timer')!, /^OnCalendar=\*-\*-\* 03:30:00$/m);
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
const opts = (): ServiceOptions => ({ off: null, unitDir, systemctl: fake.bin, journalctl: fake.journal, home, keysDir: (x) => join(home, 'keys', x), citadelUrl: () => 'http://127.0.0.1:8573' });
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
  // A hand-written file under Citadel's name is left alone and stops the install.
  writeFileSync(join(unitDir, 'citadel-app-mandate.service'), '[Service]\nExecStart=/bin/true\n');
  await assert.rejects(services.install(m), /Citadel didn't write it/);
  assert.equal(readFileSync(join(unitDir, 'citadel-app-mandate.service'), 'utf8'), '[Service]\nExecStart=/bin/true\n');
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
