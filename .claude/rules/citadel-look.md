---
paths:
  - "public/**"
---

# Citadel's look: its own pages

Josh picked it on 2026-11-19 (#1068), from three takes tried on the CI page's Host load: "Rows that open", "This, but
with some of the nice styling from A, and with better padding below the header once expanded". Josh had asked for colour
and structure page after page ("I feel like I am often needing to tell you to add some UI/UX polish with some more
color and structure"), so a page that ships as grey sentences and full tables is unfinished. What it looks like:
[the picked look](../../docs/design-system/media/citadel-look.png) and the design-system home's "Citadel's look". Contraptions follow `citadel:contraption-ui`'s First look instead; `public/ui/`
is theirs.

The parts are in `public/look.js` beside `settingsRow` in `public/settings.js`, styled in `public/settings.css`
("Citadel's look"); `public/ci-host.js` is the page built from them to copy. Build from these parts, and add a missing
part there (and to the design-system home), so every page gets it.

1. **Summary first.** Each part of a page is a row that opens (`settingsRow`) in a box of rows under a section
   heading (`settings-section`, in its group's hue with `data-hue`). Its closed line answers the question the part
   is there for: a toned chip and the one or two numbers that matter. Read with every row closed, the page tells
   its state.
2. **Detail inside.** Lists, tables, settings and explanations go in the row's body. An opened row's body starts
   with stat tiles (`statTiles`) when it has numbers to compare, then its items, then a line of prose at most
   (`look-prose`).
3. **A status is a toned chip** (`toneChip`: ok, warn, danger, info, violet, neutral), its word short ("Quiet",
   "2 waiting", "Failing"), never only a grey sentence.
4. **Colour carries structure.** A row's tile takes the hue of what it is (`data-hue`: running, waiting, done,
   danger, held, accent, teal). A scheme always shows in its own hue (`schemeTag`, `schemeHue`), the same on every
   page, and its things group under it: an app's jobs and builds sit under the scheme that owns the app. Items are
   rows with a bar in their hue (`hueRow`); a value compared across rows is a bar beside its number (`meter`).
5. **Long lists start short.** More than about six items shows the first five, worst or newest first, with "Show
   all" under them (`showFirst`); a row of a table that has parts opens to them (the waits table's schemes).
6. **An empty state is a card** (`emptyCard`): what it is and what would fill it, green when empty is good.
7. **Mechanics.** The CSP refuses `style=""`: hues go through `data-hue` and `data-cat` attributes, a width through
   the CSSOM (`el.style.setProperty`, as `meter` does). A page that redraws on a timer passes `key` to
   `settingsRow` and `showFirst`, so what a person opened stays open.

Screenshot it closed and opened, at desktop and phone (`.claude/rules/ui-checks.md`); the rubric's "First look"
checks (`docs/rubrics/ui-screenshots.md`) are what a review looks for.
