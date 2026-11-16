---
name: Upstream skills check
type: research
model: claude-sonnet-5-5
effort: medium
min_minions:
cron: 0 9 1 * *
stagger: 10m within 120m
applies: the repo copied skills, rules or files from elsewhere: a THIRD_PARTY.md with a Copies table, or a "## Copies" table in the scheme's onboarding.md
---
Run the citadel:upstream-check skill on {scheme}'s repo. Cover every Copies row of every THIRD_PARTY.md, and the "## Copies" table in this scheme's onboarding.md if it has one; an "Ideas only" table is outside the check. If there is neither, say so in one line and close.

Read upstream only: install nothing and run none of their scripts. Never apply an upstream change yourself. Takes go in a handoff in the shared folder's handoffs/ for a fresh minion.

What counts as worth reporting:
- Any take or alarm, as the skill defines them.
- If nothing moved upstream, make no commit and no report: file the run away quietly.
- If there are only ignores, ship the Checked bumps (citadel:self-review, then this scheme's usual landing route) and file the run away quietly.

Use a Sonnet-sized effort: a quiet month is a few git ls-remote calls. Check only this scheme's repo, never another scheme's.
