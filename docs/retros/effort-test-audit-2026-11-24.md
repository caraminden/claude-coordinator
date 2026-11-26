# Effort retro: Test audit Nov 24 (2026-11-24 to 2026-11-26)

The effort had 8 minions. Five started together at 15:44 PST on Nov 24, from the audit #1812's batches:

| Minion | Batch | What it did |
|---|---|---|
| #1828 | A | cuts |
| #1829 | D and C | wrong tests and speed |
| #1830 | | reviewer lens |
| #1831 | B | merges |
| #1832 | E | shared harnesses |

Three more, #2014, #2015 and #2016, started at 14:36 PST on Nov 25 from #1829's handback, on Josh's picks. The last
one closed at 09:18 PST on Nov 26[^t]. Recorded turn cost was $33.96 across the 8, plus $12.03 for the audit
itself[^c]. Times are Pacific. Evidence came from read_minion on all 8 (three Sonnet Grunts), the retro logs for
Nov 24 to 26, and `git log main`.

## What went wrong across the effort

1. **Four of the eight briefs were built on an audit count or claim that didn't hold.** The audit's Grunts skimmed,
   and the briefs passed their numbers on as facts:
   - #1831: the per-bug-number "table families" were not near-copies. The claim that `parked-hold` covered the
     unpark case was wrong too, because it goes through `/messages` and not the tool route.
   - #1832: the audit said 56 to 72 files write their own fake claude. Only 22 were plain enough to move onto the
     shared one (16, then 6)[^h].
   - #2014: the `late` knob it was asked for fires only on failure, so it wasn't needed.
   - #2016: `close-self` boots no server, and `merge-go` needs a separate HOME for each test. Only one of the three
     files got the shared boot.

   Each minion found the gap and shrank its work, so nothing was built wrong. But all of them spent the start of a
   turn re-deriving the premise. This is a repeat of the ledger's "Briefs state a guess as fact" row.
   - **Fix:** the handoff below. The audit method marks each Grunt count as a skim, and the minion checks it on three
     named files before it builds.

2. **The harness batch ran at the same time as the batches that change the same files, and waited about a day.**
   - #1832 (E) touched files that #1828 (A) was cutting. In git, 8 files are shared by #1828 and #1832[^f].
   - #1832 deferred 20 files that open worktrees held. Of the 9 holders, only #1828 was in the effort; the other 8
     were unrelated minions[^h].
   - It sealed itself until 09:00 PST on Nov 26 and shipped its last 18 files then, 41.5 h after it started[^t].
   - `who-touches` and the deferral kept the effort free of land conflicts between its own minions: 0 of them[^l].
     So the cost was elapsed time, not rework.
   - **Fix:** the same handoff. The audit's handoffs give a running order, with E after A and B have shipped, and each
     records `who-touches` on the day it was written.

3. **Four minions went on speed work worth about 9 s of CI wall together.**
   - The audit already said batch C was "about 300 s summed, so about 20 s off the 176 s". Every 14 test-seconds
     saved buys about 1 s of wall time.
   - #1829 cut its 9 files from 164 s to 95 s. Its handback card then offered three more speed pieces, and nothing
     on the card gave a wall number. Josh picked all three.
   - Those three saved about:
     - #2014, guard: from about 57-65 s to about 33 s. Its deploy gain was within the noise.
     - #2015: from 39.7 s to about 20 s.
     - #2016: about 7 s. `merge-go` showed no change.
   - That adds up to about 124 test-seconds, or about 9 s of wall time[^s].
   - #2148 found the same ratio again on Nov 26 (100 test-seconds is about 7 s)[^w].
   - The spend was small: $3.15 for the three follow-ups[^c]. The miss is that the card's reader couldn't weigh them.
   - **Fix:** the same handoff. A speed batch, and a speed handback, states its CI wall saving on the card.

4. **#1828 took 8.8 h and 7 turns to ship a 225-line deletion, and none of its four failed lands was caused by its
   own change**[^t][^r]. The four were:
   - the deploy boot check's database copy, which took 350 of its 420 s;
   - `format.test.ts` skipping on the desktop runner while #1885's check rolled out;
   - a `turn-person-env` CI timeout;
   - a `README.md` conflict at 00:04 PST on Nov 25[^l].

   #1885's new format check also failed #1829's and #1831's ships while the effort was running.
   - **No fix here:** land's smoke step now formats and names the files before the line (`tools/land/prepare.sh`). The
     boot check and CI timeouts belong to the pipeline's own retros.

