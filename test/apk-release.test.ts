import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, test } from 'node:test';
import { apkCode, dispatch, nextFeed, OldApk, publish } from '../src/apk-release.ts';

// src/apk-release.ts (#629): an APK target's release step, as Mandate's android/README.md does it by hand. A fake gh on
// PATH stands in for GitHub: `run download` writes the artifact named by APK_NAME, and every call is logged.
const root = mkdtempSync(join(tmpdir(), 'apk-release-'));
const bin = join(root, 'bin');
const log = join(root, 'gh.log');
const PATH = process.env.PATH;
before(() => {
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1" = run ] && [ "$2" = download ]; then
  while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done
  mkdir -p "$dir/mandate-release-apk" && printf apk > "$dir/mandate-release-apk/$APK_NAME"
fi
`);
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${delimiter}${PATH}`;
});
after(() => {
  process.env.PATH = PATH;
  delete process.env.APK_NAME;
  rmSync(root, { recursive: true, force: true });
});

test('apkCode and nextFeed: the versionCode in a signed APK\'s name, and latest.json with only what is known', () => {
  assert.equal(apkCode('mandate-12.apk'), 12);
  assert.equal(apkCode('app-release.apk'), null);
  assert.deepEqual(nextFeed({ versionCode: 5, apk: 'mandate-5.apk', versionName: '1.4', notes: 'x' }, 6, 'mandate-6.apk', null), { notes: 'x', versionCode: 6, apk: 'mandate-6.apk' }, 'an old versionName would mislabel the new build');
  assert.deepEqual(nextFeed({}, 6, 'mandate-6.apk', '1.5'), { versionCode: 6, apk: 'mandate-6.apk', versionName: '1.5' });
});

test('publish copies the run\'s APK in, then points latest.json at it; an APK no newer is refused with the feed untouched', async () => {
  const dir = join(root, 'android');
  mkdirSync(dir);
  const feedFile = join(dir, 'latest.json');
  writeFileSync(feedFile, JSON.stringify({ versionCode: 5, apk: 'mandate-5.apk', versionName: '1.4' }));
  process.env.APK_NAME = 'mandate-5.apk';
  await assert.rejects(publish({ slug: 'o/mandate', runId: 7, feedFile, current: 5, main: { code: 6, name: '1.5' }, as: undefined }), OldApk);
  assert.equal(JSON.parse(readFileSync(feedFile, 'utf8')).versionCode, 5);

  process.env.APK_NAME = 'mandate-6.apk';
  assert.equal(await publish({ slug: 'o/mandate', runId: 8, feedFile, current: 5, main: { code: 6, name: '1.5' }, as: undefined }), 6);
  assert.deepEqual(JSON.parse(readFileSync(feedFile, 'utf8')), { versionCode: 6, apk: 'mandate-6.apk', versionName: '1.5' });
  assert.equal(readFileSync(join(dir, 'mandate-6.apk'), 'utf8'), 'apk');
  assert.ok(!existsSync(`${feedFile}.tmp`));
  assert.match(readFileSync(log, 'utf8'), /^run download 8 --repo o\/mandate --dir \S+$/m);
});

test('dispatch starts the release workflow on the branch', async () => {
  await dispatch('o/mandate', 'android-release.yml', 'main', undefined);
  assert.match(readFileSync(log, 'utf8'), /^api -X POST repos\/o\/mandate\/actions\/workflows\/android-release\.yml\/dispatches -f ref=main$/m);
});
