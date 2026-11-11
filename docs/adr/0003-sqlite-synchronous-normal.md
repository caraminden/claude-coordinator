# 0003: SQLite commits without an fsync each (synchronous NORMAL)

Date: 2026-11-10. Minion #470.

## Context

Citadel's databases (`coordinator.db` and `state.db`) run in WAL mode with SQLite's default
`synchronous = FULL`, so every commit waits for an fsync. On perigee's btrfs disk under write load an
fsync takes 300 ms (p90) and up to 6 s (#426). A turn commits a dozen times or more. Under a slow-fsync
shim (150 ms each), fresh-session's slowest test made 121 fsyncs and went from 3.7 s to 18.4 s, against
a 20 s limit. The same cost slows every test that boots a server and the live server's writes.

## Decision

`synchronous = NORMAL` on both files. Cara, 2026-11-10, on #470's card: "Live and tests".

In WAL mode, NORMAL fsyncs the WAL at checkpoints, not on every commit
([SQLite's docs](https://www.sqlite.org/pragma.html#pragma_synchronous)). The same test now makes 18
fsyncs and runs in 4.8 s under the shim.

## Consequences

- An app crash, a kill or a failed restart loses nothing, and the database can't be corrupted.
- A power cut or kernel crash can lose the last few seconds of commits (since the last checkpoint).
- `test/db-setup.test.ts` checks the setting on both files.
