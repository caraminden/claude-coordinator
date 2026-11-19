---
name: docs-and-mocks
description: >
  How to make the pages people decide from, with the mock kit. Use before making an HTML page, a
  design doc or a clickable prototype (ideation, a proposal, an art or feature review, a new look),
  and to judge whether a page is worth making at all.
---

# Docs and mocks

A design document is a page people decide from and come back to, so it is the decision's record:
consistent, high fidelity, and live where the feel is the question. Cara decides by seeing, so a
page that shows beats a reply that describes; but a page costs a turn to make and a person's time
to open, so it has to earn its place.

## Make one only when seeing it changes the decision

The default stays a chat reply, a question card, a table in the chat or a short markdown note.
Make a page when one of these is true:

- Two or three ways a screen, a flow or a piece of art could go, and the choice turns on how they
  look or feel. (Review page.)
- Many items each need a verdict: art pieces, foes, names, features. (Review page.)
- A change touches several screens, systems or files and needs options and pictures before
  anyone builds. (Design doc.)
- A scheme's look (colours, type, components, rules) spans several screens and minions keep asking
  what it is. (Design-system home: only then, Cara 2026-10-29.)
- Rules or a state model look fine on paper, and the question is whether they hold through real
  cases: an economy, an automation rule, a flow with awkward orders. (Prototype: a logic toy.)

A choice a click settles is a question card. A choice that is visual or has several parts (takes to
compare side by side, a handful of separate picks) is a choices page, a review page with pick bars:
make those often, people decide fast from them (Cara 2026-11-16, "we should DEFINITELY do a lot of
when appropriate"). A bug, a status, a one-off list of numbers or anything five lines can say is a reply.

Be ambitious inside the page: give each take its own character, finish it with real polish, and
include the details that make it feel real (hover and focus states, motion, empty and error states).
This deepens the page you were asked for; it adds no scope beyond the ask.

## Pick the kind

| Kind | Starter | Its shape |
|---|---|---|
| Review page | `starter/review.html` | "Now" first, then one live board per take; a pick and a note on each; Send |
| Design doc | `starter/doc.html` (or `starter/doc.md` with no visuals) | Problem with real numbers, options with pictures, one recommendation, open questions, decisions log |
| Design-system home | `starter/doc.html`, status `living` | Tokens, components, rules, each with where it lives in the code |
| Prototype | `starter/review.html`, one board per rule set | The question on top, the full state after every action, free-play buttons, scenarios, a verdict pick |

Read the kind's full shape in [`kinds.md`](kinds.md) before filling the starter; a prototype's, and
when look variants belong in the real app instead, in [`prototypes.md`](prototypes.md).

## Steps

1. **Find the scheme's look:** its `theme.css` (its design folder or the shared folder's
   `mockups/`), or with none the kit's default, Citadel's look. A mock of a scheme's own screen (a
   game panel) wears that screen's look: [`theming.md`](theming.md). A look nobody has decided yet
   gets a token plan first (its named colours, type roles, an ASCII wireframe), checked against
   the brief and the "generated page" tells: [`looks.md`](looks.md).
2. **Copy into the page's folder** `starter/mockkit.js`, `starter/mockkit.css`, the theme if any,
   and the starter, renamed for the page (`stores-panel-takes.html`). The kit sits beside every
   page so an old decision page never changes under its picks (Cara 2026-10-29); pages in one
   folder share one copy.
3. **Fill it with real things:** the scheme's real numbers, names and text; real art as sibling
   files (pixel art with `class="pixel"` at whole-number scales); a screen at its real size
   (`size` on boards). A grey box stands in only for something that does not exist yet, labelled so.
   A chart, dashboard or stat tile follows the built-in `dataviz` skill's method (form, marks,
   interaction) but takes its colours from the scheme's tokens, never dataviz's placeholder palette.
   Every URL, console page or outside doc is a link, `[Firebase console](https://console.firebase.google.com)`
   in markdown or an `<a>` in a page: never a URL in backticks, a bare domain, or "open X → Y" with
   no link to X (Josh, 2026-11-10: "links are links, the same should be true of documents").
4. **Make live what the feel decides** (hover details, collapsed sections, filters, toggles, a
   state switch), and always a pick bar where a choice is asked. Art stays images; long motion is a
   clip beside the page. The kit's API is in [`mockkit.md`](mockkit.md).
   **Critic first:** when the turn's review set (its "Review set:" line) has one whose `when:` has `creative:` and
   covers these takes, run `citadel:critique` on them before showing anyone, and lay the page out by
   its verdicts ([`kinds.md`](kinds.md), "Critic lines"). None in the set: no critic, no change.
5. **Check it in Citadel's viewer** at the size it is judged at: a mock of a scheme's own app or
   game screen at that screen's real size and scale, by the scheme's own rules (its CLAUDE.md or
   Project facts); a Citadel-facing page or doc at phone width. Every page also gets one light
   phone look (Cara often reviews on her phone): it opens, and mocks scale down to fit, never
   scrolling sideways. Check the console for errors, even room above and below every box, and click
   every control once; a new look also runs the tells in `looks.md`. A mocked screen with no
   scheme look to wear passes `citadel:contraption-ui`'s First look squint check.
6. **Reader-test a design doc** before anyone sees it: a Grunt with no context answers the 5 to 10
   questions its readers would ask from the doc alone, and you fix where it missed. The brief and
   what counts as a pass: [`reader-test.md`](reader-test.md). Review pages skip it unless their notes carry
   the argument.
7. **Show it:** link the page as a card and the screenshots inline, say in one line what to
   pick, and ask with `ask_question`, `doc` set to the page's path and no questions. That choices
   card waits on people like any card, opens the page, and settles when the page's Send lands. Every
   page with pick bars you link comes with one (the link check sends the reply back otherwise); never
   repeat the takes as a second card's options. End the turn waiting on the picks.
8. **Read the picks** with the `artifact_data` tool on the page's path: `db/<collection>/<id>` =
   `{ v, note, by, at }`. Send posts them into your chat as the person's message, which wakes you. A
   page saves them through `window.claude.use('db')` (as on claude.ai), `localStorage` or
   `citadel.storage`; the kit's Send dock is the only answer button ([`mockkit.md`](mockkit.md)).
9. **Write the decision back into the page:** status `decided`, the person's words quoted with the
   date in its decisions log, the losing takes left in place. A page replaced by a newer one gets
   status `superseded` and a banner linking it. Where pages live and how a living home stays true:
   [`homes.md`](homes.md).

Done when the page is linked with screenshots at its judging size (plus the light phone look), every
control was clicked once in the viewer, a design doc passed its reader test, and its picks read back
through `artifact_data`.
