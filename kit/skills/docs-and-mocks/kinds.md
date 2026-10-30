# The three kinds and their shapes

Every kind opens with the same header (`starter/doc.html` has it): a kicker (scheme · kind · minion),
the title as the question or the thing, a meta line with the status chip, the date and what it builds
on, and a lede of one or two sentences saying what the reader decides here.

Statuses: `draft` (still being made), `review` (waiting on people), `decided`, `living` (a home kept
true), `superseded`.

## Review page

People pick between takes, or give each item a verdict.

- **Boards, one per take,** with `mock.boards()`. "Now" comes first, with `pick: false`, whenever
  something exists today: a take is judged against what it replaces.
- **Each take changes one idea,** named in its title ("Corner button on the page") and explained
  in its note (one or two sentences: what it does and what it costs). The recommended take has
  `rec: true`. Labels A, B, C; no letter in the title.
- **Each board really behaves.** The same screen and data in every board, so the difference is
  the idea, not the content. State is per board; a control above the boards that every take shares
  uses `ctl.set('*', patch)`.
- **Item verdicts** (art, foes, names): a grid of items, each a `[data-pick]` element with its art
  and name, and `mock.picks({ collection: 'marks', options: ['keep', 'rework', 'cut'] })`.
- **Below the boards:** what every take shares, so no board's note has to repeat it.
- **The dock** comes by itself: counts and Send.

## Design doc

A proposal, or the design of a system, before anyone builds.

1. **The problem**, with the real numbers (`.stat` tiles or a sentence) and where they came from.
2. **What it touches**: screens, systems, files; a table when there are more than three.
3. **The options**, as `.mk-options` cards, each with a picture (a live mini screen, a screenshot,
   art), its idea in a line, and what it costs. Two or three, never one.
4. **The recommendation** in a `.mk-callout.rec`: which option and why, in three sentences or fewer.
   The recommended card gets `rec`.
5. **Open questions**, each a `.mk-callout.question` with a pick bar (`options: ['yes', 'no']`,
   or the choices), so answers save.
6. **The decisions log** (`.mk-log`): each decision with its date, who made it and their own words.

Longer docs get contents (`<nav class="mk-toc">` and `mock.toc()`). A design doc with nothing to
look at is a markdown file from `starter/doc.md`, same sections.

## Design-system home

One living page per scheme for its look, made once that look spans several screens.

- **Tokens:** every colour as a swatch with its name, values (light and dark if both) and its use;
  type sizes and faces; spacing and radius steps. Each group says where it lives (`file:line`).
- **Components:** each a `.mk-specimen`: the real thing drawn live with the scheme's own rules
  (copied into the page, scoped), what it is for in a sentence, and where it lives in the code.
- **Rules:** the few the scheme holds every screen to, each shown right and wrong.
- **Header meta:** status `living`, and the commit it was last checked against.
- **Decisions log:** when a rule or token changed, who decided, their words.

The code is the source of truth: a change to a token or component updates the home in the same
commit, and a home that disagrees with the code is a bug in the home.
