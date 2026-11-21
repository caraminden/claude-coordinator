# The ship train: waiting ships share one CI run and one deploy

Status: accepted, 2026-11-20 (#1166, from the idea handoff `handoffs/platform-ship-train.md`, which Josh picked on
2026-11-19).

Ships waited in line one at a time, and each took its own CI run and its own deploy. With about 15 minions working,
the last one in line waited for every run ahead of it.

- **Where it lives** (Josh, 2026-11-20: "New, smaller train"): in Citadel's own `tools/land.sh`, not the kit
  template's `CI_BATCH`. The template's batch is a different shape (it batches the CI wait of a scheme with no deploy
  lock), and other schemes copy that template, so this change stays out of it.
- **Who rides** (Josh, 2026-11-20: "Rides like any ship"): any plain ship waiting in line, high-risk ones included. A
  high-risk ship has had its go before it gets in line, so riding changes nothing about who approved it.
- **The shape** (Josh, 2026-11-20, "Plan approved: build it this way"): the ship at the front of the line takes up to
  `LAND_TRAIN_MAX` (6) ships waiting behind it, in line order. It replays each onto the one before it, runs CI once on
  the top, fast-forwards main to the top, and deploys once.
- **A red train** is bisected by its prefixes, each assumed green below the first red one. The green part ships. The
  first red ship is refused with its own CI run's failure, as it would be alone. The ships after it go back in line,
  in their places. The front red: every rider goes back in line, and the front is refused as usual.
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
- **Red on main too refuses nobody** (#1430, before #1403's run alone on the train; Cara, 2026-11-21, picked on #1427's card after main's own clock test
  refused #1356, #1378, #1414 and #1366 between 00:00 and 01:30 PST). Before the suspects or the bisect, or a red
  ship alone's refusal, each real failure (at most 6 files) runs alone on main's tip here, niced. One that fails there
  too is main's red: every run on top of main stays red on it, so no suspect or bisect can judge. The output and the
  retro log say "red on main too: not this train's" and name the test; the riders go back in line, the front takes its
  one retry in place (so it can ride with main's fix), and a ship alone is refused saying main is red, not its change.
  That path now holds only when the run has another red that may be the train's own (below).
- **Ship through main's red** (#1478; Cara, 2026-11-21, asked on #1430 "if it is red on main, do we resume the deployment
  and just fix it separately?", then picked "Ship through" on its card). When every real failure is main's red, no
  ship on the train changed one of those tests or what it imports, and every other failed file passed alone (a flake),
  the train is no worse than main: the gate counts as green and it ships, riders and all. The
  output says "SHIPPING THROUGH MAIN'S RED" and each ship's shipped line names main's red test ("shipped through main's
  red on …"), so the Taskmaster sees main still needs its fix; the retro log says "shipped through main's red". Still
  #1430's path: a second real failure that passes on main, a failed file never rerun or whose rerun was killed, or a
  ship that changed main's red test (the front alone is refused, its change doesn't make it pass). A burn-in red and a
  test that only times out on main are never main's red. The accepted cost: a second break in the same test stays
  hidden until main's fix ships.
- **Each ship keeps its own line**: its branch moves to its own train commit before the deploy, so the release row
  that the deploy writes (`src/releases.ts` landedIn) lists it. Its own land.sh then prints its own `main is now at`
  and `deploy:` lines, so the server posts its shipped line and risk label as for any ship (`src/land.ts`).
- **The handshake** is a verdict file per rider, `<state>/train/<ticket>`, written by the front: riding, moving,
  back, landed or refused. Each rider reads it in the queue's wait check, and once more when it gets the lock.
  `tools/land.sh` documents each format above `train_verdict`. deploy.sh lets go of the line once a restart is queued,
  while the restart is still judged (#566), so a rider can get the lock with its verdict still `moving`: while the
  front's process lives, the rider hands the line on and waits outside it for the verdict. A train whose restart is
  rolled back comes off main, and its riders hear `back`, never `landed`.

Who is passed over (each keeps its place, and ships on its own when it reaches the front):

- a ship that changes the ship pipeline (`tools/pipeline-files.txt`). Such a ship never fronts a train either;
- a ship that doesn't rebase cleanly onto the train (since #1366, a conflict a fix recorded ahead of time resolves counts as clean), has merge commits, sits on a commit that came off main, or fails
  the undo guard against the train;
- a ship landed with `LAND_TRAIN=0`, or by a land.sh older than the train (its queue ticket has no `train` line);
- merges into a build, `--full` and `--build` runs.

No train forms when CI can't answer (no remote, `LAND_CI=0`, a recent ci-down note), while deploys are refusing or
rolled back, or with `<state>/train-off`. One ship's perigee fallback run is all perigee should take on. A train keeps its
riders while it waits, for a busy runner or for a quiet perigee (#1361, Cara 2026-11-20, "Wait for a busy desktop"):
only once the gate gives up for good, to run the suite on perigee, do the riders go back in line, and the front falls
back alone.

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
- shortcut: a ship refused by a bisect waits for the whole bisect (log2 of the train's runs) before it hears. Upgrade
  if trains are often red.
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
- It needs a free (online, not busy) `citadel-ci-linux` runner; with none, the next ship waits for its turn as before.
- Not for a train that changes the pipeline (the next ship runs that train's land.sh), a next ship that isn't a plain
  land, one that would leave a taken-back commit behind, or one whose lane runs no CI.
- A conflict in the early stack isn't reported there: that ship's own rebase reports it once the train has shipped. A
  fix recorded with conflict prep is replayed in the early stack too.
- Off: `LAND_EARLY=0`, or `<state>/early-off`.
