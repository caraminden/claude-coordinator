# shellcheck shell=bash
# The ship's own formatting (#1885; Josh, 2026-11-24: "Check, and auto-format too"). tools/land.sh sources this and calls
# format_ship once, before its smoke check: the .ts, .js and .mjs files this ship changed, formatted with tools/fmt in a
# commit of their own, so the minion needn't think of it. No other file, and no commit when nothing changes.
# - Before the line, so the smoke check, the own check, conflict prep, the trains and CI all test the commit that ships;
#   the pinned-text tests (judges, size budget) run on it in seconds. Not again after the rebase: the early next train
#   and the own check make that rebase ahead of time and it has to come out as the same commit. What two formatted sides
#   merge into is CI's to judge, as before.
# - A merge into a build formats the feeder's own files; the build minion's --full formats every file the build adds, as
#   that commit is still to be tested and merged. --build formats nothing: its branch is the build's tested tip.
# - Any trouble leaves the branch as it was, and the ship goes on: the format check (test/format-own.test.ts) decides.
# - A feeder's format commit that would change lines another feeder merged into a shared file (build claims) is left out.
# Sets land.sh's <formatted> to what it did, for the smoke check's refusal and size budget test.
format_ship() {
  local out whole=''
  [ "$mode" != full ] || whole=1
  if ! out=$(FMT_WHOLE_BUILD=$whole tools/fmt --own --commit 2>&1 </dev/null); then
    out=${out##*$'\n'}
    say "format: ${out#fmt: }; the ship goes on as it is, and the format check decides"
  elif [ -n "$out" ] && [ "$mode" = into ] && ! (check=1 claims_check main) 2>/dev/null; then
    git reset -q --keep HEAD^
    say "format: left as it is: formatting this ship's files would change lines another feeder merged in (build-claims.md)"
  elif [ -n "$out" ]; then
    formatted=$out
    say "format: $out"
  fi
}
