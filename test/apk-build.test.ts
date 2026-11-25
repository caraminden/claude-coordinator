import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { apkPaths, ApkBuilds, capacitorApp, manifestWarnings, type ApkBuildDeps, type Runner } from '../src/apk-build.ts';
import { Store, type ContraptionRow } from '../src/db.ts';
import { TargetFinder } from '../src/release-targets.ts';
import { git } from './git.ts';

// src/apk-build.ts (#837): once a Capacitor app's deploy is live, an APK whose inputs changed is built, numbered by the
// commit count, signed and published. A real git repo stands in for the live slot; a fake runner for npx, Gradle and apksigner.
const root = mkdtempSync(join(tmpdir(), 'apk-build-'));
after(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, 'home');
mkdirSync(join(home, '.local/share/android-sdk/build-tools/36.1.0'), { recursive: true });
mkdirSync(join(home, '.local/share/mise/installs/java/temurin-21'), { recursive: true });
const keyDir = join(root, 'keys');
mkdirSync(keyDir);

function commit(dir: string, files: Record<string, string>) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'c');
  return git(dir, 'rev-parse', 'HEAD');
}

/** An app called `name` whose live folder is a git repo with a Capacitor shell (`cap` false: a plain web app). */
function app(name: string, cap = true) {
  const live = join(root, 'apps', name);
  mkdirSync(join(live, 'node_modules'), { recursive: true });
  git(join(root, 'apps'), 'init', '-q', '-b', 'main', name);
  writeFileSync(join(live, '.gitignore'), 'node_modules\n');
  commit(
    live,
    cap
      ? {
          'capacitor.config.json': JSON.stringify({ appId: 'x', webDir: 'shell' }),
          'shell/index.html': '<p>shell</p>',
          'android/app/build.gradle': 'android { defaultConfig { versionCode 1\n versionName "1.0" } }',
          'src/server.ts': '1',
        }
      : { 'src/server.ts': '1' },
  );
  const row = { name, title: name.toUpperCase(), home_scheme: 10, repo: `o/${name}` } as ContraptionRow;
  return { live, row, data: join(root, 'data', name) };
}

/** A builder with every outside step faked; `calls` records what ran, `told` what the Taskmaster was told. */
function builder(o: { ciRelease?: boolean | ApkBuildDeps['ciRelease']; fail?: string; code?: number; oom?: boolean } = {}) {
  const calls: string[][] = [];
  const cwds = new Map<string, string>();
  const told: string[] = [];
  const published: [string, number, string][] = [];
  let ooms = 0;
  const run: Runner = async (argv, cwd) => {
    calls.push(argv);
    cwds.set(argv.join(' '), cwd);
    if (o.fail && argv.join(' ').includes(o.fail)) {
      if (o.oom) ooms++;
      return o.code ?? 1;
    }
    if (argv.includes('assembleRelease')) {
      mkdirSync(join(cwd, 'app/build/outputs/apk/release'), { recursive: true });
      writeFileSync(join(cwd, 'app/build/outputs/apk/release/app-release-unsigned.apk'), 'unsigned');
      mkdirSync(join(cwd, 'app/build/intermediates/merged_manifests/release'), { recursive: true });
      writeFileSync(join(cwd, 'app/build/intermediates/merged_manifests/release/AndroidManifest.xml'), '<application android:allowBackup="false"/>');
    }
    if (argv[1] === 'sign') writeFileSync(argv[argv.indexOf('--out') + 1], 'signed');
    return 0;
  };
  const b = new ApkBuilds({
    home,
    cacheDir: join(root, 'cache'),
    keyDir,
    heavy: '/bin/citadel-heavy',
    folder: (row) => join(root, 'apps', row.name),
    dataDir: (row) => join(root, 'data', row.name),
    ciRelease: typeof o.ciRelease === 'function' ? o.ciRelease : () => !!o.ciRelease,
    published: (row, code, c) => published.push([row.name, code, c]),
    tell: (_row, text) => told.push(text),
    run,
    certs: async () => ['k1'],
    oomKills: async () => ooms,
    keytool: async (args) => writeFileSync(args[args.indexOf('-keystore') + 1], 'jks'),
  });
  return { b, calls, told, published, cwds };
}

const key = (name: string) => {
  writeFileSync(join(keyDir, `${name}-release.jks`), 'jks');
  writeFileSync(join(keyDir, `${name}-release.pass`), 'pw');
};
const feed = (data: string) => JSON.parse(readFileSync(join(data, 'android/latest.json'), 'utf8'));

