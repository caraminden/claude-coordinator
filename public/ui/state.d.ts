// Citadel UI: loading, failed, empty and tabs. Types for /apps/_citadel/ui/state.js. A stable API:
// names and options are only ever added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.

/** A spinner and `text` (default "Loading…") in div.cui-loading, role="status". Give it your own min-height to match what replaces it. */
export function loadingLine(text?: string): HTMLElement;

/** `text` with a Retry button (label overridable) when `retry` is given: div.cui-failed, role="alert". */
export function failedLine(text: string, opts?: { retry?: () => void; label?: string }): HTMLElement;

/** A mark, a title and what would fill it: div.cui-empty. `tone` is a chip tone (default ok). */
export function emptyState(title: string, line?: string, opts?: { mark?: string; tone?: 'ok' | 'warn' | 'danger' | 'info' | 'violet' | 'neutral' }): HTMLElement;

export interface Tabs {
  /** div.cui-tabs, role="tablist"; each tab a button.cui-tab, role="tab", aria-selected. Arrow keys move between them. */
  element: HTMLElement;
  /** Pick `key` without calling onSelect. */
  set(key: string): void;
  readonly current: string;
}

/** A row of tabs. `items` is [key, label] pairs (a label may be a Node); `onSelect(key)` runs on every click (the picked tab's too) and on an arrow key. */
export function tabs(opts: { items: Array<[string, string | Node]>; current?: string; onSelect?: (key: string) => void; label?: string; className?: string }): Tabs;
