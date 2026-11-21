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
  line and the front is refused. An innocent suspect costs its minion one turn and a re-ship, which is accepted.
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
- a ship that doesn't rebase cleanly onto the train, has merge commits, sits on a commit that came off main, or fails
  the undo guard against the train;
- a ship landed with `LAND_TRAIN=0`, or by a land.sh older than the train (its queue ticket has no `train` line);
- merges into a build, `--full` and `--build` runs.

No train forms when CI can't answer (no remote, `LAND_CI=0`, a recent ci-down note), while deploys are refusing or
rolled back, or with `<state>/train-off`. One ship's perigee fallback run is all perigee should take on. CI giving no
answer partway through sends the riders back in line, and the front falls back alone.

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
