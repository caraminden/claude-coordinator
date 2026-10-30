# Where documents live, and how they stay true

## Places

Follow the shared folder's README first; where it is silent:

- **Design docs:** the shared folder's `specs/`, one folder per doc when it has art or a kit copy
  beside it (`specs/stores-panel/stores-panel.html`).
- **Review pages:** the shared folder's `mockups/`, the same way.
- **A design-system home and the scheme's `theme.css`:** the scheme's design folder (where its
  design docs already live; else `specs/design-system/`), linked from the scheme's CLAUDE.md or main
  design doc so sessions find it.
- **Throwaway takes** shown only to pick from once, never meant to be a record: your own shown-files
  folder; delete them before you close.

A page's art, data and kit sit beside it; it loads nothing from another scheme's folder.

## Life of a document

- **draft** while you make it; **review** once linked for people.
- **decided** when people pick: set the status chip, add the decision to the log with the date,
  who and their own words, and mark the chosen take (`rec` moves to it if it differs). Leave the
  other takes in place: they are why the decision makes sense later.
- **superseded** when a newer page replaces it: set the chip, add
  `<p class="mk-banner">Superseded by <a href="…">the newer page</a> (date).</p>` above the header,
  and link back from the new page. Keep the old one; never delete a decided page.
- **living** for a design-system home: its meta names the commit it was last checked against.

## Keeping a living home true

- A change to a token, component or rule updates the home in the same commit or the same turn.
- When the home and the code disagree, the code wins: fix the home.
- A decision about the look goes in the home's log, quoting the person with the date, as well as in
  the scheme's own decisions log if it keeps one.
