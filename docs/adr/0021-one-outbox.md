# One outbox: every deferred wake, relay and armed card in one table, one dispatcher, one readout

Status: accepted, 2026-11-20 (#1370, from the quality push's architecture lens, proposal A6,
`handoffs/qp-architecture-one-outbox.md`, which Cara picked "Go" on #1264's choices page on 2026-11-20).

Seven mechanisms in Citadel each keep a list of "do this later" in a JSON blob in the settings table, under a key of
their own. Each has its own load, filter, send and write-back loop, and each makes its own choices about what a
restart, a failed send and a dismissed minion mean. So a lost wake (a minion that never wakes) has seven places to
hide, and no one screen shows what is waiting for whom: the minion list's "Waiting:" line covers only parked
minions' chains and `wake_when_live`.

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
| `due` | ms epoch: when a timed row is due, or when a failed send is tried again. NULL for event rows |
| `origin` | the old key and id a migrated row came from, unique. This makes a migration idempotent |
| `attempts`, `last_error`, `reason` | retry count, the last throw, and why a row was dropped, held or failed |
| `created_at`, `updated_at` | ms epoch |

Indexes: `(state, due)` for the timer, `(state, when_kind)` for event pokes, and `(to_kind, to_id, state)` for
the readout and dismissals. Rows in `sent` are deleted after 1 day, and rows in `dropped` or `failed` after 7 days.
The table never grows the way `deploy-watch`'s 161 entries did.

The limits stay per kind: `wake_at` keeps MAX_WAKES 20 per chat and 90 days ahead, and the tools keep their names
and words (`wake_when_live`, `wake_at`, `relay_when_live`, `wake_when_runners_back`, `when_ci_passes`).

## The dispatcher

`src/outbox.ts`, one instance built in `server.ts`, holding these parts:

- **Kinds register** `{ kind, ready(row, event), deliver(rows), merge?(row, incoming), onDismiss? }`. `ready` is the
  condition. `deliver` receives every row of its kind that came due in one pass, so a relay's grouped note to the
  sender's Taskmaster (today's `sent()`) still works.
- **Events poke it.** The places that call the seven loops today call `outbox.poke(event)` instead:
  - `live(head)` and `merged` come from `liveOn` and `catchUp` (`server.ts` :415, :424).
  - `runners(project, list)` comes from the ci-health poll (`src/ci-health.ts` :511).
  - `ci(sha, ok)` comes from the GitHub watcher's `ciFinished`.
  - `closed(ticket)` and `reopened(ticket)` come from the runner.
  - `boot` fires once.

  A poke reads only the `waiting` rows of the matching `when_kind`.
