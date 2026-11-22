# One ship script and one way of batching ships, for every scheme

Status: accepted, 2026-11-21. Decided on #1304's cards; step 2 of its five (#1321) turns batching on in the kit's template and adds the `land_deploy` and `land_rebased` hooks; step 3 (#1322) adds Citadel's other extras as hooks and ship-time merges; the later steps move Citadel onto the template. Supersedes ADR 0020's "Where it lives". Design: the shared folder's `specs/one-ship-batching.md`.

Citadel's own `tools/land.sh` batched ships with a train (ADR 0020) and every other scheme's copy of the kit's
template batched them with `CI_BATCH`. The two are one idea: stack the waiting ships on each other, run CI once on
the top, ship up to the deepest green commit, bisect the prefixes when the top is red.

- **One solution** (Cara, 2026-11-20: "We should probably standardize on one solution right?"). This reverses Josh's
  pick on #1166 the same day, "New, smaller train", which kept the train out of the kit template.
- **The kit's batches are the one mechanism.** A member learns its verdict from git (its commit is on main), batches
  work with `CI_STACK`, lanes and fast mode. `LAND_BATCH` is the cap; a batch takes whoever is waiting, up to it.
- **A deploy under the lock is a core hook**, `land_deploy`, run once per batch for the deepest commit it ships. It
  can take main back, and then every member hears it didn't ship. Citadel sets it to `tools/deploy.sh`, so a batch
  shares one restart as the train did. Schemes without it deploy as today: the server deploys their contraptions
  after main moves, and those deploys already coalesce.
- **Pipeline ships never ride**: a ship that changes the ship pipeline (the template, `land.local.sh`, workflows, the
  lanes file, or what `LAND_PIPELINE_FILES` lists) ships alone.
- **Every scheme logs a timing line per ship** and prints one result line that the server reads.
- **`land_rebased`** (Peek Auras, 2026-11-20): an optional hook that runs on the branch once it sits on today's main,
  before its check, in every mode the minion runs (fast too), and whose commit ships: for files built from the whole tree.
- **Fast ships** have no CI run to share and stay a batch of their own. Citadel stays off fast mode (Cara, 2026-11-19:
  "Later"); once on the core it can turn it on from Settings.
- **Build branches** don't batch: `--into` and `--full` stay out of the line, `--build` ships alone.
- **Citadel runs the kit's script** with a `tools/land.local.sh` (Cara, 2026-11-20: "One script for all"). Its extras
  (flake rerun, CI fallback, preflight, guards) become hooks any scheme can use. Step 3 (#1322) adds them, each off
  by default: `GUARD_CMD`, `land_preflight`, `land_flaky` (a check's red runs once more, a CI red gets one fresh run;
  ADR 0006), `land_fallback` (decides when CI gives no answer), and `LOCK_FILE` / `QUEUE_DIR` (a lock and line
  another script shares, as Citadel's deploy queue does). The smoke check is the core's `SMOKE_CMD`.
- **Ship-time merges are a core setting**, `MERGES` (Cara, 2026-11-20, "Build it into step 3"): files two ships
  often change in the same place merge by rule during the rebase, as a git merge driver, alone and inside a batch:
  `append` (both add to one list), `sum` (both raise a number: main's plus the branch's raise, never more), `main`
  (a file `land_rebased` makes again), `hook` (`land_merge`). Anything a rule isn't sure of conflicts as before.
  Ruled out: one budget file per bump.
- **Step 3b (#1571) gives Citadel's last extras a core home** (Cara, 2026-11-22, on #1322's ship card: "A step 3b
  first"), each off by default: `FLAKE_RUNS` (several fresh runs for a flaky CI red), `PARK_RETRIES` (ask CI again in
  place before parking), `CONFLICT_PREP` (rerere on, the `prep:` line, a recorded fix retries the build),
  `land_ci_more` (more time past `CI_LIMIT`, once per reason), `land_main_red` (waive failures red on main's tip
  too), `land_recover` (put right what a half-done deploy left) and `land_under` (rebase from a rolled-back commit).
  A `MERGES` `hook` line may now sit beside `append` / `sum` lines for the same file (Citadel's `src/db.ts`): the
  hook leaves its clashes as the core's diff3 markers and the rules take them.
- **Batching is on by default** (Cara, 2026-11-20: "On, up to 4"). A scheme that sets nothing batches up to 4;
  Citadel sets 6; a scheme can set it lower, or 1 for none.

Considered and not taken: two scripts sharing a batching library. It shares the batching but leaves two of
everything else (two places for every fix, no fast mode for Citadel), and the batching is the most entangled part
of each script, so extracting it costs about as much as the move.
