// The starter CI template other schemes copy (#1782): its boot check, run as they run it, and the workflows' runners.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';

const DIR = join(import.meta.dirname, '..', 'kit/skills/scheme-setup/templates/starter-ci');

/** An app folder with this manifest and server, and the check run on it. */
async function check(t: TestContext, manifest: object, server: string, env: Record<string, string> = {}, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'starter-ci-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, 'some-folder');
  mkdirSync(app);
  writeFileSync(join(app, 'citadel-app.json'), JSON.stringify(manifest));
  writeFileSync(join(app, 'server.mjs'), server);
  const p = spawn(process.execPath, [join(DIR, 'boot-check.ts'), ...args, app], { env: { ...process.env, TMPDIR: dir, BOOT_CHECK_MS: '20000', ...env } });
  let out = '';
  p.stdout.on('data', (b) => (out += b));
  p.stderr.on('data', (b) => (out += b));
  const code = await new Promise((done) => p.once('close', done));
  return { code, out, app, dir };
}

const SERVER = `
import { createServer } from 'node:http';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const e = process.env;
writeFileSync('seen.json', JSON.stringify({ ...e, pid: process.pid, data: readdirSync(e.DATA_DIR), pub: readFileSync(e.CITADEL_KEYS + '/identity.pub', 'utf8'), key: readFileSync(e.CITADEL_KEYS + '/contraption.key', 'utf8') }));
createServer((q, r) => { r.statusCode = q.url === e.BASE_PATH + '/health' ? 204 : 404; r.end(); }).listen(Number(e.PORT), '127.0.0.1');
`;

test('a healthy app passes: built, started as Citadel starts it, and stopped after', async (t) => {
  const r = await check(t, { build: ['echo built > built.txt'], start: ['/usr/bin/node', 'server.mjs'], health: '/apps/demo/health', env: { INBOX: '~/inbox' } }, SERVER, { GITHUB_TOKEN: 'a-runner-secret' });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /passed: \/apps\/demo\/health answered 204, twice/);
  assert.equal(readFileSync(join(r.app, 'built.txt'), 'utf8'), 'built\n');
  const seen = JSON.parse(readFileSync(join(r.app, 'seen.json'), 'utf8'));
  assert.equal(seen.BASE_PATH, '/apps/demo', 'the name comes from the health path, not the folder');
  assert.deepEqual(seen.data, [], 'an empty data folder');
  assert.equal(seen.INBOX, join(seen.HOME, 'inbox'));
  assert.notEqual(seen.HOME, process.env.HOME, 'a home of its own');
  assert.match(seen.pub, /BEGIN PUBLIC KEY/);
  assert.equal(seen.GITHUB_TOKEN, undefined, "the runner's variables stay out of the app");
  assert.throws(() => process.kill(seen.pid, 0), 'the app is stopped');
  assert.deepEqual(readdirSync(r.dir), ['some-folder'], 'the scratch folder is gone');
});

test('an app that dies is red at once, with its last words', async (t) => {
  const r = await check(t, { start: ['node', 'server.mjs'], health: '/apps/demo/health' }, `console.error('no such table: people'); process.exit(3);`);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /no such table: people/);
  assert.match(r.out, /FAILED: it exited \(3\)/);
});

test('an app that answers once and then dies is red', async (t) => {
  const r = await check(t, { start: ['node', 'server.mjs'], health: '/apps/demo/health' }, SERVER.replace('r.end();', 'r.end(() => process.exit(1));'));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /it exited \(1\).*answered 204/);
});

test('a health page that errors, or redirects, is red', async (t) => {
  for (const status of [500, 302]) {
    const r = await check(t, { start: ['node', 'server.mjs'], health: '/apps/demo/health' }, SERVER.replace('204', `(r.setHeader('location', '/'), ${status})`), { BOOT_CHECK_MS: '3000' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, new RegExp(`not up after .*answered ${status}`));
  }
});

test('a failed build step is red and starts nothing; --no-build skips it', async (t) => {
  const manifest = { build: ['exit 7'], start: ['node', 'server.mjs'], health: '/apps/demo/health' };
  const r = await check(t, manifest, SERVER);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAILED: the build step "exit 7" exited 7/);
  assert.ok(!readdirSync(r.app).includes('seen.json'));
  assert.equal((await check(t, manifest, SERVER, {}, ['--no-build'])).code, 0);
});

test('with no health path an open port counts', async (t) => {
  const r = await check(t, { start: ['node', 'server.mjs'] }, SERVER);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /passed: port \d+ open/);
});

test("a folder with no manifest, and a program that isn't there, are red with the reason", async (t) => {
  const missing = await check(t, { start: ['no-such-program-here'], health: '/health' }, '');
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /FAILED: it didn't start: .*ENOENT/);
  const none = await check(t, {}, '');
  assert.match(none.out, /FAILED: citadel-app\.json has no start command/);
});

test("the workflows run only on the scheme's own runner, and not on pull requests", () => {
  for (const f of readdirSync(DIR).filter((n) => n.endsWith('.yml'))) {
    const wf = readFileSync(join(DIR, f), 'utf8').replace(/^\s*#.*$|\s#\s.*$/gm, '');
    const runsOn = [...wf.matchAll(/runs-on:(.*)/g)].map((m) => m[1].trim());
    assert.deepEqual(runsOn, ['[self-hosted, <scheme-slug>-ci-linux]'], f);
    assert.doesNotMatch(wf, /ubuntu-|windows-latest|CI_RUNNER|pull_request|upload-artifact|--if-present|\|\| true/, f);
  }
});
