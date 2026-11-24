# Retros

Each milestone's retro (the `citadel:retro` skill), one file each. This README is the ledger:
mistakes more than one retro has found, and what now stops each. A row needs two retros.

| Mistake | Retros | Guard |
|---|---|---|
| Build minion not woken when a feeder merges in | `build-1-desktop-gpu-jobs.md` (the Taskmaster woke #855), `build-2-prompt-bundle.md`, `build-3-per-person-taskmasters.md` | #927: a feeder's merge wakes and unparks the build owner |
| Feeders' self-reviews rate a change by its own files and miss a gate that only the whole-build review catches | `build-3-per-person-taskmasters.md` (`turnPerson`), `build-4-reviewers-and-critics.md` (ship gate with go threshold `never`), `build-6-platform-and-apps.md` (incidents in previews, a stop's mark on Start) | The build's Fable review of the whole diff (build step 5); no per-feeder guard yet |
| `SCHEMA_HISTORY` and ADR numbers picked by hand collide with main's while a branch is open | `build-2-prompt-bundle.md`, `build-4-reviewers-and-critics.md`, `build-5-for-people.md` (89 to 95: five renumbers), `build-6-platform-and-apps.md`, `2026-11-20-21.md` (#1378: an ADR number taken while it waited) | #1221 (`tools/ship-numbers.ts`) renumbers the `SCHEMA_HISTORY` tail and ADR files at ship time; `test/schema-compat.test.ts` in CI. Whether #1378's case slipped past #1221 is unknown |
| A feeder's land runs only its own files' tests, so a break elsewhere shows only in the build's full run | `build-4-reviewers-and-critics.md` (db-setup, cold-mail, question-images), `build-5-for-people.md` (inbox.test after #1217), `build-6-platform-and-apps.md` (static kit import, query-plan test), `2026-11-20-21.md` (8+ minions: `--affected` missed a test only CI caught), `2026-11-10-24.md` (the map was touched in 21 commits from Nov 21 to 24, among them #1622, #1701 and #1738) | `tools/affected-map.txt` (#1112), patched row by row; `test/boot-imports.test.ts` for server copies that can't boot. No check yet that a test importing a changed module is in the map |
