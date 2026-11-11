---
name: retro
description: The retrospective that closes a milestone. It covers what the spec left Claude to invent, what the skills, agents, hooks and tools got wrong, stale or slow, and the few edits that fix them, landed in the milestone's own PR. Use when a milestone PR is ready for review, when someone asks how the process went, or when a skill, agent or doc sent a session the wrong way.
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
- A skill, agent, hook or doc sent a session the wrong way. That is a one-finding retro:
  same steps, smaller.

## Steps

1. **Gather evidence.** Collect the PR diff and the spec's open Proposals, the
   conversation (what was asked, corrected or complained about), every subagent report,
   every hook failure, and the steps that took longest. The kit's hooks log each tripwire or
   guard.sh refusal, red test, failed push and refused stop to the scheme's shared folder:
   `grep -l '<your branch>' "$COORDINATOR_SHARED_DIR"/retro-log/*/*.md` finds your sessions'
   logs. land.sh's rebase conflicts (`land conflict` lines naming the files) and its likely
   flakes (`flake` lines: a test file that failed in the land or deploy run and passed alone,
   with the load average) go in the day's `retro-log/<date>/land.md`, as it has no session id. Each finding cites one of these,
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
   verdict; the fix stays this retro's to land.
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
   hit again, change a row's guard when a fix lands, and add a row for any finding that is
   now in two retros.
8. **Land the fixes in the milestone's PR**, while it is still open, so the owner reviews
   once, with the retro file in it and each edit citing its finding. Only a milestone PR
   already merged gets a small follow-up PR instead. A process or design rule the owner
   accepts from the retro also goes in the decisions log Project facts names, if any.

Done when every finding has an edit in the PR or a line in the retro saying why not, the
ledger is current, and the owner has the top three in one reply.
