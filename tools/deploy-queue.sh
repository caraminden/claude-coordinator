# The line for the deploy lock (#502). Sourced by tools/land.sh and tools/deploy.sh, never run.
#
# The lock itself is still the flock on <state>/lock, on fd 9: that alone keeps landings and deploys
# one at a time. The kernel grants a flock in no order, though, so ten landings waiting on it meant a
# small one could lose every round and time out (2026-11-10). So waiters line up first: each takes a
# numbered ticket file in <state>/queue, and only the oldest ticket tries the lock.
#   queue_lock <state dir> <label>   wait in line, then hold the lock on fd 9. Returns 1 only when
#                                    nothing has moved for DEPLOY_QUEUE_STALL seconds, and 2 when the
#                                    caller's queue_wait_check (if it defines one) failed while others
#                                    were ahead; it said why.
#   queue_phase <text>               say what the holder is doing now: the waiters' sign of progress
#   queue_done [ok]                  leave the line (the caller lets go of fd 9, or exits); ok: it went
#                                    all the way, so its time counts toward the waiters' estimate
# A ticket is four lines: "<pid> <the pid's start time>", when it got the lock (0 while it waits), its
# label, and its phase. A ticket whose process is gone is deleted by whoever waits behind it.
# The order of the waiters is the tickets' numbers, unless <state>/queue/.order (written by the Releases page, #1002)
# names some: a "# " line saying who set it, then ticket numbers, front first. Those go first in that order, and the
# rest (a landing that joined since) behind them in arrival order. Whoever holds the lock counts as ahead of every waiter.
# Outside the line, a queued restart from before the restart lock (below) and a land.sh from a branch older than
# the line take the flock directly; the head of the line waits for them like for anyone else. The restart says what it
# is doing in <state>/restart ("<pid> <the pid's start time>", then its phase), which counts as progress like a ticket's phase (#553).
# The kit's land.sh template (kit/skills/scheme-setup/templates/land.sh) carries a copy of these functions
# inline, so a scheme copies one file: a fix to either belongs in both.

QUEUE_POLL=${DEPLOY_QUEUE_POLL:-1}
# Give up after this long with no change at the head of the line. The floor is the holder's longest
# single phase: the test run, 630 s at most (tools/run-tests.sh; its reruns are a phase of their own, 310 s at
# most); the boot check ends within 6 min.
QUEUE_STALL=${DEPLOY_QUEUE_STALL:-900}
QUEUE_TYPICAL=300 # a landing's length until some have been timed here

# "<pid> <start time>" of a live process, or nothing. The start time tells a reused pid apart.
queue_proc() {
  local stat
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 0
  stat=${stat##*) } # the command's name may hold spaces
  # shellcheck disable=SC2086
  set -- "$1" $stat
  # A zombie (Z, or X while it is reaped) is dead, though its /proc entry stays until its parent waits on it.
  case $2 in Z | X | x) return 0 ;; esac
  echo "$1 ${21}"
}

