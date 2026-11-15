import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCRIPT_ENV, scriptEnv } from './script-env.ts';

const root = join(import.meta.dirname, '..');
const tools = join(root, 'tools');

test('scriptEnv drops every variable the scripts export and keeps the rest', () => {
  for (const name of SCRIPT_ENV) process.env[name] = 'leaked';
  process.env.SCRIPT_ENV_KEEP = 'yes';
  try {
    const env = scriptEnv({ EXTRA: 'x' });
    for (const name of SCRIPT_ENV) assert.equal(env[name], undefined, `${name} leaked`);
    assert.equal(env.SCRIPT_ENV_KEEP, 'yes');
    assert.equal(env.EXTRA, 'x');
  } finally {
    for (const name of SCRIPT_ENV) delete process.env[name];
    delete process.env.SCRIPT_ENV_KEEP;
  }
});

test("scriptEnv drops a person's own DEPLOY_*, LAND_* and CITADEL_HEAVY_* knobs, and extra can still set them", () => {
  const knobs = { DEPLOY_BACKUPS: '5', LAND_CI_TIMEOUT: '1', CITADEL_HEAVY_SLOTS: '1' };
  Object.assign(process.env, knobs);
  try {
    const env = scriptEnv();
    for (const name of Object.keys(knobs)) assert.equal(env[name], undefined, `${name} leaked`);
    const set = scriptEnv({ DEPLOY_BACKUPS: '2', LAND_CI_TIMEOUT: '9' });
    assert.equal(set.DEPLOY_BACKUPS, '2');
    assert.equal(set.LAND_CI_TIMEOUT, '9');
    assert.equal(set.CITADEL_HEAVY_SLOTS, undefined);
  } finally {
    for (const name of Object.keys(knobs)) delete process.env[name];
  }
});

test('the list covers everything the scripts export or pass to a child by assignment', () => {
  const found = new Set<string>();
  for (const f of readdirSync(tools).filter((n) => n === 'citadel-heavy' || n.endsWith('.sh'))) {
    const text = readFileSync(join(tools, f), 'utf8');
    // `export NAME=...` and `NAME=value command` / `LAND_REBASED=1 exec ...` prefixes on a DEPLOY_/LAND_/CITADEL_ name.
    for (const m of text.matchAll(/^[^#\n]*?(?:\bexport\s+|(?:^|[;&|]\s*|\bif\s+!\s+|\s)(?=(?:DEPLOY|LAND|CITADEL)_\w+=\S+\s+[./"$\w]))((?:DEPLOY|LAND|CITADEL)_\w+)=/gm)) found.add(m[1]);
  }
  // CITADEL_NODE and NODE_OPTIONS come from citadel-node, which every test already runs under on purpose.
  found.delete('CITADEL_NODE');
  for (const name of found) assert.ok((SCRIPT_ENV as readonly string[]).includes(name), `tools/ sets ${name} for its children: add it to SCRIPT_ENV (test/script-env.ts), or say why not`);
});

// The suites that really run these scripts (the others only name their paths, or stand in for them). A new suite that
// runs one belongs here. Split suites build their env once, in a fixture of their own that they import.
const FIXTURES = ['land-fixture.ts', 'land-recover-fixture.ts', 'scheme-setup-land-fixture.ts'];
const RUNS_SCRIPTS = [
  'land.test.ts', 'land-deploy.test.ts', 'land-queue.test.ts', 'land-recover.test.ts', 'land-boot-check.test.ts', 'deploy.test.ts',
  'run-tests.test.ts', 'run-tests-scope.test.ts', 'scheme-setup-land.test.ts', 'scheme-setup-land-ci.test.ts',
  'scheme-setup-land-lanes.test.ts',
];

test('the suites that start land.sh, deploy.sh or run-tests.sh start them with scriptEnv', () => {
  for (const f of [...FIXTURES, ...RUNS_SCRIPTS]) {
    const text = readFileSync(join(import.meta.dirname, f), 'utf8');
    const from = FIXTURES.includes(f) ? ['script-env.ts'] : ['script-env.ts', ...FIXTURES];
    assert.ok(from.some((m) => text.includes(`from './${m}'`)), `${f} must build its env with scriptEnv (test/script-env.ts)`);
    assert.doesNotMatch(text, /\.\.\.process\.env\b(?![^}]*\bscriptEnv)/, `${f} spreads process.env itself: use scriptEnv()`);
  }
});
