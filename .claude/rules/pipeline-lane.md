---
paths:
  - "tools/pipeline-files.txt"
  - "tools/land.sh"
  - "tools/land-core.sh"
  - "tools/land.local.sh"
  - "tools/ship-format.sh"
  - "tools/fmt"
  - "tools/deploy.sh"
  - "tools/deploy-queue.sh"
  - "tools/kit-land-drift.sh"
  - "tools/run-tests.sh"
  - "tools/test-deps.sh"
  - "tools/test-alone.sh"
  - "tools/citadel-wait"
  - "tools/citadel-heavy"
  - "tools/heavy-ci.ts"
  - ".github/workflows/citadel-heavy.yml"
  - "tools/known-flakes.ts"
  - "tools/burn-in.sh"
  - "tools/boot-check.ts"
  - "tools/failed-files-reporter.ts"
  - "tools/progress-reporter.ts"
  - "tools/ci-progress.ts"
  - "tools/citadel-node"
  - "tools/citadel-node.cjs"
  - "src/land.ts"
  - ".github/workflows/tests.yml"
  - "kit/skills/scheme-setup/templates/**"
  - "test/script-env.ts"
  - "test/land-fixture.ts"
  - "test/land-train-fixture.ts"
  - "test/land-recover-fixture.ts"
  - "test/scheme-setup-land-fixture.ts"
  - "test/land.test.ts"
  - "test/land-build.test.ts"
  - "test/land-queue.test.ts"
  - "test/land-train.test.ts"
  - "test/land-train-riders.test.ts"
  - "test/land-train-early.test.ts"
  - "test/land-train-split.test.ts"
  - "test/land-train-suspects.test.ts"
  - "test/land-burn-in.test.ts"
  - "test/burn-in.test.ts"
  - "test/land-deploy.test.ts"
  - "test/land-recover.test.ts"
  - "test/land-boot-check.test.ts"
  - "test/land-overlap.test.ts"
  - "test/scheme-setup-land.test.ts"
  - "test/scheme-setup-land-ci.test.ts"
  - "test/scheme-setup-land-local.test.ts"
  - "test/scheme-setup-land-build.test.ts"
  - "test/scheme-setup-land-hooks.test.ts"
  - "test/scheme-setup-land-merges.test.ts"
  - "test/kit-land-drift.test.ts"
  - "test/run-tests-scope.test.ts"
  - "test/citadel-wait.test.ts"
  - "test/citadel-heavy.test.ts"
---

# The pipeline lane

Moved word for word from the Citadel scheme instructions (#760); the scheme text keeps a one-line
summary for the Taskmaster. The paths above are `tools/pipeline-files.txt`'s list: change both together.

**The pipeline lane** (Josh, 2026-11-12, on #580's review: "we can have only one working at a time, thats fair"). The land and deploy pipeline (`tools/land.sh`, `tools/deploy.sh`, `tools/deploy-queue.sh`, `tools/run-tests.sh`, `tools/citadel-wait`, `tools/citadel-heavy`, `tools/boot-check.ts`, `src/land.ts`, `.github/workflows/tests.yml`, the kit's land template and their tests) is changed by one minion at a time. The Taskmaster keeps the lane: a second pipeline minion starts only when the first is live. A fix for lands that are broken right now jumps the lane. Probe and stress runs on CI never use the lands' concurrency group. If your work needs to touch these files and the Taskmaster hasn't given you the lane, commit what you have, park with the note "waiting for pipeline lane", and tell the Taskmaster.

**Two ways past a slow turn** (Josh, 2026-11-25, on #1985's card: "Skip a holder who isn't ready; Ship together if no shared files"). The server does both, for the minions the Taskmaster put in the lane's queue:
- Built, tested and reviewed while you wait? Call `hand_off_land`. It is held for the lane and marks you ready.
- A holder that hands nothing off in 10 minutes is passed over for the first ready one, and waits first. Don't hand off after being passed over until the lane is yours again.
- While the holder's ship is in line, the next ready one is told it may ship beside it, one at a time, when they change none of the same pipeline files. The hand-off checks that again.
