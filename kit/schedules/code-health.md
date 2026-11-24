---
name: Code health
type: research
model: claude-opus-5-5
effort: medium
trigger: 100 ships
min_minions: 40
cron: 0 5 * * *
stagger: 10m within 120m
applies: the repo holds app code people build on (a server, an app, a game, tools), not only notes, docs or a fresh scaffold with nothing built on it yet
---
Code health for {scheme}: what the changes on main since the last run (the date is in the run's second line) left messier than they found it. Paths, stack and check commands are in CLAUDE.md's Project facts.

Scope: git log --since='<last run>' main, and the 10 files those commits touched most. Not the whole repo.

Run citadel:ponytail-review on that scope, looking for:
- dead code: exports, functions, routes, scenes, assets or resources nothing reaches. Grep strings too: names referenced by string (routes, tool names, config keys, scene paths) don't show up in an import search;
- duplication added since the last run, especially the same helper written twice by minions working in parallel;
- `shortcut:` comments added since the last run, and the ledger's total against the last report;
- tests added since the last run that prove nothing (citadel:test-quality's checks);
- files that grew past about 1,500 lines.
Read the last report first (the newest reports/code-health-*.md in this scheme's shared folder) and don't re-report what it found unless it got worse.

Put the reading in 2 or 3 Sonnet Grunts (citadel:subagents), split by area, and re-check every finding you report yourself.

Worth reporting: a bug, or a fix a minion could make in under a day that would save the next minion in that file real time. Style nits are not findings.

Output:
- Nothing past the bar: reply in one line with the window's numbers (commits, files read, shortcut count) and close.
- Otherwise write reports/code-health-<YYYY-MM-DD>.md in this scheme's shared folder (ranked; each finding with file:line, why it matters, size S/M) and at most 3 handoffs in handoffs/ for the top ones; the card gives each handoff its model, risk and payoff.
- A small, certain dead-code removal (nothing references it anywhere, strings included) may ship from this run by this scheme's usual landing route, after citadel:self-review. List what shipped with its commit and risk label.
