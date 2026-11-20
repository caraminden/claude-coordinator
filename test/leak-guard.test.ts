import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ownedByRun } from './leak-guard.ts';
import { tmpdir } from 'node:os';

const gone = `${tmpdir()}/leak-guard-test-gone-${process.pid}/x`;
const pidOf = (marker: string) => Number(spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim().split('\n')[0]);
const stop = (pid: number) => { try { process.kill(pid, 'SIGKILL'); } catch {} };

test('a process that is not this run\'s, with a live parent of its own, is left alone (#1223)', async () => {
  // A detached shell (reparented to init) starts a child: the child's chain never reaches this run.
  // The parent's own command line splits the marker (a$b), so only the child matches it.
  const marker = `unrelated-${process.pid}`;
  const [a, b] = [marker.slice(0, 5), marker.slice(5)];
  spawn('sh', ['-c', `(a=${a}; b=${b}; sh -c "sleep 30; : $a$b ${gone}" & wait) & sleep 0.1`], { stdio: 'ignore' }).unref();
  await new Promise((r) => setTimeout(r, 500));
  const pid = pidOf(`sleep 30; : ${marker}`);
  try {
    assert.ok(pid > 0, 'the unrelated process started');
    assert.equal(ownedByRun(pid), false);
  } finally { stop(pid); }
});

test('a child of this run, and an orphan it left behind, are this run\'s (#271)', async () => {
  const marker = `child-${process.pid}`;
  const kid = spawn('sh', ['-c', `sleep 30; : ${marker} ${gone}`], { stdio: 'ignore' });
  const marker2 = `orphan-${process.pid}`;
  spawn('sh', ['-c', `(sh -c 'sleep 30; : ${marker2} ${gone}' &) ; sleep 0.1`], { stdio: 'ignore' }).unref();
  await new Promise((r) => setTimeout(r, 500));
  const orphan = pidOf(`sleep 30; : ${marker2}`);
  try {
    assert.equal(ownedByRun(kid.pid!), true);
    assert.equal(ownedByRun(orphan), true);
  } finally { stop(kid.pid!); stop(orphan); }
});
