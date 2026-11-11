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

**The dev copy for the checks.** Back the database up into your temp folder and start `server.ts`
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

- Citadel's own UI has phone tap targets under 40 px from before this rubric (summaries, `.small`
  buttons, settings tabs): pre-existing, so `--scope` or `--ignore` them unless the change touches
  them.

## Notes

| Date | Minion | About | Words |
|---|---|---|---|

## Calibration board

| Item | Verdict | Why |
|---|---|---|

## Known blind spots