test('capacitorApp, apkPaths and manifestWarnings: what makes an app, what goes into its APK, which flags are told', async () => {
  const { live } = app('plain', false);
  assert.equal(await capacitorApp(live), null);
  const cap = app('shellapp');
  assert.deepEqual(await capacitorApp(cap.live), { webDir: 'shell', root: '', android: 'android' });
  assert.deepEqual(apkPaths('shell/'), ['android', 'capacitor.config.json', 'capacitor.config.ts', 'shell']);
  assert.deepEqual(apkPaths('../x'), ['android', 'capacitor.config.json', 'capacitor.config.ts'], 'a webDir outside the repo is not a path to diff');
  assert.deepEqual(manifestWarnings('<application android:allowBackup="true" android:debuggable="false"/>'), ['its release manifest sets android:allowBackup="true"']);
});

test('the first deploy builds, signs and publishes build <commit count>; a change outside the APK builds nothing; one inside builds again', async () => {
  const { live, row, data } = app('reader');
  key('reader');
  const { b, calls, told, published } = builder();
  const head = git(live, 'rev-parse', 'HEAD');
  assert.deepEqual(await b.check(row, '#30'), { built: 1 });
  assert.deepEqual(feed(data), { versionCode: 1, apk: 'reader-1.apk', versionName: '1.0', commit: head });
  assert.equal(readFileSync(join(data, 'android/reader-1.apk'), 'utf8'), 'signed');
  assert.deepEqual(published, [['reader', 1, head]]);
  assert.deepEqual(told, []);
  const gradle = calls.find((c) => c.includes('assembleRelease'))!;
  assert.ok(gradle.includes('-Pcitadel.versionCode=1') && existsSync(gradle[gradle.indexOf('--init-script') + 1]), 'the versionCode goes in through the init script, the gradle file untouched');
  assert.equal(git(live, 'status', '--porcelain'), '', 'the live slot is left as it was');
  assert.ok(existsSync(join(root, 'cache/reader/src/node_modules')), "the build checkout uses the live slot's packages");

  commit(live, { 'src/server.ts': '2' });
  calls.length = 0;
  assert.deepEqual(await b.check(row, '#31'), { skipped: 'nothing in its APK changed' });
  assert.deepEqual(calls, []);

  const third = commit(live, { 'shell/index.html': '<p>new shell</p>' });
  assert.deepEqual(await b.check(row, '#32'), { built: 3 });
  assert.deepEqual(feed(data), { versionCode: 3, apk: 'reader-3.apk', versionName: '1.0', commit: third });
  assert.ok(existsSync(join(data, 'android/reader-1.apk')), 'the build before stays for a phone that just read latest.json');
  assert.deepEqual(await b.check(row, '#32'), { skipped: 'published at this commit' });

  for (const n of [4, 5, 6]) {
    commit(live, { 'android/app/x.txt': String(n) });
    assert.deepEqual(await b.check(row, 'auto-deploy'), { built: n });
  }
  assert.deepEqual(
    readdirSync(join(data, 'android'))
      .filter((f) => f.endsWith('.apk'))
      .sort(),
    ['reader-4.apk', 'reader-5.apk', 'reader-6.apk'],
    'the newest three are kept',
  );
});

test('no release key: nothing builds, the home Taskmaster is told once for that commit, and the next commit tries again', async () => {
  const { live, row, data } = app('keyless');
  const { b, calls, told } = builder();
  assert.ok('failed' in (await b.check(row, '#1')));
  assert.equal(told.length, 1);
  assert.match(told[0], /no release key yet/);
  assert.deepEqual(calls, []);
  assert.ok(!existsSync(join(data, 'android/latest.json')));
  assert.deepEqual(await b.check(row, '#1'), { skipped: 'already failed at this commit' });
  assert.equal(told.length, 1);
  key('keyless');
  commit(live, { 'android/app/y.txt': '1' });
  assert.deepEqual(await b.check(row, '#2'), { built: 2 });
});

