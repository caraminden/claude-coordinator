# Effort retro: ship CI on GitHub, the chain from #2207 (Nov 27, 2026)

The server started this effort retro (#2254) once the chain's four minions had closed. They ran from #2207 at 00:08 PST
to #2231 at 13:42 PST, Nov 27[^times]. Times are Pacific. #2198 timed the suite on GitHub's free runners and wrote the
handoffs; Cara's pick on its card started the chain: "I think that github should actually be the main CI? with my
desktop as the fallback".

| | |
|---|---|
| Minions | #2207 (three files fail only on GitHub, Sonnet medium), #2209 (ship CI on GitHub with desktop fallback), #2210 (full suite on GitHub while a ship waits for its go), #2231 (CI page for GitHub ship CI), the last three Opus high[^times] |
| Cost | $51.09 in all: $0.62, $19.77, $12.58, $18.12[^cost] |
| Commits on main | 26: 3, 9, 4, 10[^commits] |
| Ship attempts | 5: 4 shipped, 1 refused at CI (#2210)[^line] |
| GitHub CI time per ship | 201 to 302 s (20 shards)[^line] |
| Rebase conflicts at ship | 0[^conf] |

## Fixes

1. **Moving ship CI left its readers behind, and #2209's named leftovers went to no one.**
   - #2209 shipped at 09:36 PST with two items in its risk reason: the restart of the elapsed clock at a desktop
     fallback, and "`ci-hold`/`ci_busy` still counting a GitHub ship run as the desktop's"[^lessons].
   - Its ship lesson adds that the hold cancelled its own probe runs on GitHub's runners while ships were in line, so
     the first probe finished only at the hold's 2 h cap, about 2.5 h lost[^lessons].
   - The CI page still drew the desktop-era view. It was put right only after Cara asked "should the CI page have
     useful info on it?", which became #2231 ($18.12)[^cost]. #2231 changed no line of `src/ci-hold.ts`[^hold].
   - #2198's split covered where the tests run (#2209) and when (#2210), but none of the briefs owned what reads the
     old place. Last retro's fix 2 found the same thing for cloud sessions (no off switch, no route for questions).
     That makes two retros: a new ledger row.
   - **Fix (shipped here):** `.claude/rules/turn-places.md` now also loads on `src/ci-runner.ts`, `src/ci-hold.ts`,
     `tools/land/ci.sh` and `.github/workflows/tests.yml`. It adds a fourth item: list every reader of where the work
     ran, update it or put it in Done when, and turn a reader left as it is into a handoff, not only a risk-reason line.
   - **Fix (handoff, this repo):** `shared/project/handoffs/handoff-ci-hold-after-github-ship-ci.md`. It narrows the
     hold to runs that share runners with ships, and stops desktop busy counts taking GitHub ship runs.
2. **The narrow test pick missed two pinning tests that only CI caught (ledger repeat).**
   - #2210's first ship was refused at CI at 11:51 PST. A `server.ts` change printed a watch error on a fresh checkout,
     and `test/exit-with-parent.test.ts` pins a booted server's stderr. It shipped 8 minutes later[^line][^2210].
   - #2209's step-order bug was caught only by the real GitHub run. `test/ci-leftovers.test.ts` reads `tests.yml` but
     was on no map row[^lessons].
   - **Fix (shipped here):** `tools/affected-map.txt` maps `server.ts` to `exit-with-parent` and `tests.yml` to
     `ci-leftovers`, and puts both on `@pinned`, so the narrow pick runs them (25 s and 7 s[^speed]).
3. **A handoff's diagnosis was stated as fact (ledger repeat, cheap this time).**
   - #2198's handoff put report-drain's failure down to waits that were too tight. #2207 found the real cause: GitHub's
     image ships uutils `dd`, which waits on a full pipe instead of failing[^lessons].
   - #2207 checked before fixing and cost $0.62, so the guess cost nothing here. No new fix: the ledger row stands.

## Not fixed

- **The ship lessons queue:** all four lessons were untaken until this retro marked them[^lessons]. The weekly Ship
  lessons schedule reads them; no change.
- **#2231's `--danger` token:** the token doesn't exist (it's `--error`), so a red cell drew grey with no error. A
  check for undefined `var(--x)` was tried on `public/`: 45 names are used with no definition in those files, most
  of them `--citadel-*` defined elsewhere[^vars]. That's too noisy to ship from a retro. Keep an eye out.
- **#2231's critic rounds:** 4 rounds, and 2 failed on hue clashes no reviewer saw[^2231]. The critic did its job.

## Spec gaps

- #2210 chose Cara's newer line ("Run any minion that is waiting for a 'Ship it' through the full suite") over her
  earlier "Full suite at hand-off" pick, so low and medium ships get no pre-ship run. It said so in its chat, but there
  was no card[^2210]. It's a core-flow call (which ships get the run), so it's for Cara to judge.

## Keep

- **Chaining by `start_after`:** #2210 started only once #2209 had shipped, and reused #2209's workflow and ADR without
  redoing them. No rebase conflicts across 26 commits[^conf].
- **The cheap first slice:** #2207 on Sonnet medium ($0.62) cleared the GitHub-only reds before the Opus work.
- **GitHub's 20 shards:** ship CI in 3.4 to 5 min[^line], so #2210's refused ship cost 8 minutes, not an hour.

[^times]: `sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db "select number,model,effort,datetime(created_at/1000,'unixepoch','-8 hours'),datetime(closed_at/1000,'unixepoch','-8 hours') from tickets where project_id=2 and number in (2207,2209,2210,2231)"`, 2026-11-27.
[^cost]: `sqlite3 -readonly …coordinator.db "select t.number, round(sum(u.cost_usd),2) from tickets t join turns u on u.ticket_id=t.id where t.project_id=2 and t.number in (2207,2209,2210,2231) group by t.number"`, 2026-11-27.
[^commits]: `git log main --format=%h --grep="#N" | wc -l` for each N, 2026-11-27.
[^line]: `grep -E '2207|2209|2210|2231' shared/project/retro-log/2026-11-27/land.md`: five `timing` lines, `ci-run` in seconds; #2210 refused at 19:51:31Z, landed 19:59:59Z. Read 2026-11-27.
[^conf]: `grep conflict shared/project/retro-log/2026-11-27/land.md | grep -cE '2207|2209|2210|2231'` gives 0, 2026-11-27.
[^lessons]: `sqlite3 -readonly …coordinator.db "select number, lines from ship_lessons where project_id=2 and number in (2207,2209,2210,2231)"`, plus #2209's ship note read with read_minion, 2026-11-27.
[^hold]: `git log main --format=%h --grep='#2231' -- src/ci-hold.ts` is empty, 2026-11-27.
[^2210]: `git show --stat b924cdf67` (server.ts only, its message names exit-with-parent) and #2210's chat via read_minion, 2026-11-27.
[^speed]: `citadel-test test/exit-with-parent.test.ts` 25.2 s and `citadel-test test/ci-leftovers.test.ts` 7.3 s wall, 2026-11-27.
[^vars]: a scratch script over `public/*.{css,js,html}` and `public/ui/`, counting `var(--x)` with no `--x:` in those files, 2026-11-27.
[^2231]: #2231's chat via read_minion, 2026-11-27.
