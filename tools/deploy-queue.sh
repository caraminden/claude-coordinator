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
# rest (a landing that joined since) behind them in arrival order, except that nobody goes ahead of a waiter from
# before .order that arrived first (queue_key; the Releases page never ranks one behind it, src/waits.ts behindOld).
# Whoever holds the lock counts as ahead of every waiter.
# Outside the line, a queued restart from before the restart lock (below) and a land.sh from a branch older than
# the line take the flock directly; the head of the line waits for them like for anyone else. The restart says what it
# is doing in <state>/restart ("<pid> <the pid's start time>", then its phase), which counts as progress like a ticket's phase (#553).
# The kit's land.sh template (kit/skills/scheme-setup/templates/land.sh) carries a copy of these functions
# inline, so a scheme copies one file: a fix to either belongs in both.

QUEUE_POLL=${DEPLOY_QUEUE_POLL:-1}
# How often a waiter with two or more ahead of it looks (#1545): nothing it does there needs a second's reaction, and
# twelve waiters looking every second cost most of a core. The next in line keeps QUEUE_POLL, so it takes its turn at once.
QUEUE_NAP=${DEPLOY_QUEUE_NAP:-${DEPLOY_QUEUE_POLL:-5}}
# Give up after this long with no change at the head of the line. The floor is the holder's longest
# single phase: the test run, 630 s at most (tools/run-tests.sh; its reruns are a phase of their own, 310 s at
# most); the boot check ends within 6 min.
QUEUE_STALL=${DEPLOY_QUEUE_STALL:-900}
QUEUE_TYPICAL=300 # a landing's length until some have been timed here

# "<pid> <start time>" of a live process, or nothing. The start time tells a reused pid apart. With a second
# argument, into that variable instead: the line's loop runs it for every ticket each pass, and a $( ) is a fork (#1545).
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

