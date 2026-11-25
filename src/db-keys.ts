// Settings keys built from ids, shared by src/db.ts, its area files under src/db/ and their callers (#1313).
/** Settings key: who asked for a ticket's turns, when that isn't whom they run as (Store.turnAsker). */
export const askerKey = (ticketId: number) => `asker:${ticketId}`;
/** Settings key: which minion owns a scheme's Build <n> (build branches, specs/build-branches.md), set by create_ticket's build_owner. */
export const buildOwnerKey = (projectId: number, build: number) => `build-owner:${projectId}:${build}`;
/** A minion's own memory folder, as each login last held it (src/sessions.ts, #1952). */
export const ownMemoryKey = (ticketId: number) => `memory-own:${ticketId}`;
/** A minion's task-list state as of its last finished turn, so a restart replays only what came since (#530; src/runner.ts progressFor). */
export const planKey = (ticketId: number) => `plan:${ticketId}`;
/** A minion's task-list state just before the furthest chat page start read, so a restart's first open replays only what came since (#613; src/history.ts planBefore). */
export const pagePlanKey = (ticketId: number) => `plan:${ticketId}:page`;