# The state letter of a process: T or t is stopped (a SIGSTOP), and so is a process in a frozen cgroup (#585).
queue_state() {
  local stat cg
  stat=$(cat "/proc/$1/stat" 2>/dev/null) || return 0
  stat=${stat##*) }
  stat=${stat%% *}
  # A frozen cgroup (systemctl freeze, a paused container) leaves its processes in state S: its cgroup.events says it.
  if [[ $stat != [Tt] ]] && cg=$(grep -m 1 '^0::' "/proc/$1/cgroup" 2>/dev/null) &&
    grep -qx 'frozen 1' "${DEPLOY_QUEUE_CGROUP:-/sys/fs/cgroup}${cg#0::}/cgroup.events" 2>/dev/null; then stat=T; fi
  echo "$stat"
}

# <state>: the queued restart's phase, while its process lives.
queue_restart() {
  local l
  mapfile -t l 2>/dev/null <"$1/restart" || return 0
  [ -n "${l[0]:-}" ] && [ "$(queue_proc "${l[0]%% *}")" = "${l[0]}" ] || return 0
  echo "${l[1]:-}"
}

# <state>: who holds the lock when nobody in line does and no restart says so: the processes that have the lock
# file open and are neither in line nor started by someone in line (a waiter's sleep inherits fd 9), such as what
# a killed landing left running. Run with fd 9 closed, or it names itself.
queue_outside() {
  local lock p up stat cmd who="" count=0 inline=" "
  lock=$(realpath "$1/lock" 2>/dev/null) || lock=$1/lock
  for p in "$1"/queue/[0-9]*; do inline="$inline$(head -n 1 "$p" 2>/dev/null | cut -d' ' -f1) "; done
  for p in $(find /proc/[0-9]*/fd -maxdepth 1 -lname "$lock" 2>/dev/null | cut -d/ -f3 | sort -un); do
    up=$p
    while [ "${up:-0}" -gt 1 ]; do
      case $inline in *" $up "*) continue 2 ;; esac
      stat=$(cat "/proc/$up/stat" 2>/dev/null) || continue 2 # gone while we looked (a waiter's poll sleep): it holds nothing now
      stat=${stat##*) }
      stat=${stat#* }
      up=${stat%% *} # its parent
    done
    cmd=$(tr '\0' ' ' 2>/dev/null <"/proc/$p/cmdline") || continue # gone since, as above
    count=$((count + 1))
    [ "$count" -le 3 ] || continue
    who="$who${who:+, }pid $p ($(cut -c1-80 <<<"$cmd" | sed 's/ *$//'))"
  done
  if [ -n "$who" ]; then
    echo "outside the line, the lock is open in $who$([ "$count" -le 3 ] || echo " and $((count - 3)) more")"
  else
    echo "a queued restart, or a landing started from a branch older than the line"
  fi
}

# The 5th line, "order", says this landing follows .order (#1002): the server lists only those in it. A landing started
# from an older branch runs the older queue_lock, which waits for every lower ticket, so ranking it could deadlock.
queue_write() { # <file> <pid and start> <got> <label> <phase>: by a rename, so nobody reads half a ticket
  printf '%s\n' "$2" "$3" "$4" "$5" order >"$1.tmp$$" && mv -f "$1.tmp$$" "$1"
}

queue_phase() {
  local t=${DEPLOY_QUEUE_TICKET:-} l
  [ -n "$t" ] && [ -e "$t" ] || return 0
  mapfile -t l 2>/dev/null <"$t" || return 0
  queue_write "$t" "${l[0]:-}" "${l[1]:-0}" "${l[2]:-}" "$1" 2>/dev/null || true
}

queue_done() {
  local t=${DEPLOY_QUEUE_TICKET:-} l took
  [ -n "$t" ] && [ -e "$t" ] || return 0
  mapfile -t l 2>/dev/null <"$t" || true
  # How long it held the lock, for the next waiters' estimate (the newest 5 are kept). Not a run that
  # stopped early (a conflict, a red test): a few of those would promise everyone a one-minute wait.
  if [ "${1:-}" = ok ] && [ "${l[1]:-0}" -gt 0 ] 2>/dev/null; then
    took=$(dirname "$t")/.took
    { tail -n 4 "$took" 2>/dev/null; echo $(($(date +%s) - l[1])); } >"$took.tmp$$" && mv -f "$took.tmp$$" "$took"
  fi 2>/dev/null
  rm -f "$t"
}

# <queue dir> <ticket>: its sort key in the line, "0<place in .order>" or "1<ticket>". queue_order loads .order first.
queue_order() {
  local t i=0
  QUEUE_RANK=() QUEUE_ORDER_BY=""
  [ -f "$1/.order" ] || return 0
  while read -r t; do
    if [[ $t =~ ^[0-9]{10}$ ]]; then QUEUE_RANK[$t]=$((i += 1)); elif [[ $t == '# '* ]]; then QUEUE_ORDER_BY=${t#\# }; fi
  done <"$1/.order" 2>/dev/null || true
}
queue_key() {
  if [ -n "${QUEUE_RANK[$1]:-}" ]; then printf '0%010d' "${QUEUE_RANK[$1]}"; else echo "1$1"; fi
}

queue_ordinal() {
  case $1 in 1) echo next ;; 2) echo 2nd ;; 3) echo 3rd ;; *) echo "${1}th" ;; esac
}

