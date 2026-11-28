---
paths:
  - "src/turn-launch.ts"
  - "src/machine-turn.ts"
  - "src/worker-join.ts"
  - "src/cloud-*.ts"
  - "src/cloud-*.mjs"
  - "src/ci-runner.ts"
  - "src/ci-hold.ts"
  - "tools/land/ci.sh"
  - ".github/workflows/tests.yml"
---

# A new place for turns or CI to run

When you add a place where a minion's turn, or part of one, runs away from perigee (a machine, a cloud
session, a container), or move where CI runs (GitHub's runners, a desktop, a fallback between them), these
go in the same ship, not in follow-ups:

- **An off switch a member can flip** without a deploy. It stops new work going there and says where that
  work runs instead. `CLOUD_OFF` in `src/cloud-pool.ts` and Pause all in `src/routes/machines.ts` are the
  existing examples.
- **Questions reach people.** When the turn there asks a question, someone in the chat sees it as a card,
  and the answer goes back to the turn. If the place can't do that, stop the turn from asking. `src/cloud-turn.mjs`
  does both (#2191).
- **What a stop or the switch does to work already running there.** Either it finishes, or it is brought
  back and rerun on perigee. Say which, and test it.
- **What reads where the work ran.** List every reader that assumes the old place and update it, or put it
  in your brief's Done when. For CI: the CI page (`src/ci-view.ts`), the desktop's hold and its busy counts
  (`src/ci-hold.ts`), land reds and fallbacks. A reader you leave as it is goes in a handoff in this ship,
  not only in the risk reason, which nobody picks up.

**Why:** #2153 put cloud sessions live with none of the first three, at 22:25 PST on 2026-11-26. Within 20 minutes a cloud
session's question had stranded on claude.ai, and Cara asked: "Lets turn off cloud sessions until we figure this out".
#2191 and #2193 were then built as follow-ups (`docs/retros/effort-worker-pool-across-machines-2026-11-27.md`, fix 2).
On 2026-11-27 #2209 moved ship CI to GitHub; the CI page still drew the desktop until Cara asked "should the CI page have
useful info on it?" (#2231), and the hold's desktop-shaped rules, named in #2209's risk reason, went to no one
(`docs/retros/effort-github-ship-ci-2026-11-27.md`, fix 1).
