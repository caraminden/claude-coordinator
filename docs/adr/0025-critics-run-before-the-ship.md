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
  required, since it only advises until it's calibrated (this leaves out Peek Auras' `overlay-look`, which matched 15
  ships in the replay below): Cara, 2026-11-21, on #1504's card, "Keep trial exempt". A build's own ship, its take-in
  of main and the fix of a rolled-back deploy skip it (#1504's pick, open to a member's word).
- A person's go doesn't stand in for the run: the minion can always record one, `ask` included.
- `diff:` triggers take `lines: <n>`: the critic fires only when the matched files' lines added plus removed come to n
  or more. A replay over the ship record (Nov 20–21, 36 h, 298 Citadel ships) and the 13 person-found UI defects:
  any front-end file, 84 ships, 12 of 13 caught; CSS or HTML touched, 46 ships, 10 of 13; 10+ CSS or HTML lines, 16
  ships, 8 of 13. The two that only the CSS/HTML trigger adds are an interaction bug (#897) and a 3-line colour
  (#728), which a screenshot critic is unlikely to see.

Replay of the gate over the ship record (the same 36 h, every scheme; a ship counts as refused when it matched an on
critic's globs and its minion had no run of it): Citadel `ui-screenshots` 83 of 299 ships (84 matched, 1 had run it);
TWIReader `ui-screenshots` 1 of 4; TripPresenter, Genesis Tree, VoiceAnalyzer and Theory of Crafting 0; Peek Auras'
`overlay-look` would be 15 of 171 if trial critics counted. At Citadel's trigger then (`public/**`, the design system,
the contraption starter) that is about 55 critic runs a day, twice the handoff's budget of about 25 ($9), so the gate
ships with the trigger narrowed to 10+ lines of CSS or HTML (about 11 a day, 8 of the 13 caught), set on the entry by
the Taskmaster once this is live. There was no logging-only week: this replay of the record stands in for it.
