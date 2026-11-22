import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { depsNote, installDeps, lockfileDirs } from '../src/worktree-deps.ts';
import { bootServer, jsonLines } from './helpers.ts';
import { until } from './wait.ts';

// A new minion's worktree gets its npm dependencies from the lockfile before its first turn (#1649). A fake npm stands in
// for the real one: `mode` in its folder says whether `ci` makes node_modules, fails, or hangs; `calls` logs each run.
const root = mkdtempSync(join(tmpdir(), 'worktree-deps-'));
after(() => rmSync(root, { recursive: true, force: true })); // timing-ok: own temp dir

const fake = join(root, 'npm-fake');
mkdirSync(join(fake, 'bin'), { recursive: true });
writeFileSync(join(fake, 'bin', 'npm'), `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify(fake)};
fs.appendFileSync(dir + '/calls', JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2), cache: process.env.npm_config_cache ?? null, claude: Object.keys(process.env).filter((k) => /^(CLAUDE_|ANTHROPIC_)/.test(k)) }) + '\\n');
const mode = fs.existsSync(dir + '/mode') ? fs.readFileSync(dir + '/mode', 'utf8').trim() : 'ok';
if (mode === 'fail') { console.error('npm error code EBOOM'); console.error('npm error A complete log of this run can be found in: /x'); process.exit(1); }
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'stubborn') {
  // Ignores TERM, and an install script it started is still running.
  const kid = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(dir + '/grandchild', String(kid.pid));
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}
else fs.mkdirSync('node_modules/left-pad', { recursive: true });
`);
chmodSync(join(fake, 'bin', 'npm'), 0o755);
const npm = [join(fake, 'bin', 'npm')];
const setMode = (m: string) => writeFileSync(join(fake, 'mode'), m);
const calls = (): { cwd: string; args: string[]; cache: string | null; claude: string[] }[] => jsonLines(join(fake, 'calls'));
const clearCalls = () => rmSync(join(fake, 'calls'), { force: true });

let repos = 0;
/** A repo with `files` committed (path → content). */
function repo(files: Record<string, string>): string {
  const dir = join(root, `repo-${++repos}`);
  mkdirSync(dir);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'one');
  return dir;
}
const LOCK = '{"lockfileVersion":3,"packages":{}}';
const cache = join(root, 'cache');

test('a lockfile whose node_modules git ignores gets npm ci from the lockfile, on the shared cache', async () => {
  setMode('ok');
  clearCalls();
  const dir = repo({ '.gitignore': 'node_modules/\n', 'package.json': '{}', 'package-lock.json': LOCK });
  const r = await installDeps(dir, cache, { npm });
  assert.deepEqual(r, { installed: [''], failed: [] });
  assert.ok(existsSync(join(dir, 'node_modules', 'left-pad')));
  const [c] = calls();
  assert.deepEqual(c.args.slice(0, 2), ['ci', '--prefer-offline'], 'npm ci, never a plain npm install');
  assert.equal(c.cache, cache);
  assert.equal(c.cwd, dir);
  assert.equal(depsNote(r), null);
  // Already there: nothing runs again.
  clearCalls();
  assert.deepEqual(await installDeps(dir, cache, { npm }), { installed: [], failed: [] });
  assert.equal(calls().length, 0);
});

test("the install never sees Claude's own variables", async () => {
  setMode('ok');
  clearCalls();
  const dir = repo({ '.gitignore': 'node_modules/\n', 'package-lock.json': LOCK });
  process.env.ANTHROPIC_API_KEY_TEST_1649 = 'x';
  try {
    await installDeps(dir, cache, { npm });
  } finally {
    delete process.env.ANTHROPIC_API_KEY_TEST_1649;
  }
  assert.deepEqual(calls()[0].claude, []);
});

test('no lockfile, or a node_modules git would track: nothing runs', async () => {
  setMode('ok');
  clearCalls();
  const none = repo({ '.gitignore': 'node_modules/\n', 'package.json': '{}' });
  assert.deepEqual(await installDeps(none, cache, { npm }), { installed: [], failed: [] });
  // Only the root's node_modules is ignored: sub/'s would leave thousands of files to commit.
  const sub = repo({ '.gitignore': '/node_modules\n', 'package-lock.json': LOCK, 'sub/package-lock.json': LOCK });
  assert.deepEqual(await lockfileDirs(sub), ['']);
  assert.deepEqual((await installDeps(sub, cache, { npm })).installed, ['']);
  const untracked = repo({ 'package-lock.json': LOCK });
  assert.deepEqual(await installDeps(untracked, cache, { npm }), { installed: [], failed: [] });
  assert.equal(calls().length, 1, 'only the ignored root of the second repo was looked at');
  assert.equal(calls()[0].cwd, sub);
});

