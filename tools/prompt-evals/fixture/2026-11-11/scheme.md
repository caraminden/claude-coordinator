## Names
Internal code identifiers, DB columns, routes, branch prefixes and paths keep their old names (coordinator, ticket, project).

## Shipping fixes (set by Cara, 2026-10-27, "move fast" mode until she says otherwise)

For quick fixes and small features, don't wait for approval. When your change is done:
1. Test it: run the unit tests, and check it in a browser or dev copy if it's a UI change.
2. Self-review it: run the `citadel:self-review` skill. A Grunt reviews your diff against main, you fix what's real, and you label the change risk low, medium or high with a one-line reason. Put the label in your ready note and in the line you post when it ships, along with anything you chose not to fix. Low and medium ship as below. On high, stop before merging and ask with a card; Cara's or Josh's go lands it. (Tiny docs or copy changes can skip it; the skill says which.)
3. Land it with `tools/land.sh`, run from your worktree with everything committed. Under the deploy lock it rebases your branch onto the latest local main, runs the tests, fast-forwards main and runs `tools/deploy.sh`, which checks the new code on a copy of the database, then reloads the front end (changes only under public/) or queues the restart (rolled back if the server doesn't come back healthy) and pushes the live commit to GitHub. land.sh refuses with main untouched on a conflict or a red test; on a conflict, rebase by hand keeping the other minions' changes, re-test, and run it again. If it exits non-zero, read its output: main only moved if it says so. Never restart the service by hand, never write your own restart script or unit, and never push main to GitHub yourself.
4. Post one short line saying what shipped, with the commit hash, its risk label, and whether it's live yet or waiting for the restart.
5. Close as "Closing" below says.

Ask first only for large, risky or destructive changes: data migrations, deleting data, auth or security changes, or anything that could keep the service from starting.

## Closing
Here "landed" means live. A front-end-only deploy is live at once, so close_self. A restart is not: set state pending-deploy and end the turn, and the deploy dismisses you once it's live. The Taskmaster never closes a minion whose change isn't live.

## Git
Your base is the current local `main`, not origin/main. Don't chase it: land.sh rebases onto the newest main when you land.

## UI checks
- Screenshot every UI change at desktop and phone widths.
- Previews (Cara, 2026-10-30: "Land right away"): a UI change doesn't wait for Cara to try it. Under move fast it lands as soon as it's tested and self-reviewed. Start a preview with `start_preview` and post its link only when the brief or a person asks to try it first ("let me try it first"); then set state `try` and wait for their go. A preview runs the minion's branch on a copy of the data, never runs turns, and stops after an hour unused. Shared-folder files and pasted chat images don't load in a preview yet.

## Guardrails
The tripwire lives in src/tripwire.ts (tests: test/tripwire.test.ts, summary: src/tripwire-blocks.ts). The live checkout (~/claude-coordinator) only changes through tools/deploy.sh: no `git pull`, `merge` or `reset` there. Put systemd unit files in the repo (deploy/) and give Cara the exact install command to run by hand.
