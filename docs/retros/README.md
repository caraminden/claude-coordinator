# Retros

Each milestone's retro (the `citadel:retro` skill), one file each. This README is the ledger:
mistakes more than one retro has found, and what now stops each. A row needs two retros.

| Mistake | Retros | Guard |
|---|---|---|
| Build minion not woken when a feeder merges in | `build-1-desktop-gpu-jobs.md` (the Taskmaster woke #855), `build-2-prompt-bundle.md`, `build-3-per-person-taskmasters.md` | #927: a feeder's merge wakes and unparks the build owner |
| Feeders' self-reviews rate a change by its own files and miss a gate that only the whole-build review catches | `build-3-per-person-taskmasters.md` (`turnPerson`), `build-4-reviewers-and-critics.md` (ship gate with go threshold `never`) | The build's Fable review of the whole diff (build step 5); no per-feeder guard yet |
