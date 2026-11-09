# First look: the how-to

Part of `citadel:contraption-ui`: the code behind its "First look" checklist. Everything here is the
kit's tokens and parts; nothing is a new library.

## 1. The accent

One line in your `app.css`, after theme.css loads, on `:root` (not a container, so the focus ring,
`cui-primary`, `cui-choice` and switches all follow it):

```css
:root { --citadel-accent: var(--citadel-violet); }   /* or var(--citadel-info) */
```

A tone token switches with dark mode by itself and already passes against `--citadel-on-accent`.
Never `ok`, `warn` or `danger`: those mean a status, and a green Save button reads as "done".

Your own colour (from your icon, say) is a light and a dark value, the one hex pair an app owns:

```css
:root { --citadel-accent: #0f766e; }
@media (prefers-color-scheme: dark) { :root { --citadel-accent: #2dd4bf; } }
```

Check both against `--citadel-on-accent` (white in light, `#1d1c1a` in dark) at 4.5:1 or better,
and against `--citadel-surface` at 3:1 (a link, a ring). Dark wants the lighter shade.

A tint of the accent marks what's current without shouting: the open tab, a selected row.

```css
.tab[aria-current="page"], .row[aria-selected="true"] {
  background: color-mix(in srgb, var(--citadel-accent) 14%, var(--citadel-surface));
  color: color-mix(in srgb, var(--citadel-accent) 75%, var(--citadel-text));
}
```

## 2. Cards on the page

`bg` is the page; content sits on `surface`. One level: inside a card, group with space or a rule
line (craft floor).

```css
.card {
  background: var(--citadel-surface); border: 1px solid var(--citadel-border);
  border-radius: var(--citadel-radius); padding: var(--citadel-space-4);
}
.card > h2 { margin: 0 0 var(--citadel-space-3); font-size: var(--citadel-size-h3); }
.cards { display: grid; gap: var(--citadel-space-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr)); }
```

A table or list is a card too, its rows split by `border-top: 1px solid var(--citadel-border)`.

## 3. Type scale

| Level | Size | Weight | Colour |
|---|---|---|---|
| The view's title, one per view | `size-h1` | 700 | `text` |
| A card's or group's heading | `size-h2` or `size-h3` | 600 | `text` |
| Body, row titles | `size-body` | 400, a row's title 600 | `text` |
| Meta: times, counts, ids, hints | `size-meta` or `size-small` | 400 | `muted` |
| A small label over a group | `size-meta`, `letter-spacing: .04em`, uppercase | 600 | `muted` |

A key number (a total, what's overdue) is a stat: the number at `size-h1`, weight 700,
`tabular-nums`, with a `size-meta` muted label under it, and in its tone when the tone means
something (`color: color-mix(in srgb, var(--citadel-danger) 80%, var(--citadel-text))` for overdue).

## 4. Status in tone

```html
<span class="cui-chip" data-tone="ok">done</span>
<span class="cui-chip" data-tone="warn">due today</span>
<span class="cui-chip" data-tone="danger">overdue</span>
<span class="cui-chip" data-tone="info">running</span>
<span class="cui-chip" data-tone="neutral">draft</span>
```

Pick one tone per meaning and keep it across the app: the same state is the same chip on every
view. `violet` is the spare for a category that isn't a status.

## 5. Something to scan by

A row leads with something the eye catches before the words: a chip, a monochrome glyph that takes
`currentColor` (`✓`, `●`, `▲`, `◆`), or a 3 px bar in the row's tone down its left edge:

```css
.row { border-left: 3px solid var(--row-tone, transparent); }
.row[data-tone="danger"] { --row-tone: var(--citadel-danger); }
```

Long lists group under small headings (by status, by day, by owner) with a count beside each.

## 6. An empty state with shape

```html
<section class="card empty">
  <span class="empty-mark" aria-hidden="true">◆</span>
  <h2>No experiments yet</h2>
  <p>Experiments you start show up here with their results.</p>
  <button class="cui-btn cui-primary">Start one</button>
</section>
```

```css
.empty { text-align: center; padding: var(--citadel-space-6) var(--citadel-space-4); }
.empty-mark { font-size: 28px; color: color-mix(in srgb, var(--citadel-accent) 60%, var(--citadel-muted)); }
.empty p { color: var(--citadel-muted); max-width: 40ch; margin: var(--citadel-space-2) auto var(--citadel-space-4); }
```

A view that isn't built yet says so the same way, with what it will hold.

## 7. Dark mode

Only tokens and `color-mix()` with `--citadel-surface` or `--citadel-text`, so dark gets its own
palette: warm dark surfaces, lighter tones, `on-accent` near-black. What breaks it: a fixed light
tint (`#fef3c7`), `rgba(0,0,0,…)` shadows or overlays doing a border's job, `opacity` on text to
make it grey, and white or black anywhere. Screenshot dark on its own; don't assume.

## 8. Contrast

Body text is `text`; secondary text is `muted`, never lighter and never `opacity`. Text in a tone is
mixed 80% into `text` (as chips do), not the raw tone on a tint. A custom accent passes the two
checks in 1.
