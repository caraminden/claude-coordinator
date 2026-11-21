# Chat (`ui/chat.js`)

Part of `citadel:contraption-ui` (its SKILL.md has the file list, tokens and rules).

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
A turn the turn API ends `interrupted` with `retry: true` (cut off by a Citadel restart) also gets
a Retry chip under it when you pass `onReply`, which sends `RETRY_SAY` (a short "carry on") through it.
It updates in place (text through `updateMarkdown`), so a selection, focus and an open row survive
streaming; it stays at the end while the log grows (a `block` card filling in later) or its box
shrinks (an undo bar, a phone keyboard), and only a person scrolling up (wheel, touch, keys, the
scrollbar) lets go of it, which shows "Latest ↓"; scrolling back to within 24 px of the end follows
again. So don't add your own ResizeObserver or scroll pinning around it. The working line is its
only live region, so a screen reader hears progress without the whole log.

- `block(name, input, result)`: draw a top-level call as your own card (Theory of Crafting's
  viability card). Called when the call starts (`result` undefined) and once when its result comes;
  return an element for a card, null to leave it a step. Agent calls are always Grunt rows. `result`
  is the tool_result event's `data` as it came, with `id` (the call's), `ok` (a boolean) and, when
  it failed, `error` (the text the agent saw): fields your server attaches to the tool_result events it stores and relays (the tool's output) reach your card.
- `markdown: { text, link, image }`: your markdown hooks (as in [markdown.md](markdown.md)) for every reply,
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