test('a missing release key is told once, not once per commit; it tells again only after the key existed and went missing', async () => {
  const { live, row } = app('nokey');
  const { b, told } = builder();
  assert.ok('failed' in (await b.check(row, '#1')));
  commit(live, { 'android/app/a.txt': '1' });
  assert.deepEqual(await b.check(row, '#2'), { skipped: 'no release key yet, already told' });
  commit(live, { 'android/app/a.txt': '2' });
  await b.check(row, '#3');
  assert.equal(told.length, 1, 'two more commits without the key are not told again');
  key('nokey');
  commit(live, { 'android/app/a.txt': '3' });
  assert.ok('built' in (await b.check(row, '#4')));
  rmSync(join(keyDir, 'nokey-release.jks'));
  commit(live, { 'android/app/a.txt': '4' });
  await b.check(row, '#5');
  assert.equal(told.length, 2, 'the key went missing again: told again');
  assert.match(told[1], /half of its release key is missing: .*nokey-release\.pass is there but .*nokey-release\.jks isn't\. Restore it/, 'half a key is a lost one: restore, never make');
  assert.doesNotMatch(told[1], /Make release key/);
  assert.equal(b.keyless('nokey'), false, 'and no button offers a new one');
});

test("makeKey makes a keyless app's key, forgets the told notice and builds at once; keyless names it until then", async () => {
  const { row, data } = app('newkey');
  const { b, told } = builder();
  assert.equal(b.keyless('newkey'), false, 'not known as a Capacitor app until a check reads it');
  assert.ok('failed' in (await b.check(row, '#1')));
  assert.equal(told.length, 1);
  assert.match(told[0], /Make release key|make_release_key/);
  assert.equal(b.keyless('newkey'), true);
  await (await b.makeKey(row, 'Cara')).building;
  assert.equal(b.keyless('newkey'), false);
  assert.equal(feed(data).versionCode, 1, 'the commit the notice failed at builds now');
  await assert.rejects(b.makeKey(row, 'Cara'), /already has a release key/);
});

test('a failed Gradle build publishes nothing and tells the end of its log; an app a release workflow signs is left alone', async () => {
  const { row, data } = app('broken');
  key('broken');
  const { b, told } = builder({ fail: 'assembleRelease' });
  assert.deepEqual(await b.check(row, '#1'), { failed: 'gradlew assembleRelease failed (exit 1)' });
  assert.match(told[0], /The end of its build log/);
  assert.ok(!existsSync(join(data, 'android/latest.json')));

  const ci = app('ci');
  key('ci');
  assert.deepEqual(await builder({ ciRelease: true }).b.check(ci.row, '#1'), { skipped: 'a release workflow signs its APKs' });
});

test('a build killed by a signal says so; a restart kill is retried at the next check, an out-of-memory kill is not', async () => {
  const { row, data } = app('killed');
  key('killed');
  const term = builder({ fail: 'assembleRelease', code: 128 + 15 });
  assert.deepEqual(await term.b.check(row, 'auto-deploy'), { failed: 'gradlew assembleRelease was killed by SIGTERM (a Citadel restart stops its builds): the next check builds it again' });
  assert.deepEqual(term.told, [], "a restart kill is not the commit's fault: nothing to tell");
  assert.equal(((await builder().b.check(row, 'auto-deploy')) as { built: number }).built, 1, "the next check (the restarted server's) builds the same commit");

  const big = app('big');
  key('big');
  const oom = builder({ fail: 'assembleRelease', code: 128 + 9, oom: true });
  assert.deepEqual(await oom.b.check(big.row, '#1'), { failed: 'gradlew assembleRelease ran out of memory: the kernel killed it (SIGKILL)' });
  assert.match(oom.told[0], /ran out of memory/);
  assert.match(readFileSync(join(root, 'cache/big/build.log'), 'utf8'), /out of memory/);
  assert.deepEqual(await builder().b.check(big.row, '#1'), { skipped: 'already failed at this commit' });
  const daemon = app('daemon');
  key('daemon');
  assert.deepEqual(await builder({ fail: 'assembleRelease', code: 1, oom: true }).b.check(daemon.row, '#1'), { failed: 'gradlew assembleRelease ran out of memory: the kernel killed it (exit 1)' }, "an OOM kill of Gradle's daemon leaves its client exiting 1");
  assert.ok(!existsSync(join(big.data, 'android/latest.json')) && !existsSync(join(data, 'android/killed-0.apk')));
});

test('a roll back to an older commit builds it one past the published build, so phones take it (ADR 0012)', async () => {
  const { live, row, data } = app('rolled');
  key('rolled');
  const { b } = builder();
  const green = git(live, 'rev-parse', 'HEAD');
  assert.deepEqual(await b.check(row, '#1'), { built: 1 });
  commit(live, { 'shell/index.html': '<p>broken</p>' });
  const bad = commit(live, { 'shell/index.html': '<p>still broken</p>' });
  assert.deepEqual(await b.check(row, '#2'), { built: 3 });
  git(live, 'checkout', '--quiet', '--detach', green);
  assert.deepEqual(await b.check(row, '#3'), { built: 4 }, 'commit count 1, published 3: it goes out as 4');
  assert.deepEqual(feed(data), { versionCode: 4, apk: 'rolled-4.apk', versionName: '1.0', commit: green });
  git(live, 'checkout', '--quiet', '--detach', bad);
  assert.deepEqual(await b.check(row, '#4'), { built: 5 }, 'the fix after it climbs on from there');
});

test('a published build at or above the commit count is refused, not overwritten', async () => {
  const { row, data } = app('ahead');
  key('ahead');
  mkdirSync(join(data, 'android'), { recursive: true });
  writeFileSync(join(data, 'android/latest.json'), JSON.stringify({ versionCode: 7, apk: 'ahead-7.apk' }));
  const { b, told } = builder();
  assert.ok('failed' in (await b.check(row, '#1')));
  assert.match(told[0], /published APK is build 7 already/);
  assert.equal(feed(data).versionCode, 7);
});

test('schedule runs one build per app at a time and checks again for a deploy that went live meanwhile', async () => {
  const { live, row } = app('queued');
  key('queued');
  const { b, published } = builder();
  const first = b.schedule(row, '#1');
  commit(live, { 'android/app/z.txt': '1' });
  void b.schedule(row, '#2');
  await first;
  assert.equal(published.at(-1)![1], 2, 'the newer commit is built once the first build ends');
  assert.ok(published.length <= 2);
});

test('a webDir the deploy builds (gitignored) is copied from the live slot, and any commit builds again', async () => {
  const live = join(root, 'apps', 'bundled');
  mkdirSync(join(live, 'node_modules'), { recursive: true });
  git(join(root, 'apps'), 'init', '-q', '-b', 'main', 'bundled');
  writeFileSync(join(live, '.gitignore'), 'node_modules\ndist\n');
  commit(live, { 'capacitor.config.json': JSON.stringify({ webDir: 'dist' }), 'android/app/build.gradle': 'versionCode 1', 'src/main.ts': '1' });
  const row = { name: 'bundled', title: 'Bundled', home_scheme: 10, repo: 'o/bundled' } as ContraptionRow;
  key('bundled');
  const { b, told } = builder();
  assert.ok('failed' in (await b.check(row, '#1')), 'no built dist/ yet');
  assert.match(told[0], /webDir dist isn't in git/);
  mkdirSync(join(live, 'dist'));
  writeFileSync(join(live, 'dist/index.html'), 'v2');
  commit(live, { 'src/main.ts': '2' });
  assert.deepEqual(await b.check(row, '#2'), { built: 2 });
  assert.equal(readFileSync(join(root, 'cache/bundled/src/dist/index.html'), 'utf8'), 'v2', 'the live build output, copied');
  commit(live, { 'src/main.ts': '3' });
  assert.deepEqual(await b.check(row, '#3'), { built: 3 }, 'a source change may change dist/, so it builds');
});

test("the commit a build failed at outlasts a restart: a new builder doesn't tell it again", async () => {
  const { row } = app('restarted');
  const first = builder();
  await first.b.check(row, '#1');
  assert.equal(first.told.length, 1);
  const second = builder();
  assert.deepEqual(await second.b.check(row, 'auto-deploy'), { skipped: 'already failed at this commit' });
  assert.deepEqual(second.told, []);
});

/** A contraption like voice: Capacitor root android/, native project android/native, webDir android/www, named in citadel-app.json. */
function subApp(name: string, manifest = true) {
  const a = app(name, false);
  mkdirSync(join(a.live, 'android/node_modules'), { recursive: true }); // voice's Capacitor packages: android/package.json
  commit(a.live, {
    ...(manifest ? { 'citadel-app.json': JSON.stringify({ capacitor: { root: 'android', android: 'android/native' } }) } : { 'citadel-app.json': '{}' }),
    'android/capacitor.config.json': JSON.stringify({ appId: 'x', webDir: 'www' }),
    'android/www/index.html': '<p>shell</p>',
    'android/native/app/build.gradle': 'android { defaultConfig { versionCode 1\n versionName "2.0" } }',
  });
  return a;
}

test('a Capacitor project in a subfolder named in citadel-app.json is built from there and published', async () => {
  const { live, row, data } = subApp('sub');
  key('sub');
  const { b, calls, cwds } = builder();
  assert.deepEqual(await b.check(row, '#1'), { built: 2 });
  assert.equal(feed(data).versionName, '2.0');
  const cap = calls.find((c) => c.includes('sync'))!;
  assert.equal(cwds.get(cap.join(' ')), join(root, 'cache/sub/src/android'), 'cap sync runs in the Capacitor root');
  assert.equal(readlinkSync(join(root, 'cache/sub/src/android/node_modules')), join(root, 'apps/sub/android/node_modules'), "the Capacitor root's packages are linked, where cap sync and the Gradle files look");
  const gradle = calls.find((c) => c.includes('assembleRelease'))!;
  assert.equal(cwds.get(gradle.join(' ')), join(root, 'cache/sub/src/android/native'), 'Gradle runs in the Android project');
  commit(live, { 'src/server.ts': '2' });
  assert.deepEqual(await b.check(row, '#2'), { skipped: 'nothing in its APK changed' });
  commit(live, { 'android/www/index.html': '<p>new</p>' });
  assert.deepEqual(await b.check(row, '#3'), { built: 4 }, 'a change in the webDir (relative to the Capacitor root) builds again');
});

test('a keyed contraption skipped as not a Capacitor app is told to its scheme once, naming the field; one without a key is not told', async () => {
  const { live, row } = subApp('lost', false);
  key('lost');
  const { b, told } = builder();
  assert.deepEqual(await b.check(row, '#1'), { skipped: 'not a Capacitor app' });
  assert.equal(told.length, 1);
  assert.match(told[0], /citadel-app\.json/);
  assert.match(told[0], /"capacitor"/);
  commit(live, { 'src/server.ts': '2' });
  await b.check(row, '#2');
  assert.equal(told.length, 1, 'not again on the next deploy');
  const plain = app('plainkeyless', false);
  await b.check(plain.row, '#3');
  assert.equal(told.length, 1, 'no key, no tell');
});

test("an app a release workflow signs is never built or told before its scheme's targets are scanned; an unreadable clone is skipped quietly", async () => {
  // Mandate, 2026-11-24 (#1870): the 60 s startup sweep ran while the first scan was still going, read the empty
  // target list as "no release workflow" and told its scheme to add a Capacitor root it doesn't need.
  const store = new Store(join(root, 'targets.db'));
  const repo = join(root, 'scheme-repo');
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.github/workflows/android-release.yml'), 'on:\n  workflow_dispatch:\njobs:\n  release:\n    steps:\n      - run: ./gradlew assembleRelease\n');
  commit(repo, {});
  const p = store.createProject('Signed', 'https://github.com/o/signed');
  store.setProjectRepoDir(p.id, repo);
  const { row: plain, data } = app('signed', false);
  key('signed');
  const row = { ...plain, home_scheme: p.id };
  mkdirSync(join(data, 'android'), { recursive: true });
  writeFileSync(join(data, 'android/latest.json'), JSON.stringify({ versionCode: 13 }));
  store.createContraption({
    name: 'signed',
    title: 'Signed',
    icon: null,
    port: 9,
    home_scheme: p.id,
    open_paths: '[]',
    relay_paths: '[]',
    repo: 'o/signed',
    branch: null,
    folder: join(root, 'apps/signed'),
    default_model: null,
    turn_cap: null,
    identity_public: 'x',
    identity_private: 'x',
    key_hash: 'h',
    keys_at: 0,
    static_paths: null,
    restart_risk: 'unassessed',
    restart_note: '',
    subdir: null,
  });
  const finder = new TargetFinder({ store, own: () => null, apkFeed: (name) => join(root, 'data', name, 'android/latest.json') });
  const { b, told, calls } = builder({ ciRelease: (r) => finder.ciRelease(r) });
  const early = b.check(row, 'auto-deploy');
  await finder.scan();
  assert.deepEqual(await early, { skipped: 'a release workflow signs its APKs' });
  assert.deepEqual(told, [], 'nothing told while the targets were unknown');
  assert.deepEqual(calls, [], 'nothing built');

  // A scheme whose clone git can't read on the first scan: unknown, so skipped with no notice either.
  const lost = new TargetFinder({ store, own: () => null, apkFeed: (name) => join(root, 'data', name, 'android/latest.json') });
  rmSync(join(repo, '.git'), { recursive: true, force: true });
  const blind = builder({ ciRelease: (r) => lost.ciRelease(r) }).b.check(row, 'auto-deploy');
  await lost.scan();
  assert.deepEqual(await blind, { skipped: "its scheme's release targets aren't known yet" });
  assert.deepEqual(told, []);
  assert.ok(!existsSync(join(root, 'cache/signed/not-capacitor-told')));
});
