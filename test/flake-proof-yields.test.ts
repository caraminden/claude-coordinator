import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { cleanRuns } from '../src/flakes.ts';

// A flake proof gives ships the CPU (#1359): it waits while a ship's tests run is going, and what it starts is nice 19.
const root = join(import.meta.dirname, '..');
const script = readFileSync(join(root, 'tools/flake-proof.sh'), 'utf8');
const yml = readFileSync(join(root, '.github/workflows/flake-proof.yml'), 'utf8');

test('burners and test runs start under nice -n 19', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-nice-'));
  writeFileSync(join(dir, 'nice'), `#!/usr/bin/env bash\necho "nice $*" >>${dir}/log\nshift 2\nexec "$@"\n`);
  chmodSync(join(dir, 'nice'), 0o755);
  writeFileSync(join(dir, 'x.test.ts'), "import { test } from 'node:test'; test('ok', () => {});\n");
  const r = spawnSync('bash', [join(root, 'tools/flake-proof.sh'), join(dir, 'x.test.ts'), '1', '1'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: '' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = readFileSync(join(dir, 'log'), 'utf8').trim().split('\n');
  assert.ok(lines.some((l) => l.startsWith('nice -n 19 bash -c')), 'the burner is niced');
  assert.ok(lines.some((l) => /^nice -n 19 .*citadel-node --test/.test(l)), 'the test run is niced');
});

test('a batch runs its copies at once (#1443), each in its own TMPDIR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-copies-'));
  // each copy (not the skip check's run before them) logs its TMPDIR, then waits for all three to have started: run one after another, it would time out
  writeFileSync(join(dir, 'nice'), `#!/usr/bin/env bash\nshift 2\ncase "$TMPDIR $*" in ${dir}/burn-in.*citadel-node*) echo "$TMPDIR" >>${dir}/dirs; for i in $(seq 100); do [ "$(wc -l <${dir}/dirs)" -ge 3 ] && break; sleep 0.05; done; [ "$(wc -l <${dir}/dirs)" -ge 3 ] || exit 9;; esac\nexec "$@"\n`);
  chmodSync(join(dir, 'nice'), 0o755);
  writeFileSync(join(dir, 'x.test.ts'), "import { test } from 'node:test'; test('ok', () => {});\n");
  // The copies' folders go under dir (RUNNER_TEMP), so a TMPDIR already holding "burn-in." (this file burned in) can't pass for one.
  const r = spawnSync('bash', [join(root, 'tools/flake-proof.sh'), join(dir, 'x.test.ts'), '3', '1'], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: '', RUNNER_TEMP: dir }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(new Set(readFileSync(join(dir, 'dirs'), 'utf8').trim().split('\n')).size, 3, 'three copies, three TMPDIRs');
});

test("the workflow's token may read the run list the wait asks for", () => {
  assert.match(yml, /^permissions:\n  contents: read\n  actions: read/m);
});

test('every batch step passes the token the wait reads, and keeps a name cleanRuns counts', () => {
  const names = [...yml.matchAll(/- name: (\d+ clean runs[^\n]*)/g)].map((m) => m[1]);
  assert.equal(names.length, 5);
  assert.equal(yml.match(/run: tools\/flake-proof\.sh/g)?.length, 5);
  assert.equal(yml.match(/GH_TOKEN: '\$\{\{ github\.token \}\}'/g)?.length, 5);
  const steps = names.map((name) => ({ name, conclusion: 'success' }));
  assert.equal(cleanRuns(steps.slice(0, 3), null), 30);
});

function run(counts: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-'));
  // A fake curl: answers a busy count for the first looks, then 0; the call count lives in a file.
  const fake = join(dir, 'curl');
  writeFileSync(join(dir, 'n'), '0');
  writeFileSync(fake, `#!/usr/bin/env bash\nn=$(cat ${dir}/n); echo $((n+1)) >${dir}/n\nc=(${counts.join(' ')})\nv=\${c[$n]:-0}\nif [ "$v" = fail ]; then exit 22; fi\necho "{\\"total_count\\": $v}"\n`);
  chmodSync(fake, 0o755);
  const r = spawnSync('bash', [join(root, 'tools/flake-proof.sh'), 'test/none.test.ts', '0', '0'], {
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GH_TOKEN: 't', GITHUB_REPOSITORY: 'a/b', FLAKE_PROOF_WAIT_SLEEP: '0', FLAKE_PROOF_WAIT_LOOKS: '3' },
    encoding: 'utf8',
  });
  return r.stdout + r.stderr;
}

test('it waits while a ship run is queued, then starts', () => {
  // look 1: queued 1, in_progress 0; look 2: both 0
  const out = run(['1', '0', '0', '0']);
  assert.match(out, /1 ship run\(s\) queued or running/);
  assert.match(out, /no ship's tests are running: starting the batch/);
});

test('an unreadable GitHub counts as a ship running, and it gives up after the looks', () => {
  const out = run(['fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail']);
  assert.match(out, /could not read/);
  assert.match(out, /starting anyway, niced/);
});

// CB2 (#1519): a proof where a test skipped proves nothing, so the batch fails; and the workflow installs pwsh before the
// batches, as tests.yml does, so the .ps1 lint runs rather than skips.
test('a batch fails when the file skipped a test, and the workflow installs pwsh before its batches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-skip-'));
  writeFileSync(join(dir, 'x.test.ts'), "import { test } from 'node:test'; test('ok', () => {}); test('needs a tool', { skip: 'no tool' }, () => {});\n");
  const r = spawnSync('bash', [join(root, 'tools/flake-proof.sh'), join(dir, 'x.test.ts'), '1', '0'], { env: { ...process.env, GH_TOKEN: '' }, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /skipped a test on this runner/);
  assert.doesNotMatch(r.stdout, /clean runs at once/);
  const pwsh = yml.indexOf('- name: pwsh and PSScriptAnalyzer'), batch = yml.indexOf('- name: 10 clean runs (1 of 5)');
  assert.ok(pwsh > 0 && pwsh < batch, 'the pwsh step comes before the first batch');
});
