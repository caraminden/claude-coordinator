# One outbox: every deferred wake, relay and armed card in one table, one dispatcher, one readout

Status: accepted, 2026-11-20 (#1370, from the quality push's architecture lens, proposal A6,
`handoffs/qp-architecture-one-outbox.md`, which Cara picked "Go" on #1264's choices page on 2026-11-20).

Seven mechanisms in Citadel each keep a list of "do this later" in a JSON blob in the settings table, under a key of
their own. Each has its own load, filter, send and write-back loop, and each makes its own choices about what a
restart, a failed send and a dismissed minion mean. So a lost wake (a minion that never wakes) has seven places to
hide, and no one screen shows what is waiting for whom: the minion list's "Waiting:" line covers only parked
minions (`runner.wakesOn`: chains, `wake_when_live`, runners back and timed wakes), and says nothing of a wait on a
minion that isn't parked, a relay or an armed card. (`ci-armed` keeps one record per minion, and held mail and the
loop guard span several key families; the table below has each.)

This ADR moves the delivery-shaped ones into one `deliveries` table, run by one dispatcher, shown in one readout. It
is built one mechanism per ship (the steps below). Nothing moves in a big bang, because one lost wake strands a
minion.

## Decisions

Quoted from Cara's answers on #1370's cards, 2026-11-20 PST:

- **Held mail goes in the runner's queue, not the outbox** ("Queue, not outbox"). `mail:`, `cold:` and the loop
  guard's held messages belong to seam 1 (`handoffs/runner-seam-one-queue.md`, one `minion-queue:<id>` per minion).
  The outbox decides *when* something is due. The queue keeps *what a minion's next turn owes*.
- **The post-deploy health watch stays out** ("Stay out"). `deploy-watch` keeps its own state and timer. Its checks
  are a schedule of probes, not deliveries.
- **A dismissed minion's waits are kept for a reopen, then dropped** ("Keep for reopen. Added: drop them after a few
  days"). They are kept 3 days (my pick of "a few"), then dropped with a reason. A dropped row stays visible, greyed,
  for 7 days.
- **A send the server may have died in the middle of is sent again** ("Send again"). It is marked as a possible
  repeat, so the reader can spot it. Nothing is silently lost to avoid a duplicate.
