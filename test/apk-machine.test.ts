import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ApkBuilds, type Runner } from '../src/apk-build.ts';
import { ApkMachine, type ApkMachineDeps } from '../src/apk-machine.ts';
import type { ContraptionRow, MachineJob } from '../src/db.ts';
import { capacitorExtras } from '../tools/heavy-builds.ts';
import { git } from './git.ts';

// src/apk-machine.ts (H3): a release APK's Gradle step on a fake machine. A real git checkout and real tar; the fake
// machine reads the snapshot it was sent, "builds" the APK and puts back.tar where the agent would upload it.
const root = mkdtempSync(join(tmpdir(), 'apk-machine-'));
after(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, 'home');
mkdirSync(join(home, '.local/share/android-sdk/build-tools/36.1.0'), { recursive: true });
mkdirSync(join(home, '.local/share/mise/installs/java/temurin-21'), { recursive: true });
const keyDir = join(root, 'keys');
mkdirSync(keyDir);

const put = (dir: string, files: Record<string, string>) => {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
};

/** A Capacitor app whose live slot has its packages, as a deploy leaves it. */
function app(name: string) {
  const live = join(root, 'apps', name);
  mkdirSync(live, { recursive: true });
  git(join(root, 'apps'), 'init', '-q', '-b', 'main', name);
  put(live, {
    // As Capacitor's own templates write it: no trailing slash, so a linked node_modules is ignored too.
    '.gitignore': 'node_modules\n',
    'android/.gitignore': '.*\n!.gitignore\nbuild/\nlocal.properties\n*.jks\n*.pk8\nkey.properties\nkeystore.properties\n/app/src/main/assets/public\n',
    'capacitor.config.json': JSON.stringify({ appId: 'x', webDir: 'shell' }),
    'shell/index.html': 'shell',
    'android/gradlew': '#!/bin/sh\n',
    'android/app/build.gradle': 'android { defaultConfig { versionName "1.0" } }',
    'android/app/debug.keystore': 'PUBLIC-DEBUG-KEY',
    'android/capacitor.settings.gradle': "project(':capacitor-android').projectDir = new File('../node_modules/@capacitor/android/capacitor')\n",
  });
  git(live, 'add', '-A');
  git(live, 'commit', '-qm', 'c');
  put(live, {
    'node_modules/@capacitor/android/capacitor/build.gradle': 'library',
    'node_modules/@capacitor/android/capacitor/src/Bridge.java': 'class Bridge {}',
    'node_modules/@capacitor/android/capacitor/build/old.class': 'output',
    'node_modules/@capacitor/android/capacitor/debug.keystore': 'k',
    'node_modules/left-pad/index.js': 'x',
  });
  writeFileSync(join(keyDir, `${name}-release.jks`), 'THE-KEY');
  writeFileSync(join(keyDir, `${name}-release.pass`), 'pw');
  return { id: 7, name, title: name.toUpperCase(), home_scheme: 10, repo: `o/${name}` } as ContraptionRow;
}

type Outcome = 'ok' | 'fails' | 'away';

