// Citadel's phone drawers. Types for /apps/_citadel/drawers.js, served beside it as
// /apps/_citadel/drawers.d.ts. A stable API: names are only ever added (test/ui-contract.test.ts checks
// this file against the module's exports). How a page uses it: kit/skills/contraption-ui/rail-and-drawers.md.

/** The phone layout's breakpoint: '(max-width: 800px)'. Drawers only work under it. */
export const NARROW: string;
/** Px from the screen edge a swipe has to start in (44). */
export const EDGE: number;

/** What a touch that has moved (dx, dy) is: 'wait' while too short to tell, 'swipe' when mostly sideways in `dir` (+1 rightward, -1 leftward), else 'ignore'. */
export function classify(dx: number, dy: number, dir: 1 | -1): 'wait' | 'swipe' | 'ignore';

/** Whether a released drawer ends open: a fast flick decides, else a third of the way from `from` (0 pulling out, 1 pushing back). `progress` 0–1; `velocity` px/ms in the opening direction. */
export function settleOpen(progress: number, velocity: number, from?: 0 | 1): boolean;

/** Which drawer a touch at `x` on a screen `width` wide would pull out, if any. */
export function edgeSide(x: number, width: number): 'left' | 'right' | null;

export interface DrawerSide {
  /** The element, or a function that finds it (null when the current view has none), for pages that redraw it. */
  el: HTMLElement | null | (() => HTMLElement | null);
  /** Its name: the open drawer's aria-label, and "Open <label>" on its edge handle. */
  label: string;
}

export interface Drawers {
  open(side: 'left' | 'right'): void;
  close(): void;
  /** Take the gestures, handles and classes away (a Preact effect's cleanup). */
  destroy(): void;
}

/**
 * Phones: pull `left` and `right` out from the screen edges as drawers. `main` (an element, a list, or
 * a function returning either) goes inert behind an open drawer. On wider screens the elements stay
 * where your CSS puts them.
 */
export function initDrawers(opts?: { left?: DrawerSide; right?: DrawerSide; main?: Element | Iterable<Element | null> | (() => Element | Iterable<Element | null> | null) }): Drawers;

/** What citadel-drawer-open and citadel-drawer-close carry: which drawer, and its element. */
export interface DrawerEventDetail {
  side: 'left' | 'right';
  el: HTMLElement;
}

declare global {
  interface DocumentEventMap {
    /** On document, as a drawer's element is pulled out of the page (before it slides in, and when a swipe starts pulling). */
    'citadel-drawer-open': CustomEvent<DrawerEventDetail>;
    /** On document, once the drawer's element is back in the page (also after a swipe that let go of it). Always follows its open. */
    'citadel-drawer-close': CustomEvent<DrawerEventDetail>;
  }
}
