// Citadel UI: polling that rests while the tab is hidden. Types for /apps/_citadel/ui/visible.js. A stable API: names and
// options are only ever added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.

export interface PollOptions {
  /** The document to watch (tests pass a fake); default the page's. */
  document?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;
}

/**
 * Call `fn` every `ms` while the page is visible. Hidden: nothing runs. Shown again: `fn` runs once at once and the interval
 * starts over. Not called when started (do the first load yourself). A run still going isn't stacked under the next tick,
 * and a throw is swallowed (show failures in `fn`). Returns a function that stops it for good.
 */
export function pollWhileVisible(fn: () => unknown, ms: number, opts?: PollOptions): () => void;
