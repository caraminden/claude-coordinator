---
paths:
  - "CLAUDE.md"
  - "AGENTS.md"
  - ".claude/**"
  - "kit/**"
---

# Editing CLAUDE.md and rules

CLAUDE.md loads into every session, so keep it slim: a rule for one kind of job goes in its
skill, and detail goes in the doc that owns it, with at most a pointer there (the
`citadel:writing-for-agents` skill). A rule for one area of the repo goes in a path-scoped
`.claude/rules/<name>.md` (that skill, "Path-scoped rules").
