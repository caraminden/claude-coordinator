# The server's main thread is real-time priority 1 (#1561)

At a box load of 60 to 130 the server's one thread waited for a core 9% of the time (`reports/server-responsiveness-2026-11.md`).
At boot the server runs `chrt -R -r -p 1 <pid>` on its own main thread (`src/realtime.ts`): `SCHED_RR` priority 1 with
reset-on-fork, so every other thread and every child it starts stays `SCHED_OTHER` (the test checks both). It needs no root
here (the unit's `LimitRTPRIO` allows it) and no unit change. A spinning real-time thread holds a core until the 60 s
watchdog restarts the server; never raise the priority or make another thread real-time. If setting it fails, the server
logs one line and runs at normal priority.

It is on for the live server, off in dev copies and tests unless the `realtime_priority` setting is true.

Note for Cody: the Citadel server sets itself `SCHED_RR` priority 1 on its main thread (one thread, never above 1). To turn
it off, set the server's `realtime_priority` setting to false (it drops back within 15 s, no restart). Check with
`chrt -p <server pid>`.
