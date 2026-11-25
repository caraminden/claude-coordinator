# A minion tries a migration on a private copy of its app's live data

Status: accepted, 2026-11-25 (#1884).

A minion had no way to run a migration against real data: an app's `DATA_DIR` isn't mounted in a person's container
(TripPresenter #81). On #1884's card Josh picked, 2026-11-25:

- "Copy into the turn": the server copies into the asking turn's own folder and the minion runs its check there, inside its
  container. Not a minion's script run on the host (it would run outside the container with the server account's reach, and
  could still print rows), and not a sealed sandbox.
- "Any home scheme member": not only apps that opt in, and no OK per run. Membership itself counts, so an admin or a Citadel
  member who isn't in the home scheme is refused. The copy holds everyone's rows; each leaves a line in the chat naming who asked.

Consequences: the live folder is only read (SQLite's one-step backup); the copy is in no other person's container and is
deleted with the turn's folder. The turn's tripwire allows writes to its own `app-copy/`. The nightly `backups/<day>/` aren't
the source: up to a day old, and they hold the same rows.
