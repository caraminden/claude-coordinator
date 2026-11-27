# Cabal retro: Build 10, one kind of machine (Nov 26–27, 2026)

Build 10's Overseer (#2180) led the cabal. Its board: `#/p/2/cabal/2180`. The build came from Cara's #2177 card on
Nov 26 ("One major build"): every machine has an owner, one agent per computer, the Machines page's take B, a VM shown
as part of its computer, and CI runner hosts turned into ordinary PC rows. Times are Pacific.

| | |
|---|---|
| Roster | 7 rows: H1 #2184, H2 #2182, H3 #2183, H4 #2188, H6 #2202, and fixers FX #2195 and FX2 #2205. All merged into `build/10`[^t] |
| Wall time | 3 h 46 min, from the roster at 21:48 Nov 26 to live at 01:34 Nov 27[^t][^l] |
| Cost | $89.71: members $77.64, Overseer $12.07. The rows expected $126[^c][^t] |
| Full runs into `build/10` | 6 tries, 1 green: 3 red in CI, 1 refused at rebase, 1 refused by the smoke check, then green[^r] |
| Ship conflicts | 1, H3 into `build/10` at hand-off (`public/machine-connect.js`, `public/settings-machines.js`)[^r] |
| Asks | 5. Two were blocking, and both were answered within 1 min. The longest wait was 33 min (H1's ask 1)[^t] |
| Build risk | high (the owner backfill, schema 127 and 129, and `src/access.ts`). Cara's go at 01:26 Nov 27[^t] |

## Fixes

1. **The fake turn ends as soon as it reports, so a check after `turns()` races the turn's end.** H1 made every machine
   owned, and an owned machine opens only while the turn that got it is running (`openTurnSession`). Two checks in
   `test/machines.test.ts` asked for a session with a finished turn's token. They passed while the server was slower
   than the test and failed 1 copy in 10 in CI's burn-in. That cost two full runs (01:05 and 01:12 on the board),
   because the Overseer fixed line 101 alone and not the whole file (line 412 was the same race)[^r][^t].
   **Edit:** `test/machine-fakes.ts`, at the fake claude, says the turn may end once its line is in `turns.jsonl`. A
   check that needs it running belongs inside the fake. A check after it waits for the turn's end, or doesn't depend
   on the turn being alive.
2. **An Overseer's answer gave a member work that never got built.** Ask 1 picked a hidden `everyone` flag (H1) and
   said "H3's 'For my schemes' switch writes it. Told #2183." H3 merged without writing it. Only the whole-build
   Fable review found that nothing on the page sent `everyone`, and the Overseer fixed it at 00:40[^t]. This repeats
   the ledger row "Feeders' self-reviews … miss a gate that only the whole-build review catches."
   **Edit:** `kit/skills/cabal/SKILL.md`, section 2, Asks. An answer that gives another member work goes on that
   member's row note as a done-when line, and the Overseer checks it when that member merges.
3. **Three stale tests in files no member touched reached only the full run.** They were `runner-agent.test.ts` (H1's
   new CI rule) and two Machines page browser tests (H3 removed `.machine-row`). FX2 fixed them in 16 min for
   $1.06[^t]. This repeats the ledger row "A feeder's land runs only its own files' tests." The browser tests drive the
   page through a server rather than importing it, so neither `@samename` nor `@imports` picks them.
   **Edit:** `tools/affected-map.txt` gains rules for `public/settings-machines.js` and `public/machine-*.js` naming the
   three `test/machine-*-browser.test.ts` files. That reaches `--wide` and CI. The narrow `--affected` pick still
   skips map rules (#1928), so the build's full run stays the guard.
4. **The fixer rows were sized like features.** Both expected about $8; they cost $0.71 and $1.06[^t]. No edit: the
   expected cost only feeds the start card's threshold, and an over-estimate there costs nothing.

## Spec gaps (for Cara to judge)

The spec was silent on these, or the Overseer bent it. Each one sets how the core works:

- **Ask 1, the `everyone` flag (data shape).** The spec says every machine has an owner and that Josh's reach stays
  "as today". Ownership alone would have cut Josh off the test VM. The pick: a hidden `caps.everyone` on each role,
  set by the backfill and by the owner's "For my schemes" switch.
- **Ask 2, the VM keeps a hidden row (data shape).** Spec section 5 says the VM's "row then goes". It stays, hidden
  inside its computer's card, so the relay and its live tool names didn't need rekeying.
- **Ask 4, a VM links by name only (flow).** The host's Hyper-V report links a VM to the owner's row of the same
  name. Nothing links one by hand.
- **Ask 5, three VM calls.** Taskmaster lists still show the VM. Its roles and lends stay its own. Deleting the host
  unhides its VMs.

## What to keep

- **No `build-claims.md`.** Five members shared five machine files. Claims would have refused their edits to each
  other's lines. There was one conflict, caught at hand-off and resolved in the member's own rebase[^r].
- **H6's brief said "read the live rows, no hard-coded ids".** The live machine rows changed three times during the
  build (#2194: row 6 merged into 7, the VM became row 11, then row 12). H6 and the backfill held anyway.
- **One full run per batch of merges**, and the land smoke check: the missing `#N:` title cost 0 s in line[^r].

[^t]: `cabal_board` timeline for #2180, read 01:40 PST Nov 27, 2026 (starts, merges, asks, log, expected costs).
[^l]: `grep '09:34:58Z · timing · ticket/2180' "$COORDINATOR_SHARED_DIR"/retro-log/2026-11-27/land.md`: "landed", live 42 s after deploy; 09:34:58Z is 01:34:58 PST. Run 01:40 PST Nov 27.
[^c]: `sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db "select t.number, round(sum(u.cost_usd),2) from turns u join tickets t on t.id=u.ticket_id where t.project_id=2 and t.number in (2180,2182,2183,2184,2188,2195,2202,2205) group by t.number"`, run 01:40 PST Nov 27 (later turns of #2180 add to its line).
[^r]: `grep 'ticket/2180\|into build/10' "$COORDINATOR_SHARED_DIR"/retro-log/2026-11-27/land.md`, run 01:40 PST Nov 27: `into build/10, full` lines at 07:55:58Z (refused at ci), 08:40:32Z (refused at rebase), 08:59:58Z (refused at ci, burn-in red), 09:03:12Z (smoke, a commit title is wrong, 0s), 09:08:51Z (refused at ci, burn-in red), 09:25:10Z (merged); the one `land conflict` line at 07:18:27Z.
