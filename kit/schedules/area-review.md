---
name: Weekly area review
type: research
model: claude-opus-5-5
effort: high
min_minions: 10
cron: 0 6 * * 1
stagger: 30m within 180m
applies: the repo holds app code people build on (a server, an app, a game, tools); off by default, a scheme switches it on by resuming the row; about $10 to $15 a run, and the run skips at no cost when fewer than 10 minions worked in the scheme since the last one
---
Weekly area review for {scheme}: find the one code area that changed most since it was last reviewed, and review that area. Paths, stack and check commands are in CLAUDE.md's Project facts. If the repo holds no app code people build on, say so in one line and close yourself (close_self). Change no code.

1. **Reports and baselines.** Reviews are the files reports/area-review-<YYYY-MM-DD>-<area>.md in this scheme's shared folder. Each names its area and the commit it reviewed on a line `Reviewed commit: <sha>` and ends with `Area files: <paths or globs>`. Read the newest report of each area: that is the area's baseline commit. An area with no area-review report takes its baseline from the newest other deep review of it in reports/ that names the commit it read the code at (that one, not the older baseline it also names); with none, from `git rev-list -1 --before='90 days ago' main` (the repo's first commit if that prints nothing).
2. **Areas.** Count and pick by area, never by single file. Take the repo's own split: the "Layout" table in README.md, else the top-level directories. A table that lists single files is not a list of areas: group them by subdirectory, shared name prefix (turn-*) or the job their rows describe (runner with the turn-* files). Then split any directory of more than about 7,000 lines by its subdirectories so no area is bigger than that. Use the areas the newest reports named when they still exist.
3. **Pick.** For each area, count lines changed in it since its baseline: `git diff --shortstat <baseline> main -- <area paths>` (added plus deleted). The area with the most changed lines wins; break ties by the area reviewed longest ago. If the winner changed fewer than about 300 lines, reply in one line with the numbers and close (close_self).
4. **Review.** Run one review as {citadel_shared}/specs/area-review-brief.md describes: one `citadel:reviewer` Grunt per slice of at most about 7,000 lines, briefed with that file, the slice (files and focus), the baseline commit and the report path, then one `citadel:finding-checker` Grunt on its report (try to prove each finding wrong, by reading only). Budget about $10 to $15 for the run.
5. **Report.** Write the report with the reviewer's format, the checker's corrections applied, the two lines from step 1 (`Reviewed commit: <current main sha>`, `Area files:`) and, near the top, the table of lines changed per area that you picked from.
6. **Card.** Post one multi-select ask_question card of the fix handoffs to start, your picks marked, "none" as an option. Each option says in plain words what is wrong, who hits it and what the fix changes; no file paths. Write one short handoff per finding in handoffs/ (citadel:briefing) and tell this scheme's Taskmaster with message_coordinator.
7. No real findings: write the report anyway, so the baseline moves, and reply in one line.
