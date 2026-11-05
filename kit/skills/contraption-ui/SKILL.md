---
name: contraption-ui
description: >
  Citadel UI: the components, tokens and design rules Citadel serves to every contraption (an app
  under /apps/<name>/): markdown, buttons, inputs, chips, notices, tooltips, status lines, colours and type, the app
  rail and phone drawers, and a starter page. Use for any front-end work in a contraption: a new page, a
  chat or reply view, rendering an agent's text, a form, a tooltip or hover detail, a saving or busy status, a
  colour or spacing choice, the phone layout.
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

| File | What | How |
|---|---|---|
| `theme.css` | Every token below as `--citadel-*`, light and dark | `<link rel="stylesheet">`, first |
| `ui/base.css` | Buttons, inputs, chips, notices, spinner, busy regions, skeletons, focus ring, as `cui-*` classes | `<link rel="stylesheet">` after theme.css |
| `ui/markdown.js` (+ `ui/markdown.d.ts`) | An agent's markdown as safe HTML, streaming-aware | ES module import |
| `rail.js`, `drawers.js` (+ `rail.d.ts`, `drawers.d.ts`) | The app rail; phone drawers (`NARROW`, the 800 px breakpoint) | See [rail-and-drawers.md](rail-and-drawers.md) |
| `ui/composer.js` (+ `ui/composer.d.ts`) | The message box under a chat | ES module import; needs base.css |
| `ui/chat.js` (+ `ui/chat.d.ts`) | The chat log: your messages, replies, tool runs, Grunt rows, reply chips, the working line | ES module import; needs base.css |
| `ui/tip.js` (+ `ui/tip.d.ts`) | Tooltips: `data-tip` on anything, opened on hover, focus, a tap or a long press | ES module import; needs base.css |
| `ui/status.js` (+ `ui/status.d.ts`) | A status line that's always there and a button label that keeps its width, and a toast in the top layer, so a status change moves nothing (plus HTML-string builders) | ES module import; needs base.css (and `mountTips` for a cut-off line's tip) |

[starter/](starter/index.html) (`index.html`, `app.css`, `app.js`) wires theme.css, base.css, the
rail, drawers, a status line, a chat and a composer; start a new contraption's page from it.

