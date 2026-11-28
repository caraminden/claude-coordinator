---
name: retro
description: The retrospective that closes a milestone. It covers what the spec left Claude to invent, what the skills, agents, hooks and tools got wrong, stale or slow, and the few edits that fix them. Use when a milestone PR is ready for review, when a Plot is ready for its go card, for a scheduled monthly or effort retro, or when someone asks how the process went.
---

# Retro

Every milestone ends with a retro, so the process improves as the project grows and the
skills never settle into sediment. Evidence first, then a few edits. Past retros live in
the retro folder the repo's CLAUDE.md names under "Project facts" (`docs/retros/` when it
names none). Read the last one, since its fixes are what this one checks, and the folder's
`README.md`, the ledger of mistakes more than one retro has found and what now stops each.
Create either file when it is first needed.

## When

- A milestone PR is ready for review. A small task runs none: its `Process:` line in
  `citadel:self-review` stands in for it. Otherwise run the retro before the reply that says the PR is
  ready, and that reply carries the top three findings, even when it is meant to be short:
  they are part of the result.
- Someone asks how the work went.
- A Plot with a branch whose build minion leads no Plot is ready for its go card (its step 5). The retro is committed to the build
  branch, in the retro folder CLAUDE.md's Project facts name; there is no milestone PR.
- A Plot's lead, once its build is live or its last member is dismissed (`citadel:cabal`, "Closing"): the one
  retro for that Plot, written from the board's timeline.
- A scheduled monthly retro (its brief names the window). It ships by the scheme's usual route for a
  doc change; there is no milestone PR.
- An effort retro: the server starts one when every minion of an effort (the `effortName` property: 3
  or more minions, or 4 in an unnamed start_after chain) has closed and stayed closed for 6 hours, in any
  scheme. Its brief lists the minions; the retro asks what went wrong across them (the split, the order,
  briefs that left the next minion guessing) and writes `effort-<slug>.md` in the retro folder. An effort
  that is mostly one Plot gets none: that one's retro covers it.
- A trouble post-mortem: the server starts a `citadel:post-mortem` minion (Sonnet medium, read-only) for a
  closed minion that went past four times its budget or whose model a Taskmaster stepped up (a fix that didn't
  hold). It is one minion, not the process's retro: it proposes one fix on a card to the minion's owner.

## Steps

1. **Gather evidence.** Collect the PR diff and the spec's open Proposals, the
   conversation (what was asked, corrected or complained about), every subagent report,
   every hook failure, and the steps that took longest. The kit's hooks log each tripwire or
   guard.sh refusal, red test, failed push, refused stop and `process` line (what sent a self-review the wrong way) to the scheme's shared folder:
   `grep -l '<your branch>' "$COORDINATOR_SHARED_DIR"/retro-log/*/*.md` finds your sessions'
   logs. land.sh's rebase conflicts (`land conflict` lines naming the files) and its likely
   flakes (`flake` lines: a test file that failed in the ship or deploy run and passed alone,
   with the load average), and its `smoke` refusals (what the quick checks before the line caught, in seconds) go in the day's `retro-log/<date>/land.md`, as it has no session id. Each finding cites one of these,
   so it reads "the citadel:check-runner was briefed without the test filter and ran the slow
   suite three times", never "checks felt slow". In the gathering, use a subagent and keep
   only what it concludes.
2. **Spec gaps.** List every Proposal the spec forced: it names a feature but not its
   shape, or two docs disagree. Mark the ones that set how the core works (a formula, a
   flow, a data shape, as opposed to a label or a single number). Those go to the owner by
   name, as what to judge.
3. **Process gaps.** For each skill, agent, hook and tool the work touched, say what it got
   wrong, missed or slowed down. Then add one line on what worked and should stay, so a
   later pruning keeps it. A wait spent replaying or rebuilding a state whose verdict didn't
   depend on the replay is a slowdown to name. Then ask: **did a cost show up this milestone that no check
   catches?** A suite that got slower, a file every change fought over, a variation that
   took a copy instead of a table row, a refactor found again. A yes becomes a proposed
   check in step 6 (a test, a hook, a script line that prints), not a note. A skill that
   fired on the wrong turn or failed to fire gets a quick citadel:skill-stocktake for its
   verdict; the fix stays this retro's to ship.
4. **UI audit**, when the milestone touched a screen: check each screen it added or
   changed against the UI rules Project facts names, with a screenshot as the evidence, at the
   screen's fullest state as well as its first, and with the longest names and values a
   user can produce. A miss is a finding; so is a UI call made in the conversation that
   generalises but has no written rule yet.
5. **Staleness sweep.** Read each skill, agent and doc the work touched for claims this PR
   made false: a path or name that moved, a pattern replaced, a command whose output
   changed. If Project facts names a docs test that checks named paths, run it.
6. **Pick the fixes.** Keep at most five, ranked by the time or rework each would have
   saved. Each is an edit to a named file: a skill, an agent, CLAUDE.md, a script or a
   test. Prefer an edit that removes a cache of the environment (a copied name, a restated
   table, a number that lives in code) over one that adds prose, and write by the
   citadel:writing-for-agents skill. A finding that matches a ledger row is a repeat. Its fix must
   be something a session meets at the moment the mistake happens: a tool, test or hook
   that fails or prints; a skill edit at the step where the mistake is made; or a doc line
   only where a check or a skill step reads it, never a note left to rot. A retro note is
   otherwise something to keep an eye out for, not a rule.
7. **Write the retro** to `<retro folder>/<milestone>.md`, under a page: the fixes first, then the spec
   gaps, then what to keep. Committing the retro file is not the end: the ledger edit (`README.md`
   in the retro folder) goes in the same commit. Update the ledger in the same PR: add this retro to each row it
   hit again, change a row's guard when a fix ships, and add a row for any finding that is
   now in two retros.
   Every number in the retro (costs, counts, durations, ships) follows `citadel:research`,
   "Numbers carry their query": a footnote with the query or command and the date it ran, or
   "my guess". A Sonnet Grunt (medium) re-runs five footnotes picked at random before the retro
   is linked; a miss is fixed first, and the reply names the five and their results.
8. **Ship the fixes in the milestone's PR**, while it is still open, so the owner reviews
   once, with the retro file in it and each edit citing its finding. Only a milestone PR
   already shipped gets a small follow-up PR instead. A process or design rule the owner
   accepts from the retro also goes in the decisions log Project facts names, if any.
   A fix the retro can't ship itself becomes a handoff (citadel:briefing), its path sent to your Taskmaster.
   End with one multi-select ask_question card, one option per handoff you wrote for this scheme's repo, each with its `start` (handoff path, title, type, model, effort) and your recommendation marked (pair a lone one with "None of these"); link the card in your reply, start none yourself, and stay open in state ready until it is answered. More than four handoffs go on a choices page with its card instead (citadel:docs-and-mocks). A handoff for another scheme's repo gets no option: its path goes only to your Taskmaster, and a run with no option posts no card.

Done when every finding has an edit in the PR or a line in the retro saying why not, every
number has its footnote and the five re-runs passed, the ledger is current, the owner has the top three in one reply, and the start card is posted (when there is a handoff for it).
