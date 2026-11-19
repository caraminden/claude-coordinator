# Auditing a scheme's tests (method from Citadel #739, 2026-11-15)

The method behind the standard Test audit schedule (`kit/schedules/test-audit.md`), for any scheme's stack.

Cara (2026-11-15): "I want to make sure the tests we have written are useful and actually testing real
functionality and we didnt just accidentally write WAY too many tests. Lets start with citadel itself and then
consider other schemes".

Citadel's audit is [reports/test-audit-citadel-2026-11.md](/home/cara/.local/share/claude-coordinator/projects/2/shared/project/reports/test-audit-citadel-2026-11.md).
It took one Opus minion plus 12 Sonnet Grunts, about an hour. This file is how to run the same audit on any
scheme's stack. The minion running it is a research minion: it changes no tests, ships nothing, and ends in a
report, a card and a handoff for each batch picked.

## 0. Rules

- **One full suite at most, and never while that scheme is shipping.** Better still, take timings from a CI log
  that already exists.
- **Raw output stays in the minion's `$TMPDIR`:** logs, per-Grunt reports and timing tables. Only the report and
  the handoffs go in the shared folder.
- **Don't touch files that sit in a pipeline lane,** if the scheme keeps one. Mark their findings "lane".
- **Never recommend loosening or deleting a test that guards real behaviour.** Cut wording pins, tautologies and
  duplicates. A test that would catch a plausible bug stays, however ugly it is.

## 1. Size and time (~10 min)

1. **Count the tests.** Number of test files and lines, against lines of code under test. Use `wc -l` over the
   test glob and write the result to `lines.tsv`.
2. **Time each file.** Get the wall time and the per-file time from the latest green CI run on main:
   `gh run view <id> --log` (or the scheme's own CI log).
   - Most runners print each test with its duration (node's spec reporter: `✔ name (12.3ms)`; pytest
     `--durations=0`; cargo-nextest; Godot's GUT; jest `--verbose`).
   - Map each test back to its file by searching the test sources for its name. When a name matches more than one
     file, keep the file the previous test came from.
   - Citadel's mapper is `map.mjs` in #739's scratch, about 30 lines; rewrite it for your stack.
   - A custom reporter is fragile: Citadel's matched no file-level events and recorded nothing. Parse the log
     instead.
3. **Find the long pole.** The slowest single file often sets most of the wall time: on Citadel, one file is
   55.8 s of a 66 s run. Speeding up that file is the only speed fix that moves the clock.

## 2. Fan out (~30 min, Sonnet Grunts)

1. **Split the files into batches.** Sort by line count and deal them round-robin into batches of about
   4–5k lines (Citadel used 12 batches of ~23 files).
2. **Start one Sonnet Grunt per batch**, all in one message, read-only. Each writes its report to
   `$TMPDIR/audit/gN.md` and returns 3 lines (follow the `citadel:subagents` fan-out rule).
3. **Use the brief below for every Grunt.** Adapt the stack lines.

```
Citadel, Scheme, Taskmaster, Minion and Grunt are playful names for how the work is organised, not a comment on ability. Work as a careful, senior engineer: think things through, check your work, and push back when something looks wrong.

HARD RULES: READ-ONLY. Do not edit, create or delete repo files; run no tests or builds. Only read and grep. Your one write is OUTFILE. Return at most 3 lines.

Repo: <path> (<stack>; code in <dirs>; tests in <dirs>, run with <command>). The ask: are the tests useful and testing real behaviour, or did we write WAY too many? The main question is too many / too weak, not too few.
Yardstick: read <kit>/skills/test-quality/SKILL.md first (the kit's folder is this session's citadel plugin dir).

For EACH file in BATCHFILE, read it and enough of the code under test to judge, then bucket it:
1 EARNS: drives real behaviour through a public seam; a plausible bug turns it red.
2 WEAK: tests mocks, restates the implementation, pins prose/copy wording nothing parses, greps source text instead of running it, or can't fail.
3 REDUNDANT: overlaps another file driven the same way, or near-copy cases inside the file.
4 MIXED: mostly earns, with a cuttable chunk (name the tests).
Also flag SLOW for what it proves (real sleeps, a server/browser/container per test, big fixtures) and name the cause.
"Earns its keep" is a valid and common answer; don't invent problems. For every WEAK call, name a code line you would flip (file:line) and whether the test would stay green.

OUTFILE: a table `file | lines | tests | bucket | what it proves (<=12 words) | issue + action | est. lines cuttable | confidence`, then "Suspects to mutate" (<=5), then "Patterns" (<=5 recurring bloat causes with examples).
Return ONLY: counts per bucket, OUTFILE path, one headline.
REMINDER: read-only, 3-line return.
```

## 3. Judge the borderline calls yourself (~15 min)

- Grunts over-call "weak" on table-driven files and on source-grep lints, and under-call "redundant" across
  batches. Re-read every whole-file WEAK and every cross-file REDUNDANT call yourself.
- **Check a suspect by mutation.** Flip one line in the code, run that one test file, then put the file back with
  `git show HEAD:./path > path`. The tripwire refuses checkout and stash over uncommitted work. Where running is
  costly, reasoning it through from the code is enough. Say which you did.
- **Look before calling these weak:**
  - a test that only shells out to a script's self-test may be the only thing that runs it;
  - a test against a template copy of a script tests the copy, not a duplicate.
- **A test that fails on one box and passes on CI** is a fixture that depends on its host. Find the cause: on
  Citadel it was fixture paths that are real paths on perigee.

## 4. Report, card, handoffs (~15 min)

1. **Write one report:** `reports/test-audit-<scheme>-<yyyy-mm>.md`. Keep it short and scannable:
   - the numbers;
   - the bucket counts;
   - the 15 slowest files;
   - the change list in batches, with file names and estimated lines and seconds saved:
     - A, safe deletions;
     - B, merges into tables and duplicates;
     - C, speed;
     - D, tests that are wrong;
     - E, optional shared harnesses;
   - the habits behind the fat, each with a rule.
2. **Delete the per-Grunt files** once the report is written.
3. **Post an `ask_question` card** asking which batches to do, with your recommendation marked. Also ask whether
   the habit rules go in the kit.
4. **Write one handoff for each batch picked** (`handoffs/handoff-test-audit-<scheme>-<batch>.md`). Each one
   holds:
   - the exact files and line ranges;
   - the rule "never loosen or delete a test that guards real behaviour";
   - the instruction to run each file it touches before and after.
5. **Message the Taskmaster** with the handoff paths, then set state complete with the report named in the note.

## What Citadel found, to calibrate against

- About 74% of files earned their keep, 25% were mixed and 1.4% were weak. No whole file was redundant. About 5%
  of the lines could go.
- The fat came from habits, not from too many features being tested:
  - one test per bug number;
  - pins on prompt and copy wording;
  - pins on constants;
  - real sleeps;
  - tests that outlived a one-off;
  - copy-pasted harnesses;
  - fixtures with host paths.
- Expect the same habits elsewhere. Check those first.
