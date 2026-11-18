// Citadel's app rail. Types for /apps/_citadel/rail.js, served beside it as /apps/_citadel/rail.d.ts.
// A stable API: names are only ever added (test/ui-contract.test.ts checks this file against the
// module's exports). How a page includes it: kit/skills/contraption-ui/rail-and-drawers.md.
// Loaded as a <script type="module">, it draws the rail by itself, unless <html data-citadel-rail="slot">.

/**
 * The protocol name on every message between Citadel's page and a framed contraption's rail.js (postMessage,
 * `{ protocol: FRAME, type, ... }`): the two are on different origins (#709), so they talk only this way.
 */
export const FRAME: 'citadel-frame-1';

/** A contraption as GET /api/contraptions/mine lists it. */
export interface MyContraption {
  name: string;
  title: string;
  /** Its icon: a path under the app, or an /apps/ or http(s) URL. */
  icon?: string | null;
  /** false: its service is down or its keys don't open, so the rail greys it and fetches nothing from it. */
  up?: boolean;
  /** Its own address, https://<name>.<domain>/, when Citadel serves apps on their own hosts (APPS_DOMAIN); absent otherwise. */
  url?: string;
}

/** One rail entry: Citadel first (`name` null), then each contraption. */
export interface RailItem {
  name: string | null;
  title: string;
  href: string;
  icon: string | null;
  current: boolean;
  down?: boolean;
}

/** The rail's entries for `mine`, with `current` the contraption showing (null: Citadel's own views). None when nothing is enabled. */
export function railItems(mine: MyContraption[] | null | undefined, current: string | null, citadel?: string, inCitadel?: boolean): RailItem[];

/** Whether an entry opens apart from the page, from a contraption's own installed app (`installed`): every entry but its own, in Citadel's layer over the page, in the same window (#311). */
export const opensApart: (item: RailItem, installed: boolean) => boolean;

/** Whether the rail is showing (so a phone's swipe past the left panel has somewhere to go). */
export const hasRail: () => boolean;

/** For drawers.js: a swipe from the left edge pulls out the page's left drawer, and only past it the switcher (false: not any more). */
export function leaveEdge(taken?: boolean): void;

/** Phones: slide the rail out as the app switcher, over whatever is open. */
export function openRail(): void;

/** Close the phone's switcher. */
export function closeRail(): void;

/**
 * Place the rail in `el` yourself (with <html data-citadel-rail="slot">): an icon column under 120px
 * wide, the switcher list from 120px. Resolves to whether there is a rail (false: nothing enabled
 * besides you, so drop the slot).
 */
export function mountRail(el: HTMLElement): Promise<boolean>;

/** Take the rail away. */
export function hideRail(): void;

/** Fetch your contraptions and draw the rail, or take it away when there are none. Resolves to whether there is one. */
export function showRail(): Promise<boolean>;

/** How the rail's Install button installs the app showing, or null to hide it (#297). `own`: on the app's own page, not framed in Citadel. */
export type InstallMode = 'prompt' | 'intent' | 'tab' | 'ios';
export function installMode(at: { own: boolean; standalone: boolean; prompt: boolean; installed: boolean; android: boolean; ios: boolean }): InstallMode | null;

/** An Android intent:// link that opens `url` in Chrome itself (a Custom Tab's menu has no Install), else the plain URL. */
export const chromeIntent: (url: URL) => string;

/** Whether the page runs inside an app's native shell (Capacitor WebView or a "CitadelApp" user agent), where the rail never renders. */
export function inNativeApp(win?: unknown): boolean;
