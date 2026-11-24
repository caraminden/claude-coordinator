# A retro when a multi-minion effort ends, in every scheme

Status: accepted, 2026-11-24 (#1751).

On #1744's retro card Cara was asked whether Citadel should run a retro when a multi-minion effort finishes (3 or more
minions on one goal, like the CI speed-up chain), the way Delve retros every milestone. She answered "Yes, add it" and added "Why not
other schemes too if they do a big project?" (2026-11-23). So the trigger runs in every scheme.

Her picks on #1751's card (2026-11-24):
- **What marks an effort:** "Both". The Taskmaster names one with the global `effortName` property on its first minion.
  A start_after chain nobody named is named `chain from #<leader>`, and the leader takes that name too.
- **Who starts the retro:** "Starts by itself". The server starts a `citadel:retro` minion. Neither the Taskmaster nor a card starts it.

The picks the brief left to the minion (#1751):
- **What it rests on:** a text property in the global registry (`src/property-seed.ts`), seeded at startup, so there is no schema change.
  A new minion inherits it at create: from its own properties first, then its start_after leader's, then its parent's
  (`effortFor`). This is stamped when the minion is made, because start_after deliveries are pruned once they are sent.
- **Floor:** 3 minions for a named effort and 4 for an unnamed chain, since a 3-minion chain is often only ordering.
  The Taskmaster's own row doesn't count.
- **Finished:** every minion has closed, and the last one closed at least 6 hours ago. The wait lets a follow-up the
  Taskmaster starts join the effort before its retro runs.
- **No doubling up:**
  - An effort with more than half its minions in one major build gets no retro, because the build's retro covers it.
    The skip is recorded.
  - The build skip counts only builds with a build minion (`build-owner:` set). A bare build number, such as Delve's
    "found in" build on a bug, has no build retro to cover it.
  - Each effort gets one retro: the `effort-retro:<scheme>:<name>` setting holds its verdict and when. Minions that join
    after it are counted only if the name is reused for a later goal: a name gets a new retro once 3 minions made after
    the last verdict have all closed.
  - A start that fails (no worktree, say) is tried again on later ticks, 3 times in all.
  - The monthly retro and the "Process digest, all schemes" schedule are unchanged.
- **The retro minion:**
  - It's a research-tier minion (`pickFor('research')`), assigned to the first minion's person, and its turns run for them.
  - It writes `effort-<slug>.md` in the scheme's retro folder.
  - It makes the scheme's own fixes itself and puts kit fixes in a handoff for Citadel.
- **Judge:** `effort-retros` in `src/judges.ts` was built log-only, as every new judge is (#1503), and acts since her answer below.
  - While log-only, it notes the retro it would start in the scheme's retro log and marks the effort `would`.
  - Once it's switched to act, those efforts' retros start too, so nothing is lost while it watches.
  - At ship time its replay had no efforts to read: none were named before this change.
  - That was at odds with her "Starts by itself", so it went to her on #1751's card (2026-11-24). She picked "Start for real
    now": the judge acts from the start, on an empty replay. She also kept "4 for an unnamed chain" and "Follow-ups join"
    (minions a minion asks for join its effort).
