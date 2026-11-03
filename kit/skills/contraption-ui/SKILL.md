---
name: contraption-ui
description: >
  Citadel UI: the components, tokens and design rules Citadel serves to every contraption (an app
  under /apps/<name>/): markdown, buttons, inputs, chips, notices, colours and type, the app rail and
  phone drawers, and a starter page. Use for any front-end work in a contraption: a new page, a chat
  or reply view, rendering an agent's text, a form, a colour or spacing choice, the phone layout.
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
| `ui/base.css` | Buttons, inputs, chips, notices, spinner, focus ring, as `cui-*` classes | `<link rel="stylesheet">` after theme.css |
| `ui/markdown.js` (+ `ui/markdown.d.ts`) | An agent's markdown as safe HTML, streaming-aware | ES module import |
| `rail.js`, `drawers.js` | The app rail; phone drawers (`NARROW`, the 800 px breakpoint) | See [rail-and-drawers.md](rail-and-drawers.md) |
| `ui/composer.js` (+ `ui/composer.d.ts`) | The message box under a chat | ES module import; needs base.css |
| `ui/chat.js` (+ `ui/chat.d.ts`) | The chat log: your messages, replies, tool runs, Grunt rows, reply chips, the working line | ES module import; needs base.css |

[starter/](starter/index.html) (`index.html`, `app.css`, `app.js`) wires theme.css, base.css, the
rail, drawers, a chat and a composer; start a new contraption's page from it.

The API is stable: names and options are only ever added, and Citadel's tests hold them. A real
break would ship as a new file (`ui/chat2.js`) beside the old one. Types: point TypeScript at the
served `.d.ts` (copy it into your repo's types folder, or `declare module` it) rather than writing
your own.

## Markdown (`ui/markdown.js`)

```js
import { markdownElement, updateMarkdown, renderMarkdown, markdownLine } from '/apps/_citadel/ui/markdown.js';

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
});
box.busy(true);   // a turn is running (Send → Stop); box.busy(false) when it ends
```

What it does for you: grows with the text up to 40% of the screen; Enter sends on desktop and adds a
line at 800 px and under (Shift+Enter always adds one, Cara's pick); a half-composed IME word never
sends; a `1.` line continues the list; a failed send puts the words back and shows the error; Send is
disabled while a message is on its way; 16 px on phones so iOS doesn't zoom; a margin for the home bar.

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
});
chat.load(history);                 // [{ ask, events: [{ type, data, at }] }], e.g. from your own store
chat.ask(text);                     // the person sent something: their message, then "Thinking…"
chat.push({ type, data });          // each turn-API event as your server relays it: start, text, tool, tool_result, end, error
chat.replies([{ label: 'Yes', recommended: true }, { label: 'No' }]);  // chips under the newest reply
```

Your server calls the turn API (`POST /api/contraptions/turns`) and relays its SSE events to the page
as they come; hand each to `push` as `{ type: <event name>, data: <its JSON> }`, untouched. Store the
same events per turn and `load` them to draw history.

What it does for you: words split per model message (the turn API's `message`), so "Let me check."
and "Done." never glue together; each run of tool calls between texts folds into one row that reads
the step in hand while running ("**Moving “Dry cleaning”…** · step 2") and a count once done ("3 steps
· 1 Grunt · 1 failed"), and opens on a tap; Grunts (Agent calls) show as their own rows holding their
calls, with a clock, while they run; `canceled` shows "Stopped.", any other error a danger notice.
It updates in place (text through `updateMarkdown`), so a selection, focus and an open row survive
streaming; it follows new output only within 24 px of the bottom, else shows "Latest ↓"; the
working line is its only live region, so a screen reader hears progress without the whole log.

- `block(name, input, result)`: draw a top-level call as your own card (Theory of Crafting's
  viability card). Called when the call starts (`result` undefined) and once when its result comes;
  return an element for a card, null to leave it a step. Agent calls are always Grunt rows.
- Stop is the composer's: on Stop, call the turn API's cancel; the `error` event (`canceled`) that
  follows ends the turn in the chat.
- `chatModel(turns)` is the same reading as plain data, and `renderChat(turns)` as an HTML string
  (tests, a print view); `stepMark(state)`, `gruntName(input)` and `duration(ms)` are the row parts.
- Preact: mount it once in a `useEffect` on an empty element, keep the returned object in a ref, and
  `push` from your event source; render nothing into that element.

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

## The rules

1. **Equal room above and below:** text or an icon in a box, bar, button, row or chip has equal,
   non-zero top and bottom padding. Size controls with `--citadel-control-h` and centre the content.
2. **Text on the accent uses `--citadel-on-accent`.**
3. **Inputs are 16 px at 800 px and under**, so iOS Safari doesn't zoom on focus.
4. **Focus is visible on keyboard focus only:** `:focus-visible` with the focus ring.
5. **Motion respects reduced motion:** durations from `--citadel-motion`, spinners stop.
6. **External links open a new tab; nothing uses `target="_top"`.**
7. **No inline styles in what a component writes** (`style=""`, `<style>`): Citadel's CSP and maybe
   yours refuse them. Use classes, or a constructed stylesheet adopted once.
8. **Use the variables, never copied hex.**
9. **Phone breakpoint is 800 px** (`NARROW` from `drawers.js` in script).

A self-review of a contraption counts hand-rolled markdown, a chat log or composer the library
has, and a copied Citadel hex colour as findings.

Each rule shown right and wrong, with every part drawn live in both modes: Citadel's living
design-system home, `docs/design-system/index.html` in Citadel's repo (Citadel's minions keep it
true; ask your Taskmaster for a copy if you need the page itself).
