#!/usr/bin/env bash
# Land a minion's branch on main: run it from the minion's worktree once its work is committed.
#   tools/land.sh
# Don't edit this file in a scheme: it is the Citadel kit's (kit/skills/scheme-setup/templates/land.sh), copied
# byte for byte, so a kit fix reaches a scheme as one copy. The scheme's settings and hooks go in tools/land.local.sh
# next to it (the kit's land.local.sh shows each one), which this sources; a setting the core gains gets a default here.
# This is the route CLAUDE.md names under "Project facts", "How a change ships". One landing at a
# time, under a lock in the scheme repo's .git, in the order they asked: it says its place in line
# and waits as long as the line moves, so run it in the background with a long timeout (a run that
# is stopped loses its place).
#   tools/land.sh --check   only says whether the rebase onto main would conflict (exit 3, naming the files), changing
#       nothing; Citadel's hand_off_land runs it first. While others are ahead in line, each move of main is checked
#       the same way, and a conflict leaves the line at once.
#   tools/land.sh --verify  the full check and CI on HEAD, a commit already on main, out of line and without the land
#       lock: Citadel's fast mode runs it behind the lands. It prints "verify: green", or "verify: failing <id>" for
#       each failure land_failures finds (below) and "verify: red"; exit 0 green, 1 red, 75 CI gave no verdict.
#       With LAND_VERIFY_IDS (ids, a line each: fast mode's culprit search), only what those need runs: CI only for a
#       ci: id, and with CHECK_FILE_CMD set, only their test files in place of the whole CHECK.
# Build branches: a major build is a branch build/<n>, checked out nowhere, that feeders merge into and that ships
#    to $BRANCH whole. Ported from Citadel's own land.sh. Once this script takes --into, Citadel's prompts tell the
#    Taskmaster when to suggest a build and each feeder and build minion its steps (the scheme's Builds setting).
#   tools/land.sh --into build/<n> [<test files>]   a feeder merges into it: rebases onto build/<n> (no rebase when it
#       is already under the branch), runs the named test files through CHECK_FILE_CMD (with none named, or no
#       CHECK_FILE_CMD: CHECK_LIGHT, else CHECK), and moves build/<n> by compare-and-swap. No CI, no line, no push:
#       it waits only for other runs on the same build (a lock per build). A merge of light paths alone (build-claims.md,
#       and what the LANES map marks light) that names no test files runs no check (#1684).
#   tools/land.sh --into build/<n> --full           the build minion's merge of $BRANCH: build/<n> must already be
#       under its branch (it ran git merge build/<n>; no rebase, which would flatten the build's merges), then the
#       full CHECK and CI on land/<branch>, as --verify runs them, with the BUILD_WORKFLOWS the build needs, then the
#       same compare-and-swap. Out of the line.
#   tools/land.sh --build                            ships the build its branch is at the tip of, through the line:
#       $BRANCH comes in by merge (not rebase), then the check, CI, the fast-forward and the push as for any land,
#       then build/<n> is deleted, here and on origin. Only as the head of the line, never stacked, never in fast mode.
#   A plain land refuses a branch that carries commits of a build/* that $BRANCH doesn't have: half a build would go live.
#   Claims (#1159): with a build-claims.md on build/<n>, --into first checks the feeder's files against it (claims_check).
#   While the build minion's merge of a changed build-claims.md is in flight, a feeder's --into waits for it to end and
#   is checked against the new claims, and its --check (the hand-off) passes, rather than both refusing (claims_gate).
#   Lock order: a build's lock (fd 6) before the land lock (fd 9); --into and --full take only the build's.
# Fast mode (#1017): with LAND_FAST=1 (Citadel sets it for a low or medium risk land in a scheme whose Settings turn
#    fast mode on), a branch that changes none of tools/land.sh, tools/land.local.sh, the LANES map, .github/* or the
#    scheme's FAST_FULL patterns lands on the smoke check alone: no check, no CI. The full suite runs behind it on main.
# Known reds: LAND_KNOWN_RED (from Citadel in fast mode) lists what already fails on main, a line "<id><TAB><who is
#    fixing it>" each ("#41 is fixing it"). A smoke, check or CI red whose failures (land_failures) are all known reds
#    doesn't refuse; a file's id stands for every test in it. A check that timed out, or a CI workflow still running,
#    is never waived. With no SMOKE_CMD (or LAND_SMOKE=0) fast mode is off: a land with no check at all takes the gate.
# 0. The smoke check, before it gets in line, so what fails in seconds never holds the line: whether the rebase onto
#    main would conflict (git merge-tree), commit titles, then SMOKE_CMD, the scheme's quick check, if it sets one, then (EARLY_CHECK)
#    CHECK_LIGHT on the branch rebased onto main, so a red light check is refused before the line too. A fail says
#    "smoke: …" and exits 1. LAND_SMOKE=0 skips it.
# 1. Rebases the branch onto the local main. A conflict stops here, unless MERGES has a rule for the file (ship-time
#    merges). Then land.local.sh's land_rebased, if it has one (just before step 3's check): a commit it makes ships
#    with the branch.
# 2. Refuses when the branch takes a number main already has (a migration, a version, a ledger id),
#    as the "Numbered things" line in Project facts names them. No line, or "none": no check.
#    And refuses a branch that removes what a recent landing added without naming it, such as a squash
#    onto a newer main that keeps the branch's old files (undo_guard below; a message line "Undoes: <sha>"
#    lets a meant undo through).
# 3. Runs land.local.sh's land_preflight and GUARD_CMD, if it sets them, then the check command on the rebased
#    commit, within LAND_CHECK_TIMEOUT whole seconds (default 1800). A failure or overrun stops here; a red that
#    land_flaky calls flakes only runs once more. With lanes (LANES below), the check of the commit's lane. When that is
#    CHECK_LIGHT and main hasn't moved since step 0's early check passed it, the commit it passed is taken as it is.
# 4. With the CI gate on (below): pushes the commit to the scratch branch land/<branch> on origin and
#    waits for CI to pass exactly that commit (with lanes, land/<lane>/<branch>, or no push for a lane with no CI). Red stops here
#    (a red land_flaky calls flakes only gets one fresh run); no answer parks, or land_fallback decides. On the way out the scratch branch is
#    deleted and its unfinished runs cancelled, except those of a commit that landed: they finish, so
#    main's CI can reuse what they pass. With batches (CI_BATCH over 1, "Batches" below) only the
#    last of a batch pushes, and its run covers the commits of the ones ahead of it in the batch.
# 5. Fast-forwards main in the scheme's main checkout to the commit; with batches, the head of the
#    line moves it to the deepest commit of its batch CI passed, which lands every member up to there.
#    Main only ever moves to a commit CI passed. Then land.local.sh's land_deploy, if it has one, once for that commit:
#    if it fails, main goes back and nothing (none of the batch) ships.
# 6. Pushes main to origin from the main checkout, never forced (not with PUSH_MAIN=0). A failed push is
#    reported and main stays moved; the next landing pushes it again.
# 7. Once main is pushed and the lock and the place in line are free: runs land.local.sh's land_after, if it
#    has one, for each branch that landed. Its failures are warnings, never a failed landing.
# Until step 5 main is untouched. The branch itself only moves when it lands, or to the rebased
# commit when the check or CI was red on top of main (so the fix starts from there); anything else
# leaves it where it was. While this runs, the worktree sits on a detached commit: don't work in it.
# Exit: 0 landed; 1 refused (a conflict, a clash, a red check, red CI) or main moved but its push
# failed; 75 CI gave no verdict (no runner took the run, it ran too long, or it was lost twice; or,
# for LAND_CI_DOWN seconds after a landing waited out one of those limits, no runner has taken this one's yet):
# nothing is wrong with the branch and nothing landed, so park and run this again once a person says
# the runners are back.
# Its last line, however a landing ends once under way (not --check, --lane, --verify, --into or --full, nor a refusal of
# how it was run, before the smoke check: uncommitted changes, the wrong branch, a bad setting), is the one Citadel reads:
#   ship: <landed|refused> <commit> batch <n> of <m> deploy <state|none>
# <commit>: its own commit, 12 hex digits (the rebased one once it has one); batch: its place in the batch that
# shipped together (1 of 1 alone; refused: the batch it was last in); deploy: none (no land_deploy hook), back (it
# failed and main went back), else the state its hook printed (live, restart; "done" when it printed none).
# Exit 75 says refused too: the exit code tells a park apart. And a timing line goes to the retro log (TIMING_LOG).
set -euo pipefail

# The check command, exactly as Project facts names it under "Check commands" ('true' while it has none).
# With the CI gate on it is what runs here before anything is pushed: keep it light.
CHECK='npm test'
# The smoke check (#1012): the scheme's quick check, run on the branch as it is, before it gets in line, so a land it
# refuses never waits in line or for CI. Seconds, not minutes: a parse or lint step, the tests a change anywhere can
# break. '' none (the conflict check still runs). Past SMOKE_TIMEOUT seconds it doesn't decide, and the land goes on.
SMOKE_CMD=''
SMOKE_TIMEOUT=${LAND_SMOKE_TIMEOUT:-300}
# The early check (#1177): 1 runs CHECK_LIGHT in the smoke check too, on the branch rebased onto main, so a branch it
# refuses never takes a place in line (Peek Auras, 15 to 19 November: 19 of 60 refused lands were a red light check
# after the rebase, refused only at the front). It runs for a branch whose lane's check is CHECK or CHECK_LIGHT
# (CHECK_LIGHT is taken as a part of CHECK), never with CHECK_LIGHT ''. When main hasn't moved by the time a light branch reaches the front,
# that checked commit lands as it is and the check doesn't run again; when it has, it runs again on the new main. 0
# off: worth it when main moves under most landings, which then pay the light check twice for each land that passes.
EARLY_CHECK=${LAND_EARLY_CHECK:-1}
# The scheme's main branch.
BRANCH=main
# The file whose Project facts may have a "Numbered things" line.
FACTS=CLAUDE.md

# The CI gate: off while both of these are empty.
# CI_WORKFLOWS: the workflow files that must all be green on the exact commit that lands, split by
#   spaces: 'windows.yml' or 'ci.yml android.yml'. Each needs "land/**" among its push branches:
#     on:
#       push:
#         branches: ['land/**']
#   with no pull_request or main trigger, which would only run the same check again (#603), and a
#   concurrency group per ref (group: <name>-${{ github.ref }}), or the stacked runs below
#   wait for each other. A run that succeeded with a job skipped is not green, and is refused rather than
#   run again (it would skip again): a workflow whose jobs are skipped on purpose needs CI_STATUS.
# CI_STATUS: only when "every workflow green" is not the scheme's rule (a workflow that blocks only
#   when red, one that runs only for some paths): the scheme's own command. It gets the commit as
#   its one argument (with lanes, the run's lane as a second) and answers by exit code: 0 green, 1 red, 2 running, 3 not started (no run yet,
#   or still queued), 4 ended without a verdict (cancelled, the runner lost, its jobs skipped);
#   anything else: no answer this time. What it prints is shown when CI is red. It must judge the
#   newest run on that commit. With a red (1), a line per other workflow that hasn't gone green lets a
#   known red (LAND_KNOWN_RED) wait for it rather than ship: "<workflow>: in_progress …" (or queued,
#   waiting, pending, requested, not started) for one still going, "<workflow>: no verdict …" for one that
#   ended without one.
CI_WORKFLOWS=''
CI_STATUS=''
# BUILD_WORKFLOWS: more workflow files a major build's --full run (below, "Build branches") must see green on its
#   commit besides the gate's, split by spaces: 'desktop.yml' always, 'desktop.yml:tools/desktop-paths' only when
#   the build changes (since it forked from $BRANCH) a path that repo file names: a bash case pattern a line (* also
#   matches /), '#' comments, and a line starting with ! rules a path out. The file is read from $BRANCH, else the
#   branch's own; on neither, the workflow runs. Each is judged by the built-in reader's rules above, CI_STATUS or not.
#   One with no run on the commit CI_GRACE after the push to land/<branch> is dispatched there once (it needs a
#   workflow_dispatch trigger), and once more if it ends without a verdict. '' none: --full waits for the gate alone.
BUILD_WORKFLOWS=''
# Lanes: off while LANES is empty, and then every landing is full, as above. LANES is the repo path of the scheme's
#   lane map (tools/lanes), always read from $BRANCH's copy, never the landing's, so a commit can't loosen its own
#   lane. A map line is "<lane> <pattern>...": a path takes the lane of the first line with a pattern that matches
#   it, and a path no line matches is full. Patterns are bash case patterns, where * also matches /; '#' starts a
#   comment. A lane is light, full, or a lower-case word naming a partial lane (fast, android, py); any other word
#   reads as full. The map itself, tools/land.sh, tools/land.local.sh and .github/* are full whatever it says.
#   A commit's lane is over what it changes since the commit it was rebased onto (main, or the commit of the one ahead
#   in the stack): every path light is light; light and one partial lane P is P; two partial lanes, a full or unlisted
#   path, no change at all, or a git failure is full. With batches a run takes the lane of its batch's whole range,
#   from the commit under its first member to the one pushed.
#   light: runs CHECK_LIGHT (none while it is empty), pushes nothing and starts no CI: it is green once checked, and
#     still lands only on top of main in its place in line (behind a running CI: right after that one lands).
#   a partial lane, fast: runs CHECK_FAST (CHECK while unset; '' none), pushes to land/fast/<branch> and waits for
#     CI_WORKFLOWS_FAST (CI_WORKFLOWS while unset; '' runs no CI, like light); a run may skip the jobs named in
#     CI_SKIPS_FAST, split by spaces. The setting names take the lane in upper case.
#   full: CHECK and CI_WORKFLOWS, pushed to land/full/<branch>.
#   A workflow picks its lanes by its push branches ('land/full/**', 'land/fast/**'), a job it skips on one by
#   `if: ${{ !startsWith(github.ref_name, 'land/fast/') }}`. tools/land.sh --lane [<commit>] [<base>] prints
#   "<lane> <the path that decided it>" for what <commit> (HEAD) changes since it forked from <base> ($BRANCH), by
#   $BRANCH's map, and exits.
LANES=''
CHECK_LIGHT=''
# How many landings at the front of the line run CI at once, each on top of the ones ahead of it
# (below, "The stack"). 1: only the head of the line. Runners that can't carry three runs at once: 2.
CI_STACK=${LAND_STACK_DEPTH:-3}
# How many landings share one CI run (below, "Batches"): the stack then counts batches, and only the last
# of each batch runs CI. 1: every landing runs its own, as above. A batch takes whoever is waiting and never waits
# to fill. On only with a CI gate; a landing that changes the pipeline (PIPELINE_FILES below) ships alone.
CI_BATCH=${LAND_BATCH:-4}
# How many fresh CI runs a red that land_flaky calls flakes only gets, one after another, the landing keeping its place in
# line; only a green run passes (ADR 0006). 1: one, as always. A scheme whose flakes may strike twice in a row: 3.
FLAKE_RUNS=${LAND_FLAKE_RUNS:-1}
# How many times a landing CI gave no answer about (no runner took it, the run ended without a verdict twice, past
# CI_LIMIT) asks again where it would park: a fresh run of the same commit, keeping its place in line, with CI's limits
# counted again. land_fallback, if there is one, still decides first each time, and sees how many it has had in
# LAND_PARK_RETRIED (so it can say red rather than "no verdict" the second time). 0: it parks, as always.
PARK_RETRIES=${LAND_PARK_RETRIES:-0}
# Conflict prep (below, "Conflict prep"): 1, a landing stacked on the one ahead whose rebase onto it stops says so in
# a "prep:" line, so its author can record the fix ahead of time with git rerere, which this script's rebases then
# replay. Needs CI_STACK 2 or more: only a stacked landing rebases onto the one ahead. 0: none.
CONFLICT_PREP=${LAND_PREP:-0}
# A file in the repo listing more of the pipeline's own files, besides tools/land.sh, tools/land.local.sh, .github/ and
# the lanes map: one path a line, '#' comments, a trailing / for a folder ('tools/deploy.sh', 'deploy/'). A landing
# that changes any of them never shares a batch (it ships alone) and keeps fast mode on the full gate.
PIPELINE_FILES=${LAND_PIPELINE_FILES:-}
# 0: main stays in the main checkout and is never pushed (a scheme whose origin isn't its own).
PUSH_MAIN=1
# Where each landing's timing line goes ("The timing line" below): <folder>/<UTC day>/land.md. The scheme's retro log
# (its shared folder's retro-log/, which Citadel names for every land it runs); '' or no shared folder: <.git>/land-log.
TIMING_LOG=${COORDINATOR_SHARED_DIR:+$COORDINATOR_SHARED_DIR/retro-log}
# Fast mode: the paths (bash case patterns, where * also matches /, split by spaces) that keep a land on the full gate
# besides the pipeline's own files: 'migrations/* src/auth/*'.
FAST_FULL=''
# Fast mode's culprit search: the check on one test file ({file}), as 'node --test {file}' or 'pytest {file}'. Set,
# a red over several lands reruns only the failing files on each commit; '' reruns the whole CHECK.
CHECK_FILE_CMD=''
# Guards: a quick command on each rebased commit, after land_rebased and before the check (Citadel's schema, budget and
# contract tests): exit 0 goes on, 2, a timeout (GUARD_TIMEOUT seconds) or a kill doesn't decide (it says so and goes
# on), anything else refuses as a red check does. Every batch member runs it; the light lane doesn't. '' none.
GUARD_CMD=''
GUARD_TIMEOUT=${LAND_GUARD_TIMEOUT:-120}
# Ship-time merges ("Ship-time merges" below): the files a rebase onto $BRANCH may merge by rule rather than stop on,
# a line "<path> <rule> [<regex>]" each ('#' comments). '' none: a clash in any file stops the rebase, as always.
MERGES=''
# The land lock and the line's folder: '' is <.git>/land.lock and <.git>/land-queue in the main checkout. Set them to
# share one line with another script that takes the same lock (Citadel's deploy queue). A relative path is from the
# main checkout.
LOCK_FILE=''
QUEUE_DIR=''

say() { echo "land: $*" >&2; }
refuse() { say "$*"; exit 1; }
park() { say "$*"; exit 75; }

