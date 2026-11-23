// -*- mode: Bluespec; -*-
// The ship line's queue and lock rules, as a design check (#1658).
//
// Matches: the rules as of 2026-11-22, commit efb880c6e. NOT kept in step with tools/land.sh or the kit's
// land.sh template: those change about 100 times a week. Use it to check the next change to the queue, lock,
// batch or train rules before building it: write the new rule here, run the checker, then let this go stale.
//
// What it models: ships waiting in one line; the land lock, which in Citadel is deploy.sh's lock (one flock, so
// a land's deploy step inherits it and a deploy by hand waits in the same line); the restart lock (#566); one
// citadel-heavy slot; CI passing, failing, or red with flakes that get FLAKE_RERUNS fresh runs (#1419); the
// stack (CI_STACK batches build at once) and batches (CI_BATCH), with the pick on #1605's page: a batch passes
// over a ship that can't join (pipeline, LAND_TRAIN=0), which then ships alone on top of the batch.
// What it doesn't: file descriptors a check inherits, signals and kills, cgroup freezes, pid reuse, the
// Releases page reordering the line (.order), the check lock and the build locks, time itself. A wait with a
// time limit (the slot under the CI fallback, the restart lock) is an action that can give up; waiting in line
// counts as a wait with no limit, since a line that times out is the failure.
// Simplified on purpose: land.sh takes the restart lock before main moves, so a give-up leaves main untouched;
// here Land moves main first and a give-up puts it back. The reachable mains are the same; a design change
// about when main moves should write the real order in first.
module ship_line {
  const SHIPS: Set[int]     // the ships that may get in line
  const CI_BATCH: int       // how many ships share one CI run
  const CI_STACK: int       // how many batches build at once
  const FLAKE_RERUNS: int   // fresh CI runs a red of flakes only gets
  const SLOTS: int          // citadel-heavy's slots
  const PRE499: bool        // before #499: the head runs its tests in a heavy slot, waited for with no limit
  const OTHERS: bool        // deploy.sh by hand, another scheme's build and the restart unit take part

  pure val D = 8   // tools/deploy.sh run by hand, maybe from inside citadel-heavy
  pure val H = 9   // another scheme's build holding a heavy slot for as long as it likes
  pure val R = 7   // the queued restart unit
  pure val NOBODY = 0
  pure val PROCS = SHIPS.union(Set(D, H, R))

  type Ticket = { commit: List[int], verdict: str, runs: int } // verdict: "-", "green", "red"
  pure val NO_TICKET: Ticket = { commit: List(), verdict: "-", runs: 0 }
  type State = {
    line: List[int], joinOrder: List[int], tkt: int -> Ticket, main: List[int],
    lock: int, restartLock: int, slots: Set[int], phase: int -> str,
    shipping: List[int], before: List[int], restartQueued: bool,
    bad: Set[int], joinable: Set[int],
    // ghosts, for the properties: what CI really passed, and which landing each ship went in
    ciGreen: Set[List[int]], landedIn: int -> int, batchHead: int -> int, batches: int,
  }
  var s: State

  pure def has(l: List[int], x: int): bool = l.indices().exists(i => l[i] == x)
  pure def pos(l: List[int], x: int): int = l.indices().fold(-1, (a, i) => if (l[i] == x) i else a)
  pure def cap(n: int, k: int): int = if (n < k) n else k

  // The line cut into batches, front first. A ship that can't join heads a batch of its own; behind the front,
  // a batch takes the first CI_BATCH that can join and passes over the rest.
  pure def cut(l: List[int], J: Set[int]): List[List[int]] =
    l.foldl({ rest: l, out: List() }, (acc, _x) =>
      if (acc.rest.length() == 0) acc else {
        val js = acc.rest.select(x => J.contains(x))
        val b = if (J.contains(acc.rest[0])) js.slice(0, cap(js.length(), CI_BATCH)) else [acc.rest[0]]
        { rest: acc.rest.select(x => not(b.has(x))), out: acc.out.append(b) }
      }).out

