// Shared setup of land-train-riders.test.ts and its parts (#2208): the file is split so no one test file sets the suite's length.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { git, setup, quietProc } from './land-fixture.ts';
import { line, shared } from './land-train-fixture.ts';
import { until } from './wait.ts';

// #1479: the guard tests (land.sh's guards(), #1240) on the train, not just its front. On Nov 21, 03:46 to 04:20 PST,
// #1460 rode trains with a break of the one-until guard that passed on its front in 1 s, and it took 6 CI runs to
// refuse it. A stand-in citadel-test: the guard run (the one naming the one-until guard) fails on a commit whose
// test/loop-lag.test.ts says "sleep", and logs "guard <commit> <exit>" for each guard run into the fake gh's call log,
// so a test can see whether a commit's guard run came before CI was asked about it.
// Built, not quoted: a quoted test file's name reads as a dependency to test/pipeline-files.test.ts.

export const oneUntil = `test/${'one-until'}.test.ts`;

export function guarded(r: ReturnType<typeof setup>) {
  mkdirSync(join(r.source, 'test'), { recursive: true });
  writeFileSync(
    join(r.source, 'tools', 'citadel-test'),
    `#!/usr/bin/env bash
case " $* " in *" ${oneUntil} "*) ;; *) exit 0 ;; esac
rc=0
if [ -n "\${GUARD_SLOW:-}" ] && [ -e f4.txt ]; then sleep "$GUARD_SLOW"; fi # a train with ship 4 on it
! grep -qs sleep test/loop-lag.test.ts || { echo "✖ ${oneUntil}:22 › loop-lag.test.ts has 5 \\\`sleep\\\` hits, the baseline allows 3"; echo "full output: /somewhere/citadel-test.log"; rc=1; }
if [ "$rc" = 1 ] && [ -n "\${GUARD_LATE:-}" ] && [ ! -e "$GUARD_LATE" ]; then : >"$GUARD_LATE"; rc=124; fi
echo "guard $(git rev-parse HEAD) $rc" >>"$GUARD_LOG"
exit $rc
`,
    { mode: 0o755 },
  );
  writeFileSync(join(r.source, oneUntil), '');
  git(r.source, 'add', '-A');
  git(r.source, 'commit', '-qm', 'guard tools');
}

export const guardEnv = (extra: Record<string, string>) => (dir: string) => ({ GUARD_LOG: join(dir, 'gh-calls'), LAND_SMOKE: '0', ...extra });

export const guardRuns = (l: { c: { calls: () => string } }) =>
  l.c
    .calls()
    .split('\n')
    .filter((s) => s.startsWith('guard '))
    .map((s) => s.split(' ').slice(1));

// deploy.sh lets go of the line once its restart is queued, while the restart is still judged (#566), so a rider can get
// the lock before its front has a verdict to give.
export async function restart(rolledBack: boolean) {
  const l = await line([{ env: { FAKE_RESTART_GATE: '' } }, rolledBack ? { env: { FAKE_ROLLED_BACK: '1' } } : {}, {}, {}], (dir) => ({ FAKE_RESTART_GATE: join(dir, 'restarted') }));
  const all = l.go();
  await until('ships 3 and 4 wait outside the line', () => [2, 3].every((i) => /waiting outside the line for the restart of ticket\/2-x's ship train/.test(l.out[i])));
  writeFileSync(join(l.r.dir, 'restarted'), '');
  return { l, done: await all };
}

// #1360 (Cara, 2026-11-20, "Refused ships keep their place"): ship 2, at the front, is refused by the pipeline (no CI and a
// busy perigee); it keeps its ticket, lets ship 3 take the lock, and rides ship 3's train as its first rider.
export const busy = (): Record<string, string> => {
  const dir = mkdtempSync(join(tmpdir(), 'land-busy-'));
  const proc = quietProc(join(dir, 'proc'), { load: 999 });
  return { LAND_CI: '0', LAND_QUIET_PROC: proc, CITADEL_HEAVY_PRESSURE: join(proc, 'pressure', 'cpu'), CITADEL_HEAVY_DIR: join(dir, 'heavy'), LAND_QUIET_LIMIT: '0', LAND_QUIET_POLL: '0.2' };
};

export const retried = (l: Awaited<ReturnType<typeof line>>) => {
  const log = join(l.r.dir, 'shared', 'retro-log');
  return readFileSync(join(log, readdirSync(log)[0], 'land.md'), 'utf8')
    .split('\n')
    .filter((x) => x.includes(' · retry in place · '))
    .map((x) => x.replace(/^- \S+ /, ''));
};
