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

/** A status line as HTML, a span so it can sit in a heading. `inner` is statusTextHtml() and the like ('' for nothing);
 * `fill` makes it cui-status-fill (in a row: takes what's left, never widens it); `className` adds your own classes. */
export function statusSlotHtml(inner?: string, opts?: { tone?: StatusTone; fill?: boolean; className?: string }): string;

/** One line of status text as HTML (escaped): cut off with an ellipsis, whole in its tip; `tone` colours this text alone. */
export function statusTextHtml(text: string, opts?: { tone?: StatusTone }): string;

/** A spinner and `text` (default "Working…") as HTML for a status line. */
export function statusWorkingHtml(text?: string): string;

/** steadyLabel()'s stack as HTML (labels are text, escaped), showing `current` (default the first). Throws on an unknown key. */
export function steadyLabelHtml(labels: Record<string, string>, current?: string): string;

/** Say `text` in passing: a toast (div.cui-toast) at the bottom centre, in the top layer, so it moves nothing, for
 * `ms` (default 4000) or until tapped. One at a time; a screen reader hears it from a live region. `action` adds a
 * button after the text (button.cui-toast-action) that calls `run` and sends the toast away: "Couldn't save" · Retry.
 * `onHide` is called once when this toast goes: its time is up, a tap, its action, or a newer toast replacing it.
 * `undo` (instead of `action`, never both: that throws) is an Undo button that Ctrl-Z (Cmd-Z on a Mac) presses too,
 * the newest first, then the one before, even after its toast has gone, never while focus is in a text field
 * (its own undo wins there). `live()`, if given, says it still makes sense; once false, key and button skip it. Each
 * Undo runs at most once, by key or button; the key shows "Undone: <text>" in place of the toast. Make `run` show
 * the undone state at once (optimistic() for its request). Returns the toast's `hide()`, which hides it only while
 * it's still the one showing. */
export function toast(text: string, opts?: { tone?: StatusTone; ms?: number; action?: { label: string; run: () => void }; undo?: { run: () => void; live?: () => boolean }; onHide?: () => void }): { hide(): void };
