---
paths:
  - "src/turn-launch.ts"
  - "src/machine-turn.ts"
  - "src/worker-join.ts"
  - "src/cloud-*.ts"
  - "src/cloud-*.mjs"
---

# A new place for turns to run

When you add a place where a minion's turn, or part of one, runs away from perigee (a machine, a cloud
session, a container), these go in the same ship, not in follow-ups:

- **An off switch a member can flip** without a deploy. It stops new work going there and says where that
  work runs instead. `CLOUD_OFF` in `src/cloud-pool.ts` and Pause all in `src/routes/machines.ts` are the
  existing examples.
- **Questions reach people.** When the turn there asks a question, someone in the chat sees it as a card,
  and the answer goes back to the turn. If the place can't do that, stop the turn from asking. `src/cloud-turn.mjs`
  does both (#2191).
- **What a stop or the switch does to work already running there.** Either it finishes, or it is brought
  back and rerun on perigee. Say which, and test it.

**Why:** #2153 put cloud sessions live with none of these, at 22:25 PST on 2026-11-26. Within 20 minutes a cloud
session's question had stranded on claude.ai, and Cara asked: "Lets turn off cloud sessions until we figure this out".
#2191 and #2193 were then built as follow-ups (`docs/retros/effort-worker-pool-across-machines-2026-11-27.md`, fix 2).
