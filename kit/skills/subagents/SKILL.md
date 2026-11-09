---
name: subagents
description: Whether a step should leave the session for a subagent (a Grunt), which model and effort each Grunt gets, and how to brief one. Use before starting a Grunt or a worker with the Agent tool, when a session is getting big, and when choosing between one session with Grunts and several sessions.
---

# When to use a subagent (a Grunt)

Learned on Delve (Cara, 2026-10-24 and 10-25, from two usage audits of long-running build
minions). The first section sets which effort and model each kind of job gets; the rest covers
whether a step should leave the session at all. The agents named here come from the Citadel kit,
so their `subagent_type` is `citadel:<name>` (`citadel:check-runner`, `citadel:fresh-eyes`).

## Effort and model per job

- Effort: sessions run at high. Agent calls set `effort` per call when the work is mechanical:
  `low` for a read-only search that finds where something lives, `medium` for one that reads and
  summarises (code, transcripts, usage data, docs lookups). Building and general-purpose workers
  inherit high. Never put `effort` on a skill: it would hold for the rest of a long turn, and a
  switch mid-session may restart the prompt cache.
- Models: Agent calls set `model` too. A general-purpose Grunt gets `sonnet` by default (reading,
  research legwork, regeneration, reviewer passes); `haiku` for bulk reads; the
  `citadel:check-runner` agent runs on `haiku` at `low` effort (its answer is a verdict). Only a
  Grunt that judges (`citadel:critic`, `citadel:fresh-eyes`, `citadel:finding-checker`) inherits
  the session's model: on Delve's art critic Opus caught about 9 of 13 of Cara's notes, Sonnet 5.
- Turn count beats token price: the cheapest model took 2 to 3 times the turns on multi-step work
  in obra/superpowers' subagent-driven-development. Use `haiku` only when the brief holds
  everything the Grunt needs.

## How the cost works

Every model call re-reads the session's whole context, so a session's cost is roughly its calls
times its context. A subagent starts with a fresh, small context (about 30 to 50k tokens, with the
brief). It makes its own calls and hands back a summary, and the session never carries what it
read. When a session wakes after more than an hour idle, its prompt cache has lapsed, so the wake
re-writes the whole context (about $2.40 at 300k on Opus). A lean session makes every later call
and every wake cheaper. Compaction caps the cost of a session that forgets, but every compaction
is lossy: what never entered the context can't be lost from it.

Sonnet's cache reads cost what Opus's do, and reads were 35 to 52% of Delve's bill. So moving the
same work to Sonnet saves only about 25 to 33%. Keeping noisy work out of the session saves more.

## The test

Ask one question: will the session need what this step reads, or only what it concludes?
- If it needs only the conclusion, use a subagent.
- If that conclusion is a verdict (pass or fail, a table, "it lives in X.ts"), give the subagent
  Sonnet, or Haiku when the brief holds everything it needs.
- If the conclusion is a judgment, leave the model unset so the subagent inherits the session's.

## Use a subagent when

- **The step is noisy.** Test logs, searches across many files and data pulls often come to 20k
  tokens or more. The session would re-read all of that on every later call. The `citadel:check-runner`
  agent exists for exactly this.
- **The session is already big.** Past about 150k context, the savings grow quickly. Off a 90k
  session they are small.
- **Your own read needs to stay clear.** A lean session keeps the requester's actual words in
  view and compacts less often. Instructions buried under logs are where misreadings come from.
- **The read must be independent.** Reviews and `citadel:fresh-eyes` are useful because they don't share
  the session's beliefs. Hand them the code and the requester's words, not your conclusion.
- **The jobs are parallel and alike.** Several takes, several reviewers, a check per module: one
  session with subagents costs far less than one session per item, because each of those
  sessions gets woken at its own large context for every feedback round. Use a session per item
  only when a person asks for one. More than four similar jobs run as one session with Sonnet
  Grunts and one collated page. This threshold sets where the work runs; how its Grunts report
  back is the fan-out rule below, which starts at 3 Grunts.

