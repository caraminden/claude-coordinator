# Background jobs out of server.ts

`server.ts` is the boot file. It has no unit tests and is still one of the most edited files (151
commits in the 14 days to 2026-11-10). About 240 of its lines were background jobs that could only be
exercised by booting the whole server. The November 2026 architecture report listed moving them out
as a leftover, and Cara approved the plan on #475's card on 2026-11-10 ("Plan approved: build it this
way").

## Decision

- Four jobs move into classes that take what they need and import nothing that boots:
  `ScheduledRuns` (`src/schedules.ts`), `MemoryIndexer` (`src/memory.ts`), `ArtifactScanner`
  (`src/artifact-scan.ts`) and `ShipStatus` (`src/ship-status.ts`). `test/background-jobs.test.ts`
  tests each on a scratch database.
- Every `setInterval` and its `BOOT_CHECK` / `PREVIEW` gate stays in `server.ts`, so the boot file
  still says in one place what runs where, and importing a module starts no timer. The per-minion
  debounce timers (`schedule`, `scheduleCheck`) live in the classes: they only run when called.
- The bodies moved whole. The `App` object's fields kept their names, so no route file changed.
- One land with no behaviour change, behind a person's go, since `server.ts` can keep the service
  from starting.

## Consequences

- Not moved: the startup sweep, the one-off backfills, `writeVocabularies`, `newMinion`,
  `startChained` and static serving. They aren't periodic jobs, and moving them would only move wiring.
- `ShipStatus` imports `DEPLOY_FAILURE` from `src/routes/tickets.ts`, which writes it, rather than
  moving the key.
- A new background job goes in a module of its own, the same way, with its timer line in `server.ts`.
- The report's other leftover, one object per MCP tool in `src/mcp.ts`, was not done. Cara, on #475's
  card on 2026-11-11: "Skip it, close #475". It would reshuffle about 1,000 lines of text every turn
  reads for what the report called a modest gain.
