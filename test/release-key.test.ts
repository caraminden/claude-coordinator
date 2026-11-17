import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { hasKey, makeReleaseKey, type Keytool } from '../src/release-key.ts';

// src/release-key.ts (#837): an app's release key, made on the server. A fake keytool writes the keystore where it's told.
const root = mkdtempSync(join(tmpdir(), 'release-key-'));
after(() => rmSync(root, { recursive: true, force: true }));
const keyDir = join(root, 'keys');

function fake(o: { fail?: boolean } = {}) {
  const runs: string[][] = [];
  const keytool: Keytool = async (args) => {
    runs.push(args);
    if (o.fail) throw new Error('keytool failed: boom');
    writeFileSync(args[args.indexOf('-keystore') + 1], 'jks');
  };
  return { runs, keytool };
}

test('makes the .jks and a random .pass, both mode 600, with the password only in its file', async () => {
  const { runs, keytool } = fake();
  const out = await makeReleaseKey(keyDir, 'twireader', { home: root, keytool });
  assert.deepEqual(out, { jks: join(keyDir, 'twireader-release.jks'), pass: join(keyDir, 'twireader-release.pass') });
  for (const f of [out.jks, out.pass]) assert.equal(statSync(f).mode & 0o777, 0o600, f);
  const pw = readFileSync(out.pass, 'utf8').trim();
  assert.match(pw, /^[A-Za-z0-9_-]{32}$/);
  assert.ok(!runs[0].some((a) => a.includes(pw)), 'the password is never an argument');
  assert.ok(runs[0].includes('-storepass:file') && runs[0].includes('-keypass:file'));
  assert.deepEqual(readdirSync(keyDir).sort(), ['twireader-release.jks', 'twireader-release.pass'], 'its scratch folder is gone');
  assert.ok(hasKey(keyDir, 'twireader'));
  await makeReleaseKey(keyDir, 'other', { home: root, keytool });
  assert.notEqual(readFileSync(join(keyDir, 'other-release.pass'), 'utf8'), readFileSync(out.pass, 'utf8'));
});

test('never replaces a key, even half of one', async () => {
  const { runs, keytool } = fake();
  writeFileSync(join(keyDir, 'kept-release.pass'), 'old');
  await assert.rejects(makeReleaseKey(keyDir, 'kept', { home: root, keytool }), /already has a release key/);
  assert.equal(readFileSync(join(keyDir, 'kept-release.pass'), 'utf8'), 'old');
  assert.ok(!existsSync(join(keyDir, 'kept-release.jks')));
  assert.deepEqual(runs, []);
});

test('a keytool failure or a bad name leaves nothing behind', async () => {
  await assert.rejects(makeReleaseKey(keyDir, 'broke', { home: root, keytool: fake({ fail: true }).keytool }), /boom/);
  assert.ok(!hasKey(keyDir, 'broke'));
  await assert.rejects(makeReleaseKey(keyDir, '../x', { home: root, keytool: fake().keytool }), /isn't an app name/);
  assert.deepEqual(readdirSync(keyDir).filter((f) => f.startsWith('.')), []);
});