# The scheme's own settings and hooks: every value above it sets wins. Plain shell, sourced here under set -e, so
# a command in it that fails (its last line too: a false `[ x ] && y`) stops the landing, loudly.
#   land_after <commit> <branch>  step 7: run once per branch that landed, after main was pushed, with the
#                                 lock and the place in line already free. The head of a batch runs it for each
#                                 member it landed, from its own worktree: only the arguments name the landing.
#                                 A failure (or an exit) in it is only warned about.
#   land_deploy <commit>          deploys main once it moved to <commit>, in the main checkout, before main is
#                                 pushed, holding the lock:
#                                 whoever moves main runs it once (alone, or as the head for its whole batch; the
#                                 members wait for its word). Its stdout's last line, one word, is the ship line's
#                                 deploy state (live, restart; else "done"). Failed (exit non-zero, or a command in
#                                 it failing: set -e holds): main goes back where it was, and the landing and every
#                                 member of its batch say it didn't ship. None: nothing deploys (deploy none).
#   land_rebased <base> <branch>  runs on the branch just rebased onto <base>, in its worktree, before its check, in
#                                 every plain landing (fast mode too, the early check, and --into's merge), not
#                                 --verify, --build or --full. A commit it makes ships with the branch (a generated
#                                 map rebuilt on today's main); a failure, or changes left uncommitted, refuses it.
#   land_failures                 reads a check's or CI's output on stdin and prints the ids of what failed, one a
#                                 line (known reds and fast mode's ledger match on them): "<file>::<test>" where
#                                 the output names the test, else "<file>". The one below reads node's test runner
#                                 (spec and TAP), pytest and jest (files only) output, and red workflows in CI's:
#                                 a line "<workflow>: completed failure" (or timed_out, or "completed, failure"), its id "ci:<workflow>".
#                                 A scheme on another runner (cargo test) defines its own in land.local.sh.
#   land_preflight <commit> <lane> runs on each rebased commit just before GUARD_CMD, in this worktree, not on the
#                                 light lane: non-zero refuses it as a red check does (Citadel's boot check while
#                                 its deploys are refusing).
#   land_flaky                    reads a red check's or CI's output on stdin; exit 0 says the red was flakes only
#                                 (what it prints says which). A red check then runs once more and passes only if
#                                 that run is green; a red CI run gets FLAKE_RUNS fresh runs (ADR 0006). None: red is red.
#   land_fallback <commit>        CI gave no answer about <commit> (no runner, no verdict, past CI_LIMIT): it decides
#                                 in CI's place, in this worktree, which sits on <commit>: exit 0 green, 75 no verdict
#                                 either (it parks, or asks CI again: PARK_RETRIES), else red; LAND_PARK_RETRIED says
#                                 how many times this landing asked again already. None: it parks, as always.
#   land_ci_more <commit> <keys>  CI on <commit> ran past CI_LIMIT: prints "<seconds> <key> <why>" to give it more time
#                                 (a run that is only queued behind a busy runner), else nothing. <keys> are the keys
#                                 it already gave this run, space-separated: each counts once, so a reason can't add
#                                 time twice. None, or nothing printed: CI_LIMIT holds.
#   land_main_red <main> <commit> reads failure ids (land_failures') that aren't known reds on stdin, and prints those it
#                                 finds red on <main> too ($BRANCH's tip): the check, the smoke check or CI on <commit>
#                                 then waives them as known reds. Asked once per pair of commits and ids, kept a day.
#                                 None: only LAND_KNOWN_RED waives.
#   land_recover <main's commit>  each pass of the line before this landing's work, in the main checkout: puts right
#                                 what a deploy that died half way left behind (Citadel's restart bookkeeping).
#                                 A failure refuses the landing; a person needs to look.
#   land_under <commit> <branch>  plain landings, at the early checks and again before each rebase: prints the newest
#                                 commit under <commit> (the branch) whose own commits came off $BRANCH (a deploy
#                                 rolled them back), so the rebase replays only the branch's commits above it. Nothing printed: the usual fork point (header at under_of).
#   land_suspect <main> <commit>...  batches only: CI is red on the last <commit>, a member of a batch whose members'
#                                 commits are the ones given, from the one on <main> up; reads the failure ids
#                                 (land_failures') on stdin and prints the commit of the member it guesses turned it
#                                 red (Citadel's: the one whose change touched the failing test or what it imports,
#                                 run alone on the members' commits to confirm). The red batch's bisect then runs CI
#                                 on the member just below it, then on it, before halving (header at suspect_of).
#                                 Nothing printed, a failure or a commit not given: the bisect halves as always.
#   land_merge <side> <base> <ours> <theirs> <path>  the "hook" rule of MERGES: merges the file, leaving the result in
#                                 <ours>; <side> names which of ours and theirs is $BRANCH's. Exit 0 clean, else
#                                 it stops the rebase as a clash does. With LAND_MERGE_DIFF3=1 (the path has append, sum
#                                 or count lines too) it leaves its clashes in <ours> as this script's diff3 markers and
#                                 those rules take them (the header at MERGES).
land_failures() {
  awk '
    function flush() { if (spec != "") print spec; spec = "" }
    /^test at [^ ]+:[0-9]+:[0-9]+/ { flush(); spec = $3; sub(/:[0-9]+:[0-9]+$/, "", spec); next }
    spec != "" && /^\342\234\226 / { n = $0; sub(/^\342\234\226 /, "", n); sub(/ \([0-9.]+m?s\)$/, "", n); print spec "::" n; spec = ""; next }
    { flush() }
    /^not ok / { tap = 1; n = $0; sub(/^not ok [0-9]+ - /, "", n); sub(/ # (SKIP|TODO).*$/, "", n); next }
    tap && /^ *location: / { p = $2; gsub(/\047/, "", p); sub(/:[0-9]+:[0-9]+$/, "", p); print p "::" n; tap = 0; next }
    /^(ok|# Subtest)/ { tap = 0 }
    /^FAILED [^ ]+::/ { print $2; next }
    /^FAIL [^ ]+/ { print $2; next }
    /^[[:space:]]*[^:[:space:]][^:]*: completed,? (failure|timed_out)/ { p = $0; sub(/^[[:space:]]+/, "", p); sub(/: completed.*$/, "", p); print "ci:" p }
    END { flush() }
  '
}
LOCAL=$(dirname "${BASH_SOURCE[0]}")/land.local.sh
if [ -f "$LOCAL" ]; then
  trap 'say "$LOCAL failed (exit $?), so nothing ran: a command in it, or its last line, came out false"' EXIT
  # shellcheck source=/dev/null
  . "$LOCAL"
  trap - EXIT
fi
[[ $PUSH_MAIN =~ ^[01]$ ]] || refuse "PUSH_MAIN is 1 (push main) or 0 (keep it local), not \"$PUSH_MAIN\""

# Ship-time merges (#1221): MERGES names files that two branches often both change in the same place, which a rebase
# onto $BRANCH may merge by rule where git alone would stop:
#   <path> append <regex>  lines both sides add at the same place, under the nearest line above with no indent, which
#                          matches <regex> (a list's opening line): $BRANCH's lines, then the branch's. The place had
#                          no lines of its own, and every line added there is indented (a list both append to).
#   <path> sum <regex>     lines both sides changed, as many on each side, each matching <regex> as it was: merged
#                          word by word. A number both raised becomes $BRANCH's plus the branch's raise (37_900 and
#                          37_800 over 37_500: 38_200), and words both add at the same place (a note each in a comment)
#                          keep $BRANCH's, then the branch's.
#   <path> count <regex>   as sum, for a list of sizes or counts: a number either side lowered adds up too (main 110 and
#                          the branch 95 over 100: 105). Two sides changing one #N differently is a clash.
#   <path> main            $BRANCH's copy: a file land_rebased makes again from the merged tree (a baseline).
#   <path> hook            land.local.sh's land_merge decides.
# A path may have several append, sum and count lines: each clash tries them in order. main takes the whole file, so it stands
# alone. hook may come with append, sum and count lines (Citadel's src/db.ts: renumbered by its hook, appended by rule): the
# hook runs first with LAND_MERGE_DIFF3=1 set, and where it can't merge cleanly it leaves this script's own clash
# markers in <ours> (git merge-file -p --diff3 --marker-size=31 -L main -L base -L branch: the side that is $BRANCH first) and
# exits non-zero; the path's other rules then take those clashes, as they would git's.
# Anything a rule isn't sure of stops the rebase, as a clash in any other file does. <path> is a repo path. git runs
# this script as the merge driver (tools/land.sh --merge <side> <base> <ours> <theirs> <path>; a copy made as the
# landing starts, since the rebase changes the worktree's own) for the rebase onto $BRANCH, the merge-tree of the smoke
# check and --check, --build's merge and --into's rebase, so every batch member's rebase takes it too.
# shortcut: a merged file always ends in a newline, upgrade if a scheme merges one that mustn't.
MARK_M=$(printf '<%.0s' {1..31})' main' MARK_O=$(printf '|%.0s' {1..31})' base' MARK_E=$(printf '=%.0s' {1..31})
MARK_B=$(printf '>%.0s' {1..31})' branch'
merge3() { git merge-file -p --diff3 --marker-size=31 -L main -L base -L branch "$@"; } # <main's> <base> <branch's>
# A diff3 merge on stdin, its clashes resolved by merge_hunk <rule> <regex>; fails on one it can't.
merge_hunks() { # <rule> <regex> [<rule> <regex>...], on a merge with conflicts on stdin
  local line part=out head=''
  local -a M O B
  while IFS= read -r line || [ -n "$line" ]; do
    case $part in
      out)
        if [ "$line" = "$MARK_M" ]; then part=m M=() O=() B=(); continue; fi
        printf '%s\n' "$line"
        [[ ! $line =~ ^[^[:space:]] ]] || head=$line ;;
      m) if [ "$line" = "$MARK_O" ]; then part=o; else M+=("$line"); fi ;;
      o) if [ "$line" = "$MARK_E" ]; then part=b; else O+=("$line"); fi ;;
      b) if [ "$line" = "$MARK_B" ]; then part=out; merge_rules "$@" || return 1; else B+=("$line"); fi ;;
    esac
  done
  [ "$part" = out ]
}
merge_rules() { # <rule> <regex> [<rule> <regex>...]: the first that takes the hunk
  local out
  while [ $# -ge 2 ]; do
    if out=$(merge_hunk "$1" "$2"); then printf '%s\n' "$out"; return 0; fi
    shift 2
  done
  return 1
}
merge_hunk() { # <rule> <regex>, on M (main's lines), O (base) and B (the branch's)
  local i l
  case $1 in
    append)
      [ ${#O[@]} = 0 ] && [[ $head =~ $2 ]] || return 1
      for l in "${M[@]}" "${B[@]}"; do [[ $l =~ ^[[:space:]] ]] || return 1; done
      # A key both added ('a.ts': twice) would let the last one win: a clash for a person.
      for l in "${M[@]}" "${B[@]}"; do [[ ! $l =~ ^[[:space:]]+([\'\"][^\'\"]+[\'\"]): ]] || echo "${BASH_REMATCH[1]}"; done | sort | uniq -d | grep -q . && return 1
      printf '%s\n' "${M[@]}" "${B[@]}" ;;
    sum | count)
      [ ${#O[@]} != 0 ] && [ ${#M[@]} = ${#O[@]} ] && [ ${#B[@]} = ${#O[@]} ] || return 1
      for ((i = 0; i < ${#O[@]}; i++)); do
        [[ ${O[i]} =~ $2 ]] && merge_words "${M[i]}" "${O[i]}" "${B[i]}" "$1" || return 1
      done ;;
    *) return 1 ;;
  esac
}
# <main's line> <base> <the branch's> <sum or count>: the line merged a word at a time (runs of digits and _, of letters, of spaces,
# or one other character), or fails. Each number is followed by its side's tag (@m, @o, @b), which never matches
# across sides: git would take a raise both made alike once, and the tag makes every number a clash summed here (one
# nobody changed sums to itself), while the number itself still lines the words up.
merge_words() {
  local d i rc=0 line part=out out='' m o b n w
  local -a M O B T=(m o b)
  d=$(mktemp -d) || return 1
  for i in 1 2 3; do
    grep -oE '[0-9][0-9_]*|[[:alpha:]]+|[[:space:]]+|.' <<<"${!i}" | sed -E "s/^[0-9].*/&\n@${T[i - 1]}/" >"$d/$i" || true
  done
  merge3 "$d/1" "$d/2" "$d/3" >"$d/out" || rc=$?
  [ "$rc" -lt 128 ] || { rm -rf "$d"; return 1; }
  while IFS= read -r line; do
    [[ $line != @[mob] ]] || continue # a tag: only ever beside its number
    case $part in
      out) if [ "$line" = "$MARK_M" ]; then part=m M=() O=() B=(); else out+=$line; fi ;;
      m) if [ "$line" = "$MARK_O" ]; then part=o; else M+=("$line"); fi ;;
      o) if [ "$line" = "$MARK_E" ]; then part=b; else O+=("$line"); fi ;;
      b)
        [ "$line" = "$MARK_B" ] || { B+=("$line"); continue; }
        part=out
        if [ ${#O[@]} = 0 ]; then
          for w in "${M[@]}" "${B[@]}"; do out+=$w; done
        elif [ ${#O[@]}${#M[@]}${#B[@]} = 111 ] && [[ $O$M$B =~ ^[0-9_]+$ ]] && [[ $O =~ ^[0-9] && $M =~ ^[0-9] && $B =~ ^[0-9] ]]; then
          m=$((10#${M//_/})) o=$((10#${O//_/})) b=$((10#${B//_/}))
          n=$((m + b - o))
          if [ "$4" = count ]; then
            [ "$n" -ge 0 ] && { [[ $out != *'#' ]] || [ "$m" = "$o" ] || [ "$b" = "$o" ]; } || { rm -rf "$d"; return 1; }
          else
            [ "$m" -ge "$o" ] && [ "$b" -ge "$o" ] || { rm -rf "$d"; return 1; }
          fi
          if [[ $M == *_* ]]; then
            local g=''
            while [ ${#n} -gt 3 ]; do g=_${n: -3}$g n=${n:0:${#n}-3}; done
            n=$n$g
          fi
          out+=$n
        else
          rm -rf "$d"; return 1
        fi ;;
    esac
  done <"$d/out"
  rm -rf "$d"
  [ "$part" = out ] && printf '%s\n' "$out"
}
# The driver itself: <side> (ours or theirs: which is $BRANCH's) <base> <ours> <theirs> <path>; the result goes in <ours>.
merge_driver() {
  local p rule re m o rc=0 out hook=''
  local -a rules=()
  while read -r p rule re; do
    [ -n "$p" ] && [[ $p != \#* ]] && [ "$p" = "$5" ] || continue
    case $rule in
      main) [ ${#rules[@]} = 0 ] && [ -z "$hook" ] || return 1; rules=(main); break ;; # the whole file: alone
      hook) [ -z "$hook" ] || return 1; hook=1 ;;
      append | sum | count) [ -n "$re" ] || return 1; rules+=("$rule" "$re") ;;
      *) return 1 ;;
    esac
  done <<<"$MERGES"
  if [ "$1" = theirs ]; then m=$4 o=$3; else m=$3 o=$4; fi
  if [ -n "$hook" ]; then
    declare -F land_merge >/dev/null || return 1
    [ ${#rules[@]} != 0 ] || { land_merge "$@"; return; }
    LAND_MERGE_DIFF3=1 land_merge "$@" && return 0
    grep -qxF "$MARK_M" "$3" && merge_hunks "${rules[@]}" <"$3" >"$3.land" && mv "$3.land" "$3" && return 0
    rm -f "$3.land"
    return 1
  fi
  case ${rules[0]:-} in
    '') return 1 ;;
    main) [ "$m" = "$3" ] || cp "$m" "$3" || return 1; return 0 ;;
  esac
  out=$(mktemp) || return 1
  merge3 "$m" "$2" "$o" >"$out" || rc=$?
  if [ "$rc" -lt 128 ] && { [ "$rc" = 0 ] || { merge_hunks "${rules[@]}" <"$out" >"$out.2" && mv "$out.2" "$out"; }; }; then
    cat "$out" >"$3" && rm -f "$out" && return 0
  fi
  rm -f "$out" "$out.2"
  return 1
}
if [ "${1:-}" = --merge ]; then
  [ $# = 6 ] || exit 2
  shift
  # trial()'s merge-tree runs in a scratch folder (attrs_of): its files made whole, the hook runs from the repo's top and
  # finds the repo as it does in the rebase.
  if [ -n "${LAND_TOP:-}" ]; then
    for p in 2 3 4; do [[ ${!p} == /* ]] || set -- "${@:1:p-1}" "$PWD/${!p}" "${@:p+1}"; done
    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
    cd "$LAND_TOP" || exit 1
  fi
  if merge_driver "$@"; then exit 0; else exit 1; fi
fi
# land_git <side> <git args>: git with the driver on (side as above). The worktree's own land.sh and land.local.sh
# change under a rebase, so git runs a copy of both as they were when this landing started.
merge_dir=''
if [ -n "$MERGES" ]; then
  merge_dir=$(git rev-parse --absolute-git-dir)/land-merge
  mkdir -p "$merge_dir"
  cp "${BASH_SOURCE[0]}" "$merge_dir/land.sh.$$" && mv -f "$merge_dir/land.sh.$$" "$merge_dir/land.sh"
  if [ -f "$LOCAL" ]; then cp "$LOCAL" "$merge_dir/land.local.sh.$$" && mv -f "$merge_dir/land.local.sh.$$" "$merge_dir/land.local.sh"; else rm -f "$merge_dir/land.local.sh"; fi
  # core.attributesFile stands in for the person's own: theirs first, so it still holds.
  {
    m_attr=$(git config core.attributesFile 2>/dev/null) || m_attr=${XDG_CONFIG_HOME:-$HOME/.config}/git/attributes
    [ ! -f "${m_attr/#\~/$HOME}" ] || cat "${m_attr/#\~/$HOME}"
    while read -r m_path _; do [ -z "$m_path" ] || [[ $m_path == \#* ]] || printf '%s merge=land-ship\n' "$m_path"; done <<<"$MERGES"
  } >"$merge_dir/attributes"
fi
land_git() {
  local side=$1
  shift
  if [ -z "$merge_dir" ]; then git "$@"; return; fi
  git -c "core.attributesFile=$merge_dir/attributes" -c "merge.land-ship.name=land.sh's ship-time merges" \
    -c "merge.land-ship.driver=bash '$merge_dir/land.sh' --merge $side %O %A %B %P" \
    -c "merge.land-regen.name=land.sh: a Regenerate file, made again after the rebase" -c merge.land-regen.driver=true "$@"
}

# Lanes (the header at LANES). lane_of <base> <commit> <map's revision> [<path to leave out>]: prints "<lane> <the path
# that decided it>" for the paths <commit> changes since it forked from <base>, by the map as that revision has it.
# The pipeline's paths, one pattern a line (the header at PIPELINE_FILES), its list as of <revision>: they never ride a
# batch, keep fast mode's full gate, and take the full lane.
pipeline_pats() {
  printf '%s\n' tools/land.sh tools/land.local.sh '.github/*' ${LANES:+"$LANES"} ${PIPELINE_FILES:+"$PIPELINE_FILES"}
  [ -z "$PIPELINE_FILES" ] || { git show "$1:$PIPELINE_FILES" 2>/dev/null || git show "HEAD:$PIPELINE_FILES" 2>/dev/null || true; } |
    sed -e 's/[[:space:]]*#.*//' -e 's/[[:space:]]*$//' -e '/^$/d' -e 's|/$|/*|'
}
lane_of() {
  local fork files f i l p lane=light why='' words lanes=() pats=() pipe=()
  { fork=$(git merge-base "$1" "$2" 2>/dev/null) && files=$(git diff --no-renames --name-only -z "$fork" "$2" | tr '\0' '\n'); } 2>/dev/null ||
    { echo "full (couldn't diff ${2:0:12} against ${1:0:12})"; return 0; }
  [ -n "$files" ] || { echo "full (no changes)"; return 0; }
  while read -r -a words || [ "${#words[@]}" -gt 0 ]; do
    l=${words[0]:-}
    [ -n "$l" ] && [[ $l != \#* ]] || continue
    [[ $l =~ ^[a-z][a-z0-9_]*$ && $l != wait && $l != limit ]] || l=full # CHECK_WAIT and CHECK_LIMIT are this script's own
    for i in "${words[@]:1}"; do [[ $i != \#* ]] || break; lanes+=("$l") pats+=("$i"); done
  done < <(git show "$3:$LANES" 2>/dev/null)
  mapfile -t pipe < <(pipeline_pats "$3")
  while IFS= read -r f; do
    [ -n "$f" ] && [ "$f" != "${4:-}" ] || continue
    for p in "${pipe[@]}"; do case $f in $p) echo "full $f"; return 0 ;; esac; done
    l=full
    for i in "${!pats[@]}"; do
      case $f in ${pats[i]}) l=${lanes[i]}; break ;; esac
    done
    case $l in
      light) [ -n "$why" ] || why=$f ;;
      full) echo "full $f"; return 0 ;;
      *) if [ "$lane" = light ]; then lane=$l why=$f; elif [ "$lane" != "$l" ]; then echo "full $f"; return 0; fi ;;
    esac
  done <<<"$files"
  echo "$lane $why"
}

# lane_ci <lane>: 0 when its landings run CI, with LW the workflows the built-in reader waits for and LS the jobs a run
# may skip; 1 when they run none.
lane_ci() {
  local v
  LW=$CI_WORKFLOWS LS=''
  if [ -n "$LANES" ] && [ "$1" != full ]; then
    [ "$1" != light ] || return 1
    v=CI_SKIPS_${1^^} && LS=${!v-}
    v=CI_WORKFLOWS_${1^^}
    if [ -n "${!v+set}" ]; then LW=${!v} && [ -n "$LW" ]; return; fi
  fi
  [ -n "$CI_WORKFLOWS$CI_STATUS" ]
}

if [ "${1:-}" = --lane ]; then
  [ $# -le 3 ] || refuse "--lane takes a commit and a base, both optional"
  if [ -z "$LANES" ]; then echo "full (LANES is not set, so every landing is full)"; else lane_of "${3:-$BRANCH}" "${2:-HEAD}" "$BRANCH"; fi
  exit 0
fi

# A turn in its person's Claude container has its own pid namespace: this script there can't see the landings
# running on the host, so it would delete their places in line as dead, and they its own (Theory of Crafting,
# 2026-11-11). Citadel's land tool runs it on the host for such a turn.
[ "${COORDINATOR_CONTAINER:-}" != 1 ] || refuse "this turn runs in a container: call the land tool (mcp__thread) instead, which runs land.sh on the host"

# The line for the land lock. The lock itself is the flock on <.git>/land.lock, on fd 9: that alone
# keeps landings one at a time. The kernel grants a flock in no order, though, so several landings
# waiting on it meant some lost every round and timed out (2026-11-10). So waiters line up first:
# each takes a numbered ticket file in <.git>/land-queue, and only the oldest ticket tries the lock.
#   queue_join <lock file> <line folder> <label>   take a ticket at the end of the line
#   queue_look                      one look at the line: Q_AHEAD is how many are ahead; with none,
#                                   it takes the lock (Q_HELD). Returns 1 only when nothing has moved
#                                   for QUEUE_STALL seconds.
#   queue_phase <text>              say what this one is doing now: the waiters' sign of progress
#   queue_done [ok]                 leave the line; ok: it went all the way, so its time counts
#                                   toward the waiters' estimate
# A ticket is eight lines: "<pid> <the pid's start time>", when it got the lock (0 while it waits),
# its label, its phase, the commit it built ("-" while it has none, "skip" when it can't land where
# it sits; see "The stack"), CI's verdict on that commit ("-", running, green or red) and the commit
# it built on ("-" while it has none; both for "Batches"), and "order": it follows .order (below). A ticket whose
# process is gone is deleted by whoever waits behind it.
# The line's order (#1007) is the holder, then the waiters <.git>/land-queue/.order names (written by Citadel's
# Releases page: a "# " line saying who set it, then ticket numbers, front first), then the rest in arrival order.
# A ship that declares Regenerate files (#1827) holds the line: its ticket's 9th line says "hold", it goes ahead of
# every ranked waiter, and it ships alone (its verdict line says "old"), so no batch carries anyone past it.
# Citadel lists only tickets with the "order" line in it: a landing from an older branch runs a land.sh that waits for
# every lower ticket, so ranking it could leave two waiting on each other. For the same reason a waiting one is a
# barrier: nobody who arrived after it goes ahead of it, so .order ranks the waiters between two such ones only among
# themselves (had a later one counted itself ahead, both would take the lock as the holder left: The Trans Agenda #76).
# Citadel never ranks a waiter behind such a one either, so a land.sh from before that rule, which ranks .order's
# waiters ahead of every other, sees the same line as this one.
# A land.sh from a branch older than the line takes the flock directly; the head of the line waits
# for it like for anyone else.
# The same line as Citadel's own tools/deploy-queue.sh, kept inline so a scheme copies one file: a
# fix to either belongs in both (the stack is only here).
#
# The stack (CI gate on, CI_STACK over 1). A landing can't know its commit until the one ahead has
# landed, so with CI in the way every landing would wait a whole CI round alone. Instead the first
# CI_STACK in line each build now: the head on main, each one behind on the commit in the ticket
# directly ahead of it, and CI runs them side by side. Only the head lands, holding the land lock
# from the moment it is head, and only a commit CI passed that sits exactly on main. When it lands,
# the next one's commit already sits on the new main, so it lands as soon as its own run is green.
# When one leaves without landing (red, a conflict, killed), the commit ahead of everyone behind it
# changes: each of them builds again on the new one and CI runs again. The ones ahead never notice.
# A ticket with no fifth line is from a land.sh older than the stack: nobody builds on it, they
# wait for it to leave.
# The commit is built on a detached HEAD from the branch as it was, so the branch never holds
# another minion's unlanded commits, whatever stops this script.
#
# Batches (CI_BATCH over 1). The stack's unit becomes a batch: the first CI_STACK x CI_BATCH in line (skipped
# tickets left out) build as above, in batches of CI_BATCH, and only the last of each batch (its top: the last in
# line, if the batch isn't full) pushes, so one run covers them all. The next CI_BATCH build ahead: they rebase
# and check, and push once they move into the window. The head lands to the deepest green commit of its batch,
# after checking main and every member's commit sit under it and asking CI about it afresh; each member whose
# commit is then on main says it landed in a batch and leaves. The commits in the middle of a batch never ran CI
# on their own. A red top bisects: the member halfway between the deepest green one (or main) and the shallowest
# red one pushes its commit as it is. Red isn't final until the member's commit sits on main, so nobody marks
# itself skip for it, and nobody pushes with a red ticket ahead. A newcomer that joins a batch that isn't full is
# its new top; the old top's run goes on. A ticket with no sixth line is from a land.sh older than batches: it is
# a batch of its own, never landed by another. A landing that changes the pipeline (PIPELINE_FILES), a fast one and a build write
# "old" there too, and so ship alone. With land_deploy, the head deploys the batch once (deploy_run below).
QUEUE_POLL=${LAND_QUEUE_POLL:-1}
# How long a batch member waits for the head's push of main before saying it is still to come (KT3).
BATCH_PUSH_WAIT=${LAND_BATCH_PUSH_WAIT:-90}
[[ $BATCH_PUSH_WAIT =~ ^[0-9]+$ ]] || refuse "LAND_BATCH_PUSH_WAIT is in whole seconds, not \"$BATCH_PUSH_WAIT\""
CHECK_LIMIT=${LAND_CHECK_TIMEOUT:-1800}
[[ $CHECK_LIMIT =~ ^[0-9]+$ ]] || refuse "LAND_CHECK_TIMEOUT is in whole seconds, not \"$CHECK_LIMIT\""
[[ ${LAND_QUEUE_SLACK:-300} =~ ^[0-9]+$ ]] || refuse "LAND_QUEUE_SLACK is in whole seconds, not \"$LAND_QUEUE_SLACK\""
# CI's limits, in whole seconds, counted for the head of the line only (a run behind it may just be
# waiting for a runner the ones ahead are using): a runner takes the run within CI_START, and the run
# ends within CI_LIMIT. CI is asked every CI_POLL. For CI_GRACE after a push, an older run of the
# same commit may still be the one that answers, so red or lost is not believed yet. For CI_DOWN after a
# landing waited out CI_START or CI_LIMIT, the next ones park as soon as no runner has taken theirs. A stopped or refused
# landing looks for the run of a push under CI_LATE old, which GitHub lists some seconds late.
for v in LAND_CI_START LAND_CI_TIMEOUT LAND_CI_POLL LAND_CI_GRACE LAND_CI_DOWN LAND_CI_LATE; do
  [[ ${!v:-0} =~ ^[0-9]+$ ]] || refuse "$v is in whole seconds, not \"${!v}\""
done
CI_START=${LAND_CI_START:-600} CI_LIMIT=${LAND_CI_TIMEOUT:-2700} CI_POLL=${LAND_CI_POLL:-20} CI_GRACE=${LAND_CI_GRACE:-60} CI_DOWN=${LAND_CI_DOWN:-600} CI_LATE=${LAND_CI_LATE:-20}
[[ $CI_STACK =~ ^[1-9][0-9]*$ ]] || refuse "CI_STACK is a number from 1 up, not \"$CI_STACK\""
[[ $CI_BATCH =~ ^[1-9][0-9]*$ ]] || refuse "CI_BATCH is a number from 1 up, not \"$CI_BATCH\""
[[ $FLAKE_RUNS =~ ^[0-9]+$ ]] || refuse "FLAKE_RUNS is a number from 0 up, not \"$FLAKE_RUNS\""
[[ $PARK_RETRIES =~ ^[0-9]+$ ]] || refuse "PARK_RETRIES is a number from 0 up, not \"$PARK_RETRIES\""
[[ $CONFLICT_PREP =~ ^[01]$ ]] || refuse "CONFLICT_PREP is 1 (on) or 0 (off), not \"$CONFLICT_PREP\""
CI_ON=$CI_WORKFLOWS$CI_STATUS
# With lanes, a lane's own workflows turn the gate on too.
[ -z "$LANES" ] || for v in $(compgen -v CI_WORKFLOWS_); do CI_ON+=${!v}; done
[ -n "$CI_ON" ] || CI_ON='' CI_STACK=1 CI_LIMIT=0 CI_BATCH=1
BATCH='' BUILDERS=$CI_STACK BISECT=0 # BUILDERS: how many in line build at once
if [ "$CI_BATCH" -gt 1 ]; then
  BATCH=1 BUILDERS=$(((CI_STACK + 1) * CI_BATCH))
  while [ $((1 << BISECT)) -lt "$CI_BATCH" ]; do BISECT=$((BISECT + 1)); done # a red batch's bisect: ceil(log2 CI_BATCH) more runs
fi
# Give up after this long with no change at the head of the line. The head's longest single phases
# are the check (which may wait for the checks of the ones stacked behind it) and the CI run (with batches,
# the runs of a bisect too), so the limit is those plus slack (the 30 s a check gets to die, the 60 s push):
# it stays longer than them whatever a scheme sets them to.
# shortcut: a waiter counts with its own limits, not the holder's; write the holder's into its
# ticket if landings in one scheme ever run with different limits.
EARLY_AHEAD=0 # the early check (EARLY_CHECK): one at a time takes the check lock from outside the line, ahead of the head
[ "$EARLY_CHECK" != 1 ] || EARLY_AHEAD=1
QUEUE_STALL=$((CHECK_LIMIT * (BUILDERS + EARLY_AHEAD) + CI_LIMIT * (1 + BISECT) + ${LAND_QUEUE_SLACK:-300}))
# The wait for the check lock: the checks ahead of this one (at most BUILDERS and one early check, each within CHECK_LIMIT, and half the
# slack for the 30 s each may take to die) end within it, so past it the check holding it is stopped (a SIGSTOP, a
# frozen cgroup) or hung. Shorter than QUEUE_STALL, so the one waiting refuses before the ones behind it give up.
CHECK_WAIT=$((CHECK_LIMIT * (BUILDERS + EARLY_AHEAD) + ${LAND_QUEUE_SLACK:-300} / 2))
QUEUE_TYPICAL=300 # a landing's length until some have been timed here
QUEUE_TICKET='' Q_LOCK='' Q_DIR='' Q_N='' Q_ME='' Q_LABEL='' Q_AHEAD=0 Q_PRED='' Q_PREDNAME='' Q_HELD='' Q_HOLD='' Q_LAST='' Q_SINCE=0 Q_SAID='' Q_LINE=() Q_ORDER=() Q_BY=''

# "<pid> <start time>" of a live process, or nothing. The start time tells a reused pid apart. With a second
# argument, into that variable instead: the line's loop runs it for every ticket each pass, and a $( ) is a fork, which
# made a line of twelve cost most of a core (Citadel #1545).
queue_proc() {
  local stat='' r='' into=${2:-}
  IFS= read -r -d '' stat 2>/dev/null <"/proc/$1/stat" || : # read -d '' ends at EOF with status 1, so never alone under set -e
  if [ -n "$stat" ]; then
    stat=${stat##*) } # the command's name may hold spaces
    # shellcheck disable=SC2086
    set -- "$1" $stat
    # A zombie (Z, or X while it is reaped) is dead, though its /proc entry stays until its parent waits on it.
    case $2 in Z | X | x) ;; *) r="$1 ${21}" ;; esac
  fi
  if [ -n "$into" ]; then printf -v "$into" %s "$r"; elif [ -n "$r" ]; then echo "$r"; fi
}

# The state letter of a process: T or t is stopped (a SIGSTOP), and so is a process in a frozen cgroup. A second
# argument: into that variable, as queue_proc.
queue_state() {
  local stat='' cg='' x
  IFS= read -r -d '' stat 2>/dev/null <"/proc/$1/stat" || :
  stat=${stat##*) }
  stat=${stat%% *}
  # A frozen cgroup (systemctl freeze, a paused container) leaves its processes in state S: its cgroup.events says it.
  if [ -n "$stat" ] && [[ $stat != [Tt] ]]; then
    while IFS= read -r x; do [[ $x != 0::* ]] || { cg=${x#0::}; break; }; done 2>/dev/null <"/proc/$1/cgroup" || :
    [ -z "$cg" ] || while IFS= read -r x; do [ "$x" != 'frozen 1' ] || stat=T; done 2>/dev/null <"${LAND_QUEUE_CGROUP:-/sys/fs/cgroup}$cg/cgroup.events" || :
  fi
  if [ -n "${2:-}" ]; then printf -v "$2" %s "$stat"; elif [ -n "$stat" ]; then echo "$stat"; fi
}

queue_write() { # <file> <pid and start> <got> <label> <phase> <commit> <verdict> <base>: by a rename, so nobody reads half a ticket
  # A 9th line "hold" (Q_HOLD, a Regenerate ship): it holds the line, first among the waiters (queue_order).
  printf '%s\n' "$2" "$3" "$4" "$5" "$6" "$7" "$8" order ${Q_HOLD:+hold} >"$1.tmp$$" && mv -f "$1.tmp$$" "$1"
}

queue_set() { # <line, from 0> <text>: change one line of this landing's ticket
  local t=$QUEUE_TICKET l
  [ -n "$t" ] && [ -e "$t" ] || return 0
  mapfile -t l 2>/dev/null <"$t" || return 0
  l[$1]=$2
  [ "$1" != 5 ] || [ "$UNRUN" != old ] || l[5]=old # a build or a pipeline ship is a batch of its own: no gated landing's batch takes it in
  queue_write "$t" "${l[0]:-}" "${l[1]:-0}" "${l[2]:-}" "${l[3]:-}" "${l[4]:--}" "${l[5]:--}" "${l[6]:--}" 2>/dev/null || true
}

queue_phase() { queue_set 3 "$1"; }

queue_done() {
  local t=$QUEUE_TICKET l took
  [ -n "$t" ] && [ -e "$t" ] || return 0
  mapfile -t l 2>/dev/null <"$t" || true
  # How long it held the lock, for the next waiters' estimate (the newest 5 are kept). Not a run that
  # stopped early (a conflict, a red check): a few of those would promise everyone a one-minute wait.
  if [ "${1:-}" = ok ] && [ "${l[1]:-0}" -gt 0 ] 2>/dev/null; then
    took=$(dirname "$t")/.took
    { tail -n 4 "$took" 2>/dev/null; echo $(($(date +%s) - l[1])); } >"$took.tmp$$" && mv -f "$took.tmp$$" "$took"
  fi 2>/dev/null
  rm -f "$t"
}

# The tickets in line order (the header at "The line's order"), as Q_ORDER, and who set .order, as Q_ORDER_BY.
queue_order() {
  local t l i=0 old=0 seg k keys=() pins='' pin=0 LC_ALL=C # C: the keys sort byte by byte
  local -A rank=()
  Q_ORDER=() Q_ORDER_BY=''
  [ ! -f "$Q_DIR/.order" ] || while read -r t; do
    if [[ $t =~ ^[0-9]{10}$ ]]; then rank[$t]=$((i += 1)); elif [[ $t == '# '* ]]; then Q_ORDER_BY=${t#\# }; elif [[ $t == '#pin '* ]]; then pins=${t#\#pin }; fi
  done <"$Q_DIR/.order" 2>/dev/null || true
  # A ship a person placed ("#pin": Citadel's "Person's drag wins") stays ahead of one that holds the line: it goes behind the last still waiting (not landing: line 2 is 0).
  for t in $pins; do printf -v t '%010d' "$((10#$t))" 2>/dev/null && [ "$(sed -n 2p "$Q_DIR/$t" 2>/dev/null || echo x)" = 0 ] && [ "${rank[$t]:-0}" -gt "$pin" ] && pin=${rank[$t]}; done
  for t in "$Q_DIR"/[0-9]*; do
    t=${t##*/}
    [[ $t =~ ^[0-9]+$ ]] && mapfile -t l 2>/dev/null <"$Q_DIR/$t" || continue # not a ticket half-written, or the glob itself
    printf -v seg '1%05d' "$old" # the waiters from before .order (no "order" line) ahead of it, in arrival order
    if [ "${l[1]:-0}" != 0 ]; then keys+=("0 $t")
    elif [ "${l[4]:-}" != order ] && [ "${l[7]:-}" != order ]; then keys+=("${seg}3 $t") old=$((old + 1))
    elif [ "${l[8]:-}" = hold ] || [ "${l[5]:-}" = hold ]; then printf -v k '%010d' "$pin"; keys+=("${seg}1${k}h $t") # holds the line: before every rank but a person's pins (deploy-queue.sh's "hold" is its 6th line)
    elif [ -n "${rank[$t]:-}" ]; then printf -v k '%010d' "${rank[$t]}"; keys+=("${seg}1$k $t")
    else keys+=("${seg}2 $t"); fi
  done
  # Sorted in place, not by sort: a pipe is three processes a pass for every waiter (#1545), and the line is short.
  for k in "${keys[@]}"; do
    i=${#Q_ORDER[@]}
    while [ "$i" -gt 0 ] && [[ ${Q_ORDER[i - 1]} > $k ]]; do Q_ORDER[i]=${Q_ORDER[i - 1]} i=$((i - 1)); done
    Q_ORDER[i]=$k
  done
  Q_ORDER=("${Q_ORDER[@]#* }")
}

queue_ordinal() {
  case $1 in 1) echo next ;; 2) echo 2nd ;; 3) echo 3rd ;; *) echo "${1}th" ;; esac
}

queue_join() {
  Q_LOCK=$1 Q_DIR=$2 Q_LABEL=$3
  mkdir -p -m 700 "$Q_DIR"
  # Unopened, it leaves a bare shell error, or a flock one a second (Citadel's drill, F12b).
  if ! { exec 9>"$Q_LOCK"; } 2>/dev/null; then
    echo "queue: can't open the land lock $Q_LOCK for writing, so nothing landed: a person needs to look at it" >&2
    return 1
  fi
  Q_ME=$(queue_proc $$)
  # The ticket and its number, under a lock of its own that is only ever held for these few lines: the
  # ticket is in the folder before the next number goes out, so nobody behind it can miss it.
  Q_N=$(
    exec 8>"$Q_DIR/.seq.lock"
    flock 8
    n=$(cat "$Q_DIR/.seq" 2>/dev/null) || n=0
    # Junk in it (F12c) gave out a number already in line: number on from the newest ticket instead (an empty one,
    # from a write cut off, quietly).
    if ! [[ $n =~ ^[0-9]{1,10}$ ]]; then
      t=$(find "$Q_DIR" -maxdepth 1 -regex '.*/[0-9]+' -printf '%f\n' 2>/dev/null | sort | tail -n 1)
      [ -z "$n" ] || echo "queue: $Q_DIR/.seq held no ticket number (\"$(head -c 40 <<<"$n")\"); numbering goes on from the newest ticket, $((10#${t:-0}))" >&2
      n=${t:-0}
    fi
    n=$(printf '%010d' $((10#$n + 1)))
    queue_write "$Q_DIR/$n" "$Q_ME" 0 "$Q_LABEL" waiting - "$UNRUN" -
    echo "$((10#$n))" >"$Q_DIR/.seq"
    echo "$n"
  )
  QUEUE_TICKET="$Q_DIR/$Q_N" Q_SINCE=$SECONDS
  queue_order
  Q_BY=$Q_ORDER_BY # an order set before this joined is no news to it
}

queue_look() {
  local q=$Q_DIR t l p st ahead=0 head="" headname="" headpid="" sig typical sum count line detail look
  Q_PRED='' Q_PREDNAME='' Q_LINE=()
  queue_order
  if [ "$Q_ORDER_BY" != "$Q_BY" ]; then
    Q_BY=$Q_ORDER_BY
    # Said before its place, which follows at once (Citadel reads the place from the last "queue:" line).
    [ -z "$Q_BY" ] || [ -n "$Q_HELD" ] || { echo "queue: $Q_BY" >&2; Q_LAST=''; }
  fi
  for t in "${Q_ORDER[@]}"; do
    [ "$t" != "$Q_N" ] || break
    t=$q/$t
    mapfile -t l 2>/dev/null <"$t" || continue
    # Its process is gone (killed, or its turn was stopped): it leaves the line.
    [ -z "${l[0]:-}" ] || queue_proc "${l[0]%% *}" p
    if [ -z "${l[0]:-}" ] || [ "$p" != "${l[0]}" ]; then
      rm -f "$t"
      continue
    fi
    # A waiter that is stopped (a SIGSTOP, a frozen cgroup) holds no land lock, so it is passed over; it tries for the
    # lock like the head once it wakes. Those this one passed so are waiting on its lock, not ahead of it. A check it
    # was running keeps the check lock: CHECK_WAIT bounds that.
    if [ "${l[1]:-0}" = 0 ] && { [ -n "$Q_HELD" ] || { queue_state "${l[0]%% *}" st; [[ $st == [Tt] ]]; }; }; then continue; fi
    ahead=$((ahead + 1))
    [ -n "$head" ] || { head="${l[*]}" headname="${l[2]:-?}, ${l[3]:-?}" headpid=${l[0]%% *}; }
    # The last one seen is the one directly ahead. "skip": that one is red or in conflict where it sits, and
    # lands only if what is ahead of it fails, so the ones behind build on the one ahead of it meanwhile.
    # Q_LINE: the ones ahead that aren't skipped, for batches: label, commit, verdict ("old" from a land.sh older than
    # batches), base, pid.
    # A verdict line it doesn't know (another script's ticket sharing the line, as Citadel's deploy.sh) reads as old.
    [[ ${l[5]:-} =~ ^(-|running|green|red)$ ]] || l[5]=old
    [ "${l[4]:-}" = skip ] || { Q_PRED=${l[4]:-} Q_PREDNAME=${l[2]:-?}; Q_LINE+=("${l[2]:-?} ${l[4]:--} ${l[5]} ${l[6]:--} ${l[0]}"); }
  done
  Q_AHEAD=$ahead
  [[ $Q_PRED =~ ^[0-9a-f]{40,}$ ]] || Q_PRED='' # "-": it has built nothing yet; no line: older than the stack

  if [ "$ahead" = 0 ]; then
    [ -z "$Q_HELD" ] || return 0
    # A short blocking wait, not a poll: the lockers outside the line block in the kernel, and a poller would lose to every one of them.
    if flock -w "$QUEUE_POLL" 9; then
      [ -z "$Q_SAID" ] || echo "queue: got the land lock" >&2
      Q_HELD=1
      queue_set 1 "$(date +%s)"
      return 0
    fi
    # Held by a landing behind this one in line: it passed this one while it was stopped.
    head="outside $Q_N" headname="a landing started from a branch whose land.sh is older than the line"
    for t in "$q"/[0-9]*; do
      [[ ${t##*/} =~ ^[0-9]+$ ]] && mapfile -t l 2>/dev/null <"$t" || continue
      [ "${l[1]:-0}" != 0 ] && queue_proc "${l[0]%% *}" p && [ "$p" = "${l[0]:-}" ] || continue
      head="${l[*]}" headname="${l[2]:-?}, ${l[3]:-?}"
      break
    done
  fi

  # Progress is any change at the head of the line: a new head, or the head's next phase.
  sig="$ahead $head"
  if [ "$sig" != "$Q_LAST" ]; then
    Q_LAST=$sig Q_SINCE=$SECONDS
    line="$(queue_ordinal $((ahead + 1))) in line for the land lock"
    if [ "$ahead" -gt 0 ]; then
      sum=0 count=0
      [ ! -f "$q/.took" ] || while read -r typical; do [[ $typical =~ ^[0-9]+$ ]] && sum=$((sum + typical)) count=$((count + 1)); done <"$q/.took" || true
      typical=$((count ? sum / count : QUEUE_TYPICAL))
      [ "$typical" -gt 0 ] || typical=1
      line="$line, about $((((ahead + CI_BATCH - 1) / CI_BATCH * typical + 59) / 60)) min"
    fi
    echo "queue: $line (ahead: $headname)" >&2
    [ -n "$Q_SAID" ] || echo "queue: the wait has no time limit while the line moves, so run this in the background with a long timeout rather than under a 10 min limit: a run that is stopped loses its place" >&2
    Q_SAID=1
  elif [ $((SECONDS - Q_SINCE)) -ge "$QUEUE_STALL" ]; then
    detail="" look="what holds the land lock ($Q_LOCK)"
    if [ "$ahead" -gt 0 ]; then
      detail=$(queue_state "$headpid")
      case $detail in T | t) detail="; pid $headpid, stopped" ;; *) detail="; pid $headpid, state ${detail:-?}" ;; esac
      if flock -n 9; then
        flock -u 9
        detail="$detail; the lock is free" look="pid $headpid, which is first in line and is not taking the lock,"
      else
        detail="$detail; the lock is held"
      fi
    fi
    echo "queue: nothing has moved for $(((QUEUE_STALL + 59) / 60)) min (ahead: $headname$detail), so this gave up and nothing landed. A person needs to look at $look before anyone tries again" >&2
    return 1
  fi
}

# Whose check holds the check lock, by the phase in the tickets, for when it never comes.
check_holder() {
  local t l s
  for t in "$Q_DIR"/[0-9]*; do
    [[ ${t##*/} =~ ^[0-9]+$ ]] && [ "$t" != "$QUEUE_TICKET" ] && mapfile -t l 2>/dev/null <"$t" || continue
    [[ ${l[3]:-} == "running the check"* ]] || continue
    s=$(queue_state "${l[0]%% *}")
    case $s in T | t) s=stopped ;; *) s="state ${s:-?}" ;; esac
    echo "${l[2]:-?}'s check holds it (its landing is pid ${l[0]%% *}, $s)"
    return 0
  done
  echo "no landing in line says it is running its check, so it may be one a killed landing left running"
}

# Numbered things: what minions number in parallel, so two can take the same "next" one and both
# land it (git merges two identical version bumps without a word). The Project facts line lists
# entries split by ';', each a kind, a path glob and, for ids and version, a Perl regex in quotes:
#   - **Numbered things:** files src/db/migrations/NNNN-*.sql; ids docs/unproven.md "\*\*U(\d+)\.";
#     version addons/*/*.toc "^## Version: (.+)"
# files: the digits in place of NNNN in a file name; two files with one number clash.
# ids: what the regex's group matches, line by line, across the glob's files; an id the branch
#   makes appear twice clashes (duplicates main already had are left alone).
# version: the first match in each file; it clashes when the branch and main both changed it since
#   the branch started. In globs, * and ? stop at '/'. Backticks are ignored.
# Args: the revisions main is, the branch started from and the branch was before the rebase. Prints
# one line per clash and exits 1; exits 0 when there are none and 2 when the line doesn't parse.
numbered_clashes() {
  # No single quote anywhere in the Perl, comments included: it would end the bash string.
  perl -e '
    use strict; use warnings;
    my ($facts, $main, $fork, $pre) = @ARGV;
    sub git { # its output, or undef when it fails; its errors are not shown
      my @args = @_;
      my $pid = open(my $fh, "-|") // die "fork: $!\n";
      if (!$pid) { open STDERR, ">", "/dev/null"; exec "git", @args or exit 127 }
      local $/; my $out = <$fh>; close $fh;
      return $? ? undef : ($out // "");
    }
    sub git_or_die { my $out = git(@_); defined $out or die "git @_ failed\n"; $out }
    sub norm { $_[0] =~ /^\d+$/ ? $_[0] + 0 : $_[0] }
    sub glob_re { # a glob as an anchored regex; with $nums, NNNN captures digits
      my ($glob, $nums) = @_;
      my $re = join "", map { $_ eq "*" ? "[^/]*" : $_ eq "?" ? "[^/]" : ($nums && /^N{2,}$/) ? "(\\d+)" : quotemeta }
        $glob =~ /(N{2,}|[*?]|[^*?N]+|N)/g;
      qr/^$re$/;
    }
    sub highest { my @n = grep /^\d+$/, @_; @n ? " (the highest so far is " . (sort { $b <=> $a } @n)[0] . ")" : "" }

    my %head = map { $_ => 1 } split /\0/, git_or_die("ls-tree", "-rz", "--name-only", "HEAD");
    exit 0 unless $head{$facts};
    my $line;
    for (split /\n/, git_or_die("show", "HEAD:$facts")) { # a wrapped line goes on until the next bullet
      if (defined $line) { last if /^\s*-/ || /^\s*\z/ || /^\S/; $line .= " $_"; next }
      $line = $1 if /^\s*-\s*\*\*Numbered things:\*\*\s*(.*)/;
    }
    exit 0 unless defined $line;
    $line =~ tr/`//d; $line =~ s/^\s+|\s+$//g;
    exit 0 if $line eq "" || $line =~ /^none\b/i;
    my $bad = sub { print "the Numbered things line in $facts does not parse: $_[0]\n"; exit 2 };
    my @entries = ([]);
    while ($line =~ /\G\s*(?:"((?:[^"\\]|\\.)*)"|(;)|([^\s;"]+))/gc) {
      if (defined $2) { push @entries, []; next }
      push @{$entries[-1]}, defined $1 ? $1 =~ s/\\"/"/gr : $3;
    }
    $line =~ /\G\s*$/gc or $bad->("an unclosed quote or a stray character");
    my $files = join "", map "$_\n", sort keys %head;
    my %added = map { $_ => 1 } split /\0/, git_or_die("diff", "-z", "--name-only", "--no-renames", "--diff-filter=A", $main, "HEAD");
    my @clashes;
    for my $e (grep @$_, @entries) {
      my ($kind, $glob, $rx, @rest) = @$e;
      my $what = join " ", @$e;
      if ($kind eq "files") {
        (defined $glob && !defined $rx && $glob =~ /N{2,}/) or $bad->("\"$what\": files takes one glob with NNNN where the number goes");
        my $re = glob_re($glob, 1); my %by;
        for (sort keys %head) { push @{$by{$1 + 0}}, $_ if $_ =~ $re }
        for my $f (grep { $added{$_} && $_ =~ $re } sort keys %head) {
          my $n = ($f =~ $re)[0] + 0;
          my @others = grep $_ ne $f, @{$by{$n}};
          push @clashes, "$f takes number $n, which @others already has" . highest(keys %by) if @others;
        }
        next;
      }
      ($kind eq "ids" || $kind eq "version") && defined $rx && !@rest or $bad->("\"$what\": the kinds are files <glob>, ids <glob> \"<regex>\" and version <glob> \"<regex>\"");
      my $re = eval { qr/$rx/m } or $bad->("\"$what\": the regex does not compile: $@");
      my $path_re = glob_re($glob, 0);
      my @matched = grep { $_ =~ $path_re } sort keys %head;
      if ($kind eq "ids") {
        # A clash is an id the branch has more of than main, past one: old duplicates on main are left alone.
        my (%count, %was, %where);
        for my $f (@matched) {
          for (map { /$re/g } split /\n/, git_or_die("show", "HEAD:$f")) { $count{norm($_)}++; $where{norm($_)} = $f }
          $was{norm($_)}++ for map { /$re/g } split /\n/, git("show", "$main:$f") // "";
        }
        push @clashes, "$where{$_} has id $_ " . ($was{$_} ? "twice: this branch adds one and main already has it" : "$count{$_} times, all from this branch") . highest(keys %count)
          for grep { $count{$_} > 1 && $count{$_} > ($was{$_} // 0) } sort keys %count;
        next;
      }
      for my $f (@matched) {
        my ($was, $mine, $theirs) = map { my $t = git("show", "$_:$f"); defined $t && $t =~ $re ? ($1 // $&) : "" } $fork, $pre, $main;
        push @clashes, "$f: this branch moves its version from $was to $mine, but main moved it to $theirs since the branch started"
          if $mine ne $was && $theirs ne $was;
      }
    }
    print "$_\n" for @clashes;
    exit(@clashes ? 1 : 0);
  ' "$FACTS" "$@"
}

# The undo guard (#677, after Peek Auras #361's tools/undo-guard.sh): prints, and exits 1 on, the commits among
# <onto>'s last 60 that this branch reverts without seeing them. A stale squash does that behind a clean
# fast-forward with CI green: `git reset --soft main` from a branch that started further back keeps its old files
# (Peek Auras #309 undid six landings so). A commit counts when the branch removes 90% of the lines it added (4 or
# more, repeats included, of 12+ characters, compared trimmed; a removed line is a move, not a removal, only as
# many times as the branch adds that text back in any file, so a revert that also puts back older copies of a
# repeated line like "linked: null" still counts: The Trans Agenda #66) and, if it removed lines, puts at least half
# of those back. shortcut: the add-backs go to the branch's other removals of that text first, so merging two
# identical files, one of them recent, reads as undoing it (none in ~1,090 landings); if one shows up, credit the
# add-backs to the commit's own lines first, which scores a stale squash of several exports lower (96% to 93%).
# Commits of the branch's own ticket don't count (ticket/N-… against a subject's leading "#N" or "WIP #N" or last
# "#N)"); an undo that is meant names each one in a message line "Undoes: <sha>" (git revert's "This reverts commit
# <sha>" counts too). Tried on 2026-11-14 over ~690 landings in four schemes: it refused the stale squash, two
# deliberate removals of another minion's work (what the trailer is for), and nothing else; the line counts of
# 2026-11-15 refused the same over ~1,090 landings in seven.
undo_guard() {
  local base
  base=$(git merge-base HEAD "$1") || return 2
  perl -e '
    use strict; use warnings; use List::Util qw(min max);
    my ($base, $ticket) = @ARGV;
    sub run { my $out = `$_[0]`; $? == 0 or die "undo guard: $_[0] failed\n"; $out }
    sub lines { # how many times a diff adds (+) or removes (-) each trimmed line of 12+ characters, keyed by file
      my ($sign, $cmd) = @_; my (%set, $f);
      for (split /\n/, run("git -c core.quotePath=false $cmd")) {
        if (/^diff /) { undef $f; next }
        if (/^--- (?:a\/(.*)|\/dev\/null)$/) { $f = $1; next } # a deleted file is named here only
        if (/^\+\+\+ (?:b\/(.*)|\/dev\/null)$/) { $f = $1 // $f; next }
        next if /^@@/ || !defined $f;
        $set{"$f\0$1"}++ if /^\Q$sign\E\s*(.*?)\s*$/ && length $1 >= 12;
      }
      \%set;
    }
    sub text { (split /\0/, $_[0], 2)[1] }
    sub ticket { my $s = shift; return $1 if $s =~ /^(?:WIP:? )?#(\d+)\b/; my @t = $s =~ /#(\d+)\)/g; @t ? $t[-1] : "" }
    my @named = run("git log --format=%B $base..HEAD") =~ /^(?:Undoes: *|This reverts commit )([0-9a-f]{7,40})\b/mg;
    my $diff = "diff -U0 --no-renames --no-color $base HEAD";
    my ($removed, $added) = (lines("-", $diff), lines("+", $diff));
    my %net; # per text, how many more lines the branch removes than adds back anywhere
    $net{text($_)} += $removed->{$_} for keys %$removed;
    $net{text($_)} -= $added->{$_} for keys %$added;
    my @bad;
    for (split /\n/, run("git log --no-merges --format=\"%H %s\" -60 $base")) {
      my ($c, $s) = /^(\S+) (.*)/ or next;
      next if $ticket ne "" && ticket($s) eq $ticket;
      next if grep { index($c, $_) == 0 } @named;
      my $show = "diff-tree -p --root -U0 --no-renames --no-color --format= $c";
      my $put = lines("+", $show);
      my ($n, $gone, %here) = (0, 0);
      for (keys %$put) { $n += $put->{$_}; $here{text($_)} += min($put->{$_}, $removed->{$_} // 0) }
      next if $n < 4;
      $gone += min($here{$_}, max(0, $net{$_} // 0)) for keys %here;
      next if $gone < 0.9 * $n;
      my $took = lines("-", $show);
      my $back = grep { $added->{$_} } keys %$took;
      next if keys %$took && $back < 0.5 * keys %$took;
      push @bad, sprintf("  %s %s (%d of the %d lines it added are removed here)", substr($c, 0, 12), $s, $gone, $n);
    }
    exit 0 unless @bad;
    print join("\n", @bad), "\n";
    exit 1;
  ' "$base" "$(sed -nE 's|^ticket/([0-9]+)-.*|\1|p' <<<"$branch")"
}

# Build claims (#1159): build-claims.md on build/<n>, the build minion's plan, names the files each feeder writes
# ("#<n>: <paths>"; a path ending in / is a folder, the longest match wins), the hub files any feeder may add to
# ("shared: <paths>") and the build minion ("build: #<n>"). A feeder's --into is refused when it writes a file another
# feeder claimed, an unclaimed file another feeder already merged in, the claims file itself, or, in a shared file,
# lines another feeder merged in. Who merged a commit comes from build/<n>'s reflog ("land.sh --into <branch>"),
# else from a "#<n>" at the start of its subject. It runs at --check, before the lock, and again after the rebase. A plain check, no AI; with no claims file there is no check.
claims_check() {
  local trunk=$1 claims me boss mb merged f who m a b why
  claims=$(git show "refs/heads/$build:build-claims.md" 2>/dev/null) || return 0
  me=$(sed -nE 's#^ticket/([0-9]+)(-.*)?$#\1#p' <<<"$branch")
  boss=$(sed -nE 's/^build:[[:space:]]*#?([0-9]+).*/\1/p' <<<"$claims" | head -n 1)
  [ -n "$boss" ] || { say "warning: $build's build-claims.md has no line build: #<n> naming its build minion, so its claims aren't checked"; return 0; }
  { [ -n "$me" ] && [ "$me" != "$boss" ]; } || return 0 # the build minion's own branch, or one with no minion number
  [ "$mode" != full ] || refuse "--full is the build minion's (#$boss): a feeder merges in with tools/land.sh --into $build <test files>. Nothing merged"
  mb=$(git merge-base "refs/heads/$build" HEAD) || return 0
  # "<commit> <minion>" for each commit a feeder's --into brought in, newest reflog entry first.
  merged=$(git reflog show --format='%H %gs' "refs/heads/$build" 2>/dev/null | awk 'NR > 1 { print $1, prev } { prev = $0 }' |
    while read -r old new tool flag who; do
      [ "$tool $flag" = "land.sh --into" ] || continue
      m=$(sed -nE 's#^ticket/([0-9]+)(-.*)?$#\1#p' <<<"$who")
      [ -z "$m" ] || git rev-list "$old..$new" 2>/dev/null | sed "s/\$/ $m/"
    done)
  # The minion that wrote a commit of the build, or nothing for main's commits and the build minion's.
  writer() {
    git merge-base --is-ancestor "$1" "refs/heads/$trunk" 2>/dev/null && return 0
    local m
    m=$(awk -v c="$1" '$1 == c { print $2; exit }' <<<"$merged")
    [ -n "$m" ] || m=$(git log -1 --format=%s "$1" | sed -nE 's/^#([0-9]+)([^0-9].*)?$/\1/p')
    [ "$m" = "$boss" ] || echo "$m"
  }
  why=$(while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ "$f" = build-claims.md ]; then
      echo "$f is the build minion's plan, so only it changes a claim"
      continue
    fi
    # A list mark, backticks and commas are read as spaces: "- #4: `a.ts`, `b.ts`" claims both.
    who=$(awk -v f="$f" '{ l = $0; sub(/^[-*][ \t]+/, "", l); gsub(/[`,]/, " ", l) } match(l, /^(#[0-9]+|shared):/) {
        w = substr(l, 1, RLENGTH - 1); sub(/^#/, "", w); n = split(substr(l, RLENGTH + 1), p, /[ \t]+/)
        for (i = 1; i <= n; i++) if (p[i] != "" && (p[i] == f || (p[i] ~ /\/$/ && index(f, p[i]) == 1)) && length(p[i]) > best) { best = length(p[i]); out = w }
      } END { print out }' <<<"$claims")
    if [ "$who" = shared ]; then
      # Each run of lines this branch changes or removes, blamed at the merge-base: any another feeder wrote refuses.
      git -c core.quotePath=false diff -U0 --no-renames "$mb" HEAD -- "$f" | sed -nE 's/^@@ -([0-9]+)(,([0-9]+))? .*/\1 \3/p' | while read -r a b; do
        [ "${b:-1}" != 0 ] || continue
        git blame --porcelain -L "$a,+${b:-1}" "$mb" -- "$f" 2>/dev/null | awk 'length($1) >= 40 && $1 ~ /^[0-9a-f]+$/ { print $1 }' | sort -u | while read -r c; do
          m=$(writer "$c")
          [ -z "$m" ] || [ "$m" = "$me" ] || echo "$f (shared) changes or removes lines #$m merged in (line $a): only add to a shared file"
        done
      done | sort -u
    elif [ -n "$who" ]; then
      [ "$who" = "$me" ] || echo "$f is #$who's in the claims"
    else
      for c in $(git rev-list --reverse "refs/heads/$trunk..refs/heads/$build" -- "$f"); do
        m=$(writer "$c")
        [ -n "$m" ] || continue
        [ "$m" = "$me" ] || echo "$f is unclaimed, but #$m merged it in first, so it is #$m's"
        break
      done
    fi
  done < <(git -c core.quotePath=false diff --name-only --no-renames "$mb" HEAD))
  [ -n "$why" ] || return 0
  why="$branch writes outside its claim in $build's build-claims.md, so nothing merged: $(sed ':a;N;$!ba;s/\n/; /g' <<<"$why"). A late need goes through the build minion: ask #${boss:-?} (message_minion) to move the claim, or leave those files to their owners, then run this again"
  [ -z "$check" ] || { say "$why"; exit 3; } # hand_off_land's early check: exit 3 stops the hand-off with this text
  refuse "$why"
}

# A claims merge in flight (#1684): the build minion's --into of a changed build-claims.md marks itself with a file
# land-build-<n>.claims.<pid> (its queue_proc identity) in the main checkout's git dir until it ends, waiting for the
# build's lock included. claims_inflight prints the pid of a live one other than this run (a dead one's mark goes).
claims_mark() { echo "$(git rev-parse --path-format=absolute --git-common-dir)/land-build-${build#build/}.claims"; }
claims_inflight() {
  local f
  for f in "$(claims_mark)".*; do
    [ -f "$f" ] && [ "${f##*.}" != $$ ] || continue
    [ "$(queue_proc "${f##*.}")" != "$(cat "$f" 2>/dev/null)" ] || { echo "${f##*.}"; return 0; }
    rm -f "$f"
  done
  return 1
}
# claims_check, unless a claims merge is in flight: the claims are about to change, so a feeder's hand-off (--check)
# goes ahead, and its run waits for that merge to end and is checked against the new plan rather than refused against
# the old one (Peek #873 was refused twice so). Under the build's lock claims_check runs again whatever happened here.
claims_gate() {
  local pid t=$SECONDS
  if pid=$(claims_inflight); then
    say "claims merge in flight on $build (the build minion's run, pid $pid), waiting for it to end; the claims are checked against the new plan after"
    [ -z "$check" ] || return 0
    while pid=$(claims_inflight); do
      [ $((SECONDS - t)) -lt "${LAND_BUILD_WAIT:-3600}" ] || refuse "waited ${LAND_BUILD_WAIT:-3600} s for the claims merge on $build (pid $pid) to end, so nothing merged: run it again later"
      sleep "$QUEUE_POLL"
    done
    say "the claims merge on $build ended: checking the claims"
  fi
  claims_check "$BRANCH"
}

# land.local.sh's land_under <the branch's commit> <branch>, asked at the early checks and again right before each
# rebase, since a deploy can roll back while the landing waits (plain landings only): prints the newest commit under the
# branch's whose own commits came off $BRANCH since the branch took them (a deploy rolled them back),
# so this script's rebases replay only the branch's commits above it (git rebase --onto) and the early checks merge
# from it. Nothing printed: the usual fork point. A commit that isn't under the branch's, or a failure, refuses.
under='' under_asked=''
under_of() { # <the branch's commit>
  local rc=0 out c was=$under
  [ -z "$under_asked" ] || return 0
  under_asked=1 under=''
  declare -F land_under >/dev/null && [ "$mode" = land ] || return 0
  out=$(mktemp) || return 0
  (cd "$here" && land_under "$1" "$branch") </dev/null >"$out" 9>&- 6>&- 7>&- &
  wait $! || rc=$?
  c=$(tail -n 1 "$out")
  rm -f "$out"
  [ "$rc" = 0 ] || refuse "land.local.sh's land_under failed (exit $rc), so nothing landed; a person needs to look"
  [ -n "$c" ] || return 0
  under=$(git rev-parse -q --verify "$c^{commit}") && git merge-base --is-ancestor "$under" "$1" ||
    refuse "land.local.sh's land_under printed \"$c\", which is not a commit under $branch's, so nothing landed; a person needs to look"
  [ "$under" = "$was" ] || say "the rebase replays only $branch's commits above ${under:0:12} (land_under)"
}

# Conflict prep (CONFLICT_PREP): this script's rebases and early checks run with git rerere on (rr, set once the mode is
# known), so a fix recorded ahead of time replays. A landing stacked on the one ahead whose rebase onto it stops says
# "prep: <branch> will conflict with <the one ahead> once <it> ships; conflicted files: <files>; record the fix against
# <its commit> from <base> to <the branch's commit>", once per commit ahead, branch commit and count of recorded fixes,
# and keeps its place: its author records the fix in a scratch worktree (the server's wake says how), never on the
# branch. A new fix recorded tries the rebase again; one that goes through says "prep: ... resolves it". A fix never
# needed (the one ahead went red) just goes unused. rerere is never turned on for the repo: only for these commands.
rr=()
# <dir>: after a rebase in <dir> stopped, go on while every stop is one rerere resolved in full (git stops even then):
# no file left unmerged. 1 at any other stop, the rebase left for the caller.
rerere_on() {
  local n step
  [ ${#rr[@]} -gt 0 ] || return 1
  for ((n = 0; n < 1000; n++)); do
    [ -d "$(git -C "$1" rev-parse --absolute-git-dir)/rebase-merge" ] && [ -z "$(git -C "$1" diff --name-only --diff-filter=U)" ] || return 1
    # Nothing staged: the recorded fix kept the other side whole, so this commit is empty now and drops out.
    if git -C "$1" diff --cached --quiet; then step=--skip; else step=--continue; fi
    GIT_EDITOR=true land_git ours -C "$1" "${rr[@]}" rebase "$step" >/dev/null 2>&1 && return 0
  done
  return 1
}
# <onto> <commit>: whether that commit's rebase onto <onto>, which merge-tree says stops, goes through with the recorded
# fixes. Replayed in a scratch worktree, so no ref or worktree of the branch's moves. shortcut: a checkout each time,
# only after a conflict was found; cache by commits if that ever runs often.
rerere_covers() {
  local wt base ok=1
  [ ${#rr[@]} -gt 0 ] && base=${under:-$(git merge-base "$1" "$2")} && wt=$(mktemp -d "${TMPDIR:-/tmp}/land-prep.XXXXXX") || return 1
  if git worktree add -q --detach "$wt" "$2" >/dev/null 2>&1; then
    { land_git ours -C "$wt" "${rr[@]}" rebase -q --onto "$1" "$base" >/dev/null 2>&1 || rerere_on "$wt"; } && ok=0
    git -C "$wt" "${rr[@]}" rebase --abort >/dev/null 2>&1 || true # with rerere on, so it drops the preimage it left
    git worktree remove --force "$wt" >/dev/null 2>&1 || true
  fi
  rmdir "$wt" 2>/dev/null || true
  return $ok
}
prep_count() { find "$(git rev-parse --path-format=absolute --git-common-dir)/rr-cache" -name 'postimage*' 2>/dev/null | wc -l; }
# The rebase of this worktree's HEAD onto <onto>, with land_under's --onto and conflict prep's recorded fixes; git's
# output as the caller sends it. 1 with the rebase stopped, for the caller to abort.
land_rebase() {
  local -a r=("$1")
  under_asked='' # asked again: a deploy may have rolled back since the early checks
  under_of "$pre"
  [ -z "$under" ] || r=(--onto "$1" "$under")
  land_git ours "${rr[@]}" rebase -q "${r[@]}" && return 0
  rerere_on . || return 1
  say "prep: $branch conflicts with $(git log -1 --format=%h "$1") by its rebase, but the fix recorded ahead of time (git rerere) resolves it"
}
# prep_say <the commit ahead>: a stacked build's rebase onto the one ahead stopped (aborted already): the prep line.
prepped=''
prep_say() {
  local key files base
  [ ${#rr[@]} -gt 0 ] && [ "$Q_AHEAD" != 0 ] || return 0
  key="$1 $pre $(prep_count)"
  [ "$key" != "$prepped" ] || return 0
  prepped=$key
  trial "$1" "$pre" && return 0
  files=$mt_files
  base=${under:-$(git merge-base "$1" "$pre")}
  say "prep: $branch will conflict with $Q_PREDNAME once $Q_PREDNAME ships; conflicted files: ${files:-none named}; record the fix against $1 from $base to $pre"
}
# <onto>: a scratch folder holding <onto>'s .gitattributes files (nested ones too), printed, for trial()'s merge-tree to
# run in. git reads attributes from the worktree it runs in, then its index, and git before 2.40 ignores attr.tree, which
# read the branch's there (#2071): so trial() runs it in this folder with an empty index, and every git reads <onto>'s
# as the rebase onto it will. Removed after the trial.
attrs_of() {
  local d m o p
  d=$(mktemp -d "${TMPDIR:-/tmp}/land-attrs.XXXXXX") && d=$(cd "$d" && pwd -P) || return 1
  # A symlink's text isn't read as attributes, so only plain files are copied.
  while IFS=$'\t' read -r -d '' m p; do
    read -r m _ o <<<"$m"
    case $m:/$p in 1006??:*/.gitattributes) ;; *) continue ;; esac
    mkdir -p "$d/$(dirname "$p")" && git cat-file blob "$o" >"$d/$p" || { rm -rf "$d"; return 1; }
  done < <(git ls-tree -r -z "$1")
  echo "$d"
}
# trial <onto> <commit>: git merge-tree's trial of that commit's rebase onto <onto> (from $under, with land_under). 1 on a
# conflict, its files (comma-separated) in $mt_files; a git that can't tell (exit 2 and up) counts as clean.
trial() {
  local out rc=0 at gd
  mt_files=''
  gd=$(git rev-parse --absolute-git-dir) && at=$(attrs_of "$1") || return 0
  out=$(top=$(git rev-parse --show-toplevel) && cd "$at" && LAND_TOP=$top GIT_INDEX_FILE=$at/.index land_git ours --git-dir="$gd" --work-tree="$at" merge-tree --write-tree --name-only --no-messages ${under:+"--merge-base=$under"} "$1" "$2" 2>/dev/null) || rc=$?
  rm -rf "$at"
  [ "$rc" = 1 ] || return 0
  mt_files=$(sed -n '2,${/^$/q;p}' <<<"$out" | sort -u | sed ':a;N;$!ba;s/\n/, /g')
  return 1
}

regen_hint=". If every conflicted file is a command's output (a reformat, a baseline, generated files), declare it instead: a commit with the trailers Regenerate: <command> and Regenerate-files: <those files>, and the ship makes them again after its rebase"
# The early check: whether <commit> (the branch as it was) would rebase onto $BRANCH's tip cleanly, by git merge-tree,
# which touches no worktree, index or ref. On a conflict it says the refusal, naming the files, and fails; a git that
# can't tell (too old, exit 2 and up) counts as clean, and the rebase itself decides. shortcut: a three-way merge, not a
# replay commit by commit. A branch that changes a line and changes it back can pass here and still stop in the
# rebase, which catches it as before; and a branch whose commit main already has as a cherry-pick, with a later commit
# on the same lines, is refused here though the rebase would skip it: the git rebase the refusal names then goes
# through clean. Upgrade to a replay if that bites.
# A third argument checks onto a build instead: --check --into build/<n>. With land_under, from $under, as the rebase's
# --onto leaves the rest behind; a conflict the fixes recorded with git rerere resolve counts as clean (conflict prep).
early_conflict() {
  local files onto=${3:-$BRANCH} fix
  under_of "$(git rev-parse "$1")"
  trial "refs/heads/$onto" "$1" && return 0
  files=$mt_files
  if rerere_covers "refs/heads/$onto" "$1"; then
    say "$branch conflicts with $onto by git merge-tree $2 (${files:-no files named}), but a fix recorded ahead of time (git rerere, conflict prep) resolves it"
    return 0
  fi
  case $mode in
    build) fix="Take $BRANCH in on your branch by hand (git merge $BRANCH), resolve it keeping both sides, run tools/land.sh --into $build --full, then this again" ;;
    into | full) fix="On conflicts: run git rebase $onto, resolve them keeping the other feeders' changes, re-test, commit, then run this again" ;;
    *) fix="On conflicts: run git rebase $BRANCH, resolve them keeping the other minions' changes, re-test, commit, then run this again" ;;
  esac
  [ "$mode" = build ] || fix+=$regen_hint
  say "$branch won't $([ "$mode" = build ] && echo "merge $onto in" || echo "rebase onto $onto") ($(git log -1 --format='%h "%s"' "refs/heads/$onto")) cleanly, by git merge-tree $2, so nothing landed${files:+; conflicted files: $files}. $fix"
  return 1
}

# --check: only the early check, changing nothing; exit 3 on a conflict, else 0. Citadel runs it at hand_off_land,
# with the land's own arguments.
check='' verify=''
[ "${1:-}" != --check ] || { check=1; shift; }
[ "${1:-}" != --verify ] || { verify=1; shift; }
mode=land build='' files=() # mode: land, into, full or build (the header's "Build branches")
case ${1:-} in
  '') ;;
  --into)
    build=${2:-}
    [[ $build =~ ^build/[1-9][0-9]{0,5}$ ]] || refuse "--into takes a build branch, build/<n>, then the test files the change touched (or --full)"
    shift 2
    mode=into
    if [ "${1:-}" = --full ]; then
      mode=full
      shift
      [ $# -eq 0 ] || refuse "--full runs the whole check and CI: name no test files with it"
    fi
    files=("$@") ;;
  --build) [ $# -eq 1 ] || refuse "--build takes nothing more: run it from the build minion's branch at the build's tip"; mode=build ;;
  *) refuse "takes no arguments besides --check, --verify, --lane, --into build/<n> <test files>, --into build/<n> --full and --build" ;;
esac
[ -z "$verify" ] || [ "$mode" = land ] || refuse "--verify takes no other arguments"
here=$(git rev-parse --show-toplevel)
cd "$here"
gitdir=$(git rev-parse --absolute-git-dir)
branch=$(git branch --show-current)
[ -z "$verify" ] || branch=verify LAND_KNOWN_RED='' LAND_FAST='' # its scratch branch is land/verify; it judges, so nothing is known red
if [ "$CONFLICT_PREP" = 1 ] && [ "$mode" = land ] && [ -z "$verify" ]; then
  rr=(-c rerere.enabled=true -c rerere.autoupdate=true -c rebase.updateRefs=false)
  # git turns rerere on everywhere once rr-cache exists, which these rebases make: keep it to this script.
  [ -n "$(git config --get rerere.enabled)" ] || git config rerere.enabled false 2>/dev/null || true
fi
# Regenerated files (#1827; Cara, 2026-11-24: "a way for them to make an update at the front of the CI queue to
# preemptively fix a foreseeable issue instead of having to wait for the queue to totally empty while constantly being
# kicked out"). A ship whose diff is a command's output (a reformat, a baseline, generated files) says so with trailers
# on its own commits:
#   Regenerate: <a command, run with bash from the repo's top>
#   Regenerate-files: <the files it writes, as .gitattributes patterns, space-separated>
# Every merge land_git makes for it then takes $BRANCH's side of those files instead of stopping on them (the
# land-regen driver keeps %A, the side being rebased onto, in a rebase and in merge-tree), so the early check passes it
# too; after the rebase each command runs again and what it wrote is committed (regen_run, in rebased_hook). A conflict
# in any other file stops as before. Such a ship holds the line (Q_HOLD) and ships alone. Land and --into only; the same
# as Citadel's tools/land.sh. shortcut: a modify/delete conflict in a declared file, or a .gitattributes merge= on one,
# still stops, and a hand edit to a declared file is lost when $BRANCH changed it too: declare only what the command writes.
regen_cmds=() regen_pats=()
if [[ $mode = land || $mode = into ]] && [ -z "$verify" ]; then
  regen_from=$BRANCH
  [ "$mode" = land ] || regen_from=refs/heads/$build
  mapfile -t regen_cmds < <(git log --reverse --format='%(trailers:key=Regenerate,valueonly,unfold)' "$regen_from..HEAD" | awk 'NF && !seen[$0]++')
  read -ra regen_pats <<<"$(git log --format='%(trailers:key=Regenerate-files,valueonly,unfold)' "$regen_from..HEAD" | tr '\n' ' ')" || true
  [ ${#regen_cmds[@]} -gt 0 ] || [ ${#regen_pats[@]} -eq 0 ] || refuse "$branch has a Regenerate-files: trailer but no Regenerate: <command> one: add the command that writes them (git commit --allow-empty with both trailers), then this again. Nothing landed"
  [ ${#regen_pats[@]} -gt 0 ] || [ ${#regen_cmds[@]} -eq 0 ] || refuse "$branch has a Regenerate: trailer but no Regenerate-files: <patterns> one naming what the command writes: add it (git commit --allow-empty with both trailers), then this again. Nothing landed"
  for p in "${regen_pats[@]}"; do
    case $p in '!'* | '#'* | *=*) refuse "Regenerate-files: takes plain .gitattributes patterns, not \"$p\". Nothing landed" ;; esac
  done
  if [ ${#regen_cmds[@]} -gt 0 ]; then
    if [ -z "$merge_dir" ]; then
      merge_dir=$gitdir/land-merge
      mkdir -p "$merge_dir"
      m_attr=$(git config core.attributesFile 2>/dev/null) || m_attr=${XDG_CONFIG_HOME:-$HOME/.config}/git/attributes
      { [ ! -f "${m_attr/#\~/$HOME}" ] || cat "${m_attr/#\~/$HOME}"; } >"$merge_dir/attributes"
    fi
    printf '%s land-regen merge=land-regen\n' "${regen_pats[@]}" >>"$merge_dir/attributes"
    [ "$mode" != land ] || Q_HOLD=1
  fi
fi
# --build ships the build whose tip the branch is at. After the recovery below, which may put the branch back.
find_build() {
  build=$(git for-each-ref --points-at HEAD --format='%(refname:lstrip=2)' 'refs/heads/build/')
  [[ ! $build =~ ^build/[1-9][0-9]{0,5}$ ]] || return 0
  [ -z "$check" ] || exit 0 # the land itself refuses it
  local ahead='' # one merge ahead of a build: $BRANCH merged in by hand
  [ -n "$build" ] || ! git rev-parse -q --verify HEAD^2 >/dev/null || ahead=$(git for-each-ref --points-at HEAD^1 --format='%(refname:lstrip=2)' 'refs/heads/build/' | head -n 1)
  [ -z "$ahead" ] || refuse "$branch is one merge ahead of $ahead (a merge of $BRANCH by hand): run tools/land.sh --into $ahead --full first, then this again. Nothing landed"
  refuse "$branch is not at the tip of a build branch${build:+ (it is at more than one: $(echo $build))}: bring it to its build's tip first (git merge --ff-only build/<n>). Nothing landed"
}
if [ -n "$check" ]; then
  { [ -n "$branch" ] && [ "$branch" != "$BRANCH" ]; } || exit 0 # the land itself refuses these
  [ "$mode" != build ] || find_build
  case $mode in
    land | build) early_conflict HEAD "at hand-off" || exit 3 ;;
    into)
      ! git show-ref -q --verify "refs/heads/$build" || claims_gate
      git merge-base --is-ancestor "refs/heads/$build" HEAD 2>/dev/null || ! git show-ref -q --verify "refs/heads/$build" || early_conflict HEAD "at hand-off" "$build" || exit 3 ;;
  esac
  exit 0 # --full: no rebase, so nothing to check
fi
# A landing that was killed outright left this worktree on its detached commit, and the branch where it was.
# Its third line names the landing that wrote it (pid and start time): while that one is alive, it is a landing still
# running here, not a killed one, and is left alone (KT7, #1519).
if [ -z "$branch" ] && [ -s "$gitdir/land-branch" ]; then
  { read -r branch; read -r left; read -r owner; } <"$gitdir/land-branch" || true
  [ -z "$owner" ] || [ "$(queue_proc "${owner%% *}")" != "$owner" ] ||
    refuse "a landing is still running in $here (pid ${owner%% *}) and has its HEAD detached on purpose, so this touched nothing. Wait for it to end, or stop it, then run this again"
  git rebase --abort 2>/dev/null || true
  # Anything committed here since would be lost with the detached commit, which may also hold other minions' unlanded work.
  [ "$(git rev-parse HEAD)" = "$left" ] || refuse "an earlier landing was stopped mid-way and left $here on a detached commit (${left:0:12}), and HEAD has moved since. If you committed here, put those commits on $branch (git checkout $branch, then git cherry-pick each one of yours); otherwise just git checkout $branch. Then run this again"
  git checkout -q "$branch" || refuse "an earlier landing was stopped mid-way and $here could not go back onto $branch (above); a person needs to look"
  say "an earlier landing here was stopped mid-way: $here is back on $branch as it was"
fi
rm -f "$gitdir/land-branch"
{ [ -n "$branch" ] && [ "$branch" != "$BRANCH" ]; } || refuse "run it from a minion's branch, not $BRANCH or a detached HEAD"
if [ "$mode" = build ]; then
  find_build
  ! git cat-file -e HEAD:build-claims.md 2>/dev/null || refuse "build-claims.md, the build's claims, is still on $branch and would ship to $BRANCH: git rm it, commit, run tools/land.sh --into $build (a docs-only merge), then this again. Nothing landed"
fi
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "$here has uncommitted changes: commit them first"
case $mode in
  land)
    # The guard: a branch on a build's commits (a feeder that ran the usual command) would put part of that build live.
    while read -r ref; do
      for mb in $(git merge-base --all HEAD "$ref" 2>/dev/null); do
        git merge-base --is-ancestor "$mb" "refs/heads/$BRANCH" ||
          refuse "$branch carries commits of ${ref#refs/heads/} that $BRANCH doesn't have, so landing it would put part of that build live; nothing landed. Merge it into the build instead: tools/land.sh --into ${ref#refs/heads/} <the test files you touched>"
      done
    done < <(git for-each-ref --format='%(refname)' 'refs/heads/build/')
    ;;
  into | full)
    [[ $branch != build/* ]] || refuse "run it from a feeder's branch or the build minion's own, not from a build branch"
    git show-ref -q --verify "refs/heads/$build" || refuse "$build doesn't exist: its build minion makes it (git branch $build $BRANCH), so nothing merged"
    for f in "${files[@]}"; do [ -f "$f" ] || refuse "$f is not a file in $here, so nothing merged: name the test files the change touched, from the worktree's top"; done
    claims_gate
    # This run changes the claims: its mark, until it ends (claims_inflight).
    if [ "$mode" = into ] && ! git diff --quiet "$(git merge-base "refs/heads/$build" HEAD)" HEAD -- build-claims.md; then
      claims_flag=$(claims_mark).$$ claims_new=$(claims_mark)-new.$$
      trap 'rm -f "$claims_flag" "$claims_new"' EXIT
      # Written whole, then moved into place: a feeder reading it half-written would take it for a dead one's, and drop it.
      queue_proc $$ >"$claims_new" && mv -f "$claims_new" "$claims_flag"
    fi
    ;;
esac
# The first path the branch changes since it forked from main that is the pipeline's own (tools/land.sh,
# tools/land.local.sh, .github/, the lanes map, PIPELINE_FILES' list from $BRANCH, or the branch's own while main has
# none) or matches a pattern given (bash case patterns, * matching / too).
pipeline_change() {
  local fork f p list=()
  fork=$(git merge-base "refs/heads/$BRANCH" HEAD 2>/dev/null) || { echo "(couldn't find where it forked from $BRANCH)"; return; }
  mapfile -t list < <(pipeline_pats "refs/heads/$BRANCH")
  while IFS= read -r -d '' f; do
    for p in "${list[@]}" "$@"; do
      case $f in $p) echo "$f"; return ;; esac
    done
  done < <(git diff --no-renames --name-only -z "$fork" HEAD) # -z: a non-ASCII path as it is, not quoted (Mandate #152)
}
# Fast mode (the header): the first such path, or one FAST_FULL names, keeps the full gate.
fast_full() { pipeline_change $FAST_FULL; }
FAST='' UNRUN=- # UNRUN: its ticket's verdict before CI has run
[ "$mode" = land ] || LAND_FAST='' # a whole build takes the full gate, and a merge into one isn't in the line
if [ "${LAND_FAST:-}" = 1 ]; then
  why=$(set -f; fast_full)
  if [ -z "$why" ] && { [ -z "$SMOKE_CMD" ] || [ "${LAND_SMOKE:-1}" = 0 ]; }; then why='a land with no smoke check'; fi
  if [ -z "$why" ]; then
    FAST=1 UNRUN=old CHECK='' LANES='' CI_ON='' CI_WORKFLOWS='' CI_STATUS='' CI_STACK=1 CI_LIMIT=0 CI_BATCH=1 BATCH='' BUILDERS=1 BISECT=0
    # Its ticket says "old" (a land.sh older than batches), so the batches of the gated landings around it never take
    # it in: it lands alone, with no CI run of theirs to wait for.
    say "fast mode: this lands on the smoke check alone; the full suite runs on $BRANCH behind it"
  else
    say "fast mode is on, but $why takes the full gate"
  fi
fi
# A build lands only as the head of the line, on $BRANCH itself, and alone: its ticket says "old" (queue_set), so no
# batch takes it in. The ones behind may still stack on it.
[ "$mode" != build ] || CI_STACK=1 CI_BATCH=1 BATCH='' UNRUN=old
# A ship that declares Regenerate files (#1827) holds the line and ships alone too: it builds on $BRANCH itself, so
# its command runs on the newest $BRANCH, and nobody's batch carries a ship past it.
if [ -n "$Q_HOLD" ]; then
  CI_STACK=1 CI_BATCH=1 BATCH='' UNRUN=old
  [ -n "$check" ] || say "$branch declares Regenerate files (${regen_pats[*]}), so it holds the line: it goes first among the waiters, alone, behind only ships a person placed"
fi
# A landing that changes the pipeline ships alone the same way: a batch would carry its untested land.sh into the
# others' landings, and a red in it would take them all down with it.
if [ -n "$BATCH" ] && [ "$mode" = land ]; then
  why=$(set -f; pipeline_change)
  [ -z "$why" ] || { CI_STACK=1 CI_BATCH=1 BATCH='' UNRUN=old; say "$why is part of the pipeline, so this ships alone, in no batch"; }
fi
# The main checkout is the first entry of the worktree list.
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
state=$(git -C "$MAIN" rev-parse --absolute-git-dir)
LOCK_FILE=${LOCK_FILE:-$state/land.lock} QUEUE_DIR=${QUEUE_DIR:-$state/land-queue}
[[ $LOCK_FILE == /* ]] || LOCK_FILE=$MAIN/$LOCK_FILE
[[ $QUEUE_DIR == /* ]] || QUEUE_DIR=$MAIN/$QUEUE_DIR

CI_REF=land/$branch
# The BUILD_WORKFLOWS this build's --full waits for, split by spaces, saying why a path-picked one is in or out.
build_lanes() {
  local e w pf list p f fork found out='' pats outs
  fork=$(git merge-base "refs/heads/$BRANCH" HEAD 2>/dev/null) || fork=''
  for e in $BUILD_WORKFLOWS; do
    w=${e%%:*} pf=${e#*:}
    if [ "$e" = "$w" ]; then out+=" $w"; continue; fi
    if ! list=$(git show "refs/heads/$BRANCH:$pf" 2>/dev/null || git show "HEAD:$pf" 2>/dev/null); then
      say "$w: $pf is on neither $BRANCH nor $branch, so it runs" && out+=" $w" && continue
    fi
    [ -n "$fork" ] || { say "$w: couldn't find where $branch forked from $BRANCH, so it runs" && out+=" $w" && continue; }
    pats=() outs=() found=''
    while read -r p _; do case $p in '' | '#'*) ;; '!'*) outs+=("${p#!}") ;; *) pats+=("$p") ;; esac; done <<<"$list"
    while IFS= read -r -d '' f; do
      for p in "${outs[@]}"; do case $f in $p) continue 2 ;; esac; done
      for p in "${pats[@]}"; do case $f in $p) found=$f && break 2 ;; esac; done
    done < <(git diff --no-renames --name-only -z "$fork" HEAD)
    if [ -n "$found" ]; then say "$w: $found is on $pf, so it runs" && out+=" $w"; else say "$w is not needed: the build changes nothing on $pf"; fi
  done
  echo "${out# }"
}
BUILD_LW=''
if [ "$mode" = full ] && [ -n "$BUILD_WORKFLOWS" ]; then
  BUILD_LW=$(set -f; build_lanes)
  # With no gate of its own, setup left CI no time (CI_LIMIT 0): the build's workflows get the usual limit.
  [ -z "$BUILD_LW" ] || [ -n "$CI_ON" ] || CI_LIMIT=${LAND_CI_TIMEOUT:-2700}
  CI_ON+=$BUILD_LW
fi
slug=''
if [ -n "$CI_ON" ]; then
  slug=$(git -C "$MAIN" remote get-url origin 2>/dev/null) || refuse "the CI gate is on, but there is no origin remote to run CI from"
  slug=${slug#*github.com[:/]} slug=${slug%.git}
fi
cilog="$state/land-ci-${branch//\//-}.log"
# Never holding the lock: a gh or git left hanging after its timeout mustn't keep it.
hub() { GH_PROMPT_DISABLED=1 GIT_TERMINAL_PROMPT=0 timeout 30 "$@" 9>&- 6>&-; }
# What is left of the login's hour of GitHub calls, which every caller on that login shares (Citadel #1722), so each CI wait
# says it and the next "API rate limit exceeded" has numbers: "<left>/<limit>, resets in <n> min", or "unknown". Free:
# GitHub doesn't count the rate_limit read itself.
gh_quota() {
  local l='' m='' r=''
  read -r l m r < <(hub gh api rate_limit --jq '.resources.core | "\(.remaining) \(.limit) \(.reset)"' 2>/dev/null) || true
  if [[ $l =~ ^[0-9]+$ && $m =~ ^[0-9]+$ ]]; then
    [[ $r =~ ^[0-9]+$ ]] && r=", resets in $(((r - $(date +%s) + 59) / 60)) min" || r=''
    echo "$l/$m$r"
  else echo unknown; fi
}

pre=$(git rev-parse HEAD) # the branch as it was: every build starts from here
base=''    # the commit the build sits on: main, or the commit of the one directly ahead
tip=''     # the build: $pre rebased onto $base, once it passed the check
blocked='' # why it can't land on $base (a conflict, a clash, a red check, red CI). Final only once it is the head
           # and $base is main: until then the fault may lie in an unlanded commit it sits on, so it waits.
           # shortcut: it waits for the ones ahead to land, not just to turn green; read their verdicts
           # from their tickets if a red landing holding up the ones behind it ever costs real time.
keep=''    # the rebased commit the branch moves to on the way out, if it sits on main by then
green='' pushed='' pushed_at='' late_sha='' late_at=0 late_seen='' retried='' flaked=0 ci_clock=0 ci_begun='' ci_last=-1 landed='' ci_skipped=''
ci_fail_n=0 ci_fail_at='' # how many polls in a row CI gave no answer to, and since when
ci_more=0 ci_more_keys='' # land_ci_more: the seconds it added to CI_LIMIT for this run, and the keys it gave them under
main_pushed='' # step 7 runs land_after only once this is set
made_up=() # land_after owed by earlier landings whose push failed, made up after this one's push (KT4)
lane=full lane_why='' ci_lane=full # this commit's lane (LANES), why, and the lane of the CI run it waits for
verdict=-  # CI's verdict on $tip, as its ticket says it: -, running, green or red
B_NUM=''   # with batches: which batch this one is in, from the head's (1); "Batches" below
fronted='' # with batches: it has been in the head's batch, so CI's limits count
g_last='' g_quiet='' # with batches, the head: when it last asked CI about the commit it lands, and since when with no answer
g_wait='' # ... and the commit whose green it waits on its own landing to run again, and since when

# The timing line: when each phase began ($SECONDS; '' for not yet), and the phase a refusal from here on is at.
# line: from getting in line to holding the lock (with batches: to its batch reaching the front); rebase: the rebase
# and the check; ci-queue: until a runner took the job; ci-run: until CI's verdict. A rebuild starts the last three over.
# A batch member that rides another's run (it never asks CI itself): ci-queue -, and ci-run from its batch reaching the
# front until the batch was green (ride, below).
T_start='' T_lock='' T_build='' T_built='' T_ci='' T_cirun='' T_gate='' at=smoke
ride() { [ -z "$BATCH" ] || [ -n "$T_ci" ] || T_cirun=${T_lock:-$SECONDS} T_gate=$SECONDS; }
SHIP_N=1 SHIP_M=1 # its place in its batch, and how many shipped with it (or, refused, were in its batch)
DEPLOY=none # the ship line's deploy state: none (no land_deploy), back, or what land_deploy printed (below)
ship_timing() (
  set +eu
  [ -n "$T_start" ] || exit 0 # refused before the line (the smoke check): no timing line, as Citadel's
  now=$SECONDS
  span() { if [ -n "$1" ]; then echo $((${2:-$now} - $1)); else echo -; fi; } # <start> [<end>, else now]
  if [ -n "$landed" ]; then out=landed
  elif [ "$1" = 1 ]; then out="refused at $at"
  else out="stopped at $at"; [ "$1" = 0 ] || out="$out (exit $1)"; fi
  [ "$SHIP_M" = 1 ] || out="$out · batch $SHIP_N of $SHIP_M"
  dir=${TIMING_LOG:-$state/land-log}/$(date -u +%F)
  mkdir -p "$dir" || exit 0
  [ -e "$dir/land.md" ] || printf '%s\n\n' '# Retro log: land.sh' "Written by the scheme's tools/land.sh (no session id, so one file per day): a timing line per landing that got in line, landed or not. Phase times in whole seconds, - for a phase never reached: line (waiting in line for the lock, or for its batch to reach the front), rebase (the rebase and the check), ci-queue (until a runner took the job), ci-run (until CI's verdict; for a batch member riding another's run, from its batch reaching the front until the batch was green)." >>"$dir/land.md"
  printf -- '- %sZ · timing · %s · line %s · rebase %s · ci-queue %s · ci-run %s · %s\n' "$(date -u +%T)" "$branch" \
    "$(span "$T_start" "$T_lock")" "$(span "$T_build" "$T_built")" "$(span "$T_ci" "${T_cirun:-$T_gate}")" \
    "$(span "$T_cirun" "$T_gate")" "$out" >>"$dir/land.md"
)
# However a landing ends: the timing line (best effort: a failure here never changes the outcome), then the ship line.
ship_end() {
  local what=refused c=${tip:-${keep:-$pre}}
  [ -z "$landed" ] || what=landed c=$keep
  ship_timing "$1" >/dev/null 2>&1 || true
  c=${c:0:12}
  echo "ship: $what ${c:--} batch $SHIP_N of $SHIP_M deploy $DEPLOY" >&2
}

# CI's verdict on [commit] ($tip if none) in [lane] ($ci_lane if none), by the exit codes in the header at CI_STATUS;
# what it found goes to $cilog. A lane that runs no CI is green. ci_verdict: the same, but red only on failures that
# aren't known reds (known_red); with those waived, it is the other workflows' (ci_open).
ci_verdict() {
  local rc=0
  ci_runs "$@" || rc=$?
  [ "$rc" = 1 ] || return "$rc"
  # A red only on known ids still waits for the workflows running beside it (said once they've all finished).
  if [ "$ci_open" = 0 ]; then known_red "CI on $(git rev-parse --short=12 "${1:-$tip}")" "${1:-$tip}" <"$cilog" || return 1; return 0; fi
  known_red x "${1:-$tip}" <"$cilog" 2>/dev/null || return 1
  return "$ci_open"
}

# known_red <what> [<commit>, else HEAD]: reads what failed on stdin; true when land_failures finds failures in it and
# every one is a known red (LAND_KNOWN_RED, the header) or, by land_main_red, red on $BRANCH's tip too, saying so.
known_red() {
  local id who all='' ids rest='' mr
  [ -n "${LAND_KNOWN_RED:-}" ] || declare -F land_main_red >/dev/null || return 1
  ids=$(land_failures | sed "s|^$here/||" | sort -u)
  [ -n "$ids" ] || return 1
  while IFS= read -r id; do
    who=$(awk -F'\t' -v i="$id" '$1 == i || index(i, $1 "::") == 1 { print $2; exit }' <<<"${LAND_KNOWN_RED:-}")
    if [ -n "$who" ]; then all+="; $id: known red, $who"; else rest+=$id$'\n'; fi
  done <<<"$ids"
  if [ -n "$rest" ]; then
    mr=$(main_red "${2:-$(git rev-parse HEAD)}" "${rest%$'\n'}") || return 1
    while IFS= read -r id; do
      [ -n "$id" ] || continue
      grep -qxF -- "$id" <<<"$mr" || return 1
      all+="; $id: red on $BRANCH's tip too"
    done <<<"$rest"
  fi
  say "$1 failed only on known reds, so it goes on${all/#;/:}"
}

# main_red <commit> <ids, one a line>: land.local.sh's land_main_red <$BRANCH's commit> <commit>, the ids on its stdin:
# prints those it says fail on $BRANCH's tip too. Once per pair of commits and ids (CI is asked every CI_POLL), kept
# in <state>/land-main-red for a day. Plain landings only, not --verify; a failed hook, or one on main itself, is none.
main_red() {
  local m key f rc=0
  declare -F land_main_red >/dev/null && [ "$mode" = land ] && [ -z "$verify" ] || return 1
  m=$(git rev-parse "refs/heads/$BRANCH") && [ "$m" != "$1" ] || return 1
  key=$(printf '%s\n' "$m" "$1" "$2" | sha1sum) && key=${key%% *} f=$state/land-main-red/$key
  if [ ! -e "$f" ]; then
    mkdir -p "$state/land-main-red" && find "$state/land-main-red" -type f -mmin +1440 -delete 2>/dev/null
    (cd "$here" && land_main_red "$m" "$1") <<<"$2" >"$f.$$" 9>&- 6>&- 7>&- &
    wait $! || rc=$?
    [ "$rc" = 0 ] || : >"$f.$$"
    mv -f "$f.$$" "$f"
  fi
  cat "$f"
}

# ci_open: the same verdict over the workflows that aren't red (0 when they're green), so a waived red waits for the rest.
ci_runs() {
  local sha=${1:-$tip} ln=${2:-$ci_lane} rc=0
  : >"$cilog"
  ci_skipped='' ci_open=0
  lane_ci "$ln" || return 0
  if [ -n "$CI_STATUS" ]; then
    timeout 120 bash -c "$CI_STATUS \"\$@\"" _ "$sha" ${LANES:+"$ln"} >"$cilog" 2>&1 9>&- 6>&- || rc=$?
    # Its lines for the other workflows keep a red from deciding: "<file>: no verdict …" for one that ended without one
    # (as the built-in reader's 4, which ranks above running), "<file>: in_progress …" or "… not started" for one going.
    if [ "$rc" = 1 ]; then
      if grep -Eq '^[[:space:]]*[^:[:space:]][^:]*: no verdict' "$cilog"; then ci_open=4
      elif grep -Eq '^[[:space:]]*[^:[:space:]][^:]*: (in_progress|queued|waiting|pending|requested|not started)' "$cilog"; then ci_open=2; fi
    fi
    return "$rc"
  fi
  ci_read "$sha"
}
# ci_read <commit>: the built-in reader over the workflows in LW (jobs LS may skip), appending to $cilog: ci_runs' verdict
# and ci_open.
ci_read() {
  local sha=$1 runs w path id status result url one failed skipped j rank worst=0 worst_rank=0 open_rank=0
  ci_open=0 ci_seen='' # ci_seen: the workflows with a run on the commit, a queued one too
  runs=$(hub gh api "repos/$slug/actions/runs?head_sha=$sha&per_page=100" --jq '.workflow_runs | sort_by(.created_at) | reverse | .[] | [.path, .id, .status, .conclusion // "-", .html_url] | @tsv' 2>>"$cilog") || return 5
  for w in $LW; do
    one=3
    while IFS=$'\t' read -r path id status result url; do
      [[ ${path%%@*} == */"$w" ]] || continue
      ci_seen+=" $w"
      case $status:$result in
        completed:success)
          # Green only when every job ran: a run whose jobs were skipped (an `if:` that came out false) concludes success too.
          if [ -z "$LS" ]; then
            skipped=$(hub gh api "repos/$slug/actions/runs/$id/jobs?per_page=100" --jq '[.jobs[] | select(.conclusion == "skipped")] | length' 2>>"$cilog") || return 5
          else # the lane's CI_SKIPS_<LANE> may be skipped: the others are counted, by name
            j=$(hub gh api "repos/$slug/actions/runs/$id/jobs?per_page=100" --jq '.jobs[] | select(.conclusion == "skipped") | .name' 2>>"$cilog") || return 5
            skipped=0
            while IFS= read -r j; do [ -z "$j" ] || [[ " $LS " == *" $j "* ]] || skipped=$((skipped + 1)); done <<<"$j"
          fi
          # Only a plain 0 is green; a count is told apart from no answer (ci_ask), which is handled as a lost run.
          if [ "$skipped" = 0 ]; then one=0; else one=4; [ "$skipped" -gt 0 ] 2>/dev/null && ci_skipped="$skipped of the jobs in $w's run"; fi ;;
        completed:failure)
          # Red when a step failed. A runner that went away mid-run fails its job with the step it was in never finished:
          # no verdict. A run with no jobs at all failed before any runner was asked (a workflow file GitHub can't read),
          # so it is red, never parked for the runners (KT6, #1519).
          j=$(hub gh api "repos/$slug/actions/runs/$id/jobs?per_page=100" --jq '"\(.jobs | length) \([.jobs[].steps[]? | select(.conclusion == "failure")] | length)"' 2>>"$cilog") || return 5
          read -r j failed <<<"$j"
          if [ "$failed" -gt 0 ] 2>/dev/null; then one=1
          elif [ "$j" = 0 ]; then one=1; echo "$w: its run failed before any job started (a workflow file or account problem, not a lost runner)" >>"$cilog"
          else one=4; fi ;;
        # GitHub's own word for a run that failed to start (a reusable workflow it can't find, a spending limit): red.
        completed:startup_failure) one=1; echo "$w: its run failed to start (startup_failure: a workflow file or account problem, not a lost runner)" >>"$cilog" ;;
        completed:timed_out) one=1 ;;
        completed:*) one=4 ;;
        in_progress:*) one=2 ;;
      esac
      echo "$w: $status $result $url" >>"$cilog"
      break # the newest run of this workflow on the commit
    done <<<"$runs"
    [ "$one" != 3 ] || echo "$w: not started on ${sha:0:12}" >>"$cilog"
    # The worst of the workflows: red, then no verdict, not started, running, green.
    case $one in 1) rank=4 ;; 4) rank=3 ;; 3) rank=2 ;; 2) rank=1 ;; *) rank=0 ;; esac
    [ "$rank" -le "$worst_rank" ] || worst=$one worst_rank=$rank
    [ "$one" = 1 ] || [ "$rank" -le "$open_rank" ] || ci_open=$one open_rank=$rank
  done
  return "$worst"
}

# green_note: $tip is green: the lane its run took, the commit the lane's range starts from and the known reds it was
# let past go in <state>/land-green/<tip> (a day's are kept), where a batch's head asking CI about it again reads them
# (batch_green). Without one (a full disk), the head asks without them.
green_note() {
  local d=$state/land-green
  mkdir -p "$d" && printf '%s %s\n%s' "$ci_lane" "$ci_from" "${LAND_KNOWN_RED:-}" >"$d/$tip.$$" && mv -f "$d/$tip.$$" "$d/$tip" || true
  find "$d" -type f -mmin +1440 -delete 2>/dev/null || true
}
ci_from=-

# The commit goes to the scratch branch, which starts CI on it. Deleted first: a push of the commit
# the branch already has (a run to repeat) would start nothing. Forced on purpose: only this script
# writes land/<branch>, so there is no one's work to overwrite. --no-verify: the check ran above.
# CI on $tip, begun: a run of this very commit that is green or going (its pull request's, say) will do;
# otherwise a new one.
# With lanes, a lane that runs no CI is green at once, with no push. With batches the run takes the lane of the batch's
# range, from the commit under its first member (B_BASE[1], from batch_look) to $tip; one not under $tip is full.
ci_start() {
  local rc=0 l
  ci_clock=$SECONDS ci_last=$SECONDS ci_fail_n=0 ci_begun='' T_ci=$SECONDS T_cirun='' T_gate='' at=ci ci_more=0 ci_more_keys='' ci_from=-
  if [ -n "$BATCH" ] && [ -n "$LANES" ]; then
    ci_from=${B_BASE[1]:--}
    l="full (${B_BASE[1]:--} is not under ${tip:0:12})"
    ! git merge-base --is-ancestor "${B_BASE[1]:--}" "$tip" 2>/dev/null || l=$(lane_of "${B_BASE[1]}" "$tip" "refs/heads/$BRANCH")
    ci_lane=${l%% *}
    say "its batch's run, from ${B_BASE[1]:0:12} up, takes lane ${l%% *}: ${l#* }"
  fi
  if ! lane_ci "$ci_lane"; then
    green=1 verdict=green T_gate=$SECONDS at=line
    green_note
    say "lane $ci_lane runs no CI, so nothing is pushed and ${tip:0:12} is green as checked"
    queue_set 5 green
    queue_phase "checked ${tip:0:12}: lane $ci_lane runs no CI"
    return 0
  fi
  ci_verdict || rc=$?
  case $rc in
    0) green=1 T_gate=$SECONDS at=line && rm -f "$state/ci-down" && green_note && say "CI already passed ${tip:0:12}" ;;
    2) say "CI is already running on ${tip:0:12}" ;;
    *) ci_push ;;
  esac
  verdict=running
  [ -z "$green" ] || verdict=green
  queue_set 5 "$verdict"
  queue_phase "waiting for CI on ${tip:0:12} since $(date +%H:%M)"
}

# With lanes the scratch branch is land/<lane>/<branch>: one a rebuild moved off (its lane changed) goes, with its runs.
ci_push() {
  local ref=land/$branch
  [ -z "$LANES" ] || ref=land/$ci_lane/$branch
  if [ "$ref" != "$CI_REF" ]; then
    [ -z "$pushed" ] || { ci_cancel; hub git push -q --no-verify origin ":refs/heads/$CI_REF" 2>/dev/null || true; }
    CI_REF=$ref
  fi
  [ -n "$pushed" ] || ci_cancel # what a landing of this branch that was killed left running (a landed one's runs go on)
  hub git push -q --no-verify origin ":refs/heads/$CI_REF" 2>/dev/null || true
  late_sha=$tip late_at=$SECONDS late_seen='' # before the push: a stop can end it once origin has it
  hub git push -q --no-verify origin "+$tip:refs/heads/$CI_REF" || { late_sha=''; refuse "couldn't push ${tip:0:12} to origin's $CI_REF, so CI can't run on it and nothing landed"; }
  pushed=1 pushed_at=$SECONDS ci_clock=$SECONDS ci_begun='' ci_more=0 ci_more_keys=''
  say "waiting for CI on ${tip:0:12} (origin's $CI_REF). GitHub calls left this hour: $(gh_quota)"
}

# Stops the scratch branch's runs nobody waits for now, so they don't hold a runner. Best effort. A run of a
# commit already on main is left to finish: main's CI may reuse what it passes.
ci_cancel() {
  local id sha
  while read -r id sha; do
    [ -z "$id" ] || [ "$sha" != "$late_sha" ] || [[ " $late_seen" = *" $id "* ]] || late_seen+="$id "
    [ -z "$id" ] || git merge-base --is-ancestor "$sha" "refs/heads/$BRANCH" 2>/dev/null || hub gh api -X POST "repos/$slug/actions/runs/$id/cancel" >/dev/null 2>&1 || true
  done < <(hub gh api "repos/$slug/actions/runs?branch=$CI_REF&per_page=20" --jq '.workflow_runs[] | select(.status != "completed") | [.id, .head_sha] | @tsv' 2>/dev/null)
}

# A CI outage is paid once: a landing that waited out a limit leaves <state>/ci-down ("<when> <why>"), so the ones of
# the next CI_DOWN seconds don't each wait to learn the same thing. ci_down <why> writes it; ci_down_fresh puts what
# to say into $down while it is fresh.
ci_down() { printf '%s %s\n' "$(date +%s)" "$1" >"$state/ci-down" 2>/dev/null || true; }
ci_down_fresh() {
  local at why now
  read -r at why 2>/dev/null <"$state/ci-down" || return 1
  now=$(date +%s)
  [[ $at =~ ^[0-9]+$ ]] && [ $((now - at)) -lt "$CI_DOWN" ] || return 1
  down="CI gave no answer to a landing $((now - at)) s ago ($why), so this one doesn't wait for it and nothing landed; CI is asked again from $(date -d "@$((at + CI_DOWN))" +%H:%M)"
}

# ci_red <what was red>: $tip is refused (the head of a red batch bisects).
ci_red() {
  say "$1"
  [ "$Q_AHEAD" = 0 ] || say "that commit sits on $Q_PREDNAME's, which hasn't landed: waiting to see whether it does before giving up"
  blocked="$1 (above), so $BRANCH is untouched. Fix it, commit, then run this again"
  keep=${bare:-$tip} verdict=red T_gate=$SECONDS
  queue_set 5 red
  # Nobody builds on a red commit. In a batch they already have: it stays, and the bisect finds where the fault is.
  [ -n "$BATCH" ] || { tip=''; queue_set 4 skip; }
  queue_phase "CI is red"
}

# ci_none <why it parks>: CI gave no answer about $tip. land.local.sh's land_fallback decides in its place, on this
# worktree (at $tip); without one, or when it can't tell either (exit 75), it parks, or with PARK_RETRIES asks again.
park_retried=0 # how many times this landing asked CI again where it would park (PARK_RETRIES)
ci_none() {
  local rc=0
  declare -F land_fallback >/dev/null || { park_retry "$1"; return 0; }
  say "${1%%, so nothing landed*}: land.local.sh's land_fallback decides in CI's place"
  queue_phase "running land_fallback on ${tip:0:12} since $(date +%H:%M)"
  (cd "$here" && LAND_PARK_RETRIED=$park_retried land_fallback "$tip") </dev/null >&2 9>&- 6>&- 7>&- &
  wait $! || rc=$?
  case $rc in
    0)
      green=1 verdict=green T_gate=$SECONDS at=line
      # Its word, where a batch's head asking CI about this commit again reads it (batch_green); a day's are kept.
      mkdir -p "$state/land-fallback" && find "$state/land-fallback" -type f -mmin +1440 -delete 2>/dev/null
      : >"$state/land-fallback/$tip"
      say "land_fallback passed ${tip:0:12} in CI's place"
      queue_set 5 green
      queue_phase "land_fallback passed ${tip:0:12}" ;;
    75) park_retry "land.local.sh's land_fallback gave no verdict either (exit 75): $1" ;;
    *) ci_red "land.local.sh's land_fallback failed on ${tip:0:12} in CI's place (exit $rc)" ;;
  esac
}

# park_retry <why it parks>: parks, unless PARK_RETRIES allows another ask: then a fresh CI run of the same commit (the
# ones stacked on it keep theirs), its place in line kept and CI's limits counted again.
park_retry() {
  [ "$park_retried" -lt "$PARK_RETRIES" ] || park "$1"
  park_retried=$((park_retried + 1))
  say "${1%%, so nothing landed*}: asking CI again in place instead of parking ($park_retried of $PARK_RETRIES)"
  retried='' ci_more=0 ci_more_keys=''
  ci_push
  queue_phase "waiting for CI on ${tip:0:12} again since $(date +%H:%M) ($park_retried of $PARK_RETRIES)"
}

# Asks CI about $tip, at most every CI_POLL seconds: sets green, refuses on red, repeats a lost run once, parks at the limits.
ci_ask() {
  local rc=0 waited busy down='' every=$CI_POLL
  # GitHub failing: asking faster only spends what is left of the hour, so each failed poll in a row waits a poll longer, up to 60 s.
  if [ "$ci_fail_n" -gt 0 ] && [ "$every" -lt 60 ]; then every=$((CI_POLL * (1 + ci_fail_n))); [ "$every" -le 60 ] || every=60; fi
  [ $((SECONDS - ci_last)) -ge "$every" ] || return 0
  ci_last=$SECONDS
  ci_verdict || rc=$?
  case $rc in
    [0-4]) ci_fail_n=0 ;;
    *) ci_fail_n=$((ci_fail_n + 1)); [ "$ci_fail_n" -gt 1 ] || ci_fail_at=$(date +%H:%M) ;;
  esac
  if [ -n "$pushed_at" ] && [ $((SECONDS - pushed_at)) -lt "$CI_GRACE" ]; then
    case $rc in 1 | 4) rc=3 ;; esac
  fi
  [ "$rc" != 2 ] || [ -n "$T_cirun" ] || T_cirun=$SECONDS
  case $rc in
    0)
      green=1 verdict=green T_gate=$SECONDS at=line
      rm -f "$state/ci-down"
      green_note
      say "CI is green on ${tip:0:12}"
      queue_set 5 green
      queue_phase "CI passed ${tip:0:12}"
      return 0 ;;
    1)
      cat "$cilog" >&2
      if [ "$flaked" -lt "$FLAKE_RUNS" ] && v=$(flaky <"$cilog"); then
        flaked=$((flaked + 1))
        if [ "$FLAKE_RUNS" = 1 ]; then
          say "CI's red on ${tip:0:12} was flakes only (land_flaky: ${v//$'\n'/, }): one fresh run, and only a green one passes"
        else
          say "CI's red on ${tip:0:12} was flakes only (land_flaky: ${v//$'\n'/, }): fresh run $flaked of $FLAKE_RUNS, keeping its place in line, and only a green one passes"
        fi
        ci_push
        queue_phase "waiting for CI on ${tip:0:12} again since $(date +%H:%M)"
        return 0
      fi
      suspect_of
      ci_red "CI is red on ${tip:0:12}"
      return 0 ;;
    4)
      cat "$cilog" >&2
      [ -z "$ci_skipped" ] || refuse "$ci_skipped on ${tip:0:12} were skipped, so the commit's checks did not all run and nothing landed. Nothing is wrong with the runners, and running it again would skip them again. A workflow with jobs that are skipped on purpose needs the scheme's own CI_STATUS script, or with lanes their names in the lane's CI_SKIPS_<LANE> (see the top of tools/land.sh)"
      [ -z "$retried" ] || { ci_none "CI's run on ${tip:0:12} ended without a verdict a second time (a runner lost mid-run, or the run cancelled), so nothing landed. The runners need a person's look; park, and run this again after"; return 0; }
      retried=1
      say "CI's run on ${tip:0:12} ended without a verdict (a runner lost mid-run, or the run cancelled): running it again, once. The commit is the same, so the ones stacked on it keep their runs"
      ci_push
      queue_phase "waiting for CI on ${tip:0:12} again since $(date +%H:%M)"
      return 0 ;;
  esac
  [ "$Q_AHEAD" = 0 ] || [ "$B_NUM" = 1 ] || return 0 # the limits count at the front: the head, or with batches the head's batch
  waited=$((SECONDS - ci_clock))
  [ "$rc" != 2 ] || ci_begun=1
  # Under a fresh note, not before CI_GRACE after the push: GitHub may not have handed the run to a runner yet, and
  # until then a red or lost verdict shows as rc 3 (above).
  if [ -z "$ci_begun" ] && { [ "$waited" -ge "$CI_START" ] || { [ "$rc" = 3 ] && { [ -z "$pushed_at" ] || [ $((SECONDS - pushed_at)) -ge "$CI_GRACE" ]; } && [ "$park_retried" = 0 ] && ci_down_fresh; }; }; then
    [ "$ci_fail_n" != 1 ] || return 0 # one missed answer: asked again
    cat "$cilog" >&2
    [ "$rc" = 3 ] || { ci_none "CI gave no answer about ${tip:0:12} for $(((CI_START + 59) / 60)) min (exit $rc from ${CI_STATUS:-gh}; above), so nothing landed. That is GitHub or this box's gh login, not the runners or the branch: a person needs to look. Park, and run this again after"; return 0; }
    # Runs going elsewhere in the repo mean the runners are there and busy (the ones stacked behind this, say): the
    # run is waiting its turn. CI_LIMIT still ends the wait.
    busy=$(hub gh api "repos/$slug/actions/runs?status=in_progress&per_page=1" --jq .total_count 2>/dev/null) || busy=0
    if [ "$busy" -gt 0 ] 2>/dev/null; then
      say "CI hasn't started on ${tip:0:12} yet, but the runners are busy with other runs: still waiting"
      ci_begun=1
      return 0
    fi
    [ -z "$down" ] || { ci_none "$down. Park, and run this again once a person says the runners are back"; return 0; }
    ci_down "no runner started CI on ${tip:0:12} within $(((CI_START + 59) / 60)) min"
    ci_none "no runner has started CI on ${tip:0:12} within $(((CI_START + 59) / 60)) min (the machine they run on is probably off or asleep), so nothing landed. Park, and run this again once a person says the runners are back"
    return 0
  fi
  if [ "$waited" -ge $((CI_LIMIT + ci_more)) ]; then
    # One missed answer is not a verdict, so it asks again; a run of them is GitHub's, and no word about the runners (#1655).
    [ "$ci_fail_n" != 1 ] || return 0
    ! ci_more_ask || return 0
    cat "$cilog" >&2
    [ "$ci_fail_n" = 0 ] || { ci_none "GitHub didn't answer since $ci_fail_at ($ci_fail_n polls failed in a row; exit $rc from ${CI_STATUS:-gh}; above), so nothing landed, and whether CI on ${tip:0:12} finished isn't known. That is GitHub or this box's gh login, not the runners or the branch. Park, and run this again once GitHub answers"; return 0; }
    ci_down "CI on ${tip:0:12} didn't finish within $(((CI_LIMIT + 59) / 60)) min"
    ci_none "CI on ${tip:0:12} hasn't finished within $(((CI_LIMIT + 59) / 60)) min, so nothing landed. Park, and run this again later"
  fi
}

