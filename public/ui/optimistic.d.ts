// Citadel UI: optimistic actions. Types for /apps/_citadel/ui/optimistic.js. A stable API: names and options are
// only ever added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.

export interface OptimisticAction<T = unknown> {
  /** Actions with the same key send one after another, in the order they were made; other keys (or none) send at once. */
  key?: string | number;
  /** Change the page now, as if the request had already worked. Synchronous. */
  apply?: () => void;
  /** The request. Called at once, or after the same key's earlier sends settle. */
  send: () => Promise<T>;
  /** Roll back what apply() did, this action alone, when send fails. Gets send's error. */
  undo?: (err: unknown) => void;
  /** What the action is, for the failure toast: 'reject speculation' → "Couldn't reject speculation". */
  label?: string;
}

/**
 * Show an action's result at once and send it behind, so a click never waits and never blocks the next one: apply(),
 * then send() (queued behind the same key's earlier sends). If send fails: undo(), and a danger toast "Couldn't
 * <label>" with a Retry that runs apply and send again; failures while that toast is up join it ("(and 2 more)"),
 * and its Retry runs them all. Returns send's promise; its rejection is already handled, so chaining is optional.
 */
export function optimistic<T>(action: OptimisticAction<T>): Promise<T>;
