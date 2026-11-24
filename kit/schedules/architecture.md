---
name: Architecture check
type: research
model: claude-opus-5-5
effort: high
min_minions: 20
cron: 0 7 10 * *
stagger: 1d within 14d
applies: every scheme; Citadel adds it to each scheme by itself, and the run skips at no cost unless at least 20 minions were made in the scheme since the last one, so a scheme with a quiet month, or little code, waits
---
Monthly architecture check for {scheme}: where the code's shape slows minions down, and which deepening is worth doing next. Paths, stack and check commands are in CLAUDE.md's Project facts. If the repo holds no app code people build on (only notes, docs or an empty scaffold), say so in one line and close yourself (close_self).

Run citadel:improve-codebase-architecture on this repo (this brief is the ask the skill waits for), with these changes for a scheduled run:

1. **Follow-through first.** Read the newest reports/architecture-*.html in this scheme's shared folder (none yet: this is the first run, so say so). List each candidate it proposed and the seam its card picked, and check on main (git log, the files themselves) whether it was built: built, partly, or "went nowhere". A seam that was picked and not built is the first finding of this report, ahead of any new candidate: say why it stalled if the minions' notes or the handoff say so, and whether it is still worth doing. Never re-propose a seam that was built.
2. **Weigh by pain, not taste.** Evidence: churn and collisions over the last 30 days (git log --since='30 days ago' --name-only main; files edited by the most different minions; rebase conflicts and red ships in this scheme's shared folder), file sizes, and the newest reports/code-health-*.md if the scheme has one.
3. Put the reading in Sonnet Grunts (citadel:subagents); keep the judgment yourself.
4. Write the skill's HTML report as reports/architecture-<YYYY-MM>.html in this scheme's shared folder: the follow-through table first, then the top 3 to 5 candidates, each with size, what it unlocks, and risk.
5. Stop before the grilling: nobody is in the chat. End on one multi-select ask_question card of the seams to split, your picks marked, with "none this month" as an option. The card is for a person who hasn't read the report: say in plain words what each seam is and what splitting it changes.
6. When seams are picked, write one short handoff for each in handoffs/ (citadel:briefing; the skill's grilling can wait for the minion that builds it) and tell this scheme's Taskmaster with message_coordinator.
7. If no candidate is worth its cost and nothing earlier went unbuilt, reply in one line and call close_self.

Change no code. Stay open in state ready while the card waits.
