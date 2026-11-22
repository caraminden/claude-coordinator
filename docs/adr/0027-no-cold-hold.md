# A message meant to wake its reader wakes it: no cold hold

Status: accepted, 2026-11-22. Decided on #1603's card. Supersedes the cold hold of #413, and with it ADR 0015's "unless it is cold" for the budget alert: that alert now wakes an idle Taskmaster too. Data: the shared folder's `reports/held-mail-2026-11.md`.

Since #413, a machine message (minion to Taskmaster, Taskmaster to minion, minion to minion, Taskmaster to Taskmaster)
sent to a session idle over 55 minutes was held as mail, and the sweep woke the session after 3 hours, unless the
sender passed `urgent`. The idea was to save the cost of reloading a cold context.

- **Cara, 2026-11-22:** "I think there might be cases where held mail doesn't have a benefit? Like most minions aren't
  getting many messages right? So their held mail is just a 3 hour delay." On the card she picked "Drop the hold".
- **The data (14 days, all schemes):** the hold saved about 39 cold wakes, roughly $10–18 a week out of about $9,500.
  It made half of the messages that needed action wait over an hour, 244 hours in all. 42% were released by the
  3-hour timer, and 20 of 22 of those carried a single message, so nothing was batched. No signal I tried (an open
  card, a person active recently, time of day) picked out the holds that pay.
- **The rule now:** the sender's choice is final. A message sent to wake its reader wakes it, however long that reader
  has been idle. A fyi, `wake: false` or one of Citadel's own notes is still held mail and rides the next turn, as before.
- **`urgent` does nothing now.** The tools no longer offer it; the server still accepts it, so old prompts don't break.
- **Unchanged:** a parked minion still holds everything until it is unparked or woken, the loop guard still holds
  runaway exchanges, card answers and a person's own messages always run, and keepalives keep their gates (#1274).
- **Draining:** mail held before the change keeps its scheme's hold cap (3 hours unless the scheme set another). The sweep, the Held list's Deliver now and the
  `msg_cold_min` / `msg_hold_h` columns stay, but their settings are gone from the rules page. Nothing is migrated.
