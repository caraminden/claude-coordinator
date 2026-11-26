# Effort retro: Front-end review wave (Nov 24 to 25, 2026)

The server started this effort retro (#2068) once the effort's 25 minions had closed. Three read-only reviews (#1834 chat
and shell, #1835 pages outside the chat, #1836 app UI kit and kit scripts) ended in handoffs. Josh said Go on every one.
The Taskmaster started them in two waves:
- 11 fix minions, #1851 to #1862, created 16:33 to 16:47 PST Nov 24;
- 10 more, #1939 to #1948, created 02:10 to 02:13 PST Nov 25.

Plus #1922, created 00:06 PST Nov 25[^d]. The last closed at 09:26 PST Nov 25[^d].

Times are Pacific.

## What went wrong across the effort

1. **Three minions were cut from commits main then dropped.**
   - `main` fast-forwarded to #1828's 9855d17c9 at 16:44:37 PST Nov 24 and was reset to 0c461af63 seven minutes
     later, at 16:51:48[^r].
   - #1859, #1861 and #1862 were created inside or a minute either side of that window (16:43:42, 16:45:24 and
     16:47:09)[^d]. Each carried #1828's commits and rebuilt its branch by hand.
   - #1859 learnt of it from #1863's held mail, then warned the other two[^m].
   - Nothing tells a minion that main moved back under it.
   - **Fix:** handoff `shared/project/handoffs/handoff-citadel-front-end-wave-reset-base.md` (server code: not this
     retro's to ship). Which code reset main is not checked; a land rollback is a guess.
2. **The CI desktop's "Deploys first" held the effort's real-device checks for hours.**
   - #1941 (Android shell) waited about 6 h, 02:40 to 09:05 PST, for an empty ship line to run its emulator pass.
   - #1942 (desktop launcher) waited about 4 h for its Windows run.
   - #1948 (Windows rigs) never ran on Windows, so its fixes ship unproven there[^m].
   - The Taskmaster's card to Josh about #1941 went unanswered, and it settled the card itself once the pass ran[^m].
   - Since then, #1984 (13:15 PST Nov 25) tells the Taskmaster about a job held 2 h[^g]. But `capped()` in
     `src/ci-hold.ts` still lets only other schemes' jobs past their 4 h, so Citadel's own optional jobs have no longest
     wait.
   - **Fix:** handoff `handoff-citadel-front-end-wave-own-job-cap.md`. The cap is Josh's pick, since it bends his rule.
3. **The Sonnet-medium fix bundles shipped fixes with no proof.**
   - Of the 9 fix minions on Sonnet 5.5 medium, 8 shipped findings with no test, or with tests never run against main:
     #1852, #1853, #1858, #1860, #1861, #1922, #1946 and #1948[^m]. #1947 was the exception.
   - #1860 did 9 of its 13 fixes, with only HP14 tested.
   - #1948's tests only read source text.
   - The Grunts reported no such gap on the 13 Opus fix minions[^m]. The briefs asked for "each test failing on main
     first", or "where cheap" (#1853).
   - The model split came from the Taskmaster's table (known-shape work on Sonnet medium). Bundles of 9 to 14 findings
     were not known-shape.
   - **Fix:** handoff `handoff-citadel-front-end-wave-fix-proofs.md`. The ready note lists each finding with its proof,
     and the reviewer flags an unexplained "no test". It is kit work, not this retro's.
4. **Ships from parallel minions conflicted on the size list, until #1917 (ledger repeat).**
   - 23 rebase or train-prep conflict lines in the land log name an effort branch. 20 of them are on
     `test/size-budget.test.ts`, 3 on README's Layout table and 1 on the type-check baseline. One line (06:14Z) names
     both size-budget and README, so these add up to 24[^l].
   - The last size-budget one was at 01:04:44 PST Nov 25. That is before #1917's count rule reached main (7c44e64a2, fast-forwarded
     at 02:44:35 PST[^k]; the last retro dated it by its 02:13 conflict instead). None of the effort's branches had a
     size-budget conflict after it[^l].
   - Two more cases had the same root, a red blamed on the wrong minion:
     - #1851 and #1858 were burn-in red on size-budget 10 of 10, from two other ships' rows (#1904 set `src/runner.ts`
       to 5574, #1913 added a line). land.sh pinned it on them because they edit that test file[^m].
     - #1857's first ship went red in CI on `test/review-set-api.test.ts`, which reads `public/reviews.js` as text. No
       map rule picked it then (it was added since)[^m].
   - **No new edit:**
     - #1917 holds for the size list.
     - #2037 (not shipped when this ran) adds `test/pinned-tests.test.ts`, which fails when a test that reads a
       source file's text has no map row. So the smoke check's and CI's wide pick runs it. That is the general guard
       for #1857's case, and a second one here would duplicate it. `citadel-test`'s default narrow pick still skips
       such a test unless it is `@pinned` (#1928's choice, not changed here).
5. **Waves of simultaneous starts became waves of simultaneous ships.**
   - Wave 1's 11 starts at once on a box at load 178 to 287 killed several turns (#1836, #1851, #1852, and more by
     Josh's "Start 5 now, rest later" at about 23:17 PST)[^m]. #1868's start limit went live at 19:57 PST Nov 24[^l], so
     the next wave ran under it.
   - Wave 2's four hand-offs between 03:59 and 04:18 PST still waited 49 to 96 min in line each: lines of 2963, 4723,
     5556 and 5781 s for #1944, #1946, #1948 and #1947[^l]. They were behind trains that went red on other riders' tests.
   - No edit: Josh's start limit and the train work (#1910 and others) own the line. Whether a start limit should space
     out 10 starts made in 2.5 minutes is a question for whoever tunes #1868, not a finding with a fix here.

## Spec gaps

- **#1942's brief:** it said "PCs get the launcher with its own release". The code and the `desktop-app` skill say going
  live offers it. The minion flagged it and mailed the Taskmaster[^m]. It is a brief error, not a core shape.
- **#1939's brief:** it sketched an attribute on the form, but Peek replaces the form, so the minion used an event
  (`citadel-before-reload`) instead[^m]. It is the minion's own call, and it holds.
- Neither sets how the core works.

## Did the last retro's fixes hold

- **Effort follows moved asks** (`handoff-citadel-effort-follows-moved-asks.md`): no ask moved out of this effort, so
  there was nothing to test.
- **Source-tree guards on the always list** (#2065): shipped after this effort, so there was nothing to test.
- **Size-list conflicts (#1917):** held. See finding 4.

## Keep

- **Checked findings before handoffs.**
  - The three reviews ran finding-checkers before writing handoffs: 32, 48 and 46 findings, none refuted. Some suggested
    fixes were narrowed[^m].
  - No fix minion found a finding that wasn't real.
- **Handoffs named their neighbours.**
  - Every handoff named the sibling minions that shared a file, and the Taskmaster's "what the handoff can't know" lines
    caught real overlaps: HK12 already shipped by #1867, G8 part-shipped, #1940 held until #1862[^m].
  - No work was done twice across the 25.
- **Ordering by shared file:** #1854 waited for #1851 (`public/core.js`), and #1861 waited for #1854. Neither met a
  conflict with the minion it waited for[^m].

[^d]: `host_check db`, run 2026-11-25 about 18:30 PST: `SELECT number, datetime(created_at/1000,'unixepoch'),
datetime(closed_at/1000,'unixepoch') FROM tickets WHERE project_id=2 AND number IN (1834, …, 1948)`, converted from UTC
by subtracting 8 h. The last close is #1941 at 17:26:51Z.
[^r]: `git reflog show main --date=iso` in this worktree, run 2026-11-25: entries 9855d17c9 (16:44:37 -0800, merge) and
0c461af63 (16:51:48 -0800, reset).
[^l]: `shared/project/retro-log/2026-11-2[456]/land.md`, run 2026-11-25. Conflicts: `grep -hE '· (train prep conflict|land conflict) ·'`
filtered to the effort's branch names, 23 lines, of which 20 name `size-budget`, 3 README and 1 `typecheck-bas`. The
last size-budget line is 09:04:44Z (a land conflict; 09:00:59Z is the same branch's train prep). Line waits: the `· timing ·` lines ending `landed`. #1868's
`ship train shipped` line is at 03:57:39Z.
[^m]: `read_minion` on each of the 25 (last 50 entries), read by five Sonnet Grunts on 2026-11-25. Counts are from
their reports and were not re-checked one by one. The model per minion is from `tickets.model` in [^d]'s query.
[^g]: `git log main --format='%h %ci %s' -- src/ci-hold.ts`, run 2026-11-25: 89d75ad22 (13:15:41 -0800) "#1984: a job
held 2 hours is told to its scheme's Taskmaster". `capped()` and `OTHERS_CAP_MS` are at `src/ci-hold.ts` lines 43 and 455
to 457.
[^k]: `git reflog show main --date=iso | grep 7c44e64a2`, run 2026-11-25: 02:44:35 -0800, fast-forward (its commit
date is 02:37:57).
