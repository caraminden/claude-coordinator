import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.ts';
import { apkCode, certDigests, dispatch, nextFeed, OldApk, OtherKey, publish, rollBackApk } from '../src/apk-release.ts';

// src/apk-release.ts (#629): an APK target's release step, as Mandate's android/README.md does it by hand. A fake gh on
// PATH stands in for GitHub: `run download` writes the artifact named by APK_NAME, and every call is logged.
const root = mkdtempSync(join(tmpdir(), 'apk-release-'));
const bin = join(root, 'bin');
const log = join(root, 'gh.log');
const PATH = process.env.PATH;
before(() => {
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1" = run ] && [ "$2" = download ]; then
  while [ $# -gt 0 ]; do [ "$1" = --dir ] && dir="$2"; shift; done
  mkdir -p "$dir/mandate-release-apk" && printf apk > "$dir/mandate-release-apk/$APK_NAME"
fi
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  process.env.PATH = `${bin}${delimiter}${PATH}`;
});
after(() => {
  process.env.PATH = PATH;
  delete process.env.APK_NAME;
  rmSync(root, { recursive: true, force: true });
});

test("apkCode and nextFeed: the versionCode in a signed APK's name, and latest.json with only what is known", () => {
  assert.equal(apkCode('mandate-12.apk'), 12);
  assert.equal(apkCode('app-release.apk'), null);
  assert.deepEqual(nextFeed({ versionCode: 5, apk: 'mandate-5.apk', versionName: '1.4', notes: 'x' }, 6, 'mandate-6.apk', null), { notes: 'x', versionCode: 6, apk: 'mandate-6.apk' }, 'an old versionName would mislabel the new build');
  assert.deepEqual(nextFeed({}, 6, 'mandate-6.apk', '1.5'), { versionCode: 6, apk: 'mandate-6.apk', versionName: '1.5' });
});

test("publish copies the run's APK in, then points latest.json at it; an APK no newer is refused with the feed untouched", async () => {
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

test("certDigests reads apksigner's SHA-256 lines, sorted, and nothing else", () => {
  const out = `Signer #1 certificate DN: CN=Mandate, O=Citadel
Signer #1 certificate SHA-256 digest: c85e60a2
Signer #1 certificate SHA-1 digest: 407455f0
Signer #2 certificate SHA-256 digest: 0badf00d
`;
  assert.deepEqual(certDigests(out), ['0badf00d', 'c85e60a2']);
  assert.deepEqual(certDigests('WARNING: META-INF/x not protected\n'), []);
});

test('publish refuses an APK signed with another key than the published one, changing nothing; the same key goes through (#663)', async () => {
  const dir = join(root, 'keys');
  mkdirSync(dir);
  const feedFile = join(dir, 'latest.json');
  writeFileSync(feedFile, JSON.stringify({ versionCode: 6, apk: 'mandate-6.apk' }));
  writeFileSync(join(dir, 'mandate-6.apk'), 'old');
  const stored = join(root, 'mandate-7.apk');
  writeFileSync(stored, 'new');
  // The fake reads the "key" from the file's contents: the published APK's is 'old'.
  let key = 'other';
  const read: string[] = [];
  const certs = async (apk: string) => (read.push(apk), [readFileSync(apk, 'utf8') === 'old' ? 'aaa' : key === 'same' ? 'aaa' : 'bbb']);
  const go = () => publish({ slug: 'o/mandate', runId: 9, feedFile, current: 6, main: { code: 7, name: '1.7' }, as: undefined, stored, certs });
  await assert.rejects(go(), (err: Error) => err instanceof OtherKey && /another key \(certificate SHA-256 bbb\) than the published mandate-6\.apk \(aaa\)/.test(err.message));
  assert.deepEqual(read.sort(), [join(dir, 'mandate-6.apk'), stored].sort(), 'both APKs were read');
  assert.equal(JSON.parse(readFileSync(feedFile, 'utf8')).versionCode, 6, 'the feed is untouched');
  assert.ok(!existsSync(join(dir, 'mandate-7.apk')), 'and the APK not copied in');

  // An APK apksigner finds no certificate in counts as another key.
  await assert.rejects(publish({ slug: 'o/mandate', runId: 9, feedFile, current: 6, main: { code: 7, name: '1.7' }, as: undefined, stored, certs: async (a) => (a === stored ? [] : ['aaa']) }), OtherKey);

  key = 'same';
  assert.equal(await go(), 7);
  assert.deepEqual(JSON.parse(readFileSync(feedFile, 'utf8')), { versionCode: 7, apk: 'mandate-7.apk', versionName: '1.7' });
});

test('a publish is kept: who, which build, which run and when, by scheme (#663)', () => {
  const store = new Store(join(root, 'publishes.db'));
  const p = store.createProject('Mandate', null);
  store.recordApkPublish({ projectId: p.id, contraption: 'mandate', versionCode: 7, runId: 43502731900, by: '#112', uid: null });
  const rows = store.db.prepare('SELECT project_id, contraption, version_code, run_id, published_by, uid FROM apk_publishes').all();
  assert.deepEqual(
    rows.map((r) => ({ ...r })),
    [{ project_id: p.id, contraption: 'mandate', version_code: 7, run_id: 43502731900, published_by: '#112', uid: null }],
  );
  store.db.close();
});

test('dispatch starts the release workflow on the branch', async () => {
  await dispatch('o/mandate', 'android-release.yml', 'main', undefined);
  assert.match(readFileSync(log, 'utf8'), /^api -X POST repos\/o\/mandate\/actions\/workflows\/android-release\.yml\/dispatches -f ref=main$/m);
});

test("a CI-signed APK's roll back points the branch at last green, then signs it one past the published build; a copy of Citadel never does (ADR 0012)", async () => {
  const calls: string[] = [];
  const o = {
    name: 'Mandate',
    workflow: '.github/workflows/android-release.yml',
    slug: 'cara/mandate',
    current: 11,
    copy: false,
    as: undefined,
    branch: 'citadel/rollback',
    point: async (slug: string, branch: string, sha: string) => void calls.push(`point ${slug} ${branch} ${sha}`),
    start: async (slug: string, file: string, ref: string, _as: unknown, inputs: Record<string, string> = {}) => void calls.push(`dispatch ${slug} ${file} ${ref} ${JSON.stringify(inputs)}`),
  };
  assert.equal(await rollBackApk(o, 'abc123'), 12);
  assert.deepEqual(calls, ['point cara/mandate citadel/rollback abc123', 'dispatch cara/mandate android-release.yml citadel/rollback {"version_code":"12"}']);

  calls.length = 0;
  await assert.rejects(rollBackApk({ ...o, copy: true }, 'abc123'), (e: Error & { status: number }) => e.status === 409 && /doesn't release/.test(e.message));
  await assert.rejects(rollBackApk({ ...o, current: null }, 'abc123'), (e: Error & { status: number }) => e.status === 409);
  assert.deepEqual(calls, [], 'a refused roll back moves no branch and starts no run');

  // Last green's workflow from before the scheme added the input: GitHub's 422 becomes what the card says to do.
  const old = {
    ...o,
    start: async () => {
      throw Object.assign(new Error('gh: Unexpected inputs provided: ["version_code"] (HTTP 422)'), { stderr: '' });
    },
  };
  await assert.rejects(rollBackApk(old, 'abc123'), (e: Error & { status: number }) => e.status === 409 && /doesn't take a version_code input yet/.test(e.message) && /build 12/.test(e.message));
  const down = {
    ...o,
    start: async () => {
      throw new Error('HTTP 502');
    },
  };
  await assert.rejects(rollBackApk(down, 'abc123'), /HTTP 502/);
});
