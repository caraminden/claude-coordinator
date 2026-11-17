import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { apkPaths, ApkBuilds, capacitorApp, manifestWarnings, type Runner } from '../src/apk-build.ts';
import type { ContraptionRow } from '../src/db.ts';
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
  commit(live, cap ? {
    'capacitor.config.json': JSON.stringify({ appId: 'x', webDir: 'shell' }),
    'shell/index.html': '<p>shell</p>',
    'android/app/build.gradle': 'android { defaultConfig { versionCode 1\n versionName "1.0" } }',
    'src/server.ts': '1',
  } : { 'src/server.ts': '1' });
  const row = { name, title: name.toUpperCase(), home_scheme: 10, repo: `o/${name}` } as ContraptionRow;
  return { live, row, data: join(root, 'data', name) };
}

/** A builder with every outside step faked; `calls` records what ran, `told` what the Taskmaster was told. */
function builder(o: { ciRelease?: boolean; fail?: string } = {}) {
  const calls: string[][] = [];
  const told: string[] = [];
  const published: [string, number, string][] = [];
  const run: Runner = async (argv, cwd) => {
    calls.push(argv);
    if (o.fail && argv.join(' ').includes(o.fail)) return 1;
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
    home, cacheDir: join(root, 'cache'), keyDir, heavy: '/bin/citadel-heavy',
    folder: (row) => join(root, 'apps', row.name), dataDir: (row) => join(root, 'data', row.name),
    ciRelease: () => !!o.ciRelease,
    published: (row, code, c) => published.push([row.name, code, c]),
    tell: (_row, text) => told.push(text),
    run, certs: async () => ['k1'],
    keytool: async (args) => writeFileSync(args[args.indexOf('-keystore') + 1], 'jks'),
  });
  return { b, calls, told, published };
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
  assert.deepEqual(await capacitorApp(cap.live), { webDir: 'shell' });
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
  assert.ok(existsSync(join(root, 'cache/reader/src/node_modules')), 'the build checkout uses the live slot\'s packages');

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
  assert.deepEqual(readdirSync(join(data, 'android')).filter((f) => f.endsWith('.apk')).sort(), ['reader-4.apk', 'reader-5.apk', 'reader-6.apk'], 'the newest three are kept');
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
