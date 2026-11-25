# The runner's seams: one queue, then one outcome policy

Status: accepted, 2026-11-20. Seam 1 (one queue) built by #1378; seam 2 (one turn-outcome policy) built by #1379.
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
  was read: …"), and deletes its per-minion keys (context, window, commands, plan, keepalive, asker). Its budget marks stay, one small
  row per dismissed minion, so a reopen past them isn't asked again or its Taskmaster woken twice (#1510). A boot
  does the same for any closed minion whose queue holds more than held mail; held mail stays, since mail sent after a
  dismissal waits for a reopen (#783).
- `test/restart-anywhere.test.ts` checks the one invariant, now including parked mail and a stop, and is green with
  `RESTART_ANYWHERE_STRICT=1`.
- Left as they were: a stop still drops the queue (held mail stays), on purpose; the outbox (ADR 0021) still decides
  when mail is delivered; `turnPerson` is untouched. The loop guard's held messages stay in their own key: folding them
  in is left for later.
- Known edge: if a resume's launch fails twice in a row, the second try can resend the cut-off turn's batch along with
  its own. Duplicate, not lost.

## Seam 2 as built (#1379)

- `src/turn-outcome.ts` holds `outcome(end)`: pure, from a `TurnEnd` (the saved turn, its exit, stderr, close_self,
  where it ran, a restart's cut, the account pick's answer) to its kind, follow-ups, reason, and the resume it earns
  (`retry`) or would have earned with its cap spent (`spent`). `test/turn-outcome.test.ts` has a row for every kind.
- The runner's `wrapUp` calls it once at a turn's end; its old nine "ended well" guards are gone, and each follow-up
  (`cleared`, `close`, `fresh`, `seam`, `keepalive`, `deploy-note`, `rerun`) is read off the outcome. `recover` calls
  the same function on a turn a restart cut off (`cut`), so a killed turn is judged by the same rows either way.
  `endFailed` carries out a failed outcome: the account pick, the switch, the kill wait, or `turnFailed`'s words.
- No `save` follow-up: every turn's end is saved, whatever its kind, so it stays a step of `wrapUp`, not a row.
- The four counters (`resumes`, `limitTries`, `netTries`, `killTries`) are one `retries` record on the turn, and
  `RETRIES` holds each kind's cap and the counts its resume keeps: restart 2 (keeps kill), kill 1 (keeps restart;
  Cara's "I dont want to get in restart loops"), limit 3, net 3, switch 3 (keeps limit). The stored waits
  (`limit-resumes`, `net-resumes`, `kill-resumes`) keep their shape; a turn saved before this reads its old counters
  through `retriesOf`, so there is no migration.
- The one visible change: switching onto another of a person's Claude accounts had no cap, so two accounts that kept
  hitting the limit could hand a turn back and forth forever. It now stops after 3 switches in a row, says so in the
  chat, and waits out the limit as if no account were ready.
- Left as they were: the queue's interface, the turn-folder protocol, spawning, and every other cap and message.

## Seam 3, the running part, as built (#1937)

Picked: Josh, 2026-11-25, "Fork 5: build the running-turn part first", on #1926's choices page (worker machines, Build 7);
"Plan approved: build it this way" on the build plan the same day. The whole turn-process adapter stays not picked:
#1845 planned it the day before and recommended against it for three kinds (it read as about five places, and one bug in
a month it would clearly have prevented).

Why now: a turn on a connected machine is a fourth kind, and nothing the runner did by hand reaches it: no `process.kill`,
no `podman exec`, no `/proc`. Five places asking "which kind" would become five places each with a network case.

- `src/running-turn.ts` holds `RunningTurn`: `signal`, `endStart` (a stop before claude started), `alive`, `reattachable`,
  `outlivesServer`, `where`, `keepUp` (its supervisor) and `look` ("Is this still going?"). Behind it: `ChildTurn`,
  `UnitTurn` (a wrapper's service, or the supervisor's scope of the same name: one kind from here) and `ContainerTurn`.
- `runningTurn(at)` makes one from where the turn runs (`dir`, `unit`, `container`), the fields its saved record and
  `LiveTurn` already have. It holds nothing, so a unit that won't start and falls back to a child needs no switch, and the
  `turn:` record keeps its shape: a rollback mid-turn reads it as before.
