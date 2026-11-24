# Subagents: rarer jobs

Part of `citadel:subagents`, opened by name from its SKILL.md.

## Investigator and scout

From "Use a subagent when":

- **"What happened" about a minion, a ship or a turn.** The database, the transcripts, the service
  and ship logs and the retro log are one job for the `citadel:investigator` agent, not a
  hand-written general-purpose brief: ask it the question, with the minion's #N and the window, and
  take back its Pacific-time timeline (at most 15 lines). It works in a person's container too
  (it uses `host_check` there). When the person asks what went wrong and how to stop it, the
  `citadel:post-mortem` skill sends it and adds the cause and the fix.
- **"What has this scheme already done here?"** Past minions on an area (who touched it, what they
  tried or ruled out, what they left to reuse) are one job for the `citadel:scout` agent: give it the
  area, the paths or the draft brief, and take back its 15 lines. It keeps a dated note per area in
  the shared folder, so a second ask on the same area costs a few calls.

## A scheme's own agents and retuning the table

- A scheme's own agents (`.claude/agents/`) pin `model:` and `effort:` too, never `inherit`; the
  hook reads them there. On a Fable turn Citadel still sets `CLAUDE_CODE_SUBAGENT_MODEL` to Opus
  (#705) as a backstop for any Grunt that slips through, so a Grunt that must run on Fable names
  `fable` on the call.
- To retune, edit the row. A kit agent's row and its definition's `model:` and `effort:` change in
  the same commit (a test in Citadel's repo checks they match), and the hook quotes the table as
  written.

## Briefing a worker for a heavy step

A long-lived session that owns a branch (a build, a big feature) keeps the plan, the
requester's questions, the decisions and the replies, and hands each heavy step (a merge with
conflicts, a batch of fixes, a regeneration, a full check pass) to a fresh worker.

The brief is the worker's only context, so it names: the branch and its head, the step's own
text in the skill (point at it, don't retype it), the repo's merge rules, and what to return in
at most 15 lines (3 lines in a fan-out, see below): the pushed sha, tests green or red with counts, each conflict and how it was
resolved, files touched, and anything left undone. A conflict that needs a judgment call is not
the worker's to settle: it stops at its last green commit and returns the question. One worker
writes the branch at a time; the session commits before starting it and leaves the tree alone
while it runs. The session trusts the summary and CI; it does not re-run what the worker ran.

## Before looping an agent

Loop an agent only if all four hold: the task repeats often, the goal is machine-checkable, the
budget fits the number of rounds, and the agent can see the result of each round. Give every loop
a stop condition. Watch for the agent gaming the verifier (Goodhart) rather than meeting the
goal. A person owns the goal.

## The Workflow tool for a fan-out

- Claude Code's Workflow tool runs a fan-out as a script, and only its return value reaches your
  context. It is off unless a minion is opted in, as it adds about 2k tokens to every call: a
  minion that will fan out asks the Taskmaster for it (create_ticket or update_ticket
  `workflow: true`, or the composer's Workflow picker), ideally at creation, since a later flip
  breaks the prompt cache once. It applies from the next turn.

## What else fills a session

Over six context windows of one Delve build, about 18% of what filled the session was repeats
that helped nobody. Three of them a session controls:

- **The checklist.** Every update resends the whole list. Keep it under ten lines, collapse finished
  steps into one line, and update it when a step changes, not on every call.
- **The PR description.** Write it once at a milestone, from the worker that ran the checks,
  rather than reading and rewriting it in the session every round (that alone cost 3.6%).
- **Memory files.** Each edit to a memory file is shown back in full, and memory files come back
  after every compaction. Live status goes on the checklist; memory takes durable facts, edited
  at a milestone, not at every step.
