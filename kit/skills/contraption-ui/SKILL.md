---
name: contraption-ui
description: >
  Citadel UI: the components, tokens and design rules Citadel serves to every contraption (an app
  under /apps/<name>/). Use for any front-end work in one: a new page, a chat or an agent's
  markdown, a form, a tooltip, a busy or saved status, colours and spacing, the rail or phone layout.
---

# Citadel UI in a contraption

Cara, 2026-11-02: "I shouldnt need to tell mandate to implement numbered lists in its chat boxes, or
ToC to render markdown in its chats, those should be reusable components that live in Citadel." So
Citadel serves one library, live, and every app uses it.

**Use the library before writing your own.** Markdown, a chat log, a composer, buttons, notices and
colours come from Citadel. When it lacks something you need, build the smallest local stand-in and
ask your Taskmaster to ask Citadel's Taskmaster for it (`message_coordinator`), naming what you
needed and why; don't grow a second library in your app.

## What there is

Every file is under `/apps/_citadel/` on Citadel's own origin, which is your app's too. No login,
`Cache-Control: no-cache` with an ETag: a page load costs a 304 until Citadel deploys, and a fix
reaches you on Citadel's next deploy. Dev copies fetch them from the live Citadel on
`http://127.0.0.1:8573/apps/_citadel/…`; a bundler marks `/apps/_citadel/*` external.

