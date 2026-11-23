# Right-click menu (`ui/menu.js`)

Part of `citadel:contraption-ui` (its SKILL.md has the file list, tokens and rules). Citadel's own pages use
it for their right-click menu (#1663); its look is `.cui-menu` in base.css.

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
