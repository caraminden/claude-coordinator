# Right-click menu (`ui/menu.js`)

Part of `citadel:contraption-ui` (its SKILL.md has the file list, tokens and rules). Citadel's own pages use
it for their right-click menu (#1663); its look is `.cui-menu` in base.css.

## Your app already has one (rail.js)

A page that loads `/apps/_citadel/rail.js` gets Citadel's right-click menu with nothing else to do (#1665): Point at
this and Point and draw… (inside Citadel's frame: the chip lands in Citadel's chat box, with a crop), Copy for a
selection, Open and Copy link address on a link, and Copy link and Reload for the page. In the desktop app it ends
with Inspect (Ctrl+Shift+I). Add your own items for your own things; they sit under a "From <your app>" line:

```js
// After rail.js has loaded (it sets window.citadel.menu), or: import { menu } from '/apps/_citadel/rail.js';
const remove = window.citadel.menu.add('.item[data-id]', (el, event) => [
  { label: 'Mark done', icon: '✓', run: () => markDone(el.dataset.id) },
  { label: 'Open item', icon: '↗', run: () => openItem(el.dataset.id) },
], { kind: 'Item', name: (el) => el.querySelector('.title').textContent });  // the header chip and name, both optional
```

The deepest match wins when selectors nest. The items function runs at each right-click, so read state then
(falsy entries are skipped). Don't mount your own `mountMenus` beside rail.js's: one page, one menu. A page without
rail.js keeps the browser's menu unless it mounts one as below.

## Your own menu

```js
import { mountMenus, openMenu, closeMenu } from '/apps/_citadel/ui/menu.js';

mountMenus({                      // once per page; returns an unmount function
  menuFor(target, event) {        // what was right-clicked, or focused for Shift+F10 / the Menu key
    const row = target.closest('.build-row');
    if (!row) return null;        // null: the browser's own menu
    return {
      kind: 'Build', hue: 'var(--cat-2)', name: row.dataset.name,  // the header: a hued chip and a name
      items: [
        { label: 'Open', icon: '↗', run: () => open(row.dataset.id) },
        { label: 'Copy link', icon: '🔗', run: () => copy(row.href) },
        '-',                                                         // a line
        offline && { label: 'Delete', danger: true, disabled: true, reason: 'reconnecting…' },
      ],
      foot: "Shift+right-click: the browser's own menu",
    };
  },
});

openMenu(spec, x, y);   // open one yourself (a ⋯ button); closeMenu() closes it
```

An item is `{ label, run?, icon?, keys?, point?, danger?, disabled?, reason?, from? }`; falsy entries are
skipped, so `cond && item` works. A disabled item stays reachable with the arrows and reads
"label · reason". `from: 'My app'` puts a "From My app" line above a run of an app's own items.
Use `tone` (ok, warn, danger, info, violet, neutral) or `hue` (any CSS colour) for the chip.

What it does for you: opens at the cursor in the top layer (`popover="manual"`), flipped to the cursor's
other side at the right and bottom edges and kept 8 px inside the window (a taller menu scrolls). Focus
moves to the first item; arrows, Home and End move, Enter or a click picks, Escape or Tab closes and puts
focus back where it was. A press elsewhere, a scroll, a resize, a hash change or the window losing focus
closes it; one menu is open at a time. `mountMenus` leaves text boxes (inputs, textareas, selects,
contenteditable) and Shift+right-click to the browser, so spelling and Paste still work, and swallows the
`contextmenu` event that follows a Shift+F10 it already handled.

CSP: placement and the chip's hue are CSSOM writes (`el.style.left`, `setProperty`), which the CSP allows;
never `style=""`. Keep a menu short: the thing's few real actions, the commonest first.

**Phones, in an app (#1670):** a long press on something an app matched with `citadel.menu.add` or on a link opens the same sheet, with Point and the app's items under "From <app>"; plain text keeps the phone's own selection. Add `-webkit-touch-callout: none` to your own matched elements if iPhone's callout shows.

**Phones:** `mountMenus({ menuFor, longPress: true })` (or `longPress(target, spec) => boolean` to pick) opens the
same menu as a bottom sheet after a 450 ms touch hold: a grab bar, the kind chip and name, rows 48 px tall, the page
dimmed. A move past 10 px cancels it, the tap that ends it does nothing, a tap on the dim or a swipe down on the
head closes it, and focus goes back. It has its own timer because iPhone Safari sends no `contextmenu`; Android's is
answered too. Leave long-press off where text should keep the phone's own selection (leave those targets out in
the function). Add `-webkit-touch-callout: none` to the things it opens on. `openMenu({ ...spec, sheet: true })`
draws a sheet directly.
