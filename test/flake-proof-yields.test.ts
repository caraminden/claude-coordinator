import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { cleanRuns } from '../src/flakes.ts';

// A flake proof gives ships the CPU (#1359): its run asks Citadel first (#1902: test/ci-hold-ask.test.ts), and what it starts is nice 19.
const root = join(import.meta.dirname, '..');
const script = readFileSync(join(root, 'tools/flake-proof.sh'), 'utf8');
const yml = readFileSync(join(root, '.github/workflows/flake-proof.yml'), 'utf8');

test('burners and test runs start under nice -n 19', () => {
  // CITADEL_HEAVY_HELD: off CI the burn-in queues for a heavy slot (#1725); here it runs as if already holding one.
  const dir = mkdtempSync(join(tmpdir(), 'fp-nice-'));
  writeFileSync(join(dir, 'nice'), `#!/usr/bin/env bash\necho "nice $*" >>${dir}/log\nshift 2\nexec "$@"\n`);
  chmodSync(join(dir, 'nice'), 0o755);
  writeFileSync(join(dir, 'x.test.ts'), "import { test } from 'node:test'; test('ok', () => {});\n");
  const r = spawnSync('bash', [join(root, 'tools/flake-proof.sh'), join(dir, 'x.test.ts'), '1', '1'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, CITADEL_HEAVY_HELD: '1' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n');
  assert.ok(
    lines.some((l) => l.startsWith('nice -n 19 bash -c')),
    'the burner is niced',
  );
  assert.ok(
    lines.some((l) => /^nice -n 19 .*citadel-node --test/.test(l)),
    'the test run is niced',
  );
});

test('a batch runs its copies at once (#1443), each in its own TMPDIR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-copies-'));
  // each copy (not the skip check's run before them) logs its TMPDIR, then waits for all three to have started: run one after another, it would time out
  writeFileSync(join(dir, 'nice'), `#!/usr/bin/env bash\nshift 2\ncase "$TMPDIR $*" in ${dir}/burn-in.*citadel-node*) echo "$TMPDIR" >>${dir}/dirs; for i in $(seq 100); do [ "$(wc -l <${dir}/dirs)" -ge 3 ] && break; sleep 0.05; done; [ "$(wc -l <${dir}/dirs)" -ge 3 ] || exit 9;; esac\nexec "$@"\n`);
  chmodSync(join(dir, 'nice'), 0o755);
  writeFileSync(join(dir, 'x.test.ts'), "import { test } from 'node:test'; test('ok', () => {});\n");
  // The copies' folders go under dir (RUNNER_TEMP), so a TMPDIR already holding "burn-in." (this file burned in) can't pass for one.
  const r = spawnSync('bash', [join(root, 'tools/flake-proof.sh'), join(dir, 'x.test.ts'), '3', '1'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(new Set(readFileSync(join(dir, 'dirs'), 'utf8').trim().split('\n')).size, 3, 'three copies, three TMPDIRs');
});

test('off CI a batch above 4 copies is refused before any burner starts, not reported clean (#1725)', () => {
  const env = { ...process.env, RUNNER_TEMP: '', CI: '', GITHUB_ACTIONS: '' };
  const r = spawnSync('bash', [join(root, 'tools/flake-proof.sh'), 'test/none.test.ts', '10', '1'], { env, encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /^flake-proof: 10 copies at once is a CI batch/m);
  assert.doesNotMatch(r.stdout, /clean runs|starting the batch|not waiting/, 'nothing ran');
});

// Deploys first (#1902): the run asks Citadel before anything else, so a held proof gives its runner back.
test('the workflow asks Citadel whether ships go first before it sets anything up, and no batch waits on the runner', () => {
  const ask = yml.indexOf('run: node tools/ci-hold-ask.ts');
  assert.ok(ask > yml.indexOf('actions/setup-node') && ask < yml.indexOf('- name: pwsh and PSScriptAnalyzer'), 'right after node');
  assert.match(yml, /^permissions:\n  contents: read\n  id-token: write/m, "with the run's own token");
  assert.doesNotMatch(script, /wait_for_ships|GH_TOKEN/);
});

test('every batch step keeps a name cleanRuns counts', () => {
  const names = [...yml.matchAll(/- name: (\d+ clean runs[^\n]*)/g)].map((m) => m[1]);
  assert.ok(names.length > 0);
  assert.equal(yml.match(/run: tools\/flake-proof\.sh/g)?.length, names.length);
  const steps = names.map((name) => ({ name, conclusion: 'success' }));
  assert.equal(cleanRuns(steps.slice(0, 3), null), 30);
});

// CB2 (#1519): a proof where a test skipped proves nothing, so the batch fails; and the workflow installs pwsh before the
// batches, as tests.yml does, so the .ps1 lint runs rather than skips.
test('a batch fails when the file skipped a test, and the workflow installs pwsh before its batches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-skip-'));
  writeFileSync(join(dir, 'x.test.ts'), "import { test } from 'node:test'; test('ok', () => {}); test('needs a tool', { skip: 'no tool' }, () => {});\n");
  const r = spawnSync('bash', [join(root, 'tools/flake-proof.sh'), join(dir, 'x.test.ts'), '1', '0'], { env: { ...process.env }, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /skipped a test on this runner/);
  assert.doesNotMatch(r.stdout, /clean runs at once/);
  const pwsh = yml.indexOf('- name: pwsh and PSScriptAnalyzer'),
    batch = yml.indexOf('- name: 10 clean runs (1 of 5)');
  assert.ok(pwsh > 0 && pwsh < batch, 'the pwsh step comes before the first batch');
});
