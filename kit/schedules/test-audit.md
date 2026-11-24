---
name: Test audit
type: research
model: claude-opus-5-5
effort: high
trigger: 400 ships
min_minions: 250
cron: 0 7 1 * *
stagger: 1d within 28d
applies: the repo has a test suite (test files a check command runs), not only a placeholder smoke test
---
Test audit for {scheme}, by the method in citadel:test-quality's references/audit-method.md. Cara (2026-11-15): "I want to make sure the tests we have written are useful and actually testing real functionality and we didnt just accidentally write WAY too many tests."

The stack and test commands are in CLAUDE.md's Project facts. Adapt the method's per-file timing step to this stack: take per-file times from the latest green CI run's log (or a `gh workflow run`), never a full suite run on perigee.

Scope:
- If this scheme has no reports/test-audit-*.md in its shared folder yet, or the newest is older than 90 days, audit every test file.
- Otherwise audit only the test files added or changed since the commit that report names (git diff --name-only <commit> main).
- Either way, re-time the suite from the latest green CI run and say whether the long pole moved.

Research only: change no tests and land nothing.
1. Write reports/test-audit-<YYYY-MM>.md in this scheme's shared folder, naming the commit it audited.
2. Post one ask_question card for which cut batches to take, your picks marked.
3. Write a handoff in handoffs/ for each batch people pick, and message your Taskmaster each path.

If every scoped file earns its keep, reply in one line and close.
