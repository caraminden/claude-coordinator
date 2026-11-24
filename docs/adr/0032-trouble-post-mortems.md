# A post-mortem when a minion is in trouble, in every scheme

Status: accepted, 2026-11-24 (#1796).

Cara asked on 2026-11-24 whether the retro skill should run more, after hearing how Matt Pocock uses his. On the Taskmaster's card she picked "Retro on trouble" and "Every two weeks" for the standing retro.

Picks the brief left to the minion:
- **Trouble means one of two marks the server already keeps**, so no schema or marker was added:
  - *Over budget:* the minion's `minion_budget:<id>` setting has `asked`, which the runner writes when spend passes the ask mark (twice the expected cost, at least $3).
  - *Fix didn't hold:* a `ticket_picks` row after the first whose `by` is `Taskmaster`. A person's "that fix didn't hold" reaches the model only as the Taskmaster's `update_ticket` step-up, which writes that row. A Taskmaster's step-up for another reason (a stall it noticed itself) counts too: the signal is "a Taskmaster moved the model up", not the person's words.
- **When:** after the minion has closed. It is never interrupted, and a minion that never closes (sealed for good) gets none. A read-only side look on a live minion was the other option; it would cost a second read of a changing minion and could race its own fix.
- **Once only:** a `trouble-retro:<minion>:<budget|stepup>` setting per minion per trigger, written before the start; both triggers due together share one post-mortem. A post-mortem minion gets `post-mortem-of:<its id>` when it is made and is skipped, so it can't post-mortem itself. A failed start is tried again, 3 times in all, as effort retros are.
- **Back catalogue:** `trouble-retros:since` is written by the first tick; only trouble at or after it counts, so the deploy doesn't post-mortem every old minion.
- **Launcher:** the effort-retro launcher's file and deps (`newMinion`, `runner`, judge mode, the 10-minute tick), as a second class, `TroubleRetros`.
- **The minion:** Sonnet medium, type `research`, assigned to the troubled minion's owner and run for their person. It reads only through `citadel:investigator`, proposes one fix on a card `to` the owner, and writes one ledger line in the scheme's retro folder. Its cost is capped by its brief ("Expected cost: ~$3") so its own budget alarm asks it to explain or stop past $6 ($3 floor rule), and it has no code changes to make.
- **Judge:** `trouble-retros` is registered log-only, as every new judge is (#1503); it notes the post-mortem it would start and marks the trouble `would`, and switching it to act starts those too.
- **Kit:** the `monthly-retro` template's default cron is now `0 7 1,16 * *` (every two weeks), with the stagger cut to 12 days so the later day stays under the 28th. `staggerCron` accepts a day list.