test('each tracked lockfile folder is installed: a companion app beside the root', async () => {
  setMode('ok');
  clearCalls();
  const dir = repo({ '.gitignore': 'node_modules/\n', 'package-lock.json': LOCK, 'companion/package-lock.json': LOCK, 'app/npm-shrinkwrap.json': LOCK });
  assert.deepEqual((await installDeps(dir, cache, { npm })).installed, ['', 'app', 'companion']);
  assert.ok(existsSync(join(dir, 'companion', 'node_modules')));
});

test('a failed install is reported, never thrown, with npm\'s own error line', async () => {
  setMode('fail');
  const dir = repo({ '.gitignore': 'node_modules/\n', 'package-lock.json': LOCK, 'companion/package-lock.json': LOCK });
  const r = await installDeps(dir, cache, { npm });
  assert.deepEqual(r.installed, []);
  assert.deepEqual(r.failed, [{ dir: '', why: 'npm error code EBOOM' }, { dir: 'companion', why: 'npm error code EBOOM' }]);
  const note = depsNote(r)!;
  assert.match(note, /at the root: npm error code EBOOM/);
  assert.match(note, /in companion\/: npm error code EBOOM/);
  assert.match(note, /npm ci/);
});

test('a hung install is cut off at the time limit, and what it never reached says so', async () => {
  setMode('hang');
  const dir = repo({ '.gitignore': 'node_modules/\n', 'package-lock.json': LOCK, 'b/package-lock.json': LOCK });
  const r = await installDeps(dir, cache, { npm, timeoutMs: 500 });
  assert.deepEqual(r.installed, []);
  assert.match(r.failed[0].why, /^cut off after/);
  assert.deepEqual(r.failed[1], { dir: 'b', why: 'not tried: the time for installs ran out' });
});

test('an install that ignores TERM is killed with its scripts, so the lane is freed', async () => {
  setMode('stubborn');
  rmSync(join(fake, 'grandchild'), { force: true });
  const dir = repo({ '.gitignore': 'node_modules/\n', 'package-lock.json': LOCK });
  const r = await installDeps(dir, cache, { npm, timeoutMs: 500, graceMs: 200 });
  assert.match(r.failed[0].why, /^cut off after/);
  const kid = Number(readFileSync(join(fake, 'grandchild'), 'utf8')); // raw-read-ok: a pid the fake wrote before it hung
  const alive = () => {
    try {
      process.kill(kid, 0);
      return true;
    } catch {
      return false;
    }
  };
  await until('the install script it started is gone', () => !alive());
});

// Through the server: the first turn starts after the install, with node_modules there, and a failed install still
// starts the turn, with held mail saying so. The fake claude logs whether node_modules was there and what it was told.
test('a new minion\'s first turn waits for the install, and starts when it fails', async () => {
  const home = join(root, 'srv');
  mkdirSync(home);
  const turns = join(root, 'turns.log');
  const claude = join(root, 'claude-fake');
  writeFileSync(claude, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(turns)}, JSON.stringify({ cwd: process.cwd(), modules: fs.existsSync('node_modules') }) + '\\n');
process.stdin.on('data', (d) => fs.appendFileSync(${JSON.stringify(turns)}, JSON.stringify({ cwd: process.cwd(), said: String(d) }) + '\\n'));
setInterval(() => {}, 1000);
`);
  chmodSync(claude, 0o755);
  const code = repo({ '.gitignore': 'node_modules/\n', 'package.json': '{}', 'package-lock.json': LOCK });
  const srv = await bootServer({ root: home, env: { HOME: root, CLAUDE_BIN: claude, CITADEL_HEAVY_UNIT: '0', PATH: `${join(fake, 'bin')}:${process.env.PATH}` } });
  const log = (): any[] => jsonLines(turns);
  try {
    const scheme = await srv.call('/api/projects', { name: 'Deps', source: 'folder', folder: code });
    assert.equal(scheme.status, 201, JSON.stringify(scheme.data));
    const minion = async (message: string) => {
      const r = await srv.call(`/api/projects/${scheme.data.id}/tickets`, { message });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      const t = r.data.ticket ?? r.data;
      await until('its first turn', () => log().some((e) => e.cwd === t.cwd && 'modules' in e));
      return t;
    };
    setMode('ok');
    const ok = await minion('first');
    assert.equal(log().find((e) => e.cwd === ok.cwd && 'modules' in e).modules, true, 'node_modules was there when the turn began');
    assert.ok(calls().some((c) => c.cwd === ok.cwd && c.cache === join(srv.data, 'projects', '.build-cache', 'npm')));

    setMode('fail');
    const failed = await minion('second');
    assert.equal(log().find((e) => e.cwd === failed.cwd && 'modules' in e).modules, false);
    await until('the note in its turn', () => log().some((e) => e.cwd === failed.cwd && /npm error code EBOOM/.test(e.said ?? '')));
  } finally {
    await srv.stop();
  }
});