- **The readout goes under each minion in the minion list** (picked "C · Under each minion in the list", with "Instead
  of ->event, if its just another minion it should just have the minion number"). Choices page:
  `mockups/outbox-readout/outbox-readout-takes.html`.

Settled by me, inside those picks: the runner's resume keys stay with the runner work. Alert wakes become a timed
kind that merges into a pending batch. Chains keep their held rule. A dismissed sender's relays still go out.

## The table

One table, `deliveries`, created in one transaction with its indexes. Its queries live in `src/db/deliveries.ts`.

| Column | What it holds |
|---|---|
| `id` | integer key. It is also the **delivery id** printed in what is sent, so a resend can be spotted |
| `project_id` | the scheme |
| `kind` | `wake_at`, `wake_when_live`, `chain`, `relay`, `runners_back`, `ci_armed`, `alert` |
| `to_kind`, `to_id` | `minion` + ticket id, or `taskmaster` + project id (a relay to another scheme's Taskmaster names that scheme) |
| `when_kind` | `at` (a time), `live` (a commit live on the server), `merged` (a commit on the scheme's main), `runners` (a runner label online), `ci` (CI green on a sha), `now` |
| `when_arg` | JSON: the commit, sha, label or time the condition reads |
| `payload` | JSON, kind-specific: the text, note or brief, `light`, the card to post, the batched alerts |
| `set_by` | who asked: `minion:<id>`, `taskmaster:<project>`, a person's login, or `server` |
| `state` | `waiting`, `held`, `sending`, `sent`, `dropped`, `failed` |
| `due` | ms epoch: when a timed row is due, when a retry is next tried, or when a closed target's row is dropped. NULL for an event row still waiting on its event |
| `met_at` | ms epoch: when the row's condition first held. Once set, the row is only ever retried by `due`, never re-checked against its condition |
| `dedupe_key` | the key a re-add replaces or merges into, unique among `waiting` and `held` rows: `wake_when_live` ticket + commit, `chain` ticket, `ci_armed` ticket, `alert` project. NULL where every add is its own row (`wake_at`, `relay`) |
| `origin` | where a migrated row came from: the old key plus a hash of the whole old record, `since` and `at` included, unique. Old ids are reused once a list empties, so an id alone can't name a record |
| `attempts`, `last_error`, `reason` | retry count, the last failure, and why a row was dropped, held or failed |
| `created_at`, `updated_at` | ms epoch |

Indexes: `(state, due)` for the timer, `(state, when_kind)` for event pokes, and `(to_kind, to_id, state)` for
the readout and dismissals. Rows in `sent` are deleted after 1 day, and rows in `dropped` or `failed` after 7 days.
The table never grows the way `deploy-watch`'s 161 entries did.

The limits stay per kind: `wake_at` keeps MAX_WAKES 20 per chat and 90 days ahead, and the tools keep their names
and words (`wake_when_live`, `wake_at`, `relay_when_live`, `wake_when_runners_back`, `when_ci_passes`).

## The dispatcher

`src/outbox.ts`, one instance built in `server.ts`, holding these parts:

- **Kinds register** `{ kind, ready(row, event), deliver(rows), merge?(row, incoming), trim?(row, cleared) }`.
  `ready` is the condition. `deliver` receives every row of its kind that came due in one pass, so a relay's grouped
  note to the sender's Taskmaster (today's `sent()`) still works.
- **`deliver` returns an outcome for each row:** `accepted` (the receiver has made it durable), `retry` with a reason,
  or `drop` with a reason. A throw counts as `retry`. A normal return that delivered nothing is not `accepted`: an
  alert with no Taskmaster to wake, or a `runner.send` that logs a refusal.
- **Events poke it.** The places that call the seven loops today call `outbox.poke(event)` instead:
  - `merged` comes from `catchUp` (`server.ts` :415), and `live(head)` from `liveOn` (:424).
  - `runners(project, list)` comes from the ci-health poll (`src/ci-health.ts` :511).
  - `ci(ticket, pr, sha, ok)` comes from the GitHub watcher's `ciFinished`.
  - `closed(ticket)` and `reopened(ticket)` come from the runner.
  - `boot` fires once.

  A condition poke reads the `waiting` rows of its `when_kind` with no `met_at`. `closed` and `reopened` read rows
  by target, and chain rows by leader, whatever their `when_kind`: a leader dismissed unshipped holds its chains, and
  a leader dismissed after shipping releases them. `live`, `merged` and `reopened` also recheck `held` chains.
- **Reconcile, not only listen.** An event can be missed: the server was down, or the GitHub watcher marked a CI
  result seen just before a crash (`src/github.ts` :475, :507-511). So on `boot`, and when a row is added, every
  waiting event row is checked against the current state (the running head, the scheme's main, the runner list, the
  stored CI results), as `LiveWaiters.check` does today. An add whose condition already holds delivers at once.
- **One timer** is armed to the smallest `due` (capped at 2^31-1 ms, as `TimedWakes.arm()` is today) and re-armed on
  every add, send and cancel. `at` rows and retries ride it. The `every` loops that only checked lists (the alert
  wakes' 20 s tick) go away.
- **Per-target order:** rows for one target are delivered in `id` order, one pass at a time, through the runner's
  existing per-minion lane (`runner.onLane`), so a chain's brief and a wake for the same minion never cross. Each kind
  has one lane owner: `startChained` already takes the lane itself, so the outbox calls it from outside the lane,
  never from inside (`src/lanes.ts` would deadlock). As built (step 3, #1389): the `chain` kind's deliver runs
  `chainedStep`, the lane body without the lane, inside the outbox's own lane step; `startChained` keeps taking the
  lane for Start now and Unpark.
- **A closed target is never claimed.** Delivery re-reads the target's state when it claims a row, and skips a
  dismissed one.
- **The outbox never decides whether a turn runs.** It hands the message to the runner (`runner.send`, a Taskmaster
  message, or a card post), and later to seam 1's `queue.put`. Parked, cold, busy or at the usage limit are the
  runner's and the queue's states (#1343's supervisor, seam 1). The outbox does not read them.

## The crash rule

**What survives a restart:** every row in `waiting`, `held` or `sending`. They are in the database, not in memory.

**The send order:** a row goes `waiting → sending` (committed, with `met_at` set), then deliver, then
`sending → sent` (committed) only on `accepted`. On `boot`, rows still in `sending` are sent again with a line
saying the server restarted mid-send, so this may repeat delivery #id (Cara, "Send again"). A due `at` row missed
while the server was down is sent at boot, saying how late it is. That wording is new: `TimedWakes.fire` today
prints only the time it was set for.

**Accepted means durable.** Until seam 1, a `runner.send` to an idle minion puts the message in `runner.queues`,
which lives only in memory (`src/runner.ts` :1846-1855), until the turn starts and saves it (`saveTurn`). So until
step 8, a minion-bound row is `accepted` only when the runner reports that the turn carrying it has started. A crash
before then leaves the row in `sending`, and boot resends it. A chain is `accepted` only when its start sends the
brief (today's `release()`). A start that ends without sending it puts the row back to `waiting`.

As built in step 0 (#1385): a handed row keeps the runner's event id (`event_id`), and `Runner.onTurnStart` (called
once the turn is saved and marked running) marks the rows of the events it carries `sent`. Every 5 minutes, inside the
minion's lane, the outbox asks `Runner.holds` whether the next turn still carries the event. If it does (queued, held
mail, a usage-limit or network wait), the row waits. If not, a row a killed server left is sent again with the
possible-repeat line, and one this server handed is retried, since its turn was refused when it came to run. So a
wake held through a week-long limit and six deploys goes once, and a refused start gets the retries and the
Taskmaster alert instead of sitting in `sending`.

Once seam 1's queue exists, `deliver` becomes `queue.put`. Both are in the same SQLite database, so `put` and
`sending → sent` commit in one transaction, and the possible-repeat case disappears for every kind that goes
through the queue.

**What is retried:** a `retry` outcome puts the row back in `waiting` with `met_at` kept and `due` set 1, 5, 30, 120
and 360 minutes ahead, then marks it `failed`. A row with `met_at` is retried by its `due` alone: an event during the
backoff does not fire it early, and a condition that has since changed (head moved on) does not strand it. Today a
failed send is only logged, and the wake is gone.

**A closed target:** when a minion is dismissed, its waiting rows move to `held` with reason "target closed" and
`due` 3 days ahead, so the deadline survives a restart. A reopen moves them back to `waiting` and reconciles them at
once, so a condition met while closed delivers then. At `due`, the timer drops them. Relays are the exception: a
relay to a dismissed minion still goes out, as held mail, as today (`leaveMail`, `server.ts` :605-614).

**What is dropped, and who is told:**

| Case | Today | With the outbox |
|---|---|---|
| Target minion dismissed | `wake_when_live` dropped quietly; `wake_at` dropped when it comes due (a reopen before then keeps it); a chain whose target is closed is discarded; `ci-armed` not cleared, but consumed by the next CI result | `held` for 3 days, delivered on a reopen (a due one says it came due while the minion was closed); then `dropped`, reason "minion dismissed". A relay still goes out as held mail |
| Chain leader dismissed unshipped | `held: true`, people told once | the same: state `held`, people told once |
| Relay sender dismissed | still sent | still sent |
| `ci_armed`: PR head moved, CI red, or a turn running or queued | dropped | the same, with the reason kept |
| Runner list unreadable | the minion is told to ask a person | the same |
| All retries failed | (no retries) | `failed`; the setter's Taskmaster is woken, not given held mail, because a lost wake strands a minion |

When a row is dropped by the 3-day rule, its setter, if that is not the target, gets one held-mail line. Every
`dropped` and `failed` row shows greyed in the readout for 7 days, with its reason.

## Today's mechanisms, and how each moves

Live counts from the settings table on 2026-11-20, about 19:35 PST.

| # | Mechanism (A6's count) | Key | Condition | Retry today | Expiry / dismissed today | Live rows | Moves |
|---|---|---|---|---|---|---|---|
| 1a | `wake_when_live` (`src/wake.ts` LiveWaiters) | `wake-when-live` | commit live (`liveOn`); merged counts as live only for a scheme whose code this server doesn't run; with no commit, the next deploy after `since` | none: dropped before send, a throw is logged | dismissed: dropped quietly | 0 | as is; dismissed rule changes to 3 days |
| 1b | start-after chains (`startChained`) | `chained-minions` | leader `live` or `merged`, in its build branch for a feeder, or dismissed (shipped: go; unshipped: held) | kept until `release()`, restored on a caught send failure; a hard kill after `release()` can lose the brief | leader dismissed unshipped: `held`, told once | 15 | as is, held rule kept; `accepted` only when the brief is sent. Start now, Unpark and the held brief (`src/routes/tickets.ts` :250, :1141) read the table from the same step |
| 1c | `relay_when_live` | `relay-when-live` | commit live | none: dropped before deliver | sender dismissed: still sent; grouped note to sender's TM | 1 (from closed Peek Auras #701) | as is |
| 2 | `wake_at` (TimedWakes) | `timed-wakes` | time | missed wakes sent at boot by `arm()` | dismissed: dropped unsent; 20 per chat, 90 days | 34 (1 for a closed minion) | as is; dismissed rule changes to 3 days |
| 3 | `wake_when_runners_back` (`src/ci-health.ts` `wakeParked`) | `wake-runners-back` | a runner online among the scheme's labels, from the ci-health poll | none: dropped before send | closed or missing target: removed; unreadable list: told to ask a person | 0 | as is, under the 3-day rule |
| 4 | Alert wakes (`src/alert-wakes.ts`) | `alert-wakes` (`told`, `batches`) | batch 60 s after the last alert, at most 5 min after the first; quiet hours 2 to 9 AM Pacific | the batch is deleted before the wake and never retried; the wait restarts on fresh problems; cleared alerts are removed from a pending batch | none | (per scheme) | **with a change**: one `alert` row per scheme Taskmaster; `merge` folds new alerts into the waiting row and moves `due`; `trim` removes an alert that clears (`AlertWakes.clear`, `raise`) and drops an empty row; quiet hours set `due`. `told` stays in its own key, but it is written in the same transaction as the row, so a crash can't record an alert as told with no wake queued |
| 5 | Deploy watch (`src/deploy-watch.ts`) | `deploy-watch` | +20 min, +1 h, +1 day after a deploy | own | own | about 161 deploys tracked | **stays out** (Cara, "Stay out") |
| 6 | Held mail and the loop guard (`src/minion-relay.ts`) | `mail:<id>`, `cold:<id>`, `loop:*` | cold mail released after hold hours (a parked minion's waits); loop-held messages released by Continue | taken by `runner.takeQueue` | `releaseMail` never runs for a closed minion | 37 `mail:` (20 for closed minions), 18 `loop:` | **goes to seam 1's queue**, not here (Cara, "Queue, not outbox") |
| 7 | `when_ci_passes` (`src/ci-armed.ts`) | `ci-armed:<id>`, one record per minion; a second arm on the same sha replaces its card or note part | CI green on the armed sha, PR head unchanged, no turn running or queued | none; a failed delivery can wake the minion with the failure | not cleared on dismissal (a `shortcut:` in the code), consumed by the next CI result | 0 | as is, `dedupe_key` per ticket; the 3-day rule clears it |

Out of scope, and why:
- `waiting:<id>`, `resume-owed:<id>` and `net-resumes` are the runner's own state for resuming turns (#1343, #1364,
  seam 1).
- Keepalive keeps no saved queue.

## How it fits the runner work in flight

- **Seam 1** (#1310's runner map, `specs/adr-draft-runner-seams.md`; Cara picked "One queue per minion" on #1310's
  card, 2026-11-20): the outbox delivers into `queue.put`, and parked or cold is a queue state. Until seam 1 ships,
  `deliver` calls today's send functions, at-least-once. Step 8 below swaps them over and makes delivery one
  transaction.
- **#1343 (one turn supervisor):** the outbox only ever hands a message to the runner. Whether and when a turn starts
  is the supervisor's call. The outbox adds no turn-starting path of its own: chains call the same start the runner
  exposes today.
- **#1364 (killed turns resume themselves):** at boot the outbox runs its `sending` resends after the runner restores
  its resumes, so a resumed turn and a resent wake queue in order rather than racing.
- **#1366 (ships prepare against the next main)** and **#1363 (night lane):** no overlap. The `merged` event still
  comes from `catchUp`. A night-lane "run at 01:00" can be an `at` row if it wants one.

## Steps: one mechanism per ship

Each step adds its kind, moves its tool's writes to the table, and on boot migrates the old key's rows into the table
in one transaction: insert each row with `origin` set, then empty the old key. Saved waits are never dropped.

Until a cleanup step removes it, each step also keeps a **dual read**: the dispatcher reads the old key on every
boot and poke, and migrates anything it finds. Steps 1 to 3 share `LiveWaiters.check`: it keeps running for the
kinds not moved yet, and each step takes only its own kind out of it. A kind's readers move in the same ship as its
writer. If a deploy is rolled back, the old code reads only the old key, so
waits made meanwhile sit in the table, and are delivered late, never lost, once the code rolls forward again.

Each step moves saved data, so each ships high risk with a member's go. Each adds its kind to the restart-anywhere
test (`test/restart-anywhere.test.ts`): a server killed at each step of the send order loses no row.

0. **The table, the dispatcher and `wake_at`.** The timer, `boot`, the crash rule and the 3-day rule, proved on the
   simplest timed kind (34 live rows). Built in #1385 (`src/outbox.ts`, `src/db/deliveries.ts`, schema 103). What
   ran: `test/outbox.test.ts` (kill-resend marked across two kills, late at boot, reopen on day 2 and drop on day 4,
   the retry ladder to the Taskmaster, a limit-held wake never sent twice, a refused start retried, the migration
   keeping ids with the dual read, the limits and pruning), two `wake_at` flows in `test/restart-anywhere.test.ts`,
   a real-runner wake in `test/wake.test.ts`, and the affected set (host-check, db-setup, schema-compat, db-areas,
   db-writer, access-matrix, boot-imports), and the migration on the live `timed-wakes` list (41 rows on 2026-11-20)
   in a fresh database: all 41 moved with ids and fields kept, the key emptied, a second run a no-op. Not run: a full
   boot on a copy of the live database (625 MB and written constantly, so `.backup` never finished).
   A dismissed minion's row is held until 3 days past its own time, or 3 days past the dismissal when it was already
   due (Cara, 2026-11-20, "Keep until 3 days past due"), so a far-off wake survives a reopen before its date.
1. **`wake_when_live`**: the `live`, `merged` and `closed` events.
2. **`relay_when_live`**, with the grouped note to the sender's Taskmaster.
3. **Start-after chains**, with the held rule.
4. **`wake_when_runners_back`**.
5. **`when_ci_passes`**.
6. **Alert wakes**: the batch merge and quiet hours.
7. **The readout** (can start once step 0 is live, and covers each kind as it moves), as Cara picked:
   - Each waiting minion in the minion list gets a chip: `⏱ 06:00` for a timed wait, `⇢ #1177` for a wait on
     another minion's work, and `⇢ event` only for anything else.
   - A tap opens what the wait is on, who set it and since when, with Cancel under today's rules.
   - Dropped rows show greyed for 7 days.
   - The Taskmaster's own waits show only in the Taskmaster's chat.
8. **Into seam 1's queue** (only once seam 1 is live): `deliver` becomes `queue.put` in the same transaction as
   `sent`, and the dual reads of every moved key come out once each old key has been empty on the live server for 7
   days.

Handoffs, one per step: `handoffs/outbox-step-<n>-*.md` in the shared folder.

## Not doing

- A tool for Taskmasters or minions to list and cancel their own waits. It may be worth a pick later, but it is not
  part of this design.
- Moving the deploy watch, held mail, the loop guard or the runner's resume keys (see the decisions above).
