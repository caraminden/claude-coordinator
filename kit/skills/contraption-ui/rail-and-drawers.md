# The app rail and phone drawers

Reference for `citadel:contraption-ui`: Citadel's app rail (`/apps/_citadel/rail.js`) and phone drawers (`/apps/_citadel/drawers.js`) in an app's page. Rail: Citadel #238, 2026-11-01. Phone drawers: Citadel #245, 2026-11-01. Moved here from the shared `specs/contraptions/app-rail.md` (#283), so every scheme can read it.

The rail is the icon column down the left edge that lists Citadel and the contraptions enabled for the person (Cara, 2026-11-01: "B · An app rail on the left edge", "Only shows if you have an app enabled"). Citadel draws it on its own pages; on yours, one script Citadel serves draws it.

**Citadel's pick: a script that draws into a container you place** (Mandate's option a), not an element you render yourself (b) or a frame (c). One reason: the script keeps the list, icons, current-app mark and look the same in every contraption and updates with Citadel, while your container keeps your page stack and swipes yours. A frame would add a second URL, history and title, and an installed contraption opens your page directly anyway.

## The two ways to include it

### 1. Place it yourself (for apps with their own left column: Mandate, Peek Auras)

On wide screens the rail goes in your container. On a phone, hide the container and use Citadel's phone drawers (below): a swipe right past your left drawer slides the same switcher out over the page, as in Citadel. You can instead keep the container showing on a phone as your own leftmost swipe page, if you build your own swipe pages.

```html
<html data-citadel-rail="slot">   <!-- tells the script to wait for mountRail -->
```

```js
import { mountRail } from '/apps/_citadel/rail.js';
// el: your container. Desktop: your left edge, 56px wide, full height. Phone: display: none (with drawers.js).
const hasRail = await mountRail(el);
if (!hasRail) { /* nothing enabled besides you: drop the slot and the swipe page */ }
```

- **One container for both widths.** The script lays the rail out by the container's width, not the screen's: under 120 px wide it's the icon column (34 px icons, Citadel at the top, a divider, then the contraptions); 120 px and over, it's the switcher list (36 px icon and title per row, the current app highlighted), filling the container.
- **Give the container a definite width** (`56px` on desktop, `100vw` or your page width on a phone) and a height. The script sets `container-type: inline-size` on it, so its width can't come from its content.
- **Preact:** call `mountRail(ref.current)` once in a `useEffect` after the container mounts, and don't render children into it; the script owns its contents. Calling it again (say, after your layout swaps the container) moves the rail to the new one.
- `mountRail` resolves to `false` when the person has no contraption besides yours, which is when Cara wants no rail at all ("Only shows if you have an app enabled"). Hide the slot and the swipe page then.
- In this mode the script adds no padding, no fixed column, no handle and no edge swipe: your layout and gestures are entirely yours.
- **Container hidden on a phone** (`display: none`): `openRail()`, which drawers.js calls past your left drawer, moves the rail out of the container and slides it out as the switcher list. It goes back into the container when the screen widens past 800 px.

### 2. The default (anything else)

```html
<script type="module" src="/apps/_citadel/rail.js"></script>
```

- **Wide screens (over 800 px):** a fixed column on the left edge, `var(--citadel-rail)` wide (56 px, plus the left safe area when installed). The script sets `padding-left: var(--citadel-rail)` on `<html>`, so normal page flow moves right by itself. Anything `position: fixed` or `absolute` against the viewport's left edge should start at `left: var(--citadel-rail, 0px)` (unset when there's no rail), and full-window layouts should use `calc(100vw - var(--citadel-rail, 0px))`. The rail sits at `z-index: 50`.
- **Phones (800 px and under):** no column. The switcher slides out over your page from a swipe right from the left edge (first 44 px) or a tap on the slim handle mid-way down the left edge (`.citadel-rail-handle`, hide it with CSS if your own handle sits there). With drawers.js and a `left` drawer, the edge and handle are the drawer's, and the switcher is a swipe past it. `openRail()` and `hasRail()` are exported for your own triggers. It closes on a tap outside it, a swipe back left, or Escape.

## Either way

