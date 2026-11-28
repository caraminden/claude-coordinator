# Effort retro: Worker pool across machines (Nov 25–27, 2026)

The server started this effort retro (#2253) once all 56 of the effort's minions had closed. They ran from #1926 at
00:56 PST Nov 25 to #2232 at 13:19 PST Nov 27. Times are Pacific.

Two major builds carry most of it, and each has its own retro: Build 7 (`build-7-worker-machines.md`, #1935 and 19
feeders) and Build 10 (`cabal-build-10-one-kind-of-machine.md`, #2180's cabal). This retro doesn't repeat what they
found. It asks what went wrong *across* them: three designs of what a machine is, and the cloud-session line that went
around them.

| | |
|---|---|
| Minions | 56. 4 were designs (#1926, #2029, #2060, #2177), and 10 were cloud sessions (#2147 to #2232)[^cost] |
| Cost | $841.77 in all. Build 7's minion alone was $153.69[^cost] |
| Ship attempts | 137 timing lines: 82 merged into a build branch, 23 shipped to main, 32 refused[^line] |
| Time in the ship line | 1,257 minutes across those 137[^line] |
| Rebase conflicts at ship | 9 lines naming the effort's branches; `src/runner.ts` in 4 of them[^conf] |

## Fixes

1. **What a machine is got designed three times in two days, and the second build undid much of the first.**
   - **#1926 (00:56 Nov 25):** made a CI PC its own kind of row, a "runner host". #1932, #1933 and #1934 built that from
     its handoffs[^from].
   - **#2029 (15:11 Nov 25):** moved to one row per PC with a card per role. Josh made the picks. For the rows
     already saved, it decided by itself to "migrate the old lend rows into roles with no behaviour change;
     perigee-godot, the test box VM and the Android emulator stay as they are"[^spec].
     - Most of those rows were Cara's: the test box with no owner, and her desktop's two CI runner host rows.
     - She wasn't asked about them.
   - **Build 7:** #2052 (M1), #2054 (M3) and #2088 ("one row per PC, the CI runner joins the machine row") built that
     design. They cost $45.58[^cost].
   - **The first time Cara used it, about 21:20 Nov 26:** none of her machines could do what she wanted. "why are there
     3 kinds of machines and none of the ones I am using can do what I want? (worker pool)", and then "There should be
     no "Kinds" of machines"[^2177].
   - **#2177 and Build 10:** #2177 designed it again. Build 10 then gave every machine an owner, rebuilt the page as
     take B, made runner host rows into ordinary PC rows (#2202) and removed #2088's "These are one computer" button.
     Build 10's minions, with #2194, cost $105.55, and #2177 cost $6.49[^cost].
   - **Why the guards didn't catch it:**
     - Under "Who decides in a scheme", Josh's picks were valid, and so were Cara's when she reversed them.
     - What failed was narrower. A design changed rows that belonged to a member who wasn't asked, and the design
       minion filled that gap with a "say if you want otherwise" pick of its own.
     - #2177's brief did the opposite: it asked for "a plan for every existing machine row" and walked Cara's real rows
       in the mock's first scene. Build 10 then changed no row without its owner's say.
   - **Fix (kit, handoff):** add a step to `kit/skills/grilling/SKILL.md`. A design that changes how saved rows work
     lists each live row and what it becomes, and asks each row's owner on a card with `to`. It's a skill edit at the
     step where the mistake is made: building the frontier.
     Handoff: `shared/project/handoffs/handoff-citadel-design-walks-live-rows.md`.
2. **Cloud sessions went live with no off switch and no way for their questions to reach anyone.**
   - #2153 shipped at 22:25 Nov 26[^land2153]. A cloud session's question then stranded on claude.ai, where Citadel
     couldn't read it.
   - #2191 ("questions are lost") started at 22:37, and #2193 (the off switch, built on Cara's "Lets turn off cloud
     sessions until we figure this out") at 22:45[^cost].
   - #2189 (cloud drafts, $14.49) was built and then closed when the switch went off. Cara: "is this idea DOA?", and
     she picked "Close: helpers replace it"[^cloud].
   - The cloud line went through three framings in about a day: a whole first turn (#2153), drafts (#2189), then
     helpers (#2200). Its 10 minions cost $119.32[^cost].
   - Machines had a Pause all from Build 7 M3. The new place had nothing like it.
   - **Fix (shipped here):** a new path-scoped rule, `.claude/rules/turn-places.md`. It loads when a session reads
     `src/turn-launch.ts`, `src/machine-turn.ts`, `src/worker-join.ts` or the `src/cloud-*` files. A new place where turns
     run ships with its off switch, a route for its questions, and a stated fate for work already running there.
3. **Briefs stated guesses as fact again (ledger repeat).**
   - #2153's handoff capped cloud jobs at 25 minutes. #2190 found that came from a misread default (background commands
     get 30 minutes, and up to 2 hours with a timeout), and #2200 moved the cap to 2 hours[^cloud].
   - #2214's brief said take B's card had no Update button. The minion found that wrong; a flag was the real bug.
   - #2177's own first count of ownerless rows was 3, not 4.
   - **No new fix:** each cost a round, not a rebuild. This retro is added to the row.

Not new here, and left to the build retros: the build claims (Build 7, fix 1), burn-in "racy" wording, and the stale
tests that only a full run caught. One cross-build slip: #2153 merged into `build/7` after Cara's go and had to be taken
back out (d83ec21e2, 15:17 Nov 26) to ship to main by itself.

## Spec gaps

- **Who owns a machine, and whose turns it runs** (sets how the core works): decided by #1926 (owner-only turns) and
  #2029 (no owner means shared). Then Cara's #2177 answers settled it: every machine has an owner, and turns stay
  owner-only. Settled now. **Cara and Josh, to judge:** nothing open.
- **Cloud sessions' place** (sets how the core works): decided by #2177 ("The machines page if for computers you are
  connecting to citadel"), then by #2200's helpers framing. Its audits are set for Nov 29 and Dec 4[^cloud].

## Keep

- **The T0–T6 chain** (#1937 to #2011) split cleanly. No link redid another's work. What cost them was rebases onto a
  moving Build 7.
- **Two designs on heavy jobs at once** (#2029's M6c and #2060) didn't duplicate:
  - `src/heavy-place.ts` (#2120) places CI jobs.
  - `src/heavy-builds.ts` (#2107) places jobs whose files come back.
  - Both rank by M6's `rank()`, and each file's header names the other.
- **Held mail between neighbours.** #2177 told #2107 to keep ownerless and runner host branches out, and told #2153
  that cloud stays off the Machines page. #2193 sent #2187, #2189 and #2191 its setting's name. Five minions edited the
  cloud files, and no ship was refused for it.
- **#2122's overlap check** (`kit/skills/briefing/SKILL.md` part 4) landed at 10:25 Nov 26, mid-effort. No pair of this
  effort's minions built the same thing after it.

[^cost]: `host_check` db, 2026-11-27: `SELECT t.number, SUM(u.cost_usd), MIN(t.created_at) FROM tickets t LEFT JOIN turns u ON u.ticket_id=t.id WHERE t.project_id=2 AND t.number IN (<the 56>) GROUP BY t.number`, created_at read as ms and shifted −8 h. Sums over number lists in python: all 56 = 841.77; Build 10's 10 (2180, 2182–2184, 2188, 2194, 2195, 2202, 2205, 2214) = 105.55; 2052+2054+2088 = 45.58; cloud's 10 (2147, 2153, 2154, 2187, 2189–2191, 2193, 2200, 2232) = 119.32.
[^line]: The shared folder's `retro-log/2026-11-2{5,6,7,8}/land.md`, lines `^- …Z · timing · ticket/(<the 56>)-`, counting the last field (landed, merged, refused) and summing `line N` seconds (75,404 s), run 2026-11-27.
[^conf]: The same land.md files, `land conflict` lines naming the effort's branches, file paths counted, run 2026-11-27.
[^from]: `read_minion` #1933, 2026-11-27: "from #1926".
[^spec]: The shared folder's `specs/machine-connections.md`, Decisions log ("Picked by #2029, say if you want otherwise").
[^2177]: `read_minion` #2177, 2026-11-27: its brief quotes Cara, and her answers to Q1–Q3.
[^land2153]: `retro-log/2026-11-27/land.md`: `06:25:51Z · timing · ticket/2153-… · landed`.
[^cloud]: A Sonnet Grunt's read of #2147–#2232 with `read_minion`, 2026-11-27; quotes as it returned them.
