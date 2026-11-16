# 0007: The server's database writes run on a worker thread

Date: 2026-11-16. Minion #795.

## Context

With WAL and `synchronous = NORMAL` ([0003](0003-sqlite-synchronous-normal.md)) a commit doesn't fsync,
except one: the first write after a checkpoint that emptied the WAL starts the WAL over and fsyncs its
new header, on the writing connection's thread. That was the event loop, so whenever perigee's disk
stalled the whole server stopped: from 2026-11-14 to #791's fix, 12 loop-lag holds came from one-row
writes (44.5 s in total, the worst 14.3 s). #791 made those restarts rare. It didn't stop them. Restarting
the WAL on the checkpoint worker instead doesn't help: the header fsync holds the write lock, so the
server's next write waits just as long.

## Decision

The Store's void writes run on one worker thread with its own connection, in the order they're called
(`src/db-writer.ts`). Cara, 2026-11-16, card answer "Writes on a worker", plan approved the same day.

- A sent write returns a promise of the write instead of nothing. A failed one is logged and lands in the
  health log as `db-write-error`. Its caller only learns of it by awaiting.
- A read on the server's connection waits up to 50 ms for writes still queued, so it sees them. If the
  disk is stalled, it reads without them, and later reads don't wait until the queue catches up. An HTTP
  response waits the same way. Settings are the exception: a setting sent and not yet written is read
  from memory, so a get-then-set (merge goes, turn nonces) never loses the update before it. A cached
  card row is dropped both when its change is sent and when it lands.
- Writes that return a value (createTicket and about 30 more) still run on the server's thread, after the
  whole queue. If the queue doesn't empty within 30 s they throw instead of running ahead of it.
  Step 2 moves them.
- addEvent picks its event's id on the server's thread, so it still returns the row at once.
- At exit, the queue is written first, for up to 10 s.
- If the worker can't start or stops, writes go back to the server's thread. Writes it had queued when it
  died are lost, logged and counted in the health log (`db-writer-stopped`): replaying them could run
  the one in flight twice.
- Tests and tools that open a Store write inline unless they call `writeOffThread`. The server always
  calls it, so every test that boots `server.ts` runs with the worker.

## Consequences

- A stalled disk delays writes and leaves reads briefly stale. It no longer freezes pages, turns or tool calls.
- A write that breaks a constraint no longer throws at its caller. A route that answers from such a
  failure awaits the write (the machine rename's 409).
- A value-returning write still waits for the queue. If the disk stalls under one, the event loop waits
  too, until step 2.
