// Shared setup of land-train-early.test.ts and its parts (#2208): the file is split so no one test file sets the suite's length.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { ci, git, seen, setup, landAsync } from './land-fixture.ts';
import { type Ship, line, shared } from './land-train-fixture.ts';
import { until } from './wait.ts';

// Conflict prep (#1366, Cara, 2026-11-20: "we know what main WILL look like, and we can deal with the merge issues before
// we try to ship"): ship 4 waits behind ship 2's train, which carries ship 3, and conflicts with ship 3 in a.txt. While the
// train is tested, land.sh tells it so; its minion records the fix with git rerere in a scratch worktree (prepMessage's
// steps), off its branch; once the train ships, ship 4's real rebase replays the fix and it ships.
// keep: the fix keeps the train's side whole, so ship 4's a.txt commit drops out and only its second commit ships.
export async function prepped(red: boolean, keep = false, early = false) {
  let gate = '';
  const l = await line(
    [{}, {}, { change: ['a.txt', 'three\n'], ...(red ? { also: ['red.txt', 'red\n'] as [string, string] } : {}) }, { change: ['a.txt', 'four\n'], ...(keep ? { also: ['g.txt', 'g\n'] as [string, string] } : {}) }],
    (dir) => ({ ...shared(dir), ...(early ? {} : { LAND_EARLY: '0' }), FAKE_CI_GATE: (gate = join(dir, 'ci-gate')), ...(red ? { FAKE_RED_PATH: 'red.txt' } : {}) }),
    (r) => writeFileSync(join(r.dir, 'ci-gate'), ''), // ship 1's run goes through; the train's waits
  );
  rmSync(gate);
  const all = l.go();
  await until("ship 4's prep line", () => /land: prep: ticket\/4-x will conflict/.test(l.out[3]));
  const m = /land: prep: ticket\/4-x will conflict with ticket\/3-x once ticket\/2-x's ship train ships; conflicted files: a\.txt; record the fix against ([0-9a-f]{40}) from ([0-9a-f]{40}) to ([0-9a-f]{40})$/m.exec(l.out[3]);
  assert.ok(m, l.out[3]);
  assert.equal(m[3], l.was[3], "ship 4's own head");
  // What the minion runs, in a scratch worktree of its own.
  const wt = join(l.r.dir, 'train-prep');
  git(l.wts[3], 'worktree', 'add', '-q', '--detach', wt, m[1]);
  assert.throws(() => git(wt, '-c', 'rerere.enabled=true', 'cherry-pick', `${m[2]}..${m[3]}`));
  writeFileSync(join(wt, 'a.txt'), keep ? 'three\n' : 'three\nfour\n');
  git(wt, 'add', 'a.txt');
  if (keep) {
    assert.throws(() => git(wt, '-c', 'rerere.enabled=true', '-c', 'core.editor=true', 'cherry-pick', '--continue'), 'nothing to commit');
    git(wt, '-c', 'rerere.enabled=true', 'rerere');
    git(wt, 'cherry-pick', '--skip');
  } else git(wt, '-c', 'rerere.enabled=true', '-c', 'core.editor=true', 'cherry-pick', '--continue');
  git(l.wts[3], 'worktree', 'remove', '--force', wt);
  assert.equal(git(l.r.source, 'rev-parse', 'ticket/4-x'), l.was[3], 'its branch is as it was');
  await until('the fix is seen', () => /land: prep: ticket\/4-x conflicts with ticket\/3-x on ticket\/2-x's ship train \(a\.txt\), but the fix recorded ahead of time \(git rerere\) resolves it/.test(l.out[3]));
  writeFileSync(gate, '');
  return { l, done: await all };
}

// Early next train (#1366, #1568): while a train's CI runs, the ship next in line and the train it would take are stacked
// on its top and pushed to CI once that run has a runner. LAND_TRAIN_MAX=1: ship 2 takes ship 3, and ship 4 is next, with ship 5.
export const retro = (dir: string, what: string) => {
  const log = join(dir, 'shared', 'retro-log');
  return readFileSync(join(log, readdirSync(log)[0], 'land.md'), 'utf8')
    .split('\n')
    .filter((x) => x.includes(what))
    .map((x) => x.replace(/^- \S+ · /, '').replace(/\(([0-9a-f]{7,})\)|[0-9a-f]{7,}$/g, 'sha'));
};

// A ship's own check (#1567, tools/own-check.sh; Cara, 2026-11-22, A "Gated, after C and B"): with someone in line and
// the check runner online, a ship's CI runs on that runner before it joins the line.
export const own = (d: string) => ({ ...shared(d), FAKE_CHECK_RUNNERS: '1', LAND_OWN_CHECK_POLL: '0.05' });

export const pushLog = (r: ReturnType<typeof setup>) => writeFileSync(join(r.dir, 'hub.git', 'hooks', 'post-receive'), `#!/bin/sh\nwhile read -r old new ref; do echo "$new $ref" >>'${join(r.dir, 'pushes')}'; done\n`, { mode: 0o755 });

export const pushes = (dir: string) => (existsSync(join(dir, 'pushes')) ? readFileSync(join(dir, 'pushes'), 'utf8').trim().split('\n') : []);

export const holdOn = (r: ReturnType<typeof setup>) => rmSync(join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy', 'hold-off'));

// Ship 2, landed while ship 1 holds the line in its deploy; ship 2 is refused before it gets a ticket, so line() can't wait for it.
export async function refusedBehind(change: [string, string], extra: Record<string, string>, before: (r: ReturnType<typeof setup>) => void = () => {}) {
  const l = await line(
    [{}],
    (d) => ({ ...own(d), ...extra }),
    (r) => (pushLog(r), before(r)),
  );
  const wt = join(l.r.dir, 'wt2');
  git(l.r.source, 'worktree', 'add', '-q', '-b', 'ticket/2-x', wt);
  l.r.commit(wt, ...change);
  const d = await landAsync(wt, l.env, 150_000, () => {}); // (with no callback it keeps no stderr)
  const [first] = await l.go();
  assert.equal(first.status, 0, first.stderr);
  return { l, d };
}

// The light check (#1620, tools/light-check.sh; Cara, 2026-11-22, "Fill #1567's gap"): a ship sent away by a busy check
// runner runs its own and affected test files on CI's side runner instead. heavy-ci.ts is faked: the fake logs where and
// how it was called, and prints FAKE_LIGHT_OUT as the run's output.
export function busyCheck(r: ReturnType<typeof setup>) {
  const state = join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'own-check-run'), `${Math.floor(Date.now() / 1000)} ticket/9-x\n`);
  writeFileSync(join(state, 'own-check-secs'), '1000\n');
  writeFileSync(
    join(r.dir, 'bin', 'fake-heavy'),
    `#!/usr/bin/env bash
{ echo "pwd $(pwd)"; echo "head $(git rev-parse HEAD)"; echo "ship \${CITADEL_HEAVY_SHIP:-}"; echo "github \${CITADEL_HEAVY_GITHUB:-}"; echo "args $*"; echo "log $(git log --format=%s -3 | tr '\\n' '|')"; } >>"${join(r.dir, 'heavy-calls')}"
# FAKE_QUEUED: the seconds it waited for a runner; FAKE_NO_RUNNER: heavy-ci.ts's no-runner exit, with that reason.
[ -z "\${FAKE_QUEUED:-}" ] || echo "$FAKE_QUEUED" >"$CITADEL_HEAVY_QUEUED_FILE"
[ -z "\${FAKE_NO_RUNNER:-}" ] || { echo "$FAKE_NO_RUNNER" >"$CITADEL_HEAVY_FALLBACK_FILE"; exit 120; }
printf '%b\\n' "\${FAKE_LIGHT_OUT:-light check: green}"
`,
    { mode: 0o755 },
  );
  return spawn('flock', [join(state, 'own-check.lock'), 'cat'], { stdio: ['pipe', 'ignore', 'ignore'] });
}

export const light = (d: string) => ({ ...own(d), FAKE_SIDE_RUNNERS: '1', LAND_LIGHT_CHECK_HEAVY: join(d, 'bin', 'fake-heavy') });

export const heavyCalls = (dir: string) => (existsSync(join(dir, 'heavy-calls')) ? readFileSync(join(dir, 'heavy-calls'), 'utf8') : '');

export const lockHeld = (state: string) => spawnSync('flock', ['-n', join(state, 'own-check.lock'), 'true']).status === 1;
