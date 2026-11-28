# shellcheck shell=bash
# The gate's settings (LAND_CI_*, LAND_QUIET_*, the train's state), set once before it (sourced by land.sh).
# Sourced by tools/land.sh up front: definitions only (#2099).

land_settings() {
  REMOTE=${DEPLOY_REMOTE-origin}
  CI_WORKFLOW=.github/workflows/tests.yml
  CI_LABEL=citadel-ci-linux
  CI_REF=land/$branch
  CI_STEP='the full suite' # the workflow's step that runs the tests; a run that fails in any other never ran them
  CI_CLOCK_STEP="the runner's clock" # the workflow's step that fails on a skewed runner clock
  CI_PORTS_STEP='Windows ports left behind' # the workflow's check of the PC itself, run only after a green suite (#1763)
  CI_DOWN=${LAND_CI_DOWN:-600} # how long one landing's unanswered wait for CI spares the next ones theirs
  # CI_LIMIT: 540 s clears the slowest green run seen (461 s, measured pickup to suite end, burn-in off) with room for the
  # suite's growth (#1606); a run that hangs costs 3 min more before it falls back.
  CI_START=${LAND_CI_START:-90} CI_START_ONLINE=${LAND_CI_START_ONLINE:-900} CI_LIMIT=${LAND_CI_TIMEOUT:-540} CI_POLL=${LAND_CI_POLL:-15} CI_BACKOFF=${LAND_CI_BACKOFF:-60} # #1655: 5 s was 720 calls an hour for each landing waiting
  CI_LATE=${LAND_CI_LATE:-20} CI_LATE_POLL=${LAND_CI_LATE_POLL:-2} # for how long after a push a stop looks for its run, which GitHub lists some seconds late (#1894)
  CI_WAKE=${LAND_CI_WAKE:-180} # #2299: a job's wait for an asleep runner to wake
  CI_ONLINE_POLL=${LAND_CI_ONLINE_POLL:-30} # how often a job waiting past CI_START asks whether a runner is online
  CI_GH_START=${LAND_CI_GH_START:-60} # a ship's run on GitHub with a shard not started by then goes to the desktop (#2209)
  # The reruns alone get a window of their own (#1374): the workflow reruns the failed files in a step of its own, and at
  # CI_LIMIT a run whose full suite step failed and that has a rerun step gets CI_RERUN s more, once. A run still in its
  # full suite falls back at CI_LIMIT. tests.yml's RERUN_WINDOW is the same number: test/ci-runner-choice.test.ts pins them.
  CI_RERUN_STEP='rerun failed files alone' CI_RERUN=${LAND_CI_RERUN:-180}
  # The burn-in (#1443, tools/burn-in.sh): the ship's new and changed tests as 10 copies at once, in a step before the full
  # suite, needing the ship's base (CI_BASE_REF beside CI_REF). Its red is the ship's own: never a flake, a cut-off or a
  # known flake. At CI_LIMIT the run gets the step's time more (CI_BURN at most), once.
  CI_BURN_STEP='burn in new and changed tests' CI_BURN=${LAND_CI_BURN:-180} CI_BASE_REF=land-base/$branch
  ci_fail_n=0 ci_fail_at=''
  ci_quota='' ci_slug='' ci_id='' ci_status='' ci_result='' ci_url='' ci_pushed='' ci_pushed_at='' \
    ci_stale='' why='' burn_red='' burned='' ci_lost='' ci_step=''
  # Perigee runs a ship's suite only while it is quiet (#1254): CPU pressure (some avg60) under QUIET_PSI %, load under
  # half the cores, at least QUIET_MEM % memory available, citadel-heavy's plain slot and line free. Otherwise the ship
  # keeps waiting for CI, and after QUIET_LIMIT s of a busy perigee it is refused. An unreadable reading counts as busy.
  # LAND_QUIET_PROC points at a fake /proc, for tests.
  QUIET_PROC=${LAND_QUIET_PROC:-/proc} QUIET_PSI=${LAND_QUIET_PSI:-20} QUIET_MEM=${LAND_QUIET_MEM:-25}
  QUIET_LIMIT=${LAND_QUIET_LIMIT:-1800} QUIET_POLL=${LAND_QUIET_POLL:-30}
  heavy_dir=${CITADEL_HEAVY_DIR:-$HOME/.local/share/claude-coordinator/projects/.heavy}
  busy='' busy_spent=0 busy_last='' busy_told=''
  no_verdicts=0 NO_VERDICT_MAX=${LAND_NO_VERDICT_MAX:-3}
  # A CI red of flakes only on the one fresh run too (#1419): when every failed file passed alone again and no ship on the
  # train changed one or what it imports, the ship keeps its place (retry_in_place) instead of going back to its minion,
  # at most FLAKE_KEEP_MAX times a hand-off; past that it is refused, so a ship that really breaks something can't circle.
  FLAKE_KEEP_MAX=2

  # Red on main too (#1430): before a red train's suspects or bisect, or a red ship alone's refusal, each real failure
  # (train_real) runs alone here on main's tip ($old), niced, one file at a time, without the lock's fds. One that fails
  # there too is main's red, not the train's: neither suspects nor bisect can judge it, so no ship is refused for it: the
  # riders go back in line and this one takes its one retry in place (main_red); a ship alone is refused at once, saying
  # main is red. A file main hasn't got, or a run stopped at LAND_PIN_LIMIT s or by a test's own timeout, is no main red.
  # A red file this ship changed, or what it imports, still fails: it hears that its change doesn't make it pass, with no
  # retry (main_red_mine). Fails when no real failure is red on main.
  # Ship through (#1478): when every real failure is main's red, no ship on it changed one of them or what it imports, and
  # every other failed file passed alone and is a known flake no ship changed (#1419), the gate counts as green (rc=0) and
  # it ships, riders and all, saying so; its shipped line names main's red (through_by).
  main_red='' main_red_other='' main_red_mine='' main_red_riders=0
  declare -gA through_by=() # #1478: <commit> -> main's red tests its green was let through on

  # The ship train (#1166), the front's side: up to LAND_TRAIN_MAX plain lands waiting behind this one, each replayed onto
  # the one before it in a scratch worktree, so CI runs once on the top. Its riders: own=this ship's commit, then
  # train_tip, train_br, train_n (its ticket), train_was (its tip as the train took it). Not for a ship with no CI to
  # answer, nor while deploys are refusing or rolled back. A waiter keeps its place when it changes the pipeline
  # (tools/pipeline-files.txt: those land alone), has merge commits, sits on a commit that came off main, conflicts with
  # the train, or fails the undo guard against it.
  own=$tip train_tip=() train_br=() train_n=() train_was=() greens=' '
  declare -gA known_by=() # #1419: <commit> -> the known flakes its green was let through on
  # Early next train (#1366, #1568). While this train's CI runs (top_gate), early_next stacks the ship next in line, and
  # the train it would take, on this train's top in a scratch worktree, and once this train's run has a runner and another
  # ship runner is free, pushes it to early/<its branch>: tests.yml runs it niced beside this one. A red here drops it.
  # Each stack goes to <state>/stacked ("<onto> <commit> <result>"), which that ship's own rebase and train_build take
  # instead of rebasing again, and ci_gate takes the early run as its own.
  # <state>/early: "<top> <its branch> <when pushed> <this branch> <onto> <its riders' tickets, comma-separated, or ->";
  # that landing builds its train of those riders only (early_look), and at its gate counts the run or cancels it
  # (early_gate). Off: LAND_EARLY=0, or <state>/early-off. With the hold on (no <state>/hold-off, #1902) it goes only at
  # this train's deploy, on an idle desktop.
  early_ahead='' early_top='' early_pid='' train_only='' train_left='' # train_left: train_only is what is left of a red train (#1918)

  # Suspects first (#1346): a red train's real failures (not the flakes) are pinned on ships. Each failing file first runs
  # alone here on the train's prefixes (train_pin, #1403): the ship that turns it red is the cause. A file perigee can't
  # pin that way is guessed at from the files: the ships whose change touched it; failing that, a file it imports or
  # names by its path; failing that, a file those import. What is done with the ships named is train_suspects' header
  # (#1918). 0: done (rc as gate's, 1 only for this one alone or confirmed itself), 1: the bisect looks, on the train as it
  # now is (its top red, its log in $failed).
  suspect_tests='' suspect_new='' train_refused=' ' train_refused_tips='' train_held_tips=''
  held_n=() held_br=() held_was=() held_files=() held_run=() held_kind=() held_how=() held_log=()
  # The ships a red train is down to: <state>/split, the train's leader as retro_log names it, then a "<ticket> <branch>" line each.
  # <rider>: this one and its riders up to that one.
  split_of='' split_rest=''
  return 0
}
