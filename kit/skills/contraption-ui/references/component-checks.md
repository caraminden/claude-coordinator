# Component checks: dialog, tooltip, live region, drawer

Read this when you build or change one of these parts by hand, or review one. Each list is what a
keyboard and screen-reader user needs, with the WCAG criterion where there is one. The library's own
parts are marked with where they stand, so you know what you get for free. The idea of per-component
acceptance criteria comes from Intopia's accessibility skill (CC BY-NC-SA 4.0, so ideas only: none of
its text is here; credited in `THIRD_PARTY.md`). The criteria are WCAG 2.2 and the WAI-ARIA patterns.

## Dialog (anything that blocks the page until it's answered)

Use the kit dialog ([base-parts.md](base-parts.md#dialog)): a native `<dialog class="cui-dialog">`
opened with `showModal()`, which brings the top layer, the rest of the page inert, Escape, a pinned
✕, a backdrop click that closes it, and a page that stays still behind it. Built from script,
`openDialog({ title, body })` also names it and removes it on close. The rest of this list is
yours.

- It has a name: `aria-labelledby` its heading, which says what it's for (4.1.2, 2.4.6).
- Opening moves focus into it, to its heading (`tabindex="-1"`) or its first field (2.4.3).
- Tab and Shift+Tab stay inside while it's open; nothing behind it can be reached or clicked.
- A visible Close or Cancel button, and Escape, close it (2.1.1).
- Closing puts focus back on what opened it, or the next sensible place if that's gone (2.4.3).
- Nothing in it with focus is hidden under its own sticky footer or a tip (2.4.11).
- Before reaching for one, see "Refuse" in [craft-floor.md](craft-floor.md): most tasks need no dialog.

## Tooltip (`ui/tip.js`)

| Check | `tip.js` |
|---|---|
| Opens on hover and on keyboard focus (1.4.13, 2.1.1) | yes: 250 ms hover, at once on `:focus-visible` |
| The pointer can move onto the tip without it closing (1.4.13, hoverable) | yes |
| Stays until the pointer or focus leaves or someone dismisses it, never on a timer (1.4.13, persistent) | yes; a scroll closes it too |
| Escape closes it without moving the pointer or focus (1.4.13, dismissible) | yes; for a tip opened by focus or a tap it calls `preventDefault`, so a dialog of yours that checks `defaultPrevented` stays open (`drawers.js` doesn't check yet: Escape closes both) |
| The thing points at it with `aria-describedby` while open; it has `role="tooltip"` | yes |
| Fits a 320 px window without sideways scrolling (1.4.10) | yes: 8 px inside the window, scrolls past its room |
| Holds nothing to act on; a tip with links or buttons is a toggletip | `role: 'dialog'` (Tab goes into it) |

A toggletip (a button whose only job is its tip, `tapOpens`): the button only shows and hides it,
and Escape closes it and leaves focus on the button. `tip.js` pins a tip opened this way, so Tab
away leaves it open until Escape, a press outside, a scroll or a second press; a hand-built toggletip
should also close when focus leaves.

## Live region (a change announced without moving focus)

- The region is in the page, empty, **before** the change: a region created with its text in it is
  often not read. `statusSlot` is drawn up front for this reason (and for rule 13).
- `role="status"` (polite) for progress and results; `role="alert"` only for an urgent error that
  needs doing something now. Never both on one change.
- Announce only what focus doesn't: a button that moves focus to the result needs no region.
- Keep it small. The chat's only region is its working line, never the whole log, or every streamed
  word is read out.
- A toast is announced from its own region (`toast`); an error someone has to act on stays on the
  page (the status line), since a toast leaves.

## Drawer (`drawers.js`, phone width)

| Check | `drawers.js` |
|---|---|
| Open, it's a named modal (`role="dialog"`, `aria-modal`, `aria-label`) | yes |
| Everything else is `inert` while it's open | the `main` you pass and the other panel: pass every region outside the drawers, or a toolbar outside them stays reachable |
| Focus moves into it; Tab wraps inside it | yes |
| Escape closes it; focus returns to what opened it | yes |
| The edge handle that opens it is a button with a name | yes (`Open …`) |
| A swipe has a button way too (rule 14) | yes: the handle |

If you build a sheet or side panel of your own, it owes the same list; use `drawers.js` first.

## Disclosure (a section that opens and shuts)

Use `<details>`/`<summary>`: keyboard, state and name come with it. A hand-built one is a `<button>`
with `aria-expanded` and `aria-controls`, and its content is hidden from everyone when shut, not only
from the eye.
