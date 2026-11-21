import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { scriptEnv } from './script-env.ts';
import { HEAVY_SHIMS } from '../src/turn-launch.ts';

// tools/heavy-shim (#1298): a heavy command a turn types, or a script or `mise exec` calls, goes through heavy-unit by
// PATH alone. Laid out as a turn's pin/bin: heavy-unit and heavy-shim, and heavy/<cmd> links to ../heavy-shim.
const tools = join(import.meta.dirname, '..', 'tools');
const root = mkdtempSync(join(tmpdir(), 'heavy-shim-'));
after(() => rmSync(root, { recursive: true, force: true }));
const bin = join(root, 'bin');
mkdirSync(join(bin, 'heavy'), { recursive: true });
for (const t of ['heavy-unit', 'heavy-shim']) symlinkSync(join(tools, t), join(bin, t));
for (const c of HEAVY_SHIMS) symlinkSync('../heavy-shim', join(bin, 'heavy', c));
// The real tools, further down PATH: each says where it ran (its OOM score: heavy-unit sets 1000; its cgroup).
const real = join(root, 'real');
const miseDir = join(root, 'mise-installs');
mkdirSync(real);
mkdirSync(miseDir);
const report = (name: string) => `#!/bin/sh\necho "${name} $(cat /proc/self/oom_score_adj) $(sed -n 's/^0:://p' /proc/self/cgroup) $*"\n`;
const tool = (dir: string, name: string, body: string) => {
  writeFileSync(join(dir, name), body);
  chmodSync(join(dir, name), 0o755);
};
for (const c of ['node', 'make']) tool(real, c, report(c));
// A cargo that runs $THEN when it's set, as a build script runs make.
tool(real, 'cargo', `${report('cargo')}[ -z "$THEN" ] || $THEN\n`);
// mise exec puts its own installs first on PATH, past the shims, as the real one does.
tool(real, 'mise', `#!/bin/sh\n[ "$1" = exec ] || { echo "mise $*"; exit 0; }\nshift; while [ "$1" != -- ]; do shift; done; shift\nPATH="${miseDir}:$PATH" exec "$@"\n`);
tool(miseDir, 'cargo', report('mise-cargo'));
const PATH = `${join(bin, 'heavy')}:${bin}:${real}:${process.env.PATH}`;
const run = (cmd: string, env: Record<string, string> = {}) => spawnSync('sh', ['-c', cmd], { env: scriptEnv({ PATH, ...env }), encoding: 'utf8' });
const lines = (out: string) => out.trim().split('\n').map((l) => l.split(' '));

test('every shim is a command a turn may type, once', () => {
  assert.equal(new Set(HEAVY_SHIMS).size, HEAVY_SHIMS.length);
  assert.ok(['cargo', 'npm', 'tsc', 'godot', 'mise', 'chromium'].every((c) => HEAVY_SHIMS.includes(c)));
});

test('cargo, typed or in a script or under mise exec, goes through heavy-unit', () => {
  const env = { CITADEL_HEAVY_UNIT: '0' };
  assert.deepEqual(lines(run('cargo test -p core', env).stdout)[0].slice(0, 2), ['cargo', '1000']);
  tool(root, 'check.sh', '#!/bin/sh\ncargo clippy\n');
  assert.deepEqual(lines(run(`${join(root, 'check.sh')}`, env).stdout)[0].slice(0, 2), ['cargo', '1000']);
  assert.deepEqual(lines(run('mise exec -- cargo test', env).stdout)[0].slice(0, 2), ['mise-cargo', '1000']);
});

test('node and mise pass through unless they run tests or tools', () => {
  const env = { CITADEL_HEAVY_UNIT: '0' };
  const mine = readFileSync('/proc/self/oom_score_adj', 'utf8').trim();
  assert.deepEqual(lines(run('node hook.js', env).stdout)[0].slice(0, 2), ['node', mine]);
  assert.deepEqual(lines(run('node --test a.test.ts', env).stdout)[0].slice(0, 2), ['node', '1000']);
  assert.deepEqual(lines(run('node hook.js --test', env).stdout)[0].slice(0, 2), ['node', mine], "the script's own --test");
  assert.equal(run('mise which cargo', env).stdout, 'mise which cargo\n');
});

test('a command not past the shims says so, as the shell would', () => {
  // Only the shims and heavy-unit on PATH: this box may have a real godot.
  const r = spawnSync(join(bin, 'heavy', 'godot'), ['--headless'], { env: scriptEnv({ PATH: `${join(bin, 'heavy')}:${bin}:/usr/bin:/bin` }), encoding: 'utf8' });
  assert.equal(r.status, 127);
  assert.match(r.stderr, /godot: command not found/);
});

const inContainer = existsSync('/run/.containerenv') || existsSync('/.dockerenv');
const userSystemd = !inContainer && spawnSync('systemd-run', ['--user', '--scope', '--quiet', '--expand-environment=no', 'true']).status === 0;
const heavySlice = `citadel-heavy-hs${process.pid}.slice`;
after(() => {
  if (userSystemd) spawnSync('systemctl', ['--user', 'stop', heavySlice]);
});

test('on systemd, cargo runs in a scope of the heavy slice, and what it runs stays in that scope', { skip: !userSystemd && 'no user systemd here' }, () => {
  const out = lines(run('cargo build', { CITADEL_HEAVY_SLICE: heavySlice, THEN: 'make' }).stdout);
  const [cargo, make] = out;
  assert.match(cargo[2], new RegExp(`/${heavySlice}/citadel-heavy-\\d+-\\d+\\.scope$`));
  assert.equal(make[2], cargo[2], 'make, run by cargo, needs no scope of its own');
});
