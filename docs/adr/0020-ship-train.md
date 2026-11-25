# The ship train: waiting ships share one CI run and one deploy

Status: accepted, 2026-11-20 (#1166, from the idea handoff `handoffs/platform-ship-train.md`, which Josh picked on
2026-11-19).

Ships waited in line one at a time, and each took its own CI run and its own deploy. With about 15 minions working,
the last one in line waited for every run ahead of it.

- **Where it lives** (superseded by ADR 0026, Cara, 2026-11-20: "We should probably standardize on one solution right?") (Josh, 2026-11-20: "New, smaller train"): in Citadel's own `tools/land.sh`, not the kit
  template's `CI_BATCH`. The template's batch is a different shape (it batches the CI wait of a scheme with no deploy
  lock), and other schemes copy that template, so this change stays out of it.
- **Who rides** (Josh, 2026-11-20: "Rides like any ship"): any plain ship waiting in line, high-risk ones included. A
  high-risk ship has had its go before it gets in line, so riding changes nothing about who approved it.
- **The shape** (Josh, 2026-11-20, "Plan approved: build it this way"): the ship at the front of the line takes up to
  `LAND_TRAIN_MAX` (6) ships waiting behind it, in line order. It replays each onto the one before it, runs CI once on
  the top, fast-forwards main to the top, and deploys once.
