# Retros

Each milestone's retro (the `citadel:retro` skill), one file each. This README is the ledger:
mistakes more than one retro has found, and what now stops each. A row needs two retros.

| Mistake | Retros | Guard |
|---|---|---|
| Build minion not woken when a feeder merges in | `build-1-desktop-gpu-jobs.md` (the Taskmaster woke #855), `build-2-prompt-bundle.md`, `build-3-per-person-taskmasters.md` | #927: a feeder's merge wakes and unparks the build owner |
| Feeders' self-reviews rate a change by its own files and miss a gate that only the whole-build review catches | `build-3-per-person-taskmasters.md` (`turnPerson`), `build-4-reviewers-and-critics.md` (ship gate with go threshold `never`), `build-6-platform-and-apps.md` (incidents in previews, a stop's mark on Start) | The build's Fable review of the whole diff (build step 5); no per-feeder guard yet |
| `SCHEMA_HISTORY` and ADR numbers picked by hand collide with main's while a branch is open | `build-2-prompt-bundle.md`, `build-4-reviewers-and-critics.md`, `build-6-platform-and-apps.md` | None yet: `test/schema-compat.test.ts` only catches it in CI. Handoff `handoffs/numbers-at-ship-time.md` (land.sh hands out the number; pipeline lane) |
| A feeder's land runs only its own files' tests, so a break elsewhere shows only in the build's full run | `build-4-reviewers-and-critics.md` (db-setup, cold-mail, question-images), `build-6-platform-and-apps.md` (static kit import, query-plan test) | `tools/affected-map.txt` (#1112); `test/boot-imports.test.ts` for server copies that can't boot |
