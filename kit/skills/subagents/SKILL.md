---
name: subagents
description: Whether a step should leave the session for a subagent (a Grunt), which model and effort each Grunt gets, and how to brief one. Use before starting a Grunt or a worker with the Agent tool, when a session is getting big, and when choosing between one session with Grunts and several sessions.
---

# When to use a subagent (a Grunt)

Learned on Delve (Cara, 2026-10-24 and 10-25, from two usage audits of long-running build
minions). The first section sets which effort and model each kind of job gets; the rest covers
whether a step should leave the session at all. The agents named here come from the Citadel kit,
so their `subagent_type` is `citadel:<name>` (`citadel:check-runner`, `citadel:fresh-eyes`).

## Model and effort per job

Every Grunt gets its model and effort on purpose, from its job (Cara, 2026-11-17: "Why should a
grunt have the same effort or model as its parent? shouldnt we be making that decision
intentionally?"). A kit agent pins both in its definition; every other Agent call passes `model`
and `effort` from its job's row. The kit's grunt-model hook sends back a call that leaves either
unset. Forks (`subagent_type: "fork"`) are the one exception: they run on the session's model by
design.

The tiers a whole minion gets, read from the table when this skill loaded (the rows below follow them for Grunts; a
scheme with Fable off gets them without Fable):

!`node "${CLAUDE_SKILL_DIR}/../../model-tiers.ts"`

| Job | Model | Effort |
|---|---|---|
| Find where something lives (a read-only search) | sonnet | low |
| `Explore` sweep | sonnet | low |
| Read and summarise (code, transcripts, usage data, docs lookups) | sonnet | medium |
| Bulk reads with a brief that holds everything the Grunt needs | haiku | low |
| Known-shape worker (clear-repro fix, small clear-spec change, regeneration, batch edits) | sonnet | medium |
| Known-shape worker that stalled or whose fix didn't hold | opus | medium, then high |
| Worker on a hard or design-shaped build | opus | high |
| `Plan` | opus | high |
| `citadel:check-runner` | haiku | low |
| `citadel:reviewer` | sonnet | medium |
| `citadel:reviewer` on a high-risk change | opus | high |
| `citadel:reviewer` on a build's final review | fable | medium |
| `citadel:finding-checker` | opus | medium |
| `citadel:finding-checker` on a high-risk change | fable | medium |
| `citadel:investigator` | sonnet | medium |
| `citadel:scout` | sonnet | medium |
| `citadel:fresh-eyes` | opus | high |
| self-review's verifier (`general-purpose`) | sonnet | medium |
| `citadel:professor` | opus | high |
| `citadel:critic` | from the rubric | from the rubric |

- A call's `model` takes an alias (`sonnet`, `opus`, `haiku`, `fable`), and a call's `model` and
  `effort` beat the definition's: a high-risk review passes `opus` and `high` to the reviewer
  and `fable` and `medium` to the finding-checker, over their own pins. The `citadel:critic` gets
  both from its rubric (`citadel:critique`).
- Effort left unset is an accident either way: a Grunt on the session's model runs at the
  session's level (high), and one on any other model at that model's default, medium. Nothing
  above high unless a person asks (xhigh only after a Fable run has failed twice; never max).
  Never put `effort` on a skill: it would hold for the rest of a long turn, and a switch
  mid-session may restart the prompt cache.
- Why the rows are what they are (Opus for judging, the high-risk reviewer's A/B, Haiku's turn
  count) and how the cost works: `references/evidence.md`. A scheme's own agents and retuning a row:
  `references/more.md`.

### Minions, Taskmasters and schedules too

Moved here from the Citadel-wide Settings (#1576):
- Nothing above high effort unless a person asks, for a Grunt, a minion, a schedule or an app's turn.
- Models by kind of work: the Taskmaster's model table (`public/model-table.js`) is their one home; this skill and `citadel:briefing` part 8 render its tiers (Josh, 2026-11-13: "only for really complex or high risk things").

## The test

Ask one question: will the session need what this step reads, or only what it concludes?
- If it needs only the conclusion, use a subagent.
- Its row in the table above sets its model and effort: a verdict (pass or fail, a table, "it lives
  in X.ts") runs on Sonnet or Haiku, a judgment on Opus.

## Use a subagent when

- **The step is noisy.** Test logs, searches across many files and data pulls often come to 20k
  tokens or more. The session would re-read all of that on every later call. A check whose raw
  output is long (an untrimmed build or test log) goes to the `citadel:check-runner` agent; a
  wrapper that already trims output (`citadel-test`, a scheme's check script) runs inline.
- **"What happened" about a minion, a ship or a turn, or "what has this scheme already done here?"**
  Those are one job each for the `citadel:investigator` and `citadel:scout` agents: `references/more.md`,
  "Investigator and scout", says what to give each and what comes back.
- **A sweep or a chain of lookups.** A sweep whose raw reads the session won't need again (many files,
  long ones, a chain of lookups) goes to an `Explore` Grunt on Sonnet, briefed for the conclusion and
  the exact lines that matter, not file dumps. A few targeted reads, or reads the session will act on
  (code it is about to edit), stay in the session: the Grunt's own 15k start costs more than
  they do. Hops where each result only names the next lookup are one script that prints only the
  answer (in the session or in the Grunt), capped with `| head -50`.
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

A long-lived session that owns a branch (a build, a big feature) hands each heavy step to a fresh
worker: open `references/more.md`, "Briefing a worker for a heavy step", before briefing one.

## Writing the brief

The parts and their order are `citadel:briefing` ("Briefing a Grunt"): goal, done-when as what to
hand back, what is ruled out, files to read; critical constraints first and again at the end. Pass
file paths between agents, not pasted content: the next agent reads the file itself.

## Reviewer Grunts and fix loops

An Agent call that leaves out `run_in_background` runs in the foreground (the kit's grunt-model hook fills in `false`), so a Grunt whose result you need this turn just leaves it out. Pass `true` only for a Grunt you won't wait on; a stop while it runs goes through, and Claude Code wakes the turn with its result.

A reviewer's brief says: don't trust the author's report, read the diff; you don't dispatch
subagents; look outside the diff only to test a named risk.

Fix loops are capped. Re-review only the fix diff, park new findings on untouched code as a
list for the session, and stop after a set number of rounds (two unless a person says more).

Several reviewers, or a loop, make a fan-out: they write findings to files and return 3 lines
(see below). When several report, merge from their files: the same file:line and the same issue is
one finding, and where severities conflict the higher wins.

Loop an agent only after the four checks in `references/more.md`, "Before looping an agent".

## Fan-outs: one page, not a stream

A turn that starts more than 2 Grunts, or loops one Grunt more than once, is a fan-out. This
threshold sets how the Grunts report back; where the work runs is the more-than-four-jobs rule
above.
Every Grunt's report lands in the chat as well as in your
context, so a fan-out must not return prose (the story: `references/evidence.md`).

- Each Grunt writes its full report to a file, in the worktree or in scratch outside the shared
  folder, and returns at most 3 lines: verdict, path, one headline. Put that in every brief.
- You read the files, or hand them to one Sonnet Grunt to collate, and write ONE page. Link it
  once. Picks go on a `citadel:docs-and-mocks` review page; findings go in a doc. Either lands
  in the shared folder by kind (`reports/`, `mockups/`; read its README).
- Once the page is written, delete the per-Grunt files. Rounds after the first update the same
  page rather than starting another.
- The 3-line return still has to carry anything that blocks you, such as "failed, no file
  written". Don't ask a Grunt to hide a failure to keep the return short.
- The Workflow tool runs a fan-out as a script: `references/more.md` says when a minion gets it.

What else fills a session (the checklist, the PR description, memory files): `references/more.md`.

## The model is the smaller lever

Downgrade a model only where a miss is cheap. A missed edge case in a test sweep or a misread
intent in `citadel:fresh-eyes` costs a rebuild, which is far more than the model saves. Those keep the
strongest model.