- **One timer** is armed to the smallest `due` (capped at 2^31-1 ms, as `TimedWakes.arm()` is today) and re-armed on
  every add, send and cancel. `at` rows and retries ride it. The `every` loops that only checked lists (the alert
  wakes' 20 s tick) go away.
- **Per-target order:** rows for one target are delivered in `id` order, one pass at a time, through the runner's
  existing per-minion lane (`runner.onLane`), so a chain's brief and a wake for the same minion never cross.
- **The outbox never decides whether a turn runs.** It hands the message to the runner (`runner.send`, a Taskmaster
  message, or a card post), and later to seam 1's `queue.put`. Parked, cold, busy or at the usage limit are the
  runner's and the queue's states (#1343's supervisor, seam 1). The outbox does not read them.

## The crash rule

**What survives a restart:** every row in `waiting`, `held` or `sending`. They are in the database, not in memory.

**The send order:** a row goes `waiting → sending` (committed), then deliver, then `sending → sent` (committed). On
`boot`, rows still in `sending` are sent again with a line saying the server restarted mid-send, so this may repeat
delivery #id (Cara, "Send again"). A due `at` row missed while the server was down is sent at boot, saying how
late it is. `TimedWakes.arm()` does this today.

Once seam 1's queue exists, `deliver` becomes `queue.put`. Both are in the same SQLite database, so `put` and
`sending → sent` commit in one transaction, and the possible-repeat case disappears for every kind that goes
through the queue.

**What is retried:** a `deliver` that throws puts the row back in `waiting` with `due` set 1, 5, 30, 120 and 360
minutes ahead, then marks it `failed`. Today a failed send is only logged, and the wake is gone.

**What is dropped, and who is told:**

| Case | Today | With the outbox |
|---|---|---|
| Target minion dismissed | `wake_at` and `wake_when_live` dropped quietly; `ci-armed` never cleared | kept `waiting`; delivered on a reopen within 3 days (a due one says it came due while the minion was closed); after 3 days `dropped`, reason "minion dismissed" |
| Chain leader dismissed unshipped | `held: true`, people told once | the same: state `held`, people told once |
| Relay sender dismissed | still sent | still sent |
| `ci_armed`: head moved, CI red, or a turn running | dropped | the same, with the reason kept |
| Runner list unreadable | the minion is told to ask a person | the same |
| All retries failed | (no retries) | `failed`; the setter's Taskmaster is woken, not given held mail, because a lost wake strands a minion |

When a row is dropped by the 3-day rule, its setter, if that is not the target, gets one held-mail line. Every
`dropped` and `failed` row shows greyed in the readout for 7 days, with its reason.

## Today's mechanisms, and how each moves

Live counts from the settings table on 2026-11-20, about 19:35 PST.

| # | Mechanism (A6's count) | Key | Condition | Retry today | Expiry / dismissed today | Live rows | Moves |
|---|---|---|---|---|---|---|---|
| 1a | `wake_when_live` (`src/wake.ts` LiveWaiters) | `wake-when-live` | commit live (`liveOn`), on main (`catchUp`), or any deploy | none: dropped before send, a throw is logged | dismissed: dropped quietly | 0 | as is; dismissed rule changes to 3 days |
| 1b | start-after chains (`startChained`) | `chained-minions` | leader `live` or `merged` | at-least-once: kept until `release()` | leader dismissed unshipped: `held`, told once | 15 | as is, held rule kept; `deliver` sends the brief |
| 1c | `relay_when_live` | `relay-when-live` | commit live | none: dropped before deliver | sender dismissed: still sent; grouped note to sender's TM | 1 (from closed Peek Auras #701) | as is |
| 2 | `wake_at` (TimedWakes) | `timed-wakes` | time | missed wakes sent at boot by `arm()` | dismissed: dropped unsent; 20 per chat, 90 days | 34 (1 for a closed minion) | as is; dismissed rule changes to 3 days |
| 3 | `wake_when_runners_back` (`src/ci-health.ts` `wakeParked`) | `wake-runners-back` | a runner of the label online, from the ci-health poll | none: dropped before send | unreadable list: told to ask a person | 0 | as is |
| 4 | Alert wakes (`src/alert-wakes.ts`) | `alert-wakes` (`told`, `batches`) | batch 60 s after the last alert, at most 5 min after the first; quiet hours 2 to 9 AM Pacific | saved before the wake | none | (per scheme) | **with a change**: one `alert` row per scheme Taskmaster; `merge` folds new alerts into the waiting row and moves `due`; quiet hours set `due`. `told` (what was already said) stays in its own key: it is memory, not a delivery |
| 5 | Deploy watch (`src/deploy-watch.ts`) | `deploy-watch` | +20 min, +1 h, +1 day after a deploy | own | own | about 161 deploys tracked | **stays out** (Cara, "Stay out") |
| 6 | Held mail and the loop guard (`src/minion-relay.ts`) | `mail:<id>`, `cold:<id>`, `loop:*` | released after hold hours; a parked minion's mail waits | taken by `runner.takeQueue` | `releaseMail` never runs for a closed minion | 37 `mail:` (20 for closed minions), 18 `loop:` | **goes to seam 1's queue**, not here (Cara, "Queue, not outbox") |
| 7 | `when_ci_passes` (`src/ci-armed.ts`) | `ci-armed:<id>` | CI green on the armed sha, head unchanged, no turn running | none | never cleared on dismissal (a `shortcut:` in the code) | 0 | as is; the dismissed rule now clears it after 3 days |

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
boot and poke, and migrates anything it finds. If a deploy is rolled back, the old code reads only the old key, so
waits made meanwhile sit in the table, and are delivered late, never lost, once the code rolls forward again.

Each step moves saved data, so each ships high risk with a member's go. Each adds its kind to the restart-anywhere
test (`test/restart-anywhere.test.ts`): a server killed at each step of the send order loses no row.

0. **The table, the dispatcher and `wake_at`.** The timer, `boot`, the crash rule and the 3-day rule, proved on the
   simplest timed kind (34 live rows).
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
