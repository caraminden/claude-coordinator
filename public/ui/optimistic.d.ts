// Citadel UI: optimistic actions. Types for /apps/_citadel/ui/optimistic.js. A stable API: names and options are
// only ever added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.

export interface OptimisticAction<T = unknown> {
  /** Actions with the same key send one after another, in the order they were made; other keys (or none) send at once.
   * When each response redraws a whole view, give the view one key ('workshop:' + patch), or answers land out of order. */
  key?: string | number;
  /** Change the page now, as if the request had already worked. Synchronous. */
  apply?: () => void;
  /** The request. Called at once, or after the same key's earlier sends settle. */
  send: () => Promise<T>;
  /** Roll back what apply() did, this action alone, when send fails. Gets send's error. */
  undo?: (err: unknown) => void;
  /** What the action is, naming the item, for the failure toast: 'reject "Ritual altars…"' → "Couldn't reject "Ritual altars…": <error>". */
  label?: string;
}

/**
 * Show an action's result at once and send it behind, so a click never waits and never blocks the next one: apply(),
 * then send() (queued behind the same key's earlier sends). If send fails: undo(), and a danger toast "Couldn't
 * <label>: <error message>" with a Retry that runs apply and send again; failures while that toast is up join it
 * ("(and 2 more)"), and its Retry runs them all. The promise settles once, Retries included: with the value of the
 * first send that goes through, or with the last error once the failure toast goes without a Retry. So success
 * handling chained on it runs after a Retry too. Its rejection is already handled, so chaining is optional.
 */
export function optimistic<T>(action: OptimisticAction<T>): Promise<T>;
