// Citadel UI: tooltips. Types for /apps/_citadel/ui/tip.js. A stable API: names and options are only ever
// added (test/ui-contract.test.ts checks this file against the module's exports).
// Like every file in public/ui/, standalone: apps fetch it from /apps/_citadel/ui/ beside the module.

export interface TipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What a tip shows: HTML (escape what you put in it), an element (a `markdownElement`, say), null for no tip, or undefined for the element's plain `data-tip` text. */
export type TipContent = string | Node | null | undefined;

export interface TipOptions {
  /**
   * The tip's content for `el`, now or as a promise (skeleton lines show meanwhile; a rejection shows
   * "Couldn't load this: …"). Null: no tip. Undefined, or no `body` at all: the element's `data-tip`, as
   * text with its line breaks kept (none when it's empty), so plain tips need nothing here. Read whatever
   * `data-*` attributes you gave the element; wrap slow loads in a `TipCache`.
   */
  body?(el: HTMLElement): TipContent | Promise<TipContent>;
  /** Which elements have a tip (default `[data-tip]`). */
  selector?: string;
  /** `'dialog'` when the tip holds links or buttons to follow (Tab from the thing goes into them); `'tooltip'` (default) otherwise. */
  role?: 'tooltip' | 'dialog';
  /** The tip box's accessible name, for a dialog tip. */
  label?: string;
  /** Extra classes on the tip box (div.cui-tip). */
  className?: string;
  /** A tap or click on a tipped element only toggles its tip, even on a button: for chips whose whole job is their tip. */
  tapOpens?: boolean;
  /**
   * More things a tap acts on, as a selector, beside buttons, links, form fields and their ARIA roles:
   * on a touch screen their tip waits for a long press, so the tap still does its thing.
   */
  acts?: string;
  /** Called with the element whose tip opened, or null when it closed. */
  onChange?(el: HTMLElement | null): void;
}

export interface Tips {
  /** Redraw the open tip's body (after what it shows has changed). */
  refresh(): void;
  close(): void;
  /** The element whose tip is open, or null. */
  readonly open: HTMLElement | null;
  /** Stop listening and remove the tip box. */
  destroy(): void;
}

/**
 * Give every `[data-tip]` element under `root` (default `document.body`) a tooltip. It opens on mouse
 * hover after 250 ms (60 ms moving from tip to tip), at once on keyboard focus, and on touch on a tap,
 * or a 450 ms long press for things a tap acts on (that press's click is swallowed). It sits below the
 * thing or above it, never over it, inside the window, in the top layer; Escape, a press outside or a
 * scroll closes it; one is open at a time; it follows a redraw's copy of its element (same `id` and
 * `data-tip*` attributes); the element gets `aria-describedby` while it's open. Needs theme.css and base.css.
 */
export function mountTips(root?: Element | Document, opts?: TipOptions): Tips;

/**
 * Where a `w` × `h` tip goes for target `t` in a `vw` × `vh` window: below when it fits, else above,
 * else the roomier side with `maxHeight` capped to it. Never over the target, 8px clear of the edges.
 */
export function placeTip(t: TipRect, w: number, h: number, vw: number, vh: number): { left: number; top: number; maxHeight: number };

/**
 * Tip bodies by key and revision, for a `body` that loads: a hover loads once per revision, a re-hover
 * is instant, a failed load is forgotten so the next hover asks again. Least recently used out past `max` (300).
 */
export class TipCache<T = TipContent> {
  constructor(max?: number);
  get(key: string, revision: string | number, load: () => T | Promise<T>): Promise<T>;
  readonly size: number;
}
