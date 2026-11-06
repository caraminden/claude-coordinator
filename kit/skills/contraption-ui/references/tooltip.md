# Tooltip (`ui/tip.js`)

Part of `citadel:contraption-ui` (its SKILL.md has the file list, tokens and rules).

```html
<span data-tip="Life: 4,812&#10;+12% from the tree" tabindex="0">4,812</span>   <!-- plain text; &#10; breaks a line -->
<button class="cui-btn" data-tip="Recalculate in PoB (about 3 s)">Recalculate</button>
<span data-tip="" data-stat="dps" tabindex="0">1.2M</span>                       <!-- your body() fills it -->
```

```js
import { mountTips, TipCache } from '/apps/_citadel/ui/tip.js';

const cache = new TipCache();             // optional: loads once per key and revision, LRU of 300
const tips = mountTips(document.body, {   // once per page; every [data-tip] under it, drawn later too
  body: (el) => el.dataset.stat         // optional: HTML string, a Node, or a promise of either
    ? cache.get(el.dataset.stat, build.revision, () => fetchBreakdown(el.dataset.stat))
    : undefined,                        // undefined: the plain data-tip text; null: no tip
});
tips.refresh();  // redraw the open tip after what it shows changed; tips.close(), tips.open, tips.destroy()
```

What it does for you: opens on mouse hover after 250 ms (60 ms moving from one tip to the next), at once
on keyboard focus (`:focus-visible`), and on a touch screen on a tap for things that don't act, or a 450 ms
long press for buttons, links, fields and their ARIA roles, which swallows the click that follows. It sits
below the thing, or above when there's no room, never over it, 8 px inside the window, in the top layer
(`popover="manual"`), so it never moves the page. A promise shows three skeleton lines until it settles; a
rejection shows "Couldn't load this: …". Escape, a press outside, a scroll or a resize closes it; one tip
is open on the page at a time, across mounts; when a redraw replaces the element it follows the copy with
the same `id` and `data-tip*` attributes, else closes; the thing has `aria-describedby` while it's open.

- **Attributes:** `data-tip` opts an element in, and is its text when `body` gives `undefined` or there is
  no `body`; an empty `data-tip` with no body shows nothing. Put whatever else `body` needs in your own
  `data-tip-*` attributes (`data-tip-key`): they also tell a redraw's copy apart. Give a non-focusable
  thing `tabindex="0"` so the keyboard reaches its tip. `data-tip-overflow` shows the plain text only
  while the element is cut off (an ellipsis or a line clamp): a name in a narrow column carries its whole
  self in `data-tip` and tips only when it doesn't fit.
- **Options:** `body(el)`, `selector` (default `[data-tip]`), `role` (`'dialog'` when the tip holds links or
  buttons: Tab from the thing goes into them; default `'tooltip'`), `label` (a dialog tip's name),
  `className` (more classes on `div.cui-tip`), `tapOpens` (a tap or click only toggles the tip, even on a
  button: chips whose whole job is their tip), `acts` (a selector for more things a tap acts on, so they
  wait for a long press), `onChange(el | null)`.
- **Look:** `div.cui-tip` (a surface card, `size-small`, stacked children with a gap, 420 px wide at most,
  scrolls past the room it has), `span.cui-tip-text` (a plain tip, line breaks kept), `.cui-tip-skel`,
  `p.cui-tip-error`. Style your content with your own classes inside it.
- `placeTip(rect, w, h, vw, vh)` is the placement as a pure function and `TipCache` the cache, for tests.
- Preact: call `mountTips` once in a `useEffect` on the page's root and `destroy()` on unmount; render
  `data-tip` attributes as usual.
