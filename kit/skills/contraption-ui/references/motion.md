# Motion: whether, why and how

Read this before adding or changing an animation or transition, or when a review finds one. Rule 5
in the skill body is the floor (tokens, reduced motion, no layout properties, no `transitionend`);
this is the judgment above it. Ideas from Emil Kowalski's skills (credited in `THIRD_PARTY.md`), fitted
to Citadel's tokens.

## Ask in this order

1. **Should it move at all?** Count how often a person sees it. Many times a day (switching minions,
   opening a row, a hover across a list, anything a key triggers): no animation, it only makes the
   app feel slow. A few times a day (a drawer, a toast, a tip, a dialog): the tokens. Rare (a
   first-run moment): it may take more care, never more time.
2. **What is it for?** Keeping track of where something went (a drawer slides from its edge), showing
   a state changed, confirming a press, or softening something that would otherwise pop in. "It looks
   nice" on something seen often is not a reason: delete it.
3. **Which token?** `--citadel-motion` (150 ms, ease-out) for state changes, `--citadel-motion-slow`
   (250 ms) for drawers and sheets. Both are under 300 ms, which is the ceiling for anything a person
   waits on. Don't hand-roll a duration or a `cubic-bezier` per app: if a token feels wrong, ask
   Citadel to change the token, so every app moves alike.
4. **Which easing?** Ease-out (the tokens) for anything entering, leaving or answering a press;
   `linear` only for constant motion (a spinner, a progress bar). Never `ease-in` on UI: it holds
   still at the moment someone is watching.

## Shapes that feel right

- **Nothing grows from nothing.** Start an entrance at `scale(0.95)` with `opacity: 0`, never `scale(0)`.
- **A popover grows from its trigger.** If a popup scales, set `transform-origin` to the edge facing
  its trigger (a tip below the thing: `top`). A centred dialog keeps `center`. `cui-tip` only fades,
  so it needs none.
- **Transitions, not keyframes, for anything that can be retriggered** (toasts, toggles, a drawer
  dragged halfway): a transition turns round from where it is; a keyframe animation restarts from zero.
  Keyframes are for loops (the spinner, the skeleton shine).
- **Entrances with `@starting-style`**, no JS flag: `base.css` does it for `cui-tip` and `cui-toast`
  (`:popover-open` plus an `@starting-style` block at `opacity: 0`). Copy that shape.
- **Fast out, deliberate in.** What the system does (closing, dismissing) can snap; only a hold or a
  press someone is deciding on may take longer.
- **Hover motion only where hover is real:** wrap a hover transform in
  `@media (hover: hover) and (pointer: fine)`, or a phone plays it on every tap.
- **Warm tooltips:** once one tip is open, the next opens at once. `ui/tip.js` already does this (250 ms
  first, 60 ms after), so don't add a delay or an entrance of your own on top.
- **A press shows at once.** A `:active` press state belongs in `ui/base.css` for every button (not yet
  there); don't add your own scale-on-press per app, ask for it.

## Where we differ from the source, on purpose

- Rule 5 allows colour transitions; the source says transform and opacity only. `base.css` fades
  colours on hover, and that stays.
- Reduced motion takes our durations to 0 s, where the source keeps gentle fades. Ours is simpler, and
  rule 5 keeps state changes off `transitionend`, so it stays. (`drawers.js` does wait for one, with
  a timeout behind it for the 0 s case; new code sets its end state directly.)
- No springs, drag physics or staggered list entrances: our lists redraw often, and a stagger on a
  redraw is motion on a many-times-a-day path.

## In a review, fix in this order

Delete the animation, then shorten it, then fix its easing, then its origin. Flag on sight:
`transition: all`, `ease-in`, `scale(0)`, keyframes on something retriggered, motion on a keyboard
action, and hover motion outside the `(hover: hover)` query.