/** A builder whose machine is faked: `outcomes` is what each job does in turn; none left means no machine has room. */
function world(outcomes: Outcome[], took = () => {}) {
  const signLimits: number[] = [];
  const sent: { files: string[]; argv: string[]; text: string }[] = [];
  const perigee: string[][] = [];
  const signed: string[] = [];
  const stopped: number[] = [];
  const jobs = new Map<number, MachineJob>();
  const results = (id: number) => join(root, 'results', String(id));
  let offline = false;
  const deps: ApkMachineDeps = {
    store: {
      getMachine: (id) => ({ id, name: 'box' }) as ReturnType<ApkMachineDeps['store']['getMachine']>,
      getMachineJob: (id) => jobs.get(id),
      machineJobs: () => [],
      updateMachineJob: () => undefined,
    },
    jobs: {
      queueBuild: (q) => {
        took();
        const id = jobs.size + 1;
        const outcome = outcomes.shift()!;
        const snap = q.inputs[0].path;
        const dir = mkdtempSync(join(root, 'machine-'));
        execFileSync('tar', ['-xzf', snap, '-C', dir]);
        const files = execFileSync('tar', ['-tzf', snap], { encoding: 'utf8' }).trim().split('\n');
        const [, , script, , cwd, back, ...argv] = q.kind.command;
        assert.match(script, /tar --no-same-owner/);
        assert.ok(existsSync(join(dir, cwd, argv[argv.indexOf('--init-script') + 1])), 'the init script went along');
        sent.push({
          files,
          argv,
          text: files
            .filter((f) => !f.endsWith('/'))
            .map((f) => readFileSync(join(dir, f), 'utf8'))
            .join(''),
        });
        offline = outcome === 'away';
        if (outcome === 'ok') {
          const out = join(dir, back.split('\n')[0]);
          mkdirSync(join(out, '..'), { recursive: true });
          writeFileSync(out, 'unsigned on the machine');
          mkdirSync(join(dir, back.split('\n')[1]), { recursive: true });
          writeFileSync(join(dir, back.split('\n')[1], 'AndroidManifest.xml'), '<application android:allowBackup="true"/>');
          mkdirSync(results(id), { recursive: true });
          execFileSync('tar', ['-czf', join(results(id), 'back.tgz'), '-C', dir, ...back.split('\n')]);
          execFileSync('tar', ['-cf', join(results(id), 'back.tar'), '-C', results(id), 'back.tgz']);
        }
        const state = outcome === 'ok' ? 'done' : outcome === 'fails' ? 'failed' : 'running';
        const job = { id, go: 'builds', state, exit_code: outcome === 'ok' ? 0 : outcome === 'fails' ? 1 : null, error: null } as MachineJob;
        jobs.set(id, job);
        return job;
      },
      stopJob: (id) => (stopped.push(id), jobs.get(id)!),
    },
    placer: { place: () => (outcomes.length ? [{ id: 2, name: 'box', priority: null, free: 8 }] : []) },
    online: () => !offline,
    resultsDir: results,
    image: () => 'ghcr.io/x/android@sha256:a',
    pollMs: 5,
    awayMs: 15,
  };
  const run: Runner = async (argv, cwd, _env, _log, ms) => {
    perigee.push(argv);
    if (argv[1] === 'sign') signLimits.push(ms);
    if (argv.includes('sync'))
      put(cwd, { 'android/app/src/main/assets/public/index.html': 'synced web', 'android/local.properties': 'sdk.dir=/perigee', 'android/keystore.properties': 'storePassword=hunter2', 'android/release.jks': 'stray', 'android/app/platform.pk8': 'SECRET-pk8', 'android/key.properties': 'hunter2' });
    if (argv.includes('assembleRelease')) put(cwd, { 'app/build/outputs/apk/release/app-release-unsigned.apk': 'unsigned on perigee' });
    if (argv[1] === 'sign') {
      signed.push(readFileSync(argv.at(-1)!, 'utf8'));
      writeFileSync(argv[argv.indexOf('--out') + 1], 'signed');
    }
    return 0;
  };
  const told: string[] = [];
  const builds = new ApkBuilds({
    home,
    cacheDir: join(root, 'cache'),
    keyDir,
    heavy: '/bin/citadel-heavy',
    folder: (row) => join(root, 'apps', row.name),
    dataDir: (row) => join(root, 'data', row.name),
    ciRelease: () => false,
    published: () => {},
    tell: (_row, text) => told.push(text),
    elsewhere: new ApkMachine(deps),
    run,
    certs: async () => ['k1'],
    oomKills: async () => 0,
  });
  const gradleHere = () => perigee.filter((c) => c.includes('assembleRelease')).length;
  return { builds, sent, signed, signLimits, stopped, told, gradleHere };
}

