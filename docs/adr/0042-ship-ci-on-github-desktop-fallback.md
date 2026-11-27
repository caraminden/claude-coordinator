# 0042: A ship's CI runs on GitHub's runners, 20 ways; the desktop is the fallback

Date: 2026-11-27. Minion #2209, from #2198's research (`reports/github-free-runners-suite-timing-2026-11-26.md` in the
shared folder). Reverses ADR 0028's "Not picked: GitHub's own runners (Actions minutes)": on a public repo they cost
nothing, and that was the only reason given.

## Their words

Cara, 2026-11-27, on #2198's card: "I think that github should actually be the main CI? with my desktop as the
fallback, especially since my desktop can run more types of jobs, we should have the prio be 1. Release CI full test
suite on Github 2. Release CI full test suite on desktop if Github is broken or already running a test 3. Run any minion
that is waiting for a "Ship it" through the full suite on github so its bugs can be found before we try to ship". Then:
"and we should use all 20, if they give us 20, take 20".

"Release CI" is a ship's CI: the land/** run land.sh waits on. Item 3, the suite before a ship's go, is its own minion.

## Context

#2198 ran the whole suite on GitHub's standard runners (free and unlimited on a public repo; 4 vCPU, 16 GB each),
split by measured file time: 16 ways took 4 min 45 s to 4 min 59 s from push to the last job, against a 6 min 26 s
median desktop job (the last 40 green tests.yml runs, Nov 26). Queue waits were 1-3 s and setup under 30 s with the
tools cached. The Free plan runs 20 hosted jobs at once across the account's repos, so a 20-shard ship run takes them
all.

## Decision

- **A ship's push runs on GitHub.** tests.yml's `shard` job runs for a push to `land/**` (and a dispatch with
  `where=github`) as a matrix of 20, `fail-fast: false`. The desktop `test` job runs for everything else: the nightly,
  `check/**` and `early/**` (left on the desktop on purpose), runs by hand, and land.sh's fallback.
- **Split by file time.** `tools/suite-runner.ts` with `CITADEL_TEST_SHARD=<i>/<n>` deals the files longest first onto
  the shard with the least so far (a file with no time counts as the median); shard 0, which also runs the burn-in,
  starts 60 s heavier. A first job, `times`, reads main's tip and the times cache once and hands both to all 20 shards,
  so they all work out the same split: each reading the cache (or main, which picks the tier) on its own, one shard
  starting after new times were saved would leave files unrun in a green run. Each shard uploads only its files' times; `ci-cache.yml` (on `workflow_run`, so in main's
  context) merges them with `--merge-times` and keeps them, and the tool downloads, in caches every branch can read (a
  cache saved on a `land/` branch is readable only there).
- **One verdict, as before.** The run is red when any shard is; land.sh reads the run's conclusion and its failed
  step as it did for the desktop. A red of flakes only (`flake_only`) now judges each shard's log apart: every red shard
  must have rerun its failed files alone and found them all flakes (`each_job`). Before, it read only the last
  "rerunning" line in the log, which with 20 jobs would have let one shard's flakes hide another shard's real failure.
  The train's readers of the same lines (`train_labels`, `train_failing`) and the skipped-test count do the same.
- **The desktop by itself.** land.sh (`ci_gate`, `ci_to_desk` in `tools/land/ci.sh`) knows a GitHub run by the
  `shard:` job in the tip's tests.yml. It cancels that run and dispatches tests.yml with `where=desktop` on the same
  `land/` ref, then waits on that run exactly as on any desktop run, when:
  - not every shard on `ubuntu-latest` has started within `LAND_CI_GH_START` (60 s) of the push: GitHub is down, or
    its 20 slots are taken (another ship's run, another repo's jobs);
  - GitHub doesn't answer whether they started, three times running;
  - the run ends with no verdict on the tests: any shard red in a step that isn't the suite, its burn-in or its reruns
    (setup, the tools: that shard's files never ran), or cancelled, or with no failed step;
  - the run passes a CI limit (`LAND_CI_TIMEOUT` and its windows), which on the desktop went straight to perigee.
  A red only in the full suite, its burn-in or its reruns is a verdict and refuses, as on the desktop. Shards slow to
  start with no desktop runner online keep their GitHub run. Otherwise, with no desktop runner online, the fallback is
  perigee's own suite, as before (`CI FALLBACK`), but with no `ci-down` note: the next ship asks GitHub again.
- **An off switch.** The repo variable `CI_RUNNER=desktop` sends ships' pushes back to the desktop job; land.sh sees
  a run with no `ubuntu-latest` job and waits on it as a desktop run. (`CI_RUNNER=github`, the old one-job switch,
  is gone: the shard job replaces it.)
- A ship's run on GitHub no longer needs a desktop runner online before its push.

## What the numbers lose

GitHub's machines can't reach Citadel's store (`perigee.tail59477f.ts.net:8574`, tailnet only), so a ship's run on
GitHub posts nothing to it: no live test counts on the Releases page while it runs (`tools/ci-progress.ts`), no
`suite-time` / `suite-time-pipeline` point, no leak counts (`tools/ci-numbers.sh`). The series keep their points from
main's nightly run and from every desktop fallback, both on the desktop; the ship's line on the Releases page still
shows that it is waiting for CI and how it ended. Getting them back means a route out of GitHub (land.sh reading the
shards' logs once the run ends, or an artifact Citadel fetches), which nobody has asked for yet.

Also left as they are: `src/ci-hold.ts` and deploy-queue.sh's `ci_busy` still count a ship's run as the desktop's,
so optional desktop work still waits behind a ship that runs on GitHub; and the hold stops a hand-started
`where=github` run as optional work (it did to the first probe, run 45968345201).

The first ship after this lands finds no times in main's cache, so its shards split by name; `ci-cache.yml` keeps
times from then on.

Other schemes' ship scripts (the kit's `land.sh` template) are left as they are: Cara's words were about Citadel's own
ship CI, their repos may be private (hosted runners spend minutes there), and the 20 slots are one account's, shared
with this repo's ships. A new feature for one ship script needs no port (Cara, 2026-11-22, "Keep both, port by rule");
another scheme takes it by its own ask.

## Numbers

Push to verdict over real ships, against the desktop's 6 min 26 s median job: to come, once 10 ships have run on it.

The first whole run on GitHub (run 45968345201, a hand-started probe on this branch, Nov 27): 20 shards, split by name
(no times cached yet), every one started within 1 s of the others, the run 6 min 5 s from start to end, its shards
1 min 20 s to 6 min 3 s. Its three red shards were this branch's own, fixed before it shipped: the runner-choice tests
of an older commit, the leftovers sweep put after the tools step, and a stale base for the schema check. A split by file time should even the shards out; the ships'
numbers will say.

## Not picked

- 16 shards, #2198's fastest measured: Cara asked for all 20.
- Asking before each push whether a GitHub run is already going: the 60 s start check covers it, and a busy account
  also shows up that way.
- check/** and early/** on GitHub: they would take the ship's slots.