# ci_more_ask: CI on $tip ran past CI_LIMIT (and what land_ci_more gave it): 0 when land_ci_more gives it more time. It
# prints "<seconds> <key> <why>", each key at most once a run, so a reason can't add time twice; anything else is no.
ci_more_ask() {
  local rc=0 out s k why
  declare -F land_ci_more >/dev/null || return 1
  out=$(mktemp) || return 1
  (cd "$here" && land_ci_more "$tip" "${ci_more_keys# }") </dev/null >"$out" 9>&- 6>&- 7>&- &
  wait $! || rc=$?
  read -r s k why <"$out" 2>/dev/null || true
  rm -f "$out"
  [ "$rc" = 0 ] && [[ $s =~ ^[1-9][0-9]{0,5}$ ]] && [[ $k =~ ^[A-Za-z0-9_.-]+$ ]] && [[ " $ci_more_keys " != *" $k "* ]] || return 1
  ci_more=$((ci_more + s)) ci_more_keys+=" $k"
  say "CI on ${tip:0:12} ran past its $(((CI_LIMIT + 59) / 60)) min, but land_ci_more gives it ${s}s more ($k: ${why:-no reason given})"
  queue_phase "waiting for CI on ${tip:0:12}, ${s}s more for $k, since $(date +%H:%M)"
}

