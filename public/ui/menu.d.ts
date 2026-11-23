// Citadel UI: the right-click menu. Types for /apps/_citadel/ui/menu.js. A stable API: names and options are only
// ever added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.

export interface MenuItem {
  /** What it does, in a few words ("Copy link"). */
  label: string;
  /** Runs when it's picked (click or Enter); the menu has closed by then. */
  run?(event: Event): void;
  /** A glyph before the label (an emoji or ✎). */
  icon?: string;
  /** Its shortcut, shown on the right ("Alt+Shift+P"). */
  keys?: string;
  /** One of the Point pair: drawn in the accent, bold. */
  point?: boolean;
  /** A red item (Dismiss). */
  danger?: boolean;
  /** Greyed and does nothing; still reachable with the arrows so its reason is read. */
  disabled?: boolean;
  /** Why it's disabled, shown after the label ("Dismissed 1:40 PM PST", "reconnecting…"). */
  reason?: string;
  /** An app's own item: the menu puts a "From <app>" line above the first of a run. */
  from?: string;
}

export interface MenuSpec {
  /** The kind of thing clicked, in the header's chip ("Minion", "Message"); default "Page". */
  kind?: string;
  /** The chip's colour as a CSS colour (a var() works). */
  hue?: string;
  /** Or one of Citadel UI's tones. */
  tone?: 'ok' | 'warn' | 'danger' | 'info' | 'violet' | 'neutral';
  /** What it is, after the chip, cut off with … ("#1663 Right-click menu"). */
  name?: string;
  /** The items in order; '-' draws a line. Falsy entries are skipped, so `cond && item` works. */
  items: Array<MenuItem | '-' | null | undefined | false>;
  /** A muted line at the bottom ("Shift+right-click: the browser's own menu"). */
  foot?: string;
  /** The menu's accessible name (default "<kind> actions"). */
  label?: string;
  /** Where focus goes back on Escape (default: what had focus when it opened; if a redraw replaced it, its copy with the same id or data-id). */
  returnTo?: HTMLElement;
  /** Draw it as a bottom sheet with a grab bar and a dim behind (x and y are ignored). mountMenus's `longPress` sets it. */
  sheet?: boolean;
  /** Called once when it closes, however it closes. */
  onClose?(): void;
}

/** Where a `w` × `h` menu opened at (`x`, `y`) goes in a `vw` × `vh` window. Pure. */
export function placeMenu(x: number, y: number, w: number, h: number, vw: number, vh: number): {
  left: number;
  top: number;
  maxHeight: number;
  flipX: boolean;
  flipY: boolean;
};

/** Open a menu at (`x`, `y`) in the window, replacing any open one; focus moves to its first item. */
export function openMenu(spec: MenuSpec, x: number, y: number): HTMLElement;

/** Close the open menu, if any; focus goes back unless `refocus` is false. */
export function closeMenu(refocus?: boolean): void;

/** Whether a menu is open now. */
export function menuOpen(): boolean;

export interface MountMenusOptions {
  /** Where right-clicks are heard (default the document). */
  root?: Document | HTMLElement;
  /** The menu for what was right-clicked (or focused, for Shift+F10 / the Menu key); null for the browser's own. */
  menuFor(target: Element, event: Event | null): MenuSpec | null;
  /**
   * Open the menu as a bottom sheet on a phone's long press (450 ms, a move past 10 px cancels; the ending tap is
   * swallowed). `true` for everything `menuFor` has a menu for, or a function that picks by target and spec.
   * Default off.
   */
  longPress?: boolean | ((target: Element, spec: MenuSpec) => boolean);
}

/**
 * Wire right-click and Shift+F10 / the Menu key to `menuFor`. Text boxes and Shift+right-click keep the browser's
 * own menu. Returns a function that unmounts it.
 */
export function mountMenus(options: MountMenusOptions): () => void;
