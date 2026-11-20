# Citadel snapshots an app's data before a deploy that changes its migrations

Status: accepted, 2026-11-19 (#1137, Build 6; from #1093's platform ideas, A6). Reverses one line of #828.

## Context

#828 (2026-11-16) set the backup convention: each contraption writes its own finished copies to `$DATA_DIR/backups/<day>/`
before 04:00 PST, Citadel ships them off the box, and "Citadel never snapshots app data itself". #1016 (ADR 0010) then let an
app list `migrations` in `citadel-app.json`, and refused any Roll back to last green past a change to one, because older code
may not read data a newer one migrated.

Six app deploys failed in the week of 2026-11-16. A failed deploy's roll back restored the code but left the data as the
failed version's migration left it, and Roll back to last green was refused past exactly the deploys most likely to need it.

## Decision

Josh picked "Build it" on #1093's choices page on 2026-11-19, with the reversal of #828's line spelled out on the card.

- A deploy forward whose commit changes a path the app's `migrations` lists (old manifest's or new) stops the app after its
  turns drain, copies its `DATA_DIR` with `cp -a --reflink=auto` to `~/.local/share/.<name>.snapshots/<time>-<commit>/data`
  beside a `snapshot.json`, and then starts the new code. The deploy's lines say it was taken.
- If the new code fails its health check, the automatic roll back restores that snapshot with the old code.
- Roll back to last green past a migration change restores the newest snapshot taken under code whose `migrations` paths match
  the commit it goes back to; with none it is refused as before.
- A restore never deletes: the data it replaces is moved, whole, into a snapshot of its own.
- Each app keeps its newest 3 snapshots, together at most 10 GB (apparent size); the ones a step just took or restored are
  never pruned by that step, and the deploy says which went and which are kept. A `DATA_DIR` over 10 GB isn't snapshotted.
- A deploy with no migration change, a first deploy and a deploy of the same commit take none.

The rest of #828 stands: apps still write their nightly backups, and those are what leave the box. Snapshots are for roll backs.

## Consequences

- A deploy that changes migrations stops the app for the length of the copy. On perigee's btrfs a reflinked copy shares blocks,
  so it takes about as long as walking the files; on another filesystem it is a full copy, and the cap bounds it.
- Rolling back to a snapshot drops what the app's people wrote after it from the running app. It stays in the kept copy, for a
  person to merge back by hand; Citadel doesn't merge data.
- A copy cut short is left as a `.part` folder, which isn't listed or pruned: a person removes it.
