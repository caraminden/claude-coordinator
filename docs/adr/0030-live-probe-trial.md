# 0030: a big ship names a live probe, as a two-week trial

Status: accepted as a trial, 2026-11-23. Minion #1741, fix 4 of the rework deep dive (shared folder,
`reports/rework-deep-dive-2026-11-21.md`), handoff `handoffs/rework-4-live-probe-after-deploy.md`.

- **Cara, 2026-11-23**, on #1737's card ("Missing Loop" video report), after holding it on #1493's card on Nov 21.
- **Cara, 2026-11-14:** "The server, no model". **Cara, 2026-11-08:** "assume things will work instantly, but recover
  later if there was an issue".
- **Why:** 48 of the deep dive's rework pairs were a change that passed every test and broke only once live; each was
  found by a person, hours or days later, and fixed by a fresh minion with none of the builder's context.
- **Baseline to beat** (the handoff's measure): 22 live-only defects found by a person from Nov 7 to 21, and a median of
  17 h from a faulty ship to its fix minion.

## The rule

A `hand_off_land` to main whose branch changes 600 lines or more (added plus removed; since #2123 moved blocks and pure renames are left out, `changedLines`)
carries `probe`: one check from a fixed list, or `{kind:"none", reason}`. The route refuses it without one, and its
refusal lists the shapes (`src/live-probe.ts`, `PROBE_HELP`). The count is against a branch named `main`; a scheme
whose trunk has another name counts 0 and is never asked (a `shortcut:` in `changedLines`).

| kind | what the server does | pass |
|---|---|---|
| `http` | GET a path on this server, signed in as the minion's person (an app's path on the app's own host) | the status (200 by default), and the text if named; only the status and whether the text was there reach the chat, never the body |
| `timing` | three GETs of a path, signed in the same way | the median is within `ms` |
| `sql` | one SELECT through `src/db-view.ts --first` (read-only, secrets masked) | the first row's first value is a number within `min`/`max`; only that number is ever shown |

No free-form commands: a probe is data the server interprets, each kind read-only, and none restarts anything. The
server runs it once the change is live, with no model turn. A pass is one line in the minion's chat. A fail sets the
minion's state to none with the note "live probe failed", keeps it open and wakes it with what the probe saw. A probe that can't run (no
answer, a timeout, a 401 with no login to use, no headless browser) says so in one line and is not a fail.

## What "live" means, per kind of scheme

- **Citadel itself:** land.sh's "live now" runs it at once. A restart keeps it in a setting (`live-probe:<id>`) that
  outlasts the restart; `Runner.deployLive` holds the dismissal (state outside, "live; running its live probe"), runs
  it and dismisses on a pass. A `stay_open` ship's kept probe runs from `liveOn`'s sweep.
- **Another scheme whose apps this server deploys:** a clean land whose app deploys went through is live now: the
  probe runs at once, on the app's paths (`/apps/<name>/...`). `sql` is refused: it reads this server's own database.
- **Another scheme with nothing served here** (a PC build, a pull-request scheme): nothing to probe, so the route
  doesn't ask for one; a probe given anyway is logged "couldn't run: nothing served here".
- **A merge into a build:** not live, so no probe; the build's own ship to main names one.
- **Schemes that ship by pull request:** no `hand_off_land`, so no probe.

## Not taken: a shot of a live page

The handoff listed "a ui-measure shot of a live page". Every Citadel page needs a login, and opening the front end
signed in as a person isn't read-only: it marks the minion it shows seen (which can close one) and the inbox's items
read. Without a login it only ever shows the sign-in screen. So the trial has no `page` kind: an `http` probe on the
route a page reads covers most of what a shot would, and the refusal for `page` says so.

## Fit, on 10 pairs from the deep dive

About 5 of 10 fit a kind: #1079, #1251 and #1210 (timing), #1272 and #730 (sql), #479 (http). #1077 in part needed a
page shot, which the trial doesn't have (above). Three didn't: #738 (a paid image call, not read-only), #885 (the heavy queue starves only under load, hours
later), #667 (another platform: the installed app's title bar).

## Not taken: "tried on Windows or a phone" as a kind

The handoff's idea of a probe that tries the change on the Windows test box or a phone isn't a server check with no
model: it needs a person or a model turn on the test box. `stay_open` with `waiting_on` ("Cara testing on her phone")
already covers a person trying it.

## The stop rule (review on or after 2026-12-07; the Taskmaster schedules it)

Every probe writes one row to `$DATA_DIR/live-probes.jsonl` (`none`, pass, fail, can't). After two weeks, read it with
the woken minions' ends: a fail followed by a shipped fix is a real defect; one closed with "probe was wrong" is a wrong
fail. **The probe comes back out if `none` is over half of the ships that carried one, or wrong fails outnumber real
ones.** If it stays, the next step is the line at 200 changed lines, not 600.

## Not a judge

`test/judges.test.ts` lists `src/live-probe.ts` as not a judge: the check is the minion's own, run on its own ship, and
the wake goes back to that minion. This stop rule is what judges the trial.