- **A red train pulls every likely ship, and refills nothing** (#1918; Josh, 2026-11-24: "lets say we have a full train of
  minions 1, 2, 3, 4, 5, 6, 7 and it goes red. Lets say we think it is 5 or 3 that is likely the issue based on the test
  that failed. so we bisect out the likely failures and run 1, 2, 4, 6, 7 if they are green they get shipped and we send
  5 and 3 back to debug their failures. If they are still red and we guess 1 is the issue based on the failure, then we
  take it out and run 2, 4, 6, 7 then we finally get a green and ship those 4 while sending 1 back for debugging. this way
  even on 3 failures we are only running 3 tests to ship 4 minions"; plan approved that day at 11:24 PM PST). It replaces
  the refill, the guess that only picks where to cut, and the bisect after a wrong guess, in the four items below.
  Every ship the failing tests point at leaves at once, the front included, and only what is left runs again, with nobody
  from the line in the empty seats. Green: what is left ships together. Red: the new failure, the same test or another,
  names the next pull, until green or one ship is left. Then the next ships in line form a fresh full train. A ship that
  can't be rebuilt without the pulled ones goes back in line, blamed for nothing. No ship named: the split below.
  - A ship pulled on a guess runs the failing test alone on main, here, before it is blamed. Red alone (twice, and green
    on main): back to its minion with that. Green alone while another ship pulled for the same test was red alone: it
    waits for the next train. None of them red alone: they wait off the train, and all go back once the train without
    them passes the test. If that train is red on the test again, the guess was wrong: back in line, blamed for nothing
    (a pick: "if none fails alone, all of them go back" read as once the train shows it was one of them).
  - The test's runs on the train's prefixes (the pin) name a ship but don't prove it: the named ship runs alone on main too.
    Red alone: it goes back, and the other ships its test named stay on the train. Not red alone: a guess like any other,
    and the refusal says which runs it had (alone, on the train's prefixes, or none because it sits on another rider).
  - A front pulled on a guess can't wait behind its own train: it hands what is left to the next ship in line
    (`<state>/pull`, at most 3 times a hand-off, a pick, so a front never steps aside for ever) and takes its verdict like a rider's. A front proven alone is refused,
    and the hand-over is the same. The next front resumes only if it is one of the kept ships; otherwise the file is dropped.
  - Every ship named and some red alone: those go back, and the ones that passed alone stay on and ride.
    Every ship named and none of them red alone leaves nothing to test: the split. A file no ship can be named for rides on
    while others are pulled.
  - "Failed alone" is said only of a ship that was run alone (a burn-in red used to say it without a run).
  - A last red whose log doesn't name every failed file proves nothing of a pulled ship: it goes back in line, unblamed.
  - Only Citadel's land.sh has this: the kit's land core and land.local.sh have no train that pulls or holds (ADR 0026).
  - A split under way when this went live ends as it began, cut in the middle; its file's old third word is ignored.
- **A red train with no likely ship keeps splitting** (#1899; Josh, 2026-11-24, kept by #1918 for this case only: "keep splitting and any green section gets shipped, until
  the bad change is found and then pulled out to be fixed and full train starts over"). It replaces "bisected, then the
  green part ships and the first red ship is refused"; "the bisect" below means this splitting. CI runs the front part of
  the train. Green: those ships go live at once, and the next ship in line fronts what is left, with those ships only
  (`<state>/split` lists them; ships waiting behind don't join). Red: a smaller part. A split refuses a ship only as a
  front tested alone on main, so a flake or a pair that fails only together blames nobody who passes alone: of such a
  pair the earlier one ships and the later one goes back. Once the bad ship is found, the next front builds a full train
  again from everything waiting. No early run is stacked on a train being split.
  A refused front's branch keeps its rebase, as a ship tested alone always did. One bad ship of six takes 3 to 5 CI
  runs to find, the red one included, and 6 after a wrong guess.
  Picks, open to change: the part behind a red front part is not tested while the search runs (it boards the next full
  train), the later of two ships red only together goes back, and the ships waiting behind a split wait it out.
- **What a pulled-out ship needs to board again** (#1899): the test files it failed run in its next smoke check, before
  it gets in line (`<state>/pulled/`).
- **Suspects before the bisect** (#1346; Cara, 2026-11-20: "we pull out the minions that touched the failing tests
  as they are vastly more likely to be the culprit and we send them back to minions to investigate and fix. We
  replace their slots in the current train with the next waiting minions and rerun the tests on the new train"). This
  puts a step in front of Josh's "Bisect the prefixes" (2026-11-12, #599) and keeps the bisect as the fallback. A red
  train's real failures (run-tests.sh's labels; a red of flakes only keeps its one fresh run) are pinned on the ships
  whose change touched each failing test file; failing that, a file it imports by a relative path or names by its
  path; failing that, a file those import. If every real failure has a suspect, the suspects are refused at once with
  the failure, worded as likely, not certain, and the train is built again from the others, then the next ships in
  line, up to the cap, for one more CI run (never a ship stacked on a suspect's branch, which would bring its change
  back). Green: it all ships. Red again on any of the same tests: the guess was
  wrong, and the bisect runs on that refilled train (its top is the one commit known red, so the bisect stays sound
  even if a newcomer did it). Red on new tests only: another round, up to 3. A file CI didn't rerun alone (run-tests.sh stops rerunning
  once one is real) may be load, so it names no suspect: if it is real, the refilled train is red on it and the next
  round sees it. A failure with no suspect, or a log with no confirmed real failure: the bisect, as before. A suspect that is the front itself: the riders go back in
  line and the front is refused (since #1403 only when perigee confirms it, below). An innocent suspect costs its minion one turn and a re-ship, which is accepted.
- **Suspects confirmed on perigee first** (#1403; Cara, 2026-11-20, picked "Confirm suspects first": "Before refusing a
  ship blamed for a red run, re-run that one failing test on perigee with only that ship. Innocent ships stay in
  line"). On Nov 20 the nearest-level files rule blamed a ship that touched a hub (`src/db.ts`) three trains running,
  while the culprit sat a level further out (6 innocent refusals; shared `reports/incident-2026-11-20-2106-cause.md`).
  Now each real failure first runs alone on perigee, one file, niced: red at the train's top and green on main, the
  train's prefixes are bisected with that file (seconds a step), and the ship whose commit turns it red is the
  confirmed cause, refused at once, once a second run on each side agrees (red with it, green just before it; a
  timeout is no answer), so one load failure can't pin an innocent ship. That is "with only that ship" read as "the train up to that ship, with and
  without it", so a clash with an earlier rider is caught too. A file perigee can't fail alone (passes at the top,
  fails on main too) falls back to the files rule, but that suspect is now only held off the train, not refused (a guess naming more than one ship goes to the bisect,
  since a green run without them all can't tell which did it):
  green, or red on other tests only, refuses them; red again on one of their tests (with any of run-tests' labels, a
  file not rerun included) puts them back in line unrefused, and the bisect runs if a real failure came back (else
  another round). A guessed suspect that is the front itself can't wait off its own train, so the bisect looks.
  So the "accepted" innocent refusal above no longer happens.
- **Every bad ship in one round** (#1564; Cara, 2026-11-21, C "Go" on #1549's choices page, after "seems like releases
  are still REALLY hard? ... is the train size wrong?"; Cara, 2026-11-22, "Keep 7, drop G"). On Nov 21 a train with
  three bad riders took three red runs to shed them: the burn-in stopped at its first red file, and a failing file no
  ship could be pinned on sent the whole train to the bisect even when other files had confirmed causes. Now the
  burn-in (`tools/burn-in.sh`) runs every file past a red one and names each racy file, so one red run names every
  burn-in failure. The suspects judge all of a round's failing files before refusing anyone: each runs alone on the
  train's prefixes here, `LAND_PIN_JOBS` (3) at a time, and every confirmed cause leaves in that round. A file nobody
  can be pinned on no longer blocks them: with at least one confirmed cause, it rides on (as do guesses that name the
  front or more than one ship), the output says "no ship could be pinned on …, so they stay on the train", and only a
  red again on that file brings the bisect. With no confirmed cause, such a file sends the train to the bisect as
  before. The cap stays 7.
- **Red on main too refuses nobody** (#1430, before #1403's run alone on the train; Cara, 2026-11-21, picked on #1427's card after main's own clock test
  refused #1356, #1378, #1414 and #1366 between 00:00 and 01:30 PST). Before the suspects or the bisect, or a red
  ship alone's refusal, each real failure (at most 6 files) runs alone on main's tip here, niced. One that fails there
  too is main's red: every run on top of main stays red on it, so no suspect or bisect can judge. The output and the
  retro log say "red on main too: not this train's" and name the test; the riders go back in line, the front takes its
  one retry in place (so it can ride with main's fix), and a ship alone is refused saying main is red, not its change.
  That path now holds only when the run has another red that may be the train's own (below).
- **Ship through main's red** (#1478; Cara, 2026-11-21, asked on #1430 "if it is red on main, do we resume the deployment
  and just fix it separately?", then picked "Ship through" on its card). When every real failure is main's red, no
  ship on the train changed one of those tests or what it imports, and every other failed file passed alone and is a
  known flake no ship changed (#1419's rule), the train is no worse than main: the gate counts as green and it ships, riders and all. The
  output says "SHIPPING THROUGH MAIN'S RED" and each ship's shipped line names main's red test ("shipped through main's
  red on …"), so the Taskmaster sees main still needs its fix; the retro log says "shipped through main's red". Still
  #1430's path: a second real failure that passes on main, a failed file never rerun or whose rerun was killed, a
  flake never seen on another branch, the leak guard's red (processes left running), or a
  ship that changed main's red test (the front alone is refused, its change doesn't make it pass). A burn-in red and a
  test that only times out on main are never main's red. The accepted cost: a second break in the same test stays
  hidden until main's fix ships.
- **Blame rules on trial** (#1484, from #1455's retro; Cara, 2026-11-21, "pull out some takeaways on how we could avoid
  it in the future"). Every function that decides whose ship a red belongs to is checked by `test/land-verdicts.test.ts`
  against trimmed real CI logs from Nov 20 to 21 (`test/fixtures/land-verdicts/`, each case citing its run and
  incident report). The bench cuts those functions out of land.sh itself, so it tests what ships, and a guard fails
  when a function that reads the failures is neither benched nor listed as not deciding.
  A new blame rule first runs in shadow: `LAND_RULES` (default in land.sh, for example `hub=shadow`) holds
  `<rule>=shadow|live`. A shadow rule decides nothing; when it would change the guess, land.sh prints `shadow rule
  <rule>, not deciding yet` and writes `would refuse <ship> (<rule>)` or `would spare <ship> (<rule>): <instead>` to the
  day's `retro-log/<day>/land.md`. After a day of shadow lines, someone reads them against what really happened and
  turns it live with a one-word edit of that default (a pipeline ship), its bench case flipped in the same commit.
  First on trial, `hub`: a test that imports a hub (a file outside `test/` that a tenth of the test files name: today
  `src/db.ts`, `src/runner.ts`) gets no guess from imports and goes to the bisect, since almost any ship can turn it
  red. Run 44869832060 shows why: db-writer failed through `src/db.ts`, the guess held #1369, and #1356 did it.
  Also on trial, `walk`: today the walk through imports stops, with no suspects, at a file that imports nothing by a
  relative path (land.sh's `set -e`), so a test like that never has its own text read for a path a ship changed. Run
  44886957865: one-pacific names `server.ts`, which #1415 changed, and the guess named nobody. With `walk` live the walk
  goes on and names #1415. A shadow line is written only when the rule would change what the train does: a guess
  naming no ship or two goes to the bisect either way.
- **Each ship keeps its own line**: its branch moves to its own train commit before the deploy, so the release row
  that the deploy writes (`src/releases.ts` landedIn) lists it. Its own land.sh then prints its own `main is now at`
  and `deploy:` lines, so the server posts its shipped line and risk label as for any ship (`src/land.ts`).
- **The handshake** is a verdict file per rider, `<state>/train/<ticket>`, written by the front: riding, moving,
  back, landed or refused. Each rider reads it in the queue's wait check, and once more when it gets the lock.
  `tools/land.sh` documents each format above `train_verdict`. deploy.sh lets go of the line once a restart is queued,
  while the restart is still judged (#566), so a rider can get the lock with its verdict still `moving`: while the
  front's process lives, the rider hands the line on and waits outside it for the verdict. A train whose restart is
  rolled back comes off main, and its riders hear `back`, never `landed`. Before its branch moves, each rider writes
  who to report to in `<state>/riders-<the front's pid>`, so the restart the front queues reports to every rider's
  minion too: that it is live, gave up waiting, or was rolled back once the landing was over (#1865).

Who is passed over (each keeps its place, and ships on its own when it reaches the front):

- a ship that changes the ship pipeline (`tools/pipeline-files.txt`). Such a ship never fronts a train either;
- a ship that doesn't rebase cleanly onto the train (since #1366, a conflict a fix recorded ahead of time resolves counts as clean), has merge commits, sits on a commit that came off main, or fails
  the undo guard against the train;
- a ship landed with `LAND_TRAIN=0`, or by a land.sh older than the train (its queue ticket has no `train` line);
- merges into a build, `--full` and `--build` runs.

The guard tests (`guards()`, #1240) run on the train's top too, before its CI run (#1479, after the Nov 21 03:46 PST
incident cost 6 CI runs on one rider's guard break). Red there: the train's prefixes are bisected with them, the first
red rider is refused with their output, and the train is built again without it. A red train's CI bisect runs them on
each step first, and a guard red is that step's answer with no CI run; a front that fails its own ends the split.

No train forms when CI can't answer (no remote, `LAND_CI=0`, a recent ci-down note), while deploys are refusing or
rolled back, or with `<state>/train-off`. One ship's perigee fallback run is all perigee should take on. A train keeps its
riders while it waits, for a busy runner or for a quiet perigee (#1361, Cara 2026-11-20, "Wait for a busy desktop"):
only once the gate gives up for good, to run the suite on perigee, do the riders go back in line, and the front falls
back alone.

While deploys are refusing (`<state>/refusing`: the deploy's boot check failed), each ship runs that boot check
before its CI run (#646). Since #1564 (Cara, 2026-11-21, D "Go") a ship that fails it is checked against main too:
`main_boot` runs main's own boot check on a copy of main, one at a time for every ship, its exit code kept in
`<state>/boot-main` until main moves or `LAND_HOLD_RECHECK` (900 s) passes. Main passes: the change is the cause and
the ship is refused, as before. Main fails or hangs too: main or the box is broken, so a plain land keeps its ticket,
lets go of the lock and holds with the phase "held: main is broken (N min)", a waiter the line passes over (the
ticket's `yield`) and never a train rider. Every `LAND_HOLD_POLL` (30 s) it looks: the deploy's note cleared or changed,
main moved, or main's check passing on a recheck (a fixed box) sends it back to its place in line, and it starts over
from its rebase. A fix for main still passes its own check and ships as usual, and the held ships follow it. Only past
`LAND_HOLD_MAX` (8 h) is a held ship refused. A `--build` run is refused as before; merges into a build and `--full`
runs never run this check.

A ship refused by the pipeline rather than by its own change (#1360, Cara 2026-11-20, "Refused ships keep their place":
CI and perigee both busy, perigee's heavy slot taken, or a perigee red of flakes only) keeps its ticket once per
hand-off. It lets go of the lock with a `yield` line on its ticket (`tools/deploy-queue.sh`), so the next ship takes the
front and takes it as its train's first rider; with no train, it goes right after that ship. Alone in line it goes
again at once. A second pipeline refusal refuses it, and only a fully green run ships it (ADR 0006).

Rollbacks: the moving file lists every ship in the train (`tools/deploy-queue.sh`), so when main goes back, each
ship's commit is recorded as taken back under its own branch. A rider whose minion is stopped while the train is
tested is dropped, with every ship after it. The train then ships up to the ship before it, and deploy.sh tests
that commit again unless CI already passed it.

Fast mode (ADR 0011) is the kit template's, and Citadel's own land.sh doesn't have it (Citadel stays off; Cara,
2026-11-19: "Later"). If it ever gets it, a fast ship has no CI wait to share, so it should neither front nor ride a
train. Only the gated ships would batch.

Limits we know about:

- shortcut: suspects come from the file paths in each ship's diff and the test's relative imports two levels deep,
  not from the failure text naming a ship. Upgrade if suspects often miss.
- shortcut: a split's bad ship hears only when it fronts its part, after each green part ahead of it has gone live.
  Upgrade if trains are often red.
- shortcut: a rider's flake lines print in the front's output, under the front's branch, so the flake count names the
  front. Upgrade if flake blame starts to matter per ship.
- A rider that hasn't moved its branch within 10 s of main moving may be missing from the release row. The deploy
  still ships its commit, and its own shipped line still posts.

## Conflict prep (#1366)

Cara, 2026-11-20: "Can we prepare the train that is next up against the version that is attempting to ship?
Basically assuming everything goes well, then we know what main WILL look like, and we can deal with the merge issues
before we try to ship and hit a failure?"

While a train is tested, its front writes `<state>/train-top` with the train's top and each rider's commit. Every
plain land waiting behind it runs a `git merge-tree` trial against that top in its waiting check (`prep_check`). On a
conflict it prints a `prep:` line naming the files and the rider that causes it, and keeps its place. The server
wakes its minion with the steps (`prepMessage` in `src/land.ts`). The minion cherry-picks its commits onto the top in
a scratch worktree with `git rerere` on, resolves them, and finishes the pick there. Its own branch never takes the
unshipped commits.

The land's rebases (its own onto main, and a rider's onto a train) run with rerere on and continue past conflicts the
record resolves. Every merge-tree check (the hand-off's `--check` too) counts a conflict the record resolves as clean, by replaying
it in a scratch worktree (`rerere_covers`), so the waiting check doesn't eject the ship once main moves. If the train
changes (red, a rider dropped), the record goes unused and the ship rebases as it would have. Off: `LAND_PREP=0`, or
`<state>/prep-off`. git turns rerere on for every command once `rr-cache` exists, so land.sh sets the repo's
`rerere.enabled` to false when it is unset: only land.sh and the prep steps (`-c rerere.enabled=true`) use it.

- shortcut: rerere matches on the conflict's text, so a resolution recorded for the same hunks by an earlier
  conflict is replayed too, for any ship: a fix one minion recorded against a rider is replayed for that rider if it
  drops out and later rebases onto main holding the first ship. Its minion isn't told; the land says "a fix recorded
  ahead of time" and writes a `train prep replayed` retro-log line. CI still tests the result. Upgrade (scope the record per ship) if one is ever replayed wrongly.

## Early next train (#1366)

Cara, 2026-11-20, picked "Also test next train early" on the same card: the train next in line starts its CI before
the one ahead has shipped.

Once a train passed its gate, just before its deploy, the front (`early_next`) finds the ship next in line: the first
waiter by queue order that isn't on its train. It stacks that ship onto the train's top in a scratch worktree, then
builds the train that ship would take with `train_build` in a dry subshell (no verdicts said, nothing logged). It pushes
the top to that ship's `land/<branch>` and writes `<state>/early`. Each stack goes to `<state>/stacked`, keyed by the commit it was
stacked onto and the commit stacked. That ship's own rebase and its `train_build` take the stored stack instead of
rebasing again: a fresh rebase would be a new commit (committer dates), and CI's run is found by commit. A train
that comes out the same is the same commit, so `ci_gate` takes the early run as its own. `early_gate`, at the next
gate any landing reaches, counts it (`early train · counted · Ns head start` in the retro log, `ci early Ns` in the
timing line) or cancels it and deletes its scratch branch (`early train · discarded · <why>`): another ship came
first, the train came out different, or the early run went red (it runs again, as for a landing started again).

- Not while the front's own run goes, though the brief allowed it on a second free runner: two suites at once on Cara's
  desktop flaked (2026-11-11, `tests.yml`), and the lands' runs share one concurrency group, so a second would only wait.
  Superseded by "While the train ahead's CI runs" below (#1568).
- It needs a free (online, not busy) `citadel-ci-linux` runner; with none, the next ship waits for its turn as before.
- Not for a train that changes the pipeline (the next ship runs that train's land.sh), a next ship that isn't a plain
  land, one that would leave a taken-back commit behind, or one whose lane runs no CI.
- A conflict in the early stack isn't reported there: that ship's own rebase reports it once the train has shipped. A
  fix recorded with conflict prep is replayed in the early stack too.
- Off: `LAND_EARLY=0`, or `<state>/early-off`.

### One Citadel job at a time (#1906)

Josh, 2026-11-24, picked "One Citadel job, one Peek build". With the CI desktop's hold on (no `<state>/hold-off`) the early
run goes only at the train's deploy, on an idle desktop, never beside its run; a ship's run stops it. The same holds for a
ship's own check. Order, slot and caps: `src/ci-hold.ts`, `tools/ci-runner/README.md`. The sections below describe the hold off. With it on, a ship behind a running check gets no light check either (#1620, Cara, 2026-11-22: "Run it, niced"): `ci_busy` sends it into the line unchecked, since a light check is a second job.

Josh, 2026-11-25, picked "Yes, use labels" on #1902's card ("may Citadel take the job label off Peek's spare build runners while
a ship is in line, and put it back after?"): while a ship is in line or testing, one of Peek's runners on the desktop takes new builds
(`src/runner-cap.ts`). Jobs already running finish, so builds can overlap at the start; screen and heavy jobs are apart. The costs he
took: Peek's own ship can wait behind a Peek build already queued, the label stays off while Citadel is down, and 4 hours at most while it's up.

Josh, 2026-11-25, picked "Let them run, one at a time" on #1902's card ("one flaky-test proof may run beside ships"), which narrows that pick and "Deploys first" for flake proofs only: a running proof keeps no early run, own check or light check off the desktop, so `ci_busy` doesn't count one.

### While the train ahead's CI runs (#1568)

Cara, 2026-11-21, "Go" on fix F of #1549's report (ship stalls), and 2026-11-22, picked "Low-priority run on a ship
runner" on #1568's card: the early run starts when the train ahead's own run starts, not once it is green. That reverses
the "not while the front's own run goes" line above, at low priority so it can't slow the run ahead:

- `top_gate` starts `early_next` in the background beside `gate`. It stacks the next train, waits until the run ahead
  has a runner (`LAND_EARLY_WAIT`, 600 s) and a second `citadel-ci-linux` runner is free, then pushes to `early/<branch>`
  and `early-base/<branch>`, not `land/`: `tests.yml` gives those their own concurrency group per branch, niced
  (`NICENESS` 10 and a niced burn-in), on the ships' runner label, never GitHub's own, with no wait for the lands and no
  numbers kept. The ship watcher (`src/ci-ships.ts`) squeezes them like any other run while a `land/` run goes; with
  none going, a repo's oldest `early/` run counts as its ship, since that is a train whose early run was counted.
- A red ahead stops it (a flag file) or cancels its run (`early_drop`), and the next gate stacks again: a train rebuilt
  by `train_suspects` in its `top_gate`, else the deploy, which stacks one when none is kept.
- The next train rides only the riders its early run was stacked with (`<state>/early`'s sixth field, `early_look`), so
  a ship that joins the line meanwhile waits for the train after rather than changing the train and wasting the run.
  An early run that already failed, or that GitHub has no record of, holds no one back.
- A counted run stays on `early/`: `gate` takes it as the train's run, and a flake's or cut-off run's fresh run goes
  to `land/` as usual. A ship the train refused is never stacked (it is on its way out of the line).
- Cost: an early run dropped with a red ahead is one more run, on a runner that was free.

## A ship's own check (#1567)

Cara, 2026-11-21, on #1549's choices page, on A: "Go. Can you prove to me this actually results in more ship
throughput? im worried because we are already hammering my PC pretty bad when things back up...maybe we could do this
as long as my PC isnt too busy?"; 2026-11-22, on #1549's second card: "Gated, after C and B".

A train's red costs every ship on it a round, so a ship red on its own is cheapest caught before it joins one. After
the smoke check and before the line (`queue_lock`), a plain land sources `tools/own-check.sh`. Its branch, rebased onto
main in a scratch worktree, is pushed as `check/<branch>` with `check-base/<branch>` beside it. That ref runs the whole
of `tests.yml` (burn-in, suite, reruns alone) on the one runner labelled `citadel-ci-linux-check`, in the
`citadel-check` concurrency group, niced and at 8 files at once. So it never takes a land's runner or cancels a land's
run.

- A red that is the ship's own is refused before the line: a burn-in red, or files that failed again alone in CI and,
  run alone on perigee, fail with the ship and pass on main (as `train_alone` decides on a train). Anything else (flakes,
  a cut-off run, main's own red, a setup step, no runner within 180 s, a run past 900 s, GitHub not answering) joins the
  line, where CI decides as before.
- A green check's rebase goes to `<state>/own-checked`, which `stacked_of` reads with the early stacks. So when main
  hasn't moved and nobody rides with it, the ship's commit in line is the checked one, and `ci_gate` takes the check's
  run as its CI: no second run.
- Gated, so the desktop runs at most one check beside a land's run. There is no check with nobody in line (its run in
  line would start as soon as a check's), none without an online check runner, and one at a time (`<state>/own-check.lock`).
  A ship that would wait more than 120 s for the running check, going by the last check's time, joins unchecked.
- Not for a light lane (it runs no CI), a branch on a taken-back commit, or a branch that doesn't rebase cleanly (its
  rebase in line reports that). No guard tests run on the check's commit; `guards()` runs them in line.
- The brief's done line asked for the boot check too. It stays in line: `tools/boot-check.ts` boots a copy of the live
  database, which only perigee has, so the desktop's check can't run it. A stop mid-check (a trap) still cancels the run
  and deletes its worktree and branches, and the poll takes only a `check/<branch>` run newer than any GitHub already had
  on that commit, so a hand-off again with no change never reads an old run as this one's.
- Each check logs `own check · <branch> · <verdict> · <s>` to the retro log: that is how its cost and catch get counted
  against the p90 handoff-to-live time and desktop CI-hours (the brief's bar: p90 down, CI-hours within about 1.7×).
- Off: `LAND_OWN_CHECK=0`, `<state>/own-check-off`, or no runner carrying the label.

## The light check, for a ship the busy check runner sends away (#1620)

Cara, 2026-11-22, on #1620's card: "Fill #1567's gap"; then, asked whether it may run on her desktop beside a land's run
and an own check (past the own check's one-check gate), 12:47 PM PST: "Run it, niced". Replaying Nov 21-22's 229 ships through the own check's gates
with its 775 s run: 91 were alone in line, 42 got a check, and 96 were sent to the line unchecked because the check
runner was busy. Those 96 are the gap.

- Where the own check would send a ship to the line unchecked (busy for longer than it waits, or still busy after
  waiting), `light_check` (`tools/light-check.sh`, sourced by `tools/own-check.sh`) runs instead. Its branch, rebased
  onto main in a scratch worktree, goes to CI's side runner (`citadel-ci-linux-side`) through `tools/heavy-ci.ts`, with
  `CITADEL_HEAVY_SHIP=1` so it doesn't wait behind the ships' runs it is there to spare. There `tools/light-check-run.sh`
  runs `citadel-test --affected` against main (240 s), then each failed file alone (at most 4, 90 s each) on the commit
  and on main.
- It pins on the runner, not on perigee. 13 of the 16 reds the brief counts (culprits #3 and #6 in the shared folder's
  `reports/why-green-goes-red-2026-11-22.md`) are its "CI-only environment" ones: they pass on perigee and fail on the
  runner (pwsh, git config, clock, CPU), so a pin on perigee would let them through.
- Red, the ship's own (fails alone with the ship and passes alone on main, or is new with it): refused before the line,
  like an own check's red. Anything else (flakes, main's own red, a run past 240 s, nothing back within 720 s, a run that
  never started) joins the line, where CI decides as before.
- Gated: only with the side runner online and idle (a heavy job or a proof on it means no light check), one at a time
  (`<state>/light-check.lock`), not for a light lane, a taken-back commit or a branch that doesn't rebase cleanly.
- What it can't catch: a file the affected map doesn't pick (#1169's second ship broke 12 files no rule maps to its
  change), and a red that is a skip, not a failure (#1561's realtime test; `citadel-test` passes a skip, CI fails one).
  Replayed against the 16 reds, the failing file was in the ship's own and affected set for 13.
- Each logs `light check · <branch> · <verdict> · <s>`. Off: `LAND_LIGHT_CHECK=0` or `<state>/light-check-off`.