5. **Burn-in called a CI-only fault "racy" a third time.**
   - #1832's `scheme-spinner` failed 10 of 10 copies. The cause was the tripwire reading the CI runner's temp folder
     as another home, not a race.
   - This repeats a ledger row. #2141 is building the "run it once alone, say which case" fix (`who-touches
     tools/burn-in.sh`, 2026-11-26), so no new handoff is needed.

Leftovers with no owner, noted and not handed off, because each is small and not asked for:
- #1828 kept `public/cardreply.js`, a one-line `return true` that `public/thread.js` imports. Inlining it needs a
  `public/` change.
- #1829's `instant-open-browser` cold boot was offered, and nobody picked it.
- #1831 left `machine-notes-cards` (it needs a harness), `ci-health` and the lane files.

## Spec gaps

The briefs were the spec here, and their gaps are finding 1. One decision sets how the core works and is for the
owner to judge: should a test audit's handoffs be allowed to state a Grunt's skim as a count? The handoff's answer
is no. They label it, and the minion checks it first.

## What to keep

- Running `who-touches` before starting, and deferring held files instead of fighting over them. That gave 0 land
  conflicts between the effort's own minions, with 3 of them touching `test/typecheck-baseline.json`[^l][^f].
- #1830's heads-up to #1780 and #1865 over `lenses.md`. #1780 answered "ship yours first", and the benchmark rerun
  then happened once.
- Armed hand-offs (#2046). The lane queue had estimated #2014's wait at 4.7 h. The Taskmaster then told it to hand off
  at once, and it did.
- Minions saying when a brief's premise failed, as #2016 did to the Taskmaster, instead of forcing the asked-for
  shape.

[^t]: `sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db "select number, datetime(created_at/1000,'unixepoch','localtime'), datetime(closed_at/1000,'unixepoch','localtime') from tickets where project_id=2 and number in (1828,1829,1830,1831,1832,2014,2015,2016)"`. Ship times are commit dates from `git log main --format='%cd %s' --date=format-local:'%m-%d %H:%M' --grep='^#1828 '`: #1828 shipped at 00:30 on Nov 25, 8.8 h after it was created at 15:44 on Nov 24. Both ran 2026-11-26.
[^c]: The same database, the sum over each ticket's sessions of `max(session_cost_usd)` in `turns`, run 2026-11-26. The figures were #1828 2.69, #1829 8.91, #1830 4.74, #1831 1.29, #1832 13.18, #2014 1.09, #2015 0.50, #2016 1.56, and #1812 12.03. This is the recorded turn cost only, so it may miss spend that wasn't recorded.
[^h]: read_minion(1832), run 2026-11-26 by a Grunt. The commit subjects confirm it: `git log main --grep='^#1832 '` shows "replaces 16 files' own scripts" and "6 onto fakeClaude".
[^f]: `git log main --format= --name-only --grep="^#$n "` for each minion, intersected by file, run 2026-11-26. #1828 and #1832 share 8 test files. `test/typecheck-baseline.json` is touched by #1828, #1831 and #1832.
[^l]: `grep -E "ticket/$n-" retro-log/2026-11-2{4,5,6}/land.md` in the shared folder, run 2026-11-26. It found 1 `land conflict` in the effort (#1828, `README.md`, onto f494ce069), and no conflict line has two effort branches.
[^s]: My guess. It is the sum of the before and after numbers each minion reported in its chat (read_minion), divided by the audit's 14 files at once. Each minion measured on a loaded box.
[^w]: `shared/project/reports/ci-land-test-seconds-2148.md`, "Result". The audit's ratio is in `reports/test-audit-citadel-2026-11-24.md`, "The numbers". Both were read 2026-11-26.
[^r]: read_minion(1828), run 2026-11-26 by a Grunt. The count is 4 failed lands before the 5th shipped. The `README.md` conflict also appears in land.md[^l].
