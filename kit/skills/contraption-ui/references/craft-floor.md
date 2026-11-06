# Craft floor: the details that show a page was built

Read this when a page or part of your own is nearly done, before its screenshots. Most of the floor
is already the skill's rules (padding, focus, contrast through tokens, clipping, empty states) or
comes with the library; these are the leftovers. Ideas from pbakaus/impeccable's craft floor
(credited in `THIRD_PARTY.md`), checked against the design-system home.

## Check on the built page

- **Numbers that line up or change** use `font-variant-numeric: tabular-nums`: a column of counts, a
  cost, a timer, a "3/7". The library's timers (`cui-time`) already do; status text, your own tables
  and badges need it too, or digits jitter as they tick and columns don't align.
- **Every state of every part you drew yourself:** hover (desktop only), keyboard focus, pressed,
  disabled, busy (`cui-busy`, rule 10), failed and empty (rule 19). `base.css` parts have hover, focus and
  disabled (no pressed style yet); busy, failed and empty are always your wiring. A hand-built row,
  card or toggle usually has two of the seven. Put each state on screen once and
  screenshot it.
- **Copy says the product's own words.** A button names its action ("Send to the Taskmaster", not
  "Submit"); an error names what failed and the way out.
- **Browser surfaces are still default:** text selection colour, the caret and scrollbars. Citadel UI
  doesn't theme them yet, and it should happen once in `theme.css`/`base.css` (selection from the
  accent, `caret-color` the accent, `scrollbar-color` from `border` and `bg`) rather than per app.
  Don't theme them in your app; if it matters to you, ask for it as with any missing part.

## Refuse unless the brief asks for it

These are defaults a page drifts into when nobody chose. Each needs a reason in the brief, not a habit.

- **A card inside a card.** One surface per level: inside a card, group with space or a rule line.
- **Gradient text.** Emphasis is weight or size.
- **Emoji standing in for icons.** A colour emoji ignores the text colour, looks different on every
  platform and won't follow dark mode. A monochrome text glyph that takes `currentColor` (`✓` and `✕`,
  as the chat's step marks are) is fine, with an `aria-label` when it's the whole button (rule 14).
- **Glass, blur or glow as decoration**, and hard offset shadows (`4px 4px 0`). Depth comes from
  `surface` against `bg` and the border.
- **A modal for something that needs no interruption.** A drawer, an inline section or a new URL
  (rule 21) usually does it.
- **Monospace to look technical.** `--citadel-mono` is for code, ids and measurements.

Left out on purpose: the source's ban on coloured side bars (our warning notice has one by design),
its type and display-face rules (Citadel's type is the tokens), and its "one authored motion moment"
(see [motion.md](motion.md)).