  def batchesNow: List[List[int]] = cut(s.line, s.joinable)
  def batch0: List[int] = if (batchesNow.length() == 0) List() else batchesNow[0]
  def chain: List[int] = batchesNow.foldl(List(), (a, b) => a.concat(b)).select(x => x != D)
  def inWindow(x: int): bool = batchesNow.slice(0, cap(batchesNow.length(), CI_STACK)).foldl(false, (a, b) => a or b.has(x))
  // what x builds on: main for the first in the chain, else the commit in the ticket ahead of it
  def base(x: int): List[int] = if (pos(chain, x) == 0) s.main else s.tkt.get(chain[pos(chain, x) - 1]).commit
  def isBad(c: List[int]): bool = c.foldl(false, (a, y) => a or s.bad.contains(y))
  def holds(h: int, p: str): bool = s.lock == h and s.phase.get(h) == p
  def needsVerdict(x: int): bool = s.tkt.get(x).commit.length() > 0 and s.tkt.get(x).verdict == "-"

  // CI's (or the suite's) verdict on x's commit. A real break is always red; a good commit may come back red
  // with flakes, and gets another run until FLAKE_RERUNS are spent.
  def judged(x: int, flake: bool): State = {
    val t = s.tkt.get(x)
    if (isBad(t.commit)) { ...s, tkt: s.tkt.set(x, { ...t, verdict: "red" }) }
    else if (not(flake)) { ...s, tkt: s.tkt.set(x, { ...t, verdict: "green" }), ciGreen: s.ciGreen.union(Set(t.commit)) }
    else if (t.runs >= FLAKE_RERUNS) { ...s, tkt: s.tkt.set(x, { ...t, verdict: "red" }) }
    else { ...s, tkt: s.tkt.set(x, { ...t, runs: t.runs + 1 }) }
  }

  // The deepest member of the head's batch that CI passed and that sits on main with every member ahead of it.
  def deepest: int = batch0.indices().filter(i => SHIPS.contains(batch0[i]) and s.tkt.get(batch0[i]).verdict == "green"
    and s.tkt.get(batch0[i]).commit == s.main.concat(batch0.slice(0, i + 1))).fold(-1, (a, i) => if (i > a) i else a)

  // The holder lets go of everything and leaves; with ok, its batch counts as shipped, else main goes back.
  def finish(h: int, ok: bool): State = {
    val gone = s.shipping.foldl(Set(h), (a, y) => a.union(Set(y)))
    val n = s.batches + 1
    val shipped = ok and s.shipping.length() > 0
    val m = if (ok) s.main else s.before
    // (tickets of ships that left, and verdicts on commits main can't come back to, are dropped: fewer states)
    { ...s, main: m, line: s.line.select(y => not(gone.contains(y))), lock: NOBODY, before: List(),
      tkt: SHIPS.mapBy(y => if (gone.contains(y)) NO_TICKET else s.tkt.get(y)),
      ciGreen: s.ciGreen.filter(c => c.length() >= m.length() and c.slice(0, m.length()) == m),
      restartLock: if (s.restartLock == h) NOBODY else s.restartLock, slots: s.slots.exclude(Set(h)),
      phase: s.phase.set(h, "done"), restartQueued: s.restartQueued or (ok and s.restartLock == h),
      landedIn: if (shipped) s.shipping.foldl(s.landedIn, (acc, y) => acc.set(y, n)) else s.landedIn,
      batchHead: if (shipped) s.batchHead.put(n, s.shipping[0]) else s.batchHead,
      batches: if (shipped) n else s.batches, shipping: List() }
  }