# The state letter of a process: T or t is stopped (a SIGSTOP), and so is a process in a frozen cgroup (#585). A second
# argument: into that variable, as queue_proc.
queue_state() {
  local stat='' cg='' x
  IFS= read -r -d '' stat 2>/dev/null <"/proc/$1/stat" || :
  stat=${stat##*) }
  stat=${stat%% *}
  # A frozen cgroup (systemctl freeze, a paused container) leaves its processes in state S: its cgroup.events says it.
  if [ -n "$stat" ] && [[ $stat != [Tt] ]]; then
    while IFS= read -r x; do [[ $x != 0::* ]] || { cg=${x#0::}; break; }; done 2>/dev/null <"/proc/$1/cgroup" || :
    [ -z "$cg" ] || while IFS= read -r x; do [ "$x" != 'frozen 1' ] || stat=T; done 2>/dev/null <"${DEPLOY_QUEUE_CGROUP:-/sys/fs/cgroup}$cg/cgroup.events" || :
  fi
  if [ -n "${2:-}" ]; then printf -v "$2" %s "$stat"; elif [ -n "$stat" ]; then echo "$stat"; fi
}

# <state>: the queued restart's phase, while its process lives.
queue_restart() {
  local l p
  mapfile -t l 2>/dev/null <"$1/restart" || return 0
  [ -n "${l[0]:-}" ] && queue_proc "${l[0]%% *}" p && [ "$p" = "${l[0]}" ] || return 0
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
# The 6th, "train" ($QUEUE_TRAIN, set by land.sh), says it can ride in the ship train of the landing at the front (#1166):
# it reads that landing's verdict on it from <state>/train/<ticket>. One without it is never taken on a train. "hold"
# there instead (land.sh's Regenerate ship, #1827) holds the line: it goes first among the waiters, and no train takes
# a rider from behind it (land.sh's train_build). The kit core's ticket says it on its 9th line.
# The 7th, "yield" ($QUEUE_YIELD, land.sh's retry in place, #1360), says it lets the next waiter take the lock first.
queue_write() { # <file> <pid and start> <got> <label> <phase>: by a rename, so nobody reads half a ticket
  printf '%s\n' "$2" "$3" "$4" "$5" order "${QUEUE_TRAIN:-}" ${QUEUE_YIELD:+yield} >"$1.tmp$$" && mv -f "$1.tmp$$" "$1"
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

# <queue dir> <ticket>: its sort key in the line, "<the waiters from before .order ahead of it>" then "0<place in
# .order>" ("0", the place of the last waiter a person placed (else ten zeros) and the ticket for one that holds the line), "1<ticket>" or, for one from before .order, "2". queue_order loads .order and those waiters first. One of
# those waits for every lower ticket, so nobody who arrived after it goes ahead of it: .order ranks the waiters between
# two of them only among themselves (had a later one counted itself ahead, both would take the lock: The Trans Agenda #76).
queue_order() {
  local t i=0 l pins=''
  QUEUE_RANK=() QUEUE_OLD=() QUEUE_ORDER_BY="" QUEUE_HOLD=" " QUEUE_PIN=0
  for t in "$1"/[0-9]*; do
    [[ ${t##*/} =~ ^[0-9]+$ ]] && mapfile -t l 2>/dev/null <"$t" || continue
    [ "${l[5]:-}" != hold ] && [ "${l[8]:-}" != hold ] || QUEUE_HOLD+="${t##*/} " # the core's (kit template's) is its 9th line
    [ "${l[1]:-0}" != 0 ] || [ "${l[4]:-}" = order ] || [ "${l[7]:-}" = order ] || QUEUE_OLD+=("${t##*/}") # the core's "order" is line 8
  done
  [ -f "$1/.order" ] || return 0
  while read -r t; do
    if [[ $t =~ ^[0-9]{10}$ ]]; then QUEUE_RANK[$t]=$((i += 1)); elif [[ $t == '# '* ]]; then QUEUE_ORDER_BY=${t#\# }; elif [[ $t == '#pin '* ]]; then pins=${t#\#pin }; fi
  done <"$1/.order" 2>/dev/null || true
  # A ship a person placed ("#pin", #1827 "Person's drag wins") stays ahead of a holding ship: it goes behind the last still waiting (not landing: line 2 is 0).
  for t in ${pins:-}; do printf -v t '%010d' "$((10#$t))" 2>/dev/null && [ "$(sed -n 2p "$1/$t" 2>/dev/null || echo x)" = 0 ] && [ "${QUEUE_RANK[$t]:-0}" -gt "$QUEUE_PIN" ] && QUEUE_PIN=${QUEUE_RANK[$t]}; done
  return 0
}
queue_key() { # <ticket> [variable]: printed, or into that variable (as queue_proc)
  local o seg=0 k
  for o in "${QUEUE_OLD[@]}"; do
    [ "$o" != "$1" ] || { printf -v k '%05d2' "$seg"; break; }
    [[ $o > $1 ]] || seg=$((seg + 1))
  done
  # A ship that holds the line (6th line "hold") sits right behind the last ship a person placed (QUEUE_PIN, else 0: before every rank), then in arrival order.
  if [ -n "${k:-}" ]; then :; elif [[ ${QUEUE_HOLD:-} == *" $1 "* ]]; then printf -v k '%05d0%010d%s' "$seg" "${QUEUE_PIN:-0}" "$1"; elif [ -n "${QUEUE_RANK[$1]:-}" ]; then printf -v k '%05d0%010d' "$seg" "${QUEUE_RANK[$1]}"; else printf -v k '%05d1%s' "$seg" "$1"; fi
  if [ -n "${2:-}" ]; then printf -v "$2" %s "$k"; else printf %s "$k"; fi
}

queue_ordinal() {
  case $1 in 1) echo next ;; 2) echo 2nd ;; 3) echo 3rd ;; *) echo "${1}th" ;; esac
}

# <queue dir> <ticket>...: these go first in .order. Read and replaced under .order.lock, which the server takes to
# write a person's drag (src/waits.ts writeOrder), so a drag made meanwhile lands after this, not under it (#2132).
queue_front() {
  local q=$1
  shift
  (
    flock -w 10 8 || { echo "queue: $q/.order is locked, so the line's order stays as it is" >&2; exit 0; }
    { grep '^# ' "$q/.order" || true; printf '%s\n' "$@"; grep -v '^# ' "$q/.order" || true; } 2>/dev/null | awk '!seen[$0]++' >"$q/.order.tmp$$" && mv -f "$q/.order.tmp$$" "$q/.order"
  ) 8>"$q/.order.lock"
}

# QUEUE_KEEP=<its ticket> (land.sh's retry in place, #1360): wait on that ticket, so in the same place in line, instead
# of a new one at the back. QUEUE_YIELD=yield with it: every other waiter counts as ahead (and they pass over this one)
# until one of them has taken the lock, nobody else is in line, or QUEUE_YIELD_MAX s went by (a waiter from a branch
# older than this rule counts it ahead regardless). So it goes right after the next ship, or rides in its train.
queue_lock() {
  # The stall is timed in microseconds: $SECONDS ticks whole seconds, so a 3 s stall gave up 2.0-3.0 s after the last change (#790).
  local q=$1/queue label=$2 n me t l p st ahead head headname headpid phase detail look sig last="" since=${EPOCHREALTIME//[!0-9]/} said="" typical sum count line mine headkey key by="" took yield_from=$SECONDS
  local -A QUEUE_RANK=()
  local QUEUE_OLD=()
  local QUEUE_ORDER_BY="" QUEUE_HOLD=" " QUEUE_PIN=0
  mkdir -p -m 700 "$q"
  # Unopened, every flock below fails at once ("Bad file descriptor") for the whole stall (#553 F12b).
  if ! exec 9>"$1/lock"; then
    echo "queue: can't open the deploy lock $1/lock for writing, so nothing landed or deployed: a person needs to look at it" >&2
    return 1
  fi
  me=$(queue_proc $$)
  # The ticket and its number, under a lock of its own that is only ever held for these few lines: the
  # ticket is in the folder before the next number goes out, so nobody behind it can miss it.
  if [ -n "${QUEUE_KEEP:-}" ] && [ -e "$QUEUE_KEEP" ]; then
    n=${QUEUE_KEEP##*/}
    queue_write "$q/$n" "$me" 0 "$label" waiting
    # First among the ranked too: Releases ranks only waiters, so a reorder while it held the lock left it out.
    [ ! -f "$q/.order" ] || queue_front "$q" "$n"
  else n=$(
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
  ); fi
  export DEPLOY_QUEUE_TICKET="$q/$n"
  trap "${QUEUE_EXIT:-queue_done}" EXIT

  queue_order "$q"
  by=$QUEUE_ORDER_BY # an order set before this joined is no news to it
  while :; do
    ahead=0 head="" headkey="" took=""
    queue_order "$q"
    if [ "$QUEUE_ORDER_BY" != "$by" ]; then
      by=$QUEUE_ORDER_BY
      [ -z "$by" ] || echo "queue: $by" >&2
    fi
    queue_key "$n" mine
    for t in "$q"/[0-9]*; do
      [[ ${t##*/} =~ ^[0-9]+$ ]] || continue # not a ticket half-written, or the glob itself
      [ "${t##*/}" != "$n" ] || continue
      mapfile -t l 2>/dev/null <"$t" || continue
      # Its process is gone (killed, or its turn was stopped): it leaves the line.
      [ -z "${l[0]:-}" ] || queue_proc "${l[0]%% *}" p
      if [ -z "${l[0]:-}" ] || [ "$p" != "${l[0]}" ]; then
        rm -f "$t"
        continue
      fi
      # The holder is ahead of everyone; a waiter only if it comes before this one in the line's order.
      if [ "${l[1]:-0}" = 0 ]; then
        [ "${l[6]:-}" != yield ] || continue # it lets the next one go first (QUEUE_YIELD above)
        queue_key "${t##*/}" key
        [[ $key < $mine ]] || [ -n "${QUEUE_YIELD:-}" ] || continue
        # A waiter that is stopped holds nothing, so it is passed over; it tries for the lock like the head once it wakes.
        queue_state "${l[0]%% *}" st
        [[ $st != [Tt] ]] || continue
      else
        key=0 took=1 # before any waiter's, so the holder is the head
      fi
      ahead=$((ahead + 1))
      if [ -z "$head" ] || [[ $key < $headkey ]]; then head="${l[*]}" headname="${l[2]:-?}, ${l[3]:-?}" headpid=${l[0]%% *} headkey=$key; fi
    done

    if [ -n "${QUEUE_YIELD:-}" ] && { [ -n "$took" ] || [ "$ahead" = 0 ] || [ $((SECONDS - yield_from)) -ge "${QUEUE_YIELD_MAX:-30}" ]; }; then
      QUEUE_YIELD=''
      queue_write "$DEPLOY_QUEUE_TICKET" "$me" 0 "$label" "$(sed -n 4p "$DEPLOY_QUEUE_TICKET" 2>/dev/null)"
      continue
    fi

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
        [ "${l[1]:-0}" != 0 ] && queue_proc "${l[0]%% *}" p && [ "$p" = "${l[0]:-}" ] || continue
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
    if [ "$ahead" -gt 1 ]; then sleep "$QUEUE_NAP"; elif [ "$ahead" = 1 ]; then sleep "$QUEUE_POLL"; fi
  done
}

# What a kill leaves behind (#553). Not part of the line (and not in the kit's copy): notes in <state>, so the next
# one to hold the locks can finish what a SIGKILL cut off. The first two are written and read only under the deploy
# lock; taken-back is also written, with no lock, by a landing whose own restart was rolled back (land.sh's main_back).
#   unchecked   the commit the live checkout was on before a pull whose checks have not ended (tools/deploy.sh)
#   moving      "<main before> <tip>", then its branch, of a landing that moved main and has not seen its deploy end (tools/land.sh);
#               then "<commit> <branch>" for each other ship of its ship train
#   taken-back  "<tip> <branch>" of each landing whose commit came off main again, newest last (tools/land.sh reads it before it rebases)

# <state> <live>: a deploy died between its pull and the end of its checks, so the checkout goes back. Not when a
# restart queued before it has since come up healthy on that commit (last-good holds it): the server runs it. A roll
# back (deploy.sh --to, #1016) went to a commit last-good already holds, so only last-good being that very commit counts.
deploy_unchecked_back() {
  local prev head ran
  [ -s "$1/unchecked" ] || return 0
  prev=$(cat "$1/unchecked")
  head=$(git -C "$2" rev-parse HEAD)
  if git -C "$2" merge-base --is-ancestor "$head" "$prev" 2>/dev/null; then
    [ "$(git -C "$2" rev-parse -q --verify 'last-good^{commit}' 2>/dev/null)" = "$head" ] && ran=1 || ran=''
  else
    git -C "$2" merge-base --is-ancestor "$head" last-good 2>/dev/null && ran=1 || ran=''
  fi
  if git -C "$2" cat-file -e "$prev^{commit}" 2>/dev/null && [ "$head" != "$prev" ] && [ -z "$ran" ]; then
    echo "queue: an earlier deploy was killed before its checks ended; putting the live checkout back to $(git -C "$2" log -1 --format='%h "%s"' "$prev")" >&2
    git -C "$2" reset -q --hard "$prev"
  fi
  rm -f "$1/unchecked"
}

# <state> <live> <source>: a landing died after it moved main, and the live checkout never took its commit
# (the deploy's checks failed, or never ran). Nothing has landed on top (main is still its tip), so main goes back.
main_moving_back() {
  local l old tip line
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
  # A ship train's other ships follow as "<commit> <branch>" lines (#1166).
  for line in "${l[@]:2}"; do [ -z "$line" ] || taken_back "$1" "${line%% *}" "${line#* }"; done
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
#                          restart ends within about 13 min at its slowest: the database copy, a handover that times out, two
#                          restarts with their settle checks, each health ask up to 4 s, and the reports).
restart_lock() {
  local phase said="" started=$SECONDS limit=${DEPLOY_RESTART_WAIT:-900}
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

# <hub function> <slug>: 0 when Citadel's hold is on and a run of its own (ship, check, heavy job, suite; not a flake proof, which
# runs beside ships: Josh, 2026-11-25) is on the CI desktop or queued: a check or early run starts on an idle one only (#1906, src/ci-hold.ts, which stops one that slips through).
# Fails open: off, or GitHub not read, it isn't busy. A run left queued over an hour is one GitHub abandoned.
ci_busy() {
  local st n
  [ ! -e "$state/hold-off" ] || return 1
  for st in in_progress queued; do
    n=$("$1" gh api "repos/$2/actions/runs?status=$st&per_page=100" --jq '[.workflow_runs[] | select((.path | test("/(tests|citadel-heavy)\\.yml")) and (.status != "queued" or (.created_at | fromdateiso8601) > now - 3600))] | length' 2>/dev/null) || n=''
    [[ ! $n =~ ^[1-9][0-9]*$ ]] || return 0
  done
  return 1
}
