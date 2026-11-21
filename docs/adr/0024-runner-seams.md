# The runner's seams: one queue, then one outcome policy

Status: accepted, 2026-11-20. Seam 1 (one queue) built by #1378; seam 2 (one turn-outcome policy) not built yet.
Proposed by #1310. Evidence: the shared folder's `reports/runner-map-2026-11.md`.

`src/runner.ts` runs every turn of every minion. ADR 0001 cut turn launch out into `src/turn-launch.ts` and
recorded that "the `Runner` class itself is not split: its queue, resume and stream code share too many Maps and
store keys for this cut". This ADR names the cut that finally works on that shared state. The cut is not by size.
It is by what keeps breaking:

- Messages owed to a turn live in 8 places in the runner, plus the loop guard's held messages. About 15 methods copy
  them between those places.
- What an ended turn means is decided three times, in `wrapUp`, `turnFailed` and `recover`, under three resume
  counters.

The durability bugs of November 2026 are mostly misses in those copies: A1, A2, #259, S03-6, and the four write-order
gaps #1290 found.

Decision: Cara, 2026-11-20, on #1310's card, picked "One queue per minion; One turn-outcome policy". The turn-process adapter was not picked.

## The decision, as proposed

1. **One queue per minion** (`minion-queue:<id>`). Everything owed to a minion's next turn is held in one durable record.
   That covers people's messages, mail, relays, the loop guard's held messages, steered lines and owed resumes. It
   is reached through `put / take / giveBack / hold / release / owe`. A taken batch stays in the record until its
   turn is durably done. Waits and resumes keep counters and timers, never copies of messages.
2. **One turn-outcome policy**, after 1. A pure `outcome()` maps how a turn ended to a kind, and the follow-ups that
   kind triggers:
   - kinds: ok, stopped, closing, limit, net, switch-account, account-error, killed, failed;
   - follow-ups: close, keepalive, fresh step, deploy note, save.

   One `apply()` carries it out against the queue. `recover` calls the same function after a restart. Retry caps live
   in one table keyed by kind.
3. **The turn-process adapter waits.** #1343 is replacing the per-turn wrapper with one supervisor and keeps the
   turn-folder contract on purpose. Revisit the near side of that contract once it is live.

## Considered options

- **One explicit, persisted state machine for the minion** (a `minion_state` row with typed transitions, absorbing
  1 and 2 at once). Rejected for now. It is the logical end state, but as one rewrite of the runner's hottest code it
  collides with #1364, #1365, #1343 and #1129, which are all editing it. Seams 1 and 2 reach most of it in two
  ships, each tested on its own.
- **Splitting the runner's tenants** (spend, budget, progress, plan, usage, Codex, cards; about 550 lines) into
  files. Rejected: a cut by line count. They don't share the lifecycle state, and nothing gets deeper.
- **Fix each copy gap where it is found** (the status quo, as #1286 and #1364 do). It works one bug at a time, and
  each new path (RL1's kill resume, the next wait) adds another copy site.

## Consequences

- A new way for a turn to end becomes one row of the outcome table, not a fourth resume path.
- `test/restart-anywhere.test.ts` checks one invariant: every message that was put is in the queue or in a finished
  turn's transcript. The parked-mail and stop flows it lacks today join it with seam 1.
- Closing a minion empties its queue (delivered, or a chat note for held mail) and deletes its per-minion keys,
  closing the runner's share of the saved-state leak (architecture lens A13).
- The outbox (A6) delivers *into* the queue. Holding (parked or cold) is a queue state, not an outbox one.

## Seam 1 as built (#1378)

- `src/minion-queue.ts` holds the record: `msgs` (waiting for the next turn), `held` (held mail, with `coldAt` for
  the cold cap), `taken` (the batch a running turn took), `steered` (lines steered into that turn) and `owed` (a resume a
  restart still owes). Every change is one write of the whole record, so a crash between two changes finds each
  message in exactly one place. The record is deleted once it is empty.
- The first boot of this code moves the old keys into it (`waiting:`, `resume-owed:`'s queued, `turn:`'s queued and
  steered, the limit, network and kill waits' queued, `mail:` and `cold:`), keeps each message once, and runs again
  safely if it is cut off. Nothing is dropped: a closed minion's old held mail moves too and waits for a reopen, and its
  old queued messages are named in its chat. On a copy of the live database it moved 39 minions' saved messages and left none of the old keys.
- Write order: a message is put in the queue before its chat line. The line's event id is reserved first
  (`Store.reserveEventId`), so the queued message and its line share one id. A hard crash between the two loses the
  line, never the message.
- A taken batch stays in the record until its turn is saved as done. A start that runs no turn (no folder, a launch
  that can't be built) gives the batch back as held mail, so the freed lane doesn't loop on it. An owed resume is paid
  once its turn is saved as running (`launchTurn`), not when the batch is taken.
- A message refused to a turn (the person's login can't run it) is dropped, as before; held mail stays. Kept as held
  mail, a disabled person's message would pick them to pay for every later batch and refuse it too (review finding).
- A turn's end writes its owed save (`saving:`) before it deletes its record (`turn:`), so a crash between finds one of
  them: recover redoes the save, which takes the answered batch out, and never gives it back to run again. A stopped
  turn's batch is never given back either, even when the stop came before its process ran.
- Unpark sends its wake before clearing `parked`, so a crash between the two leaves the minion parked with its mail.
- Closing a minion empties its queue, names whatever was still waiting in a chat note ("Dismissed before this message
  was read: …"), and deletes its per-minion keys (context, window, commands, plan, keepalive, budget, asker). A boot
  does the same for any closed minion whose queue holds more than held mail; held mail stays, since mail sent after a
  dismissal waits for a reopen (#783).
- `test/restart-anywhere.test.ts` checks the one invariant, now including parked mail and a stop, and is green with
  `RESTART_ANYWHERE_STRICT=1`.
- Left as they were: a stop still drops the queue (held mail stays), on purpose; the outbox (ADR 0021) still decides
  when mail is delivered; `turnPerson` is untouched. The loop guard's held messages stay in their own key: folding them
  in is left for later.
- Known edge: if a resume's launch fails twice in a row, the second try can resend the cut-off turn's batch along with
  its own. Duplicate, not lost.