The API is stable: names and options are only ever added, and Citadel's tests hold them. A real
break would ship as a new file (`ui/chat2.js`) beside the old one. Types: point TypeScript at the
served `.d.ts` (copy it into your repo's types folder, or `declare module` it) rather than writing
your own.

## Markdown (`ui/markdown.js`)

```js
import { markdownElement, updateMarkdown, renderMarkdown, markdownLine, copyText } from '/apps/_citadel/ui/markdown.js';

box.append(markdownElement(text));                // a div.cui-md, its styles adopted
updateMarkdown(replyEl, textSoFar, { streaming: true });  // on every chunk; only changed blocks redraw
updateMarkdown(replyEl, fullText);                // once the reply is done
button.innerHTML = markdownLine(text);            // a line or two for a preview: no links, "• " items
```

Options (each optional): `breaks` (keep single line breaks: chat true, documents false),
`streaming` (holds back a half table row and a header without its separator, a bare list marker;
closes a half `**`, `` ` `` or `[link`), `headingBase` (the level `#` draws as: 3 by default so a
reply sits under your page's headings; a document passes 1), and hooks `link(href, html)`,
`image(href, alt, title)`, `text(html)` returning HTML.

- Output is escaped first; the only tags are the renderer's own, so `innerHTML` with it is safe.
- Default links: http(s) and mailto open a new tab (`_blank`, `rel=noopener`); anything else is an
  inert `span.cui-link`. A `link` hook for your own paths should still never use `target="_top"`:
  inside Citadel's frame that takes the person out of Citadel.
- Fenced code blocks drawn by `markdownElement`/`updateMarkdown` get a Copy button
  (`.cui-copy`, top right, shown on hover; always on a phone) that copies the code exactly. For
  your own Copy buttons, `copyText(text)` resolves whether it worked and also works on plain http.
- Styles come only through `markdownElement`/`updateMarkdown`; `renderMarkdown` alone is a string,
  for tests and servers. Preact: `updateMarkdown(ref.current, text, opts)` in a `useEffect`, with
  nothing rendered into that element.

## Composer (`ui/composer.js`)

```js
import { mountComposer } from '/apps/_citadel/ui/composer.js';

const box = mountComposer(document.getElementById('compose'), {
  placeholder: 'Message the agent…',
  draftKey: `draft:${chatId}`,           // optional: unsent text survives a reload, per chat
  send: (text) => postMessage(text),     // resolve once accepted; reject and the text goes back in the box
  stop: () => cancelTurn(),              // optional: Send shows as Stop while busy
  whileBusy: 'send',                     // optional: keep Send, with Stop beside it, while busy
});
box.busy(true);   // a turn is running (Send → Stop); box.busy(false) when it ends
```

What it does for you: grows with the text up to 40% of the screen; Enter sends on desktop and adds a
line at 800 px and under (Shift+Enter always adds one, Cara's pick); a half-composed IME word never
sends; a `1.` line continues the list; a failed send puts the words back and shows the error; Send is
disabled while a message is on its way; 16 px on phones so iOS doesn't zoom; a margin for the home bar.

- `whileBusy` (with `stop`): `'stop'` (default) turns Send into Stop while busy, so nothing sends
  mid-turn; `'send'` keeps Send (and Enter) sending and shows Stop (`box.stopButton`,
  `button.cui-btn.cui-danger.cui-composer-stop`) before it in the row while busy. Use `'send'` when
  your server queues or steers a message sent mid-turn, as Citadel's own chat does.
- `autofocus` (default `true`): the caret goes in the box when it comes up, when the window comes
  back and when a dialog or drawer closes, so people type without clicking. Desktop only (not under
  `(pointer: coarse)` or at 800 px and under), and only when nothing else has the caret: it never
  takes it from another field, a menu or a dialog, and a redraw or new message never moves it. Pass
  `false` for a box that isn't the page's main chat.
- More options: `label` (the box's accessible name), `canSend(text)` (refuse, or allow an empty text
  when something else rides along), `onError(err)` (show a failed send your own way).
- It returns `form`, `textarea`, `row` and `sendButton` too: put your own buttons (attach, a model
  picker) in `row` before Send, and restyle `.cui-composer` with your own selectors.
- `fitHeight(textarea)` and `continueList(textarea, e, enterAddsLine)` from the same module give your
  other text boxes the same autogrow and list continuation.
- Preact: mount it once in a `useEffect` on an empty element and keep the returned object in a ref.

## Chat (`ui/chat.js`)

```js
import { mountChat } from '/apps/_citadel/ui/chat.js';

const chat = mountChat(document.getElementById('chat'), {   // the element becomes the scroller: give it a height
  empty: 'Ask the Acolyte to do anything in Mandate.',
  stepLabel: (name, input) => (name === 'mcp__mandate__move_todo' ? `Moving “${input.title}”` : undefined),
  onReply: (message) => { chat.ask(message); post(message); },  // a reply chip was tapped
  markdown: { text: (html) => html.replace(/\b(?:Ctrl|Alt|Shift)\+[\w+]+/g, (k) => `<kbd>${k}</kbd>`) },  // optional
});
chat.load(history);                 // [{ ask, events: [{ type, data, at }] }], e.g. from your own store
chat.ask(text);                     // the person sent something: their message, then "Thinking…"
chat.push({ type, data });          // each turn-API event as your server relays it: start, text, tool, tool_result, end, error
chat.replies([{ label: 'Yes', recommended: true }, { label: 'No' }]);  // chips under the newest reply
```

Your server calls the turn API (`POST /api/contraptions/turns`) and relays its SSE events to the page
as they come; hand each to `push` as `{ type: <event name>, data: <its JSON> }`, untouched. Store the
same events per turn and `load` them to draw history. A stored turn needs its `end` or `error`: one
cut off (your server restarted mid-turn) draws as still running when it's the newest, so store an
`error` for it.

What it does for you: words split per model message (the turn API's `message`), so "Let me check."
and "Done." never glue together; each run of tool calls between texts collapses into one row that reads
the step in hand while running ("**Moving “Dry cleaning”…** · step 2") and a count once done ("3 steps
· 1 Grunt · 1 failed"), and opens on a tap; Grunts (Agent calls) show as their own rows holding their
calls, with a clock, while they run; `canceled` shows "Stopped.", any other error a danger notice.
It updates in place (text through `updateMarkdown`), so a selection, focus and an open row survive
streaming; it stays at the end while the log grows (a `block` card filling in later) or its box
shrinks (an undo bar, a phone keyboard), and only a person scrolling up (wheel, touch, keys, the
scrollbar) lets go of it, which shows "Latest ↓"; scrolling back to within 24 px of the end follows
again. So don't add your own ResizeObserver or scroll pinning around it. The working line is its
only live region, so a screen reader hears progress without the whole log.

- `block(name, input, result)`: draw a top-level call as your own card (Theory of Crafting's
  viability card). Called when the call starts (`result` undefined) and once when its result comes;
  return an element for a card, null to leave it a step. Agent calls are always Grunt rows. `result`
  is the tool_result event's `data` as it came, with `id` (the call's) and `ok` (a boolean): fields
  your server attaches to the tool_result events it stores and relays (the tool's output) reach your card.
- `markdown: { text, link, image }`: your markdown hooks (as in Markdown above) for every reply,
  history included, and for `renderChat`. Each one you give replaces the kit's for that hook only; line
  breaks and streaming stay the kit's. The kit leaves a link to your own paths (`/apps/<you>/...`) an
  inert span: a `link` hook returning a real `<a href>` (escape the href, no `target="_top"`) makes it
  open on a click or Enter.
- Stop is the composer's: on Stop, call the turn API's cancel; the `error` event (`canceled`) that
  follows ends the turn in the chat.
- Messages mid-turn (the composer's `whileBusy: 'send'`): while a turn runs, your server sends the
  person's message into it with `POST /api/contraptions/turns/<turn>/messages` `{ "person": 3, "text":
  "…" }` (the turn's own person only, or 403). `{ "steered": true, "id": "<uuid>" }`: it's in; Claude
  reads it between tool calls, or, sent while it was still replying, answers it after that reply, in the same turn. The turn's `taken`
  event `{ "id": "<uuid>" }` says Claude has read it: call `chat.ask(text)` then, so the rest of the
  reply draws under it, and mark it seen. `{ "steered": false, "reason": "replied" | "ended" }`: its
  reply was already out, or it ended; send it as a new turn once this one's `end` or `error` arrives.
  A steered message with no `taken` by the turn's `end` or `error` (it was stopped or failed) never
  reached Claude: send it as the next turn too. `push` ignores `taken`.
- `chatModel(turns)` is the same reading as plain data, and `renderChat(turns)` as an HTML string
  (tests, a print view); `stepMark(state)`, `gruntName(input)` and `duration(ms)` are the row parts.
- Preact: mount it once in a `useEffect` on an empty element, keep the returned object in a ref, and
  `push` from your event source; render nothing into that element.

## Tooltip (`ui/tip.js`)

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

## Status line and steady labels (`ui/status.js`)

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

## Base parts (`ui/base.css`)

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

## Installing as its own app

Each contraption installs as its own app beside Citadel's, all on Citadel's one origin, so Chrome
tells them apart only by the manifest (Cara, 2026-11-04: "I want each app to be able to install
independently"). The starter's `manifest.webmanifest` has the shape; replace `my-app` and add the icons.

- **`id` and `scope` are `/apps/<name>/`**, written root-absolute with the trailing slash. A relative
  `id` resolves against the origin, not the manifest, so `"./"` is `/`: Citadel's id.
- **`start_url` inside the scope**, and never a scope wider than yours: `/` or `/apps/` stops every
  other app installing on that device.
- **Link it relatively**: `<link rel="manifest" href="manifest.webmanifest" crossorigin="use-credentials">`.
  `/manifest.webmanifest` is Citadel's. Without `crossorigin` the fetch has no login and fails.
- **Icons: a 192 and a 512 px PNG** with purpose `any` (a maskable 512 too, ideally), served by your app.
  An SVG alone gets no Install on Android, only "Add to home screen". Also `name` and
  `display: "standalone"`.
- A service worker is optional; if you have one, its scope is `/apps/<name>/`.

The app rail has an **Install <your title>** button for you, framed in Citadel or on your own page,
which picks the way this browser can install you (the browser's dialog, your page in a new tab or in
Chrome itself, or the iOS Share hint; rail-and-drawers.md, "Installing you"). Opened from Citadel's
rail, your page is in a frame and Chrome only sees Citadel's page, so that button is the way in.
Every deploy checks the above and logs `Warning (installing as its own app): …` lines when it's wrong
(Citadel's `src/pwa-check.ts`). Full detail and the Android caveats:
`shared/project/specs/contraptions/app-rail.md`, "Installing your contraption as its own app".

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
6. **External links open a new tab; nothing uses `target="_top"`.**
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
    the headless check in "Status line and steady labels".
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
    kept), as the notice above does.
20. **Undo over "are you sure?".** A delete or bulk change acts at once and offers Undo in a bar
    of your own (`toast` takes no button); ask first only when nothing could bring it back.
21. **A view worth coming back to has its own URL.** A tab, item or filter someone would share,
    reload or go Back to updates the URL (`history.pushState`; `replaceState` for small steps), and
    that URL opens the same view.

A self-review counts a break of these rules, and anything hand-rolled that the library serves, as a
finding (`citadel:self-review`, "UI findings").

Each rule shown right and wrong (14 to 21 listed, no demo yet), with every part drawn live in both modes: Citadel's living
design-system home, `docs/design-system/index.html` in Citadel's repo (Citadel's minions keep it
true; ask your Taskmaster for a copy if you need the page itself).
