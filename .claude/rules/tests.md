---
paths:
  - "test/**"
---

# Writing tests that don't flake (#1442; Cara, 2026-11-21: "conventions ... that will result in more consistent outcomes")

`test/one-until.test.ts` counts five patterns per file against `test/flake-baseline.json` and fails when a
count rises. Write the right-hand column instead.

| Pattern the guard counts | Write instead |
|---|---|
| `await new Promise(r => setTimeout(..))` outside `until` | `until('<what>', () => cond)` from `./wait.ts`: wait on the done signal, never the first sign of it |
| `assert` that an elapsed time is under N | an injected clock (the code takes a `now`/timer knob; the test ticks it). A deadline means "it hung", never "it was fast" |
| `freePort(` | bind port 0 and read the port the server reports |
| `until(.., N)` with N under 30 s | no number: the default is the "it hung" deadline |
| `rmSync(.., { recursive: true })` | teardown through `bootServer` / `stopTurns` in `./helpers.ts`; a plain unit test's own temp dir goes in a `finally` or `after` with `// timing-ok: own temp dir` |

- To show nothing happens, do a second action and wait for it (the queue drained, the next event arrived),
  then check the first one stayed quiet. A fixed idle proves nothing and costs its whole length.
- A real timer a test waits on gets a setting the test turns down; a sleep over 100 ms means the code needs a knob.
- A stand-in service's request log holds Citadel's own background calls too (it GETs an app's page 20 s after boot
  to read its manifest and icons), so an exact count or `seen.at(-1)` goes wrong on a loaded box (#1660): record only
  the paths the test is about.
- The one escape is `// timing-ok: <why>` on the row or the row above. It is counted in the baseline too.
- A count above the baseline fails; a drop passes with a note. Lower the baseline after a fix: `FLAKE_BASELINE=write node test/one-until.test.ts`, then commit the JSON.
- Don't edit the guard's patterns to get green; fix the test, or say why the pattern is wrong.
- After a `git mv` of a test file the baseline (keyed by name) needs the same regenerate.

## What a test file leaves behind (#1763)

Each file of a guarded run (npm test, citadel-test, run-tests.sh and its reruns) gets its own `TMPDIR` and a tag,
and once its teardown is over `test/leak-file.ts` counts what is still its own: processes, the user units they run in,
listening TCP ports, and entries left in its `TMPDIR`. Anything left fails the file, naming it, and is then cleaned up.
Fix it in the file's teardown (`bootServer`'s stop, `stopTurns(root)` for a server's turn supervisor, `tempRoot`'s
teardown, a `finally`). `test/leak-baseline.json` lists files that leaked before the guard; like the flake baseline it
only shrinks: a drop passes with a note to lower it, and a file at zero loses its line.
A file killed before its exit (the run's time limit; a killed runner, which takes the file with it) is cleaned up by the reaper `test/leak-file.ts`
starts beside it, outside the run's process group (#1999): a `detached` child needs no watchdog of its own if it
inherits the file's environment or names its temp folder in its arguments (one started with a bare `env` and no such
path is not found). A server
also stops its own turns on finding its test gone (`src/exit-with-parent.ts`), and each CI job clears what is left
as it starts and ends (`test/ci-leftovers.ts`, #1900).

Before the first hand-off, run `tools/burn-in.sh <test file> [copies]` on every test file you touched, one call per file (the second argument is copies, not a file): old tests with shared state fail on whoever next edits them. A failure in 10 of 10 copies is a real failure, not a race. Repeats of a flaky file you are fixing go to a cloud session instead, off perigee's CPU: `tools/cloud-flake.ts proof <file>...` as a background command in your turn, then `citadel-wait pid` (#2187; not `citadel-job`, which leaves out your Claude login; it falls back to the burn-in at home by itself, `--help`). Editing a file a judge pins needs `node tools/judge-replay.ts <id> --record`, or `test/judges.test.ts` goes red.

Locally a minion runs only the tests it changed, the ones named after the files it changed and the repo-wide list (`citadel-test`, or `--affected`); the tests that merely use a changed file are CI's (#1928). `citadel-test --wide` runs them too.
