# Prompt evals: replaying real corrections against a prompt or a tier

Status: accepted, 2026-11-19 (#1117, from idea minion #1092's handoff "replay rig for our own prompts and tiers").

Prompt changes to minions and the Taskmaster shipped on a reviewer's read alone: nothing showed whether a reworded rule
still stopped the slip it was written for, or whether a cheaper model or effort would still make the right move. #1110's
skill trigger evals measured one narrow thing (does a skill fire). `tools/prompt-eval` measures the move itself.

**What it is.** 28 frozen moments from Citadel's own chats where a person corrected a minion or the Taskmaster (12 strikes,
10 "why didn't you…" corrections, 6 rule slips). Each case holds what the minion knew, the message it answered, the
answers its tools gave (a stub MCP server answers every Citadel tool from the case's `facts`; nothing reaches the live
app), and code checks on the rerun's tool calls and text. The rerun gets the real prompt of the version under test
(`promptParts` or, before #878, `systemPrompt`, plus the version's kit, CLAUDE.md and `.claude/`), in a read-only copy
of the repo at the moment's commit. Each case runs 3 times; a case passes on a majority. A Sonnet judge reads each rerun
too and only advises. Five closed bug fixes (`briefs/`) rerun whole from before their fix, for tier questions: a run
passes when the fix's own shipped tests go green on the rerun's code.

The grilling round with Josh, 2026-11-19:

1. **Which moments:** "Citadel's own, mixed": strikes, corrections and rule slips, Citadel's chats only.
2. **Where:** "In the repo", `tools/prompt-evals/`, versioned with the prompts it tests.
3. **Who owns the set:** "Taskmaster owns it": the Citadel Taskmaster adds and prunes cases.
4. **When:** "On ask + big changes": never per edit and never in CI; it runs on perigee on the asker's login, outside
   `citadel-heavy`'s line since #1629, as it waits on Claude, not the CPU (Josh asked whether it would run on Cara's
   desktop CI: no).
5. **Tiers:** "Both, small": opening moves on every case, plus whole reruns of a few closed briefs.
6. **A drop:** "Drop needs a go": a case fell when its passing runs drop by 2 or more; 2 or more fallen cases make a
   prompt change high risk.

**Cost.** About $0.50 per opening move on Opus high, mostly the ~50k-token prompt's cache write: a 30 × 3 run is about
$45 a side. That is why it runs on ask and before big changes only.

**Limits.** The Citadel-wide and scheme instructions live in the database, so runs use a snapshot in `fixture/`. A rerun
doesn't get the minion's auto-memory or any live state beyond its `facts`, and the replay guard refuses calls that name
today's shared folder, database, live checkout or memory.

**The first run** (2026-11-19, $82.55 over two runs): today's prompt passes 22 of 28 cases (79%); the known-bad
version (code `268638ee` with the instructions live on 2026-11-11) passes 17 (61%), with 7 cases fallen. An audit of
the first run found 10 case bugs (loose or vacuous checks, a fact that never fired, inputs in the refused shared
folder), fixed before the second. Two rule cases were dropped: they hinged on work already on the minion's branch,
which a replay checkout starting from main doesn't have. The full write-up is the shared folder's
`reports/prompt-evals-baseline-2026-11-19.md`.