## Keep the step in the session when

- **It is small.** A step of a handful of calls costs less inline than a subagent's start-up and
  brief.
- **It needs the conversation.** Taste, design trade-offs and iterating with a person don't
  survive a brief, and a subagent sounds just as sure of a wrong answer as of a right one.
- **The session needs the raw detail to act**, such as fixing a bug from its stack trace. Even
  then, a subagent can run the check and return the exact failing lines rather than just "it
  failed".

## Briefing a worker for a heavy step

A long-lived session that owns a branch (a build, a big feature) keeps the plan, the
requester's questions, the decisions and the replies, and hands each heavy step (a merge with
conflicts, a batch of fixes, a regeneration, a full check pass) to a fresh worker. On Delve a
build session did four merges inline and their diffs and conflict dumps were 12% of everything
that ever filled its context; code reads for review fixes were 34%.

The brief is the worker's only context, so it names: the branch and its head, the step's own
text in the skill (point at it, don't retype it), the repo's merge rules, and what to return in
at most 15 lines (3 lines in a fan-out, see below): the pushed sha, tests green or red with counts, each conflict and how it was
resolved, files touched, and anything left undone. A conflict that needs a judgment call is not
the worker's to settle: it stops at its last green commit and returns the question. One worker
writes the branch at a time; the session commits before starting it and leaves the tree alone
while it runs. The session trusts the summary and CI; it does not re-run what the worker ran.

## Writing the brief

- Put the critical constraints at the start of the brief and again at the end; the middle is
  what a long prompt loses.
- Pass file paths between agents, not pasted content: the next agent reads the file itself.

## Reviewer Grunts and fix loops

A reviewer's brief says: don't trust the author's report, read the diff; you don't dispatch
subagents; look outside the diff only to test a named risk.

Fix loops are capped. Re-review only the fix diff, park new findings on untouched code as a
list for the session, and stop after a set number of rounds (two unless a person says more).

Several reviewers, or a loop, make a fan-out: they write findings to files and return 3 lines
(see below). When several report, merge from their files: the same file:line and the same issue is
one finding, and where severities conflict the higher wins.

## Before looping an agent

Loop an agent only if all four hold: the task repeats often, the goal is machine-checkable, the
budget fits the number of rounds, and the agent can see the result of each round. Give every loop
a stop condition. Watch for the agent gaming the verifier (Goodhart) rather than meeting the
goal. A person owns the goal.

## Fan-outs: one page, not a stream

A turn that starts more than 2 Grunts, or loops one Grunt more than once, is a fan-out. This
threshold sets how the Grunts report back; where the work runs is the more-than-four-jobs rule
above. Added on
Delve #55 (Cara, 2026-10-30): 8 drawers and 8 critics over 3 rounds put about 16 reports of 20 to
40 lines each into the chat per round. Every Grunt's report lands in the chat as well as in your
context, so a fan-out must not return prose.

- Each Grunt writes its full report to a file, in the worktree or in scratch outside the shared
  folder, and returns at most 3 lines: verdict, path, one headline. Put that in every brief.
- You read the files, or hand them to one Sonnet Grunt to collate, and write ONE page. Link it
  once. Picks go on a `citadel:docs-and-mocks` review page; findings go in a doc. Either lands
  in the shared folder by kind (`reports/`, `mockups/`; read its README).
- Once the page is written, delete the per-Grunt files. Rounds after the first update the same
  page rather than starting another.
- The 3-line return still has to carry anything that blocks you, such as "failed, no file
  written". Don't ask a Grunt to hide a failure to keep the return short.
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

## The model is the smaller lever

Downgrade a model only where a miss is cheap. A missed edge case in a test sweep or a misread
intent in `citadel:fresh-eyes` costs a rebuild, which is far more than the model saves. Those keep the
strongest model.