# check_run <command> <log>: the check, under the check lock, into <log>; its exit code.
check_run() {
  local rc=0
  queue_phase "waiting to run the check"
  rm -f "$2" # the check makes it as it starts: none afterwards means the check lock never came
  # It runs under the lock when this is the head, so it has a time limit (LAND_CHECK_TIMEOUT, in seconds), and
  # 9>&- keeps a process it leaves running from holding the lock after this script ends. One check at a time,
  # under a lock of its own (fd 7): the ones stacked behind the head check too, and the box is shared.
  (
    flock -w "$CHECK_WAIT" 7 || exit 1
    queue_phase "running the check since $(date +%H:%M)"
    timeout -k 30 "$CHECK_LIMIT" bash -c "$1" >"$2" 2>&1 9>&- 7>&- 6>&-
  ) 7>"$state/land-check.lock" 9>&- 6>&- || rc=$? # 9>&-: this subshell outlives a killed landing, and mustn't keep its lock
  [ "$rc" = 0 ] || [ -e "$2" ] || refuse "the check lock ($state/land-check.lock) was still taken after ${CHECK_WAIT}s, so the check never ran and nothing landed: $(check_holder). A person needs to look at it before anyone tries again"
  return "$rc"
}

# flaky: land.local.sh's land_flaky on the red output on stdin; 0 (printing which) when it says flakes only.
flaky() { declare -F land_flaky >/dev/null && (land_flaky) 9>&- 6>&- 7>&-; }

