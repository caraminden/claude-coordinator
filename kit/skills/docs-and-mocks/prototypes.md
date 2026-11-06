# Prototypes

A prototype is throwaway code that answers one question. Write the question down first, in one
sentence, as the page's lede: a prototype that answers the wrong question is pure waste, and the
person opening it later needs to know what it settled. It comes in two forms.

## A logic toy

For rules and state: an economy (Delve's stores and prices), an automation rule, a queue, a flow
where the order of steps matters. One HTML page from `starter/review.html` that a person drives with
buttons, in the scheme's own words (Ore, Forge, Claim; not `dispatch` or `state.q`).

- **The rules in their own `<script>`,** as pure functions `(state, arg) => state` with no DOM in
  them, so the winning set can be lifted into the real code. The board's `on` handlers only call
  them.
- **The full state after every action,** as labelled fields (not a JSON dump), with what just
  changed marked.
- **Free-play buttons,** one per action, always there, in any order.
- **Scenarios:** a few named runs, each starting from the same state, each step a button: the
  normal case, the awkward case that's hard to reason about on paper, and something the rules
  should refuse. People find the bugs in the idea when a step does what they didn't expect.
- **Two versions of the rules side by side** when that is the question: one board each, the same
  buttons on both.
- **A verdict pick** on each board, so the answer saves (`artifact_data`).

## Look variants

A choice of look or layout is a review page: one board per take (`kinds.md`). Build the variants in
the real app instead only when a take can't be judged away from the real screen around it (its
real data, its density): two or three structurally different variants on the existing page behind
`?variant=`, on the minion's branch, shown with a preview. Variants that differ only in colour or
copy are a tweak, not a prototype.

## Rules for both

- **Marked throwaway:** "prototype" in the file or route name and in the page's kicker.
- **Trivial to run:** a page opens by itself; an in-app variant is one preview link.
- **No persistence:** state lives in the page and resets on reload. The verdict pick is the only
  thing saved.
- **No polish:** no tests, no error handling beyond what keeps it running, no abstractions for
  later.
- **Capture the verdict:** the question, the answer and the person's words in the page's decisions
  log, status `decided`; then the winner gets written properly in the real code.
- **Out of main:** a logic toy lives in the shared folder's `mockups/` and never enters a repo. An
  in-app variant's losing takes and switcher come out in a commit before the branch lands, so main
  keeps only the winner and the history keeps the rest.
