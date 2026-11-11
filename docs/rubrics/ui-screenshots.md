---
name: ui-screenshots
extends: citadel:critique/rubrics/ui-screenshots
when: "diff: public/**, docs/design-system/**, kit/skills/contraption-ui/starter/**"
person: Cara
calibrated: "2026-11-08, sonnet: 6/6 hits, 1/4 false alarms (the starter's board)"
---
# UI screenshots: Citadel

Citadel's rubric for front-end changes, on top of the kit starter (`citadel:critique`,
`rubrics/ui-screenshots.md`). People's verdicts on Citadel's UI go here (the skill's step 9).

**The dev copy for the checks.** `node tools/ui-sweep.ts [--only <screens>] [--keep]` does all of this
for the whole app (`--list` names the screens) and writes shots at 1440 and 390 with ui-measure's
numbers. By hand: back the database up into your temp folder and start `server.ts`
with `BOOT_CHECK=1`, so it starts no turns and leaves the live turns alone (without it, the copy
re-attaches to every running turn), on a free random port:

```
rm -f "$TMPDIR"/dev/coordinator.db* && mkdir -p "$TMPDIR/dev" && \
  sqlite3 -readonly ~/.local/share/claude-coordinator/coordinator.db "VACUUM INTO '$TMPDIR/dev/coordinator.db'" && \
BOOT_CHECK=1 HOST=127.0.0.1 PORT=<free port> DATA_DIR=$TMPDIR/dev TURN_UNITS=0 CLAUDE_BIN=/bin/false \
  COORDINATOR_PASSWORD=<random> SESSION_SECRET=<random 32+> node server.ts
```

Sign in with `POST /api/login` (`{"login":"cara","password":"<random>"}`) and pass the cookie from its
`Set-Cookie` to the script's `--cookie`. Views are hash routes: `/#/p/<scheme>`, `/#/t/<minion>`,
`/#/p/<scheme>/properties` and the rest in `public/core.js`'s router. Stop the server by its pid.

## Blockers

## Watch-list

- Tap targets: since #471 (2026-11-10) buttons, summaries, rows, chips, tabs and drawer controls are
  at least 24 px on desktop and 40 px on phone. A change that brings one back under is a finding.
  Still under, by choice: inline text links and desktop checkboxes (the label is the target).
- Errors and empty states as a bare red or grey sentence: Cara picked fixing them (#471, group 5).
  Use a `.cui-notice` with a tone, or the `.empty-state` box with a way out.

## Notes

| Date | Minion | About | Words |
|---|---|---|---|
| 2026-11-10 | #471 | Whole-app sweep: which finding groups to fix | "1 Flow and layout bugs; 3 Tap targets; 4 Cut-off text; 5 Empty and error states; 6 Walls of text". Not picked: 2, uneven padding inside pills and bars, which the critics flagged on chips that look even: ui-measure's padding check on small chips is not worth a finding by itself. |

## Calibration board

| Item | Verdict | Why |
|---|---|---|

## Known blind spots
