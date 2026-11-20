## Names
Internal code identifiers, DB columns, routes, branch prefixes and paths keep their old names (coordinator, ticket, project, and land: hand_off_land, tools/land.sh).

## Shipping fixes (Cara, 2026-10-27, "move fast" mode: no approval needed for quick fixes and small features)

For quick fixes and small features, don't wait for approval. When your change is done:
1. Test it: run only the test files your change touches with `citadel-test test/<name>.test.ts …` (counts and each failure's diff; full output in $TMPDIR/citadel-test.log, so don't pipe it). land.sh's gate runs the full suite once (jam wrap-up, 2026-11-11). Check a UI change in a browser or dev copy.
2. Self-review it: run the `citadel:self-review` skill. A Grunt reviews your diff against main, you fix what's real, and you label the change risk low, medium or high with a one-line reason. Put the label in your ready note and in the line you post when it ships, along with anything you chose not to fix. Low and medium ship as below. On high, stop before shipping and ask with a card; a member's go ships it. A change the skill's file-list test qualifies as low (only front end, docs or tests; Cara, 2026-11-18) hands off its ship first, once its tests are green, and runs the review in the same turn while it ships; real findings ship as a follow-up hand-off. Medium, high and anything doubtful review first. (Tiny docs or copy changes can skip it; the skill says which.)
3. Ship it with the `hand_off_land` tool (mcp__thread), with everything committed (Cara, 2026-11-14, "The server, no model"): a one-line summary, the risk label and its reason, and on high, who gave the go and when. Then end your turn with a short reply and set no state; a low change reviewed alongside the ship ends its turn after the review (the skill has the steps). If shipping fails, the server wakes you with land.sh's output; on a conflict, rebase by hand keeping the other minions' changes, re-test, and hand it off again. A build minion's `tools/land.sh --into build/<n> --full` still runs in its own turn. Never restart the service by hand, never write your own restart script or unit, and never push main to GitHub yourself.
4. Here "shipped" means live. The server closes you: it dismisses you for a front-end-only deploy, which is live at once, or sets pending-deploy for a restart, which dismisses you once it's live. The Taskmaster never closes a minion whose change isn't live. If someone wrote to you while the ship waited, it tells you the result instead, and you close yourself once nothing is left for them.

Ask first only for large, risky or destructive changes: data migrations, deleting data, auth or security changes (not ones that only guard against strangers: see "Who Citadel is for"), or anything that could keep the service from starting.

**The pipeline lane** (Josh, 2026-11-12, "we can have only one working at a time, thats fair"): one minion at a time changes the ship and deploy pipeline (`tools/pipeline-files.txt`). The Taskmaster keeps the lane; a fix for shipping that's broken right now jumps it.

## Git
Your base is the current local `main`, not origin/main. Don't chase it: land.sh rebases onto the newest main when you ship.

## UI checks
- Screenshot every UI change at desktop and phone widths.
- Previews (Cara, 2026-10-30: "Land right away"): a UI change doesn't wait for Cara to try it. It ships as soon as it's tested and self-reviewed. Start a preview with `start_preview` and post its link only when the brief or a person asks to try it first ("let me try it first"); then set state `try` and wait for their go. A preview runs the minion's branch on a copy of the data, never runs turns, and stops after an hour unused. Shared-folder files and pasted chat images don't load in a preview yet.

## Guardrails
The tripwire lives in src/tripwire.ts (tests: test/tripwire.test.ts, summary: src/tripwire-blocks.ts). The live checkout (~/claude-coordinator) only changes through tools/deploy.sh: no `git pull`, `merge` or `reset` there. Put systemd unit files in the repo (deploy/) and give Cara the exact install command to run by hand.
