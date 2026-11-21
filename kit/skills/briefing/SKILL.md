---
name: briefing
description: Writing a brief for a new minion, or a handoff file one starts from: the eight parts, in order. Use before create_ticket, and when writing handoffs or specs for a minion to pick up. Not for messaging a running minion, nor your own /fresh handoff.
---

# Briefing

A brief is the new minion's whole context: it can't see the chat that led to it. The first turn on
a brief is the dearest turn there is ($4.33 and 74 calls on average in Citadel's minion-turns sweep, 2026-11-16), and most of it
goes on working out what was meant. Eight parts, in this order, cut that down.

## The eight parts

1. **Goal**, one line: what changes, for whom.
2. **Their words**: the person's own words that asked for it, in quotation marks, with who and the
   date: `Josh, 2026-11-19: "Go on A1"`. Quote the ask itself, not your summary of it, and each
   person who shaped it. When no person started it (a schedule, a CI alert), say what did, in one line.
3. **Done when**: under that heading, the end state a person can see or check (a page shows X, a
   test goes green, a file exists in a folder), not process steps. One to five lines.
4. **Already shipped on this**: what git (`git log main --grep`, the paths in play) and the minions
   list show today, with the date checked and the commits or minions found, or "nothing found
   (checked 2026-11-19)". A minion that starts on work already shipped repeats it. For anything
   bigger than a one-file fix, first send a `citadel:scout` Grunt the area or your draft: its
   "Touched" lines go here, its "Tried or ruled out" and "Reusable" lines in part 6.
5. **Leave alone**: what the minion must not touch (files, lanes, another minion's branch, live
   data). "Nothing in particular" when true.
   Run `who-touches <the files it will edit>` (on every turn's PATH) and name each open minion
   already changing one of them, so the new one plans around it instead of meeting it as a conflict at the ship.
6. **Ruled out or tried**: decisions already made (quoted, dated), what was tried and failed and
   why, what is out of scope. Write "Nothing yet" when that's true, so the minion doesn't go looking.
   A change to how saved things are stored, read or applied (records, settings, saved files, a person's
   own items) also says here what happens to the ones saved before it: migrated, left as they are on
   purpose, or flagged to their owner.
7. **Read first**: paths to the handoffs, specs, reports and code worth reading, each with a clause
   on why. Paths, never pasted text: the minion reads the file itself.
8. **Model and effort**, with one line of why from the Taskmaster's model table: `Opus 5.5 high:
   design-shaped, a new flow`. create_ticket takes the pick in `model` and `effort`; the
   line in the brief is the why.

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
- An idea or research minion ends in one handoff per piece of work it proposes, then the card that
  asks which to start.

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
Ships straight to main.
```

## Briefing a Grunt

A Grunt's brief takes parts 1, 3, 5, 6 and 7; its model and effort go on the Agent call
(`citadel:subagents`), and its done-when is what it hands back and in how many lines. Put the
constraints that matter most first and again at the end.

## The check on new minions

create_ticket, and a person's Start on a handoff, warn when the brief (with any handoff file it
names) has no quoted words from a person, no "Done when", no "Already shipped on this" or no "Leave alone". The minion is still created: add the
missing part with message_ticket in the same turn, or say in the brief why there is none.

## Done lines (features)

A feature minion turns the brief's Done when and the person's words into 3 to 7 "when X, then Y"
lines before it codes, shows them in its first reply, and ticks them in its ready note.
Self-review and fresh-eyes check each line. Bugs, chores and research write none.
