// ananicy-cpp's stock `node` rule puts any process exec'd as `node` at SCHED_IDLE (#506, deploy/priority.md).
// It goes by the basename of argv[0], so these check that the name, never the scheduler: no ananicy needed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { TURN_NODE } from '../src/turn-launch.ts';
import { testPins } from './helpers.ts';

const argv0 = 'process.stdout.write(process.argv0)';

test("a turn's node link runs node under a name that isn't node", () => {
  const link = join(testPins().MCP_DIR, 'bin', TURN_NODE);
  assert.equal(realpathSync(link), realpathSync(process.execPath));
  const name = execFileSync(link, ['-e', argv0], { encoding: 'utf8' });
  assert.notEqual(basename(name), 'node');
});

test('tools/citadel-node runs node --test, and the test files it starts, under a name that is not node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'citadel-node-'));
  try {
    mkdirSync(join(dir, 't'));
    const out = join(dir, 'names.json');
    writeFileSync(join(dir, 't', 'a.test.mjs'), `import { writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
const child = execFileSync(process.execPath, ['-e', ${JSON.stringify(argv0)}], { encoding: 'utf8' });
writeFileSync(${JSON.stringify(out)}, JSON.stringify({ file: process.argv0, child }));
`);
    const env: Record<string, string | undefined> = { ...process.env, TMPDIR: dir, CITADEL_NODE: undefined, NODE_OPTIONS: undefined, NODE_TEST_CONTEXT: undefined };
    execFileSync(join(import.meta.dirname, '..', 'tools', 'citadel-node'), ['--test', 't/'], { cwd: dir, env, stdio: 'pipe' });
    const names = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(basename(names.file), 'citadel-node');
    assert.equal(basename(names.child), 'citadel-node');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// With no TMPDIR the link's folder is a guessable name in /tmp, where another user can make it first (ultra review A7).
test('tools/citadel-node makes its link folder private, and refuses one that is a link to somewhere else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'citadel-node-'));
  try {
    const env: Record<string, string | undefined> = { ...process.env, TMPDIR: dir, CITADEL_NODE: undefined, NODE_OPTIONS: undefined, NODE_TEST_CONTEXT: undefined };
    const run = () => spawnSync(join(import.meta.dirname, '..', 'tools', 'citadel-node'), ['-e', argv0], { env, encoding: 'utf8' });
    const own = join(dir, `citadel-node-${process.getuid!()}`);
    const made = run();
    assert.equal(basename(made.stdout), 'citadel-node', made.stderr);
    assert.equal(statSync(own).mode & 0o777, 0o700);
    // One left by an older run, open to the group, is closed.
    chmodSync(own, 0o775);
    assert.equal(run().status, 0);
    assert.equal(statSync(own).mode & 0o777, 0o700);
    rmSync(own, { recursive: true });
    mkdirSync(join(dir, 'theirs'));
    symlinkSync(join(dir, 'theirs'), own);
    const r = run();
    assert.notEqual(r.status, 0);
    assert.equal(r.stdout, '', 'node never ran');
    assert.match(r.stderr, /citadel-node: .*citadel-node-\d+ is not a folder of this user's own/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools/citadel-node sets a compile cache under TMPDIR, keeps a caller\'s own, and an edited file at the same path runs its new code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'citadel-node-cc-'));
  try {
    const bin = join(import.meta.dirname, '..', 'tools', 'citadel-node');
    const run = (args: string[], extra: Record<string, string> = {}) =>
      spawnSync(bin, args, { env: { ...process.env, TMPDIR: dir, NODE_COMPILE_CACHE: '', ...extra }, encoding: 'utf8' });
    const show = 'process.stdout.write(process.env.NODE_COMPILE_CACHE ?? "")';
    assert.equal(run(['-e', show]).stdout, join(dir, 'citadel-node-cache'));
    assert.equal(run(['-e', show], { NODE_COMPILE_CACHE: '/x/mine' }).stdout, '/x/mine');
    const file = join(dir, 'm.ts');
    writeFileSync(file, 'const n: number = 1; process.stdout.write(String(n));');
    assert.equal(run([file]).stdout, '1');
    assert.equal(run([file]).stdout, '1');
    writeFileSync(file, 'const n: number = 2; process.stdout.write(String(n));');
    assert.equal(run([file]).stdout, '2');
    // An unwritable cache folder changes nothing but speed.
    writeFileSync(join(dir, 'blocker'), '');
    const bad = run([file], { NODE_COMPILE_CACHE: join(dir, 'blocker', 'cache') });
    assert.equal(bad.status, 0, bad.stderr);
    assert.equal(bad.stdout, '2');
  } finally {
    rmSync(dir, { recursive: true, force: true }); // timing-ok: own temp dir
  }
});