  // --- ships in line ---
  action Join(x: int): bool = all { not(s.joinOrder.has(x)),
    s' = { ...s, line: s.line.append(x), joinOrder: s.joinOrder.append(x) } }
  // deploy.sh by hand gets in the same line; run under citadel-heavy, it holds a slot while it waits
  action JoinD(inSlot: bool): bool = all { OTHERS, not(s.joinOrder.has(D)), not(inSlot) or s.slots.size() < SLOTS,
    s' = { ...s, line: s.line.append(D), joinOrder: s.joinOrder.append(D), slots: if (inSlot) s.slots.union(Set(D)) else s.slots } }
  // rebase onto the commit ahead (the stack); a new commit has no verdict yet
  action Build(x: int): bool = all { s.line.has(x), inWindow(x), not(s.shipping.has(x)),
    pos(chain, x) == 0 or base(x).length() > 0, s.tkt.get(x).commit != base(x).append(x),
    s' = { ...s, tkt: s.tkt.set(x, { commit: base(x).append(x), verdict: "-", runs: 0 }) } }
  action CiRun(x: int, flake: bool): bool = all { not(PRE499), s.line.has(x), inWindow(x), not(s.shipping.has(x)),
    needsVerdict(x), s' = judged(x, flake) }
  // red is final only once the commit sits right on main
  action Refuse(x: int): bool = all { s.line.has(x), not(s.shipping.has(x)), s.tkt.get(x).verdict == "red",
    s.tkt.get(x).commit == s.main.append(x), s.lock != x or holds(x, "gate") or holds(x, "slot"),
    s' = { ...s, line: s.line.select(y => y != x), lock: if (s.lock == x) NOBODY else s.lock, phase: s.phase.set(x, "done"),
      tkt: s.tkt.set(x, NO_TICKET) } }

  // --- the head of the line, holding the land lock ---
  action Acquire(h: int): bool = all { s.line.length() > 0, s.line[0] == h, s.lock == NOBODY,
    s' = { ...s, lock: h, before: s.main, phase: s.phase.set(h, if (h == D) "deploy" else "gate") } }
  // the suite on perigee: before #499 every land's tests; today only when CI gave no answer (the fallback)
  action NeedSuite(h: int): bool = all { holds(h, "gate"), batch0.indices().exists(i => needsVerdict(batch0[i])),
    s' = { ...s, phase: s.phase.set(h, "slot") } }
  action Suite(h: int, x: int): bool = all { holds(h, "slot"), s.slots.size() < SLOTS, batch0.has(x), needsVerdict(x),
    s' = { ...judged(x, false), phase: s.phase.set(h, "gate") } }
  action SlotGiveUp(h: int): bool = all { not(PRE499), holds(h, "slot"), s' = { ...s, phase: s.phase.set(h, "gate") } }
  // main moves to the deepest green commit of the head's batch, landing every member up to it
  action Land(h: int): bool = all { holds(h, "gate"), deepest >= 0,
    s' = { ...s, main: s.main.concat(batch0.slice(0, deepest + 1)), shipping: batch0.slice(0, deepest + 1),
      before: s.main, phase: s.phase.set(h, "deploy") } }
  action TakeRestart(h: int): bool = all { holds(h, "deploy"), s.restartLock == NOBODY,
    s' = { ...s, restartLock: h, phase: s.phase.set(h, "deploying") } }
  // restart_lock gives up after DEPLOY_RESTART_WAIT: nothing ships
  action RestartGiveUp(h: int): bool = all { holds(h, "deploy"), s.restartLock != NOBODY, s' = finish(h, false) }
  // the boot check passes (a restart is queued) or fails (main goes back, none of the batch ships)
  action DeployEnd(h: int, ok: bool): bool = all { holds(h, "deploying"), s' = finish(h, ok) }

  // --- the others ---
  action HTake: bool = all { OTHERS, not(s.slots.contains(H)), s.slots.size() < SLOTS, s' = { ...s, slots: s.slots.union(Set(H)) } }
  action HFree: bool = all { s.slots.contains(H), s' = { ...s, slots: s.slots.exclude(Set(H)) } }
  action RStart: bool = all { OTHERS, s.restartQueued, s.restartLock == NOBODY, s' = { ...s, restartLock: R, restartQueued: false } }
  action REnd: bool = all { s.restartLock == R, s' = { ...s, restartLock: NOBODY } }

  action init = {
    nondet b = SHIPS.powerset().oneOf()
    nondet j = SHIPS.powerset().oneOf()
    s' = { line: List(), joinOrder: List(), tkt: SHIPS.mapBy(_x => NO_TICKET), main: List(),
      lock: NOBODY, restartLock: NOBODY, slots: Set(), phase: PROCS.mapBy(_x => "-"), shipping: List(), before: List(),
      restartQueued: false, bad: b, joinable: j, ciGreen: Set(List()), landedIn: SHIPS.mapBy(_x => 0),
      batchHead: Map(), batches: 0 }
  }

  action step = {
    nondet x = SHIPS.oneOf()
    nondet h = SHIPS.union(Set(D)).oneOf()
    nondet b = Set(true, false).oneOf()
    any { Join(x), Build(x), CiRun(x, b), Refuse(x), JoinD(b), Acquire(h), NeedSuite(h), Suite(h, x), SlotGiveUp(h),
      Land(h), TakeRestart(h), RestartGiveUp(h), DeployEnd(h, b), HTake, HFree, RStart, REnd }
  }

  // --- the properties ---
  // 1. Main only moves to a commit CI passed (or the suite on perigee, the CI fallback).
  val MainGreen = s.ciGreen.contains(s.main)
  // 2. Nobody holding the land (deploy) lock or the restart lock waits, with no time limit, for a slot or lock.
  def hardWaits(p: int): Set[int] =
    if (s.line.has(p) and s.lock != p and s.lock != NOBODY) Set(s.lock)
    else if (PRE499 and s.lock == p and s.phase.get(p) == "slot" and s.slots.size() >= SLOTS) s.slots
    else if (p == R and s.restartQueued and s.restartLock != NOBODY) Set(s.restartLock)
    else Set()
  val NoLockedWait = PROCS.forall(p => (s.lock == p or s.restartLock == p) implies hardWaits(p) == Set())
  //    and so no cycle of such waits: a deadlock
  def reach(p: int): Set[int] = PROCS.fold(hardWaits(p), (acc, _i) => acc.union(acc.fold(Set(), (a, q) => a.union(hardWaits(q)))))
  val NoDeadlock = PROCS.forall(p => not(reach(p).contains(p)))
  // 3. The line's order is kept: a ship lands no later than any ship that joined behind it, unless it couldn't
  //    join a batch and that batch, headed by a ship ahead of it, passed over it. And nothing lands twice.
  def landed(x: int): bool = s.landedIn.get(x) > 0
  def ahead(x: int, y: int): bool = pos(s.joinOrder, x) < pos(s.joinOrder, y)
  val OrderKept = SHIPS.forall(a => SHIPS.forall(c =>
    (landed(a) and landed(c) and ahead(a, c) and s.landedIn.get(a) > s.landedIn.get(c)) implies
      (not(s.joinable.contains(a)) and ahead(s.batchHead.get(s.landedIn.get(c)), a))))
  val NoTwice = s.main.indices().forall(i => s.main.indices().forall(k => i == k or s.main[i] != s.main[k]))
  val Safe = MainGreen and NoLockedWait and NoDeadlock and OrderKept and NoTwice
  // Witnesses: each should be violated, which shows the model reaches that state (a sanity check, not a property).
  val NoBatchShips = SHIPS.forall(x => SHIPS.forall(y => x == y or not(landed(x)) or s.landedIn.get(x) != s.landedIn.get(y)))
  val NoPassOver = SHIPS.forall(a => SHIPS.forall(c => not(landed(a) and landed(c) and ahead(a, c) and s.landedIn.get(a) > s.landedIn.get(c))))
  val NoFlakeGreen = SHIPS.forall(x => not(s.tkt.get(x).runs > 0 and s.tkt.get(x).verdict == "green"))
}

// Today's rules, scaled down from Citadel's settings (batches of 6, CI_STACK 2, flake reruns 2). One instance with
// everything was too big for TLC (680,000 states with the queue still growing after 10 minutes), so it's two:
// the batches, stack and flakes on three ships,
module today {
  import ship_line(SHIPS = Set(1, 2, 3), CI_BATCH = 2, CI_STACK = 2, FLAKE_RERUNS = 2, SLOTS = 1, PRE499 = false, OTHERS = false).*
}
// and the locks and slot on two, with a deploy by hand (maybe from inside citadel-heavy), another scheme's build and
// the restart unit.
module todayLocks {
  import ship_line(SHIPS = Set(1, 2), CI_BATCH = 2, CI_STACK = 2, FLAKE_RERUNS = 1, SLOTS = 1, PRE499 = false, OTHERS = true).*
}

// The rules as #497 found them (before #499, 2026-11-10): no CI gate, no batches; the head runs the suite in a
// heavy slot while it holds the deploy lock, and waits for that slot with no limit.
module pre499 {
  import ship_line(SHIPS = Set(1, 2), CI_BATCH = 1, CI_STACK = 1, FLAKE_RERUNS = 0, SLOTS = 1, PRE499 = true, OTHERS = true).*
}
