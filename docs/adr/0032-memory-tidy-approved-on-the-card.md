# The memory tidy is approved on its card and applied by the curator run

Status: accepted, 2026-11-24 (#1803).

#1111 built the weekly memory curator from Josh's pick (2026-11-19): "a curator a member approves, note by note, on the
Memory page; the curator only proposes". Its card in the run's chat had no buttons on purpose: it linked the Memory page,
where a member ticked each change and the server applied the ticked ones.

On 2026-11-24, in the curator run's chat (#1766), Cara found the card had nothing to press and said: "We should make it
something a minion can do with approval". Cara is a member and the newer word wins, so the curator now applies its own
tidy once a member approves it.

What changed (#1803):
- **The card has Approve all and Reject** (Reject is the plan card's own second button, kept so a tidy nobody wants
  doesn't sit waiting; the page's "Turn it all down" does the same). Approve marks the card approved and wakes the run, which calls `apply_memory`.
  Reject turns the tidy down at once; nothing is written. Only a member of the scheme can answer (a non-member gets 404).
- **One write path.** `apply_memory` and the Memory page's ticks both go through `decideTidy` in
  `src/routes/memory-curator.ts`: the same apply, the same changed-since skip, the same 30-day Put back. A tidy already
  decided in one place is refused in the other, so nothing is applied twice.
- **The page stays** for picking a subset. A tidy approved on the card shows as approved there until the run applies it,
  and the ticks still work meanwhile; whichever decides first wins.
- **Approve all covers:** every change but the flags (flags change nothing) and the deletes. Josh's "Delete, each ticked"
  (2026-11-19) stands: Approve all turns every delete down and keeps the note, and the card names them; a member who
  wants them gone applies the tidy on the Memory page instead, ticking each delete. (Not built: leaving the deletes
  open on the page after the run applies the rest; the tidy is decided once, as a whole.)
- **Tidies already waiting** (such as #1766's) get the new card at once: the card is drawn from the stored event, so
  their Approve works after the deploy, and their runs get `apply_memory`.
