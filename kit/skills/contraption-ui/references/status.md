# Status line and steady labels (`ui/status.js`)

Part of `citadel:contraption-ui` (its SKILL.md has the file list, tokens and rules).

A status change (busy, saved, an error, a counter, a label swap) never moves anything else (rule 13).
These parts reserve the room up front:

```js
import { statusSlot, steadyLabel, toast } from '/apps/_citadel/ui/status.js';

const status = statusSlot(document.getElementById('status'));  // div.cui-status, role="status", always 22 px tall
status.working('Saving…');                     // a spinner and the words
status.text('Saved 3 files');                  // one line; cut off with … and whole in its tooltip
status.text('Couldn\'t save: read-only', { tone: 'danger' });  // tones: ok warn danger info violet neutral
status.clear();                                // nothing to say: still there, empty, at its height

const save = steadyLabel(saveButton, { idle: 'Save', saving: 'Saving…', saved: 'Saved' });  // first key shows
save.set('saving');                            // the button stays as wide as its widest label
save.current;                                  // 'saving'

toast('Copied the link');                      // in passing: the top layer, bottom centre, 4 s or a tap
toast('Couldn\'t copy', { tone: 'danger', ms: 6000 });
toast('Deleted 3 todos', { action: { label: 'Undo', run: restore } });  // a button after the text; it sends the toast away
toast('Saved', { onHide: () => {} });          // called once when this toast goes, however it goes
```

Views that draw HTML strings get the same markup from builders, with the text escaped (`inner` is yours):

```js
import { statusSlotHtml, statusTextHtml, statusWorkingHtml, steadyLabelHtml } from '/apps/_citadel/ui/status.js';

statusSlotHtml(statusWorkingHtml('Refreshing…'), { fill: true, className: 'mine' })  // span.cui-status; '' for empty
statusSlotHtml('<span class="cui-chip">Draft</span>' + statusTextHtml('Couldn\'t sync', { tone: 'danger' }))
steadyLabelHtml({ idle: 'Measure', busy: 'Measuring…' }, 'busy')                  // labels are text
```

