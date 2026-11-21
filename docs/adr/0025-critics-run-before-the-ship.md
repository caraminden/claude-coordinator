# Critics run before the ship; code review may run alongside

Status: accepted, 2026-11-21. Built by #1504. Proposed by #1493's report, `reports/rework-deep-dive-2026-11-21.md` (pattern 3, fix 2).

Citadel's `ui-screenshots` critic had been on since Nov 8, but it ran on 5 of 172 front-end ships from Nov 17 to Nov 21.
The self-review skill's sentence asking for it was the only thing that made it run. People found the defects it exists
for instead (#910 → #928, #968 → #982, #1048 → #1075, #1423 → #1441).

Decision: Cara, 2026-11-21, on #1504's card, about refusing at hand-off versus shipping first and holding the close:
"Code review can be simultaneous, but critics not". This narrows her Nov 18 rule that a low-risk front-end change hands
off its ship first and reviews alongside: the code review still runs alongside, but a matching critic runs first.

- A ship hand-off (`hand_off_land`, and a container's land tool) is refused when the branch matches the `diff:` globs
  of a critic in the scheme's review set and that minion has no run of it on record. An advisory critic needs any
  verdict. A blocking critic needs a pass, which the existing hold (`holds()`) already enforces once a run exists.
- It applies in every scheme and to every critic that is on, from the review set's data. A critic on trial isn't
  required, since it only advises until it's calibrated. A build's own ship, its take-in of main and the fix of a
  rolled-back deploy skip it.
- A person's go doesn't stand in for the run: the minion can always record one, `ask` included.
- `diff:` triggers take `lines: <n>`: the critic fires only when the matched files' lines added plus removed come to n
  or more. A replay over the ship record (Nov 20–21, 36 h, 298 Citadel ships) and the 13 person-found UI defects:
  any front-end file, 84 ships, 12 of 13 caught; CSS or HTML touched, 46 ships, 10 of 13; 10+ CSS or HTML lines, 16
  ships, 8 of 13. The two that only the CSS/HTML trigger adds are an interaction bug (#897) and a 3-line colour
  (#728), which a screenshot critic is unlikely to see.
