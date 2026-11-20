# First look: the how-to

Part of `citadel:contraption-ui`: the code behind its "First look" checklist. Everything here is the
kit's tokens and parts; nothing is a new library. The look these rules make is take A of #683's
review page (`mockups/colour-defaults/colour-default-takes.html` in Citadel's shared folder), which
Cara picked on 2026-11-14 as the default for every minion's UI.

## 1. The two accents

Your app's own colour, as a light and a dark value. Take the hue from what the app is about or
from its icon, so two apps rarely share one; the values below are only the shape. In your
`app.css`, after theme.css loads, on `:root` (not a container, so the focus ring, `cui-primary`,
`cui-choice` and switches all follow it):

```css
:root { --citadel-accent: <light value>; }
@media (prefers-color-scheme: dark) { :root { --citadel-accent: <dark value>; } }
```

Pick a hue none of the tones use (teal, pink, indigo), so a primary button never reads as a status.
Short of one, `var(--citadel-violet)` works and switches with dark mode by itself; then violet is
the accent and stays off your chips. Never `ok`, `warn`, `danger` or `info`: those mean a status,
and a green Save button reads as "done", a blue one as "running". Never a grey: an app needs a hue.

Check both against `--citadel-on-accent` (white in light, `#1d1c1a` in dark) at 4.5:1 or better,
and against `--citadel-surface` at 3:1 (a link, a ring). Dark wants the lighter shade.

`--citadel-accent-2` is the second colour: theme.css serves fuchsia (`#a21caf`, dark `#e879f9`).
Keep it unless your accent sits within 60° of it on the colour wheel (pink, purple, red, magenta);
then set your own pair the same way, 4.5:1 or better on `surface`. It wears highlights, never the
primary button:

```css
.stars, .is-new { color: var(--citadel-accent-2); }
.cui-btn.second { border-color: color-mix(in srgb, var(--citadel-accent-2) 55%, var(--citadel-surface));
  color: color-mix(in srgb, var(--citadel-accent-2) 80%, var(--citadel-text)); }
```

A tint of the accent marks what's current without shouting: the open tab, a selected row.

```css
.tab[aria-current="page"], .row[aria-selected="true"] {
  background: color-mix(in srgb, var(--citadel-accent) 14%, var(--citadel-surface));
  color: color-mix(in srgb, var(--citadel-accent) 75%, var(--citadel-text));
}
```

## 2. A tinted page, cards with coloured heads

The page takes 5% of the accent; content sits on `surface`. One level: inside a card, group with
space or a rule line (craft floor). Each card's head is a band in the card's hue (`--hue`: the
accent, accent-2 or its category) with an icon tile leading it.

```css
html, body { background: color-mix(in srgb, var(--citadel-accent) 5%, var(--citadel-bg)); }
.card {
  --hue: var(--citadel-accent);
  background: var(--citadel-surface); border: 1px solid var(--citadel-border);
  border-radius: var(--citadel-radius);
}
.card-head {
  display: flex; align-items: center; gap: var(--citadel-space-2); padding: var(--citadel-space-2) var(--citadel-space-3);
  background: color-mix(in srgb, var(--hue) 7%, var(--citadel-surface)); border-bottom: 1px solid var(--citadel-border);
  border-radius: var(--citadel-radius) var(--citadel-radius) 0 0;
}
.card-head h2 { flex: 1; margin: 0; font-size: var(--citadel-size-h3); }
.card-body { padding: var(--citadel-space-3); }
.icon-tile {
  width: 24px; height: 24px; flex: none; display: grid; place-items: center; border-radius: var(--citadel-radius-sm);
  background: color-mix(in srgb, var(--hue) 18%, var(--citadel-surface)); color: color-mix(in srgb, var(--hue) 85%, var(--citadel-text));
}
.cards { display: grid; gap: var(--citadel-space-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); }
```

```html
<section class="card"><div class="card-head"><span class="icon-tile" aria-hidden="true">▤</span><h2>On the shelf</h2><span class="cui-chip">4</span></div>…</section>
```

A table or list is a card too, its rows split by `border-top: 1px solid var(--citadel-border)`.
The glyph in an icon tile is a monochrome character or SVG that takes `currentColor`.

## 3. Type scale and stat tiles

| Level | Size | Weight | Colour |
|---|---|---|---|
| The view's title, one per view | 26 px | 750 | `text` |
| A card's or group's heading | `size-h2` or `size-h3` | 600 | `text` |
| Body, row titles | `size-body` | 400, a row's title 600 | `text` |
| Meta: times, counts, ids, hints | `size-meta` or `size-small` | 400 | `muted` |
| A small label over a group | `size-meta`, `letter-spacing: .04em`, uppercase | 600 | `muted` |

A key number (a total, what's overdue) is a stat tile. A row of them takes a different hue each:
the accent, accent-2, or a tone when the number means a status (overdue in `danger`).

```css
.stats { display: grid; gap: var(--citadel-space-3); grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); }
.stat { --hue: var(--citadel-accent); padding: var(--citadel-space-2) var(--citadel-space-3); border-radius: var(--citadel-radius);
  background: color-mix(in srgb, var(--hue) 11%, var(--citadel-surface)); border: 1px solid color-mix(in srgb, var(--hue) 25%, var(--citadel-surface)); }
.stat b { display: block; font-size: 22px; font-weight: 750; font-variant-numeric: tabular-nums; color: color-mix(in srgb, var(--hue) 80%, var(--citadel-text)); }
.stat span { font-size: var(--citadel-size-meta); color: var(--citadel-muted); }
.stat.second { --hue: var(--citadel-accent-2); }
.stat.overdue { --hue: var(--citadel-danger); }
```

## 4. Status in tone

```html
<span class="cui-chip" data-tone="ok">done</span>
<span class="cui-chip" data-tone="warn">due today</span>
<span class="cui-chip" data-tone="danger">overdue</span>
<span class="cui-chip" data-tone="info">running</span>
<span class="cui-chip" data-tone="neutral">draft</span>
```

Pick one tone per meaning and keep it across the app: the same state is the same chip on every
view.

## 5. A hue per kind

Kinds of things (a category, a type, an area, a person) take `cat-1` to `cat-6`: indigo, sky,
rose, lime, teal, purple. Give each kind its hue once, in one table in your code, so it is the same
on every view; a seventh kind starts the list again. A kind is drawn square, a status round:

```js
const KIND_HUE = { Fiction: 1, Science: 2, History: 3, Cooking: 4 };  // fixed, never by list position
tag.dataset.hue = KIND_HUE[kind] ?? 1;
```

```css
[data-hue="1"] { --hue: var(--citadel-cat-1); } [data-hue="2"] { --hue: var(--citadel-cat-2); }
[data-hue="3"] { --hue: var(--citadel-cat-3); } [data-hue="4"] { --hue: var(--citadel-cat-4); }
[data-hue="5"] { --hue: var(--citadel-cat-5); } [data-hue="6"] { --hue: var(--citadel-cat-6); }
.tag { display: inline-flex; align-items: center; padding: 1px 7px; border-radius: 4px; font-size: var(--citadel-size-meta); font-weight: 650;
  color: color-mix(in srgb, var(--hue) 78%, var(--citadel-text)); background: color-mix(in srgb, var(--hue) 13%, var(--citadel-surface)); }
.cover { width: 30px; height: 38px; flex: none; display: grid; place-items: center; border-radius: 4px; font-weight: 800;
  background: color-mix(in srgb, var(--hue) 20%, var(--citadel-surface)); color: color-mix(in srgb, var(--hue) 85%, var(--citadel-text));
  border-left: 3px solid var(--hue); }
.avatar { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700;
  background: color-mix(in srgb, var(--hue) 24%, var(--citadel-surface)); color: color-mix(in srgb, var(--hue) 85%, var(--citadel-text)); }
```

The tag always shows its word; the cover shows the item's initial or icon. Every `cat-*` is 4.5:1
or better on `bg` and `surface` in both modes, so the raw hue can be text too.

## 6. Something to scan by

A row leads with something the eye catches before the words: a cover or glyph in the row's
category hue, a chip, or a 3 px bar in the row's tone down its left edge:

```css
.row { border-left: 3px solid var(--row-tone, transparent); }
.row[data-tone="danger"] { --row-tone: var(--citadel-danger); }
```

Long lists group under small headings (by status, by day, by owner) with a count beside each.

## 7. An empty state with shape

```html
<section class="card empty">
  <span class="empty-mark" aria-hidden="true">◆</span>
  <h2>No experiments yet</h2>
  <p>Experiments you start show up here with their results.</p>
  <button class="cui-btn cui-primary">Start one</button>
</section>
```

```css
.empty { text-align: center; padding: var(--citadel-space-6) var(--citadel-space-4); display: grid; justify-items: center; gap: var(--citadel-space-2); }
.empty-mark { width: 40px; height: 40px; border-radius: 50%; display: grid; place-items: center; font-size: 18px;
  background: color-mix(in srgb, var(--citadel-accent-2) 14%, var(--citadel-surface)); color: color-mix(in srgb, var(--citadel-accent-2) 85%, var(--citadel-text)); }
.empty p { color: var(--citadel-muted); max-width: 40ch; margin: 0 auto var(--citadel-space-2); }
```

A view that isn't built yet says so the same way, with what it will hold.

## 8. Dark mode

Only tokens and `color-mix()` with `--citadel-surface` or `--citadel-text`, so dark gets its own
palette: warm dark surfaces, lighter tones, `on-accent` near-black. What breaks it: a fixed light
tint (`#fef3c7`), `rgba(0,0,0,…)` shadows or overlays doing a border's job, `opacity` on text to
make it grey, and white or black anywhere. Screenshot dark on its own; don't assume.

## 9. Contrast

Body text is `text`; secondary text is `muted`, never lighter and never `opacity`. Text in a tone or
hue is mixed into `text` (80% for a chip, 78% for a tag), never the raw tone on its own tint. A
custom accent or accent-2 passes the checks in 1.

## 10. One standout, and an own shape

**One standout per view.** Rules 1 to 9 give every view its colour; on top, one thing is allowed to
be memorable: a stat tile, the empty-state mark, a gradient, one animated or glowing moment. Say
which in your reply, and keep the rest quiet. Before you screenshot, take one decoration off.

**An own shape (optional).** An app may set its radii and heading face once, on `:root` next to its
accent, with the reason in your first reply (a bakery's soft 14/18/22; a terminal tool's square 2/3/4).
Keep the order `sm` < `radius` < `lg`, and the square tags of rule 5 stay 4 px:

```css
:root {
  --citadel-radius-sm: 3px; --citadel-radius: 4px; --citadel-radius-lg: 6px;
}
h1, h2, h3, .cui-topbar-title { font-family: "Fraunces", var(--citadel-font); }
```

Load a face from your own app (never a CDN), with a fallback to `--citadel-font`. Body text, sizes
and spacing stay Citadel's. The token names are pinned by the contract; their values were always
yours to set.

## 11. Summary first

Each part is a card (rule 2) whose head is a `<summary>`: the closed head answers the part's
question with a chip and a number, and the body is the evidence.

```html
<details class="card part">
  <summary class="card-head"><span class="icon-tile" aria-hidden="true">▤</span><h2>Orders</h2>
    <span class="cui-chip" data-tone="warn">3 late</span> <span class="muted">41 this week</span></summary>
  <div class="card-body"><!-- the table, the list, the settings --></div>
</details>
```

```css
.part > summary { cursor: pointer; list-style: none; min-height: var(--citadel-control-h); }
.part > summary::-webkit-details-marker { display: none; }
.part:not([open]) > summary { border-bottom: 0; border-radius: var(--citadel-radius); }
.part > summary:focus-visible { outline: var(--citadel-focus-ring); outline-offset: var(--citadel-focus-offset); }
```

Every part starts closed. A view that redraws keeps what a person opened.

## 12. Long lists start short

```html
<ul class="rows"><!-- the first five, worst or newest first --></ul>
<button class="cui-btn" type="button" aria-expanded="false">Show all 23 orders</button>
```

Its click redraws the list whole, sets `aria-expanded="true"`, renames it "Show the first 5 only"
and puts focus back on it. Six or fewer items show whole: never hide just one.
