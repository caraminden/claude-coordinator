# Self-review: UI findings

Part of `citadel:self-review`, opened by name from its SKILL.md; section numbers (1 to 5) are SKILL.md's.

### UI checks for every front end

Every scheme's front end, built or reviewed, follows these (moved here from the Citadel-wide
Settings, #1576); a break is a Should-fix finding:

- Vertical padding (contraption-ui rule 1): text or an icon in anything boxed (a bar, button, row or chip) gets the same non-zero padding top and bottom. Check it in screenshots.
- Proportional checks: test and screenshot what the change touches, not the whole app.
- Clicks never freeze the UI (Cara, 2026-11-08; her words are in contraption-ui rule 23). A person's action shows its result at once and the request runs behind it; a failure rolls back that one item with a toast and a retry. In contraptions use the kit's `optimistic()`.
- No reflow without input (Cara, 2026-11-16: "UI reflowing without a user input should be avoided, especially if it moves big pieces of the UI around"). Nothing on screen moves unless the person did something. Content that arrives or changes on its own (live status, counts, timers, cards, images, a scrollbar coming and going) keeps a reserved size or appears where it pushes nothing: fixed or min widths, tabular numbers, `scrollbar-gutter: stable`, placeholders sized like what replaces them. Sideways shifts and moves of big pieces (panes, the rail, the chat column) are the worst. Check a page that updates live by letting it sit for a minute and comparing positions, and prefer an automated layout-shift check where it can repeat.
- Links are clickable (Cara, 2026-11-09, her words in contraption-ui rule 6; Josh, 2026-11-10, extended it to documents). Any URL, DOI or reference to another page or item that a UI shows is a real link, never plain text or only a tooltip; external ones open in a new tab; text from data is linkified on render. The same holds for documents written for people: every URL, console page or external doc is a markdown link `[name](https://…)`, never in backticks or a bare domain.

### Web front ends

For a diff that touches the front end, each of these is a Should-fix finding. The rules behind
them are "The rules" in `citadel:contraption-ui`.

- A hand-built twin of a part the kit serves (Cara, 2026-11-17: "using reusable components"): a
  dialog not built with `openDialog` or `cui-dialog`, a toast not from `toast`, a tooltip not from
  `data-tip`, a picture viewer not from `lightbox`, or, in a contraption (an app under
  `/apps/<name>/`), hand-rolled markdown, a chat log or a composer. Where the part lacks something,
  the fix is adding it to the part. A copied Citadel hex colour instead of its `--citadel-*` variable.
- A clickable `div` or `span` where a native control (`<button>`, `<a href>`, an input) belongs;
  an icon-only button with no `aria-label`; an `<img>` with no `alt`; a field other than the
  composer named only by its placeholder.
- An action reachable only on `:hover` or only by dragging; meaning carried by a colour alone.
- `outline: none` with no `:focus-visible` ring; animating `width`, `height`, `top`, `left` or a margin; a
  loop that isn't a spinner or skeleton; a duration not from `--citadel-motion`; a state change
  finished in `transitionend` or `animationend`; anything on the "Flag on sight" list in
  `contraption-ui`'s `references/motion.md`.
- A fixed `height` or `overflow: hidden` on a box of text (the status line's one-line cut is
  fine); `100vh`; a long URL, id or table that
  can push a phone page sideways; an `<img>` with no size or `aspect-ratio`.
- A status, error or new element inserted into the flow; a submit that can fire twice; an empty
  or failed state that is blank or says only "Error".
