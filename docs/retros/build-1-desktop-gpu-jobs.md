# Retro: Build 1, desktop GPU jobs (2026-11-17)

Build minion #855; feeders #857 (server), #858 (runner in the machine agent), #859 (job card and Machines page).
#857 merged 09:51Z, #859 at 10:34Z (both 2026-11-17), #858 at 02:03Z on 2026-11-18 (`retro-log/*/land.md`). The spike #856 is not in the build.

## Fixes, ranked by what they'd have saved

1. **The build's full suite found two reds that no feeder's own run could.** A feeder lands with only the test files it
   touched, so the first land of `build/1` with `--full` was refused at CI twice: `test/host-check.test.ts` (#857's new job
   tables have hash columns that must be listed as secret in `src/db-view.ts`) and `test/raw-log-read.test.ts` (#858's test
   read the fake podman's log raw). Both tests exist to fail on exactly this and are cheap. Refusals at `land.md` 2026-11-17
   23:05Z and 2026-11-18 02:07Z.
   Fix: `CLAUDE.md` Project facts, check commands, now names them: a change that adds a table or column runs `test/host-check.test.ts`,
   one that adds a test reading a fake's log runs `test/raw-log-read.test.ts`.
2. **The server shipped what the spec said it must not.** Spec item 6: the go belongs to the machine's owner, not to any
   scheme member. #857's `mayDecide` let any admin (every Citadel scheme member) give the go, run now, always-allow and set job
   hours on someone else's PC; no test covered an admin non-owner. Only the whole-build Fable review caught it.
   Fix (in this build): `isOwner` in `src/machine-jobs.ts` gates those four; admins still pause, resume and stop; the buttons in
   `public/jobs.js` follow; `test/machine-jobs.test.ts` pins Cara's (an admin's) answer being refused. Pointer for the next
   feature that runs code on a person's own computer: a self-review brief names the spec's access rules to check against.
3. **Taking main in broke the prompt wiring, quietly.** Main's #878 split `systemPrompt` into `promptParts` (system and turn
   halves) and moved the machine/launch code into `buildLaunch`. The textual merge of `src/prompts.ts`, `src/runner.ts`,
   `src/ci-armed.ts` and `src/routes/tickets.ts` had to be redone by taking main's side and re-adding the job pieces; the first
   attempt compiled but `jobMachines` was out of scope, and the 10 job tests timed out waiting for a first turn. Only a test run
   showed it (`ReferenceError` in the launch). Nothing new to guard: the tests did.
4. **A feeder overwrote another feeder's test file.** #858's `process` line: it wrote `test/machine-jobs.test.ts` without
   checking `build/1` already had one (#857's). Restored before landing. Fix: none beyond the line; a feeder starting from a
   build branch reads `git log build/1 -- <file>` first is the habit, and the build brief should say so.

## Spec gaps (for Cara)

- **Pause semantics.** Spec: "Pause is always a person's click". The server keeps a job paused even when the agent keeps
  reporting running (a resumable kind's grace). If the agent's `podman pause` fails, or Pause arrives while a job is
  starting, the server says paused while the container holds the GPU and the time limit stops counting. Not fixed in this build.
- **Cache keyed per kind name, not per recipe** (the owner's `/cache`): a different recipe using an always-allowed kind's
  name shares its cache. Chosen on purpose in #858 (per-digest keying re-downloads models); worth a decision.
- **Disk room.** The agent deletes the oldest finished job folders when the disk cap needs room, with nobody asked
  (spec: "the desktop keeps its copy until the owner clears it"). Now it keeps any folder with results the server never took.

## Not fixed from the review

`outFiles` stops at 500 files with no log line; a contraption deleted mid-job sends results to the scheme's shared `jobs/<id>`;
a throw from `mkdirSync` in `JobRunner.start` leaves the job starting and holding the slot; the cache keying above.

## Keep

The spec's numbered decisions made the review checkable: every real finding was a diff against a line of it. Feeders' own
reviews plus a whole-build Fable review on top caught what each part alone rated its own way.
