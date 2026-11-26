# Effort retro: front-end type cleanup (Nov 25, 2026)

The server started this effort retro (#2117) once the effort's eight minions had closed. Times are Pacific.

The Taskmaster made the six typing rounds at 15:00 PST Nov 25, from Josh's pick of "Shared types, then all" on
#2010's cleanup card. #2084 and #2087 were added at 22:23 and 22:46[^t].

- #2021 put shared shapes in `public/types.d.ts` and typed `h()`. It was held until #2010 went live.
- Rounds 2 to 6 were held until #2021 went live at 22:05[^l]. All five then started at 22:06, side by side[^e]:
  - #2022: the chat.
  - #2023: settings and people.
  - #2024: CI, Releases and Status.
  - #2025: `public/ui/`.
  - #2026: the rest, plus `sw.js`.
- #2087 (round 4b) took the files the rounds missed.
- #2084 fixed a bug that #2021's screenshots found already on main. No typing change caused it[^r].

| Minion | Model | Hand-offs | Refused | Min in line | Turn min | Cost |
|---|---|---|---|---|---|---|
| #2021 Shared types + typed h() | Opus high | 1 | 0 | 27 | 50 | $9.31 |
| #2022 The chat | Opus high | 1 | 0 | 26 | 56 | $18.98 |
| #2023 Settings and people | Opus high | 1 | 0 | 7 | 28 | $11.24 |
| #2024 CI, Releases, Status | Opus high | 1 | 0 | 13 | 40 | $10.92 |
| #2025 Citadel UI | Opus high | 1 | 0 | 14 | 31 | $8.51 |
| #2026 The rest + sw.js | Opus high | 2 | 1 (`size-budget`) | 20 | 52 | $21.39 |
| #2084 Copy buttons over the composer | Sonnet medium | 1 | 0 | 8 | 11 | $0.96 |
| #2087 Round 4b | Sonnet medium | 1 | 0 | 7 | 34 | $4.77 |

All eight together:
- 9 hand-offs, 1 refused, 122 min in line, $86.08[^l][^t].
- The report that planned the split estimated $125–160 for the six rounds[^p].
- By the minions' own counts, front-end errors went from about 8,761 before #2021 to 389 after #2087[^r].

The effort's own cost was its seams, not its typing.

## Fixes

1. **Five rounds ran at once and each one added to the same `public/types.d.ts`, which had a size cap.**
   - Every round brief said: "If you need a shape another round also needs, add it to `public/types.d.ts`"[^e]. Five
     minions then appended to the end of one file at the same time.
   - What it cost:
     - #2022 conflicted on `public/types.d.ts` at 22:57[^c]. It then had to widen its helper types for 8 new errors
       where #2024's pages called them[^r].
     - #2026's ship was refused at 23:27 by `size-budget`, after 20 min in line. Each branch was under the cap on its
       own; `types.d.ts` went 11 lines over only once #2022's ship and its own were combined[^l][^r]. Its rebase then
       raised 31 errors across 13 files from the other rounds' widened types. It had predicted 17[^r].
     - `size-budget`'s allowance for the file was raised three times in one evening, by #2022, #2026 and #2087[^s].
     - #2022 and #2024 each defined their own Codex and Claude usage window types, so the same types exist twice[^r].
   - The size-budget row has said "split by area once they finish (#2022)" since that evening[^s]. Nobody owns the
     split, and the file is 1,828 lines[^w].
   - **Fix (handoff):** split `public/types.d.ts` into one file per area, then merge the duplicated usage types.
     `shared/project/handoffs/handoff-types-d-ts-by-area.md`.
   - **For the next parallel sweep:** a brief that sends several minions into one shared file at once should name each
     one's own file or section. That's a note for whoever writes the briefs, and it is in the kit handoff below.
2. **The file split was made by name patterns, so files fell between the rounds.**
   - The report split the rounds by name patterns, such as "ci*, releases*, status, jobs, workers…"[^p].
   - Seven helpers of the Status page matched none of the patterns: `work-flow`, `flowmath`, `day-strips`,
     `box-capacity`, `worker-line`, `worker-linemath` and `codemath`. They held 486 errors[^r].
   - About 15 more files (`time-log*`, `ultrareview`, `payer`, `presence`, `prompt-cost` and the usage files) bounced
     between #2022, #2026 and the Taskmaster. Then they went to #2087, a ninth minion made mid-effort[^r].
   - #2026 also re-typed the time-log files before they were handed back to #2087, and dropped three files #2022 had
     already typed[^r].
   - The baseline already lists every file. A split that assigns each listed file to exactly one round, with the rest
     named as a leftover round, would have caught all of this at brief time.
   - **Fix (kit handoff):** `citadel:briefing` gets a line for split sweeps: build the list from the tool's per-file
     output, and leave no file unowned. `shared/project/handoffs/handoff-citadel-front-end-type-cleanup.md`, item 1.
3. **Six critic rounds failed on typing-only ships, and none of the failures came from the typing.**
   - The UI screenshots critic failed round 1 for #2022, #2023, #2024 and #2025, and rounds 1 and 2 for #2026[^v].
   - What failed them, per the minions:
     - #2022's shots were taken after a click had dismissed the minion.
     - #2024's shots were taken signed out.
     - #2025's composer was empty in the shots.
     - #2023 and #2026 failed on things already on main: a sidebar "null", a clipped title and stray Copy buttons[^r].
   - The changes were JSDoc only, with no change in behaviour. But a JSDoc cast, `/** @type {X} */ (el)`, sits on a
     code line. So `commentOnlyFiles` in `src/critic-gate.ts`, which reads line by line, counts it as code and asks for
     a critic[^g].
   - This is the second retro to find the critic gate running on changes with nothing to show
     (`2026-11-10-24.md`, fix 3). It is now a ledger row.
   - **Fix (handoff, a gate change for people to decide):** add a JS case to the open types-only handoff. A
     `public/**/*.js` file whose tokens match base once comments and parentheses are dropped asks for no critic.
     `shared/project/handoffs/handoff-types-only-risk.md`, "Also: the critic gate".
4. **Every round brief pointed at a handoff file that isn't there.**
   - All five round briefs (#2022 to #2026) said to read `handoffs/typecheck-burn-down-citadel-2.md`[^e]. That file is
     in neither `handoffs/` nor `handoffs/shipped/`[^f].
   - #2026 noticed and read `-3` instead. I don't know whether the other four found the rules some other way.
   - **Fix (Citadel handoff):** `create_ticket` warns when a brief names a shared-folder path that doesn't exist.
     Same handoff, item 2.
5. **Shared counts files (a ledger repeat).** `test/typecheck-baseline.json` was in all three of the effort's land
   conflicts: #2024 at 22:43, #2022 at 22:57 (with `types.d.ts`) and #2026 at 23:20[^c].
   - That is the third retro on this row.
   - The fix is already proposed and waiting: `handoffs/handoff-type-baseline-regenerates.md`, from #2113. No new edit
     here; the ledger row gains this retro.
   - On the row's check, whether any always-test refused a ship after 21:18 PST Nov 25: one did. That was #2026's
     `size-budget` at 23:27, and its combined-row case (fix 1) is one the pre-line check can't see.

## Spec gaps

- None set how the core works. The report's split was a plan rather than a spec, and its gaps are fixes 1 and 2.

## What worked and should stay

- **Shared types first, held behind `start_after`.**
  - The five rounds started only once #2021 was live, so none of them typed against a moving base for `h()`[^e].
  - #2021 cut about 521 errors on its own. The report had guessed 1,000–1,500[^r].
- **Rounds handed off leftovers by name.**
  - #2024 named its 7 missed files and costed a round 4b.
  - The Taskmaster folded #2022's and #2026's leftovers into #2087, on Sonnet medium, for $4.77[^r][^t].
- **A bug found in passing went to its own small minion.** #2084 fixed it in one ship for $0.96, with a red test
  first[^t][^r].
- **#2023 left `settings-machines.js` alone** because Build 7 was changing it, and said why[^r].

[^t]: `host_check db`: `select t.number, t.model, t.effort, datetime(t.created_at/1000,'unixepoch','-8 hours'), (select round(sum(u.cost_usd),2) from turns u where u.ticket_id=t.id), (select round(sum(u.duration_ms)/60000.0) from turns u where u.ticket_id=t.id) from tickets t where project_id=2 and number in (2021,2022,2023,2024,2025,2026,2084,2087)`; costs sum to $86.08. Run 2026-11-26.
[^l]: `grep -h -E '· timing · ticket/(2021|2022|2023|2024|2025|2026|2084|2087)-' shared/project/retro-log/2026-11-2[567]/land.md`: hand-offs = timing lines (9), refused = lines ending `refused at guards` (1, #2026), line minutes = `line N` / 60 per branch (7,344 s in all = 122 min). #2026's refusal reason is the `guard · … · test/size-budget.test.ts` line at 07:27:16Z. Run 2026-11-26.
[^c]: `grep -h conflict shared/project/retro-log/2026-11-2[567]/land.md | grep -E 'ticket/(2021|2022|2023|2024|2025|2026|2084|2087)-'` → 3 lines (06:43:06Z #2024 baseline; 06:57:47Z #2022 `public/types.d.ts` + baseline; 07:20:34Z #2026 train prep, baseline). Run 2026-11-26.
[^e]: `host_check db`: the first event of #2021 to #2026 (the "brief is held until … is live" notes), their first `user_message` at 22:06 PST, and `select t.number, (e.data like '%typecheck-burn-down-citadel-2.md%'), (e.data like '%types.d.ts%') from tickets t join events e on e.ticket_id=t.id where … e.kind='user_message' and e.data like '%"brief":true%'` → 1 and 1 for each of #2022 to #2026. Run 2026-11-26.
[^p]: `shared/project/reports/2026-11-25-front-end-typecheck.md`, section "The cleanup, split into minions", which adds up to "$125–160".
[^s]: `git log main --since=2026-11-25 --format='%h %s' --grep='types.d.ts'`: e540eea1e (#2022, "types.d.ts allowed 1584 lines"), 9bb97abf6 (#2026, "size budget lets types.d.ts hold InboxItem") and 21f317aaa (#2087, "raise types.d.ts's size allowance"). The row's note is at `test/size-budget.test.ts` line 21. Run 2026-11-26.
[^w]: `wc -l public/types.d.ts` = 1828 at main 615a2625e, run 2026-11-26.
[^v]: `host_check db`: `select t.number, r.round, r.verdict, re.name from review_runs r join tickets t on t.id=r.ticket_id left join review_entries re on re.id=r.entry_id where t.project_id=2 and t.number in (…)` → 6 `fail` rows, all "UI screenshots". Run 2026-11-26.
[^g]: `src/critic-gate.ts` lines 42–80 (`isCommentLine`, `commentOnlyFiles`) at 615a2625e.
[^f]: `ls shared/project/handoffs shared/project/handoffs/shipped | grep burn` → only `-3` and `-4` (in `handoffs/shipped/`) and `qp-reliability-test-burn-in.md`. Run 2026-11-26.
[^r]: The minions' chats, read with `read_minion` by two Sonnet Grunts on 2026-11-26. Only each chat's tail came back, with no timestamps, so the earliest turns of #2022 (27 entries), #2023 (20) and #2026 (73) were not read. Quotes and counts are from what was read.
