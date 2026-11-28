// Shared setup of the gap train's tests (#2243, tools/land/quick.sh): land-quick-train.test.ts and its part 2.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, type setup } from './land-fixture.ts';
import { shared, type Ship } from './land-train-fixture.ts';

// The judge (tools/quick-train.ts) stands in: a ship qualifies when its label is low and it changes no s*.txt file (the
// "sensitive" one here). The quick check's run (heavy-ci.ts) stands in too: it logs where it ran and prints its n-th
// call's FAKE_QUICK_OUT_<n>, else FAKE_QUICK_OUT, else a green.
export const quick = (d: string) => {
  mkdirSync(join(d, 'bin'), { recursive: true });
  writeFileSync(
    join(d, 'bin', 'fake-judge'),
    `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case $1 in --base) base=$2; shift ;; --risk) risk=$2; shift ;; esac; shift; done
s=$(git diff --name-only "$base" HEAD | grep '^s' | head -n 1)
if [ -n "$s" ]; then echo "not: sensitive: test ($s)"; elif [ "$risk" != low ]; then echo "not: risk \${risk:-none}"; else echo "would qualify"; fi
`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(d, 'bin', 'fake-quick-heavy'),
    `#!/usr/bin/env bash
n=$(($(wc -l <"${join(d, 'quick-calls')}" 2>/dev/null || echo 0) + 1))
echo "head $(git log -1 --format=%s) $(git rev-parse HEAD) args $*" >>"${join(d, 'quick-calls')}"
v=FAKE_QUICK_OUT_$n
sleep "\${FAKE_QUICK_SLEEP:-0}"
printf '%b\\n' "\${!v:-\${FAKE_QUICK_OUT:-light check: green}}"
`,
    { mode: 0o755 },
  );
  return { ...shared(d), FAKE_SIDE_RUNNERS: '1', LAND_QUICK_JUDGE: join(d, 'bin', 'fake-judge'), LAND_QUICK_HEAVY: join(d, 'bin', 'fake-quick-heavy'), LAND_TRAIN_MAX: '1' };
};

export const stateOf = (r: ReturnType<typeof setup>) => join(git(r.live, 'rev-parse', '--absolute-git-dir'), 'cc-deploy');

/** Turns the gap train on, as a person would (touch <state>/quick-train-on). */
export const on = (r: ReturnType<typeof setup>) => {
  mkdirSync(stateOf(r), { recursive: true });
  writeFileSync(join(stateOf(r), 'quick-train-on'), '');
};

export const quickCalls = (d: string) => (existsSync(join(d, 'quick-calls')) ? readFileSync(join(d, 'quick-calls'), 'utf8').trim().split('\n') : []);

const low = { LAND_RISK: 'low' };
// Ship 1 lands alone; ship 2 (low) is the front of a full train and takes ship 3 (LAND_TRAIN_MAX=1). Waiting behind:
// 4 (medium: the full suite), 5 and 6 (low: they qualify), 7 (low, but sensitive).
export const mixed: Ship[] = [{}, { env: low }, { env: low }, { env: { LAND_RISK: 'medium' } }, { env: low }, { env: low }, { change: ['s7.txt', '7\n'], env: low }];
