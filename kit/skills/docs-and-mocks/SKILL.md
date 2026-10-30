---
name: docs-and-mocks
description: >
  How to make the documents people decide from and come back to: review pages with takes side by
  side and saved picks, proposal and design docs, and a scheme's living design-system home, built
  with the mock kit so every scheme's look and layout match. Use before making an HTML page or a
  design doc for ideation, a proposal, an art or feature review, or a design system, and to judge
  whether one is worth making at all.
---

# Docs and mocks

A design document is a page people decide from and come back to: a choice between takes, a review
of art or a feature, a system that touches many parts of a scheme. Made well it is the decision's
record, so it is consistent, high fidelity, and live where the feel is the question. Cara decides
by seeing, so a page that shows beats a reply that describes; yet a page costs a turn to make and a
person's time to open, so it has to earn its place.

## Make one only when seeing it changes the decision

The default stays a chat reply, a question card, a table in the chat or a short markdown note.
Make a page when one of these is true:

- Two or three ways a screen, a flow or a piece of art could go, and the choice turns on how they
  look or feel. (Review page.)
- Many items each need a verdict: art pieces, foes, names, features. (Review page.)
- A change touches several screens, systems or files and needs options, pictures and a
  recommendation before anyone builds. (Design doc.)
- A scheme's look (colours, type, components, rules) spans several screens and minions keep asking
  what it is. (Design-system home: only then, Cara 2026-10-29.)

A choice a click settles is a question card. A bug, a status, a one-off list of numbers or anything
five lines can say is a reply.

## Pick the kind

| Kind | Starter | Its shape |
|---|---|---|
| Review page | `starter/review.html` | "Now" first, then one live board per take; a pick and a note on each; Send |
| Design doc | `starter/doc.html` (or `starter/doc.md` with no visuals) | Problem with real numbers, options with pictures, one recommendation, open questions, decisions log |
| Design-system home | `starter/doc.html`, status `living` | Tokens, components, rules, each with where it lives in the code |

Each kind's full shape is in [`kinds.md`](kinds.md): read it before filling the starter.

## Steps

1. **Find the scheme's look.** A scheme with its own look keeps a `theme.css` (its design folder or
   the shared folder's `mockups/`). None: the kit's default is Citadel's look, which suits any
   scheme without one. A mock of a scheme's own screen (a game panel) wears that screen's look:
   [`theming.md`](theming.md).
2. **Copy into the page's folder** `starter/mockkit.js`, `starter/mockkit.css`, the theme if any,
   and the starter, renamed for what the page is (`stores-panel-takes.html`). The kit sits beside
   every page so an old decision page never changes under its picks (Cara 2026-10-29). Pages in one
   folder share one copy.
3. **Fill it with real things:** the scheme's real numbers, names and text; real art as sibling
   files (pixel art with `class="pixel"` at whole-number scales); a screen at its real size
   (`size` on boards). A grey box stands in only for something that does not exist yet, labelled so.
4. **Make live what the feel decides:** hover details, folds, filters, toggles, a state switch, and
   always a pick bar where a choice is asked. Keep still what only needs looking at: art as images,
   long motion as a clip beside the page. The kit's API is in [`mockkit.md`](mockkit.md).
5. **Check it in Citadel's viewer** at desktop and phone widths: screenshot both, open the browser
   console for errors, confirm nothing scrolls sideways, and hold every box to even room above and
   below. Click every control once.
6. **Show it:** link the page as a card and the two screenshots inline, say in one line what to
   pick, and end the turn waiting on the picks.
7. **Read the picks** with the `artifact_data` tool on the page's path: `db/<collection>/<id>` =
   `{ v, note, by, at }`. Picks sent with Send also arrive as a comment message.
8. **Write the decision back into the page:** status `decided`, the person's words quoted with the
   date in its decisions log, the losing takes left in place. A page replaced by a newer one gets
   status `superseded` and a banner linking it. Where pages live and how a living home stays true:
   [`homes.md`](homes.md).

Done when the page is linked with screenshots at both widths, every control was clicked once in
the viewer, and its picks read back through `artifact_data`.
