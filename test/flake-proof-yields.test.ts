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
  assert.match(script, /nice -n 19 bash -c 'while :; do :; done'/);
  assert.match(script, /nice -n 19 "\$here\/citadel-node" --test/);
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