- No change in behaviour. `test/running-turn.test.ts` pins nine behaviours for each of child, unit, supervisor and
  container through the Runner, written against the code before the move and passing unchanged after it.
- Left in the runner, by choice: starting a turn (the spawns, and `rescue`, which restarts one the supervisor gave back),
  the stream readers, the order and timing of a stop's signals (`stopSignals`, `armKill`), and what an end means (`ran`,
  for `outcome()`, and the killed row's unit name). A fourth kind will need words of its own there.
- Past the four named ("signal, stop, alive, reattach"): `outlivesServer`, `where`, `keepUp` and `look` replace kind checks the
  runner already made about a running turn, two of them inside what moved (the re-attach log line, the supervisor check).
  They add no behaviour.
- A folder with no record (a stray's, the boot sweep's) has its kind read from its `container` file, by `wrapperAlive(dir)`
  beside `runningTurn`. A new kind needs its case in both.
- Stop stays the runner's three timed signals, with `endStart` the one step that differs by kind. A kind whose far side
  keeps that clock itself (a machine's supervisor) is T2's call.

## T2 (#1962): the fourth kind, a turn on a connected machine

- `MachineTurn` (`src/machine-turn.ts`) is the class, with its case in `runningTurn(at)` and `wrapperAlive(dir)`. Its kind
  is read from the folder's `machine` file, and only when the record names no unit and no container.
- The stop clock stays the runner's: each signal is a line in the folder's `signals` file, which the machine's agent applies
  in order. A SIGKILL with the machine away writes the turn's end here, since nothing there will.
- Away is not gone: with its agent not connected a machine turn counts as alive. T6 adds the wait before it comes home.
- `ran` for `outcome()` says unit and container for a machine turn, so a kill there is never blamed on this server's restart.
- The agent runs the turn's wrapper with `podman exec`, as a person's container at home does, not a supervisor of its own:
  the wrapper already outlives the agent, and a second supervisor would need its own adoption across agent restarts.

## T3 (#1972): a machine turn's state

- The server's copy is the record. A worktree travels as one commit that holds all of it (files, index, branch, a merge or
  rebase under way), made the same way on both sides with a fixed author and date, so the same id means the same state
  (`snapshot` in `public/machine-sync.mjs`). Folders travel by file list, each change going the way it was made.
- The machine's half runs inside the worker container, not in the agent: a git config a minion wrote can then run nothing
  outside it, and every path is the server's.
- A worktree is written only under git's own index lock, only while it is still the snapshot it was read as, and by the
  form of `read-tree` that leaves a file edited since alone (`restore` with `from`). Otherwise nothing is changed, and it is
  looked at again. The files go first, then the branch and the index together, so a commit made after one cut off can't
  hold an undo. The machine finishes a cut-off pull file by file before it sends anything (`resume`), keeping what the turn
  did since. What git ignores and is in the way goes to `citadel-aside` in the worktree's git folder, and the chat says so.
- Home keeps two marks per minion: the machine's last snapshot and its own as that left it, so a lost answer or a detached
  copy is not taken for work done here. While a landing runs in the worktree, after its commit moved here, or when it can't
  be written, the machine's is kept in `refs/citadel/kept/<ticket>/`, the chat says so, and a tool that waits for it is
  refused. Files that changed here are kept there before the machine's go over them.
- A file the machine only stopped sending (ignored now, a key) stays here. Stashes come home as kept refs, tags as tags.
- Deletes travel too, only over a copy the other side left alone, and a side that lost a whole folder deletes nothing.
- A turn's `exit.json` goes home after its last checkpoint, so the runner's end-of-turn work (session save, branch state,
  links) reads the turn's files and needed no change.
- A tool that reads the worktree here waits for a checkpoint in one place: `turnCall` in `src/routes/machines.ts`, by the
  path list in `readsDisk`: 'must' is refused without one, 'may' goes on. A new tool that reads a minion's files by path goes in it.
- Not moved: ignored files, untracked keys and `.env` files, git repos inside the worktree, LFS contents, empty folders.
