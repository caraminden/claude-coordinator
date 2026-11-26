# A pick on a card starts the minion, with no Taskmaster turn

Status: accepted, 2026-11-25. Built by #2050. Reverses Cara's "Not now" of 2026-11-16 on #848's route A
("A pick starts the minion, with no Taskmaster turn"). Data: the shared folder's
`reports/2026-11-25-turns-the-server-could-do.md` (candidate 2) and #848's page
`mockups/taskmaster-routing/taskmaster-routing-picks.html` (route A).

- **Cara, 2026-11-16,** on #848's choices page, route A: **"Not now"** (then about $42 a week of Taskmaster turns).
- **Josh, 2026-11-25:** "we should only use minion turns for things code cant easily do". On #2031's choices page he
  picked **"Start"** on "A pick on a card starts the minion directly". By the Citadel-wide rule the newest member's word
  wins, so this replaces the Nov 16 decision.
- **The data (7 days to Nov 25, every scheme):** 243 "picked → please start from handoffs/…" messages to Taskmasters,
  which led to 215 Taskmaster turns (about $90, an upper bound: those turns read other mail too). About 2 to 3 times the
  Nov 16 estimate.

## The rule now

- An `ask_question` option on a minion's own card can carry `start: {handoff, title, type, model?, effort?, start_after?,
  build?}`. It is checked when the card is posted: the handoff is a `.md` file in the scheme's shared folder, the type a
  type of that scheme, and model and effort from the lists create_ticket takes (left out: the model table's pick for the
  type). Ship cards and a Taskmaster's cards can't carry one: a Taskmaster starts its own minions with create_ticket.
- A person's plain pick (no typed words, no picture or file) starts each picked option's minion through the
  Taskmaster's own create path: brief "Start from the handoff <path>", parent the card's owner, the picker's own
  (assigned, requested by, and run on the picker's login), the worker pool's line, the start card over $30, and the
  duplicate-handoff refusal (a handoff an open minion, or one closed in the last 3 days, started from). Two picks of one
  handoff at once: the second is refused.
- When every pick started, the card's owner hears it as held mail (no turn), with a note in its chat. Anything else (a
  refused start, or other options picked beside the starts) wakes the owner with what started and what didn't.
- The scheme's Taskmaster gets held mail (a fyi) naming what started.
- A pick with typed words or a picture starts nothing: the words may change the brief, so the owner is woken as before
  and passes the picks on.

## What the Taskmaster gives up

It no longer reads each brief before it starts: the card's author fills in model, effort, start_after and build, and
the server refuses duplicates. Ordering against the start limits stays with the worker pool's line.

## Not covered yet

Choices pages (a mock kit page's Send) still go to the minion, which passes the picks on. They can follow once the card
version holds. The Taskmaster's "schedule this weekly?" cards (route A's `schedule` option) were not built either.