What it does for you: the line is drawn whether or not it says anything, at a fixed 22 px, so the first
message, a longer one or none never pushes the page; its text is one line, cut off with an ellipsis, and
the whole of it opens in the kit tooltip (`data-tip-overflow`: only while it's cut off) under your page's
`mountTips`; it's a polite live region, so a screen reader hears each change. A steady label stacks every
label in one grid cell and hides all but one (`visibility`, so the hidden ones keep their room and a screen
reader hears only the one shown); a label is text or a Node (a `cui-spin` and words). On a touch screen a
tap opens a cut-off status's tip, as for anything a tap doesn't act on; inside a button, a link or a
`role="button"` header it's the long press, like every tip there.

- **Markup instead of JS:** `<div class="cui-status" role="status"><span class="cui-spin" aria-hidden="true"></span><span class="cui-status-text" data-tip="…" data-tip-overflow>Saving…</span></div>`,
  `data-tone` on the line, or on one `cui-status-text` to colour that text alone (a chip and an error in one
  slot); `<span class="cui-steady"><span>Save</span><span hidden>Saving…</span></span>`
  inside the button, toggling `hidden`. A page reset like `[hidden] { display: none !important }` breaks the
  steady label: scope it to leave `.cui-steady > [hidden]` alone.
- **Where it goes:** one line per place a status belongs (under a form, beside a toolbar's buttons, in a
  card's footer), in the layout from the start. Don't create it when the status comes.
- **In a row** (a card's header, beside its title): add `cui-status-fill`. The slot takes what the row has
  left (`flex: 1 1 0`) and adds nothing to the row's narrowest width (`contain: inline-size`), so a long
  status is cut off instead of widening the card past a phone's edge; `justify-content: flex-end` puts its
  text at the right. Not in a column: there `flex: 1 1 0` grows it down.
- **Children:** in any slot, everything but a `cui-status-text` (a chip, the spinner, your own span) keeps
  its size; only the text gives way, cut off with its ellipsis.
- **A counter or a number that changes:** `font-variant-numeric: tabular-nums` and a `min-width` in `ch`
  for its widest value; a chip that comes and goes keeps its place with `visibility: hidden`.
- **Something in passing** ("Copied", "Saved to the build"): `toast(text, { tone, ms })`. One at a time (a
  new one replaces the last), in the top layer at the bottom centre, so it moves nothing; a tap sends it
  away; a screen reader hears it from a live region. Not for an error someone has to act on: that stays
  in the page's own status line until it's dealt with.
- **Something you can undo or retry** ("Deleted 3 todos" · Undo): `toast(text, { action: { label, run } })`.
  The button sits after the text, centred, and its tap runs `run` and sends the toast away. A failed click
  is `optimistic()`'s job (below), which makes this toast for you.
- **Something that has to be big** (an error with a retry, a banner): overlay it (a `cui-tip`-style card in
  the top layer, `position: fixed`), never insert it into the flow.

**Check it in a headless browser.** Citadel's `test/status-browser.test.ts` cycles each part through its
states and checks that nothing moved, two ways: every element's `getBoundingClientRect()` against the first
state, and the page's `layout-shift` entries (a `PerformanceObserver`, cleared once the page has loaded),
plus a naive status line that must fail, so the check is proven to catch a shift. Copy it for your own page:

```js
// In the page, before any change:
window.shifts = [];
new PerformanceObserver((l) => shifts.push(...l.getEntries().map((e) => e.value))).observe({ type: 'layout-shift', buffered: true });
const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
const boxes = () => Object.fromEntries([...document.querySelectorAll('[id]')].map((el) => [el.id, el.getBoundingClientRect().toJSON()]));
// Then, from the test: await frame(); shifts = []; const first = boxes(); for each state: change it, await frame(),
// and assert every box equals first's and shifts is empty.
```

## Optimistic actions (`ui/optimistic.js`)

Rule 23: a click shows its result at once and the request runs behind it. Nothing waits: every control
stays usable, and ten quick clicks are ten actions.

```js
import { optimistic } from '/apps/_citadel/ui/optimistic.js';

rejectButton.onclick = () => optimistic({
  key: spec.id,                                     // same key: sends one after another, in click order
  apply: () => card.classList.add('rejected'),      // the page changes now, synchronously
  send: () => api(`/specs/${spec.id}/reject`, { method: 'POST' }),  // a promise; rejects on failure
  undo: () => card.classList.remove('rejected'),    // this item alone, if send fails (gets the error)
  label: `reject "${spec.title}"`,                  // the toast: Couldn't reject "Ritual altars…": <error> · Retry
});
```

- **`key`:** actions on one thing (accept, then reject, on one speculation) share its id, so they
  reach the server in the order they were clicked; different keys, or none, send at once, side by side.
  A failure doesn't stop the next of its key: that one still sends.
  When each response redraws a whole view (the server sends the whole list back), give every action in
  that view one key (`workshop:${patch}`): with a key per item, two answers can land out of order and the
  older one redraws over the newer.
- **`send` must reject on failure.** `fetch` resolves on a 500, so check `res.ok` and throw.
- **On failure:** `undo(err)`, then a danger toast (`Couldn't <label>: <error message>`) with Retry, which
  runs `apply` and `send` again. Name the item in the label, so the toast says which one failed. Failures
  while that toast is up join it ("(and 2 more)"), and its one Retry runs them all.
- **The promise settles once, Retries included:** with the value of the first `send` that goes through,
  or with the last error once the failure toast goes without a Retry. So success handling chained on it
  (`.then(({ id }) => …)`) runs after a Retry too. Its rejection is already handled, so leaving it
  unchained logs nothing.
- **`apply` and `undo` change only their own item,** never redraw the list from a snapshot taken at
  click time: with three clicks in flight, a snapshot undo would wipe the other two.
- **Not for a result you can't guess** (a calculation, an agent turn): show busy on its own region
  (`cui-busy`, a `statusSlot` working line), never on the whole panel.
