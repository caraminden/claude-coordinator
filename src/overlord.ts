// The Overlord (#921): the scheme-level Taskmaster session a scheme gets once a second member writes
// (specs/per-person-taskmasters-overlord.md). It holds what has no owner: the claims, alerts that name no
// minion, other schemes' messages for nobody in particular, and the open builds.
import type { Store, Ticket } from './db.ts';

/** Where an ownerless job goes: the scheme's Overlord, else (a one-person scheme) its only Taskmaster. */
export function overlordOrLead(store: Store, projectId: number): Ticket | undefined {
  return store.getCoordinator(projectId);
}
