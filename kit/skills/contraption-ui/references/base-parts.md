# Base parts (`ui/base.css`)

Part of `citadel:contraption-ui` (its SKILL.md has the file list, tokens and rules).

```html
<button class="cui-btn cui-primary">Send</button>  <!-- also cui-ghost, cui-danger, cui-small, cui-icon -->
<input class="cui-input"> <textarea class="cui-input"></textarea>
<span class="cui-chip" data-tone="ok">done</span>  <!-- tones: ok warn danger info violet neutral -->
<div class="cui-choices"><button class="cui-choice cui-rec">Yes</button><button class="cui-choice">No</button></div>
<div class="cui-notice" role="status">Couldn't reach Citadel. Your message is still in the box.</div>  <!-- data-tone="danger" | "info" -->
<div class="cui-working"><span class="cui-spin"></span> Working… <span class="cui-time">12s</span></div>
```

Every rule sits in `:where()`, so any selector of yours wins: restyle by writing your own rule, no
`!important`.

## Dialog

Every modal (rule 22), from `ui/base.css` and `ui/dialog.js`:

```html
<dialog class="cui-dialog" id="link" aria-labelledby="link-title">
  <form method="dialog" class="cui-dialog-head">
    <h2 id="link-title">Link to PC</h2>
    <button class="cui-btn cui-ghost cui-icon" aria-label="Close">✕</button>
  </form>
  …the body: anything, as long as it likes…
</dialog>
<script type="module">
  import { mountDialogs } from '/apps/_citadel/ui/dialog.js';
  mountDialogs(); // once per page: every .cui-dialog, now and later
  document.getElementById('open-link').onclick = () => document.getElementById('link').showModal();
</script>
```

- **The head** stays at the top while the body scrolls, spans the box with a line under it, and keeps
  equal room above and below the title and ✕. It must be the dialog's first child. The ✕ in a
  `<form method="dialog">` closes it with no script; a `<div class="cui-dialog-head">` works too, with
  your own `onclick` that calls `close()`.
- **A click on the backdrop** closes it: a press and release both outside the box, so selecting text and
  letting go on the backdrop leaves it open. It goes through `requestClose()` where the browser has it,
  so a `cancel` listener that calls `preventDefault()` (unsaved changes) keeps it open, as it does for Escape.
- **It fits the window:** 480 px wide (`--cui-dialog-width: 560px` on it for another), 12 px in from each
  edge, 8 px on a phone; the page behind doesn't scroll while it's open.
- **Open it with `showModal()`.** `show()` gives a non-modal box with no backdrop, no Escape and no lock.
- The body's padding is the dialog's own (`--cui-dialog-pad`, 16 px, 12 px on a phone); a footer of
  buttons is a plain row at the end of the body, scrolling with it.
- Naming it and moving focus are yours: [component-checks.md](component-checks.md#dialog-anything-that-blocks-the-page-until-its-answered).

**Switch** (an on/off setting that takes effect at once; a choice sent with a form stays a checkbox):

```html
<label><input type="checkbox" role="switch" class="cui-switch"> Show overlays</label>
<input type="checkbox" role="switch" class="cui-switch" aria-label="Show overlays" checked>  <!-- no visible text -->
```

A native checkbox, so `.checked`, `change`, `disabled` and forms work as usual. Its touch target is 44 px
tall and lays out at the track's size, so stack switches at least `--citadel-space-3` apart or a tap
near one's edge lands on its neighbour; a `<label>` around it lines up the text and makes it tappable too.
In a `<td>` or `<th>` the cell clips the target to the row's height (`overflow-y: clip`), so rows of any
height work; anything else in that cell taller than the row is cut off too. Elsewhere (a grid or `div`
"table", a list in an `overflow: auto` box) leave 12 px of room past the edge switch, or its target makes
the container scroll.

**Busy region** (the part of the page that's reloading, while the rest stays usable):

```html
<section class="cui-busy" aria-busy="true">…the list as it was…</section>
```

```js
list.setAttribute('aria-busy', 'true');   // the fetch starts
list.setAttribute('aria-busy', 'false');  // the new content is in
```

While `aria-busy="true"`, the region's children dim to 0.45 after 0.2 s (a fast load never flashes),
take no clicks, and an 18 px ring sits in its top right corner, sticky, so it stays in view while the
region or the page scrolls. Back to `false` and it clears at once. The one attribute drives the look and
the screen reader's "busy" together, so they can't drift; it isn't the composer's `data-busy`. No JS
helper: it's CSS on the attribute.

- **The region is a block box;** put a flex or grid layout on one child inside it. The ring is a sticky
  float, which is what keeps it in view while the region scrolls and lets it take no room. In a flex or
  grid box a float isn't one: the ring becomes an item, takes a gap in a flex column and a cell in a grid,
  and moves the content. Pinning it with `position: absolute` instead would make it scroll away with the
  content, and needs `position: relative` on the region, which changes what your own absolutely placed
  children sit against.
- Its direct children dim; any `cui-skeleton` or `cui-skeleton-card` among them stays as it is.
- Clicks are blocked from the moment it goes busy (the dim follows 0.2 s later), keys aren't: disable a
  button whose action would go wrong on the stale content.
- Mark the region that changes (the list, the card, the panel), never the whole page.

**Skeleton** (a first load, when there's nothing yet to dim):

```html
<section class="cui-busy" aria-busy="true">
  <div class="cui-skeleton-card" aria-hidden="true">
    <span class="cui-skeleton" data-width="medium"></span>
    <span class="cui-skeleton"></span>
    <span class="cui-skeleton" data-width="long"></span>
  </div>
  <span class="cui-skeleton" data-width="short" aria-hidden="true"></span>
</section>
```

A `cui-skeleton` is one line of the text around it (`1lh` tall, a 0.8 em grey bar inside), so a stack of
them swapped for their text moves nothing; full width
or `data-width="short"` (35%), `"medium"` (60%), `"long"` (85%); for an image or a block give one a height
and `padding: 0` in your own CSS (the grey is its `::before`, so restyle that, not the box). `cui-skeleton-card` is a bordered card to hold a few. A slow shine runs across them and
stops under reduced motion. `aria-hidden="true"` on each: the busy region around them is what a screen
reader hears. Replace them with the real content and set `aria-busy="false"` in the same step.