# The land_preflight hook and GUARD_CMD on the commit just built, not on the light lane: 1 (blocked set) on a refusal.
guards() {
  local rc=0 log
  [ "$lane" != light ] || return 0
  if declare -F land_preflight >/dev/null; then
    queue_phase "running land_preflight"
    (cd "$here" && land_preflight "$(git rev-parse HEAD)" "$lane") </dev/null >&2 9>&- 6>&- 7>&- &
    wait $! || rc=$?
    if [ "$rc" != 0 ]; then
      keep=${bare:-$(git rev-parse HEAD)}
      blocked="land.local.sh's land_preflight refused $(git rev-parse --short=12 HEAD) (exit $rc, above), so $BRANCH is untouched"
      return 1
    fi
  fi
  [ -n "$GUARD_CMD" ] || return 0
  queue_phase "running the guards"
  log="$state/land-guards-${branch//\//-}.log"
  timeout -k 10 "$GUARD_TIMEOUT" bash -c "$GUARD_CMD" >"$log" 2>&1 </dev/null 9>&- 6>&- 7>&- || rc=$?
  case $rc in
    0) ;;
    2 | 124 | 137) say "the guards didn't decide (exit $rc$([ "$rc" = 2 ] || echo ", past ${GUARD_TIMEOUT}s")), so the check decides" ;;
    *)
      tail -n 40 "$log" >&2
      keep=${bare:-$(git rev-parse HEAD)}
      blocked="the guards ($GUARD_CMD) failed on the rebased branch (exit $rc, full log: $log), so $BRANCH is untouched"
      return 1 ;;
  esac
}

