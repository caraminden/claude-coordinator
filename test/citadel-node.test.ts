// ananicy-cpp's stock `node` rule puts any process exec'd as `node` at SCHED_IDLE (#506, deploy/priority.md).
// It goes by the basename of argv[0], so these check that the name, never the scheduler: no ananicy needed.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
import { execFileSync } from 'node:child_process';
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
