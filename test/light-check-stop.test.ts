// A light check stopped mid-run (#2265): its TERM trap must remove the worktree and .out whatever `wait` returns, under
// land.sh's set -e (the killed run's nonzero wait once ended the trap before light_check_done).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, makeRepo } from './git.ts';
import { until } from './wait.ts';

const lightCheck = join(import.meta.dirname, '..', 'tools', 'light-check.sh');

test('a light check stopped mid-run leaves no worktree or .out behind and exits 143 (#2265)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'light-check-stop-'));
  try {
    const repo = join(dir, 'repo');
    const tmp = join(dir, 'tmp');
    const tools = join(dir, 'tools');
    for (const d of [repo, tmp, tools, join(dir, 'state')]) mkdirSync(d);
    makeRepo(repo);
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'a');
    // lane.sh: not light. The heavy command: runs `bash tools/light-check-run.sh <main>`, here a long sleep.
    writeFileSync(join(tools, 'lane.sh'), '#!/bin/bash\necho full\n');
    writeFileSync(join(tools, 'fake-heavy'), '#!/bin/bash\ntouch "$FAKE_STARTED"\nsleep 60\n');
    chmodSync(join(tools, 'lane.sh'), 0o755);
    chmodSync(join(tools, 'fake-heavy'), 0o755);
    const started = join(dir, 'started');
    const driver = `set -e
say() { echo "$*" >&2; }
retro_log() { :; }
own_hub() { echo 1; }
numbers_git() { shift; git "$@"; }
rerere_on() { :; }
under_of() { :; }
rr=()
state=${JSON.stringify(join(dir, 'state'))} tools=${JSON.stringify(tools)} branch=x label=x
source ${JSON.stringify(lightCheck)}
light_check owner/repo
`;
    const child = spawn('bash', ['-c', driver], {
      cwd: repo,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, TMPDIR: tmp, LAND_LIGHT_CHECK_HEAVY: join(tools, 'fake-heavy'), FAKE_STARTED: started },
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const closed = new Promise<number | null>((r) => child.on('close', r));
    await until('the light check runs', () => readdirSync(dir).includes('started'));
    assert.ok(
      readdirSync(tmp).some((f) => f.startsWith('land-light-check.')),
      'the worktree exists while it runs',
    );
    child.kill('SIGTERM');
    assert.equal(await closed, 143, stderr);
    assert.deepEqual(readdirSync(tmp), [], 'no land-light-check.* worktree or .out left');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