- The script asks Citadel for the person's contraptions (`GET /api/contraptions/mine`, same origin, their own login: `[{ name, title, icon }]`) and draws nothing if there are none.
- It brings its own styles (classes `citadel-rail*`, as a constructed stylesheet, so a strict `style-src` CSP doesn't block it). It needs nothing else from you.
- Your `icon` in Citadel's registry (Settings → Contraptions) is a path you serve, relative to your base: `/icon.svg` means `/apps/<name>/icon.svg`. Make it square and at least 72 px; it's shown at 34–36 px with rounded corners. With no icon you get a letter tile.
- Picking an app opens it inside Citadel's window (next section); picking the one you're in does nothing (in the default mode it closes the switcher).

## Inside Citadel's window (#274)

Cara, 2026-11-02, after the first take opened each contraption in its own installed app's window ("This makes it worse, now it opens in a new window"): picking a contraption shows it **inside Citadel**. Citadel's `#/apps/<name>` view shows your page (`/apps/<name>/`) in a frame beside Citadel's rail, over Citadel's page. In Citadel's installed app it's inside Citadel's scope, so no out-of-scope strip and no second window.

- **Your frame stays alive** once opened, hidden while the person is elsewhere, so switching back keeps their place. Citadel's own page keeps its place under it too.
- **Framed, rail.js draws no rail of its own**: Citadel's is beside you. `mountRail` resolves `false` (hide your slot and swipe page, as with no rail). `hasRail()` and `openRail()` reach Citadel's rail, so drawers.js's swipe past your left drawer, the left-edge swipe and the slim handle all slide out Citadel's switcher on a phone. Nothing to do on your side.
- **Don't refuse framing:** no `X-Frame-Options` and no `frame-ancestors` stricter than `'self'`. Same origin, so your cookies, service worker, notifications and storage work as on your own page.
- **Leaving the frame:** a link that should replace Citadel's whole window needs `target="_top"`. Your own navigation stays in the frame, and Citadel's address stays `#/apps/<name>` (your inner path isn't in it, so a reload starts you at your base).
- **From your own page** (your installed app, or a tab), the rail's entries are links into Citadel: Citadel's root, and `/c/#/apps/<other>` for the others. In your installed app they open apart (`target="_blank"`), which Chrome hands to Citadel's installed app: its open window comes forward (`launch_handler` `focus-existing`) and shows the contraption picked.

## Phone drawers (drawers.js)

Cara's Mandate phone layout (2026-11-01): "the main view should be the list, right swipe is the Acolyte, left is different sections, currently only notes, then left again is Contraptions/Citadel". She picked "Citadel's edge drawers" for those, and "Share it, served by Citadel" for the code. So Citadel serves its own phone drawers, and Citadel's page uses the same module: a fix reaches every app.

```js
import { initDrawers } from '/apps/_citadel/drawers.js';
const drawers = initDrawers({
  left: { el: sectionsNav, label: 'Sections' },   // pulled in from the left edge
  right: { el: acolyteAside, label: 'Acolyte' },  // pulled in from the right edge
  main: listEl,                                   // goes inert behind an open drawer
});
// drawers.open('left' | 'right'), drawers.close(), drawers.destroy()
```

- **Options.**
  - `left` and `right`: each optional, `{ el, label }`. `label` names the drawer for screen readers and its edge handle.
  - `el`: the element itself, or a function that finds it each time (returning `null` when the current view has none), for a page that redraws it.
  - `main`: what goes inert behind an open drawer: an element, a list of them, or a function returning either. Pass what sits beside the drawers, not a wrapper around them: an element holding the open drawer is left alone. The page is kept from jumping relative to the first one while a drawer comes and goes.
- **Phones only (800 px wide and under).** On wider screens nothing changes: your elements stay where your CSS puts them. On a phone, elements you passed directly are hidden until pulled out (the script marks them `data-citadel-drawer`). Elements you pass as a function are yours to hide on a phone, as Citadel does. Don't hide them yourself on a phone either way: a drawer is the element itself, slid in.
- **What it does**, the same as Citadel's own drawers:
  - a swipe in from within 44 px of an edge pulls a drawer out;
  - a drawer settles open once dragged a third of the way, or on a flick;
  - it goes back on a drag toward its edge, a tap on the backdrop, Escape, or following a link inside it;
  - while one is open, focus stays inside it and `main` is inert;
  - reduced motion is respected;
  - a sideways scroller under the finger scrolls instead of pulling a drawer;
  - slim handles mid-way down each edge open the drawers with a tap, since Safari's own back and forward swipes win the screen edges in a tab.
- **Two deep on the left.** With the rail showing, a swipe right past the open left drawer slides out the app switcher, the same list as in Citadel and every other app. Pass a `left` and the left edge is the drawer's: rail.js drops its own left-edge swipe and handle. With no `left`, a swipe from the left edge opens the switcher directly. Importing drawers.js loads rail.js too, which draws the rail by itself in the default mode. Set `data-citadel-rail="slot"` and call `mountRail` to place it yourself.
- **The phone switcher: hide your rail slot on phones, and let drawers.js open the switcher.** (This answers the question Mandate #6 asked; the alternative was passing the slot in as the left stack's second level.) Then the switcher is the same in every app and needs no wiring on phones. Your desktop slot stays as it is.
- **Styles come with it**, as a constructed stylesheet (classes `citadel-drawer*`). You supply only the contents and these:
  - Width: `--citadel-drawer-width` on the element (default `min(86vw, 340px)`). Your desktop width doesn't carry over to the drawer.
  - Background: `--citadel-drawer-bg` (default `Canvas`), or your own `background`, padding and border on the element.
  - Handle colour: `--citadel-drawer-handle`.
  - Placement and size win over your rules (`!important`): the script sets `position: fixed`, the full height, z-index 30, the backdrop at 29 and the handles at 28. If you have a header above z-index 30, drop it while `html:has(.citadel-drawer)`. Don't put a drawer element inside something with `transform`, `filter` or `contain`, which would pin `position: fixed` to that box instead of the screen.
- **Preact:** call `initDrawers` once in a `useEffect` after the elements mount, with refs' elements or finder functions, and `destroy()` in the cleanup. The script only adds and removes classes and attributes on your elements; it never moves them in the DOM.

## Not here yet (the rail)

- The list is fetched once per page load: someone newly enabled for a contraption sees it on their next load.
- No unread badges or per-app state on the icons.