| File | What | How, and the details |
|---|---|---|
| `theme.css` | Every token below as `--citadel-*`, light and dark | `<link rel="stylesheet">`, first; [Tokens](#tokens-themecss) below |
| `ui/base.css` | Buttons, inputs, chips, notices, switches, spinner, busy regions, skeletons, focus ring, as `cui-*` classes | `<link rel="stylesheet">` after theme.css; [references/base-parts.md](references/base-parts.md) |
| `ui/markdown.js` (+ `.d.ts`) | An agent's markdown as safe HTML, streaming-aware, Copy on code blocks | ES module import; [references/markdown.md](references/markdown.md) |
| `rail.js`, `drawers.js` (+ `.d.ts`) | The app rail; phone drawers (`NARROW`, the 800 px breakpoint) | [rail-and-drawers.md](rail-and-drawers.md) |
| `ui/composer.js` (+ `.d.ts`) | The message box under a chat | ES module import, needs base.css; [references/composer.md](references/composer.md) |
| `ui/chat.js` (+ `.d.ts`) | The chat log: your messages, replies, tool runs, Grunt rows, reply chips, the working line, messages sent mid-turn | ES module import, needs base.css; [references/chat.md](references/chat.md) |
| `ui/tip.js` (+ `.d.ts`) | Tooltips: `data-tip` on anything, opened on hover, focus, a tap or a long press | ES module import, needs base.css; [references/tooltip.md](references/tooltip.md) |
| `ui/dialog.js` (+ `.d.ts`) | The dialog: every modal. Its head and ✕ stay at the top while the body scrolls; a backdrop click and Escape close it | `cui-dialog` in base.css, `mountDialogs()` once; [references/base-parts.md](references/base-parts.md#dialog) |
| `ui/status.js` (+ `.d.ts`) | A status line that's always there, a button label that keeps its width, a toast, and the headless check that nothing moved | ES module import, needs base.css; [references/status.md](references/status.md) |
| Your `manifest.webmanifest` | Installing your app on its own, beside Citadel's | [references/installing.md](references/installing.md) |

[starter/](starter/index.html) (`index.html`, `app.css`, `app.js`) wires theme.css, base.css, the
rail, drawers, a status line, a chat and a composer; start a new contraption's page from it.

The API is stable: names and options are only ever added, and Citadel's tests hold them. A real
break would ship as a new file (`ui/chat2.js`) beside the old one. Types: point TypeScript at the
served `.d.ts` (copy it into your repo's types folder, or `declare module` it) rather than writing
your own.

## Tokens (`theme.css`)

Follow the device's light or dark mode, as Citadel does. Names are stable; values change when
Citadel's do, so use the variables and never copy a hex value.

- **Colours:** `bg`, `surface`, `text`, `muted`, `border`, `accent`, `on-accent` (text and icons on
  the accent: white in light, near-black in dark), `focus`, `danger`, `ok`, `warn`, `warn-tint`,
  `info`, `neutral`, `violet`, `code-bg`.
- **Type:** `font`, `mono`; `size-body` 15, `size-small` 13 (tool rows, small buttons), `size-meta`
  12 (chips, timestamps, hints), `size-h1`/`h2`/`h3` 22/18/16.
- **Space:** `space-1` to `space-6`: 4, 8, 12, 16, 24, 32.
- **Radii:** `radius-sm` 6 (buttons, inputs, inline code), `radius` 8 (cards, rows, code blocks),
  `radius-lg` 10 (chat messages, dialogs), `radius-pill` (chips).
- **Controls:** `control-h`, 32 px, and 40 px at 800 px wide and under.
- **Focus:** `focus-ring` (`2px solid` the accent) with `focus-offset` 2px.
- **Motion:** `motion` 150 ms for state changes, `motion-slow` 250 ms for drawers and sheets; both
  0s under reduced motion.
- **Notice:** `notice-bg` and `notice-bar`, the warning notice's fill and bar.

All are `--citadel-<name>` (`var(--citadel-space-3)`). One computes from another at `:root`, so to
tint a part, set the base colour (`--citadel-accent`) on its container rather than a derived one.

A chart, dashboard or stat tile follows the built-in `dataviz` skill's method (form, marks,
interaction) but takes its colours from these tokens, never dataviz's placeholder palette.

## The rules

1. **Equal room above and below:** text or an icon in a box, bar, button, row or chip has equal,
   non-zero top and bottom padding. Size controls with `--citadel-control-h` and centre the content.
2. **Text on the accent uses `--citadel-on-accent`.**
3. **Inputs are 16 px at 800 px and under**, so iOS Safari doesn't zoom on focus.
4. **Focus is visible on keyboard focus only:** `:focus-visible` with the focus ring.
5. **Motion respects reduced motion:** durations from `--citadel-motion`, spinners stop. Animate colours,
   `opacity` and `transform`, never layout (`width`, `height`, `top`, `left`, margins), and loop
   nothing but a spinner or skeleton. Set the end state yourself, never in `transitionend` or
   `animationend`: at 0s a transition fires no event.
6. **External links open a new tab (`_blank`, `rel=noopener`).** A link to a custom URL scheme
   (`myapp://…`) needs `target="_top"`: inside the frame Citadel's CSP (`default-src 'self'`, so
   `frame-src 'self'`) blocks it, and the top window hands it to the OS. Never `_top` for a plain
   web link.
7. **No inline styles in what a component writes** (`style=""`, `<style>`): Citadel's CSP and maybe
   yours refuse them. Use classes, or a constructed stylesheet adopted once.
8. **Use the variables, never copied hex.**
9. **Phone breakpoint is 800 px** (`NARROW` from `drawers.js` in script).
10. **No full-screen loading covers.** Cara, 2026-11-03: "keep the screen visible and just have a spinner
    or grey out the changed thing". Mark the region that's changing busy (`cui-busy` with `aria-busy`),
    or show skeletons on a first load; the rest of the page stays visible and usable.
11. **A chat's box has the caret on desktop.** Cara, 2026-11-04: "If I have a screen with a chat open in
    citadel, it should default focus so I dont have to click on the chat box to type into it". The
    composer does it (`autofocus`, on by default): don't turn it off for a page's main chat, and don't
    focus anything yourself on a redraw. Never on a phone, never out of another field.
12. **Tooltips give extra detail on hover.** Cara, 2026-11-04: "add useful additional details ... when
    things are moused over throughout the app, tooltips are great!" A number, a stat, a short label or an
    icon button gets the line or breakdown behind it through `data-tip` and `ui/tip.js`, not `title=""`
    (no touch, no keyboard, no styling) and not a tooltip of your own. Nothing a person needs to act
    on lives only in a tip or behind `:hover`: a phone shows a tip only on a tap or long press, and
    has no hover.
13. **A status change moves nothing.** Cara, 2026-11-04: "set up rules that make sure status changes like
    that dont move any UI elements". Busy, saved, an error, a counter, a label swap: nothing else on the
    screen shifts. Reserve the room (`statusSlot` and `steadyLabel` from `ui/status.js`, a `min-width` for a
    number) or overlay it; never insert a line into the flow or let a label widen its button. Prove it with
    the headless check in [references/status.md](references/status.md).
14. **Keyboard and screen reader reach everything.** Anything that acts is a native control
    (`<button>`, `<a href>`, an input, `<summary>`), never a clickable `div`, so Tab and Enter reach
    it; a chip that toggles is a `button` with `aria-pressed`. An
    icon-only button has an `aria-label` (`data-tip` adds detail, not a name); an `<img>` has `alt`
    (`""` for decoration). A drag has a button or menu way too ("Move up", "Move to…"). A sticky bar
    of your own gets a matching `scroll-padding` on its scroller, so it never hides what has focus.
15. **Tap targets are big enough:** 24 px each way at the least on desktop, `--citadel-control-h`
    tall at 800 px and under, `--citadel-space-2` between neighbours. A small icon gets padding as
    its hit area.
16. **Every field has a label.** A visible `<label>` (or `aria-label`); a placeholder is a hint,
    except in the composer, where it names the box unless you pass `label`.
    The right `type`, `inputmode` and `autocomplete` bring a phone's right keyboard and autofill.
    Check a field when it loses focus and put its error under it (`aria-describedby`), keeping what
    was typed. Submit is disabled while its request is on its way.
17. **A colour never carries meaning alone.** A tone on a chip, status or notice also says it in a
    word or an icon: "failed", not just a red dot.
18. **Text is never clipped and never widens the page.** A box of text grows with it (no fixed
    `height` or `overflow: hidden`); names, errors and actions wrap. The one cut is a single line
    with its whole self in `data-tip-overflow`, as the status line does. Long URLs and ids break (`overflow-wrap:
    anywhere`, `min-width: 0` on a flex or grid child), a wide table scrolls in its own box, and an
    image has `max-width: 100%` and a `width`/`height` or `aspect-ratio`. Prose runs about 75ch
    wide at most. A full-height layout uses `dvh`: `vh` puts its bottom under a phone's address bar.
19. **Empty and failed say what next.** An empty list or search says why and offers the next step
    ("No todos yet. Add one below."); an error says what failed and the way out (Retry, what was
    kept), as the `cui-notice` example in [references/base-parts.md](references/base-parts.md) does.
20. **Undo over "are you sure?".** A delete or bulk change acts at once and offers Undo in a bar
    of your own (`toast` takes no button); ask first only when nothing could bring it back.
21. **A view worth coming back to has its own URL.** A tab, item or filter someone would share,
    reload or go Back to updates the URL (`history.pushState`; `replaceState` for small steps), and
    that URL opens the same view.
22. **Every modal is the kit dialog.** Cara, 2026-11-08: "the X to close should stay at the top and
    clicking off the modal should close it". A `<dialog class="cui-dialog">` with a `cui-dialog-head`,
    opened with `showModal()`, and `mountDialogs()` from `ui/dialog.js` called once: the ✕ stays in
    view however long the body, a click on the backdrop closes it, Escape too.

A self-review counts a break of these rules, and anything hand-rolled that the library serves, as a
finding (`citadel:self-review`, "UI findings").

## Read on demand

- Using a part from the table above: its file in the table's last column, before writing the code.
- Adding or reviewing an animation or transition: [references/motion.md](references/motion.md).
- A view that draws names, counts or lists, before its screenshots: [references/worst-case-data.md](references/worst-case-data.md).
- A page or part of your own nearly done: [references/craft-floor.md](references/craft-floor.md).
- A dialog (its focus and naming are yours), or a tooltip, live region, drawer or disclosure built by hand: [references/component-checks.md](references/component-checks.md).
- A new page, view or flow, or a request to QA an app: [references/dogfood.md](references/dogfood.md).

Each rule shown right and wrong (14 to 22 listed, no demo yet), with every part drawn live in both modes: Citadel's living
design-system home, `docs/design-system/index.html` in Citadel's repo (Citadel's minions keep it
true; ask your Taskmaster for a copy if you need the page itself).
