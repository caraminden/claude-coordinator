# Copies: the onboarding table and THIRD_PARTY.md

Record every copy (rules, adapted skills and agents alike) under `## Copies` in
`$COORDINATOR_SHARED_DIR/onboarding.md`, adding the heading if it isn't there. One row each:
file here, source (scheme and path, or "kit template"), the source's commit (`git -C <source>
rev-parse --short HEAD`; a kit template has no commit to read: write `kit`), today's date. A tune-up refreshes copies from this table. Leave the
rest of that file to the Taskmaster.

A copy from outside Citadel (a third-party skill, agent or rule, from a plan line or a
`citadel:skills-survey` handoff) also gets a row in the repo's `THIRD_PARTY.md`, so the scheduled
upstream check (`citadel:upstream-check`) can read it. Make the file when it isn't there, with
this table and, below it, each licence's full text:

```
## Copies

| Upstream repo | Upstream path | Pinned commit | Path here | Licence | Copied | Checked |
|---|---|---|---|---|---|---|
| owner/repo | skills/x | abc1234 | .claude/skills/x/ | MIT | unchanged | abc1234 2026-11-06 |
```

`Copied` is `unchanged` or `adapted: <what changed>`; `Checked` starts as the pinned commit and
today's date; one row per copied path. If this is the file's first row and the plan's Standard
audits leave out the upstream check, get it asked for as `citadel:upstream-check` says. *Done when*
every copied file has its row.
