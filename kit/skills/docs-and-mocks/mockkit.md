# The mock kit

`starter/mockkit.js` and `starter/mockkit.css` (version in each file's first line), no dependencies.
The page links them in its head, then its theme:

```html
<link rel="stylesheet" href="mockkit.css">
<link rel="stylesheet" href="theme.css">   <!-- only if the scheme has one -->
<script src="mockkit.js"></script>
<body class="mk"><main class="mk-page">…</main></body>   <!-- .mk-page.wide for boards -->
```

## Where picks go

In Citadel's viewer, or a tab its Open button opened, the kit saves through the artifact bridge:
`window.claude.use('db')`, key `db/<collection>/<id>`, value `{ v, note, by, at }` (`v` the choice,
`by` the person). Everyone's picks show live. Opened with no way back to Citadel (from disk, a pasted
link), the page still runs, picks stay in the tab, and the dock's Send becomes Copy, the only
clipboard path. `mock.ready` resolves `{ saving, person }`.

## `mock.boards(target, opts)`

One board per take, each with its own copy of the state.

```js
const ctl = mock.boards('#takes', {
  size: { w: 420, h: 330 },            // optional: the screen at its real size, scaled down to fit a phone
  state: { open: [], filter: 'all' },  // each board starts with its own copy (plus board.state)
  boards: [
    { id: 'now', label: 'Now', title: 'Today', note: 'What ships now.', pick: false },
    { id: 'A', title: 'One list by element', note: 'What it does; what it costs.', rec: true },
    { id: 'B', title: 'Lairs on the right', note: '…', state: { filter: 'lairs' } },
  ],
  render: (board, s) => `
    <button data-on="click:fold" data-arg="ember">${s.open.includes('ember') ? '−' : '+'}</button>
    <input data-on="input:find" value="${mock.esc(s.q ?? '')}">`,
  on: {
    fold: (s, { arg }) => ({ open: s.open.includes(arg) ? s.open.filter((x) => x !== arg) : [...s.open, arg] }),
    find: (s, { value }) => ({ q: value }),
  },
  pick: { collection: 'picks', one: true },  // the default; false for no pick bars
});
ctl.set('*', { filter: 'all' });             // a shared control above the boards: patch every board
```

- `render` returns HTML for one board; escape any text you did not write with `mock.esc`.
- `data-on="click:name input:other"` names handlers; events: click, input, change, keydown,
  pointerover, pointerout, focusin, focusout. `data-arg` passes a value.
- A handler gets `(state, { arg, value, checked, el, ev, board })` and returns a patch (or changes
  state in place). A board whose state changed re-renders, keeping focus and the caret; give an
  input `data-key` if two share a handler and arg.
- Hover looks are CSS (`:hover`); handlers are for state that changes the screen.
- The board ids are the pick ids: keep them stable once people have picked.

## `mock.picks(opts)`

Pick bars on every `[data-pick="<id>"]` element under `root` (default: the page).

```js
mock.picks({ collection: 'marks', options: ['keep', 'rework', 'cut'] });
mock.picks({ collection: 'questions', options: ['yes', 'no'], root: document.getElementById('open-questions').parentElement });
```

- `options`: strings, or `{ v, label, done }` (`done` is how a made choice reads, "Picked").
- `one: true` makes the choice exclusive across the items (choose one take).
- The item's name in Send comes from `data-title`, else its first heading, else its id.
- Each person's pick is saved under their own `by`, so to pick between takes per person, build one
  row (one `data-pick` item) per person in the same collection.
- One collection per question set; two sets on a page need two collections or separate roots.
- The item gets `.picked` and `data-mk-v` when chosen, for styling.

## The dock

Comes with the first picks set: counts picks and notes, and **Send picks to the minion** posts one
line per pick straight into your chat as the person who pressed it, which wakes you (`citadel.send`,
only from a click). A shared-folder page's Send goes to the minion that last linked it, else the
Taskmaster. Send also settles that minion's choices card for the page (`ask_question` with `doc`:
the card that opens it). The dock shows Sent at once; a failure takes it back with a toast and Retry. It sticks to
the bottom once anything is picked.

**The dock is the only answer button.** Never hand-roll one: no `navigator.clipboard`, no
`execCommand('copy')`, no `citadel.send` of your own. Citadel's link check sends your reply back when
a page you link has any of them. A question the pick bars can't ask is still a `mock.picks` set
(options as strings, a note on each).

## `mock.toc()`

Fills `<nav class="mk-toc">` with a link per `h2` in `.mk-page`, giving each an id.

## CSS parts

| Class | What |
|---|---|
| `mk-head`, `mk-kicker`, `mk-meta`, `mk-lede` | The header |
| `mk-status` + `data-status` | draft, review, decided, living, superseded |
| `mk-chip`, `mk-tag` (`.rec`) | Plain chip; small uppercase tag |
| `mk-banner` (`.info`) | A line across the top: superseded, or a warning |
| `mk-toc` | Contents |
| `mk-callout` + `.rec` `.decision` `.question` `.risk`, `data-label` | Callouts |
| `mk-options` > `mk-option` (`.rec`) | Option cards side by side |
| `mk-figure` > `mk-frame` or `img`, `figcaption` | A picture or a live mini screen |
| `mk-table-wrap` > `mk-table`; `mk-yes` `mk-no` `mk-meh`; `.num` | Tables that scroll on a phone |
| `mk-log` > `li` with `time`, `q` | Decisions log |
| `mk-swatches` > `mk-swatch` > `mk-chipcolor`; `mk-specimen` > `mk-show` + `mk-about`; `mk-lives` | Design-system home |
| `mk-btn` (`.primary`), `mk-muted`, `pixel` | Buttons, quiet text, pixel art |
