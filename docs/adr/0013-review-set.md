# Each scheme's reviewers and critics live in Citadel, not its repo

Status: accepted, 2026-11-19 (Build 4, "Reviewers and critics"; phase 1 built in #1051, build minion #1050).

Until now a scheme's critics were rubric files in its own repo (`docs/rubrics/*.md`, named by the Rubrics line in
its CLAUDE.md's Project facts), and the critic loop (`citadel:critique`) read them there. Changing one meant a
commit in that scheme's repo, and nobody could see a scheme's set at a glance.

## Decisions

The spec is the decisions table in the shared folder's `handoffs/handoff-review-set-0-overview.md` (all
2026-11-19). These are the ones phase 1 builds on:

- **Citadel stores them** (Q2, Cara): a database store, keyed by scheme (`project_id`), with a version history.
  Today's rubric files move in once and leave the repos.
- **A scheme's version of a kit starter layers on top** (Q9, Cara): the entry keeps only its own lines and an
  `extends:` naming the kit's starter, so it still gets the kit's fixes.
- **Fully switchable** (Q10, Cara): every entry has an on/off switch.
- **New entries start on trial** (Q12, Cara): they advise only, until calibrated or a person marks them good.
- **Its own page beside Schedules** (Q5, Cara), laid out as take A, columns by when each one runs (Josh, choices
  page).
- **Only the minion records verdicts** (Q13, Josh): the page shows a record, but it has no box for adding one.

## What phase 1 built

- **The store** (`src/review-set.ts`). `review_entries` holds one row per entry: slug, name, kind, extends, body,
  triggers, context, enabled, trial, model, effort, stage, position, gate, source and version. `review_versions`
  holds every save whole, so History shows and restores any of them. A restore is a new version, never a rewind.
  - Columns phase 2 and 3 fill are there but idle: `kind` (the built-ins join as reviewer, checker and audit
    entries), `position` (run order), `gate` (block or advise) and `context.verdicts`.
  - Phase 3's hand-offs, panels and run record get their own tables.
- **The API** (`src/routes/reviews.ts`):
  - Everyone in a scheme reads its set.
  - People and Taskmasters add, change and restore entries.
  - A minion saves only an entry's body: the learning step in the critic loop. The switches stay a person's call.
  - The `review_set` MCP tool wraps the same reads and saves.
- **Turns read the set as files.** Each turn renders the scheme's switched-on entries into `<turn dir>/review-set/`
  in the rubric format the kit already reads, and gets a line naming that folder. The critique skill treats that
  folder as the scheme's rubric set. The skills and agents didn't change how they read a rubric; only where they
  find it.
- **The one-off import.** On its first start with this code, the server copies every scheme's repo rubric files into
  its set, then sets `review_set_import` so it never runs again.
  - It only adds, and it skips a slug already there.
  - The repo files stay until each scheme's minion removes them and its Rubrics line, on a relay from #1050.
  - The live run waits for a person's go, asked on #1051's card.
- **The page**, `#/p/<id>/reviews`, linked from each scheme's settings beside Schedules:
  - Columns for While working, Before ship, On ask (shown when it has entries) and On a schedule. On a phone they
    stack.
  - Each card has a switch and trial, kit and off chips.
  - The detail panel shows what it reviews, its context, "with the others" and the record (both empty states until
    phases 2 and 3), plus Edit by hand, History and Restore.
  - New starts blank or from a kit starter, always on trial.

## Why not keep repo files

- Repo files need a commit, and a ship, for every switch flip.
- Repo files can't hold a history that a page restores from.
- Repo files can't show every scheme's set the same way.
- The cost: the set is no longer in git with the code it judges. The version history is what replaces git's for it.
