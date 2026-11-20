# The ideas ledger

Status: accepted, 2026-11-20 (#1150).

Josh picked G3 "One ledger of ideas and handoffs" on #1092's ideas page (2026-11-19), and settled its design in #1150's grilling round on 2026-11-20:

- Storage: a database table, `ideas`, one row per idea per scheme ("Database table").
- Filling: automatic, with a hand fix that sticks ("Automatic, plus manual fix"). Send on a choices page writes the picks, a minion started from a handoff marks its row started, and a ship marks it built. A status or minion link set by hand wins over the scan until it is set back to automatic.
- Pages: Orders → Ideas, linked both ways with Orders → Decisions; a pick sent with a note is a decision there too, as the source "Ideas ledger" ("Two pages; noted picks feed it").
- Which picks make rows: any pick bar with a Later option, found automatically, and every handoff file in the shared folder, which joins the row of the card it names or makes its own ("Later-style bars + handoffs"). Design-take bars without a Later option make none.
- Later items: rows picked Later over two weeks ago sit pinned at the top of the page, and once a week the scheme's Taskmaster gets them as held mail that wakes nothing ("Pinned + weekly Taskmaster note").

Built is read from the minion's own record: a "Shipped" note, a merged PR, a ship lessons row, or for a minion merged into a major build, its build minion's ship. Nothing in the ship pipeline writes to the ledger.