test('a release build placed on a machine is signed on perigee, and no key file is among what it was sent', async () => {
  const row = app('placed');
  const w = world(['ok']);
  assert.deepEqual(await w.builds.check(row, '#1'), { built: 1 });
  assert.equal(w.gradleHere(), 0, 'Gradle did not run on perigee');
  assert.deepEqual(w.signed, ['unsigned on the machine']);
  const [{ files, argv, text }] = w.sent;
  assert.deepEqual(argv.slice(0, 2), ['./gradlew', '--no-daemon']);
  assert.ok(argv.includes('-Pcitadel.versionCode=1'));
  for (const f of ['android/app/src/main/assets/public/index.html', 'node_modules/@capacitor/android/capacitor/src/Bridge.java', 'android/app/build.gradle', 'android/app/debug.keystore']) assert.ok(files.includes(f), f);
  assert.deepEqual(
    files.filter((f) => f !== 'android/app/debug.keystore' && /\.(jks|keystore|pass)$|\.pk8$|key\.properties|local\.properties|keystore\.properties|left-pad|capacitor\/build\//.test(f)),
    [],
  );
  assert.doesNotMatch(text, /THE-KEY|hunter2|SECRET-pk8/);
  assert.match(w.told.join(), /allowBackup="true"/, 'the manifest came back for its warnings');
  assert.ok(!existsSync(join(root, 'cache/placed/machine')), 'the snapshot is gone');
});

test('no machine, or a build that fails there: perigee builds it', async () => {
  for (const [name, outcomes] of [
    ['nomachine', []],
    ['failsthere', ['fails']],
  ] as [string, Outcome[]][]) {
    const row = app(name);
    const w = world(outcomes);
    assert.deepEqual(await w.builds.check(row, '#1'), { built: 1 }, name);
    assert.equal(w.gradleHere(), 1, name);
    assert.deepEqual(w.signed, ['unsigned on perigee'], name);
  }
});

test('a machine that goes away has the build placed once more, then perigee takes it', async () => {
  const again = app('awayonce');
  const w = world(['away', 'ok']);
  assert.deepEqual(await w.builds.check(again, '#1'), { built: 1 });
  assert.deepEqual([w.sent.length, w.stopped, w.gradleHere(), w.signed], [2, [1], 0, ['unsigned on the machine']]);
  const gone = app('awaytwice');
  const t = world(['away', 'away', 'ok']);
  assert.deepEqual(await t.builds.check(gone, '#1'), { built: 1 });
  assert.deepEqual([t.sent.length, t.stopped, t.gradleHere()], [2, [1, 2], 1]);
});

test('a build that comes back late still has time to be signed', async (t) => {
  let late = 0;
  const now = Date.now.bind(Date);
  t.mock.method(Date, 'now', () => now() + late);
  const w = world(['ok'], () => (late = 2 * 3_600_000));
  assert.deepEqual(await w.builds.check(app('late'), '#1'), { built: 1 });
  assert.ok(w.signLimits[0] > 60_000, `signing had ${w.signLimits[0]} ms`);
});

test("capacitorExtras: nothing for a project that isn't Capacitor's, and a hoisted package outside the project is found", () => {
  const top = join(root, 'mono');
  put(top, { 'app/android/build.gradle': 'x', 'store/@capacitor/android/capacitor/A.java': 'a' });
  git(root, 'init', '-q', '-b', 'main', 'mono');
  assert.deepEqual(capacitorExtras(top, 'app/android'), []);
  mkdirSync(join(top, 'node_modules/@capacitor'), { recursive: true });
  symlinkSync(join(top, 'store/@capacitor/android'), join(top, 'node_modules/@capacitor/android'));
  put(top, { '.gitignore': 'node_modules\n', 'app/android/capacitor.settings.gradle': "new File('../../node_modules/@capacitor/android/capacitor')" });
  assert.deepEqual(capacitorExtras(top, 'app/android'), ['node_modules/@capacitor/android/capacitor/A.java']);
});