queue_lock() {
  # The stall is timed in microseconds: $SECONDS ticks whole seconds, so a 3 s stall gave up 2.0-3.0 s after the last change (#790).
  local q=$1/queue label=$2 n me t l ahead head headname headpid phase detail look sig last="" since=${EPOCHREALTIME//[!0-9]/} said="" typical sum count line mine headkey key by=""
  local -A QUEUE_RANK=()
  local QUEUE_ORDER_BY=""
  mkdir -p -m 700 "$q"
  # Unopened, every flock below fails at once ("Bad file descriptor") for the whole stall (#553 F12b).
  if ! exec 9>"$1/lock"; then
    echo "queue: can't open the deploy lock $1/lock for writing, so nothing landed or deployed: a person needs to look at it" >&2
    return 1
  fi
  me=$(queue_proc $$)
  # The ticket and its number, under a lock of its own that is only ever held for these few lines: the
  # ticket is in the folder before the next number goes out, so nobody behind it can miss it.
  n=$(
    exec 8>"$q/.seq.lock"
    flock 8
    n=$(cat "$q/.seq" 2>/dev/null) || n=0
    # Junk in it (#553 F12c) failed every landing after its deploy: number on from the newest ticket instead (an empty
    # one, from a write cut off, quietly).
    if ! [[ $n =~ ^[0-9]{1,10}$ ]]; then
      t=$(find "$q" -maxdepth 1 -regex '.*/[0-9]+' -printf '%f\n' 2>/dev/null | sort | tail -n 1)
      [ -z "$n" ] || echo "queue: $q/.seq held no ticket number (\"$(head -c 40 <<<"$n")\"); numbering goes on from the newest ticket, $((10#${t:-0}))" >&2
      n=${t:-0}
    fi
    n=$(printf '%010d' $((10#$n + 1)))
    queue_write "$q/$n" "$me" 0 "$label" waiting
    echo "$((10#$n))" >"$q/.seq"
    echo "$n"
  )
  export DEPLOY_QUEUE_TICKET="$q/$n"
  trap queue_done EXIT

  queue_order "$q"
  by=$QUEUE_ORDER_BY # an order set before this joined is no news to it
  while :; do
    ahead=0 head="" headkey=""
    queue_order "$q"
    if [ "$QUEUE_ORDER_BY" != "$by" ]; then
      by=$QUEUE_ORDER_BY
      [ -z "$by" ] || echo "queue: $by" >&2
    fi
    mine=$(queue_key "$n")
    for t in "$q"/[0-9]*; do
      [[ ${t##*/} =~ ^[0-9]+$ ]] || continue # not a ticket half-written, or the glob itself
      [ "${t##*/}" != "$n" ] || continue
      mapfile -t l 2>/dev/null <"$t" || continue
      # Its process is gone (killed, or its turn was stopped): it leaves the line.
      if [ -z "${l[0]:-}" ] || [ "$(queue_proc "${l[0]%% *}")" != "${l[0]}" ]; then
        rm -f "$t"
        continue
      fi
      # The holder is ahead of everyone; a waiter only if it comes before this one in the line's order.
      if [ "${l[1]:-0}" = 0 ]; then
        key=$(queue_key "${t##*/}")
        [[ $key < $mine ]] || continue
        # A waiter that is stopped holds nothing, so it is passed over; it tries for the lock like the head once it wakes.
        [[ $(queue_state "${l[0]%% *}") != [Tt] ]] || continue
      else
        key=0 # before any waiter's, so the holder is the head
      fi
      ahead=$((ahead + 1))
      if [ -z "$head" ] || [[ $key < $headkey ]]; then head="${l[*]}" headname="${l[2]:-?}, ${l[3]:-?}" headpid=${l[0]%% *} headkey=$key; fi
    done

    # The caller's own check while others are ahead (land.sh's early conflict check, #770): a failure leaves the line.
    if [ "$ahead" -gt 0 ] && declare -F queue_wait_check >/dev/null && ! queue_wait_check; then
      queue_done
      return 2
    fi

    if [ "$ahead" = 0 ]; then
      # A short blocking wait, not a poll: the lockers outside the line block in the kernel, and a poller would lose to every one of them.
      if flock -w "$QUEUE_POLL" 9; then
        [ -z "$said" ] || echo "queue: got the deploy lock" >&2
        queue_write "$DEPLOY_QUEUE_TICKET" "$me" "$(date +%s)" "$label" starting
        return 0
      fi
      # Held by a landing behind this one in line: it passed this one while it was stopped.
      head=""
      for t in "$q"/[0-9]*; do
        [[ ${t##*/} =~ ^[0-9]+$ ]] && mapfile -t l 2>/dev/null <"$t" || continue
        [ "${l[1]:-0}" != 0 ] && [ "$(queue_proc "${l[0]%% *}")" = "${l[0]:-}" ] || continue
        head="${l[*]}" headname="${l[2]:-?}, ${l[3]:-?}"
        break
      done
      if [ -z "$head" ]; then
        phase=$(queue_restart "$1")
        # No restart says it has it: who does is looked up (queue_outside) only when there is a line to print.
        if [ -n "$phase" ]; then head="outside $n $phase" headname="the queued restart, $phase"; else head="outside $n" headname=""; fi
      fi
    fi

    # Progress is any change at the head of the line: a new head, or the head's next phase.
    sig="$ahead $head"
    if [ "$sig" != "$last" ]; then
      last=$sig since=${EPOCHREALTIME//[!0-9]/}
      [ -n "$headname" ] || headname=$(exec 9>&-; queue_outside "$1")
      line="$(queue_ordinal $((ahead + 1))) in line for the deploy lock"
      if [ "$ahead" -gt 0 ]; then
        sum=0 count=0
        [ ! -f "$q/.took" ] || while read -r typical; do [[ $typical =~ ^[0-9]+$ ]] && sum=$((sum + typical)) count=$((count + 1)); done <"$q/.took" || true
        typical=$((count ? sum / count : QUEUE_TYPICAL))
        [ "$typical" -gt 0 ] || typical=1
        line="$line, about $(((ahead * typical + 59) / 60)) min"
      fi
      echo "queue: $line (ahead: $headname)" >&2
      [ -n "$said" ] || echo "queue: the wait has no time limit while the line moves, so run this in the background with a long timeout rather than under a 10 min limit: a run that is stopped loses its place" >&2
      said=1
    elif [ $((${EPOCHREALTIME//[!0-9]/} - since)) -ge $((QUEUE_STALL * 1000000)) ]; then
      [ -n "$headname" ] || headname=$(exec 9>&-; queue_outside "$1")
      detail="" look="what holds the deploy lock ($1/lock)"
      if [ "$ahead" -gt 0 ]; then
        detail=$(queue_state "$headpid")
        case $detail in T | t) detail="; pid $headpid, stopped" ;; *) detail="; pid $headpid, state ${detail:-?}" ;; esac
        if flock -n 9; then
          flock -u 9
          detail="$detail; the lock is free" look="pid $headpid, which is first in line and is not taking the lock"
        else
          detail="$detail; the lock is held"
        fi
      fi
      echo "queue: nothing has moved for $((QUEUE_STALL / 60)) min (ahead: $headname$detail), so this gave up and nothing landed or deployed. A person needs to look at $look before anyone tries again" >&2
      queue_done
      return 1
    fi
    [ "$ahead" = 0 ] || sleep "$QUEUE_POLL"
  done
}

# What a kill leaves behind (#553). Not part of the line (and not in the kit's copy): notes in <state>, so the next
# one to hold the locks can finish what a SIGKILL cut off. The first two are written and read only under the deploy
# lock; taken-back is also written, with no lock, by a landing whose own restart was rolled back (land.sh's main_back).
#   unchecked   the commit the live checkout was on before a pull whose checks have not ended (tools/deploy.sh)
#   moving      "<main before> <tip>", then its branch, of a landing that moved main and has not seen its deploy end (tools/land.sh)
#   taken-back  "<tip> <branch>" of each landing whose commit came off main again, newest last (tools/land.sh reads it before it rebases)

# <state> <live>: a deploy died between its pull and the end of its checks, so the checkout goes back. Not when a
# restart queued before it has since come up healthy on that commit (last-good holds it): the server runs it.
deploy_unchecked_back() {
  local prev
  [ -s "$1/unchecked" ] || return 0
  prev=$(cat "$1/unchecked")
  if git -C "$2" cat-file -e "$prev^{commit}" 2>/dev/null && [ "$(git -C "$2" rev-parse HEAD)" != "$prev" ] && ! git -C "$2" merge-base --is-ancestor HEAD last-good 2>/dev/null; then
    echo "queue: an earlier deploy was killed before its checks ended; putting the live checkout back to $(git -C "$2" log -1 --format='%h "%s"' "$prev")" >&2
    git -C "$2" reset -q --hard "$prev"
  fi
  rm -f "$1/unchecked"
}

# <state> <live> <source>: a landing died after it moved main, and the live checkout never took its commit
# (the deploy's checks failed, or never ran). Nothing has landed on top (main is still its tip), so main goes back.
main_moving_back() {
  local l old tip
  [ -s "$1/moving" ] || return 0
  mapfile -t l <"$1/moving" || true
  read -r old tip <<<"${l[0]:-}" || true
  [ -n "$tip" ] && [ "$(git -C "$3" rev-parse main)" = "$tip" ] || { rm -f "$1/moving"; return 0; }
  if git -C "$2" merge-base --is-ancestor "$tip" HEAD 2>/dev/null; then
    # In the checkout with the restart on it still to be judged (#566: that restart runs beside the next landing):
    # the note stays for whoever looks once it has its verdict.
    ! git -C "$2" merge-base --is-ancestor "$tip" last-good 2>/dev/null || rm -f "$1/moving"
    return 0
  fi
  taken_back "$1" "$tip" "${l[1]:-}" # before main goes back, so a kill in between still leaves the record
  rm -f "$1/moving"
  git -C "$3" reset -q --keep "$old" || return 0
  echo "queue: an earlier landing was killed after it moved main to $(git -C "$3" log -1 --format='%h "%s"' "$tip") and before its deploy went through; main is back at $(git -C "$3" log -1 --format=%h "$old")" >&2
}

# <state> <tip> <branch>: a landing's commit came off main again. A branch that was rebased onto it meanwhile still
# holds it, and would carry it back onto main (tools/land.sh leaves it behind). The newest 20 are kept.
taken_back() {
  { tail -n 19 "$1/taken-back" 2>/dev/null; echo "$2 $3"; } >"$1/taken-back.tmp$$" && mv -f "$1/taken-back.tmp$$" "$1/taken-back"
}

# The restart lock (#566): <state>/restart.lock, on fd 7. Not part of the line either (the kit's copy has no restart).
# The queued restart (deploy.sh restart) holds it from the database copy until it ends: settled, or rolled back, and
# reported. Whoever moves main or the live checkout holds it too, taken after the deploy lock and never before it.
# So the restart no longer needs the deploy lock, and the next landing rebases and passes its gate beside it; only
# its fast-forward and its deploy wait for the restart's verdict. A restart still waiting on busy turns holds nothing.
#   restart_lock <state>   hold it on fd 7. Returns 1 when it wasn't let go within DEPLOY_RESTART_WAIT seconds (a
#                          restart ends within about 5 min: two restarts with their settle checks, and the reports).
restart_lock() {
  local phase said="" started=$SECONDS limit=${DEPLOY_RESTART_WAIT:-600}
  if ! exec 7>"$1/restart.lock"; then
    echo "queue: can't open the restart lock $1/restart.lock for writing, so nothing landed or deployed: a person needs to look at it" >&2
    return 1
  fi
  until flock -w "$QUEUE_POLL" 7; do
    phase=$(queue_restart "$1")
    # The restart's own phase is the sign of progress for the landings behind this one. Written before the line below,
    # so whoever reads that line finds the ticket already says it (#790: land-overlap read it in between).
    if [ -n "$phase" ]; then queue_phase "deploying: waiting for the restart ahead: $phase"; else queue_phase "deploying: waiting for the restart ahead${said:- since $(date +%H:%M)}"; fi
    [ -n "$said" ] || echo "queue: waiting for the restart ahead to have its verdict${phase:+ ($phase)}; main and the live checkout stay as they are until then" >&2
    [ -n "$said" ] || said=" since $(date +%H:%M)"
    if [ $((SECONDS - started)) -ge "$limit" ]; then
      echo "queue: the restart lock ($1/restart.lock) has not been let go for $limit s (${phase:-no restart says it holds it}), so this gave up. A person needs to look at the restart (journalctl --user -u ${DEPLOY_UNIT:-cc-restart-when-idle}) before anyone tries again" >&2
      exec 7>&-
      return 1
    fi
  done
}
