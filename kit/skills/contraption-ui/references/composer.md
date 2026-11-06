# Composer (`ui/composer.js`)

Part of `citadel:contraption-ui` (its SKILL.md has the file list, tokens and rules).

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
