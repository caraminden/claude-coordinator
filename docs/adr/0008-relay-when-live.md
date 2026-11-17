# 0008: A minion queues a cross-scheme note for when its change is live

Status: accepted, 2026-11-16 (#852, from #848's route D).

## Context

Minions kept asking the Taskmaster to "relay this to <scheme> once I'm live", about 54 Taskmaster turns a week. On 2026-11-16 (#783) Cara said "anything cross-scheme stays with the Taskmaster".

## Decision

`relay_when_live` queues a note for another scheme's Taskmaster or a minion (#N) of the same scheme. The server leaves it as held mail (no wake) once the commit is live, using the same check as `wake_when_live`. Cara picked this on #848's choices page and added: "What if we sent it as an FYI to the taskmaster so it has a chance to notice stuff on its next turn?" So the sender's own Taskmaster gets the full text as held mail when the note is queued, and a one-line note when it goes out.

This sends cross-scheme held mail without a Taskmaster turn, which #783's words would not have allowed. Cara accepted that with the FYI above. The reach is the one `message_taskmaster` uses for the person the turn runs for (`schemeTarget`).

## Consequences

- Pending relays survive a restart (a setting, like waiters). A dismissed minion's relays still go out.
- A failed land leaves them queued. The land-failure wake text lives in `src/land.ts`, a pipeline-lane file, so it doesn't list them: the tool lists and cancels (no arguments, or `cancel`).
