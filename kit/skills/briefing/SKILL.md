---
name: briefing
description: 'Writing a brief for a new minion, or a handoff file one starts from: the eight parts, in order. Use before create_ticket, and when writing handoffs or specs for a minion to pick up. Not for messaging a running minion, nor your own /fresh handoff.'
---

# Briefing

A brief is the new minion's whole context: it can't see the chat that led to it. The first turn on
a brief is the dearest turn there is ($4.33 and 74 calls on average in Citadel's minion-turns sweep, 2026-11-16), and most of it
goes on working out what was meant. Eight parts, in this order, cut that down.

## The eight parts

1. **Goal**, one line: what changes, for whom. Two asks that can each ship and be used alone get two
   minions (a chain only when the second needs the first's code), above all when only one waits on a
   person's card: a read-only Flow tab and a saved closing word whose word list a person picks were
   one brief, and should have been two.
   A sweep split across several minions is split from the tool's per-file list (a baseline,
   `git ls-files`, a report's per-file counts), never from name patterns: every file goes to exactly
   one brief, and the leftovers are a round of their own, named. When several of them add to one
   shared file at once, each brief names its own file or section in it.
2. **Their words**: the person's own words that asked for it, in quotation marks, with who and the
   date: `Josh, 2026-11-19: "Go on A1"`. Quote the ask itself, not your summary of it, and each
   person who shaped it. When no person started it (a schedule, a CI alert), say what did, in one line.
3. **Done when**: under that heading, the end state a person can see or check (a page shows X, a
   test goes green, a file exists in a folder), not process steps. One to five lines.
   A line that needs the live data (a timing, a count over real chats) or a pipeline-lane file names
   how the minion meets it: `host_check` db (Citadel's database only), `copy_app_data` (a home app's),
   the ship's live `probe`, or a place in the lane. A turn in a container can't open the live data
   itself.
4. **Already shipped on this**: what git (`git log main --grep`, the paths in play) and the minions
   list show today, with the date checked and the commits or minions found, or "nothing found
   (checked 2026-11-19)". A minion that starts on work already shipped repeats it. For anything
   bigger than a one-file fix, first send a `citadel:scout` Grunt the area or your draft: its
   "Touched" lines go here, its "Tried or ruled out" and "Reusable" lines in part 6.
   Look in the minions list for an open minion deciding or building the same mechanism too (a design
   minion has no files yet). When there is one, send it the new ask as a message instead, or name the
   seam in both briefs (message it its half): which piece each builds, which ships second.
5. **Leave alone**: what the minion must not touch (files, lanes, another minion's branch, live
   data). "Nothing in particular" when true.
   Run `who-touches <the files it will edit>` (on every turn's PATH) and name each open minion
   already changing one of them, so the new one plans around it instead of meeting it as a conflict at the ship.
   Minions sealed on the same leader can't show up in `who-touches` yet. When two will edit the same
   files (README.md's Layout table, a design-system page), say which ships second and rebases.
6. **Ruled out or tried**: decisions already made (quoted, dated), what was tried and failed and
   why, what is out of scope. Write "Nothing yet" when that's true, so the minion doesn't go looking.
   A change to how saved things are stored, read or applied (records, settings, saved files, a person's
   own items) also says here what happens to the ones saved before it: migrated, left as they are on
   purpose, or flagged to their owner.
   A cause, count or size the brief states ("about 15 files leak", "the stall comes from start bursts")
   carries the command that showed it, or is labelled a guess.
7. **Read first**: paths to the handoffs, specs, reports and code worth reading, each with a clause
   on why. Paths, never pasted text: the minion reads the file itself.
8. **Model and effort**, with one line of why from the Taskmaster's model table: `Opus 5.5 high:
   design-shaped, a new flow`. create_ticket takes the pick in `model` and `effort`; the
   line in the brief is the why. Nothing above high unless a person asks (`citadel:subagents`).
   Then **`Expected cost: ~$N`** on a line of its own. Rule of thumb: the usual cost for the type on that
   model (the budget part of list_tickets' lines, or the Budget line at the top of your own turns) times
   how many minions' worth of work the brief holds; a port, a migration or many files weighs more, a
   one-line fix less. create_ticket reads the line (or takes `expected_cost`), and the minion's budget
   alarms count from it. A brief over $50 waits for a person's start card (Start, or Split first) before it
   runs: give the honest number, and say in the brief where the work could split, so the person can pick.
   The tiers, read from the table when this skill loaded (a scheme with Fable off gets them without
   Fable):

!`node "${CLAUDE_SKILL_DIR}/../../model-tiers.ts"`

After the eight parts, only what the minion can't find on its own: where it ships (main, or a build's
branch), the lane or chain it sits in, and anything to clean up when done.

## A brief that points at a handoff

When a handoff file already holds the eight parts, the create_ticket message is a pointer to it by
full path plus what the file can't know (where it ships, the lane, the load on the box). Don't
repeat the file. The check below reads a handoff the message names.

## Writing a handoff

A handoff is a brief kept in a file so a fresh minion can begin from it.

- In the shared folder's `handoffs/`, one file per minion, titled `# Handoff: <goal>`.
- The eight parts as its sections, in the same order. Part 2 is the pick that started it: `**Pick
  (Josh, 2026-11-19):** "Go on A1"`, plus the original ask it came from.
- Under about 60 lines; link the long material rather than copy it.
- No one deletes a handoff: Citadel files it by itself once the minion started from it closes,
  as a rule into `handoffs/shipped/` (#1371). To tell another minion of its ship, a minion calls
  `relay_when_live` before `hand_off_land` (it wakes nothing; a minion that must wake sets its own
  `wake_when_live`). Neither chore is a reason for `stay_open`, or goes in a brief as an after-ship step.
- An idea or research minion ends in one handoff per piece of work it proposes, then the card that
  asks which to start (past four handoffs, a choices page: the Citadel-wide card rule (Asking and picking)).
  Give each handoff's option its `start` (ask_question): a plain pick then starts that minion with no turn.

## Idea minions and process-only changes

An idea minion ships nothing: it ends in short handoffs in the shared folder, written with this skill. A process-only change (prompts, skills, tooling, docs) never waits for a feature build: it ships once green and self-reviewed, and its risk label decides whether it needs a go.

## The shared folder

It is sorted by kind (`handoffs/`, `reports/`, `specs/`, `mockups/`, plus what the scheme's README adds). Read the README before adding files. No caches, build output, raw runs or secrets there.

## Example

```
Goal: the Usage bar shows today's spend for the whole scheme, not just this person.

Cara, 2026-11-18: "the usage bar should be the scheme's total, I don't care about mine alone"

Done when
- The top bar's Usage reads the scheme's total for today (PST), matching the Costs page's row.
- A test pins the total for a scheme with two people's turns.

Already shipped on this: nothing found (git log main --grep=usage, 2026-11-19).
Leave alone: the per-person Costs page.
Ruled out: a per-person toggle (Cara, same message: "no toggle"). Tried: nothing yet.
Read first: src/costs.ts (the totals), public/topbar.js (the bar), test/costs.test.ts.
Model: Sonnet 5.5 medium: known-shape change, one query and one label (table: small feature).
Expected cost: ~$4 (one small feature's worth).
Ships straight to main.
```

## Briefing a Grunt

A Grunt's brief takes parts 1, 3, 5, 6 and 7; its model and effort go on the Agent call
(`citadel:subagents`), and its done-when is what it hands back and in how many lines. Put the
constraints that matter most first and again at the end.

## The check on new minions

create_ticket, and a person's Start on a handoff, warn when the brief (with any handoff file it
names) has no quoted words from a person, no "Done when", no "Already shipped on this" or no "Leave alone". The minion is still created: add the
missing part with message_ticket in the same turn, or say in the brief why there is none. create_ticket
also notes a missing "Expected cost" line; that minion starts anyway, its alarms counted from the usual cost.

## Done lines (features)

A feature minion turns the brief's Done when and the person's words into 3 to 7 "when X, then Y"
lines before it codes, shows them in its first reply, and ticks them in its ready note.
Self-review and fresh-eyes check each line. Bugs, chores and research write none.