# note_branch <commit>: the branch, the commit this leaves the worktree on and who wrote it: how the next run puts things
# back if this one is killed, and knows it isn't while it runs.
note_branch() { printf '%s\n' "$branch" "$1" "$(queue_proc $$)" >"$gitdir/land-branch"; }

# regen_run <command> <patterns...>: run a Regenerate command (above) on the branch just rebased and commit what it
# changed, if anything. It may change only files the patterns (all the branch declared) name: when it fails or writes
# elsewhere, the worktree is put back and it fails (1, hook_failed set). Its fds 6, 7 and 9 (the locks) are closed, so
# a process it leaves behind can't hold the line.
regen_run() {
  local cmd=$1 log rc=0 was chk out=() bad=() new=() why n
  shift
  was=$(git -c core.quotePath=false ls-files --others --exclude-standard)
  log=$(mktemp "${TMPDIR:-/tmp}/land-regen.XXXXXX")
  say "making $* again on $(git rev-parse --short HEAD): $cmd"
  (cd "$(git rev-parse --show-toplevel)" && timeout "${LAND_REGEN_TIMEOUT:-900}" bash -c "$cmd") </dev/null >"$log" 2>&1 9>&- 7>&- 6>&- || rc=$?
  mapfile -t new < <(comm -13 <(sort <<<"$was") <(git -c core.quotePath=false ls-files --others --exclude-standard | sort) | awk NF)
  mapfile -t out < <({ git -c core.quotePath=false diff --name-only HEAD; printf '%s\n' "${new[@]}"; } | awk 'NF && !seen[$0]++')
  if [ ${#out[@]} -gt 0 ]; then
    chk=$gitdir/land-regen-check.attributes
    printf '%s land-regen\n' "$@" >"$chk"
    mapfile -t bad < <(printf '%s\n' "${out[@]}" | git -c "core.attributesFile=$chk" check-attr --stdin land-regen | awk -F': ' '$NF != "set" { print $1 }')
  fi
  if [ "$rc" != 0 ] || [ ${#bad[@]} -gt 0 ]; then
    git reset -q --hard HEAD 9>&- 6>&-
    [ ${#new[@]} -eq 0 ] || git --literal-pathspecs clean -fq -- "${new[@]}"
    why=$(tail -n 5 "$log" | tr '\n' ' ')
    rm -f "$log"
    if [ "$rc" != 0 ]; then
      say "the Regenerate command \`$cmd\` $([ "$rc" = 124 ] && echo "ran past ${LAND_REGEN_TIMEOUT:-900} s" || echo "failed (exit $rc)") on the rebased branch, and what it wrote was put back${why:+. Its output ended: $why}. Run it on your rebased branch, fix it, commit"
    else
      say "the Regenerate command \`$cmd\` changed files outside Regenerate-files ($*): $(echo "${bad[@]}"), and they were put back. Add them to Regenerate-files: or stop the command writing them"
    fi
    hook_failed='the Regenerate command'
    return 1
  fi
  rm -f "$log"
  [ ${#out[@]} -gt 0 ] || return 0
  git --literal-pathspecs add -A -- "${out[@]}"
  n=$(sed -nE 's#^ticket/([0-9]+)(-.*)?$#\1#p' <<<"$branch")
  git diff --cached --quiet || git commit -q -m "${n:+#$n: }regenerated at ship time: $cmd" -m "Made again on the rebased branch by tools/land.sh (#1827)." 9>&- 6>&-
}
hook_failed=''
# The Regenerate commands, then land.local.sh's land_rebased <base> <branch>, if it has one: on the branch just rebased onto
# <base>, before its check, in this worktree; a commit it makes ships with the branch. 1: one failed or left uncommitted
# changes (dropped here).
# bare: the commit under what they made ('' when they made none). A branch that doesn't ship goes back to that: the next
# try makes their commits again, and the lost-title check took one left behind for the branch's own (#1866).
bare=''
rebased_hook() {
  local c rc=0 new untracked
  local -x GIT_REFLOG_ACTION=land_rebased # on what is made here, for into_left
  hook_failed=''
  bare=$(git rev-parse HEAD)
  if [ ${#regen_cmds[@]} -gt 0 ]; then
    queue_phase "making the Regenerate files again"
    for c in "${regen_cmds[@]}"; do regen_run "$c" "${regen_pats[@]}" || return 1; done
    [ ! -e "$gitdir/land-branch" ] || note_branch "$(git rev-parse HEAD)"
  fi
  if ! declare -F land_rebased >/dev/null; then
    [ "$(git rev-parse HEAD)" != "$bare" ] || bare=''
    return 0
  fi
  untracked=$(git ls-files -o --exclude-standard)
  queue_phase "running land_rebased"
  # In the background and waited on, so set -e holds inside it.
  (cd "$here" && land_rebased "$1" "$branch") </dev/null >&2 9>&- 6>&- &
  wait $! || rc=$?
  [ ! -e "$gitdir/land-branch" ] || note_branch "$(git rev-parse HEAD)"
  if [ "$rc" != 0 ]; then
    say "land.local.sh's land_rebased failed (exit $rc)"
  elif [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    say "land.local.sh's land_rebased left changes it didn't commit, which are dropped: it commits what should ship"
    rc=1
  elif new=$(comm -13 <(sort <<<"$untracked") <(git ls-files -o --exclude-standard | sort)) && [ -n "$new" ]; then
    say "land.local.sh's land_rebased made files it didn't commit (${new//$'\n'/, }), so they wouldn't ship: it adds and commits what should ship"
    rc=1
  fi
  [ "$rc" = 0 ] || { git reset -q --hard HEAD 9>&- 6>&-; hook_failed="land.local.sh's land_rebased"; }
  [ "$(git rev-parse HEAD)" != "$bare" ] || bare=''
  return "$rc"
}

# titles <what a refusal leaves> <git log's range...>: commit titles (#1489). A rebase stopped on a conflict and continued
# with GIT_EDITOR=true reads "#N: ..." as a comment and drops it. A commit with an empty subject, or none starting "#N"
# while a sibling has one, is refused by name. A read that fails refuses: passing would skip the check (#1626).
titles() {
  local kept=$1 subs empty lost
  shift
  subs=$(git log --no-merges --format='%h %s' "$@") || refuse "could not read the commits of $branch ($*: git log failed, above), so their titles are unchecked: $kept. Run this again; if it keeps failing, a person needs to look"
  # grep finding nothing exits 1, which pipefail would turn into the script's own exit: each ends in || x=''.
  empty=$(grep -E '^[0-9a-f]+ *$' <<<"$subs" | head -n 1) || empty=''
  if grep -qE '^[0-9a-f]+ (WIP )?#[0-9]+' <<<"$subs"; then
    # Some commit starts "#N", so the ones that don't lost it.
    lost=$(grep -vE '^[0-9a-f]+ (WIP )?#[0-9]+' <<<"$subs" | head -n 1) || lost=''
    [ -z "$lost" ] || refuse "commit ${lost%% *} (\"${lost#* }\") lost its #N: title, which a rebase continued with GIT_EDITOR=true drops, so $kept: reword it (git rebase -i, or git commit --amend) to start with #N:, then run this again"
  elif [ -n "$empty" ]; then
    # No title starts "#N" (a scheme whose titles end in "(#N)"): only the empty one is the lost title.
    refuse "commit ${empty%% *} has an empty subject, which a rebase continued with GIT_EDITOR=true can leave behind when it drops a title, so $kept: give it a subject in this scheme's title style (git rebase -i, or git commit --amend), then run this again"
  fi
}

# The branch as it was, rebased onto <commit> and checked: sets base, and tip when it passed (with the
# CI gate on, CI then runs on it), or blocked when it can't sit on that commit.
build() {
  local want=$1 on phase rc=0 clashes fork log chk v reuse=''
  [ -z "$pushed" ] || ci_cancel # its run is on a commit that will never land now
  base=$want tip='' blocked='' keep='' bare='' green='' retried='' flaked=0 pushed_at='' verdict=-
  T_build=$SECONDS T_built='' T_ci='' T_cirun='' T_gate='' at=rebase
  queue_set 4 -
  queue_set 5 "$UNRUN"
  queue_set 6 "$want"
  if [ "$Q_AHEAD" = 0 ]; then
    on="$BRANCH ($(git log -1 --format='%h "%s"' "$want"))" phase="rebasing onto $BRANCH"
  else
    phase="rebasing onto $Q_PREDNAME's commit"
    on="$Q_PREDNAME's commit ${want:0:12}, $(queue_ordinal $((Q_AHEAD + 1))) in line: CI runs on both at once, and this lands once $Q_PREDNAME has"
  fi
  [ "$mode" != build ] || phase="merging $BRANCH into $build"
  queue_phase "$phase"
  if [ "$mode" = build ]; then say "merging $on into $build on $branch"; else say "rebasing $branch onto $on"; fi
  note_branch "$pre"
  # 9>&- on git: a git gc --auto it starts detaches, and mustn't keep the lock.
  git checkout -q --detach "$pre" 9>&- 6>&-
  if [ "$mode" = build ]; then
    # A build takes $BRANCH in by merge: a rebase would flatten its merges of $BRANCH and change its feeders' commits.
    if git merge-base --is-ancestor "$want" HEAD || land_git theirs merge -q -m "Merge $BRANCH into $build" "$want" 9>&- 6>&-; then
      note_branch "$(git rev-parse HEAD)"
    else
      git merge --abort 2>/dev/null || true
      blocked="merging $BRANCH into $build failed (see git's output above), so nothing landed. Take $BRANCH in on your branch by hand (git merge $BRANCH), resolve it keeping both sides, run tools/land.sh --into $build --full, then this again"
      return 0
    fi
  elif land_rebase "$want" 9>&- 6>&-; then
    note_branch "$(git rev-parse HEAD)"
  else
    git rebase --abort 2>/dev/null || true # nothing to abort if it never started
    prep_say "$want"
    blocked="the rebase onto $BRANCH failed (see git's output above), so nothing landed. On conflicts: run git rebase $BRANCH, resolve them keeping the other minions' changes, re-test, commit, then run this again$regen_hint"
    return 0
  fi

  at=check
  queue_phase "checking numbered things"
  fork=$(git merge-base "$want" "$pre")
  clashes=$(numbered_clashes "$want" "$fork" "$pre") || rc=$?
  if [ "$rc" != 0 ]; then
    printf '%s\n' "$clashes" | sed 's/^/land:   /' >&2
    [ "$rc" != 2 ] || refuse "fix that line in $FACTS (commit it on this branch), then run this again. Nothing landed and $branch is back where it was"
    [ "$rc" = 1 ] || refuse "the numbered-things check itself failed (exit $rc), so nothing landed and $branch is back where it was; a person needs to look"
    blocked="this branch takes a number $BRANCH already has (above), so nothing landed and $branch is back where it was. Renumber yours past $BRANCH's highest (bump the version past $BRANCH's), commit, then run this again"
    return 0
  fi

  queue_phase "checking for landings it undoes"
  rc=0
  clashes=$(undo_guard "$want") || rc=$?
  if [ "$rc" != 0 ]; then
    [ "$rc" = 1 ] || refuse "the undo check itself failed (exit $rc, above), so nothing landed and $branch is back where it was; a person needs to look"
    printf 'land: %s\n' "$branch removes what these landed, without naming them:" "$clashes" >&2
    refuse "nothing landed and $branch is back where it was. A squash onto a newer $BRANCH keeps the branch's old files, which reverts what landed since (git reset --soft from a branch that started further back). Find the branch's last commit before the squash (git reflog), rebase that onto $BRANCH, and squash only then: git reset --soft \$(git merge-base HEAD $BRANCH). If the undo is meant, add a line \"Undoes: <sha>\" to a commit message for each commit above, then run this again"
  fi

  # Not in --build mode (#1698): feeders' commits are already merged and their hashes can't be reworded, so a mix passes.
  [ "$mode" = build ] || titles "nothing landed and $branch is back where it was" "$want..HEAD"

  # Its lane, over what it changes on $want, and that lane's check.
  lane=full lane_why='' chk=$CHECK
  if [ -n "$LANES" ]; then
    read -r lane lane_why <<<"$(lane_of "$want" HEAD "refs/heads/$BRANCH")"
    say "lane $lane: $lane_why"
    case $lane in light) chk=$CHECK_LIGHT ;; full) ;; *) v=CHECK_${lane^^} && chk=${!v-$CHECK} ;; esac
  fi
  ci_lane=$lane
  if [ -n "$chk" ] && [ -n "$early_on" ] && [ "$want" = "$early_on" ] && [ "$chk" = "$early_cmd" ] && [ "$(git rev-parse 'HEAD^{tree}')" = "$early_tree" ]; then
    reuse=1 # the early check's commit already holds what land_rebased made
  elif [ "$mode" = land ] && ! rebased_hook "$want"; then
    blocked="$hook_failed failed on the rebased branch (above), so $BRANCH is untouched"
    return 0
  fi
  if [ -n "$reuse" ]; then
    # The early check passed this same rebase onto this same commit: its commit (with any the check made) is the build.
    git checkout -q --detach "$early_tip" 9>&- 6>&-
    bare=$early_bare
    note_branch "$early_tip"
  fi
  guards || return 0
  if [ -z "$chk" ]; then
    [ -n "$FAST" ] || say "lane $lane runs no check"
  elif [ -n "$reuse" ]; then
    say "the check passed on this same rebase before the line and $BRANCH hasn't moved since, so it doesn't run again"
  else
    say "running $chk"
    log="$state/land-check-${branch//\//-}.log"
    check_run "$chk" "$log" || rc=$?
    if [ "$rc" != 0 ] && [ "$rc" != 124 ] && [ "$rc" != 137 ] && v=$(flaky <"$log"); then
      say "the check's red was flakes only (land_flaky: ${v//$'\n'/, }): running it once more, and only a green run passes"
      cp "$log" "$log.first"
      rc=0
      check_run "$chk" "$log" || rc=$?
    fi
    if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
      echo "land: the check ran past ${CHECK_LIMIT}s and was stopped: something in it hung" >>"$log" # the tail below shows it
    fi
    if [ "$rc" != 0 ] && { [ "$rc" = 124 ] || [ "$rc" = 137 ] || ! known_red "the check" <"$log"; }; then
      tail -n 40 "$log" >&2
      keep=${bare:-$(git rev-parse HEAD)}
      blocked="the check failed on the rebased branch (full log: $log), so $BRANCH is untouched"
      return 0
    fi
  fi

  tip=$(git rev-parse HEAD) T_built=$SECONDS at=line
  if [ -n "$BATCH" ]; then
    queue_phase "checked ${tip:0:12}: CI runs on its batch's top"
  elif [ -n "$CI_ON" ]; then
    ci_start
  fi
  queue_set 4 "$tip"
}

# Batches (CI_BATCH over 1; the header at "Batches"). batch_look walks the line from the head: the ones ahead as
# queue_look saw them, this one, then the ones behind, leaving out the gone, the skipped and the stopped, as
# queue_look does ahead, and the landed (B_ON): a landed batch's members leave one by one, and the batches behind must
# not be cut anew, with another top pushing a run, at each. It sets B_NUM (this one's batch, from the head's, 1), B_I (its place in the batch, from 1),
# B_LABEL, B_SHA, B_VER, B_BASE and B_PID (each member's, from 1), and B_RED when a ticket ahead of this one is red.
batch_add() { # <label> <commit> <verdict> <base> <pid and start>: the next in line joins the last batch, or starts one
  if [ "$B_N" != 0 ] && { [ "$3" = old ] || [ "$B_N" = "$CI_BATCH" ]; }; then
    B_AT=$((B_AT + 1)) B_N=0 B_LABEL=('') B_SHA=('') B_VER=('') B_BASE=('') B_PID=('')
  fi
  B_N=$((B_N + 1))
  [ "$3" != old ] || B_N=$CI_BATCH # a land.sh older than batches is a batch of its own
  B_LABEL+=("$1") B_SHA+=("$2") B_VER+=("$3") B_BASE+=("$4") B_PID+=("$5")
}

# B_ON[<commit>]: 1 for one on $BRANCH, 0 for one that isn't, as of B_MAIN, $BRANCH's commit. While B_MAIN's deploy runs
# (it may go back) or with this one's own commit on it (batch_landed's), no one counts as landed.
declare -A B_ON=()
B_MAIN=''
batch_main() {
  local m st=''
  m=$(git rev-parse "refs/heads/$BRANCH")
  [ "$m" = "$B_MAIN" ] || B_MAIN=$m B_ON=()
  B_SKIP=1
  ! batch_on "${tip:--}" || B_SKIP=''
  read -r st _ 2>/dev/null <"$state/land-deploy/$m" || true
  [ "$st" != running ] || B_SKIP=''
}
batch_on() { # <commit>
  [[ $1 =~ ^[0-9a-f]{40,}$ ]] || return 1
  [ -n "${B_ON[$1]:-}" ] || { B_ON[$1]=0 && ! git merge-base --is-ancestor "$1" "$B_MAIN" 2>/dev/null || B_ON[$1]=1; }
  [ "${B_ON[$1]}" = 1 ]
}
batch_left() { [ -n "$B_SKIP" ] && batch_on "$1"; } # <commit>: landed, so out of the line

batch_look() {
  local e t l label sha ver bas pid p st behind=''
  batch_main
  B_AT=1 B_N=0 B_LABEL=('') B_SHA=('') B_VER=('') B_BASE=('') B_PID=('') B_RED=''
  for e in "${Q_LINE[@]}"; do
    read -r label sha ver bas pid <<<"$e"
    ! batch_left "$sha" || continue
    [ "$ver" != red ] || B_RED=1
    batch_add "$label" "$sha" "$ver" "$bas" "$pid"
  done
  batch_add "$branch" "${tip:--}" "$verdict" "${base:--}" "$Q_ME"
  B_NUM=$B_AT B_I=$B_N SHIP_N=$B_N
  for t in "${Q_ORDER[@]}"; do
    [ "$B_N" -lt "$CI_BATCH" ] || break
    [ -n "$behind" ] || { [ "$t" != "$Q_N" ] || behind=1; continue; } # the ones behind this one, in queue_look's order
    mapfile -t l 2>/dev/null <"$Q_DIR/$t" || continue
    [ -n "${l[0]:-}" ] && queue_proc "${l[0]%% *}" p && [ "$p" = "${l[0]}" ] && [ "${l[4]:-}" != skip ] || continue
    if [ "${l[1]:-0}" = 0 ] && { queue_state "${l[0]%% *}" st; [[ $st == [Tt] ]]; }; then continue; fi
    ! batch_left "${l[4]:--}" || continue
    [[ ${l[5]:-} =~ ^(-|running|green|red)$ ]] || break # older than batches, fast mode's or another script's: the next batch
    batch_add "${l[2]:-?}" "${l[4]:--}" "${l[5]}" "${l[6]:--}" "${l[0]}"
  done
  SHIP_M=$B_N
}

# land.local.sh's land_suspect (the header): this one's CI is red and members of its batch sit below it, so the hook
# guesses which member turned it red, from the failure ids in $cilog. Its answer goes in <state>/land-suspect/<tip>
# (a day's are kept), where every member's batch_mid reads it. A failure or an answer that isn't a member's commit is
# said, and the bisect halves as always: a guess never refuses a landing.
suspect_of() {
  local i rc=0 out c d=$state/land-suspect
  local -a m=()
  declare -F land_suspect >/dev/null && [ -n "$BATCH" ] && [ "${B_I:-1}" -gt 1 ] && [ "${B_SHA[B_I]:-}" = "$tip" ] || return 0
  for ((i = 1; i <= B_I; i++)); do m+=("${B_SHA[i]}"); done
  out=$(mktemp) || return 0
  (cd "$here" && land_suspect "${B_BASE[1]}" "${m[@]}") < <(land_failures <"$cilog" | sed "s|^$here/||" | sort -u) >"$out" 9>&- 6>&- 7>&- &
  wait $! || rc=$?
  c=$(tail -n 1 "$out")
  rm -f "$out"
  [ "$rc" = 0 ] || { say "land.local.sh's land_suspect failed (exit $rc), so the red batch's bisect halves"; return 0; }
  [ -n "$c" ] || return 0
  for ((i = 1; i <= B_I; i++)); do
    [ "${B_SHA[i]}" = "$c" ] || continue
    mkdir -p "$d" && find "$d" -type f -mmin +1440 -delete 2>/dev/null
    echo "$c" >"$d/$tip.$$" && mv -f "$d/$tip.$$" "$d/$tip"
    say "land_suspect guesses ${B_LABEL[i]} (${c:0:12}) turned CI red, so the bisect tries it first"
    return 0
  done
  say "land.local.sh's land_suspect printed \"$c\", which is not the commit of a member of this batch, so the red batch's bisect halves"
}

# Which member of a red batch runs CI next: halfway between the deepest green one (0: main) and the shallowest red one.
# With land_suspect's guess k for the shallowest red one (suspect_of), first the member just below k, then k itself:
# each lies strictly between the two, so the search still ends, and a wrong guess only costs those runs.
batch_mid() {
  local i hi='' lo=0 s p
  for ((i = 1; i < ${#B_VER[@]}; i++)); do [ "${B_VER[i]}" != red ] || { hi=$i; break; }; done
  [ -n "$hi" ] || return 0
  for ((i = 1; i < hi; i++)); do [ "${B_VER[i]}" != green ] || lo=$i; done
  if [ -s "$state/land-suspect/${B_SHA[hi]}" ] && s=$(cat "$state/land-suspect/${B_SHA[hi]}"); then
    for ((i = lo + 1; i <= hi; i++)); do
      [ "${B_SHA[i]}" = "$s" ] || continue
      p=$((i - 1))
      [ "$p" -gt "$lo" ] || p=$i
      [ "$p" -ge "$hi" ] || { echo "$p"; return 0; }
      break
    done
  fi
  [ $((hi - lo)) -le 1 ] || echo $(((lo + hi) / 2))
}

# Whether this one pushes now: in a batch that runs CI, never with a red ticket ahead (its fault may be in this
# commit too: the bisect ahead goes first), and only as its batch's top or as a red batch's next halfway member.
batch_push() {
  [ "$B_NUM" -le "$CI_STACK" ] && [ -z "$B_RED" ] || return 1
  [ "$B_I" = $((${#B_SHA[@]} - 1)) ] || [ "$(batch_mid)" = "$B_I" ]
}

# This one is green, but in a lane for a range that starts above its batch now (a part of the batch ahead landed, so the
# rest joined this one's), and the whole range takes another lane: CI never saw the members under it, so it is green no
# more and runs in the batch's lane when it is due (batch_push).
g_base=''
batch_regreen() {
  local from=${B_BASE[1]:--} l
  [ "$verdict" = green ] && [ -n "$LANES" ] && [ "$B_NUM" = 1 ] && [ -n "$B_SKIP" ] && [ "$from $tip" != "$g_base" ] || return 0
  [ "$ci_lane" != full ] && [ ! -e "$state/land-fallback/$tip" ] && git merge-base --is-ancestor "$from" "$tip" 2>/dev/null || return 0
  g_base="$from $tip"
  ! git merge-base --is-ancestor "$ci_from" "$from" 2>/dev/null || return 0
  l=$(lane_of "$from" "$tip" "refs/heads/$BRANCH") || return 0
  [ "${l%% *}" != "$ci_lane" ] || return 0
  green='' verdict=- at=line retried='' flaked=0
  queue_set 5 "$UNRUN"
  queue_phase "checked ${tip:0:12}: CI runs on its batch's top"
  say "${tip:0:12} is green in lane $ci_lane, but its batch now starts at ${from:0:12} and takes lane ${l%% *}, so its CI runs again when it is due"
  B_VER[B_I]=$verdict
}

# The head: the deepest green member of its batch, as G (its commit) and GI, once it may land. Its ticket's green is
# checked: main and every member's commit, the head's down to G's, sit under G, each built on the one ahead (the
# head on main: a member killed since leaves a gap), CI passes G when asked again now (or land_fallback passed it, ci_none), and the members up to G are
# all still running (one killed meanwhile must not land). CI is asked at most every CI_POLL, and with no answer for
# CI_START it parks, as ci_ask does.
batch_green() {
  local i rc=0 under main gl=full known l from LAND_KNOWN_RED=${LAND_KNOWN_RED:-}
  G='' GI=''
  for ((i = ${#B_VER[@]} - 1; i >= 1; i--)); do [ "${B_VER[i]}" != green ] || { GI=$i; break; }; done
  [ -n "$GI" ] && [[ ${B_SHA[GI]} =~ ^[0-9a-f]{40,}$ ]] || return 1
  G=${B_SHA[GI]} under=$(git rev-parse "refs/heads/$BRANCH") main=$under
  git merge-base --is-ancestor "$under" "$G" 2>/dev/null || return 1
  for ((i = 1; i <= GI; i++)); do
    [ "${B_BASE[i]}" = "$under" ] && [[ ${B_SHA[i]} =~ ^[0-9a-f]{40,}$ ]] && git merge-base --is-ancestor "${B_SHA[i]}" "$G" 2>/dev/null || return 1
    under=${B_SHA[i]}
  done
  [ -z "$g_last" ] || [ $((SECONDS - g_last)) -ge "$CI_POLL" ] || return 1
  g_last=$SECONDS
  # In the lane G's run took, past the known reds it went past (green_note), if that run's range holds main..G (it
  # starts on main, or its lane is full) or main..G takes that lane too. No note: the lane of main..G.
  [ -z "$LANES" ] || { gl=$(lane_of "$main" "$G" "refs/heads/$BRANCH") && gl=${gl%% *}; }
  if [ -f "$state/land-green/$G" ]; then
    { read -r l from && known=$(cat); } <"$state/land-green/$G"
    if [ "$l" = full ] || git merge-base --is-ancestor "$from" "$main" 2>/dev/null; then gl=$l; fi
    # G's own landing is about to run it in the lane of main..G (batch_regreen). One that works that lane out otherwise
    # (its branch's LANES or map differs) never does, so after CI_START CI is asked all the same.
    if [ "$l" != "$gl" ] && [ ! -e "$state/land-fallback/$G" ]; then
      [ "${g_wait%% *}" = "$G" ] || g_wait="$G $SECONDS"
      [ $((SECONDS - ${g_wait#* })) -ge "$CI_START" ] || return 1
    fi
    LAND_KNOWN_RED+=${known:+${LAND_KNOWN_RED:+$'\n'}$known}
  fi
  # land_fallback passed G in CI's place (ci_none): CI still has no answer, so its word stands.
  [ -e "$state/land-fallback/$G" ] || ci_verdict "$G" "$gl" || rc=$?
  case $rc in
    0) g_quiet='' ;;
    [1-4])
      cat "$cilog" >&2
      refuse "${B_LABEL[GI]}'s ticket says CI passed ${G:0:12}, but CI says otherwise now (exit $rc from ${CI_STATUS:-gh}; above), so nothing landed. A person needs to look before anyone tries again" ;;
    *)
      g_quiet=${g_quiet:-$SECONDS}
      [ $((SECONDS - g_quiet)) -lt "$CI_START" ] || { cat "$cilog" >&2; park "CI gave no answer about ${G:0:12} for $(((CI_START + 59) / 60)) min (exit $rc from ${CI_STATUS:-gh}; above), so nothing landed. That is GitHub or this box's gh login, not the runners or the branch: a person needs to look. Park, and run this again after"; }
      return 1 ;;
  esac
  for ((i = 2; i <= GI; i++)); do [ "$(queue_proc "${B_PID[i]%% *}")" = "${B_PID[i]}" ] || return 1; done
}

# The deploy (land.local.sh's land_deploy): whoever moves main (a lone landing, or the head of a batch) runs it once,
# for the commit main moved to, holding the lock, before main is pushed. Its word goes in <state>/land-deploy/<commit>:
# "<state> <when> <the main it moved from> <the head's pid and start>", the state running, back, or the deploy's own
# word; "running" is written before main moves, so a member that sees its commit on main always finds it, and "back"
# after main goes back. A head that stops while running it is taken back by the next landing (deploy_stale).
deploy_mark() { # <commit> <state> <the main it moved from>
  local d=$state/land-deploy
  mkdir -p "$d" && echo "$2 $(date +%s) $3 $Q_ME" >"$d/$1.$$" && mv -f "$d/$1.$$" "$d/$1"
  [ "$2" != running ] || find "$d" -maxdepth 1 -type f -mmin +1440 -delete 2>/dev/null || true
}
# Runs it for <commit>, main having moved there from <old>. Its stdout's last line, one word (live, restart), is the
# ship line's deploy state ("done" when it printed none). Failed: main goes back to <old> and nothing ships.
deploy_run() {
  local to=$1 old=$2 rc=0 out last
  at=deploy
  queue_phase "deploying $(git rev-parse --short=12 "$to")"
  out=$state/land-deploy/$to.out.$$
  # In the background and waited on, so set -e holds inside it (an `||` around the call would switch it off).
  # 9>&-: a server it leaves running must not hold the land lock after this exits.
  (cd "$MAIN" && land_deploy "$to") >"$out" </dev/null 6>&- 9>&- &
  wait $! || rc=$?
  cat "$out" >&2
  last=$(tail -n 1 "$out")
  rm -f "$out"
  if [ "$rc" = 0 ]; then
    DEPLOY=done
    [[ ! $last =~ ^[a-z][a-z-]*$ ]] || [ "$last" = running ] || [ "$last" = back ] || DEPLOY=$last
    deploy_mark "$to" "$DEPLOY" "$old"
    say "land_deploy deployed $(git rev-parse --short=12 "$to") ($DEPLOY)"
    return 0
  fi
  DEPLOY=back
  local who=''
  [ -z "$BATCH" ] || [ "${GI:-1}" = 1 ] || who=$(printf ', %s' "${B_LABEL[@]:2:GI-1}")
  [ -z "$who" ] || who=", nor did the others in its batch (${who#, })"
  # Main goes back before the mark says so, so a member reading "back" sees main without its commit.
  git -C "$MAIN" -c gc.auto=0 reset -q --keep "$old" || {
    deploy_mark "$to" back "$old"
    refuse "land.local.sh's land_deploy failed (exit $rc), and $BRANCH couldn't go back to $(git rev-parse --short=12 "$old"): it is at $(git rev-parse --short=12 "$to"), not pushed. Nothing shipped$who; a person needs to look at $MAIN"
  }
  deploy_mark "$to" back "$old"
  refuse "land.local.sh's land_deploy failed (exit $rc), so $BRANCH went back to $(git rev-parse --short=12 "$old") and nothing shipped$who"
}
# A member: whether a deploy of a commit holding its own has its word yet (since it got in line). Running: it waits.
deploy_look() {
  local f st ep old id
  for f in "$state"/land-deploy/*; do
    [[ ${f##*/} =~ ^[0-9a-f]{40,}$ ]] || continue
    read -r st ep old id <"$f" 2>/dev/null || continue
    [[ $ep =~ ^[0-9]+$ ]] && [ "$ep" -ge "$D_SINCE" ] || continue
    git merge-base --is-ancestor "$tip" "${f##*/}" 2>/dev/null || continue
    while [ "$st" = running ]; do
      [ "$(queue_proc "${id%% *}")" = "$id" ] ||
        refuse "the head of its batch stopped while deploying ${f##*/}, which holds ${tip:0:12}, so it didn't ship: the next landing takes $BRANCH back to ${old:0:12}. Run this again"
      queue_phase "waiting for its batch's deploy"
      sleep "$QUEUE_POLL"
      read -r st ep old id <"$f" 2>/dev/null || st=''
    done
    case $st in
      back) DEPLOY=back keep='' && refuse "didn't ship: its batch's deploy failed, so $BRANCH went back to ${old:0:12} without ${tip:0:12}. Run this again once the deploy is fixed" ;;
      '') refuse "the deploy's word on ${f##*/} went missing while it waited, so whether ${tip:0:12} shipped is unknown: a person needs to look" ;;
      *) DEPLOY=$st ;;
    esac
  done
}
# Under the lock, at the front: a head that stopped while deploying left main moved and unpushed, with members told
# they didn't ship, so main goes back to where that head found it.
deploy_stale() {
  local f st ep old id
  for f in "$state"/land-deploy/*; do
    [[ ${f##*/} =~ ^[0-9a-f]{40,}$ ]] || continue
    read -r st ep old id <"$f" 2>/dev/null || continue
    [ "$st" = running ] && [ "$(queue_proc "${id%% *}")" != "$id" ] || continue
    if [ "$(git rev-parse "refs/heads/$BRANCH")" = "${f##*/}" ] && git -C "$MAIN" -c gc.auto=0 reset -q --keep "$old"; then
      say "the landing before this one stopped while deploying $(git rev-parse --short=12 "${f##*/}"), so $BRANCH went back to ${old:0:12}, where it found it (none of that was pushed)"
    fi
    deploy_mark "${f##*/}" back "$old"
  done
}

# land.local.sh's land_recover <$BRANCH's commit>: once a landing, at the front, holding the lock, after deploy_stale
# and before $BRANCH is read, in the main checkout: puts right what a landing killed mid-deploy left behind that the
# scheme's own deploy keeps (its own marks, a roll back half done). Non-zero refuses: a person needs to look.
recover_hook() {
  local rc=0
  declare -F land_recover >/dev/null || return 0
  queue_phase "running land_recover"
  (cd "$MAIN" && land_recover "$(git rev-parse "refs/heads/$BRANCH")") </dev/null >&2 9>&- 6>&- 7>&- &
  wait $! || rc=$?
  [ "$rc" = 0 ] || refuse "land.local.sh's land_recover failed (exit $rc), so nothing landed: what an earlier landing left behind may still be there, and a person needs to look before anyone tries again"
}

# A member whose commit the head landed (its commit is on main now): it says so and leaves as landed, unless a commit
# was made on the branch or here while it waited: that one is not on main, so it refuses as the head would.
batch_landed() {
  local i with='' on='its own'
  if [ "$(git rev-parse HEAD)" != "$tip" ] || [ "$(git rev-parse "refs/heads/$branch")" != "$pre" ]; then
    keep=''
    refuse "${tip:0:12} landed in a batch ($BRANCH is now $(git rev-parse --short=12 "refs/heads/$BRANCH")), but $branch or this worktree's HEAD moved while it waited, so what was committed since is not on $BRANCH. Put it on $branch, then run this again"
  fi
  for ((i = 1; i < ${#B_SHA[@]}; i++)); do
    [[ ${B_SHA[i]} =~ ^[0-9a-f]{40,}$ ]] && git merge-base --is-ancestor "${B_SHA[i]}" "refs/heads/$BRANCH" 2>/dev/null || continue
    if [ "$i" = "$B_I" ]; then on='its own'; else with="$with, ${B_LABEL[i]}" on="${B_LABEL[i]}'s"; fi
    SHIP_M=$i
  done
  SHIP_N=$B_I
  ride
  keep=$tip landed=ok
  # Its own commit, which the server's ship note reads (KT3, #1519): main's tip is the deepest green commit of the batch.
  say "landed $(git log -1 --format='%h "%s"' "$tip") in a batch with ${with#, }, on $on CI run (${BRANCH} is now $(git rev-parse --short=12 "refs/heads/$BRANCH"))"
  batch_pushed
  exit 0
}

# The head pushes main after its merge, so a member waits a while for origin to hold its commit, and says how that
# ended: pushed, the head's push failed (the unpushed line the server reads, so the minion hands off again or tells a
# person), or still to come. Never waits with PUSH_MAIN=0 or no origin, where nothing is pushed.
batch_pushed() {
  local t=0
  [ "$PUSH_MAIN" != 0 ] && git -C "$MAIN" remote get-url origin >/dev/null 2>&1 || return 0
  while ! git -C "$MAIN" merge-base --is-ancestor "$tip" "refs/remotes/origin/$BRANCH" 2>/dev/null; do
    if grep -qs "^$tip " "$state/land-after-pending"; then
      say "$BRANCH moved, but the push to origin failed: $(cat "$state/land-push-error" 2>/dev/null)"
      exit 1
    fi
    if [ "$t" -ge "$BATCH_PUSH_WAIT" ]; then
      say "the batch head's push of $BRANCH to origin is still to come (not there after ${BATCH_PUSH_WAIT}s); it landed here all the same"
      return 0
    fi
    sleep 2; t=$((t + 2))
  done
  say "$BRANCH is on origin (the batch head pushed it)"
}

# "<commit>:<branch>" for each branch this landing put on main: its own and, as the head of a batch, each member's.
landed_here() {
  local i
  echo "$tip:$branch"
  [ -z "$BATCH" ] || for ((i = 2; i <= ${GI:-0}; i++)); do echo "${B_SHA[i]}:${B_LABEL[i]}"; done
}

# On the way out, however it ends: the worktree goes back on the branch, the place in line and the lock
# go, then the scratch branch and its runs, except a landed commit's own runs, which finish (main's CI
# may skip what they passed). Then step 7, once main was pushed: land_after for this branch and, as the
# head of a batch, for each member it landed.
leave() {
  local rc=$? main
  trap - EXIT
  set +e
  if [ -z "$(git branch --show-current)" ]; then
    git rebase --abort 2>/dev/null
    # The branch takes the rebased commit only when that landed or was built on main itself: never one stacked on
    # someone's unlanded work.
    main=$(git rev-parse "refs/heads/$BRANCH")
    if [ "$(git rev-parse "refs/heads/$branch")" != "$pre" ]; then
      say "$branch moved while this ran, so it is left as it is now"
      git checkout -q "$branch" 9>&-
    elif [ -n "$keep" ] && { [ -n "$landed" ] || { [ "$mode" != build ] && { [ "$keep" = "$main" ] || [ "$base" = "$main" ]; }; }; }; then
      git checkout -q -B "$branch" "$keep" 9>&-
    else
      git checkout -q "$branch" 9>&-
    fi
  fi
  rm -f "$gitdir/land-branch"
  queue_done $landed
  exec 9>&- 6>&-
  if [ -n "$pushed$late_sha" ]; then
    ci_cancel
    # A run pushed a moment ago may not be listed yet (#1894), nor all of its push's workflows at once.
    while [ -n "$late_sha" ] && [ -z "$landed" ] && [ "$(wc -w <<<"$late_seen")" -lt "$(wc -w <<<"${LW:-one}")" ] && [ $((SECONDS - late_at)) -lt "$CI_LATE" ]; do
      sleep 2
      ci_cancel
    done
    hub git push -q --no-verify origin ":refs/heads/$CI_REF" 2>/dev/null
  fi
  if [ -n "$main_pushed" ] && declare -F land_after >/dev/null; then
    local i after=("${made_up[@]}") seen=" ${made_up[*]%% *} "
    while IFS= read -r i; do [[ $seen == *" ${i%%:*} "* ]] || after+=("${i%%:*} ${i#*:}"); done < <(landed_here)
    for i in "${after[@]}"; do
      (land_after "${i%% *}" "${i#* }") >&2 || say "land.local.sh's land_after failed for ${i#* } (exit $?), which landed all the same"
    done
  fi
  ship_end "$rc"
  exit "$rc"
}

# The early check (EARLY_CHECK, the header's step 0): CHECK_LIGHT as early_cmd, or '' none: off, not a plain land, a
# fast land, no CHECK_LIGHT, or a lane whose check is neither CHECK nor CHECK_LIGHT (none, or a CHECK_<LANE> of its
# own). A merge into a build and a build itself never run it.
early_cmd='' early_on='' early_tree='' early_tip='' early_bare=''
early_plan() {
  local lane=full why v chk=$CHECK
  [ "$EARLY_CHECK" = 1 ] && [ "$mode" = land ] && [ -z "$FAST" ] && [ -n "$CHECK_LIGHT" ] || return 0
  if [ -n "$LANES" ]; then
    read -r lane why <<<"$(lane_of "refs/heads/$BRANCH" "$pre" "refs/heads/$BRANCH")"
    case $lane in light) chk=$CHECK_LIGHT ;; full) ;; *) v=CHECK_${lane^^} && chk=${!v-$CHECK} ;; esac
  fi
  if [ -n "$chk" ] && { [ "$chk" = "$CHECK" ] || [ "$chk" = "$CHECK_LIGHT" ]; }; then early_cmd=$CHECK_LIGHT; fi
}

# The worktree back on the branch after the early check, or with a commit, the branch moved to that commit (the rebased
# one, on a red check, as a red at the front does), unless the branch moved meanwhile. -f: what the check changed in
# tracked files goes; the worktree was clean before it.
early_back() {
  if [ -n "${1:-}" ] && [ "$(git rev-parse "refs/heads/$branch")" = "$pre" ]; then
    git checkout -q -f -B "$branch" "$1" 6>&- || return
  else
    git checkout -q -f "$branch" 6>&- || return
  fi
  rm -f "$gitdir/land-branch"
}

# early_check <smoke's start>: early_cmd on the branch rebased onto $BRANCH, in this worktree as in line (land-branch
# puts it back if this is killed), under the check lock and its limits. Red refuses before the line, with the check's
# last lines as a red at the front shows them. Green sets early_on, early_tree and early_tip, which build() takes as
# its build when it rebases onto early_on again: the check then runs once. 1 when it neither passed nor refused.
early_check() {
  local t0=$1 t1=$SECONDS want rb log rc=0
  want=$(git rev-parse "refs/heads/$BRANCH")
  say "smoke: running $early_cmd on $branch rebased onto $BRANCH ($(git log -1 --format=%h "$want"))"
  note_branch "$pre"
  git checkout -q --detach "$pre" 6>&-
  if ! land_rebase "$want" >/dev/null 2>&1 6>&-; then
    git rebase --abort 2>/dev/null || true
    early_back
    say "smoke: the rebase onto $BRANCH stopped, so the check doesn't decide here: getting in line, where the rebase says why"
    return 1
  fi
  rb=$(git rev-parse HEAD)
  note_branch "$rb"
  if ! rebased_hook "$want"; then
    early_back
    say "smoke: so the check doesn't decide here: getting in line, where it runs again"
    return 1
  fi
  log="$state/land-check-${branch//\//-}.log"
  rm -f "$log" # the check makes it as it starts: none afterwards means the check lock never came
  # One early check at a time waits for the check lock, so the head of the line waits behind at most one (EARLY_AHEAD).
  (
    flock -w "$CHECK_WAIT" 8 && flock -w "$CHECK_WAIT" 7 || exit 1
    timeout -k 30 "$CHECK_LIMIT" bash -c "$early_cmd" >"$log" 2>&1 9>&- 8>&- 7>&- 6>&-
  ) 8>"$state/land-early.lock" 7>"$state/land-check.lock" 9>&- 6>&- || rc=$?
  if [ "$rc" = 0 ]; then
    early_on=$want early_tree=$(git rev-parse "$rb^{tree}") early_tip=$(git rev-parse HEAD) early_bare=$bare
    early_back
    say "smoke: the check passed on the rebased branch in $((SECONDS - t1)) s"
    return 0
  fi
  if [ ! -e "$log" ]; then
    early_back
    say "smoke: the check lock ($state/land-check.lock, or the early checks' land-early.lock) was still taken after ${CHECK_WAIT}s, so the check doesn't decide here: getting in line"
    return 1
  fi
  if [ "$rc" -eq 124 ] || [ "$rc" -eq 137 ]; then
    echo "land: the check ran past ${CHECK_LIMIT}s and was stopped: something in it hung" >>"$log" # the tail below shows it
  elif known_red "smoke: the check" <"$log"; then
    early_back
    return 1
  fi
  tail -n 40 "$log" >&2
  early_back "${bare:-$(git rev-parse HEAD)}"
  refuse "smoke: the check failed on the rebased branch (full log: $log), before the line ($((SECONDS - t0)) s), so nothing landed and nobody waited on it; $branch is now on that rebase onto $BRANCH, so the fix starts from there. Fix it, re-test, commit, then run this again"
}

# The smoke check (step 0): before the line, so what fails in seconds never waits in it.
smoke() {
  local t0=$SECONDS out rc=0 passed=1
  say "smoke: checking $branch before it queues"
  early_conflict "$pre" "before the line" || refuse "smoke: it conflicts with $BRANCH, before the line ($((SECONDS - t0)) s), so nothing landed and nobody waited on it. Fix it, re-test, commit, then run this again"
  # Commit titles, again on the rebased commit: here without the same patches on main, and land_under's (#1983); one the rebase would empty is named.
  if [ "$mode" = land ] && ! out=$(titles "nothing landed" --cherry-pick --right-only "refs/heads/$BRANCH...$pre" ${under:+"^$under"} 2>&1); then
    sed 's/^land: /land: smoke: /' <<<"$out. If $BRANCH already has that commit's change, git rebase $BRANCH drops it" >&2
    refuse "smoke: a commit title is wrong, before the line ($((SECONDS - t0)) s), so nothing landed and nobody waited on it. Fix it, re-test, commit, then run this again"
  fi
  early_plan
  # A SMOKE_CMD that is the early check's own command runs once, on the rebase.
  if [ -n "$SMOKE_CMD" ] && [ "$SMOKE_CMD" != "$early_cmd" ]; then
    out=$(timeout -k 10 "$SMOKE_TIMEOUT" bash -c "$SMOKE_CMD" 2>&1 6>&-) || rc=$?
    if { [ "$rc" = 124 ] || [ "$rc" = 137 ]; } && [ -n "$FAST" ]; then
      refuse "smoke: SMOKE_CMD ran past $SMOKE_TIMEOUT s, and a fast land goes live on it alone, so nothing landed. Find what hangs; a land labelled high takes the full gate"
    elif [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
      say "smoke: SMOKE_CMD ran past $SMOKE_TIMEOUT s, so it doesn't decide: getting in line"
      return 0 # it did not pass: no "passed" line (The Trans Agenda #76)
    elif [ "$rc" != 0 ]; then
      known_red "smoke: SMOKE_CMD" <<<"$out" || {
        tail -n 60 <<<"$out" | sed 's/^/land: smoke: /' >&2
        refuse "smoke: SMOKE_CMD failed (exit $rc), before the line ($((SECONDS - t0)) s), so nothing landed and nobody waited on it. Fix it, re-test, commit, then run this again"
      }
      passed='' # it said so, and it did not pass either
    fi
  fi
  [ -z "$early_cmd" ] || early_check "$t0" || passed=''
  [ -z "$passed" ] || say "smoke: passed in $((SECONDS - t0)) s"
}

# --verify (the header): the full CHECK under the check lock, then with the CI gate on, CI on land/verify (with lanes
# land/full/verify) within CI_START and CI_LIMIT. Both run, so one verdict names every failure.
# A red waits for the workflows still going (ci_open), so the verdict names every one that fails; one already red on
# the commit needs no new run.
verify_ci() {
  rc=0
  ci_runs || rc=$?
  gate_rc=$rc # the gate's own verdict, its open one when it is red, as it stood before BUILD_WORKFLOWS
  [ "$rc" != 1 ] || [ "$ci_open" = 0 ] || gate_rc=$ci_open
  [ -z "$BUILD_LW" ] || build_ci
  [ "$rc" != 1 ] || [ "$ci_open" = 0 ] || { ci_red=1 rc=$ci_open; }
}
# --full's BUILD_WORKFLOWS, each read on its own and folded into rc and ci_open as one more of the gate's workflows. One
# with no run at all on $tip (a queued one is waited for) CI_GRACE after the push is dispatched on $CI_REF; build_again names the ones to dispatch again
# (no verdict, on the retry), whose old run doesn't count for CI_GRACE after that.
ci_rank() { case $1 in 0) echo 0 ;; 2) echo 1 ;; 1) echo 5 ;; 4) echo 4 ;; 3) echo 3 ;; *) echo 2 ;; esac; } # worst last
build_ci() {
  local w x open=$rc gate_open=$ci_open
  [ "$rc" != 1 ] || open=$gate_open # the gate's verdict apart from its reds
  build_lost='' build_wait=''
  [ -z "$build_bad" ] || printf '%s' "$build_bad" >>"$cilog"
  for w in $BUILD_LW; do
    x=0
    if [[ $build_bad == *"$w: couldn't dispatch"* ]]; then x=1
    else LW=$w LS='' ci_read "$tip" || x=$?; fi
    if [ "$x" = 1 ]; then :
    elif [[ " $build_again " == *" $w "* ]]; then
      if [[ " $build_resent " != *" $w "* ]]; then
        x=3 && build_dispatch "$w" || x=$?
        [ "$x" = 2 ] && x=3 || build_resent+=" $w" # GitHub gave no answer: dispatch it on the next poll
      elif [ "$x" != 0 ] && [ "$x" != 2 ] && [ $((SECONDS - build_at)) -lt "$CI_GRACE" ]; then x=3; fi
    elif [ "$x" = 3 ] && [ -z "$ci_seen" ] && [[ " $build_sent " != *" $w "* ]]; then
      build_wait=1
      if [ -n "$pushed" ] && [ $((SECONDS - pushed_at)) -ge "$CI_GRACE" ]; then
        build_dispatch "$w" || x=$?
        [ "$x" = 2 ] && x=3 || build_sent+=" $w"
      fi
    fi
    [ "$x" != 4 ] || build_lost+=" $w"
    [ "$(ci_rank "$x")" -le "$(ci_rank "$rc")" ] || rc=$x
    [ "$x" = 1 ] || [ "$(ci_rank "$x")" -le "$(ci_rank "$open")" ] || open=$x
  done
  ci_open=0
  [ "$rc" != 1 ] || ci_open=$open
}
# build_dispatch <workflow>: starts it on $CI_REF (its workflow_dispatch trigger). GitHub's refusal (an HTTP 4xx) is its red
# from then on (build_bad), 1; no answer (a 5xx, a timeout) is 2, to try again.
build_dispatch() {
  local err
  build_at=$SECONDS
  if err=$(hub gh api -X POST "repos/$slug/actions/workflows/$1/dispatches" -f ref="$CI_REF" 2>&1 >/dev/null); then
    say "dispatched $1 on $CI_REF: it doesn't start on the push"
    return 0
  fi
  if [[ $err != *"HTTP 4"[0-9][0-9]* ]]; then
    echo "$1: couldn't dispatch it on $CI_REF, trying again: ${err//$'\n'/ }" >>"$cilog"
    return 2
  fi
  build_bad+="$1: couldn't dispatch it on $CI_REF (it needs a workflow_dispatch trigger, or land/** among its push branches): ${err//$'\n'/ }"$'\n'
  printf '%s\n' "${build_bad%$'\n'}" | tail -n 1 >>"$cilog"
  return 1
}
verify_run() {
  local rc=0 log="$state/land-verify.log" red="" ids="" ci="" ci_red="" chk=$CHECK want=${LAND_VERIFY_IDS:-} files
  local gate_rc=0 build_bad='' build_sent='' build_resent='' build_again='' build_lost='' build_wait='' build_at=0
  tip=$(git rev-parse HEAD) ci_lane=full
  say "verify: ${tip:0:12}"
  if [ -n "$want" ]; then
    # Only what the ids need: CI for a ci: id, and each test file alone when CHECK_FILE_CMD can run one.
    grep -Eq '^(ci:|CI$)' <<<"$want" || CI_ON=''
    files=$(grep -Ev '^(ci:|CI$)' <<<"$want" | sed 's/::.*//' | sort -u || true)
    if [ -z "$files" ]; then chk=''
    elif [ -n "$CHECK_FILE_CMD" ] && ! grep -Eqx 'the check|CI' <<<"$files"; then
      chk='r=0; '
      while IFS= read -r f; do chk+="{ ${CHECK_FILE_CMD//\{file\}/$(printf %q "$f")}; } || r=1; "; done <<<"$files"
      chk+='exit $r'
    fi
  fi
  if [ -n "$chk" ]; then
    (
      flock -w "$CHECK_WAIT" 7 || { echo "land: the check lock was still taken after ${CHECK_WAIT}s"; exit 1; }
      timeout -k 30 "$CHECK_LIMIT" bash -c "$chk" 2>&1 7>&- 6>&-
    ) >"$log" 7>"$state/land-check.lock" || rc=$?
    if [ "$rc" != 0 ]; then
      tail -n 40 "$log" >&2
      red=1 ids=$(land_failures <"$log" | sed "s|^$here/||")
      # A check that hung, or failed on nothing land_failures can name, is one id of its own.
      if [ -z "$ids" ] || [ "$rc" = 124 ] || [ "$rc" = 137 ]; then ids+=$'\nthe check'; fi
    fi
  fi
  if [ -n "$CI_ON" ]; then
    ci_clock=$SECONDS
    verify_ci
    # The gate's own verdict decides a push; a build workflow to dispatch needs the commit on $CI_REF too.
    { [ "$gate_rc" = 0 ] || [ "$gate_rc" = 1 ] || [ "$gate_rc" = 2 ]; } && [ -z "$build_wait" ] || ci_push
    while [ "$rc" != 0 ] && [ "$rc" != 1 ]; do
      sleep "$CI_POLL"
      verify_ci
      [ "$rc" != 2 ] || ci_begun=1
      if [ "$rc" = 4 ] && [ -z "$retried" ]; then
        retried=1 build_again=$build_lost
        [ "$gate_rc" != 4 ] && { [ -n "$pushed" ] || [ -z "$build_again" ]; } || ci_push
        continue
      fi
      if [ "$rc" = 4 ] || { [ -z "$ci_begun" ] && [ $((SECONDS - ci_clock)) -ge "$CI_START" ]; } || [ $((SECONDS - ci_clock)) -ge "$CI_LIMIT" ]; then
        cat "$cilog" >&2
        # A workflow already red is a verdict even if the others never finish.
        if [ -n "$ci_red" ]; then rc=1; break; fi
        [ -n "$red" ] && break
        hub git push -q --no-verify origin ":refs/heads/$CI_REF" 2>/dev/null || true
        echo "verify: no verdict"
        exit 75
      fi
    done
    [ -z "$pushed" ] || hub git push -q --no-verify origin ":refs/heads/$CI_REF" 2>/dev/null || true
    if [ "$rc" = 1 ]; then
      cat "$cilog" >&2
      red=1 ci=$(land_failures <"$cilog")
      ids+=$'\n'${ci:-CI}
    fi
  fi
  if [ -z "$red" ]; then echo "verify: green"; exit 0; fi
  sed '/^$/d' <<<"$ids" | sort -u | sed 's/^/verify: failing /'
  echo "verify: red"
  exit 1
}
[ -z "$verify" ] || verify_run

# A build's lock: one run at a time on build/<n> (a merge into it, its --full run or its land), on fd 6. --build takes
# it before the line, so a land never waits on a feeder's check; the feeders wait for the build's land instead.
if [ -n "$build" ]; then
  [[ ${LAND_BUILD_WAIT:-3600} =~ ^[0-9]+$ ]] || refuse "LAND_BUILD_WAIT is in whole seconds, not \"$LAND_BUILD_WAIT\""
  lock=$state/land-build-${build#build/}.lock
  exec 6>"$lock" || refuse "can't open $lock for writing, so nothing ran: a person needs to look at it"
  if ! flock -n 6; then
    say "waiting for the run on $build ahead of this one (a merge into it, its full run or its land) to end"
    flock -w "${LAND_BUILD_WAIT:-3600}" 6 || refuse "waited ${LAND_BUILD_WAIT:-3600} s for the run on $build ahead of this one, so nothing ran: run it again later, or look at what holds $lock"
  fi
  # Under its lock only land.sh moves it: what a merge into it compares and swaps against.
  bbase=$(git rev-parse -q --verify "refs/heads/$build") || refuse "$build doesn't exist (a build that landed is deleted), so nothing ran"
  [ "$mode" != build ] || [ "$bbase" = "$pre" ] || refuse "$build moved on while this waited ($(git log -1 --format='%h "%s"' "$bbase")): bring $branch to it (git merge --ff-only $build) and run it again. Nothing landed"
fi

# A feeder's merge that stops after rebased_hook's commits leaves the branch without it (bare), unless HEAD's reflog says
# that something else committed since too: this worktree is on the branch, and that commit stays.
into_left() {
  local rc=$? at='' how c
  set +e
  [ -z "${claims_flag:-}" ] || rm -f "$claims_flag" "$claims_new"
  if [ -n "$bare" ] && [ "$(git branch --show-current)" = "$branch" ]; then
    while read -r c how; do
      at=$c
      [ "$c" != "$bare" ] && [[ $how == land_rebased* ]] || break
    done < <(git reflog --format='%H %gs')
    [ "$at" != "$bare" ] || git reset -q --keep "$bare" 6>&-
  fi
  exit "$rc"
}

# --into and --full (the header's "Build branches"): out of the line, under the build's lock only.
if [ "$mode" = into ] || [ "$mode" = full ]; then
  # Before the rebase, so $BRANCH's own commits, which a merge of it brought and the rebase would copy, don't count.
  [ "$mode" = full ] || titles "$build and $branch are untouched" "$bbase..HEAD" "^refs/heads/$BRANCH"
  if git merge-base --is-ancestor "$bbase" HEAD; then
    say "$build is already under $branch: no rebase"
  else
    [ "$mode" = into ] || refuse "$build has commits $branch doesn't: run git merge $build (not a rebase), re-test, then run this again. Nothing merged"
    say "rebasing $branch onto $build ($(git log -1 --format='%h "%s"' "$bbase"))"
    if ! land_git ours rebase -q "$bbase" 6>&-; then
      git rebase --abort 2>/dev/null || true
      refuse "the rebase onto $build failed (see git's output above), so $build is untouched. On conflicts: run git rebase $build, resolve them keeping the other feeders' changes, re-test, commit, then run this again"
    fi
  fi
  claims_check "$BRANCH" # again under the lock: a feeder that merged while this waited may own a file now
  rc=0
  clashes=$(numbered_clashes "$bbase" "$(git merge-base "$bbase" "$pre")" "$pre") || rc=$?
  if [ "$rc" != 0 ]; then
    printf '%s\n' "$clashes" | sed 's/^/land:   /' >&2
    [ "$rc" != 2 ] || refuse "fix that line in $FACTS (commit it on this branch), then run this again. $build is untouched"
    [ "$rc" = 1 ] || refuse "the numbered-things check itself failed (exit $rc), so $build is untouched; a person needs to look"
    refuse "this branch takes a number $build already has (above), so $build is untouched. Renumber yours past $build's highest, commit, then run this again"
  fi
  rc=0
  clashes=$(undo_guard "$bbase") || rc=$?
  if [ "$rc" != 0 ]; then
    [ "$rc" = 1 ] || refuse "the undo check itself failed (exit $rc, above), so $build is untouched; a person needs to look"
    printf 'land: %s\n' "$branch removes what these merged, without naming them:" "$clashes" >&2
    refuse "$build is untouched. If the undo is meant, add a line \"Undoes: <sha>\" to a commit message for each commit above, then run this again"
  fi
  # A feeder's land_rebased first: its commit is part of what is checked.
  trap into_left EXIT
  [ "$mode" != into ] || rebased_hook "$bbase" || refuse "$hook_failed failed on the rebased branch (above), so $build is untouched"
  # The commit the check runs on is the one the build moves to: one made in the worktree while the check runs was
  # never checked (KT5, #1519; Citadel's own land.sh reads its tip here too).
  tip=$(git rev-parse HEAD)
  if [ "$mode" = into ]; then
    # A feeder runs only what it touched: its test files through CHECK_FILE_CMD, else the light check, else CHECK.
    # A merge of light paths alone that names no test files runs none (#1684): build-claims.md, the build minion's
    # plan that never ships, and what the lanes map marks light (docs).
    chk=${CHECK_LIGHT:-$CHECK} light=''
    if [ ${#files[@]} -eq 0 ]; then
      if [ -z "$(git diff --no-renames --name-only "$bbase" "$tip" -- . ':!build-claims.md')" ]; then
        git diff --quiet "$bbase" "$tip" -- build-claims.md || light=build-claims.md
      elif [ -n "$LANES" ]; then
        read -r into_lane light < <(lane_of "$bbase" "$tip" "refs/heads/$BRANCH" build-claims.md)
        [ "$into_lane" = light ] || light=''
      fi
    fi
    if [ -n "$light" ]; then
      chk=''
      say "$branch changes only light paths ($light), so no check ran"
    elif [ ${#files[@]} -gt 0 ] && [ -n "$CHECK_FILE_CMD" ]; then
      chk='r=0; '
      for f in "${files[@]}"; do chk+="{ ${CHECK_FILE_CMD//\{file\}/$(printf %q "$f")}; } || r=1; "; done
      chk+='exit $r'
    fi
    if [ -n "$chk" ]; then
      say "running $chk"
      log="$state/land-check-${branch//\//-}.log"
      (
        flock -w "$CHECK_WAIT" 7 || { echo "land: the check lock was still taken after ${CHECK_WAIT}s"; exit 1; }
        timeout -k 30 "$CHECK_LIMIT" bash -c "$chk" 2>&1 7>&- 6>&-
      ) >"$log" 7>"$state/land-check.lock" 6>&- || rc=$?
      [ "$rc" = 0 ] || { tail -n 40 "$log" >&2; refuse "the check failed on the rebased branch (full log: $log), so $build is untouched; $branch keeps the rebased work"; }
    fi
  else
    # The build minion's merge of $BRANCH: the full check and CI, judged as --verify judges (no fast mode, no known reds).
    out=$(LAND_VERIFY_IDS='' verify_run) || rc=$?
    case $rc in
      0) ;;
      75) park "CI gave no verdict on $(git rev-parse --short=12 HEAD), so $build is untouched. Park, and run this again once a person says the runners are back" ;;
      *) sed -n 's/^verify: failing /land:   failing: /p' <<<"$out" >&2
         refuse "the full check or CI is red on $branch (above), so $build is untouched. Fix it, commit, then run this again" ;;
    esac
  fi
  git update-ref -m "land.sh --into $branch" "refs/heads/$build" "$tip" "$bbase" || refuse "$build moved while this ran (not by land.sh, which holds its lock), so nothing merged: run it again"
  bare=''
  say "$build is now at $(git log -1 --format='%h "%s"' "$tip"); $BRANCH is untouched"
  exit 0
fi

# Until leave takes over: a landing stopped during the early check (or what it runs) puts the worktree back.
trap 'rc=$?; set +e; [ -n "$(git branch --show-current)" ] || { git rebase --abort 2>/dev/null; early_back; }; ship_end "$rc"' EXIT
[ "${LAND_SMOKE:-1}" = 0 ] || smoke
at=line
D_SINCE=$(date +%s) # deploy_look: the deploys since it got in line
queue_join "$LOCK_FILE" "$QUEUE_DIR" "$branch"
T_start=$SECONDS
trap leave EXIT
seen_main='' looked='' checked_main=''
while :; do
  # In a batch, landed by the head: its commit is under the one the head moved main to.
  # Or taken back by its deploy, which leaves main without it (deploy_look refuses). Its deploy looked at again once
  # the commit is on main: the head marks it before main moves.
  if [ -n "$BATCH" ] && [ -n "$tip" ]; then
    deploy_look
    if git merge-base --is-ancestor "$tip" "refs/heads/$BRANCH" 2>/dev/null; then deploy_look; batch_landed; fi
  fi
  queue_look || exit 1
  # While others are ahead, each time main moves: whether the branch would still rebase onto it. A conflict leaves the
  # line at once, so the minion hears now rather than when it reaches the front.
  # Not once its own commit is on main (landed in a batch since batch_landed's look): it would conflict with itself.
  if [ "$Q_AHEAD" != 0 ] && [ "$(git rev-parse "refs/heads/$BRANCH")" != "$checked_main" ] &&
    ! { [ -n "$tip" ] && git merge-base --is-ancestor "$tip" "refs/heads/$BRANCH" 2>/dev/null; }; then
    checked_main=$(git rev-parse "refs/heads/$BRANCH")
    early_conflict "$pre" "waiting in line" || exit 1
  fi
  if [ -n "$BATCH" ]; then
    batch_look
    looked=1
    # The limits on CI count from here: until now its run could be waiting on the batches ahead.
    [ "$B_NUM" != 1 ] || [ -n "$fronted" ] || fronted=1 ci_clock=$SECONDS ci_begun='' T_lock=$SECONDS
  fi
  if [ "$Q_AHEAD" = 0 ]; then
    [ -n "$Q_HELD" ] || continue # queue_look waited on the lock, so this is no busy loop
    if [ -z "$seen_main" ]; then
      ! declare -F land_deploy >/dev/null || deploy_stale
      recover_hook
      # Under the lock: another landing fast-forwarding main there looks like uncommitted changes while it runs.
      [ "$(git -C "$MAIN" branch --show-current)" = "$BRANCH" ] || refuse "$MAIN is not on $BRANCH; a person needs to look"
      [ -z "$(git -C "$MAIN" status --porcelain --untracked-files=no)" ] || refuse "$MAIN has uncommitted changes; a person needs to look"
      seen_main=1 ci_clock=$SECONDS ci_begun='' T_lock=${T_lock:-$SECONDS} # the limits on CI count from here: until now its run could be waiting on the ones ahead
    fi
    want=$(git rev-parse "refs/heads/$BRANCH")
  elif [ -n "$BATCH" ]; then
    want='' # the batches that run CI and the one that builds ahead build; further back waits
    [ "$B_NUM" -gt $((CI_STACK + 1)) ] || want=$Q_PRED
  elif [ "$Q_AHEAD" -lt "$CI_STACK" ] && [ -n "$Q_PRED" ]; then
    want=$Q_PRED
  else
    want='' # too far back to build yet, or the one ahead has nothing built
  fi
  # A new commit ahead that is already in main: a batch member that landed and is leaving the line. It lacks the rest
  # of its batch, so building on it would spend a CI run on a commit that can't land: wait, as for nothing built.
  # (One it already built on stays: main may have just moved to its batch, whose landing the next look sees.)
  [ -z "$want" ] || [ "$want" = "$base" ] || [ "$Q_AHEAD" = 0 ] || ! git merge-base --is-ancestor "$want" "refs/heads/$BRANCH" 2>/dev/null || want=''
  # Conflict prep: a stacked build stopped by a conflict tries again once a new fix is recorded.
  [ -z "$prepped" ] || [ -z "$blocked" ] || [ "$want" != "$base" ] || [ "$prepped" = "$want $pre $(prep_count)" ] || base=''

  if [ -z "$want" ]; then
    # What it was built on is gone: wait for the one ahead to build again. Unless that was main's tip: the one
    # it sat on has landed and only skipped ones are ahead for a moment, so the build and its CI run still stand.
    if [ -n "$base" ] && [ "$base" != "$(git rev-parse "refs/heads/$BRANCH")" ]; then
      [ -z "$pushed" ] || ci_cancel
      base='' tip='' blocked='' green='' verdict=-
      queue_set 4 -
      queue_set 5 "$UNRUN"
      queue_set 6 -
      queue_phase waiting
    fi
  elif [ "$want" != "$base" ]; then
    build "$want"
    looked='' # the line may have moved while it built (a check takes minutes): batches decide on the next look
    [ -z "$blocked" ] || [ "$Q_AHEAD" = 0 ] || queue_set 4 skip
    [ -z "$blocked" ] || [ "$Q_AHEAD" = 0 ] || say "that was on top of $Q_PREDNAME's commit, which hasn't landed: ${blocked%%, so *}. Not final: waiting to see whether that one lands"
  fi

  if [ -n "$blocked" ]; then
    [ "$Q_AHEAD" != 0 ] || refuse "$blocked"
  elif [ -n "$tip" ] && [ -n "$BATCH" ]; then
    if [ -n "$looked" ]; then
      batch_regreen
      [ "$verdict" != - ] || ! batch_push || ci_start
      [ "$verdict" != running ] || ci_ask
      B_VER[B_I]=$verdict
      if [ "$Q_AHEAD" = 0 ] && [ -z "$blocked" ] && batch_green; then break; fi
    fi
  elif [ -n "$tip" ]; then
    [ -z "$CI_ON" ] || [ -n "$green" ] || ci_ask
    if [ "$Q_AHEAD" = 0 ] && { [ -z "$CI_ON" ] || [ -n "$green" ]; }; then break; fi
  fi
  sleep "$QUEUE_POLL"
done
at=landing
ride

# The head of the line, holding the lock, with $tip checked (and green in CI) on exactly today's main; with
# batches, main moves to G, the deepest green commit of its batch, which holds $tip.
# The merge keeps the lock, so nobody sees main half moved if this script is killed; gc.auto=0, so no git gc
# detaches from it holding the lock.
# A commit made here or on the branch while this waited is not in $tip: CI never saw it.
{ [ "$(git rev-parse HEAD)" = "$tip" ] && [ "$(git rev-parse "refs/heads/$branch")" = "$pre" ]; } || refuse "$branch or this worktree's HEAD moved while the landing waited, so what CI passed is not what is here now and nothing landed. Put any commit made meanwhile on $branch, then run this again"
to=$tip
[ -z "$BATCH" ] || to=$G
old=$(git rev-parse "refs/heads/$BRANCH") deploy=''
! declare -F land_deploy >/dev/null || { deploy=1; deploy_mark "$to" running "$old"; }
git -C "$MAIN" -c gc.auto=0 merge -q --ff-only "$to" || { [ -z "$deploy" ] || deploy_mark "$to" back "$old"; refuse "could not fast-forward $BRANCH to $branch; nothing landed"; }
[ -z "$BATCH" ] || SHIP_N=1 SHIP_M=$GI
say "$BRANCH is now at $(git log -1 --format='%h "%s"' "$to")"
[ -z "$deploy" ] || deploy_run "$to" "$old"
keep=$tip landed=ok # it landed, so its time counts toward the estimate, whatever the push does
if [ -n "$BATCH" ] && [ "$GI" != 1 ]; then
  with=$(printf ', %s' "${B_LABEL[@]:2:GI-1}")
  say "landed $(git log -1 --format='%h "%s"' "$tip") in a batch with ${with#, }, on ${B_LABEL[GI]}'s CI run"
fi
if [ "$mode" = build ]; then
  if git update-ref -d "refs/heads/$build" "$bbase"; then
    say "deleted $build, which is on $BRANCH now (to make it again: git branch $build $(git rev-parse --short "$bbase"))"
  else
    say "$build moved during the land (not by land.sh), so it stays: what is in it after $(git rev-parse --short "$bbase") isn't on $BRANCH"
  fi
fi

if [ "$PUSH_MAIN" = 0 ]; then
  say "PUSH_MAIN is 0, so $BRANCH stays local"
  exit 0
fi
if ! git -C "$MAIN" remote get-url origin >/dev/null 2>&1; then
  say "no origin remote, so $BRANCH stays local"
  exit 0
fi
queue_phase "pushing $BRANCH to origin"
# --no-verify: .githooks/pre-push refuses every push to main on purpose; this script is the one
# route that may make it.
if out=$(GIT_TERMINAL_PROMPT=0 timeout 60 git -C "$MAIN" push -q --no-verify origin "$BRANCH" 2>&1); then
  say "pushed $BRANCH to origin"
  main_pushed=1
  # land_after owed by earlier landings whose push failed (KT4, #1519): made up now that origin holds them, claimed
  # under the lock so two landings never both run one.
  if [ -s "$state/land-after-pending" ]; then
    while read -r i; do
      git merge-base --is-ancestor "${i%% *}" "refs/remotes/origin/$BRANCH" 2>/dev/null && made_up+=("$i")
    done <"$state/land-after-pending"
    rm -f "$state/land-after-pending" "$state/land-push-error"
  fi
  if [ "$mode" = build ] && git show-ref -q --verify "refs/remotes/origin/$build"; then
    hub git push -q --no-verify origin ":refs/heads/$build" 2>/dev/null || say "couldn't delete $build on origin: delete it there by hand"
  fi
else
  say "$BRANCH moved, but the push to origin failed: $out"
  # What land_after owes is written down for the next landing that pushes (KT4, #1519), and a waiting batch member
  # reads it to report the failure.
  printf '%s\n' "$out" >"$state/land-push-error"
  while IFS= read -r i; do printf '%s %s\n' "${i%%:*}" "${i#*:}"; done < <(landed_here) >>"$state/land-after-pending"
  ! declare -F land_after >/dev/null || say "land.local.sh's land_after didn't run, since $BRANCH isn't on origin: the next landing that pushes it runs it"
  say "the next landing retries it; if origin's $BRANCH moved on its own (rejected as non-fast-forward), a person merges it into $MAIN first"
  exit 1
fi
