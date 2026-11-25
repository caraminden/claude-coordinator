# What runs a minion's job (#1890, src/minion-jobs.ts), on the host or in its person's container: citadel-job copies it
# into the job's folder ($1) and the server starts it there, $2 its time limit in seconds. It touches `beat` while the
# command runs, ends it when `stop` appears or the limit passes, and writes the exit code last, by a rename.
__cj=$1 __cjl=$2
[[ $__cjl =~ ^[0-9]+$ ]] || exit 2
# One run only: a second launch, or one after the turn took it back (citadel-job's started()), ends here.
mkdir "$__cj/claim" 2>/dev/null || exit 0
: >"$__cj/beat"
. "$__cj/env"; rm -f "$__cj/env"
__cj_end() { echo "$1" >"$__cj/code.tmp"; mv "$__cj/code.tmp" "$__cj/code"; rm -rf "${__cj:?}/pin"; }
. "$__cj/cmd" 2>"$__cj/output.log" || { __cj_end 126; exit; }
__cji=/dev/null; [ ! -f "$__cj/stdin" ] || __cji=$__cj/stdin
setsid "$@" >"$__cj/output.log" 2>&1 <"$__cji" &
__cjp=$!
# The job's processes, children first: some leave its process group (setsid, a nested runner).
__cj_tree() { local c; for c in $(cat /proc/"$1"/task/*/children 2>/dev/null); do __cj_tree "$c"; done; echo "$1"; }
__cj_kill() {
  { echo "$1" >"$__cj/how"; } 2>/dev/null
  local pids i; pids=$(__cj_tree "$__cjp")
  kill -TERM $pids 2>/dev/null; kill -TERM -- "-$__cjp" 2>/dev/null
  for i in 1 2 3 4 5 6 7 8; do
    kill -0 $pids 2>/dev/null || kill -0 -- "-$__cjp" 2>/dev/null || return
    sleep 1
  done
  kill -KILL $pids 2>/dev/null; kill -KILL -- "-$__cjp" 2>/dev/null
}
(
  SECONDS=0
  while :; do
    # Its folder went: the minion closed.
    [ -d "$__cj" ] || { __cj_kill stopped; break; }
    : >"$__cj/beat"
    [ ! -e "$__cj/stop" ] || { __cj_kill stopped; break; }
    [ "$SECONDS" -lt "$__cjl" ] || { __cj_kill timeout; break; }
    sleep 1
  done
) &
__cjw=$!
# systemd stops a unit by signalling all of it: outlive the job so its end is still recorded.
trap 'echo stopped >"$__cj/how"; kill -TERM -- "-$__cjp" 2>/dev/null' TERM INT HUP
wait "$__cjp"; __cjc=$?
while kill -0 "$__cjp" 2>/dev/null; do wait "$__cjp"; __cjc=$?; done
[ ! -e "$__cj/how" ] || wait "$__cjw"
kill "$__cjw" 2>/dev/null
__cj_end "$__cjc"
