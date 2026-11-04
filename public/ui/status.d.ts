// Citadel UI: a steady status line and steady labels. Types for /apps/_citadel/ui/status.js. A stable API:
// names and options are only ever added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.

export type StatusTone = 'ok' | 'warn' | 'danger' | 'info' | 'violet' | 'neutral';

export interface StatusSlot {
  /** The line: div.cui-status, role="status" unless it had a role. */
  element: HTMLElement;
  /** Say `text` (one line, cut off with an ellipsis and whole in its tooltip); a tone colours it. Empty clears it. */
  text(text: string, opts?: { tone?: StatusTone }): void;
  /** The working state: a spinner and `text` (default "Working…"). */
  working(text?: string): void;
  /** Nothing to say: the line stays, empty, at its height. */
  clear(): void;
}

export interface SteadyLabel {
  /** The span.cui-steady holding one span per label (`data-label` is its key; all but one `hidden`). */
  element: HTMLElement;
  /** Show the label `key`. Throws on a key it wasn't given. */
  set(key: string): void;
  /** The key showing now. */
  readonly current: string;
}

/** Make `el` a status line, always drawn at its fixed height, so a status change never moves what's around it. */
export function statusSlot(el: HTMLElement): StatusSlot;

/**
 * Fill `el` (a button, usually) with every one of `labels` stacked in one grid cell, showing `current` (default
 * the first), so it keeps the width of its widest label: "Save" → "Saving…" → "Saved" moves nothing.
 */
export function steadyLabel(el: HTMLElement, labels: Record<string, string | Node>, current?: string): SteadyLabel;
