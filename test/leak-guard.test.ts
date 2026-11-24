import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ownedByRun } from './leak-guard.ts';
import { tmpdir } from 'node:os';

const gone = `${tmpdir()}/leak-guard-test-gone-${process.pid}/x`;
const pidOf = (marker: string) => Number(spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim().split('\n')[0]);
// The shell and the sleep it waits on (#1763: killing the shell alone left the sleep running).
const stop = (pid: number) => {
  spawnSync('pkill', ['-KILL', '-P', String(pid)]);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
};

test("a process that is not this run's, with a live parent of its own, is left alone (#1223)", async () => {
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
  } finally {
    stop(pid);
  }
});

test("a child of this run, and an orphan it left behind, are this run's (#271)", async () => {
  const marker = `child-${process.pid}`;
  const kid = spawn('sh', ['-c', `sleep 30; : ${marker} ${gone}`], { stdio: 'ignore' });
  const marker2 = `orphan-${process.pid}`;
  spawn('sh', ['-c', `(sh -c 'sleep 30; : ${marker2} ${gone}' &) ; sleep 0.1`], { stdio: 'ignore', env: { ...process.env, CITADEL_LEAK_RUN: 'mine' } }).unref();
  await new Promise((r) => setTimeout(r, 500));
  const orphan = pidOf(`sleep 30; : ${marker2}`);
  try {
    assert.equal(ownedByRun(kid.pid!), true);
    assert.equal(ownedByRun(orphan, process.pid, 'mine'), true);
  } finally {
    stop(kid.pid!);
    stop(orphan);
  }
});

test('two runs on one box each own only the orphan that carries their own id', async () => {
  // Detached leftovers (reparented to init), one per run; each has its run's id in its environment, as globalSetup's does.
  const left = (id: string) => {
    spawn('sh', ['-c', `(sh -c 'sleep 30; : orphan-${id}-${process.pid} ${gone}' &) ; sleep 0.1`], { stdio: 'ignore', env: { ...process.env, CITADEL_LEAK_RUN: id } }).unref();
  };
  left('runA');
  left('runB');
  await new Promise((r) => setTimeout(r, 500));
  const [a, b] = [`orphan-runA-${process.pid}`, `orphan-runB-${process.pid}`].map((m) => pidOf(`sleep 30; : ${m}`));
  try {
    assert.ok(a > 0 && b > 0, 'both leftovers started');
    assert.equal(ownedByRun(a, process.pid, 'runA'), true);
    assert.equal(ownedByRun(b, process.pid, 'runA'), false, "run A must not claim run B's leftover");
    assert.equal(ownedByRun(b, process.pid, 'runB'), true);
    assert.equal(ownedByRun(a, process.pid, 'runB'), false);
  } finally {
    stop(a);
    stop(b);
  }
});
