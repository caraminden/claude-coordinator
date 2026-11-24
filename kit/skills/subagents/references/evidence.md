# Subagents: the evidence behind the rules

Part of `citadel:subagents`, opened by name from its SKILL.md.

## Why the rows

- Judging Grunts run on Opus: on Delve's art critic Opus caught about 9 of 13 of Cara's notes,
  Sonnet 5. The stalled-worker row is Cara's (2026-11-14, "Widen to known-shape work"), the same
  tier Citadel's model table gives minions.
- The high-risk reviewer is Opus at high, not Fable: on 8 past high-risk diffs Opus caught 10 of
  18 real medium-or-high findings and Fable 11, each missing some the other caught, for $1.02 a
  run against $1.46 (#950, 2026-11-17, `reports/highrisk-review-ab-2026-11.md` in the shared folder).
  The checker stays on Fable: it wasn't tested.
- Turn count beats token price: the cheapest model took 2 to 3 times the turns on multi-step work
  in obra/superpowers' subagent-driven-development. Use `haiku` only when the brief holds
  everything the Grunt needs.

## How the cost works

Every model call re-reads the session's whole context, so a session's cost is roughly its calls
times its context. A subagent starts with a fresh, small context (about 15k tokens on average, with the
brief). It makes its own calls and hands back a summary, and the session never carries what it
read. When a session wakes after more than an hour idle, its prompt cache has lapsed, so the wake
re-writes the whole context (about $2.40 at 300k on Opus). A lean session makes every later call
and every wake cheaper. Compaction caps the cost of a session that forgets, but every compaction
is lossy: what never entered the context can't be lost from it.

Sonnet costs about half of what Opus does, cache reads included (measured 2026-11-14), so moving
known-shape work to Sonnet halves it. Keeping noisy work out of the session saves more on top.

## Heavy steps on Delve

On Delve a
build session did four merges inline and their diffs and conflict dumps were 12% of everything
that ever filled its context; code reads for review fixes were 34%.

## Why fan-outs return 3 lines

Added on
Delve #55 (Cara, 2026-10-30): 8 drawers and 8 critics over 3 rounds put about 16 reports of 20 to
40 lines each into the chat per round.
