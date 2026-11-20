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

Rollbacks: the moving file lists every ship in the train (`tools/deploy-queue.sh`), so when main goes back, each
ship's commit is recorded as taken back under its own branch. A rider whose minion is stopped while the train is
tested is dropped, with every ship after it. The train then ships up to the ship before it, and deploy.sh tests
that commit again unless CI already passed it.

Fast mode (ADR 0011) is the kit template's, and Citadel's own land.sh doesn't have it (Citadel stays off; Cara,
2026-11-19: "Later"). If it ever gets it, a fast ship has no CI wait to share, so it should neither front nor ride a
train. Only the gated ships would batch.

Limits we know about:

- shortcut: a ship refused by a bisect waits for the whole bisect (log2 of the train's runs) before it hears. Upgrade
  if trains are often red.
- shortcut: a rider's flake lines print in the front's output, under the front's branch, so the flake count names the
  front. Upgrade if flake blame starts to matter per ship.
- A rider that hasn't moved its branch within 10 s of main moving may be missing from the release row. The deploy
  still ships its commit, and its own shipped line still posts.
